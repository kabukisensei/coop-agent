#!/usr/bin/env python3
"""Read-only live impact tracing for one SQL object (master plan section 8 item 4, SQ4).

Given one object name, connect to the contract's default (dev or test) target
exactly as lib/sql_query.py does and run three fixed, parameterized catalog
queries, never free text:

- downstream (who references this object): `sys.dm_sql_referencing_entities`
  joined to `sys.objects`, resolved at call time;
- upstream (what this object references): `sys.sql_expression_dependencies`
  for the object's own referenced entities, with a `sys.sql_modules` text check
  for each dependency the catalog could not resolve (a dropped or cross-database
  reference shows as ambiguous or unresolved there);
- shape: `INFORMATION_SCHEMA.COLUMNS` for the object's columns, so a before/after
  comparison knows what to count.

The object name is always a bound parameter (`OBJECT_ID(?)`), never spliced into
SQL. Where a target kind lacks a catalog view, the matching section reports
`unavailable` with a reason instead of an empty list, so "no dependents" is never
confused with "could not look". No credential, connection string, server name or
exception text appears in a result.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

import sql_query

MAX_DEPENDENCIES = 500
MAX_COLUMNS = 1000
_IDENT = r"[A-Za-z_][A-Za-z0-9_@#$]{0,127}"
OBJECT_NAME = re.compile(rf"^(?:(?:\[({_IDENT})\]|({_IDENT}))\.)?(?:\[({_IDENT})\]|({_IDENT}))$")
DEFAULT_SCHEMA = "dbo"

# Fixed catalog queries. Every `?` is a pyodbc-bound parameter.
RESOLVE_SQL = (
    "SELECT s.name, o.name, o.type_desc FROM sys.objects AS o "
    "JOIN sys.schemas AS s ON s.schema_id = o.schema_id WHERE o.object_id = OBJECT_ID(?)"
)
DOWNSTREAM_SQL = (
    f"SELECT TOP ({MAX_DEPENDENCIES + 1}) re.referencing_schema_name, re.referencing_entity_name, o.type_desc "
    "FROM sys.dm_sql_referencing_entities(?, 'OBJECT') AS re "
    "LEFT JOIN sys.objects AS o ON o.object_id = re.referencing_id "
    "ORDER BY re.referencing_schema_name, re.referencing_entity_name"
)
UPSTREAM_SQL = (
    f"SELECT TOP ({MAX_DEPENDENCIES + 1}) d.referenced_schema_name, d.referenced_entity_name, "
    "d.referenced_database_name, d.referenced_server_name, d.is_ambiguous, d.referenced_id, o.type_desc "
    "FROM sys.sql_expression_dependencies AS d "
    "LEFT JOIN sys.objects AS o ON o.object_id = d.referenced_id "
    "WHERE d.referencing_id = OBJECT_ID(?) "
    "ORDER BY d.referenced_schema_name, d.referenced_entity_name"
)
MODULE_MENTION_SQL = (
    "SELECT TOP (1) 1 FROM sys.sql_modules WHERE object_id = OBJECT_ID(?) AND definition LIKE ? ESCAPE '\\'"
)
COLUMNS_SQL = (
    f"SELECT TOP ({MAX_COLUMNS + 1}) COLUMN_NAME, DATA_TYPE, IS_NULLABLE, ORDINAL_POSITION "
    "FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION"
)

# Catalog coverage that is known up front: the result says so without asking the
# server. Everything else is tried and reported as `unavailable` when the view is
# missing on that target.
KIND_LIMITS: dict[str, dict[str, str]] = {
    "synapse_serverless": {
        "downstream": "Synapse serverless does not expose sys.dm_sql_referencing_entities; "
        "dependents are not traceable here (views and external tables only)",
    },
}


def parse_object_name(raw: Any) -> tuple[str, str] | None:
    """(schema, name) from `name`, `schema.name`, or their bracketed forms; None when unsafe."""
    if not isinstance(raw, str):
        return None
    match = OBJECT_NAME.fullmatch(raw.strip())
    if not match:
        return None
    schema = match.group(1) or match.group(2) or DEFAULT_SCHEMA
    name = match.group(3) or match.group(4)
    return schema, name


def _bracketed(schema: str, name: str) -> str:
    return f"[{schema}].[{name}]"


def _like_pattern(name: str) -> str:
    escaped = re.sub(r"([%_\[\\])", r"\\\1", name)
    return f"%{escaped}%"


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ("" if value is None else str(value))


def _rows(cursor: Any, sql: str, params: tuple[Any, ...], limit: int) -> list[tuple[Any, ...]]:
    cursor.execute(sql, params)
    rows: list[tuple[Any, ...]] = []
    while len(rows) < limit + 1:
        row = cursor.fetchone()
        if row is None:
            break
        rows.append(tuple(row))
    return rows


def _section(items: list[dict[str, Any]], truncated: bool) -> dict[str, Any]:
    return {"state": "ok", "items": items, "count": len(items), "truncated": truncated}


def _unavailable(reason: str) -> dict[str, Any]:
    return {"state": "unavailable", "reason": reason, "items": [], "count": 0, "truncated": False}


def trace(cursor: Any, kind: str, schema: str, name: str) -> dict[str, Any]:
    """Run the three catalog queries on an open cursor; each section fails on its own."""
    qualified = _bracketed(schema, name)
    limits = KIND_LIMITS.get(kind, {})
    sections: dict[str, dict[str, Any]] = {}

    if "downstream" in limits:
        sections["downstream"] = _unavailable(limits["downstream"])
    else:
        try:
            rows = _rows(cursor, DOWNSTREAM_SQL, (qualified,), MAX_DEPENDENCIES)
            items = [
                {"schema": _text(r[0]), "name": _text(r[1]), "type": _text(r[2]) or "unknown"}
                for r in rows[:MAX_DEPENDENCIES]
            ]
            sections["downstream"] = _section(items, len(rows) > MAX_DEPENDENCIES)
        except Exception:
            sections["downstream"] = _unavailable(
                f"sys.dm_sql_referencing_entities query failed on this {kind} target; dependents could not be looked up"
            )

    try:
        rows = _rows(cursor, UPSTREAM_SQL, (qualified,), MAX_DEPENDENCIES)
        items = []
        for r in rows[:MAX_DEPENDENCIES]:
            ref_schema, ref_name, ref_db, ref_server, ambiguous, ref_id, type_desc = (list(r) + [None] * 7)[:7]
            resolved = ref_id is not None and not ambiguous
            item: dict[str, Any] = {
                "schema": _text(ref_schema),
                "name": _text(ref_name),
                "type": _text(type_desc) or ("unknown" if not resolved else "unknown"),
                "resolved": bool(resolved),
            }
            if ref_db:
                item["database"] = _text(ref_db)
            if ref_server:
                item["server"] = _text(ref_server)
            if not resolved:
                # The catalog could not bind this reference: confirm the module text
                # still names it, so a dropped or cross-database object is visible.
                try:
                    mention = _rows(cursor, MODULE_MENTION_SQL, (qualified, _like_pattern(_text(ref_name))), 1)
                    item["mentioned_in_definition"] = bool(mention)
                except Exception:
                    item["mentioned_in_definition"] = None
            items.append(item)
        sections["upstream"] = _section(items, len(rows) > MAX_DEPENDENCIES)
    except Exception:
        sections["upstream"] = _unavailable(
            f"sys.sql_expression_dependencies query failed on this {kind} target; references could not be looked up"
        )

    try:
        rows = _rows(cursor, COLUMNS_SQL, (schema, name), MAX_COLUMNS)
        items = [
            {
                "name": _text(r[0]),
                "type": _text(r[1]),
                "nullable": _text(r[2]).upper() == "YES",
                "position": int(r[3]) if isinstance(r[3], int) else None,
            }
            for r in rows[:MAX_COLUMNS]
        ]
        sections["columns"] = _section(items, len(rows) > MAX_COLUMNS)
    except Exception:
        sections["columns"] = _unavailable(
            f"INFORMATION_SCHEMA.COLUMNS query failed on this {kind} target; the column shape could not be read"
        )
    return sections


def execute(payload: Any, *, cwd: Path | None = None) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) != {"object"}:
        return sql_query.result("input_invalid")
    parsed = parse_object_name(payload.get("object"))
    if parsed is None:
        return sql_query.result("object_invalid")
    schema, name = parsed
    connection, target, _driver, error = sql_query.open_connection(cwd=cwd)
    if error is not None or connection is None or target is None:
        return error or sql_query.result("connection_failed")
    try:
        connection.timeout = sql_query.QUERY_TIMEOUT
        cursor = connection.cursor()
        try:
            resolved = _rows(cursor, RESOLVE_SQL, (_bracketed(schema, name),), 1)
        except Exception:
            return sql_query.result("query_failed", stage="resolve_object")
        if not resolved:
            return sql_query.result("object_not_found", target=target.summary())
        found_schema, found_name, type_desc = (list(resolved[0]) + [None] * 3)[:3]
        sections = trace(cursor, target.kind, _text(found_schema) or schema, _text(found_name) or name)
        return sql_query.result(
            "ok",
            target=target.summary(),
            object={"schema": _text(found_schema) or schema, "name": _text(found_name) or name, "type": _text(type_desc) or "unknown"},
            **sections,
        )
    except Exception:
        return sql_query.result("query_failed")
    finally:
        try:
            connection.close()
        except Exception:
            pass


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (UnicodeDecodeError, json.JSONDecodeError):
        payload = None
    try:
        output = execute(payload)
    except Exception:
        output = sql_query.result("internal_error")
    sys.stdout.write(json.dumps(output, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
    return 0 if output["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

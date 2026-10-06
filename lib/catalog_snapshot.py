#!/usr/bin/env python3
"""Committed dev catalog snapshot (master plan SQ9).

Reads the contract's default dev or test target read-only, exactly as
lib/sql_query.py and lib/sql_impact.py do (`open_connection`: same target, same
identity pinning, driver, encryption and timeouts; never production), and writes
the catalog as committable files, one per object:

- tables: a synthesized `CREATE TABLE` with every column, type and nullability
  (INFORMATION_SCHEMA.COLUMNS);
- views, procedures and functions: the definition the catalog holds
  (sys.sql_modules), so coop-data-doc can parse the folder as a SQL source;
- `manifest.json`: when the snapshot was taken, the target's environment, kind
  and database, the counts, and the list of files it wrote;
- `README.md`: what the folder is and that nothing is ever deployed from it.

No row data, no credential, no connection string and no server name is written.
The folder is `catalog.path` from the contract (relative to the contract root),
else `<data_docs repository>/catalog/<environment>` when the contract names a
`data_docs` repository (DR1), else `.coop/catalog/<environment>` beside the
contract. `status` reports whether the snapshot exists and how old it is against
`catalog.max_age_days` (default 7). A folder that is not a snapshot (no
manifest.json, not empty) is never overwritten.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sql_query  # noqa: E402
import sql_targets as targets_lib  # noqa: E402
import warehouse_mcp as wmcp  # noqa: E402

SCHEMA_VERSION = 1
DEFAULT_MAX_AGE_DAYS = 7
MAX_OBJECTS = 5000
MAX_COLUMNS = 200_000
MAX_DEFINITION_CHARS = 1_000_000
OBJECT_TYPES = {"U": "table", "V": "view", "P": "procedure", "FN": "function", "IF": "function", "TF": "function"}
COUNT_KEYS = ("tables", "views", "procedures", "functions")

# Fixed catalog queries, no parameters and no free text.
OBJECTS_SQL = (
    f"SELECT TOP ({MAX_OBJECTS + 1}) s.name, o.name, RTRIM(o.type) FROM sys.objects AS o "
    "JOIN sys.schemas AS s ON s.schema_id = o.schema_id "
    "WHERE o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF') AND o.is_ms_shipped = 0 "
    "ORDER BY s.name, o.name"
)
COLUMNS_SQL = (
    f"SELECT TOP ({MAX_COLUMNS + 1}) TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, "
    "CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, DATETIME_PRECISION, IS_NULLABLE, ORDINAL_POSITION "
    "FROM INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION"
)
MODULES_SQL = (
    f"SELECT TOP ({MAX_OBJECTS + 1}) s.name, o.name, m.definition FROM sys.sql_modules AS m "
    "JOIN sys.objects AS o ON o.object_id = m.object_id "
    "JOIN sys.schemas AS s ON s.schema_id = o.schema_id "
    "WHERE o.type IN ('V', 'P', 'FN', 'IF', 'TF') AND o.is_ms_shipped = 0 "
    "ORDER BY s.name, o.name"
)

_SAFE_NAME = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_@#$")


# --- contract: where the snapshot lives and how old it may be -------------------


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _is_todo(value: str) -> bool:
    return not value or value.upper().startswith("TODO")


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def max_age_days(project: dict[str, Any]) -> int:
    raw = _mapping(project.get("catalog")).get("max_age_days", DEFAULT_MAX_AGE_DAYS)
    try:
        days = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_MAX_AGE_DAYS
    return days if days > 0 else DEFAULT_MAX_AGE_DAYS


def data_docs_repository(project: dict[str, Any]) -> str:
    """The local_path of the contract's `data_docs` repository, or ''."""
    for entry in _mapping(project.get("repositories")).values():
        entry = _mapping(entry)
        role = _text(entry.get("role")).lower().replace("-", "_")
        local_path = _text(entry.get("local_path"))
        if role == "data_docs" and not _is_todo(local_path):
            return local_path
    return ""


def resolve_output(project: dict[str, Any], project_path: Path, environment: str) -> tuple[Path, str]:
    """(absolute folder, how it was chosen: contract | data_docs | default)."""
    root = project_path.resolve().parent.parent
    configured = _text(_mapping(project.get("catalog")).get("path"))
    if not _is_todo(configured):
        return (root / configured).resolve(), "contract"
    docs_repo = data_docs_repository(project)
    if docs_repo:
        return (root / os.path.expanduser(docs_repo) / "catalog" / environment).resolve(), "data_docs"
    return (root / ".coop" / "catalog" / environment).resolve(), "default"


def default_environment(project: dict[str, Any]) -> str:
    env = _text(_mapping(project.get("sql_targets")).get("default_environment")).lower()
    return env if env in ("dev", "test") else "dev"


def has_sql_target(project: dict[str, Any]) -> bool:
    """True when the contract has a configured sql_targets section (SQ1); the
    doctor row stays out of legacy endpoint-only contracts."""
    try:
        return bool(targets_lib.parse_sql_targets(project).configured)
    except Exception:
        return False


def _load(cwd: Path | None, project_arg: str | None) -> tuple[dict[str, Any] | None, Path | None]:
    if project_arg:
        path = Path(project_arg)
        if not path.is_file():
            return None, None
    else:
        found = wmcp.find_project_yml(cwd or Path.cwd())
        if not found:
            return None, None
        path = Path(found)
    try:
        project = wmcp.load_project(path)
    except Exception:
        return None, None
    return (project if isinstance(project, dict) else {}), path


# --- status ---------------------------------------------------------------------


def read_manifest(folder: Path) -> dict[str, Any] | None:
    try:
        data = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("coop_catalog_snapshot") is True else None


def _age_days(taken_at: str, now: datetime) -> float | None:
    try:
        taken = datetime.fromisoformat(taken_at.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if taken.tzinfo is None:
        taken = taken.replace(tzinfo=timezone.utc)
    return max(0.0, (now - taken).total_seconds() / 86400.0)


def status(*, cwd: Path | None = None, project_arg: str | None = None, now: datetime | None = None) -> dict[str, Any]:
    project, path = _load(cwd, project_arg)
    if project is None or path is None:
        return sql_query.result("project_unavailable")
    environment = default_environment(project)
    folder, chosen = resolve_output(project, path, environment)
    root = path.resolve().parent.parent
    try:
        rel = folder.relative_to(root).as_posix()
    except ValueError:
        rel = folder.as_posix()
    limit = max_age_days(project)
    base = {"path": rel, "chosen_by": chosen, "environment": environment, "max_age_days": limit}
    manifest = read_manifest(folder)
    if manifest is None:
        return sql_query.result("missing", **base)
    age = _age_days(_text(manifest.get("taken_at")), now or datetime.now(timezone.utc))
    counts = {key: int(_mapping(manifest.get("objects")).get(key, 0) or 0) for key in COUNT_KEYS}
    details = {**base, "taken_at": _text(manifest.get("taken_at")), "objects": counts, "target": _mapping(manifest.get("target"))}
    if age is None:
        return sql_query.result("stale", age_days=None, **details)
    details["age_days"] = round(age, 1)
    return sql_query.result("stale" if age > limit else "ok", **details)


def doctor_lines(*, cwd: Path | None = None, project_arg: str | None = None) -> list[tuple[str, str, str]]:
    """(level, message, hint) rows for coop doctor's project-contract section."""
    project, _path = _load(cwd, project_arg)
    if project is None or not has_sql_target(project):
        return []
    info = status(cwd=cwd, project_arg=project_arg)
    state = info["state"]
    if state == "project_unavailable":
        return []
    if state == "missing":
        return [("warn", f"no catalog snapshot under {info['path']}", "run: coop catalog snapshot   (or catalog_snapshot in a session) so coop knows the dev tables and columns before it writes SQL")]
    objects = info.get("objects") or {}
    summary = ", ".join(f"{objects.get(key, 0)} {key}" for key in COUNT_KEYS)
    if state == "stale":
        age = info.get("age_days")
        age_text = f"{age:g} day(s) old" if isinstance(age, (int, float)) else "of unknown age"
        return [("warn", f"catalog snapshot under {info['path']} is {age_text} (max {info['max_age_days']})", "run: coop catalog snapshot")]
    return [("ok", f"catalog snapshot under {info['path']}: {summary}, {info.get('age_days', 0):g} day(s) old (max {info['max_age_days']})", "")]


# --- snapshot -------------------------------------------------------------------


def _safe(name: str) -> bool:
    return 0 < len(name) <= 128 and all(ch in _SAFE_NAME for ch in name)


def _bracket(name: str) -> str:
    return "[" + name.replace("]", "]]") + "]"


def render_type(data_type: str, char_max: Any, precision: Any, scale: Any, dt_precision: Any) -> str:
    t = data_type.lower()
    if t in ("varchar", "nvarchar", "char", "nchar", "binary", "varbinary"):
        if char_max in (-1, "-1"):
            return f"{t}(max)"
        return f"{t}({char_max})" if char_max not in (None, "") else t
    if t in ("decimal", "numeric"):
        if precision not in (None, "") and scale not in (None, ""):
            return f"{t}({precision}, {scale})"
        return t
    if t in ("datetime2", "datetimeoffset", "time") and dt_precision not in (None, ""):
        return f"{t}({dt_precision})"
    return t


def _rows(cursor: Any, sql: str, limit: int) -> tuple[list[tuple[Any, ...]], bool]:
    cursor.execute(sql, ())
    out: list[tuple[Any, ...]] = []
    while True:
        row = cursor.fetchone()
        if row is None:
            break
        out.append(tuple(row))
        if len(out) > limit:
            return out[:limit], True
    return out, False


def _header(target: dict[str, str], taken_at: str, schema: str, name: str, kind: str) -> str:
    return (
        f"-- coop catalog snapshot: {kind} {schema}.{name}\n"
        f"-- target: {target.get('environment', '')} {target.get('kind', '')} database {target.get('database', '')}, taken {taken_at}\n"
        "-- Read-only copy of what the catalog held at that time. Never deploy from this file; refresh with: coop catalog snapshot\n\n"
    )


def render_table(schema: str, name: str, columns: list[tuple[Any, ...]]) -> str:
    lines = []
    for col in columns:
        col_name, data_type, char_max, precision, scale, dt_precision, nullable = (list(col) + [None] * 7)[:7]
        col_name = _text(col_name)
        if not col_name:
            continue
        type_text = render_type(_text(data_type) or "sql_variant", char_max, precision, scale, dt_precision)
        null_text = "NULL" if _text(nullable).upper() != "NO" else "NOT NULL"
        lines.append(f"    {_bracket(col_name)} {type_text} {null_text}")
    body = ",\n".join(lines)
    return f"CREATE TABLE {_bracket(schema)}.{_bracket(name)} (\n{body}\n);\n"


def _readme(target: dict[str, str], environment: str) -> str:
    return (
        "# coop catalog snapshot\n\n"
        f"A read-only copy of the {environment} catalog ({target.get('kind', '')}, database `{target.get('database', '')}`): "
        "one file per table (a `CREATE TABLE` built from the catalog's columns), view, procedure and function "
        "(the definition the catalog holds), and `manifest.json` with the time it was taken.\n\n"
        "coop reads these files before it writes SQL for this client, so it knows the tables and columns that exist, "
        "and coop-data-doc can build lineage from them when the client has no SQL repository. "
        "It holds no row data, no credential and no server name.\n\n"
        "It is never a deployment artifact: nothing is run from this folder. Refresh it with `coop catalog snapshot` "
        "(or the `catalog_snapshot` tool in a session) and commit the result.\n"
    )


def snapshot(*, cwd: Path | None = None, project_arg: str | None = None, now: datetime | None = None) -> dict[str, Any]:
    project, path = _load(cwd, project_arg)
    if project is None or path is None:
        return sql_query.result("project_unavailable")
    environment = default_environment(project)
    folder, chosen = resolve_output(project, path, environment)
    root = path.resolve().parent.parent
    try:
        rel = folder.relative_to(root).as_posix()
    except ValueError:
        rel = folder.as_posix()
    if folder.exists():
        if not folder.is_dir():
            return sql_query.result("output_not_snapshot", path=rel)
        if read_manifest(folder) is None and any(folder.iterdir()):
            return sql_query.result("output_not_snapshot", path=rel)

    connection, target, _driver, error = sql_query.open_connection(cwd=cwd if project_arg is None else path.parent.parent)
    if error is not None or connection is None or target is None:
        return error or sql_query.result("connection_failed")
    if target.environment not in ("dev", "test"):
        try:
            connection.close()
        except Exception:
            pass
        return sql_query.result("target_not_dev_or_test", environment=target.environment)
    summary = target.summary()
    taken_at = (now or datetime.now(timezone.utc)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    try:
        connection.timeout = sql_query.QUERY_TIMEOUT
        cursor = connection.cursor()
        try:
            objects, objects_truncated = _rows(cursor, OBJECTS_SQL, MAX_OBJECTS)
        except Exception:
            return sql_query.result("query_failed", stage="objects")
        try:
            columns, columns_truncated = _rows(cursor, COLUMNS_SQL, MAX_COLUMNS)
        except Exception:
            return sql_query.result("query_failed", stage="columns")
        unavailable: list[str] = []
        modules: dict[tuple[str, str], str] = {}
        try:
            module_rows, _ = _rows(cursor, MODULES_SQL, MAX_OBJECTS)
            for row in module_rows:
                schema, name, definition = (list(row) + [None] * 3)[:3]
                if _text(schema) and _text(name) and isinstance(definition, str):
                    modules[(_text(schema), _text(name))] = definition[:MAX_DEFINITION_CHARS]
        except Exception:
            unavailable.append("definitions (sys.sql_modules is not readable on this target)")
    except Exception:
        return sql_query.result("query_failed")
    finally:
        try:
            connection.close()
        except Exception:
            pass

    by_table: dict[tuple[str, str], list[tuple[Any, ...]]] = {}
    for row in columns:
        schema, name = _text(row[0]), _text(row[1])
        if schema and name:
            by_table.setdefault((schema, name), []).append(tuple(row[2:9]))

    files: list[tuple[str, str]] = []  # (relative path, content)
    counts = {key: 0 for key in COUNT_KEYS}
    skipped: list[str] = []
    for row in objects:
        schema, name, type_code = _text(row[0]), _text(row[1]), _text(row[2]).upper()
        kind = OBJECT_TYPES.get(type_code)
        if not kind or not _safe(schema) or not _safe(name):
            if schema or name:
                skipped.append(f"{schema}.{name}")
            continue
        key = (schema, name)
        if kind == "table":
            body = render_table(schema, name, by_table.get(key, []))
        else:
            definition = modules.get(key)
            if definition is None:
                cols = by_table.get(key)
                if kind == "view" and cols:
                    body = "-- definition not readable on this target; columns from INFORMATION_SCHEMA.COLUMNS\n" + render_table(schema, name, cols).replace("CREATE TABLE", "-- VIEW", 1)
                else:
                    skipped.append(f"{schema}.{name} ({kind}: definition not readable)")
                    continue
            else:
                body = definition.strip() + "\n"
        counts[kind + "s"] += 1
        files.append((f"{schema}/{name}.sql", _header(summary, taken_at, schema, name, kind) + body))

    folder.mkdir(parents=True, exist_ok=True)
    previous = read_manifest(folder) or {}
    for old in previous.get("files") or []:
        if isinstance(old, str) and old.endswith(".sql") and ".." not in old:
            try:
                (folder / old).unlink()
            except OSError:
                pass
    for child in list(folder.iterdir()):
        if child.is_dir() and not any(child.iterdir()):
            shutil.rmtree(child, ignore_errors=True)
    for rel_file, content in files:
        target_file = folder / rel_file
        target_file.parent.mkdir(parents=True, exist_ok=True)
        target_file.write_text(content, encoding="utf-8", newline="\n")
    manifest = {
        "coop_catalog_snapshot": True,
        "schema_version": SCHEMA_VERSION,
        "taken_at": taken_at,
        "target": summary,
        "objects": counts,
        "files": sorted(rel_file for rel_file, _ in files),
        "truncated": {"objects": objects_truncated, "columns": columns_truncated},
        "unavailable": unavailable,
        "skipped": skipped[:200],
    }
    (folder / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    (folder / "README.md").write_text(_readme(summary, environment), encoding="utf-8", newline="\n")
    return sql_query.result(
        "ok",
        path=rel,
        chosen_by=chosen,
        environment=environment,
        target=summary,
        taken_at=taken_at,
        objects=counts,
        files=len(files),
        truncated=manifest["truncated"],
        unavailable=unavailable,
        skipped=len(skipped),
    )


# --- entry points -----------------------------------------------------------------


def execute(payload: Any, *, cwd: Path | None = None) -> dict[str, Any]:
    """stdin contract for the coop-tools `catalog_snapshot` tool: {"command": "snapshot"|"status"}."""
    if not isinstance(payload, dict) or set(payload) - {"command"}:
        return sql_query.result("input_invalid")
    command = payload.get("command", "status")
    if command == "status":
        return status(cwd=cwd)
    if command == "snapshot":
        return snapshot(cwd=cwd)
    return sql_query.result("input_invalid")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="catalog_snapshot", description=__doc__.splitlines()[0])
    parser.add_argument("--project", help="path to .coop/project.yml (default: nearest above the current folder)")
    parser.add_argument("command", nargs="?", choices=["snapshot", "status", "doctor-lines"], help="omit to read {\"command\": ...} from stdin")
    args = parser.parse_args(argv)
    if args.command == "doctor-lines":
        for level, message, hint in doctor_lines(project_arg=args.project):
            sys.stdout.write(f"{level}\t{message}\t{hint}\n")
        return 0
    if args.command is None:
        try:
            payload = json.load(sys.stdin)
        except (UnicodeDecodeError, json.JSONDecodeError):
            payload = None
        try:
            output = execute(payload)
        except Exception:
            output = sql_query.result("internal_error")
    else:
        try:
            output = snapshot(project_arg=args.project) if args.command == "snapshot" else status(project_arg=args.project)
        except Exception:
            output = sql_query.result("internal_error")
    sys.stdout.write(json.dumps(output, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
    return 0 if output["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

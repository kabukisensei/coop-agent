#!/usr/bin/env python3
"""Deterministic schema compare between two SQL environments (master plan SQ10).

Reads the catalog of two sides read-only and writes a stable, sorted diff plus
an ordered promotion script, so a team can see exactly what dev holds that prod
does not (or the other way round) and carry the change over by hand or through
coop's governed write path. The tool never writes to any target: its only output
is two files under the contract's compare folder.

A side is one of the contract's `sql_targets` entries (`dev`, `test`, `prod`),
read exactly as lib/sql_query.py reads it (`open_connection(environment=...)`:
same identity pinning, driver, encryption and timeouts; production reads are
plain reads); `snapshot`, the committed dev catalog snapshot
(lib/catalog_snapshot.py), so a compare can run against the state the team
committed rather than whatever dev holds this minute; or `repo[:<name>[/<sub>]]`,
the schema as code: the `.sql` files of one of the contract's `repositories`
entries with role `sql` or `mixed` (its `sql_root` or a named subfolder), read
by lib/sql_source.py with no connection. Any pairing works: repo against repo,
live against live, repo against live.

What is compared, per object, sorted by schema then name:

- schemas (user schemas that hold compared objects, plus `sys.schemas` without the
  system ones and Fabric's internal underscore-prefixed schemas such as `_rsc`);
- tables: every column's name, rendered type, nullability and position
  (INFORMATION_SCHEMA.COLUMNS);
- views, procedures and functions: the definition the catalog holds
  (sys.sql_modules), compared with whitespace and line endings normalized.

The script is ordered so it can run top to bottom: new schemas, new tables,
column changes, then functions, views and procedures (each set topologically
sorted by the names its definition mentions, then by name), with every removal
and every change that can lose data emitted last as commented-out statements
under a DESTRUCTIVE banner, because a table rebuild on a Fabric Warehouse and a
DROP anywhere are a person's decision. On Fabric Warehouse and Lakehouse the
column changes are rendered as a rebuild note, not `ALTER TABLE ... ADD`, since
the Warehouse does not alter columns in place. Constraints, indexes, permissions,
row data and everything outside those object kinds are out of scope and the
report says so. No credential, connection string, server name or exception text
appears in a result or a file.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import catalog_snapshot as snapshot_lib  # noqa: E402
import sql_query  # noqa: E402
import sql_source  # noqa: E402
import warehouse_mcp as wmcp  # noqa: E402

SCHEMA_VERSION = 1
ENVIRONMENTS = ("dev", "test", "prod")
SIDES = ENVIRONMENTS + ("snapshot",)
REPO_SIDE = re.compile(r"^repo(?::([A-Za-z0-9_.-]+)((?:/[A-Za-z0-9_. -]+)*))?$")
REPO_ROLES = ("sql", "mixed")
DEFAULT_TARGET = "prod"
MAX_SCHEMAS = 1000
MAX_CHANGES_IN_RESULT = 200
# A schema filter (`schemas` keeps only those, `exclude` drops those; names match
# case-insensitively) applies to both sides before the diff (Aaron, 2026-10-21).
MAX_FILTER_SCHEMAS = 50
SQLSC_SCHEMA = "sqlsc"
FILTER_SCHEMA = re.compile(r"^[^\[\]\x00-\x1f;'\"-][^\[\]\x00-\x1f;'\"]{0,127}$")
MODULE_KINDS = ("function", "view", "procedure")
# Kinds that cannot alter a column in place: the script renders a rebuild note.
REBUILD_KINDS = ("fabric_warehouse", "fabric_lakehouse")
SYSTEM_SCHEMAS = {"sys", "information_schema", "guest", "queryinsights", "dbo", "_rsc"}
# Fabric keeps internal, underscore-prefixed schemas (`_rsc` today) that hold no user
# object; the catalog snapshot never sees them, so the live side skips them too. An
# underscore-prefixed schema that does hold user objects is a user schema and stays.
INTERNAL_SCHEMA_PREFIX = "_"

SCHEMAS_SQL = (
    f"SELECT TOP ({MAX_SCHEMAS + 1}) s.name FROM sys.schemas AS s "
    "WHERE s.schema_id < 16384 AND s.name NOT LIKE 'db[_]%' ORDER BY s.name"
)
OBJECTS_SQL = snapshot_lib.OBJECTS_SQL
COLUMNS_SQL = snapshot_lib.COLUMNS_SQL
MODULES_SQL = snapshot_lib.MODULES_SQL

_IDENT = r"[A-Za-z_][A-Za-z0-9_@#$]{0,127}"
_SNAPSHOT_HEADER = re.compile(r"^-- coop catalog snapshot: (table|view|procedure|function) (\S+)\.(\S+)$")
_SNAPSHOT_COLUMN = re.compile(r"^\s{4}\[(.+?)\] (.+?) (NULL|NOT NULL)$")
MODULE_WORDS = ("VIEW", "PROC", "PROCEDURE", "FUNCTION")
# A database's own schemas: they exist in every database and cannot be created or
# dropped, so a compare never offers them as a change (objects in them still compare).
INTRINSIC_SCHEMAS = {"dbo", "guest", "sys", "information_schema"}
_SKIPPED = re.compile(r"^(.+?)(?: \((table|view|procedure|function): definition not readable\))?$")
MAX_SKIPPED = 200


# --- catalog model -----------------------------------------------------------------


class Column:
    __slots__ = ("name", "type", "nullable", "position")

    def __init__(self, name: str, type_text: str, nullable: bool, position: int) -> None:
        self.name = name
        self.type = type_text
        self.nullable = nullable
        self.position = position

    def render(self) -> str:
        return f"{_bracket(self.name)} {self.type} {'NULL' if self.nullable else 'NOT NULL'}"


class Catalog:
    """One side's catalog: schemas, tables with columns, modules with definitions."""

    def __init__(self) -> None:
        self.schemas: set[str] = set()
        self.tables: dict[tuple[str, str], list[Column]] = {}
        self.modules: dict[tuple[str, str], tuple[str, str]] = {}  # (kind, definition)
        self.truncated: list[str] = []
        self.unavailable: list[str] = []
        self.notes: list[str] = []
        # `schema.name` (lower case) of objects a snapshot skipped: present, but unread.
        self.skipped: set[str] = set()
        # Tables whose column list a repo side could not fully read: it proves no column absent.
        self.incomplete: set[tuple[str, str]] = set()

    def kinds(self) -> dict[tuple[str, str], str]:
        out = {key: "table" for key in self.tables}
        out.update({key: kind for key, (kind, _definition) in self.modules.items()})
        return out


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ("" if value is None else str(value))


def _bracket(name: str) -> str:
    return "[" + name.replace("]", "]]") + "]"


def _qualified(key: tuple[str, str]) -> str:
    return f"{_bracket(key[0])}.{_bracket(key[1])}"


def _plain(key: tuple[str, str]) -> str:
    return f"{key[0]}.{key[1]}"


def _segments(sql: str) -> list[tuple[str, str]]:
    """The text as (kind, text) runs: `ws`, `comment` (line or nested block),
    `string` ('...' with '' escapes), `ident` ([...] with ]] escapes, "..." with ""
    escapes) and `code` (everything else). Joined back, the runs are the text."""
    out: list[tuple[str, str]] = []
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        if ch.isspace() or ch == "\ufeff":  # a byte-order mark reads as whitespace
            end = i
            while end < n and (sql[end].isspace() or sql[end] == "\ufeff"):
                end += 1
            out.append(("ws", sql[i:end]))
        elif sql.startswith("--", i):
            end = sql.find("\n", i)
            end = n if end < 0 else end
            out.append(("comment", sql[i:end]))
        elif sql.startswith("/*", i):
            depth, end = 1, i + 2
            while end < n and depth:
                if sql.startswith("/*", end):
                    depth, end = depth + 1, end + 2
                elif sql.startswith("*/", end):
                    depth, end = depth - 1, end + 2
                else:
                    end += 1
            out.append(("comment", sql[i:end]))
        elif ch in "'[\"":
            close = "]" if ch == "[" else ch
            end = i + 1
            while end < n:
                if sql[end] == close:
                    if end + 1 < n and sql[end + 1] == close:
                        end += 2
                        continue
                    end += 1
                    break
                end += 1
            out.append(("string" if ch == "'" else "ident", sql[i:end]))
        else:
            end = i + 1
            while end < n and not (sql[end].isspace() or sql[end] == "\ufeff" or sql[end] in "'[\"" or sql.startswith("--", end) or sql.startswith("/*", end)):
                end += 1
            out.append(("code", sql[i:end]))
        i = end
    return out


def _code_only(sql: str) -> str:
    """The text with comments and string literals blanked: what names objects."""
    return "".join(" " if kind in ("comment", "string") else text for kind, text in _segments(sql))


def _words(runs: list[tuple[str, str]], start: int, count: int) -> list[tuple[int, str]]:
    """The next `count` code or identifier runs from `start`, skipping whitespace and comments."""
    out: list[tuple[int, str]] = []
    for index in range(start, len(runs)):
        if runs[index][0] in ("ws", "comment"):
            continue
        out.append((index, runs[index][1]))
        if len(out) == count:
            break
    return out


def normalize_definition(definition: str) -> str:
    """Whitespace outside string literals and quoted names folded (a line break
    stays a line break, blank lines go), a leading comment banner, `OR ALTER` (or
    a leading `ALTER`) and trailing `;` dropped: a definition reformatted by an
    editor or kept in a repo file is not a change; a changed token, string literal
    or quoted name is."""
    runs = _segments(definition.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff"))
    while runs and runs[0][0] in ("ws", "comment"):
        runs.pop(0)
    head = _words(runs, 0, 3)
    words = [w.upper() for _, w in head]
    if words[:3] == ["CREATE", "OR", "ALTER"]:
        runs = runs[: head[0][0] + 1] + runs[head[2][0] + 1 :]
    elif words[:1] == ["ALTER"] and len(words) > 1 and words[1] in MODULE_WORDS:
        runs = [("code", "create" if head[0][1].islower() else "CREATE")] + runs[1:]
    out: list[str] = []
    for kind, text in runs:
        if kind == "ws":
            out.append("\n" if "\n" in text else " ")
        elif kind == "comment":
            out.append("\n".join(re.sub(r"[ \t]+", " ", line).rstrip() for line in text.split("\n")))
        else:
            out.append(text)
    body = "".join(out).strip()
    while body.endswith(";"):
        body = body[:-1].rstrip()
    return body


# --- live side ---------------------------------------------------------------------


def _rows(cursor: Any, sql: str, limit: int) -> tuple[list[tuple[Any, ...]], bool]:
    cursor.execute(sql, ())
    out: list[tuple[Any, ...]] = []
    while True:
        row = cursor.fetchone()
        if row is None:
            return out, False
        out.append(tuple(row))
        if len(out) > limit:
            return out[:limit], True


def read_live(cursor: Any) -> Catalog:
    """The four fixed, parameter-free catalog queries on an open cursor."""
    catalog = Catalog()
    try:
        rows, truncated = _rows(cursor, SCHEMAS_SQL, MAX_SCHEMAS)
        listed = {_text(r[0]) for r in rows if _text(r[0]) and _text(r[0]).lower() not in SYSTEM_SCHEMAS}
        if truncated:
            catalog.truncated.append("schemas")
    except Exception:
        listed = set()
        catalog.unavailable.append("schemas (sys.schemas is not readable on this target; schemas come from the objects)")
    objects, truncated = _rows(cursor, OBJECTS_SQL, snapshot_lib.MAX_OBJECTS)
    if truncated:
        catalog.truncated.append("objects")
    columns, truncated = _rows(cursor, COLUMNS_SQL, snapshot_lib.MAX_COLUMNS)
    if truncated:
        catalog.truncated.append("columns")
    by_table: dict[tuple[str, str], list[Column]] = {}
    for row in columns:
        schema, name, col_name, data_type, char_max, precision, scale, dt_precision, nullable, position = (list(row) + [None] * 10)[:10]
        if not (_text(schema) and _text(name) and _text(col_name)):
            continue
        type_text = snapshot_lib.render_type(_text(data_type) or "sql_variant", char_max, precision, scale, dt_precision)
        by_table.setdefault((_text(schema), _text(name)), []).append(
            Column(_text(col_name), type_text, _text(nullable).upper() != "NO", int(position) if isinstance(position, int) else len(by_table.get((_text(schema), _text(name)), [])) + 1)
        )
    modules: dict[tuple[str, str], str] = {}
    try:
        module_rows, _ = _rows(cursor, MODULES_SQL, snapshot_lib.MAX_OBJECTS)
        for row in module_rows:
            schema, name, definition = (list(row) + [None] * 3)[:3]
            if _text(schema) and _text(name) and isinstance(definition, str):
                modules[(_text(schema), _text(name))] = definition[: snapshot_lib.MAX_DEFINITION_CHARS]
    except Exception:
        catalog.unavailable.append("definitions (sys.sql_modules is not readable on this target; views, procedures and functions compare by name only)")
    for row in objects:
        schema, name, type_code = _text(row[0]), _text(row[1]), _text(row[2]).upper()
        kind = snapshot_lib.OBJECT_TYPES.get(type_code)
        if not kind or not schema or not name:
            continue
        key = (schema, name)
        catalog.schemas.add(schema)
        if kind == "table":
            catalog.tables[key] = sorted(by_table.get(key, []), key=lambda c: (c.position, c.name))
        else:
            catalog.modules[key] = (kind, modules.get(key, ""))
    catalog.schemas |= {s for s in listed if not (s.startswith(INTERNAL_SCHEMA_PREFIX) and s not in catalog.schemas)}
    return catalog


# --- snapshot side -------------------------------------------------------------------


def read_snapshot(folder: Path) -> tuple[Catalog | None, str]:
    """The committed snapshot as a Catalog, or (None, state). Every file the
    manifest lists must be there, inside the folder, under its snapshot header:
    a missing or damaged one fails as `snapshot_incomplete` rather than reading
    as an object the side does not have. What the writer recorded as cut,
    unavailable or skipped comes back on the Catalog."""
    manifest = snapshot_lib.read_manifest(folder)
    if manifest is None:
        return None, "snapshot_missing"
    catalog = Catalog()
    truncated = manifest.get("truncated")
    if isinstance(truncated, dict):
        catalog.truncated = sorted(str(k) for k, v in truncated.items() if v is True)
    catalog.unavailable = [v for v in (manifest.get("unavailable") or []) if isinstance(v, str)]
    skipped = [v for v in (manifest.get("skipped") or []) if isinstance(v, str)]
    if len(skipped) >= MAX_SKIPPED:
        catalog.truncated.append("skipped objects")
    root = folder.resolve()
    files = manifest.get("files") or []
    if not isinstance(files, list):
        return None, "snapshot_incomplete"
    for rel in files:
        if not isinstance(rel, str) or not rel.endswith(".sql") or ".." in rel or os.path.isabs(rel):
            return None, "snapshot_incomplete"
        path = (folder / rel).resolve()
        if root not in path.parents:
            return None, "snapshot_incomplete"
        try:
            content = path.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeDecodeError):
            return None, "snapshot_incomplete"
        lines = content.replace("\r\n", "\n").split("\n")
        head = _SNAPSHOT_HEADER.match(lines[0] if lines else "")
        if not head:
            return None, "snapshot_incomplete"
        kind, schema, name = head.group(1), head.group(2), head.group(3)
        body_start = 0
        for index, line in enumerate(lines):
            if not line.startswith("--") and line.strip():
                body_start = index
                break
        key = (schema, name)
        catalog.schemas.add(schema)
        if kind == "table":
            cols: list[Column] = []
            for line in lines[body_start:]:
                col = _SNAPSHOT_COLUMN.match(line.rstrip(","))
                if col:
                    cols.append(Column(col.group(1).replace("]]", "]"), col.group(2), col.group(3) == "NULL", len(cols) + 1))
            catalog.tables[key] = cols
        elif any(line.startswith("-- definition not readable") for line in lines[1 : body_start + 1]):
            catalog.modules[key] = (kind, "")
        else:
            catalog.modules[key] = (kind, "\n".join(lines[body_start:]))
    for item in skipped:
        # A module whose definition was not readable is there, definition unknown;
        # a name unsafe as a file name is there, kind unknown.
        match = _SKIPPED.match(item)
        name_text, kind = (match.group(1), match.group(2)) if match else (item, None)
        schema, dot, name = name_text.partition(".")
        if kind and kind != "table" and dot and (schema, name) not in catalog.modules:
            catalog.schemas.add(schema)
            catalog.modules[(schema, name)] = (kind, "")
        else:
            catalog.skipped.add(name_text.lower())
    return catalog, "ok"


# --- repo side -----------------------------------------------------------------------


def _is_todo(value: str) -> bool:
    return not value or value.strip().upper().startswith("TODO")


def _repo_entries(project: dict[str, Any]) -> dict[str, tuple[str, str]]:
    """name -> (local_path, sql_root) for every sql or mixed repository with a path."""
    repos = project.get("repositories")
    out: dict[str, tuple[str, str]] = {}
    if not isinstance(repos, dict):
        return out
    for name, entry in repos.items():
        if not isinstance(entry, dict) or not isinstance(name, str):
            continue
        role = _text(entry.get("role")).lower().replace("-", "_")
        local_path = _text(entry.get("local_path"))
        if role in REPO_ROLES and not _is_todo(local_path):
            sql_root = _text(entry.get("sql_root"))
            out[name] = (local_path, "" if _is_todo(sql_root) else sql_root)
    return out


def resolve_repo(side: str, project: dict[str, Any], project_path: Path) -> tuple[Path | None, str, str]:
    """(folder, label, state) for a `repo[:<name>[/<sub>]]` side: the named
    repository (the only sql/mixed one when unnamed), its `sql_root` unless a
    subfolder is named, and never a path outside the repository."""
    match = REPO_SIDE.match(side)
    if not match or ".." in side:
        return None, "", "input_invalid"
    name, sub = match.group(1), (match.group(2) or "").strip("/")
    entries = _repo_entries(project)
    if name is None:
        if len(entries) != 1:
            return None, "", "repo_missing" if not entries else "repo_ambiguous"
        name = next(iter(entries))
    if name not in entries:
        return None, "", "repo_missing"
    local_path, sql_root = entries[name]
    root = (project_path.resolve().parent.parent / os.path.expanduser(local_path)).resolve()
    folder = (root / (sub or sql_root)).resolve() if (sub or sql_root) else root
    if folder != root and root not in folder.parents:
        return None, "", "input_invalid"
    if not folder.is_dir():
        return None, "", "repo_unavailable"
    label = name + (f"/{sub}" if sub else "")
    return folder, label, "ok"


def read_repo(folder: Path) -> Catalog:
    """The folder's `.sql` files as a Catalog (lib/sql_source.py)."""
    parsed = sql_source.parse_folder(folder)
    catalog = Catalog()
    catalog.schemas = set(parsed.schemas)
    for key, columns in parsed.tables.items():
        catalog.tables[key] = [Column(name, type_text, nullable, position) for position, (name, type_text, nullable) in enumerate(columns, 1)]
    catalog.modules = dict(parsed.modules)
    catalog.incomplete = set(parsed.incomplete)
    catalog.notes = sql_source.describe(parsed)
    return catalog


# --- diff ---------------------------------------------------------------------------


def _change(kind: str, key: tuple[str, str], action: str, detail: str = "", destructive: bool = False) -> dict[str, Any]:
    item: dict[str, Any] = {"kind": kind, "schema": key[0], "name": key[1], "action": action}
    if detail:
        item["detail"] = detail
    if destructive:
        item["destructive"] = True
    return item


def compare_tables(source: list[Column], target: list[Column]) -> tuple[list[str], bool]:
    """Column differences in words; True when applying them can lose data."""
    src = {c.name.lower(): c for c in source}
    tgt = {c.name.lower(): c for c in target}
    details: list[str] = []
    lossy = False
    for name in sorted(set(src) - set(tgt)):
        details.append(f"add column {src[name].render()}")
        if not src[name].nullable:
            lossy = True  # a NOT NULL column cannot be added to a table that holds rows without a default
    for name in sorted(set(tgt) - set(src)):
        details.append(f"drop column {_bracket(tgt[name].name)}")
        lossy = True
    for name in sorted(set(src) & set(tgt)):
        a, b = src[name], tgt[name]
        if a.type != b.type:
            details.append(f"change column {_bracket(a.name)} type {b.type} -> {a.type}")
            lossy = True
        if a.nullable != b.nullable:
            details.append(f"change column {_bracket(a.name)} {'NULL' if b.nullable else 'NOT NULL'} -> {'NULL' if a.nullable else 'NOT NULL'}")
            if not a.nullable:
                lossy = True
    if [c.name.lower() for c in source] != [c.name.lower() for c in target] and not (set(src) ^ set(tgt)):
        details.append("columns reordered")
    return details, lossy


def diff(source: Catalog, target: Catalog) -> list[dict[str, Any]]:
    """Every difference, sorted by kind order then schema then name. Direction:
    what the target needs to match the source."""
    changes: list[dict[str, Any]] = []
    src_kinds, tgt_kinds = source.kinds(), target.kinds()
    src_schemas = {s for s in source.schemas if s.lower() not in INTRINSIC_SCHEMAS}
    tgt_schemas = {s for s in target.schemas if s.lower() not in INTRINSIC_SCHEMAS}
    # A side whose list was cut, or that skipped objects, cannot prove an absence.
    if "schemas" not in target.truncated:
        for schema in sorted(src_schemas - tgt_schemas, key=str.lower):
            changes.append(_change("schema", (schema, ""), "add"))
    if "schemas" not in source.truncated:
        for schema in sorted(tgt_schemas - src_schemas, key=str.lower):
            changes.append(_change("schema", (schema, ""), "drop", destructive=True))
    for key in sorted(set(src_kinds) | set(tgt_kinds), key=lambda k: (k[0].lower(), k[1].lower())):
        src_kind, tgt_kind = src_kinds.get(key), tgt_kinds.get(key)
        if src_kind and tgt_kind and src_kind != tgt_kind:
            changes.append(_change(src_kind, key, "replace", f"a {tgt_kind} on the target, a {src_kind} on the source", destructive=True))
            continue
        missing_from = target if src_kind and not tgt_kind else source if tgt_kind and not src_kind else None
        if missing_from is not None and ("objects" in missing_from.truncated or f"{key[0]}.{key[1]}".lower() in missing_from.skipped):
            side = "target" if missing_from is target else "source"
            why = "its object list was cut at the compare cap" if "objects" in missing_from.truncated else "its snapshot skipped this object"
            changes.append(_change(src_kind or tgt_kind or "", key, "unknown", f"not read on the {side} ({why}); compare by hand"))
            continue
        if src_kind and not tgt_kind:
            if src_kind == "table":
                changes.append(_change("table", key, "add", f"{len(source.tables[key])} column(s)"))
            else:
                changes.append(_change(src_kind, key, "add"))
            continue
        if tgt_kind and not src_kind:
            changes.append(_change(tgt_kind, key, "drop", destructive=True))
            continue
        if src_kind == "table":
            unread = [side for side, cat in (("source", source), ("target", target)) if key in cat.incomplete]
            if unread:
                # A column the reader lost would show as a drop (or an add): never script that.
                changes.append(_change("table", key, "unknown", f"a column could not be read on the {' and '.join(unread)} side; compare its columns by hand"))
                continue
            details, lossy = compare_tables(source.tables[key], target.tables[key])
            if details:
                changes.append(_change("table", key, "alter", "; ".join(details), destructive=lossy))
        else:
            src_def, tgt_def = source.modules[key][1], target.modules[key][1]
            if not src_def or not tgt_def:
                if not src_def and not tgt_def:
                    continue
                changes.append(_change(src_kind, key, "unknown", "definition not readable on one side; compare by hand"))
            elif normalize_definition(_as_named(src_def, key)) != normalize_definition(_as_named(tgt_def, key)):
                changes.append(_change(src_kind, key, "alter", "definition differs"))
    return changes


def _as_named(definition: str, key: tuple[str, str]) -> str:
    """The definition declaring the object it is filed under. A module renamed with
    sp_rename (or moved with ALTER SCHEMA ... TRANSFER) keeps its old name in
    sys.sql_modules; the catalog's name is the object, so the old declared name is
    neither a difference nor what a script may create."""
    return sql_source.with_identity(definition, key[0], key[1])[0]


# --- script -----------------------------------------------------------------------------


def _mentions(definition: str, names: set[str]) -> set[str]:
    lowered = _code_only(definition).lower()
    return {name for name in names if re.search(r"\b" + re.escape(name.lower()) + r"\b", lowered)}


def _references(definition: str, keys: list[tuple[str, str]]) -> set[tuple[str, str]]:
    """The objects among `keys` a definition names: `schema.name` (brackets or not)
    resolves exactly; a bare name resolves only when one object in the set has it.
    Comments and string literals name nothing."""
    lowered = _code_only(definition).lower()
    out: set[tuple[str, str]] = set()
    counts: dict[str, int] = {}
    for key in keys:
        counts[key[1].lower()] = counts.get(key[1].lower(), 0) + 1
    for key in keys:
        schema, name = key[0].lower(), key[1].lower()
        qualified = r"\[?" + re.escape(schema) + r"\]?\s*\.\s*\[?" + re.escape(name) + r"\]?"
        if re.search(r"(?<![\w\].])" + qualified + r"(?![\w\[])", lowered):
            out.add(key)
        elif counts[name] == 1 and re.search(r"(?<![\w.])\[?" + re.escape(name) + r"\]?(?![\w\[])", lowered):
            out.add(key)
    return out


def _ordered(keys: list[tuple[str, str]], definitions: dict[tuple[str, str], str], kinds: dict[tuple[str, str], str] | None = None) -> list[tuple[str, str]]:
    """Topological order by the objects each definition names, across kinds (a
    function over a view follows the view); ties by kind order then name, a cycle
    placed by that same order (`cycles` names its members)."""
    return _order(keys, definitions, kinds)[0]


def _cycles(keys: list[tuple[str, str]], definitions: dict[tuple[str, str], str]) -> set[tuple[str, str]]:
    """The objects that name each other round in a circle: no order is right for them."""
    return _order(keys, definitions, None)[1]


def _order(keys: list[tuple[str, str]], definitions: dict[tuple[str, str], str], kinds: dict[tuple[str, str], str] | None) -> tuple[list[tuple[str, str]], set[tuple[str, str]]]:
    rank = {kind: i for i, kind in enumerate(MODULE_KINDS)}

    def order(k: tuple[str, str]) -> tuple[int, str, str]:
        return (rank.get((kinds or {}).get(k, ""), len(rank)), k[0].lower(), k[1].lower())

    pending = sorted(keys, key=order)
    deps = {k: _references(definitions.get(k, ""), pending) - {k} for k in pending}
    out: list[tuple[str, str]] = []
    placed: set[tuple[str, str]] = set()
    circular: set[tuple[str, str]] = set()
    while pending:
        ready = [k for k in pending if deps[k] <= placed]
        if not ready:
            # Stuck: the objects that reach themselves are the cycle; whatever only
            # waits on them is ready once they are placed.
            ready = [k for k in pending if k in _reachable(k, deps, placed)]
            circular.update(ready)
        for k in ready:
            out.append(k)
            placed.add(k)
            pending.remove(k)
    return out, circular


def _reachable(start: tuple[str, str], deps: dict[tuple[str, str], set[tuple[str, str]]], placed: set[tuple[str, str]]) -> set[tuple[str, str]]:
    seen: set[tuple[str, str]] = set()
    stack = [d for d in deps[start] if d not in placed]
    while stack:
        k = stack.pop()
        if k not in seen:
            seen.add(k)
            stack.extend(d for d in deps[k] if d not in placed)
    return seen


def _rebuilt_columns(changes: list[dict[str, Any]]) -> dict[tuple[str, str], set[str]]:
    """Per altered table, the columns its detail adds: a module that names one
    cannot bind until the table is rebuilt (a dropped or retyped column binds
    either way)."""
    out: dict[tuple[str, str], set[str]] = {}
    for c in changes:
        if c["kind"] == "table" and c["action"] == "alter":
            names = {m.group(1).replace("]]", "]").lower() for m in re.finditer(r"add column \[(.+?)\] ", c.get("detail", ""))}
            if names:
                out[(c["schema"], c["name"])] = names
    return out


def _terminated(text: str) -> str:
    """One statement with exactly one trailing semicolon."""
    text = text.rstrip()
    return text if text.endswith(";") else text + ";"


def _create_or_alter(definition: str) -> str:
    """The definition with its leading `CREATE` (or `ALTER`) as `CREATE OR ALTER`,
    after any comment banner; comments, strings and the body are left as written."""
    runs = _segments(definition.strip())
    head = _words(runs, 0, 3)
    words = [w.upper() for _, w in head]
    if len(words) > 1 and words[0] in ("CREATE", "ALTER") and words[1] in MODULE_WORDS:
        runs[head[0][0]] = ("code", "CREATE OR ALTER")
    return "".join(text for _, text in runs)


def _drop_word(kind: str) -> str:
    return {"view": "VIEW", "procedure": "PROCEDURE", "function": "FUNCTION", "table": "TABLE", "schema": "SCHEMA"}[kind]


def render_script(
    source: Catalog, changes: list[dict[str, Any]], *, source_name: str, target_name: str, target_kind: str, taken_at: str
) -> tuple[str, int, int]:
    """(script text, statements to run, destructive statements commented out)."""
    rebuild = target_kind in REBUILD_KINDS
    live: list[str] = []
    destructive: list[str] = []

    def go(lines: list[str], text: str) -> None:
        lines.append(_terminated(text))
        lines.append("GO")
        lines.append("")

    for c in changes:
        if c["kind"] == "schema" and c["action"] == "add":
            go(live, f"CREATE SCHEMA {_bracket(c['schema'])}")
    for c in changes:
        if c["kind"] == "table" and c["action"] == "add":
            key = (c["schema"], c["name"])
            go(live, _render_table(source.tables[key], key))
    for c in changes:
        if c["kind"] == "table" and c["action"] == "alter":
            key = (c["schema"], c["name"])
            if rebuild:
                block = [
                    f"-- {_plain(key)}: {c['detail']}",
                    f"-- A {target_kind.replace('_', ' ')} does not alter columns in place: rebuild the table (CREATE TABLE AS SELECT into a new name, check the row count, then rename) and keep its rows.",
                    "-- Source shape:",
                    _render_table(source.tables[key], key),
                ]
                destructive.append("\n".join(block))
            else:
                for detail in c["detail"].split("; "):
                    statement, lossy = _alter_statement(key, detail, source.tables[key])
                    if statement is None:
                        continue
                    if lossy:
                        destructive.append(f"-- {_plain(key)}: {detail}\n{statement};")
                    else:
                        go(live, statement)
    definitions = {key: _as_named(definition, key) if definition else definition for key, (_kind, definition) in source.modules.items()}
    kinds = {key: kind for key, (kind, _definition) in source.modules.items()}
    keys = [(c["schema"], c["name"]) for c in changes if c["kind"] in MODULE_KINDS and c["action"] in ("add", "alter")]
    # On a target that rebuilds tables by hand, a module that names a column the
    # rebuild adds or changes cannot run until that rebuild: it goes below, after
    # the rebuild notes, with everything that depends on it.
    rebuilt = _rebuilt_columns(changes) if rebuild else {}
    deferred: dict[tuple[str, str], str] = {}
    order, circular = _order(keys, definitions, kinds)
    for key in order:
        kind = kinds.get(key, "")
        definition = definitions.get(key, "")
        if not definition:
            destructive.append(f"-- {kind} {_plain(key)}: definition not readable on the source; write it by hand")
            continue
        if key in circular:
            # Objects that name each other have no right order: a person runs them.
            others = sorted(_references(definition, sorted(circular)) - {key})
            reason = f"names {', '.join(_plain(o) for o in others)}, and those references lead back to it; run these in an order that works"
            deferred[key] = reason
            destructive.append(f"-- {kind} {_plain(key)}: circular reference: {reason}\n{_terminated(_create_or_alter(definition))}")
            continue
        waits_on = [dep for dep in _references(definition, list(deferred)) if dep != key]
        rebuilt_tables = [t for t in _references(definition, list(rebuilt)) if _mentions(definition, rebuilt[t])]
        if waits_on or rebuilt_tables:
            reason = "; ".join(
                [f"names {', '.join(sorted(_mentions(definition, rebuilt[t])))} of {_plain(t)}, which the target has only after that table's rebuild above" for t in sorted(rebuilt_tables)]
                + [f"follows {kind_word} {_plain(dep)} below" for dep in sorted(waits_on) for kind_word in [kinds.get(dep, "object")]]
            )
            deferred[key] = reason
            destructive.append(f"-- {kind} {_plain(key)}: run after the rebuild: {reason}\n{_terminated(_create_or_alter(definition))}")
            continue
        go(live, _create_or_alter(definition))
    for c in changes:
        if c["action"] == "replace":
            # The target holds another kind under this name: drop it, then create
            # the source's object, both by hand.
            key = (c["schema"], c["name"])
            if c["kind"] == "table":
                create = _render_table(source.tables[key], key) + ";"
            else:
                create = _terminated(_create_or_alter(definitions.get(key, ""))) if definitions.get(key) else f"-- {c['kind']} definition not readable on the source; write it by hand"
            destructive.append(f"-- {_plain(key)}: {c['detail']}\nDROP {_drop_word(_target_kind_of(c))} {_qualified(key)};\nGO\n{create}")
    for kind in ("procedure", "view", "function", "table"):
        for c in changes:
            if c["kind"] == kind and c["action"] == "drop":
                destructive.append(f"DROP {_drop_word(kind)} {_qualified((c['schema'], c['name']))};")
    for c in changes:
        if c["kind"] == "schema" and c["action"] == "drop":
            destructive.append(f"DROP SCHEMA {_bracket(c['schema'])};")
    for c in changes:
        if c["action"] == "unknown":
            destructive.append(f"-- {c['kind']} {_plain((c['schema'], c['name']))}: {c['detail']}")

    header = [
        f"-- coop schema compare: {source_name} -> {target_name}, taken {taken_at}",
        "-- Generated from the two catalogs, read-only. Review every statement; coop never runs this file itself.",
        "-- Run it against the target through coop's governed write path or your own deployment tool, top to bottom.",
        f"-- Statements: {sum(1 for line in live if line == 'GO')} to run, {len(destructive)} destructive or manual (commented out below).",
        "-- Out of scope: constraints, indexes, permissions, row data.",
        "",
    ]
    tail: list[str] = []
    if destructive:
        tail = [
            "-- ======================================================================",
            "-- DESTRUCTIVE OR MANUAL: each block below can lose data or needs a person.",
            "-- Nothing here runs until you uncomment it on purpose.",
            "-- ======================================================================",
            "",
        ]
        for block in destructive:
            tail.extend("-- " + line if not line.startswith("--") else line for line in block.split("\n"))
            tail.append("")
    return "\n".join(header + live + tail).rstrip() + "\n", sum(1 for line in live if line == "GO"), len(destructive)


def _target_kind_of(change: dict[str, Any]) -> str:
    match = re.match(r"a (\w+) on the target", change.get("detail", ""))
    return match.group(1) if match else change["kind"]


def _render_table(columns: list[Column], key: tuple[str, str]) -> str:
    body = ",\n".join("    " + col.render() for col in columns)
    return f"CREATE TABLE {_qualified(key)} (\n{body}\n)"


def _alter_statement(key: tuple[str, str], detail: str, columns: list[Column]) -> tuple[str | None, bool]:
    by_name = {c.name.lower(): c for c in columns}
    add = re.match(r"^add column \[(.+?)\] ", detail)
    if add:
        col = by_name.get(add.group(1).replace("]]", "]").lower())
        return (f"ALTER TABLE {_qualified(key)} ADD {col.render()}" if col else None), bool(col and not col.nullable)
    drop = re.match(r"^drop column \[(.+?)\]$", detail)
    if drop:
        return f"ALTER TABLE {_qualified(key)} DROP COLUMN [{drop.group(1)}]", True
    change = re.match(r"^change column \[(.+?)\] ", detail)
    if change:
        col = by_name.get(change.group(1).replace("]]", "]").lower())
        return (f"ALTER TABLE {_qualified(key)} ALTER COLUMN {col.render()}" if col else None), True
    return None, False


# --- report ---------------------------------------------------------------------------


def render_report(
    changes: list[dict[str, Any]], *, source_name: str, target_name: str, taken_at: str, sides: dict[str, dict[str, Any]], notes: list[str]
) -> str:
    counts = summarize(changes)
    lines = [
        f"# Schema compare: {source_name} -> {target_name}",
        "",
        f"Taken {taken_at}. Direction: what `{target_name}` needs to match `{source_name}`. Read-only; nothing was changed on either side.",
        "",
        "| Side | Environment | Kind | Database | Tables | Views | Procedures | Functions |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for label in ("source", "target"):
        side = sides[label]
        lines.append(f"| {label} | {side.get('environment', '')} | {side.get('kind', '')} | {side.get('database', '')} | {side['tables']} | {side['views']} | {side['procedures']} | {side['functions']} |")
    lines += ["", f"**{counts['total']} difference(s)**: {counts['add']} to add, {counts['alter']} to alter, {counts['drop']} to drop, {counts['destructive']} destructive or manual.", ""]
    if not changes:
        lines.append("The two sides match for every compared object.")
    else:
        lines += ["| Kind | Object | Change | Detail |", "| --- | --- | --- | --- |"]
        for c in changes:
            name = c["schema"] if c["kind"] == "schema" else f"{c['schema']}.{c['name']}"
            flag = " (destructive)" if c.get("destructive") else ""
            lines.append(f"| {c['kind']} | `{name}` | {c['action']}{flag} | {c.get('detail', '')} |")
    lines += ["", "Out of scope: constraints, indexes, permissions, row data."]
    if notes:
        lines += [""] + [f"- {note}" for note in notes]
    lines += ["", "The ordered script is `deploy.sql` beside this file; destructive statements are commented out there."]
    return "\n".join(lines) + "\n"


def summarize(changes: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"total": len(changes), "add": 0, "alter": 0, "drop": 0, "destructive": 0}
    for c in changes:
        if c["action"] in ("add", "alter", "drop"):
            counts[c["action"]] += 1
        if c.get("destructive"):
            counts["destructive"] += 1
    return counts


def _side_summary(catalog: Catalog, target: dict[str, str]) -> dict[str, Any]:
    kinds = catalog.kinds()
    return {
        **target,
        "tables": sum(1 for k in kinds.values() if k == "table"),
        "views": sum(1 for k in kinds.values() if k == "view"),
        "procedures": sum(1 for k in kinds.values() if k == "procedure"),
        "functions": sum(1 for k in kinds.values() if k == "function"),
    }


# --- entry point ----------------------------------------------------------------------


def _folder_word(side: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", side).strip("-") or "side"


def resolve_output(project: dict[str, Any], project_path: Path, source: str, target: str) -> tuple[Path, str]:
    """`.coop/schema-compare/<source>-to-<target>` beside the contract (a repo
    side's name and subfolder joined with hyphens)."""
    root = project_path.resolve().parent.parent
    folder = (root / ".coop" / "schema-compare" / f"{_folder_word(source)}-to-{_folder_word(target)}").resolve()
    try:
        rel = folder.relative_to(root).as_posix()
    except ValueError:
        rel = folder.as_posix()
    return folder, rel


def _read_side(side: str, *, cwd: Path | None, project: dict[str, Any], project_path: Path) -> tuple[Catalog | None, dict[str, str], dict[str, Any] | None]:
    """(catalog, target summary, error result)."""
    if side.startswith("repo"):
        folder, label, state = resolve_repo(side, project, project_path)
        if folder is None:
            return None, {}, sql_query.result(state, side=side)
        return read_repo(folder), {"environment": "repo", "kind": "sql source", "database": label}, None
    if side == "snapshot":
        environment = snapshot_lib.default_environment(project)
        folder, _chosen = snapshot_lib.resolve_output(project, project_path, environment)
        catalog, state = read_snapshot(folder)
        if catalog is None:
            return None, {}, sql_query.result(state, side="snapshot")
        manifest = snapshot_lib.read_manifest(folder) or {}
        summary = {str(k): str(v) for k, v in (manifest.get("target") or {}).items() if isinstance(v, str)}
        summary.setdefault("environment", environment)
        summary["taken_at"] = _text(manifest.get("taken_at"))
        return catalog, summary, None
    connection, target, _driver, error = sql_query.open_connection(cwd=cwd, environment=side)
    if error is not None or connection is None or target is None:
        error = error or sql_query.result("connection_failed")
        error["side"] = side
        return None, {}, error
    try:
        connection.timeout = sql_query.QUERY_TIMEOUT
        catalog = read_live(connection.cursor())
    except Exception:
        return None, {}, sql_query.result("query_failed", side=side)
    finally:
        try:
            connection.close()
        except Exception:
            pass
    return catalog, target.summary(), None


def schema_filter(value: Any) -> list[str] | None:
    """A validated schema list (empty when absent), or None when malformed."""
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_FILTER_SCHEMAS:
        return None
    names = [v.strip() for v in value if isinstance(v, str)]
    if len(names) != len(value) or not all(FILTER_SCHEMA.match(n) for n in names):
        return None
    return names


def filter_schemas(catalog: Catalog, keep: list[str], drop: list[str]) -> None:
    """Drop every schema (and the objects in it) the filter leaves out."""
    keep_set, drop_set = {k.lower() for k in keep}, {d.lower() for d in drop}

    def wanted(schema: str) -> bool:
        name = schema.lower()
        return (not keep_set or name in keep_set) and name not in drop_set

    catalog.schemas = {s for s in catalog.schemas if wanted(s)}
    catalog.tables = {k: v for k, v in catalog.tables.items() if wanted(k[0])}
    catalog.modules = {k: v for k, v in catalog.modules.items() if wanted(k[0])}


def compare(payload: Any, *, cwd: Path | None = None, now: datetime | None = None) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) - {"source", "target", "schemas", "exclude"}:
        return sql_query.result("input_invalid")
    keep, drop = schema_filter(payload.get("schemas")), schema_filter(payload.get("exclude"))
    if keep is None or drop is None:
        return sql_query.result("input_invalid")
    project_path = wmcp.find_project_yml(cwd or Path.cwd())
    if not project_path:
        return sql_query.result("project_unavailable")
    project = wmcp.load_project(project_path)
    project = project if isinstance(project, dict) else {}
    source = payload.get("source", snapshot_lib.default_environment(project))
    target = payload.get("target", DEFAULT_TARGET)
    if not (valid_side(source) and valid_side(target, target=True)) or source == target:
        return sql_query.result("input_invalid")
    for side in (source, target):
        # A repo side is checked before anything connects: it is cheap and local.
        if side.startswith("repo"):
            _folder, _label, state = resolve_repo(side, project, Path(project_path))
            if state != "ok":
                return sql_query.result(state, side=side)
    source_catalog, source_summary, error = _read_side(source, cwd=cwd, project=project, project_path=Path(project_path))
    if error is not None or source_catalog is None:
        return error or sql_query.result("connection_failed", side=source)
    target_catalog, target_summary, error = _read_side(target, cwd=cwd, project=project, project_path=Path(project_path))
    if error is not None or target_catalog is None:
        return error or sql_query.result("connection_failed", side=target)

    # SQL source control keeps its locks in its own schema: never offer it as
    # a change unless the person names it in `schemas`.
    bookkeeping = SQLSC_SCHEMA not in {k.lower() for k in keep} and any(
        s.lower() == SQLSC_SCHEMA for c in (source_catalog, target_catalog) for s in c.schemas
    )
    if keep or drop or bookkeeping:
        filter_schemas(source_catalog, keep, drop + ([SQLSC_SCHEMA] if bookkeeping else []))
        filter_schemas(target_catalog, keep, drop + ([SQLSC_SCHEMA] if bookkeeping else []))
    changes = diff(source_catalog, target_catalog)
    taken_at = (now or datetime.now(timezone.utc)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    notes: list[str] = []
    if keep:
        notes.append(f"only schemas {', '.join(keep)} compared")
    if drop:
        notes.append(f"schemas {', '.join(drop)} left out")
    if bookkeeping:
        notes.append("schema sqlsc (SQL source control's locks) left out")
    for label, catalog in (("source", source_catalog), ("target", target_catalog)):
        for item in catalog.notes:
            notes.append(f"{label}: {item}")
        for item in catalog.unavailable:
            notes.append(f"{label}: unavailable {item}")
        for item in catalog.truncated:
            notes.append(f"{label}: the {item} list is larger than the compare cap; the compare is partial")
        if catalog.skipped:
            notes.append(f"{label}: the snapshot skipped {len(catalog.skipped)} object(s) (names unsafe as file names); they compare as unknown")
    script, to_run, destructive = render_script(
        source_catalog, changes, source_name=source, target_name=target, target_kind=target_summary.get("kind", ""), taken_at=taken_at
    )
    sides = {"source": _side_summary(source_catalog, source_summary), "target": _side_summary(target_catalog, target_summary)}
    report = render_report(changes, source_name=source, target_name=target, taken_at=taken_at, sides=sides, notes=notes)
    folder, rel = resolve_output(project, Path(project_path), source, target)
    try:
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "report.md").write_text(report, encoding="utf-8", newline="\n")
        (folder / "deploy.sql").write_text(script, encoding="utf-8", newline="\n")
    except OSError:
        return sql_query.result("output_unwritable", path=rel)
    return sql_query.result(
        "ok",
        source=sides["source"],
        target=sides["target"],
        taken_at=taken_at,
        path=rel,
        counts=summarize(changes),
        # False when a side was not read whole: no difference listed does not mean none exists.
        complete=not any(c.truncated or c.skipped for c in (source_catalog, target_catalog)),
        changes=changes[:MAX_CHANGES_IN_RESULT],
        changes_truncated=len(changes) > MAX_CHANGES_IN_RESULT,
        script={"statements": to_run, "destructive": destructive},
        notes=notes,
    )


def valid_side(value: Any, *, target: bool = False) -> bool:
    if not isinstance(value, str):
        return False
    if value in ENVIRONMENTS or (value == "snapshot" and not target):
        return True
    return bool(REPO_SIDE.match(value)) and ".." not in value


def execute(payload: Any, *, cwd: Path | None = None) -> dict[str, Any]:
    return compare(payload, cwd=cwd)


def _write_utf8(text: str) -> None:
    """Write the JSON frame as UTF-8 whatever the console code page is: on Windows a
    piped stdout defaults to the ANSI code page, and ensure_ascii=False output
    with a character outside it would raise instead of answering."""
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    sys.stdout.write(text)
    sys.stdout.flush()


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="schema_compare", description=__doc__.splitlines()[0])
    parser.add_argument("--source", help="side to promote from: dev, test, prod, snapshot or repo[:<name>[/<subfolder>]] (default: the contract's default dev/test entry)")
    parser.add_argument("--target", help=f"side to promote to: dev, test, prod or repo[:<name>[/<subfolder>]] (default: {DEFAULT_TARGET})")
    parser.add_argument("--schema", action="append", help="compare only this schema (repeatable)")
    parser.add_argument("--exclude-schema", action="append", help="leave this schema out (repeatable)")
    parser.add_argument("--stdin", action="store_true", help="read {\"source\": ..., \"target\": ...} from stdin (the tool contract)")
    parser.add_argument("--cli", action="store_true", help="never read stdin: the sides come from the flags or their defaults (bin/coop.ps1)")
    args = parser.parse_args(argv)
    if not args.cli and (args.stdin or (args.source is None and args.target is None and not sys.stdin.isatty())):
        try:
            try:
                sys.stdin.reconfigure(encoding="utf-8")
            except (AttributeError, ValueError):
                pass
            payload = json.load(sys.stdin)
        except (UnicodeDecodeError, json.JSONDecodeError):
            payload = None
    else:
        payload = {}
        if args.source:
            payload["source"] = args.source
        if args.target:
            payload["target"] = args.target
        if args.schema:
            payload["schemas"] = args.schema
        if args.exclude_schema:
            payload["exclude"] = args.exclude_schema
    try:
        output = execute(payload)
    except Exception:
        output = sql_query.result("internal_error")
    _write_utf8(json.dumps(output, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
    return 0 if output["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

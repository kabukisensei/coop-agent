#!/usr/bin/env python3
"""Deterministic schema compare between two SQL environments (master plan SQ10).

Reads the catalog of two sides read-only and writes a stable, sorted diff plus
an ordered promotion script, so a team can see exactly what dev holds that prod
does not (or the other way round) and carry the change over by hand or through
coop's governed write path. The tool never writes to any target: its only output
is two files under the contract's compare folder.

A side is one of the contract's `sql_targets` entries (`dev`, `test`, `prod`, or an
environment of a named set such as `dev@lakehouse`, for a client whose Lakehouse
sits beside its Warehouse in every environment), read exactly as lib/sql_query.py reads it (`open_connection(environment=...)`:
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

import hashlib
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
# `dev@lakehouse`: an environment of a named target set (lib/sql_targets.py).
LIVE_SIDE = re.compile(r"^(dev|test|prod)(?:@([a-z][a-z0-9_-]{0,31}))?$")
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
IDENTITY_SQL = snapshot_lib.IDENTITY_SQL
MODULES_SQL = snapshot_lib.MODULES_SQL

_IDENT = r"[A-Za-z_][A-Za-z0-9_@#$]{0,127}"
_SNAPSHOT_HEADER = re.compile(r"^-- coop catalog snapshot: (table|view|procedure|function) (\S+)\.(\S+)$")
_SNAPSHOT_COLUMN = re.compile(r"^\s{4}\[(.+?)\] (.+?)( IDENTITY)? (NULL|NOT NULL)$")
MODULE_WORDS = ("VIEW", "PROC", "PROCEDURE", "FUNCTION")
# A database's own schemas: they exist in every database and cannot be created or
# dropped, so a compare never offers them as a change (objects in them still compare).
INTRINSIC_SCHEMAS = {"dbo", "guest", "sys", "information_schema"}
_SKIPPED = re.compile(r"^(.+?)(?: \((table|view|procedure|function): definition not readable\))?$")
MAX_SKIPPED = 200


# --- catalog model -----------------------------------------------------------------


class Column:
    __slots__ = ("name", "type", "nullable", "position", "identity")

    def __init__(self, name: str, type_text: str, nullable: bool, position: int, identity: bool = False) -> None:
        self.name = name
        self.type = type_text
        self.nullable = nullable
        self.position = position
        self.identity = identity

    def render(self) -> str:
        # Bare IDENTITY: Fabric Warehouse takes no seed or increment (it manages
        # them), and SQL Server reads a bare IDENTITY as IDENTITY(1,1).
        identity = " IDENTITY" if self.identity else ""
        return f"{_bracket(self.name)} {self.type}{identity} {'NULL' if self.nullable else 'NOT NULL'}"


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
        # False when this side could not say which columns are identity columns (an
        # older snapshot, an unreadable catalog view): identity then compares as unknown.
        self.identity_known = True

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
    """The text as (kind, text) runs: `ws`, `comment`, `string`, `ident` and `code`
    (sql_source.segments, the one lexer the batch splitter uses too)."""
    return sql_source.segments(sql)


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
    identity: set[tuple[str, str, str]] = set()
    try:
        identity_rows, _ = _rows(cursor, IDENTITY_SQL, snapshot_lib.MAX_COLUMNS)
        identity = {(_text(r[0]), _text(r[1]), _text(r[2]).lower()) for r in identity_rows if len(r) >= 3}
    except Exception:
        catalog.identity_known = False
        catalog.unavailable.append("identity columns (sys.identity_columns is not readable on this target; identity compares by hand)")
    for (schema, name), cols in by_table.items():
        for col in cols:
            col.identity = (schema, name, col.name.lower()) in identity
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
    if "columns" in catalog.truncated:
        # The column list was cut at the cap: no table's shape is known whole, so a
        # column missing here is unread, never dropped or added (#443).
        catalog.incomplete |= set(catalog.tables)
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
    catalog.identity_known = manifest.get("identity_columns") is True
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
                    cols.append(Column(col.group(1).replace("]]", "]"), col.group(2), col.group(4) == "NULL", len(cols) + 1, bool(col.group(3))))
            catalog.tables[key] = cols
        elif any(line.startswith("-- definition not readable") for line in lines[1 : body_start + 1]):
            catalog.modules[key] = (kind, "")
        else:
            catalog.modules[key] = (kind, "\n".join(lines[body_start:]))
    if "columns" in catalog.truncated:
        catalog.incomplete |= set(catalog.tables)  # as when it was taken (#443)
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
        identity = parsed.identity.get(key, set())
        catalog.tables[key] = [Column(name, type_text, nullable, position, name.lower() in identity) for position, (name, type_text, nullable) in enumerate(columns, 1)]
    catalog.modules = dict(parsed.modules)
    catalog.incomplete = set(parsed.incomplete)
    if parsed.truncated or parsed.unread:
        # A file the reader did not read may define any schema or object: this side
        # cannot prove an absence, so nothing missing here is scripted as a drop (#14).
        catalog.truncated.append("files")
    catalog.notes = sql_source.describe(parsed)
    return catalog


# --- diff ---------------------------------------------------------------------------


# A change that alters no behaviour: a module whose two sides differ only in
# whitespace, line breaks or comments, or a table whose columns are only reordered.
# Labelled in the report and the result so a reviewer can skip reading it; still
# scripted, so the target comes to match the source and the compare stops listing
# it (the 2026-10-23 deployment call deployed three such views on purpose).
COSMETIC_FORMATTING = "formatting"
COSMETIC_COLUMN_ORDER = "column order"
COSMETIC_WORDS = {COSMETIC_FORMATTING: "formatting only", COSMETIC_COLUMN_ORDER: "column order only"}
_COLUMN_ORDER_DETAIL = "columns reordered"


def flatten_definition(definition: str) -> str:
    """The normalized definition with comments dropped and every run of whitespace
    (line breaks included) folded to one space: what the engine parses. String
    literals and quoted names keep their text."""
    out: list[str] = []
    for kind, text in _segments(normalize_definition(definition)):
        out.append(" " if kind in ("ws", "comment") else text)
    return re.sub(r" {2,}", " ", "".join(out)).strip()


def formatting_only(source_definition: str, target_definition: str) -> bool:
    """True when two definitions that normalize differently differ in formatting only."""
    return flatten_definition(source_definition) == flatten_definition(target_definition)


def cosmetic_flag(c: dict[str, Any]) -> str:
    """` (formatting only)` / ` (column order only)` for a cosmetic change, else ``."""
    word = COSMETIC_WORDS.get(str(c.get("cosmetic", "")), "")
    return f" ({word})" if word else ""


def _change(kind: str, key: tuple[str, str], action: str, detail: str = "", destructive: bool = False, cosmetic: str = "") -> dict[str, Any]:
    item: dict[str, Any] = {"kind": kind, "schema": key[0], "name": key[1], "action": action}
    if detail:
        item["detail"] = detail
    if destructive:
        item["destructive"] = True
    if cosmetic:
        item["cosmetic"] = cosmetic
    return item


def compare_tables(source: list[Column], target: list[Column], identity: bool = True) -> tuple[list[str], bool]:
    """Column differences in words; True when applying them can lose data.
    `identity` False: one side could not say which columns are identity columns,
    so identity is not compared (the caller notes that)."""
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
        if identity and a.identity != b.identity:
            # No engine turns identity on or off in place: a rebuild, a person's call.
            details.append(f"change column {_bracket(a.name)} identity {'IDENTITY' if b.identity else 'none'} -> {'IDENTITY' if a.identity else 'none'}")
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
    # ("files": a repo side whose .sql files were not all read cannot prove an absence either, #14.)
    if not {"schemas", "files"} & set(target.truncated):
        for schema in sorted(src_schemas - tgt_schemas, key=str.lower):
            changes.append(_change("schema", (schema, ""), "add"))
    if not {"schemas", "files"} & set(source.truncated):
        for schema in sorted(tgt_schemas - src_schemas, key=str.lower):
            changes.append(_change("schema", (schema, ""), "drop", destructive=True))
    for key in sorted(set(src_kinds) | set(tgt_kinds), key=lambda k: (k[0].lower(), k[1].lower())):
        src_kind, tgt_kind = src_kinds.get(key), tgt_kinds.get(key)
        if src_kind == "table" and tgt_kind and tgt_kind != "table" and key in source.incomplete:
            changes.append(_change("table", key, "unknown", f"a {tgt_kind} on the target, a table on the source whose columns could not all be read; replace it by hand"))
            continue
        if src_kind and tgt_kind and src_kind != tgt_kind:
            changes.append(_change(src_kind, key, "replace", f"a {tgt_kind} on the target, a {src_kind} on the source", destructive=True))
            continue
        missing_from = target if src_kind and not tgt_kind else source if tgt_kind and not src_kind else None
        if missing_from is not None and ({"objects", "files"} & set(missing_from.truncated) or f"{key[0]}.{key[1]}".lower() in missing_from.skipped):
            side = "target" if missing_from is target else "source"
            if "objects" in missing_from.truncated:
                why = "its object list was cut at the compare cap"
            elif "files" in missing_from.truncated:
                why = "not every .sql file on that side was read (over the file cap, unreadable, or beyond the file count cap)"
            else:
                why = "its snapshot skipped this object"
            changes.append(_change(src_kind or tgt_kind or "", key, "unknown", f"not read on the {side} ({why}); compare by hand"))
            continue
        if src_kind == "table" and not tgt_kind and key in source.incomplete:
            # Its columns were not all read: a CREATE from this shape would be wrong (#443).
            changes.append(_change("table", key, "unknown", "not every column could be read on the source side; create it by hand"))
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
                changes.append(_change("table", key, "unknown", f"not every column could be read on the {' and '.join(unread)} side; compare its columns by hand"))
                continue
            details, lossy = compare_tables(source.tables[key], target.tables[key], source.identity_known and target.identity_known)
            if details:
                cosmetic = COSMETIC_COLUMN_ORDER if details == [_COLUMN_ORDER_DETAIL] else ""
                changes.append(_change("table", key, "alter", "; ".join(details), destructive=lossy, cosmetic=cosmetic))
        else:
            src_def, tgt_def = source.modules[key][1], target.modules[key][1]
            if not src_def or not tgt_def:
                if not src_def and not tgt_def:
                    continue
                changes.append(_change(src_kind, key, "unknown", "definition not readable on one side; compare by hand"))
            elif normalize_definition(_as_named(src_def, key)) != normalize_definition(_as_named(tgt_def, key)):
                if formatting_only(_as_named(src_def, key), _as_named(tgt_def, key)):
                    changes.append(_change(src_kind, key, "alter", "definition differs in whitespace, line breaks or comments only", cosmetic=COSMETIC_FORMATTING))
                else:
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


# --- the change record: one entry per object, read by the script and the report ----

# Script sections, in run order. A section with no object is left out.
SECTIONS = (
    (1, "New schemas"),
    (2, "New tables"),
    (3, "Table changes"),
    (4, "Views, procedures and functions, in dependency order"),
    (5, "After the manual table rebuilds above"),
    # Section 6, "Objects replaced by another kind", is retired (#16): a module
    # replacing another kind is ordered with the modules in 4 and 5, and a table
    # replacing another kind goes with the new tables in 2.
    (7, "Removals"),
    (8, "For a person: not scripted"),
)
KIND_WORDS = {"schema": "SCHEMA", "table": "TABLE", "view": "VIEW", "procedure": "PROCEDURE", "function": "FUNCTION"}
# A Lakehouse SQL analytics endpoint takes no table DDL at all: every table change
# there (create, alter, drop, replace) is a person's step in the Lakehouse (#15).
_LAKEHOUSE_TABLE_NOTE = (
    "A Lakehouse SQL analytics endpoint cannot {verb} a table with T-SQL: {verb} the Delta table in the Lakehouse "
    "(a notebook or a pipeline), then compare again. The statement below is the shape, commented out."
)


def _record(kind: str, key: tuple[str, str], detected: str, action: str, section: int, *, changes: list[str] | None = None, notes: list[str] | None = None, statements: list[str] | None = None, destructive: bool = False, manual: bool = False, safe: int = 0) -> dict[str, Any]:
    return {
        "kind": kind,
        "schema": key[0],
        "name": key[1],
        "object": key[0] if kind == "schema" else _plain(key),
        "detected": detected,
        "action": action,
        "section": section,
        "changes": list(changes or []),
        "notes": list(notes or []),
        # Statements, each one batch. A manual record's statements are a template
        # for a person and always commented out; a destructive one's run unless
        # the run asked for destructive statements commented out.
        "statements": list(statements or []),
        "destructive": destructive,
        "manual": manual,
        # How many leading statements keep every row (an ALTER that adds a nullable
        # column beside one that drops another): those are never commented out.
        "safe": safe if destructive else len(statements or []),
    }


def _identity_line(columns: list[Column]) -> str:
    ids = [c for c in columns if c.identity]
    if not ids:
        return "Identity: none (no column becomes an identity column)."
    names = ", ".join(f"{_bracket(c.name)} {c.type} IDENTITY" for c in ids)
    return f"Identity: {names}, with no seed or increment (Fabric Warehouse manages them); no PRIMARY KEY constraint is added."


def _table_steps(key: tuple[str, str], details: list[str], columns: list[Column], target_kind: str) -> tuple[list[str], list[str], list[str]]:
    """(ALTERs that keep every row, ALTERs that can lose data, what no ALTER on
    this target can do). Fabric Warehouse's ALTER TABLE adds a nullable column
    and drops a column; it cannot change a column's type, nullability or identity
    (ALTER COLUMN is a preview there and this script does not use it)."""
    by_name = {c.name.lower(): c for c in columns}
    fabric = target_kind == "fabric_warehouse"
    keep: list[str] = []
    lossy: list[str] = []
    rebuild: list[str] = []
    for detail in details:
        add = re.match(r"^add column \[(.+?)\] ", detail)
        drop = re.match(r"^drop column \[(.+)\]$", detail)
        change = re.match(r"^change column \[(.+?)\] (type|NULL|NOT NULL)", detail)
        if add:
            col = by_name.get(add.group(1).replace("]]", "]").lower())
            if col is None:
                rebuild.append(detail)
            elif col.nullable and not col.identity:
                keep.append(f"ALTER TABLE {_qualified(key)} ADD {col.render()}")
            elif fabric:
                rebuild.append(f"add the {'identity' if col.identity else 'NOT NULL'} column {_bracket(col.name)}")
            else:
                # A NOT NULL column with no default fails on a table that holds rows.
                lossy.append(f"ALTER TABLE {_qualified(key)} ADD {col.render()}")
        elif drop:
            lossy.append(f"ALTER TABLE {_qualified(key)} DROP COLUMN [{drop.group(1)}]")
        elif change and not fabric:
            col = by_name.get(change.group(1).replace("]]", "]").lower())
            if col is None or col.identity:
                rebuild.append(detail)
            else:
                lossy.append(f"ALTER TABLE {_qualified(key)} ALTER COLUMN {col.render()}")
        else:
            rebuild.append(detail)
    return keep, lossy, rebuild


def plan(source: Catalog, changes: list[dict[str, Any]], *, target_kind: str, rebuild_schemas: list[str] | tuple[str, ...] = ()) -> list[dict[str, Any]]:
    """The change record: every difference as one object entry, in script order,
    with its detected change, the chosen action, a factual summary, notes and
    the statements. deploy.sql and report.md are both rendered from it."""
    rebuild_set = {s.lower() for s in rebuild_schemas}
    records: list[dict[str, Any]] = []
    manual_rebuilds: dict[tuple[str, str], set[str]] = {}
    for c in changes:
        if c["kind"] == "schema" and c["action"] == "add":
            records.append(_record("schema", (c["schema"], ""), "add", "CREATE", 1, changes=["New on the target."], statements=[f"CREATE SCHEMA {_bracket(c['schema'])}"]))
    lakehouse = target_kind == "fabric_lakehouse"
    # Tables a person must create or replace by hand (a Lakehouse): a module that
    # names one runs only after that manual step (#15).
    manual_tables: set[tuple[str, str]] = set()
    # Modules replaced by DROP + CREATE in the module section: a consumer that
    # follows one is told so, because the replacement is destructive and may be
    # commented out (#16).
    replaced: set[tuple[str, str]] = set()
    for c in changes:
        key = (c["schema"], c["name"])
        if c["kind"] == "table" and c["action"] == "add":
            cols = source.tables[key]
            if lakehouse:
                manual_tables.add(key)
                records.append(_record("table", key, "add", "MANUAL", 2, changes=[f"New on the target: {len(cols)} column(s)."], manual=True, notes=[
                    _LAKEHOUSE_TABLE_NOTE.format(verb="create"), _identity_line(cols),
                ], statements=[_render_table(cols, key)]))
            else:
                records.append(_record("table", key, "add", "CREATE", 2, changes=[f"New on the target: {len(cols)} column(s)."], notes=[_identity_line(cols)], statements=[_render_table(cols, key)]))
        elif c["kind"] == "table" and c["action"] == "replace":
            # Another kind on the target, a table on the source: the table goes with
            # the new tables, before the modules that may name it (#16).
            cols = source.tables[key]
            statements = [f"DROP {_drop_word(_target_kind_of(c))} {_qualified(key)}", _render_table(cols, key)]
            if lakehouse:
                manual_tables.add(key)
                records.append(_record("table", key, "replace", "MANUAL", 2, changes=[c["detail"]], manual=True, notes=[
                    _LAKEHOUSE_TABLE_NOTE.format(verb="create"),
                    f"Drop the target's {_target_kind_of(c)} on the SQL analytics endpoint first; the statements below are the shape, commented out.",
                    _identity_line(cols),
                ], statements=statements))
            else:
                records.append(_record("table", key, "replace", "DROP + CREATE", 2, changes=[c["detail"]], notes=[
                    f"DESTRUCTIVE: drops the target's {_target_kind_of(c)} before creating the source's table.", _identity_line(cols),
                ], statements=statements, destructive=True))
    for c in changes:
        if c["kind"] != "table" or c["action"] != "alter":
            continue
        key = (c["schema"], c["name"])
        cols = source.tables[key]
        details = c["detail"].split("; ")
        keep, lossy, rebuild = _table_steps(key, details, cols, target_kind)
        added = {m.group(1).replace("]]", "]").lower() for d in details for m in [re.match(r"^add column \[(.+?)\] ", d)] if m}
        if target_kind == "fabric_lakehouse":
            manual_rebuilds[key] = added
            records.append(_record("table", key, "alter", "MANUAL", 3, changes=details, manual=True, notes=[
                _LAKEHOUSE_TABLE_NOTE.format(verb="change"),
                _identity_line(cols),
            ], statements=[_render_table(cols, key)]))
        elif key[0].lower() in rebuild_set:
            why = (
                f"Rebuilt because schema {key[0]} is in rebuild_tables_in (the selected policy); "
                + ("the target could not make every change in place either." if rebuild else "the target could ALTER it in place.")
            )
            notes = [why, _identity_line(cols), "DESTRUCTIVE: drops the table with its rows and permissions. The new table is empty: reload it, and rebuild what is keyed on it, before its consumers run."]
            if any(col.identity for col in cols):
                notes.append("Keeping the IDENTITY property does not keep the existing key values: rebuild the facts that hold them too.")
            records.append(_record("table", key, "alter", "REBUILD (DROP + CREATE)", 3, changes=details, notes=notes, destructive=True, statements=[f"DROP TABLE IF EXISTS {_qualified(key)}", _render_table(cols, key)]))
        elif rebuild:
            manual_rebuilds[key] = added
            where = "Fabric Warehouse cannot" if target_kind == "fabric_warehouse" else "No ALTER TABLE can"
            records.append(_record("table", key, "alter", "MANUAL REBUILD", 3, changes=details, manual=True, notes=[
                f"{where} {'; '.join(rebuild)} in place. Rebuild the table keeping its rows (CREATE TABLE AS SELECT into a new name, check the row count, then rename), "
                "or name its schema in rebuild_tables_in to DROP + CREATE it empty. The statement below is the source shape, commented out.",
                _identity_line(cols),
            ], statements=[_render_table(cols, key)]))
        else:
            notes = ["DESTRUCTIVE: a dropped or changed column can lose data."] if lossy else []
            records.append(_record("table", key, "alter", "ALTER", 3, changes=details, notes=notes, destructive=bool(lossy), statements=keep + lossy, safe=len(keep)))
    definitions = {key: _as_named(definition, key) if definition else definition for key, (_kind, definition) in source.modules.items()}
    kinds = {key: kind for key, (kind, _definition) in source.modules.items()}
    by_key = {(c["schema"], c["name"]): c for c in changes if c["kind"] in MODULE_KINDS}
    # A module that replaces another kind on the target is ordered with the other
    # modules: a new view that calls a function replacing a view must come after the
    # replacement, not before it (#16).
    keys = [k for k, c in by_key.items() if c["action"] in ("add", "alter", "replace")]
    deferred: set[tuple[str, str]] = set()
    order, circular = _order(keys, definitions, kinds)
    for key in order:
        c = by_key[key]
        kind = kinds.get(key, c["kind"])
        definition = definitions.get(key, "")
        replacing = _target_kind_of(c) if c["action"] == "replace" else ""
        if replacing:
            summary = [c["detail"]]
        elif c["action"] == "add":
            summary = ["New on the target."]
        elif c.get("cosmetic"):
            summary = ["Definition differs in whitespace, line breaks or comments only; the source's text replaces the target's so the two match from now on."]
        else:
            summary = ["Definition differs; the source's definition replaces the target's."]
        if not definition:
            notes = ["Definition not readable on the source: write it by hand."]
            statements: list[str] = []
            if replacing:
                notes.insert(0, "DESTRUCTIVE: drops the target's " + replacing + (" and its rows" if replacing == "table" else "") + " before creating the source's.")
                statements = [f"DROP {_drop_word(replacing)} {_qualified(key)}"]
                replaced.add(key)
            records.append(_record(kind, key, c["action"], "MANUAL", 8, changes=summary, manual=True, notes=notes, statements=statements, destructive=bool(replacing)))
            continue
        notes: list[str] = []
        stale = sql_source.with_identity(source.modules[key][1], key[0], key[1])[1]
        if stale:
            notes.append(f"Its stored definition declares {stale} (renamed after it was created); scripted under {_plain(key)}, body unchanged.")
        section = 4
        if key in circular:
            others = sorted(_references(definition, sorted(circular)) - {key})
            notes.append(f"Circular reference: names {', '.join(_plain(o) for o in others)}, and those references lead back to it; run these in an order that works.")
        waits_on = sorted(dep for dep in _references(definition, sorted(deferred)) if dep != key)
        rebuilt_tables = sorted(t for t in _references(definition, list(manual_rebuilds)) if _mentions(definition, manual_rebuilds[t]))
        created_tables = sorted(t for t in _references(definition, sorted(manual_tables)) if t != key)
        follows_replaced = sorted(dep for dep in _references(definition, sorted(replaced)) if dep != key)
        if (waits_on or rebuilt_tables or created_tables) and key not in circular:
            section = 5
            deferred.add(key)
            notes += [f"Run after the manual rebuild of {_plain(t)}: names {', '.join(sorted(_mentions(definition, manual_rebuilds[t])))}, which the target has only after it." for t in rebuilt_tables]
            notes += [f"Run after the manual change of table {_plain(t)} above: the target has it only after that step." for t in created_tables]
            notes += [f"Follows {kinds.get(dep, 'object')} {_plain(dep)} in this section." for dep in waits_on]
        notes += [f"Follows the replacement of {_plain(dep)} (DROP + CREATE, destructive): when that replacement is commented out or manual, run it first." for dep in follows_replaced]
        if replacing:
            replaced.add(key)
            statements = [f"DROP {_drop_word(replacing)} {_qualified(key)}", _create_or_alter(definition)]
            if lakehouse and replacing == "table":
                # Dropping a Lakehouse table is not T-SQL either: the whole step is a person's.
                manual_tables.add(key)
                records.append(_record(kind, key, "replace", "MANUAL", section, changes=summary, manual=True, notes=[
                    _LAKEHOUSE_TABLE_NOTE.format(verb="drop"), *notes,
                ], statements=statements))
            else:
                records.append(_record(kind, key, "replace", "DROP + CREATE", section, changes=summary, notes=[
                    "DESTRUCTIVE: drops the target's " + replacing + (" and its rows" if replacing == "table" else "") + " before creating the source's.", *notes,
                ], statements=statements, destructive=True))
            continue
        records.append(_record(kind, key, c["action"], "CREATE" if c["action"] == "add" else "CREATE OR ALTER", section, changes=summary, notes=notes, statements=[_create_or_alter(definition)]))
    for kind in ("procedure", "view", "function", "table", "schema"):
        for c in changes:
            if c["kind"] == kind and c["action"] == "drop":
                key = (c["schema"], c["name"])
                target_ref = _bracket(c["schema"]) if kind == "schema" else _qualified(key)
                loses = " with its rows" if kind == "table" else ""
                if lakehouse and kind == "table":
                    records.append(_record(kind, key, "drop", "MANUAL", 7, changes=["Only on the target."], manual=True, notes=[_LAKEHOUSE_TABLE_NOTE.format(verb="drop")], statements=[f"DROP TABLE {target_ref}"]))
                    continue
                records.append(_record(kind, key, "drop", "DROP", 7, changes=["Only on the target."], notes=[f"DESTRUCTIVE: drops the {kind}{loses}."], statements=[f"DROP {_drop_word(kind)} {target_ref}"], destructive=True))
    for c in changes:
        if c["action"] == "unknown":
            records.append(_record(c["kind"] or "object", (c["schema"], c["name"]), "unknown", "MANUAL", 8, changes=[c["detail"]], manual=True))
    return sorted(records, key=lambda r: r["section"])


def _commented(r: dict[str, Any], commented: bool, index: int) -> bool:
    """True when the record's statement at `index` is written commented out."""
    return bool(r["manual"] or (commented and index >= r["safe"]))


def script_stats(records: list[dict[str, Any]], *, commented: bool = False) -> dict[str, int]:
    """Counts the script header, the report and the tool result share. A note
    batch holds only comments: it is never a statement."""
    off = sum(1 for r in records for i in range(len(r["statements"])) if _commented(r, commented, i))
    run = sum(len(r["statements"]) for r in records) - off
    return {
        "objects": len(records),
        "statements": run,
        "commented": off,
        "destructive": sum(1 for r in records if r["destructive"]),
        "manual": sum(1 for r in records if r["manual"]),
        # Every object's note batch, every statement it runs, and the header's.
        "batches": 1 + len(records) + run,
    }


def _note_lines(r: dict[str, Any]) -> list[str]:
    kind = KIND_WORDS.get(r["kind"], r["kind"].upper())
    lines = [f"Object: {r['object']}", f"Type: {kind} | Change: {r['detected'].upper()} | Action: {r['action']}"]
    lines += [f"Changes: {item}" for item in r["changes"]]
    lines += r["notes"]
    return lines


def render_deploy(records: list[dict[str, Any]], *, source_name: str, target_name: str, taken_at: str, commented: bool = False, choices: list[str] | tuple[str, ...] = ()) -> str:
    """deploy.sql from the change record. Every object opens with a comment-only
    note batch ended by GO, so a note never becomes part of a saved view or
    procedure; the module's own leading comments stay with it, as written."""
    stats = script_stats(records, commented=commented)
    by_kind: dict[str, int] = {}
    for r in records:
        by_kind[r["kind"]] = by_kind.get(r["kind"], 0) + 1
    kinds_text = ", ".join(f"{n} {k}{'s' if n != 1 else ''}" for k, n in sorted(by_kind.items()))
    lines = [
        f"-- coop schema compare: {source_name} -> {target_name}, taken {taken_at}",
        "-- Generated from the two catalogs, read-only. coop never runs this file: review it, then run it yourself,",
        "-- top to bottom, with a tool that understands GO batches (SSMS, sqlcmd, VS Code).",
        f"-- Objects: {stats['objects']}{f' ({kinds_text})' if kinds_text else ''}. Statements: {stats['statements']} to run, {stats['commented']} commented out.",
        f"-- Destructive objects: {stats['destructive']}, each marked DESTRUCTIVE in its note; their statements are "
        + ("commented out (remove the leading -- from each line to use one)." if commented else "active, not commented out."),
    ]
    if stats["manual"]:
        lines.append(f"-- For a person: {stats['manual']} object(s) need a manual step; their templates are commented out (remove the leading -- from each line).")
    lines += [f"-- Choice: {item}" for item in choices]
    lines += [
        "-- Each object's note is a batch of its own, so it never becomes part of a saved view or procedure.",
        "-- Out of scope: constraints, indexes, permissions, row data.",
        "GO",
        "",
    ]
    number = 0
    for section, title in SECTIONS:
        group = [r for r in records if r["section"] == section]
        if not group:
            continue
        number += 1
        lines += ["-- " + "=" * 70, f"-- {number}. {title}", "-- " + "=" * 70, ""]
        for r in group:
            lines += [f"-- {line}" for line in _note_lines(r)]
            lines.append("GO")
            for index, statement in enumerate(r["statements"]):
                off = _commented(r, commented, index)
                text = _terminated(statement).split("\n")
                # Off: every line gets exactly `--` in front, its own comments included,
                # so taking those two characters away gives back the statement as written.
                lines += ["--" + line for line in text] + ["--GO"] if off else text + ["GO"]
            lines.append("")
    if not records:
        lines.append("-- The two sides match for every compared object: nothing to run.")
    return "\n".join(lines).rstrip() + "\n"


def render_script(
    source: Catalog, changes: list[dict[str, Any]], *, source_name: str, target_name: str, target_kind: str, taken_at: str,
    rebuild_schemas: list[str] | tuple[str, ...] = (), commented: bool = False, choices: list[str] | tuple[str, ...] = (),
) -> tuple[str, dict[str, int]]:
    """(deploy.sql text, script_stats) for the changes."""
    records = plan(source, changes, target_kind=target_kind, rebuild_schemas=rebuild_schemas)
    text = render_deploy(records, source_name=source_name, target_name=target_name, taken_at=taken_at, commented=commented, choices=choices)
    return text, script_stats(records, commented=commented)


def _target_kind_of(change: dict[str, Any]) -> str:
    match = re.match(r"a (\w+) on the target", change.get("detail", ""))
    return match.group(1) if match else change["kind"]


def _render_table(columns: list[Column], key: tuple[str, str]) -> str:
    body = ",\n".join("    " + col.render() for col in columns)
    return f"CREATE TABLE {_qualified(key)} (\n{body}\n)"


# --- report ---------------------------------------------------------------------------


def render_report(
    changes: list[dict[str, Any]], *, source_name: str, target_name: str, taken_at: str, sides: dict[str, dict[str, Any]], notes: list[str],
    records: list[dict[str, Any]] | None = None, commented: bool = False, choices: list[str] | tuple[str, ...] = (),
) -> str:
    counts = summarize(changes)
    records = records or []
    lines = [
        f"# Schema compare: {source_name} -> {target_name}",
        "",
        f"Taken {taken_at}. Direction: what `{target_name}` needs to match `{source_name}`. Read-only; nothing was changed on either side, and no SQL was run.",
        "",
        "| Side | Environment | Kind | Database | Tables | Views | Procedures | Functions |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for label in ("source", "target"):
        side = sides[label]
        lines.append(f"| {label} | {side.get('environment', '')} | {side.get('kind', '')} | {side.get('database', '')} | {side['tables']} | {side['views']} | {side['procedures']} | {side['functions']} |")
    cosmetic = f" {counts['cosmetic']} of them change formatting or column order only." if counts.get("cosmetic") else ""
    lines += ["", f"**{counts['total']} difference(s)**: {counts['add']} to add, {counts['alter']} to alter, {counts['drop']} to drop; {counts['destructive']} of them can lose data as detected.{cosmetic}", ""]
    if records:
        stats = script_stats(records, commented=commented)
        lines += [
            f"Script: {stats['objects']} object(s), {stats['statements']} statement(s) to run, {stats['commented']} commented out, "
            f"{stats['destructive']} destructive object(s) after the chosen actions, {stats['manual']} for a person; {stats['batches']} GO batches including the comment-only note batches.",
            "",
        ]
    if choices:
        lines += ["## Choices", ""] + [f"- {item}" for item in choices] + [""]
    if not changes:
        lines.append("The two sides match for every compared object.")
    else:
        lines += ["| Kind | Object | Change | Detail |", "| --- | --- | --- | --- |"]
        for c in changes:
            name = c["schema"] if c["kind"] == "schema" else f"{c['schema']}.{c['name']}"
            flag = (" (destructive)" if c.get("destructive") else "") + cosmetic_flag(c)
            lines.append(f"| {c['kind']} | `{name}` | {c['action']}{flag} | {c.get('detail', '')} |")
    if records:
        lines += ["", "## Objects", "", "In the order deploy.sql runs them; each has the same note there."]
        for r in records:
            lines += ["", f"### {r['object']} ({KIND_WORDS.get(r['kind'], r['kind'].upper())})", ""]
            lines.append(f"- **Detected change:** {r['detected'].upper()}.")
            lines.append(f"- **Deployment action:** {r['action']}" + (" (commented out in deploy.sql)." if any(_commented(r, commented, i) for i in range(len(r["statements"]))) else "."))
            lines += [f"- Change: {item}" for item in r["changes"]]
            lines += [f"- {'**' + note.split(':', 1)[0] + ':**' + note.split(':', 1)[1] if note.startswith('DESTRUCTIVE:') else note}" for note in r["notes"]]
    lines += ["", "Out of scope: constraints, indexes, permissions, row data."]
    if notes:
        lines += [""] + [f"- {note}" for note in notes]
    lines += ["", "The ordered script is `deploy.sql` beside this file. coop never runs it; a person reviews it and runs it."]
    return "\n".join(lines) + "\n"


def summarize(changes: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"total": len(changes), "add": 0, "alter": 0, "drop": 0, "destructive": 0, "cosmetic": 0}
    for c in changes:
        if c["action"] in ("add", "alter", "drop"):
            counts[c["action"]] += 1
        if c.get("destructive"):
            counts["destructive"] += 1
        if c.get("cosmetic"):
            counts["cosmetic"] += 1
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
    summary = target.summary()
    named = LIVE_SIDE.match(side)
    if named and named.group(2):
        summary["set"] = named.group(2)
    return catalog, summary, None


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


DESTRUCTIVE_MODES = ("runnable", "commented")
GENERATED_MARK = "-- coop generated: sha256 "


def _settings(project: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
    """The client's `schema_compare:` section of .coop/project.yml, validated:
    ({schemas, exclude, rebuild, commented}, "") or (None, the bad key)."""
    section = project.get("schema_compare")
    if section is None:
        section = {}
    if not isinstance(section, dict):
        return None, "schema_compare"
    out: dict[str, Any] = {}
    for key, name in (("schemas", "schemas"), ("exclude", "exclude_schemas"), ("rebuild", "rebuild_tables_in")):
        value = schema_filter(section.get(name))
        if value is None:
            return None, f"schema_compare.{name}"
        out[key] = value
    mode = section.get("destructive", "runnable")
    if mode not in DESTRUCTIVE_MODES:
        return None, "schema_compare.destructive"
    out["commented"] = mode == "commented"
    return out, ""


def _choices(payload: dict[str, Any], saved: dict[str, Any]) -> tuple[list[str], list[str], list[str], bool, list[str]]:
    """(keep, exclude, rebuild, commented, the choices in words with where each
    came from). A run's `exclude` adds to the project file's; any other run value
    replaces the file's for that run, and a schema the run names in `schemas` is
    never left out by the file's exclude list."""
    run_keep, run_drop = payload.get("schemas"), payload.get("exclude") or []
    keep = run_keep if run_keep is not None else saved["schemas"]
    named = {k.lower() for k in (run_keep or [])}
    file_drop = [d for d in saved["exclude"] if d.lower() not in named]
    drop = file_drop + [d for d in run_drop if d.lower() not in {f.lower() for f in file_drop}]
    rebuild = payload.get("rebuild") if payload.get("rebuild") is not None else saved["rebuild"]
    commented = payload["commented"] if isinstance(payload.get("commented"), bool) else saved["commented"]
    words: list[str] = []
    if keep:
        words.append(f"only schemas {', '.join(keep)} compared ({'this run' if run_keep is not None else 'project file'})")
    parts = ([f"{', '.join(file_drop)} (project file)"] if file_drop else []) + ([f"{', '.join(d for d in drop if d not in file_drop)} (this run)"] if len(drop) > len(file_drop) else [])
    if parts:
        words.append("schemas left out: " + "; ".join(parts))
    if rebuild:
        words.append(f"changed tables in schemas {', '.join(rebuild)} are rebuilt with DROP + CREATE ({'this run' if payload.get('rebuild') is not None else 'project file'}); other tables ALTER where the target allows it")
    else:
        words.append("changed tables: ALTER where the target allows it, a manual rebuild note where it does not (default)")
    source = "this run" if isinstance(payload.get("commented"), bool) else "project file" if saved["commented"] else "default"
    words.append(f"destructive statements: {'commented out' if commented else 'active, marked DESTRUCTIVE'} ({source})")
    return keep, drop, rebuild, commented, words


def _defaults_hint(payload: dict[str, Any], saved: dict[str, Any]) -> str:
    """One note when a run names schema choices the project file does not hold, so
    two people stop getting different counts from exclusions typed into a prompt
    (2026-10-23: 72 against 74). Names the exact keys; coop never writes them itself."""
    def names(values: Any) -> list[str]:
        return sorted({v.lower() for v in values}) if isinstance(values, list) else []

    offers: list[str] = []
    run_drop = [d for d in names(payload.get("exclude")) if d not in names(saved["exclude"])]
    if run_drop:
        offers.append(f"exclude_schemas: [{', '.join(run_drop)}]")
    if payload.get("schemas") is not None and names(payload.get("schemas")) != names(saved["schemas"]):
        offers.append(f"schemas: [{', '.join(names(payload.get('schemas')))}]")
    if payload.get("rebuild") is not None and names(payload.get("rebuild")) != names(saved["rebuild"]):
        offers.append(f"rebuild_tables_in: [{', '.join(names(payload.get('rebuild')))}]")
    if isinstance(payload.get("commented"), bool) and payload["commented"] != saved["commented"]:
        offers.append(f"destructive: {'commented' if payload['commented'] else 'runnable'}")
    if not offers:
        return ""
    return (
        "this run's choices are not the project file's: to make them this client's defaults for everyone, add under "
        f"schema_compare in .coop/project.yml: {'; '.join(offers)} (the Project pane or /setup-project edits it; then /new)"
    )


def _write_script(folder: Path, script: str, stamp: str) -> str:
    """Write deploy.sql with a closing checksum line. A deploy.sql someone edited
    since coop wrote it (its checksum no longer matches) is kept beside the new
    one as deploy.edited-<stamp>.sql; the name kept is returned ("" when none)."""
    digest = hashlib.sha256(script.encode("utf-8")).hexdigest()
    text = script + GENERATED_MARK + digest + "\n"
    path = folder / "deploy.sql"
    kept = ""
    if path.is_file():
        old = path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n")
        body, _, last = old.rstrip("\n").rpartition("\n")
        unedited = last.startswith(GENERATED_MARK) and hashlib.sha256((body + "\n").encode("utf-8")).hexdigest() == last[len(GENERATED_MARK):].strip()
        if old != text and not unedited:
            kept = f"deploy.edited-{stamp}.sql"
            (folder / kept).write_text(old, encoding="utf-8", newline="\n")
    path.write_text(text, encoding="utf-8", newline="\n")
    return kept


def compare(payload: Any, *, cwd: Path | None = None, now: datetime | None = None) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) - {"source", "target", "schemas", "exclude", "rebuild", "commented"}:
        return sql_query.result("input_invalid")
    keep, drop, rebuild = schema_filter(payload.get("schemas")), schema_filter(payload.get("exclude")), schema_filter(payload.get("rebuild"))
    if keep is None or drop is None or rebuild is None or not isinstance(payload.get("commented", False), bool):
        return sql_query.result("input_invalid")
    project_path = wmcp.find_project_yml(cwd or Path.cwd())
    if not project_path:
        return sql_query.result("project_unavailable")
    project = wmcp.load_project(project_path)
    project = project if isinstance(project, dict) else {}
    saved, bad = _settings(project)
    if saved is None:
        return sql_query.result("setting_invalid", setting=bad)
    keep, drop, rebuild, commented, choices = _choices(payload, saved)
    defaults_hint = _defaults_hint(payload, saved)
    source = payload.get("source", snapshot_lib.default_environment(project))
    target = payload.get("target", default_target_for(source))
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
    if defaults_hint:
        notes.append(defaults_hint)
    if bookkeeping:
        notes.append("schema sqlsc (SQL source control's locks) left out")
    for label, catalog in (("source", source_catalog), ("target", target_catalog)):
        for item in catalog.notes:
            notes.append(f"{label}: {item}")
        for item in catalog.unavailable:
            notes.append(f"{label}: unavailable {item}")
        for item in catalog.truncated:
            if item == "files":
                notes.append(f"{label}: the compare is partial; objects missing on this side compare as unknown, not as removed")
            else:
                notes.append(f"{label}: the {item} list is larger than the compare cap; the compare is partial")
        if catalog.skipped:
            notes.append(f"{label}: the snapshot skipped {len(catalog.skipped)} object(s) (names unsafe as file names); they compare as unknown")
        if not catalog.identity_known and catalog.tables:
            notes.append(f"{label}: identity columns were not recorded (a snapshot from before coop read them: take it again), so identity was not compared")
    records = plan(source_catalog, changes, target_kind=target_summary.get("kind", ""), rebuild_schemas=rebuild)
    script = render_deploy(records, source_name=source, target_name=target, taken_at=taken_at, commented=commented, choices=choices)
    stats = script_stats(records, commented=commented)
    sides = {"source": _side_summary(source_catalog, source_summary), "target": _side_summary(target_catalog, target_summary)}
    folder, rel = resolve_output(project, Path(project_path), source, target)
    try:
        folder.mkdir(parents=True, exist_ok=True)
        kept = _write_script(folder, script, re.sub(r"[^0-9TZ]", "", taken_at))
        if kept:
            notes.append(f"deploy.sql had been edited since coop wrote it: that copy is kept as {kept} beside the new one")
        report = render_report(changes, source_name=source, target_name=target, taken_at=taken_at, sides=sides, notes=notes, records=records, commented=commented, choices=choices)
        (folder / "report.md").write_text(report, encoding="utf-8", newline="\n")
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
        script=stats,
        choices=choices,
        notes=notes,
    )


def valid_side(value: Any, *, target: bool = False) -> bool:
    if not isinstance(value, str):
        return False
    if LIVE_SIDE.match(value) or (value == "snapshot" and not target):
        return True
    return bool(REPO_SIDE.match(value)) and ".." not in value


def default_target_for(source: Any) -> str:
    """The target a run gets when it names none: prod, in the source's named set
    when the source is `dev@<set>` (a Lakehouse dev side compares with the Lakehouse
    prod side, never with the Warehouse)."""
    m = LIVE_SIDE.match(source) if isinstance(source, str) else None
    return f"{DEFAULT_TARGET}@{m.group(2)}" if m and m.group(2) else DEFAULT_TARGET


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
    parser.add_argument("--exclude-schema", action="append", help="leave this schema out (repeatable; adds to the project file's exclude_schemas)")
    parser.add_argument("--rebuild-tables-in", action="append", help="rebuild changed tables in this schema with DROP + CREATE (repeatable; replaces the project file's rebuild_tables_in)")
    parser.add_argument("--destructive", choices=DESTRUCTIVE_MODES, help="runnable (default) or commented: whether DROP and other destructive statements are written active or commented out")
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
        if args.rebuild_tables_in:
            payload["rebuild"] = args.rebuild_tables_in
        if args.destructive:
            payload["commented"] = args.destructive == "commented"
    try:
        output = execute(payload)
    except Exception:
        output = sql_query.result("internal_error")
    _write_utf8(json.dumps(output, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
    return 0 if output["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

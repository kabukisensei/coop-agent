#!/usr/bin/env python3
"""Read a folder of T-SQL source files as a catalog (schema as code).

A "repo side" is any folder of `*.sql` files that create objects: a Fabric
Warehouse Git export or SQL database project (one file per object under folders
such as `dbo/Tables/`), a hand-kept `sql/` folder, or a coop catalog snapshot's
sibling. Every file is split into batches on `GO`; each batch's first statement
is read when it is `CREATE SCHEMA`, `CREATE TABLE`, or `CREATE [OR ALTER]`
`VIEW` / `PROCEDURE` / `FUNCTION`. Anything else (ALTER, INSERT, post-deployment
scripts, project files) is ignored, and the count of files that held no object
goes into the notes so a mis-pointed folder is visible.

Columns come from the table's column list: name, type and nullability, with the
type rendered the way the live catalog renders it (`varchar(100)`,
`decimal(18, 2)`, `datetime2(7)`; a length or precision the source leaves out
gets the engine default, as the engine itself would store it). Constraints,
indexes, computed-column expressions, defaults and identity clauses are out of
scope, as on the live side. A module's definition is the batch text as written,
so a repo compares against a live side with the same whitespace folding.

The parser is deliberately small and deterministic: files are read in sorted
path order, nothing is executed, and no file outside the folder is touched.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

MAX_FILES = 5000
MAX_FILE_BYTES = 4_000_000
SKIP_DIRS = {".git", ".coop", ".vs", "bin", "obj", "node_modules", "__pycache__"}
DEFAULT_SCHEMA = "dbo"
KINDS = {"VIEW": "view", "PROC": "procedure", "PROCEDURE": "procedure", "FUNCTION": "function"}
# Types whose length or precision the engine fills in when the source leaves it out.
LENGTH_TYPES = ("varchar", "nvarchar", "char", "nchar", "binary", "varbinary")
PRECISION_TYPES = ("decimal", "numeric")
TIME_TYPES = ("datetime2", "datetimeoffset", "time")
# Words that open a table constraint or option instead of a column. All are reserved
# words, so a bare column can never be named one. PERIOD is not reserved: it opens a
# clause only as `PERIOD FOR SYSTEM_TIME (...)` and is otherwise a column name.
CONSTRAINT_WORDS = ("CONSTRAINT", "PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "INDEX", "WITH")
_PERIOD_CLAUSE = re.compile(r"^PERIOD\s+FOR\s+SYSTEM_TIME\b", re.IGNORECASE)
# sqlsc's repo layout (coop-sql-source-control): one file per object, named
# `<schema>.<name>.sql` with %XX escapes, under these folders of the scripts folder
# that its sqlsc.yml names. In that layout the file name is the catalog name.
SQLSC_CONFIG = "sqlsc.yml"
SQLSC_FOLDERS = {"tables": "table", "views": "view", "stored procedures": "procedure", "functions": "function"}

_GO = re.compile(r"^\s*GO(?:\s+\d+)?\s*;?\s*$", re.IGNORECASE | re.MULTILINE)
_NAME_PART = r"(?:\[(?:[^\]]|\]\])+\]|\"(?:[^\"]|\"\")+\"|[A-Za-z_@#][A-Za-z0-9_@#$]*)"
_NAME = rf"({_NAME_PART}(?:\s*\.\s*{_NAME_PART}){{0,2}})"
_CREATE = re.compile(
    rf"^\s*CREATE\s+(?:OR\s+ALTER\s+)?(SCHEMA|TABLE|VIEW|PROC|PROCEDURE|FUNCTION)\s+{_NAME}",
    re.IGNORECASE,
)
_COLUMN = re.compile(rf"^\s*({_NAME_PART})\s+(.*)$", re.DOTALL)
_TYPE = re.compile(rf"^(?:\[?(?:sys|dbo)\]?\s*\.\s*)?\[?([A-Za-z_][A-Za-z0-9_]*)\]?(?:\s+(precision|varying))?\s*(\(\s*[^)]*\))?", re.IGNORECASE)


def strip_comments(sql: str) -> str:
    """Comments blanked (lengths kept so nothing shifts), strings left alone."""
    out: list[str] = []
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        if ch == "'":
            end = i + 1
            while end < n:
                if sql[end] == "'":
                    if end + 1 < n and sql[end + 1] == "'":
                        end += 2
                        continue
                    break
                end += 1
            out.append(sql[i : end + 1])
            i = end + 1
        elif ch == "[":
            end = sql.find("]", i + 1)
            end = n - 1 if end < 0 else end
            out.append(sql[i : end + 1])
            i = end + 1
        elif sql.startswith("--", i):
            end = sql.find("\n", i)
            end = n if end < 0 else end
            out.append(" " * (end - i))
            i = end
        elif sql.startswith("/*", i):
            end = sql.find("*/", i + 2)
            end = n - 2 if end < 0 else end
            out.append(re.sub(r"[^\n]", " ", sql[i : end + 2]))
            i = end + 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def unquote(part: str) -> str:
    part = part.strip()
    if part.startswith("[") and part.endswith("]"):
        return part[1:-1].replace("]]", "]")
    if part.startswith('"') and part.endswith('"'):
        return part[1:-1].replace('""', '"')
    return part


def split_name(text: str) -> tuple[str, str]:
    """`[db].[schema].[name]`, `schema.name` or `name` -> (schema, name)."""
    parts = [unquote(p) for p in re.findall(_NAME_PART, text)]
    if not parts:
        return DEFAULT_SCHEMA, ""
    if len(parts) == 1:
        return DEFAULT_SCHEMA, parts[0]
    return parts[-2], parts[-1]


def split_batches(sql: str) -> list[str]:
    return [batch for batch in _GO.split(sql) if batch.strip()]


def split_top_level(text: str) -> list[str]:
    """Split on commas outside parentheses, brackets and strings."""
    items: list[str] = []
    depth = 0
    current: list[str] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "'":
            end = i + 1
            while end < n and not (text[end] == "'" and not (end + 1 < n and text[end + 1] == "'")):
                end += 2 if text[end] == "'" else 1
            current.append(text[i : end + 1])
            i = end + 1
            continue
        if ch == "[":
            end = text.find("]", i + 1)
            end = n - 1 if end < 0 else end
            current.append(text[i : end + 1])
            i = end + 1
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            items.append("".join(current))
            current = []
        else:
            current.append(ch)
        i += 1
    if "".join(current).strip():
        items.append("".join(current))
    return items


def column_list(body: str, start: int) -> str | None:
    """The text inside the first balanced parentheses at or after `start`."""
    open_at = body.find("(", start)
    if open_at < 0:
        return None
    depth = 0
    i, n = open_at, len(body)
    while i < n:
        ch = body[i]
        if ch == "'":
            end = i + 1
            while end < n and not (body[end] == "'" and not (end + 1 < n and body[end + 1] == "'")):
                end += 2 if body[end] == "'" else 1
            i = end + 1
            continue
        if ch == "[":
            end = body.find("]", i + 1)
            i = (n if end < 0 else end) + 1
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return body[open_at + 1 : i]
        i += 1
    return None


def render_type(base: str, args: str | None, modifier: str | None) -> str:
    """The type the way the live catalog renders it, defaults filled in."""
    t = base.lower()
    if modifier and modifier.lower() == "precision":
        t = "float"  # double precision
    elif modifier:
        t = {"char": "varchar", "nchar": "nvarchar", "binary": "varbinary"}.get(t, t)  # char varying
    parts = [p.strip().lower() for p in args.strip("()").split(",")] if args else []
    parts = [p for p in parts if p]
    if t in LENGTH_TYPES:
        length = parts[0] if parts else "1"
        return f"{t}(max)" if length == "max" else f"{t}({length})"
    if t in PRECISION_TYPES:
        precision = parts[0] if parts else "18"
        scale = parts[1] if len(parts) > 1 else "0"
        return f"{t}({precision}, {scale})"
    if t in TIME_TYPES:
        return f"{t}({parts[0] if parts else '7'})"
    return t


def is_table_clause(item: str) -> bool:
    """A constraint, index, option or period clause in a column list, not a column."""
    stripped = item.strip()
    if not stripped:
        return True
    head = stripped.split(None, 1)[0].upper().rstrip(",")
    return head in CONSTRAINT_WORDS or bool(_PERIOD_CLAUSE.match(stripped))


def parse_column(item: str) -> tuple[str, str, bool] | None:
    """(name, rendered type, nullable) for a column item; None for a table clause
    (is_table_clause) or an item this reader cannot read."""
    stripped = item.strip()
    if is_table_clause(stripped):
        return None
    match = _COLUMN.match(stripped)
    if not match:
        return None
    name, rest = unquote(match.group(1)), match.group(2).strip()
    if not name or not rest:
        return None
    if re.match(r"^AS\b", rest, re.IGNORECASE):
        return name, "computed", not re.search(r"\bNOT\s+NULL\b", rest, re.IGNORECASE)
    type_match = _TYPE.match(rest)
    if not type_match:
        return None
    type_text = render_type(type_match.group(1), type_match.group(3), type_match.group(2))
    tail = rest[type_match.end():]
    nullable = not re.search(r"\bNOT\s+NULL\b", tail, re.IGNORECASE)
    return name, type_text, nullable


class ParsedSource:
    """What the folder declares, in plain structures."""

    def __init__(self) -> None:
        self.schemas: set[str] = set()
        self.tables: dict[tuple[str, str], list[tuple[str, str, bool]]] = {}
        self.modules: dict[tuple[str, str], tuple[str, str]] = {}
        self.files = 0
        self.files_without_objects = 0
        self.notes: list[str] = []
        self.truncated = False
        # Tables with a column item the reader could not read: their column list is
        # not complete, so it cannot prove a column absent.
        self.incomplete: set[tuple[str, str]] = set()


def sql_files(folder: Path) -> list[Path]:
    out: list[Path] = []
    for root, dirs, files in os.walk(folder):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith("."))
        for name in sorted(files):
            if name.lower().endswith(".sql"):
                out.append(Path(root) / name)
    return sorted(out, key=lambda p: p.as_posix().lower())


def parse_batch(batch: str, parsed: ParsedSource, file_key: tuple[str, str, str] | None = None, where: str = "") -> bool:
    """Record the batch's first CREATE statement; True when one was found.
    `file_key` is (kind, schema, name) when the file's name is the catalog name
    (sqlsc's layout): a module whose CREATE names another object is read under the
    file's name, its declared name rewritten, and a note says so."""
    plain = strip_comments(batch)
    head = _CREATE.match(plain.lstrip("﻿"))
    if not head:
        return False
    word = head.group(1).upper()
    if word == "SCHEMA":
        name = unquote(re.findall(_NAME_PART, head.group(2))[0])
        if name:
            parsed.schemas.add(name)
        return True
    schema, name = split_name(head.group(2))
    if not name:
        return False
    if file_key and word != "TABLE" and file_key[0] == KINDS[word] and (schema.lower(), name) != (file_key[1].lower(), file_key[2]):
        batch, stale = with_identity(batch, file_key[1], file_key[2])
        if stale:
            parsed.notes.append(
                f"{where or 'a file'} declares {stale} but is sqlsc's file for {file_key[1]}.{file_key[2]} (renamed after it was scripted); "
                f"read as {file_key[1]}.{file_key[2]}. Script it again with sqlsc to correct the file"
            )
            schema, name = file_key[1], file_key[2]
    key = (schema, name)
    if key in parsed.tables or key in parsed.modules:
        parsed.notes.append(f"{schema}.{name} is created in more than one file; the last one in path order counts")
    parsed.schemas.add(schema)
    if word == "TABLE":
        inner = column_list(plain, head.end())
        columns: list[tuple[str, str, bool]] = []
        if inner is not None:
            for item in split_top_level(inner):
                column = parse_column(item)
                if column:
                    columns.append(column)
                elif not is_table_clause(item):
                    parsed.incomplete.add(key)
                    parsed.notes.append(f"{schema}.{name}: a column item could not be read ({' '.join(item.split())[:80]}); its columns compare by hand")
        else:
            parsed.incomplete.add(key)
            parsed.notes.append(f"{schema}.{name}: its column list could not be read; its columns compare by hand")
        parsed.modules.pop(key, None)
        parsed.tables[key] = columns
        return True
    parsed.tables.pop(key, None)
    parsed.modules[key] = (KINDS[word], batch.strip())
    return True


_DECLARATION = re.compile(rf"^(\s*(?:CREATE\s+(?:OR\s+ALTER\s+)?|ALTER\s+)(?:VIEW|PROC|PROCEDURE|FUNCTION)\s+){_NAME}", re.IGNORECASE)


def with_identity(definition: str, schema: str, name: str) -> tuple[str, str | None]:
    """The module definition declaring `schema`.`name`, and the name it declared
    before when that differed (else None). Only the declared schema and name parts
    that differ are rewritten (bracketed); comments, strings and the body stay as
    written. sp_rename and ALTER SCHEMA ... TRANSFER leave a module's stored CREATE
    naming the old object, so a catalog's own name is what a definition is compared
    and scripted under. A schema compares case-insensitively, a name exactly."""
    plain = strip_comments(definition).replace("\ufeff", " ")
    match = _DECLARATION.match(plain)
    if not match:
        return definition, None
    offset = match.start(2)
    parts = list(re.finditer(_NAME_PART, match.group(2)))
    name_part = parts[-1]
    schema_part = parts[-2] if len(parts) > 1 else None
    declared_name = unquote(name_part.group())
    declared_schema = unquote(schema_part.group()) if schema_part else None
    edits: list[tuple[int, int, str]] = []
    if declared_name != name:
        edits.append((offset + name_part.start(), offset + name_part.end(), "[" + name.replace("]", "]]") + "]"))
    if schema_part is not None and declared_schema is not None and declared_schema.lower() != schema.lower():
        edits.append((offset + schema_part.start(), offset + schema_part.end(), "[" + schema.replace("]", "]]") + "]"))
    if not edits:
        return definition, None
    stale = (f"{declared_schema}." if declared_schema is not None else "") + declared_name
    for start, end, text in sorted(edits, reverse=True):
        definition = definition[:start] + text + definition[end:]
    return definition, stale


def _sqlsc_decode(part: str) -> str:
    """sqlsc's file-name escape: %XX bytes (UTF-8) back to characters."""
    try:
        return re.sub(r"(?:%[0-9A-Fa-f]{2})+", lambda m: bytes.fromhex(m.group().replace("%", "")).decode("utf-8"), part)
    except UnicodeDecodeError:
        return part


def sqlsc_script_dirs(folder: Path) -> set[Path]:
    """The scripts folders of every sqlsc.yml at, above or (up to three levels)
    below `folder`: where sqlsc's file-per-object layout is known to hold."""
    found: set[Path] = set()
    candidates = [d / SQLSC_CONFIG for d in (folder, *folder.parents)]
    base_depth = len(folder.parts)
    for root, dirs, files in os.walk(folder):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith(".") and len(Path(root, d).parts) - base_depth <= 3)
        if SQLSC_CONFIG in files:
            candidates.append(Path(root) / SQLSC_CONFIG)
    for config in candidates:
        try:
            if not config.is_file():
                continue
            text = config.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            continue
        match = re.search(r"^folder:\s*['\"]?([^'\"#\n]+?)['\"]?\s*(?:#.*)?$", text, re.MULTILINE)
        try:
            found.add((config.parent / (match.group(1).strip() if match else "database")).resolve())
        except OSError:
            continue
    return found


def sqlsc_file_key(path: Path, script_dirs: set[Path]) -> tuple[str, str, str] | None:
    """(kind, schema, name) for a file in sqlsc's layout, None for any other file."""
    kind = SQLSC_FOLDERS.get(path.parent.name.lower())
    if kind is None or not path.name.lower().endswith(".sql"):
        return None
    try:
        if path.parent.parent.resolve() not in script_dirs:
            return None
    except OSError:
        return None
    schema, dot, name = path.name[:-4].partition(".")
    if not dot or not schema or not name:
        return None
    return kind, _sqlsc_decode(schema), _sqlsc_decode(name)


def parse_folder(folder: Path) -> ParsedSource:
    parsed = ParsedSource()
    files = sql_files(folder)
    script_dirs = sqlsc_script_dirs(folder)
    if len(files) > MAX_FILES:
        files = files[:MAX_FILES]
        parsed.truncated = True
    for path in files:
        try:
            if path.stat().st_size > MAX_FILE_BYTES:
                parsed.notes.append(f"{path.relative_to(folder).as_posix()} is larger than the file cap and was skipped")
                continue
            text = path.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            continue
        parsed.files += 1
        found = False
        file_key = sqlsc_file_key(path, script_dirs) if script_dirs else None
        where = path.relative_to(folder).as_posix()
        for batch in split_batches(text.replace("\r\n", "\n").replace("\r", "\n")):
            if parse_batch(batch, parsed, file_key if not found else None, where):
                found = True
        if not found:
            parsed.files_without_objects += 1
    return parsed


def describe(parsed: ParsedSource) -> list[str]:
    """Notes for the report: what the folder held beyond the compared objects."""
    notes = list(parsed.notes)
    if parsed.files == 0:
        notes.append("the folder holds no .sql file")
    elif parsed.files_without_objects:
        notes.append(f"{parsed.files_without_objects} of {parsed.files} .sql file(s) create no schema, table, view, procedure or function and were ignored")
    if parsed.truncated:
        notes.append(f"more than {MAX_FILES} .sql files; only the first {MAX_FILES} in path order were read")
    return notes

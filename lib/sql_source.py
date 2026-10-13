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
CONSTRAINT_WORDS = ("CONSTRAINT", "PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "INDEX", "PERIOD", "WITH")

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


def parse_column(item: str) -> tuple[str, str, bool] | None:
    """(name, rendered type, nullable) for a column item, None for a constraint."""
    stripped = item.strip()
    if not stripped:
        return None
    head = stripped.split(None, 1)[0].upper().rstrip(",")
    if head in CONSTRAINT_WORDS:
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


def sql_files(folder: Path) -> list[Path]:
    out: list[Path] = []
    for root, dirs, files in os.walk(folder):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith("."))
        for name in sorted(files):
            if name.lower().endswith(".sql"):
                out.append(Path(root) / name)
    return sorted(out, key=lambda p: p.as_posix().lower())


def parse_batch(batch: str, parsed: ParsedSource) -> bool:
    """Record the batch's first CREATE statement; True when one was found."""
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
        parsed.modules.pop(key, None)
        parsed.tables[key] = columns
        return True
    parsed.tables.pop(key, None)
    parsed.modules[key] = (KINDS[word], batch.strip())
    return True


def parse_folder(folder: Path) -> ParsedSource:
    parsed = ParsedSource()
    files = sql_files(folder)
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
        for batch in split_batches(text.replace("\r\n", "\n").replace("\r", "\n")):
            if parse_batch(batch, parsed):
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

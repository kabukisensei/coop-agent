#!/usr/bin/env python3
"""Committed dev catalog snapshot (master plan SQ9).

Reads the contract's default dev or test target read-only (never production) and
writes the catalog as committable files, one per object, through the pinned
`coop-schema-compare snapshot` (lib/compare_tool.py; suite review 2026-10-26,
pick 1: coop keeps no snapshot writer of its own). The target is resolved
exactly as lib/sql_query.py and lib/sql_impact.py resolve a read
(`resolve_target` + `resolve_connection`: same entry, same identity pinning,
same Fabric host discovery); the package receives the host and the database and
the tenant-pinned token through its `SQL_ACCESS_TOKEN` environment variable,
with the entry's `connect_timeout` and read-only intent, and writes:

- tables: a synthesized `CREATE TABLE` with every column, type, nullability and
  identity (INFORMATION_SCHEMA.COLUMNS, sys.identity_columns);
- views, procedures and functions: the definition the catalog holds
  (sys.sql_modules), so coop-data-doc can parse the folder as a SQL source;
- `manifest.json`: when the snapshot was taken, the target's environment, kind
  and database (as the contract names them), the counts, and the list of files
  it wrote;
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
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import compare_tool  # noqa: E402
import sql_query  # noqa: E402
import sql_targets as targets_lib  # noqa: E402
import warehouse_mcp as wmcp  # noqa: E402

DEFAULT_MAX_AGE_DAYS = 7
COUNT_KEYS = ("tables", "views", "procedures", "functions")


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


def _relative(folder: Path, root: Path) -> str:
    try:
        return folder.relative_to(root).as_posix()
    except ValueError:
        return folder.as_posix()


def status(*, cwd: Path | None = None, project_arg: str | None = None, now: datetime | None = None) -> dict[str, Any]:
    project, path = _load(cwd, project_arg)
    if project is None or path is None:
        return sql_query.result("project_unavailable")
    environment = default_environment(project)
    folder, chosen = resolve_output(project, path, environment)
    rel = _relative(folder, path.resolve().parent.parent)
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


def doctor_lines(*, cwd: Path | None = None, project_arg: str | None = None, now: datetime | None = None) -> list[tuple[str, str, str]]:
    """(level, message, hint) rows for coop doctor's project-contract section."""
    project, _path = _load(cwd, project_arg)
    if project is None or not has_sql_target(project):
        return []
    info = status(cwd=cwd, project_arg=project_arg, now=now)
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


def tool_args(server: str, target: sql_query.ResolvedTarget, folder: Path, environment: str) -> tuple[list[str], dict[str, str]]:
    """(argv after the executable, the child's extra environment) for one snapshot;
    the token is added by snapshot() itself."""
    args = [
        "snapshot", f"{server}/{target.database}",
        "--out", str(folder),
        "--environment", environment,
        "--connect-timeout", str(target.connect_timeout),
    ]
    if target.read_only_intent:
        args.append("--read-only-intent")
    return args, {}


def _stamp_manifest(folder: Path, summary: dict[str, str]) -> dict[str, Any]:
    """The manifest the package wrote, its `target` set to the contract's own words
    for the entry (the package names the kind from the host, which cannot tell a
    Lakehouse SQL endpoint from a Warehouse)."""
    manifest = read_manifest(folder) or {}
    if manifest and manifest.get("target") != summary:
        manifest["target"] = summary
        (folder / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    return manifest


def snapshot(*, cwd: Path | None = None, project_arg: str | None = None) -> dict[str, Any]:
    project, path = _load(cwd, project_arg)
    if project is None or path is None:
        return sql_query.result("project_unavailable")
    environment = default_environment(project)
    folder, chosen = resolve_output(project, path, environment)
    rel = _relative(folder, path.resolve().parent.parent)
    if folder.exists():
        if not folder.is_dir():
            return sql_query.result("output_not_snapshot", path=rel)
        if read_manifest(folder) is None and any(folder.iterdir()):
            return sql_query.result("output_not_snapshot", path=rel)

    target, error = sql_query.resolve_target(cwd=cwd if project_arg is None else path.parent.parent)
    if error is not None or target is None:
        return error or sql_query.result("target_invalid")
    if target.environment not in ("dev", "test"):
        return sql_query.result("target_not_dev_or_test", environment=target.environment)
    server, token, error = sql_query.resolve_connection(target)
    if error is not None:
        return error
    summary = target.summary()
    args, env = tool_args(server, target, folder, environment)
    env[compare_tool.TOKEN_ENV] = token
    out = compare_tool.run_tool(args, env=env)
    if not out.get("ok"):
        state = _text(out.get("state")) or "tool_failed"
        details = {key: out[key] for key in ("tool", "exit_code") if key in out}
        if state == "output_not_snapshot":
            details["path"] = rel
        return sql_query.result(state, **details)
    manifest = _stamp_manifest(folder, summary)
    counts = {key: int(_mapping(out.get("objects")).get(key, 0) or 0) for key in COUNT_KEYS}
    return sql_query.result(
        "ok",
        path=rel,
        chosen_by=chosen,
        environment=environment,
        target=summary,
        taken_at=_text(out.get("taken_at")),
        objects=counts,
        files=int(out.get("files", 0) or 0),
        truncated=_mapping(manifest.get("truncated")),
        unavailable=[item for item in (out.get("unavailable") or []) if isinstance(item, str)],
        skipped=int(out.get("skipped", 0) or 0),
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
            try:
                sys.stdin.reconfigure(encoding="utf-8")
            except (AttributeError, ValueError):
                pass
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
    _write_utf8(json.dumps(output, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
    return 0 if output["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

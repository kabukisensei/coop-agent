#!/usr/bin/env python3
"""Schema compare (master plan SQ10): coop's sides over the pinned coop-schema-compare.

coop carries no compare engine of its own (suite review 2026-10-26, pick 1).
This helper turns the contract's side grammar into one
`coop-schema-compare compare <source> <target> --json` call on the package
`config/release-manifest.json` pins (lib/compare_tool.py finds and runs it) and
shapes the answer for the native `schema_compare` tool and `coop schema compare`.

What stays coop's:

- the sides: one of the contract's `sql_targets` entries (`dev`, `test`, `prod`,
  or an environment of a named set such as `dev@lakehouse`), resolved exactly as
  lib/sql_query.py resolves a read (`resolve_target` + `resolve_connection`: the
  same identity pinning, the same Fabric host discovery; production reads are
  plain reads); `snapshot`, the committed dev catalog snapshot folder
  (lib/catalog_snapshot.py); or `repo[:<name>[/<sub>]]`, the `.sql` files of one
  of the contract's `repositories` entries with role `sql` or `mixed`;
- the identity: the package receives a live side as `host/database` and the
  tenant-pinned token through the child's `SQL_ACCESS_TOKEN` environment
  variable, never on a command line, with the entry's `connect_timeout` and
  read-only intent, and the target entry's kind so a Fabric Warehouse gets its
  rebuild notes;
- the per-client defaults in `schema_compare:` of .coop/project.yml, how a run's
  choices combine with them, and the note that names the keys to add when they
  differ;
- the output folder `.coop/schema-compare/<source>-to-<target>` beside the
  contract, and the `sqlsc` bookkeeping schema (SQL source control's locks),
  always left out unless the run names it.

The package reads both catalogs read-only, diffs them (schemas, tables and
columns, views, procedures and functions) and writes `report.md` and
`deploy.sql` under that folder; nothing is applied to any target. No credential,
connection string, server name or exception text appears in a result or a file.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import catalog_snapshot as snapshot_lib  # noqa: E402
import compare_tool  # noqa: E402
import sql_query  # noqa: E402
import warehouse_mcp as wmcp  # noqa: E402

ENVIRONMENTS = ("dev", "test", "prod")
LIVE_SIDE = re.compile(r"^(dev|test|prod)(?:@([a-z][a-z0-9_-]{0,31}))?$")
REPO_SIDE = re.compile(r"^repo(?::([A-Za-z0-9_.-]+)((?:/[A-Za-z0-9_. -]+)*))?$")
REPO_ROLES = ("sql", "mixed")
DEFAULT_TARGET = "prod"
MAX_CHANGES_IN_RESULT = 200
MAX_FILTER_SCHEMAS = 50
SQLSC_SCHEMA = "sqlsc"
FILTER_SCHEMA = re.compile(r"^[^\[\]\x00-\x1f;'\"-][^\[\]\x00-\x1f;'\"]{0,127}$")
DESTRUCTIVE_MODES = ("runnable", "commented")
# The kinds the package's --target-kind takes; any other kind is read from the host.
TARGET_KINDS = ("fabric_warehouse", "fabric_lakehouse", "azure_sql", "sql_server")
COUNT_KEYS = snapshot_lib.COUNT_KEYS


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _is_todo(value: str) -> bool:
    return not value or value.strip().upper().startswith("TODO")


# --- sides ----------------------------------------------------------------------------


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


class Side:
    """One resolved side: what the package is told (`spec`), coop's summary of it,
    and, for a live entry, the resolved target and its token."""

    __slots__ = ("name", "spec", "summary", "target", "token")

    def __init__(self, name: str, spec: str, summary: dict[str, str], target: sql_query.ResolvedTarget | None = None, token: str = "") -> None:
        self.name, self.spec, self.summary, self.target, self.token = name, spec, summary, target, token


def resolve_side(side: str, *, cwd: Path | None, project: dict[str, Any], project_path: Path) -> tuple[Side | None, dict[str, Any] | None]:
    """(side, None) or (None, error result carrying `side`)."""
    if side.startswith("repo"):
        folder, label, state = resolve_repo(side, project, project_path)
        if folder is None:
            return None, sql_query.result(state, side=side)
        return Side(side, str(folder), {"environment": "repo", "kind": "sql source", "database": label}), None
    if side == "snapshot":
        environment = snapshot_lib.default_environment(project)
        folder, _chosen = snapshot_lib.resolve_output(project, project_path, environment)
        manifest = snapshot_lib.read_manifest(folder)
        if manifest is None:
            return None, sql_query.result("snapshot_missing", side=side)
        summary = {str(k): str(v) for k, v in (manifest.get("target") or {}).items() if isinstance(v, str)}
        summary.setdefault("environment", environment)
        summary["taken_at"] = _text(manifest.get("taken_at"))
        return Side(side, str(folder), summary), None
    target, error = sql_query.resolve_target(cwd=cwd, environment=side)
    if error is not None or target is None:
        error = error or sql_query.result("target_invalid")
        error["side"] = side
        return None, error
    server, token, error = sql_query.resolve_connection(target)
    if error is not None:
        error["side"] = side
        return None, error
    summary = target.summary()
    named = LIVE_SIDE.match(side)
    if named and named.group(2):
        summary["set"] = named.group(2)
    return Side(side, f"{server}/{target.database}", summary, target, token), None


# --- output folder and choices ---------------------------------------------------------


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


# --- the compare ----------------------------------------------------------------------


def tool_args(source: Side, target: Side, folder: Path, *, keep: list[str], drop: list[str], rebuild: list[str], commented: bool) -> tuple[list[str], dict[str, str]]:
    """(argv after the executable, the child's extra environment) for one compare."""
    args = [
        "compare", source.spec, target.spec,
        "--out", str(folder),
        "--source-environment", source.name,
        "--target-environment", target.name,
        "--destructive", "commented" if commented else "runnable",
    ]
    for schema in keep:
        args += ["--schema", schema]
    for schema in drop:
        args += ["--exclude-schema", schema]
    for schema in rebuild:
        args += ["--rebuild-tables-in", schema]
    env: dict[str, str] = {}
    live = [side.target for side in (source, target) if side.target is not None]
    if live:
        # One launch identity, one token: both live sides are read as the same account.
        env[compare_tool.TOKEN_ENV] = next(side.token for side in (source, target) if side.target is not None)
        args += ["--connect-timeout", str(max(entry.connect_timeout for entry in live))]
        if any(entry.read_only_intent for entry in live):
            args.append("--read-only-intent")
    if target.target is not None and target.target.kind in TARGET_KINDS:
        args += ["--target-kind", target.target.kind]
    return args, env


def _summary(side: Side, reported: Any) -> dict[str, Any]:
    counts = reported if isinstance(reported, dict) else {}
    return {**side.summary, **{key: int(counts.get(key, 0) or 0) for key in COUNT_KEYS}}


def compare(payload: Any, *, cwd: Path | None = None) -> dict[str, Any]:
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
    source_side, error = resolve_side(source, cwd=cwd, project=project, project_path=Path(project_path))
    if error is not None or source_side is None:
        return error or sql_query.result("connection_failed", side=source)
    target_side, error = resolve_side(target, cwd=cwd, project=project, project_path=Path(project_path))
    if error is not None or target_side is None:
        return error or sql_query.result("connection_failed", side=target)

    # SQL source control keeps its locks in its own schema: never offer it as
    # a change unless the person names it in `schemas`.
    bookkeeping = SQLSC_SCHEMA not in {k.lower() for k in keep}
    if bookkeeping and SQLSC_SCHEMA not in {d.lower() for d in drop}:
        drop = drop + [SQLSC_SCHEMA]
    folder, rel = resolve_output(project, Path(project_path), source, target)
    args, env = tool_args(source_side, target_side, folder, keep=keep, drop=drop, rebuild=rebuild, commented=commented)
    out = compare_tool.run_tool(args, env=env)
    if not out.get("ok"):
        state = _text(out.get("state")) or "tool_failed"
        details = {key: out[key] for key in ("tool", "exit_code") if key in out}
        if state == "output_not_snapshot":
            details["path"] = rel
        return sql_query.result(state, **details)
    notes: list[str] = []
    if defaults_hint:
        notes.append(defaults_hint)
    if bookkeeping:
        notes.append("schema sqlsc (SQL source control's locks) is left out of the compare")
    notes += [note for note in (out.get("notes") or []) if isinstance(note, str)]
    changes = [change for change in (out.get("changes") or []) if isinstance(change, dict)]
    counts = out.get("counts") if isinstance(out.get("counts"), dict) else {"total": len(changes)}
    script = out.get("script") if isinstance(out.get("script"), dict) else {}
    return sql_query.result(
        "ok",
        source=_summary(source_side, out.get("source")),
        target=_summary(target_side, out.get("target")),
        taken_at=_text(out.get("taken_at")),
        path=rel,
        counts=counts,
        # False when a side was not read whole: no difference listed does not mean none exists.
        complete=out.get("complete") is not False,
        changes=changes[:MAX_CHANGES_IN_RESULT],
        changes_truncated=len(changes) > MAX_CHANGES_IN_RESULT,
        script=script,
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

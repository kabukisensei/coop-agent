#!/usr/bin/env python3
"""Lineage docs from the live dev database (coop-data-doc `snapshot`).

For a client whose SQL is not in a repository: coop-data-doc reads the dev
database's catalog into a local folder and builds the docs from it
(`live_sources` in coop-data-doc.yml, coop-data-doc 1.6+). This helper is coop's
part: which databases, under which identity, and how old a snapshot may get.

- `setup`: the contract's dev targets (`sql_targets.dev` and every
  `sql_targets.named.<set>.dev`) become `live_sources` entries, each with its host
  resolved exactly as lib/sql_query.py resolves a read (`resolve_target` +
  `resolve_connection`: same entry, same identity pinning, same Fabric host
  discovery), written through `coop-data-doc config-set` (coop never writes
  coop-data-doc.yml itself). The host goes into that file and nowhere else.
- `refresh`: for each `live_sources` entry of the config that IS one of those
  dev targets (same host, same database), run `coop-data-doc snapshot <name>`
  with the tenant-pinned token in the child's environment
  (`COOP_DATA_DOC_ACCESS_TOKEN`). An entry the contract does not name as a dev
  target is skipped and reported: no token ever goes to a host the contract did
  not name. With `max_age_days`, a source whose snapshot is younger is skipped
  before anything is resolved or minted.
- `status`: how old each source's snapshot is; reads files only.

Dev only: never test, never production (coop-data-doc refuses a source whose
`environment` is not dev, and only dev targets are offered here). Read-only: the
package runs SELECT on catalog views with read-only intent and no data rows.
Nothing here prints a token, a host or exception text.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sql_query  # noqa: E402
import sql_targets as targets_lib  # noqa: E402
import warehouse_mcp as wmcp  # noqa: E402

TOOL = "coop-data-doc"
TOOL_ENV = "COOP_DATA_DOC_BIN"
TOKEN_ENV = "COOP_DATA_DOC_ACCESS_TOKEN"
CONFIG_NAME = "coop-data-doc.yml"
MANIFEST = ".coop-data-doc-snapshot.json"
DEFAULT_MAX_AGE_DAYS = 7
# Under the 300 s the coop-tools extension allows this helper.
SNAPSHOT_TIMEOUT_SECONDS = 240
SHOW_CONFIG_TIMEOUT_SECONDS = 30
LIVE_FOLDER = "live"

result = sql_query.result


def find_tool() -> str:
    """The coop-data-doc executable, or '' when it is not installed."""
    override = os.environ.get(TOOL_ENV, "")
    if override:
        return override if Path(override).is_file() else ""
    found = shutil.which(TOOL)
    if found:
        return found
    folders = [Path(p) for p in (os.environ.get("PIPX_BIN_DIR", ""),) if p] + [Path.home() / ".local" / "bin"]
    for folder in folders:
        for name in (TOOL, TOOL + ".exe"):
            if (folder / name).is_file():
                return str(folder / name)
    return ""


def _child_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    env.pop(TOKEN_ENV, None)  # only the one snapshot child gets a token
    env.update(extra or {})
    return env


def _run_json(
    args: list[str], *, cwd: Path, timeout: int, env: dict[str, str] | None = None, stdin: str | None = None
) -> tuple[Any, int]:
    """(the JSON the command printed, exit code); (None, code) when it printed none.
    The command's own stderr is discarded: it can carry a host name."""
    tool = find_tool()
    if not tool:
        return None, -1
    try:
        done = subprocess.run(
            [tool, *args],
            cwd=str(cwd),
            env=_child_env(env),
            input=stdin,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return None, -2
    except OSError:
        return None, -1
    try:
        return json.loads(done.stdout), done.returncode
    except ValueError:
        return None, done.returncode


# --- the contract's dev targets --------------------------------------------------


def source_name(set_name: str) -> str:
    """The live source (and its folder) for a dev target: `dev`, or `dev_<set>`."""
    return f"dev_{set_name}" if set_name else "dev"


def repo_key(set_name: str) -> str:
    """The coop-data-doc repo that receives it: `sql` (the wizard's SQL slot) for
    the main dev target, `sql_<set>` for a named set."""
    return f"sql_{set_name}" if set_name else "sql"


def dev_specs(project: dict[str, Any]) -> list[tuple[str, str]]:
    """[(target spec, set name)] for every ready dev entry: `dev` first, then
    `dev@<set>` by set name."""
    parsed = targets_lib.parse_sql_targets(project)
    out: list[tuple[str, str]] = []
    main = parsed.targets.get("dev")
    if main is not None and main.state == "ready":
        out.append(("dev", ""))
    for name in sorted(parsed.named):
        entry = parsed.named[name].get("dev")
        if entry is not None and entry.state == "ready":
            out.append((f"dev@{name}", name))
    return out


def _project(cwd: Path) -> tuple[dict[str, Any] | None, Path | None]:
    found = wmcp.find_project_yml(cwd)
    if not found:
        return None, None
    try:
        project = wmcp.load_project(Path(found))
    except Exception:
        return None, None
    return (project if isinstance(project, dict) else {}), Path(found)


def _resolve(spec: str, cwd: Path) -> tuple[sql_query.ResolvedTarget | None, str, str, dict[str, Any] | None]:
    """(target, host, token, None) for one dev spec, or (None, '', '', error)."""
    target, error = sql_query.resolve_target(cwd=cwd, environment=spec)
    if error is not None or target is None:
        return None, "", "", error or result("target_invalid")
    if target.environment != "dev":
        return None, "", "", result("target_not_dev", environment=target.environment)
    server, token, error = sql_query.resolve_connection(target)
    if error is not None:
        return None, "", "", error
    return target, server, token, None


def setup(*, cwd: Path, config: Any) -> dict[str, Any]:
    """Write the contract's dev targets into the config as live sources."""
    config_path = _config_path(config, cwd, must_exist=False)
    if config_path is None:
        return result("config_unavailable")
    project, _path = _project(cwd)
    if project is None:
        return result("project_unavailable")
    specs = dev_specs(project)
    if not specs:
        return result("no_dev_target")
    if not find_tool():
        return result("tool_unavailable", tool=TOOL)
    repos: dict[str, Any] = {}
    live: dict[str, Any] = {}
    sources: list[dict[str, str]] = []
    for spec, set_name in specs:
        target, server, _token, error = _resolve(spec, cwd)
        if error is not None or target is None:
            return {**(error or result("target_invalid")), "target": spec}
        name = source_name(set_name)
        path = f"./{LIVE_FOLDER}/{name}"
        repos[repo_key(set_name)] = {"path": path, "include": ["**/*.sql"], "exclude": []}
        live[name] = {"server": server, "database": target.database, "repo": repo_key(set_name), "environment": "dev"}
        sources.append({"name": name, "target": spec, "kind": target.kind, "repo": repo_key(set_name), "path": path, "database": target.database})
    # keep a live source someone added by hand; ours replace their own names
    existing = _config(config_path) if config_path.is_file() else None
    if existing is None:
        # a config the package creates here starts with its placeholder Power BI
        # folder; drop it so the wizard asks for the real one
        repos.setdefault("powerbi", None)
    kept = existing.get("live_sources") if isinstance(existing, dict) else None
    merged = {**(kept if isinstance(kept, dict) else {}), **live}
    _out, code = _run_json(
        ["config-set", "--config", str(config_path), "--from-json", "-"],
        cwd=config_path.parent,
        timeout=SHOW_CONFIG_TIMEOUT_SECONDS,
        stdin=json.dumps({"repos": repos, "live_sources": merged}),
    )
    if code != 0:
        return result("config_not_written" if code > 0 else "tool_unavailable" if code == -1 else "tool_timeout")
    return result("ok", sources=sources)


# --- the config's live sources -----------------------------------------------------


def _config(config_path: Path) -> dict[str, Any] | None:
    data, code = _run_json(
        ["show-config", "--config", str(config_path)], cwd=config_path.parent, timeout=SHOW_CONFIG_TIMEOUT_SECONDS
    )
    if code != 0 or not isinstance(data, dict):
        return None
    inner = data.get("config")
    return inner if isinstance(inner, dict) else data


def _live_sources(config: dict[str, Any], config_path: Path) -> list[dict[str, Any]]:
    """[{name, server, database, folder}] in name order; a source whose repo the
    config does not define is left out."""
    live = config.get("live_sources")
    repos = config.get("repos")
    if not isinstance(live, dict) or not isinstance(repos, dict):
        return []
    out: list[dict[str, Any]] = []
    for name in sorted(live):
        entry = live[name] if isinstance(live[name], dict) else {}
        repo = repos.get(str(entry.get("repo", "")))
        path = repo.get("path") if isinstance(repo, dict) else None
        if not isinstance(path, str) or not path:
            continue
        out.append(
            {
                "name": str(name),
                "server": str(entry.get("server", "")),
                "database": str(entry.get("database", "")),
                "folder": (config_path.parent / os.path.expanduser(path)).resolve(),
            }
        )
    return out


def age_days(folder: Path, now: datetime) -> float | None:
    """Days since the folder's snapshot finished; None when it never did."""
    try:
        manifest = json.loads((folder / MANIFEST).read_text(encoding="utf-8"))
        taken = datetime.fromisoformat(str(manifest["taken_at"]).replace("Z", "+00:00"))
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if taken.tzinfo is None:
        taken = taken.replace(tzinfo=timezone.utc)
    return max(0.0, (now - taken).total_seconds() / 86400.0)


def _config_path(raw: Any, cwd: Path, *, must_exist: bool = True) -> Path | None:
    if not isinstance(raw, str) or not raw:
        return None
    path = Path(raw)
    path = path if path.is_absolute() else cwd / path
    if path.name != CONFIG_NAME:
        return None
    return path if path.is_file() or (not must_exist and path.parent.is_dir() and not path.exists()) else None


def status(*, cwd: Path, config: Any, now: datetime | None = None) -> dict[str, Any]:
    config_path = _config_path(config, cwd)
    if config_path is None:
        return result("config_unavailable")
    if not find_tool():
        return result("tool_unavailable", tool=TOOL)
    parsed = _config(config_path)
    if parsed is None:
        return result("config_unreadable")
    moment = now or datetime.now(timezone.utc)
    rows = []
    for source in _live_sources(parsed, config_path):
        age = age_days(source["folder"], moment)
        rows.append({"name": source["name"], "age_days": None if age is None else round(age, 1)})
    return result("ok" if rows else "no_live_sources", sources=rows)


def _same(a: str, b: str) -> bool:
    return a.strip().lower() == b.strip().lower()


def refresh(*, cwd: Path, config: Any, max_age_days: Any = None, now: datetime | None = None) -> dict[str, Any]:
    config_path = _config_path(config, cwd)
    if config_path is None:
        return result("config_unavailable")
    if max_age_days is not None and (isinstance(max_age_days, bool) or not isinstance(max_age_days, int) or max_age_days < 0):
        return result("input_invalid")
    if not find_tool():
        return result("tool_unavailable", tool=TOOL)
    parsed = _config(config_path)
    if parsed is None:
        return result("config_unreadable")
    sources = _live_sources(parsed, config_path)
    if not sources:
        return result("no_live_sources")
    moment = now or datetime.now(timezone.utc)
    rows: list[dict[str, Any]] = []
    due = []
    for source in sources:
        age = age_days(source["folder"], moment)
        if max_age_days is not None and age is not None and age < max_age_days:
            rows.append({"name": source["name"], "state": "fresh", "age_days": round(age, 1)})
        else:
            due.append(source)
    if not due:
        return result("ok", sources=rows, taken=0)

    project, _path = _project(cwd)
    if project is None:
        return result("project_unavailable")
    # resolve each dev target once, only now that something is due
    resolved: list[tuple[str, str, str]] = []  # (host, database, token)
    first_error: dict[str, Any] | None = None
    for spec, _set_name in dev_specs(project):
        target, server, token, error = _resolve(spec, cwd)
        if error is not None or target is None:
            first_error = first_error or error
            continue
        resolved.append((server, target.database, token))
    taken = 0
    for source in due:
        match = next((r for r in resolved if _same(r[0], source["server"]) and _same(r[1], source["database"])), None)
        if match is None:
            if first_error is not None and not resolved:
                return {**first_error, "sources": rows}
            rows.append({"name": source["name"], "state": "not_a_dev_target"})
            continue
        data, code = _run_json(
            ["snapshot", source["name"], "--json", "--config", str(config_path)],
            cwd=config_path.parent,
            timeout=SNAPSHOT_TIMEOUT_SECONDS,
            env={TOKEN_ENV: match[2]},
        )
        entry = None
        if isinstance(data, dict) and isinstance(data.get("sources"), list) and data["sources"]:
            entry = data["sources"][0] if isinstance(data["sources"][0], dict) else None
        if code != 0 or entry is None:
            state = "tool_unavailable" if code == -1 else "tool_timeout" if code == -2 else "snapshot_failed"
            rows.append({"name": source["name"], "state": state})
            continue
        taken += 1
        counts = entry.get("counts") if isinstance(entry.get("counts"), dict) else {}
        rows.append(
            {
                "name": source["name"],
                "state": "taken",
                "taken_at": str(entry.get("taken_at", "")),
                "objects": {str(k): int(v) for k, v in counts.items() if isinstance(v, int)},
                "written": int(entry.get("written", 0) or 0),
                "removed": int(entry.get("removed", 0) or 0),
                "unread": len(entry.get("unread") or []),
                "renamed": len(entry.get("renamed") or []),
            }
        )
    failed = [row for row in rows if row["state"] not in ("taken", "fresh")]
    return result("ok" if not failed else "partial" if taken else "failed", sources=rows, taken=taken)


# --- entry points -----------------------------------------------------------------


def execute(payload: Any, *, cwd: Path | None = None) -> dict[str, Any]:
    """stdin contract for the coop-tools extension:
    {"command": "setup", "config": path} | {"command": "status", "config": path}
    | {"command": "refresh", "config": path, "max_age_days": int?}."""
    if not isinstance(payload, dict) or set(payload) - {"command", "config", "max_age_days"}:
        return result("input_invalid")
    here = cwd or Path.cwd()
    command = payload.get("command")
    if command == "setup" and "max_age_days" not in payload:
        return setup(cwd=here, config=payload.get("config"))
    if command == "status" and "max_age_days" not in payload:
        return status(cwd=here, config=payload.get("config"))
    if command == "refresh":
        return refresh(cwd=here, config=payload.get("config"), max_age_days=payload.get("max_age_days"))
    return result("input_invalid")


def main(argv: list[str] | None = None) -> int:
    argparse.ArgumentParser(prog="live_docs", description=__doc__.splitlines()[0]).parse_args(argv)
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
        output = result("internal_error")
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    sys.stdout.write(json.dumps(output, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

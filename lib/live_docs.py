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
- `build`: the daily lineage refresh's rebuild (CW6, scripts/docs-refresh.ps1):
  `live/.gitignore` when missing, then `coop-data-doc build --non-interactive` in
  the config's folder, exactly as the session-start refresh rebuilds, plus how
  many files in the config's `output.dir` and `site_dir` it changed (a content
  hash before and after; nothing else is read or written).
- `dev_is_prod`: a dev entry that names a production database is refused before
  anything is resolved or minted (`setup` and `refresh`): the same server and
  database, workspace and item, or Lakehouse SQL endpoint as any `prod` entry
  (`sql_targets.prod` or a named set's), or, when the dev entry's own set has
  no real production entry (a `TODO` template names nothing), a server,
  database or set name that reads as production (`prod`, `production`, `prd`,
  `live`) or equals `fabric.environment_names.prod`.
- What changed in dev: `refresh` compares each new snapshot with the one it
  replaces (the files the previous manifest named, by content hash) and reports
  the objects added, changed and removed since the previous read, in its answer
  and as a dated section of `live/dev-changes.md` (newest first). The weekly
  session-start refresh makes that the weekly "what changed in dev" summary.

Dev only: never test, never production (coop-data-doc refuses a source whose
`environment` is not dev, and only dev targets are offered here). Read-only: the
package runs SELECT on catalog views with read-only intent and no data rows.
Nothing here prints a token, a host or exception text.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote

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
# The daily refresh's whole run is capped at 20 minutes (scripts/docs-refresh.ps1);
# the build gets what is left of it, never more than this.
BUILD_TIMEOUT_SECONDS = 1200
# The word sqlsc's write check refuses (lib/sqlsc.mjs classifySqlscWrite).
PRODUCTION_WORD = re.compile(r"(^|[^a-z0-9])(prod|production|prd|live)([^a-z0-9]|$)", re.IGNORECASE)
LIVE_FOLDER = "live"
CHANGES_FILE = "dev-changes.md"
CHANGES_TITLE = "# What changed in dev"
CHANGES_INTRO = (
    "Each read of the dev database compared with the one before it, newest first. "
    "coop writes this file when it refreshes the lineage docs from dev; `live/` is "
    "one teammate's copy and is not committed.\n"
)
# the snapshot's type folders -> the word for a person
_KIND_BY_FOLDER = {
    "tables": "table",
    "views": "view",
    "stored procedures": "procedure",
    "functions": "function",
    "triggers": "trigger",
}

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


# No console window for coop-data-doc on Windows: the daily refresh runs this
# helper with no console, and a console program started from it would open one.
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0


def _child_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    env.pop(TOKEN_ENV, None)  # only the one snapshot child gets a token
    env.pop(wmcp.FABRIC_TOKEN_ENV, None)  # the launch identity is this process's alone
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
            creationflags=NO_WINDOW,
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


def _named(value: str) -> bool:
    """A real value: not blank and not a `TODO` placeholder (lib/sql_targets.py)."""
    return bool(value) and not targets_lib._placeholder(value.strip())


def _production_entries(parsed: targets_lib.SqlTargets) -> list[tuple[str, targets_lib.SqlTarget]]:
    """[(set name, entry)] for every `prod` entry that really names something (ready
    or not): the plain one (set name '') and each named set's. A template entry
    (`unconfigured`, or only `TODO` placeholders) names nothing."""
    entries = [("", parsed.targets.get("prod"))] + [(name, entries.get("prod")) for name, entries in sorted(parsed.named.items())]
    return [
        (name, e) for name, e in entries
        if e is not None and e.state != "unconfigured"
        and any(_named(v) for v in (e.server, e.database, e.workspace_id, e.item_id, e.sql_endpoint_id))
    ]


def dev_is_prod(project: dict[str, Any], spec: str) -> bool:
    """True when the dev entry `spec` names a production database (see the module
    docstring). Checked before a token is minted for it."""
    parsed = targets_lib.parse_sql_targets(project)
    dev = parsed.resolve(spec)
    if dev is None:
        return False
    same = lambda a, b: _named(a) and _named(b) and a.strip().lower() == b.strip().lower()  # noqa: E731
    prods = _production_entries(parsed)
    for _prod_set, prod in prods:
        if same(dev.server, prod.server) and same(dev.database, prod.database):
            return True
        if same(dev.workspace_id, prod.workspace_id) and same(dev.item_id, prod.item_id):
            return True
        if same(dev.sql_endpoint_id, prod.sql_endpoint_id):
            return True
    _env, set_name = targets_lib.split_target_spec(spec)
    # Only a real production entry of the dev entry's own set says what production
    # is for it; another set's, or none, leaves the word and environment_names checks on.
    if any(prod_set == set_name for prod_set, _prod in prods):
        return False
    if PRODUCTION_WORD.search(f"{dev.server} {dev.database} {set_name}"):
        return True
    fabric = project.get("fabric") if isinstance(project.get("fabric"), dict) else {}
    names = fabric.get("environment_names") if isinstance(fabric.get("environment_names"), dict) else {}
    prod_name = names.get("prod") if isinstance(names.get("prod"), str) else ""
    return same(dev.database, prod_name) or same(dev.server, prod_name)


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
    for spec, _set_name in specs:
        if dev_is_prod(project, spec):
            return result("dev_is_prod", target=spec)
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


def _mint_launch_identity(project: dict[str, Any], project_path: Path | None, spec: str) -> dict[str, Any] | None:
    """Mint the launch identity for `spec` into this process's environment, as
    `warehouse_mcp.py launch-token` does for a launch (the audience the entry's
    kind uses, pinned to the client tenant); None when minted, else the error.
    Never prompts: an expired sign-in is `auth_required`."""
    entry = targets_lib.parse_sql_targets(project).resolve(spec)
    resource = wmcp.FABRIC_RESOURCE if entry is not None and entry.discovered else wmcp.SQL_RESOURCE
    token, state = wmcp.az_access_token(resource=resource, tenant=wmcp.pinned_tenant(project_path))
    if state != "ok":
        return result(state, stage="launch_token")
    os.environ[wmcp.FABRIC_TOKEN_ENV] = token
    return None


def refresh(*, cwd: Path, config: Any, max_age_days: Any = None, now: datetime | None = None, mint: bool = False) -> dict[str, Any]:
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

    project, project_path = _project(cwd)
    if project is None:
        return result("project_unavailable")
    if mint and not os.environ.get(wmcp.FABRIC_TOKEN_ENV, ""):
        # The daily refresh (no coop session, so no launch token): mint the
        # launch identity here, only now that a ready dev entry that is not
        # production needs it, named sets included. It stays in this process.
        usable = [spec for spec, _set_name in dev_specs(project) if not dev_is_prod(project, spec)]
        if usable:
            error = _mint_launch_identity(project, project_path, usable[0])
            if error is not None:
                return {**error, "sources": rows}
    # resolve each dev target once, only now that something is due
    resolved: list[tuple[str, str, str]] = []  # (host, database, token)
    first_error: dict[str, Any] | None = None
    for spec, _set_name in dev_specs(project):
        if dev_is_prod(project, spec):
            # never minted, never read: a source on it is not a dev target
            first_error = first_error or result("dev_is_prod", target=spec)
            continue
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
        before = snapshot_files(source["folder"])
        since = str(_manifest(source["folder"]).get("taken_at") or "")
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
        row = {
            "name": source["name"],
            "state": "taken",
            "taken_at": str(entry.get("taken_at", "")),
            "objects": {str(k): int(v) for k, v in counts.items() if isinstance(v, int)},
            "written": int(entry.get("written", 0) or 0),
            "removed": int(entry.get("removed", 0) or 0),
            "unread": len(entry.get("unread") or []),
            "renamed": len(entry.get("renamed") or []),
        }
        after = snapshot_files(source["folder"])
        if before is not None and after is not None:
            # a previous read to compare with: what changed in dev since it
            row["since"] = since
            row["changes"] = compare_snapshots(before, after)
            section = changes_section(source["name"], since, row["taken_at"], row["changes"])
            row["changes_file"] = f"{LIVE_FOLDER}/{CHANGES_FILE}" if record_changes(config_path.parent / LIVE_FOLDER, section) else ""
        rows.append(row)
    failed = [row for row in rows if row["state"] not in ("taken", "fresh")]
    return result("ok" if not failed else "partial" if taken else "failed", sources=rows, taken=taken)


# --- the daily refresh's rebuild ---------------------------------------------------


def _tree_hashes(folders: list[Path]) -> dict[str, str]:
    """{path: content hash} of every file under the folders (links not followed)."""
    out: dict[str, str] = {}
    for folder in folders:
        if not folder.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(folder):
            dirnames[:] = [d for d in dirnames if not os.path.islink(os.path.join(dirpath, d))]
            for name in filenames:
                path = os.path.join(dirpath, name)
                try:
                    if os.path.islink(path):
                        continue
                    with open(path, "rb") as fh:
                        out[path] = hashlib.sha256(fh.read()).hexdigest()
                except OSError:
                    continue
    return out


def build(*, cwd: Path, config: Any, timeout_seconds: Any = None) -> dict[str, Any]:
    """Rebuild the docs from the snapshots, as the session-start refresh does, and
    count the files that changed in the config's output folders."""
    config_path = _config_path(config, cwd)
    if config_path is None:
        return result("config_unavailable")
    if timeout_seconds is not None and (isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, int) or timeout_seconds < 1):
        return result("input_invalid")
    if not find_tool():
        return result("tool_unavailable", tool=TOOL)
    parsed = _config(config_path)
    if parsed is None:
        return result("config_unreadable")
    output = parsed.get("output") if isinstance(parsed.get("output"), dict) else {}
    folders = [
        (config_path.parent / os.path.expanduser(str(output[key]))).resolve()
        for key in ("dir", "site_dir")
        if isinstance(output.get(key), str) and output[key]
    ]
    live = config_path.parent / LIVE_FOLDER
    try:
        # live/ is one teammate's copy of the dev definitions (coop-tools ignoreLiveFolder)
        if live.is_dir() and not (live / ".gitignore").exists():
            (live / ".gitignore").write_text("*\n", encoding="utf-8")
    except OSError:
        pass
    before = _tree_hashes(folders)
    limit = min(BUILD_TIMEOUT_SECONDS, timeout_seconds) if timeout_seconds is not None else BUILD_TIMEOUT_SECONDS
    try:
        done = subprocess.run(
            [find_tool(), "build", "--non-interactive"],
            cwd=str(config_path.parent),
            env=_child_env(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=limit,
            check=False,
            creationflags=NO_WINDOW,
        )
    except subprocess.TimeoutExpired:
        return result("tool_timeout")
    except OSError:
        return result("tool_unavailable", tool=TOOL)
    if done.returncode != 0:
        return result("build_failed")
    after = _tree_hashes(folders)
    changed = sum(1 for path in before.keys() | after.keys() if before.get(path) != after.get(path))
    return result("ok", files_changed=changed)


# --- what changed in dev -----------------------------------------------------------


def _manifest(folder: Path) -> dict[str, Any]:
    try:
        data = json.loads((folder / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def snapshot_files(folder: Path) -> dict[str, str] | None:
    """{relative path: content hash} for every object file the folder's finished
    manifest names; None when the folder holds no finished snapshot."""
    manifest = _manifest(folder)
    files = manifest.get("files")
    if not manifest.get("taken_at") or not isinstance(files, list):
        return None
    out: dict[str, str] = {}
    for relative in files:
        if not isinstance(relative, str) or not relative.lower().endswith(".sql") or ".." in relative:
            continue
        try:
            out[relative] = hashlib.sha256((folder / relative).read_bytes()).hexdigest()
        except OSError:
            continue
    return out


def object_label(relative: str) -> str:
    """`Views/dbo.v_customers.sql` -> `dbo.v_customers (view)`; file names carry
    sqlsc's %XX escapes."""
    parts = relative.replace("\\", "/").split("/")
    kind = _KIND_BY_FOLDER.get(parts[0].lower(), "object") if len(parts) > 1 else "object"
    name = parts[-1]
    if name.lower().endswith(".sql"):
        name = name[:-4]
    return f"{unquote(name)} ({kind})"


def compare_snapshots(before: dict[str, str], after: dict[str, str]) -> dict[str, list[str]]:
    """The objects added, changed and removed between two snapshots, by label."""
    return {
        "added": sorted(object_label(p) for p in after.keys() - before.keys()),
        "changed": sorted(object_label(p) for p in after.keys() & before.keys() if after[p] != before[p]),
        "removed": sorted(object_label(p) for p in before.keys() - after.keys()),
    }


def _day(stamp: str) -> str:
    return stamp[:10] if len(stamp) >= 10 else stamp


def changes_section(name: str, since: str, taken_at: str, changes: dict[str, list[str]]) -> str:
    lines = [f"## {name}: {_day(taken_at)} (since {_day(since)})", ""]
    if not any(changes.values()):
        lines.append("- Nothing changed.")
    for word in ("added", "changed", "removed"):
        for label in changes.get(word, []):
            lines.append(f"- {word.capitalize()}: {label}")
    return "\n".join(lines) + "\n"


def record_changes(live_folder: Path, section: str) -> bool:
    """Put the section at the top of live/dev-changes.md (under its title), creating
    the file when needed. False when it could not be written."""
    path = live_folder / CHANGES_FILE
    try:
        old = path.read_text(encoding="utf-8") if path.is_file() else ""
    except OSError:
        old = ""
    marker = "\n## "
    at = old.find(marker)
    older = old[at + 1 :] if at >= 0 else ""
    text = f"{CHANGES_TITLE}\n\n{CHANGES_INTRO}\n{section}" + (f"\n{older}" if older else "")
    try:
        live_folder.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
    except OSError:
        return False
    return True


# --- entry points -----------------------------------------------------------------


def execute(payload: Any, *, cwd: Path | None = None) -> dict[str, Any]:
    """stdin contract for the coop-tools extension:
    {"command": "setup", "config": path} | {"command": "status", "config": path}
    | {"command": "refresh", "config": path, "max_age_days": int?, "mint": true?}
    | {"command": "build", "config": path, "timeout_seconds": int?}.
    `mint` (the daily refresh, scripts/docs-refresh.ps1): with no launch token in
    the environment, mint one after everything else was checked."""
    if not isinstance(payload, dict) or set(payload) - {"command", "config", "max_age_days", "timeout_seconds", "mint"}:
        return result("input_invalid")
    here = cwd or Path.cwd()
    command = payload.get("command")
    if "timeout_seconds" in payload and command != "build":
        return result("input_invalid")
    if "mint" in payload and (command != "refresh" or payload["mint"] is not True):
        return result("input_invalid")
    if command == "build" and "max_age_days" not in payload:
        return build(cwd=here, config=payload.get("config"), timeout_seconds=payload.get("timeout_seconds"))
    if command == "setup" and "max_age_days" not in payload:
        return setup(cwd=here, config=payload.get("config"))
    if command == "status" and "max_age_days" not in payload:
        return status(cwd=here, config=payload.get("config"))
    if command == "refresh":
        return refresh(cwd=here, config=payload.get("config"), max_age_days=payload.get("max_age_days"), mint=payload.get("mint") is True)
    return result("input_invalid")


def main(argv: list[str] | None = None) -> int:
    argparse.ArgumentParser(prog="live_docs", description=__doc__.splitlines()[0]).parse_args(argv)
    try:
        # utf-8-sig: a leading BOM is dropped. Windows PowerShell 5.1's
        # Process.StandardInput writes one before the request when the console
        # is UTF-8 (scripts/docs-refresh.ps1 avoids it; this is the second guard).
        try:
            sys.stdin.reconfigure(encoding="utf-8-sig")
        except (AttributeError, ValueError):
            pass
        text = sys.stdin.read()
        payload = json.loads(text[1:] if text.startswith("﻿") else text)
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

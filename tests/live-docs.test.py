#!/usr/bin/env python3
"""Offline tests for lib/live_docs.py: lineage docs from the live dev database,
read by a stub `coop-data-doc` (the pinned package's `show-config`, `config-set`
and `snapshot`)."""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent

# Windows runners default stdout to cp1252, which cannot encode the check mark.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass
sys.path.insert(0, str(ROOT / "lib"))


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "lib" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


sq = load("sql_query")
ld = load("live_docs")

WH_HOST = "abc.datawarehouse.fabric.microsoft.com"
SQL_HOST = "contoso-dev.database.windows.net"
TAKEN = datetime(2026, 11, 24, 16, 0, tzinfo=timezone.utc)

# The stub keeps the config as JSON beside the path it is given (the real package
# renders YAML; coop only ever reads it back through show-config) and records
# every call with the token it was handed, which travels in the environment only.
STUB = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
argv = sys.argv[1:]
log = os.environ.get("COOP_TEST_RECORD", "")
if log:
    with open(log, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"argv": argv, "token": os.environ.get("COOP_DATA_DOC_ACCESS_TOKEN", "")}) + "\\n")
config = Path(argv[argv.index("--config") + 1])
store = config.with_suffix(".json")
data = json.loads(store.read_text(encoding="utf-8")) if store.is_file() else {"repos": {}, "live_sources": {}}
if argv[0] == "show-config":
    print(json.dumps({**data, "exists": config.is_file(), "path": str(config)}))
elif argv[0] == "config-set":
    patch = json.load(sys.stdin)
    data["repos"].update(patch.get("repos", {}))
    if "live_sources" in patch:
        data["live_sources"] = patch["live_sources"]
    store.write_text(json.dumps(data), encoding="utf-8")
    config.write_text("# stub\\n", encoding="utf-8")
    print("Wrote")
elif argv[0] == "snapshot":
    name = argv[1]
    if name == os.environ.get("COOP_TEST_FAIL", ""):
        print("boom", file=sys.stderr)
        sys.exit(1)
    folder = config.parent / data["repos"][data["live_sources"][name]["repo"]]["path"]
    folder.mkdir(parents=True, exist_ok=True)
    (folder / ".coop-data-doc-snapshot.json").write_text(json.dumps({"taken_at": "2026-11-24T16:00:00Z"}), encoding="utf-8")
    print(json.dumps({"command": "snapshot", "sources": [{"source": name, "path": str(folder), "skipped": False,
        "taken_at": "2026-11-24T16:00:00Z", "counts": {"table": 2, "view": 1}, "written": 3, "removed": 0,
        "unread": [{"schema": "dbo", "name": "v", "type": "view", "why": "x"}], "renamed": [], "dependencies": 1, "dependencies_error": None}]}))
'''


def write_stub(folder: Path) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        script = folder / "coop-data-doc.py"
        script.write_text(STUB, encoding="utf-8")
        wrapper = folder / "coop-data-doc.cmd"
        wrapper.write_text(f'@"{sys.executable}" "{script}" %*\r\n', encoding="ascii")
        return wrapper
    stub = folder / "coop-data-doc"
    stub.write_text(STUB, encoding="utf-8")
    stub.chmod(stub.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return stub


CONTRACT = """schema_version: 1
profile:
  client: Contoso
sql_targets:
  default_environment: dev
  dev:
    kind: azure_sql
    server: "contoso-dev.database.windows.net"
    database: ContosoDW
  prod:
    kind: azure_sql
    server: "contoso.database.windows.net"
    database: ContosoDW
  named:
    lake:
      dev:
        kind: azure_sql
        server: "contoso-lake-dev.database.windows.net"
        database: ContosoLake
"""


def fake_resolve_target(*, cwd=None, environment=None):
    database = {"dev": "ContosoDW", "dev@lake": "ContosoLake"}.get(environment)
    if database is None:
        return None, sq.result("target_invalid")
    return sq.ResolvedTarget("azure_sql", "dev", database, server="unused"), None


def fake_resolve_connection(target):
    host = SQL_HOST if target.database == "ContosoDW" else WH_HOST
    return host, "tok-" + target.database, None


resolving = lambda: mock.patch.multiple(sq, resolve_target=mock.Mock(side_effect=fake_resolve_target), resolve_connection=mock.Mock(side_effect=fake_resolve_connection))  # noqa: E731
no_resolving = lambda: mock.patch.multiple(sq, resolve_target=mock.Mock(side_effect=AssertionError("nothing is resolved")), resolve_connection=mock.Mock(side_effect=AssertionError("nothing is minted")))  # noqa: E731


def calls(record: Path) -> list[dict]:
    return [json.loads(line) for line in record.read_text(encoding="utf-8").splitlines()] if record.exists() else []


# --- input shape ------------------------------------------------------------------
with no_resolving():
    assert ld.execute({"command": "drop"})["state"] == "input_invalid"
    assert ld.execute("refresh")["state"] == "input_invalid"
    assert ld.execute({"command": "refresh", "config": "x", "object": "y"})["state"] == "input_invalid"
    assert ld.execute({"command": "setup", "config": "x", "max_age_days": 1})["state"] == "input_invalid"

with tempfile.TemporaryDirectory() as tmp:
    stub = write_stub(Path(tmp) / "bin")
    record = Path(tmp) / "record.jsonl"
    os.environ[ld.TOOL_ENV] = str(stub)
    os.environ["COOP_TEST_RECORD"] = str(record)
    os.environ[ld.TOKEN_ENV] = "stale-token-from-the-parent"
    root = Path(tmp) / "work" / "contoso"
    (root / ".coop").mkdir(parents=True)
    (root / ".coop" / "project.yml").write_text(CONTRACT, encoding="utf-8")
    config = root / "coop-data-doc.yml"

    # Only a file named coop-data-doc.yml; refresh and status need it to exist.
    with no_resolving():
        assert ld.setup(cwd=root, config=str(root / "other.yml"))["state"] == "config_unavailable"
        assert ld.refresh(cwd=root, config=str(config))["state"] == "config_unavailable"
        assert ld.status(cwd=root, config=str(config))["state"] == "config_unavailable"

    # setup: every dev target (never prod) becomes a live source through config-set.
    with resolving():
        out = ld.setup(cwd=root, config=str(config))
    assert out["ok"], out
    assert [(s["name"], s["target"], s["repo"], s["path"], s["database"]) for s in out["sources"]] == [
        ("dev", "dev", "sql", "./live/dev", "ContosoDW"),
        ("dev_lake", "dev@lake", "sql_lake", "./live/dev_lake", "ContosoLake"),
    ], out
    # the host is in the config and nowhere in the answer
    assert SQL_HOST not in json.dumps(out) and WH_HOST not in json.dumps(out) and "tok-" not in json.dumps(out)
    stored = json.loads(config.with_suffix(".json").read_text(encoding="utf-8"))
    assert stored["live_sources"] == {
        "dev": {"server": SQL_HOST, "database": "ContosoDW", "repo": "sql", "environment": "dev"},
        "dev_lake": {"server": WH_HOST, "database": "ContosoLake", "repo": "sql_lake", "environment": "dev"},
    }, stored
    assert stored["repos"]["sql"] == {"path": "./live/dev", "include": ["**/*.sql"], "exclude": []}
    # no call so far carried a token, on the command line or in the environment
    assert all(c["token"] == "" and "tok-" not in " ".join(c["argv"]) for c in calls(record)), calls(record)

    # status before any snapshot: both sources have no age; nothing is resolved.
    with no_resolving():
        info = ld.status(cwd=root, config=str(config), now=TAKEN)
    assert info["state"] == "ok" and info["sources"] == [{"name": "dev", "age_days": None}, {"name": "dev_lake", "age_days": None}], info

    # refresh: one snapshot per source, each with its own database's token, in the
    # child's environment only.
    record.unlink()
    with resolving():
        out = ld.refresh(cwd=root, config=str(config), now=TAKEN)
    assert out["state"] == "ok" and out["taken"] == 2, out
    assert out["sources"][0] == {"name": "dev", "state": "taken", "taken_at": "2026-11-24T16:00:00Z", "objects": {"table": 2, "view": 1}, "written": 3, "removed": 0, "unread": 1, "renamed": 0}, out
    snaps = [c for c in calls(record) if c["argv"][0] == "snapshot"]
    assert [(c["argv"][1], c["token"]) for c in snaps] == [("dev", "tok-ContosoDW"), ("dev_lake", "tok-ContosoLake")], snaps
    assert all(c["argv"] == ["snapshot", c["argv"][1], "--json", "--config", str(config)] for c in snaps)
    assert all(c["token"] == "" for c in calls(record) if c["argv"][0] != "snapshot"), "only the snapshot child gets a token"
    assert "tok-" not in json.dumps(out) and SQL_HOST not in json.dumps(out)

    # A fresh snapshot is skipped before anything is resolved or minted.
    record.unlink()
    with no_resolving():
        out = ld.refresh(cwd=root, config=str(config), max_age_days=7, now=TAKEN + timedelta(days=2))
    assert out["state"] == "ok" and out["taken"] == 0 and [s["state"] for s in out["sources"]] == ["fresh", "fresh"], out
    assert not [c for c in calls(record) if c["argv"][0] == "snapshot"]
    with resolving():
        out = ld.refresh(cwd=root, config=str(config), max_age_days=7, now=TAKEN + timedelta(days=8))
    assert out["taken"] == 2, out
    for bad in (-1, True, "7", 1.5):
        assert ld.refresh(cwd=root, config=str(config), max_age_days=bad)["state"] == "input_invalid"

    # A live source that is not one of the contract's dev targets (here: the
    # production host, typed into the config by hand) never gets a token.
    stored["live_sources"]["dev"]["server"] = "contoso.database.windows.net"
    config.with_suffix(".json").write_text(json.dumps(stored), encoding="utf-8")
    record.unlink()
    with resolving():
        out = ld.refresh(cwd=root, config=str(config), now=TAKEN)
    assert out["state"] == "partial" and out["taken"] == 1, out
    assert out["sources"][0] == {"name": "dev", "state": "not_a_dev_target"}, out
    assert [c["argv"][1] for c in calls(record) if c["argv"][0] == "snapshot"] == ["dev_lake"]
    stored["live_sources"]["dev"]["server"] = SQL_HOST.upper()   # a host compares case-insensitively
    config.with_suffix(".json").write_text(json.dumps(stored), encoding="utf-8")

    # A failing snapshot is one row; the other source still refreshes.
    with resolving(), mock.patch.dict(os.environ, {"COOP_TEST_FAIL": "dev"}):
        out = ld.refresh(cwd=root, config=str(config), now=TAKEN)
    assert out["state"] == "partial" and [s["state"] for s in out["sources"]] == ["snapshot_failed", "taken"], out

    # Identity errors pass through; a missing package is its own state.
    with mock.patch.object(sq, "resolve_target", return_value=(None, sq.result("launch_identity_missing"))):
        assert ld.refresh(cwd=root, config=str(config), now=TAKEN)["state"] == "launch_identity_missing"
        assert ld.setup(cwd=root, config=str(config))["state"] == "launch_identity_missing"
    with resolving(), mock.patch.object(sq, "resolve_connection", return_value=("", "", sq.result("identity_mismatch"))):
        assert ld.setup(cwd=root, config=str(config))["state"] == "identity_mismatch"
    with no_resolving(), mock.patch.dict(os.environ, {ld.TOOL_ENV: str(Path(tmp) / "missing")}):
        assert ld.refresh(cwd=root, config=str(config))["state"] == "tool_unavailable"
        assert ld.status(cwd=root, config=str(config))["state"] == "tool_unavailable"

    # A resolved target that is not dev is refused before any mint.
    with mock.patch.object(sq, "resolve_target", return_value=(sq.ResolvedTarget("azure_sql", "prod", "ContosoDW", server="x"), None)), \
            mock.patch.object(sq, "resolve_connection", side_effect=AssertionError("no mint for production")):
        out = ld.setup(cwd=root, config=str(config))
    assert out["state"] == "target_not_dev" and out["environment"] == "prod", out

    # No contract, or a contract without a dev target.
    outside = Path(tmp) / "outside"
    outside.mkdir()
    (outside / "coop-data-doc.yml").write_text("# x\n", encoding="utf-8")
    with no_resolving():
        assert ld.setup(cwd=outside, config=str(outside / "coop-data-doc.yml"))["state"] == "project_unavailable"
    (root / ".coop" / "project.yml").write_text("schema_version: 1\nprofile:\n  client: Contoso\n", encoding="utf-8")
    with no_resolving():
        assert ld.setup(cwd=root, config=str(config))["state"] == "no_dev_target"

    # The stdin contract routes to the same functions.
    assert ld.execute({"command": "status", "config": str(config)}, cwd=root)["state"] == "ok"

    for key in (ld.TOOL_ENV, "COOP_TEST_RECORD", ld.TOKEN_ENV):
        os.environ.pop(key, None)

print("✓ live docs helper (dev targets only, token per source in the child's environment, fresh snapshots never connect)")

#!/usr/bin/env python3
"""Offline tests for lib/catalog_snapshot.py: the committed dev catalog snapshot (SQ9),
written by a stub `coop-schema-compare snapshot` (suite review 2026-10-26, pick 1)."""

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
sys.path.insert(0, str(ROOT / "lib"))


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "lib" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


sq = load("sql_query")
ct = load("compare_tool")
cs = load("catalog_snapshot")

AZ_HOST = "contoso-dev.database.windows.net"
TAKEN = datetime(2026, 10, 26, 16, 0, tzinfo=timezone.utc)   # the stub's taken_at

# The stub stands in for the pinned package: it records argv and the token it was
# handed (environment only) and writes a snapshot folder the way the package does.
STUB = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
record = os.environ.get("COOP_TEST_RECORD", "")
if record:
    Path(record).write_text(json.dumps({"argv": sys.argv[1:], "token": os.environ.get("SQL_ACCESS_TOKEN", "")}), encoding="utf-8")
answer = os.environ.get("COOP_TEST_ANSWER", "")
if answer:
    data = json.loads(Path(answer).read_text(encoding="utf-8"))
    print(json.dumps(data))
    sys.exit(0 if data.get("ok") else 1)
out = Path(sys.argv[sys.argv.index("--out") + 1])
out.mkdir(parents=True, exist_ok=True)
for old in out.rglob("*.sql"):
    old.unlink()
(out / "dbo").mkdir(exist_ok=True)
(out / "dbo" / "Orders.sql").write_text("-- coop catalog snapshot: table dbo.Orders\\nCREATE TABLE [dbo].[Orders] (\\n    [OrderId] int IDENTITY NOT NULL\\n);\\n", encoding="utf-8")
manifest = {"coop_catalog_snapshot": True, "schema_version": 1, "taken_at": "2026-10-26T16:00:00Z",
            "target": {"environment": sys.argv[sys.argv.index("--environment") + 1], "kind": "fabric_warehouse", "database": "ContosoDW"},
            "objects": {"tables": 1, "views": 2, "procedures": 1, "functions": 0}, "schemas": ["dbo"], "files": ["dbo/Orders.sql"],
            "truncated": {"schemas": False, "objects": False, "columns": False},
            "unavailable": ["definitions (sys.sql_modules is not readable on this target)"], "skipped": ["dbo.bad;name"], "identity_columns": True}
(out / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\\n", encoding="utf-8")
(out / "README.md").write_text("# coop catalog snapshot\\n", encoding="utf-8")
print(json.dumps({"ok": True, "state": "ok", "taken_at": manifest["taken_at"], "objects": manifest["objects"], "files": 1, "skipped": 1, "unavailable": manifest["unavailable"], "path": out.as_posix()}))
'''

def write_stub(folder: Path, source: str) -> Path:
    """The stub as an executable: a shebang script on POSIX; on Windows a .cmd
    wrapper that runs the script with this interpreter (a shebang file cannot be
    started by CreateProcess)."""
    folder.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        script = folder / "coop-schema-compare.py"
        script.write_text(source, encoding="utf-8")
        wrapper = folder / "coop-schema-compare.cmd"
        wrapper.write_text(f'@"{sys.executable}" "{script}" %*\r\n', encoding="ascii")
        return wrapper
    stub = folder / "coop-schema-compare"
    stub.write_text(source, encoding="utf-8")
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
"""


def make_root(tmp: str, contract: str = CONTRACT) -> Path:
    root = Path(tmp) / "work" / "contoso"
    (root / ".coop").mkdir(parents=True)
    (root / ".coop" / "project.yml").write_text(contract, encoding="utf-8")
    return root


def target(kind="azure_sql", environment="dev", **extra):
    return sq.ResolvedTarget(kind, environment, "ContosoDW", server=AZ_HOST if kind == "azure_sql" else "", **extra)


def resolved(kind="azure_sql", environment="dev", **extra):
    return mock.patch.object(sq, "resolve_target", return_value=(target(kind, environment, **extra), None))


connection = mock.patch.object(sq, "resolve_connection", side_effect=lambda t: (AZ_HOST, "tok-" + t.environment, None))

# --- input shape for the stdin contract -----------------------------------------
with mock.patch.object(sq, "resolve_target", side_effect=AssertionError("no resolution for bad input")):
    assert cs.execute({"command": "snapshot", "object": "x"})["state"] == "input_invalid"
    assert cs.execute({"command": "drop"})["state"] == "input_invalid"
    assert cs.execute("snapshot")["state"] == "input_invalid"

with tempfile.TemporaryDirectory() as tmp:
    stub = write_stub(Path(tmp) / "bin", STUB)
    record_path = Path(tmp) / "record.json"
    os.environ[ct.TOOL_ENV] = str(stub)
    os.environ["COOP_TEST_RECORD"] = str(record_path)
    os.environ.pop("COOP_TEST_ANSWER", None)
    root = make_root(tmp)

    # Status before any snapshot: missing, default folder beside the contract.
    info = cs.status(cwd=root, now=TAKEN)
    assert info["state"] == "missing" and info["ok"] is False, info
    assert info["path"] == ".coop/catalog/dev" and info["chosen_by"] == "default" and info["max_age_days"] == 7, info
    rows = cs.doctor_lines(cwd=root)
    assert rows and rows[0][0] == "warn" and "no catalog snapshot under .coop/catalog/dev" in rows[0][1], rows

    # Snapshot: the package is told the host, the database, the environment and the
    # entry's connection settings; the token travels in its environment only.
    with resolved("fabric_lakehouse", connect_timeout=20), connection:
        out = cs.snapshot(cwd=root)
    assert out["ok"] and out["state"] == "ok", out
    folder = root / ".coop" / "catalog" / "dev"
    call = json.loads(record_path.read_text(encoding="utf-8"))
    assert call["argv"] == ["snapshot", f"{AZ_HOST}/ContosoDW", "--out", str(folder.resolve()), "--environment", "dev", "--connect-timeout", "20", "--json"], call["argv"]
    assert call["token"] == "tok-dev" and "tok-" not in " ".join(call["argv"])
    assert out["objects"] == {"tables": 1, "views": 2, "procedures": 1, "functions": 0} and out["files"] == 1 and out["skipped"] == 1, out
    assert out["path"] == ".coop/catalog/dev" and out["chosen_by"] == "default" and out["environment"] == "dev" and out["taken_at"] == "2026-10-26T16:00:00Z", out
    assert out["unavailable"] == ["definitions (sys.sql_modules is not readable on this target)"] and out["truncated"] == {"schemas": False, "objects": False, "columns": False}, out
    assert out["target"] == {"environment": "dev", "kind": "fabric_lakehouse", "database": "ContosoDW"}, "the contract's words for the entry"
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["target"] == {"environment": "dev", "kind": "fabric_lakehouse", "database": "ContosoDW"}, "the manifest carries the contract's kind, not the one the package read from the host"
    assert manifest["files"] == ["dbo/Orders.sql"] and manifest["identity_columns"] is True and manifest["coop_catalog_snapshot"] is True
    assert (folder / "dbo" / "Orders.sql").is_file() and (folder / "README.md").is_file()
    # No host, no token anywhere in the folder or the answer.
    for file in folder.rglob("*"):
        if file.is_file():
            text = file.read_text(encoding="utf-8")
            assert AZ_HOST not in text and "tok-" not in text and "SERVER=" not in text, file
    assert AZ_HOST not in json.dumps(out) and "tok-" not in json.dumps(out)

    # An Azure SQL entry with read-scale replicas asks for read-only intent.
    with resolved(read_only_intent=True), connection:
        assert cs.snapshot(cwd=root)["ok"]
    argv = json.loads(record_path.read_text(encoding="utf-8"))["argv"]
    assert argv[-2:] == ["--read-only-intent", "--json"] and argv[argv.index("--connect-timeout") + 1] == "15", argv

    # Status after: fresh; stale once older than max_age_days; doctor rows follow.
    info = cs.status(cwd=root, now=TAKEN + timedelta(days=2))
    assert info["state"] == "ok" and info["age_days"] == 2.0 and info["objects"]["views"] == 2, info
    # doctor_lines reads the real clock, so pin it.
    with mock.patch.object(cs, "datetime", wraps=datetime) as fake_dt:
        fake_dt.now.return_value = TAKEN + timedelta(days=2)
        rows = cs.doctor_lines(cwd=root)
    assert rows[0][0] == "ok" and "1 tables, 2 views, 1 procedures, 0 functions" in rows[0][1], rows
    info = cs.status(cwd=root, now=TAKEN + timedelta(days=8))
    assert info["state"] == "stale" and info["age_days"] == 8.0, info
    with mock.patch.object(cs, "datetime", wraps=datetime) as fake_dt:
        fake_dt.now.return_value = TAKEN + timedelta(days=9)
        rows = cs.doctor_lines(cwd=root)
    assert rows[0][0] == "warn" and "9 day(s) old (max 7)" in rows[0][1] and "coop catalog snapshot" in rows[0][2], rows

    # Never production, even when the contract resolved one: nothing is minted and nothing runs.
    record_path.unlink()
    with resolved(environment="prod"), mock.patch.object(sq, "resolve_connection", side_effect=AssertionError("no mint for production")):
        out = cs.snapshot(cwd=root)
    assert out["state"] == "target_not_dev_or_test" and out["environment"] == "prod" and not record_path.exists(), out
    # Resolution and identity errors pass through untouched; the package's failure comes back as its state.
    with mock.patch.object(sq, "resolve_target", return_value=(None, sq.result("launch_identity_missing"))):
        assert cs.snapshot(cwd=root)["state"] == "launch_identity_missing"
    with resolved(), mock.patch.object(sq, "resolve_connection", return_value=("", "", sq.result("identity_mismatch"))):
        assert cs.snapshot(cwd=root)["state"] == "identity_mismatch" and not record_path.exists()
    failure = Path(tmp) / "failure.json"
    failure.write_text(json.dumps({"ok": False, "state": "query_failed"}), encoding="utf-8")
    with resolved(), connection, mock.patch.dict(os.environ, {"COOP_TEST_ANSWER": str(failure)}):
        out = cs.snapshot(cwd=root)
    assert out["state"] == "query_failed" and AZ_HOST not in json.dumps(out), out
    with resolved(), connection, mock.patch.dict(os.environ, {ct.TOOL_ENV: str(Path(tmp) / "missing")}):
        out = cs.snapshot(cwd=root)
    assert out["state"] == "tool_unavailable" and out["tool"] == "coop-schema-compare", out

    # The stdin contract routes to the same functions.
    with resolved(), connection:
        assert cs.execute({"command": "snapshot"}, cwd=root)["state"] == "ok"
    assert cs.execute({}, cwd=root)["state"] in ("ok", "stale")

# --- output folder choices and the refusal to overwrite a non-snapshot folder -------
with tempfile.TemporaryDirectory() as tmp:
    root = make_root(tmp, CONTRACT + "catalog:\n  path: catalog/dev-warehouse\n  max_age_days: 2\n")
    info = cs.status(cwd=root, now=TAKEN)
    assert info["path"] == "catalog/dev-warehouse" and info["chosen_by"] == "contract" and info["max_age_days"] == 2, info

    root2 = make_root(tmp + "/two", CONTRACT + "repositories:\n  docs:\n    role: data_docs\n    local_path: ../contoso-data-docs\n")
    info = cs.status(cwd=root2, now=TAKEN)
    assert info["chosen_by"] == "data_docs" and info["path"].endswith("contoso-data-docs/catalog/dev"), info

    root3 = make_root(tmp + "/three")
    busy = root3 / ".coop" / "catalog" / "dev"
    busy.mkdir(parents=True)
    (busy / "keep-me.txt").write_text("not a snapshot", encoding="utf-8")
    with mock.patch.object(sq, "resolve_target", side_effect=AssertionError("must refuse before resolving")):
        out = cs.snapshot(cwd=root3)
    assert out["state"] == "output_not_snapshot" and out["path"] == ".coop/catalog/dev" and (busy / "keep-me.txt").is_file(), out

    assert cs.status(cwd=Path(tmp) / "nowhere")["state"] == "project_unavailable"
    assert cs.doctor_lines(cwd=Path(tmp) / "nowhere") == []

print("catalog-snapshot tests passed")

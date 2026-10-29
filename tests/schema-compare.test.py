#!/usr/bin/env python3
"""Offline tests for lib/schema_compare.py and lib/compare_tool.py: coop's sides,
choices and identity handling over a stub `coop-schema-compare` (SQ10; suite
review 2026-10-26, pick 1: the compare engine is the pinned package)."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
import time
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
sc = load("schema_compare")

DEV_HOST = "contoso-dev.database.windows.net"
PROD_HOST = "contoso-prod.database.windows.net"
LAKE_HOST = "abc123-xyz.datawarehouse.fabric.microsoft.com"

# The stub stands in for the pinned package: it records its argv and the token it
# was handed (environment only), then answers with canned JSON after a stray log
# line, as a real run may print one before its result.
STUB = '''#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
record = os.environ.get("COOP_TEST_RECORD", "")
if record:
    Path(record).write_text(json.dumps({"argv": sys.argv[1:], "token": os.environ.get("SQL_ACCESS_TOKEN", ""), "pid": os.getpid()}), encoding="utf-8")
if sys.argv[1:2] == ["--version"]:
    print("coop-schema-compare 0.1.8")
    sys.exit(0)
answer = os.environ.get("COOP_TEST_ANSWER", "")
if answer == "garbage":
    print("no json here")
    sys.exit(3)
if answer == "hang":
    time.sleep(5)
    sys.exit(0)
if sys.argv[1] == "snapshot" and not answer:
    out = Path(sys.argv[sys.argv.index("--out") + 1])
    out.mkdir(parents=True, exist_ok=True)
    (out / "dbo").mkdir(exist_ok=True)
    (out / "dbo" / "Orders.sql").write_text("-- coop catalog snapshot: table dbo.Orders\\nCREATE TABLE [dbo].[Orders] (\\n    [OrderId] int NOT NULL\\n);\\n", encoding="utf-8")
    manifest = {"coop_catalog_snapshot": True, "schema_version": 1, "taken_at": "2026-10-26T16:00:00Z",
                "target": {"environment": "dev", "kind": "fabric_warehouse", "database": "ContosoDW"},
                "objects": {"tables": 2, "views": 1, "procedures": 0, "functions": 0}, "files": ["dbo/Orders.sql"],
                "truncated": {"schemas": False, "objects": False, "columns": True}, "unavailable": ["definitions (sys.sql_modules is not readable on this target)"],
                "skipped": ["dbo.bad;name"], "identity_columns": True}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\\n", encoding="utf-8")
    print(json.dumps({"ok": True, "state": "ok", "taken_at": "2026-10-26T16:00:00Z", "objects": manifest["objects"], "files": 1, "skipped": 1, "unavailable": manifest["unavailable"], "path": out.as_posix()}))
    sys.exit(0)
if answer:
    data = json.loads(Path(answer).read_text(encoding="utf-8"))
else:
    data = {"ok": True, "state": "ok", "complete": True, "taken_at": "2026-10-26T16:05:00Z", "path": "ignored",
            "source": {"environment": "live", "kind": "azure_sql", "database": "ContosoDW", "tables": 12, "views": 3, "procedures": 2, "functions": 1},
            "target": {"environment": "live", "kind": "azure_sql", "database": "ContosoDW", "tables": 11, "views": 3, "procedures": 2, "functions": 1},
            "counts": {"total": 2, "add": 1, "alter": 0, "drop": 1, "destructive": 1, "cosmetic": 0},
            "changes": [{"kind": "table", "schema": "dbo", "name": "NewTable", "action": "add", "detail": "3 column(s)", "destructive": False},
                        {"kind": "view", "schema": "dbo", "name": "vw_Old", "action": "drop", "detail": "", "destructive": True}],
            "script": {"objects": 2, "statements": 2, "commented": 0, "destructive": 1, "manual": 0, "batches": 4},
            "choices": ["package wording"], "notes": ["target: unavailable definitions"]}
print("stray log line before the result")
print(json.dumps(data))
sys.exit(0 if data.get("ok") else 1)
'''

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
    server: "contoso-prod.database.windows.net"
    database: ContosoDW
"""


def make_root(tmp: str, contract: str = CONTRACT) -> Path:
    root = Path(tmp) / "work" / "contoso"
    (root / ".coop").mkdir(parents=True)
    (root / ".coop" / "project.yml").write_text(contract, encoding="utf-8")
    return root


def target_for(environment: str, kind: str = "azure_sql", **extra):
    server = {"dev": DEV_HOST, "prod": PROD_HOST, "test": DEV_HOST}[environment.split("@")[0]]
    return sq.ResolvedTarget(kind, environment.split("@")[0], "ContosoDW", server=server, **extra)


def fake_resolve_target(*, cwd=None, environment=None):
    if environment is None:
        return target_for("dev"), None
    if environment.startswith("prod"):
        return target_for("prod", connect_timeout=60, read_only_intent=True), None
    if environment.startswith("dev"):
        return target_for("dev"), None
    return None, sq.result("target_invalid")


def fake_resolve_connection(target):
    return target.server, f"tok-{target.environment}", None


def _alive(pid: int) -> bool:
    """Whether a process still runs (a zombie awaiting its reaper counts as ended)."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    if not Path("/proc").is_dir():
        return True
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[-1].split()[0] != "Z"
    except (FileNotFoundError, ProcessLookupError):
        return False  # reaped between the signal probe and the read
    except (OSError, IndexError):
        return True


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


class Record:
    """The stub's record of its last call."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def clear(self) -> None:
        if self.path.exists():
            self.path.unlink()

    def read(self) -> dict | None:
        return json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else None


with tempfile.TemporaryDirectory() as tmp:
    stub = write_stub(Path(tmp) / "bin", STUB)
    record = Record(Path(tmp) / "record.json")
    os.environ[ct.TOOL_ENV] = str(stub)
    os.environ["COOP_TEST_RECORD"] = str(record.path)
    os.environ.pop("COOP_TEST_ANSWER", None)

    # --- compare_tool: finding and running the package --------------------------------
    assert ct.find_tool() == str(stub)
    with mock.patch.dict(os.environ, {ct.TOOL_ENV: str(Path(tmp) / "missing")}):
        assert ct.find_tool() == "", "an override that is not a file is not a tool"
        out = ct.run_tool(["compare", "a", "b"])
        assert out["state"] == "tool_unavailable" and out["tool"] == "coop-schema-compare" and not out["ok"], out
    with mock.patch.dict(os.environ, {ct.TOOL_ENV: ""}), mock.patch.object(ct.shutil, "which", return_value=None):
        pipx_bin = Path(tmp) / "pipx-bin"
        pipx_bin.mkdir()
        with mock.patch.object(ct, "_pipx_bin_dirs", return_value=[pipx_bin]):
            assert ct.find_tool() == "", "nothing on PATH and nothing in pipx's bin folder"
            (pipx_bin / "coop-schema-compare.exe").write_text("", encoding="utf-8")
            assert ct.find_tool() == str(pipx_bin / "coop-schema-compare.exe"), "pipx's bin folder is the fallback"
    assert ct.version() == "0.1.8"
    out = ct.run_tool(["compare", "a", "b"])
    assert out["ok"] and out["state"] == "ok" and out["counts"]["total"] == 2, out
    assert record.read()["argv"] == ["compare", "a", "b", "--json"], "always --json, last"
    with mock.patch.dict(os.environ, {"COOP_TEST_ANSWER": "garbage"}):
        out = ct.run_tool(["compare", "a", "b"])
        assert out["state"] == "tool_failed" and out["exit_code"] == 3 and not out["ok"], out
    failure = Path(tmp) / "failure.json"
    failure.write_text(json.dumps({"ok": False, "state": "connection_failed"}), encoding="utf-8")
    with mock.patch.dict(os.environ, {"COOP_TEST_ANSWER": str(failure)}):
        out = ct.run_tool(["compare", "a", "b"])
        assert out["state"] == "connection_failed" and out["ok"] is False, "the package's own state passes through"
    lying = Path(tmp) / "lying.json"
    lying.write_text(json.dumps({"ok": True, "state": "connection_failed"}), encoding="utf-8")
    with mock.patch.dict(os.environ, {"COOP_TEST_ANSWER": str(lying)}):
        assert ct.run_tool(["compare", "a", "b"])["ok"] is False, "ok means state ok, nothing else"
    with mock.patch.dict(os.environ, {"COOP_TEST_ANSWER": "hang"}), mock.patch.object(ct, "TIMEOUT_SECONDS", 1):
        out = ct.run_tool(["compare", "a", "b"])
        assert out["state"] == "tool_timeout" and not out["ok"], out
    if os.name == "posix":
        # #477: a termination of the helper ends the package it started, not only the helper.
        record.path.unlink()
        helper = subprocess.Popen(
            [sys.executable, "-c", "import sys; sys.path.insert(0, sys.argv[1]); import compare_tool; compare_tool.run_tool(['compare', 'a', 'b'])", str(ROOT / "lib")],
            env={**os.environ, "COOP_TEST_ANSWER": "hang"}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        for _ in range(100):
            if record.path.is_file() and record.path.read_text(encoding="utf-8"):
                break
            time.sleep(0.05)
        package_pid = record.read()["pid"]
        helper.send_signal(signal.SIGTERM)
        assert helper.wait(timeout=5) == 143, helper.returncode
        ended = False
        for _ in range(60):
            if not _alive(package_pid):
                ended = True
                break
            time.sleep(0.05)
        assert ended, "the package kept running after its helper was terminated"

    # --- input shape before anything resolves -------------------------------------------
    with mock.patch.object(sq, "resolve_target", side_effect=AssertionError("no resolution for bad input")):
        assert sc.execute({"source": "dev", "target": "prod", "extra": 1})["state"] == "input_invalid"
        assert sc.execute({"schemas": "dbo"})["state"] == "input_invalid"
        assert sc.execute({"schemas": ["dbo;drop"]})["state"] == "input_invalid"
        assert sc.execute({"commented": "yes"})["state"] == "input_invalid"
        assert sc.execute("dev")["state"] == "input_invalid"
    assert sc.valid_side("dev") and sc.valid_side("prod@lakehouse") and sc.valid_side("snapshot") and sc.valid_side("repo:sql/procs")
    assert not sc.valid_side("snapshot", target=True) and not sc.valid_side("repo:../x") and not sc.valid_side("staging") and not sc.valid_side(3)
    assert sc.default_target_for("dev") == "prod" and sc.default_target_for("dev@lakehouse") == "prod@lakehouse"

    # --- settings, choices and the defaults hint (coop's, not the package's) ----------
    saved, bad = sc._settings({})
    assert saved == {"schemas": [], "exclude": [], "rebuild": [], "commented": False} and bad == ""
    assert sc._settings({"schema_compare": "no"}) == (None, "schema_compare")
    assert sc._settings({"schema_compare": {"exclude_schemas": "staging"}}) == (None, "schema_compare.exclude_schemas")
    assert sc._settings({"schema_compare": {"destructive": "maybe"}}) == (None, "schema_compare.destructive")
    saved, _ = sc._settings({"schema_compare": {"exclude_schemas": ["staging"], "rebuild_tables_in": ["stg"], "destructive": "commented"}})
    keep, drop, rebuild, commented, words = sc._choices({"exclude": ["Audit", "staging"]}, saved)
    assert keep == [] and drop == ["staging", "Audit"] and rebuild == ["stg"] and commented is True, (keep, drop, rebuild, commented)
    assert any("staging (project file)" in w and "Audit (this run)" in w for w in words), words
    assert any("stg" in w and "(project file)" in w for w in words) and any("commented out (project file)" in w for w in words), words
    keep, drop, _r, _c, words = sc._choices({"schemas": ["staging"], "rebuild": []}, saved)
    assert keep == ["staging"] and drop == [], "a schema the run names is never left out by the file's exclude list"
    assert any("only schemas staging compared (this run)" in w for w in words), words
    hint = sc._defaults_hint({"exclude": ["Audit"], "commented": False}, saved)
    assert "exclude_schemas: [audit]" in hint and "destructive: runnable" in hint and "/setup-project" in hint, hint
    assert sc._defaults_hint({"exclude": ["staging"]}, saved) == "", "a run that repeats the file's choices needs no hint"

    root = make_root(tmp)
    with mock.patch.object(sq, "resolve_target", side_effect=fake_resolve_target), mock.patch.object(sq, "resolve_connection", side_effect=fake_resolve_connection):
        # --- dev -> prod: what the package is told, and what coop answers --------------
        record.clear()
        out = sc.compare({}, cwd=root)
        assert out["ok"] and out["state"] == "ok", out
        call = record.read()
        folder = (root / ".coop" / "schema-compare" / "dev-to-prod").resolve()
        assert call["argv"] == [
            "compare", f"{DEV_HOST}/ContosoDW", f"{PROD_HOST}/ContosoDW",
            "--out", str(folder), "--source-environment", "dev", "--target-environment", "prod",
            "--destructive", "runnable", "--exclude-schema", "sqlsc",
            "--connect-timeout", "60", "--read-only-intent", "--target-kind", "azure_sql", "--json",
        ], call["argv"]
        assert call["token"] == "tok-dev" and "tok-" not in " ".join(call["argv"]), "the token travels in the environment only"
        assert out["path"] == ".coop/schema-compare/dev-to-prod" and out["taken_at"] == "2026-10-26T16:05:00Z"
        assert out["source"] == {"environment": "dev", "kind": "azure_sql", "database": "ContosoDW", "tables": 12, "views": 3, "procedures": 2, "functions": 1}, out["source"]
        assert out["target"]["environment"] == "prod" and out["target"]["tables"] == 11
        assert out["counts"]["total"] == 2 and out["counts"]["destructive"] == 1 and len(out["changes"]) == 2 and out["changes_truncated"] is False
        assert out["script"]["statements"] == 2 and out["complete"] is True
        assert out["choices"] == ["changed tables: ALTER where the target allows it, a manual rebuild note where it does not (default)", "destructive statements: active, marked DESTRUCTIVE (default)"], out["choices"]
        assert out["notes"] == ["schema sqlsc (SQL source control's locks) is left out of the compare", "target: unavailable definitions"], out["notes"]
        text = json.dumps(out)
        assert DEV_HOST not in text and PROD_HOST not in text and "tok-" not in text, "no host and no token in a result"

        # A package answer that is not whole: complete false and the first 200 changes.
        big = Path(tmp) / "big.json"
        big.write_text(json.dumps({"ok": True, "state": "ok", "complete": False, "taken_at": "t", "counts": {"total": 250}, "changes": [{"kind": "table", "schema": "s", "name": f"t{i}", "action": "add"} for i in range(250)], "script": {}, "notes": [], "source": {}, "target": {}}), encoding="utf-8")
        with mock.patch.dict(os.environ, {"COOP_TEST_ANSWER": str(big)}):
            out = sc.compare({}, cwd=root)
        assert out["ok"] and out["complete"] is False and len(out["changes"]) == 200 and out["changes_truncated"] is True and out["source"]["tables"] == 0, out["counts"]

        # The package's failure comes back as its state; coop's own layer states carry the tool's name.
        with mock.patch.dict(os.environ, {"COOP_TEST_ANSWER": str(failure)}):
            out = sc.compare({}, cwd=root)
        assert out["state"] == "connection_failed" and not out["ok"] and "tool" not in out, out
        with mock.patch.dict(os.environ, {ct.TOOL_ENV: str(Path(tmp) / "missing")}):
            out = sc.compare({}, cwd=root)
        assert out["state"] == "tool_unavailable" and out["tool"] == "coop-schema-compare", out

        # --- choices from the project file and the run ------------------------------------
        root2 = make_root(tmp + "/two", CONTRACT + "schema_compare:\n  exclude_schemas: [staging]\n  rebuild_tables_in: [stg]\n  destructive: commented\n")
        record.clear()
        out = sc.compare({"exclude": ["Audit"], "source": "prod", "target": "dev"}, cwd=root2)
        argv = record.read()["argv"]
        assert argv[1] == f"{PROD_HOST}/ContosoDW" and argv[2] == f"{DEV_HOST}/ContosoDW", "any direction"
        assert argv[argv.index("--destructive") + 1] == "commented"
        excluded = [argv[i + 1] for i, a in enumerate(argv) if a == "--exclude-schema"]
        assert excluded == ["staging", "Audit", "sqlsc"], excluded
        assert argv[argv.index("--rebuild-tables-in") + 1] == "stg" and "--read-only-intent" in argv and argv[argv.index("--connect-timeout") + 1] == "60"
        assert out["path"] == ".coop/schema-compare/prod-to-dev"
        assert out["notes"][0].startswith("this run's choices are not the project file's") and "exclude_schemas: [audit]" in out["notes"][0], out["notes"]
        # Naming sqlsc keeps it in the compare, without the note.
        record.clear()
        out = sc.compare({"schemas": ["sqlsc", "dbo"]}, cwd=root2)
        argv = record.read()["argv"]
        assert [argv[i + 1] for i, a in enumerate(argv) if a == "--schema"] == ["sqlsc", "dbo"] and "sqlsc" not in [argv[i + 1] for i, a in enumerate(argv) if a == "--exclude-schema"]
        assert not any("sqlsc" in n for n in out["notes"] if "locks" in n), out["notes"]
        assert sc.compare({"source": "dev", "target": "dev"}, cwd=root2)["state"] == "input_invalid", "the same side twice"
        root3 = make_root(tmp + "/three", CONTRACT + "schema_compare:\n  destructive: maybe\n")
        out = sc.compare({}, cwd=root3)
        assert out["state"] == "setting_invalid" and out["setting"] == "schema_compare.destructive", out

        # --- a target the package cannot name a kind for: no --target-kind -------------------
        with mock.patch.object(sq, "resolve_target", side_effect=lambda *, cwd=None, environment=None: (target_for(environment or "dev", "fabric_sql_database"), None)):
            record.clear()
            assert sc.compare({"source": "dev", "target": "test"}, cwd=root)["ok"]
            argv = record.read()["argv"]
            assert "--target-kind" not in argv and "--read-only-intent" not in argv and argv[argv.index("--connect-timeout") + 1] == "15", argv

        # --- the committed snapshot as the source ------------------------------------------
        record.clear()
        out = sc.compare({"source": "snapshot"}, cwd=root)
        assert out["state"] == "snapshot_missing" and out["side"] == "snapshot" and record.read() is None, "checked before the package runs"
        snap = root / ".coop" / "catalog" / "dev"
        snap.mkdir(parents=True)
        (snap / "manifest.json").write_text(json.dumps({"coop_catalog_snapshot": True, "taken_at": "2026-10-20T08:00:00Z", "target": {"environment": "dev", "kind": "fabric_lakehouse", "database": "ContosoDW"}, "objects": {}, "files": []}), encoding="utf-8")
        record.clear()
        out = sc.compare({"source": "snapshot"}, cwd=root)
        assert out["ok"], out
        argv = record.read()["argv"]
        assert argv[1] == str(snap.resolve()) and argv[2] == f"{PROD_HOST}/ContosoDW" and argv[argv.index("--source-environment") + 1] == "snapshot"
        assert out["source"]["taken_at"] == "2026-10-20T08:00:00Z" and out["source"]["kind"] == "fabric_lakehouse" and out["path"] == ".coop/schema-compare/snapshot-to-prod"
        assert record.read()["token"] == "tok-prod", "the live side's token, even when the other side is a folder"

        # --- a repo side: the contract repository's .sql files, read by the package -------
        repo_contract = CONTRACT + "repositories:\n  sql:\n    role: sql\n    local_path: ../contoso-sql\n    sql_root: database\n"
        root4 = make_root(tmp + "/four", repo_contract)
        out = sc.compare({"source": "repo"}, cwd=root4)
        assert out["state"] == "repo_unavailable" and out["side"] == "repo", out
        sql_dir = root4.parent / "contoso-sql" / "database"
        (sql_dir / "procs").mkdir(parents=True)
        record.clear()
        out = sc.compare({"source": "repo"}, cwd=root4)
        assert out["ok"], out
        argv = record.read()["argv"]
        assert argv[1] == str(sql_dir.resolve()) and argv[2] == f"{PROD_HOST}/ContosoDW", argv
        assert out["source"] == {"environment": "repo", "kind": "sql source", "database": "sql", "tables": 12, "views": 3, "procedures": 2, "functions": 1}
        assert out["path"] == ".coop/schema-compare/repo-to-prod"
        record.clear()
        out = sc.compare({"source": "repo:sql/database/procs", "target": "repo:sql"}, cwd=root4)  # a subfolder is relative to the repository root
        argv = record.read()["argv"]
        assert out["ok"] and argv[1] == str((sql_dir / "procs").resolve()) and argv[2] == str(sql_dir.resolve())
        assert "--connect-timeout" not in argv and "--target-kind" not in argv and record.read()["token"] == "", "two folders: no identity, no token"
        assert out["path"] == ".coop/schema-compare/repo-sql-database-procs-to-repo-sql" and out["target"]["database"] == "sql"
        assert sc.compare({"source": "repo:other"}, cwd=root4)["state"] == "repo_missing"
        assert sc.compare({"source": "repo:sql/../.."}, cwd=root4)["state"] == "input_invalid"
        assert sc.compare({"source": "repo"}, cwd=root)["state"] == "repo_missing", "no sql repository in the contract"
        root5 = make_root(tmp + "/five", repo_contract + "  more:\n    role: mixed\n    local_path: ../more\n")
        assert sc.compare({"source": "repo"}, cwd=root5)["state"] == "repo_ambiguous"

        # --- named target sets: dev@lakehouse compares with prod@lakehouse -----------------
        record.clear()
        out = sc.compare({"source": "dev@lakehouse"}, cwd=root)
        assert out["ok"] and out["source"]["set"] == "lakehouse" and out["target"]["set"] == "lakehouse", out["target"]
        assert out["path"] == ".coop/schema-compare/dev-lakehouse-to-prod-lakehouse"
        argv = record.read()["argv"]
        assert argv[argv.index("--source-environment") + 1] == "dev@lakehouse" and argv[argv.index("--target-environment") + 1] == "prod@lakehouse"

        # --- a side the contract cannot resolve, named in the answer ------------------------
        out = sc.compare({"source": "test"}, cwd=root)
        assert out["state"] == "target_invalid" and out["side"] == "test", out
        with mock.patch.object(sq, "resolve_connection", return_value=("", "", sq.result("identity_mismatch"))):
            record.clear()
            out = sc.compare({}, cwd=root)
            assert out["state"] == "identity_mismatch" and out["side"] == "dev" and record.read() is None, "nothing runs without the pinned identity"

        # --- the CLI entry point (bin/coop.ps1 passes --cli and the flags) -------------------
        stream = io.StringIO()
        cwd = os.getcwd()
        os.chdir(root)
        try:
            with contextlib.redirect_stdout(stream):
                rc = sc.main(["--cli", "--source", "dev", "--target", "prod", "--exclude-schema", "Audit", "--destructive", "commented"])
        finally:
            os.chdir(cwd)
        printed = json.loads(stream.getvalue())
        assert rc == 0 and printed["ok"] and printed["path"] == ".coop/schema-compare/dev-to-prod", printed
        argv = record.read()["argv"]
        assert argv[argv.index("--destructive") + 1] == "commented" and "Audit" in argv, argv

    assert sc.compare({}, cwd=Path(tmp) / "nowhere")["state"] == "project_unavailable"

print("schema-compare tests passed")

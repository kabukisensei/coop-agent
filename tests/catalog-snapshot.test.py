#!/usr/bin/env python3
"""Offline tests for lib/catalog_snapshot.py: the committed dev catalog snapshot (SQ9)."""

from __future__ import annotations

import importlib.util
import json
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
cs = load("catalog_snapshot")

AZ_HOST = "contoso-dev.database.windows.net"
NOW = datetime(2026, 10, 5, 22, 0, tzinfo=timezone.utc)


class FakeCursor:
    def __init__(self, answers, failing=()):
        self.answers = answers
        self.failing = set(failing)
        self.calls: list[str] = []
        self.pending: list = []

    def execute(self, sql, params=None):
        assert params == (), "catalog queries are fixed text with no parameters"
        self.calls.append(sql)
        if sql in self.failing:
            raise RuntimeError("Invalid object name 'sys.sql_modules' on " + AZ_HOST)
        self.pending = list(self.answers.get(sql, []))

    def fetchone(self):
        return self.pending.pop(0) if self.pending else None


class FakeConnection:
    def __init__(self, cursor):
        self.timeout = None
        self._cursor = cursor
        self.closed = False

    def cursor(self):
        return self._cursor

    def close(self):
        self.closed = True


def target(kind="azure_sql", environment="dev"):
    return sq.ResolvedTarget(kind, environment, "ContosoDW", server=AZ_HOST if kind == "azure_sql" else "")


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

ANSWERS = {
    cs.OBJECTS_SQL: [
        ("dbo", "Orders", "U"),
        ("dbo", "vw_Sales", "V"),
        ("dbo", "usp_Refresh", "P"),
        ("fin", "fn_Rate", "FN"),
        ("dbo", "vw_NoDefinition", "V"),
        ("dbo", "bad;name", "U"),
    ],
    cs.COLUMNS_SQL: [
        ("dbo", "Orders", "OrderId", "int", None, 10, 0, None, "NO", 1),
        ("dbo", "Orders", "Customer", "nvarchar", 100, None, None, None, "YES", 2),
        ("dbo", "Orders", "Notes", "nvarchar", -1, None, None, None, "YES", 3),
        ("dbo", "Orders", "Amount", "decimal", None, 18, 2, None, "NO", 4),
        ("dbo", "Orders", "Placed", "datetime2", None, None, None, 7, "NO", 5),
        ("dbo", "vw_NoDefinition", "Total", "money", None, 19, 4, None, "YES", 1),
    ],
    cs.MODULES_SQL: [
        ("dbo", "vw_Sales", "CREATE VIEW dbo.vw_Sales AS SELECT OrderId, Amount FROM dbo.Orders"),
        ("dbo", "usp_Refresh", "CREATE PROCEDURE dbo.usp_Refresh AS SELECT 1"),
        ("fin", "fn_Rate", "CREATE FUNCTION fin.fn_Rate() RETURNS int AS BEGIN RETURN 1 END"),
    ],
}


def make_root(tmp: str, contract: str = CONTRACT) -> Path:
    root = Path(tmp) / "work" / "contoso"
    (root / ".coop").mkdir(parents=True)
    (root / ".coop" / "project.yml").write_text(contract, encoding="utf-8")
    return root


# --- type rendering --------------------------------------------------------------
assert cs.render_type("nvarchar", -1, None, None, None) == "nvarchar(max)"
assert cs.render_type("varchar", 50, None, None, None) == "varchar(50)"
assert cs.render_type("decimal", None, 18, 2, None) == "decimal(18, 2)"
assert cs.render_type("datetime2", None, None, None, 3) == "datetime2(3)"
assert cs.render_type("int", None, 10, 0, None) == "int"

# --- input shape for the stdin contract -----------------------------------------
with mock.patch.object(sq, "open_connection", side_effect=AssertionError("no connection for bad input")):
    assert cs.execute({"command": "snapshot", "object": "x"})["state"] == "input_invalid"
    assert cs.execute({"command": "drop"})["state"] == "input_invalid"
    assert cs.execute("snapshot")["state"] == "input_invalid"

with tempfile.TemporaryDirectory() as tmp:
    root = make_root(tmp)

    # Status before any snapshot: missing, default folder beside the contract.
    info = cs.status(cwd=root, now=NOW)
    assert info["state"] == "missing" and info["ok"] is False, info
    assert info["path"] == ".coop/catalog/dev" and info["chosen_by"] == "default" and info["max_age_days"] == 7, info
    rows = cs.doctor_lines(cwd=root)
    assert rows and rows[0][0] == "warn" and "no catalog snapshot under .coop/catalog/dev" in rows[0][1], rows

    # Snapshot: one file per object, synthesized tables, definitions as held, manifest + README.
    cursor = FakeCursor(ANSWERS)
    connection = FakeConnection(cursor)
    with mock.patch.object(sq, "open_connection", return_value=(connection, target(), "ODBC Driver 18 for SQL Server", None)):
        out = cs.snapshot(cwd=root, now=NOW)
    assert out["ok"] and out["state"] == "ok", out
    assert out["objects"] == {"tables": 1, "views": 2, "procedures": 1, "functions": 1}, out
    assert out["files"] == 5 and out["skipped"] == 1 and out["path"] == ".coop/catalog/dev", out
    assert connection.closed
    assert cursor.calls == [cs.OBJECTS_SQL, cs.COLUMNS_SQL, cs.MODULES_SQL]
    folder = root / ".coop" / "catalog" / "dev"
    table_sql = (folder / "dbo" / "Orders.sql").read_text(encoding="utf-8")
    assert "CREATE TABLE [dbo].[Orders] (" in table_sql, table_sql
    assert "[OrderId] int NOT NULL" in table_sql and "[Customer] nvarchar(100) NULL" in table_sql, table_sql
    assert "[Notes] nvarchar(max) NULL" in table_sql and "[Amount] decimal(18, 2) NOT NULL" in table_sql and "[Placed] datetime2(7) NOT NULL" in table_sql, table_sql
    assert "taken 2026-10-05T22:00:00Z" in table_sql and "Never deploy from this file" in table_sql
    view_sql = (folder / "dbo" / "vw_Sales.sql").read_text(encoding="utf-8")
    assert view_sql.endswith("CREATE VIEW dbo.vw_Sales AS SELECT OrderId, Amount FROM dbo.Orders\n"), view_sql
    assert (folder / "fin" / "fn_Rate.sql").is_file() and (folder / "dbo" / "usp_Refresh.sql").is_file()
    stub = (folder / "dbo" / "vw_NoDefinition.sql").read_text(encoding="utf-8")
    assert "definition not readable" in stub and "[Total] money NULL" in stub, stub
    assert not (folder / "dbo" / "bad;name.sql").exists()
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["coop_catalog_snapshot"] is True and manifest["taken_at"] == "2026-10-05T22:00:00Z"
    assert manifest["target"] == {"environment": "dev", "kind": "azure_sql", "database": "ContosoDW"}
    assert manifest["files"] == ["dbo/Orders.sql", "dbo/usp_Refresh.sql", "dbo/vw_NoDefinition.sql", "dbo/vw_Sales.sql", "fin/fn_Rate.sql"], manifest["files"]
    assert manifest["skipped"] == ["dbo.bad;name"]
    readme = (folder / "README.md").read_text(encoding="utf-8")
    assert "never a deployment artifact" in readme
    # No host, no connection string, no token anywhere in the folder.
    for file in folder.rglob("*"):
        if file.is_file():
            text = file.read_text(encoding="utf-8")
            assert AZ_HOST not in text and "DRIVER=" not in text and "SERVER=" not in text, file

    # Status after: fresh; stale once older than max_age_days; doctor rows follow.
    info = cs.status(cwd=root, now=NOW + timedelta(days=2))
    assert info["state"] == "ok" and info["age_days"] == 2.0 and info["objects"]["views"] == 2, info
    rows = cs.doctor_lines(cwd=root)
    assert rows[0][0] == "ok" and "1 tables, 2 views, 1 procedures, 1 functions" in rows[0][1], rows
    info = cs.status(cwd=root, now=NOW + timedelta(days=8))
    assert info["state"] == "stale" and info["age_days"] == 8.0, info
    with mock.patch.object(cs, "datetime", wraps=datetime) as fake_dt:
        fake_dt.now.return_value = NOW + timedelta(days=9)
        rows = cs.doctor_lines(cwd=root)
    assert rows[0][0] == "warn" and "9 day(s) old (max 7)" in rows[0][1] and "coop catalog snapshot" in rows[0][2], rows

    # A second snapshot replaces the folder's files: a dropped object's file goes away.
    fewer = {key: list(value) for key, value in ANSWERS.items()}
    fewer[cs.OBJECTS_SQL] = [row for row in ANSWERS[cs.OBJECTS_SQL] if row[1] != "fn_Rate"]
    with mock.patch.object(sq, "open_connection", return_value=(FakeConnection(FakeCursor(fewer)), target(), "d", None)):
        out = cs.snapshot(cwd=root, now=NOW + timedelta(days=9))
    assert out["ok"] and out["objects"]["functions"] == 0, out
    assert not (folder / "fin").exists(), "the empty schema folder of a dropped function is removed"
    assert (folder / "dbo" / "Orders.sql").is_file()

    # Definitions unavailable (a Lakehouse SQL endpoint): tables still land, the manifest says so.
    with mock.patch.object(sq, "open_connection", return_value=(FakeConnection(FakeCursor(ANSWERS, failing=[cs.MODULES_SQL])), target("fabric_lakehouse"), "d", None)):
        out = cs.snapshot(cwd=root, now=NOW)
    assert out["ok"] and out["objects"]["tables"] == 1 and out["objects"]["procedures"] == 0, out
    assert out["unavailable"] and "sys.sql_modules" in out["unavailable"][0], out
    assert AZ_HOST not in json.dumps(out)

    # Never production, even if a connection resolved one; executor errors pass through.
    with mock.patch.object(sq, "open_connection", return_value=(FakeConnection(FakeCursor(ANSWERS)), target(environment="prod"), "d", None)):
        assert cs.snapshot(cwd=root, now=NOW)["state"] == "target_not_dev_or_test"
    with mock.patch.object(sq, "open_connection", return_value=(None, None, "", sq.result("pyodbc_unavailable"))):
        assert cs.snapshot(cwd=root, now=NOW)["state"] == "pyodbc_unavailable"
    with mock.patch.object(sq, "open_connection", return_value=(FakeConnection(FakeCursor(ANSWERS, failing=[cs.OBJECTS_SQL])), target(), "d", None)):
        out = cs.snapshot(cwd=root, now=NOW)
    assert out["state"] == "query_failed" and out["stage"] == "objects" and AZ_HOST not in json.dumps(out), out

    # The stdin contract routes to the same functions.
    with mock.patch.object(sq, "open_connection", return_value=(FakeConnection(FakeCursor(ANSWERS)), target(), "d", None)):
        assert cs.execute({"command": "snapshot"}, cwd=root)["state"] == "ok"
    assert cs.execute({}, cwd=root)["state"] in ("ok", "stale")

# --- output folder choices and the refusal to overwrite a non-snapshot folder -------
with tempfile.TemporaryDirectory() as tmp:
    root = make_root(tmp, CONTRACT + "catalog:\n  path: catalog/dev-warehouse\n  max_age_days: 2\n")
    info = cs.status(cwd=root, now=NOW)
    assert info["path"] == "catalog/dev-warehouse" and info["chosen_by"] == "contract" and info["max_age_days"] == 2, info

    root2 = make_root(tmp + "/two", CONTRACT + "repositories:\n  docs:\n    role: data_docs\n    local_path: ../contoso-data-docs\n")
    info = cs.status(cwd=root2, now=NOW)
    assert info["chosen_by"] == "data_docs" and info["path"].endswith("contoso-data-docs/catalog/dev"), info

    root3 = make_root(tmp + "/three")
    busy = root3 / ".coop" / "catalog" / "dev"
    busy.mkdir(parents=True)
    (busy / "keep-me.txt").write_text("not a snapshot", encoding="utf-8")
    with mock.patch.object(sq, "open_connection", side_effect=AssertionError("must refuse before connecting")):
        out = cs.snapshot(cwd=root3, now=NOW)
    assert out["state"] == "output_not_snapshot" and (busy / "keep-me.txt").is_file(), out

    assert cs.status(cwd=Path(tmp) / "nowhere")["state"] == "project_unavailable"
    assert cs.doctor_lines(cwd=Path(tmp) / "nowhere") == []

print("catalog-snapshot tests passed")

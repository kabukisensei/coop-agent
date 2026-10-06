#!/usr/bin/env python3
"""Offline tests for lib/sql_impact.py: fixed parameterized catalog queries (SQ4)."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
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
si = load("sql_impact")

TENANT = "11111111-1111-4111-8111-111111111111"
PRINCIPAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
AZ_HOST = "contoso-dev.database.windows.net"


def jwt(audience: str) -> str:
    import base64

    def enc(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return f"{enc({'alg': 'none'})}.{enc({'tid': TENANT, 'oid': PRINCIPAL, 'aud': audience})}.sig"


FABRIC_TOKEN = jwt("fabric")
SQL_TOKEN = jwt("sql")

# --- object names: identifier only, schema optional, brackets allowed -------------
assert si.parse_object_name("dbo.vw_Sales") == ("dbo", "vw_Sales")
assert si.parse_object_name("vw_Sales") == ("dbo", "vw_Sales")
assert si.parse_object_name("[finance].[Ledger Transactions]") is None, "spaces need quoting the catalog cannot bind safely"
assert si.parse_object_name("[finance].[Ledger_Transactions]") == ("finance", "Ledger_Transactions")
assert si.parse_object_name("  sales.Orders  ") == ("sales", "Orders")
for bad in ("", "a.b.c", "dbo.vw;DROP", "dbo.'x'", 'dbo."x"', "dbo.x--", "OtherDb.dbo.x", None, 5, "x" * 129):
    assert si.parse_object_name(bad) is None, bad
assert si._like_pattern("a_b%c[d]") == "%a\\_b\\%c\\[d]%"

# --- input shape: exactly {object}, before any target or connection work -----------
with mock.patch.object(sq, "open_connection", side_effect=AssertionError("no connection for bad input")):
    assert si.execute({"object": "dbo.x", "query": "SELECT 1"})["state"] == "input_invalid"
    assert si.execute({"object": "dbo.x; DROP TABLE y"})["state"] == "object_invalid"
    assert si.execute("dbo.x")["state"] == "input_invalid"


class FakeCursor:
    """Answers each fixed query from a table keyed by its SQL text; records bound params."""

    def __init__(self, answers, failing=()):
        self.answers = answers
        self.failing = set(failing)
        self.calls: list[tuple[str, tuple]] = []
        self.pending: list = []

    def execute(self, sql, params=None):
        assert params is not None and isinstance(params, tuple), "every catalog query binds its parameters"
        assert "'" not in "".join(str(p) for p in params) or sql is si.MODULE_MENTION_SQL
        self.calls.append((sql, params))
        if sql in self.failing:
            raise RuntimeError("Invalid object name 'sys.dm_sql_referencing_entities' " + str(params))
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


# --- happy path on Azure SQL: three sections, bound names, no host in the output ----
answers = {
    si.RESOLVE_SQL: [("dbo", "vw_Sales", "VIEW")],
    si.DOWNSTREAM_SQL: [("rpt", "vw_SalesByRegion", "VIEW"), ("dbo", "usp_Refresh", "SQL_STORED_PROCEDURE")],
    si.UPSTREAM_SQL: [
        ("dbo", "Orders", None, None, False, 101, "USER_TABLE"),
        ("dbo", "Dropped_Table", None, None, False, None, None),
        (None, "CrossDbView", "OtherDb", None, True, None, None),
    ],
    si.MODULE_MENTION_SQL: [(1,)],
    si.COLUMN_REFERENCES_SQL: [("amount",), ("region",)],
    si.COLUMNS_SQL: [("region", "nvarchar", "NO", 1), ("amount", "decimal", "YES", 2)],
}
cursor = FakeCursor(answers)
connection = FakeConnection(cursor)
with mock.patch.object(sq, "open_connection", return_value=(connection, target(), "ODBC Driver 18 for SQL Server", None)):
    out = si.execute({"object": "vw_Sales"})
assert out["ok"] and out["state"] == "ok", out
assert out["target"] == {"environment": "dev", "kind": "azure_sql", "database": "ContosoDW"}
assert out["object"] == {"schema": "dbo", "name": "vw_Sales", "type": "VIEW"}
assert out["downstream"]["state"] == "ok" and out["downstream"]["count"] == 2
assert out["downstream"]["items"][0] == {"schema": "rpt", "name": "vw_SalesByRegion", "type": "VIEW", "columns": ["amount", "region"]}
# SQ8: each dependent names the columns of this object it reads, from one bound
# query per dependent (the dependent first, this object second).
assert out["downstream"]["column_references"] == "ok"
assert out["downstream"]["items"][1]["columns"] == ["amount", "region"]
# #285: a successful dependents query says what it could see, so zero rows never
# read as zero impact; upstream and columns carry no such caveat.
assert out["downstream"]["coverage"] == si.DOWNSTREAM_COVERAGE and "this principal can read" in out["downstream"]["coverage"]
assert "coverage" not in out["upstream"] and "coverage" not in out["columns"]
with mock.patch.object(sq, "open_connection", return_value=(FakeConnection(FakeCursor({**answers, si.DOWNSTREAM_SQL: []})), target(), "ODBC Driver 18 for SQL Server", None)):
    empty = si.execute({"object": "vw_Sales"})
assert empty["downstream"]["state"] == "ok" and empty["downstream"]["count"] == 0 and empty["downstream"]["coverage"] == si.DOWNSTREAM_COVERAGE
assert empty["downstream"]["column_references"] == "none"
# A target without sys.dm_sql_referenced_entities: the dependents stay, none carries
# `columns`, and the section says the column level was unavailable.
no_refs = FakeCursor(answers, failing={si.COLUMN_REFERENCES_SQL})
with mock.patch.object(sq, "open_connection", return_value=(FakeConnection(no_refs), target(), "d", None)):
    without = si.execute({"object": "vw_Sales"})
assert without["downstream"]["column_references"] == "unavailable" and without["downstream"]["count"] == 2
assert all("columns" not in item for item in without["downstream"]["items"])
assert "Invalid object name" not in json.dumps(without)
up = out["upstream"]["items"]
assert up[0] == {"schema": "dbo", "name": "Orders", "type": "USER_TABLE", "resolved": True}
assert up[1]["resolved"] is False and up[1]["mentioned_in_definition"] is True and up[1]["type"] == "unknown"
assert up[2]["database"] == "OtherDb" and up[2]["resolved"] is False
assert out["columns"]["items"] == [
    {"name": "region", "type": "nvarchar", "nullable": False, "position": 1},
    {"name": "amount", "type": "decimal", "nullable": True, "position": 2},
]
assert connection.closed and connection.timeout == sq.QUERY_TIMEOUT
sqls = [c[0] for c in cursor.calls]
assert sqls[:2] == [si.RESOLVE_SQL, si.DOWNSTREAM_SQL] and si.UPSTREAM_SQL in sqls and si.COLUMNS_SQL in sqls
assert cursor.calls[0][1] == ("[dbo].[vw_Sales]",), "the name is a bound parameter, bracketed"
assert cursor.calls[1][1] == ("[dbo].[vw_Sales]",)
mention_calls = [c for c in cursor.calls if c[0] is si.MODULE_MENTION_SQL]
assert len(mention_calls) == 2 and mention_calls[0][1] == ("[dbo].[vw_Sales]", "%Dropped\\_Table%")
assert [c for c in cursor.calls if c[0] is si.COLUMNS_SQL][0][1] == ("dbo", "vw_Sales")
reference_calls = [c[1] for c in cursor.calls if c[0] is si.COLUMN_REFERENCES_SQL]
assert reference_calls == [("[rpt].[vw_SalesByRegion]", "[dbo].[vw_Sales]"), ("[dbo].[usp_Refresh]", "[dbo].[vw_Sales]")]
blob = json.dumps(out)
assert AZ_HOST not in blob and "ODBC Driver" not in blob

# --- Fabric Warehouse: no referencing DMV, dependents come from the dependency rows -
fabric_answers = dict(answers)
fabric_answers[si.DOWNSTREAM_CATALOG_SQL] = [("finance", "ForecastVersion", "VIEW")]
fabric = FakeCursor(fabric_answers, failing={si.DOWNSTREAM_SQL})
with mock.patch.object(sq, "open_connection", return_value=(FakeConnection(fabric), target("fabric_warehouse"), "d", None)):
    out = si.execute({"object": "dbo.vw_Sales"})
assert out["downstream"]["state"] == "ok", out["downstream"]
assert out["downstream"]["items"] == [{"schema": "finance", "name": "ForecastVersion", "type": "VIEW", "columns": ["amount", "region"]}]
fallback = [c for c in fabric.calls if c[0] is si.DOWNSTREAM_CATALOG_SQL]
assert fallback and fallback[0][1] == ("[dbo].[vw_Sales]",), "the fallback binds the name too"
assert out["upstream"]["state"] == "ok" and out["columns"]["state"] == "ok"

# --- a missing catalog view is "unavailable", never an empty list ------------------
failing = FakeCursor(answers, failing={si.DOWNSTREAM_SQL, si.DOWNSTREAM_CATALOG_SQL, si.COLUMNS_SQL})
with mock.patch.object(sq, "open_connection", return_value=(FakeConnection(failing), target("fabric_warehouse", "test"), "d", None)):
    out = si.execute({"object": "dbo.vw_Sales"})
assert out["ok"] and out["downstream"]["state"] == "unavailable" and out["downstream"]["items"] == []
assert "fabric_warehouse" in out["downstream"]["reason"] and "could not be looked up" in out["downstream"]["reason"]
assert out["columns"]["state"] == "unavailable" and out["upstream"]["state"] == "ok"
assert "Invalid object name" not in json.dumps(out), "driver error text never leaks"

# --- Synapse serverless: dependents are known to be untraceable, said up front ------
synapse = FakeCursor(answers)
with mock.patch.object(sq, "open_connection", return_value=(FakeConnection(synapse), target("synapse_serverless"), "d", None)):
    out = si.execute({"object": "dbo.vw_Sales"})
assert out["downstream"]["state"] == "unavailable" and "Synapse serverless" in out["downstream"]["reason"]
assert si.DOWNSTREAM_SQL not in [c[0] for c in synapse.calls], "no query for a view the kind lacks"
assert out["upstream"]["state"] == "ok" and out["columns"]["state"] == "ok"

# --- unknown object, and the executor's own failures pass through unchanged --------
with mock.patch.object(sq, "open_connection", return_value=(FakeConnection(FakeCursor({})), target(), "d", None)):
    out = si.execute({"object": "dbo.Nope"})
assert out == {"ok": False, "state": "object_not_found", "target": {"environment": "dev", "kind": "azure_sql", "database": "ContosoDW"}}
for error in (sq.result("target_invalid"), sq.result("identity_mismatch"), sq.result("auth_required", stage="database_token")):
    with mock.patch.object(sq, "open_connection", return_value=(None, None, "", error)):
        assert si.execute({"object": "dbo.x"}) == error

# --- end to end through open_connection: the contract target, no Fabric mint --------
with tempfile.TemporaryDirectory() as td:
    project = Path(td) / "project"
    (project / ".coop").mkdir(parents=True)
    (project / ".coop" / "project.yml").write_text(
        f"sql_targets:\n  default_environment: dev\n  dev:\n    kind: azure_sql\n    server: {AZ_HOST}\n    database: ContosoDW\n"
        "  prod:\n    kind: azure_sql\n    server: contoso.database.windows.net\n    database: ContosoDW\n",
        encoding="utf-8",
    )

    class FakePyodbc:
        def __init__(self):
            self.call = None

        def drivers(self):
            return ["ODBC Driver 18 for SQL Server"]

        def connect(self, connection_string, **kwargs):
            self.call = (connection_string, kwargs)
            return FakeConnection(FakeCursor(answers))

    fake = FakePyodbc()
    minted = []

    def fake_token(*, timeout=8, resource=sq.wmcp.FABRIC_RESOURCE, tenant=""):
        minted.append((resource, tenant))
        return SQL_TOKEN, "ok"

    with (
        mock.patch.dict(os.environ, {sq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN}, clear=False),
        mock.patch.dict(sys.modules, {"pyodbc": fake}),
        mock.patch.object(sq.wmcp, "az_access_token", side_effect=fake_token),
        mock.patch.object(sq.wmcp, "fabric_get_json", side_effect=AssertionError("no discovery for azure_sql")),
    ):
        out = si.execute({"object": "dbo.vw_Sales"}, cwd=project)
    assert out["ok"] and out["target"]["environment"] == "dev", out
    assert minted == [(sq.SQL_RESOURCE, TENANT)]
    assert f"SERVER={AZ_HOST},1433" in fake.call[0] and "contoso.database.windows.net," not in fake.call[0]
    assert fake.call[1]["timeout"] == 60

print("sql-impact tests passed")

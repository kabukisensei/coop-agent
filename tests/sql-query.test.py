#!/usr/bin/env python3
"""Offline tests for the governed pyodbc executor (Fabric fallback + contract sql_targets)."""

from __future__ import annotations

import base64
import importlib.util
import json
import os
import shlex
import shutil
import struct
import sys
import tempfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "lib"))
spec = importlib.util.spec_from_file_location(
    "sql_query", ROOT / "lib" / "sql_query.py"
)
fsq = importlib.util.module_from_spec(spec)
sys.modules["sql_query"] = fsq
spec.loader.exec_module(fsq)

WORKSPACE = "22222222-2222-4222-8222-222222222222"
ITEM = "33333333-3333-4333-8333-333333333333"
LAKEHOUSE = "44444444-4444-4444-8444-444444444444"
TENANT = "11111111-1111-4111-8111-111111111111"
PRINCIPAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
SERVER = "fixture.datawarehouse.fabric.microsoft.com"
QUERY = "SELECT TOP (2) customer_id FROM dbo.Customer"


def jwt(audience: str) -> str:
    def enc(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return f"{enc({'alg': 'none'})}.{enc({'tid': TENANT, 'oid': PRINCIPAL, 'aud': audience})}.sig"


FABRIC_TOKEN = jwt("fabric")
SQL_TOKEN = jwt("sql")


def fixture(
    item_type: str = "Warehouse",
) -> tuple[tempfile.TemporaryDirectory, Path, Path]:
    temp = tempfile.TemporaryDirectory()
    root = Path(temp.name)
    project = root / "project"
    (project / ".coop").mkdir(parents=True)
    item_id = ITEM if item_type == "Warehouse" else LAKEHOUSE
    endpoint_properties = (
        ""
        if item_type == "Warehouse"
        else f'    sqlEndpointProperties:\n      id: "{ITEM}"\n'
    )
    (project / ".coop" / "project.yml").write_text(
        f"""fabric:
  default_workspace_id: "{WORKSPACE}"
  default_sql_endpoint:
    item_type: "{item_type}"
    item_name: "CustomerWarehouse"
    item_id: "{item_id}"
{endpoint_properties}
""",
        encoding="utf-8",
    )
    agent = root / "agent"
    agent.mkdir()
    (agent / "mcp-adapter.json").write_text(
        json.dumps(
            {
                "mcpServers": {
                    "fabric-sqlendpoint": {
                        "url": f"{fsq.wmcp.FABRIC_RESOURCE}/v1/mcp/dataPlane/workspaces/{WORKSPACE}/items/{ITEM}/sqlEndpoint",
                        "auth": False,
                        "requestHeadersCommand": {
                            "command": "node",
                            "args": [
                                fsq.wmcp.REQUEST_HEADERS_HELPER,
                                f"{fsq.wmcp.FABRIC_RESOURCE}/v1/mcp/dataPlane/workspaces/{WORKSPACE}/items/{ITEM}/sqlEndpoint",
                            ],
                            "timeoutMs": 10000,
                        },
                        "requestTimeoutMs": 60000,
                        "lifecycle": "lazy",
                        "_coop_target": {
                            "scope": "item",
                            "workspace_id": WORKSPACE,
                            "item_id": ITEM,
                            "item_type": item_type,
                            "reason": "fixture",
                            "client": "",
                            "tenant_id": "",
                            "environment": "",
                            "item_name": "CustomerWarehouse",
                        },
                    }
                },
                "_coop": {"managed_servers": ["fabric-sqlendpoint"]},
            }
        ),
        encoding="utf-8",
    )
    return temp, project, agent


class FakeCursor:
    # Real pyodbc cursors reject arbitrary attributes, including timeout.
    __slots__ = ("query", "rows", "description", "fetch_index")
    def __init__(self, rows=None, description=None):
        self.query = None
        self.rows = [(1, b"a"), (2, b"b"), (3, b"c")] if rows is None else rows
        self.description = description or [("customer_id",), ("seen_at",)]
        self.fetch_index = 0

    def execute(self, query):
        self.query = query

    def fetchone(self):
        if self.fetch_index >= len(self.rows):
            return None
        row = self.rows[self.fetch_index]
        self.fetch_index += 1
        return row


class FakeConnection:
    def __init__(self, rows=None, description=None):
        self.timeout = None
        self.cursor_value = FakeCursor(rows, description)
        self.closed = False

    def cursor(self):
        assert self.timeout == fsq.QUERY_TIMEOUT
        return self.cursor_value

    def close(self):
        self.closed = True


class FakePyodbc:
    def __init__(self, drivers=None, connect_error=None, rows=None, description=None):
        self.driver_values = drivers or [
            "ODBC Driver 17 for SQL Server",
            "ODBC Driver 18 for SQL Server",
            "ODBC Driver 19 for SQL Server",
        ]
        self.connect_error = connect_error
        self.connection = FakeConnection(rows, description)
        self.call = None

    def drivers(self):
        return self.driver_values

    def connect(self, connection_string, **kwargs):
        self.call = (connection_string, kwargs)
        if self.connect_error:
            raise self.connect_error
        return self.connection


# Reject anything except one literal-TOP SELECT before target/auth/connect work.
for rejected in (
    "DELETE FROM dbo.Customer",
    "SELECT * FROM dbo.Customer",
    "SELECT TOP (2) * FROM dbo.Customer; SELECT TOP (1) * FROM dbo.Secret",
    "SELECT TOP (2) * FROM OtherDb.dbo.Secret",
    "WITH x AS (SELECT TOP (2) * FROM dbo.Customer) SELECT TOP (2) * FROM x",
    "SELECT TOP (1001) * FROM dbo.Customer",
):
    with mock.patch.object(fsq, "_canonical_target") as target:
        assert fsq.execute({"query": rejected})["state"] == "query_rejected"
        target.assert_not_called()
assert fsq.execute({"query": QUERY, "target": ITEM})["state"] == "input_invalid"
assert fsq.execute({"query": QUERY, "maximum_rows": 0})["state"] == "query_rejected"

# Access-token packing is SQL Server's little-endian length + UTF-16-LE bytes.
packed = fsq.pack_access_token("abc")
assert packed == struct.pack("<I", 6) + "abc".encode("utf-16-le")
assert struct.unpack("<I", packed[:4])[0] == len(packed[4:])

# Canonical project target, Driver 18+ selection, REST discovery, identity binding,
# query timeout, row cap, and structured output all run without network.
temp, project, agent = fixture()
resources = []
rest_calls = []
pyodbc = FakePyodbc()


def fake_token(*, timeout=8, resource=fsq.wmcp.FABRIC_RESOURCE, tenant=""):
    resources.append((resource, tenant))
    return (FABRIC_TOKEN if resource == fsq.wmcp.FABRIC_RESOURCE else SQL_TOKEN, "ok")


def fake_rest(url, token, timeout=8):
    rest_calls.append((url, token, timeout))
    return {
        "id": ITEM,
        "type": "Warehouse",
        "workspaceId": WORKSPACE,
        "properties": {"connectionString": SERVER},
    }, "ok"


with (
    mock.patch.dict(
        os.environ,
        {
            "PI_CODING_AGENT_DIR": str(agent),
            fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN,
        },
        clear=False,
    ),
    mock.patch.dict(sys.modules, {"pyodbc": pyodbc}),
    mock.patch.object(fsq.wmcp, "az_access_token", side_effect=fake_token),
    mock.patch.object(fsq.wmcp, "fabric_get_json", side_effect=fake_rest),
):
    output = fsq.execute({"query": QUERY, "maximum_rows": 1}, cwd=project)

assert output == {
    "ok": True,
    "state": "ok",
    "columns": ["customer_id", "seen_at"],
    "rows": [[1, "61"]],
    "row_count": 1,
    "truncated": True,
    "driver": "ODBC Driver 19 for SQL Server",
    "target": {"environment": "", "kind": "fabric_warehouse", "database": "CustomerWarehouse"},
}
# Both mints are pinned to the launch token's tenant.
assert resources == [(fsq.wmcp.FABRIC_RESOURCE, TENANT), (fsq.SQL_RESOURCE, TENANT)]
assert rest_calls == [
    (
        f"{fsq.wmcp.FABRIC_RESOURCE}/v1/workspaces/{WORKSPACE}/warehouses/{ITEM}",
        FABRIC_TOKEN,
        8,
    )
]
connection_string, kwargs = pyodbc.call
assert "ODBC Driver 19 for SQL Server" in connection_string
assert SERVER in connection_string and "CustomerWarehouse" in connection_string
assert (
    "Encrypt=yes" in connection_string
    and "TrustServerCertificate=no" in connection_string
)
assert "UID=" not in connection_string and "PWD=" not in connection_string
assert kwargs["attrs_before"] == {
    fsq.SQL_COPT_SS_ACCESS_TOKEN: fsq.pack_access_token(SQL_TOKEN)
}
assert kwargs["timeout"] == fsq.CONNECT_TIMEOUT and kwargs["autocommit"] is True
assert pyodbc.connection.timeout == fsq.QUERY_TIMEOUT
assert pyodbc.connection.cursor_value.query == QUERY
assert pyodbc.connection.closed is True

# Lakehouse discovery uses the source Lakehouse ID and the documented nested
# sqlEndpointProperties response while preserving the configured endpoint ID.
lake_temp, lake_project, lake_agent = fixture("Lakehouse")
lake_calls = []


def fake_lake_rest(url, token, timeout=8):
    lake_calls.append((url, token, timeout))
    return {
        "id": LAKEHOUSE,
        "type": "Lakehouse",
        "workspaceId": WORKSPACE,
        "properties": {
            "sqlEndpointProperties": {"id": ITEM, "connectionString": SERVER}
        },
    }, "ok"


with (
    mock.patch.dict(
        os.environ,
        {
            "PI_CODING_AGENT_DIR": str(lake_agent),
            fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN,
        },
        clear=False,
    ),
    mock.patch.dict(sys.modules, {"pyodbc": FakePyodbc()}),
    mock.patch.object(fsq.wmcp, "az_access_token", side_effect=fake_token),
    mock.patch.object(fsq.wmcp, "fabric_get_json", side_effect=fake_lake_rest),
):
    assert fsq.execute({"query": QUERY}, cwd=lake_project)["state"] == "ok"
assert lake_calls[0][0] == (
    f"{fsq.wmcp.FABRIC_RESOURCE}/v1/workspaces/{WORKSPACE}/lakehouses/{LAKEHOUSE}"
)

# Missing or mismatched documented identity fields fail closed.
lake_target = fsq.wmcp.project_target(
    fsq.wmcp.load_project(lake_project / ".coop" / "project.yml")
)
for invalid_item in (
    {"properties": {"sqlEndpointProperties": {"id": ITEM, "connectionString": SERVER}}},
    {
        "id": LAKEHOUSE,
        "type": "Lakehouse",
        "workspaceId": "33333333-3333-4333-8333-333333333333",
        "properties": {
            "sqlEndpointProperties": {"id": ITEM, "connectionString": SERVER}
        },
    },
    {
        "id": LAKEHOUSE,
        "type": "Lakehouse",
        "workspaceId": WORKSPACE,
        "properties": {"sqlEndpointProperties": {"connectionString": SERVER}},
    },
):
    with mock.patch.object(
        fsq.wmcp, "fabric_get_json", return_value=(invalid_item, "ok")
    ):
        assert fsq._discover_server(lake_target, FABRIC_TOKEN)[1] == "endpoint_invalid"

# One oversized cell and aggregate overflow return one stable, non-sensitive state.
for rows in (
    [("x" * (fsq.MAX_CELL_CHARS + 1), "small")],
    [("x" * fsq.MAX_CELL_CHARS, "small") for _ in range(16)],
):
    sized_pyodbc = FakePyodbc(rows=rows)
    with (
        mock.patch.dict(
            os.environ,
            {
                "PI_CODING_AGENT_DIR": str(agent),
                fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN,
            },
            clear=False,
        ),
        mock.patch.dict(sys.modules, {"pyodbc": sized_pyodbc}),
        mock.patch.object(fsq.wmcp, "az_access_token", side_effect=fake_token),
        mock.patch.object(fsq.wmcp, "fabric_get_json", side_effect=fake_rest),
    ):
        sized = fsq.execute(
            {"query": "SELECT TOP (20) customer_id FROM dbo.Customer"}, cwd=project
        )
    assert sized == {"ok": False, "state": "result_too_large"}

# Fetch incrementally and reject oversized columns even when no rows are returned.
wide_columns = [("x" * fsq.MAX_COLUMN_CHARS,) for _ in range(2_000)]
sized_pyodbc = FakePyodbc(rows=[], description=wide_columns)
with (
    mock.patch.dict(
        os.environ,
        {
            "PI_CODING_AGENT_DIR": str(agent),
            fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN,
        },
        clear=False,
    ),
    mock.patch.dict(sys.modules, {"pyodbc": sized_pyodbc}),
    mock.patch.object(fsq.wmcp, "az_access_token", side_effect=fake_token),
    mock.patch.object(fsq.wmcp, "fabric_get_json", side_effect=fake_rest),
):
    sized = fsq.execute({"query": QUERY}, cwd=project)
assert sized == {"ok": False, "state": "result_too_large"}
assert sized_pyodbc.connection.cursor_value.fetch_index == 0

# Missing prerequisites and canonical-target drift return stable diagnostics.
with (
    mock.patch.dict(
        os.environ,
        {
            "PI_CODING_AGENT_DIR": str(agent),
            fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN,
        },
        clear=False,
    ),
    mock.patch.dict(sys.modules, {"pyodbc": None}),
):
    missing = fsq.execute({"query": QUERY}, cwd=project)
assert missing["state"] == "pyodbc_unavailable"
assert missing == {"ok": False, "state": "pyodbc_unavailable", "stage": "driver_import"}

old = json.loads((agent / "mcp-adapter.json").read_text(encoding="utf-8"))
old["mcpServers"]["fabric-sqlendpoint"]["_coop_target"]["item_name"] = "OtherWarehouse"
(agent / "mcp-adapter.json").write_text(json.dumps(old), encoding="utf-8")
with mock.patch.dict(os.environ, {"PI_CODING_AGENT_DIR": str(agent)}, clear=False):
    assert fsq.execute({"query": QUERY}, cwd=project)["state"] == "target_mismatch"

# Driver and connection failures never include token, SQL, server, or exception text.
_, project2, agent2 = fixture()
for fake, expected in (
    (FakePyodbc(drivers=["ODBC Driver 17 for SQL Server"]), "odbc_driver_unavailable"),
    (
        FakePyodbc(connect_error=RuntimeError(f"{SQL_TOKEN} {QUERY} {SERVER}")),
        "connection_failed",
    ),
):
    with (
        mock.patch.dict(
            os.environ,
            {
                "PI_CODING_AGENT_DIR": str(agent2),
                fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN,
            },
            clear=False,
        ),
        mock.patch.dict(sys.modules, {"pyodbc": fake}),
        mock.patch.object(fsq.wmcp, "az_access_token", side_effect=fake_token),
        mock.patch.object(fsq.wmcp, "fabric_get_json", side_effect=fake_rest),
    ):
        diagnostic = fsq.execute({"query": QUERY}, cwd=project2)
    blob = json.dumps(diagnostic)
    assert diagnostic["state"] == expected
    assert SQL_TOKEN not in blob and QUERY not in blob and SERVER not in blob

# Azure/REST failures retain only stable state + stage; no client switching.
with (
    mock.patch.dict(
        os.environ,
        {
            "PI_CODING_AGENT_DIR": str(agent2),
            fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN,
        },
        clear=False,
    ),
    mock.patch.dict(sys.modules, {"pyodbc": FakePyodbc()}),
    mock.patch.object(fsq.wmcp, "az_access_token", return_value=("", "auth_required")),
):
    assert fsq.execute({"query": QUERY}, cwd=project2) == {
        "ok": False,
        "state": "auth_required",
        "stage": "fabric_rest_token",
    }

# No launch identity: nothing is minted at all.
with (
    mock.patch.dict(os.environ, {"PI_CODING_AGENT_DIR": str(agent2)}, clear=False),
    mock.patch.dict(sys.modules, {"pyodbc": FakePyodbc()}),
    mock.patch.object(
        fsq.wmcp, "az_access_token", side_effect=AssertionError("minted without a launch identity")
    ),
):
    os.environ.pop(fsq.wmcp.FABRIC_TOKEN_ENV, None)
    assert fsq.execute({"query": QUERY}, cwd=project2) == {"ok": False, "state": "identity_mismatch"}

# SQ2: a contract `sql_targets:` section drives the executor instead of the
# managed Fabric target. Azure SQL connects straight to the named host: no
# Fabric REST token, no discovery, the kind's 60 s connect timeout, and
# ApplicationIntent only when the entry opts into read-scale replicas.
AZ_SERVER = "contoso-dev.database.windows.net"


def contract_fixture(block: str) -> tuple[tempfile.TemporaryDirectory, Path]:
    temp = tempfile.TemporaryDirectory()
    project = Path(temp.name) / "project"
    (project / ".coop").mkdir(parents=True)
    (project / ".coop" / "project.yml").write_text(block, encoding="utf-8")
    return temp, project


AZURE_BLOCK = f"""sql_targets:
  default_environment: dev
  dev:
    kind: azure_sql
    server: {AZ_SERVER}
    database: ContosoDW
  prod:
    kind: azure_sql
    server: contoso.database.windows.net
    database: ContosoDW
"""
az_temp, az_project = contract_fixture(AZURE_BLOCK)
az_pyodbc = FakePyodbc()
az_resources = []


def fake_sql_only_token(*, timeout=8, resource=fsq.wmcp.FABRIC_RESOURCE, tenant=""):
    az_resources.append((resource, tenant))
    assert resource == fsq.SQL_RESOURCE, "a direct kind never mints a Fabric token"
    return SQL_TOKEN, "ok"


with (
    mock.patch.dict(os.environ, {fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN}, clear=False),
    mock.patch.dict(sys.modules, {"pyodbc": az_pyodbc}),
    mock.patch.object(fsq.wmcp, "az_access_token", side_effect=fake_sql_only_token),
    mock.patch.object(
        fsq.wmcp, "fabric_get_json", side_effect=AssertionError("no discovery for azure_sql")
    ),
):
    az_output = fsq.execute({"query": QUERY, "maximum_rows": 1}, cwd=az_project)
assert az_output["state"] == "ok", az_output
assert az_output["target"] == {"environment": "dev", "kind": "azure_sql", "database": "ContosoDW"}
assert az_resources == [(fsq.SQL_RESOURCE, TENANT)]
az_connection_string, az_kwargs = az_pyodbc.call
assert f"SERVER={AZ_SERVER},1433" in az_connection_string
assert "contoso.database.windows.net" not in az_connection_string, "prod is never selected"
assert "DATABASE={ContosoDW}" in az_connection_string
assert "ApplicationIntent" not in az_connection_string
assert az_kwargs["timeout"] == 60 and az_kwargs["autocommit"] is True

# read_scale_replicas: true adds the read-only intent, and only for azure_sql.
ro_temp, ro_project = contract_fixture(AZURE_BLOCK.replace("    database: ContosoDW\n  prod:", "    database: ContosoDW\n    read_scale_replicas: true\n  prod:"))
ro_pyodbc = FakePyodbc()
with (
    mock.patch.dict(os.environ, {fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN}, clear=False),
    mock.patch.dict(sys.modules, {"pyodbc": ro_pyodbc}),
    mock.patch.object(fsq.wmcp, "az_access_token", side_effect=fake_sql_only_token),
):
    ro_output = fsq.execute({"query": QUERY}, cwd=ro_project)
assert ro_output["state"] == "ok", ro_output
assert "ApplicationIntent=ReadOnly;" in ro_pyodbc.call[0]

# Without PyYAML (fresh Windows machines, the Windows CI leg) lib/_yaml.py keeps
# `true` as text; the entry still resolves and still carries the read-only intent.
ro_text_pyodbc = FakePyodbc()
with (
    mock.patch.dict(os.environ, {fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN}, clear=False),
    mock.patch.dict(sys.modules, {"pyodbc": ro_text_pyodbc, "yaml": None}),
    mock.patch.object(fsq.wmcp, "az_access_token", side_effect=fake_sql_only_token),
):
    ro_text_output = fsq.execute({"query": QUERY}, cwd=ro_project)
assert ro_text_output["state"] == "ok", ro_text_output
assert "ApplicationIntent=ReadOnly;" in ro_text_pyodbc.call[0]

# Synapse serverless and Fabric SQL database are direct kinds too (15 s timeout).
for kind, host in (
    ("synapse_serverless", "contoso-ondemand.sql.azuresynapse.net"),
    ("fabric_sql_database", "abc-xyz.database.fabric.microsoft.com"),
):
    kind_temp, kind_project = contract_fixture(
        f"sql_targets:\n  default_environment: dev\n  dev:\n    kind: {kind}\n    server: {host}\n    database: Sales\n"
    )
    kind_pyodbc = FakePyodbc()
    with (
        mock.patch.dict(os.environ, {fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN}, clear=False),
        mock.patch.dict(sys.modules, {"pyodbc": kind_pyodbc}),
        mock.patch.object(fsq.wmcp, "az_access_token", side_effect=fake_sql_only_token),
    ):
        kind_output = fsq.execute({"query": QUERY}, cwd=kind_project)
    assert kind_output["target"]["kind"] == kind, kind_output
    assert f"SERVER={host},1433" in kind_pyodbc.call[0]
    assert kind_pyodbc.call[1]["timeout"] == fsq.CONNECT_TIMEOUT

# A discovered contract kind (Fabric Warehouse by ids) goes through REST discovery
# exactly like the managed target, without needing mcp-adapter.json at all.
fw_temp, fw_project = contract_fixture(
    f"sql_targets:\n  default_environment: test\n  dev:\n    kind: azure_sql\n    server: TODO\n    database: TODO\n"
    f"  test:\n    kind: fabric_warehouse\n    workspace_id: {WORKSPACE}\n    item_id: {ITEM}\n    database: CustomerWarehouse\n"
)
fw_calls = []


def fake_fw_rest(url, token, timeout=8):
    fw_calls.append(url)
    return fake_rest(url, token, timeout)


with (
    mock.patch.dict(os.environ, {fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN}, clear=False),
    mock.patch.dict(sys.modules, {"pyodbc": FakePyodbc()}),
    mock.patch.object(fsq.wmcp, "az_access_token", side_effect=fake_token),
    mock.patch.object(fsq.wmcp, "fabric_get_json", side_effect=fake_fw_rest),
):
    fw_output = fsq.execute({"query": QUERY}, cwd=fw_project)
assert fw_output["target"] == {"environment": "test", "kind": "fabric_warehouse", "database": "CustomerWarehouse"}
assert fw_calls == [f"{fsq.wmcp.FABRIC_RESOURCE}/v1/workspaces/{WORKSPACE}/warehouses/{ITEM}"]

# A contract whose only ready entry is prod, or whose default is a placeholder,
# fails closed with target_invalid: the executor never picks prod for the caller.
for block in (
    f"sql_targets:\n  default_environment: dev\n  dev:\n    kind: azure_sql\n    server: TODO\n    database: TODO\n  prod:\n    kind: azure_sql\n    server: contoso.database.windows.net\n    database: ContosoDW\n",
    f"sql_targets:\n  default_environment: prod\n  prod:\n    kind: azure_sql\n    server: contoso.database.windows.net\n    database: ContosoDW\n",
):
    bad_temp, bad_project = contract_fixture(block)
    with (
        mock.patch.dict(os.environ, {fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN}, clear=False),
        mock.patch.dict(sys.modules, {"pyodbc": FakePyodbc()}),
        mock.patch.object(fsq.wmcp, "az_access_token", side_effect=AssertionError("no mint for an invalid target")),
    ):
        assert fsq.execute({"query": QUERY}, cwd=bad_project) == {"ok": False, "state": "target_invalid"}

# A read may name another ready entry, prod included, to compare it with dev
# (Aaron, 2026-10-07). The executor still only runs one bounded SELECT.
named_pyodbc = FakePyodbc()
with (
    mock.patch.dict(os.environ, {fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN}, clear=False),
    mock.patch.dict(sys.modules, {"pyodbc": named_pyodbc}),
    mock.patch.object(fsq.wmcp, "az_access_token", side_effect=fake_sql_only_token),
):
    named = fsq.execute({"query": QUERY, "maximum_rows": 1, "environment": "prod"}, cwd=az_project)
    assert named["state"] == "ok", named
    assert named["target"] == {"environment": "prod", "kind": "azure_sql", "database": "ContosoDW"}
    assert "SERVER=contoso.database.windows.net,1433" in named_pyodbc.call[0]
    # An entry that is not ready (test is absent here), an unknown name and a
    # write through the named entry never connect.
    assert fsq.execute({"query": QUERY, "environment": "test"}, cwd=az_project) == {"ok": False, "state": "target_invalid"}
    for environment in ("production", "staging", 1):
        assert fsq.execute({"query": QUERY, "environment": environment}, cwd=az_project)["state"] == "input_invalid", environment
    assert fsq.execute({"query": "DELETE FROM dbo.T", "environment": "prod"}, cwd=az_project)["state"] == "query_rejected"
# Without sql_targets there is one target: naming an entry is target_invalid.
legacy_named = fsq.execute({"query": QUERY, "environment": "prod"}, cwd=Path(tempfile.mkdtemp()))
assert legacy_named["state"] in ("project_unavailable", "target_invalid"), legacy_named

# Connection failures on a direct kind still never leak the host or the token.
leak_temp, leak_project = contract_fixture(AZURE_BLOCK)
with (
    mock.patch.dict(os.environ, {fsq.wmcp.FABRIC_TOKEN_ENV: FABRIC_TOKEN}, clear=False),
    mock.patch.dict(sys.modules, {"pyodbc": FakePyodbc(connect_error=RuntimeError(f"{SQL_TOKEN} {AZ_SERVER}"))}),
    mock.patch.object(fsq.wmcp, "az_access_token", side_effect=fake_sql_only_token),
):
    leak = json.dumps(fsq.execute({"query": QUERY}, cwd=leak_project))
assert '"connection_failed"' in leak and AZ_SERVER not in leak and SQL_TOKEN not in leak

# H2b end to end: a guest whose az default account is the home tenant. The shared
# fake az (tests/fixtures/fake-az.mjs) mints for --tenant, else for that default
# account, and the real token helper runs. Unpinned mints would come back for the
# home tenant and fail the launch-identity check.
HOME_TENANT = "abababab-abab-4bab-8bab-abababababab"
CLIENT_TENANT = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd"
FAKE_PRINCIPAL = "0a0a0a0a-0a0a-40a0-80a0-0a0a0a0a0a0a"


def claims_jwt(claims: dict) -> str:
    def enc(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return f"{enc({'alg': 'none'})}.{enc(claims)}.{enc('launch')}"


with tempfile.TemporaryDirectory() as az_tmp:
    az_root = Path(az_tmp)
    az_state = az_root / "az-state"
    az_bin = az_root / "az-bin"
    az_state.mkdir()
    az_bin.mkdir()
    (az_state / "tokens").write_text(f"{HOME_TENANT} *\n{CLIENT_TENANT} *\n", encoding="ascii")
    (az_state / "default-tenant").write_text(HOME_TENANT, encoding="ascii")
    node = str(Path(shutil.which("node")).resolve())
    fake = str(ROOT / "tests" / "fixtures" / "fake-az.mjs")
    # The token helper hands az an allowlisted environment: the wrapper names the state.
    if os.name == "nt":
        (az_bin / "az.cmd").write_bytes(
            f'@echo off\r\nset "COOP_TEST_AZ_STATE={az_state}"\r\n"{node}" "{fake}" %*\r\nexit /b %ERRORLEVEL%\r\n'.encode("ascii")
        )
    else:
        (az_bin / "az").write_text(
            f"#!/bin/sh\nCOOP_TEST_AZ_STATE={shlex.quote(str(az_state))} exec {shlex.quote(node)} {shlex.quote(fake)} \"$@\"\n",
            encoding="ascii",
        )
        (az_bin / "az").chmod(0o755)
    guest_pyodbc = FakePyodbc()
    previous_cwd = os.getcwd()
    os.chdir(ROOT)  # the helper refuses an az inside its working folder
    try:
        with (
            mock.patch.dict(
                os.environ,
                {
                    "PI_CODING_AGENT_DIR": str(agent2),
                    fsq.wmcp.FABRIC_TOKEN_ENV: claims_jwt({"tid": CLIENT_TENANT, "oid": FAKE_PRINCIPAL}),
                    "PATH": f"{az_bin}{os.pathsep}{os.environ.get('PATH', '')}",
                },
                clear=False,
            ),
            mock.patch.dict(sys.modules, {"pyodbc": guest_pyodbc}),
            mock.patch.object(fsq.wmcp, "fabric_get_json", side_effect=fake_rest),
        ):
            guest = fsq.execute({"query": QUERY}, cwd=project2)
    finally:
        os.chdir(previous_cwd)
    assert guest["state"] == "ok", guest
    assert (az_state / "argv.log").read_text(encoding="utf-8").splitlines() == [
        f"account get-access-token --resource {fsq.wmcp.FABRIC_RESOURCE} --output json --tenant {CLIENT_TENANT}",
        f"account get-access-token --resource {fsq.SQL_RESOURCE} --output json --tenant {CLIENT_TENANT}",
    ]
    assert guest_pyodbc.connection.closed is True

temp.cleanup()
lake_temp.cleanup()
print("sql-query tests passed")

# --- endpoint discovery retries one transient REST failure, never an auth error ---
_calls = []
def _flaky(url, token):
    _calls.append(url)
    return ({}, "unavailable") if len(_calls) == 1 else ({}, "auth_required")
with mock.patch.object(fsq.wmcp, "fabric_get_json", side_effect=_flaky):
    assert fsq._discover_server(lake_target, FABRIC_TOKEN)[1] == "auth_required"
assert len(_calls) == 2, "one retry after unavailable"
_calls.clear()
with mock.patch.object(fsq.wmcp, "fabric_get_json", side_effect=lambda u, t: (_calls.append(u), ({}, "auth_required"))[1]):
    assert fsq._discover_server(lake_target, FABRIC_TOKEN)[1] == "auth_required"
assert len(_calls) == 1, "an auth error is not retried"
print("sql_query discovery retry tests passed")


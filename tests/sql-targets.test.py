#!/usr/bin/env python3
"""Tests for lib/sql_targets.py: the `sql_targets:` contract section (SQ1)."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "lib"))
spec = importlib.util.spec_from_file_location("sql_targets", ROOT / "lib" / "sql_targets.py")
st = importlib.util.module_from_spec(spec)
sys.modules["sql_targets"] = st
spec.loader.exec_module(st)

WS = "11111111-2222-3333-4444-555555555555"
ITEM = "11111111-2222-3333-4444-666666666666"
ENDPOINT = "11111111-2222-3333-4444-777777777777"


def section(raw):
    return st.parse_sql_targets({"sql_targets": raw})


# --- absent section: not configured, one informational doctor row --------------
empty = st.parse_sql_targets({})
assert not empty.configured and empty.default is None and not empty.errors
assert st.doctor_lines(empty)[0][0] == "ok"
assert st.parse_sql_targets("nonsense").configured is False

# --- a complete mixed estate: dev Azure SQL default, test Fabric, prod unfinished -
mixed = section({
    "default_environment": "dev",
    "dev": {"kind": "azure_sql", "server": "Contoso-Dev.database.windows.net", "database": "ContosoDW"},
    "test": {"kind": "fabric_warehouse", "workspace_id": WS.upper(), "item_id": ITEM, "database": "SalesWarehouse"},
    "prod": {"kind": "azure_sql", "server": "contoso.database.windows.net", "database": ""},
})
assert mixed.configured and not mixed.errors, mixed.errors
assert mixed.default is not None and mixed.default.environment == "dev"
dev = mixed.targets["dev"]
assert dev.state == "ready" and dev.server == "contoso-dev.database.windows.net"
assert dev.connect_timeout == 60, "Azure SQL (serverless auto-pause) connects with a 60 s timeout"
assert not dev.discovered and not dev.production
test = mixed.targets["test"]
assert test.state == "ready" and test.workspace_id == WS and test.discovered and test.connect_timeout == 15
prod = mixed.targets["prod"]
assert prod.state == "unconfigured" and prod.production and "database" in prod.reason
rows = st.doctor_lines(mixed)
assert [r[0] for r in rows] == ["ok", "ok", "warn"], rows
assert "(default)" in rows[0][1] and "contoso-dev.database.windows.net / ContosoDW" in rows[0][1]
assert "prod" in rows[2][1]
payload = mixed.to_json()
assert set(payload) == {"configured", "default_environment", "targets", "errors"}
assert json.dumps(payload)  # JSON-serialisable for the CLI

# --- production is never the default ---------------------------------------
prod_default = section({
    "default_environment": "prod",
    "dev": {"kind": "azure_sql", "server": "d.database.windows.net", "database": "D"},
    "prod": {"kind": "azure_sql", "server": "p.database.windows.net", "database": "P"},
})
assert prod_default.default is None and prod_default.default_environment == ""
assert any("never be prod" in e for e in prod_default.errors), prod_default.errors
assert any("no ready default" in r[1] for r in st.doctor_lines(prod_default))
assert section({"default_environment": "qa", "dev": {}}).errors
assert any("no test entry" in e for e in section({"default_environment": "test", "dev": {}}).errors)
assumed = section({"dev": {"kind": "azure_sql", "server": "d.database.windows.net", "database": "D"}})
assert assumed.default_environment == "dev" and any("assumes dev" in e for e in assumed.errors)

# --- host pattern must match the kind: no production hiding behind a dev kind -
def target(**raw):
    return st.parse_target("dev", raw)

assert target(kind="azure_sql", server="evil.datawarehouse.fabric.microsoft.com", database="d").state == "invalid"
assert target(kind="azure_sql", server="x.database.windows.net,1433", database="d").state == "invalid"
assert target(kind="azure_sql", server="x.database.windows.net:1433", database="d").state == "invalid"
assert target(kind="fabric_sql_database", server="abc-xyz.database.fabric.microsoft.com", database="d").state == "ready"
assert target(kind="fabric_sql_database", server="abc.database.windows.net", database="d").state == "invalid"
assert target(kind="synapse_serverless", server="ws-ondemand.sql.azuresynapse.net", database="d").state == "ready"
assert target(kind="synapse_serverless", server="ws.sql.azuresynapse.net", database="d").state == "invalid"
assert target(kind="azure_sql", server="x.database.windows.net", database="d", workspace_id=WS).state == "invalid"
assert target(kind="mainframe", server="x", database="d").reason.startswith("kind 'mainframe'")
assert target(kind="azure_sql", server="x.database.windows.net", database="bad;name").state == "invalid"

# --- Fabric kinds are discovered: ids, never a hand-written server -------------
assert target(kind="fabric_warehouse", workspace_id=WS, item_id=ITEM, database="W").state == "ready"
assert target(kind="fabric_warehouse", workspace_id=WS, item_id=ITEM, database="W", server="x.datawarehouse.fabric.microsoft.com").state == "invalid"
assert target(kind="fabric_warehouse", workspace_id="nope", item_id=ITEM, database="W").state == "invalid"
assert target(kind="fabric_warehouse", database="W").state == "unconfigured"
assert target(kind="fabric_lakehouse", workspace_id=WS, item_id=ITEM, database="L").state == "unconfigured"
assert target(kind="fabric_lakehouse", workspace_id=WS, item_id=ITEM, sql_endpoint_id=ENDPOINT, database="L").state == "ready"
assert target(kind="fabric_lakehouse", workspace_id=WS, item_id=ITEM, sql_endpoint_id="x", database="L").state == "invalid"

# --- placeholders are unconfigured, not errors; credentials are rejected --------
assert target().state == "unconfigured"
assert target(kind="TODO: kind", server="TODO", database="TODO").state == "unconfigured"
assert target(kind="azure_sql", server="x.database.windows.net", database="TODO: db").state == "unconfigured"
assert target(kind="azure_sql", server="x.database.windows.net", database="d", password="p").state == "invalid"
assert target(kind="azure_sql", server="x.database.windows.net", database="d", connection_string="s").state == "invalid"
assert target(kind="azure_sql", server="x.database.windows.net", database="d", colour="blue").state == "invalid"
assert st.parse_target("dev", "just a string").state == "invalid"

# --- read_scale_replicas: azure_sql only; a plain value arrives as a bool, a quoted one as text
AZ = dict(kind="azure_sql", server="x.database.windows.net", database="d")
assert target(**AZ, read_scale_replicas=True).read_scale_replicas is True
assert target(**AZ, read_scale_replicas="true").read_scale_replicas is True
assert target(**AZ, read_scale_replicas="False").read_scale_replicas is False
assert target(**AZ, read_scale_replicas="yes").state == "invalid"
assert target(**AZ, read_scale_replicas=1).state == "invalid"
assert target(kind="synapse_serverless", server="ws-ondemand.sql.azuresynapse.net", database="d", read_scale_replicas="true").state == "invalid"
listy = section({"default_environment": "dev", "dev": {"kind": "azure_sql", "server": "x.database.windows.net", "database": "d"}, "staging": {}})
assert any("unknown entries (staging)" in e for e in listy.errors)
assert section([]).errors == ["sql_targets must be a mapping"]

# --- CLI: doctor-lines / show / default read the contract through lib/_yaml ------
with tempfile.TemporaryDirectory() as td:
    repo = Path(td) / "repo" / "nested"
    (repo.parent / ".coop").mkdir(parents=True)
    repo.mkdir()
    (repo.parent / ".coop" / "project.yml").write_text(
        "profile:\n  client: Contoso\n"
        "sql_targets:\n  default_environment: dev\n"
        "  dev:\n    kind: azure_sql\n    server: contoso-dev.database.windows.net\n    database: ContosoDW\n"
        "  prod:\n    kind: azure_sql\n    server: contoso.database.windows.net\n    database: ContosoDW\n",
        encoding="utf-8",
    )
    env = dict(os.environ)
    cli = [sys.executable, str(ROOT / "lib" / "sql_targets.py")]
    out = subprocess.run(cli + ["doctor-lines"], cwd=repo, env=env, capture_output=True, text=True, check=True).stdout
    lines = [l.split("\t") for l in out.splitlines()]
    assert lines[0][0] == "ok" and "dev (default)" in lines[0][1], out
    assert lines[1][0] == "ok" and "prod:" in lines[1][1] and "(default)" not in lines[1][1], out
    default = subprocess.run(cli + ["default"], cwd=repo, env=env, capture_output=True, text=True, check=True)
    assert json.loads(default.stdout)["environment"] == "dev"
    shown = subprocess.run(cli + ["--project", str(repo.parent / ".coop" / "project.yml"), "show"], env=env, capture_output=True, text=True, check=True)
    assert json.loads(shown.stdout)["targets"]["prod"]["state"] == "ready"
    none = subprocess.run(cli + ["default"], cwd=td, env=env, capture_output=True, text=True)
    assert none.returncode == 1 and none.stdout.strip() == "{}"
    # A credential never reaches the output: the CLI reports the rejection only.
    (repo.parent / ".coop" / "project.yml").write_text(
        "sql_targets:\n  dev:\n    kind: azure_sql\n    server: contoso-dev.database.windows.net\n    database: ContosoDW\n    password: hunter2\n",
        encoding="utf-8",
    )
    out = subprocess.run(cli + ["doctor-lines"], cwd=repo, env=env, capture_output=True, text=True, check=True).stdout
    assert "hunter2" not in out and "credential keys are not allowed" in out, out

print("  OK  sql_targets: kinds, host patterns, production never default, placeholders, credentials, CLI")

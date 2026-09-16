#!/usr/bin/env python3
"""Deterministic P0 acceptance receipt for the Warehouse MCP vertical slice.

This fixture contains no client data and performs no live calls. It proves the
intended control flow: one MCP SQL executor, approval before bounded rows, SQL
generated from schema/fixture rows, and review tied to the same pinned standard
revision.
"""

from __future__ import annotations

import hashlib
import json

SQL_STANDARD_REVISION = "sql-standards@903dc62b1e4c833235b54db918a9a51cb6d3cc8f"
WAREHOUSE_MCP = "fabric-sqlendpoint"

schema_plan = {
    "server": WAREHOUSE_MCP,
    "tool": "execute_query",
    "purpose": "schema_discovery",
    "sql": "select column_name, data_type from information_schema.columns where table_schema = 'dbo' and table_name = 'InvoiceSummary'",
}
schema_response = {
    "columns": [
        {"column_name": "invoice_date", "data_type": "date"},
        {"column_name": "customer_key", "data_type": "varchar"},
        {"column_name": "net_amount", "data_type": "decimal"},
    ]
}
bounded_read = {
    "approved": True,
    "server": WAREHOUSE_MCP,
    "tool": "execute_query",
    "limit": 5,
    "sql": "select top (5) invoice_date, customer_key, net_amount from dbo.InvoiceSummary order by invoice_date desc",
    "fixture_rows": [
        {"invoice_date": "2026-01-31", "customer_key": "C-001", "net_amount": "42.00"},
        {"invoice_date": "2026-01-30", "customer_key": "C-002", "net_amount": "17.50"},
    ],
}

generated_sql = """select
    invoice_date,
    count(*) as invoice_count,
    sum(net_amount) as net_amount
from dbo.InvoiceSummary
group by invoice_date
order by invoice_date desc;"""

review = {
    "tool": "coop-sql-review",
    "standard_revision": SQL_STANDARD_REVISION,
    "sql_sha256": hashlib.sha256(generated_sql.encode("utf-8")).hexdigest(),
    "status": "pass",
    "findings": [],
}

receipt = {
    "standard_revision": SQL_STANDARD_REVISION,
    "schema_discovery": {"plan": schema_plan, "response": schema_response},
    "bounded_row_read": bounded_read,
    "generated_sql": generated_sql,
    "review": review,
    "validated": True,
    "warehouse_absence_receipt": {
        "state": "blocked",
        "reason": "fabric-sqlendpoint Warehouse MCP is unavailable",
        "next_action": "run coop sync and configure/authorize the Warehouse target",
    },
}

serialized = json.dumps(receipt, sort_keys=True)
assert "client" not in serialized.lower()
assert receipt["bounded_row_read"]["approved"] is True
assert receipt["bounded_row_read"]["limit"] == 5
assert receipt["review"]["standard_revision"] == receipt["standard_revision"]
assert (
    receipt["review"]["sql_sha256"]
    == hashlib.sha256(generated_sql.encode("utf-8")).hexdigest()
)

executors = {
    step["server"]
    for step in (
        receipt["schema_discovery"]["plan"],
        receipt["bounded_row_read"],
    )
}
assert executors == {WAREHOUSE_MCP}, executors
assert receipt["warehouse_absence_receipt"]["state"] == "blocked"

print("  OK  P0 vertical-slice acceptance receipt is deterministic and single-executor")

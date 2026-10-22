#!/usr/bin/env python3
"""Offline tests for lib/schema_compare.py: the deterministic schema compare (SQ10)."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from datetime import datetime, timezone
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
sc = load("schema_compare")

AZ_HOST = "contoso-dev.database.windows.net"
PROD_HOST = "contoso-prod.database.windows.net"
NOW = datetime(2026, 10, 12, 21, 0, tzinfo=timezone.utc)


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
            raise RuntimeError("Invalid object name on " + AZ_HOST)
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


def target(environment, kind="azure_sql"):
    host = {"dev": AZ_HOST, "prod": PROD_HOST}.get(environment, "")
    return sq.ResolvedTarget(kind, environment, "ContosoDW", server=host if kind == "azure_sql" else "")


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

VIEW_DEV = "CREATE VIEW [dbo].[vw_Sales] AS\n  SELECT OrderId, Amount, Region FROM dbo.Orders"
VIEW_PROD = "CREATE VIEW [dbo].[vw_Sales] AS\nSELECT OrderId, Amount FROM dbo.Orders"
PROC = "CREATE PROCEDURE [dbo].[usp_Refresh] AS\r\nBEGIN\r\n    SELECT  1\r\nEND"
PROC_REFORMATTED = "CREATE PROCEDURE [dbo].[usp_Refresh] AS\nBEGIN\n  SELECT 1\nEND\n"
FN = "CREATE FUNCTION [fin].[fn_Rate]() RETURNS int AS BEGIN RETURN 1 END"
VIEW_TOP = "CREATE VIEW [dbo].[vw_Top] AS SELECT * FROM dbo.vw_Sales WHERE fin.fn_Rate() > 0;"  # repo files end with ;

DEV = {
    sc.SCHEMAS_SQL: [("dbo",), ("fin",), ("sys",), ("INFORMATION_SCHEMA",), ("stage",)],
    sc.OBJECTS_SQL: [
        ("dbo", "Orders", "U"),
        ("dbo", "NewTable", "U"),
        ("dbo", "vw_Sales", "V"),
        ("dbo", "vw_Top", "V"),
        ("dbo", "usp_Refresh", "P"),
        ("fin", "fn_Rate", "FN"),
        ("dbo", "Swapped", "V"),
    ],
    sc.COLUMNS_SQL: [
        ("dbo", "Orders", "OrderId", "int", None, 10, 0, None, "NO", 1),
        ("dbo", "Orders", "Amount", "decimal", None, 18, 2, None, "YES", 2),
        ("dbo", "Orders", "Region", "nvarchar", 50, None, None, None, "YES", 3),
        ("dbo", "NewTable", "Id", "bigint", None, 19, 0, None, "NO", 1),
        ("dbo", "NewTable", "Name", "varchar", -1, None, None, None, "YES", 2),
    ],
    sc.MODULES_SQL: [
        ("dbo", "vw_Sales", VIEW_DEV),
        ("dbo", "vw_Top", VIEW_TOP),
        ("dbo", "usp_Refresh", PROC),
        ("fin", "fn_Rate", FN),
        ("dbo", "Swapped", "CREATE VIEW [dbo].[Swapped] AS SELECT 1 AS x"),
    ],
}
PROD = {
    sc.SCHEMAS_SQL: [("dbo",), ("fin",), ("sys",), ("old",), ("_rsc",), ("queryinsights",)],
    sc.OBJECTS_SQL: [
        ("dbo", "Orders", "U"),
        ("dbo", "Legacy", "U"),
        ("dbo", "vw_Sales", "V"),
        ("dbo", "usp_Refresh", "P"),
        ("dbo", "usp_Old", "P"),
        ("fin", "fn_Rate", "FN"),
        ("dbo", "Swapped", "U"),
    ],
    sc.COLUMNS_SQL: [
        ("dbo", "Orders", "OrderId", "int", None, 10, 0, None, "NO", 1),
        ("dbo", "Orders", "Amount", "decimal", None, 18, 4, None, "YES", 2),
        ("dbo", "Orders", "Obsolete", "int", None, 10, 0, None, "YES", 3),
        ("dbo", "Legacy", "Id", "int", None, 10, 0, None, "NO", 1),
        ("dbo", "Swapped", "x", "int", None, 10, 0, None, "NO", 1),
    ],
    sc.MODULES_SQL: [
        ("dbo", "vw_Sales", VIEW_PROD),
        ("dbo", "usp_Refresh", PROC_REFORMATTED),
        ("dbo", "usp_Old", "CREATE PROCEDURE [dbo].[usp_Old] AS SELECT 1"),
        ("fin", "fn_Rate", FN),
    ],
}


def catalog(answers, failing=()):
    return sc.read_live(FakeCursor(answers, failing))


# --- normalization: whitespace and line endings are not changes ---------------------
assert sc.normalize_definition(PROC) == sc.normalize_definition(PROC_REFORMATTED)
assert sc.normalize_definition(VIEW_DEV) != sc.normalize_definition(VIEW_PROD)

# --- read_live: schemas minus system ones, tables with rendered types, modules ------
dev = catalog(DEV)
assert dev.schemas == {"dbo", "fin", "stage"}, dev.schemas
assert [c.render() for c in dev.tables[("dbo", "Orders")]] == [
    "[OrderId] int NOT NULL",
    "[Amount] decimal(18, 2) NULL",
    "[Region] nvarchar(50) NULL",
]
assert dev.tables[("dbo", "NewTable")][1].type == "varchar(max)"
assert dev.modules[("fin", "fn_Rate")] == ("function", FN)
assert dev.kinds()[("dbo", "Swapped")] == "view"
no_modules = catalog(DEV, failing={sc.MODULES_SQL})
assert no_modules.unavailable and "definitions" in no_modules.unavailable[0]
assert no_modules.modules[("dbo", "vw_Sales")] == ("view", "")
no_schemas = catalog(DEV, failing={sc.SCHEMAS_SQL})
assert no_schemas.schemas == {"dbo", "fin"}, "schemas fall back to the objects' own"

# --- diff: sorted, direction is what the target needs, destructive flagged ----------
prod = catalog(PROD)
# Fabric's internal `_rsc` (and any underscore-prefixed schema with no user object) is
# skipped the way the snapshot skips it; an empty user schema such as `old` still counts.
assert "_rsc" not in prod.schemas and "queryinsights" not in prod.schemas and "old" in prod.schemas, prod.schemas
underscore = catalog({sc.SCHEMAS_SQL: [("dbo",), ("_rsc",), ("_mine",)], sc.OBJECTS_SQL: [("_mine", "Kept", "U")], sc.COLUMNS_SQL: [("_mine", "Kept", "Id", "int", None, 10, 0, None, "NO", 1)]})
assert underscore.schemas == {"_mine"}, "an underscore schema that owns a user object is a user schema"
changes = sc.diff(dev, prod)
by = {(c["kind"], c["schema"], c["name"], c["action"]): c for c in changes}
assert ("schema", "stage", "", "add") in by
assert by[("schema", "old", "", "drop")]["destructive"] is True
assert ("schema", "_rsc", "", "drop") not in by, "the internal schema is never a drop"
assert by[("table", "dbo", "NewTable", "add")]["detail"] == "2 column(s)"
assert by[("table", "dbo", "Legacy", "drop")]["destructive"] is True
orders = by[("table", "dbo", "Orders", "alter")]
assert orders["detail"] == "add column [Region] nvarchar(50) NULL; drop column [Obsolete]; change column [Amount] type decimal(18, 4) -> decimal(18, 2)", orders["detail"]
assert orders["destructive"] is True
assert by[("view", "dbo", "vw_Sales", "alter")]["detail"] == "definition differs"
assert ("procedure", "dbo", "usp_Refresh", "alter") not in by, "a reformatted procedure is not a change"
assert by[("procedure", "dbo", "usp_Old", "drop")]["destructive"] is True
assert ("view", "dbo", "vw_Top", "add") in by
swapped = by[("view", "dbo", "Swapped", "replace")]
assert swapped["destructive"] is True and "a table on the target" in swapped["detail"]
assert sc.diff(dev, dev) == []
assert sc.diff(dev, prod) == sc.diff(catalog(DEV), catalog(PROD)), "deterministic"
# a kind-only compare when one side has no definitions
by_unknown = {(c["schema"], c["name"]): c for c in sc.diff(no_modules, prod) if c["action"] == "unknown"}
assert ("dbo", "vw_Sales") in by_unknown
# a NOT NULL column added to an existing table is lossy; a NULL one is not
safe, lossy = sc.compare_tables([sc.Column("a", "int", False, 1), sc.Column("b", "int", True, 2)], [sc.Column("a", "int", False, 1)])
assert safe == ["add column [b] int NULL"] and lossy is False
_details, lossy = sc.compare_tables([sc.Column("a", "int", False, 1), sc.Column("b", "int", False, 2)], [sc.Column("a", "int", False, 1)])
assert lossy is True
reordered, lossy = sc.compare_tables([sc.Column("a", "int", False, 1), sc.Column("b", "int", True, 2)], [sc.Column("b", "int", True, 1), sc.Column("a", "int", False, 2)])
assert reordered == ["columns reordered"] and lossy is False

# --- script: ordered, Azure SQL alters in place, destructive commented out ----------
script, to_run, destructive = sc.render_script(dev, changes, source_name="dev", target_name="prod", target_kind="azure_sql", taken_at="2026-10-12T21:00:00Z")
live_part, _, tail = script.partition("-- DESTRUCTIVE OR MANUAL: each block below can lose data or needs a person.\n")
order = [live_part.index(marker) for marker in (
    "CREATE SCHEMA [stage]",
    "CREATE TABLE [dbo].[NewTable]",
    "ALTER TABLE [dbo].[Orders] ADD [Region] nvarchar(50) NULL",
    "CREATE OR ALTER VIEW [dbo].[vw_Sales]",
    "CREATE OR ALTER VIEW [dbo].[vw_Top]",
)]
assert order == sorted(order), order
assert "CREATE OR ALTER PROCEDURE" not in live_part, "an unchanged procedure is not re-created"
assert "CREATE OR ALTER FUNCTION" not in live_part, "an unchanged function is not re-created"
assert tail, "destructive block present"
assert "-- ALTER TABLE [dbo].[Orders] DROP COLUMN [Obsolete];" in tail
assert "-- ALTER TABLE [dbo].[Orders] ALTER COLUMN [Amount] decimal(18, 2) NULL;" in tail
assert "-- DROP TABLE [dbo].[Legacy];" in tail
assert "-- DROP PROCEDURE [dbo].[usp_Old];" in tail
assert "-- DROP SCHEMA [old];" in tail and "[_rsc]" not in script
assert "-- DROP TABLE [dbo].[Swapped];\n-- GO\n-- CREATE OR ALTER VIEW [dbo].[Swapped] AS SELECT 1 AS x;" in tail, "a kind swap drops the target's kind and creates the source's, by hand"
assert tail.index("DROP PROCEDURE") < tail.index("DROP TABLE [dbo].[Legacy]") < tail.index("DROP SCHEMA")
for line in tail.splitlines():
    assert not line or line.startswith("--"), line
assert to_run == live_part.count("\nGO\n") and destructive == 6, (to_run, destructive)
assert f"-- Statements: {to_run} to run, {destructive} destructive" in script
assert AZ_HOST not in script and PROD_HOST not in script

# Fabric Warehouse: no in-place column change, the alter becomes a rebuild note
wh_script, wh_run, wh_destructive = sc.render_script(dev, changes, source_name="dev", target_name="prod", target_kind="fabric_warehouse", taken_at="2026-10-12T21:00:00Z")
assert "ALTER TABLE" not in wh_script
assert "-- A fabric warehouse does not alter columns in place" in wh_script
assert "-- CREATE TABLE [dbo].[Orders] (" in wh_script, "the source shape rides along, commented"
# vw_Sales selects [Region], which prod gets only with the rebuild, so it and
# vw_Top (which reads vw_Sales) move below the rebuild note instead of failing live
wh_live, _, wh_tail = wh_script.partition("-- DESTRUCTIVE OR MANUAL: each block below can lose data or needs a person.\n")
assert "CREATE OR ALTER VIEW [dbo].[vw_Sales]" not in wh_live and "CREATE OR ALTER VIEW [dbo].[vw_Top]" not in wh_live
assert "-- view dbo.vw_Sales: run after the rebuild: names region of dbo.Orders, which the target has only after that table's rebuild above\n-- CREATE OR ALTER VIEW [dbo].[vw_Sales]" in wh_tail
assert "-- view dbo.vw_Top: run after the rebuild: follows view dbo.vw_Sales below\n-- CREATE OR ALTER VIEW [dbo].[vw_Top]" in wh_tail
assert wh_tail.index("-- CREATE TABLE [dbo].[Orders] (") < wh_tail.index("-- CREATE OR ALTER VIEW [dbo].[vw_Sales]") < wh_tail.index("-- CREATE OR ALTER VIEW [dbo].[vw_Top]")
assert wh_run == to_run - 3 and wh_destructive == destructive + 1, (wh_run, wh_destructive)
assert not [line for line in wh_script.splitlines() if line.rstrip().endswith(";;")], "deferred module lines end with one semicolon"
assert "CREATE TABLE [dbo].[NewTable]" in wh_live and "CREATE SCHEMA [stage]" in wh_live

# a definition that already says CREATE OR ALTER is left alone; a PROC short form is handled
assert sc._create_or_alter("create or alter view v as select 1") == "create or alter view v as select 1"
assert sc._create_or_alter("  CREATE PROC p AS SELECT 1") == "CREATE OR ALTER PROC p AS SELECT 1"
assert sc._ordered([("dbo", "vw_Top"), ("dbo", "vw_Sales")], {("dbo", "vw_Top"): VIEW_TOP, ("dbo", "vw_Sales"): VIEW_DEV}) == [("dbo", "vw_Sales"), ("dbo", "vw_Top")]
# across kinds: an inline function over a view follows the view, although functions
# come first otherwise; a bare name shared by two schemas resolves only when qualified
tvf = "CREATE FUNCTION [fin].[fn_Top]() RETURNS TABLE AS RETURN (SELECT * FROM [dbo].[vw_Top])"
cross_keys = [("fin", "fn_Top"), ("dbo", "vw_Top"), ("dbo", "vw_Sales"), ("fin", "fn_Rate")]
cross_defs = {("fin", "fn_Top"): tvf, ("dbo", "vw_Top"): VIEW_TOP, ("dbo", "vw_Sales"): VIEW_DEV, ("fin", "fn_Rate"): FN}
cross_kinds = {("fin", "fn_Top"): "function", ("dbo", "vw_Top"): "view", ("dbo", "vw_Sales"): "view", ("fin", "fn_Rate"): "function"}
assert sc._ordered(cross_keys, cross_defs, cross_kinds) == [("fin", "fn_Rate"), ("dbo", "vw_Sales"), ("dbo", "vw_Top"), ("fin", "fn_Top")]
dup_defs = {("mart", "vw_dup"): "CREATE VIEW [mart].[vw_dup] AS SELECT 1 AS x", ("stage", "vw_dup"): "CREATE VIEW [stage].[vw_dup] AS SELECT x FROM mart.vw_dup"}
assert sc._ordered(list(dup_defs), dup_defs) == [("mart", "vw_dup"), ("stage", "vw_dup")]
assert sc._references("select * from dbo.vw_dup join [stage].[vw_dup] s on 1=1", list(dup_defs)) == {("stage", "vw_dup")}
assert sc._references("select * from vw_dup", list(dup_defs)) == set(), "an ambiguous bare name is no dependency"
assert sc._references("select Region from Orders", [("dbo", "Orders")]) == {("dbo", "Orders")}
assert sc._references("select 1 from dbo.Orders_Archive", [("dbo", "Orders")]) == set()
cycle = {("dbo", "a"): "select * from b", ("dbo", "b"): "select * from a"}
assert sc._ordered(list(cycle), cycle) == [("dbo", "a"), ("dbo", "b")], "a cycle breaks by name"

# --- report -------------------------------------------------------------------------
sides = {"source": sc._side_summary(dev, {"environment": "dev", "kind": "azure_sql", "database": "ContosoDW"}), "target": sc._side_summary(prod, {"environment": "prod", "kind": "azure_sql", "database": "ContosoDW"})}
report = sc.render_report(changes, source_name="dev", target_name="prod", taken_at="2026-10-12T21:00:00Z", sides=sides, notes=["source: unavailable x"])
assert "| source | dev | azure_sql | ContosoDW | 2 | 3 | 1 | 1 |" in report, report
assert "| table | `dbo.Orders` | alter (destructive) |" in report
assert "- source: unavailable x" in report
assert sc.render_report([], source_name="dev", target_name="prod", taken_at="t", sides=sides, notes=[]).count("match for every compared object") == 1

# --- snapshot side: the committed folder reads back as a catalog ---------------------
with tempfile.TemporaryDirectory() as tmp:
    folder = Path(tmp) / "snap"
    (folder / "dbo").mkdir(parents=True)
    (folder / "fin").mkdir()
    summary = {"environment": "dev", "kind": "fabric_warehouse", "database": "QE_WH"}
    files = {
        "dbo/Orders.sql": cs._header(summary, "2026-10-10T00:00:00Z", "dbo", "Orders", "table") + cs.render_table("dbo", "Orders", [
            ("OrderId", "int", None, None, None, None, "NO"),
            ("Amount", "decimal", None, 18, 2, None, "YES"),
            ("Region", "nvarchar", 50, None, None, None, "YES"),
        ]),
        "dbo/vw_Sales.sql": cs._header(summary, "2026-10-10T00:00:00Z", "dbo", "vw_Sales", "view") + VIEW_DEV + "\n",
        "fin/fn_Rate.sql": cs._header(summary, "2026-10-10T00:00:00Z", "fin", "fn_Rate", "function") + FN + "\n",
        "dbo/vw_NoDef.sql": cs._header(summary, "2026-10-10T00:00:00Z", "dbo", "vw_NoDef", "view") + "-- definition not readable on this target; columns from INFORMATION_SCHEMA.COLUMNS\n-- VIEW [dbo].[vw_NoDef] (\n    [x] int NULL\n);\n",
    }
    for rel, content in files.items():
        (folder / rel).write_text(content, encoding="utf-8")
    (folder / "manifest.json").write_text(json.dumps({"coop_catalog_snapshot": True, "taken_at": "2026-10-10T00:00:00Z", "target": summary, "files": sorted(files)}), encoding="utf-8")
    snap, state = sc.read_snapshot(folder)
    assert state == "ok"
    assert [c.render() for c in snap.tables[("dbo", "Orders")]] == ["[OrderId] int NOT NULL", "[Amount] decimal(18, 2) NULL", "[Region] nvarchar(50) NULL"]
    assert snap.modules[("dbo", "vw_Sales")] == ("view", VIEW_DEV + "\n")
    assert snap.modules[("fin", "fn_Rate")][0] == "function"
    assert snap.modules[("dbo", "vw_NoDef")] == ("view", "")
    assert snap.schemas == {"dbo", "fin"}
    assert sc.diff(snap, dev)[0]["kind"] in ("schema", "table", "view"), "a snapshot compares like a live side"
    assert sc.read_snapshot(Path(tmp) / "nowhere") == (None, "snapshot_missing")
    # #417: a listed file outside the folder, missing, headerless or undecodable fails closed.
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    (folder / "manifest.json").write_text(json.dumps({**manifest, "files": manifest["files"] + ["../escape.sql"]}), encoding="utf-8")
    assert sc.read_snapshot(folder) == (None, "snapshot_incomplete")
    (folder / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    saved = (folder / "dbo/Orders.sql").read_bytes()
    (folder / "dbo/Orders.sql").unlink()
    assert sc.read_snapshot(folder) == (None, "snapshot_incomplete"), "a missing table file is no drop"
    (folder / "dbo/Orders.sql").write_text("CREATE TABLE dbo.Orders (id int NOT NULL)\n", encoding="utf-8")
    assert sc.read_snapshot(folder) == (None, "snapshot_incomplete")
    (folder / "dbo/Orders.sql").write_bytes(b"\xff\xfe\x00bad")
    assert sc.read_snapshot(folder) == (None, "snapshot_incomplete")
    (folder / "dbo/Orders.sql").write_bytes(saved)
    # The writer's cut lists, unavailable reads and skipped objects come back.
    (folder / "manifest.json").write_text(json.dumps({**manifest, "files": [f for f in manifest["files"] if f != "dbo/Orders.sql"], "truncated": {"objects": True, "columns": False}, "unavailable": ["definitions"], "skipped": ["dbo.hidden (view: definition not readable)", "dbo.bad name"]}), encoding="utf-8")
    snap, state = sc.read_snapshot(folder)
    assert state == "ok" and snap.truncated == ["objects"] and snap.unavailable == ["definitions"], (snap.truncated, snap.unavailable)
    assert snap.modules[("dbo", "hidden")] == ("view", "") and snap.skipped == {"dbo.bad name"}
    whole = sc.Catalog()
    whole.schemas = {"dbo"}
    whole.tables[("dbo", "Orders")] = [sc.Column("id", "int", False, 1)]
    whole.tables[("dbo", "bad name")] = [sc.Column("id", "int", False, 1)]
    cut = [(c["name"], c["action"]) for c in sc.diff(snap, whole)]
    assert ("Orders", "unknown") in cut and not [c for c in cut if c[1] == "drop"], cut
    snap.truncated = []
    assert ("bad name", "unknown") in [(c["name"], c["action"]) for c in sc.diff(snap, whole)]
    assert ("Orders", "drop") in [(c["name"], c["action"]) for c in sc.diff(snap, whole)], "a whole side still proves a removal"

# --- review findings 2026-10-21 (#415, #416, #418, #419) --------------------------------
# #415: whitespace inside literals and quoted names is a change; outside it is not.
for a, b in (("'a  b'", "'a b'"), ("'a\tb'", "'a b'"), ("'a\n\nb'", "'a\nb'"), ("N'it''s  x'", "N'it''s x'"), ("1 AS [a  b]", "1 AS [a b]"), ('1 AS "a  b"', '1 AS "a b"')):
    assert sc.normalize_definition("CREATE VIEW dbo.v AS SELECT " + a) != sc.normalize_definition("CREATE VIEW dbo.v AS SELECT " + b), a
assert sc.normalize_definition("-- banner\nCREATE OR ALTER VIEW dbo.v AS\n\n    SELECT  'a  b' AS v ,\t1 AS w;\n") == sc.normalize_definition("CREATE VIEW dbo.v AS\r\nSELECT 'a  b' AS v , 1 AS w")
assert sc.normalize_definition("ALTER VIEW dbo.v AS SELECT 1") == sc.normalize_definition("CREATE VIEW dbo.v AS SELECT 1")
lit_src, lit_tgt = sc.Catalog(), sc.Catalog()
lit_src.modules[("dbo", "v")] = ("view", "CREATE VIEW dbo.v AS SELECT 'a  b' AS value")
lit_tgt.modules[("dbo", "v")] = ("view", "CREATE VIEW dbo.v AS SELECT 'a b' AS value")
assert [(c["name"], c["action"]) for c in sc.diff(lit_src, lit_tgt)] == [("v", "alter")]
# #416: CREATE OR ALTER after a banner; never inside a comment or string.
for given, expected in {
    "-- maintained view\nCREATE VIEW dbo.v AS SELECT 2 AS n": "-- maintained view\nCREATE OR ALTER VIEW dbo.v AS SELECT 2 AS n",
    "/* a /* nested */ b */\ncreate procedure dbo.p AS SELECT 1": "/* a /* nested */ b */\nCREATE OR ALTER procedure dbo.p AS SELECT 1",
    "\ufeff-- x\nCREATE FUNCTION dbo.f() RETURNS int AS BEGIN RETURN 1 END": "\ufeff-- x\nCREATE OR ALTER FUNCTION dbo.f() RETURNS int AS BEGIN RETURN 1 END",
    "CREATE OR ALTER VIEW dbo.v AS SELECT 'CREATE VIEW' AS s": "CREATE OR ALTER VIEW dbo.v AS SELECT 'CREATE VIEW' AS s",
    "-- CREATE VIEW\nALTER PROC dbo.p AS SELECT 1": "-- CREATE VIEW\nCREATE OR ALTER PROC dbo.p AS SELECT 1",
}.items():
    assert sc._create_or_alter(given) == expected, given
banner_src, banner_tgt = sc.Catalog(), sc.Catalog()
banner_src.modules[("dbo", "v")] = ("view", "-- maintained view\nCREATE VIEW dbo.v AS SELECT 2 AS n")
banner_tgt.modules[("dbo", "v")] = ("view", "CREATE VIEW dbo.v AS SELECT 1 AS n")
banner_script, _, _ = sc.render_script(banner_src, sc.diff(banner_src, banner_tgt), source_name="s", target_name="t", target_kind="azure_sql", taken_at="x")
assert "-- maintained view\nCREATE OR ALTER VIEW dbo.v AS SELECT 2 AS n;" in banner_script
# #418: comments and string literals order nothing; a real cycle goes to a person.
for z in ("CREATE VIEW dbo.z AS SELECT 'dbo.a' AS label", "CREATE VIEW dbo.z AS SELECT N'it''s dbo.a' AS label", "-- like dbo.a\nCREATE VIEW dbo.z AS SELECT 1 AS label", "CREATE VIEW dbo.z AS /* [dbo].[a] */ SELECT 1 AS label"):
    dep_src = sc.Catalog()
    dep_src.modules = {("dbo", "a"): ("view", "CREATE VIEW dbo.a AS SELECT label FROM dbo.z"), ("dbo", "z"): ("view", z)}
    dep_script, runnable, manual = sc.render_script(dep_src, sc.diff(dep_src, sc.Catalog()), source_name="s", target_name="t", target_kind="azure_sql", taken_at="x")
    assert dep_script.index("VIEW dbo.z") < dep_script.index("VIEW dbo.a") and (runnable, manual) == (2, 0), z
cyc = sc.Catalog()
cyc.modules = {
    ("dbo", "a"): ("view", "CREATE VIEW dbo.a AS SELECT * FROM dbo.b"),
    ("dbo", "b"): ("view", "CREATE VIEW dbo.b AS SELECT * FROM dbo.a"),
    ("dbo", "c"): ("view", "CREATE VIEW dbo.c AS SELECT * FROM dbo.a"),
    ("dbo", "d"): ("view", "CREATE VIEW dbo.d AS SELECT 1 AS x"),
}
assert sc._cycles(list(cyc.modules), {k: v[1] for k, v in cyc.modules.items()}) == {("dbo", "a"), ("dbo", "b")}
cyc_script, runnable, manual = sc.render_script(cyc, sc.diff(cyc, sc.Catalog()), source_name="s", target_name="t", target_kind="azure_sql", taken_at="x")
cyc_live = cyc_script.split("DESTRUCTIVE OR MANUAL")[0]
assert "CREATE OR ALTER VIEW dbo.d" in cyc_live and not any(f"VIEW dbo.{n} " in cyc_live for n in "abc")
assert "-- view dbo.a: circular reference: names dbo.b" in cyc_script and "-- view dbo.c: run after the rebuild: follows view dbo.a below" in cyc_script
assert (runnable, manual) == (1, 3)
# #419: dbo is never created or dropped; user schemas still are.
with_dbo = sc.Catalog()
with_dbo.schemas = {"dbo"}
with_dbo.tables[("dbo", "Orders")] = [sc.Column("id", "int", False, 1)]
dbo_only = sc.Catalog()
dbo_only.schemas = {"DBO"}
assert [(c["kind"], c["action"]) for c in sc.diff(with_dbo, sc.Catalog())] == [("table", "add")]
assert [(c["kind"], c["action"]) for c in sc.diff(sc.Catalog(), with_dbo)] == [("table", "drop")]
assert sc.diff(dbo_only, sc.Catalog()) == [] and sc.diff(sc.Catalog(), dbo_only) == []
dbo_script, _, _ = sc.render_script(with_dbo, sc.diff(with_dbo, sc.Catalog()), source_name="s", target_name="t", target_kind="azure_sql", taken_at="x")
assert "CREATE SCHEMA" not in dbo_script
staging = sc.Catalog()
staging.schemas = {"dbo", "staging"}
assert [(c["schema"], c["action"]) for c in sc.diff(staging, sc.Catalog())] == [("staging", "add")]

# --- compare(): input shape before any connection; identical sides rejected ---------
with mock.patch.object(sq, "open_connection", side_effect=AssertionError("no connection for bad input")):
    assert sc.compare({"source": "dev", "target": "prod", "server": "x"})["state"] == "input_invalid"
    assert sc.compare("dev")["state"] == "input_invalid"
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp) / "repo"
        (repo / ".coop").mkdir(parents=True)
        (repo / ".coop" / "project.yml").write_text(CONTRACT, encoding="utf-8")
        assert sc.compare({"source": "prod", "target": "prod"}, cwd=repo)["state"] == "input_invalid"
        assert sc.compare({"target": "snapshot"}, cwd=repo)["state"] == "input_invalid", "the snapshot is a source only"
        assert sc.compare({"source": "lord"}, cwd=repo)["state"] == "input_invalid"
    assert sc.compare({}, cwd=Path(tempfile.mkdtemp()))["state"] == "project_unavailable"

# --- compare(): dev -> prod end to end with two fake connections ----------------------
with tempfile.TemporaryDirectory() as tmp:
    repo = Path(tmp) / "repo"
    (repo / ".coop").mkdir(parents=True)
    (repo / ".coop" / "project.yml").write_text(CONTRACT, encoding="utf-8")
    opened: list[str | None] = []
    connections = {}

    def fake_open(*, cwd=None, environment=None):
        opened.append(environment)
        answers = {"dev": DEV, "prod": PROD}[environment]
        connections[environment] = FakeConnection(FakeCursor(answers))
        return connections[environment], target(environment), "ODBC Driver 18 for SQL Server", None

    with mock.patch.object(sq, "open_connection", side_effect=fake_open):
        out = sc.compare({}, cwd=repo, now=NOW)
    assert out["state"] == "ok" and out["complete"] is True, out
    assert opened == ["dev", "prod"], "the default pair is the contract's default entry against prod, each read once"
    assert all(c.closed for c in connections.values())
    assert out["path"] == ".coop/schema-compare/dev-to-prod"
    assert out["counts"] == {"total": 9, "add": 3, "alter": 2, "drop": 3, "destructive": 5}, out["counts"]
    assert out["script"] == {"statements": to_run, "destructive": destructive}
    assert out["source"]["environment"] == "dev" and out["target"]["environment"] == "prod"
    assert out["changes"][0]["kind"] == "schema"
    text = json.dumps(out)
    assert AZ_HOST not in text and PROD_HOST not in text and "ODBC" not in text
    written = repo / ".coop" / "schema-compare" / "dev-to-prod"
    assert (written / "report.md").read_text(encoding="utf-8").startswith("# Schema compare: dev -> prod")
    assert (written / "deploy.sql").read_text(encoding="utf-8") == script.replace("taken 2026-10-12T21:00:00Z", "taken 2026-10-12T21:00:00Z")
    assert PROD_HOST not in (written / "deploy.sql").read_text(encoding="utf-8")

    # prod -> dev is a plain pair of reads too (what dev lacks that prod has)
    opened.clear()
    with mock.patch.object(sq, "open_connection", side_effect=fake_open):
        back = sc.compare({"source": "prod", "target": "dev"}, cwd=repo, now=NOW)
    assert back["state"] == "ok" and opened == ["prod", "dev"] and back["path"].endswith("prod-to-dev")

    # a schema filter applies to both sides before the diff, case-insensitively
    some = sorted({c["schema"] for c in out["changes"]})
    assert len(some) >= 2, some
    with mock.patch.object(sq, "open_connection", side_effect=fake_open):
        only = sc.compare({"schemas": [some[0].upper()]}, cwd=repo, now=NOW)
        without = sc.compare({"exclude": [some[0]]}, cwd=repo, now=NOW)
    assert only["state"] == "ok" and only["changes"] and {c["schema"] for c in only["changes"]} == {some[0]}, only["changes"]
    assert f"only schemas {some[0].upper()} compared" in only["notes"]
    assert without["state"] == "ok" and some[0] not in {c["schema"] for c in without["changes"]}
    assert without["counts"]["total"] + only["counts"]["total"] == out["counts"]["total"]
    for bad in ({"schemas": "dbo"}, {"exclude": ["[x]"]}, {"schemas": ["-x"]}, {"exclude": ["a"] * 51}):
        assert sc.compare(bad, cwd=repo)["state"] == "input_invalid", bad

    # SQL source control's own schema (its locks) is never offered as a change
    # unless the person names it in `schemas` (dev VM, 2026-10-21)
    def sides(with_sqlsc):
        def read(side, **_k):
            cat = sc.Catalog()
            if with_sqlsc and side == "dev":
                cat.schemas.add("sqlsc")
                cat.modules[("sqlsc", "ObjectLock")] = ("view", "select 1")
            return cat, {"environment": side}, None
        return read
    with mock.patch.object(sc, "_read_side", side_effect=sides(True)):
        quiet = sc.compare({"exclude": ["sqlsc_lt"]}, cwd=repo, now=NOW)
        named = sc.compare({"schemas": ["SQLSC"]}, cwd=repo, now=NOW)
    assert quiet["state"] == "ok" and quiet["counts"]["total"] == 0, quiet["counts"]
    assert "schema sqlsc (SQL source control's locks) left out" in quiet["notes"]
    assert named["state"] == "ok" and {c["schema"] for c in named["changes"]} == {"sqlsc"}, named["changes"]
    with mock.patch.object(sc, "_read_side", side_effect=sides(False)):
        plain = sc.compare({}, cwd=repo, now=NOW)
    assert not any("sqlsc" in n for n in plain["notes"])

    # a side the executor refuses is reported with the side's name, before the other side is read
    def refuse(*, cwd=None, environment=None):
        if environment == "prod":
            opened.append(environment)
            return None, None, "", sq.result("target_invalid")
        return fake_open(cwd=cwd, environment=environment)

    opened.clear()
    with mock.patch.object(sq, "open_connection", side_effect=refuse):
        bad = sc.compare({"target": "prod"}, cwd=repo)
    assert bad["state"] == "target_invalid" and bad["side"] == "prod" and opened == ["dev", "prod"]

    # the committed snapshot as the source: no dev connection at all
    env = cs.default_environment({"sql_targets": {"default_environment": "dev"}})
    snap_folder = repo / ".coop" / "catalog" / env
    (snap_folder / "dbo").mkdir(parents=True)
    (snap_folder / "dbo" / "Orders.sql").write_text(cs._header({"environment": "dev", "kind": "azure_sql", "database": "ContosoDW"}, "2026-10-10T00:00:00Z", "dbo", "Orders", "table") + cs.render_table("dbo", "Orders", [("OrderId", "int", None, None, None, None, "NO")]), encoding="utf-8")
    (snap_folder / "manifest.json").write_text(json.dumps({"coop_catalog_snapshot": True, "taken_at": "2026-10-10T00:00:00Z", "target": {"environment": "dev", "kind": "azure_sql", "database": "ContosoDW"}, "files": ["dbo/Orders.sql"]}), encoding="utf-8")
    opened.clear()
    with mock.patch.object(sq, "open_connection", side_effect=fake_open):
        from_snapshot = sc.compare({"source": "snapshot", "target": "prod"}, cwd=repo, now=NOW)
    assert from_snapshot["state"] == "ok" and opened == ["prod"], opened
    assert from_snapshot["source"]["taken_at"] == "2026-10-10T00:00:00Z"
    assert from_snapshot["path"] == ".coop/schema-compare/snapshot-to-prod"
    assert {(c["name"], c["action"]) for c in from_snapshot["changes"] if c["kind"] == "table"} == {("Orders", "alter"), ("Legacy", "drop"), ("Swapped", "drop")}

    # a missing snapshot is its own state, named by side
    import shutil
    shutil.rmtree(snap_folder)
    with mock.patch.object(sq, "open_connection", side_effect=AssertionError("the snapshot side never connects")):
        assert sc.compare({"source": "snapshot"}, cwd=repo)["state"] == "snapshot_missing"

# --- repo sides: the contract repository's .sql files, read as code, no connection ------
REPO_CONTRACT = CONTRACT + """repositories:
  sql:
    role: "sql"
    local_path: "../sql-repo"
    sql_root: "warehouse"
  other:
    role: "mixed"
    local_path: "../other-repo"
  docs:
    role: "data_docs"
    local_path: "../docs"
"""
assert sc.normalize_definition("-- banner\nCREATE OR ALTER VIEW v AS SELECT 1;") == sc.normalize_definition("CREATE VIEW v AS SELECT 1"), "a banner, OR ALTER and ; are not changes"
with tempfile.TemporaryDirectory() as tmp:
    home = Path(tmp) / "home"
    (home / ".coop").mkdir(parents=True)
    (home / ".coop" / "project.yml").write_text(REPO_CONTRACT, encoding="utf-8")
    sql_repo = Path(tmp) / "sql-repo" / "warehouse"
    for rel, content in {
        "dbo/Tables/Orders.sql": "-- Orders as code\nCREATE TABLE [dbo].[Orders] (\n    [OrderId] INT NOT NULL,\n    [Amount] DECIMAL (18, 2) NULL,\n    [Region] nvarchar(50),\n    CONSTRAINT [PK_Orders] PRIMARY KEY NONCLUSTERED ([OrderId]) NOT ENFORCED\n);\nGO\n",
        "dbo/Tables/NewTable.sql": "CREATE TABLE dbo.NewTable (Id bigint NOT NULL, Name varchar(max) NULL)\nGO\n",
        "dbo/Views/vw_Sales.sql": "-- banner\n" + VIEW_DEV.replace("CREATE VIEW", "CREATE OR ALTER VIEW") + ";\nGO\n",
        "dbo/Views/vw_Top.sql": VIEW_TOP + "\n",
        "dbo/StoredProcedures/usp_Refresh.sql": PROC + "\nGO\n",
        "fin/Functions/fn_Rate.sql": FN,
        "Security/fin.sql": "CREATE SCHEMA [fin] AUTHORIZATION [dbo];\nGO\nCREATE SCHEMA stage;\n",
        "Script.PostDeployment.sql": "INSERT INTO dbo.Orders VALUES (1, 2, 'x');\n",
        "bin/Debug/ignored.sql": "CREATE TABLE dbo.Ignored (a int)\n",
    }.items():
        (sql_repo / rel).parent.mkdir(parents=True, exist_ok=True)
        (sql_repo / rel).write_text(content, encoding="utf-8")
    (Path(tmp) / "sql-repo" / "stray.sql").write_text("CREATE TABLE dbo.Stray (a int)\n", encoding="utf-8")
    other_repo = Path(tmp) / "other-repo"
    other_repo.mkdir()
    (other_repo / "orders.sql").write_text("CREATE TABLE dbo.Orders (OrderId int NOT NULL, Amount decimal(18, 2) NULL)\n", encoding="utf-8")

    # the repo reads as a catalog shaped like the live one
    from_repo = sc.read_repo(sql_repo)
    assert [c.render() for c in from_repo.tables[("dbo", "Orders")]] == ["[OrderId] int NOT NULL", "[Amount] decimal(18, 2) NULL", "[Region] nvarchar(50) NULL"]
    assert from_repo.schemas == {"dbo", "fin", "stage"}
    assert ("dbo", "Stray") not in from_repo.tables and ("dbo", "Ignored") not in from_repo.tables, "sql_root and bin/ are respected"
    assert from_repo.notes == ["1 of 8 .sql file(s) create no schema, table, view, procedure or function and were ignored"], from_repo.notes
    assert [(c["kind"], c["name"], c["action"]) for c in sc.diff(from_repo, dev)] == [("view", "Swapped", "drop")], "the repo matches dev apart from the view only dev holds"

    # resolution: the named repository, its sql_root, a subfolder, the only one when unnamed
    assert sc.resolve_repo("repo:sql", {}, home / ".coop" / "project.yml")[2] == "repo_missing"
    project = sc.wmcp.load_project(home / ".coop" / "project.yml")
    assert sc.resolve_repo("repo:sql", project, home / ".coop" / "project.yml") == (sql_repo.resolve(), "sql", "ok")
    assert sc.resolve_repo("repo:sql/warehouse/dbo/Views", project, home / ".coop" / "project.yml") == ((sql_repo / "dbo" / "Views").resolve(), "sql/warehouse/dbo/Views", "ok"), "a subfolder is under the repository root, not sql_root"
    assert sc.resolve_repo("repo:other", project, home / ".coop" / "project.yml")[1:] == ("other", "ok")
    assert sc.resolve_repo("repo", project, home / ".coop" / "project.yml")[2] == "repo_ambiguous"
    assert sc.resolve_repo("repo:docs", project, home / ".coop" / "project.yml")[2] == "repo_missing", "data_docs is not a SQL repository"
    assert sc.resolve_repo("repo:sql/nowhere", project, home / ".coop" / "project.yml")[2] == "repo_unavailable"
    assert sc.resolve_repo("repo:../x", project, home / ".coop" / "project.yml")[2] == "input_invalid"

    # repo -> prod connects once (prod only); repo -> repo never connects
    opened_envs: list[str | None] = []

    def open_prod(*, cwd=None, environment=None):
        opened_envs.append(environment)
        return FakeConnection(FakeCursor(PROD)), target("prod"), "ODBC Driver 18 for SQL Server", None

    with mock.patch.object(sq, "open_connection", side_effect=open_prod):
        result = sc.compare({"source": "repo:sql", "target": "prod"}, cwd=home, now=NOW)
    assert result["state"] == "ok" and opened_envs == ["prod"], result
    assert result["source"] == {"environment": "repo", "kind": "sql source", "database": "sql", "tables": 2, "views": 2, "procedures": 1, "functions": 1}, result["source"]
    assert result["path"] == ".coop/schema-compare/repo-sql-to-prod"
    assert {(c["name"], c["action"]) for c in result["changes"] if c["kind"] == "table"} == {("Orders", "alter"), ("NewTable", "add"), ("Legacy", "drop"), ("Swapped", "drop")}
    assert result["notes"] == ["source: 1 of 8 .sql file(s) create no schema, table, view, procedure or function and were ignored"]
    deploy = (home / ".coop" / "schema-compare" / "repo-sql-to-prod" / "deploy.sql").read_text(encoding="utf-8")
    assert "CREATE OR ALTER VIEW [dbo].[vw_Sales]" in deploy and "ALTER TABLE [dbo].[Orders] ADD [Region] nvarchar(50) NULL" in deploy
    with mock.patch.object(sq, "open_connection", side_effect=AssertionError("repo sides never connect")):
        both = sc.compare({"source": "repo:sql", "target": "repo:other"}, cwd=home, now=NOW)
        assert both["state"] == "ok" and both["path"] == ".coop/schema-compare/repo-sql-to-repo-other", both
        assert [(c["kind"], c["schema"] if c["kind"] == "schema" else c["name"], c["action"]) for c in both["changes"] if c["kind"] in ("schema", "table")] == [("schema", "fin", "add"), ("schema", "stage", "add"), ("table", "NewTable", "add"), ("table", "Orders", "alter")], both["changes"]
        assert sc.compare({"source": "repo:sql", "target": "repo:sql"}, cwd=home)["state"] == "input_invalid"
        assert sc.compare({"source": "repo:nope", "target": "prod"}, cwd=home) == sq.result("repo_missing", side="repo:nope")
        assert sc.compare({"source": "dev", "target": "repo"}, cwd=home)["state"] == "repo_ambiguous"
        assert sc.compare({"source": "repo:sql/../../x", "target": "prod"}, cwd=home)["state"] == "input_invalid"
    with mock.patch.object(sq, "open_connection", side_effect=lambda **k: (FakeConnection(FakeCursor(DEV)), target("dev"), "d", None)):
        to_repo = sc.compare({"source": "dev", "target": "repo:sql"}, cwd=home, now=NOW)
        assert to_repo["state"] == "ok" and to_repo["target"]["kind"] == "sql source"
        assert [(c["kind"], c["name"], c["action"]) for c in to_repo["changes"]] == [("view", "Swapped", "add")], to_repo["changes"]

# --- a bare `period` column, unreadable columns (sqlsc capture bugs, 2026-10-22) ----------
src = sc.sql_source
assert src.parse_column("period bigint NULL") == ("period", "bigint", True), "PERIOD is not a reserved word"
assert src.parse_column("[period] bigint NULL") == ("period", "bigint", True)
assert src.parse_column("Period datetime2(3) NOT NULL") == ("Period", "datetime2(3)", False)
assert src.parse_column("PERIOD FOR SYSTEM_TIME (ValidFrom, ValidTo)") is None
assert src.parse_column("period  for\n system_time ([From],[To])") is None
for clause in ("CONSTRAINT pk PRIMARY KEY (id)", "PRIMARY KEY (id)", "UNIQUE (id)", "CHECK (id > 0)", "INDEX ix (id)", "FOREIGN KEY (a) REFERENCES t (a)"):
    assert src.parse_column(clause) is None and src.is_table_clause(clause), clause
with tempfile.TemporaryDirectory() as tmp:
    repo = Path(tmp)
    (repo / "t.sql").write_text(
        "CREATE TABLE dbo.Setup (\n    id int NOT NULL\n    ,period bigint NULL\n    ,ValidFrom datetime2 GENERATED ALWAYS AS ROW START NOT NULL\n"
        "    ,ValidTo datetime2 GENERATED ALWAYS AS ROW END NOT NULL\n    ,PERIOD FOR SYSTEM_TIME (ValidFrom, ValidTo)\n);\n",
        encoding="utf-8",
    )
    from_repo = sc.read_repo(repo)
    assert [c.name for c in from_repo.tables[("dbo", "Setup")]] == ["id", "period", "ValidFrom", "ValidTo"]
    live = sc.Catalog()
    live.schemas = {"dbo"}
    live.tables[("dbo", "Setup")] = [sc.Column("id", "int", False, 1), sc.Column("period", "bigint", True, 2), sc.Column("ValidFrom", "datetime2(7)", False, 3), sc.Column("ValidTo", "datetime2(7)", False, 4)]
    assert sc.diff(from_repo, live) == [] and sc.diff(live, from_repo) == [], "the matching period column is no drop and no rebuild"
    # A column item the reader cannot read: no drop is ever scripted from that loss.
    (repo / "t.sql").write_text("CREATE TABLE dbo.Setup (\n    id int NOT NULL\n    ,period bigint NULL\n    ,9odd ???\n);\n", encoding="utf-8")
    lossy = sc.read_repo(repo)
    assert ("dbo", "Setup") in lossy.incomplete and any("could not be read" in n for n in lossy.notes)
    lost = sc.diff(lossy, live)
    assert [(c["name"], c["action"]) for c in lost] == [("Setup", "unknown")], lost
    lost_script, lost_run, _ = sc.render_script(lossy, lost, source_name="repo", target_name="dev", target_kind="azure_sql", taken_at="x")
    assert lost_run == 0 and "DROP" not in lost_script.replace("-- ", "").split("DESTRUCTIVE")[0]
    assert sc.diff(live, lossy)[0]["action"] == "unknown", "an unread target side proves nothing either"

# --- renamed modules: the catalog's name, not the stale CREATE (2026-10-22) ---------------
assert src.with_identity("CREATE VIEW dbo.OriginalName AS SELECT 1 AS x", "dbo", "RenamedView") == ("CREATE VIEW dbo.[RenamedView] AS SELECT 1 AS x", "dbo.OriginalName")
body = "-- etl.LoadOld\nCREATE OR ALTER PROCEDURE [etl].[LoadOld] AS\nEXEC etl.LoadOld; SELECT 'etl.LoadOld';"
assert src.with_identity(body, "etl", "LoadOld_deprecated") == (body.replace("[etl].[LoadOld] AS", "[etl].[LoadOld_deprecated] AS"), "etl.LoadOld"), "only the declaration moves"
assert src.with_identity("create view DBO.Same as select 1", "dbo", "Same") == ("create view DBO.Same as select 1", None)
assert src.with_identity("ALTER VIEW dbo.Old AS SELECT 1", "archive", "Old")[0] == "ALTER VIEW [archive].Old AS SELECT 1", "a schema transfer"
STALE = "CREATE VIEW dbo.OriginalName AS SELECT 1 AS LiteralValue;"
stale_live = sc.Catalog()
stale_live.schemas = {"dbo"}
stale_live.modules[("dbo", "RenamedView")] = ("view", STALE)
with tempfile.TemporaryDirectory() as tmp:
    repo = Path(tmp)
    (repo / "sqlsc.yml").write_text("version: 1\nfolder: database\n", encoding="utf-8")
    (repo / "database" / "Views").mkdir(parents=True)
    (repo / "database" / "Stored Procedures").mkdir(parents=True)
    # A file scripted before sqlsc 1.0.4 keeps the stale CREATE; sqlsc's file name is the catalog name.
    (repo / "database" / "Views" / "dbo.RenamedView.sql").write_text(STALE + "\nGO\n", encoding="utf-8")
    (repo / "database" / "Stored Procedures" / "etl.Load%2Ev2.sql").write_text("CREATE PROCEDURE etl.LoadOld AS SELECT 1;\nGO\n", encoding="utf-8")
    old_capture = sc.read_repo(repo / "database")
    assert set(old_capture.modules) == {("dbo", "RenamedView"), ("etl", "Load.v2")}, old_capture.modules
    assert any("declares dbo.OriginalName" in n and "dbo.RenamedView" in n for n in old_capture.notes), old_capture.notes
    assert [c for c in sc.diff(old_capture, stale_live) if c["schema"] == "dbo"] == [], "no add of the old name, no drop of the current one"
    # The corrected capture (sqlsc 1.0.4) against a catalog that still holds the stale CREATE: no change at all.
    (repo / "database" / "Views" / "dbo.RenamedView.sql").write_text("CREATE VIEW dbo.[RenamedView] AS SELECT 1 AS LiteralValue;\nGO\n", encoding="utf-8")
    fixed = sc.read_repo(repo / "database")
    assert not any("OriginalName" in n for n in fixed.notes)
    view_changes = [c for c in sc.diff(fixed, stale_live) if c["name"] == "RenamedView"]
    assert view_changes == [], view_changes
    # Live to repo: a script never creates the stale name.
    moved = sc.Catalog()
    moved.schemas = {"dbo"}
    moved.modules[("dbo", "RenamedView")] = ("view", STALE.replace("SELECT 1", "SELECT 2"))
    alter = sc.diff(moved, fixed)
    assert [(c["name"], c["action"]) for c in alter if c["name"] == "RenamedView"] == [("RenamedView", "alter")]
    out_script, _, _ = sc.render_script(moved, alter, source_name="dev", target_name="repo", target_kind="azure_sql", taken_at="x")
    assert "CREATE OR ALTER VIEW dbo.[RenamedView] AS SELECT 2" in out_script and "OriginalName" not in out_script, out_script
    # Without sqlsc.yml the file name means nothing: the CREATE decides, as before.
    (repo / "sqlsc.yml").unlink()
    (repo / "database" / "Views" / "dbo.RenamedView.sql").write_text(STALE + "\nGO\n", encoding="utf-8")
    plain_repo = sc.read_repo(repo / "database")
    assert ("dbo", "OriginalName") in plain_repo.modules and ("dbo", "RenamedView") not in plain_repo.modules

# --- stdin contract ---------------------------------------------------------------------
with mock.patch.object(sc, "execute", return_value=sq.result("ok", path="x")) as run:
    import io
    with mock.patch.object(sys, "stdin", io.StringIO('{"source": "dev", "target": "prod"}')):
        assert sc.main(["--stdin"]) == 0
    assert run.call_args.args[0] == {"source": "dev", "target": "prod"}
    assert sc.main(["--source", "snapshot", "--target", "test"]) == 0
    assert run.call_args.args[0] == {"source": "snapshot", "target": "test"}
    assert sc.main(["--source", "repo:sql/warehouse", "--target", "prod"]) == 0
    assert run.call_args.args[0] == {"source": "repo:sql/warehouse", "target": "prod"}
    with mock.patch.object(sys, "stdin", io.StringIO('{"source": "dev"}')):
        assert sc.main(["--cli"]) == 0, "the terminal form never reads stdin"
    assert run.call_args.args[0] == {}

print("✓ schema_compare tests passed")

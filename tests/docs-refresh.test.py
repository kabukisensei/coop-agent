#!/usr/bin/env python3
"""Offline tests for the Daily lineage refresh's Python side (FEATURES-DESIGN CW6):

- lib/live_docs.py `dev_is_prod`: a dev entry that names a production database is
  refused before anything is resolved or minted (setup and refresh), across the
  plain prod entry, named sets, Fabric workspace/item and Lakehouse SQL endpoints,
  and, with no production entry, the production word and environment_names.prod;
- lib/live_docs.py `build`: live/.gitignore, `coop-data-doc build
  --non-interactive` in the config's folder (and nothing else), the files it
  changed in output.dir and site_dir, a failed or hung build, input checks;
- the scripts the waiter runs: scripts/docs-refresh.ps1 starts no Pi, no git, no
  SQL helper; its only helper is lib/live_docs.py (a static scan, beside the real
  process tests in tests/fixtures/docs-refresh*.test.ps1).
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import stat
import sys
import tempfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
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

G = ["11111111-1111-4111-8111-11111111111%d" % i for i in range(10)]


def project(text: str) -> dict:
    import _yaml  # noqa: PLC0415  (coop's one YAML reader)

    return _yaml.loads(text)


# --- dev_is_prod --------------------------------------------------------------------
BASE = """sql_targets:
  default_environment: dev
  dev:
    kind: azure_sql
    server: "{dev_server}"
    database: {dev_db}
{prod}"""
PROD = """  prod:
    kind: azure_sql
    server: "contoso.database.windows.net"
    database: ContosoDW
"""

same_db = project(BASE.format(dev_server="contoso.database.windows.net", dev_db="ContosoDW", prod=PROD))
assert ld.dev_is_prod(same_db, "dev"), "dev = prod server and database"
case = project(BASE.format(dev_server="CONTOSO.database.windows.net", dev_db="contosodw", prod=PROD))
assert ld.dev_is_prod(case, "dev"), "the match ignores letter case"
other_db = project(BASE.format(dev_server="contoso.database.windows.net", dev_db="ContosoDW_Dev", prod=PROD))
assert not ld.dev_is_prod(other_db, "dev"), "same server, another database: dev"
other_server = project(BASE.format(dev_server="contoso-dev.database.windows.net", dev_db="ContosoDW", prod=PROD))
assert not ld.dev_is_prod(other_server, "dev"), "another server, same database name: dev"
# A production entry exists, so the word check is off: a dev database called *_live is fine.
assert not ld.dev_is_prod(project(BASE.format(dev_server="contoso-dev.database.windows.net", dev_db="sales_live", prod=PROD)), "dev")

# Named sets: a named dev that is any production entry (the plain prod, or its own set's).
named = project("""sql_targets:
  default_environment: dev
  dev:
    kind: azure_sql
    server: "contoso-dev.database.windows.net"
    database: ContosoDW
  named:
    lake:
      dev:
        kind: fabric_lakehouse
        workspace_id: "%s"
        item_id: "%s"
        sql_endpoint_id: "%s"
        database: SalesLake
      prod:
        kind: fabric_lakehouse
        workspace_id: "%s"
        item_id: "%s"
        sql_endpoint_id: "%s"
        database: SalesLake
    wh:
      dev:
        kind: fabric_warehouse
        workspace_id: "%s"
        item_id: "%s"
        database: Sales
      prod:
        kind: fabric_warehouse
        workspace_id: "%s"
        item_id: "%s"
        database: Sales
""" % (G[0], G[1], G[2], G[3], G[4], G[2], G[5], G[6], G[5], G[6]))
assert not ld.dev_is_prod(named, "dev")
assert ld.dev_is_prod(named, "dev@lake"), "a Lakehouse whose SQL endpoint is production's"
assert ld.dev_is_prod(named, "dev@wh"), "a Warehouse with production's workspace and item"
# ... and against another set's production entry too.
cross = project("""sql_targets:
  default_environment: dev
  dev:
    kind: azure_sql
    server: "contoso-dev.database.windows.net"
    database: ContosoDW
  named:
    copy:
      prod:
        kind: azure_sql
        server: "contoso-dev.database.windows.net"
        database: ContosoDW
""")
assert ld.dev_is_prod(cross, "dev"), "the plain dev is a named set's production"

# No production entry: the production word (server, database or set name) or environment_names.prod.
bare = "sql_targets:\n  default_environment: dev\n  dev:\n    kind: azure_sql\n    server: \"%s\"\n    database: %s\n"
assert ld.dev_is_prod(project(bare % ("contoso-prod.database.windows.net", "ContosoDW")), "dev")
assert ld.dev_is_prod(project(bare % ("contoso.database.windows.net", "Contoso_PRD")), "dev")
assert not ld.dev_is_prod(project(bare % ("contoso-dev.database.windows.net", "ContosoDW")), "dev")
assert not ld.dev_is_prod(project(bare % ("contoso-dev.database.windows.net", "ProductionPlanning")), "dev"), "a word inside a name is not the word"
names = project((bare % ("contoso-dev.database.windows.net", "SalesMain")) + "fabric:\n  environment_names:\n    prod: salesmain\n")
assert ld.dev_is_prod(names, "dev"), "the database is environment_names.prod"
prodset = project("sql_targets:\n  default_environment: dev\n  dev:\n    kind: azure_sql\n    server: \"a-dev.database.windows.net\"\n    database: A\n  named:\n    prod_copy:\n      dev:\n        kind: azure_sql\n        server: \"b-dev.database.windows.net\"\n        database: B\n")
assert ld.dev_is_prod(prodset, "dev@prod_copy") and not ld.dev_is_prod(prodset, "dev")

# A template prod entry (TODO placeholders) names nothing: the word and environment_names checks stay on (Neon B3).
for template in ("  prod:\n    server: TODO\n    database: TODO\n",
                 "  prod:\n    kind: TODO\n    server: TODO\n    database: TODO\n",
                 "  prod:\n    kind: azure_sql\n    server: \"TODO.database.windows.net\"\n    database: TODO\n"):
    word = project((bare % ("contoso-prod.database.windows.net", "ContosoDW")) + template)
    assert ld.dev_is_prod(word, "dev"), f"a TODO prod entry does not switch the word check off: {template!r}"
    named_prod = project((bare % ("contoso-dev.database.windows.net", "SalesMain")) + template + "fabric:\n  environment_names:\n    prod: salesmain\n")
    assert ld.dev_is_prod(named_prod, "dev"), f"a TODO prod entry does not switch environment_names off: {template!r}"
# Another set's real prod entry does not switch the plain dev's word check off ...
other_set = project("sql_targets:\n  default_environment: dev\n  dev:\n    kind: azure_sql\n    server: \"contoso-prod.database.windows.net\"\n    database: ContosoDW\n"
                    "  named:\n    lake:\n      prod:\n        kind: azure_sql\n        server: \"lake.database.windows.net\"\n        database: Lake\n")
assert ld.dev_is_prod(other_set, "dev"), "only the dev entry's own set's prod switches the word check off"
# ... nor a named dev's, and the plain prod is not that set's.
other_set_named = project("sql_targets:\n  default_environment: dev\n  prod:\n    kind: azure_sql\n    server: \"main.database.windows.net\"\n    database: Main\n"
                          "  named:\n    lake:\n      dev:\n        kind: azure_sql\n        server: \"lake-prd.database.windows.net\"\n        database: Lake\n")
assert ld.dev_is_prod(other_set_named, "dev@lake"), "a named dev with no prod in its own set keeps the word check"
# A real prod entry in the same set decides: a dev *_live database beside it is dev.
same_set = project("sql_targets:\n  default_environment: dev\n  named:\n    lake:\n      dev:\n        kind: azure_sql\n        server: \"lake-dev.database.windows.net\"\n        database: Sales_live\n"
                   "      prod:\n        kind: azure_sql\n        server: \"lake.database.windows.net\"\n        database: Sales\n")
assert not ld.dev_is_prod(same_set, "dev@lake")

# setup and refresh refuse it before anything is resolved or minted.
STUB = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
argv = sys.argv[1:]
with open(os.environ["COOP_TEST_RECORD"], "a", encoding="utf-8") as fh:
    fh.write(json.dumps({"argv": argv, "cwd": os.getcwd()}) + "\\n")
config = Path(argv[argv.index("--config") + 1]) if "--config" in argv else Path("coop-data-doc.yml")
if argv[0] == "show-config":
    print(json.dumps({"exists": True, "path": str(config), "output": {"dir": "./data-docs", "site_dir": "./data-docs-site"},
        "repos": {"sql": {"path": "./live/dev"}}, "live_sources": {"dev": {"server": "contoso.database.windows.net", "database": "ContosoDW", "repo": "sql"}}}))
elif argv[0] == "build":
    mode = os.environ.get("COOP_TEST_BUILD", "ok")
    if mode == "fail":
        sys.exit(3)
    if mode == "hang":
        import time
        time.sleep(30)
    out = Path("data-docs"); site = Path("data-docs-site")
    out.mkdir(exist_ok=True); site.mkdir(exist_ok=True)
    (out / "same.md").write_text("same\\n", encoding="utf-8")
    (out / "changed.md").write_text(os.environ.get("COOP_TEST_BODY", "new") + "\\n", encoding="utf-8")
    (site / "index.html").write_text("<p>" + os.environ.get("COOP_TEST_BODY", "new") + "</p>", encoding="utf-8")
    gone = out / "removed.md"
    if gone.exists():
        gone.unlink()
else:
    sys.exit(9)
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


def calls(record: Path) -> list[dict]:
    return [json.loads(line) for line in record.read_text(encoding="utf-8").splitlines()] if record.exists() else []


no_resolving = lambda: mock.patch.multiple(sq, resolve_target=mock.Mock(side_effect=AssertionError("nothing is resolved")), resolve_connection=mock.Mock(side_effect=AssertionError("nothing is minted")))  # noqa: E731

with tempfile.TemporaryDirectory() as tmp:
    os.environ[ld.TOOL_ENV] = str(write_stub(Path(tmp) / "bin"))
    record = Path(tmp) / "record.jsonl"
    os.environ["COOP_TEST_RECORD"] = str(record)
    root = Path(tmp) / "work" / "contoso"
    (root / ".coop").mkdir(parents=True)
    (root / ".coop" / "project.yml").write_text("schema_version: 1\n" + BASE.format(dev_server="contoso.database.windows.net", dev_db="ContosoDW", prod=PROD), encoding="utf-8")
    config = root / "coop-data-doc.yml"
    config.write_text("# stub\n", encoding="utf-8")
    os.environ["COOP_PROJECT_YML"] = str(root / ".coop" / "project.yml")
    with no_resolving():
        out = ld.setup(cwd=root, config=str(config))
        assert out["state"] == "dev_is_prod" and out["target"] == "dev", out
        out = ld.refresh(cwd=root, config=str(config))
        assert out["state"] == "dev_is_prod", out
    assert not any(c["argv"][0] in ("snapshot", "config-set") for c in calls(record)), calls(record)
    del os.environ["COOP_PROJECT_YML"]

    # --- build ------------------------------------------------------------------------
    record.unlink()
    (root / "live" / "dev").mkdir(parents=True)
    docs = root / "data-docs"
    docs.mkdir()
    (docs / "same.md").write_text("same\n", encoding="utf-8")
    (docs / "changed.md").write_text("old\n", encoding="utf-8")
    (docs / "removed.md").write_text("bye\n", encoding="utf-8")
    elsewhere = root / "sql" / "keep.sql"
    elsewhere.parent.mkdir()
    elsewhere.write_text("select 1\n", encoding="utf-8")
    out = ld.execute({"command": "build", "config": str(config), "timeout_seconds": 60}, cwd=root)
    # changed.md, removed.md and the new site page: same.md is rewritten with the same bytes
    assert out == {"ok": True, "state": "ok", "files_changed": 3}, out
    assert (root / "live" / ".gitignore").read_text(encoding="utf-8") == "*\n", "live/ is kept out of the repository"
    builds = [c for c in calls(record) if c["argv"][0] == "build"]
    assert [c["argv"] for c in builds] == [["build", "--non-interactive"]] and Path(builds[0]["cwd"]).resolve() == root.resolve(), builds
    assert {c["argv"][0] for c in calls(record)} == {"show-config", "build"}, "nothing but show-config and build"
    assert elsewhere.read_text(encoding="utf-8") == "select 1\n"
    # the same build again changes nothing
    assert ld.execute({"command": "build", "config": str(config)}, cwd=root)["files_changed"] == 0
    os.environ["COOP_TEST_BODY"] = "newer"
    assert ld.execute({"command": "build", "config": str(config)}, cwd=root)["files_changed"] == 2
    os.environ["COOP_TEST_BUILD"] = "fail"
    assert ld.execute({"command": "build", "config": str(config)}, cwd=root)["state"] == "build_failed"
    os.environ["COOP_TEST_BUILD"] = "hang"
    assert ld.execute({"command": "build", "config": str(config), "timeout_seconds": 1}, cwd=root)["state"] == "tool_timeout"
    del os.environ["COOP_TEST_BUILD"]
    for bad in ({"command": "build", "config": str(config), "timeout_seconds": 0}, {"command": "build", "config": str(config), "timeout_seconds": True},
                {"command": "build", "config": str(config), "max_age_days": 1}, {"command": "refresh", "config": str(config), "timeout_seconds": 5}):
        assert ld.execute(bad, cwd=root)["state"] == "input_invalid", bad
    assert ld.execute({"command": "build", "config": str(root / "other.yml")}, cwd=root)["state"] == "config_unavailable"
    os.environ[ld.TOOL_ENV] = str(Path(tmp) / "missing")
    assert ld.execute({"command": "build", "config": str(config)}, cwd=root)["state"] == "tool_unavailable"

# --- what the waiter runs (static, beside the process fixtures) ----------------------------
script = (ROOT / "scripts" / "docs-refresh.ps1").read_text(encoding="utf-8-sig")
code = "\n".join(line for line in script.splitlines() if not line.lstrip().startswith("#"))
for word in (r"\bgit\b", r"&\s*pi\b", r"\bpi\s+-", r"sql_query", r"sql_impact", r"sqlsc", r"catalog_snapshot", r"schema_compare", r"Invoke-Expression", r"\biex\b", r"&\s*['\"]?coop-data-doc", r"FileName\s*=\s*['\"]?coop-data-doc"):
    assert not re.search(word, code, re.IGNORECASE), f"docs-refresh.ps1 runs {word}"
helpers = set(re.findall(r"lib\\\\?([a-z_]+\.py)", code))
assert helpers == {"live_docs.py"}, helpers
assert re.findall(r"command\s*=\s*'(\w+)'", code) == ["refresh", "build"], "the run asks live_docs.py for refresh, then build"
builder = (ROOT / "lib" / "live_docs.py").read_text(encoding="utf-8")
build_src = builder[builder.index("def build("): builder.index("# --- what changed in dev")]
assert re.findall(r"\[find_tool\(\), ([^\]]*)\]", build_src) == ['"build", "--non-interactive"'], "build runs coop-data-doc build only"

print("✓ daily lineage refresh: dev_is_prod (prod entries, named sets, Fabric ids, the word), build (files changed, nothing else run), the waiter runs only live_docs.py")

#!/usr/bin/env python3
"""Regressions from the v0.35.0 code review: the dependency-free YAML reader,
the contract's `enabled: false` without PyYAML, the catalog snapshot's manifest
containment, and the fleet digest's JSON config."""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "lib"))
sys.path.insert(0, str(ROOT / "scripts"))
import _yaml  # noqa: E402
import catalog_snapshot  # noqa: E402
import warehouse_mcp  # noqa: E402



def fallback(text: str):
    """The dependency-free reader, whatever this machine has installed."""
    return _yaml._load_fallback(text)


# 1. An apostrophe inside an unquoted value is a plain character, so the comment
#    after it is still stripped and flow lists still split.
doc = fallback("profile:\n  client: Aaron's Apiaries  # the client\nnames: [Aaron's, Bob, 'c, d']\nk: 'it''s'\n\"q k\": v\n")
assert doc["profile"]["client"] == "Aaron's Apiaries", doc
assert doc["names"] == ["Aaron's", "Bob", "c, d"], doc
assert doc["k"] == "it's" and doc["q k"] == "v", doc

# 2. Double-quoted escapes decode the way PyYAML does.
doc = fallback('path: "C:\\\\work\\\\x"\nnote: "a\\"b"\n')
assert doc["path"] == "C:\\work\\x" and doc["note"] == 'a"b', doc

# 3. `mcp.fabric_sqlendpoint.enabled: false` disables the managed server even
#    when the reader keeps `false` as text.
assert warehouse_mcp.project_sqlendpoint_enabled({"mcp": {"fabric_sqlendpoint": {"enabled": "false"}}}) is False
assert warehouse_mcp.project_sqlendpoint_enabled({"mcp": {"fabric_sqlendpoint": {"enabled": False}}}) is False
assert warehouse_mcp.project_sqlendpoint_enabled({"mcp": {"fabric_sqlendpoint": {"enabled": "true"}}}) is True
assert warehouse_mcp.project_sqlendpoint_enabled({}) is True

# 4. A manifest naming a path outside the snapshot folder deletes nothing there;
#    reserved Windows device names are never used as file names.
with tempfile.TemporaryDirectory() as td:
    base = Path(td)
    folder = base / "snapshot"
    (folder / "dbo").mkdir(parents=True)
    inside = folder / "dbo" / "old.sql"
    inside.write_text("x", encoding="utf-8")
    outside = base / "elsewhere.sql"
    outside.write_text("keep", encoding="utf-8")
    catalog_snapshot._remove_previous_files(folder, {"files": ["dbo/old.sql", str(outside), "../elsewhere.sql", "dbo/../../elsewhere.sql"]})
    assert not inside.exists(), "listed file inside the folder is removed"
    assert outside.exists(), "a path outside the snapshot folder is never deleted"
assert catalog_snapshot._safe("Customer") and not catalog_snapshot._safe("CON") and not catalog_snapshot._safe("com1")

# 5. fleet-digest reads ~/.coop/config as the JSON onboard.py writes.
with tempfile.TemporaryDirectory() as td:
    pub = Path(td) / "published"
    pub.mkdir()
    cfg = Path(td) / "config"
    cfg.write_text(json.dumps({"fleet": {"publish_dir": str(pub)}}, indent=2) + "\n", encoding="utf-8")
    run = subprocess.run([sys.executable, str(ROOT / "scripts" / "fleet-digest.py"), "--config", str(cfg), "--format", "md"], capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    assert "publish_dir not configured" not in run.stderr

# 6. The SQL helpers answer in UTF-8 whatever the console code page is.
env = dict(os.environ, PYTHONIOENCODING="cp1252", COOP_PROJECT_YML=str(ROOT / "nope.yml"))
run = subprocess.run([sys.executable, str(ROOT / "lib" / "sql_query.py")], input='{"query":"SELECT TOP (1) \'Łódź\' AS n"}'.encode("utf-8"), capture_output=True, env=env, cwd=tempfile.gettempdir())
assert run.stdout.startswith(b"{"), run.stderr
json.loads(run.stdout.decode("utf-8"))

print("  OK  review fixes: YAML apostrophes and escapes, enabled: false, manifest containment, JSON fleet config, UTF-8 helper output")

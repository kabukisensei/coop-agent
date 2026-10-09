#!/usr/bin/env python3
"""Regressions from the v0.35.0 code review: the dependency-free YAML reader
(coop's one parser: core-schema scalar coercion, never PyYAML), the contract's
`enabled: false`, the catalog snapshot's manifest containment, and the fleet
digest's JSON config."""
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

# 2b. One parser everywhere: load() never imports PyYAML, and plain scalars are
#     coerced like the YAML 1.2 core schema (bool / None / int / float), quoted
#     ones stay text, and the `get` CLI prints a bool as true / false.
assert "yaml" not in sys.modules, "importing _yaml must not import PyYAML"
with tempfile.TemporaryDirectory() as td:
    f = Path(td) / "t.yml"
    f.write_text(
        "a: true\nb: False\nc: TRUE\nd: null\ne: ~\nf:\ng: 12\nh: -3\ni: 0o17\nj: 0x1F\n"
        "k: 1.5\nl: .5\nm: 1e3\nq: '12'\nr: \"true\"\ns: yes\nt: 0.79.0\nu: main\n"
        "v: [1, true, null, x]\nw: {k: 2.0, q: 'null'}\nx: 1_000\ny: 0ab1c2d3-0000-4000-8000-000000000000\n"
        "tools:\n  fabric_cli:\n    enabled: false\n",
        encoding="utf-8",
    )
    doc = _yaml.load(str(f))
    assert "yaml" not in sys.modules, "_yaml.load() must not import PyYAML"
    assert doc["a"] is True and doc["b"] is False and doc["c"] is True, doc
    assert doc["d"] is None and doc["e"] is None and doc["f"] is None, doc
    assert doc["g"] == 12 and doc["h"] == -3 and doc["i"] == 15 and doc["j"] == 31, doc
    assert all(isinstance(doc[k], int) and not isinstance(doc[k], bool) for k in "ghij"), doc
    assert doc["k"] == 1.5 and doc["l"] == 0.5 and doc["m"] == 1000.0, doc
    assert all(isinstance(doc[k], float) for k in "klm"), doc
    assert doc["q"] == "12" and doc["r"] == "true", doc
    assert doc["s"] == "yes" and doc["t"] == "0.79.0" and doc["u"] == "main" and doc["x"] == "1_000", doc
    assert doc["y"] == "0ab1c2d3-0000-4000-8000-000000000000", doc
    assert doc["v"] == [1, True, None, "x"] and doc["v"][1] is True and doc["v"][2] is None, doc
    assert doc["w"] == {"k": 2.0, "q": "null"} and isinstance(doc["w"]["k"], float), doc
    assert _yaml.loads(f.read_text(encoding="utf-8")) == doc
    assert _yaml.loads("") == {}
    # The CLI (Get-CoopYamlValue / Test-CoopToolEnabled in lib/common.ps1 compare
    # against these strings), run with -S -I so PyYAML cannot be on the path.
    cli = [sys.executable, "-S", "-I", str(ROOT / "lib" / "_yaml.py")]
    def get(key, default="MISS"):
        return subprocess.run(cli + ["get", str(f), key, default], capture_output=True, text=True, check=True).stdout
    assert get("a") == "true" and get("b") == "false", (get("a"), get("b"))
    assert get("tools.fabric_cli.enabled") == "false"
    assert get("g") == "12" and get("k") == "1.5" and get("t") == "0.79.0" and get("y") == doc["y"]
    assert get("d") == "MISS" and get("f") == "MISS" and get("v") == "MISS" and get("nope.key") == "MISS"
    assert get("r") == "true" and get("q") == "12"
    listed = subprocess.run(cli + ["list", str(f), "v"], capture_output=True, text=True, check=True).stdout.split("\n")
    assert listed[:3] == ["1", "True", "x"], listed

# 3. `mcp.fabric_sqlendpoint.enabled: false` disables the managed server: a plain
#    `false` arrives as a bool; a quoted one is text and still counts.
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

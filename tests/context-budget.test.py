#!/usr/bin/env python3
"""The context-budget split (FEATURES-DESIGN, context budget).

scripts/context-budget.py reads a `// coop:feature <key>` comment on the line
directly above a native tool's pi.registerTool call and reports two totals:
default-off (everything not behind a switch: what a fresh install sends) and
all-on (plus every switched tool). estimated_fixed_total_tokens is the all-on
total, the one scripts/check-context-budget.ps1 gates against 8,000 (the gate's
failure above the ceiling is checked in tests/run.ps1). Every marker names a
feature from lib/features.mjs, and sql_source carries one.

Offline; reads only the repository.
"""

from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "lib"))
passed = 0

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass


def ok(label: str) -> None:
    global passed
    passed += 1
    print(f"  ✓ {label}")


def load():
    spec = importlib.util.spec_from_file_location("context_budget", ROOT / "scripts" / "context-budget.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


budget = load()

SAMPLE = """
  pi.registerTool({
    name: "always",
    description: "abcd",
    promptSnippet: "ef",
    promptGuidelines: ["gh", "ij"],
  });
  // Registered only while the switch is on.
  // coop:feature comments
  if (on()) pi.registerTool({
    name: "switched",
    description: "0123456789",
    promptGuidelines: ["xy"],
  });
  // coop:feature history

  pi.registerTool({ name: "gap", description: "zz" });
  // coop:feature
  pi.registerTool({ name: "empty", description: "q" });
"""

blocks = budget.tool_blocks_with_markers(SAMPLE)
assert [(b["name"], b["feature"]) for b in blocks] == [("always", ""), ("switched", "comments"), ("gap", ""), ("empty", "")], blocks
ok("a marker counts only on the line directly above the registerTool call (a blank line or a bare marker does not)")

chars, count = budget.collect_tool_metadata_chars(SAMPLE)
assert (chars, count) == (4 + 2 + 2 + 2 + 10 + 2 + 2 + 1, 4), (chars, count)
ok("collect_tool_metadata_chars still counts every tool (the all-on view)")

with_crlf = SAMPLE.replace("\n", "\r\n")
assert [(b["name"], b["feature"]) for b in budget.tool_blocks_with_markers(with_crlf)] == [(b["name"], b["feature"]) for b in blocks]
ok("a Windows (CRLF) checkout reads the same markers")

# The real measurement.
run = subprocess.run([sys.executable, str(ROOT / "scripts" / "context-budget.py"), "--json"], cwd=ROOT, capture_output=True, text=True, check=True)
data = json.loads(run.stdout)
tools = data["categories"]["native_tools"]
switched = tools["switched"]
assert data["estimated_fixed_total_tokens"] == data["estimated_all_on_total_tokens"], data
assert tools["default_off_schema_chars"] + sum(t["schema_chars"] for t in switched) == tools["schema_chars"]
assert data["default_off_total_chars"] == data["total_chars"] - sum(t["schema_chars"] for t in switched)
assert data["estimated_default_off_total_tokens"] == budget.estimate_tokens(data["default_off_total_chars"])
assert data["estimated_default_off_total_tokens"] < data["estimated_all_on_total_tokens"] <= 8000, data
ok(f"two totals: default-off {data['estimated_default_off_total_tokens']} and all-on {data['estimated_all_on_total_tokens']} tokens (the gated one, at most 8000)")

assert [(t["name"], t["feature"]) for t in switched] == [("sql_source", "sql-source")], switched
ok("sql_source is the one tool behind a switch (sql-source)")

features_src = (ROOT / "lib" / "features.mjs").read_text(encoding="utf-8")
known = set(re.findall(r'\{ key: "([a-z-]+)", label:', features_src))
assert known == {"instructions", "history", "comments", "docs-refresh", "sql-source"}, known
source = (ROOT / "extensions" / "coop-tools" / "index.ts").read_text(encoding="utf-8")
markers = re.findall(r"^\s*//\s*coop:feature\s+(\S+)\s*$", source, re.MULTILINE)
assert markers and all(m in known for m in markers), markers
ok("every coop:feature marker names a feature from lib/features.mjs")
# A marker that is not directly above its registerTool call (above an `if`, or
# after a blank line) names a real feature but does not count: the tool would
# stay in the default-off total. Every marker in the file must be one that counts.
assert len(markers) == len(switched), (markers, switched)
ok("every coop:feature marker in coop-tools counts (none misplaced)")

human = subprocess.run([sys.executable, str(ROOT / "scripts" / "context-budget.py")], cwd=ROOT, capture_output=True, text=True, check=True).stdout
assert "Estimated fixed total, default-off" in human and "Estimated fixed total, all-on" in human, human
assert "behind a switch      sql_source (sql-source)" in human, human
ok("the human report prints both totals and the switched tool")

print(f"✓ context-budget split tests passed ({passed})")

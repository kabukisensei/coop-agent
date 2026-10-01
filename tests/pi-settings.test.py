#!/usr/bin/env python3
"""Contract tests for Coop's narrow Pi settings merge."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parent.parent
HELPER = ROOT / "lib" / "pi_settings.py"


def run(path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(HELPER), "ensure-quiet-startup", str(path)],
        text=True,
        capture_output=True,
        check=False,
    )


with tempfile.TemporaryDirectory() as raw_tmp:
    tmp = Path(raw_tmp)

    fresh = tmp / "fresh" / "settings.json"
    result = run(fresh)
    assert result.returncode == 0, result.stderr
    assert json.loads(fresh.read_text()) == {"quietStartup": True}
    print("  PASS creates an isolated settings file with quietStartup enabled")

    existing = tmp / "existing.json"
    original = {
        "packages": ["npm:context-mode@1.0.169"],
        "theme": "dark",
        "quietStartup": False,
        "futureSetting": {"preserve": True},
    }
    existing.write_text(json.dumps(original), encoding="utf-8")
    result = run(existing)
    assert result.returncode == 0, result.stderr
    merged = json.loads(existing.read_text())
    assert merged == {**original, "quietStartup": True}
    print("  PASS enables quietStartup while preserving packages and unknown settings")

    before = existing.read_bytes()
    result = run(existing)
    assert result.returncode == 0, result.stderr
    assert existing.read_bytes() == before
    print("  PASS converged settings are left byte-for-byte unchanged")

    invalid = tmp / "invalid.json"
    invalid.write_text("{not json", encoding="utf-8")
    before = invalid.read_bytes()
    result = run(invalid)
    assert result.returncode == 2
    assert invalid.read_bytes() == before
    print("  PASS invalid settings fail without overwriting the original")

    # ensure-coop-footer: pi-better-openai's footer.mode must not replace coop's footer (#203)
    def footer(path: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(HELPER), "ensure-coop-footer", str(path)],
            text=True,
            capture_output=True,
            check=False,
        )

    fresh_footer = tmp / "fresh" / "extensions" / "pi-better-openai.json"
    result = footer(fresh_footer)
    assert result.returncode == 0, result.stderr
    assert json.loads(fresh_footer.read_text()) == {"footer": {"mode": "status"}}
    print("  PASS creates pi-better-openai config in status footer mode")

    replace = tmp / "replace.json"
    original = {
        "persistState": True,
        "active": False,
        "footer": {"mode": "replace"},
        "pets": {"enabled": False, "slug": ""},
        "futureKey": [1, 2],
    }
    replace.write_text(json.dumps(original), encoding="utf-8")
    result = footer(replace)
    assert result.returncode == 0, result.stderr
    merged = json.loads(replace.read_text())
    assert merged == {**original, "footer": {"mode": "status"}}
    print("  PASS replace mode becomes status while every other key is preserved")

    before = replace.read_bytes()
    result = footer(replace)
    assert result.returncode == 0, result.stderr
    assert replace.read_bytes() == before
    print("  PASS status mode is left byte-for-byte unchanged")

    off = tmp / "off.json"
    off.write_text(json.dumps({"footer": {"mode": "off"}}), encoding="utf-8")
    before = off.read_bytes()
    result = footer(off)
    assert result.returncode == 0, result.stderr
    assert off.read_bytes() == before
    print("  PASS a deliberate off mode is respected")

print("  8 Pi settings tests passed")

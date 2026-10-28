#!/usr/bin/env python3
"""One way to run the pinned `coop-schema-compare` command (suite review 2026-10-26, pick 1).

coop ships no compare engine of its own: the schema compare and the catalog
snapshot are the `coop-schema-compare` package at the version
`config/release-manifest.json` pins (installed by `coop install` with pipx, the
window package carries the wheel). lib/schema_compare.py and
lib/catalog_snapshot.py keep coop's part (the contract's sides, the identity
pinning, the per-client choices, the output folders) and hand the rest to one
child process started here with `--json`.

The executable is `COOP_SCHEMA_COMPARE_BIN` when set (the tests point it at a
stub; a machine with an unusual install may too), else `coop-schema-compare` on
PATH, else the copy in pipx's bin folder (`PIPX_BIN_DIR`, else `~/.local/bin`),
the place `coop install` links. A token for a live side travels only in the
child's environment (`SQL_ACCESS_TOKEN`, the variable the package reads), never
on its command line, and the package prints no credential, host or exception
text, so nothing here does either.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
from pathlib import Path
from typing import Any

TOOL = "coop-schema-compare"
TOOL_ENV = "COOP_SCHEMA_COMPARE_BIN"
TOKEN_ENV = "SQL_ACCESS_TOKEN"
# Under the 300 s the coop-tools extension allows a snapshot or a compare.
TIMEOUT_SECONDS = 280
MAX_OUTPUT_CHARS = 4_000_000


def result(state: str, **details: Any) -> dict[str, Any]:
    return {"ok": state == "ok", "state": state, **details}


def _pipx_bin_dirs() -> list[Path]:
    out: list[Path] = []
    configured = os.environ.get("PIPX_BIN_DIR", "")
    if configured:
        out.append(Path(configured))
    out.append(Path.home() / ".local" / "bin")
    return out


def find_tool() -> str:
    """The executable's path, or '' when it is not installed."""
    override = os.environ.get(TOOL_ENV, "")
    if override:
        return override if Path(override).is_file() else ""
    found = shutil.which(TOOL)
    if found:
        return found
    for folder in _pipx_bin_dirs():
        for name in (TOOL, TOOL + ".exe"):
            candidate = folder / name
            if candidate.is_file():
                return str(candidate)
    return ""


# The package process while it runs, so a termination of this helper ends it too.
_running: list[subprocess.Popen[str]] = []


class _forwarding_termination:
    """While the package runs, SIGTERM (what coop's cancel sends on POSIX; Windows has
    no handler to install, there the caller ends the whole tree) kills the package
    first and then ends this helper with the conventional 128 + 15 (#477). Outside
    the main thread, or where the signal cannot be handled, nothing is installed."""

    def __enter__(self) -> None:
        self.previous = None
        try:
            self.previous = signal.signal(signal.SIGTERM, self._terminate)
        except (ValueError, OSError, AttributeError):
            self.previous = None

    def __exit__(self, *exc: object) -> None:
        if self.previous is not None:
            try:
                signal.signal(signal.SIGTERM, self.previous)
            except (ValueError, OSError):
                pass

    @staticmethod
    def _terminate(signum: int, frame: object) -> None:
        for proc in _running:
            try:
                proc.kill()
            except OSError:
                pass
        os._exit(128 + int(signum))


def run_tool(args: list[str], *, env: dict[str, str] | None = None) -> dict[str, Any]:
    """Run `coop-schema-compare <args> --json` and return its result object.

    States of this layer (never the package's): `tool_unavailable` (not
    installed), `tool_timeout`, `tool_failed` (no JSON answer; `exit_code` says
    how it ended). A package failure comes back as the package wrote it
    (`ok: false` and its `state`)."""
    tool = find_tool()
    if not tool:
        return result("tool_unavailable", tool=TOOL)
    merged = {**os.environ, **(env or {}), "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    try:
        with _forwarding_termination(), subprocess.Popen(
            [tool, *args, "--json"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=merged,
        ) as proc:
            _running.append(proc)
            try:
                stdout, _ = proc.communicate(timeout=TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()
                return result("tool_timeout", tool=TOOL)
            finally:
                _running.clear()
            returncode = proc.returncode
    except OSError:
        return result("tool_unavailable", tool=TOOL)
    text = (stdout or "")[-MAX_OUTPUT_CHARS:].strip()
    line = text.rsplit("\n", 1)[-1] if text else ""
    try:
        data = json.loads(line)
    except ValueError:
        data = None
    if not isinstance(data, dict) or not isinstance(data.get("state"), str):
        return result("tool_failed", tool=TOOL, exit_code=returncode)
    data["ok"] = data.get("ok") is True and data["state"] == "ok"
    return data


def version() -> str:
    """The installed package's version ('' when it is not installed or does not answer)."""
    tool = find_tool()
    if not tool:
        return ""
    try:
        completed = subprocess.run([tool, "--version"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, check=False)
    except (OSError, subprocess.SubprocessError):
        return ""
    words = (completed.stdout or "").split()
    return words[-1] if completed.returncode == 0 and words else ""

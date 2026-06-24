#!/usr/bin/env python3
"""Align coop's isolated Pi extension tree to the Pi agent's own pi-ai / pi-tui.

coop installs its core Pi extensions into an ISOLATED npm tree
(``~/.coop/agent/npm``). Those extensions are loaded INTO the running Pi agent, so
they must share ONE ``@earendil-works/pi-ai`` and ``@earendil-works/pi-tui`` with
the agent — the same instance the agent itself uses.

Left to npm's default resolution that does not hold: ``pi-mcp-adapter`` declares a
hard ``@earendil-works/pi-ai: ^0.74.0`` dependency, so npm installs and HOISTS a
concrete pi-ai 0.74.x; ``pi-web-access`` (0.12+) declares pi-ai only as a ``*`` peer
and resolves against that hoisted 0.74.x — which has no ``./compat`` export, so its
``import "@earendil-works/pi-ai/compat"`` fails against a 0.80 agent. (Same story for
pi-tui.) See the coop-agent issue "pi-ai / pi-tui version skew".

The fix is to write an npm ``overrides`` block into the isolated tree's
``package.json`` pinning pi-ai + pi-tui to the agent's OWN version, then reinstall.
The agent, pi-ai and pi-tui publish in lockstep (identical version lists on the
registry), so pinning to ``pi --version`` always resolves. ``pi-mcp-adapter`` keeps
working because it only uses stable top-level exports present across 0.74 -> 0.80.

This helper is stdlib-only (a fresh machine's python may lack any deps) and is
called by both ``scripts/sync.sh`` and ``scripts/sync.ps1`` (and the doctors).

Usage:
    python3 _extdeps.py align <agent_dir> <agent_version> [--check]

``<agent_dir>`` is coop's isolated Pi agent dir (the parent of ``npm/``).
``<agent_version>`` is the agent semver, e.g. ``0.80.2`` (from ``pi --version``).

``--check`` is read-only: it never writes package.json (used by ``coop doctor``).

Prints ONE space-separated line to stdout (``-`` for missing values):
    <tree_pi_ai> <tree_pi_tui> <override_pi_ai> <override_pi_tui> <changed> <aligned>
  where <changed> and <aligned> are ``1`` or ``0``.

Exit codes (so the shell can branch without parsing):
    0   installed tree already matches the pin — no reinstall needed
    10  reinstall recommended (installed tree doesn't match the pin)
    11  tree matches the pin, but the pin pre-dates pi-ai's ``/compat`` (< 0.80.1)
        while an installed pi-web-access needs it — the AGENT is too old; aligning
        can't help, so warn (don't reinstall) and tell the user to update the agent
    2   nothing to do (no npm tree / package.json / unreadable) — silent
    3   bad usage
"""
import json
import os
import sys

PI_AI = "@earendil-works/pi-ai"
PI_TUI = "@earendil-works/pi-tui"
PI_WEB_ACCESS = "pi-web-access"

# pi-ai first shipped the ``./compat`` subpath export at 0.80.1; pi-web-access began
# importing it around 0.11. So a pin BELOW 0.80.1 cannot satisfy a pi-web-access AT
# OR ABOVE 0.11 no matter how cleanly we align — that's an agent-too-old situation
# the user must resolve by updating Pi, not by re-pinning extensions.
PI_AI_COMPAT_FLOOR = (0, 80, 1)
PWA_COMPAT_FLOOR = (0, 11, 0)


def _ver_tuple(s):
    """('0.80.2') -> (0, 80, 2); tolerant of pre-release/build suffixes. None if unparseable."""
    if not isinstance(s, str):
        return None
    core = s.strip().lstrip("v").split("+")[0].split("-")[0]
    parts = core.split(".")
    try:
        return tuple(int(p) for p in parts[:3]) if parts and parts[0] != "" else None
    except ValueError:
        return None


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _installed_version(node_modules, pkg):
    """Top-level (hoisted) installed version of <pkg>, or None.

    The hoisted top-level copy is the one peer-only dependents (pi-web-access)
    resolve against, so it is the version that decides whether ``/compat`` is
    present — exactly the copy the skew is about.
    """
    data = _read_json(os.path.join(node_modules, *pkg.split("/"), "package.json"))
    if isinstance(data, dict):
        v = data.get("version")
        if isinstance(v, str) and v:
            return v
    return None


def _write_json(path, data):
    # Deterministic: 2-space indent, preserve key order, trailing newline, LF.
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def align(agent_dir, version, check=False):
    npm_dir = os.path.join(agent_dir, "npm")
    pkg_path = os.path.join(npm_dir, "package.json")
    node_modules = os.path.join(npm_dir, "node_modules")

    data = _read_json(pkg_path)
    if not isinstance(data, dict):
        return 2, None  # no installed extension tree yet (or unreadable) — nothing to do

    overrides = data.get("overrides")
    if not isinstance(overrides, dict):
        overrides = {}

    changed = overrides.get(PI_AI) != version or overrides.get(PI_TUI) != version
    if changed and not check:
        overrides[PI_AI] = version
        overrides[PI_TUI] = version
        data["overrides"] = overrides
        _write_json(pkg_path, data)
    elif check:
        changed = False  # read-only mode never claims a write

    ovr_ai = overrides.get(PI_AI) if isinstance(overrides.get(PI_AI), str) else None
    ovr_tui = overrides.get(PI_TUI) if isinstance(overrides.get(PI_TUI), str) else None

    tree_ai = _installed_version(node_modules, PI_AI)
    tree_tui = _installed_version(node_modules, PI_TUI)
    aligned = tree_ai == version and tree_tui == version

    # Would aligning even help? If an installed pi-web-access needs the ``/compat``
    # export but the pin (agent version) pre-dates it, the agent itself is too old —
    # re-pinning the tree can't fix the crash. Surface that distinctly (rc 11).
    pwa = _ver_tuple(_installed_version(node_modules, PI_WEB_ACCESS))
    pin = _ver_tuple(version)
    agent_too_old = (
        pwa is not None
        and pwa >= PWA_COMPAT_FLOOR
        and pin is not None
        and pin < PI_AI_COMPAT_FLOOR
    )

    line = "{} {} {} {} {} {}".format(
        tree_ai or "-",
        tree_tui or "-",
        ovr_ai or "-",
        ovr_tui or "-",
        "1" if changed else "0",
        "1" if aligned else "0",
    )
    # Branch on the installed tree, not on `changed`: if the versions already match
    # the pin there is nothing to reinstall (the overrides we just wrote are for
    # future protection). 10 = fix the versions; 11 = aligned but agent too old.
    if not aligned:
        rc = 10
    elif agent_too_old:
        rc = 11
    else:
        rc = 0
    return rc, line


def main(argv):
    args = [a for a in argv[1:] if a != "--check"]
    check = "--check" in argv[1:]
    if len(args) < 3 or args[0] != "align":
        sys.stderr.write(
            "usage: _extdeps.py align <agent_dir> <agent_version> [--check]\n"
        )
        return 3
    agent_dir, version = args[1], args[2]
    if not version:
        return 3
    rc, line = align(agent_dir, version, check=check)
    if line is not None:
        sys.stdout.write(line + "\n")
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv))

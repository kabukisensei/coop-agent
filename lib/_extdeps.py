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
    <tree_pi_ai> <tree_pi_tui> <override_pi_ai> <override_pi_tui> <changed> <aligned> <required_floor> <offending_ext>
  where <changed> and <aligned> are ``1`` or ``0``. ``<required_floor>`` is the
  highest pi-ai version any installed extension needs (or ``-``), and
  ``<offending_ext>`` is the extension that drives it (or ``-``). Fields 1-6 are
  unchanged for backward compatibility; 7-8 are appended.

Exit codes (so the shell can branch without parsing):
    0   installed tree already matches the pin — no reinstall needed
    10  reinstall recommended (installed tree doesn't match the pin)
    11  an installed extension needs a NEWER pi-ai than the agent provides — the
        AGENT is too old; aligning the extension tree can't help, so warn (don't
        reinstall) and tell the user to update the agent. Takes precedence over 10:
        if the agent is too old, no reinstall would fix it anyway.
    2   nothing to do (no npm tree / package.json / unreadable) — silent
    3   bad usage
"""
import json
import os
import re
import sys

PI_AI = "@earendil-works/pi-ai"
PI_TUI = "@earendil-works/pi-tui"
PI_WEB_ACCESS = "pi-web-access"

# pi-ai first shipped the ``./compat`` subpath export at 0.80.1; pi-web-access began
# importing it around 0.11, but declares pi-ai only as a ``*`` peer — so its need is
# read from pi-web-access's OWN version, not a pi-ai range. Every other extension
# (e.g. pi-hermes-memory: ``@earendil-works/pi-ai: ^0.80.2``) states its floor as a
# concrete dependency range, which we read directly below. A pin under the resulting
# floor is an agent-too-old situation the user must fix by updating Pi.
PI_AI_COMPAT_FLOOR = (0, 80, 1)
PWA_COMPAT_FLOOR = (0, 11, 0)


def _ver_tuple(s):
    """('0.80.2') -> (0, 80, 2); tolerant of pre-release/build suffixes. None if unparseable.

    Always returns a 3-tuple, padding short versions with zeros ('0.11' -> (0,11,0)),
    so comparisons against 3-tuple floors are sound even if a version omits its patch."""
    if not isinstance(s, str):
        return None
    core = s.strip().lstrip("v").split("+")[0].split("-")[0]
    parts = core.split(".")
    if not parts or parts[0] == "":
        return None
    try:
        nums = [int(p) for p in parts[:3]]
    except ValueError:
        return None
    while len(nums) < 3:
        nums.append(0)
    return tuple(nums)


def _range_floor(spec):
    """Lowest pi-ai version a dependency range REQUIRES, as a (maj,min,pat) tuple.

    Conservative on purpose — this gates a launch guard, so a false "too old" is
    worse than a miss. We only extract a floor from simple lower-bound ranges
    (``^0.80.2``, ``~0.80.2``, ``>=0.80.1``, ``0.80.2``). Anything that imposes no
    real lower bound — ``*`` / ``latest`` / ``x`` / a pure upper bound (``<0.81``) /
    ``workspace:`` / ``file:`` / a URL — returns None (no floor)."""
    if not isinstance(spec, str):
        return None
    s = spec.strip()
    if not s or s in ("*", "latest", "x", "X"):
        return None
    if s[0] == "<":                       # pure upper bound — no lower floor
        return None
    if not re.match(r"^[\^~>=v0-9]", s):  # workspace:/file:/link:/git/http/etc.
        return None
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", s)
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)))


def _required_pi_ai_floor(node_modules):
    """Highest pi-ai version any installed extension needs: (floor, ext, floor_str).

    Scans every top-level package in the agent's extension ``node_modules`` for a
    ``@earendil-works/pi-ai`` entry in its dependencies/peerDependencies and keeps the
    max lower bound. pi-web-access is a special case: it declares pi-ai as ``*`` but
    its own version (>= 0.11) implies the ``/compat`` floor (0.80.1). Returns
    (None, None, None) when nothing imposes a floor."""
    best = None        # (maj,min,pat)
    best_ext = None
    if not os.path.isdir(node_modules):
        return None, None, None

    def _consider(floor, ext):
        nonlocal best, best_ext
        if floor is not None and (best is None or floor > best):
            best, best_ext = floor, ext

    # Enumerate installed packages: top-level dirs plus one level into @scopes.
    pkg_dirs = []
    try:
        for name in os.listdir(node_modules):
            if name.startswith(".") or name == ".bin":
                continue
            full = os.path.join(node_modules, name)
            if name.startswith("@"):
                if os.path.isdir(full):
                    for sub in os.listdir(full):
                        pkg_dirs.append(os.path.join(full, sub))
            else:
                pkg_dirs.append(full)
    except OSError:
        return None, None, None

    for pdir in pkg_dirs:
        data = _read_json(os.path.join(pdir, "package.json"))
        if not isinstance(data, dict):
            continue
        ext_name = data.get("name") or os.path.basename(pdir)
        for field in ("dependencies", "peerDependencies"):
            deps = data.get(field)
            if isinstance(deps, dict):
                _consider(_range_floor(deps.get(PI_AI)), ext_name)
        # pi-web-access encodes its /compat need in its OWN version, not a pi-ai range.
        if ext_name == PI_WEB_ACCESS:
            pwa = _ver_tuple(data.get("version"))
            if pwa is not None and pwa >= PWA_COMPAT_FLOOR:
                _consider(PI_AI_COMPAT_FLOOR, PI_WEB_ACCESS)

    floor_str = ".".join(str(p) for p in best) if best else None
    return best, best_ext, floor_str


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

    # Would aligning even help? Compute the highest pi-ai any installed extension
    # needs. If the agent (pin) is below that floor, the agent itself is too old —
    # re-pinning/reinstalling the tree can only drag pi-ai DOWN to the agent, so it
    # can't fix the crash. Surface that distinctly (rc 11) and name the extension.
    floor, offending_ext, floor_str = _required_pi_ai_floor(node_modules)
    pin = _ver_tuple(version)
    agent_too_old = floor is not None and pin is not None and pin < floor

    line = "{} {} {} {} {} {} {} {}".format(
        tree_ai or "-",
        tree_tui or "-",
        ovr_ai or "-",
        ovr_tui or "-",
        "1" if changed else "0",
        "1" if aligned else "0",
        floor_str if agent_too_old else "-",
        offending_ext if agent_too_old else "-",
    )
    # agent-too-old takes precedence: if the agent can't satisfy an installed
    # extension, no amount of reinstalling the tree will help (it would just pin
    # pi-ai to the too-old agent), so don't recommend a pointless reinstall (10) —
    # report 11 so callers tell the user to update Pi. Otherwise branch on the
    # installed tree: 10 = fix the versions (reinstall); 0 = already aligned.
    if agent_too_old:
        rc = 11
    elif not aligned:
        rc = 10
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

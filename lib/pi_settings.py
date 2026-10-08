#!/usr/bin/env python3
"""Manage the small set of Pi settings owned by Coop.

The isolated Pi settings file also contains user choices and package state, so
updates must merge narrowly instead of replacing the document.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import stat
import sys
import tempfile


def _read_json_object(path: Path) -> tuple[dict, int | None]:
    """Read a JSON object file, returning it with its current mode (None if absent)."""

    if not path.exists():
        return {}, None
    existing_mode = stat.S_IMODE(path.stat().st_mode)
    try:
        document = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read {path}: {exc}") from exc
    if not isinstance(document, dict):
        raise ValueError(f"cannot update {path}: root must be a JSON object")
    return document, existing_mode


def _write_json_object(path: Path, document: dict, existing_mode: int | None) -> None:
    """Replace `path` atomically, keeping its mode (0600 for a new file)."""

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(document, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.chmod(tmp, existing_mode if existing_mode is not None else 0o600)
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def ensure_quiet_startup(path: Path) -> bool:
    """Set quietStartup without disturbing any other Pi setting.

    Returns True when the file changed and False when it was already converged.
    """

    settings, existing_mode = _read_json_object(path)
    if settings.get("quietStartup") is True:
        return False
    settings["quietStartup"] = True
    _write_json_object(path, settings, existing_mode)
    return True


# pi-better-openai's own footer defaults to `footer.mode: "replace"`, which calls
# ctx.ui.setFooter and wipes coop-powerline's footer on session_start (issue #203).
# coop owns the footer: it surfaces pi-better-openai's plan-usage text through
# footerData.getExtensionStatuses(), which is exactly what "status" mode emits.
COOP_FOOTER_MODES = ("status", "off")


def ensure_coop_footer(path: Path) -> bool:
    """Keep pi-better-openai in status-line mode so coop's own footer survives.

    `path` is pi-better-openai's global config (`<agent dir>/extensions/
    pi-better-openai.json`). Only `footer.mode` is touched: "replace" (its
    default) becomes "status"; a deliberate "off" is left alone, and every other
    key is preserved. Returns True when the file changed.
    """

    config, existing_mode = _read_json_object(path)
    footer = config.get("footer")
    if not isinstance(footer, dict):
        footer = {}
    if footer.get("mode") in COOP_FOOTER_MODES:
        return False
    config["footer"] = {**footer, "mode": "status"}
    _write_json_object(path, config, existing_mode)
    return True


# Pi 1.x ships a built-in MCP client next to pi-mcp-adapter. coop launches Pi
# with --no-mcp, so it never runs in a coop session; the settings entry keeps it
# off for anything else that reads this agent dir, and it is the entry
# pi-mcp-adapter would otherwise add itself on first start, with a notice.
BUILTINS_OFF = ("builtin:mcp", "builtin:codemode")


def ensure_builtins_off(path: Path) -> bool:
    """Keep `-builtin:mcp` and `-builtin:codemode` in Pi's `extensions` list, and
    no other entry for either.

    coop's own codemode (extensions/coop-codemode) replaces Pi's built-in one at
    launch; the entry keeps Pi from warning about the swap on every start.
    Every other entry and setting is preserved. Returns True when the file changed.
    """

    settings, existing_mode = _read_json_object(path)
    extensions = settings.get("extensions")
    if not isinstance(extensions, list):
        extensions = []
    kept = [e for e in extensions if not (isinstance(e, str) and e.lstrip("+!-") in BUILTINS_OFF)]
    wanted = kept + [f"-{name}" for name in BUILTINS_OFF]
    if extensions == wanted:
        return False
    settings["extensions"] = wanted
    _write_json_object(path, settings, existing_mode)
    return True


def ensure_packages(path: Path, sources: list[str]) -> bool:
    """Declare npm packages in `packages` the way `pi install` records them.

    The coop window package (master plan D1d) ships the extension tree already
    installed, so no `pi install` runs to write the `npm:<name>@<pin>` entries Pi
    loads packages from. Each source is such an entry: an existing entry for the
    same package (any pin) is replaced in place, a missing one is appended, and
    every other entry, git or local, is kept. Returns True when the file changed.
    """

    settings, existing_mode = _read_json_object(path)
    packages = settings.get("packages")
    if not isinstance(packages, list):
        packages = []
    wanted = {}
    for source in sources:
        if not source.startswith("npm:") or "@" not in source[4:].lstrip("@"):
            raise ValueError(f"not an npm package pin: {source}")
        wanted[_npm_package_name(source)] = source
    merged = []
    seen = set()
    for entry in packages:
        name = _npm_package_name(entry) if isinstance(entry, str) and entry.startswith("npm:") else None
        if name in wanted:
            if name not in seen:
                merged.append(wanted[name])
                seen.add(name)
            continue
        merged.append(entry)
    for name, source in wanted.items():
        if name not in seen:
            merged.append(source)
    if merged == packages:
        return False
    settings["packages"] = merged
    _write_json_object(path, settings, existing_mode)
    return True


def _npm_package_name(source: str) -> str:
    """`npm:@scope/name@1.2.3` -> `@scope/name`; `npm:name` -> `name`."""

    spec = source[len("npm:"):].strip()
    scoped = spec.startswith("@")
    body = spec[1:] if scoped else spec
    name = body.split("@", 1)[0]
    return ("@" + name) if scoped else name


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Converge Coop-owned Pi settings")
    parser.add_argument("command", choices=("ensure-quiet-startup", "ensure-coop-footer", "ensure-packages", "ensure-builtins-off"))
    parser.add_argument("settings", type=Path)
    parser.add_argument("sources", nargs="*", help="ensure-packages: npm:<name>@<pin> entries")
    args = parser.parse_args(argv)

    try:
        if args.command == "ensure-coop-footer":
            ensure_coop_footer(args.settings)
        elif args.command == "ensure-builtins-off":
            ensure_builtins_off(args.settings)
        elif args.command == "ensure-packages":
            ensure_packages(args.settings, list(args.sources))
        else:
            ensure_quiet_startup(args.settings)
    except ValueError as exc:
        print(f"pi-settings: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

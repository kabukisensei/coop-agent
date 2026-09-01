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


def ensure_quiet_startup(path: Path) -> bool:
    """Set quietStartup without disturbing any other Pi setting.

    Returns True when the file changed and False when it was already converged.
    """

    existing_mode: int | None = None
    if path.exists():
        existing_mode = stat.S_IMODE(path.stat().st_mode)
        try:
            settings = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ValueError(f"cannot read {path}: {exc}") from exc
        if not isinstance(settings, dict):
            raise ValueError(f"cannot update {path}: root must be a JSON object")
    else:
        settings = {}

    if settings.get("quietStartup") is True:
        return False

    settings["quietStartup"] = True
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(settings, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.chmod(tmp, existing_mode if existing_mode is not None else 0o600)
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Converge Coop-owned Pi settings")
    parser.add_argument("command", choices=("ensure-quiet-startup",))
    parser.add_argument("settings", type=Path)
    args = parser.parse_args(argv)

    try:
        ensure_quiet_startup(args.settings)
    except ValueError as exc:
        print(f"pi-settings: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

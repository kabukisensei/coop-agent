"""Shared path boundary for selected beta Python commands (no filesystem writes)."""

import os
import re
import stat
import sys
import hashlib
from pathlib import Path


def _beta_root() -> Path:
    root = os.environ.get("COOP_BETA_ROOT", "")
    if not root or not Path(root).is_absolute():
        raise ValueError("Beta project setup requires an owned root")
    return Path(root)


def _checked_path(value: str | Path, base: Path, scope: Path) -> Path:
    """Common lexical, link and alias checks for an explicitly selected scope."""
    if str(value).startswith("~") or "://" in str(value) or any(ord(char) < 32 for char in str(value)):
        raise ValueError("Beta project paths must stay inside owned scope")
    raw = Path(value)
    lexical = raw if raw.is_absolute() else base / raw
    if sys.platform == "win32" and (
        not re.fullmatch(r"[A-Za-z]:", lexical.drive)
        or any(re.search(r'[:*?"<>|]', part) or (part not in (".", "..") and part.endswith((".", " ")))
               or re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", part, re.I)
               for part in lexical.parts[1:])
    ):
        raise ValueError("Beta project paths must be unambiguous local paths")
    candidate = Path(os.path.abspath(lexical))
    try:
        candidate.relative_to(scope)
    except ValueError:
        raise ValueError("Beta project paths must stay inside owned workspaces") from None
    # Inspect the uncollapsed path too: link/../target must not hide the link.
    for entry in (lexical, *lexical.parents, candidate, *candidate.parents):
        try:
            info = entry.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError("Beta project paths cannot traverse links or reparse points")
        if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
            raise ValueError("Beta project files cannot have additional hardlink aliases")
    if os.path.normcase(str(candidate.resolve(strict=False))) != os.path.normcase(str(candidate)):
        raise ValueError("Beta project path resolution changes ownership")
    return candidate



def beta_workspace_path(value: str | Path, base: Path) -> Path:
    """Validate a workspace path without following links or reparse points."""
    return _checked_path(value, base, _beta_root() / "workspaces")


def beta_standard_path(value: str | Path, base: Path, domain: str) -> Path:
    """Read only a workspace standard or its verified immutable beta snapshot."""
    try:
        return beta_workspace_path(value, base)
    except ValueError:
        candidate = _checked_path(value, base, _beta_root() / "profile" / "standards" / "snapshots")
        match = re.fullmatch(r"([0-9a-f]{64})-" + re.escape(domain) + r"\.md", candidate.name)
        if not match or not candidate.is_file() or hashlib.sha256(candidate.read_bytes()).hexdigest() != match[1]:
            raise ValueError("Beta standards snapshot identity is invalid")
        return candidate


def beta_workspace_tree(value: str | Path, base: Path) -> Path:
    """Reject nested links before a companion reads or rebuilds a tree."""
    candidate = beta_workspace_path(value, base)
    if candidate.is_dir():
        def unreadable(_error):
            raise ValueError("Cannot inspect the complete beta workspace tree")
        for directory, dirs, files in os.walk(candidate, followlinks=False, onerror=unreadable):
            for name in dirs + files:
                beta_workspace_path(Path(directory) / name, candidate)
    return candidate

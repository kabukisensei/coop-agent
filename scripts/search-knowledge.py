#!/usr/bin/env python3
"""search-knowledge.py — deterministic local keyword search over configured
team-knowledge clones (stdlib only; no network, no index, no writes).

Invocation:
    <python> <install-path>/scripts/search-knowledge.py --query "partition"

Config: <COOP_DIR>/.coop/config when COOP_DIR is set, else <home>/.coop/config
(UTF-8 with optional BOM). Search runs ONLY when knowledge.enabled is boolean
true and knowledge.repos is a list. Each repo's local_path must be absolute or
lead with ~/ / ~\\ (tilde expands against the actual home, never COOP_DIR);
relative paths are warned about and skipped.

Search: case-insensitive LITERAL substring over Markdown files (*.md, plus
*.markdown) found recursively. .git is pruned, symlinks are never followed, so
a configured root can never be escaped. Traversal is sorted; output is capped
at 10 matches per repository, but every configured repository is still
attempted. An unreadable file or root is reported in warnings and is never
claimed as searched.

Stdout: one deterministic JSON document:
    {"status": ..., "searched_roots": [...], "warnings": [...],
     "matches": [...], "truncated": <bool>, "per_repo": {...}}
Each match carries the root identity (resolved path + label), the note path
RELATIVE to that root, a 1-based line number, and a snippet capped at 240
characters. This is local keyword search — not BM25, not semantic search.

Exit codes:
    0  search ran (status ok | unavailable | disabled | invalid_config are all
       recoverable, structured outcomes — zero matches is status "ok")
    2  invalid CLI usage (missing/empty --query, unknown flags)
    1  unexpected internal failure (never reported as a successful search)
"""

import argparse
import json
import os
import sys

MAX_MATCHES_PER_REPO = 10
SNIPPET_CAP = 240
MARKDOWN_SUFFIXES = (".md", ".markdown")
STATUS_OK = "ok"
STATUS_UNAVAILABLE = "unavailable"
STATUS_DISABLED = "disabled"
STATUS_INVALID_CONFIG = "invalid_config"


def config_path():
    coop_dir = os.environ.get("COOP_DIR")
    if coop_dir:
        return os.path.join(coop_dir, ".coop", "config")
    return os.path.join(os.path.expanduser("~"), ".coop", "config")


def load_config():
    """Return (data, error). error is None or a short human-readable string."""
    path = config_path()
    if not os.path.isfile(path):
        return None, "config file not found: %s" % path
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as exc:
        return None, "config is not valid JSON: %s (%s)" % (path, exc)
    if not isinstance(data, dict):
        return None, "config root is not a JSON object: %s" % path
    return data, None


def expand_local_path(raw):
    """Expand a leading ~/ / ~\\ against the actual home. Returns absolute path
    or None when the entry is relative (must be skipped, not resolved against
    the active client workspace)."""
    raw = str(raw).strip()
    if not raw:
        return None
    if raw == "~":
        return os.path.expanduser("~")
    if raw.startswith("~/") or raw.startswith("~\\"):
        return os.path.join(os.path.expanduser("~"), raw[2:].replace("\\", os.sep))
    if os.path.isabs(raw):
        return raw
    return None


def iter_markdown_files(root):
    """Yield sorted Markdown file paths under root, pruning .git and never
    following symlinks (both directory and file symlinks are skipped)."""
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if d != ".git" and not os.path.islink(os.path.join(dirpath, d)))
        for name in sorted(filenames):
            if not name.lower().endswith(MARKDOWN_SUFFIXES):
                continue
            full = os.path.join(dirpath, name)
            if os.path.islink(full):
                continue
            yield full


def search_root(root, query, warnings):
    """Search one root. Returns (matches, total_found, truncated). Unreadable
    files are reported in warnings and skipped."""
    matches = []
    total = 0
    truncated = False
    needle = query.lower()
    for full in iter_markdown_files(root):
        try:
            with open(full, "r", encoding="utf-8", errors="replace") as fh:
                for lineno, line in enumerate(fh, 1):
                    if needle not in line.lower():
                        continue
                    total += 1
                    if len(matches) < MAX_MATCHES_PER_REPO:
                        snippet = line.strip()
                        if len(snippet) > SNIPPET_CAP:
                            snippet = snippet[: SNIPPET_CAP - 1] + "\u2026"
                        matches.append(
                            {
                                "root": root,
                                "root_label": os.path.basename(root.rstrip(os.sep)) or root,
                                "path": os.path.relpath(full, root).replace(os.sep, "/"),
                                "line": lineno,
                                "snippet": snippet,
                            }
                        )
                    else:
                        truncated = True
        except OSError as exc:
            warnings.append("unreadable file skipped: %s (%s)" % (full, exc))
    return matches, total, truncated


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="search-knowledge.py",
        description="Local keyword search over configured team-knowledge clones.",
    )
    parser.add_argument("--query", required=True, help="literal search string (case-insensitive)")
    args = parser.parse_args(argv)

    query = args.query.strip()
    if not query:
        print("error: --query must not be empty", file=sys.stderr)
        return 2

    warnings = []
    searched_roots = []
    matches = []
    per_repo = {}
    truncated_any = False

    data, err = load_config()
    if err is not None or not isinstance(data, dict):
        # No/invalid config is a recoverable outcome: nothing to search.
        status = STATUS_DISABLED if err and "not found" in err else STATUS_INVALID_CONFIG
        warnings.append(err or "config root is not a JSON object")
    else:
        knowledge = data.get("knowledge")
        if knowledge is None:
            status = STATUS_DISABLED
        elif not isinstance(knowledge, dict):
            status = STATUS_INVALID_CONFIG
            warnings.append("knowledge block is not an object")
        elif knowledge.get("enabled") is not True:
            if knowledge.get("enabled") in (False, None):
                status = STATUS_DISABLED
            else:
                status = STATUS_INVALID_CONFIG
                warnings.append("knowledge.enabled must be boolean true")
        else:
            repos = knowledge.get("repos")
            if not isinstance(repos, list):
                status = STATUS_INVALID_CONFIG
                warnings.append("knowledge.repos must be a list")
            else:
                status = None  # decided after attempting every repo
                seen_roots = set()
                for index, repo in enumerate(repos):
                    label = "repos[%d]" % index
                    if not isinstance(repo, dict):
                        warnings.append("%s is not an object — skipped" % label)
                        continue
                    raw_path = repo.get("local_path", "")
                    if not str(raw_path).strip():
                        warnings.append("%s has no local_path — skipped" % label)
                        continue
                    label = str(repo.get("url", "")).strip() or str(raw_path).strip()
                    expanded = expand_local_path(raw_path)
                    if expanded is None:
                        warnings.append(
                            "%s: relative local_path %r is not searched (use an absolute path or ~/...)"
                            % (label, str(raw_path).strip())
                        )
                        continue
                    root = os.path.realpath(expanded)
                    if root in seen_roots:
                        continue
                    seen_roots.add(root)
                    if not os.path.isdir(root):
                        warnings.append("unavailable root skipped: %s" % root)
                        continue
                    searched_roots.append(root)
                    try:
                        root_matches, total, truncated = search_root(root, query, warnings)
                    except OSError as exc:
                        warnings.append("unavailable root skipped: %s (%s)" % (root, exc))
                        continue
                    matches.extend(root_matches)
                    truncated_any = truncated_any or truncated
                    per_repo[root] = {
                        "matches": len(root_matches),
                        "total": total,
                        "truncated": truncated,
                    }
                if not searched_roots:
                    status = STATUS_UNAVAILABLE

    if status is None:
        status = STATUS_OK

    result = {
        "status": status,
        "query": query,
        "searched_roots": searched_roots,
        "warnings": warnings,
        "matches": matches,
        "truncated": truncated_any,
        "per_repo": per_repo,
    }
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as exc:  # never convert a programming failure into a fake search
        print("error: unexpected failure: %s" % exc, file=sys.stderr)
        sys.exit(1)

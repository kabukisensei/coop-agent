#!/usr/bin/env python3
"""Merge missing MCP servers from the example config into an existing live mcp.json.

`coop sync` copies config/mcp.example.json into the live ~/.coop/agent/mcp.json only
when the live file is ABSENT (it never clobbers a user's config). That means an
existing install never picks up MCP servers ADDED to the example in a later release.
This helper closes that gap: it ADDS any top-level `mcpServers` entry present in the
example but MISSING from the live config, and never modifies or removes an entry the
user already has — so their tenant ids and customizations are preserved.

Prints the names of any servers it added, one per line, to stdout. Best-effort by
design: on any error it leaves the live file untouched and exits 0, so a sync/doctor
run can never fail because of it.

Usage: python3 _mcpmerge.py <example.json> <live.json>
"""
import json
import os
import sys


def main(argv):
    if len(argv) < 3:
        return 0
    example_path, live_path = argv[1], argv[2]
    try:
        # utf-8-sig tolerates a BOM if a Windows editor added one to the live file.
        with open(example_path, encoding="utf-8-sig") as f:
            example = json.load(f)
        with open(live_path, encoding="utf-8-sig") as f:
            live = json.load(f)
    except (OSError, ValueError):
        return 0

    ex_servers = example.get("mcpServers")
    live_servers = live.get("mcpServers")
    # Only merge when BOTH configs use the standard {"mcpServers": {...}} shape;
    # otherwise leave the user's file untouched rather than guessing its structure.
    if not isinstance(ex_servers, dict) or not isinstance(live_servers, dict):
        return 0

    added = []
    for name, spec in ex_servers.items():
        if name not in live_servers:
            live_servers[name] = spec
            added.append(name)
    if not added:
        return 0

    tmp = live_path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(live, f, indent=2)
            f.write("\n")
        os.replace(tmp, live_path)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return 0

    for name in added:
        sys.stdout.write(name + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

#!/usr/bin/env python3
"""Validate proposed .coop/project.yml content without writing it."""
import json
import sys

import _yaml


def main() -> int:
    text = sys.stdin.read()
    try:
        value = _yaml.loads(text)
    except Exception as exc:
        print(json.dumps({"valid": False, "diagnostics": [{"code": "yaml-invalid", "message": str(exc)}]}))
        return 0
    diagnostics = []
    if not isinstance(value, dict):
        diagnostics.append({"code": "project-config-not-object", "message": "Project configuration must be a YAML mapping."})
    elif "profile" in value and not isinstance(value["profile"], dict):
        diagnostics.append({"code": "profile-not-object", "message": "profile must be a YAML mapping."})
    print(json.dumps({"valid": not diagnostics, "diagnostics": diagnostics}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

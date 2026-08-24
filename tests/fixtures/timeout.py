#!/usr/bin/env python3
"""Run a command under a hard wall-clock limit.

usage: timeout.py SECONDS COMMAND [ARGS...]

Prints combined stdout/stderr; exits with the child's code, or 124 on timeout.
Used by tests that must fail fast if a fix regresses into an infinite loop
(a hanging wizard would otherwise stall the whole suite).
"""
import os
import subprocess
import sys


def main() -> int:
    secs = float(sys.argv[1])
    cmd = sys.argv[2:]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=secs,
                           env=os.environ)
    except subprocess.TimeoutExpired:
        print("TIMEOUT after %ss" % secs, file=sys.stderr)
        return 124
    sys.stdout.write((r.stdout or "") + (r.stderr or ""))
    return r.returncode


if __name__ == "__main__":
    sys.exit(main())

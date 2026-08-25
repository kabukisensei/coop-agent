#!/usr/bin/env python3
"""Drive an interactive command under a real pty with paced line input.

Used by tests/first-run.test.sh: `coop` refuses to onboard when stdin is a
plain pipe ([ -t 0 ] check), so the test needs a genuine TTY. BSD/GNU `script`
injects an early EOF before the child starts reading; this driver waits for
the first prompt to appear before dripping lines in.

Env:
  PTY_ANSWERS  file whose lines are fed, one every PTY_INTERVAL seconds,
               after the first prompt appears
  PTY_OUT      file receiving the full terminal transcript
Exit code: the child's exit code.
"""
import os
import pty
import select
import sys
import time


def main() -> int:
    cmd = sys.argv[1:]
    if not cmd:
        sys.stderr.write("pty_drive: no command given\n")
        return 64
    with open(os.environ["PTY_ANSWERS"], "rb") as fh:
        lines = fh.read().split(b"\n")
    interval = float(os.environ.get("PTY_INTERVAL", "0.25"))

    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)

    buf = b""
    sent = 0
    started = False
    last_send = 0.0
    deadline = time.time() + float(os.environ.get("PTY_DEADLINE", "120"))
    status = None
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            buf += data
            if not started and (b"?" in buf or b": " in buf):
                started = True
                last_send = 0.0
        now = time.time()
        if started and sent < len(lines) and (now - last_send) >= interval:
            os.write(fd, lines[sent] + b"\n")
            sent += 1
            last_send = time.time()
        # Reap opportunistically once everything has been fed.
        if sent >= len(lines):
            try:
                waited, status = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                break
            if waited:
                break
    if status is None:
        # Child still alive at deadline or select ended: kill hard, then reap.
        try:
            os.kill(pid, 9)
            _, status = os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError):
            status = 0
    rc = os.waitstatus_to_exitcode(status) if status is not None else -1
    sys.stderr.write(f"pty_drive: sent={sent}/{len(lines)} bytes={len(buf)} rc={rc}\n")
    with open(os.environ["PTY_OUT"], "wb") as fh:
        fh.write(buf)
    return rc


if __name__ == "__main__":
    sys.exit(main())

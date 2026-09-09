#!/usr/bin/env python3
"""knowledge-git.py — bounded, unattended git runner for knowledge sync.

One shared timeout/unattended contract used by sync-knowledge.sh and
sync-knowledge.ps1 so Git, credential helpers, askpass, and SSH can never wait
indefinitely (http.lowSpeedTime only bounds HTTP low-speed stalls — it is not
an overall deadline).

Usage:
    <python> scripts/knowledge-git.py --timeout-seconds 30 -- <git> [args...]

Timeout: the --timeout-seconds flag wins; otherwise
COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS (a positive integer); otherwise 30.
Invalid values never create an unlimited wait — they fall back to 30.

Child-only environment (the parent is never modified):
    GIT_TERMINAL_PROMPT=0      no interactive credential prompts
    GCM_INTERACTIVE=never      noninteractive Git Credential Manager
    GIT_ASKPASS / SSH_ASKPASS  pointed at the platform null device so no GUI
                               prompt program can open (terminal prompt stays
                               disabled via GIT_TERMINAL_PROMPT=0 / BatchMode)
    stdin                      /dev/null (closed)
SSH stays unattended WITHOUT weakening host-key checking: when (and only when)
the user has no custom GIT_SSH / GIT_SSH_COMMAND, GIT_SSH_COMMAND is set to
"ssh -o BatchMode=yes". A custom transport is preserved untouched; if it cannot
be made unattended the overall process deadline still bounds the wait.

Process-tree discipline: POSIX starts the child in a new session and kills the
owned process GROUP on timeout (including credential-helper/SSH descendants);
Windows kills the spawned PID's tree via `taskkill /PID <pid> /T /F`. Never
kills by executable name. Cleanup is bounded — no unlimited wait after timeout.

Exit codes:
    0-125   the child's exit status (a signal death maps to 128+signum)
    124     timed out and the owned tree was terminated
    127     the requested executable could not be started
    2       invalid CLI usage
"""

import os
import signal
import subprocess
import sys

DEFAULT_TIMEOUT_SECONDS = 30
EXIT_TIMEOUT = 124
EXIT_CANNOT_START = 127
EXIT_USAGE = 2
CLEANUP_GRACE_SECONDS = 5


def resolve_timeout(flag_value):
    if flag_value is not None:
        try:
            value = int(flag_value)
            if value > 0:
                return value
        except (TypeError, ValueError):
            pass
        return DEFAULT_TIMEOUT_SECONDS
    raw = os.environ.get("COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS")
    if raw:
        try:
            value = int(raw.strip())
            if value > 0:
                return value
        except (TypeError, ValueError):
            pass  # invalid override must not become an unlimited wait
    return DEFAULT_TIMEOUT_SECONDS


def child_env():
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GCM_INTERACTIVE"] = "never"
    env["GIT_ASKPASS"] = os.devnull
    env["SSH_ASKPASS"] = os.devnull
    # Unattended SSH without touching host-key checking: BatchMode refuses
    # passphrase/host-key interactivity but keeps known_hosts verification.
    # A user's custom GIT_SSH/GIT_SSH_COMMAND is authoritative — never replaced.
    if "GIT_SSH" not in env and "GIT_SSH_COMMAND" not in env:
        env["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes"
    return env


def terminate_tree(proc):
    """Kill the owned process tree, never a global executable sweep."""
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=CLEANUP_GRACE_SECONDS,
            )
        except (OSError, subprocess.SubprocessError):
            pass
    else:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.kill()
            except OSError:
                pass


def reap_bounded(proc):
    """Bounded final reap — never wait forever after a timeout kill."""
    try:
        proc.wait(timeout=CLEANUP_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        # The child ignored SIGKILL/taskkill (or is stuck uninterruptible);
        # nothing more can be done safely — report rather than hang.
        pass


def main(argv):
    timeout_flag = None
    command = None
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--":
            command = argv[i + 1 :]
            break
        if arg == "--timeout-seconds":
            if i + 1 >= len(argv):
                print("error: --timeout-seconds requires a value", file=sys.stderr)
                return EXIT_USAGE
            timeout_flag = argv[i + 1]
            i += 2
            continue
        print("error: unknown argument: %s" % arg, file=sys.stderr)
        return EXIT_USAGE
    if not command:
        print("error: missing command after --", file=sys.stderr)
        return EXIT_USAGE

    timeout = resolve_timeout(timeout_flag)

    popen_kwargs = {
        "stdin": subprocess.DEVNULL,
        "env": child_env(),
    }
    if os.name == "nt":
        popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        popen_kwargs["start_new_session"] = True

    try:
        proc = subprocess.Popen(command, **popen_kwargs)
    except (FileNotFoundError, PermissionError, OSError) as exc:
        print("error: cannot start %r: %s" % (command[0], exc), file=sys.stderr)
        return EXIT_CANNOT_START

    try:
        rc = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        terminate_tree(proc)
        reap_bounded(proc)
        print(
            "error: git operation timed out after %ds and was terminated" % timeout,
            file=sys.stderr,
        )
        return EXIT_TIMEOUT
    except KeyboardInterrupt:
        terminate_tree(proc)
        reap_bounded(proc)
        return 130

    if rc < 0:
        return 128 + (-rc)
    return rc


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)

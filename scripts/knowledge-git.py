#!/usr/bin/env python3
"""knowledge-git.py — bounded, unattended git runner for knowledge sync.

One shared timeout/unattended contract used by sync-knowledge.sh and
sync-knowledge.ps1 so Git, credential helpers, askpass, and SSH can never wait
indefinitely (http.lowSpeedTime only bounds HTTP low-speed stalls — it is not
an overall deadline).

Usage:
    <python> scripts/knowledge-git.py --timeout-seconds 30 -- <git> [args...]

Deadline: ONE deadline bounds the COMPLETE operation, not just the immediate
child. After the child exits, descendants may still hold the inherited output
streams open (a Bash `$(...)` capture stays blocked until every writer closes);
the runner therefore keeps watching the OWNED PROCESS GROUP — captured at spawn
so it survives the child's exit — and, once the deadline passes, kills the
group so the streams close and cleanup actually happens. Exceeding the
deadline anywhere in that chain exits 124, even if git itself finished.

Timeout source: the --timeout-seconds flag wins; otherwise
COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS (a positive integer); otherwise 30.
Invalid values never create an unlimited wait — they fall back to 30.

Child-only environment (the parent is never modified):
    GIT_TERMINAL_PROMPT=0      no interactive credential prompts
    GCM_INTERACTIVE=never      noninteractive Git Credential Manager
    GIT_ASKPASS / SSH_ASKPASS  pointed at the platform null device so no GUI
                               prompt program can open (terminal prompt stays
                               disabled via GIT_TERMINAL_PROMPT=0 / BatchMode)
    stdin                      /dev/null (closed)
SSH stays unattended WITHOUT weakening host-key checking, and WITHOUT
silently replacing the selected transport:
  * GIT_SSH / GIT_SSH_COMMAND set by the user  -> preserved untouched.
  * core.sshCommand configured (system/global/repo-local; repo-local is read
    through any -C in the git args)            -> preserved. When the command
    is plain `ssh`, BatchMode is appended to
    GIT_SSH_COMMAND (the configured command itself, kept verbatim + the
    unattended option). For non-ssh transports (corporate wrappers, plink,
    proxy scripts) unattended mode CANNOT be injected safely: the runner skips
    the injection and prints an actionable warning — the overall deadline is
    the enforcement. Git's own precedence (env over config) is otherwise
    respected.
  * no custom transport anywhere               -> GIT_SSH_COMMAND defaults to
    "ssh -o BatchMode=yes".

Process-tree discipline: POSIX starts the child in a new session; the owned
process GROUP is killed on deadline (including credential-helper/SSH
descendants, even ones whose parent already exited). Windows kills the spawned
PID's tree via `taskkill /PID <pid> /T /F` while the root lives. Never kills
by executable name. Cleanup is bounded — no unlimited wait after a kill.

Exit codes:
    0-125   the child's exit status (a signal death maps to 128+signum)
    124     the deadline passed — child, descendants, or output completion
            were terminated
    127     the requested executable could not be started
    2       invalid CLI usage
"""

import os
import shlex
import signal
import subprocess
import sys
import time

DEFAULT_TIMEOUT_SECONDS = 30
EXIT_TIMEOUT = 124
EXIT_CANNOT_START = 127
EXIT_USAGE = 2
CLEANUP_GRACE_SECONDS = 5
CONFIG_PROBE_TIMEOUT_SECONDS = 5
POLL_INTERVAL_SECONDS = 0.05


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


def probe_core_ssh_command(git_argv):
    """Return the effective core.sshCommand (system/global, plus repo-local
    through any -C present in the git args), or None when unset/unreadable.
    Never contacts the network — a pure config read with its own small bound.
    """
    if not git_argv:
        return None
    cmd = [git_argv[0]]
    args = git_argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "-C" and i + 1 < len(args):
            cmd += ["-C", args[i + 1]]
            break
        i += 1
    cmd += ["config", "--get", "core.sshCommand"]
    try:
        res = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=CONFIG_PROBE_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if res.returncode != 0:
        return None
    value = res.stdout.decode("utf-8", "replace").strip()
    return value or None


def is_plain_ssh_command(command):
    """True only when the configured transport IS ssh(1) (BatchMode can be
    appended safely). Wrappers, plink, proxy scripts: False — never guess."""
    try:
        tokens = shlex.split(command, posix=(os.name != "nt"))
    except ValueError:
        return False
    if not tokens:
        return False
    base = os.path.basename(tokens[0].replace("\\", "/")).lower()
    return base in ("ssh", "ssh.exe")


def child_env(git_argv):
    """Build the child environment plus an optional actionable warning.

    Returns (env, warning). The warning is emitted on stderr by main; it never
    changes the exit code.
    """
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GCM_INTERACTIVE"] = "never"
    env["GIT_ASKPASS"] = os.devnull
    env["SSH_ASKPASS"] = os.devnull
    # A user's environment-level transport is authoritative — never replaced.
    if "GIT_SSH" in env or "GIT_SSH_COMMAND" in env:
        return env, None
    configured = probe_core_ssh_command(git_argv)
    if configured:
        if is_plain_ssh_command(configured):
            # The CONFIGURED command stays the transport; BatchMode only makes
            # it unattended (same precedence Git itself would apply).
            env["GIT_SSH_COMMAND"] = configured + " -o BatchMode=yes"
            return env, None
        return env, (
            "custom SSH transport preserved (core.sshCommand): %s — "
            "unattended mode cannot be enforced for it; the operation is "
            "bounded by the deadline" % configured
        )
    env["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes"
    return env, None


def group_alive(pgid):
    """True while any process remains in the owned process group."""
    if pgid is None:
        return False
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists but not signalable by us — do not busy-loop
    except OSError:
        return False


def wait_group_exit(pgid, deadline):
    """Bounded wait for the owned group to empty; never waits past deadline."""
    while group_alive(pgid) and time.monotonic() < deadline:
        time.sleep(POLL_INTERVAL_SECONDS)


def terminate_tree(proc, pgid):
    """Kill the owned process tree, never a global executable sweep.

    The group id is preferred (and was captured at spawn): after the immediate
    child exits, descendants can keep the group — and the inherited output
    streams — alive, and only a group-wide kill reaches them.
    """
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
        return
    killed_group = False
    if pgid is not None:
        try:
            os.killpg(pgid, signal.SIGKILL)
            killed_group = True
        except (ProcessLookupError, PermissionError, OSError):
            killed_group = False
    if not killed_group:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            killed_group = True
        except (ProcessLookupError, PermissionError, OSError):
            killed_group = False
    if not killed_group:
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
    env, env_warning = child_env(command)
    if env_warning:
        print("warning: %s" % env_warning, file=sys.stderr)

    popen_kwargs = {
        "stdin": subprocess.DEVNULL,
        "env": env,
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

    # The owned process-group identity, captured NOW: it survives the child's
    # exit, which is exactly when descendant cleanup becomes the problem.
    pgid = None
    if os.name != "nt":
        try:
            pgid = os.getpgid(proc.pid)
        except OSError:
            pgid = None

    deadline = time.monotonic() + timeout
    try:
        rc = proc.wait(timeout=max(0.0, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        terminate_tree(proc, pgid)
        reap_bounded(proc)
        wait_group_exit(pgid, time.monotonic() + CLEANUP_GRACE_SECONDS)
        print(
            "error: git operation timed out after %ds and was terminated" % timeout,
            file=sys.stderr,
        )
        return EXIT_TIMEOUT
    except KeyboardInterrupt:
        terminate_tree(proc, pgid)
        reap_bounded(proc)
        wait_group_exit(pgid, time.monotonic() + CLEANUP_GRACE_SECONDS)
        return 130

    if os.name != "nt":
        # The child finished, but the operation has not: descendants may still
        # hold the inherited stdout/stderr open, leaving the caller's capture
        # (e.g. Bash $(...)) blocked past the deadline. The SAME deadline
        # bounds them; on expiry the owned group is killed so the streams
        # close and cleanup actually happens.
        if pgid is not None and group_alive(pgid):
            wait_group_exit(pgid, deadline)
            if group_alive(pgid):
                try:
                    os.killpg(pgid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    pass
                wait_group_exit(pgid, time.monotonic() + CLEANUP_GRACE_SECONDS)
                print(
                    "error: git operation exceeded the %ds deadline — "
                    "descendants outlived it and were terminated" % timeout,
                    file=sys.stderr,
                )
                return EXIT_TIMEOUT

    if rc < 0:
        return 128 + (-rc)
    return rc


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(130)

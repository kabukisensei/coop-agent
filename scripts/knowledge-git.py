#!/usr/bin/env python3
"""knowledge-git.py — bounded, unattended git runner for knowledge sync.

One shared timeout/unattended contract used by sync-knowledge.sh and
sync-knowledge.ps1 so Git, credential helpers, askpass, and SSH can never wait
indefinitely (http.lowSpeedTime only bounds HTTP low-speed stalls — it is not
an overall deadline).

Usage:
    <python> scripts/knowledge-git.py --timeout-seconds 30 [--stdin-file PATH] -- <git> [args...]
    <python> scripts/knowledge-git.py --timeout-seconds 30 [--stdin-file PATH] --argv-file PATH

Deadline: ONE deadline bounds the COMPLETE operation — configuration
discovery, the immediate child, and every descendant — not just the child.

  * The deadline is established BEFORE configuration discovery, and the
    core.sshCommand probe runs through the SAME owned-process mechanism with
    the remaining time. A probe that exceeds the deadline fails the whole
    operation (exit 124): the transport is "could not be determined", and the
    runner never silently proceeds with a guessed default.
  * After the child exits, descendants may still hold the inherited output
    streams open (a Bash `$(...)` capture stays blocked until every writer
    closes). The runner keeps watching the ownership it captured at spawn —
    which survives the child's exit — and, once the deadline passes, kills it
    so the streams close and cleanup actually happens. Exceeding the deadline
    anywhere in that chain exits 124, even if git itself finished.

Ownership: on POSIX the child starts a new session and the owned PROCESS
GROUP (id captured at spawn) is the kill/wait unit. On Windows the child is
spawned suspended, assigned to a Job Object created with
KILL_ON_JOB_CLOSE, then resumed — job membership is inherited by every
grandchild and PERSISTS after the immediate parent exits, so an orphaned
descendant holding the output handles is still owned and can be terminated;
job emptiness is the output-completion signal. If setup, membership query, or
handle close cannot be proven, the runner terminates/closes what it owns and
fails closed with ownership-unavailable status 126. Never kills by executable
name. Cleanup is bounded — no unlimited wait after a kill.

Timeout source: the --timeout-seconds flag wins; otherwise
COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS (a positive integer); otherwise 30.
Invalid values never create an unlimited wait — they fall back to 30.

Child-only environment (the parent is never modified):
    GIT_TERMINAL_PROMPT=0      no interactive credential prompts
    GCM_INTERACTIVE=never      noninteractive Git Credential Manager
    GIT_ASKPASS / SSH_ASKPASS  pointed at the platform null device so no GUI
                               prompt program can open (terminal prompt stays
                               disabled via GIT_TERMINAL_PROMPT=0 / BatchMode)
    stdin                      /dev/null (closed), unless --stdin-file opens a
                               file directly for the owned child
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
  * config probe could not be determined (start failure) -> an actionable
    warning is printed and NO default transport is guessed; the environment
    is left unchanged.
  * configuration not set anywhere                -> GIT_SSH_COMMAND defaults
    to "ssh -o BatchMode=yes".

Exit codes:
    0-125   the child's exit status (a signal death maps to 128+signum)
    124     the deadline passed — probe, child, descendants, or output
            completion were terminated
    126     (Windows) process containment could not be established before the
            child ran — the suspended child was stopped and the operation was
            not attempted (never silent unowned execution)
    127     the requested executable could not be started
    2       invalid CLI usage
"""

import json
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
# Windows-only: the Job Object could not be created or the child could not
# be assigned before resume, so the suspended child was stopped and the
# operation was NOT attempted. Explicit unavailability, never silent
# unowned execution.
EXIT_OWNERSHIP_UNAVAILABLE = 126
CLEANUP_GRACE_SECONDS = 5
POLL_INTERVAL_SECONDS = 0.05

OWNERSHIP_EMPTY = "empty"
OWNERSHIP_TIMED_OUT = "timed_out"
OWNERSHIP_UNCERTAIN = "uncertain"

# Explicit fail-closed test seam. Values select fixed lifecycle stages only;
# arbitrary code or callables are never accepted. Inert unless deliberately set.
_TEST_FAULT_ENV = "COOP_KNOWLEDGE_GIT_TEST_FAULT"
_TEST_PID_FILE_ENV = "COOP_KNOWLEDGE_GIT_TEST_PID_FILE"
_TEST_EVENT_NONCE_ENV = "COOP_KNOWLEDGE_GIT_TEST_EVENT_NONCE"
_TEST_RECORD_PREFIX = "COOP_KNOWLEDGE_GIT_LIFECYCLE:"
_TEST_FAULTS = frozenset(
    (
        "job-create",
        "job-assign",
        "resume",
        "job-query",
        "job-terminate",
        "job-close",
    )
)
_TEST_FAULT_OUTCOMES = {
    "job-create": "failure",
    "job-assign": "failure",
    "resume": "failure",
    "job-query": "indeterminate",
    "job-terminate": "failure",
    "job-close": "failure",
}
_PROCESS_ID = os.getpid()
_CONSUMED_TEST_FAULTS = set()
_SELECTED_TEST_FAULT = os.environ.get(_TEST_FAULT_ENV, "")
if _SELECTED_TEST_FAULT not in _TEST_FAULTS:
    _SELECTED_TEST_FAULT = ""
_TEST_EVENT_NONCE = os.environ.get(_TEST_EVENT_NONCE_ENV, "")
_TEST_PID_FILE = os.environ.get(_TEST_PID_FILE_ENV, "")
_TEST_FAULT_ARMED = False


class TestEvidenceError(RuntimeError):
    """The internal fault seam could not emit authentic helper evidence."""


def _test_fault(stage):
    return _TEST_FAULT_ARMED and _SELECTED_TEST_FAULT == stage


def _emit_test_record(nonce, stage):
    """Synchronously emit one exact record at the helper-owned stderr seam."""
    event = {
        "schema_version": 1,
        "nonce": nonce,
        "stage": stage,
        "outcome": _TEST_FAULT_OUTCOMES[stage],
    }
    record = (
        _TEST_RECORD_PREFIX
        + json.dumps(event, sort_keys=True, separators=(",", ":"))
        + "\n"
    )
    try:
        written = sys.stderr.write(record)
        if written != len(record):
            raise OSError("short lifecycle record write")
        sys.stderr.flush()
    except (OSError, ValueError, UnicodeError) as exc:
        raise TestEvidenceError(
            "internal test lifecycle evidence emission failed at %s: %s" % (stage, exc)
        )


def _consume_test_fault(stage):
    """Emit authentic evidence once before returning an injected lifecycle result."""
    if not _test_fault(stage):
        return False
    nonce = _TEST_EVENT_NONCE
    consumption = (_PROCESS_ID, nonce, stage)
    if consumption in _CONSUMED_TEST_FAULTS:
        return True
    if len(nonce) != 32 or any(char not in "0123456789abcdef" for char in nonce):
        raise TestEvidenceError(
            "internal test lifecycle evidence nonce is invalid at %s" % stage
        )
    _emit_test_record(nonce, stage)
    # Consumption becomes durable only after the record was written and flushed.
    _CONSUMED_TEST_FAULTS.add(consumption)
    return True


def _record_test_pid(proc):
    """Expose the real spawned root PID only while a fixed lifecycle fault is active."""
    if not any(_test_fault(stage) for stage in _TEST_FAULTS):
        return
    path = _TEST_PID_FILE
    if not path:
        return
    try:
        with open(path, "w", encoding="ascii") as stream:
            stream.write("%d\n" % proc.pid)
    except OSError:
        pass  # The behavioral test fails loudly if its requested evidence is absent.


def _payload_environment():
    """Return an environment with every internal acceptance control removed."""
    env = os.environ.copy()
    for name in tuple(env):
        if name.startswith("COOP_KNOWLEDGE_GIT_TEST_") or name.startswith(
            "COOP_TERMINAL_ACCEPTANCE_"
        ):
            env.pop(name, None)
    return env


def _purge_test_environment():
    """Retain captured controls only in helper memory before doing any work."""
    for name in tuple(os.environ):
        if name.startswith("COOP_KNOWLEDGE_GIT_TEST_") or name.startswith(
            "COOP_TERMINAL_ACCEPTANCE_"
        ):
            os.environ.pop(name, None)


# Probe result states.
PROBE_VALUE = "value"  # core.sshCommand is set (possibly empty -> unset)
PROBE_UNSET = "unset"  # read succeeded; key absent
PROBE_INDETERMINATE = "indeterminate"  # probe could not start at all
PROBE_TIMED_OUT = "timed_out"  # probe exceeded the operation deadline
PROBE_OWNERSHIP_UNCERTAIN = "ownership_uncertain"

_CREATE_SUSPENDED = 0x00000004


# ---------------------------------------------------------------------------
# Windows Job Object support (loaded only on nt). Wrapped so any failure
# degrades to the taskkill fallback rather than crashing the runner.
# ---------------------------------------------------------------------------
_KERNEL32 = None
if os.name == "nt":
    try:
        import ctypes
        from ctypes import wintypes

        # use_last_error so assignment failures report the real Win32 code
        # (e.g. ERROR_ACCESS_DENIED when the runner already jobs its steps).
        _KERNEL32 = ctypes.WinDLL("kernel32", use_last_error=True)
        _KERNEL32.CreateJobObjectW.restype = wintypes.HANDLE
        _KERNEL32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
        _KERNEL32.SetInformationJobObject.argtypes = [
            wintypes.HANDLE,
            wintypes.DWORD,
            wintypes.LPVOID,
            wintypes.DWORD,
        ]
        _KERNEL32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        _KERNEL32.OpenProcess.restype = wintypes.HANDLE
        _KERNEL32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        _KERNEL32.CloseHandle.argtypes = [wintypes.HANDLE]
        _KERNEL32.QueryInformationJobObject.argtypes = [
            wintypes.HANDLE,
            wintypes.DWORD,
            wintypes.LPVOID,
            wintypes.DWORD,
            wintypes.LPVOID,
        ]
        _KERNEL32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        _KERNEL32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        _KERNEL32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        _KERNEL32.OpenThread.restype = wintypes.HANDLE
        _KERNEL32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        _KERNEL32.ResumeThread.restype = wintypes.DWORD
        _KERNEL32.ResumeThread.argtypes = [wintypes.HANDLE]

        _INVALID_HANDLE = ctypes.c_void_p(-1).value
        _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
        _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
        _JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1
        _PROCESS_SET_QUOTA = 0x0100
        _PROCESS_TERMINATE = 0x0001
        _THREAD_SUSPEND_RESUME = 0x0002
        _TH32CS_SNAPTHREAD = 0x00000004

        class _IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                (name, ctypes.c_ulonglong)
                for name in (
                    "ReadOperationCount",
                    "WriteOperationCount",
                    "OtherOperationCount",
                    "ReadTransferCount",
                    "WriteTransferCount",
                    "OtherTransferCount",
                )
            ]

        class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            # SDK layout — the two LARGE_INTEGER time limits LEAD the struct.
            # Omitting them (the previous shape) shifted every later field,
            # so SetInformationJobObject read LimitFlags from
            # MaximumWorkingSetSize's slot: KILL_ON_JOB_CLOSE was never set.
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),  # LARGE_INTEGER
                ("PerJobUserTimeLimit", ctypes.c_longlong),  # LARGE_INTEGER
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", _IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        class _JOBOBJECT_BASIC_ACCOUNTING_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("TotalUserTime", ctypes.c_longlong),
                ("TotalKernelTime", ctypes.c_longlong),
                ("ThisPeriodTotalUserTime", ctypes.c_longlong),
                ("ThisPeriodTotalKernelTime", ctypes.c_longlong),
                ("TotalPageFaultCount", wintypes.DWORD),
                ("TotalProcesses", wintypes.DWORD),
                ("ActiveProcesses", wintypes.DWORD),
                ("TotalTerminatedProcesses", wintypes.DWORD),
            ]

        class _THREADENTRY32(ctypes.Structure):
            _fields_ = [
                ("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ThreadID", wintypes.DWORD),
                ("th32OwnerProcessID", wintypes.DWORD),
                ("tpBasePri", wintypes.LONG),
                ("tpDeltaPri", wintypes.LONG),
                ("dwFlags", wintypes.DWORD),
            ]
    except (ImportError, AttributeError, ValueError):
        _KERNEL32 = None


def _win_job_create():
    """A job object that kills all its processes when the handle closes.

    Returns (job, error): error is None on success, else (stage, code)
    with the Win32 code captured IMMEDIATELY after the failing call —
    before any cleanup (CloseHandle resets the thread's last error).
    """
    try:
        if _consume_test_fault("job-create"):
            return None, ("test-job-create", 1)
    except TestEvidenceError as exc:
        # There is no Job yet. adopt() will terminate the suspended child.
        return None, ("test-evidence", str(exc))
    if _KERNEL32 is None:
        return None, ("unsupported", None)
    try:
        job = _KERNEL32.CreateJobObjectW(None, None)
        if not job or job == _INVALID_HANDLE:
            return None, ("create", _win_last_error())
        info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not _KERNEL32.SetInformationJobObject(
            job,
            _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(info),
            ctypes.sizeof(info),
        ):
            err = _win_last_error()  # capture BEFORE CloseHandle replaces it
            _KERNEL32.CloseHandle(job)
            return None, ("setinfo", err)
        return job, None
    except (OSError, ValueError) as exc:
        return None, ("exception", repr(exc))


def _win_job_assign(job, pid):
    """Assign pid to job. Returns (ok, error); error is (stage, code) —
    'open' distinguishes handle-acquisition failure from the assignment
    itself, each code captured immediately after its own call."""
    try:
        if _consume_test_fault("job-assign"):
            return False, ("test-job-assign", 1)
    except TestEvidenceError as exc:
        # adopt() will terminate the still-suspended child and close the Job.
        return False, ("test-evidence", str(exc))
    if _KERNEL32 is None or not job:
        return False, ("unsupported", None)
    try:
        proc = _KERNEL32.OpenProcess(
            _PROCESS_SET_QUOTA | _PROCESS_TERMINATE, False, pid
        )
        if not proc or proc == _INVALID_HANDLE:
            return False, ("open", _win_last_error())
        try:
            if _KERNEL32.AssignProcessToJobObject(job, proc):
                return True, None
            return False, ("assign", _win_last_error())
        finally:
            _KERNEL32.CloseHandle(proc)
    except (OSError, ValueError) as exc:
        return False, ("exception", repr(exc))


def _win_job_active_processes(job):
    try:
        if _consume_test_fault("job-query"):
            return None
    except TestEvidenceError:
        # The caller treats an unreadable ownership count as uncertainty and
        # immediately terminates/closes the owned Job.
        return None
    if _KERNEL32 is None or not job:
        return None
    try:
        info = _JOBOBJECT_BASIC_ACCOUNTING_INFORMATION()
        if not _KERNEL32.QueryInformationJobObject(
            job,
            _JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
            ctypes.byref(info),
            ctypes.sizeof(info),
            None,
        ):
            return None
        return int(info.ActiveProcesses)
    except (OSError, ValueError):
        return None


def _win_job_terminate(job):
    try:
        if _consume_test_fault("job-terminate"):
            return False, ("test-job-terminate", 1)
    except TestEvidenceError as exc:
        # terminate() will immediately invoke the Job-close fallback.
        return False, ("test-evidence", str(exc))
    if _KERNEL32 is None or not job:
        return False, ("unsupported", None)
    try:
        if _KERNEL32.TerminateJobObject(job, 1):
            return True, None
        return False, ("terminate", _win_last_error())
    except (OSError, ValueError) as exc:
        return False, ("exception", repr(exc))


def _win_job_close_raw(job):
    """Close a Job handle without consulting the test seam."""
    if _KERNEL32 is None or not job:
        return False, ("unsupported", None)
    try:
        if _KERNEL32.CloseHandle(job):
            return True, None
        return False, ("close", _win_last_error())
    except (OSError, ValueError) as exc:
        return False, ("exception", repr(exc))


def _win_job_close(job):
    try:
        if _consume_test_fault("job-close"):
            return False, ("test-job-close", 1)
    except TestEvidenceError as exc:
        # Evidence failure may not prevent KILL_ON_JOB_CLOSE cleanup. Close the
        # real handle, but preserve an uncertain result because the requested
        # injected seam was not authentically observed.
        closed, close_error = _win_job_close_raw(job)
        return False, ("test-evidence", str(exc), "cleanup-close", closed, close_error)
    return _win_job_close_raw(job)


def _win_last_error():
    if _KERNEL32 is None:
        return None
    return ctypes.get_last_error()


def _win_terminate_pid(pid):
    """Terminate one process we own outright (the still-suspended child).

    Used only when containment cannot be established: the child has never
    run, so stopping it loses nothing. Returns (ok, code), code captured
    immediately after TerminateProcess."""
    if _KERNEL32 is None:
        return False, ("unsupported", None)
    handle = _KERNEL32.OpenProcess(_PROCESS_TERMINATE, False, int(pid))
    if not handle or handle == _INVALID_HANDLE:
        return False, ("open", _win_last_error())
    try:
        if _KERNEL32.TerminateProcess(handle, 1):
            return True, None
        return False, ("terminate", _win_last_error())
    finally:
        _KERNEL32.CloseHandle(handle)


def _win_resume_verdict(prev):
    """Classify a ResumeThread previous-suspend-count return value.

    ResumeThread returns the thread's PREVIOUS suspend count (DWORD), not a
    boolean success flag:
      0xFFFFFFFF  failure sentinel — the caller must read GetLastError
      1           expected result for a CREATE_SUSPENDED child's first resume
      0           thread was not suspended (already running)
      >1          thread remains suspended (nested suspends)
    Returns (ok, code): (True, None) on the expected single resume, else
    (False, ("resume", detail)) where detail names the observed state
    ("failure_sentinel" — read GetLastError, "already_running", or
    "still_suspended:<prev>"). Pure and deterministic; unit-testable off
    Windows. Never raises.
    """
    if prev == 0xFFFFFFFF:
        return False, ("resume", "failure_sentinel")
    if prev == 1:
        return True, None
    if prev == 0:
        return False, ("resume", "already_running")
    return False, ("resume", "still_suspended:%d" % prev)


def _win_resume_pid(pid):
    """Resume a CREATE_SUSPENDED child by resuming its primary thread.

    Returns (ok, code); code is the Win32 error captured after the
    resuming ResumeThread call (or after the failing step)."""
    try:
        if _consume_test_fault("resume"):
            return False, ("test-resume", 1)
    except TestEvidenceError as exc:
        # adopt() still owns the suspended child and will terminate/close it.
        return False, ("test-evidence", str(exc))
    if _KERNEL32 is None:
        return False, ("unsupported", None)
    try:
        snap = _KERNEL32.CreateToolhelp32Snapshot(_TH32CS_SNAPTHREAD, pid)
        if not snap or snap == _INVALID_HANDLE:
            return False, ("snapshot", _win_last_error())
        try:
            entry = _THREADENTRY32()
            entry.dwSize = ctypes.sizeof(_THREADENTRY32)
            have = _KERNEL32.Thread32First(snap, ctypes.byref(entry))
            while have:
                if entry.th32OwnerProcessID == pid:
                    thread = _KERNEL32.OpenThread(
                        _THREAD_SUSPEND_RESUME, False, entry.th32ThreadID
                    )
                    if thread and thread != _INVALID_HANDLE:
                        try:
                            prev = _KERNEL32.ResumeThread(thread)
                            ok, verdict = _win_resume_verdict(prev)
                            if ok:
                                return True, None
                            if verdict and verdict[1] == "failure_sentinel":
                                return False, ("resume", _win_last_error())
                            return False, verdict
                        finally:
                            _KERNEL32.CloseHandle(thread)
                    return False, ("open_thread", _win_last_error())
                have = _KERNEL32.Thread32Next(snap, ctypes.byref(entry))
            return False, ("no_thread", None)
        finally:
            _KERNEL32.CloseHandle(snap)
    except (OSError, ValueError) as exc:
        return False, ("exception", repr(exc))


class Ownership:
    """Owned-process tracking that survives the immediate child's exit.

    POSIX: the process-group id, captured at spawn (start_new_session).
    Windows: a Job Object (KILL_ON_JOB_CLOSE) the suspended child is assigned
    to before resume — membership is inherited by grandchildren and persists
    after the parent exits, so orphaned descendants stay owned.

    `available` is False when Windows job setup or resume failed. The caller
    refuses to accept unowned execution and returns status 126.
    """

    def __init__(self):
        self.pgid = None
        self.job = None
        self.child = None
        self._close_result = None

    @property
    def available(self):
        if os.name == "nt":
            return self.job is not None
        return self.pgid is not None

    def spawn_kwargs(self):
        if os.name == "nt":
            # Suspended so assignment to the job closes the race in which a
            # grandchild spawns before being captured. Resumed after adopt().
            return {"creationflags": _CREATE_SUSPENDED}
        return {"start_new_session": True}

    def adopt(self, proc):
        """Capture the kill/wait identity of a just-spawned child.

        On Windows the child is suspended at spawn. Containment MUST be
        established before it runs: if the job cannot be created or the
        child cannot be assigned, the still-suspended child is stopped
        (it is ours and has never executed) and `available` stays False —
        the caller then refuses to run the operation unowned rather than
        silently losing orphan cleanup. Every stage reports its own
        Win32 error, captured before cleanup can replace it.
        """
        self.child = proc
        self.unavailable_reason = None
        if os.name == "nt":
            self.job, err = _win_job_create()
            if self.job is None:
                stage, code = err
                stopped, stop_err = _win_terminate_pid(proc.pid)
                self.unavailable_reason = "job create failed at %s (error %s)" % (
                    stage,
                    code,
                )
                if not stopped:
                    self.unavailable_reason += (
                        "; suspended-child termination failed (%s)" % (stop_err,)
                    )
            else:
                assigned, err = _win_job_assign(self.job, proc.pid)
                if not assigned:
                    stage, code = err
                    stopped, stop_err = _win_terminate_pid(proc.pid)
                    closed, close_err = _win_job_close(self.job)
                    self.job = None
                    self.unavailable_reason = (
                        "job assignment failed at %s (error %s)" % (stage, code)
                    )
                    if not stopped:
                        self.unavailable_reason += (
                            "; suspended-child termination failed (%s)" % (stop_err,)
                        )
                    if not closed:
                        self.unavailable_reason += "; Job close failed (%s)" % (
                            close_err,
                        )
            if self.unavailable_reason:
                print(
                    "warning: Windows process containment unavailable — %s; "
                    "the operation was not started" % self.unavailable_reason,
                    file=sys.stderr,
                )
            if self.unavailable_reason is None:
                resumed, rerr = _win_resume_pid(proc.pid)
                if not resumed:
                    terminated, term_err = _win_job_terminate(self.job)
                    closed, close_err = _win_job_close(self.job)
                    self.job = None
                    self._close_result = closed
                    self.unavailable_reason = "child resume failed (%s)" % (rerr,)
                    if not terminated:
                        self.unavailable_reason += "; Job termination failed (%s)" % (
                            term_err,
                        )
                    if not closed:
                        self.unavailable_reason += "; Job close failed (%s)" % (
                            close_err,
                        )
                    print(
                        "warning: Windows process containment unavailable — %s; "
                        "the operation was not started" % self.unavailable_reason,
                        file=sys.stderr,
                    )
        else:
            try:
                self.pgid = os.getpgid(proc.pid)
            except OSError:
                self.pgid = None

    def wait_empty(self, deadline):
        """Return verified empty, deadline expiry, or ownership uncertainty."""
        if os.name == "nt":
            if self.job is None:
                # A missing Windows Job can never prove ownership empty.
                return OWNERSHIP_UNCERTAIN
            while time.monotonic() < deadline:
                active = _win_job_active_processes(self.job)
                if active == 0:
                    return OWNERSHIP_EMPTY
                if active is None:
                    return OWNERSHIP_UNCERTAIN
                time.sleep(POLL_INTERVAL_SECONDS)
            active = _win_job_active_processes(self.job)
            if active is None:
                return OWNERSHIP_UNCERTAIN
            return OWNERSHIP_EMPTY if active == 0 else OWNERSHIP_TIMED_OUT
        while group_alive(self.pgid) and time.monotonic() < deadline:
            time.sleep(POLL_INTERVAL_SECONDS)
        return OWNERSHIP_EMPTY if not group_alive(self.pgid) else OWNERSHIP_TIMED_OUT

    def terminate(self):
        """Kill every owned process, never a global executable sweep."""
        if os.name == "nt":
            if self.job is not None:
                terminated, _ = _win_job_terminate(self.job)
                if terminated:
                    return True
                # The Job already owns the complete descendant tree. If its
                # explicit termination call fails, close it immediately so
                # KILL_ON_JOB_CLOSE fires before any PID fallback can stall or
                # miss an orphaned child. terminate_and_wait interprets the
                # close result and keeps uncertainty fail-closed.
                self.close()
                return False
            # Only a degraded no-Job path may use the root-PID tree fallback.
            try:
                result = subprocess.run(
                    ["taskkill", "/PID", str(self.child.pid), "/T", "/F"],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=CLEANUP_GRACE_SECONDS,
                )
                return result.returncode == 0
            except (OSError, subprocess.SubprocessError):
                return False
        killed = False
        if self.pgid is not None:
            try:
                os.killpg(self.pgid, signal.SIGKILL)
                killed = True
            except (ProcessLookupError, PermissionError, OSError):
                killed = False
        if not killed and self.child is not None:
            try:
                os.killpg(os.getpgid(self.child.pid), signal.SIGKILL)
                killed = True
            except (ProcessLookupError, PermissionError, OSError):
                killed = False
        if not killed and self.child is not None:
            try:
                self.child.kill()
                killed = True
            except OSError:
                pass
        return killed

    def terminate_and_wait(self, deadline, proc=None):
        """Terminate ownership and verify it without delaying kill-on-close."""
        terminated = self.terminate()
        if proc is not None:
            # Reap before checking emptiness so a dead POSIX group leader does
            # not remain visible as a zombie for the whole cleanup grace.
            reap_bounded(proc)
        if os.name == "nt":
            if not terminated:
                # terminate() already invoked the Job-close fallback. There is
                # no live Job handle to query and waiting would only recreate
                # the orphan mutation window.
                return OWNERSHIP_EMPTY if self._close_result else OWNERSHIP_UNCERTAIN
            return self.wait_empty(deadline)
        wait_group_exit(self.pgid, deadline)
        return OWNERSHIP_EMPTY if not group_alive(self.pgid) else OWNERSHIP_TIMED_OUT

    def close(self):
        if os.name == "nt" and self.job is not None:
            closed, _ = _win_job_close(self.job)
            self.job = None
            self._close_result = closed
            return closed
        if os.name == "nt" and self._close_result is not None:
            return self._close_result
        return True


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


def reap_bounded(proc):
    """Bounded final reap — never wait forever after a timeout kill."""
    try:
        proc.wait(timeout=CLEANUP_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        # The child ignored SIGKILL/taskkill (or is stuck uninterruptible);
        # nothing more can be done safely — report rather than hang.
        pass


def run_bounded_capture(argv, deadline):
    """Run argv under owned-process discipline with the REMAINING deadline.

    Returns (state, stdout_bytes):
      ("ok", bytes)          process exited AND output completed in time
      ("timed_out", None)    deadline passed — owned tree terminated, pipes
                             drained as far as the kill allows
      ("start_failed", None) the executable could not be started at all
    """
    ownership = Ownership()
    try:
        try:
            proc = subprocess.Popen(
                argv,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                env=_payload_environment(),
                **ownership.spawn_kwargs(),
            )
        except (OSError, subprocess.SubprocessError):
            return "start_failed", None
        _record_test_pid(proc)
        ownership.adopt(proc)
        if not ownership.available:
            # adopt() stopped the still-suspended child and printed why.
            return "unavailable", None
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            ownership.terminate_and_wait(time.monotonic() + CLEANUP_GRACE_SECONDS, proc)
            return "timed_out", None
        try:
            out, _ = proc.communicate(timeout=remaining)
        except subprocess.TimeoutExpired:
            # Parent done or not, the operation is not: something owned still
            # holds the output pipe. Kill the whole ownership, then drain.
            ownership.terminate_and_wait(time.monotonic() + CLEANUP_GRACE_SECONDS, proc)
            try:
                out, _ = proc.communicate(timeout=CLEANUP_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                try:
                    proc.stdout.close()
                except OSError:
                    pass
                out = None
            return "timed_out", None
        # Process exited — but output completion is part of the operation:
        # descendants may still hold the pipe (parent-exits-first).
        empty_state = ownership.wait_empty(deadline)
        if empty_state != OWNERSHIP_EMPTY:
            ownership.terminate_and_wait(time.monotonic() + CLEANUP_GRACE_SECONDS, proc)
            try:
                proc.communicate(timeout=CLEANUP_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                pass
            if empty_state == OWNERSHIP_UNCERTAIN:
                return "uncertain", None
            return "timed_out", None
        if not ownership.close():
            return "uncertain", None
        return "ok", out
    finally:
        ownership.close()


def probe_core_ssh_command(git_argv, deadline):
    """Read the effective core.sshCommand through the bounded mechanism.

    Returns (state, value): state is one of PROBE_VALUE / PROBE_UNSET /
    PROBE_INDETERMINATE / PROBE_TIMED_OUT. "unset" means the read succeeded and
    the key is absent; "indeterminate" means the probe could not even start;
    neither is ever silently conflated with the other, and a timed-out probe
    fails the operation instead of guessing a default transport.
    """
    if not git_argv:
        return PROBE_UNSET, None
    cmd = [git_argv[0]]
    args = git_argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "-C" and i + 1 < len(args):
            cmd += ["-C", args[i + 1]]
            break
        i += 1
    cmd += ["config", "--get", "core.sshCommand"]
    state, out = run_bounded_capture(cmd, deadline)
    if state == "unavailable":
        # Containment could not be established; adopt() stopped the suspended
        # probe child. This is ownership uncertainty, not an ordinary config
        # lookup failure, so the main payload must not be attempted.
        return PROBE_OWNERSHIP_UNCERTAIN, None
    if state == "start_failed":
        return PROBE_INDETERMINATE, None
    if state == "timed_out":
        return PROBE_TIMED_OUT, None
    if state == "uncertain":
        return PROBE_OWNERSHIP_UNCERTAIN, None
    if out is None:
        return PROBE_INDETERMINATE, None
    # A probe that died on its own (nonzero rc) with empty output means unset;
    # `git config --get` exits 1 for an absent key.
    value = out.decode("utf-8", "replace").strip()
    if not value:
        return PROBE_UNSET, None
    return PROBE_VALUE, value


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


def child_env(git_argv, deadline):
    """Build the child environment under the operation deadline.

    Returns (env, warning, probe_state). The probe consumes part of the SAME
    deadline the main command gets; the caller fails the operation when the
    probe_state is PROBE_TIMED_OUT. The warning is emitted on stderr by main;
    it never changes the exit code.
    """
    env = _payload_environment()
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GCM_INTERACTIVE"] = "never"
    env["GIT_ASKPASS"] = os.devnull
    env["SSH_ASKPASS"] = os.devnull
    # A user's environment-level transport is authoritative — never replaced.
    if "GIT_SSH" in env or "GIT_SSH_COMMAND" in env:
        return env, None, PROBE_UNSET
    probe_state, configured = probe_core_ssh_command(git_argv, deadline)
    if probe_state in (PROBE_TIMED_OUT, PROBE_OWNERSHIP_UNCERTAIN):
        return env, None, probe_state
    if probe_state == PROBE_INDETERMINATE:
        # Distinguish "not set" from "could not be determined": with an
        # indeterminate configuration the runner must NOT inject a guessed
        # default transport — the environment is left unchanged.
        return (
            env,
            (
                "SSH configuration could not be determined (config probe failed) "
                "— leaving the transport unchanged; the operation is bounded by "
                "the deadline"
            ),
            probe_state,
        )
    if configured:
        if is_plain_ssh_command(configured):
            # The CONFIGURED command stays the transport; BatchMode only makes
            # it unattended (same precedence Git itself would apply).
            env["GIT_SSH_COMMAND"] = configured + " -o BatchMode=yes"
            return env, None, probe_state
        return (
            env,
            (
                "custom SSH transport preserved (core.sshCommand): %s — "
                "unattended mode cannot be enforced for it; the operation is "
                "bounded by the deadline" % configured
            ),
            probe_state,
        )
    env["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes"
    return env, None, probe_state


def operation_deadline_exceeded(timeout, what="git operation"):
    print(
        "error: %s exceeded the %ds deadline — %s outlived it and were "
        "terminated"
        % (
            what,
            timeout,
            "descendants" if what == "git operation" else "owned processes",
        ),
        file=sys.stderr,
    )


def finish_owned(ownership, status):
    """Close ownership before publishing status; close uncertainty fails closed."""
    if ownership.close():
        return status
    print(
        "error: Windows process ownership could not be closed cleanly — "
        "operation status is uncertain",
        file=sys.stderr,
    )
    return EXIT_TIMEOUT if status == EXIT_TIMEOUT else EXIT_OWNERSHIP_UNAVAILABLE


def main(argv):
    global _TEST_FAULT_ARMED
    # No payload, descendant, probe, or cleanup utility may inherit test-only
    # controls. Needed allowlisted values were captured at module startup.
    _purge_test_environment()
    timeout_flag = None
    command = None
    argv_file = None
    stdin_path = None
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
        if arg in ("--stdin-file", "--argv-file"):
            if i + 1 >= len(argv):
                print("error: %s requires a value" % arg, file=sys.stderr)
                return EXIT_USAGE
            if arg == "--stdin-file":
                stdin_path = argv[i + 1]
            else:
                argv_file = argv[i + 1]
            i += 2
            continue
        print("error: unknown argument: %s" % arg, file=sys.stderr)
        return EXIT_USAGE
    if command is not None and argv_file is not None:
        print("error: use either --argv-file or --, not both", file=sys.stderr)
        return EXIT_USAGE
    if argv_file is not None:
        try:
            with open(argv_file, "r", encoding="utf-8") as stream:
                command = json.load(stream)
        except (OSError, ValueError) as exc:
            print("error: cannot read argv file: %s" % exc, file=sys.stderr)
            return EXIT_USAGE
        if (
            not isinstance(command, list)
            or not command
            or not all(isinstance(value, str) for value in command)
            or not command[0]
        ):
            print(
                "error: argv file must contain a non-empty JSON string array",
                file=sys.stderr,
            )
            return EXIT_USAGE
    if not command:
        print("error: missing command after -- or --argv-file", file=sys.stderr)
        return EXIT_USAGE

    timeout = resolve_timeout(timeout_flag)
    # The deadline bounds the COMPLETE operation: configuration discovery
    # happens under it, with whatever time remains for the command itself.
    deadline = time.monotonic() + timeout
    env, env_warning, probe_state = child_env(command, deadline)
    if probe_state == PROBE_TIMED_OUT:
        print(
            "error: SSH configuration probe exceeded the %ds deadline — the "
            "transport could not be determined, so the runner refuses to "
            "proceed with a guessed default" % timeout,
            file=sys.stderr,
        )
        return EXIT_TIMEOUT
    if probe_state == PROBE_OWNERSHIP_UNCERTAIN:
        print(
            "error: SSH configuration probe ownership became uncertain — "
            "the operation was not started",
            file=sys.stderr,
        )
        return EXIT_OWNERSHIP_UNAVAILABLE
    if env_warning:
        print("warning: %s" % env_warning, file=sys.stderr)

    # Configuration discovery is preliminary and may never consume lifecycle
    # evidence. Arm the seam only at the exact main-payload ownership boundary.
    _TEST_FAULT_ARMED = True

    stdin_stream = None
    if stdin_path is not None:
        try:
            stdin_stream = open(stdin_path, "rb")
        except OSError as exc:
            print(
                "error: cannot open stdin file %r: %s" % (stdin_path, exc),
                file=sys.stderr,
            )
            return EXIT_CANNOT_START
    popen_kwargs = {"stdin": stdin_stream or subprocess.DEVNULL, "env": env}
    ownership = Ownership()
    popen_kwargs.update(ownership.spawn_kwargs())

    try:
        try:
            proc = subprocess.Popen(command, **popen_kwargs)
        except (FileNotFoundError, PermissionError, OSError) as exc:
            print("error: cannot start %r: %s" % (command[0], exc), file=sys.stderr)
            return EXIT_CANNOT_START
        _record_test_pid(proc)
        ownership.adopt(proc)
        if not ownership.available:
            # Containment could not be established before the child ran;
            # adopt() already stopped it and printed the per-stage reason.
            print(
                "error: process containment unavailable (%s) — the operation "
                "was not started" % ownership.unavailable_reason,
                file=sys.stderr,
            )
            return finish_owned(ownership, EXIT_OWNERSHIP_UNAVAILABLE)

        try:
            rc = proc.wait(timeout=max(0.0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            ownership.terminate_and_wait(time.monotonic() + CLEANUP_GRACE_SECONDS, proc)
            print(
                "error: git operation timed out after %ds and was terminated" % timeout,
                file=sys.stderr,
            )
            return finish_owned(ownership, EXIT_TIMEOUT)
        except KeyboardInterrupt:
            ownership.terminate_and_wait(time.monotonic() + CLEANUP_GRACE_SECONDS, proc)
            return finish_owned(ownership, 130)

        # The child finished, but the operation has not: descendants may still
        # hold the inherited stdout/stderr open, leaving the caller's capture
        # (e.g. Bash $(...)) blocked past the deadline. The SAME deadline
        # bounds them; on expiry the ownership is terminated so the streams
        # close and cleanup actually happens. On Windows the job object keeps
        # orphaned descendants owned after the parent's exit, so this wait is
        # as valid there as the POSIX group wait.
        empty_state = ownership.wait_empty(deadline)
        if empty_state != OWNERSHIP_EMPTY:
            ownership.terminate_and_wait(time.monotonic() + CLEANUP_GRACE_SECONDS, proc)
            if empty_state == OWNERSHIP_UNCERTAIN:
                print(
                    "error: Windows Job membership could not be verified — "
                    "owned processes were terminated and status is uncertain",
                    file=sys.stderr,
                )
                return finish_owned(ownership, EXIT_OWNERSHIP_UNAVAILABLE)
            operation_deadline_exceeded(timeout)
            return finish_owned(ownership, EXIT_TIMEOUT)

        if rc < 0:
            return finish_owned(ownership, 128 + (-rc))
        return finish_owned(ownership, rc)
    finally:
        ownership.close()
        if stdin_stream is not None:
            stdin_stream.close()


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except TestEvidenceError as exc:
        print("error: %s; injected operation refused" % exc, file=sys.stderr)
        sys.exit(EXIT_OWNERSHIP_UNAVAILABLE)
    except KeyboardInterrupt:
        sys.exit(130)

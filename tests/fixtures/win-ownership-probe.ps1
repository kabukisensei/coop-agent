# Windows owned-kill native evidence probe (Defect A).
#
# Synthetic diagnostic ONLY. Emits bounded PROBE| evidence lines; it does not
# modify product code, does not weaken any timeout/exit assertion, does not
# terminate anything by executable name, and asserts nothing about product
# correctness. Healthy on every platform: non-Windows hosts get a skip line.
#
# Evidence gathered (per project-lead spec):
#   identity: source SHA, Python version/architecture, fixture compiler
#   requested vs resolved timeout (product resolve_timeout)
#   structure sizes/offsets: product ctypes layout vs Windows SDK layout
#   Job Object create/configure/assign success + GetLastError codes
#   actual child identity; existence BEFORE termination
#   monotonic phase timings (adopt, terminate, reap, close)
#   evidence the real child is gone afterward (OpenProcess by real PID)
#   total caller-observed duration and exit status
$ErrorActionPreference = 'Stop'
# Platform detection must work on Windows PowerShell 5.1, where the
# $IsWindows automatic variable does not exist (it is PS 6+ only); a 5.1
# runner therefore used to take the skip branch below on an actual Windows
# host. [System.Environment]::OSVersion is available since .NET 1.1 and on
# both Windows PowerShell and PowerShell 7. NOTE: the probe-local variable
# must NOT be named *IsWindows* — variable names are case-insensitive, so on
# PS 7 it would collide with the read-only $IsWindows automatic variable.
$script:probeOnWindows = [System.Environment]::OSVersion.Platform -eq 'Win32NT'
if (-not $script:probeOnWindows) { Write-Host '  - win ownership probe: skipped (non-Windows)'; exit 0 }

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$py = (Get-Command python -ErrorAction SilentlyContinue)
if (-not $py) { Write-Host 'PROBE| error: python not found on this runner'; exit 2 }
$script:probeFailed = $false
$total = [System.Diagnostics.Stopwatch]::StartNew()
function Mark($name) { '{0:N3}' -f $total.Elapsed.TotalSeconds }
function Section($name, [scriptblock]$body) {
  try { & $body } catch {
    $script:probeFailed = $true
    Write-Host "PROBE| section=$name error=$($_.Exception.Message)"
  }
}

function Emit-StepResult($name, $lines) {
  # Verify each native/Python subprocess the probe drives: emit its output,
  # require exit status 0, and require at least one PROBE| evidence line.
  # A silent or failing subprocess is missing evidence, not success.
  $rc = $LASTEXITCODE
  foreach ($l in $lines) { Write-Host $l }
  if ($rc -ne 0) {
    $script:probeFailed = $true
    Write-Host "PROBE| section=$name subprocess_rc=$rc"
  } elseif (-not ($lines | Where-Object { $_ -like 'PROBE|*' })) {
    $script:probeFailed = $true
    Write-Host "PROBE| section=$name missing_PROBE_evidence"
  }
}

Section 'identity' {
  $head = (& git -C $root rev-parse HEAD 2>$null)
  $gitRc = $LASTEXITCODE
  Write-Host "PROBE| identity.git_rev_parse_rc=$gitRc"
  if ($gitRc -ne 0 -or -not $head) {
    $script:probeFailed = $true
    Write-Host 'PROBE| identity.git_rev_parse_failed=1'
  }
  Write-Host "PROBE| identity.ps_version=$($PSVersionTable.PSVersion)"
  Write-Host "PROBE| identity.os_arch=$([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)"
  Write-Host "PROBE| identity.source_sha=$head"
  $pyId = @'
import platform, sys
print("PROBE| identity.python=%s %s" % (platform.python_version(), platform.architecture()[0]))
print("PROBE| identity.python_exe=%s" % sys.executable)
'@
  $out = @($pyId | & $py.Source -)
  Emit-StepResult 'identity' $out
  $gcc = Get-Command gcc -ErrorAction SilentlyContinue
  if ($gcc) {
    Write-Host "PROBE| identity.compiler=$($gcc.Source)"
    $v = (& gcc --version 2>$null | Select-Object -First 1)
    $gccRc = $LASTEXITCODE
    Write-Host "PROBE| identity.compiler_version_rc=$gccRc"
    if ($gccRc -ne 0 -or -not $v) {
      $script:probeFailed = $true
      Write-Host 'PROBE| identity.compiler_version_failed=1'
    }
    Write-Host "PROBE| identity.compiler_version=$v"
  } else {
    Write-Host 'PROBE| identity.compiler=NONE (gcc not found)'
  }
  $req = $env:COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS
  Write-Host "PROBE| timeout.requested_env=$(if ($req) { $req } else { '<unset>' })"
}

Section 'layout' {
  $out = @(@"
import ctypes, importlib.util, sys
from ctypes import wintypes
spec = importlib.util.spec_from_file_location("kg", r"$root/scripts/knowledge-git.py")
kg = importlib.util.module_from_spec(spec); spec.loader.exec_module(kg)
cur = kg._JOBOBJECT_BASIC_LIMIT_INFORMATION
print("PROBE| layout.product_fields=" + ",".join("%s@%d" % (n, getattr(cur, n).offset) for n, _ in cur._fields_))
print("PROBE| layout.product_basic_sizeof=%d" % ctypes.sizeof(cur))
print("PROBE| layout.product_extended_sizeof=%d" % ctypes.sizeof(kg._JOBOBJECT_EXTENDED_LIMIT_INFORMATION))

class SdkBasic(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", wintypes.LARGE_INTEGER),
        ("PerJobUserTimeLimit", wintypes.LARGE_INTEGER),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]
print("PROBE| layout.sdk_fields=" + ",".join("%s@%d" % (n, getattr(SdkBasic, n).offset) for n, _ in SdkBasic._fields_))
print("PROBE| layout.sdk_basic_sizeof=%d" % ctypes.sizeof(SdkBasic))
print("PROBE| layout.sdk_limitflags_offset=%d" % SdkBasic.LimitFlags.offset)
print("PROBE| layout.product_limitflags_offset=%d" % cur.LimitFlags.offset)
print("PROBE| timeout.resolved=%d" % kg.resolve_timeout(__import__("os").environ.get("COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS")))
"@ | & $py.Source -)
  Emit-StepResult 'layout' $out
}

Section 'jobconfig' {
  $out = @(@'
import ctypes, importlib.util
from ctypes import wintypes
spec = importlib.util.spec_from_file_location("kg", r"ROOT/scripts/knowledge-git.py")
kg = importlib.util.module_from_spec(spec); spec.loader.exec_module(kg)
k32 = kg._KERNEL32
if k32 is None:
    print("PROBE| jobconfig.error=_KERNEL32 unavailable")
else:
    k32.SetLastError(0)
    raw = k32.CreateJobObjectW(None, None)
    e1 = ctypes.get_last_error()
    print("PROBE| jobconfig.create_handle=%s getlasterror=%d" % (raw, e1))
    if raw:
        k32.CloseHandle(raw)  # close the raw evidence handle immediately
        print("PROBE| jobconfig.raw_handle_closed=1")
    # Product helper via the MODULE (kg), not the WinDLL (k32); unpack the
    # current (job, error) return contract and surface the error verbatim.
    created, create_err = kg._win_job_create()
    print("PROBE| jobconfig.product_create=%s create_error=%s" % ("ok" if created else "NONE", create_err))
    if created:
        class SdkExt(ctypes.Structure):
            class Basic(ctypes.Structure):
                _fields_ = [("PerProcessUserTimeLimit", wintypes.LARGE_INTEGER),
                            ("PerJobUserTimeLimit", wintypes.LARGE_INTEGER),
                            ("LimitFlags", wintypes.DWORD),
                            ("MinimumWorkingSetSize", ctypes.c_size_t),
                            ("MaximumWorkingSetSize", ctypes.c_size_t),
                            ("ActiveProcessLimit", wintypes.DWORD),
                            ("Affinity", ctypes.c_size_t),
                            ("PriorityClass", wintypes.DWORD),
                            ("SchedulingClass", wintypes.DWORD)]
            _fields_ = [("BasicLimitInformation", Basic), ("IoInfo", kg._IO_COUNTERS),
                        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]
        try:
            k32.SetLastError(0)
            info = SdkExt()
            ok = k32.QueryInformationJobObject(created, 9, ctypes.byref(info), ctypes.sizeof(info), None)
            e2 = ctypes.get_last_error()
            print("PROBE| jobconfig.query_ok=%s getlasterror=%d" % (ok, e2))
            print("PROBE| jobconfig.kernel_limitflags=0x%x (KILL_ON_JOB_CLOSE=0x2000)" % info.BasicLimitInformation.LimitFlags)
        finally:
            k32.CloseHandle(created)
'@.Replace('ROOT', ($root -replace '\\', '/')) | & $py.Source -)
  Emit-StepResult 'jobconfig' $out
}

Section 'assignment' {
  $out = @(@'
import ctypes, importlib.util, subprocess, sys, time
spec = importlib.util.spec_from_file_location("kg", r"ROOT/scripts/knowledge-git.py")
kg = importlib.util.module_from_spec(spec); spec.loader.exec_module(kg)
t0 = time.monotonic()
own = kg.Ownership()
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], **own.spawn_kwargs())
own.child = child
t_spawn = time.monotonic() - t0
failed = False
try:
    k32 = kg._KERNEL32
    print("PROBE| assignment.child_pid=%s" % child.pid)
    if k32 is None:
        print("PROBE| assignment.error=_KERNEL32 unavailable")
        failed = True
    else:
        # Explicitly report an OpenProcess result with the same access mask used
        # by the product assignment helper; the helper then performs its own
        # independently checked OpenProcess + AssignProcessToJobObject sequence.
        k32.SetLastError(0)
        preflight = k32.OpenProcess(kg._PROCESS_SET_QUOTA | kg._PROCESS_TERMINATE, False, child.pid)
        open_err = ctypes.get_last_error()
        print("PROBE| assignment.open_process_ok=%s getlasterror=%d" % (bool(preflight), open_err))
        if preflight:
            k32.CloseHandle(preflight)
        else:
            failed = True
            raise RuntimeError("open_process_failed")

        job, create_error = kg._win_job_create()
        print("PROBE| assignment.job_create_ok=%s error=%s" % (bool(job), create_error))
        own.job = job
        if not job:
            failed = True
        else:
            assign_ok, assign_error = kg._win_job_assign(job, child.pid)
            print("PROBE| assignment.assign_ok=%s error=%s" % (assign_ok, assign_error))
            if not assign_ok:
                failed = True
                k32.CloseHandle(job)
                own.job = None
                raise RuntimeError("assign_failed")
            else:
                # Exercise the declared DWORD ResumeThread return contract and
                # report its actual previous suspend count. Do not resume until
                # containment has succeeded.
                k32.SetLastError(0)
                snap = k32.CreateToolhelp32Snapshot(kg._TH32CS_SNAPTHREAD, child.pid)
                snap_err = ctypes.get_last_error()
                print("PROBE| assignment.thread_snapshot_ok=%s getlasterror=%d" % (bool(snap and snap != kg._INVALID_HANDLE), snap_err))
                if not snap or snap == kg._INVALID_HANDLE:
                    failed = True
                else:
                    try:
                        entry = kg._THREADENTRY32()
                        entry.dwSize = ctypes.sizeof(kg._THREADENTRY32)
                        k32.SetLastError(0)
                        have = k32.Thread32First(snap, ctypes.byref(entry))
                        enum_err = ctypes.get_last_error()
                        print("PROBE| assignment.thread32first=%s getlasterror=%d" % (bool(have), enum_err))
                        resumed = False
                        thread_found = False
                        while have:
                            if entry.th32OwnerProcessID == child.pid:
                                thread_found = True
                                k32.SetLastError(0)
                                thread = k32.OpenThread(kg._THREAD_SUSPEND_RESUME, False, entry.th32ThreadID)
                                thread_err = ctypes.get_last_error()
                                print("PROBE| assignment.open_thread_ok=%s getlasterror=%d thread_id=%d" % (bool(thread and thread != kg._INVALID_HANDLE), thread_err, entry.th32ThreadID))
                                if thread and thread != kg._INVALID_HANDLE:
                                    try:
                                        k32.SetLastError(0)
                                        previous_count = k32.ResumeThread(thread)
                                        resume_error = ctypes.get_last_error()
                                        resume_ok, resume_verdict = kg._win_resume_verdict(previous_count)
                                        print("PROBE| assignment.resume_previous_count=%d getlasterror=%d ok=%s verdict=%s" % (previous_count, resume_error, resume_ok, resume_verdict))
                                        resumed = resume_ok
                                    finally:
                                        k32.CloseHandle(thread)
                                break
                            have = k32.Thread32Next(snap, ctypes.byref(entry))
                        print("PROBE| assignment.child_thread_found=%s" % thread_found)
                        if not resumed:
                            failed = True
                    finally:
                        k32.CloseHandle(snap)

        print("PROBE| assignment.ownership_available=%s" % own.available)
        if own.job:
            active = kg._win_job_active_processes(own.job)
            print("PROBE| assignment.job_active_after_assign=%s (>=1=child captured; 0=assignment absent; None=query failed)" % active)
            if active is None or active < 1:
                failed = True
        k32.SetLastError(0)
        h = k32.OpenProcess(0x1000, False, child.pid)
        e = ctypes.get_last_error()
        print("PROBE| assignment.exists_before_terminate=%s getlasterror=%d" % (bool(h), e))
        if h: k32.CloseHandle(h)
    t_done = time.monotonic() - t0
    print("PROBE| timing.spawn=%.3f native_stages_done=%.3f" % (t_spawn, t_done))
    t_term0 = time.monotonic() - t0
    if own.job:
        own.terminate()
    elif child.poll() is None:
        stop_ok, stop_error = kg._win_terminate_pid(child.pid)
        print("PROBE| cleanup.suspended_child_terminate_ok=%s error=%s" % (stop_ok, stop_error))
        if not stop_ok: failed = True
    t_term1 = time.monotonic() - t0
    print("PROBE| timing.terminate_start=%.3f terminate_done=%.3f" % (t_term0, t_term1))
    t_wait0 = time.monotonic() - t0
    empty = own.wait_empty(time.monotonic() + 8) if own.job else True
    t_wait1 = time.monotonic() - t0
    print("PROBE| timing.reap_start=%.3f reap_done=%.3f wait_empty=%s" % (t_wait0, t_wait1, empty))
    if not empty: failed = True
    if k32 is not None:
        k32.SetLastError(0)
        h = k32.OpenProcess(0x1000, False, child.pid)
        e = ctypes.get_last_error()
        print("PROBE| assignment.exists_after_terminate=%s getlasterror=%d (87=ERROR_INVALID_PARAMETER, gone)" % (bool(h), e))
        if h:
            k32.CloseHandle(h)
            failed = True
    own.close()
    print("PROBE| timing.close_done=%.3f total=%.3f" % (time.monotonic() - t0, time.monotonic() - t0))
finally:
    # Safe cleanup of everything this section owns. If create/assign/resume fails,
    # terminate the still-suspended owned child rather than letting it execute.
    # This path is reached via exception, so it must verify and emit its own
    # cleanup result instead of relying on the staged checks above.
    if child.poll() is None:
        if own.job:
            own.terminate()
        else:
            stop_ok, stop_error = kg._win_terminate_pid(child.pid)
            print("PROBE| cleanup.suspended_child_terminate_ok=%s error=%s" % (stop_ok, stop_error))
            if not stop_ok:
                failed = True
        if k32 is not None:
            k32.SetLastError(0)
            h = k32.OpenProcess(0x1000, False, child.pid)
            e = ctypes.get_last_error()
            print("PROBE| cleanup.exists_after_suspended_terminate=%s getlasterror=%d" % (bool(h), e))
            if h:
                k32.CloseHandle(h)
                failed = True
    own.close()
if failed:
    sys.exit(1)
'@.Replace('ROOT', ($root -replace '\\', '/')) | & $py.Source -)
  Emit-StepResult 'assignment' $out
}

Section 'crt_contract' {
  # Establish what _spawnvp(_P_NOWAIT) returns under the fixture's own
  # compiler/runtime: a process HANDLE per the CRT contract; derive the real
  # PID via GetProcessId; show OpenProcess-by-raw-value fails.
  $tmp = Join-Path $env:TEMP ('coop-crt-probe-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  $src = Join-Path $tmp 'crt-probe.c'
  @'
#include <stdio.h>
#include <process.h>
#include <windows.h>
int main(void) {
  const char *argv_sleep[] = {"sleep", "30", NULL};
  intptr_t kid = _spawnvp(_P_NOWAIT, "sleep", argv_sleep);
  if (kid == -1) { printf("PROBE| crt.spawn_failed\n"); return 1; }
  HANDLE h = (HANDLE)kid;
  DWORD realPid = GetProcessId(h);
  HANDLE byRaw = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)kid);
  printf("PROBE| crt.spawn_return=0x%p\n", (void*)kid);
  printf("PROBE| crt.real_pid_via_getprocessid=%lu\n", realPid);
  printf("PROBE| crt.openprocess_by_raw_value=%s\n", byRaw ? "SUCCEEDED(unexpected)" : "failed");
  if (byRaw) CloseHandle(byRaw);
  TerminateProcess(h, 1); CloseHandle(h);
  return 0;
}
'@ | Set-Content -Path $src -Encoding Ascii
  $exe = Join-Path $tmp 'crt-probe.exe'
  try {
    & gcc -O1 -o $exe $src 2>&1 | ForEach-Object { Write-Host "PROBE| crt.compile: $_" }
    if ($LASTEXITCODE -eq 0) {
      $crtOut = @(& $exe)
      Emit-StepResult 'crt_contract' $crtOut
    } else { $script:probeFailed = $true; Write-Host 'PROBE| crt.compile_failed' }
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

Write-Host ("PROBE| total_duration_seconds=" + (Mark 'end'))
if ($script:probeFailed) { exit 2 }
Write-Host 'PROBE| probe_exit=0'
exit 0

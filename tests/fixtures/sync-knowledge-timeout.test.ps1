#!/usr/bin/env pwsh
# PowerShell behavioral twin of the bounded-git regression in
# tests/sync-knowledge.test.sh.
#
# The fake `git` MUST be a real PE binary: native CreateProcess resolves the
# exact name "git" before appending .exe, so an extensionless script or a
# .cmd batch file here shadows git.exe with a non-executable file and every
# spawn dies with WinError 216. The fixture is therefore compiled from a C
# shim (same source as the Git Bash suite), passed its target paths through
# the environment, and smoke-tested standalone BEFORE any timeout assertion
# depends on it. It spawns a REAL child process (recording its PID) so the
# tests demand evidence the child existed and was terminated.
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-knowledge-timeout-ps-' + [guid]::NewGuid().ToString('N'))
$failed = $false
function Ok([string]$Message) { Write-Host "  OK  $Message" }
function Ko([string]$Message) { Write-Host "  FAIL $Message"; $script:failed = $true }
# Windows PowerShell 5.1 converts native-command stderr into terminating
# NativeCommandError records under $ErrorActionPreference='Stop' — even with
# call-site 2>$null or 2>&1-into-$null redirection when the fixture runs
# nested (powershell -File under a capturing parent, as tests/run.ps1 does).
# Empirically confirmed on CI (run 34673322072, sync-knowledge-timeout fixture
# line 32). Lowering EAP for the native invocation is the 5.1-safe form;
# $LASTEXITCODE is unaffected. Assertions are unchanged.
function Invoke-Native([Parameter(Mandatory=$true)][scriptblock]$Command) {
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Command } finally { $ErrorActionPreference = $prevEap }
}

New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
  # --- healthy local bare remote (real git, file:// URL, no network) ---------
  $remote = Join-Path $temp 'remote.git'
  $work = Join-Path $temp 'work'
  # Native setup calls run through Invoke-Native: see its header for the PS 5.1
  # NativeCommandError semantics. $LASTEXITCODE is preserved across the call.
  $null = Invoke-Native { & git init --bare -b main -q $remote 2>&1 }
  if ($LASTEXITCODE -ne 0) { $null = Invoke-Native { & git init --bare -q $remote 2>&1 }; $null = Invoke-Native { & git -C $remote symbolic-ref HEAD refs/heads/main 2>&1 } }
  $null = Invoke-Native { & git clone -q $remote $work 2>&1 }
  $null = Invoke-Native { & git -C $work config user.email test@example.com 2>&1 }
  $null = Invoke-Native { & git -C $work config user.name 'Test' 2>&1 }
  Set-Content (Join-Path $work 'note.md') 'one'
  $null = Invoke-Native { & git -C $work add note.md 2>&1 }
  $null = Invoke-Native { & git -C $work commit -qm first 2>&1 }
  $null = Invoke-Native { & git -C $work push -q -u origin main 2>&1 }

  # --- prepare the fake git --------------------------------------------------
  $fakeBin = Join-Path $temp 'fakebin'
  New-Item -ItemType Directory -Force -Path $fakeBin | Out-Null
  $fakeLog = Join-Path $temp 'fake-git.log'
  $sleeperFile = Join-Path $temp 'sleeper.pid'
  $probeOut = Join-Path $temp 'probe-env.txt'
  $realGit = (Get-Command git).Source
  $pyCmd = Get-Command python3 -ErrorAction SilentlyContinue
  if (-not $pyCmd) { $pyCmd = Get-Command python -ErrorAction SilentlyContinue }
  if (-not $pyCmd) { $pyCmd = Get-Command py -ErrorAction SilentlyContinue }
  if (-not $pyCmd) { Ko 'no python interpreter found for knowledge-git.py'; exit 1 }
  $pyExe = $pyCmd.Source

  $windowsHost = $false
  $isWindowsVar = Get-Variable IsWindows -ErrorAction SilentlyContinue
  if ($isWindowsVar) {
    $windowsHost = [bool]$IsWindows
  } else {
    $windowsHost = ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT)
  }

  $fakeGit = if ($windowsHost) { Join-Path $fakeBin 'git.exe' } else { Join-Path $fakeBin 'git' }
  $cSource = @'
/* Test fixture: a fake `git` the native subprocess launcher actually
 * executes. Mirrors the Git Bash fixture contract: log argv (FAKELOG),
 * hang/orphan past the deadline for marker repos — spawning a REAL child
 * process whose PID is recorded in SLEEPERFILE — and delegate everything
 * else to the real git (REALGIT). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <process.h>
#include <windows.h>

static void logargv(int argc, char **argv) {
    const char *fakelog = getenv("FAKELOG");
    if (!fakelog) return;
    FILE *f = fopen(fakelog, "a");
    if (!f) return;
    for (int i = 1; i < argc; i++) fprintf(f, "%s%s", i > 1 ? " " : "", argv[i]);
    fputc('\n', f);
    fclose(f);
}

static intptr_t spawn_sleeper(void) {
    static const char *git_sleep = "C:\\Program Files\\Git\\usr\\bin\\sleep.exe";
    const char *argv_sleep[] = {"sleep", "30", NULL};
    intptr_t kid = _spawnvp(_P_NOWAIT, "sleep", argv_sleep);
    if (kid != -1) return kid;
    kid = _spawnv(_P_NOWAIT, git_sleep, argv_sleep);
    if (kid != -1) return kid;
    return -1;
}

static int record_sleeper(intptr_t kid) {
    const char *sl = getenv("SLEEPERFILE");
    if (!sl || kid == -1) return 3;
    /* _spawnvp(_P_NOWAIT) returns a process HANDLE, not a PID. Convert,
       prove the spawned instance is alive NOW (before the parent exits),
       close the handle, and log the identity proof for the fixture. */
    HANDLE h = (HANDLE)kid;
    DWORD pid = GetProcessId(h);
    if (pid == 0) { CloseHandle(h); return 4; }
    if (WaitForSingleObject(h, 0) != WAIT_TIMEOUT) { CloseHandle(h); return 5; }
    CloseHandle(h);
    const char *fakelog = getenv("FAKELOG");
    if (fakelog) {
        FILE *lg = fopen(fakelog, "a");
        if (lg) {
            fprintf(lg, "spawned-sleeper pid=%lu\n", (unsigned long)pid);
            fclose(lg);
        }
    }
    FILE *f = fopen(sl, "w");
    if (!f) return 3;
    fprintf(f, "%lu", (unsigned long)pid);
    fclose(f);
    return 0;
}

int main(int argc, char **argv) {
    logargv(argc, argv);
    char buf[4096] = {0};
    for (int i = 1; i < argc; i++) {
        strncat(buf, argv[i], sizeof(buf) - strlen(buf) - 2);
        strncat(buf, " ", sizeof(buf) - strlen(buf) - 1);
    }
    int orphan = 0, hang = 0;
    if (strstr(buf, "probehang") && strstr(buf, "config --get")) orphan = 1;
    if (strstr(buf, "hanghere-orphan") && strstr(buf, "status --porcelain")) orphan = 1;
    if (!orphan) {
        if (strstr(buf, "clone") && strstr(buf, "hanghere")) hang = 1;
    }
    if (orphan) {
        intptr_t kid = spawn_sleeper();
        int rc = record_sleeper(kid);
        if (rc != 0) return rc;
        return 0;  /* parent exits FIRST; child holds the inherited stdout */
    }
    if (hang) {
        intptr_t kid = spawn_sleeper();
        int rc = record_sleeper(kid);
        if (rc != 0) return rc;
        Sleep(30000);
        return 0;
    }
    const char *realgit = getenv("REALGIT");
    if (!realgit) return 127;
    return _spawnv(_P_WAIT, realgit, (const char * const *)argv);
}
'@
  if ($windowsHost) {
    $cFile = Join-Path $temp 'fake-git.c'
    Set-Content -LiteralPath $cFile -Value $cSource -Encoding ascii
    $cc = $null
    foreach ($cand in @('gcc', 'cc', 'clang')) {
      $found = Get-Command $cand -ErrorAction SilentlyContinue
      if ($found) { $cc = $found.Source; break }
    }
    if (-not $cc) {
      foreach ($cand in @('C:\mingw64\bin\gcc.exe', 'C:\ProgramData\chocolatey\lib\mingw\tools\install\mingw64\bin\gcc.exe')) {
        if (Test-Path -LiteralPath $cand) { $cc = $cand; break }
      }
    }
    if (-not $cc) { Ko 'no C compiler found to build the Windows git fixture (fixture must execute)'; exit 1 }
    $compileOut = Invoke-Native { & $cc -O1 -o $fakeGit $cFile 2>&1 } | Out-String
    if (-not (Test-Path -LiteralPath $fakeGit)) {
      Ko "compiling the Windows git fixture failed: $compileOut"; exit 1
    }
  } else {
    $fakeScript = @'
#!/bin/sh
logargv() {
  [ -n "$FAKELOG" ] || return
  printf '%s\n' "$*" >> "$FAKELOG"
}
spawn_sleeper() {
  sleep 30 &
  kid=$!
  printf '%s' "$kid" > "$SLEEPERFILE"
  printf 'spawned-sleeper pid=%s\n' "$kid" >> "$FAKELOG"
}
logargv "$@"
args="$*"
case "$args" in
  *probehang*config\ --get*|*hanghere-orphan*status\ --porcelain*)
    spawn_sleeper
    exit 0
    ;;
  *clone*hanghere*|*hanghere*clone*)
    spawn_sleeper
    sleep 30
    exit 0
    ;;
esac
exec "$REALGIT" "$@"
'@
    Set-Content -LiteralPath $fakeGit -Value $fakeScript -Encoding ascii
    & chmod +x $fakeGit
    if (-not (Test-Path -LiteralPath $fakeGit)) {
      Ko 'creating the POSIX git fixture failed'; exit 1
    }
  }

  # Fixture environment, consumed by the fake git at runtime.
  $priorPath = $env:PATH
  $priorTimeout = $env:COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS
  $priorCoopDir = $env:COOP_DIR
  $env:FAKELOG = $fakeLog
  $env:PROBEOUT = $probeOut
  $env:REALGIT = $realGit
  $env:SLEEPERFILE = $sleeperFile
  $env:PATH = "$fakeBin$([System.IO.Path]::PathSeparator)$priorPath"

  # Standalone smoke gate: the fixture must RUN and DELEGATE before any
  # timeout assertion depends on it (an incompatible binary surfaces here as
  # a loud failure instead of a silent "fixture never ran" downstream).
  & $fakeGit --version *> $null
  if (Test-Path -LiteralPath $fakeLog) {
    $smokeLog = Get-Content -LiteralPath $fakeLog -Raw
    if ($smokeLog -like '*--version*') { Ok 'win fixture smoke: executable runs, argv logged, real git delegated' }
    else { Ko 'fixture smoke: invocation log written but argv missing' }
  } else {
    Ko 'git fixture did not execute standalone (executable-compatibility error)'; exit 1
  }
  Remove-Item -LiteralPath $fakeLog -ErrorAction SilentlyContinue

  # Instance-identity discipline for all sleeper checks: the fake git proves
  # the spawned instance existed (real PID + spawn-time liveness, logged to
  # FAKELOG); Assert-SleeperGone then verifies THAT SAME process is gone.
  # $sentinelJob is an unrelated long-lived process that must survive every
  # timeout test — evidence the kill path never strays outside the owned tree.
  $sentinelJob = Start-Job -ScriptBlock { Start-Sleep -Seconds 300 }
  function Assert-SleeperGone([string]$label) {
    Start-Sleep -Seconds 2   # allow the killed tree to be reaped
    if (-not (Test-Path -LiteralPath $sleeperFile)) {
      Ko "${label}: fake git never spawned its sleeper"
      return
    }
    $sleeperPid = [int]((Get-Content -LiteralPath $sleeperFile) -join '')
    $proof = $false
    if (Test-Path -LiteralPath $fakeLog) {
      $proof = (Get-Content -LiteralPath $fakeLog -Raw) -match ("spawned-sleeper pid=" + $sleeperPid + "(?!\d)")
    }
    if (-not $proof) {
      Ko "${label}: no spawn-time existence proof for pid $sleeperPid (recorded value was not a real PID?)"
      Remove-Item -LiteralPath $sleeperFile -ErrorAction SilentlyContinue
      return
    }
    $alive = Get-Process -Id $sleeperPid -ErrorAction SilentlyContinue
    if ($alive) { Ko "${label}: sleeper $sleeperPid survived the deadline" }
    else { Ok "${label}: sleeper $sleeperPid provably existed and is gone" }
    Remove-Item -LiteralPath $sleeperFile -ErrorAction SilentlyContinue
  }

  # --- A (PS). clone hang is bounded; the healthy repo still syncs ------------
  $cfg = Join-Path $temp 'cfg'
  New-Item -ItemType Directory -Force -Path (Join-Path $cfg '.coop') | Out-Null
  $cloneSlow = Join-Path $temp 'kb\hanghere-clone'
  $cloneOk = Join-Path $temp 'kb\healthy'
  $json = '{"schema_version":1,"knowledge":{"enabled":true,"repos":[' +
    '{"url":"https://example.invalid/hanghere-clone.git","local_path":"' + ($cloneSlow -replace '\\','/') + '"},' +
    '{"url":"' + ($remote -replace '\\','/') + '","local_path":"' + ($cloneOk -replace '\\','/') + '"}]}}'
  Set-Content (Join-Path $cfg '.coop\config') $json
  $env:COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS = '1'
  $env:COOP_DIR = $cfg
  try {
    # Independent outer deadline so a regression cannot hang CI.
    $jobOutput = Join-Path $temp 'sync-knowledge-job.log'
    $job = Start-Job -ScriptBlock {
      param($scriptPath, $outputPath)
      $oldError = [Console]::Error
      $writer = New-Object System.IO.StreamWriter($outputPath)
      [Console]::SetError($writer)
      try { & $scriptPath }
      finally {
        $writer.Flush()
        $writer.Dispose()
        [Console]::SetError($oldError)
      }
    } -ArgumentList (Join-Path $root 'scripts\sync-knowledge.ps1'), $jobOutput
    if (Wait-Job $job -Timeout 60) {
      Receive-Job $job | Out-Null
      $out = if (Test-Path -LiteralPath $jobOutput) { Get-Content -LiteralPath $jobOutput -Raw } else { '' }
      Ok 'sync completed inside the outer deadline'
    } else {
      Stop-Job $job -PassThru | Remove-Job -Force
      Ko 'sync hung past the outer deadline'
      $out = ''
    }
    Remove-Job $job -Force -ErrorAction SilentlyContinue
  } finally {
    $env:PATH = $priorPath
    if ($null -eq $priorTimeout) { Remove-Item Env:\COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS -ErrorAction SilentlyContinue } else { $env:COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS = $priorTimeout }
    if ($null -eq $priorCoopDir) { Remove-Item Env:\COOP_DIR -ErrorAction SilentlyContinue } else { $env:COOP_DIR = $priorCoopDir }
  }

  if (Test-Path -LiteralPath $fakeLog) { Ok 'fixture executed (invocation log written) (PS)' } else { Ko 'fixture never ran — missing invocation log (PS)' }
  if ($out -like '*timed out*') { Ok 'timeout warning surfaced (PS)' } else { Ko "no timeout warning (PS): $out" }
  if ($out -like '*sync complete*') { Ok 'sync still fails soft and completes (PS)' } else { Ko "sync did not complete (PS): $out" }
  if (Test-Path -LiteralPath (Join-Path $cloneOk 'note.md')) { Ok 'second healthy repo cloned in the same run (PS)' } else { Ko 'healthy repo missing (PS)' }
  Assert-SleeperGone 'sleeper descendant'

  # --- B (PS). parent-exits-first orphan: deadline still bounds the operation -
  # The fake git spawns a child holding the inherited stdout and exits. The
  # Job Object ownership in knowledge-git.py must keep the orphan owned,
  # classify the result as a TIMEOUT (not success), and terminate the child.
  $orphanRepo = Join-Path $temp 'kb\hanghere-orphan'
  New-Item -ItemType Directory -Force -Path $orphanRepo | Out-Null
  $env:COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS = '1'
  $env:PATH = "$fakeBin$([System.IO.Path]::PathSeparator)$priorPath"
  try {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $orphanOut = Invoke-Native { & $pyExe (Join-Path $root 'scripts\\knowledge-git.py') '--' git -C $orphanRepo status --porcelain 2>&1 } | Out-String
    $orphanRc = $LASTEXITCODE
    $sw.Stop()
  } finally {
    $env:PATH = $priorPath
    if ($null -eq $priorTimeout) { Remove-Item Env:\COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS -ErrorAction SilentlyContinue } else { $env:COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS = $priorTimeout }
  }
  if ($orphanRc -eq 124) { Ok 'orphan classified as a timeout, not success (rc=124) (PS)' } else { Ko "orphan rc=$orphanRc (want 124) (PS): $orphanOut" }
  if ($sw.Elapsed.TotalSeconds -lt 10) { Ok ("caller returned within the deadline + bounded cleanup ({0:n1}s, not the child's 30s) (PS)" -f $sw.Elapsed.TotalSeconds) } else { Ko "caller blocked $($sw.Elapsed.TotalSeconds)s (PS)" }
  if ($orphanOut -like '*deadline*') { Ok 'actionable deadline message on the orphan timeout (PS)' } else { Ko "no deadline message (PS): $orphanOut" }
  Assert-SleeperGone 'orphaned child'

  # --- C (PS). the probe orphan: a timed-out config probe fails the operation -
  $probeRepo = Join-Path $temp 'kb\probehang'
  New-Item -ItemType Directory -Force -Path $probeRepo | Out-Null
  $env:COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS = '1'
  $env:PATH = "$fakeBin$([System.IO.Path]::PathSeparator)$priorPath"
  try {
    $sw2 = [System.Diagnostics.Stopwatch]::StartNew()
    $probeOrphanOut = Invoke-Native { & $pyExe (Join-Path $root 'scripts\\knowledge-git.py') '--' git -C $probeRepo status --porcelain 2>&1 } | Out-String
    $probeOrphanRc = $LASTEXITCODE
    $sw2.Stop()
  } finally {
    $env:PATH = $priorPath
    if ($null -eq $priorTimeout) { Remove-Item Env:\COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS -ErrorAction SilentlyContinue } else { $env:COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS = $priorTimeout }
  }
  if ($probeOrphanRc -eq 124) { Ok 'probe orphan bounded (rc=124) (PS)' } else { Ko "probe orphan rc=$probeOrphanRc (want 124) (PS): $probeOrphanOut" }
  if ($sw2.Elapsed.TotalSeconds -lt 10) { Ok ("probe orphan returned within the deadline ({0:n1}s) (PS)" -f $sw2.Elapsed.TotalSeconds) } else { Ko "probe orphan blocked $($sw2.Elapsed.TotalSeconds)s (PS) — resolved deadline evidence: $($probeOrphanOut.Trim())" }
  Assert-SleeperGone 'probe orphan child'

  # In-process contract: & sync-knowledge.ps1 must RETURN (never exit), so the
  # sentinel line after the call is always reached — even on total failure.
  $sentinel = Join-Path $temp 'sentinel.txt'
  $env:COOP_DIR = $cfg
  $env:COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS = '1'
  $env:PATH = "$fakeBin$([System.IO.Path]::PathSeparator)$priorPath"
  try {
    & (Join-Path $root 'scripts\sync-knowledge.ps1') *> $null
    Set-Content $sentinel 'reached'
  } finally {
    $env:PATH = $priorPath
    if ($null -eq $priorTimeout) { Remove-Item Env:\COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS -ErrorAction SilentlyContinue } else { $env:COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS = $priorTimeout }
    if ($null -eq $priorCoopDir) { Remove-Item Env:\COOP_DIR -ErrorAction SilentlyContinue } else { $env:COOP_DIR = $priorCoopDir }
  }
  if (Test-Path -LiteralPath $sentinel) { Ok 'in-process invocation returned; sentinel reached after failure' } else { Ko 'sync-knowledge.ps1 exited the parent instead of returning' }
  if ($sentinelJob.State -eq 'Running') { Ok 'unrelated sentinel process survived the timeout tests' } else { Ko 'unrelated sentinel process did not survive the timeout tests' }
  Stop-Job $sentinelJob -ErrorAction SilentlyContinue
  Remove-Job $sentinelJob -Force -ErrorAction SilentlyContinue
}
finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failed) { exit 1 }
exit 0

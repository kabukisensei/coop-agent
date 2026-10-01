#!/usr/bin/env pwsh
# scripts/sync-knowledge.ps1
# against a LOCAL bare-repo fixture (real git, file paths, no network). Gate
# lane: clone on the first run, fast-forward on the second, a dirty checkout is
# warned and skipped (never reset), the disabled flag is a no-op, a bogus URL
# warns and still exits 0 without leaving a husk, and a config without the
# knowledge key is a clean no-op. The bounded-git cases that need a hanging fake
# git (status-probe hang never pulls, pull hang keeps the checkout, an
# interrupted clone never deletes an existing destination) run only in the
# EXTENDED LANE (COOP_TEST_EXTENDED=1); the clone-hang and orphan cases live in
# tests/fixtures/sync-knowledge-timeout.test.ps1, and the runner's environment /
# SSH-transport / exit-code contracts live in tests/knowledge-git.test.py.
# Sandboxed HOME/USERPROFILE/COOP_DIR, never ~/.coop.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-sync-knowledge-ps-' + [guid]::NewGuid().ToString('N'))

$syncScript = Join-Path $root 'scripts\sync-knowledge.ps1'
$sandboxHome = Join-Path $t 'home'

$saved = Save-Env @('PATH','HOME','USERPROFILE','COOP_DIR','COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS','FAKELOG','SLEEPERFILE','REALGIT','PROBEOUT','PROBEENV','NO_COLOR')
try {
  New-Item -ItemType Directory -Force -Path $sandboxHome | Out-Null
  $env:HOME = $sandboxHome
  $env:USERPROFILE = $sandboxHome
  $env:NO_COLOR = '1'
  foreach ($n in @('COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS','FAKELOG','SLEEPERFILE','REALGIT','PROBEOUT','PROBEENV')) {
    Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue
  }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is required for this fixture' }

  # --- healthy local bare remote ------------------------------------------------
  $remote = Join-Path $t 'remote.git'
  $work = Join-Path $t 'work'
  $null = Invoke-Native { & git init --bare -b main -q $remote 2>&1 }
  if ($LASTEXITCODE -ne 0) { $null = Invoke-Native { & git init --bare -q $remote 2>&1 }; $null = Invoke-Native { & git -C $remote symbolic-ref HEAD refs/heads/main 2>&1 } }
  $null = Invoke-Native { & git clone -q $remote $work 2>&1 }
  $null = Invoke-Native { & git -C $work checkout -B main -q 2>&1 }
  $null = Invoke-Native { & git -C $work config user.email test@example.com 2>&1 }
  $null = Invoke-Native { & git -C $work config user.name Test 2>&1 }
  $null = Invoke-Native { & git -C $work config core.autocrlf false 2>&1 }
  [System.IO.File]::WriteAllText((Join-Path $work 'note.md'), "one`n", $utf8)
  $null = Invoke-Native { & git -C $work add note.md 2>&1 }
  $null = Invoke-Native { & git -C $work commit -qm first 2>&1 }
  $null = Invoke-Native { & git -C $work push -q -u origin main 2>&1 }
  if (-not (Test-Path -LiteralPath (Join-Path $remote 'refs\heads\main')) -and -not (Test-Path -LiteralPath (Join-Path $remote 'packed-refs'))) {
    throw 'fixture remote has no main branch'
  }

  function Slash([string]$p) { return ($p -replace '\\', '/') }
  function Write-Config([string]$Dir, [string]$Json) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Dir '.coop') | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $Dir '.coop\config'), $Json + "`n", $utf8)
  }
  function Repo-Config([bool]$Enabled, [string[]]$Pairs) {
    # $Pairs: url, path, url, path, ...
    $repos = @()
    for ($i = 0; $i -lt $Pairs.Count; $i += 2) { $repos += ('{"url":"' + (Slash $Pairs[$i]) + '","local_path":"' + (Slash $Pairs[$i + 1]) + '"}') }
    return '{"schema_version":1,"knowledge":{"enabled":' + $Enabled.ToString().ToLower() + ',"repos":[' + ($repos -join ',') + ']}}'
  }
  # Runs sync-knowledge.ps1 in a child PowerShell with COOP_DIR=$Cfg; returns Rc + merged output.
  function Invoke-Sync([string]$Cfg) {
    $env:COOP_DIR = $Cfg
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
      $out = (& $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $syncScript 2>&1 | Out-String)
      $rc = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $eap
      Remove-Item -LiteralPath 'Env:\COOP_DIR' -ErrorAction SilentlyContinue
    }
    return [pscustomobject]@{ Rc = $rc; Out = $out }
  }
  function Read-Note([string]$Path) { ([System.IO.File]::ReadAllText($Path) -replace "`r", '').TrimEnd("`n") }

  # --- first run clones ----------------------------------------------------------
  $cfg = Join-Path $t 'cfg'
  $clone = Join-Path $t 'kb\incremental-bi'
  Write-Config $cfg (Repo-Config $true @($remote, $clone))
  $r = Invoke-Sync $cfg
  if ($r.Rc -eq 0 -and (Test-Path -LiteralPath (Join-Path $clone 'note.md'))) { Ok 'first run clones the repo' }
  else { Ko "clone failed: rc=$($r.Rc)" $r.Out }

  # --- second run fast-forwards a new commit ------------------------------------
  [System.IO.File]::AppendAllText((Join-Path $work 'note.md'), "two`n", $utf8)
  $null = Invoke-Native { & git -C $work commit -qam second 2>&1 }
  $null = Invoke-Native { & git -C $work push -q 2>&1 }
  $r = Invoke-Sync $cfg
  $content = if (Test-Path -LiteralPath (Join-Path $clone 'note.md')) { Read-Note (Join-Path $clone 'note.md') } else { '' }
  if ($r.Rc -eq 0 -and $content -eq "one`ntwo") { Ok 'second run fast-forwards the new commit' }
  else { Ko "ff failed: rc=$($r.Rc) content=[$content]" $r.Out }

  # --- dirty managed checkout: warn, skip, leave changes -------------------------
  [System.IO.File]::AppendAllText((Join-Path $clone 'note.md'), "local edit`n", $utf8)
  $r = Invoke-Sync $cfg
  if ($r.Out -match 'dirty[\s\S]*skip') { Ok 'dirty checkout warns and skips' } else { Ko 'no dirty warning' $r.Out }
  if ((Read-Note (Join-Path $clone 'note.md')).Contains('local edit')) { Ok 'dirty checkout left untouched' } else { Ko 'dirty checkout was modified' }
  if ($r.Rc -eq 0) { Ok 'dirty checkout still exits 0' } else { Ko "dirty checkout exit $($r.Rc)" $r.Out }

  # --- disabled flag is a no-op --------------------------------------------------
  $cfg2 = Join-Path $t 'cfg2'
  $kb2 = Join-Path $t 'kb2\x'
  Write-Config $cfg2 (Repo-Config $false @($remote, $kb2))
  $r = Invoke-Sync $cfg2
  if ($r.Rc -eq 0 -and -not (Test-Path -LiteralPath $kb2)) { Ok 'disabled flag is a no-op (nothing cloned)' }
  else { Ko "disabled: rc=$($r.Rc)" $r.Out }

  # --- bogus URL warns and exits 0 ------------------------------------------------
  $cfg3 = Join-Path $t 'cfg3'
  $kb3 = Join-Path $t 'kb3\x'
  Write-Config $cfg3 (Repo-Config $true @('file:///nonexistent/nowhere.git', $kb3))
  $r = Invoke-Sync $cfg3
  if ($r.Rc -ne 0) { Ko "bogus URL exited $($r.Rc)" $r.Out }
  if ($r.Out.Contains('clone failed')) { Ok 'bogus URL warns + exits 0' } else { Ko 'bogus URL gave no warning' $r.Out }
  if (-not (Test-Path -LiteralPath $kb3)) { Ok 'failed clone leaves no husk directory' } else { Ko 'husk dir left behind' }
  $husks = @(Get-ChildItem -LiteralPath (Join-Path $t 'kb3') -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '.coop-knowledge-clone-*' })
  if ($husks.Count -eq 0) { Ok 'failed clone cleaned up its owned temp clone' } else { Ko 'owned temp clone left behind' ($husks.FullName -join "`n") }

  # --- missing knowledge key is a clean no-op -------------------------------------
  $cfg4 = Join-Path $t 'cfg4'
  Write-Config $cfg4 '{"schema_version":1,"integrations":{}}'
  $r = Invoke-Sync $cfg4
  if ($r.Rc -eq 0) { Ok 'absent knowledge key exits 0' } else { Ko "absent key exit $($r.Rc)" $r.Out }

  # ==============================================================================
  # EXTENDED LANE: bounded git with a hanging fake `git` (timing + real sleeper
  # processes). A fake git records argv (FAKELOG), spawns a sleeping descendant
  # (PID in SLEEPERFILE) and hangs for marker repos; everything else delegates to
  # the real git (REALGIT). On Windows it must be a real PE binary (compiled from
  # a C shim, see sync-knowledge-timeout.test.ps1); on POSIX a sh script.
  # ==============================================================================
  if ($env:COOP_TEST_EXTENDED -eq '1') {
    $fakeBin = Join-Path $t 'fakebin'
    New-Item -ItemType Directory -Force -Path $fakeBin | Out-Null
    $fakeLog = Join-Path $t 'fake-git.log'
    $sleeperFile = Join-Path $t 'sleeper.pid'
    $realGit = (Get-Command git).Source
    $fakeGit = if ($isWindowsHost) { Join-Path $fakeBin 'git.exe' } else { Join-Path $fakeBin 'git' }
    if ($isWindowsHost) {
      $cSource = @'
/* Test fixture: a fake `git` the native subprocess launcher executes. Logs
 * argv (FAKELOG), spawns a REAL sleeping child (PID in SLEEPERFILE) and hangs
 * for marker repos; delegates everything else to the real git (REALGIT). */
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
    HANDLE h = (HANDLE)kid;
    DWORD pid = GetProcessId(h);
    if (pid == 0) { CloseHandle(h); return 4; }
    if (WaitForSingleObject(h, 0) != WAIT_TIMEOUT) { CloseHandle(h); return 5; }
    CloseHandle(h);
    const char *fakelog = getenv("FAKELOG");
    if (fakelog) {
        FILE *lg = fopen(fakelog, "a");
        if (lg) { fprintf(lg, "spawned-sleeper pid=%lu\n", (unsigned long)pid); fclose(lg); }
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
    int hang = 0;
    if (strstr(buf, "status --porcelain") && strstr(buf, "hanghere-status")) hang = 1;
    if (strstr(buf, " pull ") && strstr(buf, "hanghere-pull")) hang = 1;
    if (strstr(buf, "clone") && strstr(buf, "hanghere")) hang = 1;
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
      $cFile = Join-Path $t 'fake-git.c'
      [System.IO.File]::WriteAllText($cFile, $cSource, [System.Text.Encoding]::ASCII)
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
      if (-not $cc) { throw 'no C compiler found to build the Windows git fixture (fixture must execute)' }
      $compileOut = Invoke-Native { & $cc -O1 -o $fakeGit $cFile 2>&1 } | Out-String
      if (-not (Test-Path -LiteralPath $fakeGit)) { throw "compiling the Windows git fixture failed: $compileOut" }
    } else {
      $fakeScript = @'
#!/bin/sh
[ -n "$FAKELOG" ] && printf '%s\n' "$*" >> "$FAKELOG"
hang() {
  sleep 30 &
  kid=$!
  printf '%s' "$kid" > "$SLEEPERFILE"
  printf 'spawned-sleeper pid=%s\n' "$kid" >> "$FAKELOG"
  wait
  exit 0
}
# Dispatch by SUBCOMMAND first, then by repo marker, so e.g. a status probe on
# the pull-hang repo passes through while its pull hangs.
case "$*" in
  *"status --porcelain"*) case "$*" in *hanghere-status*) hang ;; esac ;;
  *" pull "*)             case "$*" in *hanghere-pull*) hang ;; esac ;;
  "clone "*|*" clone "*)  case "$*" in *hanghere*) hang ;; esac ;;
esac
exec "$REALGIT" "$@"
'@
      [System.IO.File]::WriteAllText($fakeGit, $fakeScript, [System.Text.Encoding]::ASCII)
      & chmod +x $fakeGit
    }
    $env:FAKELOG = $fakeLog
    $env:REALGIT = $realGit
    $env:SLEEPERFILE = $sleeperFile
    $env:PATH = "$fakeBin$sep$($saved['PATH'])"

    # Smoke gate: the fake must RUN and DELEGATE before any timeout assertion depends on it.
    Remove-Item -LiteralPath $fakeLog -ErrorAction SilentlyContinue
    $null = Invoke-Native { & $fakeGit --version 2>&1 }
    if ((Test-Path -LiteralPath $fakeLog) -and ((Get-Content -LiteralPath $fakeLog -Raw) -like '*--version*')) { Ok 'fake git smoke: runs, argv logged, real git delegated' }
    else { throw 'git fixture did not execute standalone' }

    # Runs sync in a child process with an independent 60s outer deadline; returns
    # Rc, Out, TimedOut. $OnSleeper runs once the fake git has recorded its sleeper
    # (case D creates the destination while the clone is hanging).
    function Invoke-SyncBounded([string]$Cfg, [string]$Timeout = '3', [scriptblock]$OnSleeper = $null) {
      $env:COOP_DIR = $Cfg
      $env:COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS = $Timeout
      $so = Join-Path $t 'bounded.out'; $se = Join-Path $t 'bounded.err'
      try {
        $p = Start-Process -FilePath $psExe -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $syncScript + '"')) `
          -PassThru -NoNewWindow -RedirectStandardOutput $so -RedirectStandardError $se
        $null = $p.Handle
        if ($OnSleeper) {
          for ($i = 0; $i -lt 200; $i++) { if (Test-Path -LiteralPath $sleeperFile) { break }; Start-Sleep -Milliseconds 100 }
          & $OnSleeper
        }
        $timedOut = -not $p.WaitForExit(60000)
        if ($timedOut) { try { $p.Kill() } catch { }; $p.WaitForExit() }
        $rc = $p.ExitCode
      } finally {
        Remove-Item -LiteralPath 'Env:\COOP_DIR' -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath 'Env:\COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS' -ErrorAction SilentlyContinue
      }
      $out = ''
      foreach ($f in @($se, $so)) { if (Test-Path -LiteralPath $f) { $out += [System.IO.File]::ReadAllText($f) } }
      return [pscustomobject]@{ Rc = $rc; Out = $out; TimedOut = $timedOut }
    }
    function Get-LogLines([string]$Needle) {
      if (-not (Test-Path -LiteralPath $fakeLog)) { return @() }
      return @(Get-Content -LiteralPath $fakeLog | Where-Object { $_.Contains($Needle) })
    }

    # --- B. status-probe hang: unknown state, NEVER pulls -------------------------
    $cfg6 = Join-Path $t 'cfg6'
    $statusRepo = Join-Path $t 'kbh2\hanghere-status'
    $null = Invoke-Native { & $realGit clone -q $remote $statusRepo 2>&1 }
    Write-Config $cfg6 (Repo-Config $true @($remote, $statusRepo))
    Remove-Item -LiteralPath $fakeLog, $sleeperFile -Force -ErrorAction SilentlyContinue
    $r = Invoke-SyncBounded $cfg6
    if ((Test-Path -LiteralPath $fakeLog) -and (Get-Item -LiteralPath $fakeLog -Force).Length -gt 0) { Ok 'B: fixture executed (invocation log written)' } else { Ko 'B: fixture never ran (missing invocation log)' }
    if (-not $r.TimedOut) { Ok 'B: sync completed inside the outer deadline' } else { Ko 'B: sync hung past the outer deadline' $r.Out }
    if ($r.Out.Contains('state unknown')) { Ok 'B: unknown-state warning on status timeout' } else { Ko 'B: no unknown-state warning' $r.Out }
    if ($r.Rc -eq 0) { Ok 'B: fails soft (exit 0)' } else { Ko "B: exit $($r.Rc)" $r.Out }
    $statusLines = @(Get-LogLines 'hanghere-status')
    if (@($statusLines | Where-Object { $_.Contains('status --porcelain') }).Count -gt 0) { Ok 'B: status probe invoked' } else { Ko 'B: status probe missing from log' ($statusLines -join "`n") }
    if (@($statusLines | Where-Object { $_.Contains('pull') }).Count -eq 0) { Ok 'B: failed status probe never pulls' } else { Ko 'B: pull was invoked despite the failed status probe' ($statusLines -join "`n") }
    Assert-SleeperGone 'B'

    # --- C. pull hang: bounded, warned, checkout preserved ---------------------------
    $cfg7 = Join-Path $t 'cfg7'
    $pullRepo = Join-Path $t 'kbh3\hanghere-pull'
    $null = Invoke-Native { & $realGit clone -q $remote $pullRepo 2>&1 }
    Write-Config $cfg7 (Repo-Config $true @($remote, $pullRepo))
    Remove-Item -LiteralPath $fakeLog, $sleeperFile -Force -ErrorAction SilentlyContinue
    $r = Invoke-SyncBounded $cfg7
    if (-not $r.TimedOut) { Ok 'C: sync completed inside the outer deadline' } else { Ko 'C: sync hung past the outer deadline' $r.Out }
    if ($r.Out.Contains('timed out')) { Ok 'C: pull timeout warned' } else { Ko 'C: no pull timeout warning' $r.Out }
    if (Test-Path -LiteralPath (Join-Path $pullRepo 'note.md')) { Ok 'C: existing checkout preserved' } else { Ko 'C: checkout damaged' }
    Assert-SleeperGone 'C'

    # --- D. interrupted clone cleanup cannot delete an existing destination ----------
    $cfg8 = Join-Path $t 'cfg8'
    $dest8 = Join-Path $t 'kbh4\hanghere-dest'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest8) | Out-Null
    Write-Config $cfg8 (Repo-Config $true @('https://example.invalid/hanghere-dest.git', $dest8))
    Remove-Item -LiteralPath $fakeLog, $sleeperFile -Force -ErrorAction SilentlyContinue
    # Pre-create the destination once the clone is ACTUALLY hanging (sleeper recorded).
    $r = Invoke-SyncBounded $cfg8 '5' {
      New-Item -ItemType Directory -Force -Path $dest8 | Out-Null
      [System.IO.File]::WriteAllText((Join-Path $dest8 'keep.txt'), "user data`n", $utf8)
    }
    if (-not $r.TimedOut) { Ok 'D: sync completed inside the outer deadline' } else { Ko 'D: sync hung past the outer deadline' $r.Out }
    if ((Test-Path -LiteralPath (Join-Path $dest8 'keep.txt')) -and ([System.IO.File]::ReadAllText((Join-Path $dest8 'keep.txt')).Contains('user data'))) { Ok 'D: existing destination survived interrupted clone' }
    else { Ko 'D: destination was deleted' $r.Out }
    Assert-SleeperGone 'D'
  } else {
    Write-Host '  - skipped the bounded-git cases B/C/D (COOP_TEST_EXTENDED=1 runs them)'
  }
} catch {
  Ko "fixture error: $($_.Exception.Message)" ($_.ScriptStackTrace)
} finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}

if ($fail -ne 0) { Write-Host "  $G_CROSS sync-knowledge.ps1 (PowerShell) tests FAILED"; exit 1 }
Write-Host '  sync-knowledge.ps1 (PowerShell) tests passed'
exit 0

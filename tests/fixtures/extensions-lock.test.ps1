#!/usr/bin/env pwsh
# config/extensions-lock.json pins the isolated extension tree's TRANSITIVE
# dependencies (issue #152). Behavioural half of tests/extensions-lock.test.sh
# (the structural lock-vs-manifest checks stay there): with a stub npm and a stub
# pi at the manifest's version,
#   - Install-CoopExtensionsLock copies the lock beside package.json and runs
#     `npm ci` on an exact tree; a tree the lock cannot hold, or a Pi other than
#     the manifest's, gets no lock and no npm ci (the caller resolves live);
#   - Sync-CoopExtensionPins reaches the lock from its fast path (a tree already
#     at pin but without the lock), rewrites caret ranges to exact pins first,
#     and leaves a tree that carries the shipped lock alone;
#   - a lock this machine cannot install (`npm ci` fails) falls back to the live
#     install ONCE and is remembered in .coop-lock-failed.json until a new lock
#     ships; a lock that installs clears the record.
# Offline: node and python are real (lib/pins.js, lib/_extdeps.py, lib/extlock.js
# run locally); the lock is read, never resolved; temp trees only.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$isWindowsHost = ($env:OS -eq 'Windows_NT')
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-extlock-' + [guid]::NewGuid().ToString('N'))
$G_CHECK = [char]0x2713; $G_CROSS = [char]0x2717
$fail = 0
function Ok([string]$m) { Write-Host "  $G_CHECK $m" }
function Ko([string]$m, [string]$Out = '') { Write-Host "  $G_CROSS $m"; if ($Out) { Write-Host $Out }; $script:fail = 1 }
$chmod = if ($isWindowsHost) { '' } else { (Get-Command chmod -ErrorAction Stop).Source }
$sep = [System.IO.Path]::PathSeparator
$lock = Join-Path $root 'config\extensions-lock.json'
$manifest = Get-Content -LiteralPath (Join-Path $root 'config\release-manifest.json') -Raw | ConvertFrom-Json
$piVer = [string]$manifest.pi.version
$extNames = @($manifest.extensions.PSObject.Properties.Name)
$specs = @($extNames | ForEach-Object { "$_@$($manifest.extensions.$_)" })
$npmLog = Join-Path $t 'npm.log'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Shim {
  param([string]$Dir, [string]$Name, [string]$Sh, [string]$Cmd)
  [System.IO.File]::WriteAllText((Join-Path $Dir $Name), "#!/bin/sh`n$Sh`n")
  # .cmd twins only on Windows: Get-CoopWorkingNpm prefers npm.cmd through Get-Command,
  # which on Linux/macOS would try to run the batch file.
  if ($isWindowsHost) { [System.IO.File]::WriteAllText((Join-Path $Dir ($Name + '.cmd')), "@echo off`r`n$Cmd`r`n") }
  else { & $chmod +x (Join-Path $Dir $Name) }
}
function Get-Log { if (Test-Path -LiteralPath $npmLog) { return [System.IO.File]::ReadAllText($npmLog) } else { return '' } }
function Reset-Log { [System.IO.File]::WriteAllText($npmLog, '') }
function Test-LogHas([string]$Prefix) { return [bool]@((Get-Log) -split "`r?`n" | Where-Object { $_.StartsWith($Prefix) }).Count }
function Test-SameFile([string]$A, [string]$B) {
  if (-not (Test-Path -LiteralPath $A) -or -not (Test-Path -LiteralPath $B)) { return $false }
  return ((Get-FileHash -LiteralPath $A -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $B -Algorithm SHA256).Hash)
}
# A tree whose package.json declares the manifest pins exactly (plus extras / an
# override version): what `coop sync` converges to.
function New-Tree([string]$Dir, [hashtable]$Extra, [string]$Override) {
  $npmDir = Join-Path $Dir 'npm'
  New-Item -ItemType Directory -Force -Path $npmDir | Out-Null
  $deps = [ordered]@{}
  foreach ($n in $extNames) { $deps[$n] = [string]$manifest.extensions.$n }
  foreach ($k in $Extra.Keys) { $deps[$k] = $Extra[$k] }
  $pkg = [ordered]@{ name = 'pi-extensions'; private = $true; dependencies = $deps
    overrides = [ordered]@{ '@earendil-works/pi-ai' = $Override; '@earendil-works/pi-tui' = $Override; '@earendil-works/pi-coding-agent' = $Override } }
  [System.IO.File]::WriteAllText((Join-Path $npmDir 'package.json'), ($pkg | ConvertTo-Json -Depth 5), $utf8)
}
# What `pi install` leaves: exact-pin node_modules, caret-range package.json.
function New-InstalledTree([string]$Dir) {
  $npmDir = Join-Path $Dir 'npm'
  Remove-Item -LiteralPath (Join-Path $npmDir 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $npmDir | Out-Null
  $deps = [ordered]@{}
  foreach ($n in $extNames) {
    $v = [string]$manifest.extensions.$n
    $deps[$n] = "^$v"
    $d = Join-Path (Join-Path $npmDir 'node_modules') $n
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $d 'package.json'), ('{"name":"' + $n + '","version":"' + $v + '"}'), $utf8)
  }
  $pkg = [ordered]@{ name = 'pi-extensions'; private = $true; dependencies = $deps }
  [System.IO.File]::WriteAllText((Join-Path $npmDir 'package.json'), ($pkg | ConvertTo-Json -Depth 5), $utf8)
}
function Invoke-Converge([string]$Dir) {
  $ErrorActionPreference = 'Continue'
  $r = Sync-CoopExtensionPins -AgentDir $Dir -Specs $specs *>&1
  return [bool]@($r | Where-Object { $_ -is [bool] } | Select-Object -Last 1)[0]
}

$saved = @{}
$names = @('PATH', 'HOME', 'USERPROFILE', 'COOP_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'NO_COLOR', 'COOP_SKIP_AZ', 'COOP_TEST_NPM_LOG')
foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
try {
  $stub = Join-Path $t 'stub'; $failStub = Join-Path $t 'failstub'
  New-Item -ItemType Directory -Force -Path $stub, $failStub, (Join-Path $t 'home'), (Join-Path $t 'agent') | Out-Null
  $env:HOME = Join-Path $t 'home'; $env:USERPROFILE = $env:HOME
  $env:COOP_AGENT_DIR = Join-Path $t 'agent'; $env:PI_CODING_AGENT_DIR = $env:COOP_AGENT_DIR
  $env:NO_COLOR = '1'; $env:COOP_SKIP_AZ = '1'
  $env:COOP_TEST_NPM_LOG = $npmLog
  # Stub npm: logs every call; the failing twin refuses `npm ci` (the VM, 2026-10-01).
  $npmSh = 'if [ "$1" = "--version" ]; then echo 10.9.0; exit 0; fi; echo "NPM $*" >> "$COOP_TEST_NPM_LOG"'
  $npmCmd = 'if "%1"=="--version" (echo 10.9.0& exit /b 0)' + "`r`n" + 'echo NPM %*>>"%COOP_TEST_NPM_LOG%"'
  Write-Shim $stub 'npm' ($npmSh + '; exit 0') ($npmCmd + "`r`n" + 'exit /b 0')
  Write-Shim $failStub 'npm' ($npmSh + '; if [ "$1" = "ci" ]; then exit 1; fi; exit 0') ($npmCmd + "`r`n" + 'if "%1"=="ci" exit /b 1' + "`r`n" + 'exit /b 0')
  foreach ($d in @($stub, $failStub)) {
    Write-Shim $d 'pi' "if [ `"`$1`" = `"--version`" ]; then echo `"pi $piVer`"; fi; exit 0" "if `"%1`"==`"--version`" echo pi $piVer"
  }
  $basePath = $env:PATH
  $env:PATH = $stub + $sep + $basePath
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node is required (lib/extlock.js, lib/pins.js)' }

  . (Join-Path $root 'lib\common.ps1')
  if (-not (Test-Path -LiteralPath $lock)) { Ko 'config/extensions-lock.json is missing' }

  # --- 5. End to end through the helper: lock applies only when it can hold ----
  $exact = Join-Path $t 'exact'; New-Tree $exact @{} $piVer
  $extra = Join-Path $t 'extra'; New-Tree $extra @{ 'some-personal-extension' = '1.0.0' } $piVer
  Reset-Log
  $applied = Install-CoopExtensionsLock -AgentDir $exact -Npm (Join-Path $stub 'npm') -PiVersion $piVer
  if ($applied -and (Test-Path -LiteralPath (Join-Path $exact 'npm\package-lock.json')) -and (Test-LogHas 'NPM ci ')) {
    Ok 'sync copies the lock next to package.json and runs npm ci on an exact tree'
  } else { Ko 'lock path did not run npm ci on an exact tree' (Get-Log) }
  if (Test-SameFile $lock (Join-Path $exact 'npm\package-lock.json')) { Ok "the tree's package-lock.json is byte-identical to the shipped lock" } else { Ko 'the copied lock differs from config/extensions-lock.json' }
  Reset-Log
  $applied = Install-CoopExtensionsLock -AgentDir $extra -Npm (Join-Path $stub 'npm') -PiVersion $piVer
  if ($applied) { Ko 'lock path claimed success on a tree the lock cannot hold' }
  elseif (-not (Test-Path -LiteralPath (Join-Path $extra 'npm\package-lock.json')) -and -not (Test-LogHas 'NPM ci ')) {
    Ok 'a tree the lock cannot hold gets no lock and no npm ci (caller resolves live)'
  } else { Ko 'lock path touched a tree it cannot hold' (Get-Log) }
  Reset-Log
  $applied = Install-CoopExtensionsLock -AgentDir $exact -Npm (Join-Path $stub 'npm') -PiVersion '0.0.1'
  if ($applied -or (Test-LogHas 'NPM ci ')) { Ko "lock applied although the installed Pi is not the manifest's Pi" (Get-Log) }
  else { Ok "an installed Pi other than the manifest's (edge, matrix) skips the lock" }
  if (Test-CoopExtensionsLockPending -AgentDir $extra -PiVersion $piVer) { Ok 'a tree without the lock on the manifest Pi is lock-pending' } else { Ko 'a tree without the lock should be lock-pending' }
  if (Test-CoopExtensionsLockPending -AgentDir $exact -PiVersion $piVer) { Ko 'a tree carrying the shipped lock must not be lock-pending' } else { Ok 'a tree carrying the shipped lock is not lock-pending' }
  if (Test-CoopExtensionsLockPending -AgentDir $extra -PiVersion '0.0.1') { Ko 'another Pi must not be lock-pending' } else { Ok "another Pi than the manifest's is never lock-pending" }

  # --- 6. The convergence fast path still reaches the lock (VM finding) --------
  $installed = Join-Path $t 'installed'; New-InstalledTree $installed
  Reset-Log
  $r = Invoke-Converge $installed
  if ($r -and (Test-LogHas 'NPM ci ') -and (Test-SameFile $lock (Join-Path $installed 'npm\package-lock.json'))) {
    Ok 'an already-at-pin tree without the lock still gets exact pins and npm ci'
  } else { Ko 'fast path skipped the lock on an already-at-pin tree' (Get-Log) }
  $deps = (Get-Content -LiteralPath (Join-Path $installed 'npm\package.json') -Raw | ConvertFrom-Json).dependencies
  $carets = @($deps.PSObject.Properties | Where-Object { ([string]$_.Value).StartsWith('^') }).Count
  if ($carets -eq 0) { Ok 'pins.js rewrote the caret ranges pi install records to exact pins before npm ci' } else { Ko 'package.json still carries caret ranges' }
  Reset-Log
  $r = Invoke-Converge $installed
  if ($r -and -not (Get-Log).Trim()) { Ok 'a tree that already carries the shipped lock is left alone (idempotent, offline)' } else { Ko 'a locked tree was reinstalled' (Get-Log) }

  # --- 7. A lock this machine cannot install: fall back once, remember it ------
  $env:PATH = $failStub + $sep + $basePath
  $nolock = Join-Path $t 'nolock'; New-InstalledTree $nolock
  $failed = Join-Path $nolock 'npm\.coop-lock-failed.json'
  $treeLock = Join-Path $nolock 'npm\package-lock.json'
  Reset-Log
  $r = Invoke-Converge $nolock
  if ($r -and (Test-LogHas 'NPM ci ') -and (Test-LogHas 'NPM install ') -and -not (Test-Path -LiteralPath $treeLock) -and (Test-SameFile $lock $failed)) {
    Ok 'a failed npm ci falls back to the live install, drops the copied lock and records the failed lock'
  } else { Ko "failed-lock fallback misbehaved (lock=$(if (Test-Path -LiteralPath $treeLock) { 'present' } else { 'absent' }))" (Get-Log) }
  Reset-Log
  $r = Invoke-Converge $nolock
  if ($r -and -not (Get-Log).Trim()) { Ok 'the next sync does not retry a lock this machine already failed to install (no npm call)' } else { Ko 'a known-failed lock was retried' (Get-Log) }
  Remove-Item -LiteralPath (Join-Path $nolock 'npm\node_modules') -Recurse -Force
  Reset-Log
  $r = Invoke-Converge $nolock
  if ($r -and -not (Test-LogHas 'NPM ci ') -and (Test-LogHas 'NPM install ')) { Ok 'a wiped tree with a known-failed lock goes straight to the live install (VM step 5)' } else { Ko 'a wiped tree retried a known-failed lock' (Get-Log) }
  New-InstalledTree $nolock
  [System.IO.File]::WriteAllText($failed, "{`"stale`": true}`n", $utf8)
  Reset-Log
  $r = Invoke-Converge $nolock
  if ($r -and (Test-LogHas 'NPM ci ')) { Ok 'a different (new) lock is tried again after an earlier failure' } else { Ko 'a new lock was not retried after an earlier failure' (Get-Log) }
  [System.IO.File]::WriteAllText($failed, "{`"stale`": true}`n", $utf8)
  $env:PATH = $stub + $sep + $basePath
  Reset-Log
  $r = Invoke-Converge $nolock
  if ($r -and (Test-LogHas 'NPM ci ') -and -not (Test-Path -LiteralPath $failed) -and (Test-SameFile $lock $treeLock)) { Ok 'a lock that installs clears the failed-lock record' } else { Ko 'a successful lock install left the failed-lock record' (Get-Log) }
}
finally {
  foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  extensions-lock behaviour tests passed' } else { Write-Host "  $G_CROSS extensions-lock behaviour tests FAILED" }
exit $fail

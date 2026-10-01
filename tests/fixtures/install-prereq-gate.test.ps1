#!/usr/bin/env pwsh
# H1: install.ps1 checks every prerequisite first, prints the exact command for
# each missing one, and stops before installing anything; doctor.ps1 reports the
# same rows; Coop-Warn prints its "how to fix" hint. Stubs only.
# Assertions stay ASCII: Windows PowerShell 5.1 re-encodes child stderr.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$psExe = try { (Get-Process -Id $PID).Path } catch { 'pwsh' }
$isWindowsHost = ($env:OS -eq 'Windows_NT')
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-prereq-gate-' + [guid]::NewGuid().ToString('N'))
$bin = Join-Path $t 'bin'
$fail = 0
function Ko([string]$m, [string]$out) { Write-Host "  x $m"; Write-Host $out; $script:fail = 1 }
# Captured BEFORE PATH is restricted to the stub dir: later cases write shims too.
$chmod = if ($isWindowsHost) { '' } else { (Get-Command chmod -ErrorAction Stop).Source }

function Write-Shim {
  param([string]$Name, [string]$Sh, [string]$Cmd, [string]$Dir = $bin)
  [System.IO.File]::WriteAllText((Join-Path $Dir $Name), "#!/bin/sh`n$Sh`n")
  [System.IO.File]::WriteAllText((Join-Path $Dir ($Name + '.cmd')), "@echo off`r`n$Cmd`r`n")
  if (-not $isWindowsHost) { & $chmod +x (Join-Path $Dir $Name) }
}
# Run install.ps1 and return its output; "$_" keeps each stderr line whole
# (Out-String can wrap long lines). Sets $script:installRc.
function Invoke-Install([string[]]$InstallArgs = @()) {
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $lines = @(& $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\install.ps1') @InstallArgs 2>&1 | ForEach-Object { "$_" })
  $script:installRc = $LASTEXITCODE
  $ErrorActionPreference = $eap
  return ($lines -join "`n")
}

$saved = @{}
$names = @('PATH','HOME','USERPROFILE','COOP_DIR','COOP_AGENT_DIR','PI_CODING_AGENT_DIR','COOP_NO_ONBOARD','COOP_FLEET_TEST_MODE','LOCALAPPDATA','ProgramFiles')
foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
try {
  New-Item -ItemType Directory -Force -Path $bin, (Join-Path $t 'home'), (Join-Path $t 'agent'), (Join-Path $t 'lad'), (Join-Path $t 'pf') | Out-Null
  Write-Shim 'uname' 'echo Darwin' 'echo Darwin'
  Write-Shim 'git' "echo 'git version 2.50.0'" 'echo git version 2.50.0'
  Write-Shim 'az' "echo 'azure-cli 2.80.0'" 'echo azure-cli 2.80.0'
  Write-Shim 'pipx' 'echo 1.7.1' 'echo 1.7.1'
  Write-Shim 'py' 'exit 1' 'exit /b 1'
  # "Python missing": every probed name answers with nothing (Store-stub-like).
  foreach ($n in @('python3', 'python', 'python3.12', 'python3.13')) { Write-Shim $n 'exit 0' 'exit /b 0' }
  # #112 --prereqs auto cases: installer shims do nothing; off Windows the steps
  # run through `sh -c`. A coop shim lives in its own dir, on PATH only when linked.
  Write-Shim 'winget' 'exit 0' 'exit /b 0'
  Write-Shim 'brew' 'exit 0' 'exit /b 0'
  if (-not $isWindowsHost) { Write-Shim 'sh' 'exec /bin/sh "$@"' 'exit /b 0' }
  $linked = Join-Path $t 'linked'
  New-Item -ItemType Directory -Force -Path $linked | Out-Null
  Write-Shim 'coop' 'exit 0' 'exit /b 0' $linked

  $env:PATH = $bin
  $env:HOME = Join-Path $t 'home'
  # Windows PowerShell derives $HOME from USERPROFILE: without it, install.ps1
  # and doctor.ps1 would put the real ~\.local\bin on PATH and read the real
  # ~\.config\mcp\mcp.json.
  $env:USERPROFILE = $env:HOME
  $env:COOP_DIR = Join-Path $t 'coop-dir'
  $env:COOP_AGENT_DIR = Join-Path $t 'agent'
  $env:PI_CODING_AGENT_DIR = $env:COOP_AGENT_DIR
  $env:COOP_NO_ONBOARD = '1'
  $env:COOP_FLEET_TEST_MODE = '1'
  $env:LOCALAPPDATA = Join-Path $t 'lad'
  $env:ProgramFiles = Join-Path $t 'pf'

  $nodeFix = if ($isWindowsHost) { 'winget install --id OpenJS.NodeJS.LTS -e' } else { 'brew install node' }
  $pyFix = if ($isWindowsHost) { 'winget install --id Python.Python.3.12 -e' } else { 'brew install python@3.12' }

  # #112: $bin is the whole PATH, so no real coop can leak into the "not linked
  # yet" cases; until step 7 links coop, the stop lines name Install coop.cmd.
  if (Get-Command coop -ErrorAction SilentlyContinue) { Ko 'a coop is on the stub PATH' $env:PATH }
  $launch = '& "' + (Join-Path $root 'bin\coop.cmd') + '" install'
  $rerun = "then double-click Install coop.cmd again (or run: $launch)"

  $out = Invoke-Install
  if ($installRc -eq 0) { Ko 'install.ps1 exited 0 with Node and Python missing' $out }
  foreach ($want in @('1. Git  (2.50.0)', '2. Node.js 22.19.0 or newer  (not found)', $nodeFix, '3. Python 3.10-3.13 (3.12 recommended)  (not found)', $pyFix, '2 required prerequisite(s) missing. Install the')) {
    if (-not $out.Contains($want)) { Ko "install.ps1 output is missing: $want" $out }
  }
  if ($out.Contains('2/8')) { Ko 'install.ps1 went past the prerequisite stage' $out }
  if ($fail -eq 0) { Write-Host '  ok install.ps1 without Node/Python stops at the checklist with both commands' }
  foreach ($want in @(" rows above in that order, open a NEW terminal, $rerun", "(or let coop run those commands for you: $launch --prereqs auto)")) {
    if (-not $out.Contains($want)) { Ko "install.ps1 output is missing: $want" $out }
  }
  if ($fail -eq 0) { Write-Host '  ok with coop not linked yet, the stop lines name Install coop.cmd and the clone launcher (#112)' }

  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $dout = (& $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\doctor.ps1') 2>&1 | Out-String)
  $drc = $LASTEXITCODE
  $ErrorActionPreference = $eap
  if ($drc -eq 0) { Ko 'doctor.ps1 exited 0 with Node and Python missing' $dout }
  $nodeRow = [regex]::Escape('2. Node.js 22.19.0 or newer  (not found)') + '.*' + [regex]::Escape($nodeFix)
  if ($dout -notmatch $nodeRow) { Ko 'doctor.ps1 does not show the same Node row and command as install' $dout }
  elseif ($fail -eq 0) { Write-Host '  ok doctor.ps1 reports the same prerequisite rows as install' }

  $common = Join-Path $root 'lib\common.ps1'
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $wout = (& $psExe -NoProfile -Command ". '$common'; Coop-Warn 'odbc missing' 'install the driver'" 2>&1 | Out-String)
  $ErrorActionPreference = $eap
  if ($wout -notmatch 'odbc missing .* install the driver') { Ko 'Coop-Warn dropped its hint argument' $wout }
  else { Write-Host '  ok Coop-Warn prints its how-to-fix hint' }

  # #112: the --prereqs auto re-check stop, before and after coop is on PATH.
  $autoOut = Invoke-Install @('--prereqs', 'auto')
  $want = "Open a NEW terminal so the new tools are on PATH, $rerun"
  if ($installRc -eq 0 -or -not $autoOut.Contains($want)) { Ko "install.ps1 --prereqs auto output is missing: $want" $autoOut }
  else { Write-Host '  ok with coop not linked yet, the --prereqs auto stop names Install coop.cmd (#112)' }

  $env:PATH = $linked + [System.IO.Path]::PathSeparator + $bin
  $lout = Invoke-Install
  foreach ($want in @(' rows above in that order, open a NEW terminal, then run: coop install', '(or let coop run those commands for you: coop install --prereqs auto)')) {
    if (-not $lout.Contains($want)) { Ko "install.ps1 with coop on PATH is missing: $want" $lout }
  }
  if ($lout.Contains('Install coop.cmd')) { Ko 'install.ps1 with coop on PATH still names Install coop.cmd' $lout }
  $lout = Invoke-Install @('--prereqs', 'auto')
  $want = 'Open a NEW terminal so the new tools are on PATH, then run: coop install'
  if (-not $lout.Contains($want)) { Ko "install.ps1 --prereqs auto with coop on PATH is missing: $want" $lout }
  if ($fail -eq 0) { Write-Host '  ok with coop on PATH, the stop lines still say: coop install' }

  # A machine whose only Python is 3.14 passes row 3 when its pipx can fetch a
  # standalone 3.12 for the Fabric CLI, with either spelling of that flag
  # (pipx 1.5-1.11: --fetch-missing-python; 1.12+: --fetch-python). Node stays
  # missing here, so the exit code is not under test, only the row's text.
  $env:PATH = $bin
  foreach ($n in @('python3', 'python')) { Write-Shim $n 'if [ "$1" = --version ]; then echo "Python 3.14.2"; fi; exit 0' 'if "%1"=="--version" echo Python 3.14.2' }
  Write-Shim 'pipx' 'if [ "$1 $2" = "install --help" ]; then echo "  --fetch-missing-python"; else echo 1.7.1; fi; exit 0' 'if "%1 %2"=="install --help" (echo   --fetch-missing-python) else (echo 1.7.1)'
  $out = Invoke-Install
  $want = '3. Python 3.10-3.13 (3.12 recommended)  (3.14.2; pipx fetches 3.12 for the Fabric CLI)'
  if (-not $out.Contains($want)) { Ko "install.ps1 with Python 3.14 + a fetch-capable pipx is missing: $want" $out }
  else { Write-Host '  ok Python 3.14 plus a pipx that can fetch a Python passes row 3 (older --fetch-missing-python spelling too)' }

  # Python 3.14 with a pipx too old to fetch a Python: Windows prints the
  # admin-free repair (upgrade pipx; 1.12+ downloads a standalone 3.12); other
  # platforms keep the package manager's Python as the fix.
  Write-Shim 'pipx' 'echo 1.4.3' 'echo 1.4.3'
  $out = Invoke-Install
  $wantRow = '3. Python 3.10-3.13 (3.12 recommended)  (3.14.2 only; the Fabric CLI needs 3.10-3.13)'
  $wantFix = if ($isWindowsHost) { '-m pip install --user --upgrade pipx' } else { $pyFix }
  if (-not $out.Contains($wantRow)) { Ko "install.ps1 with Python 3.14 + an old pipx is missing: $wantRow" $out }
  elseif (-not $out.Contains($wantFix)) { Ko "install.ps1 with Python 3.14 + an old pipx is missing the fix: $wantFix" $out }
  elseif ($isWindowsHost -and $out.Contains('winget install --id Python.Python.3.12')) { Ko 'install.ps1 with an old pipx still sent the user to winget' $out }
  else { Write-Host '  ok Python 3.14 plus an old pipx names the repair for this platform' }
}
finally {
  foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
exit $fail

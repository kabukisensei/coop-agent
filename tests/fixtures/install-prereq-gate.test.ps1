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

function Write-Shim {
  param([string]$Name, [string]$Sh, [string]$Cmd)
  [System.IO.File]::WriteAllText((Join-Path $bin $Name), "#!/bin/sh`n$Sh`n")
  [System.IO.File]::WriteAllText((Join-Path $bin ($Name + '.cmd')), "@echo off`r`n$Cmd`r`n")
  if (-not $isWindowsHost) { & chmod +x (Join-Path $bin $Name) }
}

$saved = @{}
$names = @('PATH','HOME','COOP_DIR','COOP_AGENT_DIR','PI_CODING_AGENT_DIR','COOP_NO_ONBOARD','COOP_FLEET_TEST_MODE','LOCALAPPDATA','ProgramFiles')
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

  $env:PATH = $bin
  $env:HOME = Join-Path $t 'home'
  $env:COOP_DIR = Join-Path $t 'coop-dir'
  $env:COOP_AGENT_DIR = Join-Path $t 'agent'
  $env:PI_CODING_AGENT_DIR = $env:COOP_AGENT_DIR
  $env:COOP_NO_ONBOARD = '1'
  $env:COOP_FLEET_TEST_MODE = '1'
  $env:LOCALAPPDATA = Join-Path $t 'lad'
  $env:ProgramFiles = Join-Path $t 'pf'

  $nodeFix = if ($isWindowsHost) { 'winget install --id OpenJS.NodeJS.LTS -e' } else { 'brew install node' }
  $pyFix = if ($isWindowsHost) { 'winget install --id Python.Python.3.12 -e' } else { 'brew install python@3.12' }

  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $out = (& $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\install.ps1') 2>&1 | Out-String)
  $rc = $LASTEXITCODE
  $ErrorActionPreference = $eap
  if ($rc -eq 0) { Ko 'install.ps1 exited 0 with Node and Python missing' $out }
  foreach ($want in @('1. Git  (2.50.0)', '2. Node.js 22.19.0 or newer  (not found)', $nodeFix, '3. Python 3.10-3.13 (3.12 recommended)  (not found)', $pyFix, '2 required prerequisite(s) missing. Install the')) {
    if (-not $out.Contains($want)) { Ko "install.ps1 output is missing: $want" $out }
  }
  if ($out.Contains('2/9')) { Ko 'install.ps1 went past the prerequisite stage' $out }
  if ($fail -eq 0) { Write-Host '  ok install.ps1 without Node/Python stops at the checklist with both commands' }

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
}
finally {
  foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
exit $fail

#!/usr/bin/env pwsh
# Execute the real Windows installer with an incompatible generic Python and an
# initially absent explicit Fabric interpreter and no Windows Python installer.
# pipx must fetch a standalone 3.12 runtime, proving install.ps1 does not require
# winget, py, or pymanager to repair a Python 3.14-only workstation.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$install = Join-Path $root 'scripts\install.ps1'
$update = Join-Path $root 'scripts\update.ps1'
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-install-python-' + [guid]::NewGuid().ToString('N'))
$bin = Join-Path $t 'bin'
$calls = Join-Path $t 'calls'
$isWindowsHost = ($env:OS -eq 'Windows_NT')
if (-not $isWindowsHost) {
  Write-Host '  --  Windows fresh-install prerequisite fixture runs in Windows CI'
  exit 0
}

function Write-Shim {
  param([string]$Name, [string]$Sh, [string]$Cmd)
  [System.IO.File]::WriteAllText((Join-Path $bin $Name), $Sh)
  [System.IO.File]::WriteAllText((Join-Path $bin ($Name + '.cmd')), $Cmd)
  if (-not $isWindowsHost) { & chmod +x (Join-Path $bin $Name) }
}

$saved = @{}
foreach ($name in @('PATH','HOME','COOP_DIR','PIPX_HOME','PIPX_BIN_DIR','PI_CODING_AGENT_DIR','COOP_AGENT_DIR','COOP_NO_ONBOARD','COOP_FLEET_TEST_MODE','COOP_FABRIC_PYTHON','COOP_TEST_CALLS','COOP_TEST_PY_TEMPLATE','LOCALAPPDATA','ProgramFiles','SystemRoot')) {
  $saved[$name] = [Environment]::GetEnvironmentVariable($name)
}

try {
  New-Item -ItemType Directory -Force -Path $bin, (Join-Path $t 'home'), (Join-Path $t 'pipx-home'), (Join-Path $t 'pipx-bin'), (Join-Path $t 'agent'), (Join-Path $t 'program-files'), (Join-Path $t 'local-app-data'), (Join-Path $t 'system-root') | Out-Null
  $fabricPython = Join-Path $t $(if ($isWindowsHost) { 'python312.cmd' } else { 'python312' })
  $pythonTemplate = Join-Path $t $(if ($isWindowsHost) { 'python-template.cmd' } else { 'python-template' })
  if ($isWindowsHost) {
    [System.IO.File]::WriteAllText($pythonTemplate, "@echo off`r`nif `"%1`"==`"--version`" echo Python 3.12.9`r`nif `"%1`"==`"-c`" echo 3.12`r`nexit /b 0`r`n")
  } else {
    [System.IO.File]::WriteAllText($pythonTemplate, "#!/bin/sh`n[ `"`$1`" = `"--version`" ] && echo 'Python 3.12.9'`n[ `"`$1`" = `"-c`" ] && echo '3.12'`nexit 0`n")
    & chmod +x $pythonTemplate
  }

  Write-Shim 'python3' @'
#!/bin/sh
[ "$1" = "--version" ] && echo 'Python 3.14.6'
[ "$1" = "-c" ] && echo '3.14'
exit 0
'@ @'
@echo off
if "%1"=="--version" echo Python 3.14.6
if "%1"=="-c" echo 3.14
exit /b 0
'@
  Write-Shim 'pi' @'
#!/bin/sh
[ "$1" = "--version" ] && echo 'pi 0.84.3'
exit 0
'@ @'
@echo off
if "%1"=="--version" echo pi 0.84.3
exit /b 0
'@
  Write-Shim 'git' @'
#!/bin/sh
[ "$1" = "--version" ] && { echo 'git version 2.50.0'; exit 0; }
exit 1
'@ @'
@echo off
if "%1"=="--version" (
  echo git version 2.50.0
  exit /b 0
)
exit /b 1
'@
  Write-Shim 'npm' "#!/bin/sh`nexit 0`n" "@echo off`r`nexit /b 0`r`n"
  Write-Shim 'pipx' @'
#!/bin/sh
echo "PIPX $*" >> "$COOP_TEST_CALLS"
if [ "$1" = "list" ]; then
  echo 'package coop-data-doc 1.1.1'; echo 'package coop-sql-review 0.15.2'; echo 'package coop-dax-review 0.22.0'; echo 'package ms-fabric-cli 1.7.0'
fi
exit 0
'@ @'
@echo off
echo PIPX %*>>"%COOP_TEST_CALLS%"
if "%1"=="install" if "%2"=="--help" (
  echo --fetch-python {always,missing,never}
  exit /b 0
)
if "%1"=="list" (
  echo package coop-data-doc 1.1.1
  echo package coop-sql-review 0.15.2
  echo package coop-dax-review 0.22.0
  echo package ms-fabric-cli 1.7.0
)
exit /b 0
'@
  Write-Shim 'fab' "#!/bin/sh`necho 'fab version 1.7.0'`n" "@echo off`r`necho fab version 1.7.0`r`n"
  Write-Shim 'az' "#!/bin/sh`necho 'azure-cli 2.80.0'`n" "@echo off`r`necho azure-cli 2.80.0`r`n"

  $env:PATH = "$bin$([System.IO.Path]::PathSeparator)$($saved['PATH'])"
  $env:HOME = Join-Path $t 'home'
  $env:COOP_DIR = Join-Path $t 'coop-dir'
  $env:PIPX_HOME = Join-Path $t 'pipx-home'
  $env:PIPX_BIN_DIR = Join-Path $t 'pipx-bin'
  $env:PI_CODING_AGENT_DIR = Join-Path $t 'agent'
  $env:COOP_AGENT_DIR = $env:PI_CODING_AGENT_DIR
  $env:COOP_NO_ONBOARD = '1'
  $env:COOP_FLEET_TEST_MODE = '1'
  $env:COOP_FABRIC_PYTHON = $fabricPython
  $env:COOP_TEST_CALLS = $calls
  $env:COOP_TEST_PY_TEMPLATE = $pythonTemplate
  $env:LOCALAPPDATA = Join-Path $t 'local-app-data'
  $env:ProgramFiles = Join-Path $t 'program-files'
  $env:SystemRoot = Join-Path $t 'system-root'
  [System.IO.File]::WriteAllText($calls, '')

  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & $install --force 2>&1 | Out-String
  $rc = $LASTEXITCODE
  $ErrorActionPreference = $oldPreference
  if ($rc -ne 0) { Write-Error "install fixture exited $rc`n$output`n$(Get-Content $calls -Raw)" }
  $transcript = Get-Content $calls -Raw
  if ($transcript -like '*WINGET*') { Write-Error "Python 3.14-only install unexpectedly required winget`n$transcript" }
  if ($transcript -notlike '*PIPX install --force --fetch-python=missing --python 3.12 ms-fabric-cli==1.7.0*') { Write-Error "Fabric CLI did not fetch and use a standalone Python 3.12`n$transcript" }
  Write-Host '  OK  Windows installer fetches a standalone Fabric Python without winget/py/pymanager'

  [System.IO.File]::WriteAllText($calls, '')
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & $update 2>&1 | Out-String
  $rc = $LASTEXITCODE
  $ErrorActionPreference = $oldPreference
  if ($rc -ne 0) { Write-Error "update fixture exited $rc`n$output`n$(Get-Content $calls -Raw)" }
  $transcript = Get-Content $calls -Raw
  if ($transcript -notlike '*PIPX install --force --fetch-python=missing --python 3.12 ms-fabric-cli==1.7.0*') { Write-Error "Updater did not rebuild Fabric CLI with standalone Python 3.12`n$transcript" }
  if ($transcript -notlike '*PIPX inject ms-fabric-cli fabric-cicd==1.3.0 --force*') { Write-Error "Updater did not reinject fabric-cicd after rebuilding Fabric CLI`n$transcript" }
  Write-Host '  OK  Windows updater repairs an existing Python 3.14 Fabric environment'
}
finally {
  foreach ($name in $saved.Keys) {
    if ($null -eq $saved[$name]) { [Environment]::SetEnvironmentVariable($name, $null) }
    else { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
  }
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}

#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
. (Join-Path $root 'lib/common.ps1')

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("coop-pipx-owner-" + [guid]::NewGuid().ToString('N'))
$toolBin = Join-Path $tmp 'tools'
$pipxBinDir = Join-Path $tmp 'exposed'
$venvsDir = Join-Path $tmp 'venvs'
$venvBin = Join-Path $venvsDir 'ms-fabric-cli/Scripts'
$rogueBin = Join-Path $tmp 'rogue'
$linkBin = Join-Path $tmp 'links'
$jsonFile = Join-Path $tmp 'pipx-list.json'
New-Item -ItemType Directory -Force -Path $toolBin, $pipxBinDir, $venvBin, $rogueBin, $linkBin | Out-Null

$envNames = @('PATH', 'COOP_PIPX_BIN', 'COOP_PIPX_HOME', 'PIPX_HOME',
              'COOP_TEST_LOCAL_VENVS', 'COOP_TEST_PIPX_BIN_DIR', 'COOP_TEST_PIPX_JSON')
$prior = @{}
foreach ($name in $envNames) { $prior[$name] = [Environment]::GetEnvironmentVariable($name) }

try {
  $chmod = if ($env:OS -eq 'Windows_NT') { $null } else { (Get-Command chmod -ErrorAction Stop).Source }
  # Real pipx on Windows lists apps WITH their extension ("fab.exe"); the
  # matcher must also accept bare names from older installs — both are covered.
  $metadata = @{
    pipx_spec_version = '0.1'
    venvs = @{
      'ms-fabric-cli' = @{
        metadata = @{ main_package = @{ apps = @('fab.exe') } }
      }
    }
  }
  [System.IO.File]::WriteAllText($jsonFile, (($metadata | ConvertTo-Json -Depth 8) + [Environment]::NewLine))

  $isWin = ($env:OS -eq 'Windows_NT')
  if ($isWin) {
    $pipxCmd = Join-Path $toolBin 'selected-pipx.cmd'
    $shim = @'
@echo off
if "%1"=="environment" if "%3"=="PIPX_LOCAL_VENVS" echo %COOP_TEST_LOCAL_VENVS%
if "%1"=="environment" if "%3"=="PIPX_BIN_DIR" echo %COOP_TEST_PIPX_BIN_DIR%
if "%1"=="list" type "%COOP_TEST_PIPX_JSON%"
'@
    [System.IO.File]::WriteAllText($pipxCmd, $shim)
  } else {
    $pipxCmd = Join-Path $toolBin 'selected-pipx'
    $shim = @'
#!/bin/sh
if [ "$1" = environment ] && [ "$3" = PIPX_LOCAL_VENVS ]; then printf '%s\n' "$COOP_TEST_LOCAL_VENVS"; exit 0; fi
if [ "$1" = environment ] && [ "$3" = PIPX_BIN_DIR ]; then printf '%s\n' "$COOP_TEST_PIPX_BIN_DIR"; exit 0; fi
if [ "$1" = list ]; then while IFS= read -r line; do printf '%s\n' "$line"; done < "$COOP_TEST_PIPX_JSON"; exit 0; fi
exit 1
'@
    [System.IO.File]::WriteAllText($pipxCmd, $shim)
    & $chmod +x $pipxCmd
  }

  $launcher = Join-Path $pipxBinDir 'fab.exe'
  [System.IO.File]::WriteAllText($launcher, "#!/bin/sh`nexit 0`n")
  if (-not $isWin) { & $chmod +x $launcher }

  $env:COOP_PIPX_BIN = $pipxCmd
  Remove-Item Env:COOP_PIPX_HOME -ErrorAction SilentlyContinue
  Remove-Item Env:PIPX_HOME -ErrorAction SilentlyContinue
  $env:COOP_TEST_LOCAL_VENVS = $venvsDir
  $env:COOP_TEST_PIPX_BIN_DIR = $pipxBinDir
  $env:COOP_TEST_PIPX_JSON = $jsonFile
  $sep = [System.IO.Path]::PathSeparator
  # Deliberately omit any command literally named "pipx" from PATH: the
  # COOP_PIPX_BIN override must be independently authoritative.
  $env:PATH = "$toolBin$sep$pipxBinDir"

  $owned = Get-CoopExePipxVenv 'fab.exe'
  if ($owned -ne 'ms-fabric-cli') { throw "external pipx launcher resolved to '$owned'" }
  Write-Output '  ✓ external Windows-style launcher maps through pipx metadata'

  # Older pipx metadata lists bare app names without the .exe suffix.
  $metadata.venvs.'ms-fabric-cli'.metadata.main_package.apps = @('fab')
  [System.IO.File]::WriteAllText($jsonFile, (($metadata | ConvertTo-Json -Depth 8) + [Environment]::NewLine))
  $owned = Get-CoopExePipxVenv 'fab.exe'
  if ($owned -ne 'ms-fabric-cli') { throw "bare-name metadata resolved to '$owned'" }
  Write-Output '  ✓ extension-less pipx metadata still matches'

  $rogue = Join-Path $rogueBin 'fab.exe'
  [System.IO.File]::WriteAllText($rogue, "#!/bin/sh`nexit 0`n")
  if (-not $isWin) { & $chmod +x $rogue }
  $env:PATH = "$rogueBin$sep$toolBin$sep$pipxBinDir"
  $wrong = Get-CoopExePipxVenv 'fab.exe'
  if ($null -ne $wrong) { throw "unrelated launcher was credited to '$wrong'" }
  Write-Output '  ✓ same-name executable outside PIPX_BIN_DIR is rejected'

  $target = Join-Path $venvBin 'fab.exe'
  [System.IO.File]::WriteAllText($target, "#!/bin/sh`nexit 0`n")
  if (-not $isWin) { & $chmod +x $target }
  $candidate = $target
  try {
    $link = Join-Path $linkBin 'fab-link'
    New-Item -ItemType SymbolicLink -Path $link -Target $target -ErrorAction Stop | Out-Null
    $candidate = $link
  } catch {
    # Windows hosts without symlink permission still exercise direct venv membership.
  }
  $direct = Get-CoopExePipxVenv $candidate
  if ($direct -ne 'ms-fabric-cli') { throw "venv path/symlink resolved to '$direct'" }
  Write-Output '  ✓ venv path and symlink ownership remain supported'
}
finally {
  foreach ($name in $envNames) {
    if ($null -eq $prior[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($name, [string]$prior[$name]) }
  }
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

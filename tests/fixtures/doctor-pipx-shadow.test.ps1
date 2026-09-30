#!/usr/bin/env pwsh
# PowerShell twin of tests/inventory.test.sh F4 + F4c: the coop-data-doc row of
# scripts/doctor.ps1 with a fake pipx (COOP_PIPX_BIN), a fake pipx home
# (COOP_PIPX_HOME) and a fixture release manifest (COOP_RELEASE_MANIFEST).
#   1. A FOREIGN coop-data-doc earlier on PATH (pip --user copy, another tool
#      manager, leftover shim) reporting 1.1.1 while the pipx venv's metadata says
#      1.2.0 is a PATH shadow: a warning that names the resolved path and both
#      versions, never "stale/corrupt" (teammate report, 2026-09-30, v0.24.0).
#   2. The genuine case is unchanged: the venv's OWN console script disagreeing
#      with the metadata is still the stale/corrupt failure with the --force hint.
# Sandboxed HOME/COOP_DIR/agent dir, never ~/.coop; COOP_SKIP_AZ=1 keeps az out.
# Assertions stay ASCII: Windows PowerShell 5.1 re-encodes child output.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$psExe = try { (Get-Process -Id $PID).Path } catch { 'pwsh' }
$isWindowsHost = ($env:OS -eq 'Windows_NT')
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-doctor-shadow-' + [guid]::NewGuid().ToString('N'))
$fail = 0
function Ok([string]$m) { Write-Host "  ok $m" }
function Ko([string]$m, [string]$out = '') { Write-Host "  x $m"; if ($out) { Write-Host $out }; $script:fail = 1 }

$Pin = '1.2.0'
$shadowDir = Join-Path $t 'shadowbin'
$fakeBin = Join-Path $t 'fakebin'
$pipxHome = Join-Path $t 'pipxhome'
$venvsDir = Join-Path $pipxHome 'venvs'
$venvBin = Join-Path $venvsDir 'coop-data-doc\bin'
$pipxBinDir = Join-Path $t 'pipx-bin-dir-not-on-path'
$cwd = Join-Path $t 'cwd'
$sandboxHome = Join-Path $t 'home'
$agent = Join-Path $t 'agent'
$doctor = Join-Path $root 'scripts\doctor.ps1'
$utf8 = New-Object System.Text.UTF8Encoding($false)

# Write a tiny command that prints one line: a .cmd on Windows (Get-Command
# resolves it), a sh script elsewhere. Returns the path Get-Command will report.
function New-Stub([string]$Dir, [string]$Name, [string]$Line) {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  if ($isWindowsHost) {
    $p = Join-Path $Dir "$Name.cmd"
    [System.IO.File]::WriteAllText($p, "@echo off`r`necho $Line`r`n", [System.Text.Encoding]::ASCII)
  } else {
    $p = Join-Path $Dir $Name
    [System.IO.File]::WriteAllText($p, "#!/bin/sh`necho '$Line'`n", $utf8)
    & chmod +x $p
  }
  return $p
}

$saved = @{}
$names = @('PATH','HOME','USERPROFILE','COOP_DIR','COOP_AGENT_DIR','PI_CODING_AGENT_DIR','COOP_NO_ISOLATE',
           'COOP_SKIP_AZ','NO_COLOR','COOP_PIPX_BIN','COOP_PIPX_HOME','PIPX_HOME','COOP_RELEASE_MANIFEST')
foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
$savedLocation = Get-Location
try {
  New-Item -ItemType Directory -Force -Path $shadowDir, $fakeBin, $venvBin, $pipxBinDir, $cwd, $sandboxHome, (Join-Path $t 'coop\.coop'), $agent | Out-Null

  # Fixture manifest: only the python tools matter here.
  $manifest = Join-Path $t 'manifest.json'
  [System.IO.File]::WriteAllText($manifest, ('{"schema_version":1,"python_tools":{"coop-data-doc":"' + $Pin + '","coop-sql-review":"0.15.2","coop-dax-review":"0.22.0","ms-fabric-cli":"1.7.0","fabric-cicd":"1.3.0","pyodbc":"5.3.0"}}'), $utf8)

  # Fake pipx: `runpip coop-data-doc show coop-data-doc` answers the venv's
  # metadata (1.2.0); `environment --value` answers the fixture dirs; anything
  # else fails, so no other distribution is credited.
  if ($isWindowsHost) {
    $pipx = Join-Path $fakeBin 'pipx.cmd'
    $lines = @(
      '@echo off',
      ('if "%~1"=="runpip" if "%~2"=="coop-data-doc" if "%~3"=="show" if "%~4"=="coop-data-doc" (echo Name: coop-data-doc& echo Version: ' + $Pin + '& exit /b 0)'),
      ('if "%~1"=="environment" if "%~3"=="PIPX_LOCAL_VENVS" (echo ' + $venvsDir + '& exit /b 0)'),
      ('if "%~1"=="environment" if "%~3"=="PIPX_BIN_DIR" (echo ' + $pipxBinDir + '& exit /b 0)'),
      'exit /b 1'
    )
    [System.IO.File]::WriteAllText($pipx, (($lines -join "`r`n") + "`r`n"), [System.Text.Encoding]::ASCII)
  } else {
    $pipx = Join-Path $fakeBin 'pipx'
    $lines = @(
      '#!/bin/sh',
      'case "$*" in',
      ('  "runpip coop-data-doc show coop-data-doc") echo "Name: coop-data-doc"; echo "Version: ' + $Pin + '"; exit 0 ;;'),
      ('  "environment --value PIPX_LOCAL_VENVS") echo "' + $venvsDir + '"; exit 0 ;;'),
      ('  "environment --value PIPX_BIN_DIR") echo "' + $pipxBinDir + '"; exit 0 ;;'),
      'esac',
      'exit 1'
    )
    [System.IO.File]::WriteAllText($pipx, (($lines -join "`n") + "`n"), $utf8)
    & chmod +x $pipx
  }
  # Doctor refreshes the coop-agent checkout at most once a day; a fresh stamp
  # in the sandbox agent dir keeps this fixture offline.
  [System.IO.File]::WriteAllText((Join-Path $agent '.coop-fetch-stamp'), '')

  $env:HOME = $sandboxHome
  $env:USERPROFILE = $sandboxHome
  $env:COOP_DIR = Join-Path $t 'coop'
  $env:COOP_AGENT_DIR = $agent
  $env:COOP_SKIP_AZ = '1'
  $env:NO_COLOR = '1'
  $env:COOP_PIPX_BIN = $pipx
  $env:COOP_PIPX_HOME = $pipxHome
  $env:COOP_RELEASE_MANIFEST = $manifest
  foreach ($n in @('PI_CODING_AGENT_DIR','COOP_NO_ISOLATE','PIPX_HOME')) {
    Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue
  }
  Set-Location -LiteralPath $cwd

  function Get-DoctorRows() {
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
      $raw = (& $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $doctor --json 2>$null | Out-String)
    } finally {
      $ErrorActionPreference = $eap
    }
    $doc = @($raw -split "`r?`n" | Where-Object { $_.StartsWith('{"checks"') }) | Select-Object -Last 1
    if (-not $doc) { throw "doctor.ps1 --json printed no document: $raw" }
    return @(($doc | ConvertFrom-Json).checks)
  }
  function Show-Rows($Rows) {
    (@($Rows | Where-Object { ([string]$_.name).Contains('coop-data-doc') } | ForEach-Object { "$($_.status) | $($_.name) | $($_.hint)" }) -join "`n")
  }
  $sep = [System.IO.Path]::PathSeparator

  # 1. PATH shadow: the foreign copy is first on PATH; the venv's own script is
  #    not on PATH at all (its launcher would live in PIPX_BIN_DIR).
  $shadow = New-Stub $shadowDir 'coop-data-doc' 'coop-data-doc, version 1.1.1'
  $null = New-Stub $venvBin 'coop-data-doc' "coop-data-doc, version $Pin"
  $env:PATH = "$shadowDir$sep$fakeBin$sep$($saved['PATH'])"
  $resolved = (Get-Command coop-data-doc -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  if ($resolved -ne $shadow) { throw "fixture must resolve the shadow stub (got $resolved)" }
  $rows = Get-DoctorRows
  $stale = @($rows | Where-Object { ([string]$_.name).Contains('coop-data-doc') -and ([string]$_.name).Contains('stale/corrupt') })
  if ($stale.Count -ne 0) {
    Ko 'doctor.ps1 must not report a PATH-shadowed coop-data-doc as a stale venv' (Show-Rows $rows)
  } else { Ok 'doctor.ps1 does not report a PATH-shadowed coop-data-doc as a stale venv' }
  $expect = "coop-data-doc skipped: coop-data-doc on PATH ($shadow) is not the pipx one (it reports 1.1.1; pipx metadata says $Pin)"
  $row = @($rows | Where-Object { ([string]$_.name) -eq $expect }) | Select-Object -First 1
  if ($null -eq $row -or $row.status -ne 'warn') {
    Ko 'doctor.ps1 must classify the shadow with the resolved path and both versions' (Show-Rows $rows)
  } else { Ok 'doctor.ps1 classifies the shadow with the resolved path and both versions' }
  if ($null -eq $row -or -not ([string]$row.hint).Contains('pip uninstall coop-data-doc') -or -not ([string]$row.hint).Contains('pipx ensurepath')) {
    Ko 'doctor.ps1 shadow hint must name removing the copy or fixing PATH order' (Show-Rows $rows)
  } else { Ok 'doctor.ps1 shadow hint names removing the copy or fixing PATH order' }

  # 2. Genuine disagreement: only the venv's own script is on PATH and it
  #    reports 1.0.0 against metadata 1.2.0 (twin of F4). Still stale/corrupt.
  Remove-Item -LiteralPath $shadow -Force
  $null = New-Stub $venvBin 'coop-data-doc' 'coop-data-doc, version 1.0.0'
  $env:PATH = "$venvBin$sep$fakeBin$sep$($saved['PATH'])"
  $rows = Get-DoctorRows
  $stale = @($rows | Where-Object { ([string]$_.name) -eq "coop-data-doc pipx environment is stale/corrupt: metadata says $Pin but coop-data-doc reports 1.0.0" })
  if ($stale.Count -ne 1 -or $stale[0].status -ne 'fail' -or -not ([string]$stale[0].hint).StartsWith("pipx install --force coop-data-doc==$Pin")) {
    Ko 'doctor.ps1 must still fail a genuine in-venv metadata/CLI disagreement with the --force hint' (Show-Rows $rows)
  } else { Ok 'doctor.ps1 still fails a genuine in-venv metadata/CLI disagreement with the --force hint' }
} catch {
  Ko "fixture error: $($_.Exception.Message)" ($_.ScriptStackTrace)
} finally {
  Set-Location -LiteralPath $savedLocation
  foreach ($n in $names) {
    if ($null -eq $saved[$n]) { Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
  }
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}

if ($fail -ne 0) { Write-Host '  x doctor.ps1 pipx PATH-shadow rows (PowerShell) tests FAILED'; exit 1 }
Write-Host '  doctor.ps1 pipx PATH-shadow rows (PowerShell) tests passed'
exit 0

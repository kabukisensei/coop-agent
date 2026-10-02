#!/usr/bin/env pwsh
# Doctor fleet-pin rows found by the v0.27.0 VM update check (2026-10-02): an
# update from v0.24.0 left powerbi-desktop-bridge-cli at 0.1.2 against a pin of
# 1.0.0 while doctor ticked it green (presence only), and the retired
# coop-sql-review / coop-dax-review stayed in pipx with no mention.
#   1. Each npm tool is compared with its manifest pin: at the pin is ok, off it
#      is a warning naming both versions with a `coop update` hint. The Desktop
#      bridge is checked on Windows only.
#   2. A retired reviewer still in pipx is a warning with `pipx uninstall`; one
#      that is not installed gets no row.
# Fake npm and pipx on PATH / COOP_PIPX_BIN, a fixture release manifest, and a
# sandboxed HOME/COOP_DIR/agent dir; COOP_SKIP_AZ=1 keeps az out.
# Assertions stay ASCII: Windows PowerShell 5.1 re-encodes child output.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-doctor-pins-' + [guid]::NewGuid().ToString('N'))
$bin = Join-Path $t 'fakebin'
$cwd = Join-Path $t 'cwd'
$sandboxHome = Join-Path $t 'home'
$agent = Join-Path $t 'agent'
$doctor = Join-Path $root 'scripts\doctor.ps1'

$report = '@microsoft/powerbi-report-authoring-cli'
$modeling = '@microsoft/powerbi-modeling-mcp'
$bridge = '@microsoft/powerbi-desktop-bridge-cli'

$saved = Save-Env @('PATH','HOME','USERPROFILE','COOP_DIR','COOP_AGENT_DIR','PI_CODING_AGENT_DIR','COOP_NO_ISOLATE',
           'COOP_SKIP_AZ','NO_COLOR','COOP_PIPX_BIN','COOP_PIPX_HOME','PIPX_HOME','COOP_RELEASE_MANIFEST')
$savedLocation = Get-Location
try {
  New-Item -ItemType Directory -Force -Path $bin, $cwd, $sandboxHome, (Join-Path $t 'coop\.coop'), $agent | Out-Null

  $manifest = Join-Path $t 'manifest.json'
  [System.IO.File]::WriteAllText($manifest, ('{"schema_version":1,"python_tools":{"coop-data-doc":"1.3.0"},' +
    '"npm_tools":{"' + $report + '":"0.4.0","' + $modeling + '":"1.0.0","' + $bridge + '":"1.0.0"}}'), $utf8)

  # Fake npm (cmd splits `--depth=0` at the `=`, so the package is %5 there):
  # `npm ls -g --depth=0 <pkg>` answers the fixture versions (the
  # modeling MCP and the bridge are off their pins); anything else prints nothing.
  Write-Shim -Dir $bin -Name 'npm' -Sh (@(
      'case "$*" in',
      ('  "ls -g --depth=0 ' + $report + '") echo "/g"; echo "+-- ' + $report + '@0.4.0" ;;'),
      ('  "ls -g --depth=0 ' + $modeling + '") echo "/g"; echo "+-- ' + $modeling + '@0.9.0" ;;'),
      ('  "ls -g --depth=0 ' + $bridge + '") echo "/g"; echo "+-- ' + $bridge + '@0.1.2" ;;'),
      'esac',
      'exit 0') -join "`n") -Cmd (@(
      ('if "%~5"=="' + $report + '" (echo C:\g& echo +-- ' + $report + '@0.4.0& exit /b 0)'),
      ('if "%~5"=="' + $modeling + '" (echo C:\g& echo +-- ' + $modeling + '@0.9.0& exit /b 0)'),
      ('if "%~5"=="' + $bridge + '" (echo C:\g& echo +-- ' + $bridge + '@0.1.2& exit /b 0)'),
      'exit /b 0') -join "`r`n")

  # Fake pipx: only coop-sql-review has a venv (0.15.2); everything else fails.
  Write-Shim -Dir $bin -Name 'pipx' -Sh (@(
      'case "$*" in',
      '  "runpip coop-sql-review show coop-sql-review") echo "Name: coop-sql-review"; echo "Version: 0.15.2"; exit 0 ;;',
      'esac',
      'exit 1') -join "`n") -Cmd (@(
      'if "%~1"=="runpip" if "%~2"=="coop-sql-review" if "%~3"=="show" (echo Name: coop-sql-review& echo Version: 0.15.2& exit /b 0)',
      'exit /b 1') -join "`r`n")
  $pipx = if ($isWindowsHost) { Join-Path $bin 'pipx.cmd' } else { Join-Path $bin 'pipx' }

  # Doctor refreshes the coop-agent checkout at most once a day; a fresh stamp
  # in the sandbox agent dir keeps this fixture offline.
  [System.IO.File]::WriteAllText((Join-Path $agent '.coop-fetch-stamp'), '')

  $env:PATH = "$bin$sep$($saved['PATH'])"
  $env:HOME = $sandboxHome
  $env:USERPROFILE = $sandboxHome
  $env:COOP_DIR = Join-Path $t 'coop'
  $env:COOP_AGENT_DIR = $agent
  $env:COOP_SKIP_AZ = '1'
  $env:NO_COLOR = '1'
  $env:COOP_PIPX_BIN = $pipx
  $env:COOP_RELEASE_MANIFEST = $manifest
  foreach ($n in @('PI_CODING_AGENT_DIR','COOP_NO_ISOLATE','PIPX_HOME','COOP_PIPX_HOME')) {
    Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue
  }
  Set-Location -LiteralPath $cwd

  $rows = Get-DoctorRows

  # 1. npm tools against their pins.
  $ok = @($rows | Where-Object { ([string]$_.name) -eq "$report 0.4.0 matches manifest (0.4.0)" })
  if ($ok.Count -ne 1 -or $ok[0].status -ne 'ok') {
    Ko 'doctor.ps1 must tick an npm tool at its pin' (Show-Rows $rows 'powerbi')
  } else { Ok 'doctor.ps1 ticks an npm tool at its pin' }
  $off = @($rows | Where-Object { ([string]$_.name) -eq "$modeling 0.9.0 differs from manifest (1.0.0)" })
  if ($off.Count -ne 1 -or $off[0].status -ne 'warn' -or -not ([string]$off[0].hint).StartsWith('coop update') -or -not ([string]$off[0].hint).Contains("npm install -g $modeling@1.0.0")) {
    Ko 'doctor.ps1 must warn on an npm tool off its pin with a coop update hint' (Show-Rows $rows 'powerbi')
  } else { Ok 'doctor.ps1 warns on an npm tool off its pin with a coop update hint' }
  $br = @($rows | Where-Object { ([string]$_.name) -eq "$bridge 0.1.2 differs from manifest (1.0.0)" })
  if ($isWindowsHost) {
    if ($br.Count -ne 1 -or $br[0].status -ne 'warn') {
      Ko 'doctor.ps1 must warn on the Desktop bridge left behind by an old updater' (Show-Rows $rows 'powerbi')
    } else { Ok 'doctor.ps1 warns on the Desktop bridge left behind by an old updater' }
  } else {
    if ($br.Count -ne 0) {
      Ko 'doctor.ps1 must not check the Desktop bridge pin off Windows' (Show-Rows $rows 'powerbi')
    } else { Ok 'doctor.ps1 skips the Desktop bridge pin off Windows' }
  }

  # 2. Retired reviewers.
  $sql = @($rows | Where-Object { ([string]$_.name) -eq 'coop-sql-review 0.15.2 is retired (coop no longer uses it)' })
  if ($sql.Count -ne 1 -or $sql[0].status -ne 'warn' -or ([string]$sql[0].hint) -ne 'pipx uninstall coop-sql-review') {
    Ko 'doctor.ps1 must name a retired reviewer left in pipx with its uninstall' (Show-Rows $rows 'review')
  } else { Ok 'doctor.ps1 names a retired reviewer left in pipx with its uninstall' }
  if (@(Find-Rows $rows 'coop-dax-review').Count -ne 0) {
    Ko 'doctor.ps1 must not mention a retired reviewer that is not installed' (Show-Rows $rows 'review')
  } else { Ok 'doctor.ps1 says nothing about a retired reviewer that is not installed' }
} catch {
  Ko "fixture error: $($_.Exception.Message)" ($_.ScriptStackTrace)
} finally {
  Set-Location -LiteralPath $savedLocation
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}

if ($fail -ne 0) { Write-Host "  $G_CROSS doctor.ps1 fleet-pin rows (PowerShell) tests FAILED"; exit 1 }
Write-Host '  doctor.ps1 fleet-pin rows (PowerShell) tests passed'
exit 0

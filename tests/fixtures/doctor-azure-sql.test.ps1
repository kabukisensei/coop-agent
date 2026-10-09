#!/usr/bin/env pwsh
# An Azure SQL-only client (client.platform azure_sql in ~/.coop/config, master
# plan section 8 item 7) passes scripts/doctor.ps1 without the Fabric CLI or the
# managed Fabric Python runtime: every row that is red only because Fabric is
# absent is informational there, and the same machine with platform fabric
# keeps those rows red. fab is hidden from PATH, a fake pipx answers nothing (no
# ms-fabric-cli metadata), COOP_FABRIC_PYTHON points nowhere (no runtime), and
# the sandbox agent dir's mcp-adapter.json has no fabric-sqlendpoint entry.
# Sandboxed HOME/COOP_DIR/agent dir, never ~/.coop; COOP_SKIP_AZ=1 keeps az out,
# and a fresh fetch stamp keeps doctor from fetching this checkout. No network.
# Assertions stay ASCII: Windows PowerShell 5.1 re-encodes child output.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-doctor-azsql-' + [guid]::NewGuid().ToString('N'))
$bin = Join-Path $t 'fakebin'
$cwd = Join-Path $t 'cwd'
$sandboxHome = Join-Path $t 'home'
$agent = Join-Path $t 'agent'
$doctor = Join-Path $root 'scripts\doctor.ps1'

$saved = Save-Env @('PATH','HOME','USERPROFILE','COOP_DIR','COOP_AGENT_DIR','PI_CODING_AGENT_DIR','COOP_NO_ISOLATE',
           'COOP_SKIP_AZ','NO_COLOR','COOP_PIPX_BIN','COOP_PIPX_HOME','PIPX_HOME','COOP_FABRIC_PYTHON','PSModuleAnalysisCachePath')
$savedLocation = Get-Location
try {
  New-Item -ItemType Directory -Force -Path $bin, $cwd, $sandboxHome, (Join-Path $t 'coop\.coop'), $agent | Out-Null
  # Fake pipx: no venv has any metadata, so ms-fabric-cli reads as not installed.
  Write-Shim -Dir $bin -Name 'pipx' -Sh 'exit 1' -Cmd 'exit /b 1'
  $pipx = if ($isWindowsHost) { Join-Path $bin 'pipx.cmd' } else { Join-Path $bin 'pipx' }
  [System.IO.File]::WriteAllText((Join-Path $agent '.coop-fetch-stamp'), '')
  [System.IO.File]::WriteAllText((Join-Path $agent 'mcp-adapter.json'),
    '{"mcpServers":{"microsoft-learn":{"url":"https://learn.microsoft.com/api/mcp"}}}', $utf8)
  $configFile = Join-Path $t 'coop\.coop\config'

  # fab off PATH, whether or not this machine has it: the Fabric CLI rows must
  # take their "missing" branches.
  $noFab = @($bin)
  foreach ($d in ($saved['PATH'] -split [System.IO.Path]::PathSeparator)) {
    if (-not $d) { continue }
    if ((Test-Path -LiteralPath (Join-Path $d 'fab')) -or (Test-Path -LiteralPath (Join-Path $d 'fab.exe')) -or (Test-Path -LiteralPath (Join-Path $d 'fab.cmd'))) { continue }
    $noFab += $d
  }
  $env:PATH = ($noFab -join [System.IO.Path]::PathSeparator)
  $env:HOME = $sandboxHome
  $env:USERPROFILE = $sandboxHome
  $env:COOP_DIR = Join-Path $t 'coop'
  $env:COOP_AGENT_DIR = $agent
  $env:COOP_SKIP_AZ = '1'
  $env:NO_COLOR = '1'
  $env:COOP_PIPX_BIN = $pipx
  $env:COOP_FABRIC_PYTHON = Join-Path $t 'nope\python'
  $env:PSModuleAnalysisCachePath = Join-Path $t 'ModuleAnalysisCache'
  foreach ($n in @('PI_CODING_AGENT_DIR','COOP_NO_ISOLATE','PIPX_HOME','COOP_PIPX_HOME')) {
    Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue
  }
  Set-Location -LiteralPath $cwd

  function Get-PlatformRows([string]$Platform) {
    [System.IO.File]::WriteAllText($configFile, ('{"schema_version":1,"client":{"platform":"' + $Platform + '"},"integrations":{}}'), $utf8)
    return (Get-DoctorRows)
  }
  function Get-FailRows($Rows) { @($Rows | Where-Object { [string]$_.status -eq 'fail' }) }
  function Test-FabricRow($Row) {
    $n = [string]$Row.name; $s = [string]$Row.section
    return ($s -eq 'Microsoft Fabric CLI' -or $s -eq 'Fabric / semantic-model tooling' -or $n -match '(?i)fabric|fab |fab$|powerbi|power bi|sqlendpoint|pyodbc')
  }

  # 1. The azure_sql machine: no Fabric row is red, each optional row says so.
  $az = Get-PlatformRows 'azure_sql'
  $azFabricFails = @(Get-FailRows $az | Where-Object { Test-FabricRow $_ })
  if ($azFabricFails.Count -ne 0) { Ko 'Azure SQL client: a Fabric-only row is still red' (Show-Rows $azFabricFails) }
  else { Ok 'Azure SQL client: no Fabric-only row is red' }

  $row = Find-Row $az 'fab not installed (Azure SQL client'
  if ($row -and [string]$row.status -eq 'ok') { Ok 'Azure SQL client: missing fab is informational' } else { Ko 'Azure SQL client: fab row' (Show-Rows $az 'fab') }
  $row = Find-Row $az 'ms-fabric-cli not installed (Azure SQL client'
  if ($row -and [string]$row.status -eq 'ok') { Ok 'Azure SQL client: the ms-fabric-cli manifest row is informational' } else { Ko 'Azure SQL client: ms-fabric-cli manifest row' (Show-Rows $az 'ms-fabric-cli') }
  $row = Find-Row $az 'fabric-cicd not installed (Azure SQL client'
  if ($row -and [string]$row.status -eq 'ok') { Ok 'Azure SQL client: fabric-cicd is informational' } else { Ko 'Azure SQL client: fabric-cicd row' (Show-Rows $az 'fabric-cicd') }
  $row = Find-Row $az 'SQL runtime: the managed Python with pyodbc is not installed (Azure SQL client'
  if ($row -and [string]$row.status -eq 'warn' -and ([string]$row.hint).StartsWith('coop install')) { Ok 'Azure SQL client: the missing SQL runtime is a warning that names sql_query' }
  else { Ko 'Azure SQL client: SQL runtime row' (Show-Rows $az 'runtime') }
  if (@(Find-Rows $az 'Fabric SQL fallback').Count -ne 0) { Ko 'Azure SQL client: the Fabric SQL fallback row must not appear without a runtime' (Show-Rows $az 'Fabric SQL') }
  else { Ok 'Azure SQL client: no Fabric SQL fallback row without a runtime' }
  $row = Find-Row $az 'fabric-sqlendpoint not configured (Azure SQL client'
  if ($row -and [string]$row.status -eq 'ok') { Ok 'Azure SQL client: an unregistered Warehouse MCP is informational' } else { Ko 'Azure SQL client: fabric-sqlendpoint row' (Show-Rows $az 'sqlendpoint') }
  $pbi = @(Find-Rows $az 'powerbi-report-author missing')
  if ($pbi.Count -eq 0) { Ok 'Azure SQL client: powerbi-report-author is installed here (its optional branch is covered when it is missing)' }
  elseif ([string]$pbi[0].status -eq 'warn' -and ([string]$pbi[0].hint).Contains('Azure SQL client')) { Ok 'Azure SQL client: a missing powerbi-report-author is a warning naming it optional' }
  else { Ko 'Azure SQL client: powerbi-report-author row' (Show-Rows $pbi) }

  # 2. Whatever is still red on the azure_sql machine is red for a non-Fabric
  #    reason: the same row is red with platform fabric too.
  $fab = Get-PlatformRows 'fabric'
  $fabFailNames = @(Get-FailRows $fab | ForEach-Object { [string]$_.name })
  $onlyAzFails = @(Get-FailRows $az | Where-Object { $fabFailNames -notcontains [string]$_.name })
  if ($onlyAzFails.Count -ne 0) { Ko 'Azure SQL client: a row is red there but not on a Fabric client' (Show-Rows $onlyAzFails) }
  else { Ok 'Azure SQL client: every remaining red row is red on a Fabric client too' }
  if ($script:LastDoctorRc -eq 0 -and (Get-FailRows $fab).Count -ne 0) { Ko 'doctor exit code does not follow its red rows' }

  # 3. The Fabric client keeps the rows red.
  $row = Find-Row $fab 'fab missing'
  if ($row -and [string]$row.status -eq 'fail') { Ok 'Fabric client: missing fab stays red' } else { Ko 'Fabric client: fab row' (Show-Rows $fab 'fab') }
  $row = Find-Row $fab 'Fabric SQL fallback: selected Fabric Python runtime is unavailable'
  if ($row -and [string]$row.status -eq 'fail') { Ok 'Fabric client: the missing runtime stays red' } else { Ko 'Fabric client: runtime row' (Show-Rows $fab 'runtime') }
  $row = Find-Row $fab 'ms-fabric-cli not installed (manifest'
  if ($row -and [string]$row.status -eq 'warn') { Ok 'Fabric client: the ms-fabric-cli manifest row stays a warning with its pipx hint' } else { Ko 'Fabric client: ms-fabric-cli manifest row' (Show-Rows $fab 'ms-fabric-cli') }
  $row = Find-Row $fab 'fabric-cicd: install the Microsoft Fabric CLI first'
  if ($row -and [string]$row.status -eq 'warn') { Ok 'Fabric client: fabric-cicd stays a warning' } else { Ko 'Fabric client: fabric-cicd row' (Show-Rows $fab 'fabric-cicd') }
  # Unregistered: 'unavailable', or 'target_invalid' when the nearest contract
  # names a Fabric endpoint the entry does not match; a warning either way.
  $row = Find-Row $fab 'fabric-sqlendpoint '
  if ($row -and [string]$row.status -eq 'warn' -and -not ([string]$row.name).Contains('Azure SQL client')) { Ok 'Fabric client: an unregistered Warehouse MCP stays a warning' } else { Ko 'Fabric client: fabric-sqlendpoint row' (Show-Rows $fab 'sqlendpoint') }
  if (@(Find-Rows $fab 'Azure SQL client').Count -ne 0) { Ko 'Fabric client: an Azure SQL row leaked' (Show-Rows $fab 'Azure SQL client') }
  else { Ok 'Fabric client: no Azure SQL wording' }
} catch {
  Ko "fixture error: $($_.Exception.Message)" ($_.ScriptStackTrace)
} finally {
  Set-Location -LiteralPath $savedLocation
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}

if ($fail -ne 0) { Write-Host "  $G_CROSS doctor.ps1 Azure SQL client (PowerShell) tests FAILED"; exit 1 }
Write-Host '  doctor.ps1 Azure SQL client (PowerShell) tests passed'
exit 0

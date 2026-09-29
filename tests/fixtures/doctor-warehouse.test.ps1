#!/usr/bin/env pwsh
# H2b: the PowerShell twin of the Warehouse and fabric rows in tests/doctor.test.sh.
# Runs scripts/doctor.ps1 --json from a folder whose .mcp.json has fabric and
# fabric-sqlendpoint, with a python3 stub whose warehouse_mcp.py doctor-json
# prints a fixed state and tenant. The Warehouse row names the tenant the probe
# minted for, the token_command_failed hint pins it with --tenant, a tenant that
# is not a GUID or domain name is dropped, and the fabric row says coop cannot
# pin the fabric MCP's tenant. Sandboxed HOME/COOP_DIR/agent dir, never ~/.coop;
# COOP_SKIP_AZ=1 keeps az out, and a fresh fetch stamp keeps doctor from
# fetching the coop-agent repo. No waits.
# Assertions stay ASCII: Windows PowerShell 5.1 re-encodes child output.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$psExe = try { (Get-Process -Id $PID).Path } catch { 'pwsh' }
$isWindowsHost = ($env:OS -eq 'Windows_NT')
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-doctor-wh-' + [guid]::NewGuid().ToString('N'))
$fail = 0
function Ok([string]$m) { Write-Host "  ok $m" }
function Ko([string]$m, [string]$out = '') { Write-Host "  x $m"; if ($out) { Write-Host $out }; $script:fail = 1 }

$Tenant = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd'
$TokenCommand = 'az account get-access-token --resource https://api.fabric.microsoft.com --output json'
$bin = Join-Path $t 'bin'
$cwd = Join-Path $t 'cwd'
$sandboxHome = Join-Path $t 'home'
$agent = Join-Path $t 'agent'
$doctor = Join-Path $root 'scripts\doctor.ps1'
$utf8 = New-Object System.Text.UTF8Encoding($false)

$saved = @{}
$names = @('PATH','HOME','USERPROFILE','COOP_DIR','COOP_AGENT_DIR','PI_CODING_AGENT_DIR','COOP_NO_ISOLATE',
           'COOP_SKIP_AZ','NO_COLOR','COOP_WAREHOUSE_TEST_STATE','COOP_WAREHOUSE_TEST_TENANT')
foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
$savedLocation = Get-Location
try {
  New-Item -ItemType Directory -Force -Path $bin, $cwd, $sandboxHome, (Join-Path $t 'coop\.coop'), $agent | Out-Null
  # python3 stub: answers the interpreter probe and warehouse_mcp.py; every other
  # Python call doctor makes fails quietly, which only affects unrelated rows.
  if ($isWindowsHost) {
    $py = Join-Path $bin 'python3.cmd'
    [System.IO.File]::WriteAllText($py, (@(
      '@echo off',
      'if "%~1"=="--version" (echo Python 3.12.0& exit /b 0)',
      'if /i "%~nx1"=="warehouse_mcp.py" goto warehouse',
      'exit /b 1',
      ':warehouse',
      'echo {"state":"%COOP_WAREHOUSE_TEST_STATE%","target":{"scope":"global"},"tenant":"%COOP_WAREHOUSE_TEST_TENANT%"}',
      'exit /b 0'
    ) -join "`r`n") + "`r`n", [System.Text.Encoding]::ASCII)
  } else {
    $py = Join-Path $bin 'python3'
    [System.IO.File]::WriteAllText($py, (@(
      '#!/bin/sh',
      'case "${1:-}" in',
      '  --version) echo "Python 3.12.0"; exit 0 ;;',
      '  *warehouse_mcp.py)',
      '    printf ''{"state":"%s","target":{"scope":"global"},"tenant":"%s"}\n'' "$COOP_WAREHOUSE_TEST_STATE" "${COOP_WAREHOUSE_TEST_TENANT:-}"',
      '    exit 0 ;;',
      'esac',
      'exit 1'
    ) -join "`n") + "`n", $utf8)
    & chmod +x $py
  }
  [System.IO.File]::WriteAllText((Join-Path $cwd '.mcp.json'),
    '{"mcpServers":{"fabric":{"command":"npx","args":["-y","@microsoft/fabric-mcp"]},"fabric-sqlendpoint":{"command":"npx","args":["-y","mcp-remote@0.1.38","https://api.fabric.microsoft.com/v1/mcp/dataPlane/sqlEndpoint","--transport","http-only","--silent"]}}}',
    $utf8)
  # Doctor refreshes the coop-agent checkout at most once a day; a fresh stamp
  # in the sandbox agent dir keeps this fixture offline.
  [System.IO.File]::WriteAllText((Join-Path $agent '.coop-fetch-stamp'), '')

  $env:PATH = "$bin$([System.IO.Path]::PathSeparator)$($env:PATH)"
  $env:HOME = $sandboxHome
  $env:USERPROFILE = $sandboxHome
  $env:COOP_DIR = Join-Path $t 'coop'
  $env:COOP_AGENT_DIR = $agent
  $env:COOP_SKIP_AZ = '1'
  $env:NO_COLOR = '1'
  # Remove-Item, not SetEnvironmentVariable($n, $null): PowerShell passes $null
  # to a .NET string parameter as '', which leaves an empty variable behind.
  foreach ($n in @('PI_CODING_AGENT_DIR','COOP_NO_ISOLATE')) {
    Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue
  }
  $resolvedPy = (Get-Command python3 -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  if ($resolvedPy -ne $py) { throw "fixture must resolve the python3 stub (got $resolvedPy)" }
  Set-Location -LiteralPath $cwd

  # doctor.ps1 --json rows (stdout, one document). Captured human output is
  # stderr, which Windows PowerShell 5.1 wraps at the console width.
  function Get-DoctorRows([string]$State, [string]$TenantValue) {
    $env:COOP_WAREHOUSE_TEST_STATE = $State
    $env:COOP_WAREHOUSE_TEST_TENANT = $TenantValue
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
  function Find-Row($Rows, [string]$Needle) {
    @($Rows | Where-Object { ([string]$_.name).Contains($Needle) }) | Select-Object -First 1
  }
  function Show-Rows($Rows) {
    (@($Rows | Where-Object { ([string]$_.name).Contains('fabric') } | ForEach-Object { "$($_.status) | $($_.name) | $($_.hint)" }) -join "`n")
  }

  # Two doctor runs keep this fixture cheap; the fabric row does not depend on
  # the Warehouse state.
  # 1. token_command_failed with a tenant: the Warehouse row names the tenant the
  #    probe minted for, the hint pins it with --tenant, and the fabric row says
  #    coop cannot pin the fabric MCP's tenant.
  $rows = Get-DoctorRows 'token_command_failed' $Tenant
  $wh = Find-Row $rows 'fabric-sqlendpoint token_command_failed'
  if ($null -eq $wh -or $wh.status -ne 'warn' -or -not ([string]$wh.name).Contains("token_command_failed (global target, tenant $Tenant)")) {
    Ko 'doctor.ps1 must name the tenant the Warehouse probe minted for' (Show-Rows $rows)
  } else { Ok 'doctor.ps1 names the tenant the Warehouse probe minted for' }
  if ($null -eq $wh -or -not ([string]$wh.hint).EndsWith("run: $TokenCommand --tenant $Tenant")) {
    Ko "doctor.ps1's Warehouse token hint must name the client tenant" (Show-Rows $rows)
  } else { Ok "doctor.ps1's Warehouse token hint names the client tenant" }
  $fab = Find-Row $rows 'fabric server configured'
  if ($null -eq $fab -or $fab.status -ne 'ok' -or -not ([string]$fab.name).Contains("fabric server configured (uses az's default account; coop cannot pin its tenant)")) {
    Ko 'doctor.ps1 must state that the fabric MCP tenant cannot be pinned' (Show-Rows $rows)
  } else { Ok 'doctor.ps1 states that the fabric MCP tenant cannot be pinned' }

  # 2. A tenant that is not a GUID or domain name is dropped: the row and hint
  #    stay unpinned, as with no tenant (az's default account).
  $rows = Get-DoctorRows 'token_command_failed' 'contoso.com/x'
  $wh = Find-Row $rows 'fabric-sqlendpoint token_command_failed'
  if ($null -eq $wh -or -not ([string]$wh.name).Contains('token_command_failed (global target)') -or -not ([string]$wh.hint).EndsWith("run: $TokenCommand") -or ([string]$wh.hint).Contains('--tenant')) {
    Ko 'doctor.ps1 must drop an invalid tenant from the Warehouse row and hint' (Show-Rows $rows)
  } else { Ok 'doctor.ps1 drops an invalid tenant from the Warehouse row and hint' }
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

if ($fail -ne 0) { Write-Host '  x doctor.ps1 Warehouse and fabric rows (PowerShell) tests FAILED'; exit 1 }
Write-Host '  doctor.ps1 Warehouse and fabric rows (PowerShell) tests passed'
exit 0

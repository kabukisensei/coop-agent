#!/usr/bin/env pwsh
# The managed Warehouse MCP entry follows the folder coop starts in (2026-10-05:
# `coop update` run from the home folder wrote the global endpoint into the shared
# mcp-adapter.json, and the project folder then reported target_mismatch and no
# execute_query tool).
#   A. Update-CoopManagedMcpConfig (lib/common.ps1): from a folder with no contract
#      the entry is the global endpoint; from a project with an item target it is
#      that item (url, _coop_target, item_name); back in the plain folder it is
#      global again. A user-added server survives every rewrite.
#   B. End-to-end `coop` (stub pi) from the project folder after a home-folder
#      sync: the stub reads the config while it runs and sees the item target.
# Sandboxed HOME/USERPROFILE/agent dir, never ~/.coop; COOP_SKIP_AZ=1, offline.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-mcp-retarget-' + [guid]::NewGuid().ToString('N'))

$sandboxHome = Join-Path $t 'home'
$agent = Join-Path $t 'agent'
$marker = Join-Path $t 'marker'
$bin = Join-Path $t 'bin'
$project = Join-Path $t 'work\client-repo'
$workspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$item = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
$itemUrl = "https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/$workspace/items/$item/sqlEndpoint"
$globalUrl = 'https://api.fabric.microsoft.com/v1/mcp/dataPlane/sqlEndpoint'

$saved = Save-Env @('PATH','HOME','USERPROFILE','COOP_DIR','COOP_AGENT_DIR','PI_CODING_AGENT_DIR','COOP_NO_ISOLATE','COOP_SKIP_AZ','COOP_AZ_BIN',
           'COOP_SKIP_EXT_CHECK','COOP_NO_ONBOARD','COOP_NO_MODEL_LOGIN','COOP_PRIME_MODEL_LOGIN','COOP_FIRST_RUN','NO_COLOR',
           'COOP_STANDARDS_ROOT','COOP_STANDARDS_STATE','COOP_STANDARDS_SNAPSHOT_ROOT')
try {
  New-Item -ItemType Directory -Force -Path $sandboxHome, $agent, $marker, $bin, (Join-Path $project '.coop'), (Join-Path $sandboxHome '.coop') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $agent '.coop-fetch-stamp'), '')
  [System.IO.File]::WriteAllText((Join-Path $sandboxHome '.coop\user.json'), '{"name":"Tester","communication_style":"balanced"}' + "`n", $utf8)
  [System.IO.File]::WriteAllText((Join-Path $sandboxHome '.coop\config'), '{"schema_version":1,"integrations":{}}' + "`n", $utf8)
  [System.IO.File]::WriteAllText((Join-Path $project '.coop\project.yml'), (@(
    'fabric:',
    "  default_workspace_id: `"$workspace`"",
    '  default_sql_endpoint:',
    '    item_type: "Warehouse"',
    '    item_name: "CustomerWarehouse"',
    "    item_id: `"$item`"") -join "`n") + "`n", $utf8)

  $env:HOME = $sandboxHome
  $env:USERPROFILE = $sandboxHome
  $env:COOP_AGENT_DIR = $agent
  $env:COOP_SKIP_AZ = '1'
  $env:COOP_AZ_BIN = Join-Path $t 'nonexistent-az'
  $env:COOP_SKIP_EXT_CHECK = '1'
  $env:COOP_NO_MODEL_LOGIN = '1'
  $env:NO_COLOR = '1'
  foreach ($n in @('COOP_DIR','PI_CODING_AGENT_DIR','COOP_NO_ISOLATE','COOP_NO_ONBOARD','COOP_PRIME_MODEL_LOGIN',
                   'COOP_FIRST_RUN','COOP_STANDARDS_ROOT','COOP_STANDARDS_STATE','COOP_STANDARDS_SNAPSHOT_ROOT')) {
    Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue
  }

  $realPy = Get-FixturePython
  if (-not $realPy) { throw 'python3 is required (the generator and the stub pi)' }
  $configPath = Join-Path $agent 'mcp-adapter.json'
  # Stub pi: copies the config it would load, as it is while pi runs.
  $null = New-PyStub $bin 'pi' @"
import os, shutil, sys
shutil.copyfile(r'''$configPath''', os.path.join(r'''$marker''', 'config-at-launch.json'))
open(os.path.join(r'''$marker''', 'pi-ran'), 'w').close()
sys.exit(0)
"@
  $null = New-PyStub $bin 'npm' "import sys`nif sys.argv[1:2] == ['--version']:`n    print('10.0.0')`nsys.exit(0)`n"
  $env:PATH = "$bin$sep$($saved['PATH'])"

  function Read-Entry([string]$Path) {
    $doc = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    return $doc.mcpServers.'fabric-sqlendpoint'
  }
  function Invoke-Redirected([string]$Script, [string]$WorkDir) {
    $in = Join-Path $t 'child.in'; $so = Join-Path $t 'child.out'; $se = Join-Path $t 'child.err'
    [System.IO.File]::WriteAllText($in, '')
    $p = Start-Process -FilePath $psExe -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $Script + '"')) -WorkingDirectory $WorkDir `
      -PassThru -NoNewWindow -RedirectStandardInput $in -RedirectStandardOutput $so -RedirectStandardError $se
    $null = $p.Handle
    $p.WaitForExit()
    return [pscustomobject]@{ Rc = $p.ExitCode; Out = [System.IO.File]::ReadAllText($so); Err = [System.IO.File]::ReadAllText($se) }
  }

  # --- A. the helper, in-process -----------------------------------------------------
  . (Join-Path $root 'lib\common.ps1')
  $env:PI_CODING_AGENT_DIR = $agent
  # A user-added server must survive every rewrite (the generator is ownership-aware).
  [System.IO.File]::WriteAllText($configPath, '{"mcpServers":{"my-own":{"command":"node","args":["x.js"]}}}' + "`n", $utf8)

  Push-Location -LiteralPath $sandboxHome
  $state = Update-CoopManagedMcpConfig -Quiet
  Pop-Location
  $entry = Read-Entry $configPath
  if ($state -eq 'ok' -and $entry -and $entry.url -eq $globalUrl -and $entry._coop_target.scope -eq 'global') { Ok 'home folder (no contract): the managed entry is the global endpoint' }
  else { Ko "home folder: state=$state url=$($entry.url) scope=$($entry._coop_target.scope)" }

  Push-Location -LiteralPath $project
  $state = Update-CoopManagedMcpConfig -Quiet
  Pop-Location
  $entry = Read-Entry $configPath
  if ($state -eq 'ok' -and $entry -and $entry.url -eq $itemUrl -and $entry._coop_target.scope -eq 'item' -and $entry._coop_target.item_name -eq 'CustomerWarehouse') { Ok 'project folder: the managed entry is the contract''s item target' }
  else { Ko "project folder: state=$state url=$($entry.url) scope=$($entry._coop_target.scope) item_name=$($entry._coop_target.item_name)" }
  if ($entry.requestHeadersCommand.args[1] -eq $itemUrl) { Ok 'the request-headers helper is handed the item url' } else { Ko "helper url: $($entry.requestHeadersCommand.args[1])" }

  Push-Location -LiteralPath $sandboxHome
  $state = Update-CoopManagedMcpConfig -Quiet
  Pop-Location
  $entry = Read-Entry $configPath
  if ($state -eq 'ok' -and $entry.url -eq $globalUrl) { Ok 'back in the home folder: global again (the last launch wins)' } else { Ko "home folder again: state=$state url=$($entry.url)" }
  $doc = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  if ($doc.mcpServers.'my-own' -and $doc.mcpServers.'my-own'.args[0] -eq 'x.js') { Ok 'a user-added server survives the rewrites' } else { Ko 'the user-added server was dropped' }
  Remove-Item -LiteralPath Env:PI_CODING_AGENT_DIR -ErrorAction SilentlyContinue

  # --- B. end-to-end: `coop` from the project folder after a home-folder sync ------
  # The config now carries the global target (the home-folder run above).
  $r = Invoke-Redirected (Join-Path $root 'bin\coop.ps1') $project
  $all = $r.Out + $r.Err
  $seen = Join-Path $marker 'config-at-launch.json'
  if ((Test-Path -LiteralPath (Join-Path $marker 'pi-ran')) -and $r.Rc -eq 0) { Ok 'launch from the project folder: pi ran, rc 0' } else { Ko "launch: pi-ran=$(Test-Path -LiteralPath (Join-Path $marker 'pi-ran')) rc=$($r.Rc)" $all }
  if (Test-Path -LiteralPath $seen) {
    $entry = Read-Entry $seen
    if ($entry -and $entry.url -eq $itemUrl -and $entry._coop_target.item_name -eq 'CustomerWarehouse') { Ok 'the launch re-targeted the managed entry to the project before pi started' }
    else { Ko "config pi saw: url=$($entry.url) item_name=$($entry._coop_target.item_name)" $all }
  } else { Ko 'stub pi recorded no config' $all }
  if (-not $all.Contains('could not refresh the MCP config')) { Ok 'no refresh warning on a healthy launch' } else { Ko 'the launch warned about the MCP config' $all }
} catch {
  Ko "fixture error: $($_.Exception.Message)" ($_.ScriptStackTrace)
} finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}

if ($fail -ne 0) { Write-Host "  $G_CROSS MCP re-target (PowerShell) tests FAILED"; exit 1 }
Write-Host '  MCP re-target (PowerShell) tests passed'
exit 0

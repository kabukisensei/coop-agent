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
#   D. Opened from the folder above the client repository (2026-10-07: a teammate
#      launched from the user folder holding <user>\fabric; the managed entry was
#      the global endpoint with blank targets and the guardrails refused a dev
#      write): `coop sync` and a launch from that folder use the repository's
#      project file. With two repositories that each have one, nothing is
#      guessed: the entry stays global (no_project_file) and the launch warns.
#   E. The remembered project file (one per Windows user, Aaron 2026-10-08): the
#      first launch that finds one records it in <profile>\home-project.json; later
#      launches from any folder without one above use it, so several repositories
#      no longer need a guess; `coop project home [<folder>]` shows or sets it.
#   F. A shortcut launch (COOP_SHORTCUT) from the user folder opens the remembered
#      project file's repository, so Pi lists that folder's saved sessions.
#   C. Several coops at once (2026-10-06): each launch also writes its folder's
#      own copy (<agent dir>\mcp\<key>.json) and hands Pi that path
#      (--mcp-config, COOP_MCP_CONFIG); a later launch from another folder
#      retargets the shared file but never the first launch's copy.
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
args = sys.argv[1:]
given = args[args.index('--mcp-config') + 1] if '--mcp-config' in args else ''
with open(os.path.join(r'''$marker''', 'mcp-config-arg.txt'), 'a') as f:
    f.write(given + '|' + os.environ.get('COOP_MCP_CONFIG', '') + '\n')
open(os.path.join(r'''$marker''', 'pi-ran'), 'w').close()
with open(os.path.join(r'''$marker''', 'pi-cwd.txt'), 'w') as f:
    f.write(os.getcwd())
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

  # --- C. this launch's own copy, untouched by a later launch elsewhere -----------
  $env:PI_CODING_AGENT_DIR = $agent
  $projectCopy = Get-CoopFolderMcpConfigPath -ProjectCwd $project
  $homeCopy = Get-CoopFolderMcpConfigPath -ProjectCwd $sandboxHome
  Remove-Item -LiteralPath Env:PI_CODING_AGENT_DIR -ErrorAction SilentlyContinue
  $argLines = @(Get-Content -LiteralPath (Join-Path $marker 'mcp-config-arg.txt'))
  if ($argLines.Count -ge 1 -and $argLines[-1] -eq "$projectCopy|$projectCopy") { Ok 'pi got --mcp-config and COOP_MCP_CONFIG naming the project folder''s own copy' }
  else { Ko "pi's --mcp-config|COOP_MCP_CONFIG: $($argLines -join ' / ') (expected $projectCopy)" }
  if ($projectCopy -ne $homeCopy -and (Split-Path -Leaf $projectCopy) -match '^[0-9a-f]{12}\.json$' -and (Split-Path -Leaf (Split-Path -Parent $projectCopy)) -eq 'mcp') { Ok 'each folder has its own copy under <agent dir>\mcp' } else { Ko "copies: $projectCopy / $homeCopy" }
  $entry = if (Test-Path -LiteralPath $projectCopy) { Read-Entry $projectCopy } else { $null }
  if ($entry -and $entry.url -eq $itemUrl) { Ok 'the project folder''s copy carries the item target' } else { Ko "project copy url: $($entry.url)" }
  $doc = Get-Content -LiteralPath $projectCopy -Raw | ConvertFrom-Json
  if ($doc.mcpServers.'my-own') { Ok 'the copy keeps the user-added server from the shared file' } else { Ko 'the copy dropped the user-added server' }
  # A second coop from the home folder: the shared file goes global, the project's copy stays.
  # (The project launch above remembered its file for every launch; forget it so
  # the home folder has no project file, as on a fresh profile.)
  $homeRecord = Join-Path $sandboxHome '.coop\home-project.json'
  if ((Test-Path -LiteralPath $homeRecord) -and ((Get-Content -LiteralPath $homeRecord -Raw | ConvertFrom-Json).project_file -eq [System.IO.Path]::GetFullPath((Join-Path $project '.coop\project.yml')))) { Ok 'the first launch that found a project file remembered it (home-project.json)' }
  else { Ko "home-project.json after the project launch: $(if (Test-Path -LiteralPath $homeRecord) { Get-Content -LiteralPath $homeRecord -Raw } else { 'missing' })" }
  Remove-Item -LiteralPath $homeRecord -Force -ErrorAction SilentlyContinue
  $r = Invoke-Redirected (Join-Path $root 'bin\coop.ps1') $sandboxHome
  $all = $r.Out + $r.Err
  if ($r.Rc -eq 0 -and (Read-Entry $configPath).url -eq $globalUrl) { Ok 'a launch from the home folder retargets the shared file' } else { Ko "home launch: rc=$($r.Rc) shared url=$((Read-Entry $configPath).url)" $all }
  if ((Read-Entry $projectCopy).url -eq $itemUrl) { Ok 'the project launch''s own copy still names the item (the running coop is not retargeted)' } else { Ko "project copy after the home launch: $((Read-Entry $projectCopy).url)" }
  if ((Test-Path -LiteralPath $homeCopy) -and (Read-Entry $homeCopy).url -eq $globalUrl) { Ok 'the home launch got its own copy' } else { Ko 'no home copy' $all }

  # --- D. opened from the folder above the client repository ----------------------
  $userDir = Join-Path $t 'users\josh'
  $clientRepo = Join-Path $userDir 'fabric'
  New-Item -ItemType Directory -Force -Path (Join-Path $clientRepo '.git'), (Join-Path $clientRepo '.coop') | Out-Null
  Copy-Item -LiteralPath (Join-Path $project '.coop\project.yml') -Destination (Join-Path $clientRepo '.coop\project.yml')
  $env:PI_CODING_AGENT_DIR = $agent
  Push-Location -LiteralPath $userDir
  $state = Update-CoopManagedMcpConfig -Quiet
  Pop-Location
  Remove-Item -LiteralPath Env:PI_CODING_AGENT_DIR -ErrorAction SilentlyContinue
  $entry = Read-Entry $configPath
  if ($state -eq 'ok' -and $entry.url -eq $itemUrl -and $entry._coop_target.scope -eq 'item' -and $entry._coop_target.workspace_id -eq $workspace -and $entry._coop_target.item_id -eq $item) { Ok 'sync from the folder above the client repository: the entry is that repository''s item target' }
  else { Ko "folder above the repository: state=$state url=$($entry.url) scope=$($entry._coop_target.scope) workspace=$($entry._coop_target.workspace_id)" }
  Remove-Item -LiteralPath (Join-Path $marker 'config-at-launch.json') -Force -ErrorAction SilentlyContinue
  $r = Invoke-Redirected (Join-Path $root 'bin\coop.ps1') $userDir
  $all = $r.Out + $r.Err
  $seen = Join-Path $marker 'config-at-launch.json'
  $entry = if (Test-Path -LiteralPath $seen) { Read-Entry $seen } else { $null }
  $env:PI_CODING_AGENT_DIR = $agent
  $userCopy = Get-CoopFolderMcpConfigPath -ProjectCwd $userDir
  Remove-Item -LiteralPath Env:PI_CODING_AGENT_DIR -ErrorAction SilentlyContinue
  $copyEntry = if (Test-Path -LiteralPath $userCopy) { Read-Entry $userCopy } else { $null }
  if ($r.Rc -eq 0 -and $entry -and $entry.url -eq $itemUrl -and $entry._coop_target.item_name -eq 'CustomerWarehouse' -and $copyEntry -and $copyEntry.url -eq $itemUrl) { Ok 'launch from the folder above the client repository: Pi sees the item target, in the shared file and the folder''s own copy' }
  else { Ko "launch from the user folder: rc=$($r.Rc) shared=$($entry.url) copy=$($copyEntry.url)" $all }
  # Remembered: a launch from a folder with no project file anywhere near it uses it.
  $elsewhere = Join-Path $t 'elsewhere'
  New-Item -ItemType Directory -Force -Path $elsewhere | Out-Null
  $r = Invoke-Redirected (Join-Path $root 'bin\coop.ps1') $elsewhere
  $all = $r.Out + $r.Err
  $entry = Read-Entry $configPath
  if ($r.Rc -eq 0 -and $entry.url -eq $itemUrl -and $all -match 'remembered by coop') { Ok 'a launch from an unrelated folder uses the remembered project file' }
  else { Ko "unrelated folder: rc=$($r.Rc) url=$($entry.url)" $all }
  # A second client repository with its own project file: the remembered one decides.
  $otherRepo = Join-Path $userDir 'reports'
  New-Item -ItemType Directory -Force -Path (Join-Path $otherRepo '.git'), (Join-Path $otherRepo '.coop') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $otherRepo '.coop\project.yml'), "profile:`n  client: `"Other`"`n", $utf8)
  $r = Invoke-Redirected (Join-Path $root 'bin\coop.ps1') $userDir
  $all = $r.Out + $r.Err
  $entry = Read-Entry $configPath
  if ($r.Rc -eq 0 -and $entry.url -eq $itemUrl -and -not ($all -match 'several repositories')) { Ok 'two repositories with project files: the remembered one is used, no guess and no warning' }
  else { Ko "two repositories, remembered: rc=$($r.Rc) url=$($entry.url)" $all }
  # A repository opened directly keeps its own file (and the record is unchanged).
  $r = Invoke-Redirected (Join-Path $root 'bin\coop.ps1') $otherRepo
  $entry = Read-Entry $configPath
  if ($r.Rc -eq 0 -and $entry.url -eq $globalUrl -and $entry._coop_target.reason -eq 'missing_unambiguous_project_ids' -and (Get-Content -LiteralPath $homeRecord -Raw) -match 'fabric') { Ok 'a repository with its own project file uses its own; the remembered file stays' }
  else { Ko "own repository: rc=$($r.Rc) url=$($entry.url) reason=$($entry._coop_target.reason)" ($r.Out + $r.Err) }
  # Nothing remembered (a fresh profile): which one is meant is unknown.
  Remove-Item -LiteralPath $homeRecord -Force
  $r = Invoke-Redirected (Join-Path $root 'bin\coop.ps1') $userDir
  $all = $r.Out + $r.Err
  $entry = Read-Entry $configPath
  if ($r.Rc -eq 0 -and $entry.url -eq $globalUrl -and $entry._coop_target.workspace_id -eq '' -and $entry._coop_target.reason -eq 'no_project_file') { Ok 'two repositories with project files: nothing is guessed, the target stays blank (no_project_file)' }
  else { Ko "two repositories: rc=$($r.Rc) url=$($entry.url) reason=$($entry._coop_target.reason)" $all }
  if ($all -match 'several repositories inside it have one \(fabric, reports\)' -and $all -match 'writes are refused') { Ok 'the launch says which repositories hold one and to open coop in the one meant' }
  else { Ko 'no several-project-files warning' $all }
  if (-not (Test-Path -LiteralPath $homeRecord)) { Ok 'with several and nothing remembered, nothing is recorded either' } else { Ko "recorded a guess: $(Get-Content -LiteralPath $homeRecord -Raw)" }
  # `coop project home <folder>` sets it; `coop project home` shows it.
  $homeScript = Join-Path $t 'project-home.ps1'
  [System.IO.File]::WriteAllText($homeScript, "& '$((Join-Path $root 'bin\coop.ps1'))' project home '$clientRepo'`nexit `$LASTEXITCODE`n", $utf8)
  $r = Invoke-Redirected $homeScript $userDir
  if ($r.Rc -eq 0 -and (Test-Path -LiteralPath $homeRecord) -and (Get-Content -LiteralPath $homeRecord -Raw) -match 'fabric') { Ok 'coop project home <folder> records that folder''s project file' }
  else { Ko "coop project home: rc=$($r.Rc)" ($r.Out + $r.Err) }
  [System.IO.File]::WriteAllText($homeScript, "& '$((Join-Path $root 'bin\coop.ps1'))' project home '$elsewhere'`nexit `$LASTEXITCODE`n", $utf8)
  $r = Invoke-Redirected $homeScript $userDir
  if ($r.Rc -ne 0 -and ($r.Out + $r.Err) -match 'no client project file' -and (Get-Content -LiteralPath $homeRecord -Raw) -match 'fabric') { Ok 'coop project home on a folder without one refuses and keeps the record' }
  else { Ko "coop project home elsewhere: rc=$($r.Rc)" ($r.Out + $r.Err) }
  $r = Invoke-Redirected (Join-Path $root 'bin\coop.ps1') $userDir
  if ((Read-Entry $configPath).url -eq $itemUrl) { Ok 'after coop project home, the user folder launch uses it' } else { Ko 'not used after coop project home' ($r.Out + $r.Err) }
  # F. A shortcut launch (COOP_SHORTCUT, set by bin\coop-desktop.ps1) starts in the
  # user folder; it opens the remembered file's repository there, so Pi lists that
  # folder's saved sessions (2026-10-08: the window showed the user folder's old ones).
  $piCwd = Join-Path $marker 'pi-cwd.txt'
  $env:COOP_SHORTCUT = '1'
  try { $r = Invoke-Redirected (Join-Path $root 'bin\coop.ps1') $sandboxHome } finally { Remove-Item Env:COOP_SHORTCUT -ErrorAction SilentlyContinue }
  $seenCwd = if (Test-Path -LiteralPath $piCwd) { (Get-Content -LiteralPath $piCwd -Raw).Trim() } else { '' }
  if ($r.Rc -eq 0 -and $seenCwd -and ([System.IO.Path]::GetFullPath($seenCwd) -eq [System.IO.Path]::GetFullPath($clientRepo))) { Ok 'a shortcut launch from the user folder opens the remembered project''s repository' }
  else { Ko "shortcut launch: rc=$($r.Rc) pi cwd=$seenCwd" ($r.Out + $r.Err) }
  $r = Invoke-Redirected (Join-Path $root 'bin\coop.ps1') $sandboxHome
  $seenCwd = if (Test-Path -LiteralPath $piCwd) { (Get-Content -LiteralPath $piCwd -Raw).Trim() } else { '' }
  if ($r.Rc -eq 0 -and $seenCwd -and ([System.IO.Path]::GetFullPath($seenCwd) -eq [System.IO.Path]::GetFullPath($sandboxHome))) { Ok 'coop typed in the user folder stays there' }
  else { Ko "typed launch in the user folder: rc=$($r.Rc) pi cwd=$seenCwd" ($r.Out + $r.Err) }
  $env:COOP_SHORTCUT = '1'
  try { $r = Invoke-Redirected (Join-Path $root 'bin\coop.ps1') $elsewhere } finally { Remove-Item Env:COOP_SHORTCUT -ErrorAction SilentlyContinue }
  $seenCwd = if (Test-Path -LiteralPath $piCwd) { (Get-Content -LiteralPath $piCwd -Raw).Trim() } else { '' }
  if ($r.Rc -eq 0 -and $seenCwd -and ([System.IO.Path]::GetFullPath($seenCwd) -eq [System.IO.Path]::GetFullPath($elsewhere))) { Ok 'a shortcut launch from another folder stays in that folder' }
  else { Ko "shortcut launch elsewhere: rc=$($r.Rc) pi cwd=$seenCwd" ($r.Out + $r.Err) }
  # The remembered file is gone and nothing else is found: blank target, a clear warning.
  Remove-Item -LiteralPath (Join-Path $clientRepo '.coop\project.yml') -Force
  Remove-Item -LiteralPath (Join-Path $otherRepo '.coop\project.yml') -Force
  $r = Invoke-Redirected (Join-Path $root 'bin\coop.ps1') $userDir
  $all = $r.Out + $r.Err
  $entry = Read-Entry $configPath
  if ($r.Rc -eq 0 -and $entry.url -eq $globalUrl -and $all -match 'the remembered project file is gone') { Ok 'a remembered file that is gone: blank target and a warning saying what to do' }
  else { Ko "gone: rc=$($r.Rc) url=$($entry.url)" $all }
} catch {
  Ko "fixture error: $($_.Exception.Message)" ($_.ScriptStackTrace)
} finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}

if ($fail -ne 0) { Write-Host "  $G_CROSS MCP re-target (PowerShell) tests FAILED"; exit 1 }
Write-Host '  MCP re-target (PowerShell) tests passed'
exit 0

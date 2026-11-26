#!/usr/bin/env pwsh
#
# tests/fixtures/_docs-refresh.ps1 - the sandbox the Daily lineage refresh (CW6)
# fixtures share: docs-refresh.test.ps1 (gate) and docs-refresh-process.test.ps1
# (extended). Dot-source it after _common.ps1; it sets the environment (call
# Restore-Env $drSaved in the fixture's finally) and defines:
#
#   $drScript, $signIn, $coop       the real scripts under test
#   $drProfile, $drState, $drDir    ~/.coop, its docs-refresh folder and state.json
#   Set-DrClock <seconds>           the waiter's clock: 09:00 today + seconds
#   Get-DrNow                       that clock now
#   Get-DrCalls / Get-DrWaiterCalls every start of the built-in powershell.exe /
#                                   only the waiter starts (argv arrays)
#   Get-DrHelperCalls               every lib\live_docs.py request the run made
#   Invoke-DrSignIn / Invoke-DrCoop the real sign-in.ps1 / `coop -p hi` (fake Pi)
#   Invoke-DrWaiter <argv>          the waiter, run to its end in this process' child
#   Set-DrFeature on|off            through the one writer (coop settings)
#
# Fakes: the built-in powershell.exe is a recorder (COOP_BUILTIN_POWERSHELL);
# with -Forward (the process fixture) it runs the waiter for real. Python is the
# real one with a sitecustomize.py on PYTHONPATH that answers only
# warehouse_mcp.py launch-token (the tenant-pinned token) and lib\live_docs.py
# (the refresh and build), as tests/fixtures/fabric-mcp-launch.test.ps1 fakes the
# token helper; every other Python call runs as it is. The clock is
# COOP_DOCS_REFRESH_CLOCK. Offline, sandbox home only.
param([switch]$Forward)

$drRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$drScript = Join-Path $drRoot 'scripts\docs-refresh.ps1'
$signIn = Join-Path $drRoot 'scripts\sign-in.ps1'
$coop = Join-Path $drRoot 'bin\coop.ps1'
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-cw6-' + [guid]::NewGuid().ToString('N'))
$drSaved = Save-Env @('PATH', 'HOME', 'USERPROFILE', 'COOP_DIR', 'COOP_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'COOP_NO_ISOLATE', 'COOP_MACHINE_DIR',
  'COOP_SKIP_AZ', 'COOP_AZ_BIN', 'COOP_SKIP_EXT_CHECK', 'COOP_NO_MODEL_LOGIN', 'NO_COLOR', 'PYTHONPATH', 'TEMP', 'TMP', 'TMPDIR',
  'COOP_BUILTIN_POWERSHELL', 'COOP_DOCS_REFRESH_CLOCK', 'COOP_DOCS_REFRESH_POLL_MS', 'COOP_DOCS_REFRESH_LIMIT_SECONDS', 'COOP_SIGNIN_NO_PAUSE',
  'COOP_TEST_DR_CALLS', 'COOP_TEST_DR_LOG', 'COOP_TEST_DR_TOKEN', 'COOP_TEST_DR_REFRESH', 'COOP_TEST_DR_BUILD', 'COOP_TEST_DR_SLEEP', 'COOP_PROJECT_YML', 'COOP_FABRIC_MCP_TOKEN')

New-Item -ItemType Directory -Force -Path (Join-Path $t 'temp') | Out-Null
$env:TEMP = Join-Path $t 'temp'; $env:TMP = $env:TEMP; $env:TMPDIR = $env:TEMP
$drHome = New-SandboxHome (Join-Path $t 'home')
$env:HOME = $drHome
$env:USERPROFILE = $drHome
$env:COOP_DIR = $drHome
$drAgent = Join-Path $t 'agent'
New-Item -ItemType Directory -Force -Path $drAgent | Out-Null
# A fresh fetch stamp keeps the launch's once-a-day refresh (and doctor's) offline.
[System.IO.File]::WriteAllText((Join-Path $drAgent '.coop-fetch-stamp'), '')
$env:COOP_AGENT_DIR = $drAgent
$env:COOP_MACHINE_DIR = Join-Path $t 'machine'
$env:COOP_SKIP_AZ = '1'
$env:COOP_AZ_BIN = Join-Path $t 'nonexistent-az'
$env:COOP_SKIP_EXT_CHECK = '1'
$env:COOP_NO_MODEL_LOGIN = '1'
$env:NO_COLOR = '1'
$env:COOP_SIGNIN_NO_PAUSE = '1'
foreach ($n in @('PI_CODING_AGENT_DIR', 'COOP_NO_ISOLATE', 'COOP_DOCS_REFRESH_LIMIT_SECONDS', 'COOP_TEST_DR_TOKEN', 'COOP_TEST_DR_REFRESH', 'COOP_TEST_DR_BUILD', 'COOP_TEST_DR_SLEEP', 'COOP_PROJECT_YML', 'COOP_FABRIC_MCP_TOKEN')) { Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue }
$drProfile = Join-Path $drHome '.coop'
$drDir = Join-Path $drProfile 'docs-refresh'
$drState = Join-Path $drDir 'state.json'
New-Item -ItemType Directory -Force -Path $drProfile | Out-Null

$realPy = Get-FixturePython
if (-not $realPy) { throw 'python3 is required for the docs-refresh fixtures' }

# --- the client folder: a repository with a project file and live-sourced docs ---------
$drClient = Join-Path $t 'client\sql'
New-Item -ItemType Directory -Force -Path (Join-Path $drClient '.coop') | Out-Null
$drProject = Join-Path $drClient '.coop\project.yml'
[System.IO.File]::WriteAllText($drProject, "schema_version: 1`nprofile:`n  client: Contoso`n", $utf8)
$drConfig = Join-Path $drClient 'coop-data-doc.yml'
[System.IO.File]::WriteAllText($drConfig, "project_name: contoso`nrepos:`n  sql:`n    path: ./live/dev`nlive_sources:`n  dev:`n    repo: sql`n", $utf8)
[System.IO.File]::WriteAllText((Join-Path $drProfile 'client.json'), (ConvertTo-Json -Compress -InputObject ([ordered]@{ schema_version = 1; client = 'Contoso'; root = $drClient; project_file = $drProject })), $utf8)

# --- fakes -------------------------------------------------------------------------------
$drBin = Join-Path $t 'bin'
New-Item -ItemType Directory -Force -Path $drBin | Out-Null
$null = New-PyStub $drBin 'npm' "import sys`nif sys.argv[1:2] == ['--version']:`n    print('10.0.0')`nsys.exit(0)`n"
$null = New-PyStub $drBin 'pi' "import sys`nsys.exit(0)`n"
$env:PATH = "$drBin$sep$($drSaved['PATH'])"

$env:COOP_TEST_DR_CALLS = Join-Path $t 'builtin-powershell.jsonl'
$env:COOP_TEST_DR_LOG = Join-Path $t 'python.jsonl'
# -Forward: run the waiter for real, recording its pid and, when it ends, its exit
# (<calls>.waiters), so the process fixture can wait for every waiter and stop strays.
$forwardLine = if ($Forward) {
  "if any(a.lower().endswith('docs-refresh.ps1') for a in args):`n" +
  "    child = subprocess.Popen([r'$psExe'] + args)`n" +
  "    with open(os.environ['COOP_TEST_DR_CALLS'] + '.waiters', 'a', encoding='utf-8') as fh:`n        fh.write(json.dumps({'pid': child.pid}) + '\n')`n" +
  "    rc = child.wait()`n" +
  "    with open(os.environ['COOP_TEST_DR_CALLS'] + '.waiters', 'a', encoding='utf-8') as fh:`n        fh.write(json.dumps({'exit': child.pid, 'rc': rc}) + '\n')`n" +
  "    sys.exit(rc)`n"
} else { '' }
$recorder = "import json, os, subprocess, sys`nargs = sys.argv[1:]`nwith open(os.environ['COOP_TEST_DR_CALLS'], 'a', encoding='utf-8') as fh:`n    fh.write(json.dumps(args) + '\n')`n$forwardLine" +
  "sys.exit(4 if '-Command' in args else 0)`n"
$env:COOP_BUILTIN_POWERSHELL = New-PyStub (Join-Path $t 'builtin') 'builtin-powershell' $recorder

$drSite = Join-Path $t 'site'
New-Item -ItemType Directory -Force -Path $drSite | Out-Null
@'
import json
import os
import sys
import time
from pathlib import Path

_name = Path(sys.argv[0]).name.lower() if sys.argv and sys.argv[0] else ""


def _record(entry):
    with open(os.environ["COOP_TEST_DR_LOG"], "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry) + "\n")


if _name == "warehouse_mcp.py" and sys.argv[1:2] == ["launch-token"]:
    if os.environ.get("COOP_TEST_DR_TOKEN", "ok") == "ok":
        os.write(1, b"token\tfake.cw6.token\tend")
    else:
        os.write(1, b"warning\tauth_required\tend")
    os._exit(0)
if _name == "live_docs.py":
    request = json.loads(sys.stdin.read() or "null")
    command = request.get("command") if isinstance(request, dict) else ""
    _record({"request": request, "cwd": os.getcwd(), "project_yml": os.environ.get("COOP_PROJECT_YML", ""),
             "token": os.environ.get("COOP_FABRIC_MCP_TOKEN", ""), "pid": os.getpid()})
    delay = float(os.environ.get("COOP_TEST_DR_SLEEP", "") or 0)
    if delay:
        time.sleep(delay)
    if command == "refresh":
        answer = os.environ.get("COOP_TEST_DR_REFRESH", "") or json.dumps({"ok": True, "state": "ok", "taken": 1, "sources": [
            {"name": "dev", "state": "taken", "changes": {"added": ["dbo.a (table)"], "changed": ["dbo.v (view)"], "removed": []}}]})
    else:
        answer = os.environ.get("COOP_TEST_DR_BUILD", "") or json.dumps({"ok": True, "state": "ok", "files_changed": 3})
    sys.stdout.write(answer)
    sys.stdout.flush()
    os._exit(0)
'@ | Set-Content -LiteralPath (Join-Path $drSite 'sitecustomize.py') -Encoding UTF8
$env:PYTHONPATH = if ($drSaved['PYTHONPATH']) { "$drSite$sep$($drSaved['PYTHONPATH'])" } else { $drSite }

# --- the clock: 09:00 today plus the seconds given, so +21 minutes never crosses midnight ----
$env:COOP_DOCS_REFRESH_CLOCK = Join-Path $t 'clock'
$drNine = (Get-Date).Date.AddHours(9)
function Set-DrClock([double]$Seconds) {
  $offset = ($drNine.AddSeconds($Seconds) - (Get-Date)).TotalSeconds
  [System.IO.File]::WriteAllText($env:COOP_DOCS_REFRESH_CLOCK, $offset.ToString([System.Globalization.CultureInfo]::InvariantCulture))
}
function Get-DrNow { return (Get-Date).AddSeconds([double]([System.IO.File]::ReadAllText($env:COOP_DOCS_REFRESH_CLOCK))) }
function Get-DrDay([double]$Seconds) { return $drNine.AddSeconds($Seconds).ToString('yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture) }
Set-DrClock 0

# --- readers -------------------------------------------------------------------------------
function Read-DrJsonLines([string]$File) {
  if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return @() }
  return @(Get-Content -LiteralPath $File -Encoding UTF8 | Where-Object { $_ } | ForEach-Object { , ($_ | ConvertFrom-Json) })
}
function Get-DrCalls { return @(Read-DrJsonLines $env:COOP_TEST_DR_CALLS) }
function Get-DrWaiterCalls { return @(Get-DrCalls | Where-Object { @($_ | Where-Object { ([string]$_).ToLower().EndsWith('docs-refresh.ps1') }).Count -gt 0 }) }
function Get-DrHelperCalls { return @(Read-DrJsonLines $env:COOP_TEST_DR_LOG | Where-Object { $_.PSObject.Properties['request'] }) }
function Get-DrStateDoc { if (Test-Path -LiteralPath $drState) { return (Get-Content -LiteralPath $drState -Raw -Encoding UTF8 | ConvertFrom-Json) } return $null }
function Get-DrPending { $f = Join-Path $drDir 'pending.json'; if (Test-Path -LiteralPath $f) { return (Get-Content -LiteralPath $f -Raw | ConvertFrom-Json) } return $null }
# The waiter argument after -WaiterDue (unix seconds) / -WaiterFrom in one recorded start.
function Get-DrArg($Call, [string]$Name) { $a = @($Call); for ($i = 0; $i -lt $a.Count - 1; $i++) { if ($a[$i] -ceq $Name) { return [string]$a[$i + 1] } }; return '' }
function ConvertFrom-DrUnix([long]$Seconds) { return [System.DateTimeOffset]::FromUnixTimeSeconds($Seconds).LocalDateTime }

# --- the real scripts -------------------------------------------------------------------------
function Invoke-DrSignIn {
  $out = (Invoke-Native { & $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $signIn 2>&1 } | Out-String)
  return @{ Rc = $LASTEXITCODE; Out = $out }
}
# `coop -p "say hi"` in a child whose stdin is empty, as tests/fixtures/pi-exit-code.test.ps1 runs it.
function Invoke-DrCoop {
  $in = Join-Path $t 'coop.in'; $so = Join-Path $t 'coop.out'; $se = Join-Path $t 'coop.err'
  [System.IO.File]::WriteAllText($in, '')
  $argList = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $coop + '"'), '-p', '"say hi"')
  $p = Start-Process -FilePath $psExe -ArgumentList $argList -WorkingDirectory $t -PassThru -NoNewWindow -RedirectStandardInput $in -RedirectStandardOutput $so -RedirectStandardError $se
  $null = $p.Handle
  $p.WaitForExit()
  return @{ Rc = $p.ExitCode; Out = [System.IO.File]::ReadAllText($so) + [System.IO.File]::ReadAllText($se) }
}
# The waiter, run to its end: its last output line is the outcome.
function Invoke-DrWaiter([string[]]$WaiterArgs) {
  $out = @(Invoke-Native { & $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $drScript @WaiterArgs 2>&1 } | ForEach-Object { [string]$_ } | Where-Object { $_.Trim() })
  return @{ Rc = $LASTEXITCODE; Outcome = $(if ($out.Count) { $out[-1].Trim() } else { '' }); Out = ($out -join "`n") }
}
# A recorded start, replayed exactly (with -WaiterTick appended to look once).
function Invoke-DrRecordedWaiter($Call, [switch]$Tick) {
  $from = Get-DrArg $Call '-WaiterFrom'; $due = Get-DrArg $Call '-WaiterDue'
  $wa = @('-WaiterFrom', $from, '-WaiterDue', $due)
  if ($Tick) { $wa += '-WaiterTick' }
  return (Invoke-DrWaiter $wa)
}
function Set-DrFeature([string]$State) {
  $out = (Invoke-Native { & $psExe -NoProfile -File $coop settings set docs-refresh $State 2>&1 } | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "coop settings set docs-refresh $State failed: $out" }
}

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
#   Get-DrWaiterEnv                 the launch-private variables each waiter start
#                                   inherited (none may reach it)
#   Get-DrAzCalls                   every fake `az` call (Set-DrReal: the real
#                                   live_docs.py)
#   Invoke-DrSignIn / Invoke-DrCoop the real sign-in.ps1 / `coop -p hi` (fake Pi)
#   Invoke-DrDesktop                the real `coop desktop --app <fake window>`
#   Invoke-DrWaiter <argv>          the waiter, run to its end in this process' child
#   Set-DrFeature on|off            through the one writer (coop settings)
#
# Fakes: the built-in powershell.exe is a recorder (sign-in.ps1 -PowerShellPath,
# and COOP_BUILTIN_POWERSHELL for coop's starter); with -Forward (the process
# fixture) it runs the waiter for real. Python is the real one with a
# sitecustomize.py on PYTHONPATH that answers only warehouse_mcp.py launch-token
# (the launch's token) and lib\live_docs.py (the refresh and build), as
# tests/fixtures/fabric-mcp-launch.test.ps1 fakes the token helper; every other
# Python call runs as it is. With COOP_TEST_DR_REAL=1 (Set-DrReal) live_docs.py
# is the real one too, against a fake `az` (the sign-in, mode in az-mode) and a
# fake coop-data-doc (COOP_DATA_DOC_BIN). The clock is COOP_DOCS_REFRESH_CLOCK.
# Offline, sandbox home only.
param([switch]$Forward)

$drRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$drScript = Join-Path $drRoot 'scripts\docs-refresh.ps1'
$signIn = Join-Path $drRoot 'scripts\sign-in.ps1'
$coop = Join-Path $drRoot 'bin\coop.ps1'
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-cw6-' + [guid]::NewGuid().ToString('N'))
$drSaved = Save-Env @('PATH', 'HOME', 'USERPROFILE', 'COOP_DIR', 'COOP_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'COOP_NO_ISOLATE', 'COOP_MACHINE_DIR',
  'COOP_SKIP_AZ', 'COOP_AZ_BIN', 'COOP_SKIP_EXT_CHECK', 'COOP_NO_MODEL_LOGIN', 'NO_COLOR', 'PYTHONPATH', 'TEMP', 'TMP', 'TMPDIR',
  'COOP_BUILTIN_POWERSHELL', 'COOP_DOCS_REFRESH_CLOCK', 'COOP_DOCS_REFRESH_POLL_MS', 'COOP_DOCS_REFRESH_LIMIT_SECONDS', 'APPDATA', 'COOP_DATA_DOC_BIN', 'COOP_TEST_DR_REAL', 'COOP_TEST_DR_GRANDCHILD',
  'COOP_DATA_DOC_ACCESS_TOKEN', 'COOP_DESKTOP_SPEC', 'COOP_DESKTOP_DATA', 'COOP_FIRST_RUN', 'COOP_PRIME_MODEL_LOGIN',
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
foreach ($n in @('PI_CODING_AGENT_DIR', 'COOP_NO_ISOLATE', 'COOP_DOCS_REFRESH_LIMIT_SECONDS', 'COOP_TEST_DR_TOKEN', 'COOP_TEST_DR_REFRESH', 'COOP_TEST_DR_BUILD', 'COOP_TEST_DR_SLEEP', 'COOP_PROJECT_YML', 'COOP_FABRIC_MCP_TOKEN',
  'COOP_DATA_DOC_BIN', 'COOP_TEST_DR_REAL', 'COOP_TEST_DR_GRANDCHILD', 'COOP_DATA_DOC_ACCESS_TOKEN', 'COOP_DESKTOP_SPEC', 'COOP_DESKTOP_DATA', 'COOP_FIRST_RUN', 'COOP_PRIME_MODEL_LOGIN')) { Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue }
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
# Each start also notes which launch-private variables it inherited (<calls>.env).
$recorder = "import json, os, subprocess, sys`nargs = sys.argv[1:]`nwith open(os.environ['COOP_TEST_DR_CALLS'], 'a', encoding='utf-8') as fh:`n    fh.write(json.dumps(args) + '\n')`n" +
  "private = [n for n in ('COOP_FABRIC_MCP_TOKEN', 'COOP_DATA_DOC_ACCESS_TOKEN', 'COOP_DESKTOP_SPEC', 'COOP_DESKTOP_DATA', 'COOP_FIRST_RUN', 'COOP_PRIME_MODEL_LOGIN') if n in os.environ]`n" +
  "with open(os.environ['COOP_TEST_DR_CALLS'] + '.env', 'a', encoding='utf-8') as fh:`n    fh.write(json.dumps({'args': args, 'private': private}) + '\n')`n$forwardLine" +
  "sys.exit(4 if '-Command' in args else 0)`n"
$drBuiltin = New-PyStub (Join-Path $t 'builtin') 'builtin-powershell' $recorder
$env:COOP_BUILTIN_POWERSHELL = $drBuiltin

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


if _name == "warehouse_mcp.py" and sys.argv[1:2] == ["launch-token"] and os.environ.get("COOP_TEST_DR_REAL") != "1":
    if os.environ.get("COOP_TEST_DR_TOKEN", "ok") == "ok":
        os.write(1, b"token\tfake.cw6.token\tend")
    else:
        os.write(1, b"warning\tauth_required\tend")
    os._exit(0)
if _name == "live_docs.py" and os.environ.get("COOP_TEST_DR_REAL") != "1":
    request = json.loads(sys.stdin.read() or "null")
    command = request.get("command") if isinstance(request, dict) else ""
    _record({"request": request, "cwd": os.getcwd(), "project_yml": os.environ.get("COOP_PROJECT_YML", ""),
             "token": os.environ.get("COOP_FABRIC_MCP_TOKEN", ""), "pid": os.getpid()})
    delay = float(os.environ.get("COOP_TEST_DR_SLEEP", "") or 0)
    if delay and os.environ.get("COOP_TEST_DR_GRANDCHILD"):
        # coop-data-doc's place: a child that would outlive this helper if only the helper were stopped.
        import subprocess
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(%f)" % delay])
        with open(os.environ["COOP_TEST_DR_GRANDCHILD"], "w", encoding="utf-8") as fh:
            fh.write(str(child.pid))
        child.wait()
    elif delay:
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
# The Run entry starts it with no parameter; here the recorder stands in for the
# built-in powershell.exe and the closing pause is skipped.
function Invoke-DrSignIn {
  $out = (Invoke-Native { & $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $signIn -PowerShellPath $drBuiltin -NoPause 2>&1 } | Out-String)
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
# The waiter, run to its end, in the profile folder as the starters start it:
# its last output line is the outcome.
function Invoke-DrWaiter([string[]]$WaiterArgs) {
  Push-Location -LiteralPath $drProfile
  try { $out = @(Invoke-Native { & $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $drScript @WaiterArgs 2>&1 } | ForEach-Object { [string]$_ } | Where-Object { $_.Trim() }) } finally { Pop-Location }
  return @{ Rc = $LASTEXITCODE; Outcome = $(if ($out.Count) { $out[-1].Trim() } else { '' }); Out = ($out -join "`n") }
}
# A recorded start, replayed exactly (with -WaiterTick appended to look once).
function Invoke-DrRecordedWaiter($Call, [switch]$Tick) {
  $from = Get-DrArg $Call '-WaiterFrom'; $due = Get-DrArg $Call '-WaiterDue'
  $wa = @('-WaiterFrom', $from, '-WaiterDue', $due)
  if ($Tick) { $wa += '-WaiterTick' }
  return (Invoke-DrWaiter $wa)
}
function Get-DrWaiterEnv { return @(Read-DrJsonLines ($env:COOP_TEST_DR_CALLS + '.env') | Where-Object { @($_.args | Where-Object { ([string]$_).ToLower().EndsWith('docs-refresh.ps1') }).Count -gt 0 }) }

# `coop desktop --app <fake window> <client folder>`: the fake window notes the
# launch-private variables it got (it must get the spec; the waiter must not).
$drNpm = Join-Path $t 'appdata\npm\node_modules\@earendil-works\pi-coding-agent'
New-Item -ItemType Directory -Force -Path (Join-Path $drNpm 'dist') | Out-Null
[System.IO.File]::WriteAllText((Join-Path $drNpm 'package.json'), '{"name":"@earendil-works/pi-coding-agent","version":"0.0.0","bin":{"pi":"dist/cli.js"}}', $utf8)
[System.IO.File]::WriteAllText((Join-Path $drNpm 'dist\cli.js'), '', $utf8)
$drWindowLog = Join-Path $t 'window.jsonl'
$drWindow = New-PyStub (Join-Path $t 'window') 'coop-window' ("import json, os`nwith open(r'$drWindowLog', 'a', encoding='utf-8') as fh:`n    fh.write(json.dumps({'spec': bool(os.environ.get('COOP_DESKTOP_SPEC')), 'data': bool(os.environ.get('COOP_DESKTOP_DATA'))}) + '\n')`n")
function Invoke-DrDesktop {
  $saveAppData = $env:APPDATA
  $env:APPDATA = Join-Path $t 'appdata'
  try {
    $out = (Invoke-Native { & $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $coop desktop --app $drWindow $drClient 2>&1 } | Out-String)
    return @{ Rc = $LASTEXITCODE; Out = $out }
  } finally { $env:APPDATA = $saveAppData }
}
function Get-DrWindowStarts { return @(Read-DrJsonLines $drWindowLog) }

# --- the real live_docs.py (Set-DrReal): a fake az and a fake coop-data-doc ----------------
# The token helper (lib\fabric_request_headers.mjs) gives az only a few safe
# variables, so the fake az reads its mode from a file: 'ok' answers a token for
# the fixture's tenant and user, 'auth' says to run az login.
$drMarker = Join-Path $t 'az'
New-Item -ItemType Directory -Force -Path $drMarker | Out-Null
function ConvertTo-DrB64Url([string]$Text) { return [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Text)).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
$drJwt = (ConvertTo-DrB64Url '{"alg":"none"}') + '.' + (ConvertTo-DrB64Url '{"tid":"11111111-1111-4111-8111-111111111111","oid":"22222222-2222-4222-8222-222222222222"}') + '.' + (ConvertTo-DrB64Url 'cw6-signature')
[System.IO.File]::WriteAllText((Join-Path $drMarker 'az-response.json'), '{"accessToken":"' + $drJwt + '"}' + "`n", [System.Text.Encoding]::ASCII)
function Set-DrAzMode([string]$Mode) { [System.IO.File]::WriteAllText((Join-Path $drMarker 'az-mode'), $Mode, [System.Text.Encoding]::ASCII) }
Set-DrAzMode 'ok'
$drAzProgram = Join-Path $drMarker 'fake-az.cjs'
[System.IO.File]::WriteAllText($drAzProgram, @'
const fs = require('node:fs');
const path = require('node:path');
const [marker, ...args] = process.argv.slice(2);
fs.appendFileSync(path.join(marker, 'az-calls.jsonl'), JSON.stringify(args) + '\n');
if (fs.readFileSync(path.join(marker, 'az-mode'), 'utf8') === 'auth') {
  process.stderr.write("ERROR: Please run 'az login' to setup account.\n");
  process.exit(1);
}
process.stdout.write(fs.readFileSync(path.join(marker, 'az-response.json')));
'@, [System.Text.Encoding]::ASCII)
$drNode = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
if ($isWindowsHost) {
  [System.IO.File]::WriteAllText((Join-Path $drBin 'az.cmd'), "@echo off`r`n`"$drNode`" `"$drAzProgram`" `"$drMarker`" %*`r`nexit /b %ERRORLEVEL%`r`n", [System.Text.Encoding]::ASCII)
} else {
  [System.IO.File]::WriteAllText((Join-Path $drBin 'az'), "#!/bin/sh`nexec `"$drNode`" `"$drAzProgram`" `"$drMarker`" `"`$@`"`n", [System.Text.Encoding]::ASCII)
  & $chmod +x (Join-Path $drBin 'az')
}
function Get-DrAzCalls { return @(Read-DrJsonLines (Join-Path $drMarker 'az-calls.jsonl')) }
# The fake coop-data-doc: show-config answers the config's live sources (from
# the fixture's file), snapshot writes one file and reports it (recording
# whether it got the database token), build exits 0.
$drDataDocLog = Join-Path $t 'data-doc.jsonl'
$env:COOP_DATA_DOC_BIN = New-PyStub (Join-Path $t 'data-doc') 'coop-data-doc' (@'
import json, os, sys
from pathlib import Path
argv = sys.argv[1:]
with open(r'__LOG__', 'a', encoding='utf-8') as fh:
    fh.write(json.dumps({"argv": argv, "token": bool(os.environ.get("COOP_DATA_DOC_ACCESS_TOKEN")), "launch_token": bool(os.environ.get("COOP_FABRIC_MCP_TOKEN"))}) + "\n")
spec = json.loads(Path(r'__SPEC__').read_text(encoding="utf-8"))
if argv[:1] == ["show-config"]:
    print(json.dumps({"exists": True, "output": {"dir": "./data-docs"}, "repos": {"sql": {"path": "./live/dev"}}, "live_sources": spec}))
elif argv[:1] == ["snapshot"]:
    name = argv[1]
    folder = Path("live") / "dev"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "dbo.t.sql").write_text("create table dbo.t (id int)\n", encoding="utf-8")
    print(json.dumps({"sources": [{"name": name, "taken_at": "2026-11-26T09:21:00Z", "counts": {"tables": 1}, "written": 1}]}))
elif argv[:1] == ["build"]:
    Path("data-docs").mkdir(exist_ok=True)
    Path("data-docs", "index.md").write_text("# docs\n", encoding="utf-8")
else:
    sys.exit(9)
'@).Replace('__LOG__', $drDataDocLog).Replace('__SPEC__', (Join-Path $t 'live-sources.json'))
function Get-DrDataDocCalls { return @(Read-DrJsonLines $drDataDocLog) }
# The real live_docs.py with these live sources (name -> server, database) and this project file text.
function Set-DrReal([hashtable]$Sources, [string]$ProjectText) {
  $env:COOP_TEST_DR_REAL = '1'
  $live = [ordered]@{}
  foreach ($k in $Sources.Keys) { $live[$k] = [ordered]@{ repo = 'sql'; server = $Sources[$k][0]; database = $Sources[$k][1] } }
  [System.IO.File]::WriteAllText((Join-Path $t 'live-sources.json'), (ConvertTo-Json -Compress -Depth 4 -InputObject $live), $utf8)
  [System.IO.File]::WriteAllText($drProject, $ProjectText, $utf8)
}
function Reset-DrReal {
  Remove-Item Env:COOP_TEST_DR_REAL -ErrorAction SilentlyContinue
  [System.IO.File]::WriteAllText($drProject, "schema_version: 1`nprofile:`n  client: Contoso`n", $utf8)
}

function Set-DrFeature([string]$State) {
  $out = (Invoke-Native { & $psExe -NoProfile -File $coop settings set docs-refresh $State 2>&1 } | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "coop settings set docs-refresh $State failed: $out" }
}

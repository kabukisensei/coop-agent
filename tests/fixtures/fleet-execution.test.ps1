#!/usr/bin/env pwsh
# Execute the normal install/update/sync fleet paths with offline stubs and assert
# the exact specs they converge to:
#   - `install --force` reinstalls the Fabric CLI with an explicit supported
#     bootstrap Python and injects the exact fabric-cicd / pyodbc runtime pins;
#     an injection or pipx failure is exit 1 with a failed-step summary; the
#     extensions are installed by the sync child (master plan S2)
#   - a non-Windows install without ODBC Driver 18 still converges with ONE warning
#   - `update` (fleet mode) never fetches the checkout it runs from, leaves Pi and
#     the pipx tools already at their pins alone (offline no-op), converges a
#     drifted tool, and is exit 1 when a convergence unit fails
#   - `sync` installs every manifest extension pin into the isolated tree, and a
#     repeat sync is an offline no-op
#   - normal install converges drifted Pi / pipx tools, skips matching ones;
#     `--edge` attempts upstream latest for Pi and the tools (extensions stay
#     pinned); a failed Fabric convergence is a failure; update installs missing
#     manifest-pinned pipx tools with the explicit bootstrap Python
# The pipx stub is honest: `install` / `upgrade` update the list it reports, so
# the convergence postcondition (installed version == pin) is really exercised.
# The scripts run from a plain COPY of this tree with no .git (#104): step 1 of
# `coop update` fetches and fast-forwards the checkout it runs from, and a test
# must never touch the checkout running it. Every location the fleet scripts can
# write is isolated per block (temp HOME / USERPROFILE / LOCALAPPDATA / APPDATA /
# COOP_DIR / PIPX_HOME / agent dirs); the real ~/.coop is never read or written.
# Install and update run through to their last step: the redirected profile keeps
# the PATH link and shortcuts in the sandbox (Test-CoopProfileRedirected), the
# redirected stdio and COOP_NO_ONBOARD / COOP_NO_MODEL_LOGIN skip onboarding and
# the model sign-in, and the sync and doctor children run against these stubs.
# Doctor's verdict decides the exit code, so the cases below assert on the call
# log and the scripts' failed-step summary lines, not on the exit code alone.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$checkout = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-fleet-exec-' + [guid]::NewGuid().ToString('N'))
$realNode = (Get-Command node -ErrorAction Stop).Source
$realGit = (Get-Command git -ErrorAction Stop).Source
# The stub machine needs a Fabric-compatible (3.10-3.13) Python for the H1 gate;
# prefer a versioned one so a host whose python3 is 3.14 still qualifies. The
# Windows Store App-Execution-Alias stub under WindowsApps is not an interpreter.
$realPy = Get-FixturePython
if (-not $realPy) { throw 'a Python 3.10-3.13 is required for the fleet fixtures' }
$psDir = Split-Path -Parent $psExe

$extSpecs = @('npm:pi-mcp-adapter@5.4.0', 'npm:pi-hermes-memory@0.9.11', 'npm:pi-better-openai@0.1.22', 'npm:pi-web-access@0.35.0',
              'npm:@juicesharp/rpiv-ask-user-question@2.12.0', 'npm:@juicesharp/rpiv-todo@2.12.0', 'npm:@xl0/pi-lovely-rename@0.1.5')

# A Python string literal for a path (backslashes and quotes escaped).
function ConvertTo-PyString([string]$S) { return "'" + $S.Replace('\', '\\').Replace("'", "\'") + "'" }
# Shared stub preamble: argv, the call log, a package.json writer (honest
# installs) and a forwarder to a real tool.
$stubPrelude = @'
import json, os, subprocess, sys
args = sys.argv[1:]
def log(line):
    with open(os.environ['MARKER'], 'a', encoding='utf-8', newline='\n') as f:
        f.write(line + '\n')
def write_pkg(root, spec):
    i = spec.rfind('@')
    name, ver = (spec[:i], spec[i + 1:]) if i > 0 else (spec, '')
    d = os.path.join(root, *name.split('/'))
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, 'package.json'), 'w', encoding='utf-8') as f:
        json.dump({'name': name, 'version': ver}, f)
def forward(exe):
    sys.exit(subprocess.call([exe] + args))

'@
# Honest pi: `pi install npm:<name>@<ver>` materializes
# $PI_CODING_AGENT_DIR/npm/node_modules/<name>/package.json, which sync's
# postcondition reads back.
function Get-PiStub([string]$Version, [bool]$Honest, [bool]$Log) {
  $honestPy = if ($Honest) { 'True' } else { 'False' }
  $logPy = if ($Log) { 'True' } else { 'False' }
  return $stubPrelude + @"
if args[:1] == ['--version']:
    print('pi $Version'); sys.exit(0)
if ${logPy}:
    log('PI ' + ' '.join(args))
if ${honestPy} and args[:1] == ['install'] and len(args) > 1:
    spec = args[1]
    write_pkg(os.path.join(os.environ['PI_CODING_AGENT_DIR'], 'npm', 'node_modules'), spec[4:] if spec.startswith('npm:') else spec)
sys.exit(0)
"@
}
# Honest npm: the shared-library realignment (Sync-CoopExtDeps) runs
# `npm install ... @earendil-works/pi-ai@V @earendil-works/pi-tui@V` in the tree
# and sync's postcondition (lib/_extdeps.py align --check) then reads those two
# package.json files back, so the stub materializes exactly them in its cwd.
# `npm prefix -g` answers the machine's <home>/.local (the stub bin's parent).
$npmStub = $stubPrelude + @'
if args[:2] == ['prefix', '-g']:
    print(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))); sys.exit(0)
if args[:1] == ['view']:
    print('1.2.0'); sys.exit(0)
if args[:1] == ['--version']:
    print('10.9.0'); sys.exit(0)
log('NPM ' + ' '.join(args))
if args[:1] == ['install']:
    for a in args:
        if a.startswith('@earendil-works/pi-ai@') or a.startswith('@earendil-works/pi-tui@'):
            write_pkg('node_modules', a)
sys.exit(0)
'@
# Honest pipx: `pipx list` prints the machine's installed packages from the
# $PIPX_STATE file; any other call whose argv contains $PIPX_FAIL_MATCH fails
# (exit 1, unlogged) so the failure-injection cases can fail a convergence unit;
# everything else is logged, and `install [--force] ... <pkg>[==<ver>]` /
# `upgrade <pkg>` record the package at that version (an unpinned spec and
# `upgrade` land on 9.9.9, "latest"), `uninstall <pkg>` drops it, so a
# convergence is verified by what pipx then reports (the postcondition installed
# == pin). `environment --value PIPX_DEFAULT_PYTHON` answers with the machine's
# real interpreter (#430: the one coop's tools belong on). A local wheel spec
# (what the sourced-tool path hands pipx for coop-sql-source-control, #433) is
# read the way pip reads it: the PEP 427 file name carries the distribution and
# the version, and `_` in the name normalizes to `-` (the name `pipx list` shows).
$pipxStub = $stubPrelude + @'
import re
state = os.environ['PIPX_STATE']
def spec_name_version(spec):
    base = os.path.basename(spec)
    if base.lower().endswith('.whl'):
        parts = base[:-4].split('-')
        if len(parts) >= 5:
            return re.sub(r'[-_.]+', '-', parts[0]).lower(), parts[1]
        return base, '9.9.9'
    name, _, ver = spec.partition('==')
    return name, (ver or '9.9.9')
def read_state():
    if not os.path.exists(state):
        return []
    with open(state, encoding='utf-8') as f:
        return [l for l in f.read().splitlines() if l]
if args[:1] == ['list']:
    for line in read_state():
        print(line)
    sys.exit(0)
if args[:3] == ['environment', '--value', 'PIPX_DEFAULT_PYTHON']:
    print(os.environ.get('PIPX_STUB_DEFAULT_PYTHON', ''))
    sys.exit(0)
fail = os.environ.get('PIPX_FAIL_MATCH', '')
if fail and fail in ' '.join(args):
    sys.exit(1)
log('PIPX ' + ' '.join(args))
if args[:1] == ['uninstall'] and len(args) > 1:
    lines = [l for l in read_state() if not l.startswith('package ' + args[1] + ' ')]
    with open(state, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + ('\n' if lines else ''))
if args[:1] in (['install'], ['upgrade']) and len(args) > 1:
    name, ver = spec_name_version(args[-1])
    if '--suffix' in args:  # a suffixed install is its own environment (#441's probe)
        name += args[args.index('--suffix') + 1]
    lines = [l for l in read_state() if not l.startswith('package ' + name + ' ')]
    lines.append('package %s %s' % (name, ver))
    with open(state, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')
sys.exit(0)
'@
# One fully isolated "machine": every location the fleet scripts can touch lives
# under it, plus the stub bin that models the tools present on it.
# The bootstrap interpreter the fleet scripts pick for the Fabric CLI on the
# machine whose environment is current (PATH, LOCALAPPDATA, ProgramFiles): the
# tree copy's own resolver, run in a child PowerShell so nothing of lib/common.ps1
# lands in this fixture's scope. '' when it names none.
function Get-MachineFabricPython {
  $lib = Join-Path $root 'lib\common.ps1'
  if (-not (Test-Path -LiteralPath $lib -PathType Leaf)) { return '' }
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $lines = @(& $psExe -NoProfile -NonInteractive -Command ". '$lib'; [string](Get-CoopFabricBootstrapPython)" 2>$null | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
    $resolved = if ($lines.Count) { $lines[-1] } else { '' }
  } catch { $resolved = '' } finally { $ErrorActionPreference = $eap }
  if ($resolved -and (Test-Path -LiteralPath $resolved -PathType Leaf)) { return $resolved }
  return ''
}
function New-Machine {
  param([string]$Name, [string]$PiVersion = '1.2.0', [bool]$HonestPi = $true, [string[]]$PipxList = @(), [string]$FabVersion = '1.6.1', [bool]$LogPi = $true)
  $d = Join-Path $t "m-$Name"
  $mHome = Join-Path $d 'home'
  $bin = Join-Path $mHome '.local\bin'
  $agent = Join-Path $d 'agent'
  $pipxHome = Join-Path $d 'pipx-home'
  foreach ($p in @($bin, $agent, $pipxHome, (Join-Path $d 'pipx-bin'), (Join-Path $d 'coop-dir'), (Join-Path $mHome 'AppData\Local\Microsoft\Windows\PowerShell'), (Join-Path $mHome 'AppData\Roaming'))) {
    New-Item -ItemType Directory -Force -Path $p | Out-Null
  }
  $marker = Join-Path $d 'calls'
  [System.IO.File]::WriteAllText($marker, '')
  $env:HOME = $mHome; $env:USERPROFILE = $mHome
  $env:LOCALAPPDATA = Join-Path $mHome 'AppData\Local'; $env:APPDATA = Join-Path $mHome 'AppData\Roaming'
  $env:COOP_DIR = Join-Path $d 'coop-dir'
  $env:PIPX_HOME = $pipxHome; $env:PIPX_BIN_DIR = Join-Path $d 'pipx-bin'
  $env:PIPX_STUB_DEFAULT_PYTHON = $realPy
  $env:PI_CODING_AGENT_DIR = $agent; $env:COOP_AGENT_DIR = $agent
  $env:COOP_NO_ONBOARD = '1'; $env:COOP_NO_MODEL_LOGIN = '1'
  $env:MARKER = $marker
  $env:COOP_TEST_STUB_PATH = $bin
  Remove-Item Env:\COOP_FABRIC_PYTHON, Env:\PIPX_FAIL_MATCH, Env:\COOP_TEST_DRIVER_MISSING -ErrorAction SilentlyContinue
  $null = New-PyStub $bin 'pi' (Get-PiStub $PiVersion $HonestPi $LogPi)
  $null = New-PyStub $bin 'npm' $npmStub
  # The pipx list lives in a state file the honest stub reads and updates.
  $pipxState = Join-Path $d 'pipx-list'
  [System.IO.File]::WriteAllText($pipxState, (($PipxList | ForEach-Object { "$_" }) -join "`n") + $(if (@($PipxList).Count) { "`n" } else { '' }), $utf8)
  $env:PIPX_STATE = $pipxState
  $null = New-PyStub $bin 'pipx' $pipxStub
  # The sourced tool's release wheel is already in this machine's wheel cache
  # (<profile>\wheels, hash-checked), so the convergence takes the wheel branch
  # with no network and no token (#433); its SHA-256 is the fixture manifest's.
  if ($script:sourcedWheel) {
    $wheelDir = Join-Path (Join-Path $env:COOP_DIR '.coop') 'wheels'
    New-Item -ItemType Directory -Force -Path $wheelDir | Out-Null
    [System.IO.File]::WriteAllBytes((Join-Path $wheelDir $script:sourcedWheel.Asset), $script:sourcedWheel.Bytes)
  }
  $null = New-PyStub $bin 'fab' ($stubPrelude + "print('fab version $FabVersion')`nsys.exit(0)`n")
  # Git and Azure CLI are install prerequisites (H1 gate); this machine has them.
  $null = New-PyStub $bin 'az' ($stubPrelude + "print('azure-cli 2.80.0')`nsys.exit(0)`n")
  $null = New-PyStub $bin 'git' ($stubPrelude + 'forward(' + (ConvertTo-PyString $realGit) + ")`n")
  $null = New-PyStub $bin 'node' ($stubPrelude + 'forward(' + (ConvertTo-PyString $realNode) + ")`n")
  $null = New-PyStub $bin 'python3' ($stubPrelude + 'forward(' + (ConvertTo-PyString $realPy) + ")`n")
  # A driver_missing runtime on Windows would reach `winget install
  # Microsoft.msodbcsql.18`; this machine's winget only logs and fails.
  $null = New-PyStub $bin 'winget' ($stubPrelude + "log('WINGET ' + ' '.join(args))`nsys.exit(1)`n")
  if ($isWindowsHost) {
    $env:PATH = $bin + $sep + $script:priorPath
  } else {
    # The stub bin first, then the system dirs the scripts need (sh, uname). The
    # stub bin is repeated at the END because install.ps1's PATH helpers prepend
    # with ';' (Windows separators): on a POSIX host that fuses the first entries
    # into one unusable segment, and the trailing copy keeps the stubs resolvable.
    $env:PATH = $bin + ':' + $psDir + ':/usr/bin:/bin:' + $bin
  }
  # The Fabric CLI's pipx environment is a REAL (pip-less) venv built on the
  # interpreter the scripts themselves resolve for it on this machine
  # (Get-CoopFabricBootstrapPython under the machine's PATH, as a real install
  # would have built it; $realPy when it names none), so Get-CoopVenvPythonPath
  # finds Scripts\python.exe on Windows and bin/python elsewhere, and the
  # environment is on the Python the convergence expects (#430: a venv on any
  # other interpreter is removed and built again). The fixture pyodbc on
  # PYTHONPATH (set once below) answers its runtime probe.
  $bootPy = Get-MachineFabricPython
  if (-not $bootPy) { $bootPy = $realPy }
  $venv = Join-Path $pipxHome 'venvs\ms-fabric-cli'
  & $bootPy -m venv --without-pip $venv *> $null
  if ($LASTEXITCODE -ne 0 -or -not ((Test-Path -LiteralPath (Join-Path $venv 'Scripts\python.exe')) -or (Test-Path -LiteralPath (Join-Path $venv 'bin/python')))) {
    throw "could not create the Fabric venv fixture under $venv with $bootPy"
  }
  return [pscustomobject]@{ Dir = $d; Bin = $bin; Agent = $agent; Marker = $marker; Home = $mHome; PipxState = $pipxState; FabricPython = $bootPy }
}
# Rewrite what the stub pipx reports (a machine whose tool drifted after install).
function Set-PipxList([object]$M, [string[]]$Lines) { [System.IO.File]::WriteAllText($M.PipxState, ($Lines -join "`n") + "`n", $utf8) }
function Get-Calls([object]$M) { return [System.IO.File]::ReadAllText($M.Marker) }
function Reset-Calls([object]$M) { [System.IO.File]::WriteAllText($M.Marker, '') }
function Test-Call([object]$M, [string]$Pattern) { return [bool]@((Get-Calls $M) -split "`r?`n" | Where-Object { $_ -match $Pattern }).Count }
function Test-CallLiteral([object]$M, [string]$Text) { return (Get-Calls $M).Contains($Text) }
# Run one fleet script from the tree copy; output as text, exit code in $script:rc.
function Invoke-Fleet([string]$Script, [string[]]$ScriptArgs = @()) {
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $lines = @(& $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\$Script") @ScriptArgs 2>&1 | ForEach-Object { "$_" })
  $script:rc = $LASTEXITCODE
  $ErrorActionPreference = $eap
  return ($lines -join "`n")
}

$saved = Save-Env @('PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COOP_DIR', 'PIPX_HOME', 'PIPX_BIN_DIR', 'PI_CODING_AGENT_DIR', 'COOP_AGENT_DIR',
           'COOP_NO_ONBOARD', 'COOP_NO_MODEL_LOGIN', 'MARKER', 'COOP_TEST_STUB_PATH', 'COOP_FABRIC_PYTHON', 'PIPX_FAIL_MATCH', 'COOP_TEST_DRIVER_MISSING',
           'COOP_RELEASE_MANIFEST', 'COOP_SKIP_AZ', 'NO_COLOR',
           'PYTHONPATH', 'PYTHONHOME', 'PIPX_STATE', 'PIPX_STUB_DEFAULT_PYTHON')
$script:priorPath = $env:PATH
try {
  # A plain copy of the tree, no .git (dot entries other than the bundled .coop
  # contract are git, CI and cache files, not runtime).
  $root = Join-Path $t 'coop-agent'
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  foreach ($e in (Get-ChildItem -LiteralPath $checkout -Force | Where-Object { -not $_.Name.StartsWith('.') -or $_.Name -eq '.coop' })) {
    Copy-Item -LiteralPath $e.FullName -Destination (Join-Path $root $e.Name) -Recurse -Force
  }
  $env:COOP_SKIP_AZ = '1'; $env:NO_COLOR = '1'
  $env:COOP_RELEASE_MANIFEST = Join-Path $root 'config\release-manifest.json'
  Remove-Item Env:\COOP_BUNDLED_WHEELS -ErrorAction SilentlyContinue
  # The manifest's sourced tool (a GitHub release wheel, not PyPI): a synthetic
  # wheel named after the manifest's asset, with the copied manifest's SHA-256
  # pointed at its bytes, so every machine's wheel cache already holds it
  # (New-Machine) and the install path never reaches the network. Pin and asset
  # come from the manifest, never from a literal here.
  $script:sourcedWheel = $null
  $manifestJson = [System.IO.File]::ReadAllText($env:COOP_RELEASE_MANIFEST, $utf8) | ConvertFrom-Json
  # Every pin this fixture names comes from the manifest, so a pin bump never
  # leaves a stale literal behind (tests/pins.test.sh fails the bump otherwise).
  $pinDoc = [string]$manifestJson.python_tools.'coop-data-doc'
  $pinCompare = [string]$manifestJson.python_tools.'coop-schema-compare'
  $pinSqlsc = [string]$manifestJson.python_tools.'coop-sql-source-control'
  $pinFab = [string]$manifestJson.python_tools.'ms-fabric-cli'
  $pinCicd = [string]$manifestJson.python_tools.'fabric-cicd'
  $pinPyodbc = [string]$manifestJson.python_tools.'pyodbc'
  $sourced = $manifestJson.python_tool_sources
  if ($sourced) {
    $sourcedName = @($sourced.PSObject.Properties | Select-Object -First 1)[0].Name
    $sourcedEntry = $sourced.$sourcedName
    $sourcedPin = [string]$manifestJson.python_tools.$sourcedName
    $bytes = [System.Text.Encoding]::ASCII.GetBytes("coop fleet fixture wheel: $($sourcedEntry.asset)`n")
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $newHash = ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    $sha.Dispose()
    $manifestText = [System.IO.File]::ReadAllText($env:COOP_RELEASE_MANIFEST, $utf8)
    if (-not $manifestText.Contains([string]$sourcedEntry.sha256)) { throw "the copied manifest does not carry python_tool_sources.$sourcedName.sha256" }
    [System.IO.File]::WriteAllText($env:COOP_RELEASE_MANIFEST, $manifestText.Replace([string]$sourcedEntry.sha256, $newHash), $utf8)
    if ([string]$sourcedEntry.asset -notmatch ('^' + [regex]::Escape(($sourcedName -replace '[-_.]+', '_')) + '-' + [regex]::Escape($sourcedPin) + '-')) {
      throw "the manifest's $sourcedName asset '$($sourcedEntry.asset)' does not carry the python_tools pin $sourcedPin"
    }
    $script:sourcedWheel = [pscustomobject]@{ Package = $sourcedName; Pin = $sourcedPin; Asset = [string]$sourcedEntry.asset; Bytes = $bytes }
  }
  # The Fabric SQL runtime probe runs inside each machine's venv: a fixture pyodbc
  # (5.3.0 metadata; drivers() honours COOP_TEST_DRIVER_MISSING) on PYTHONPATH
  # answers it the same way on every platform.
  $runtimeFixture = Join-Path $t 'runtime-fixture'
  $pyodbcMetadata = Join-Path $runtimeFixture "pyodbc-$pinPyodbc.dist-info"
  New-Item -ItemType Directory -Force -Path $runtimeFixture, $pyodbcMetadata | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $runtimeFixture 'pyodbc.py'), "import os`ndef drivers():`n    if os.environ.get('COOP_TEST_DRIVER_MISSING') == '1':`n        return []`n    return ['ODBC Driver 18 for SQL Server']`n", $utf8)
  [System.IO.File]::WriteAllText((Join-Path $pyodbcMetadata 'METADATA'), "Metadata-Version: 2.1`nName: pyodbc`nVersion: $pinPyodbc`n", $utf8)
  Remove-Item Env:\PYTHONHOME -ErrorAction SilentlyContinue
  $env:PYTHONPATH = if ($saved['PYTHONPATH']) { $runtimeFixture + $sep + $saved['PYTHONPATH'] } else { $runtimeFixture }
  # The doctor child reads the contract of its working directory: run from the
  # temp dir, never from the checkout.
  Push-Location -LiteralPath $t

  # --- 1. install --force on a machine with pipx tools at older versions ----------
  $m = New-Machine 'install' -PipxList @('package coop-data-doc 1.1.0', "package ms-fabric-cli $pinFab")
  $out = Invoke-Fleet 'install.ps1' @('--force')
  if ($out.Contains('8/8') -and -not $out.Contains('install/sync step(s) failed')) { Ok 'install --force runs through step 8/8 with no failed install/sync step' } else { Ko "install --force stopped early or reported a failed step (rc=$rc)" $out }
  if (Test-Call $m 'PIPX install --force --python .+ ms-fabric-cli==1\.7\.0') { Ok 'Fabric CLI install selects a supported bootstrap Python explicitly' } else { Ko 'Fabric CLI install did not select a supported bootstrap Python explicitly' (Get-Calls $m) }
  if (Test-CallLiteral $m "PIPX install --force coop-data-doc==$pinDoc") { Ok 'install --force reinstalls a pipx tool at its exact pin' } else { Ko 'install --force did not reinstall coop-data-doc at its pin' (Get-Calls $m) }
  # Extensions are the sync child's (one `pi install` path, S2; fleet-manifest
  # asserts install.ps1 carries no `pi install` of its own): the child installed them.
  if (Test-CallLiteral $m 'PI install npm:pi-mcp-adapter@5.4.0') { Ok 'the sync child of install installs the manifest extensions' } else { Ko 'the sync child of install did not install the extensions' (Get-Calls $m) }
  if ((Test-CallLiteral $m "PIPX inject ms-fabric-cli fabric-cicd==$pinCicd --force") -and (Test-CallLiteral $m "PIPX inject ms-fabric-cli pyodbc==$pinPyodbc --force")) { Ok 'install injects the exact fabric-cicd and pyodbc runtime pins' } else { Ko 'install did not inject the exact runtime pins' (Get-Calls $m) }

  # Driver auto-provisioning is Windows-only. A supported non-Windows install still
  # converges pyodbc and succeeds with one actionable warning.
  if (-not $isWindowsHost) {
    Reset-Calls $m
    $env:COOP_TEST_DRIVER_MISSING = '1'
    $out = Invoke-Fleet 'install.ps1' @('--force')
    Remove-Item Env:\COOP_TEST_DRIVER_MISSING -ErrorAction SilentlyContinue
    # Install's own warning, once; the doctor child at the end repeats the
    # finding in its own row, so count only up to doctor's banner.
    $installOnly = $out; $doctorAt = $out.IndexOf('coop doctor '); if ($doctorAt -ge 0) { $installOnly = $out.Substring(0, $doctorAt) }
    $warns = ([regex]::Matches($installOnly, [regex]::Escape('ODBC Driver 18+ for SQL Server is missing'))).Count
    if ($out.Contains('install/sync step(s) failed')) { Ko 'non-Windows install failed solely because Driver 18 is absent' $out }
    elseif ($warns -ne 1) { Ko "non-Windows install emitted $warns Driver 18 warning(s), expected exactly one" $out }
    elseif (-not (Test-CallLiteral $m "PIPX inject ms-fabric-cli pyodbc==$pinPyodbc --force")) { Ko 'non-Windows missing-driver install did not converge pyodbc' (Get-Calls $m) }
    else { Ok 'non-Windows install succeeds with one warning when Driver 18 is absent' }
  }

  # An injected-library failure is a convergence failure, not a warning-only success.
  $env:PIPX_FAIL_MATCH = "pyodbc==$pinPyodbc"
  $out = Invoke-Fleet 'install.ps1' @('--force')
  if ($rc -ne 0 -and $out.Contains('install/sync step(s) failed')) { Ok 'exact pyodbc pin is injected and injection failure is nonzero with a failed-step summary' } else { Ko "failed pyodbc injection was converted into install success (rc=$rc)" $out }
  # Install, like update, keeps a visible convergence failure in its exit status
  # even though it continues through the remaining units for diagnostics.
  $env:PIPX_FAIL_MATCH = "install --force coop-data-doc==$pinDoc"
  $out = Invoke-Fleet 'install.ps1' @('--force')
  if ($rc -ne 0 -and $out.Contains('install/sync step(s) failed')) { Ok 'install exits non-zero with a failed-step summary when a convergence unit fails' } else { Ko "failed pipx convergence was converted into install success (rc=$rc)" $out }
  Remove-Item Env:\PIPX_FAIL_MATCH -ErrorAction SilentlyContinue

  # --- 2. update on the same machine ---------------------------------------------
  Reset-Calls $m
  $out = Invoke-Fleet 'update.ps1'
  if ($out.Contains('6/6') -and -not $out.Contains('failed convergence step(s)')) { Ok 'normal pinned update runs through step 6/6 with no failed convergence step' } else { Ko "normal pinned update stopped early or reported a failed step (rc=$rc)" $out }
  if ($out.Contains('not a git checkout')) { Ok 'update runs from a copy of the tree, so step 1 never fetches or moves the checkout running the tests' } else { Ko 'update step 1 ran against a git checkout; the fixture must run a copy (#104)' $out }
  # Everything the --force install left is at its pin, so update is an offline
  # no-op for Pi and every pipx tool (the same probe-then-skip install uses).
  if (Test-Call $m '^PIPX (install|upgrade) ') { Ko 'update reinstalled a pipx tool already at its pin' (Get-Calls $m) } else { Ok 'update leaves pipx tools already at their pins alone (offline no-op)' }
  if (Test-Call $m '^NPM install -g @earendil-works/pi-coding-agent') { Ko 'update reinstalled a Pi already at the manifest version' (Get-Calls $m) } else { Ok 'update leaves a Pi already at the manifest version alone (offline no-op)' }
  if ((Test-CallLiteral $m "PIPX inject ms-fabric-cli fabric-cicd==$pinCicd --force") -and (Test-CallLiteral $m "PIPX inject ms-fabric-cli pyodbc==$pinPyodbc --force")) { Ok 'update still converges the exact Fabric runtime pins' } else { Ko 'update did not converge the Fabric runtime pins' (Get-Calls $m) }
  if (Test-CallLiteral $m 'PI update --extensions') { Ko 'update ran the unpinned pi update --extensions' (Get-Calls $m) } else { Ok 'update never runs the unpinned pi update --extensions' }
  # The tree install's sync child left is at every pin, so update's sync child is
  # an offline no-op too: no `pi install` or `pi update` at all.
  if (Test-Call $m '^PI (install|update) ') { Ko 'update (or its sync child) ran pi install/update on a tree already at its pins' (Get-Calls $m) } else { Ok 'update leaves a tree already at its extension pins alone (no pi install)' }
  # Drift after the install: update converges the tool to its pin, and a visible
  # unit failure makes update non-zero even though execution reaches the
  # aggregate end (the old behaviour silently returned success via Doctor).
  Reset-Calls $m
  Set-PipxList $m @('package coop-data-doc 1.1.0', "package ms-fabric-cli $pinFab")
  $out = Invoke-Fleet 'update.ps1'
  if (-not $out.Contains('failed convergence step(s)') -and (Test-CallLiteral $m "PIPX install --force coop-data-doc==$pinDoc")) { Ok 'update converges a drifted pipx tool to its manifest pin' } else { Ko "update did not converge drifted coop-data-doc (rc=$rc)" ($out + "`n" + (Get-Calls $m)) }
  Set-PipxList $m @('package coop-data-doc 1.1.0', "package ms-fabric-cli $pinFab")
  $env:PIPX_FAIL_MATCH = "coop-data-doc==$pinDoc"
  $out = Invoke-Fleet 'update.ps1'
  if ($rc -ne 0 -and $out.Contains('update finished with 1 failed convergence step(s)')) { Ok 'update exits non-zero with a failed-step summary when a convergence unit fails' } else { Ko "failed pipx convergence was converted into update success (rc=$rc)" $out }
  Remove-Item Env:\PIPX_FAIL_MATCH -ErrorAction SilentlyContinue

  # --- 3. sync installs every manifest extension pin into the isolated tree ------
  # Force the production sync through its install path: repeat syncs intentionally
  # skip already-exact extensions without touching the network.
  Reset-Calls $m
  Remove-Item -LiteralPath (Join-Path $m.Agent 'npm\node_modules') -Recurse -Force -ErrorAction SilentlyContinue
  $out = Invoke-Fleet 'sync.ps1'
  if ($rc -eq 0) { Ok 'production sync exits 0' } else { Ko "production sync failed unexpectedly (rc=$rc)" $out }
  # The Microsoft skills step finds Python as the MCP step does (it once lost its lookup).
  if ($out.Contains('cannot generate MCP config') -or -not $out.Contains('cannot refresh Microsoft skills catalog')) { Ok 'sync looks Python up for the Microsoft skills catalog' } else { Ko 'sync said python missing for the Microsoft skills catalog while the MCP step had Python' $out }
  $missing = @($extSpecs | Where-Object { -not (Test-CallLiteral $m "PI install $_") })
  if ($missing.Count -eq 0) { Ok 'sync installs every manifest extension at its exact pin' } else { Ko "missing sync spec(s): $($missing -join ', ')" (Get-Calls $m) }
  foreach ($ext in @('pi-mcp-adapter', '@juicesharp/rpiv-ask-user-question')) {
    if (Test-Path -LiteralPath (Join-Path $m.Agent "npm\node_modules\$ext\package.json")) { Ok "sync materialized $ext in the isolated tree" } else { Ko "sync did not materialize $ext in the isolated tree" $out }
  }
  # A tree already at every pin needs no `pi install`: the repeat sync is offline.
  Reset-Calls $m
  $out = Invoke-Fleet 'sync.ps1'
  if ($rc -eq 0 -and -not (Test-Call $m '^PI install ')) { Ok 'a repeat sync skips extensions already at their pins (offline no-op)' } else { Ko "repeat sync reinstalled extensions or failed (rc=$rc)" ($out + "`n" + (Get-Calls $m)) }
  # The Fabric runtime convergence argv (normal + edge) through the shared helper.
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $frOut = @(& $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $checkout 'tests\fixtures\fabric-runtime-convergence.test.ps1') 2>&1 | ForEach-Object { "$_" })
  $frRc = $LASTEXITCODE
  $ErrorActionPreference = $eap
  if ($frRc -eq 0) { $frOut | ForEach-Object { Write-Host $_ } } else { Ko 'fabric-runtime-convergence fixture failed' ($frOut -join "`n") }

  # --- 4. NORMAL-mode drift convergence (no --force): round-2 review item #1 -------
  # Deliberate drift: installed Pi 0.81.0 (manifest 1.2.0) and coop-data-doc 1.1.0
  # (manifest 1.3.1); ms-fabric-cli matches its pin.
  $m2 = New-Machine 'drift' -PiVersion '0.81.0' -HonestPi $false -PipxList @('package coop-data-doc 1.1.0', "package ms-fabric-cli $pinFab")
  $out = Invoke-Fleet 'install.ps1'
  if (-not (Test-CallLiteral $m2 'NPM install -g @earendil-works/pi-coding-agent@1.2.0')) { Ko 'drifted Pi NOT converged to manifest' (Get-Calls $m2) }
  else { Ok 'normal install converges a drifted Pi to the manifest without --force' }
  if (-not (Test-CallLiteral $m2 'PIPX install --force coop-data-doc')) { Ko 'drifted coop-data-doc NOT force-installed' (Get-Calls $m2) }
  elseif (-not (Test-CallLiteral $m2 "PIPX install --force coop-data-doc==$pinDoc")) { Ko 'drifted coop-data-doc NOT force-installed to its manifest pin' (Get-Calls $m2) }
  else { Ok 'normal install converges a drifted pipx tool to its manifest pin without --force' }
  if (Test-Call $m2 'PIPX install .*ms-fabric-cli==') { Ko 'matching fabric-cli was reinstalled despite matching pin' (Get-Calls $m2) }
  else { Ok 'normal install leaves a pipx tool that already matches its pin alone' }

  # --- 5. --edge on an EXISTING machine attempts upstream latest -------------------
  $m4 = New-Machine 'edge' -HonestPi $false -PipxList @("package coop-data-doc $pinDoc", "package coop-schema-compare $pinCompare", "package coop-sql-source-control $pinSqlsc", "package ms-fabric-cli $pinFab")
  $out = Invoke-Fleet 'install.ps1' @('--edge')
  if (-not (Test-CallLiteral $m4 'NPM install -g @earendil-works/pi-coding-agent')) { Ko 'edge install did not attempt a Pi upstream update' (Get-Calls $m4) }
  else { Ok 'install --edge attempts a Pi upstream update' }
  if (-not (Test-CallLiteral $m4 'PIPX upgrade coop-data-doc')) { Ko 'edge install did not attempt a pipx upgrade for an existing tool' (Get-Calls $m4) }
  else { Ok 'install --edge attempts a pipx upgrade for an existing tool' }
  # --edge is a Pi and tools channel: the extensions stay pinned (sync has no
  # --edge), so every `pi install` the sync child issues is an exact npm:name@pin.
  if (Test-Call $m4 '^PI install (?!npm:\S+@\d)') { Ko 'edge install installed an unpinned extension (extensions stay pinned, sync has no --edge)' (Get-Calls $m4) }
  elseif (-not (Test-Call $m4 'PIPX install --force --python .+ ms-fabric-cli$')) { Ko 'edge install did not reinstall the Fabric CLI unpinned' (Get-Calls $m4) }
  elseif (-not (Test-CallLiteral $m4 'PIPX inject ms-fabric-cli fabric-cicd --force')) { Ko 'edge install did not refresh unpinned fabric-cicd' ($out + "`n" + (Get-Calls $m4)) }
  elseif (Test-CallLiteral $m4 "PIPX inject ms-fabric-cli fabric-cicd==$pinCicd --force") { Ko 'edge install incorrectly pinned fabric-cicd' (Get-Calls $m4) }
  elseif (-not (Test-CallLiteral $m4 "PIPX inject ms-fabric-cli pyodbc==$pinPyodbc --force")) { Ko 'edge install did not preserve the exact pyodbc runtime contract' (Get-Calls $m4) }
  else { Ok 'install --edge takes upstream latest for the Fabric CLI and fabric-cicd, keeps the extensions pinned' }

  # --- 6. Fabric failed convergence must NOT read as success -------------------------
  # pipx refuses the --force install of ms-fabric-cli==pin while an OLD fab binary
  # stays on PATH: the unit must fail, not report "ready".
  $m5 = New-Machine 'fabric-fail' -HonestPi $false -PipxList @("package coop-data-doc $pinDoc", "package coop-schema-compare $pinCompare", "package coop-sql-source-control $pinSqlsc", 'package ms-fabric-cli 1.5.0') -FabVersion '1.5.0'
  $env:PIPX_FAIL_MATCH = "ms-fabric-cli==$pinFab"
  $out = Invoke-Fleet 'install.ps1'
  if ($rc -eq 0 -or -not $out.Contains('install/sync step(s) failed')) { Ko "failed Fabric convergence returned install success (rc=$rc)" $out }
  elseif ($out.Contains('Microsoft Fabric CLI ready')) { Ko 'fabric reported ready after FAILED convergence' $out }
  elseif (-not ($out.Contains('failed to converge ms-fabric-cli') -or $out.Contains('remains at'))) { Ko 'unexpected fabric outcome: no converge-failure message' $out }
  else { Ok 'failed Fabric convergence is reported as failure, not ready' }
  Remove-Item Env:\PIPX_FAIL_MATCH -ErrorAction SilentlyContinue

  # --- 7. NORMAL-mode skip when everything already matches --------------------------
  $m3 = New-Machine 'match' -HonestPi $false -PipxList @("package coop-data-doc $pinDoc", "package coop-schema-compare $pinCompare", "package coop-sql-source-control $pinSqlsc", "package ms-fabric-cli $pinFab")
  $out = Invoke-Fleet 'install.ps1'
  if (Test-Call $m3 '^NPM install -g @earendil-works/pi-coding-agent@') { Ko 'Pi was reinstalled although it matched the manifest' (Get-Calls $m3) }
  elseif (Test-CallLiteral $m3 'PIPX install --force coop-data-doc==') { Ko 'coop-data-doc was reinstalled although it matched the manifest' (Get-Calls $m3) }
  else { Ok 'normal install skips components already at their manifest pins' }

  # --- 8. UPDATE repairs an incomplete workstation instead of only diagnosing it ----
  $m6 = New-Machine 'repair' -HonestPi $false -PipxList @() -LogPi $false
  $out = Invoke-Fleet 'update.ps1'
  $missing = @(@("coop-data-doc==$pinDoc", "ms-fabric-cli==$pinFab") | Where-Object { -not (Test-CallLiteral $m6 $_) })
  if ($missing.Count -eq 0) { Ok 'update installs missing manifest-pinned pipx tools' } else { Ko "update did not install missing $($missing -join ', ')" (Get-Calls $m6) }
  if (Test-Call $m6 '^PIPX install --python .+ ms-fabric-cli==1\.7\.0') { Ok 'update installs a missing Fabric CLI with an explicit supported bootstrap Python' } else { Ko 'update did not select a supported bootstrap Python for the missing Fabric CLI' (Get-Calls $m6) }
  if (Test-Call $m6 '^PIPX install --force ') { Ko 'update force-reinstalled a tool that was simply missing' (Get-Calls $m6) } else { Ok 'a missing tool is installed, not force-reinstalled' }
  # The sourced tool (a release wheel, not a PyPI spec) installs from the local
  # wheel and converges to its pin: the honest stub records the distribution
  # name and version the wheel's file name carries, and the postcondition
  # (installed == pin) holds (#433).
  if ($script:sourcedWheel) {
    $w = $script:sourcedWheel
    $wheelCall = '^PIPX install (--python .+ )?.*' + [regex]::Escape($w.Asset) + '$'
    $listed = [System.IO.File]::ReadAllText($m6.PipxState).Contains("package $($w.Package) $($w.Pin)")
    if (-not (Test-Call $m6 $wheelCall)) { Ko "update did not install $($w.Package) from its local release wheel" (Get-Calls $m6) }
    elseif (-not $listed) { Ko "the wheel install did not record $($w.Package) $($w.Pin) (pipx list: $([System.IO.File]::ReadAllText($m6.PipxState)))" (Get-Calls $m6) }
    elseif ($out.Contains("$($w.Package) remains at")) { Ko "$($w.Package) failed its convergence postcondition after the wheel install" $out }
    else { Ok "update installs the missing $($w.Package) from its local release wheel and the install converges to $($w.Pin)" }
    # Already converged: a repeat update performs no install for it.
    Reset-Calls $m6
    $out = Invoke-Fleet 'update.ps1'
    if (Test-Call $m6 ('^PIPX (install|upgrade) .*' + [regex]::Escape($w.Package))) { Ko "a repeat update reinstalled $($w.Package) already at $($w.Pin)" (Get-Calls $m6) } else { Ok "a repeat update leaves $($w.Package) at its pin alone" }
  }

  # --- 9. UPDATE moves a tool built on another Python onto coop's (#430) ----------
  # coop-data-doc is at its pin, but its environment's pyvenv.cfg names another
  # interpreter (a hand `pipx install` from a shell whose pipx ran on a different
  # Python). Version alone is no longer convergence: the environment is removed
  # and the tool installed again with --python <coop's>, where coop's Python is
  # what pipx reports as PIPX_DEFAULT_PYTHON (the stub answers the real one).
  $m7 = New-Machine 'wrong-python' -HonestPi $false -PipxList @("package coop-data-doc $pinDoc", "package ms-fabric-cli $pinFab") -LogPi $false
  $otherVenv = Join-Path (Join-Path $m7.Dir 'pipx-home') 'venvs\coop-data-doc'
  New-Item -ItemType Directory -Force -Path $otherVenv | Out-Null
  $otherHome = if ($isWindowsHost) { 'C:\Users\someone\AppData\Local\Programs\Python\Python312' } else { '/opt/other-python/bin' }
  [System.IO.File]::WriteAllText((Join-Path $otherVenv 'pyvenv.cfg'), "home = $otherHome`ninclude-system-site-packages = false`nversion = 3.12.4`nexecutable = $otherHome$(if ($isWindowsHost) { '\python.exe' } else { '/python3.12' })`n", $utf8)
  $out = Invoke-Fleet 'update.ps1'
  $calls7 = @((Get-Calls $m7) -split "`r?`n" | Where-Object { $_ -match '^PIPX (uninstall|install) ' })
  $pyPattern = [regex]::Escape($realPy)
  # The pin comes from the manifest: a release that bumps it must not leave an
  # escaped literal behind (the nightly lane was red from 2026-10-24 on 1\.4\.2).
  $dataDocPin = [string]$manifestJson.python_tools.'coop-data-doc'
  if (-not (Test-CallLiteral $m7 'PIPX uninstall coop-data-doc')) { Ko 'update left a coop-data-doc built on another Python in place (no uninstall)' ($out + "`n" + (Get-Calls $m7)) }
  elseif (-not (Test-Call $m7 ('^PIPX install --python ' + $pyPattern + ' coop-data-doc==' + [regex]::Escape($dataDocPin) + '$'))) { Ko "update did not reinstall coop-data-doc on coop's Python with the pin" ($out + "`n" + (Get-Calls $m7)) }
  elseif (@($calls7 | Where-Object { $_ -match 'uninstall coop-data-doc$' }).Count -ne 1 -or ($calls7.IndexOf(@($calls7 | Where-Object { $_ -match 'uninstall coop-data-doc$' })[0]) -gt $calls7.IndexOf(@($calls7 | Where-Object { $_ -match 'install --python .+ coop-data-doc' })[0]))) { Ko 'the environment must go before the reinstall (pipx install --force keeps the old interpreter)' (Get-Calls $m7) }
  elseif (Test-Call $m7 '^PIPX install --force coop-data-doc') { Ko 'a wrong-Python tool was force-reinstalled (that keeps the old interpreter)' (Get-Calls $m7) }
  elseif (-not $out.Contains("coop-data-doc $pinDoc reinstalled on coop's Python $realPy (it was on ")) { Ko 'update did not say the tool moved to coop''s Python' $out }
  elseif ($out.Contains('failed to reinstall coop-data-doc') -or $out.Contains('could not remove coop-data-doc')) { Ko "the wrong-Python reinstall counted as a failure (rc=$rc)" $out }
  else { Ok "update removes a tool built on another Python and installs it again on coop's (#430)" }
  if (Test-Call $m7 '^PIPX (uninstall|install) .*ms-fabric-cli') { Ko 'the Fabric CLI, built on this machine''s own Python, was reinstalled' (Get-Calls $m7) } else { Ok 'a tool whose environment is on coop''s Python is left alone' }
  if (-not (Test-Call $m7 ('^PIPX install --suffix _coopnext --python ' + $pyPattern + ' coop-data-doc==' + [regex]::Escape($dataDocPin) + '$'))) { Ko 'the replacement was not proven under a suffix before the working tool was removed (#441)' (Get-Calls $m7) }
  elseif ($calls7.IndexOf(@($calls7 | Where-Object { $_ -match 'install --suffix' })[0]) -gt $calls7.IndexOf(@($calls7 | Where-Object { $_ -match 'uninstall coop-data-doc$' })[0])) { Ko 'the probe install must come before the uninstall (#441)' (Get-Calls $m7) }
  elseif (-not (Test-CallLiteral $m7 'PIPX uninstall coop-data-doc_coopnext')) { Ko 'the probe environment was left behind' (Get-Calls $m7) }
  elseif (((Get-Content -LiteralPath $m7.PipxState -Raw) -split "`r?`n") -match '_coopnext') { Ko 'the probe environment is still installed' (Get-Content -LiteralPath $m7.PipxState -Raw) }
  else { Ok 'the move is proven under a suffix first and the probe is removed (#441)' }
  # A second update is a no-op: the reinstalled environment is now on coop's Python.
  $venvDir = Join-Path (Join-Path $m7.Dir 'pipx-home') 'venvs\coop-data-doc'
  [System.IO.File]::WriteAllText((Join-Path $venvDir 'pyvenv.cfg'), "home = $(Split-Path -Parent $realPy)`nversion = 3.12.4`nexecutable = $realPy`n", $utf8)
  Reset-Calls $m7
  $out = Invoke-Fleet 'update.ps1'
  if (Test-Call $m7 '^PIPX (uninstall|install) .*coop-data-doc') { Ko 'a tool now on coop''s Python was reinstalled again' (Get-Calls $m7) } else { Ok 'once on coop''s Python the tool is converged (offline no-op)' }

  # --- 10. A move that cannot be completed keeps the working tool (#441) ----------
  # The same wrong-Python tool, but the replacement cannot be installed (the
  # index is unreachable: every install carrying --python fails). The tool must
  # stay installed and usable, the unit must report failure, and nothing may
  # have been uninstalled.
  $m8 = New-Machine 'wrong-python-offline' -HonestPi $false -PipxList @('package coop-data-doc 1.4.3') -LogPi $false
  $otherVenv8 = Join-Path (Join-Path $m8.Dir 'pipx-home') 'venvs\coop-data-doc'
  New-Item -ItemType Directory -Force -Path $otherVenv8 | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $otherVenv8 'pyvenv.cfg'), "home = $otherHome`ninclude-system-site-packages = false`nversion = 3.12.4`nexecutable = $otherHome$(if ($isWindowsHost) { '\python.exe' } else { '/python3.12' })`n", $utf8)
  $env:PIPX_FAIL_MATCH = '--python'
  $out = Invoke-Fleet 'update.ps1'
  Remove-Item Env:\PIPX_FAIL_MATCH -ErrorAction SilentlyContinue
  $state8 = Get-Content -LiteralPath $m8.PipxState -Raw
  if ($state8 -notmatch 'package coop-data-doc 1\.4\.3') { Ko 'a failed interpreter move removed the working coop-data-doc (#441)' ($out + "`n" + (Get-Calls $m8) + "`n" + $state8) }
  elseif (Test-Call $m8 '^PIPX uninstall coop-data-doc$') { Ko 'the working tool was uninstalled before its replacement was proven (#441)' (Get-Calls $m8) }
  elseif (-not $out.Contains("could not prepare coop-data-doc (coop-data-doc==$dataDocPin) on coop's Python")) { Ko 'a failed move did not say the installation stays (#441)' $out }
  elseif ($rc -eq 0) { Ko 'a failed interpreter move counted as a converged update' $out }
  else { Ok 'a move that cannot be completed keeps the working tool and reports the failure (#441)' }
}
finally {
  Pop-Location
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  normal install/update/sync executed exact manifest specs' } else { Write-Host "  $G_CROSS fleet-execution tests FAILED" }
exit $fail

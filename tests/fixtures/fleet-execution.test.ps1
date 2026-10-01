#!/usr/bin/env pwsh
# Execute the normal install/update/sync fleet paths with offline stubs and assert
# the exact specs they converge to (port of tests/fleet-execution.test.sh):
#   - `install --force` installs every manifest extension at its pin, the Fabric
#     CLI with an explicit supported bootstrap Python, and injects the exact
#     fabric-cicd / pyodbc runtime pins; an injection or pipx failure is exit 1
#   - a non-Windows install without ODBC Driver 18 still converges with ONE warning
#   - `update` (fleet mode) never fetches the checkout it runs from, pins Pi and
#     every extension, and is exit 1 when a convergence unit fails
#   - `sync` installs every manifest extension pin into the isolated tree
#   - normal install converges drifted Pi / pipx tools, skips matching ones;
#     `--edge` attempts upstream latest; a failed Fabric convergence is a failure;
#     update installs missing manifest-pinned pipx tools
# The scripts run from a plain COPY of this tree with no .git (#104): step 1 of
# `coop update` fetches and fast-forwards the checkout it runs from, and a test
# must never touch the checkout running it. Every location the fleet scripts can
# write is isolated per block (temp HOME / USERPROFILE / COOP_DIR / PIPX_HOME /
# agent dirs); the real ~/.coop is never read or written.
$ErrorActionPreference = 'Stop'
$checkout = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$psExe = try { (Get-Process -Id $PID).Path } catch { 'pwsh' }
$isWindowsHost = ($env:OS -eq 'Windows_NT')
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-fleet-exec-' + [guid]::NewGuid().ToString('N'))
$G_CHECK = [char]0x2713; $G_CROSS = [char]0x2717
$fail = 0
function Ok([string]$m) { Write-Host "  $G_CHECK $m" }
function Ko([string]$m, [string]$Out = '') { Write-Host "  $G_CROSS $m"; if ($Out) { Write-Host $Out }; $script:fail = 1 }
$sep = [System.IO.Path]::PathSeparator
$utf8 = New-Object System.Text.UTF8Encoding($false)
$chmod = if ($isWindowsHost) { '' } else { (Get-Command chmod -ErrorAction Stop).Source }
# Real tools the stub machine forwards to (captured before PATH is restricted).
$realNode = (Get-Command node -ErrorAction Stop).Source
$realGit = (Get-Command git -ErrorAction Stop).Source
# The stub machine needs a Fabric-compatible (3.10-3.13) Python for the H1 gate;
# prefer a versioned one so a host whose python3 is 3.14 still qualifies. The
# Windows Store App-Execution-Alias stub under WindowsApps is not an interpreter.
$realPy = $null
foreach ($n in @('python3.13', 'python3.12', 'python3', 'python')) {
  $c = Get-Command $n -ErrorAction SilentlyContinue
  if (-not $c -or -not $c.Source -or $c.Source -match '\\WindowsApps\\') { continue }
  $realPy = $c.Source; break
}
if (-not $realPy) { throw 'a Python 3.10-3.13 is required for the fleet fixtures' }
$psDir = Split-Path -Parent $psExe

$extSpecs = @('npm:pi-mcp-adapter@3.3.0', 'npm:pi-hermes-memory@0.9.9', 'npm:pi-better-openai@0.1.22', 'npm:pi-web-access@0.10.7',
              'npm:@juicesharp/rpiv-ask-user-question@2.12.0', 'npm:@xl0/pi-lovely-rename@0.1.5', 'npm:context-mode@1.0.169')

# Every stub is ONE Python script (<name>.stub.py) behind a one-line forwarder:
# a .cmd on Windows, a #!/bin/sh script elsewhere, so each stub behaves
# identically on every platform (the same pattern as doctor/inventory). Stubs
# log their argv to $MARKER as "<TOOL> <args>" (the lines the assertions parse).
function New-PyStub([string]$Dir, [string]$Name, [string]$Source) {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $py = Join-Path $Dir "$Name.stub.py"
  [System.IO.File]::WriteAllText($py, $Source, $utf8)
  if ($isWindowsHost) {
    $p = Join-Path $Dir "$Name.cmd"
    [System.IO.File]::WriteAllText($p, "@`"$realPy`" `"$py`" %*`r`n@exit /b %ERRORLEVEL%`r`n", [System.Text.Encoding]::ASCII)
  } else {
    $p = Join-Path $Dir $Name
    [System.IO.File]::WriteAllText($p, "#!/bin/sh`nexec `"$realPy`" `"$py`" `"`$@`"`n", $utf8)
    & $chmod +x $p
  }
  return $p
}
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
    print('0.87.1'); sys.exit(0)
if args[:1] == ['--version']:
    print('10.9.0'); sys.exit(0)
log('NPM ' + ' '.join(args))
if args[:1] == ['install']:
    for a in args:
        if a.startswith('@earendil-works/pi-ai@') or a.startswith('@earendil-works/pi-tui@'):
            write_pkg('node_modules', a)
sys.exit(0)
'@
# pipx: `pipx list` prints the machine's installed packages; any other call
# whose argv contains $PIPX_FAIL_MATCH fails (exit 1, unlogged) so the
# failure-injection cases can fail a convergence unit; everything else is logged.
function Get-PipxStub([string[]]$PipxList) {
  $listPy = '[' + (($PipxList | ForEach-Object { ConvertTo-PyString $_ }) -join ', ') + ']'
  return $stubPrelude + @"
if args[:1] == ['list']:
    for line in ${listPy}:
        print(line)
    sys.exit(0)
fail = os.environ.get('PIPX_FAIL_MATCH', '')
if fail and fail in ' '.join(args):
    sys.exit(1)
log('PIPX ' + ' '.join(args))
sys.exit(0)
"@
}
# One fully isolated "machine": every location the fleet scripts can touch lives
# under it, plus the stub bin that models the tools present on it.
function New-Machine {
  param([string]$Name, [string]$PiVersion = '0.87.1', [bool]$HonestPi = $true, [string[]]$PipxList = @(), [string]$FabVersion = '1.6.1', [bool]$LogPi = $true)
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
  $env:PI_CODING_AGENT_DIR = $agent; $env:COOP_AGENT_DIR = $agent
  $env:COOP_NO_ONBOARD = '1'
  $env:MARKER = $marker
  $env:COOP_TEST_STUB_PATH = $bin
  Remove-Item Env:\COOP_FABRIC_PYTHON, Env:\PIPX_FAIL_MATCH, Env:\COOP_TEST_DRIVER_MISSING -ErrorAction SilentlyContinue
  $null = New-PyStub $bin 'pi' (Get-PiStub $PiVersion $HonestPi $LogPi)
  $null = New-PyStub $bin 'npm' $npmStub
  $null = New-PyStub $bin 'pipx' (Get-PipxStub $PipxList)
  $null = New-PyStub $bin 'fab' ($stubPrelude + "print('fab version $FabVersion')`nsys.exit(0)`n")
  # Git and Azure CLI are install prerequisites (H1 gate); this machine has them.
  $null = New-PyStub $bin 'az' ($stubPrelude + "print('azure-cli 2.80.0')`nsys.exit(0)`n")
  $null = New-PyStub $bin 'git' ($stubPrelude + 'forward(' + (ConvertTo-PyString $realGit) + ")`n")
  $null = New-PyStub $bin 'node' ($stubPrelude + 'forward(' + (ConvertTo-PyString $realNode) + ")`n")
  $null = New-PyStub $bin 'python3' ($stubPrelude + 'forward(' + (ConvertTo-PyString $realPy) + ")`n")
  # A driver_missing runtime on Windows would reach `winget install
  # Microsoft.msodbcsql.18`; this machine's winget only logs and fails.
  $null = New-PyStub $bin 'winget' ($stubPrelude + "log('WINGET ' + ' '.join(args))`nsys.exit(1)`n")
  # The Fabric CLI's pipx environment is a REAL (pip-less) venv of the real
  # interpreter, so Get-CoopVenvPythonPath finds Scripts\python.exe on Windows
  # and bin/python elsewhere; the fixture pyodbc on PYTHONPATH (set once below)
  # answers its runtime probe.
  $venv = Join-Path $pipxHome 'venvs\ms-fabric-cli'
  & $realPy -m venv --without-pip $venv *> $null
  if ($LASTEXITCODE -ne 0 -or -not ((Test-Path -LiteralPath (Join-Path $venv 'Scripts\python.exe')) -or (Test-Path -LiteralPath (Join-Path $venv 'bin/python')))) {
    throw "could not create the Fabric venv fixture under $venv with $realPy"
  }
  if ($isWindowsHost) {
    $env:PATH = $bin + $sep + $script:priorPath
  } else {
    # The stub bin first, then the system dirs the scripts need (sh, uname). The
    # stub bin is repeated at the END because install.ps1's PATH helpers prepend
    # with ';' (Windows separators): on a POSIX host that fuses the first entries
    # into one unusable segment, and the trailing copy keeps the stubs resolvable.
    $env:PATH = $bin + ':' + $psDir + ':/usr/bin:/bin:' + $bin
  }
  return [pscustomobject]@{ Dir = $d; Bin = $bin; Agent = $agent; Marker = $marker; Home = $mHome }
}
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

$saved = @{}
$names = @('PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COOP_DIR', 'PIPX_HOME', 'PIPX_BIN_DIR', 'PI_CODING_AGENT_DIR', 'COOP_AGENT_DIR',
           'COOP_NO_ONBOARD', 'MARKER', 'COOP_TEST_STUB_PATH', 'COOP_FABRIC_PYTHON', 'PIPX_FAIL_MATCH', 'COOP_TEST_DRIVER_MISSING',
           'COOP_FLEET_TEST_MODE', 'COOP_PI_LATEST_OVERRIDE', 'COOP_PYPI_LATEST_OVERRIDE', 'COOP_RELEASE_MANIFEST', 'COOP_SKIP_AZ', 'NO_COLOR',
           'PYTHONPATH', 'PYTHONHOME')
foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
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
  $env:COOP_PI_LATEST_OVERRIDE = '0.87.1'; $env:COOP_PYPI_LATEST_OVERRIDE = '0.1.0'
  # The Fabric SQL runtime probe runs inside each machine's venv: a fixture pyodbc
  # (5.3.0 metadata; drivers() honours COOP_TEST_DRIVER_MISSING) on PYTHONPATH
  # answers it the same way on every platform.
  $runtimeFixture = Join-Path $t 'runtime-fixture'
  $pyodbcMetadata = Join-Path $runtimeFixture 'pyodbc-5.3.0.dist-info'
  New-Item -ItemType Directory -Force -Path $runtimeFixture, $pyodbcMetadata | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $runtimeFixture 'pyodbc.py'), "import os`ndef drivers():`n    if os.environ.get('COOP_TEST_DRIVER_MISSING') == '1':`n        return []`n    return ['ODBC Driver 18 for SQL Server']`n", $utf8)
  [System.IO.File]::WriteAllText((Join-Path $pyodbcMetadata 'METADATA'), "Metadata-Version: 2.1`nName: pyodbc`nVersion: 5.3.0`n", $utf8)
  Remove-Item Env:\PYTHONHOME -ErrorAction SilentlyContinue
  $env:PYTHONPATH = if ($saved['PYTHONPATH']) { $runtimeFixture + $sep + $saved['PYTHONPATH'] } else { $runtimeFixture }

  # --- 1. install --force on a machine with pipx tools at older versions ----------
  $m = New-Machine 'install' -PipxList @('package coop-data-doc 1.1.0', 'package coop-sql-review 0.15.2', 'package coop-dax-review 0.22.0', 'package ms-fabric-cli 1.7.0')
  $env:COOP_FLEET_TEST_MODE = '1'
  $out = Invoke-Fleet 'install.ps1' @('--force')
  if ($rc -eq 0) { Ok 'install --force (fleet mode) exits 0' } else { Ko "install --force exited $rc" $out }
  if (Test-Call $m 'PIPX install --force --python .+ ms-fabric-cli==1\.7\.0') { Ok 'Fabric CLI install selects a supported bootstrap Python explicitly' } else { Ko 'Fabric CLI install did not select a supported bootstrap Python explicitly' (Get-Calls $m) }
  $missing = @($extSpecs | Where-Object { -not (Test-CallLiteral $m "PI install $_") })
  if ($missing.Count -eq 0) { Ok 'install --force installs every manifest extension at its exact pin' } else { Ko "missing install spec(s): $($missing -join ', ')" (Get-Calls $m) }
  if ((Test-CallLiteral $m 'PIPX inject ms-fabric-cli fabric-cicd==1.3.0 --force') -and (Test-CallLiteral $m 'PIPX inject ms-fabric-cli pyodbc==5.3.0 --force')) { Ok 'install injects the exact fabric-cicd and pyodbc runtime pins' } else { Ko 'install did not inject the exact runtime pins' (Get-Calls $m) }

  # Driver auto-provisioning is Windows-only. A supported non-Windows install still
  # converges pyodbc and succeeds with one actionable warning.
  if (-not $isWindowsHost) {
    Reset-Calls $m
    $env:COOP_TEST_DRIVER_MISSING = '1'
    $out = Invoke-Fleet 'install.ps1' @('--force')
    Remove-Item Env:\COOP_TEST_DRIVER_MISSING -ErrorAction SilentlyContinue
    $warns = ([regex]::Matches($out, [regex]::Escape('ODBC Driver 18+ for SQL Server is missing'))).Count
    if ($rc -ne 0) { Ko 'non-Windows install failed solely because Driver 18 is absent' $out }
    elseif ($warns -ne 1) { Ko "non-Windows install emitted $warns Driver 18 warning(s), expected exactly one" $out }
    elseif (-not (Test-CallLiteral $m 'PIPX inject ms-fabric-cli pyodbc==5.3.0 --force')) { Ko 'non-Windows missing-driver install did not converge pyodbc' (Get-Calls $m) }
    else { Ok 'non-Windows install succeeds with one warning when Driver 18 is absent' }
  }

  # An injected-library failure is a convergence failure, not a warning-only success.
  $env:PIPX_FAIL_MATCH = 'pyodbc==5.3.0'
  $out = Invoke-Fleet 'install.ps1' @('--force')
  if ($rc -ne 0) { Ok 'exact pyodbc pin is injected and injection failure is nonzero' } else { Ko 'failed pyodbc injection was converted into install success' $out }
  # Install, like update, keeps a visible convergence failure in its exit status
  # even though it continues through the remaining units for diagnostics.
  # (the match is the unit's argv prefix; the pinned spec follows it)
  $env:PIPX_FAIL_MATCH = 'install --force coop-data-doc'
  $out = Invoke-Fleet 'install.ps1' @('--force')
  if ($rc -ne 0) { Ok 'install exits non-zero when a convergence unit fails' } else { Ko 'failed pipx convergence was converted into install success' $out }
  Remove-Item Env:\PIPX_FAIL_MATCH -ErrorAction SilentlyContinue

  # --- 2. update (fleet mode) on the same machine ---------------------------------
  Reset-Calls $m
  $out = Invoke-Fleet 'update.ps1'
  if ($rc -eq 0) { Ok 'normal pinned update exits 0' } else { Ko "normal pinned update failed unexpectedly (rc=$rc)" $out }
  if ($out.Contains('not a git checkout')) { Ok 'update runs from a copy of the tree, so step 1 never fetches or moves the checkout running the tests' } else { Ko 'update step 1 ran against a git checkout; the fixture must run a copy (#104)' $out }
  if (Test-Call $m 'PIPX install --force --python .+ ms-fabric-cli==1\.7\.0') { Ok 'Fabric CLI update selects a supported bootstrap Python explicitly' } else { Ko 'Fabric CLI update did not select a supported bootstrap Python explicitly' (Get-Calls $m) }
  $missing = @($extSpecs | Where-Object { -not (Test-CallLiteral $m "PI install $_") })
  if ($missing.Count -eq 0) { Ok 'update pins every manifest extension at its exact spec' } else { Ko "missing update spec(s): $($missing -join ', ')" (Get-Calls $m) }
  if (Test-CallLiteral $m 'PI update --extensions') { Ko 'update ran the unpinned pi update --extensions' (Get-Calls $m) } else { Ok 'update never runs the unpinned pi update --extensions' }
  if (Test-CallLiteral $m 'NPM install -g @earendil-works/pi-coding-agent@0.87.1') { Ok 'update pins Pi to the manifest version' } else { Ko 'update did not pin Pi to the manifest version' (Get-Calls $m) }
  # A visible unit failure makes update non-zero even though execution reaches the
  # aggregate end (the old behaviour silently returned success via Doctor).
  $env:PIPX_FAIL_MATCH = 'coop-data-doc==1.2.0'
  $out = Invoke-Fleet 'update.ps1'
  if ($rc -ne 0) { Ok 'update exits non-zero when a convergence unit fails' } else { Ko 'failed pipx convergence was converted into update success' $out }
  Remove-Item Env:\PIPX_FAIL_MATCH -ErrorAction SilentlyContinue
  Remove-Item Env:\COOP_FLEET_TEST_MODE -ErrorAction SilentlyContinue

  # --- 3. sync installs every manifest extension pin into the isolated tree ------
  # Force the production sync through its install path: repeat syncs intentionally
  # skip already-exact extensions without touching the network.
  Reset-Calls $m
  Remove-Item -LiteralPath (Join-Path $m.Agent 'npm\node_modules') -Recurse -Force -ErrorAction SilentlyContinue
  $out = Invoke-Fleet 'sync.ps1'
  if ($rc -eq 0) { Ok 'production sync exits 0' } else { Ko "production sync failed unexpectedly (rc=$rc)" $out }
  $missing = @($extSpecs | Where-Object { -not (Test-CallLiteral $m "PI install $_") })
  if ($missing.Count -eq 0) { Ok 'sync installs every manifest extension at its exact pin' } else { Ko "missing sync spec(s): $($missing -join ', ')" (Get-Calls $m) }
  foreach ($ext in @('pi-mcp-adapter', '@juicesharp/rpiv-ask-user-question')) {
    if (Test-Path -LiteralPath (Join-Path $m.Agent "npm\node_modules\$ext\package.json")) { Ok "sync materialized $ext in the isolated tree" } else { Ko "sync did not materialize $ext in the isolated tree" $out }
  }
  # The Fabric runtime convergence argv (normal + edge) through the shared helper.
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $frOut = @(& $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $checkout 'tests\fixtures\fabric-runtime-convergence.test.ps1') 2>&1 | ForEach-Object { "$_" })
  $frRc = $LASTEXITCODE
  $ErrorActionPreference = $eap
  if ($frRc -eq 0) { $frOut | ForEach-Object { Write-Host $_ } } else { Ko 'fabric-runtime-convergence fixture failed' ($frOut -join "`n") }

  # --- 4. NORMAL-mode drift convergence (no --force): round-2 review item #1 -------
  # Deliberate drift: installed Pi 0.81.0 (manifest 0.87.1) and coop-data-doc 1.1.0
  # (manifest 1.2.0); ms-fabric-cli matches its pin.
  $m2 = New-Machine 'drift' -PiVersion '0.81.0' -HonestPi $false -PipxList @('package coop-data-doc 1.1.0', 'package coop-sql-review 0.15.2', 'package coop-dax-review 0.22.0', 'package ms-fabric-cli 1.7.0')
  $env:COOP_FLEET_TEST_MODE = '1'
  $out = Invoke-Fleet 'install.ps1'
  if (-not (Test-CallLiteral $m2 'NPM install -g @earendil-works/pi-coding-agent@0.87.1')) { Ko 'drifted Pi NOT converged to manifest' (Get-Calls $m2) }
  else { Ok 'normal install converges a drifted Pi to the manifest without --force' }
  if (-not (Test-CallLiteral $m2 'PIPX install --force coop-data-doc')) { Ko 'drifted coop-data-doc NOT force-installed' (Get-Calls $m2) }
  elseif (-not (Test-CallLiteral $m2 'PIPX install --force coop-data-doc==1.2.0')) { Ko 'drifted coop-data-doc NOT force-installed to its manifest pin' (Get-Calls $m2) }
  else { Ok 'normal install converges a drifted pipx tool to its manifest pin without --force' }
  if (Test-Call $m2 'PIPX install .*ms-fabric-cli==') { Ko 'matching fabric-cli was reinstalled despite matching pin' (Get-Calls $m2) }
  else { Ok 'normal install leaves a pipx tool that already matches its pin alone' }

  # --- 5. --edge on an EXISTING machine attempts upstream latest -------------------
  $m4 = New-Machine 'edge' -HonestPi $false -PipxList @('package coop-data-doc 1.2.0', 'package ms-fabric-cli 1.7.0')
  $out = Invoke-Fleet 'install.ps1' @('--edge')
  if (-not (Test-CallLiteral $m4 'NPM install -g @earendil-works/pi-coding-agent')) { Ko 'edge install did not attempt a Pi upstream update' (Get-Calls $m4) }
  else { Ok 'install --edge attempts a Pi upstream update' }
  if (-not (Test-CallLiteral $m4 'PIPX upgrade coop-data-doc')) { Ko 'edge install did not attempt a pipx upgrade for an existing tool' (Get-Calls $m4) }
  else { Ok 'install --edge attempts a pipx upgrade for an existing tool' }
  if (Test-Call $m4 'PI install npm:[^ ]+@') { Ko 'edge install pinned an extension' (Get-Calls $m4) }
  elseif (-not (Test-CallLiteral $m4 'PI install npm:pi-mcp-adapter')) { Ko 'edge install did not install the extensions unpinned' (Get-Calls $m4) }
  elseif (-not (Test-Call $m4 'PIPX install --force --python .+ ms-fabric-cli$')) { Ko 'edge install did not reinstall the Fabric CLI unpinned' (Get-Calls $m4) }
  elseif (-not (Test-CallLiteral $m4 'PIPX inject ms-fabric-cli fabric-cicd --force')) { Ko 'edge install did not refresh unpinned fabric-cicd' (Get-Calls $m4) }
  elseif (Test-CallLiteral $m4 'PIPX inject ms-fabric-cli fabric-cicd==1.3.0 --force') { Ko 'edge install incorrectly pinned fabric-cicd' (Get-Calls $m4) }
  elseif (-not (Test-CallLiteral $m4 'PIPX inject ms-fabric-cli pyodbc==5.3.0 --force')) { Ko 'edge install did not preserve the exact pyodbc runtime contract' (Get-Calls $m4) }
  else { Ok 'install --edge takes upstream latest for extensions, the Fabric CLI and fabric-cicd' }

  # --- 6. Fabric failed convergence must NOT read as success -------------------------
  # pipx refuses the --force install of ms-fabric-cli==pin while an OLD fab binary
  # stays on PATH: the unit must fail, not report "ready".
  $m5 = New-Machine 'fabric-fail' -HonestPi $false -PipxList @('package coop-data-doc 1.2.0', 'package ms-fabric-cli 1.5.0') -FabVersion '1.5.0'
  $env:PIPX_FAIL_MATCH = 'ms-fabric-cli==1.7.0'
  $out = Invoke-Fleet 'install.ps1'
  if ($rc -eq 0) { Ko 'failed Fabric convergence returned install success' $out }
  elseif ($out.Contains('Microsoft Fabric CLI ready')) { Ko 'fabric reported ready after FAILED convergence' $out }
  elseif (-not ($out.Contains('failed to converge ms-fabric-cli') -or $out.Contains('remains at'))) { Ko 'unexpected fabric outcome: no converge-failure message' $out }
  else { Ok 'failed Fabric convergence is reported as failure, not ready' }
  Remove-Item Env:\PIPX_FAIL_MATCH -ErrorAction SilentlyContinue

  # --- 7. NORMAL-mode skip when everything already matches --------------------------
  $m3 = New-Machine 'match' -HonestPi $false -PipxList @('package coop-data-doc 1.2.0', 'package ms-fabric-cli 1.7.0')
  $out = Invoke-Fleet 'install.ps1'
  if (Test-Call $m3 '^NPM install -g @earendil-works/pi-coding-agent@') { Ko 'Pi was reinstalled although it matched the manifest' (Get-Calls $m3) }
  elseif (Test-CallLiteral $m3 'PIPX install --force coop-data-doc==') { Ko 'coop-data-doc was reinstalled although it matched the manifest' (Get-Calls $m3) }
  else { Ok 'normal install skips components already at their manifest pins' }

  # --- 8. UPDATE repairs an incomplete workstation instead of only diagnosing it ----
  $m6 = New-Machine 'repair' -HonestPi $false -PipxList @() -LogPi $false
  $out = Invoke-Fleet 'update.ps1'
  $missing = @(@('coop-data-doc==1.2.0', 'coop-sql-review==0.15.2', 'coop-dax-review==0.22.0', 'ms-fabric-cli==1.7.0') | Where-Object { -not (Test-CallLiteral $m6 $_) })
  if ($missing.Count -eq 0) { Ok 'update installs missing manifest-pinned pipx tools' } else { Ko "update did not install missing $($missing -join ', ')" (Get-Calls $m6) }
}
finally {
  foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  normal install/update/sync executed exact manifest specs' } else { Write-Host "  $G_CROSS fleet-execution tests FAILED" }
exit $fail

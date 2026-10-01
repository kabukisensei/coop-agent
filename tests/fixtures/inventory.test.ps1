#!/usr/bin/env pwsh
# Port of tests/inventory.test.sh (master plan S1): truthful inventory for
# scripts/doctor.ps1 and scripts/sync.ps1 against FIXTURES in a temp dir:
#   - a fixture release manifest (COOP_RELEASE_MANIFEST)
#   - a fake pipx (COOP_PIPX_BIN; `runpip <venv> show <dist>` reads <fixture>/<venv>--<dist>.meta)
#   - fake venv trees (COOP_PIPX_HOME), with fake venv pythons on macOS/Linux
#   - fake CLI executables: a genuine-looking `fab` INSIDE the fake venv, a
#     Paramiko-flavored `fab` outside it, a `coop-data-doc` inside its venv.
# Doctor rows F1-F7b (F4/F4c-F4f live in tests/fixtures/doctor-pipx-shadow.test.ps1
# and are not repeated here), `coop doctor --fix` convergence (F2b), and the sync
# postconditions S1-S5 (fake `pi`, sabotaged npm, stubbed lib/_extdeps.py). The
# workstation's real pipx/venvs/executables are never probed; nothing leaves the
# temp dir; no network: every npm the sync cases can reach is a stub that cannot
# install, and S3's tree already carries the shipped lock and shared libraries.
# The fake venv python is a sh script, so the rows that need it (F1's Fabric SQL
# rows, F2b, F6, F7, F7b) are skipped on native Windows, like
# tests/fixtures/fabric-python-finder.test.ps1's stub interpreters.
# Sandboxed HOME/USERPROFILE/COOP_DIR/agent dir, never ~/.coop; COOP_SKIP_AZ=1.
# Assertions stay ASCII: Windows PowerShell 5.1 re-encodes child output.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$psExe = try { (Get-Process -Id $PID).Path } catch { 'pwsh' }
$isWindowsHost = ($env:OS -eq 'Windows_NT')
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-inventory-ps-' + [guid]::NewGuid().ToString('N'))
$fail = 0
function Ok([string]$m) { Write-Host "  ok $m" }
function Ko([string]$m, [string]$out = '') { Write-Host "  x $m"; if ($out) { Write-Host $out }; $script:fail = 1 }
function Skipped([string]$m) { Write-Host "  - skipped on native Windows: $m (needs a fake venv python; covered on macOS/Linux)" }

$PinFab = '1.7.0'; $PinDdd = '1.2.0'
$sandboxHome = Join-Path $t 'home'
$agent = Join-Path $t 'agent'
$cwd = Join-Path $t 'cwd'
$fakeBin = Join-Path $t 'fakebin'
$fixtures = Join-Path $t 'fixtures'
$pipxHome = Join-Path $t 'pipxhome'
$venvsDir = Join-Path $pipxHome 'venvs'
$fabVenvBin = Join-Path $venvsDir 'ms-fabric-cli\bin'
$dddVenvBin = Join-Path $venvsDir 'coop-data-doc\bin'
$calls = Join-Path $t 'pipx.calls'
$doctor = Join-Path $root 'scripts\doctor.ps1'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$sep = [System.IO.Path]::PathSeparator

$saved = @{}
$names = @('PATH','HOME','USERPROFILE','COOP_DIR','COOP_AGENT_DIR','PI_CODING_AGENT_DIR','COOP_NO_ISOLATE','COOP_SKIP_AZ','NO_COLOR',
           'COOP_STANDARDS_ROOT','COOP_STANDARDS_STATE','COOP_STANDARDS_SNAPSHOT_ROOT','COOP_PIPX_BIN','COOP_PIPX_HOME','PIPX_HOME',
           'COOP_RELEASE_MANIFEST','COOP_TEST_PIPX_FIXTURE','COOP_TEST_CALLS','COOP_TEST_PIPX_FAIL','COOP_TEST_FIX_INSTALL',
           'COOP_FABRIC_PYTHON','COOP_SKIP_FABRIC_SYNC','COOP_TEST_FAKE_PI_OK','COOP_TEST_FAKE_PI_WRONG','COOP_TEST_FAKE_PI_SKIP',
           'COOP_TEST_FAKE_PI_INSTALL_VERSION','COOP_FAKE_EXTDEPS_RC','COOP_FAKE_LOCAL_VENVS')
foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
# The machine PATH minus any folder that already resolves fab or coop-data-doc
# (a workstation with the real pipx launchers installed), so only the
# fixture's copies answer.
$sep0 = [System.IO.Path]::PathSeparator
$basePath = (@($env:PATH -split [regex]::Escape($sep0) | Where-Object {
  $_ -and -not (@(Get-ChildItem -LiteralPath $_ -Include 'fab*', 'coop-data-doc*' -File -ErrorAction SilentlyContinue).Count)
}) -join $sep0)
$savedLocation = Get-Location
try {
  New-Item -ItemType Directory -Force -Path $sandboxHome, (Join-Path $t 'coop\.coop'), $agent, $cwd, $fakeBin, $fixtures, $fabVenvBin, $dddVenvBin | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $agent '.coop-fetch-stamp'), '')
  $manifest = Join-Path $t 'manifest.json'
  [System.IO.File]::WriteAllText($manifest, ('{"schema_version":1,"python_tools":{"coop-data-doc":"' + $PinDdd + '","coop-sql-review":"0.15.2","coop-dax-review":"0.22.0","ms-fabric-cli":"' + $PinFab + '","fabric-cicd":"1.3.0","pyodbc":"5.3.0"}}'), $utf8)

  $env:HOME = $sandboxHome
  $env:USERPROFILE = $sandboxHome
  $env:COOP_DIR = Join-Path $t 'coop'
  $env:COOP_AGENT_DIR = $agent
  $env:COOP_SKIP_AZ = '1'
  $env:NO_COLOR = '1'
  $env:COOP_RELEASE_MANIFEST = $manifest
  $env:COOP_PIPX_HOME = $pipxHome
  $env:COOP_TEST_PIPX_FIXTURE = $fixtures
  foreach ($n in @('PI_CODING_AGENT_DIR','COOP_NO_ISOLATE','COOP_STANDARDS_ROOT','COOP_STANDARDS_STATE','COOP_STANDARDS_SNAPSHOT_ROOT','PIPX_HOME',
                   'COOP_TEST_CALLS','COOP_TEST_PIPX_FAIL','COOP_TEST_FIX_INSTALL','COOP_FABRIC_PYTHON','COOP_TEST_FAKE_PI_OK',
                   'COOP_TEST_FAKE_PI_WRONG','COOP_TEST_FAKE_PI_SKIP','COOP_TEST_FAKE_PI_INSTALL_VERSION','COOP_FAKE_EXTDEPS_RC','COOP_FAKE_LOCAL_VENVS')) {
    Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue
  }
  Set-Location -LiteralPath $cwd
  . (Join-Path $root 'lib\common.ps1')
  $realPy = Get-CoopPython
  if (-not $realPy) { throw 'a real python is required for this fixture' }

  # A command backed by a Python script: <Name>.cmd on Windows, a sh launcher elsewhere.
  function New-PyStub([string]$Dir, [string]$Name, [string]$Source) {
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    $py = Join-Path $Dir "$Name.stub.py"
    [System.IO.File]::WriteAllText($py, $Source, $utf8)
    if ($isWindowsHost) {
      $p = Join-Path $Dir "$Name.cmd"
      [System.IO.File]::WriteAllText($p, "@`"$realPy`" `"$py`" %*`r`n", [System.Text.Encoding]::ASCII)
    } else {
      $p = Join-Path $Dir $Name
      [System.IO.File]::WriteAllText($p, "#!/bin/sh`nexec `"$realPy`" `"$py`" `"`$@`"`n", $utf8)
      & chmod +x $p
    }
    return $p
  }
  # A command that answers `--version` with one line and fails on anything else.
  function New-VersionStub([string]$Dir, [string]$Name, [string]$Line) {
    New-PyStub $Dir $Name ("import sys`nif sys.argv[1:2] == ['--version']:`n    print(" + "'" + $Line.Replace("'", "\'") + "'" + ")`n    sys.exit(0)`nsys.exit(1)`n")
  }
  function Remove-Stub([string]$Dir, [string]$Name) {
    foreach ($f in @($Name, "$Name.cmd", "$Name.stub.py")) { Remove-Item -LiteralPath (Join-Path $Dir $f) -Force -ErrorAction SilentlyContinue }
  }
  function Set-Meta([string]$Venv, [string]$Dist, [string]$Version) {
    $f = Join-Path $fixtures "$Venv--$Dist.meta"
    if ($Version) { [System.IO.File]::WriteAllText($f, "Name: $Dist`nVersion: $Version`n", $utf8) }
    else { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
  }
  # Fake venv python (macOS/Linux): answers the interpreter probes coop makes:
  # platform.python_version(), sys.version_info, sys.executable, the stdin
  # Requires-Python probe (marker: coop-requires-python-probe) and the stdin
  # pyodbc runtime probe (FAKEPY_SQL_STATE: ready | driver_missing | pyodbc_missing).
  function Set-VenvPython([string]$Venv, [string]$Version, [string]$RequiresPython = '', [string]$SqlState = 'ready') {
    if ($isWindowsHost) { return }
    $dir = Join-Path $venvsDir "$Venv\bin"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $p = Join-Path $dir 'python'
    [System.IO.File]::WriteAllText($p, (@(
      '#!/bin/sh',
      "FAKEPY_VERSION='$Version'",
      "FAKEPY_RP='$RequiresPython'",
      "FAKEPY_SQL_STATE='$SqlState'",
      'if [ "${1:-}" = "-" ]; then',
      '  prog="$(cat)"',
      '  case "$prog" in',
      '    *coop-requires-python-probe*) printf ''%s\n'' "$FAKEPY_RP"; exit 0 ;;',
      '    *pyodbc.drivers*)',
      '      case "$FAKEPY_SQL_STATE" in',
      '        ready) printf ''ready\t5.3.0\t18\n''; exit 0 ;;',
      '        driver_missing) printf ''driver_missing\t5.3.0\n''; exit 5 ;;',
      '        pyodbc_missing) printf ''pyodbc_missing\n''; exit 2 ;;',
      '      esac ;;',
      '  esac',
      '  exit 1',
      'fi',
      'case "${2:-}" in',
      '  *sys.executable*) exit 0 ;;',
      '  *sys.version_info*) printf ''%s\n'' "${FAKEPY_VERSION%.*}"; exit 0 ;;',
      'esac',
      'printf ''%s\n'' "$FAKEPY_VERSION"'
    ) -join "`n") + "`n", $utf8)
    & chmod +x $p
  }
  function Remove-VenvPython([string]$Venv) { Remove-Item -LiteralPath (Join-Path $venvsDir "$Venv\bin\python") -Force -ErrorAction SilentlyContinue }

  # Fake pipx: runpip show reads the fixture .meta files; inject succeeds; with
  # COOP_TEST_FIX_INSTALL=1 an `install ... ms-fabric-cli==` creates the venv's
  # fab and metadata; any argv containing COOP_TEST_PIPX_FAIL fails; every call
  # is logged to COOP_TEST_CALLS as "PIPX <argv>".
  $pipx = New-PyStub $fakeBin 'pipx' @'
import os, sys
args = sys.argv[1:]
joined = ' '.join(args)
calls = os.environ.get('COOP_TEST_CALLS')
if calls:
    with open(calls, 'a') as f:
        f.write('PIPX ' + joined + '\n')
fail = os.environ.get('COOP_TEST_PIPX_FAIL')
if fail and fail in joined:
    sys.exit(1)
fix = os.environ.get('COOP_TEST_PIPX_FIXTURE', '')
if args[:1] == ['inject']:
    sys.exit(0)
if args[:2] == ['install', '--help']:
    print('usage: pipx install [--fetch-python=missing] ...'); sys.exit(0)
if args[:1] == ['install'] and os.environ.get('COOP_TEST_FIX_INSTALL', '0') == '1':
    spec = [a for a in args[1:] if a.startswith('ms-fabric-cli==')]
    if spec:
        home = os.environ['COOP_PIPX_HOME']
        d = os.path.join(home, 'venvs', 'ms-fabric-cli', 'bin')
        os.makedirs(d, exist_ok=True)
        fab = os.path.join(d, 'fab')
        with open(fab, 'w') as f:
            f.write('#!/bin/sh\n[ "$1" = "--version" ] && { echo "fab version 1.7.0"; exit 0; }\nexit 1\n')
        os.chmod(fab, 0o755)
        with open(os.path.join(fix, 'ms-fabric-cli--ms-fabric-cli.meta'), 'w') as f:
            f.write('Name: ms-fabric-cli\nVersion: 1.7.0\n')
    sys.exit(0)
if args[:1] == ['runpip'] and len(args) >= 4 and args[2] == 'show':
    f = os.path.join(fix, args[1] + '--' + args[3] + '.meta')
    if os.path.isfile(f):
        sys.stdout.write(open(f).read()); sys.exit(0)
    sys.exit(1)
if args[:2] == ['environment', '--value'] and len(args) >= 3:
    if args[2] == 'PIPX_LOCAL_VENVS' and os.environ.get('COOP_FAKE_LOCAL_VENVS'):
        print(os.environ['COOP_FAKE_LOCAL_VENVS']); sys.exit(0)
    sys.exit(1)
sys.exit(1)
'@
  $env:COOP_PIPX_BIN = $pipx

  function Get-DoctorRows([string]$PathPrefix = '', [string[]]$DoctorArgs = @()) {
    $env:PATH = "$PathPrefix$fabVenvBin$sep$dddVenvBin$sep$fakeBin$sep$basePath"
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
      $raw = (& $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $doctor --json @DoctorArgs 2>$null | Out-String)
      $script:LastDoctorRc = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $eap
      $env:PATH = $basePath
    }
    $doc = @($raw -split "`r?`n" | Where-Object { $_.StartsWith('{"checks"') }) | Select-Object -Last 1
    if (-not $doc) { throw "doctor.ps1 --json printed no document: $raw" }
    return @(($doc | ConvertFrom-Json).checks)
  }
  function Find-Rows($Rows, [string]$Needle) { @($Rows | Where-Object { ([string]$_.name).Contains($Needle) -or ([string]$_.hint).Contains($Needle) }) }
  function Show-Rows($Rows, [string]$Needle) {
    (@($Rows | Where-Object { ([string]$_.name).Contains($Needle) } | ForEach-Object { "$($_.status) | $($_.name) | $($_.hint)" }) -join "`n")
  }

  Write-Host '  -> doctor: ms-fabric-cli checked as a distribution whose executable is fab'

  # F1: exact match: metadata, CLI and membership all agree.
  Set-Meta 'ms-fabric-cli' 'ms-fabric-cli' $PinFab
  $null = New-VersionStub $fabVenvBin 'fab' $PinFab
  Set-VenvPython 'ms-fabric-cli' '3.13.1' '<3.14,>=3.10'
  $rows = Get-DoctorRows
  if (@(Find-Rows $rows "ms-fabric-cli $PinFab matches manifest").Count -gt 0) { Ok 'exact match reported against the fab executable' } else { Ko 'exact match not recognized' (Show-Rows $rows 'ms-fabric-cli') }
  if (@(Find-Rows $rows 'ms-fabric-cli not installed').Count -eq 0) { Ok "no false 'not installed' warning when only fab exists" } else { Ko "false 'ms-fabric-cli not installed' warning persists" (Show-Rows $rows 'ms-fabric-cli') }
  if ($isWindowsHost) { Skipped 'Fabric SQL runtime rows' } else {
    if (@(Find-Rows $rows 'Fabric SQL fallback ready (pyodbc 5.3.0, ODBC Driver 18)').Count -gt 0) { Ok 'doctor verifies pyodbc pin and Driver 18 with the selected runtime' } else { Ko 'doctor did not report the selected Fabric SQL runtime ready' (Show-Rows $rows 'Fabric SQL') }
    Set-VenvPython 'ms-fabric-cli' '3.13.1' '<3.14,>=3.10' 'driver_missing'
    $rows = Get-DoctorRows
    if (@(Find-Rows $rows 'Fabric SQL fallback: ODBC Driver 18+ for SQL Server is missing').Count -gt 0) { Ok 'doctor hard-fails a selected runtime with no Driver 18+' } else { Ko 'doctor did not report missing ODBC Driver 18+' (Show-Rows $rows 'Fabric SQL') }
    Set-VenvPython 'ms-fabric-cli' '3.13.1' '<3.14,>=3.10'
  }

  # F2: missing package: no venv metadata and no fab anywhere.
  Remove-Stub $fabVenvBin 'fab'; Set-Meta 'ms-fabric-cli' 'ms-fabric-cli' ''
  $rows = Get-DoctorRows
  if (@(Find-Rows $rows 'ms-fabric-cli not installed').Count -gt 0) { Ok 'missing distribution reported' } else { Ko 'missing ms-fabric-cli not reported' (Show-Rows $rows 'ms-fabric-cli') }

  # F2b: doctor --fix installs the exact CLI spec, then delegates the injected
  # libraries and Driver readiness to the managed convergence helpers.
  if ($isWindowsHost) { Skipped 'doctor --fix Fabric runtime convergence (F2b)' } else {
    [System.IO.File]::WriteAllText($calls, '')
    $env:COOP_TEST_CALLS = $calls; $env:COOP_TEST_FIX_INSTALL = '1'
    $rows = Get-DoctorRows '' @('--fix')
    $fixRc = $script:LastDoctorRc
    $callLines = @([System.IO.File]::ReadAllLines($calls))
    $exact = @($callLines | Where-Object { $_ -match '^PIPX install .+ms-fabric-cli==1\.7\.0(\s|$)' })
    $loose = @($callLines | Where-Object { ($_ -match '^PIPX install .+ms-fabric-cli(\s|$)') -and ($_ -notmatch 'ms-fabric-cli==1\.7\.0') })
    if ($exact.Count -gt 0 -and $loose.Count -eq 0 -and ($callLines -contains 'PIPX inject ms-fabric-cli fabric-cicd==1.3.0 --force') -and ($callLines -contains 'PIPX inject ms-fabric-cli pyodbc==5.3.0 --force')) {
      Ok 'doctor --fix converges the exact managed Fabric runtime'
    } else { Ko 'doctor --fix did not use exact managed Fabric specs' ($callLines -join "`n") }
    if (@(Find-Rows $rows 'Fabric SQL fallback ready (pyodbc 5.3.0, ODBC Driver 18)').Count -gt 0) { Ok 'doctor --fix re-check sees Fabric SQL readiness' } else { Ko "doctor --fix re-check did not see Fabric SQL readiness (rc=$fixRc)" (Show-Rows $rows 'Fabric SQL') }
    Remove-Stub $fabVenvBin 'fab'; Remove-Item -LiteralPath (Join-Path $fabVenvBin 'fab') -Force -ErrorAction SilentlyContinue
    Set-Meta 'ms-fabric-cli' 'ms-fabric-cli' ''
    $env:COOP_TEST_PIPX_FAIL = 'pyodbc==5.3.0'
    $env:PATH = "$fabVenvBin$sep$dddVenvBin$sep$fakeBin$sep$basePath"
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $doctor --fix *> $null; $fixFailRc = $LASTEXITCODE }
    finally { $ErrorActionPreference = $eap; $env:PATH = $basePath }
    if ($fixFailRc -ne 0) { Ok 'doctor --fix preserves managed runtime repair failures' } else { Ko 'doctor --fix converted a failed pyodbc convergence into success' }
    foreach ($n in @('COOP_TEST_CALLS','COOP_TEST_FIX_INSTALL','COOP_TEST_PIPX_FAIL')) { Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath (Join-Path $fabVenvBin 'fab') -Force -ErrorAction SilentlyContinue
  }

  # F3: wrong version: metadata and CLI agree with each other, differ from the pin.
  Set-Meta 'ms-fabric-cli' 'ms-fabric-cli' '1.6.1'
  $null = New-VersionStub $fabVenvBin 'fab' '1.6.1'
  Set-VenvPython 'ms-fabric-cli' '3.13.1' '<3.14,>=3.10'
  $rows = Get-DoctorRows
  $older = @($rows | Where-Object { ([string]$_.name).Contains('ms-fabric-cli 1.6.1') -and ([string]$_.name).Contains('older than manifest') })
  if ($older.Count -gt 0) { Ok 'older version reported with manifest reference' } else { Ko 'wrong version not classified' (Show-Rows $rows 'ms-fabric-cli') }

  # F4b: pipx metadata unreadable -> classify by the CLI, flag the unreadable metadata.
  # (F4 stale/corrupt and F4c-F4f are tests/fixtures/doctor-pipx-shadow.test.ps1.)
  Set-Meta 'coop-data-doc' 'coop-data-doc' ''
  $null = New-VersionStub $dddVenvBin 'coop-data-doc' 'coop-data-doc, version 1.0.0'
  $rows = Get-DoctorRows
  if (@(Find-Rows $rows 'coop-data-doc 1.0.0 differs from manifest per coop-data-doc (pipx metadata unreadable)').Count -gt 0) { Ok 'unreadable pipx metadata reported alongside the CLI classification' }
  else { Ko 'metadata-unavailable fallback not handled' (Show-Rows $rows 'coop-data-doc') }
  Set-Meta 'coop-data-doc' 'coop-data-doc' $PinDdd
  $null = New-VersionStub $dddVenvBin 'coop-data-doc' "coop-data-doc, version $PinDdd"

  # F5: a Paramiko/Fabric SSH `fab` is rejected and never credited as ms-fabric-cli.
  Set-Meta 'ms-fabric-cli' 'ms-fabric-cli' $PinFab
  Remove-Stub $fabVenvBin 'fab'
  $wrongDir = Join-Path $fakeBin 'wrongfab'
  $null = New-VersionStub $wrongDir 'fab' 'Fabric 2.7.4 (paramiko)'
  $rows = Get-DoctorRows "$wrongDir$sep"
  if (@(Find-Rows $rows 'WRONG').Count -gt 0) { Ok 'Paramiko fab still rejected as the wrong tool' } else { Ko 'paramiko fab not rejected' (Show-Rows $rows 'fab') }
  if (@(Find-Rows $rows "ms-fabric-cli $PinFab matches manifest").Count -eq 0) { Ok 'paramiko fab not credited as ms-fabric-cli' } else { Ko 'paramiko fab was accepted as ms-fabric-cli' (Show-Rows $rows 'ms-fabric-cli') }
  Remove-Item -LiteralPath $wrongDir -Recurse -Force

  if ($isWindowsHost) { Skipped 'venv Python Requires-Python rows (F6, F7, F7b)' } else {
    # F6: the distribution's own Requires-Python ("<3.14,>=3.10") rejects a 3.14 venv.
    $null = New-VersionStub $fabVenvBin 'fab' $PinFab
    Set-VenvPython 'ms-fabric-cli' '3.14.5' '<3.14,>=3.10'
    $rows = Get-DoctorRows
    $envRows = @($rows | Where-Object { ([string]$_.name).Contains('ms-fabric-cli environment') })
    if (@(Find-Rows $envRows '3.14').Count -gt 0) { Ok 'venv Python 3.14 reported for ms-fabric-cli' } else { Ko 'venv interpreter version not reported' (Show-Rows $rows 'ms-fabric-cli') }
    if (@(Find-Rows $envRows "violates its own requires-python '<3.14,>=3.10'").Count -gt 0) { Ok '3.14 venv flagged against installed Requires-Python metadata' } else { Ko 'Requires-Python violation not flagged' (Show-Rows $rows 'ms-fabric-cli') }
    if (@(Find-Rows $envRows '--python 3.12').Count -gt 0 -or @(Find-Rows $envRows '--python 3.13').Count -gt 0) { Ok 'repair suggests recreating with a supported Python' } else { Ko 'repair does not suggest a supported --python' (Show-Rows $rows 'ms-fabric-cli') }

    # F7: a supported venv Python passes quietly, citing the metadata.
    Set-VenvPython 'ms-fabric-cli' '3.12.7' '<3.14,>=3.10'
    $rows = Get-DoctorRows
    if (@(Find-Rows $rows 'violates').Count -eq 0) { Ok 'Python 3.12 venv accepted without a violation warning' } else { Ko 'supported venv Python falsely flagged' (Show-Rows $rows 'violates') }
    if (@(Find-Rows $rows 'ms-fabric-cli environment uses Python 3.12.7 (requires-python: <3.14,>=3.10)').Count -gt 0) { Ok 'interpreter reported with its Requires-Python metadata' } else { Ko 'interpreter+metadata line absent' (Show-Rows $rows 'ms-fabric-cli') }

    # F7b: no hardcoded <3.14: a distribution whose own metadata allows 3.14 passes.
    Set-VenvPython 'coop-data-doc' '3.14.0' '>=3.9'
    $rows = Get-DoctorRows
    if (@(Find-Rows $rows 'coop-data-doc environment uses Python 3.14.0 (requires-python: >=3.9)').Count -gt 0) { Ok "3.14 venv accepted where the distribution's own metadata allows it" } else { Ko 'uncapped distribution falsely restricted to <3.14' (Show-Rows $rows 'coop-data-doc') }
  }

  Write-Host '  -> sync: extension postconditions verified after installation'

  # Direct unit coverage of the verifier over fixture agent dirs.
  function New-VerifierTree([string]$Layout) {
    $ad = Join-Path $t "tree-$Layout"
    $pkgDir = Join-Path $ad 'npm\node_modules\pi-mcp-adapter'
    New-Item -ItemType Directory -Force -Path $pkgDir | Out-Null
    switch ($Layout) {
      'ok'    { [System.IO.File]::WriteAllText((Join-Path $pkgDir 'package.json'), '{"name":"pi-mcp-adapter","version":"2.10.0"}', $utf8) }
      'wrong' { [System.IO.File]::WriteAllText((Join-Path $pkgDir 'package.json'), '{"name":"pi-mcp-adapter","version":"2.9.0"}', $utf8) }
    }
    return $ad
  }
  if ((Get-CoopExtInstalledVersion -AgentDir (New-VerifierTree 'ok') -Name 'pi-mcp-adapter') -eq '2.10.0') { Ok 'verifier reads exact installed version' } else { Ko 'verifier failed on exact fixture' }
  if (-not (Get-CoopExtInstalledVersion -AgentDir (New-VerifierTree 'missing') -Name 'pi-mcp-adapter')) { Ok 'verifier returns empty for missing extension' } else { Ko 'verifier invented a version for a missing extension' }

  # A broken npm shim (exit 0, prints nothing) is never selected as the working npm;
  # a real one is. (The bash COOP_NPM_FALLBACK managed launcher has no PowerShell twin.)
  $brokenDir = Join-Path $t 'npm-broken'; $goodDir = Join-Path $t 'npm-good'
  $brokenNpm = New-PyStub $brokenDir 'npm' "import sys`nsys.exit(0)`n"
  $goodNpm = New-PyStub $goodDir 'npm' "import sys`nif sys.argv[1:2] == ['--version']:`n    print('10.0.0'); sys.exit(0)`nsys.exit(1)`n"
  $env:PATH = "$brokenDir$sep$basePath"
  $selected = Get-CoopWorkingNpm
  $env:PATH = $basePath
  if ($selected -ne $brokenNpm) { Ok 'a broken npm shim is never selected as the working npm' } else { Ko "the broken npm shim was selected ($selected)" }
  $env:PATH = "$goodDir$sep$basePath"
  $selected = Get-CoopWorkingNpm
  $env:PATH = $basePath
  if ($selected -eq $goodNpm) { Ok 'a working npm first on PATH is selected' } else { Ko "working npm was not selected (got '$selected')" }

  # Fake pi for the sync cases: --version from COOP_TEST_FAKE_PI_VERSION (default
  # 0.87.1), `pi install npm:<name>@<ver>` writes <name>'s package.json into
  # $PI_CODING_AGENT_DIR/npm/node_modules, honestly (COOP_TEST_FAKE_PI_OK=1),
  # at a WRONG version (COOP_TEST_FAKE_PI_WRONG=<name> + _INSTALL_VERSION), or
  # NOT AT ALL (COOP_TEST_FAKE_PI_SKIP=<name>). `pi install` exiting 0 proves
  # nothing: sync must verify the tree.
  $fakePiSource = @'
import json, os, sys
args = sys.argv[1:]
if args[:1] == ['--version']:
    print(os.environ.get('COOP_TEST_FAKE_PI_VERSION', '0.87.1')); sys.exit(0)
if args[:1] == ['install'] and len(args) >= 2:
    spec = args[1]
    rest = spec[4:] if spec.startswith('npm:') else spec
    name, _, ver = rest.rpartition('@')
    if name == os.environ.get('COOP_TEST_FAKE_PI_WRONG', ''):
        ver = os.environ.get('COOP_TEST_FAKE_PI_INSTALL_VERSION', '0.0.1')
    if name == os.environ.get('COOP_TEST_FAKE_PI_SKIP', ''):
        sys.exit(0)
    d = os.path.join(os.environ['PI_CODING_AGENT_DIR'], 'npm', 'node_modules', name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, 'package.json'), 'w') as f:
        json.dump({'name': name, 'version': ver}, f)
    sys.exit(0)
sys.exit(1)
'@
  $piDir = Join-Path $t 'pibin'
  $null = New-PyStub $piDir 'pi' $fakePiSource
  # An npm that answers --version but can install nothing: convergence is blocked.
  $badDir = Join-Path $t 'badnpm'
  $null = New-PyStub $badDir 'npm' "import sys`nif sys.argv[1:2] == ['--version']:`n    print('10.0.0'); sys.exit(0)`nsys.exit(1)`n"
  $syncAgent = Join-Path $t 'sync-agent'
  function Invoke-Sync([string]$PathPrefix = '', [string]$Script = (Join-Path $root 'scripts\sync.ps1')) {
    Remove-Item -LiteralPath $syncAgent -Recurse -Force -ErrorAction SilentlyContinue
    $env:COOP_AGENT_DIR = $syncAgent
    $env:COOP_SKIP_FABRIC_SYNC = '1'
    # The sync cases pin the REAL extension fleet: the fixture manifest above only
    # carries the python tools, so the real manifest is restored for them.
    $env:COOP_RELEASE_MANIFEST = Join-Path $root 'config\release-manifest.json'
    $env:PATH = "$PathPrefix$piDir$sep$fakeBin$sep$basePath"
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
      $out = (& $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Script 2>&1 | Out-String)
      $rc = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $eap
      $env:PATH = $basePath
      $env:COOP_AGENT_DIR = $agent
      $env:COOP_RELEASE_MANIFEST = $manifest
      Remove-Item -LiteralPath 'Env:\COOP_SKIP_FABRIC_SYNC' -ErrorAction SilentlyContinue
    }
    return [pscustomobject]@{ Rc = $rc; Out = ($out -replace "$([char]27)\[[0-9;]*m", '') }
  }
  function Clear-FakePi { foreach ($n in @('COOP_TEST_FAKE_PI_OK','COOP_TEST_FAKE_PI_WRONG','COOP_TEST_FAKE_PI_SKIP','COOP_TEST_FAKE_PI_INSTALL_VERSION')) { Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue } }

  # S1: fake pi reports SUCCESS but installs a WRONG version. With npm unable to
  # install, production convergence cannot repair it: sync must report accurately
  # and exit non-zero instead of claiming success.
  $env:COOP_TEST_FAKE_PI_WRONG = 'context-mode'; $env:COOP_TEST_FAKE_PI_INSTALL_VERSION = '0.0.1'
  $r = Invoke-Sync "$badDir$sep"
  Clear-FakePi
  if ($r.Rc -ne 0) { Ok 'blocked enforcement + drifted install -> nonzero result' } else { Ko 'sync exited 0 despite blocked enforcement' $r.Out }
  if ($r.Out.Contains('context-mode is version 0.0.1')) { Ok 'failure names the offending extension and its drifted version' } else { Ko 'failure output omits the context-mode postcondition' $r.Out }
  if (-not $r.Out.Contains('release version 1.0.169 (context-mode)')) { Ok 'does not claim success for context-mode when the postcondition failed' } else { Ko 'claimed a converged context-mode despite the failed postcondition' $r.Out }

  # S2: fake pi succeeds but installs NOTHING.
  $env:COOP_TEST_FAKE_PI_SKIP = 'context-mode'
  $r = Invoke-Sync "$badDir$sep"
  Clear-FakePi
  if ($r.Rc -ne 0 -and $r.Out.Contains('context-mode is MISSING')) { Ok 'missing-after-successful-install (enforcement blocked) -> nonzero result' } else { Ko "sync exited $($r.Rc) despite a missing extension" $r.Out }

  # S3: honest success path: a correct install converges and reports precisely.
  # The tree starts with the shipped lock and the shared libraries at the fake
  # Pi's version, so no npm resolution (and no network) is needed to converge.
  $env:COOP_TEST_FAKE_PI_OK = '1'
  Remove-Item -LiteralPath $syncAgent -Recurse -Force -ErrorAction SilentlyContinue
  $syncNpm = Join-Path $syncAgent 'npm'
  New-Item -ItemType Directory -Force -Path $syncNpm | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $syncNpm 'package.json'), "{`n  `"name`": `"pi-extensions`",`n  `"private`": true`n}`n", $utf8)
  Copy-Item -LiteralPath (Join-Path $root 'config\extensions-lock.json') -Destination (Join-Path $syncNpm 'package-lock.json')
  foreach ($lib in @('pi-ai', 'pi-tui', 'pi-coding-agent')) {
    $libDir = Join-Path $syncNpm "node_modules\@earendil-works\$lib"
    New-Item -ItemType Directory -Force -Path $libDir | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $libDir 'package.json'), ('{"name":"@earendil-works/' + $lib + '","version":"0.87.1"}'), $utf8)
  }
  $env:COOP_AGENT_DIR = $syncAgent
  $env:COOP_SKIP_FABRIC_SYNC = '1'
  $env:COOP_RELEASE_MANIFEST = Join-Path $root 'config\release-manifest.json'
  $env:PATH = "$badDir$sep$piDir$sep$fakeBin$sep$basePath"
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $s3Out = ((& $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\sync.ps1') 2>&1 | Out-String) -replace "$([char]27)\[[0-9;]*m", '')
    $s3Rc = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $eap; $env:PATH = $basePath; $env:COOP_AGENT_DIR = $agent; $env:COOP_RELEASE_MANIFEST = $manifest
    Remove-Item -LiteralPath 'Env:\COOP_SKIP_FABRIC_SYNC' -ErrorAction SilentlyContinue
  }
  Clear-FakePi
  if ($s3Rc -eq 0) { Ok 'correct convergence exits zero' } else { Ko "honest sync failed (rc=$s3Rc)" $s3Out }
  if ($s3Out.Contains('Ensuring isolated pi-mcp-adapter is version')) { Ok 'convergence message states the exact target version' } else { Ko 'targeted convergence message missing' $s3Out }
  if ($s3Out.Contains('Already at release version') -or $s3Out.Contains('Installed release version')) { Ok 'postcondition outcome stated precisely' } else { Ko 'precise outcome message missing' $s3Out }
  if ($s3Out.Contains('Your personal Pi extensions are unchanged')) { Ok 'one-time explanation distinguishes isolated tree' } else { Ko 'isolated-tree explanation missing' $s3Out }

  # S4: alignment rc 10 / rc 11 must count as failures (deterministic): the
  # PRODUCTION sync.ps1 from a sandbox COOP_ROOT whose lib/_extdeps.py is a stub
  # emitting a chosen result line and exit code.
  function Invoke-SyncWithExtdeps([int]$Rc, [string]$Line) {
    $sandbox = Join-Path $t "fakeroot-$Rc"
    Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path (Join-Path $sandbox 'lib'), (Join-Path $sandbox 'config'), (Join-Path $sandbox 'scripts'), (Join-Path $sandbox 'bin') | Out-Null
    foreach ($f in @('lib\common.ps1', 'lib\pi_settings.py', 'lib\pins.js', 'lib\mcp_config.py', 'lib\_yaml.py', 'config\release-manifest.json', 'config\defaults.yml', 'scripts\sync.ps1', 'VERSION')) {
      Copy-Item -LiteralPath (Join-Path $root $f) -Destination (Join-Path $sandbox $f)
    }
    [System.IO.File]::WriteAllText((Join-Path $sandbox 'lib\_extdeps.py'), "import os, sys`nprint('$Line')`nsys.exit(int(os.environ.get('COOP_FAKE_EXTDEPS_RC', '$Rc')))`n", $utf8)
    $null = New-PyStub (Join-Path $sandbox 'bin') 'pi' $fakePiSource
    $null = New-PyStub (Join-Path $sandbox 'bin') 'npm' "import sys`nif sys.argv[1:2] == ['--version']:`n    print('22.0.0'); sys.exit(0)`nsys.exit(1)`n"
    $ad = Join-Path $sandbox 'agent'
    New-Item -ItemType Directory -Force -Path (Join-Path $ad 'npm\node_modules\pi-mcp-adapter') | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $ad 'npm\node_modules\pi-mcp-adapter\package.json'), '{"name":"pi-mcp-adapter","version":"2.10.0"}', $utf8)
    [System.IO.File]::WriteAllText((Join-Path $ad 'npm\package.json'), "{`n  `"name`": `"pi-extensions`",`n  `"private`": true,`n  `"dependencies`": {}`n}`n", $utf8)
    $env:COOP_TEST_FAKE_PI_OK = '1'
    $env:COOP_FAKE_EXTDEPS_RC = "$Rc"
    $env:COOP_AGENT_DIR = $ad
    $env:COOP_PIPX_BIN = Join-Path $sandbox 'nonexistent-pipx'
    $env:COOP_RELEASE_MANIFEST = Join-Path $sandbox 'config\release-manifest.json'
    $env:COOP_SKIP_FABRIC_SYNC = '1'
    $env:PATH = (Join-Path $sandbox 'bin') + $sep + $basePath
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
      $out = ((& $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $sandbox 'scripts\sync.ps1') 2>&1 | Out-String) -replace "$([char]27)\[[0-9;]*m", '')
      $rc2 = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $eap
      $env:PATH = $basePath; $env:COOP_AGENT_DIR = $agent; $env:COOP_PIPX_BIN = $pipx; $env:COOP_RELEASE_MANIFEST = $manifest
      foreach ($n in @('COOP_FAKE_EXTDEPS_RC','COOP_SKIP_FABRIC_SYNC')) { Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue }
      Clear-FakePi
    }
    return [pscustomobject]@{ Rc = $rc2; Out = $out }
  }
  Write-Host '  -> S4: shared-library skew classes must FAIL sync (rc 10 and rc 11)'
  $r = Invoke-SyncWithExtdeps 10 '- 0.80.2 - - 1 0 - -'
  if ($r.Rc -ne 0) { Ok 'rc-10 shared-lib skew -> sync exits non-zero' } else { Ko 'sync exited 0 on rc-10 skew' $r.Out }
  if ($r.Out.Contains('shared-library skew remains after alignment')) { Ok 'rc-10 skew reported precisely' } else { Ko 'rc-10 message missing' $r.Out }
  $r = Invoke-SyncWithExtdeps 11 '- 0.80.2 - - 1 0 ^99.0.0 pi-web-access'
  if ($r.Rc -ne 0) { Ok 'rc-11 agent-too-old skew -> sync exits non-zero' } else { Ko 'sync exited 0 on rc-11 skew' $r.Out }
  if ($r.Out.Contains('needs newer pi-ai libraries') -and $r.Out.Contains('pi-web-access needs pi-ai >= ^99.0.0')) { Ok 'rc-11 names the offending extension and floor' } else { Ko 'rc-11 detail missing' $r.Out }

  # S5: the venvs dir comes straight from PIPX_LOCAL_VENVS (no /venvs doubling).
  $authVenvs = Join-Path $t 'auth-venvs'
  Remove-Item -LiteralPath 'Env:\COOP_PIPX_HOME' -ErrorAction SilentlyContinue
  $env:COOP_FAKE_LOCAL_VENVS = $authVenvs
  $vd = Get-CoopPipxVenvsDir
  $env:COOP_PIPX_HOME = $pipxHome
  Remove-Item -LiteralPath 'Env:\COOP_FAKE_LOCAL_VENVS' -ErrorAction SilentlyContinue
  if ($vd -eq $authVenvs) { Ok 'venv dir comes straight from PIPX_LOCAL_VENVS (no /venvs doubling)' } else { Ko "doubled/mangled venvs dir: $vd" }
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

if ($fail -ne 0) { Write-Host '  x truthful inventory (doctor.ps1 pipx rows / sync.ps1 postconditions) tests FAILED'; exit 1 }
Write-Host '  truthful inventory (doctor.ps1 pipx rows / sync.ps1 postconditions) tests passed'
exit 0

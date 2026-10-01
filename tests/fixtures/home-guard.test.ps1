#!/usr/bin/env pwsh
# Home-guard (port of tests/home-guard.test.sh): proves the fleet entry points
# (install / update / sync / doctor / onboard) cannot write into the REAL home
# directory when run under the suite's isolation environment. Motivated by a
# historical leak where test stubs landed in ~/.local/bin; this fails if that
# ever happens again.
#
# Scope: ~/.local/bin and ~/.coop (the two locations the fleet scripts write) of
# the home this fixture was started with, plus the checkout running the tests,
# which update and doctor must never fetch or move (the scripts run from a plain
# copy of the tree with no .git, #104). Offline: pi/npm/pipx/fab/az/winget are
# honest stubs; git, node and python are real (behind forwarding stubs).
$ErrorActionPreference = 'Stop'
$checkout = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$psExe = try { (Get-Process -Id $PID).Path } catch { 'pwsh' }
$isWindowsHost = ($env:OS -eq 'Windows_NT')
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-home-guard-' + [guid]::NewGuid().ToString('N'))
$G_CHECK = [char]0x2713; $G_CROSS = [char]0x2717
$fail = 0
function Ok([string]$m) { Write-Host "  $G_CHECK $m" }
function Ko([string]$m, [string]$Out = '') { Write-Host "  $G_CROSS $m"; if ($Out) { Write-Host $Out }; $script:fail = 1 }
$utf8 = New-Object System.Text.UTF8Encoding($false)
$chmod = if ($isWindowsHost) { '' } else { (Get-Command chmod -ErrorAction Stop).Source }
$realNode = (Get-Command node -ErrorAction Stop).Source
$realGit = (Get-Command git -ErrorAction Stop).Source
# A Fabric-compatible (3.10-3.13) Python, preferring a versioned one; the Windows
# Store App-Execution-Alias stub under WindowsApps is not an interpreter.
$realPy = $null
foreach ($n in @('python3.13', 'python3.12', 'python3', 'python')) {
  $c = Get-Command $n -ErrorAction SilentlyContinue
  if (-not $c -or -not $c.Source -or $c.Source -match '\\WindowsApps\\') { continue }
  $realPy = $c.Source; break
}
if (-not $realPy) { throw 'a Python 3.10-3.13 is required for the home-guard fixture' }
$psDir = Split-Path -Parent $psExe

# The home under guard: the one this process was started with (USERPROFILE on
# Windows, HOME elsewhere), captured BEFORE the sandbox replaces it.
$realHome = if ($isWindowsHost -and $env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
# Sorted "relative-path sha256" lines (stable, no mtimes); '' for a missing dir.
function Get-Snapshot([string]$Dir) {
  if (-not $Dir -or -not (Test-Path -LiteralPath $Dir -PathType Container)) { return '' }
  $base = (Resolve-Path -LiteralPath $Dir).Path
  $lines = @()
  foreach ($f in (Get-ChildItem -LiteralPath $base -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.Extension -ne '.pyc' })) {
    $h = try { (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256 -ErrorAction Stop).Hash } catch { 'unreadable' }
    $lines += ($f.FullName.Substring($base.Length).TrimStart('\', '/') -replace '\\', '/') + ' ' + $h
  }
  return (($lines | Sort-Object) -join "`n")
}
function Invoke-Fleet([string]$Script, [string]$OutFile, [string[]]$ScriptArgs = @()) {
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $lines = @(& $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\$Script") @ScriptArgs 2>&1 | ForEach-Object { "$_" })
  $ErrorActionPreference = $eap
  [System.IO.File]::WriteAllText($OutFile, ($lines -join "`n"))
  [System.IO.File]::WriteAllText($env:MARKER, '')
}

$saved = @{}
$names = @('PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COOP_DIR', 'PIPX_HOME', 'PIPX_BIN_DIR', 'PI_CODING_AGENT_DIR', 'COOP_AGENT_DIR',
           'COOP_NO_ONBOARD', 'MARKER', 'COOP_TEST_STUB_PATH', 'COOP_FABRIC_PYTHON', 'COOP_FLEET_TEST_MODE', 'COOP_RELEASE_MANIFEST', 'COOP_SKIP_AZ',
           'COOP_AZ_BIN', 'NO_COLOR', 'COOP_PI_LATEST_OVERRIDE', 'COOP_STANDARDS_ROOT', 'COOP_STANDARDS_STATE', 'COOP_STANDARDS_SNAPSHOT_ROOT',
           'PYTHONPATH', 'PYTHONHOME')
foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
$priorPath = $env:PATH
try {
  $beforeLocalBin = Get-Snapshot (Join-Path $realHome '.local\bin')
  $beforeCoop = Get-Snapshot (Join-Path $realHome '.coop')

  # A plain copy of the tree, no .git (dot entries other than the bundled .coop
  # contract are git, CI and cache files, not runtime).
  $root = Join-Path $t 'coop-agent'
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  foreach ($e in (Get-ChildItem -LiteralPath $checkout -Force | Where-Object { -not $_.Name.StartsWith('.') -or $_.Name -eq '.coop' })) {
    Copy-Item -LiteralPath $e.FullName -Destination (Join-Path $root $e.Name) -Recurse -Force
  }
  $sandboxHome = Join-Path $t 'home'
  $bin = Join-Path $sandboxHome '.local\bin'
  $agent = Join-Path $t 'agent'
  foreach ($p in @($bin, $agent, (Join-Path $t 'pipx-home'), (Join-Path $t 'pipx-bin'), (Join-Path $t 'coop-dir'), (Join-Path $sandboxHome 'AppData\Local\Microsoft\Windows\PowerShell'), (Join-Path $sandboxHome 'AppData\Roaming'))) {
    New-Item -ItemType Directory -Force -Path $p | Out-Null
  }
  $marker = Join-Path $t 'calls'
  [System.IO.File]::WriteAllText($marker, '')

  # Honest offline stubs so the scripts exercise real code paths without network
  # or workstation tools. Every stub is ONE Python script (<name>.stub.py) behind
  # a one-line forwarder (.cmd on Windows, #!/bin/sh elsewhere), so each behaves
  # identically on every platform. The pi stub installs extensions honestly
  # (sync's postcondition check requires it); the npm stub materializes the
  # shared pi-ai/pi-tui libraries the realignment asks for.
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
  function ConvertTo-PyString([string]$S) { return "'" + $S.Replace('\', '\\').Replace("'", "\'") + "'" }
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
  $null = New-PyStub $bin 'pi' ($stubPrelude + @'
if args[:1] == ['--version']:
    print('pi 0.87.1'); sys.exit(0)
if args[:1] == ['install'] and len(args) > 1:
    spec = args[1]
    write_pkg(os.path.join(os.environ['PI_CODING_AGENT_DIR'], 'npm', 'node_modules'), spec[4:] if spec.startswith('npm:') else spec)
log('PI ' + ' '.join(args))
sys.exit(0)
'@)
  $null = New-PyStub $bin 'npm' ($stubPrelude + @'
if args[:2] == ['prefix', '-g']:
    print(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))); sys.exit(0)
if args[:1] == ['view']:
    print('0.87.1'); sys.exit(0)
if args[:1] == ['--version']:
    print('10.9.0'); sys.exit(0)
if args[:1] == ['install']:
    for a in args:
        if a.startswith('@earendil-works/pi-ai@') or a.startswith('@earendil-works/pi-tui@'):
            write_pkg('node_modules', a)
log('NPM ' + ' '.join(args))
sys.exit(0)
'@)
  $null = New-PyStub $bin 'pipx' ($stubPrelude + @'
if args[:1] == ['list']:
    sys.exit(0)
log('PIPX ' + ' '.join(args))
sys.exit(0)
'@)
  $null = New-PyStub $bin 'fab' ($stubPrelude + "print('fab version 1.6.1')`nsys.exit(0)`n")
  # A Fabric-compatible (3.10-3.13) Python and an Azure CLI stub let install pass
  # its H1 prerequisite gate, so the install path below really runs. Real git
  # behind a wrapper (Git Bash keeps git in /mingw64/bin, off this PATH).
  $null = New-PyStub $bin 'az' ($stubPrelude + "print('azure-cli 2.80.0')`nsys.exit(0)`n")
  $null = New-PyStub $bin 'git' ($stubPrelude + 'forward(' + (ConvertTo-PyString $realGit) + ")`n")
  $null = New-PyStub $bin 'node' ($stubPrelude + 'forward(' + (ConvertTo-PyString $realNode) + ")`n")
  $null = New-PyStub $bin 'python3' ($stubPrelude + 'forward(' + (ConvertTo-PyString $realPy) + ")`n")
  # A driver_missing runtime on Windows would reach `winget install
  # Microsoft.msodbcsql.18` on the host; this winget only logs and fails.
  $null = New-PyStub $bin 'winget' ($stubPrelude + "log('WINGET ' + ' '.join(args))`nsys.exit(1)`n")
  # The Fabric CLI's pipx environment is a REAL (pip-less) venv of the real
  # interpreter under the sandbox PIPX_HOME, so Get-CoopVenvPythonPath finds
  # Scripts\python.exe on Windows and bin/python elsewhere; a fixture pyodbc
  # (5.3.0 metadata, Driver 18 present) on PYTHONPATH answers its runtime probe.
  $venv = Join-Path $t 'pipx-home\venvs\ms-fabric-cli'
  & $realPy -m venv --without-pip $venv *> $null
  if ($LASTEXITCODE -ne 0 -or -not ((Test-Path -LiteralPath (Join-Path $venv 'Scripts\python.exe')) -or (Test-Path -LiteralPath (Join-Path $venv 'bin/python')))) {
    throw "could not create the Fabric venv fixture under $venv with $realPy"
  }
  $runtimeFixture = Join-Path $t 'runtime-fixture'
  $pyodbcMetadata = Join-Path $runtimeFixture 'pyodbc-5.3.0.dist-info'
  New-Item -ItemType Directory -Force -Path $runtimeFixture, $pyodbcMetadata | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $runtimeFixture 'pyodbc.py'), "def drivers():`n    return ['ODBC Driver 18 for SQL Server']`n", $utf8)
  [System.IO.File]::WriteAllText((Join-Path $pyodbcMetadata 'METADATA'), "Metadata-Version: 2.1`nName: pyodbc`nVersion: 5.3.0`n", $utf8)
  Remove-Item Env:\PYTHONHOME -ErrorAction SilentlyContinue
  $env:PYTHONPATH = if ($saved['PYTHONPATH']) { $runtimeFixture + [System.IO.Path]::PathSeparator + $saved['PYTHONPATH'] } else { $runtimeFixture }

  # Native Windows node and python find the home through USERPROFILE, not HOME, so
  # the fleet scripts get a sandboxed USERPROFILE too; without it a standards
  # refresh in sync reached the real %USERPROFILE%\.coop (#135).
  $env:HOME = $sandboxHome; $env:USERPROFILE = $sandboxHome
  $env:LOCALAPPDATA = Join-Path $sandboxHome 'AppData\Local'; $env:APPDATA = Join-Path $sandboxHome 'AppData\Roaming'
  $env:COOP_DIR = Join-Path $t 'coop-dir'
  $env:PIPX_HOME = Join-Path $t 'pipx-home'; $env:PIPX_BIN_DIR = Join-Path $t 'pipx-bin'
  $env:PI_CODING_AGENT_DIR = $agent; $env:COOP_AGENT_DIR = $agent
  $env:COOP_RELEASE_MANIFEST = Join-Path $root 'config\release-manifest.json'
  $env:MARKER = $marker; $env:COOP_TEST_STUB_PATH = $bin
  $env:COOP_NO_ONBOARD = '1'; $env:COOP_SKIP_AZ = '1'; $env:NO_COLOR = '1'
  $env:COOP_PI_LATEST_OVERRIDE = '0.87.1'
  foreach ($n in @('COOP_FABRIC_PYTHON', 'COOP_STANDARDS_ROOT', 'COOP_STANDARDS_STATE', 'COOP_STANDARDS_SNAPSHOT_ROOT')) { [Environment]::SetEnvironmentVariable($n, $null) }
  if ($isWindowsHost) { $env:PATH = $bin + ';' + $priorPath }
  else {
    # Stub bin first, the system dirs the scripts need (sh, uname) next; the stub
    # bin again at the END because install.ps1's PATH helpers prepend with ';'
    # (Windows separators), which on a POSIX host fuses the leading entries into
    # one unusable segment.
    $env:PATH = $bin + ':' + $psDir + ':/usr/bin:/bin:' + $bin
  }

  Write-Host '-> fleet paths cannot mutate the real home directory'
  $env:COOP_FLEET_TEST_MODE = '1'
  Invoke-Fleet 'install.ps1' (Join-Path $t 'install.out') @('--force')
  Invoke-Fleet 'update.ps1' (Join-Path $t 'update.out')
  Remove-Item Env:\COOP_FLEET_TEST_MODE -ErrorAction SilentlyContinue
  Invoke-Fleet 'sync.ps1' (Join-Path $t 'sync.out')
  Push-Location $t
  try { Invoke-Fleet 'doctor.ps1' (Join-Path $t 'doctor.out') } finally { Pop-Location }
  # Onboarding wizard itself (scripted answers, isolated dirs).
  $env:COOP_AZ_BIN = Join-Path $t 'nonexistent\az'
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $null = ("Guard User`n2`nn`n`n`nn`n`n" | & $realPy (Join-Path $root 'scripts\onboard.py') onboard 2>&1)
  $ErrorActionPreference = $eap

  $afterLocalBin = Get-Snapshot (Join-Path $realHome '.local\bin')
  $afterCoop = Get-Snapshot (Join-Path $realHome '.coop')
  if ($beforeLocalBin -ceq $afterLocalBin) { Ok "$realHome/.local/bin unchanged by fleet paths" }
  else { Ko "$realHome/.local/bin MUTATED" (Compare-Object ($beforeLocalBin -split "`n") ($afterLocalBin -split "`n") | Select-Object -First 10 | Out-String) }
  if ($beforeCoop -ceq $afterCoop) { Ok "$realHome/.coop unchanged by fleet paths" }
  else { Ko "$realHome/.coop MUTATED" (Compare-Object ($beforeCoop -split "`n") ($afterCoop -split "`n") | Select-Object -First 10 | Out-String) }

  # Update and doctor ran from the copy, so neither saw a git checkout to fetch or move.
  $updateOut = [System.IO.File]::ReadAllText((Join-Path $t 'update.out'))
  $doctorOut = [System.IO.File]::ReadAllText((Join-Path $t 'doctor.out'))
  if ($updateOut.Contains('not a git checkout') -and $doctorOut.Contains('not a git checkout')) { Ok 'update and doctor ran from a copy, never the checkout running the tests' }
  else { Ko 'update or doctor ran against a git checkout; fleet paths must run from a copy (#104)' ($updateOut + "`n" + $doctorOut) }

  # Sanity: the stubs were actually exercised (otherwise the guard proves nothing).
  if (Test-Path -LiteralPath (Join-Path $agent 'npm\node_modules\pi-mcp-adapter')) { Ok 'stubbed install path was genuinely exercised' }
  else { Ko 'isolation sanity failed: extension tree not created in temp dir' ([System.IO.File]::ReadAllText((Join-Path $t 'install.out'))) }
}
finally {
  foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  home-guard tests passed' } else { Write-Host "  $G_CROSS home-guard tests FAILED" }
exit $fail

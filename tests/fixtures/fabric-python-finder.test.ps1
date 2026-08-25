#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'

# Get-CoopFabricPython must discover side-by-side interpreters that are NOT on
# PATH (Python install manager + winget layouts) and must reject incompatible
# versions (notably a 3.14-only machine). The bash twin of this fixture runs in
# the Windows Git Bash CI leg; here we skip native Windows to avoid executing
# deliberately-invalid stub .exe files under ErrorActionPreference=Stop.

if ($env:OS -eq 'Windows_NT') {
  Write-Output '  – skipped on native Windows (covered by the Git Bash suite)'
  exit 0
}

$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
. (Join-Path $root 'lib/common.ps1')

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("coop-fabric-py-" + [guid]::NewGuid().ToString('N'))
$fakeLocal = Join-Path $tmp 'AppData'
New-Item -ItemType Directory -Force -Path $fakeLocal | Out-Null

$chmod = (Get-Command chmod -ErrorAction Stop).Source   # capture BEFORE PATH is restricted

$envNames = @('LOCALAPPDATA', 'PROGRAMFILES', 'COOP_FABRIC_PYTHON', 'COOP_FAKE_PY_VERSION', 'PATH')
$prior = @{}
foreach ($name in $envNames) { $prior[$name] = [Environment]::GetEnvironmentVariable($name) }

function New-FakePython([string]$Path) {
  $dir = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $shim = @'
#!/bin/sh
if [ "$1" = "-c" ]; then printf '%s\n' "$COOP_FAKE_PY_VERSION"; exit 0; fi
exit 1
'@
  [System.IO.File]::WriteAllText($Path, $shim)
  & $chmod +x $Path
}

try {
  # Fail-stubs shadow every interpreter name the PATH-based probes try.
  foreach ($stub in @('python3.13', 'python3.12', 'python3', 'python', 'py')) {
    $p = Join-Path $tmp $stub
    [System.IO.File]::WriteAllText($p, "#!/bin/sh`nexit 1`n")
    & $chmod +x $p
  }
  $env:PATH = $tmp
  $env:LOCALAPPDATA = $fakeLocal
  $env:PROGRAMFILES = (Join-Path $tmp 'ProgramFiles')   # isolate machine-scope probes too
  Remove-Item Env:COOP_FABRIC_PYTHON -ErrorAction SilentlyContinue

  # 1. Python install manager layout: %LOCALAPPDATA%\Python\bin\python3.13.exe
  $env:COOP_FAKE_PY_VERSION = '3.13'
  $py313 = Join-Path (Join-Path (Join-Path $fakeLocal 'Python') 'bin') 'python3.13.exe'
  New-FakePython $py313
  $found = Get-CoopFabricPython
  if ($found -ne $py313) { throw "pymanager-layout interpreter not discovered (got '$found')" }
  Write-Output '  ✓ %LOCALAPPDATA%\Python\bin side-by-side interpreter discovered'

  # 2. An interpreter that reports 3.14 is NOT Fabric-compatible.
  $env:COOP_FAKE_PY_VERSION = '3.14'
  $found = Get-CoopFabricPython
  if ($null -ne $found) { throw "Python 3.14 wrongly accepted as Fabric-compatible: '$found'" }
  Write-Output '  ✓ 3.14-only machine still reports no compatible interpreter'

  # 3. winget user-scope layout: %LOCALAPPDATA%\Programs\Python\Python312\python.exe
  Remove-Item $py313 -Force
  $env:COOP_FAKE_PY_VERSION = '3.12'
  $py312 = Join-Path (Join-Path (Join-Path (Join-Path $fakeLocal 'Programs') 'Python') 'Python312') 'python.exe'
  New-FakePython $py312
  $found = Get-CoopFabricPython
  if ($found -ne $py312) { throw "winget user-scope interpreter not discovered (got '$found')" }
  Write-Output '  ✓ %LOCALAPPDATA%\Programs\Python\Python31x layout discovered'
}
finally {
  foreach ($name in $envNames) {
    if ($null -eq $prior[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($name, [string]$prior[$name]) }
  }
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

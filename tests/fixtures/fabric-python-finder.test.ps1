#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'

# Get-CoopFabricBootstrapPython must discover side-by-side interpreters that are NOT on
# PATH (Python install manager + winget layouts) and must reject incompatible
# versions (notably a 3.14-only machine). Native Windows is skipped to avoid
# executing deliberately-invalid stub .exe files under ErrorActionPreference=Stop.

$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
. (Join-Path $root 'lib/common.ps1')

# #81: the version probe must reach a REAL interpreter intact. Windows PowerShell 5.1
# (the CI job that runs this file on Windows, and coop.cmd's runtime) mangles embedded
# double quotes in native arguments, which the stub interpreters below cannot show.
# PowerShell 7.3+ reproduces 5.1's quoting with 'Legacy' argument passing, so the
# Linux pwsh run catches a regression too; 5.1 has no such setting and ignores it.
$realPy = @('python3', 'python') | ForEach-Object { Get-Command $_ -ErrorAction SilentlyContinue } |
  Where-Object { $_.Source -and $_.Source -notmatch '\\WindowsApps\\' } | Select-Object -First 1
if ($realPy) {
  $PSNativeCommandArgumentPassing = 'Legacy'
  $realVersion = Get-CoopPythonMinorVersion $realPy.Source
  Remove-Variable PSNativeCommandArgumentPassing -ErrorAction SilentlyContinue
  if ($realVersion -notmatch '^3\.\d+$') {
    throw "version probe got '$realVersion' from a real $($realPy.Source) under PowerShell $($PSVersionTable.PSVersion)"
  }
  Write-Output "  ✓ version probe reads $realVersion from a real interpreter (PowerShell $($PSVersionTable.PSVersion.Major).$($PSVersionTable.PSVersion.Minor))"
  # The same quoting broke Get-CoopVenvRequiresPython, whose program carries double
  # quotes: doctor then reported "no Requires-Python metadata found" and skipped the
  # check. A throwaway venv sees a fake distribution through PYTHONPATH.
  $rpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("coop-rp-" + [guid]::NewGuid().ToString('N'))
  $priorPipxHome = $env:COOP_PIPX_HOME; $priorPythonPath = $env:PYTHONPATH
  try {
    $distInfo = Join-Path (Join-Path $rpRoot 'site') 'coop_rp_probe-1.0.dist-info'
    New-Item -ItemType Directory -Force -Path $distInfo | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $distInfo 'METADATA'), "Metadata-Version: 2.1`nName: coop-rp-probe`nVersion: 1.0`nRequires-Python: >=3.10`n")
    & $realPy.Source -m venv --without-pip (Join-Path (Join-Path $rpRoot 'venvs') 'coop-rp-probe') 2>$null | Out-Null
    $env:COOP_PIPX_HOME = $rpRoot
    $env:PYTHONPATH = Join-Path $rpRoot 'site'
    $PSNativeCommandArgumentPassing = 'Legacy'
    $rp = Get-CoopVenvRequiresPython 'coop-rp-probe' 'coop-rp-probe'
    Remove-Variable PSNativeCommandArgumentPassing -ErrorAction SilentlyContinue
    if ($rp -ne '>=3.10') { throw "Requires-Python probe got '$rp' from a real venv under PowerShell $($PSVersionTable.PSVersion)" }
    Write-Output "  ✓ Requires-Python probe reads $rp from a real venv (PowerShell $($PSVersionTable.PSVersion.Major).$($PSVersionTable.PSVersion.Minor))"
  } finally {
    Remove-Variable PSNativeCommandArgumentPassing -ErrorAction SilentlyContinue
    $env:COOP_PIPX_HOME = $priorPipxHome; $env:PYTHONPATH = $priorPythonPath
    Remove-Item -LiteralPath $rpRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
} else {
  Write-Output '  – no real Python on PATH; version probe check skipped'
}

if ($env:OS -eq 'Windows_NT') {
  Write-Output '  – stub-interpreter discovery skipped on native Windows (covered by the Git Bash suite)'
  exit 0
}

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
  $found = Get-CoopFabricBootstrapPython
  if ($found -ne $py313) { throw "pymanager-layout interpreter not discovered (got '$found')" }
  Write-Output '  ✓ %LOCALAPPDATA%\Python\bin side-by-side interpreter discovered'

  # 2. An interpreter that reports 3.14 is NOT Fabric-compatible.
  $env:COOP_FAKE_PY_VERSION = '3.14'
  $found = Get-CoopFabricBootstrapPython
  if ($null -ne $found) { throw "Python 3.14 wrongly accepted as Fabric-compatible: '$found'" }
  Write-Output '  ✓ 3.14-only machine still reports no compatible interpreter'

  # 3. winget user-scope layout: %LOCALAPPDATA%\Programs\Python\Python312\python.exe
  Remove-Item $py313 -Force
  $env:COOP_FAKE_PY_VERSION = '3.12'
  $py312 = Join-Path (Join-Path (Join-Path (Join-Path $fakeLocal 'Programs') 'Python') 'Python312') 'python.exe'
  New-FakePython $py312
  $found = Get-CoopFabricBootstrapPython
  if ($found -ne $py312) { throw "winget user-scope interpreter not discovered (got '$found')" }
  Write-Output '  ✓ %LOCALAPPDATA%\Programs\Python\Python31x layout discovered'

  # 4. Get-CoopPipxFetchPythonFlag: the flag pipx accepts for a standalone Python,
  #    in that pipx's own spelling; '' when it cannot fetch one.
  function New-FakePipx([string]$HelpLine) {
    $p = Join-Path $tmp 'pipx'
    [System.IO.File]::WriteAllText($p, "#!/bin/sh`nif [ `"`$1 `$2`" = `"install --help`" ]; then echo '$HelpLine'; fi`nexit 0`n")
    & $chmod +x $p
  }
  New-FakePipx '  --fetch-python {always,missing,never} | --fetch-missing-python'
  $flag = Get-CoopPipxFetchPythonFlag
  if ($flag -ne '--fetch-python=missing') { throw "pipx 1.12+ spelling not preferred (got '$flag')" }
  New-FakePipx '  --fetch-missing-python'
  $flag = Get-CoopPipxFetchPythonFlag
  if ($flag -ne '--fetch-missing-python') { throw "pipx 1.5-1.11 spelling not accepted (got '$flag')" }
  New-FakePipx '  --python PYTHON'
  $flag = Get-CoopPipxFetchPythonFlag
  if ($flag) { throw "a pipx without a fetch flag returned '$flag'" }
  # A pipx reachable only as `python -m pipx` is probed the same way.
  $py3 = Join-Path $tmp 'python3'
  [System.IO.File]::WriteAllText($py3, "#!/bin/sh`nif [ `"`$1 `$2 `$3 `$4`" = `"-m pipx install --help`" ]; then echo '  --fetch-python {always,missing,never}'; fi`nexit 0`n")
  & $chmod +x $py3
  $flag = Get-CoopPipxFetchPythonFlag @('python3', '-m', 'pipx')
  if ($flag -ne '--fetch-python=missing') { throw "python -m pipx not probed (got '$flag')" }
  Remove-Item (Join-Path $tmp 'pipx') -Force
  $flag = Get-CoopPipxFetchPythonFlag
  if ($flag) { throw "a missing pipx reported a fetch flag '$flag'" }
  Write-Output '  ✓ Get-CoopPipxFetchPythonFlag reports --fetch-python=missing / --fetch-missing-python / nothing'

  # 5. Get-CoopFabricPipxPlan: a local 3.10-3.13 wins; otherwise pipx's standalone
  #    3.12 with that pipx's flag; $null when neither exists (row 3 then decides).
  [System.IO.File]::WriteAllText($py3, "#!/bin/sh`nexit 1`n")   # back to the fail-stub
  $env:COOP_FAKE_PY_VERSION = '3.12'                              # py312 from case 3 is still in place
  $plan = Get-CoopFabricPipxPlan
  if (-not $plan -or $plan.Python -ne $py312 -or $plan.FetchFlag) { throw "plan with a local 3.12 gave '$($plan | Out-String)'" }
  Remove-Item $py312 -Force
  $plan = Get-CoopFabricPipxPlan
  if ($null -ne $plan) { throw "plan succeeded with no Python and no pipx: '$($plan | Out-String)'" }
  New-FakePipx '  --fetch-python {always,missing,never}'
  $plan = Get-CoopFabricPipxPlan
  if (-not $plan -or $plan.Python -ne '3.12' -or $plan.FetchFlag -ne '--fetch-python=missing') { throw "standalone plan gave '$($plan | Out-String)'" }
  Write-Output '  ✓ Get-CoopFabricPipxPlan prefers a local 3.10-3.13, else pipx standalone 3.12, else nothing'
}
finally {
  foreach ($name in $envNames) {
    if ($null -eq $prior[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($name, [string]$prior[$name]) }
  }
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

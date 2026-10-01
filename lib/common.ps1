#!/usr/bin/env pwsh
#
# coop-agent shared PowerShell library — the twin of lib/common.sh.
# Dot-sourced by bin/coop.ps1 and scripts/*.ps1:
#
#   . (Join-Path $PSScriptRoot '../lib/common.ps1')   # from scripts/ or bin/
#
# Defines helpers only; never calls `exit` except via Coop-Die. Dot-sourcing runs
# this file in the CALLER's script scope, so every $script:* variable and function
# here lands in (and binds to) the calling script — exactly like `. lib/common.sh`
# on the bash side. When you change a helper in lib/common.sh, port it here in the
# same change (scripts/check-parity.sh gates the pairing + this file's BOM).

# --- Resolve COOP_ROOT (the directory that contains bin/, lib/, scripts/) -----
# $PSScriptRoot inside a dot-sourced file is THIS file's directory (lib/), so the
# repo root is one level up — mirror of common.sh's self-location logic.
$script:CoopRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:COOP_ROOT = $script:CoopRoot

$script:CoopVersion = '0.0.0'
$coopVerFile = Join-Path $script:CoopRoot 'VERSION'
if (Test-Path -LiteralPath $coopVerFile -PathType Leaf) {
  $coopVerRaw = (Get-Content -LiteralPath $coopVerFile -Raw -ErrorAction SilentlyContinue)
  if ($coopVerRaw) { $script:CoopVersion = $coopVerRaw.Trim() }
}
$env:COOP_VERSION = $script:CoopVersion

# Release manifest: single source of truth for exact versions installed together.
$script:CoopReleaseManifest = if ($env:COOP_RELEASE_MANIFEST) { $env:COOP_RELEASE_MANIFEST } else { Join-Path $script:CoopRoot 'config\release-manifest.json' }
$env:COOP_RELEASE_MANIFEST = $script:CoopReleaseManifest

function Coop-ManifestGet([string]$Key, [string]$Default = '') {
  try {
    $m = Get-Content -LiteralPath $script:CoopReleaseManifest -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $parts = $Key -split '\.'
    $v = $m
    foreach ($p in $parts) { if ($v -is [System.Collections.IDictionary]) { $v = $v[$p] } elseif ($v -and $v.PSObject.Properties[$p]) { $v = $v.$p } else { return $Default } }
    if ($null -eq $v) { return $Default }
    return [string]$v
  } catch { return $Default }
}

function Coop-ManifestObjectGet([string]$Object, [string]$Key, [string]$Default = '') {
  try {
    $m = Get-Content -LiteralPath $script:CoopReleaseManifest -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $o = $m.PSObject.Properties[$Object].Value
    $p = $o.PSObject.Properties[$Key]
    if ($null -eq $p -or $null -eq $p.Value) { return $Default }
    return [string]$p.Value
  } catch { return $Default }
}
function Coop-ManifestExtensionSpec([string]$Package) { $v = Coop-ManifestObjectGet 'extensions' $Package; if ($v) { return "npm:${Package}@${v}" }; return '' }
function Coop-ManifestPythonSpec([string]$Package) { $v = Coop-ManifestObjectGet 'python_tools' $Package; if ($v) { return "${Package}==${v}" }; return '' }
function Coop-ManifestNpmToolSpec([string]$Package) { $v = Coop-ManifestObjectGet 'npm_tools' $Package; if ($v) { return "${Package}@${v}" }; return '' }
function Coop-ManifestMcpSpec([string]$Package) { $v = Coop-ManifestObjectGet 'mcp_servers' $Package; if ($v) { return "${Package}@${v}" }; return '' }

# Every installed version `pi list` reports for one managed extension. Only real
# package specs count: an extension's install path also contains its name (and
# often a version), and counting those lines made one installed version read as
# ambiguous — which failed the fleet-pin proof closed for a correct machine.
# The name is exact-matched, so `pi-mcp-adapter-tools` is never mistaken for
# `pi-mcp-adapter`. `pi list` lines look like:
#   npm:pi-mcp-adapter@2.10.0
#     C:\...\npm\node_modules\pi-mcp-adapter
function Get-CoopPiExtensionVersions([string]$PiList, [string]$Package) {
  if (-not $Package -or -not $PiList) { return @() }
  $text = ($PiList -split "`r?`n") -join "`n"
  $core = '(?:0|[1-9][0-9]*)'
  $identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
  $prerelease = "-$identifier(?:\.$identifier)*"
  $build = '\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*'
  $semver = "$core\.$core\.$core(?:$prerelease)?(?:$build)?"
  $pattern = "^\s*(?:npm:)?$([regex]::Escape($Package))@(?<ver>$semver)\s*$"
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
  $versions = @()
  foreach ($match in [regex]::Matches($text, $pattern, 'Multiline')) {
    $version = $match.Groups['ver'].Value
    if ($seen.Add($version)) { $versions += $version }
  }
  return @($versions)
}

function Coop-ManifestKeys([string]$Key) {
  try {
    $m = Get-Content -LiteralPath $script:CoopReleaseManifest -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $parts = $Key -split '\.'
    $v = $m
    foreach ($p in $parts) { if ($v -is [System.Collections.IDictionary]) { $v = $v[$p] } elseif ($v -and $v.PSObject.Properties[$p]) { $v = $v.$p } else { return @() } }
    if ($v -is [System.Collections.IDictionary]) { return $v.Keys }
    if ($v -and $v.PSObject.Properties) { return @($v.PSObject.Properties.Name) }
    return @()
  } catch { return @() }
}

function Coop-VersionLessThan([string]$A, [string]$B) {
  if (-not $A -or -not $B) { return $false }
  $aParts = @($A -replace '^v','' -split '\.' | Select-Object -First 3 | ForEach-Object { [int]($_ -replace '[^0-9].*$','') })
  $bParts = @($B -replace '^v','' -split '\.' | Select-Object -First 3 | ForEach-Object { [int]($_ -replace '[^0-9].*$','') })
  for ($i = 0; $i -lt 3; $i++) { $av = if ($i -lt $aParts.Count) { $aParts[$i] } else { 0 }; $bv = if ($i -lt $bParts.Count) { $bParts[$i] } else { 0 }; if ($av -lt $bv) { return $true }; if ($av -gt $bv) { return $false } }
  return $false
}

function Coop-MinorNewer([string]$A, [string]$B) {
  if (-not $A -or -not $B) { return $false }
  $aParts = @($A -replace '^v','' -split '\.' | ForEach-Object { $_ -replace '[^0-9].*$','' })
  $bParts = @($B -replace '^v','' -split '\.' | ForEach-Object { $_ -replace '[^0-9].*$','' })
  if ($aParts.Count -lt 2 -or $bParts.Count -lt 2) { return $false }
  $aMaj = [int]$aParts[0]; $aMin = [int]$aParts[1]; $bMaj = [int]$bParts[0]; $bMin = [int]$bParts[1]
  return ($aMaj -gt $bMaj) -or (($aMaj -eq $bMaj) -and ($aMin -gt $bMin))
}

function Coop-ManifestStatus([string]$Installed, [string]$Expected) {
  if ([string]::IsNullOrWhiteSpace($Installed)) { return 'missing' }
  if ([string]::IsNullOrWhiteSpace($Expected)) { return 'not-applicable' }
  if ($Installed -eq $Expected) { return 'ok' }
  $i = $Installed -replace '^v',''; $e = $Expected -replace '^v',''
  if (Coop-VersionLessThan $i $e) { return 'older' }
  if (Coop-MinorNewer $i $e) { return 'newer-than-tested' }
  return 'wrong-version'
}

# --- pipx inventory probes (truthful tool inventory; twins of lib/common.sh) --
# `pipx list` output is NEVER authoritative: its cache can be stale and the
# command can even be shadowed. The source of truth is distribution metadata
# read INSIDE each venv via `pipx runpip`.

function Get-CoopPipxVenvsDir {
  # Resolution order (authoritative first):
  #   COOP_PIPX_HOME      test hook — point at fixtures without touching the box
  #   PIPX_HOME           user override, honored by pipx itself
  #   pipx environment    the selected pipx binary's OWN resolved value
  #   platform defaults   modern Windows %LOCALAPPDATA%\pipx\pipx,
  #                       legacy Windows ~\pipx, unix ~/.local/pipx
  # Defaulting straight to ~/.local/pipx misses Windows installs entirely.
  if ($env:COOP_PIPX_HOME) { return (Join-Path $env:COOP_PIPX_HOME 'venvs') }
  if ($env:PIPX_HOME) { return (Join-Path $env:PIPX_HOME 'venvs') }
  # PIPX_LOCAL_VENVS is ALREADY the complete venvs directory - never append
  # another "venvs" (that produced .../venvs/venvs and broke every probe).
  $cmd = Get-CoopPipxCmd
  if (Get-Command $cmd -ErrorAction SilentlyContinue) {
    $v = [string]((& $cmd environment --value PIPX_LOCAL_VENVS 2>$null | Out-String)).Trim()
    if ($v) { return $v }
  }
  $candidates = @()
  if ($IsWindows -or $env:OS -eq 'Windows_NT') {
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'pipx\pipx') }
    $candidates += (Join-Path $HOME 'pipx')
  } else {
    $candidates += (Join-Path $HOME '.local\pipx')
    $candidates += (Join-Path $HOME '.local/pipx')
  }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return (Join-Path $c 'venvs') }
  }
  return (Join-Path $HOME '.local\pipx\venvs')
}

# Installed version of a pipx-managed distribution from in-venv metadata.
# The pipx command used for inventory probes. COOP_PIPX_BIN lets callers pin an
# exact binary — useful when PATH carries shadows/stubs, and in tests.
function Get-CoopPipxCmd {
  if ($env:COOP_PIPX_BIN) { return $env:COOP_PIPX_BIN }
  return 'pipx'
}

function Get-CoopVenvDistVersion([string]$Venv, [string]$Distribution) {
  $pipx = Get-CoopPipxCmd
  $out = (& $pipx runpip $Venv show $Distribution 2>$null | Out-String)
  if (-not $out) { return '' }
  foreach ($line in ($out -split "`r?`n")) {
    if ($line -match '^Version:\s*(.+)$') { return $matches[1].Trim() }
  }
  return ''
}

# Python version inside a pipx venv, resolved directly.
function Get-CoopVenvPythonVersion([string]$Venv) {
  $py = Get-CoopVenvPythonPath $Venv
  if (-not $py) { return }
  & $py -c 'import platform;print(platform.python_version())' 2>$null
}

# Resolve a bootstrap interpreter supported by ms-fabric-cli (<3.14, >=3.10).
# Live Fabric Python is resolved separately from the managed pipx environment.
# Last ERROR line of captured pip output, trimmed — for actionable warnings.
function Coop-PipErrorTail([string]$Out) {
  $reason = ''
  foreach ($line in ($Out -split "`r?`n")) {
    if ($line -match 'ERROR:') { $reason = $line.Trim() }
  }
  if (-not $reason) { return '' }
  if ($reason.Length -gt 160) { $reason = $reason.Substring(0, 157) + '...' }
  return $reason
}

# "3.12"-style major.minor of an interpreter, or '' when it can't say. The probe
# carries no quotes or spaces: Windows PowerShell 5.1 (coop.cmd's runtime) does not
# escape embedded double quotes when it builds a native command line, so the old
# print("%d.%d" % ...) probe reached Python as a SyntaxError and every candidate
# but the py launcher was skipped (#81).
function Get-CoopPythonMinorVersion([string]$Exe) {
  return [string]((& $Exe -c 'import sys;print(*sys.version_info[:2],sep=chr(46))' 2>$null | Out-String)).Trim()
}

function Get-CoopFabricBootstrapPython {
  foreach ($name in @('python3.13', 'python3.12')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd -or -not $cmd.Source -or $cmd.Source -match '\\WindowsApps\\') { continue }
    $version = Get-CoopPythonMinorVersion $cmd.Source
    if ($version -match '^3\.(10|11|12|13)$') { return $cmd.Source }
  }
  # Side-by-side interpreters that are NOT on PATH:
  #   Python install manager: %LOCALAPPDATA%\Python\bin\python3.1x.exe
  #   winget user-scope:      %LOCALAPPDATA%\Programs\Python\Python31x\python.exe
  #   winget machine-scope:   %ProgramFiles%\Python31x\python.exe
  # A stale or broken launcher shim on PATH cannot shadow these direct probes.
  $direct = @()
  foreach ($minor in @('13', '12')) {
    if ($env:LOCALAPPDATA) {
      $direct += (Join-Path $env:LOCALAPPDATA "Python\bin\python3.$minor.exe")
      $direct += (Join-Path $env:LOCALAPPDATA "Programs\Python\Python3$minor\python.exe")
    }
    if ($env:ProgramFiles) { $direct += (Join-Path $env:ProgramFiles "Python3$minor\python.exe") }
  }
  foreach ($candidate in $direct) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $version = Get-CoopPythonMinorVersion $candidate
    if ($version -match '^3\.(10|11|12|13)$') { return $candidate }
  }
  $launcher = Get-Command py -ErrorAction SilentlyContinue
  if ($launcher) {
    foreach ($version in @('3.13', '3.12')) {
      $resolved = [string]((& $launcher.Source "-$version" -c 'import sys;print(sys.executable)' 2>$null | Out-String)).Trim()
      if ($LASTEXITCODE -eq 0 -and $resolved) { return $resolved }
    }
  }
  foreach ($name in @('python3', 'python')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd -or ($cmd.Source -and $cmd.Source -match '\\WindowsApps\\')) { continue }
    $version = Get-CoopPythonMinorVersion $cmd.Source
    if ($version -match '^3\.(10|11|12|13)$') { return $cmd.Source }
  }
  return $null
}

# The `pipx install` flag that makes pipx download a standalone Python when the
# requested version is not installed: pipx 1.12+ spells it --fetch-python=missing,
# pipx 1.5-1.11 --fetch-missing-python (still accepted by newer pipx as a deprecated
# alias, so the current spelling is tried first). '' when this pipx cannot fetch a
# Python (pipx < 1.5, or no pipx). $PipxCommand is the pipx invocation to probe
# (e.g. @('python', '-m', 'pipx') for a pipx installed but not on PATH yet);
# default: Get-CoopPipxCmd. Twin of coop_pipx_fetch_python_flag.
function Get-CoopPipxFetchPythonFlag([string[]]$PipxCommand = @()) {
  if (-not $PipxCommand -or $PipxCommand.Count -eq 0) { $PipxCommand = @((Get-CoopPipxCmd)) }
  $exe = $PipxCommand[0]
  if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { return '' }
  $rest = @($PipxCommand | Select-Object -Skip 1) + @('install', '--help')
  $help = (& $exe @rest 2>&1 | Out-String)
  if ($help -match '--fetch-python') { return '--fetch-python=missing' }
  if ($help -match '--fetch-missing-python') { return '--fetch-missing-python' }
  return ''
}

# How the Fabric CLI's pipx environment gets a supported interpreter: an object
# { Python; FetchFlag } — a local 3.10-3.13 interpreter (FetchFlag ''), or '3.12'
# plus the flag from Get-CoopPipxFetchPythonFlag when only pipx's standalone
# download can supply one. $null when neither is possible — then prerequisite
# row 3 (Get-CoopPrereqs) says what to install. Shared by install, update and
# `coop doctor --fix`, so every path builds the environment the same way:
#   pipx install [--force] [<FetchFlag>] --python <Python> ms-fabric-cli==<pin>
# Twin of coop_fabric_pipx_plan.
function Get-CoopFabricPipxPlan {
  $py = Get-CoopFabricBootstrapPython
  $flag = ''
  if (-not $py) {
    $flag = Get-CoopPipxFetchPythonFlag
    if (-not $flag) { return $null }
    $py = '3.12'
  }
  return [pscustomobject]@{ Python = [string]$py; FetchFlag = [string]$flag }
}

function Get-CoopVenvPythonPath([string]$Venv) {
  $base = Join-Path (Get-CoopPipxVenvsDir) $Venv
  foreach ($py in @((Join-Path $base 'Scripts\python.exe'), (Join-Path $base 'bin\python'), (Join-Path $base 'bin/python'))) {
    if (Test-Path -LiteralPath $py) { return $py }
  }
  return $null
}

# Exact runtime for live Fabric SQL. The managed ms-fabric-cli environment is
# the default; COOP_FABRIC_PYTHON is operator-managed and never mutated.
function Get-CoopFabricPython {
  $py = if ($env:COOP_FABRIC_PYTHON) { $env:COOP_FABRIC_PYTHON } else { Get-CoopVenvPythonPath 'ms-fabric-cli' }
  if (-not $py -or -not [System.IO.Path]::IsPathRooted($py) -or -not (Test-Path -LiteralPath $py -PathType Leaf)) { return $null }
  & $py -c 'import sys; raise SystemExit(0 if sys.executable else 1)' *> $null
  if ($LASTEXITCODE -ne 0) { return $null }
  return $py
}

function Get-CoopFabricSqlRuntimeStatus {
  $py = Get-CoopFabricPython
  if (-not $py) { return [pscustomobject]@{ state = 'runtime_missing'; version = ''; driver = 0 } }
  $pin = Coop-ManifestGet -Key 'python_tools.pyodbc'
  $probe = @'
import importlib.metadata as m,re,sys
pin=sys.argv[1]
try:
 v=m.version("pyodbc")
except Exception:
 print("pyodbc_missing"); raise SystemExit(2)
if v != pin:
 print("pyodbc_wrong\t"+v); raise SystemExit(3)
try:
 import pyodbc
except Exception:
 print("pyodbc_unloadable"); raise SystemExit(4)
majors=[int(x.group(1)) for d in pyodbc.drivers() for x in [re.fullmatch(r"ODBC Driver ([0-9]+) for SQL Server",d)] if x]
if not majors or max(majors) < 18:
 print("driver_missing\t"+v); raise SystemExit(5)
print("ready\t"+v+"\t"+str(max(majors)))
'@
  # Pass Python source on stdin, not through PowerShell 5.1 native quoting.
  try {
    $probeLines = @($probe | & $py - $pin 2>$null)
    $probeRc = $LASTEXITCODE
  } catch {
    return [pscustomobject]@{ state = 'pyodbc_unloadable'; version = ''; driver = 0 }
  }
  $line = [string]($probeLines | Select-Object -First 1)
  $parts = @($line -split "`t")
  $expectedExit = @{ ready = 0; pyodbc_missing = 2; pyodbc_wrong = 3; pyodbc_unloadable = 4; driver_missing = 5 }
  if ($probeLines.Count -ne 1 -or -not $expectedExit.ContainsKey($parts[0]) -or $probeRc -ne $expectedExit[$parts[0]]) {
    return [pscustomobject]@{ state = 'pyodbc_unloadable'; version = ''; driver = 0 }
  }
  return [pscustomobject]@{ state = $(if ($parts.Count) { $parts[0] } else { 'pyodbc_unloadable' }); version = $(if ($parts.Count -gt 1) { $parts[1] } else { '' }); driver = $(if ($parts.Count -gt 2) { [int]$parts[2] } else { 0 }) }
}

function Sync-CoopFabricPythonPackages([bool]$Edge = $false) {
  if (-not $env:COOP_FABRIC_PYTHON) {
    $pipx = Get-CoopPipxCmd
    foreach ($pkg in @('fabric-cicd', 'pyodbc')) {
      $pin = Coop-ManifestGet -Key "python_tools.$pkg"
      if (-not $pin) { return $false }
      $spec = if ($Edge -and $pkg -eq 'fabric-cicd') { $pkg } else { "$pkg==$pin" }
      & $pipx inject ms-fabric-cli $spec --force *> $null
      if ($LASTEXITCODE -ne 0) { Coop-Warn "failed to install $spec in the ms-fabric-cli environment"; return $false }
    }
  }
  $status = Get-CoopFabricSqlRuntimeStatus
  return ($status.state -eq 'ready' -or $status.state -eq 'driver_missing')
}

function Ensure-CoopFabricOdbcDriver([bool]$AllowPrereqs = $true) {
  $status = Get-CoopFabricSqlRuntimeStatus
  if ($status.state -eq 'ready') { return $true }
  if ($status.state -ne 'driver_missing') { return $false }
  if ($env:OS -ne 'Windows_NT') {
    Coop-Warn 'ODBC Driver 18+ for SQL Server is missing' 'install Microsoft ODBC Driver 18 for SQL Server, then run: coop doctor'
    return $true
  }
  if (-not $AllowPrereqs) { Coop-Warn 'ODBC Driver 18+ is missing (--no-prereqs)' 'install Microsoft.msodbcsql.18, then run: coop doctor'; return $false }
  if (-not (Coop-Confirm 'Install Microsoft ODBC Driver 18 for SQL Server and accept its license?')) {
    Coop-Warn 'ODBC Driver 18+ is required; license was not accepted' 're-run with --yes or install Microsoft.msodbcsql.18 manually'
    return $false
  }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { Coop-Warn 'winget is required to install ODBC Driver 18 automatically' 'install Microsoft.msodbcsql.18 manually, then run: coop doctor'; return $false }
  & $winget.Source install --id Microsoft.msodbcsql.18 -e --source winget --accept-source-agreements --accept-package-agreements --silent --disable-interactivity *> $null
  if ($LASTEXITCODE -ne 0) { Coop-Warn 'ODBC Driver 18 installation failed' 'run an elevated terminal or install Microsoft.msodbcsql.18 manually, then run: coop doctor'; return $false }
  $after = Get-CoopFabricSqlRuntimeStatus
  if ($after.state -ne 'ready') { Coop-Warn 'ODBC Driver 18 installation completed but the selected Fabric runtime cannot see it' 'open a new terminal, then run: coop doctor'; return $false }
  return $true
}

# The installed distribution's own Requires-Python metadata, read from inside
# its venv. The probe program carries a marker so fixture interpreters can
# recognise it in tests.
function Get-CoopVenvRequiresPython([string]$Venv, [string]$Distribution) {
  $py = Get-CoopVenvPythonPath $Venv
  if (-not $py) { return '' }
  $probe = @'
# coop-requires-python-probe
import sys
from importlib.metadata import metadata
print(metadata(sys.argv[1]).get("Requires-Python") or "")
'@
  # Pass the program on stdin: Windows PowerShell 5.1 does not escape the double quotes
  # in a native argument, so `-c $probe` reached Python as a SyntaxError and doctor
  # silently skipped the Requires-Python check.
  $out = (($probe | & $py - $Distribution 2>$null) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { return '' }
  return $out
}

# Evaluate <Version> against a PEP 440 Requires-Python specifier subset:
# comma-separated <, <=, >, >=, ==, != tokens (optionally "X.Y.*" wildcards).
# Anything unparseable counts as matching — never warn on uncertainty.
function Test-CoopPythonSpec([string]$PyVer, [string]$Spec) {
  if (-not $Spec) { return $true }
  function Key([string]$v) {
    $v = $v.TrimStart('v') -replace '[^0-9.].*$', ''
    $p = ($v -split '\.') + @('0','0','0')
    return [int]$p[0] * 1000000 + [int]$p[1] * 1000 + [int]($p[2] -as [int])
  }
  $keyPy = Key $PyVer
  foreach ($tok in ($Spec -split ',')) {
    $t = $tok.Trim()
    if (-not $t) { continue }
    if ($t.StartsWith('~=')) { return $true }                       # not approximated here
    if ($t -notmatch '[0-9]') { return $true }                      # no version -> no verdict
    $op = ''; $want = ''
    foreach ($candidate in @('==','!=','>=','<=','>','<')) {
      if ($t.StartsWith($candidate)) { $op = $candidate; $want = $t.Substring($candidate.Length); break }
      elseif ($t.StartsWith($candidate.Substring(0,1)) -and $candidate.Length -eq 1) { $op = $candidate; $want = $t.Substring(1); break }
    }
    if (-not $op) { return $true }
    $wild = $false
    if ($want.EndsWith('.*') -or $want.EndsWith('*')) { $wild = $true; $want = $want.TrimEnd('*').TrimEnd('.') }
    $want = $want.TrimStart('v')
    if (-not $want -or $want -match '[^0-9.]') { return $true }
    $keyWant = Key $want
    if ($wild) {
      $parts = ($want -split '\.').Count
      $scale = 1
      for ($i = 3; $i -gt $parts; $i--) { $scale *= 1000 }
      $modW = [math]::Floor($keyWant / $scale); $modP = [math]::Floor($keyPy / $scale)
      if ($op -eq '==' -and $modP -ne $modW) { return $false }
      if ($op -eq '!=' -and $modP -eq $modW) { return $false }
      continue
    }
    switch ($op) {
      '<'  { if (-not ($keyPy -lt $keyWant)) { return $false } }
      '<=' { if (-not ($keyPy -le $keyWant)) { return $false } }
      '>'  { if (-not ($keyPy -gt $keyWant)) { return $false } }
      '>=' { if (-not ($keyPy -ge $keyWant)) { return $false } }
      '==' { if ($keyPy -ne $keyWant) { return $false } }
      '!=' { if ($keyPy -eq $keyWant) { return $false } }
    }
  }
  return $true
}

# Which pipx venv does <command> resolve to? Returns venv name or $null.
function Get-CoopExePipxVenv([string]$Command) {
  # Ownership probe: which pipx venv exposes <command>?
  #   1. follow the full symlink chain (unix shims),
  #   2. compare against raw AND physically-resolved venv prefixes,
  #   3. fall back to pipx's own application metadata (`pipx list --json`),
  #      the only reliable source for Windows .exe launchers exposed OUTSIDE
  #      the venv (binary stubs carry no readable path).
  $cmd = Get-Command $Command -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  $p = $cmd.Source

  $vdir = (Get-CoopPipxVenvsDir)
  $vdirReal = $vdir
  try { $vdirReal = (Resolve-Path -LiteralPath $vdir -ErrorAction Stop).Path } catch {}
  $isUnder = {
    param($path, $base)
    if (-not $path) { return $false }
    $np = $path.Replace('\', '/'); $nb = $base.Replace('\', '/')
    return $np.StartsWith($nb + '/', [System.StringComparison]::OrdinalIgnoreCase)
  }

  # 1-2. Path membership across the symlink chain.
  $cur = $p
  for ($hop = 0; $hop -lt 4 -and $cur; $hop++) {
    if (& $isUnder $cur $vdir) {
      $rest = $cur.Replace('\', '/').Substring(($vdir.Replace('\', '/')).Length).TrimStart('/')
      return ($rest -split '/')[0]
    }
    if (& $isUnder $cur $vdirReal) {
      $rest = $cur.Replace('\', '/').Substring(($vdirReal.Replace('\', '/')).Length).TrimStart('/')
      return ($rest -split '/')[0]
    }
    $item = Get-Item -LiteralPath $cur -Force -ErrorAction SilentlyContinue
    if (-not $item) { break }
    $tgt = $null
    if ($item.PSObject.Properties['Target'] -and $item.Target) { $tgt = @($item.Target)[0] }
    if (-not $tgt) { break }
    if (-not [System.IO.Path]::IsPathRooted($tgt)) { $tgt = Join-Path (Split-Path -Parent $cur) $tgt }
    $cur = $tgt
  }

  # 3. pipx application metadata: map an executable exposed in PIPX_BIN_DIR
  # back to the venv whose main package declares that app name. Windows launchers
  # are binary .exe files outside the venv, so neither shebang nor target-path
  # inspection can establish their ownership.
  $pipxBin = Get-CoopPipxCmd
  if (Get-Command $pipxBin -ErrorAction SilentlyContinue) {
    $pipxBinDir = [string]((& $pipxBin environment --value PIPX_BIN_DIR 2>$null | Out-String)).Trim()
    if (-not $pipxBinDir) { return $null }
    $pipxBinDirReal = $pipxBinDir
    try { $pipxBinDirReal = (Resolve-Path -LiteralPath $pipxBinDir -ErrorAction Stop).Path } catch {}
    $parent = Split-Path -Parent $p
    $parentReal = $parent
    try { $parentReal = (Resolve-Path -LiteralPath $parent -ErrorAction Stop).Path } catch {}
    $normParent = $parent.Replace('\', '/').TrimEnd('/')
    $normParentReal = $parentReal.Replace('\', '/').TrimEnd('/')
    $normBin = $pipxBinDir.Replace('\', '/').TrimEnd('/')
    $normBinReal = $pipxBinDirReal.Replace('\', '/').TrimEnd('/')
    $inPipxBin = $normParent.Equals($normBin, [System.StringComparison]::OrdinalIgnoreCase) -or
                 $normParentReal.Equals($normBinReal, [System.StringComparison]::OrdinalIgnoreCase)
    if (-not $inPipxBin) { return $null }

    $json = [string]((& $pipxBin list --json 2>$null | Out-String))
    if ($json.Trim()) {
      try { $data = $json | ConvertFrom-Json } catch { $data = $null }
      if ($data -and $data.venvs) {
        # pipx 1.x on Windows lists apps WITH their extension ("fab.exe") while
        # older installs / unix list bare names — compare both forms (-eq is
        # case-insensitive in PowerShell) so a healthy install never false-warns.
        $app = [System.IO.Path]::GetFileNameWithoutExtension($p)
        $raw = [System.IO.Path]::GetFileName($p)
        foreach ($venv in $data.venvs.PSObject.Properties) {
          foreach ($a in @($venv.Value.metadata.main_package.apps)) {
            if ([System.IO.Path]::GetFileNameWithoutExtension([string]$a) -eq $app -or [string]$a -eq $raw) { return $venv.Name }
          }
        }
      }
    }
  }
  return $null
}

# Select an npm that actually WORKS: some workstation shims exit 0 while doing
# nothing (observed with a broken ~/.hermes/node/bin/npm), which silently
# no-ops convergence. Requires real version output.
function Get-CoopWorkingNpm {
  # Windows commonly exposes BOTH npm.ps1 and npm.cmd. Without Select-Object,
  # `.Source` becomes an array and `& $cand --version` passes the second launcher
  # as argv[0] (effectively `npm npm --version`). Prefer the native .cmd shim.
  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $npmCommand) { $npmCommand = Get-Command npm -ErrorAction SilentlyContinue | Select-Object -First 1 }
  $cand = if ($npmCommand) { $npmCommand.Source } else { $null }
  if ($cand) {
    $v = [string]((& $cand --version 2>$null | Out-String)).Trim()
    if ($v) { return $cand }
  }
  $candidates = @('/opt/homebrew/bin/npm')
  if (${env:ProgramFiles}) { $candidates += (Join-Path ${env:ProgramFiles} 'nodejs\npm.cmd') }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\npm.cmd') }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) {
      $v = [string]((& $c --version 2>$null | Out-String)).Trim()
      if ($v) { return $c }
    }
  }
  return $null
}

# Converge the isolated tree's recorded extension dependencies to EXACT
# versions and reinstall (twin of coop_converge_extension_pins). PRODUCTION
# convergence: the compatibility matrix relies on this same path.
function Sync-CoopExtensionPins([string]$AgentDir, [string[]]$Specs) {
  # NOTE: forward slashes throughout — backslashes leak into node/npm argv on
  # any host and corrupt paths (observed as ENOENT on POSIX).
  $npmDir = Join-Path $AgentDir 'npm'
  if (-not (Test-Path -LiteralPath (Join-Path $npmDir 'package.json'))) {
    # Bootstrap the npm project exactly like the bash helper does.
    New-Item -ItemType Directory -Force -Path $npmDir | Out-Null
    Set-Content -LiteralPath (Join-Path $npmDir 'package.json') -Value "{`n  `"name`": `"pi-extensions`",`n  `"private`": true`n}"
  }
  if (-not (Test-Have 'node')) { return $false }
  # Skip the reinstall when every extension is already at its exact pin.
  $need = $false
  foreach ($spec in $Specs) {
    $i = $spec.LastIndexOf('@')
    $got = Get-CoopExtInstalledVersion -AgentDir $AgentDir -Name $spec.Substring(0, $i)
    if ($got -ne $spec.Substring($i + 1)) { $need = $true; break }
  }
  # `pi install` already lands every extension at its exact pin, so the fast
  # path alone would never reach the lockfile (seen on the VM, #152): a tree
  # whose package-lock.json is not the shipped lock still needs the npm ci.
  $piVer = Get-CoopPiVersion
  if (-not $need -and (Test-CoopExtensionsLockPending -AgentDir $AgentDir -PiVersion $piVer)) { $need = $true }
  if (-not $need) { return $true }
  $npm = Get-CoopWorkingNpm
  if (-not $npm) { return $false }
  node (Join-Path $script:CoopRoot 'lib\pins.js') $AgentDir @Specs
  if ($LASTEXITCODE -ne 0) { return $false }
  # This npm install auto-installs peers. Pin the agent peer (and pi-ai/pi-tui) to
  # the running Pi first (#122); unpinned, npm fetched the newest agent into the
  # tree seconds after upstream published it. Best-effort, like the alignment.
  $py = Get-CoopPython
  if ($piVer -and $py) {
    & $py (Join-Path $script:CoopRoot 'lib\_extdeps.py') align $AgentDir $piVer *> $null
  }
  # Reproducible path (#152): the release ships npm's lockfile for this exact
  # extension set, so `npm ci` installs the same transitive versions on every
  # machine. Falls back to a plain install when the lock cannot apply.
  if (Install-CoopExtensionsLock -AgentDir $AgentDir -Npm $npm -PiVersion $piVer) { return $true }
  Push-Location $npmDir
  $npmOut = @(& $npm install --silent --no-audit --no-fund 2>&1)
  $rc = $LASTEXITCODE
  Pop-Location
  if ($rc -ne 0) {
    $detail = ((@($npmOut | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ }) | Select-Object -Last 8) -join ' | ')
    Coop-Warn ("npm extension convergence failed via {0}{1}" -f $npm, $(if ($detail) { ": $detail" } else { '' }))
  }
  return ($rc -eq 0)
}

# Install the isolated tree from the release lockfile (config/extensions-lock.json,
# generated by `node lib/extlock.js generate`; issue #152). Applies only when the
# lock can hold: the installed Pi is the manifest's Pi (the lock resolves pi-ai /
# pi-tui / the agent peer to that version, so an --edge or matrix Pi needs a live
# resolution) and the tree's package.json declares exactly the lock's root
# dependencies (`npm ci` refuses anything else). Returns $true when the tree was
# installed from the lock; $false when the lock does not apply (caller resolves
# live) or `npm ci` failed (the caller's install then repairs the tree). Mirror
# of coop_apply_extensions_lock. Lifecycle scripts run as they do for a plain
# install (better-sqlite3, context-mode and sharp build or fetch their binaries).
# SHA-256 of a file as an upper-case hex string, through .NET rather than
# Get-FileHash: Windows PowerShell 5.1 started by coop.cmd from a PowerShell 7
# window inherits pwsh's PSModulePath and cannot load Microsoft.PowerShell.Utility's
# Get-FileHash ("not recognized", seen on the VM 2026-10-01); the .NET type is
# always there. Returns '' for a missing file.
function Get-CoopFileSha256([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '')
  } finally {
    $stream.Dispose(); $sha.Dispose()
  }
}

# True when the shipped lock applies to this install (lock present, installed Pi
# is the manifest's Pi) but the tree does not carry it yet: no package-lock.json
# beside the tree's package.json, or one that differs from
# config\extensions-lock.json. Mirror of coop_extensions_lock_pending.
function Test-CoopExtensionsLockPending([string]$AgentDir, [string]$PiVersion) {
  $lock = Join-Path $script:CoopRoot 'config\extensions-lock.json'
  if (-not (Test-Path -LiteralPath $lock)) { return $false }
  $want = Coop-ManifestGet -Key 'pi.version'
  if (-not $want -or $PiVersion -ne $want) { return $false }
  $a = Get-CoopFileSha256 $lock
  # A lock this machine could not install is not retried until a new one ships.
  $failed = Join-Path $AgentDir 'npm\.coop-lock-failed.json'
  if ((Test-Path -LiteralPath $failed) -and ((Get-CoopFileSha256 $failed) -eq $a)) { return $false }
  $treeLock = Join-Path $AgentDir 'npm\package-lock.json'
  if (-not (Test-Path -LiteralPath $treeLock)) { return $true }
  $b = Get-CoopFileSha256 $treeLock
  return ($a -ne $b)
}

function Install-CoopExtensionsLock([string]$AgentDir, [string]$Npm, [string]$PiVersion) {
  $lock = Join-Path $script:CoopRoot 'config\extensions-lock.json'
  if (-not (Test-Path -LiteralPath $lock)) { return $false }
  if (-not (Test-Have 'node')) { return $false }
  $want = Coop-ManifestGet -Key 'pi.version'
  if (-not $want -or $PiVersion -ne $want) { return $false }
  node (Join-Path $script:CoopRoot 'lib\extlock.js') matches $AgentDir $lock *> $null
  if ($LASTEXITCODE -ne 0) { return $false }
  $npmDir = Join-Path $AgentDir 'npm'
  $treeLock = Join-Path $npmDir 'package-lock.json'
  # A lock this machine already failed to install is not retried (even on a
  # wiped tree) until a new lock ships; the caller's plain install converges.
  $failed = Join-Path $npmDir '.coop-lock-failed.json'
  if ((Test-Path -LiteralPath $failed) -and ((Get-CoopFileSha256 $failed) -eq (Get-CoopFileSha256 $lock))) { return $false }
  try { Copy-Item -LiteralPath $lock -Destination $treeLock -Force } catch { return $false }
  # Lifecycle scripts run as in a plain install. npm builds the nodes it installs
  # from the lock entries, so lib/extlock.js carries `gypfile: false` into the
  # lock for packages that ship their binary (better-sqlite3 13); without it npm
  # ran a bare `node-gyp rebuild` on the Windows VM and failed.
  Push-Location $npmDir
  try {
    & $Npm ci --no-audit --no-fund *> $null
    $rc = $LASTEXITCODE
  } catch { $rc = 1 } finally { Pop-Location }
  if ($rc -eq 0) {
    Remove-Item -LiteralPath $failed -Force -ErrorAction SilentlyContinue
    return $true
  }
  # Remember this lock as failed so the next sync does not tear the tree down
  # again; the caller's plain install repairs the tree now.
  Remove-Item -LiteralPath $treeLock -Force -ErrorAction SilentlyContinue
  try { Copy-Item -LiteralPath $lock -Destination $failed -Force } catch {}
  return $false
}

# Version of an installed Pi extension inside an isolated agent dir, read from
# its package.json. Empty when absent or unreadable — callers treat that as a
# failed postcondition, never as success.
function Get-CoopExtInstalledVersion([string]$AgentDir, [string]$Name) {
  $f = Join-Path $AgentDir "npm\node_modules\$Name\package.json"
  if (-not (Test-Path -LiteralPath $f)) { return '' }
  try {
    $pkg = Get-Content -LiteralPath $f -Raw | ConvertFrom-Json
    if ($pkg.version -and -not [string]::IsNullOrWhiteSpace($pkg.version)) { return [string]$pkg.version }
  } catch {}
  return ''
}

# Ensure user tool bins (pipx, Azure CLI) are on PATH in-process
$script:PathSep = [System.IO.Path]::PathSeparator
$pipxBin = Join-Path $HOME '.local\bin'
if ((Test-Path -LiteralPath $pipxBin) -and (($env:PATH -split $script:PathSep) -notcontains $pipxBin)) {
  $env:PATH = "$pipxBin$script:PathSep$env:PATH"
}
foreach ($d in (@(
  $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Microsoft SDKs\Azure\CLI2\wbin' }),
  $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Microsoft SDKs\Azure\CLI2\wbin' }),
  $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\Microsoft\Azure CLI\wbin' })
) | Where-Object { $_ })) {
  if ((Test-Path -LiteralPath $d) -and (($env:PATH -split $script:PathSep) -notcontains $d)) {
    $env:PATH = "$env:PATH$script:PathSep$d"
  }
}

# --- Colors (respect NO_COLOR and non-TTY) -----------------------------------
# Cooptimize brand palette (truecolor). Folds "is stderr a real console" in, so
# redirected output gets plain text — mirror of common.sh's [ -t 2 ] check.
$script:CoopColor = ($null -eq $env:NO_COLOR -or $env:NO_COLOR -eq '') -and -not [Console]::IsErrorRedirected
$e = [char]27
if ($script:CoopColor) {
  $script:C_NAVY   = "$e[38;2;0;65;107m"
  $script:C_FOREST = "$e[38;2;66;120;60m"
  $script:C_OLIVE  = "$e[38;2;130;170;67m"
  $script:C_LIME   = "$e[38;2;178;210;53m"
  $script:C_RED    = "$e[38;2;239;65;45m"
  $script:C_BOLD   = "$e[1m"
  $script:C_DIM    = "$e[2m"
  $script:C_RST    = "$e[0m"
} else {
  $script:C_NAVY = ''; $script:C_FOREST = ''; $script:C_OLIVE = ''; $script:C_LIME = ''; $script:C_RED = ''
  $script:C_BOLD = ''; $script:C_DIM = ''; $script:C_RST = ''
}
function Coop-Navy { $script:C_NAVY }
function Coop-Bold { $script:C_BOLD }
function Coop-Dim  { $script:C_DIM }
function Coop-Rst  { $script:C_RST }

# Status glyphs (defined with [char] codepoints for Windows PowerShell 5.1 compat).
$script:G_BULLET = [char]0x2022   # •
$script:G_CHECK  = [char]0x2713   # ✓
$script:G_CROSS  = [char]0x2717   # ✗

# --- Progress: one determinate "overall" bar + an animated active-item line ---
# Mirror of common.sh. Built for installers where each item (npm/pipx/pi install)
# takes a while and its own % is unknowable. The bar is determinate at the ITEM
# level (total known up front); the active item shows a braille spinner + elapsed
# seconds so it is obviously alive. Animates only when stderr is a real console;
# otherwise the loggers fall through to plain lines and units print "<label>…".
$script:ProgActive   = $false
$script:ProgTotal    = 0
$script:ProgDone     = 0
$script:ProgW        = 22
$script:ProgCols     = 80
$script:ProgSpinline = ''
$script:SpinFrames   = @(
  [char]0x280B, [char]0x2819, [char]0x2839, [char]0x2838, [char]0x283C,
  [char]0x2834, [char]0x2826, [char]0x2827, [char]0x2807, [char]0x280F
)
$script:UseThreadJob = [bool](Get-Command Start-ThreadJob -ErrorAction SilentlyContinue)

function Test-ProgTty { $script:CoopColor }   # already folds in -not IsErrorRedirected

function Coop-ProgBar {
  $total = if ($script:ProgTotal -gt 0) { $script:ProgTotal } else { 1 }
  $done  = [Math]::Min([int]$script:ProgDone, [int]$total)
  $w     = $script:ProgW
  $fill  = [int][Math]::Floor($done * $w / $total)
  $pct   = [int][Math]::Floor($done * 100 / $total)
  $on    = ([string][char]0x2588) * $fill
  $off   = ([string][char]0x2591) * ($w - $fill)
  "  [$($script:C_LIME)$on$($script:C_DIM)$off$($script:C_RST)] $done/$total  $pct%"
}

function Coop-ProgSpin {
  param([string]$Glyph, [string]$Label, [int]$Elapsed)
  $max = $script:ProgCols - 14
  if ($max -lt 8)  { $max = 8 }
  if ($max -gt 48) { $max = 48 }
  if ($Label.Length -gt $max) { $Label = $Label.Substring(0, $max - 1) + [char]0x2026 }
  "  $($script:C_LIME)$Glyph$($script:C_RST) $Label $($script:C_DIM)(${Elapsed}s)$($script:C_RST)"
}

# Draw the 2-line region (bar + active item), parking the cursor back at the start
# of the bar line. Relative moves only, so scrolling at the bottom edge stays sane.
function Coop-ProgDraw {
  if (-not (Test-ProgTty)) { return }
  $x = [char]27
  [Console]::Error.Write("`r$x[2K" + (Coop-ProgBar) + "`n")
  [Console]::Error.Write("$x[2K" + $script:ProgSpinline)
  [Console]::Error.Write("$x[1A`r")
}

# Erase the 2-line region, leaving the cursor at the (now empty) bar line, col 0.
function Coop-ProgLift {
  if (-not (Test-ProgTty)) { return }
  $x = [char]27
  [Console]::Error.Write("`r$x[2K")
  [Console]::Error.Write("`n$x[2K")
  [Console]::Error.Write("$x[1A`r")
}

function Coop-ProgBegin {
  param([int]$Total)
  $script:ProgTotal = $Total; $script:ProgDone = 0; $script:ProgSpinline = ''; $script:ProgActive = $true
  try { $script:ProgCols = [Console]::WindowWidth } catch { $script:ProgCols = 80 }
  if ($script:ProgCols -lt 1) { $script:ProgCols = 80 }
  if (Test-ProgTty) { [Console]::Error.Write("$([char]27)[?25l"); Coop-ProgDraw }   # hide cursor, draw 0%
}

function Coop-ProgEnd {
  if ($script:ProgActive -and (Test-ProgTty)) {
    Coop-ProgLift
    $script:ProgSpinline = ''
    [Console]::Error.WriteLine((Coop-ProgBar))            # leave a permanent completed bar
    [Console]::Error.Write("$([char]27)[?25h")            # restore cursor
  }
  $script:ProgActive = $false
}

# --- Logging (progress-aware: lift the pinned bar, print above it, redraw) -----
# All log lines go to stderr. When no progress region is active (the common case —
# doctor/sync/dispatcher) this is a plain WriteLine, exactly as before.
function Coop-Emit {
  param([string]$Line)
  # Non-TTY branch. The [Console]::Error contract is load-bearing: callers and
  # fixtures replace it via [Console]::SetError($writer) to capture output, so
  # emission MUST go through [Console]::Error. But on Windows PowerShell 5.1 in
  # a nested `powershell -File` context (CI legs invoke fixtures this way)
  # [Console]::Error.WriteLine can throw System.IO.FileLoadException ("assembly
  # name or codebase ... was invalid", observed on GitHub Actions run
  # 34696119275: fresh-install prerequisite leg at this line, and inside the
  # knowledge-timeout fixture's Start-Job). Emission is cosmetic status output:
  # never let it crash install/update/doctor, so fall back in tiers —
  #   1. [Console]::Error.WriteLine  (normal, honors SetError capture)
  #   2. the replaced TextWriter via the [Console]::Error property (same
  #      contract, avoids the method that fails to JIT on those hosts)
  #   3. the PowerShell host API (redirectable; last resort)
  # TTY redraw branch below is unchanged. POSIX twin: printf >&2 in
  # lib/common.sh (already redirectable — parity preserved).
  if ($script:ProgActive -and (Test-ProgTty)) {
    Coop-ProgLift
    [Console]::Error.WriteLine($Line)
    Coop-ProgDraw
  } else {
    $emitted = $false
    try { [Console]::Error.WriteLine($Line); $emitted = $true } catch { }
    if (-not $emitted) {
      try { $writer = [Console]::Error; $writer.WriteLine($Line); $emitted = $true } catch { }
    }
    if (-not $emitted) {
      if ($Host.UI -and $Host.UI.WriteErrorLine) { $Host.UI.WriteErrorLine($Line) }
    }
  }
}
function Coop-Say  { param([string]$m) Coop-Emit $m }
function Coop-Info { param([string]$m) Coop-Emit "$($script:C_LIME)$($script:G_BULLET)$($script:C_RST) $m" }
function Coop-Ok   { param([string]$m) Coop-Emit "$($script:C_FOREST)$($script:G_CHECK)$($script:C_RST) $m" }
# Optional second argument is the "how to fix" hint (mirror of coop_warn "$1" "$2").
function Coop-Warn { param([string]$m, [string]$Hint = '') Coop-Emit ("$($script:C_OLIVE)!$($script:C_RST) $m" + $(if ($Hint) { " — $Hint" } else { '' })) }
function Coop-Err  { param([string]$m) Coop-Emit "$($script:C_RED)$($script:G_CROSS)$($script:C_RST) $m" }
function Coop-Die  { param([string]$m) Coop-Err $m; exit 1 }
function Coop-Head { param([string]$m) Coop-Emit "`n$($script:C_BOLD)$($script:C_NAVY)$m$($script:C_RST)" }

# --- Small utilities ----------------------------------------------------------
# Is a command available on PATH? (mirror of have())
function Test-Have { param([string]$Name) [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

# Pick a usable python interpreter that ACTUALLY runs — not the Windows Store
# App-Execution-Alias stub. python.org's installer never creates python3.exe, so
# on stock Windows `python3` resolves ONLY to the Store stub under
# ...\WindowsApps\: Get-Command succeeds while `--version` prints nothing.
# Prefer python3, fall back to python; $null when neither is real.
# (mirror of coop_python — THE one python resolver; don't re-add per-script copies)
function Get-CoopPython {
  foreach ($name in @('python3', 'python')) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $c) { continue }
    if ($c.Source -and $c.Source -match '\\WindowsApps\\') { continue }
    $v = (& $c.Source --version 2>&1 | ForEach-Object { $_.ToString() }) -join ' '
    if ($v -match '\d+\.\d+') { return $c.Source }
  }
  return $null
}

# Is Microsoft ODBC Driver 18+ for SQL Server registered? Windows reads the ODBC
# driver list in the registry; elsewhere `odbcinst -q -d` (unixODBC).
function Test-CoopOdbcDriver18 {
  $names = @()
  if ($env:OS -eq 'Windows_NT') {
    $key = Get-Item -LiteralPath 'HKLM:\SOFTWARE\ODBC\ODBCINST.INI\ODBC Drivers' -ErrorAction SilentlyContinue
    if ($key) { $names = @($key.GetValueNames()) }
  } elseif (Test-Have 'odbcinst') {
    $names = @(& odbcinst -q -d 2>$null | ForEach-Object { ([string]$_).Trim('[', ']', ' ') })
  }
  foreach ($n in $names) {
    if ($n -match '^ODBC Driver (\d+) for SQL Server$' -and [int]$Matches[1] -ge 18) { return $true }
  }
  return $false
}

# --- Prerequisite gate: ONE ordered table shared by install and doctor ----------
# Rows are in dependency order. Each row: Order, Name, Required, Ok, Detail, Fix.
# Fix is the exact command to print; ' then ' separates two steps. Install stops
# when a Required row is not Ok; doctor reports the same rows with the same text.
# (mirror of coop_prereq_rows)
function Get-CoopPrereqs([bool]$NoFabric = $false) {
  $win = ($env:OS -eq 'Windows_NT')
  $mac = (-not $win) -and ([string](& uname -s 2>$null) -eq 'Darwin')
  if ($win) {
    $fix = @{
      git = 'winget install --id Git.Git -e'; node = 'winget install --id OpenJS.NodeJS.LTS -e'
      python = 'winget install --id Python.Python.3.12 -e'
      pipx = 'py -3.12 -m pip install --user pipx then py -3.12 -m pipx ensurepath'
      az = 'winget install --id Microsoft.AzureCLI -e'; odbc = 'winget install --id Microsoft.msodbcsql.18 -e'
      pipxUpgrade = $true
    }
  } elseif ($mac) {
    $fix = @{
      git = 'xcode-select --install'; node = 'brew install node'; python = 'brew install python@3.12'
      pipx = 'brew install pipx then pipx ensurepath'; az = 'brew install azure-cli'
      odbc = 'brew tap microsoft/mssql-release https://github.com/Microsoft/homebrew-mssql-release then brew install msodbcsql18'
      pipxUpgrade = $false
    }
  } else {
    $fix = @{
      git = 'sudo apt-get install -y git'; node = 'see https://nodejs.org/en/download'
      python = 'sudo apt-get install -y python3.12 python3.12-venv'
      pipx = 'sudo apt-get install -y pipx then pipx ensurepath'
      az = 'curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash'
      odbc = 'see https://learn.microsoft.com/sql/connect/odbc/linux-mac/installing-the-microsoft-odbc-driver-for-sql-server'
      pipxUpgrade = $false
    }
  }
  $ver = { param([string]$Exe) $o = (& $Exe --version 2>&1 | Out-String); $m = [regex]::Match($o, '\d+\.\d+(\.\d+)?'); if ($m.Success) { $m.Value } else { '' } }
  $rows = @()
  $row = { param($o, $n, $req, $ok, $det, $f) [pscustomobject]@{ Order = $o; Name = $n; Required = $req; Ok = [bool]$ok; Detail = $det; Fix = $f } }

  $gitOk = Test-Have 'git'
  $rows += & $row 1 'Git' $true $gitOk $(if ($gitOk) { & $ver 'git' } else { 'not found' }) $fix.git

  $nodeMin = Coop-ManifestGet -Key 'node.min' -Default '22.19.0'
  $nodeOk = $false; $nodeDet = 'not found'
  if (Test-Have 'node') {
    $nv = & $ver 'node'
    if ($nv -and ([version]$nv -ge [version]$nodeMin)) { $nodeOk = $true; $nodeDet = $nv }
    else { $nodeDet = "$(if ($nv) { $nv } else { 'unknown version' }) is older than $nodeMin" }
  }
  $rows += & $row 2 "Node.js $nodeMin or newer" $true $nodeOk $nodeDet $fix.node

  # The Fabric CLI cannot run on 3.14, so it needs 3.10-3.13. A pipx that can
  # fetch a standalone Python (1.5+, Get-CoopPipxFetchPythonFlag) supplies its own
  # 3.12 for the Fabric CLI, so 3.14 plus that pipx also passes. pipx counts here
  # exactly as row 4 counts it: on PATH, or reachable as `<python> -m pipx`.
  $pyOk = $false; $pyDet = 'not found'; $pyFix = $fix.python
  $fabPy = if (-not $NoFabric) { Get-CoopFabricBootstrapPython } else { $null }
  $genPy = Get-CoopPython
  $genVer = if ($genPy) { & $ver $genPy } else { '' }
  $genOk = $genVer -and ([version]$genVer -ge [version]'3.10')
  $pipxDet = 'not found'; $pipxVia = @()
  if (Test-Have 'pipx') { $pipxDet = & $ver 'pipx'; $pipxVia = @('pipx') }
  else {
    foreach ($p in @($fabPy, $genPy)) {
      if (-not $p) { continue }
      & $p -m pipx --version *> $null
      if ($LASTEXITCODE -eq 0) { $pipxDet = "via $p -m pipx"; $pipxVia = @($p, '-m', 'pipx'); break }
    }
  }
  # A general Python that is itself 3.10-3.13 is Fabric-compatible even when the
  # Fabric resolver's probe misses it (#81: Windows PowerShell 5.1 quoting). pipx
  # is probed only when it is the deciding factor (a 3.14+ Python and nothing
  # older), so the row stays cheap.
  $genFabOk = $genOk -and ([version]$genVer -lt [version]'3.14')
  if ($fabPy) { $pyOk = $true; $pyDet = & $ver $fabPy }
  elseif ($genOk -and ($NoFabric -or $genFabOk)) { $pyOk = $true; $pyDet = $genVer }
  elseif ($genOk -and $pipxVia.Count -gt 0 -and (Get-CoopPipxFetchPythonFlag $pipxVia)) {
    $pyOk = $true; $pyDet = "$genVer; pipx fetches 3.12 for the Fabric CLI"
  } elseif ($genOk) {
    $pyDet = "$genVer only; the Fabric CLI needs 3.10-3.13"
    # Windows: a pipx that is present but too old to fetch a Python is repaired
    # without winget or an administrator — upgrading pipx (1.12+) lets it download
    # a standalone 3.12 for the Fabric CLI. Elsewhere the package manager's Python
    # stays the fix (pip --user is refused on Debian-family Pythons, PEP 668).
    if ($pipxVia.Count -gt 0 -and $fix.pipxUpgrade) { $pyFix = "$genPy -m pip install --user --upgrade pipx then $genPy -m pipx ensurepath" }
  }
  elseif ($genVer) { $pyDet = "$genVer is older than 3.10" }
  $rows += & $row 3 'Python 3.10-3.13 (3.12 recommended)' $true $pyOk $pyDet $pyFix

  $rows += & $row 4 'pipx' $true ($pipxVia.Count -gt 0) $pipxDet $fix.pipx

  $azOk = Test-Have 'az'
  $rows += & $row 5 'Azure CLI' $true $azOk $(if ($azOk) { '' } else { 'not found' }) $fix.az

  # Not blocking here: install offers ODBC with its license prompt after the
  # Fabric CLI, and doctor checks that the Fabric runtime can load it.
  $odbcOk = Test-CoopOdbcDriver18
  $rows += & $row 6 'ODBC Driver 18 for SQL Server' $false $odbcOk $(if ($odbcOk) { '' } else { 'not found; needed for live SQL' }) $fix.odbc

  $teOk = Test-Have 'te'
  $rows += & $row 7 'Tabular Editor CLI (optional, BPA reviews)' $false $teOk $(if ($teOk) { '' } else { 'not found' }) 'download te from https://tabulareditor.com/product/features-and-tools/tabular-editor-cli, put it on PATH, then: te auth login'
  return $rows
}

# coop runs Pi against an ISOLATED agent dir so coop's extensions/settings/theme
# never mix with the user's personal `pi`. Override with COOP_AGENT_DIR.
# (mirror of coop_pi_agent_dir)
function Get-CoopPiAgentDir { if ($env:COOP_AGENT_DIR) { $env:COOP_AGENT_DIR } else { Join-Path $HOME '.coop\agent' } }

# The agent dir Pi will ACTUALLY load: PI_CODING_AGENT_DIR when set; with
# COOP_NO_ISOLATE=1 Pi falls back to the personal ~/.pi/agent.
# (mirror of coop_effective_agent_dir)
function Get-CoopEffectiveAgentDir {
  if ($env:PI_CODING_AGENT_DIR) { return $env:PI_CODING_AGENT_DIR }
  if ($env:COOP_NO_ISOLATE -eq '1') { return (Join-Path $HOME '.pi\agent') }
  return (Get-CoopPiAgentDir)
}

# True when Pi has a stored provider credential in the agent tree Coop will
# actually load. Environment-only credentials intentionally do not count: this
# helper gates the one-time interactive /login handoff requested by onboarding.
# Pi writes an empty `{}` auth.json on startup, so a non-empty file is not proof
# of a login (#167): at least one provider entry must be an object.
function Test-CoopPiLoginPresent {
  return (Test-CoopAuthHasCredential (Join-Path (Get-CoopEffectiveAgentDir) 'auth.json'))
}

# True when the given auth.json holds a stored provider credential (#167). Pi
# writes `{}` on startup, so a non-empty file alone is not a login.
# (mirror of coop_auth_has_credential)
function Test-CoopAuthHasCredential {
  param([string]$authPath)
  if (-not $authPath -or -not (Test-Path -LiteralPath $authPath -PathType Leaf)) { return $false }
  try {
    if ((Get-Item -LiteralPath $authPath).Length -eq 0) { return $false }
    $data = Get-Content -LiteralPath $authPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($null -eq $data -or $data -isnot [System.Management.Automation.PSCustomObject]) { return $false }
    foreach ($prop in $data.PSObject.Properties) {
      if ($prop.Value -is [System.Management.Automation.PSCustomObject] -and @($prop.Value.PSObject.Properties).Count -gt 0) { return $true }
    }
    return $false
  } catch { return $false }
}

# Align coop's ISOLATED extension tree's @earendil-works/pi-ai + pi-tui to the Pi
# agent's OWN version (mirror of lib/common.sh coop_align_ext_deps). coop's
# extensions load INTO the running agent, so they must share one pi-ai/pi-tui with
# it; we write an npm `overrides` pin via lib/_extdeps.py and reinstall only when
# the installed tree doesn't already match. Best-effort; never fatal. Lives in the
# shared lib (not sync.ps1) so `coop sync` AND the launch preflight can both call
# the SAME targeted re-pin without the preflight spawning the full sync.
# -AgentDir defaults to the dir Pi will actually load (honors COOP_NO_ISOLATE),
# mirroring the bash helper's internal coop_effective_agent_dir call.
function Sync-CoopExtDeps {
  param([string]$AgentDir = (Get-CoopEffectiveAgentDir))
  if (-not (Test-Have 'pi')) { return }
  $py = Get-CoopPython
  if (-not $py) { return }
  $npmDir = Join-Path $AgentDir 'npm'
  if (-not (Test-Path -LiteralPath (Join-Path $npmDir 'package.json') -PathType Leaf)) { return }
  $ver = Get-CoopPiVersion
  if (-not $ver) { return }
  $extdeps = Join-Path $script:CoopRoot 'lib/_extdeps.py'

  function Read-AlignField {
    param([string[]]$Parts, [int]$Index, [string]$Default = '-')
    if ($Parts.Count -gt $Index) { return $Parts[$Index] } else { return $Default }
  }
  function Invoke-Align {
    param([switch]$Check)
    $a = @($extdeps, 'align', $AgentDir, $ver); if ($Check) { $a += '--check' }
    # Capture the whole output BEFORE reading $LASTEXITCODE — piping a native command
    # into `Select-Object -First 1` terminates it early and leaves $LASTEXITCODE unset.
    $out = (& $py @a 2>$null)
    $code = $LASTEXITCODE
    $line = if ($out) { @($out)[0] } else { '' }
    return @{ rc = $code; parts = $(if ($line) { $line -split '\s+' } else { @() }) }
  }

  # Build the "agent too old" warning from _extdeps.py fields 7 (required floor) and
  # 8 (offending extension); fall back to a generic line when they're absent ('-').
  function Format-TooOld {
    param([string[]]$Parts)
    $req = Read-AlignField $Parts 6; $ext = Read-AlignField $Parts 7
    $need = if ($ext -and $ext -ne '-' -and $req -and $req -ne '-') { "$ext needs pi-ai >= $req" } else { 'an installed extension needs a newer pi-ai' }
    "Pi agent $ver is too old — $need — update the Pi agent: coop update   (or move off the legacy-node20 build)"
  }

  # Branch on the helper's exit code (so an unexpected failure is a clean no-op).
  $r = Invoke-Align
  $treeAi = Read-AlignField $r.parts 0
  if ($r.rc -eq 0) { Coop-Ok "extension pi-ai / pi-tui aligned to pi $ver"; return }
  if ($r.rc -eq 11) { Coop-Warn (Format-TooOld $r.parts); return }
  if ($r.rc -ne 10) { return }   # 2 (nothing) or unexpected — no-op

  $npm = Get-CoopWorkingNpm
  if (-not $npm) {
    Coop-Warn "extension pi-ai/pi-tui need realignment to pi $ver but npm is missing — install Node.js, then: coop sync"
    return
  }
  # Skewed: replace ONLY the two shared libraries. Removing npm's root and hidden
  # lock inventories prevents a manually damaged tree from being credited as the
  # locked version. --ignore-scripts guarantees this repair cannot rebuild an
  # unrelated native dependency such as context-mode's better-sqlite3.
  Coop-Info "aligning extension pi-ai / pi-tui to the agent ($ver; tree has $treeAi)…"
  $scope = Join-Path $npmDir 'node_modules\@earendil-works'
  $ai = Join-Path $scope 'pi-ai'
  $tui = Join-Path $scope 'pi-tui'
  $bak = Join-Path $npmDir '.coop-extdeps-backup'
  Remove-Item -LiteralPath $bak -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $bak | Out-Null
  if (Test-Path -LiteralPath $ai) { Move-Item -LiteralPath $ai -Destination (Join-Path $bak 'pi-ai') -Force }
  if (Test-Path -LiteralPath $tui) { Move-Item -LiteralPath $tui -Destination (Join-Path $bak 'pi-tui') -Force }
  Remove-Item -LiteralPath (Join-Path $npmDir 'package-lock.json'), (Join-Path $npmDir 'node_modules\.package-lock.json') -Force -ErrorAction SilentlyContinue
  $npmOut = @(); $reinstallOk = $false
  Push-Location $npmDir
  try {
    $npmOut = @(& $npm install --no-save --ignore-scripts --no-audit --no-fund ("@earendil-works/pi-ai@" + $ver) ("@earendil-works/pi-tui@" + $ver) 2>&1)
    $reinstallOk = ($LASTEXITCODE -eq 0)
  } catch { $npmOut = @($_) } finally { Pop-Location }
  if ($reinstallOk) {
    Remove-Item -LiteralPath $bak -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Remove-Item -LiteralPath $ai, $tui -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $scope | Out-Null
    if (Test-Path -LiteralPath (Join-Path $bak 'pi-ai')) { Move-Item -LiteralPath (Join-Path $bak 'pi-ai') -Destination $ai -Force }
    if (Test-Path -LiteralPath (Join-Path $bak 'pi-tui')) { Move-Item -LiteralPath (Join-Path $bak 'pi-tui') -Destination $tui -Force }
    Remove-Item -LiteralPath $bak -Recurse -Force -ErrorAction SilentlyContinue
    $detail = ((@($npmOut | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ }) | Select-Object -Last 8) -join ' | ')
    Coop-Warn ("extension realignment reinstall failed — restored the previous shared libraries{0} — check your network, then: coop doctor --fix" -f $(if ($detail) { ": $detail" } else { '' }))
  }
  $r = Invoke-Align -Check
  if ($r.rc -eq 0) { Coop-Ok "extension pi-ai / pi-tui aligned to $ver" }
  elseif ($r.rc -eq 11) { Coop-Warn (Format-TooOld $r.parts) }
  else { Coop-Warn "could not fully align extension pi-ai/pi-tui to $ver — close any running coop session, then: coop doctor --fix" }
}

# --- Azure sign-in preflight (non-fatal) ---------------------------------------
# Before a launch, make sure the Azure CLI can mint the Fabric token, then the
# Power BI token, for the client tenant. The tenant comes from one chain
# (Get-CoopTenant): the project contract's fabric.tenant_id, else ~/.coop/config
# azure.tenant_id (client resources only), else nothing, and then the launch is
# silent and `coop doctor` says what to set. Skipped entirely when
# COOP_SKIP_AZ=1.
#
# When az reports an authentication failure and the launch runs in an
# interactive console (stdin and stderr not redirected, or COOP_ASSUME_YES=1),
# coop runs `az login --tenant <id>` itself: no question, bounded to 5 minutes,
# and Ctrl-C cancels it (read as a key, so it does not stop the launch). With
# -NewWindow (the retired `coop web`, which the old 'coop' shortcut ran in a minimized
# console) the sign-in opens in its own visible window, and a failed, cancelled
# or timed-out sign-in also shows its line in a window until Enter. A timeout or
# a non-authentication error never opens a sign-in. Any failure prints ONE line
# naming the command to run, and the launch continues.
#
# Cached: a verified check stamps the tenant id into <agent-dir>/.az-ok. Tokens
# live ~60 minutes and `az` cold-starts in ~1-3s, so within 30 minutes of a
# success for the SAME tenant no az call is made. A failed check (or a stale,
# missing or mismatched marker) re-checks; marker I/O is best-effort and never
# fails the launch. (mirror of coop_az_preflight)

# Resolve the client Azure tenant (mirror of coop_tenant). The chain and its
# rules live in one place, `lib/warehouse_mcp.py tenant`. Returns
# [pscustomobject]@{ Rc; Tenant }: Rc 0 resolved, 1 none set, 2 not a GUID or a
# domain name (a rejected value is never returned). The contract is the one
# Find-CoopProjectYml finds, the same one `coop doctor` shows.
function Get-CoopTenant {
  $py = Get-CoopPython
  if (-not $py) { return [pscustomobject]@{ Rc = 1; Tenant = '' } }
  $previousEap = $ErrorActionPreference
  $out = ''
  $rc = 1
  try {
    $ErrorActionPreference = 'Continue'
    # One "--project=<path>" token: Windows PowerShell 5.1 drops an empty
    # native argument, and an empty value means "no contract found".
    $proj = Find-CoopProjectYml
    $out = (& $py (Join-Path $script:CoopRoot 'lib\warehouse_mcp.py') tenant "--project=$proj" 2>$null | Out-String).Trim()
    $rc = $LASTEXITCODE
  } catch {
    $out = ''
    $rc = 1
  } finally {
    $ErrorActionPreference = $previousEap
  }
  if ($rc -ne 0 -and $rc -ne 1 -and $rc -ne 2) { $rc = 1 }
  if ($rc -ne 0) { $out = '' }
  # Defence in depth: the value goes into az argv and the cache marker.
  if ($out -and $out -notmatch '^[A-Za-z0-9.-]+$') { $out = ''; $rc = 2 }
  if ($rc -eq 0 -and -not $out) { $rc = 1 }
  return [pscustomobject]@{ Rc = $rc; Tenant = $out }
}

# End a bounded az call and everything it started. Windows: taskkill /T /F,
# because Kill() would leave az.cmd's python.exe running. Elsewhere pwsh 7 can
# kill the whole tree (the az wrapper script runs Python as a child).
function Stop-CoopAzTree {
  param($Process)
  try { if ($Process.HasExited) { return } } catch { return }
  if ($env:OS -eq 'Windows_NT') {
    $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    & $taskkill /PID $Process.Id /T /F *> $null
  } else {
    try { $Process.Kill($true) } catch { try { $Process.Kill() } catch { } }
  }
}

# A PowerShell single-quoted literal for -Text.
function ConvertTo-CoopPsLiteral {
  param([string]$Text)
  "'" + $Text.Replace("'", "''") + "'"
}

# Run -Script in a new visible PowerShell console window and return the process
# (not waited for). -EncodedCommand: no native-argument quoting.
function Start-CoopPsWindow {
  param([string]$Script)
  $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($Script))
  $psExe = (Get-Process -Id $PID).Path
  Start-Process -FilePath $psExe -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded) -PassThru -ErrorAction Stop
}

# Run az with a hard time limit (mirror of coop_az_run). Returns
# [pscustomobject]@{ Rc; Err }: az's exit code, 124 when az was stopped (the
# timeout, or any code above 128 as in bash), 127 when az is missing or its path
# has cmd.exe metacharacters. The child sees AZURE_CORE_LOGIN_EXPERIENCE_V2=off,
# so `az login` never waits on its subscription picker. -AzArgs are literal
# flags plus a validated tenant; Start-Process joins them unquoted, which is
# safe because no argument has spaces or quotes.
#   -Quiet      probes: stdin empty, stdout discarded, stderr read into Err
#               (only classified, never shown; --output none keeps tokens out)
#   (default)   sign-in in this console: stderr stays visible for the browser,
#               WAM and device-code text. Ctrl-C is read as a key while az
#               runs, so it cancels the sign-in (az is ended, Rc 124) instead
#               of stopping coop, as the bash twin's INT trap does.
#   -NewWindow  Windows sign-in in its own visible console window, which
#               closes when az exits (the caller reports any failure)
function Invoke-CoopAz {
  param([int]$Seconds, [string[]]$AzArgs, [switch]$Quiet, [switch]$NewWindow)
  $result = [pscustomobject]@{ Rc = 127; Err = '' }
  # Application only: PowerShell never runs az from the current folder.
  $cmd = Get-Command az -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd -or -not $cmd.Source -or $cmd.Source -match "[`"&|<>^%!`r`n]") { return $result }
  $az = $cmd.Source
  $previousEap = $ErrorActionPreference
  $previousLxv2 = $env:AZURE_CORE_LOGIN_EXPERIENCE_V2
  $previousCtrlC = $null
  $temps = @()
  $errFile = ''
  $p = $null
  try {
    $ErrorActionPreference = 'Continue'
    # Start-Process on Windows PowerShell 5.1 cannot set a child-only variable.
    $env:AZURE_CORE_LOGIN_EXPERIENCE_V2 = 'off'
    if ($NewWindow) {
      # A new PowerShell window runs az. The script is passed with
      # -EncodedCommand: no native-argument quoting.
      $azLine = '& ' + (ConvertTo-CoopPsLiteral $az) + ' ' + (@($AzArgs | ForEach-Object { ConvertTo-CoopPsLiteral $_ }) -join ' ')
      $windowScript = @(
        "`$env:AZURE_CORE_LOGIN_EXPERIENCE_V2 = 'off'",
        $azLine,
        "exit `$LASTEXITCODE"
      ) -join "`n"
      $p = Start-CoopPsWindow $windowScript
    } else {
      $inFile = [System.IO.Path]::GetTempFileName()
      $outFile = [System.IO.Path]::GetTempFileName()
      $temps += $inFile, $outFile
      $start = @{
        FilePath = $az; ArgumentList = $AzArgs; NoNewWindow = $true; PassThru = $true
        RedirectStandardInput = $inFile; RedirectStandardOutput = $outFile; ErrorAction = 'Stop'
      }
      if ($Quiet) {
        $errFile = [System.IO.Path]::GetTempFileName()
        $temps += $errFile
        $start['RedirectStandardError'] = $errFile
      } else {
        # Throws when there is no console input (redirected, CI): Ctrl-C then
        # keeps its default and stops coop, and the finally block ends az.
        try {
          $previousCtrlC = [Console]::TreatControlCAsInput
          [Console]::TreatControlCAsInput = $true
        } catch { $previousCtrlC = $null }
      }
      $p = Start-Process @start
    }
    $null = $p.Handle   # Windows PowerShell 5.1: keeps ExitCode readable after exit
    # Short waits, so a Ctrl-C is noticed promptly: as a key during an
    # in-console sign-in, else it stops this script and the finally block
    # below ends az.
    $deadline = (Get-Date).AddSeconds($Seconds)
    $cancelled = $false
    while (-not $p.WaitForExit(200)) {
      if ($null -ne $previousCtrlC) {
        try {
          while ([Console]::KeyAvailable) {
            $key = [Console]::ReadKey($true)
            if ($key.KeyChar -eq [char]3 -or ($key.Key -eq [ConsoleKey]::C -and ($key.Modifiers -band [ConsoleModifiers]::Control))) { $cancelled = $true }
          }
        } catch { }
        if ($cancelled) { break }
      }
      if ((Get-Date) -ge $deadline) { break }
    }
    if ($p.HasExited) {
      $rc = [int]$p.ExitCode
      if ($rc -gt 128) { $rc = 124 }
      $result.Rc = $rc
    } else {
      Stop-CoopAzTree $p
      $result.Rc = 124
    }
    if ($errFile) {
      try { $result.Err = [System.IO.File]::ReadAllText($errFile) } catch { }
    }
  } catch {
    $result.Rc = 127
  } finally {
    if ($p) { Stop-CoopAzTree $p }
    if ($null -ne $previousCtrlC) { try { [Console]::TreatControlCAsInput = $previousCtrlC } catch { } }
    if ($null -eq $previousLxv2) { Remove-Item Env:\AZURE_CORE_LOGIN_EXPERIENCE_V2 -ErrorAction SilentlyContinue }
    else { $env:AZURE_CORE_LOGIN_EXPERIENCE_V2 = $previousLxv2 }
    foreach ($t in $temps) { Remove-Item -LiteralPath $t -Force -ErrorAction SilentlyContinue }
    $ErrorActionPreference = $previousEap
  }
  return $result
}

# True when az's stderr reports an authentication failure (a sign-in is needed).
# The same markers as lib/fabric_request_headers.mjs (mirror of coop_az_auth_error).
function Test-CoopAzAuthError {
  param([string]$Text)
  if (-not $Text) { return $false }
  $lower = $Text.ToLowerInvariant()
  foreach ($marker in @('az login', 'not logged in', 'login required', 'authentication required',
                        'interaction_required', 'interactionrequired', 'invalid_grant',
                        'aadsts50058', 'aadsts50076', 'aadsts50078', 'aadsts50079', 'aadsts50158')) {
    if ($lower.Contains($marker)) { return $true }
  }
  return $false
}

# Check that az can mint the Fabric token, then the Power BI token, for -Tenant
# (mirror of coop_az_tokens_ok). 15 seconds each; stops at the first failure.
# Returns 0 when both mint, 1 when az reports an authentication failure, 2 for
# any other failure, 124 on timeout.
function Get-CoopAzTokenRc {
  param([string]$Tenant)
  foreach ($resource in @('https://api.fabric.microsoft.com', 'https://analysis.windows.net/powerbi/api')) {
    $r = Invoke-CoopAz -Seconds 15 -Quiet -AzArgs @('account', 'get-access-token', '--tenant', $Tenant, '--resource', $resource, '--output', 'none')
    if ($r.Rc -eq 0) { continue }
    if ($r.Rc -eq 124) { return 124 }
    if (Test-CoopAzAuthError $r.Err) { return 1 }
    return 2
  }
  return 0
}

function Invoke-CoopAzPreflight {
  param([switch]$NewWindow)
  if ($env:COOP_SKIP_AZ -eq '1') { return }
  if (-not (Test-Have 'az')) { return }
  $resolved = Get-CoopTenant
  if ($resolved.Rc -eq 2) {
    Coop-Warn 'Azure tenant id is not a GUID or domain name; skipping Azure sign-in.' 'fix fabric.tenant_id in .coop/project.yml or run: coop onboard --config-only'
    return
  }
  $tenant = $resolved.Tenant
  if (-not $tenant) { return }
  $agentDir = Get-CoopEffectiveAgentDir
  $marker = Join-Path $agentDir '.az-ok'
  # -Force: pwsh on macOS/Linux treats the dot-prefixed marker as hidden.
  $mi = Get-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  if ($mi -and (((Get-Date) - $mi.LastWriteTime).TotalMinutes -lt 30)) {
    $cached = ''
    try { $cached = ([System.IO.File]::ReadAllText($marker)).Trim() } catch { }
    if ($cached -ceq $tenant) { return }
  }
  $rc = Get-CoopAzTokenRc -Tenant $tenant
  $tried = $false
  $interactive = $false
  try { $interactive = (-not [Console]::IsInputRedirected) -and (-not [Console]::IsErrorRedirected) } catch { }
  $inWindow = $NewWindow -and $env:OS -eq 'Windows_NT'
  if ($rc -eq 1 -and ($interactive -or $env:COOP_ASSUME_YES -eq '1')) {
    $tried = $true
    Coop-Info "Opening Azure sign-in for tenant $tenant..."
    $loginArgs = @('login', '--tenant', $tenant, '--allow-no-subscriptions', '--output', 'none')
    if ($inWindow) {
      $login = Invoke-CoopAz -Seconds 300 -AzArgs $loginArgs -NewWindow
    } else {
      $login = Invoke-CoopAz -Seconds 300 -AzArgs $loginArgs
    }
    $rc = $login.Rc
    # A zero login exit is not enough: tenant-only and conditional-access flows
    # can finish without the tokens coop needs, so check both again.
    if ($rc -eq 0) { $rc = Get-CoopAzTokenRc -Tenant $tenant }
  }
  if ($rc -eq 0) {
    try {
      New-Item -ItemType Directory -Force -Path $agentDir -ErrorAction SilentlyContinue | Out-Null
      [System.IO.File]::WriteAllText($marker, $tenant)
    } catch { }
    if ($tried) { Coop-Ok "Signed in to Azure for tenant $tenant." }
    return
  }
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  if ($tried) {
    Coop-Warn "Azure sign-in for tenant $tenant is not verified; continuing." "run: az login --tenant $tenant --allow-no-subscriptions"
    if ($inWindow) {
      # The launching console is minimized (the 'coop' shortcut), so a failed,
      # cancelled or timed-out sign-in also shows this line in its own window
      # until Enter. The launch does not wait for it.
      $notice = "Write-Host " + (ConvertTo-CoopPsLiteral "Azure sign-in for tenant $tenant is not verified. Run: az login --tenant $tenant --allow-no-subscriptions") + "`n[void](Read-Host 'Press Enter to close')"
      try { $null = Start-CoopPsWindow $notice } catch { }
    }
  } elseif ($rc -eq 124) {
    Coop-Warn "Azure token check timed out for tenant $tenant (network or VPN?); continuing." "run: az account get-access-token --tenant $tenant --resource https://api.fabric.microsoft.com"
  } elseif ($rc -eq 1) {
    Coop-Warn "Azure: not signed in to tenant $tenant; continuing." "run: az login --tenant $tenant --allow-no-subscriptions"
  } else {
    Coop-Warn "Azure token check failed for tenant $tenant (not an auth error); continuing." "run: az account get-access-token --tenant $tenant --resource https://api.fabric.microsoft.com"
  }
}

# --- Repo staleness (fleet drift) ---------------------------------------------
# coop-agent updates arrive when `coop update` fast-forwards the checkout to the
# newest release tag (H5; --edge: head of main); a zip/shared-drive copy (no .git)
# silently never updates, and even a git checkout has no signal between updates.
# These helpers power step 1 of `coop update` and the doctor / launch nudge.

# Is <Dir> a git checkout: a clone (.git directory) or a linked worktree or
# submodule (.git file naming its gitdir). Both twins use this one rule (#106), so
# bash and PowerShell agree on a worktree; a plain copy, or a .git file that names
# no gitdir, is not a checkout. No git process is started.
# (mirror of coop_is_git_checkout)
function Test-CoopGitCheckout([string]$Dir) {
  $g = Join-Path $Dir '.git'
  if (Test-Path -LiteralPath $g -PathType Container) { return $true }
  if (-not (Test-Path -LiteralPath $g -PathType Leaf)) { return $false }
  try { $first = ([System.IO.File]::ReadAllText($g) -split "`r?`n", 2)[0] } catch { return $false }
  return ($first.StartsWith('gitdir: ') -and $first.Length -gt 8)
}

# Quietly refresh origin — at most once per day (marker in the effective agent
# dir) and bounded by a 5s wait, so an offline or VPN-black-holed fetch can never
# stall doctor or a launch. Stamps BEFORE fetching, so an offline machine pays
# the wait at most once a day. Returns $true when THIS call attempted the (daily)
# fetch; $false when throttled or not applicable (non-git copy / no git / no
# origin remote). (mirror of coop_repo_fetch_throttled)
function Invoke-CoopRepoFetchThrottled {
  if (-not (Test-Have 'git')) { return $false }
  if (-not (Test-CoopGitCheckout $script:CoopRoot)) { return $false }
  & git -C $script:CoopRoot remote get-url origin *> $null
  if ($LASTEXITCODE -ne 0) { return $false }
  $agentDir = Get-CoopEffectiveAgentDir
  $marker = Join-Path $agentDir '.coop-fetch-stamp'
  # -Force: pwsh on macOS/Linux treats the dot-prefixed marker as hidden and
  # Get-Item won't return it otherwise (Windows has no Hidden attribute on it).
  $mi = Get-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  if ($mi -and (((Get-Date) - $mi.LastWriteTime).TotalHours -lt 24)) { return $false }
  New-Item -ItemType Directory -Force -Path $agentDir -ErrorAction SilentlyContinue | Out-Null
  New-Item -ItemType File -Force -Path $marker -ErrorAction SilentlyContinue | Out-Null
  # Watchdog via a raw child process (mirrors bash's bg-fetch + 5s killer).
  # Deliberately NOT a PowerShell job: Stop-Job can block indefinitely while a
  # native command is mid-flight inside the job, which would hang doctor/launch —
  # Process.WaitForExit(ms) + Kill() can't.
  $oldPrompt = $env:GIT_TERMINAL_PROMPT
  $env:GIT_TERMINAL_PROMPT = '0'
  $so = [System.IO.Path]::GetTempFileName(); $se = [System.IO.Path]::GetTempFileName()
  try {
    $p = Start-Process -FilePath 'git' -ArgumentList @('-C', "$script:CoopRoot", 'fetch', '--quiet', 'origin') `
          -NoNewWindow -PassThru -RedirectStandardOutput $so -RedirectStandardError $se -ErrorAction Stop
    if (-not $p.WaitForExit(5000)) { try { $p.Kill() } catch { } }
  } catch { }
  finally {
    Remove-Item $so, $se -Force -ErrorAction SilentlyContinue
    if ($null -eq $oldPrompt) { Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue }
    else { $env:GIT_TERMINAL_PROMPT = $oldPrompt }
  }
  return $true
}

# How many commits HEAD is behind the release `coop update` would move it to
# (Get-CoopRepoNextRelease) — purely local and instant (last-fetched refs; no
# network). 0 when there is no newer release, this is not a git checkout, git is
# missing, or the count is unknowable, so a checkout that is ahead, diverged or
# held is never told to run an update that would not move it.
# (mirror of coop_repo_behind_count)
function Get-CoopRepoBehindCount {
  $ErrorActionPreference = 'Continue'
  $tag = Get-CoopRepoNextRelease
  if (-not $tag) { return 0 }
  $out = Get-CoopRepoGitLine @('rev-list', '--count', "HEAD..refs/tags/$tag")
  if ($out -match '^\d+$') { return [int]$out }
  return 0
}

# Launch-time staleness nudge: at most once per day (it fires only when this call
# performed the daily fetch), warn when a newer release is waiting for this
# checkout. Never blocks or fails the launch; silent offline / non-git / current.
# Stranded checkouts stay quiet here; step 1 and doctor name them.
# (mirror of coop_update_nudge)
function Invoke-CoopUpdateNudge {
  if (-not (Invoke-CoopRepoFetchThrottled)) { return }
  $tag = Get-CoopRepoNextRelease
  if (-not $tag) { return }
  $behind = Get-CoopRepoBehindCount
  if ($behind -gt 0) { Coop-Warn "coop-agent is $behind commit(s) behind release $tag — run: coop update" }
}

# First output line of a read-only git query against the coop-agent checkout; ''
# when git fails. Function-local Continue: redirected git stderr can never become
# a terminating error for a caller running with EAP=Stop on Windows PowerShell 5.1.
function Get-CoopRepoGitLine {
  param([string[]]$GitArgs)
  $ErrorActionPreference = 'Continue'
  $out = @(& git -C $script:CoopRoot @GitArgs 2>$null)
  if ($LASTEXITCODE -ne 0) { return '' }
  foreach ($o in $out) { if ($null -ne $o) { return ([string]$o).Trim() } }
  return ''
}

# The checked-out branch name; '' when HEAD is detached. Strips refs/heads/ from
# the full ref, not --short: a tag named like the branch (a stray 'main' tag,
# which every fetch auto-follows) turns --short into 'heads/main'.
# (mirror of _coop_repo_branch)
function Get-CoopRepoBranch {
  $ErrorActionPreference = 'Continue'
  $ref = Get-CoopRepoGitLine @('symbolic-ref', '-q', 'HEAD')
  if ($ref -cmatch '^refs/heads/(.+)$') { return $Matches[1] }
  return ''
}

# True when HEAD follows release tags: a detached HEAD, or a branch whose upstream
# is origin/main (main, or a renamed branch that tracks it). Any other branch,
# including one with no upstream, is a hold. (mirror of _coop_repo_follows_releases)
function Test-CoopRepoFollowsReleases {
  $ErrorActionPreference = 'Continue'
  $branch = Get-CoopRepoBranch
  if (-not $branch) { return $true }
  if ((Get-CoopRepoGitLine @('config', '--get', "branch.$branch.remote")) -cne 'origin') { return $false }
  return ((Get-CoopRepoGitLine @('config', '--get', "branch.$branch.merge")) -ceq 'refs/heads/main')
}

# The newest strict vX.Y.Z tag merged into the last-fetched origin/main, with any
# extra for-each-ref filters (e.g. --contains HEAD). rc tags, tags off main and
# junk output are skipped; lstrip=2 so a same-named branch cannot hide a tag.
# (mirror of _coop_repo_newest_release)
function Get-CoopRepoNewestRelease {
  param([string[]]$Filter = @())
  $ErrorActionPreference = 'Continue'
  $gitArgs = @('-C', $script:CoopRoot, 'for-each-ref') + $Filter + @('--merged', 'refs/remotes/origin/main', '--sort=-v:refname', '--format=%(refname:lstrip=2)', 'refs/tags/v[0-9]*')
  $out = @(& git @gitArgs 2>$null)
  if ($LASTEXITCODE -ne 0) { return '' }
  foreach ($t in $out) {
    if ($null -eq $t) { continue }
    $s = ([string]$t).Trim()
    if ($s -cmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { return $s }
  }
  return ''
}

# The release `coop update` would move this checkout to: the newest strict vX.Y.Z
# tag merged into the last-fetched origin/main that contains HEAD, unless HEAD is
# already on it. Read-only and local. '' for a non-git copy, missing git, a hold,
# or no newer release, so nothing is ever moved backwards.
# (mirror of coop_repo_next_release)
function Get-CoopRepoNextRelease {
  $ErrorActionPreference = 'Continue'
  if (-not (Test-Have 'git')) { return '' }
  if (-not (Test-CoopGitCheckout $script:CoopRoot)) { return '' }
  if (-not (Test-CoopRepoFollowsReleases)) { return '' }
  $tag = Get-CoopRepoNewestRelease -Filter @('--contains', 'HEAD')
  if (-not $tag) { return '' }
  if ((Get-CoopRepoGitLine @('rev-list', '-n', '1', "refs/tags/$tag")) -ceq (Get-CoopRepoGitLine @('rev-parse', 'HEAD'))) { return '' }
  return $tag
}

# `git describe` of the checkout against release tags (rc tags and tags not
# shaped vX.Y.Z, such as v1 or v0.10.0.1, skipped; a bare short SHA when no
# release is reachable) for the doctor row and step 1. No --dirty, so the index
# is never touched. '' for a non-git copy or unexpected output.
# (mirror of coop_repo_describe)
function Get-CoopRepoDescribe {
  $ErrorActionPreference = 'Continue'
  if (-not (Test-Have 'git')) { return '' }
  if (-not (Test-CoopGitCheckout $script:CoopRoot)) { return '' }
  $d = Get-CoopRepoGitLine @('describe', '--tags', '--match', 'v[0-9]*.[0-9]*.[0-9]*', '--exclude', '*-*', '--exclude', 'v*.*.*.*', '--always')
  if ($d -cmatch '^(v[0-9]|[0-9a-f]{4})[0-9A-Za-z.-]*$') { return $d }
  return ''
}

# The remote a missing origin was renamed to, or '' when that is not certain:
# the checked-out branch's remote, unless a different remote points at the
# canonical repo; else the one remote that points at the canonical repo. Never
# the first name `git remote` lists: it is sorted, so a fork added next to a
# renamed origin would come first. (mirror of _coop_repo_origin_candidate)
function Get-CoopRepoOriginCandidate {
  $ErrorActionPreference = 'Continue'
  $root = $script:CoopRoot
  $br = ''
  $branch = Get-CoopRepoBranch
  if ($branch) {
    $br = Get-CoopRepoGitLine @('config', '--get', "branch.$branch.remote")
    # '.' (a local upstream) or a remote that no longer exists is no candidate.
    if ($br) {
      & git -C $root remote get-url $br *> $null
      if ($LASTEXITCODE -ne 0) { $br = '' }
    }
  }
  $canon = @()
  foreach ($r in @(& git -C $root remote 2>$null)) {
    if ($null -eq $r) { continue }
    $name = ([string]$r).Trim()
    if (-not $name) { continue }
    $url = Get-CoopRepoGitLine @('remote', 'get-url', $name)
    if ($url -cmatch '[/:]kabukisensei/coop-agent(\.git)?/?$') { $canon += $name }
  }
  if ($br) {
    if ($canon.Count -eq 0 -or $canon -ccontains $br) { return $br }
    return ''
  }
  if ($canon.Count -eq 1) { return $canon[0] }
  return ''
}

# A state in which `coop update` cannot move this checkout, as
# @{ Message; Hint } (what is wrong, then the command that fixes it); $null when
# the checkout follows releases normally. Local only. Step 1 and doctor use it so
# a stranded machine is never silent. (mirror of coop_repo_stranded)
function Get-CoopRepoStranded {
  $ErrorActionPreference = 'Continue'
  if (-not (Test-Have 'git')) { return $null }
  $root = $script:CoopRoot
  if (-not (Test-CoopGitCheckout $root)) { return $null }
  & git -C $root remote get-url origin *> $null
  if ($LASTEXITCODE -ne 0) {
    # Renamed (origin -> upstream) or removed: name it before it reads as a hold.
    # Suggest a rename only for a certain candidate; otherwise add the canonical one.
    $remote = Get-CoopRepoOriginCandidate
    $fix = if ($remote) { "git -C `"$root`" remote rename $remote origin" } else { "git -C `"$root`" remote add origin https://github.com/kabukisensei/coop-agent.git; git -C `"$root`" fetch origin" }
    return [pscustomobject]@{ Message = 'coop-agent has no origin remote, so coop update cannot move it'; Hint = "fix: $fix" }
  }
  if (-not (Test-CoopRepoFollowsReleases)) {
    $branch = Get-CoopRepoBranch
    $fix = if ($branch -ceq 'main') { "git -C `"$root`" branch --set-upstream-to=origin/main main" } else { "git -C `"$root`" switch main" }
    return [pscustomobject]@{ Message = "coop-agent is held on branch '$branch' (it does not track origin/main); coop update leaves it alone"; Hint = "to follow releases again: $fix" }
  }
  & git -C $root rev-parse -q --verify refs/remotes/origin/main *> $null
  if ($LASTEXITCODE -ne 0) {
    return [pscustomobject]@{ Message = 'coop-agent has no origin/main to follow (for example a single-branch clone of a tag)'; Hint = "fix: git -C `"$root`" remote set-branches origin '*'; git -C `"$root`" fetch origin" }
  }
  $tag = Get-CoopRepoNewestRelease
  if ($tag -and -not (Get-CoopRepoNextRelease)) {
    & git -C $root merge-base --is-ancestor "refs/tags/$tag" HEAD *> $null
    if ($LASTEXITCODE -ne 0) {
      # Name the aside branch after HEAD so a leftover from an earlier rejoin never
      # collides, and run the reset only if the branch was made: Windows
      # PowerShell 5.1 has no &&, and ';' would reset anyway and orphan the commits.
      $aside = 'my-work'
      $sha = Get-CoopRepoGitLine @('rev-parse', '--short', 'HEAD')
      if ($sha -cmatch '^[0-9a-f]+$') { $aside = "my-work-$sha" }
      return [pscustomobject]@{ Message = "coop-agent has commits that release $tag does not contain, so coop update cannot move it (push them, or set them aside)"; Hint = "set them aside and rejoin: git -C `"$root`" branch $aside; if (`$LASTEXITCODE -eq 0) { git -C `"$root`" reset --keep $tag }" }
    }
  }
  return $null
}

# Coop-Warn the Get-CoopRepoStranded state; $false when there is none.
# (mirror of _coop_repo_warn_stranded)
function Write-CoopRepoStranded {
  $s = Get-CoopRepoStranded
  if ($null -eq $s) { return $false }
  Coop-Warn $s.Message $s.Hint
  return $true
}

# The repo line of `coop update --check` (#107), as @{ Line; Hint } (Hint '' when
# none): what step 1 would do to this checkout. Local only, no fetch, so --check
# still changes nothing. (mirror of coop_repo_check_line)
function Get-CoopRepoCheckLine {
  $ErrorActionPreference = 'Continue'
  if (-not (Test-Have 'git') -or -not (Test-CoopGitCheckout $script:CoopRoot)) {
    return @{ Line = 'not a git checkout: coop update never moves it'; Hint = '' }
  }
  $at = Get-CoopRepoDescribe; if (-not $at) { $at = 'checkout' }
  $next = Get-CoopRepoNextRelease
  if ($next) { return @{ Line = "$at  would move to release $next"; Hint = '' } }
  $s = Get-CoopRepoStranded
  if ($null -ne $s) { return @{ Line = $s.Message; Hint = $s.Hint } }
  return @{ Line = "$at  no newer release"; Hint = '' }
}

# The doctor's "coop-agent repository" row for a git checkout, as
# @{ Level; Message; Hint } (Level 'ok' or 'warn'; Hint '' for ok). Local only
# (no network; doctor refreshes origin first). A newer release to move to comes
# first; else a stranded state is named with its fix; else the checkout is ok.
# (mirror of coop_repo_doctor_row)
function Get-CoopRepoDoctorRow {
  $ErrorActionPreference = 'Continue'
  $next = Get-CoopRepoNextRelease
  $behind = Get-CoopRepoBehindCount
  if ($next -and $behind -gt 0) {
    return [pscustomobject]@{ Level = 'warn'; Message = "coop-agent is $behind commit(s) behind release $next"; Hint = 'run: coop update' }
  }
  $s = Get-CoopRepoStranded
  if ($null -ne $s) { return [pscustomobject]@{ Level = 'warn'; Message = $s.Message; Hint = $s.Hint } }
  $at = Get-CoopRepoDescribe
  if (-not $at) { $at = 'git checkout' }
  return [pscustomobject]@{ Level = 'ok'; Message = "coop-agent $at (follows release tags via: coop update)"; Hint = '' }
}

# Step 1 of `coop update`: move the coop-agent checkout. Default: fast-forward to
# Get-CoopRepoNextRelease, never backwards, never a tag checkout or reset. -Edge:
# head of main, via today's `git pull --ff-only` on a branch, or a guarded
# re-attach of a detached HEAD to main. Tracked-file changes skip the move; a hold
# is not fetched or moved. Warn-and-continue: never touches the update's failure
# count. (mirror of coop_repo_follow_release)
function Invoke-CoopRepoFollowRelease {
  param([bool]$Edge = $false)
  $ErrorActionPreference = 'Continue'
  $root = $script:CoopRoot
  $status = (& git -C $root status --porcelain --untracked-files=no 2>$null | Out-String)
  if ($status.Trim()) {
    Coop-Warn 'uncommitted changes to tracked files in coop-agent — skipping the coop-agent move (commit/stash first).'
    return
  }
  $before = Get-CoopRepoDescribe
  if (-not $before) { $before = 'checkout' }
  $branch = Get-CoopRepoBranch
  $oldPrompt = $env:GIT_TERMINAL_PROMPT
  $env:GIT_TERMINAL_PROMPT = '0'
  try {
    if ($Edge -and $branch) {
      # A branch with no upstream (e.g. a hold made from a tag) has nothing to pull.
      if (-not (Get-CoopRepoGitLine @('config', '--get', "branch.$branch.merge"))) { $null = Write-CoopRepoStranded; return }
      Coop-Info "git pull --ff-only (--edge: head of $branch)"
      & git -C $root pull --ff-only *> $null
      if ($LASTEXITCODE -eq 0) { Coop-Ok "coop-agent moved from $before to head of $branch ($(Get-CoopRepoDescribe))" }
      else { Coop-Warn 'git pull failed (continuing)' "see: git -C `"$root`" status" }
      return
    }
    if (-not (Test-CoopRepoFollowsReleases)) { $null = Write-CoopRepoStranded; return }
    $fetchOut = @(& git -C $root fetch --quiet origin 2>&1)
    if ($LASTEXITCODE -ne 0) {
      $line = 'fetch failed'
      foreach ($o in $fetchOut) { $s = ([string]$o).Trim(); if ($s) { $line = $s; break } }
      Coop-Warn 'could not fetch from origin — using the releases already on this machine' "git: $line"
    }
    if ($Edge) {
      # Detached HEAD: re-attach to main only when that is forward-only and loses
      # nothing — HEAD and any existing local main must both be ancestors of
      # origin/main. Never a plain `git checkout main` (a stale local main would
      # move HEAD backwards and strand the machine if the pull then failed).
      & git -C $root rev-parse -q --verify refs/remotes/origin/main *> $null
      if ($LASTEXITCODE -ne 0) { $null = Write-CoopRepoStranded; return }
      & git -C $root merge-base --is-ancestor HEAD refs/remotes/origin/main *> $null
      if ($LASTEXITCODE -ne 0) {
        Coop-Warn "--edge: this detached coop-agent has commits that are not on origin/main — staying at $before" "see: git -C `"$root`" log --oneline origin/main..HEAD"
        return
      }
      & git -C $root rev-parse -q --verify refs/heads/main *> $null
      if ($LASTEXITCODE -eq 0) {
        & git -C $root merge-base --is-ancestor refs/heads/main refs/remotes/origin/main *> $null
        if ($LASTEXITCODE -ne 0) {
          Coop-Warn "--edge: local branch main has commits that are not on origin/main — staying at $before" "see: git -C `"$root`" log --oneline refs/remotes/origin/main..refs/heads/main"
          return
        }
      }
      & git -C $root checkout -q -B main --track refs/remotes/origin/main *> $null
      if ($LASTEXITCODE -eq 0) { Coop-Ok "coop-agent moved from $before to head of main ($(Get-CoopRepoDescribe))" }
      else { Coop-Warn 'could not switch coop-agent to main (continuing)' "see: git -C `"$root`" status" }
      return
    }
    $tag = Get-CoopRepoNextRelease
    if ($tag) {
      # merge --ff-only, never checkout: git itself refuses anything that is not a
      # fast-forward, or that would overwrite an untracked file.
      & git -C $root merge --ff-only --quiet "refs/tags/$tag" *> $null
      if ($LASTEXITCODE -eq 0) { Coop-Ok "coop-agent moved from $before to release $tag" }
      else { Coop-Warn "could not fast-forward coop-agent to $tag (continuing)" "see: git -C `"$root`" status" }
      return
    }
    if (-not (Write-CoopRepoStranded)) { Coop-Ok "coop-agent ${before}: no newer release to move to (--edge follows main)" }
  } finally {
    if ($null -eq $oldPrompt) { Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue }
    else { $env:GIT_TERMINAL_PROMPT = $oldPrompt }
  }
}

# The Pi agent's own semver, e.g. '0.80.2' (from `pi --version`). '' if unknown.
# (mirror of coop_pi_version)
function Get-CoopPiVersion {
  if (-not (Test-Have 'pi')) { return '' }
  $raw = (& pi --version 2>$null | Select-Object -First 1)
  $m = [regex]::Match([string]$raw, '\d+\.\d+\.\d+')
  if ($m.Success) { return $m.Value } else { return '' }
}

# True if version $A's MAJOR.MINOR is strictly newer than $B's (patch ignored).
# (mirror of coop_minor_newer)
function Test-CoopMinorNewer {
  param([string]$A, [string]$B)
  $ma = [regex]::Match([string]$A, '^(\d+)\.(\d+)'); $mb = [regex]::Match([string]$B, '^(\d+)\.(\d+)')
  if (-not $ma.Success -or -not $mb.Success) { return $false }
  return ([version]("{0}.{1}" -f $ma.Groups[1].Value, $ma.Groups[2].Value) -gt [version]("{0}.{1}" -f $mb.Groups[1].Value, $mb.Groups[2].Value))
}

# Read a dotted scalar key from a YAML file via lib/_yaml.py (PyYAML when present,
# else a dependency-free fallback parser). (mirror of coop_yaml_get)
function Get-CoopYamlValue {
  param([string]$File, [string]$Key, [string]$Default = '')
  if (-not $File -or -not (Test-Path -LiteralPath $File -PathType Leaf)) { return $Default }
  $py = Get-CoopPython
  if (-not $py) { return $Default }
  $yamlPy = Join-Path $script:CoopRoot 'lib/_yaml.py'
  try {
    $out = (& $py $yamlPy get $File $Key $Default 2>$null)
    if ($null -eq $out) { return $Default }
    $out = ($out | Out-String).TrimEnd("`r", "`n")
    if ($out -eq '') { return $Default }
    return $out
  } catch { return $Default }
}

# Read a dotted key that is a YAML list of scalars, returning a string array.
# (mirror of coop_yaml_list)
function Get-CoopYamlList {
  param([string]$File, [string]$Key)
  if (-not $File -or -not (Test-Path -LiteralPath $File -PathType Leaf)) { return @() }
  $py = Get-CoopPython
  if (-not $py) { return @() }
  $yamlPy = Join-Path $script:CoopRoot 'lib/_yaml.py'
  try {
    $out = (& $py $yamlPy list $File $Key 2>$null)
    if ($null -eq $out) { return @() }
    return @($out -split "`r?`n" | Where-Object { $_ -ne '' })
  } catch { return @() }
}

# --- Team knowledge config (~/.coop/config "knowledge" block) -----------------
# The fleet config JSON (schema_version 1, written by scripts/onboard.py) carries
# an OPTIONAL "knowledge" block: { "enabled": bool, "repos": [{url, local_path}] }.
# Absent/disabled/unreadable is a clean no-op everywhere. COOP_DIR overrides the
# parent of .coop (same convention as onboard.py and the test suite).
# (mirrors of coop_config_file / coop_knowledge_enabled / coop_knowledge_repos)
function Get-CoopConfigFile {
  $base = if ($env:COOP_DIR) { $env:COOP_DIR } else { $HOME }
  return (Join-Path $base '.coop\config')
}

function Get-CoopKnowledgeBlock {
  $f = Get-CoopConfigFile
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $null }
  try {
    $cfg = Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.knowledge) { return $cfg.knowledge }
  } catch { return $null }
  return $null
}

# True when knowledge.enabled is truthy in the fleet config.
function Test-CoopKnowledgeEnabled {
  $k = Get-CoopKnowledgeBlock
  return [bool]($k -and $k.enabled)
}

# One PSCustomObject per configured knowledge repo (Url, LocalPath with ~ expanded),
# only when knowledge.enabled. Empty array when disabled/absent/malformed.
function Get-CoopKnowledgeRepos {
  if (-not (Test-CoopKnowledgeEnabled)) { return @() }
  $k = Get-CoopKnowledgeBlock
  $repos = @()
  foreach ($r in @($k.repos)) {
    $url = [string]$r.url
    $path = [string]$r.local_path
    if (-not $url -or -not $path) { continue }
    if ($path -eq '~') { $path = $HOME }
    elseif ($path.StartsWith('~/') -or $path.StartsWith('~\')) { $path = Join-Path $HOME $path.Substring(2) }
    $repos += [pscustomobject]@{ Url = $url.Trim(); LocalPath = $path }
  }
  return $repos
}

# Extract the YAML frontmatter `name:` from a SKILL.md (first match), or '' if none.
# (mirror of coop_skill_name)
function Get-CoopSkillName {
  param([string]$File)
  if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return '' }
  # Get-Content returns a SCALAR STRING for a one-line file, not an array:
  # $lines[0] would then be the first CHARACTER (a [System.Char] has no
  # .Trim()), which crashed the launcher on a malformed one-line team skill.
  # @(...) forces an array so $lines[0] is always the first LINE. -ErrorAction
  # Stop + try/catch: an unreadable file is a rejected skill (''), never a
  # launcher abort.
  try {
    $lines = @(Get-Content -LiteralPath $File -Encoding UTF8 -ErrorAction Stop)
  }
  catch {
    return ''
  }
  if (-not $lines -or $lines.Count -eq 0 -or $lines[0].Trim() -ne '---') { return '' }
  for ($i = 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -eq '---') { break }
    if ($lines[$i] -match '^\s*name:\s*(.+?)\s*$') {
      return ($matches[1].Trim() -replace '^["'']|["'']$', '')
    }
  }
  return ''
}

# Test whether a tool is enabled in .coop/project.yml. Returns $true when the key
# is absent or set to true/yes/1; returns $false only for explicit false/0/no.
# Falls back to enabled if no project.yml exists.
function Test-CoopToolEnabled {
  param([string]$Proj, [string]$Key)
  $v = Get-CoopYamlValue $Proj "tools.$Key.enabled"
  switch -Regex ($v) {
    '^(false|0|no|nope)$' { return $false }
    default { return $true }
  }
}

# Locate the active project contract: nearest .coop/project.yml walking up from
# $PWD, else the bundled one at COOP_ROOT/.coop/project.yml. (mirror of coop_find_project_yml)
function Find-CoopProjectYml {
  param([string]$StartDir = (Get-Location).Path)
  $dir = $StartDir
  while ($dir) {
    $candidate = Join-Path $dir '.coop\project.yml'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    $parent = Split-Path -Parent $dir
    if ($parent -eq $dir -or -not $parent) { break }
    $dir = $parent
  }
  $bundled = Join-Path $script:CoopRoot '.coop\project.yml'
  if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
  return ''
}

# Confirm a potentially-destructive action unless --yes / COOP_ASSUME_YES is set.
# (mirror of coop_confirm)
function Coop-Confirm {
  param([string]$Prompt = 'Proceed?')
  if ($env:COOP_ASSUME_YES -eq '1') { return $true }
  if ([Console]::IsInputRedirected) { Coop-Warn 'Non-interactive shell; refusing without --yes.'; return $false }
  [Console]::Error.Write("$($script:C_OLIVE)$Prompt$($script:C_RST) [y/N] ")
  $ans = [Console]::In.ReadLine()
  if ($ans -match '^(y|yes)$') { return $true } else { return $false }
}

# Test whether the local COOP user profile exists.
function Test-CoopUserProfileMissing {
  return -not (Test-Path -LiteralPath (Join-Path $HOME '.coop\user.json') -PathType Leaf)
}

function Test-CoopOnboardingMissing {
  return (Test-CoopUserProfileMissing) -or -not (Test-Path -LiteralPath (Join-Path $HOME '.coop\config') -PathType Leaf)
}

# First-run onboarding: run when either the profile or integration config is missing.
function Invoke-CoopMaybeOnboard {
  # Exit code contract for callers: $script:CoopOnboardRc is 0 when onboarding
  # ran (or was legitimately skipped) and the wizard's exit code when it failed.
  $script:CoopOnboardRc = 0
  if (-not (Test-CoopOnboardingMissing)) { return }
  if ([Console]::IsInputRedirected) {
    Coop-Warn 'COOP onboarding is incomplete (user.json or config missing). Run: coop onboard'
    return
  }
  if ($env:COOP_NO_ONBOARD -eq '1') { return }
  $py = Get-CoopPython
  if (-not $py) {
    Coop-Warn 'python3 required for onboarding. Run: coop onboard once python is available.'
    return
  }
  Coop-Info "First run: let's set up your COOP profile."
  & $py (Join-Path $script:CoopRoot 'scripts\onboard.py') onboard
  $script:CoopOnboardRc = $LASTEXITCODE
}

# --- Background units (install/update items) ----------------------------------
function Start-CoopJob {
  param([scriptblock]$Sb, [object[]]$JobArgs)
  if ($script:UseThreadJob) { Start-ThreadJob -ScriptBlock $Sb -ArgumentList $JobArgs }
  else                      { Start-Job       -ScriptBlock $Sb -ArgumentList $JobArgs }
}

# Coop-Unit <label> <scriptblock> [args]
#   Runs the scriptblock in a background job (it returns @{ok=<bool>; msg=<string>}).
#   While it runs, the active-item line animates under the overall bar; on completion
#   the bar advances by one and a permanent ✓/! line is printed. NB: the scriptblock
#   runs in a FRESH runspace — it sees none of these functions/variables, so units
#   must be self-contained and take their inputs as arguments. (mirror of coop_unit)
function Coop-Unit {
  param([string]$Label, [scriptblock]$Work, [object[]]$WorkArgs = @())
  $sw  = [System.Diagnostics.Stopwatch]::StartNew()
  $job = Start-CoopJob $Work $WorkArgs
  if ((Test-ProgTty) -and $script:ProgActive) {
    $i = 0
    while ($job.State -eq 'Running') {
      $g = $script:SpinFrames[$i % $script:SpinFrames.Count]
      $script:ProgSpinline = (Coop-ProgSpin $g $Label ([int]$sw.Elapsed.TotalSeconds))
      Coop-ProgDraw
      $i++
      Start-Sleep -Milliseconds 120
    }
  } else {
    Coop-Info "$Label…"          # non-console: at least show the slow step started
  }
  # Wait for the job to FINISH before reading it. The TTY branch's poll loop already
  # blocks until completion; the non-TTY branch does not, so without this Receive-Job
  # could read an empty (still-running) result and falsely report failure. Mirrors the
  # `wait "$pid"` in bash coop_unit.
  $null = Wait-Job $job -ErrorAction SilentlyContinue
  $res = $null
  try { $res = Receive-Job $job -ErrorAction SilentlyContinue | Select-Object -Last 1 } catch {}
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  $ok = $false; $msg = $Label
  if ($null -ne $res) {
    if ($res.PSObject.Properties.Name -contains 'ok')  { $ok  = [bool]$res.ok }
    if ($res.PSObject.Properties.Name -contains 'msg') { $msg = [string]$res.msg }
  }
  $script:ProgDone++
  $script:ProgSpinline = ''
  # Callers that need a truthful aggregate result read this after each unit.
  # Do not emit a Boolean: that would pollute command output and job results.
  $script:CoopUnitLastOk = $ok
  if ($ok) { Coop-Ok $msg } else { Coop-Warn $msg }
}

# Run a sibling coop script (sync/doctor) in a CHILD process so its `exit` cannot
# abort the caller — mirrors bash invoking "$COOP_ROOT/scripts/x.sh" as a
# subprocess. Returns the child's exit code.
function Invoke-CoopScript {
  param([string]$ScriptPath, [string[]]$ScriptArgs = @())
  $psExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
  & $psExe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @ScriptArgs
  return $LASTEXITCODE
}

# --- Profile redirection (isolated installs) ----------------------------------
# A second coop can run isolated from the real install by redirecting HOME /
# USERPROFILE / LOCALAPPDATA / APPDATA at a sandbox folder (the acceptance
# harness and the VM runbooks do this). Everything keyed off those variables
# already lands in the sandbox, but two install steps used to ignore them: the
# Start Menu / Desktop shortcuts came from the Windows shell folders and the
# launcher dir went onto the persistent user PATH in the registry — so a sandbox
# install rewrote the real user's shortcuts (pointing them at the sandbox) and
# grew the real user PATH. Test-CoopProfileRedirected tells the two apart by
# comparing the profile in use (USERPROFILE, else $HOME) with the profile Windows
# registered for this account (.NET's UserProfile special folder, which does not
# follow the environment). Off Windows the same comparison runs against .NET's
# notion of the home directory, so the helpers behave identically in tests.
function Get-CoopProfileInUse {
  if ($env:USERPROFILE) { return [string]$env:USERPROFILE }
  return [string]$HOME
}
function Get-CoopRegisteredProfile {
  try { return [string][Environment]::GetFolderPath('UserProfile') } catch { return '' }
}
# Normalized form for comparing two paths: absolute, no trailing separator,
# case-folded (Windows paths are case-insensitive; a sandbox is never a
# case-variant of the real profile).
function ConvertTo-CoopComparablePath {
  param([string]$Path)
  if (-not $Path) { return '' }
  $full = try { [System.IO.Path]::GetFullPath($Path) } catch { $Path }
  return $full.TrimEnd('\', '/').ToLowerInvariant()
}
function Test-CoopPathInside {
  param([string]$Path, [string]$Root)
  $p = ConvertTo-CoopComparablePath $Path
  $r = ConvertTo-CoopComparablePath $Root
  if (-not $p -or -not $r) { return $false }
  return ($p -eq $r) -or $p.StartsWith($r + '\') -or $p.StartsWith($r + '/')
}
function Test-CoopProfileRedirected {
  $registered = ConvertTo-CoopComparablePath (Get-CoopRegisteredProfile)
  $inUse = ConvertTo-CoopComparablePath (Get-CoopProfileInUse)
  if (-not $registered -or -not $inUse) { return $false }
  return ($registered -ne $inUse)
}
# The account's registered roaming AppData folder (where the real Start Menu
# lives). NOT [Environment]::GetFolderPath('ApplicationData'): the shell expands
# the registered "%USERPROFILE%\AppData\Roaming" against the CURRENT environment,
# so under a redirected USERPROFILE it points into the sandbox, and when that
# folder does not exist yet .NET falls back to the APPDATA variable itself — both
# make a redirected APPDATA look registered. Read the raw "User Shell Folders"
# value instead and expand %USERPROFILE% against the registered profile. Off
# Windows (or without the value) it is <registered profile>\AppData\Roaming.
function Get-CoopRegisteredRoaming {
  $registered = Get-CoopRegisteredProfile
  $fallback = if ($registered) { Join-Path $registered 'AppData\Roaming' } else { '' }
  if ($env:OS -ne 'Windows_NT') { return $fallback }
  try {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders')
    if (-not $key) { return $fallback }
    $raw = [string]$key.GetValue('AppData', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $key.Close()
    if (-not $raw) { return $fallback }
    $token = '%USERPROFILE%'
    $idx = $raw.IndexOf($token, [StringComparison]::OrdinalIgnoreCase)
    if ($idx -ge 0 -and $registered) { $raw = $raw.Substring(0, $idx) + $registered + $raw.Substring($idx + $token.Length) }
    $expanded = [Environment]::ExpandEnvironmentVariables($raw)
    if ($expanded -and [System.IO.Path]::IsPathRooted($expanded)) { return $expanded }
    return $fallback
  } catch { return $fallback }
}
# Where the "coop" shortcuts live, Start Menu first, then Desktop. A normal
# install uses the Windows shell folders (they follow a OneDrive-redirected
# Desktop); an isolated one uses the redirected profile's own Desktop and the
# Start Menu under its roaming AppData (APPDATA when it was redirected too,
# else <profile>\AppData\Roaming), so nothing lands on the real profile. A
# sandbox may itself sit under the real profile (C:\Users\me\sandbox), so the
# APPDATA test is "is it still the account's registered roaming folder", not
# "is it under the real profile".
function Get-CoopShortcutDirs {
  if (Test-CoopProfileRedirected) {
    $profileDir = Get-CoopProfileInUse
    $appData = ConvertTo-CoopComparablePath ([string]$env:APPDATA)
    $roaming = if ($appData -and ($appData -ne (ConvertTo-CoopComparablePath (Get-CoopRegisteredRoaming)))) {
      [string]$env:APPDATA
    } else {
      Join-Path $profileDir 'AppData\Roaming'
    }
    return @((Join-Path $roaming 'Microsoft\Windows\Start Menu\Programs'), (Join-Path $profileDir 'Desktop'))
  }
  $dirs = @()
  foreach ($folder in @('Programs', 'Desktop')) {
    $d = try { [string][Environment]::GetFolderPath($folder) } catch { '' }
    if ($d) { $dirs += $d }
  }
  return $dirs
}

# --- Double-click launcher (Start Menu + Desktop) ------------------------------
# One "coop" shortcut on the Start Menu and Desktop opens the terminal agent through
# bin\coop-desktop.ps1 (its own console, home folder, coop.ico). Before S5 the "coop"
# shortcut ran `coop web` in a minimized console, and "coop (terminal)" was the
# terminal. install writes the shortcut; update rewrites it only where a coop
# shortcut already exists (-OnlyIfPresent), so old shortcuts are repaired and a
# removed one stays removed. The target folders come from Get-CoopShortcutDirs, so
# an isolated install (redirected profile) writes into its sandbox, never onto the
# real Desktop. Best-effort: returns $true when a shortcut was written.
function Set-CoopDesktopShortcuts {
  param([switch]$OnlyIfPresent)
  if ($env:OS -ne 'Windows_NT') { return $false }
  $desktopLauncher = Join-Path $script:CoopRoot 'bin\coop-desktop.ps1'
  if (-not (Test-Path -LiteralPath $desktopLauncher)) { return $false }
  $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $icon  = Join-Path $script:CoopRoot 'themes\coop.ico'
  $ws = New-Object -ComObject WScript.Shell
  $wrote = $false
  foreach ($dir in (Get-CoopShortcutDirs)) {
    if (-not $dir) { continue }
    $main = Join-Path $dir 'coop.lnk'
    $legacyTerminal = Join-Path $dir 'coop (terminal).lnk'
    $present = (Test-Path -LiteralPath $main) -or (Test-Path -LiteralPath $legacyTerminal)
    if ($OnlyIfPresent -and -not $present) { continue }
    # A fresh sandbox profile has no Desktop / Start Menu folder yet.
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $sc = $ws.CreateShortcut($main)
    $sc.TargetPath       = $psExe
    $sc.Arguments        = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$desktopLauncher`""
    $sc.WorkingDirectory = $HOME
    $sc.Description      = 'coop - the Cooptimize analytics agent'
    $sc.WindowStyle      = 1
    # ',0' = explicit icon index; some shells show a generic icon without it.
    if (Test-Path -LiteralPath $icon) { $sc.IconLocation = "$icon,0" }
    $sc.Save()
    $wrote = $true
    if (Test-Path -LiteralPath $legacyTerminal) { Remove-Item -LiteralPath $legacyTerminal -Force -ErrorAction SilentlyContinue }
  }
  return $wrote
}

#!/usr/bin/env pwsh
#
# coop-agent shared PowerShell library — coop's one helper library (master plan S1).
# Dot-sourced by bin/coop.ps1 and scripts/*.ps1:
#
#   . (Join-Path $PSScriptRoot '../lib/common.ps1')   # from scripts/ or bin/
#
# Defines helpers only; never calls `exit` except via Coop-Die. Dot-sourcing runs
# this file in the CALLER's script scope, so every $script:* variable and function
# here lands in (and binds to) the calling script. scripts/check-bom.ps1 gates this
# file's UTF-8 BOM (Windows PowerShell 5.1 reads a BOM-less file as ANSI).

# --- Resolve COOP_ROOT (the directory that contains bin/, lib/, scripts/) -----
# $PSScriptRoot inside a dot-sourced file is THIS file's directory (lib/), so the
# repo root is one level up.
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

# --- The coop window package's bundled runtime (master plan D1d) --------------
# The installed window package carries a snapshot of this repository under
# <app>\resources\coop and, beside it, <app>\resources\runtime: the pinned Node
# (runtime\node), an npm global prefix holding the pinned Pi and the Power BI
# tools (runtime\npm) and the extension tree installed from the shipped lock
# (runtime\extensions), named by runtime\coop-runtime.json. When this library
# runs from such a snapshot, that Node and that prefix come first on PATH and
# npm's global prefix is the bundled one, so `node`, `npm`, `pi` and every helper
# below resolve to the package's own copies and nothing is downloaded for them.
# D1k adds the rest of a teammate's tools: MinGit (runtime\git\cmd), the NuGet
# Python with pipx (runtime\python, runtime\python\Scripts\pipx.cmd), the Azure
# CLI zip (runtime\az\bin) also first on PATH, the wheel folder every pipx install
# reads offline (COOP_BUNDLED_WHEELS, Use-CoopBundledWheels), and the ODBC Driver
# 18 MSI with the VC++ runtime (Install-CoopBundledOdbc). Each is optional in the
# marker, so a D1d package without them still loads.
# Detected by location (the runtime folder beside the checkout);
# COOP_BUNDLED_RUNTIME names another folder for the tests.
$script:CoopBundledRuntime = ''
$script:CoopBundledRuntimeInfo = $null
$script:CoopBundledOdbc = $null
$script:CoopWindowExe = ''
function Initialize-CoopBundledRuntime {
  $dir = if ($env:COOP_BUNDLED_RUNTIME) { $env:COOP_BUNDLED_RUNTIME } else { Join-Path (Split-Path -Parent $script:CoopRoot) 'runtime' }
  $marker = Join-Path $dir 'coop-runtime.json'
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { return }
  $info = $null
  try { $info = Get-Content -LiteralPath $marker -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch { return }
  if (-not $info -or $info.schema -ne 1 -or -not $info.node -or -not $info.npm) { return }
  $nodeDir = Join-Path $dir ([string]$info.node.dir)
  $prefix = Join-Path $dir ([string]$info.npm.prefix)
  if (-not (Test-Path -LiteralPath $nodeDir -PathType Container) -or -not (Test-Path -LiteralPath $prefix -PathType Container)) { return }
  $script:CoopBundledRuntime = $dir
  $script:CoopBundledRuntimeInfo = $info
  $sep = [System.IO.Path]::PathSeparator
  $first = @()
  if ($info.git -and $info.git.dir) { $first += (Join-Path (Join-Path $dir ([string]$info.git.dir)) 'cmd') }
  if ($info.python -and $info.python.dir) {
    $pyDir = Join-Path $dir ([string]$info.python.dir)
    $first += @($pyDir, (Join-Path $pyDir 'Scripts'))
    if ($info.python.wheels) {
      $wheels = Join-Path $dir ([string]$info.python.wheels)
      if (Test-Path -LiteralPath $wheels -PathType Container) { $env:COOP_BUNDLED_WHEELS = $wheels }
    }
  }
  if ($info.azureCli -and $info.azureCli.dir) { $first += (Join-Path (Join-Path $dir ([string]$info.azureCli.dir)) 'bin') }
  if ($info.odbc -and $info.odbc.dir) {
    $msi = Join-Path (Join-Path $dir ([string]$info.odbc.dir)) ([string]$info.odbc.msi)
    $vc = Join-Path (Join-Path $dir ([string]$info.odbc.dir)) ([string]$info.odbc.vcRedist)
    if ((Test-Path -LiteralPath $msi -PathType Leaf) -and (Test-Path -LiteralPath $vc -PathType Leaf)) {
      $script:CoopBundledOdbc = [pscustomobject]@{ Version = [string]$info.odbc.version; Msi = $msi; VcRedist = $vc }
    }
  }
  # Prepended in reverse, so PATH reads prefix, node, git, python, az, then the rest.
  $all = @($prefix, $nodeDir) + @($first | Where-Object { Test-Path -LiteralPath $_ -PathType Container })
  [array]::Reverse($all)
  foreach ($d in $all) {
    if (($env:PATH -split $sep) -notcontains $d) { $env:PATH = "$d$sep$env:PATH" }
  }
  $env:npm_config_prefix = $prefix
  # The package's own window: coop.exe two levels above the snapshot
  # (<app>\resources\coop), which `coop desktop` opens instead of a runtime tree.
  $exe = Join-Path (Split-Path -Parent (Split-Path -Parent $script:CoopRoot)) 'coop.exe'
  if (Test-Path -LiteralPath $exe -PathType Leaf) { $script:CoopWindowExe = $exe }
}
Initialize-CoopBundledRuntime
function Test-CoopBundledRuntime { return [bool]$script:CoopBundledRuntime }
# Is <Path> inside the bundled runtime? (A prerequisite row says "bundled with the
# coop window" only for the package's own copy, not a machine install on PATH.)
function Test-CoopBundledPath([string]$Path) {
  if (-not $script:CoopBundledRuntime -or -not $Path) { return $false }
  return (Test-CoopPathInside -Path $Path -Root $script:CoopBundledRuntime)
}
# The bundled Python (D1k), or '' outside the package.
function Get-CoopBundledPython {
  $info = $script:CoopBundledRuntimeInfo
  if (-not $script:CoopBundledRuntime -or -not $info -or -not $info.python -or -not $info.python.dir) { return '' }
  $exe = Join-Path (Join-Path $script:CoopBundledRuntime ([string]$info.python.dir)) 'python.exe'
  if (Test-Path -LiteralPath $exe -PathType Leaf) { return $exe }
  return ''
}
# pipx and pip read the package's wheel folder instead of the internet (D1k):
# PIP_NO_INDEX and PIP_FIND_LINKS for one pipx call that installs or injects
# exact pins (`name==version`), so the first launch works offline. Anything else
# (an --edge install of the latest, `pipx upgrade`, COOP_PIP_ONLINE=1) keeps the
# index. Returns the previous values for Restore-CoopBundledWheels, or $null when
# nothing changed. The variables are set only around coop's own pipx calls, never
# for the session, so a pip the user runs inside coop still reaches PyPI.
function Use-CoopBundledWheels([string[]]$PipxArgs) {
  $wheels = [string]$env:COOP_BUNDLED_WHEELS
  if (-not $wheels -or $env:COOP_PIP_ONLINE -eq '1' -or -not (Test-Path -LiteralPath $wheels -PathType Container)) { return $null }
  $a = @($PipxArgs)
  if ($a.Count -lt 2 -or @('install', 'inject') -notcontains $a[0]) { return $null }
  $positional = @()
  for ($i = 1; $i -lt $a.Count; $i++) {
    if ($a[$i] -eq '--python') { $i++; continue }
    if ([string]$a[$i] -like '-*') { continue }
    $positional += [string]$a[$i]
  }
  $specs = if ($a[0] -eq 'inject') { @($positional | Select-Object -Skip 1) } else { $positional }
  if ($specs.Count -eq 0) { return $null }
  foreach ($spec in $specs) { if ($spec -notmatch '^[A-Za-z0-9._-]+==[^=]+$') { return $null } }
  $saved = @{ PIP_NO_INDEX = $env:PIP_NO_INDEX; PIP_FIND_LINKS = $env:PIP_FIND_LINKS }
  $env:PIP_NO_INDEX = '1'
  $env:PIP_FIND_LINKS = $wheels
  return $saved
}
function Restore-CoopBundledWheels($Saved) {
  if ($null -eq $Saved) { return }
  foreach ($k in @('PIP_NO_INDEX', 'PIP_FIND_LINKS')) {
    if ($null -eq $Saved[$k]) { Remove-Item -LiteralPath "Env:$k" -ErrorAction SilentlyContinue }
    else { Set-Item -LiteralPath "Env:$k" -Value $Saved[$k] }
  }
}
# A terminal install that already owns the `coop` command and the "coop"
# double-click launcher keeps them when the coop window package (D1d) runs its
# first-launch install from the snapshot: the package never retargets either at
# itself. The link is %LOCALAPPDATA%\coop\bin\coop.cmd forwarding to
# <root>\bin\coop.cmd (scripts\install.ps1); it belongs to another install when
# that target exists and is not this checkout's.
function Get-CoopLinkedLauncherTarget {
  param([string]$LauncherDir = (Join-Path $env:LOCALAPPDATA 'coop\bin'))
  if (-not $LauncherDir) { return $null }
  $launcher = Join-Path $LauncherDir 'coop.cmd'
  if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { return $null }
  $body = ''
  try { $body = [System.IO.File]::ReadAllText($launcher) } catch { return $null }
  if ($body -match 'call\s+"([^"]+)"') {
    $target = $Matches[1]
    if (Test-Path -LiteralPath $target -PathType Leaf) { return $target }
  }
  return $null
}
function Test-CoopForeignLauncherLink {
  param([string]$LauncherDir = (Join-Path $env:LOCALAPPDATA 'coop\bin'))
  $target = Get-CoopLinkedLauncherTarget -LauncherDir $LauncherDir
  if (-not $target) { return $false }
  $mine = Join-Path $script:CoopRoot 'bin\coop.cmd'
  return ((ConvertTo-CoopComparablePath $target) -ne (ConvertTo-CoopComparablePath $mine))
}
# The "coop" shortcut (Start Menu or Desktop) of another install: one that exists
# and does not start this checkout's bin\coop-desktop.ps1.
function Test-CoopForeignTerminalShortcut {
  if ($env:OS -ne 'Windows_NT') { return $false }
  $mine = ConvertTo-CoopComparablePath (Join-Path $script:CoopRoot 'bin\coop-desktop.ps1')
  $ws = $null
  foreach ($dir in (Get-CoopShortcutDirs)) {
    if (-not $dir) { continue }
    $lnk = Join-Path $dir 'coop.lnk'
    if (-not (Test-Path -LiteralPath $lnk -PathType Leaf)) { continue }
    try {
      if (-not $ws) { $ws = New-Object -ComObject WScript.Shell }
      $args = [string]$ws.CreateShortcut($lnk).Arguments
    } catch { continue }
    if ($args -match '-File\s+"([^"]+)"') {
      if ((ConvertTo-CoopComparablePath $Matches[1]) -ne $mine) { return $true }
    } elseif ($args) { return $true }
  }
  return $false
}
# The package's first launch on this profile: the agent dir does not carry this
# release's extension lock yet (a fresh machine, or a profile an older coop set
# up), so `coop desktop` runs the install first (D1d).
function Test-CoopBundledSetupPending {
  if (-not $script:CoopBundledRuntime) { return $false }
  return (Test-CoopExtensionsLockPending -AgentDir (Get-CoopPiAgentDir) -PiVersion (Get-CoopPiVersion))
}
# npm's global package root inside the bundled prefix (npm's own layout:
# <prefix>\node_modules on Windows, <prefix>/lib/node_modules elsewhere).
function Get-CoopBundledNpmRoot {
  if (-not $script:CoopBundledRuntime) { return '' }
  $prefix = Join-Path $script:CoopBundledRuntime ([string]$script:CoopBundledRuntimeInfo.npm.prefix)
  if ($env:OS -eq 'Windows_NT') { return (Join-Path $prefix 'node_modules') }
  return (Join-Path $prefix 'lib/node_modules')
}

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

# --- Fleet plan: the one manifest-driven list of what coop installs -----------
# Every lifecycle script (install, update, sync, uninstall, doctor --fix) reads
# this plan instead of carrying its own copy of the fleet (master plan S2, #222).
# Pins come from config/release-manifest.json. -Edge drops the Pi and tool pins
# (an unpinned spec means upstream latest); extensions stay pinned regardless,
# because sync has no --edge. fabric-cicd and pyodbc are libraries injected into
# the Fabric CLI environment (Sync-CoopFabricPythonPackages), not standalone
# tools, and powerbi-desktop-bridge needs Power BI Desktop, so it is a
# Windows-only npm tool. Returns
#   @{ PiPackage; PiPin; PiSpec; Extensions; PythonTools; Fabric; FabricRuntime; NpmTools }
# where every Extensions / PythonTools / NpmTools row (and Fabric, $null under
# -NoFabric) is @{ Name; Pin; Spec }. An npm tool without a pin has Spec '' in
# normal mode: it fails to converge rather than falling back to npm's latest.
$script:CoopFabricCliPackage = 'ms-fabric-cli'
$script:CoopFabricRuntimeLibraries = @('fabric-cicd', 'pyodbc')
$script:CoopWindowsOnlyNpmTools = @('@microsoft/powerbi-desktop-bridge-cli')
function Get-CoopFleetPlan {
  param([switch]$Edge, [switch]$NoFabric)
  $piPackage = Coop-ManifestGet -Key 'pi.package' -Default '@earendil-works/pi-coding-agent'
  $piPin = Coop-ManifestGet -Key 'pi.version'
  $piSpec = if (-not $Edge -and $piPin) { "${piPackage}@${piPin}" } else { $piPackage }
  $extensions = @()
  foreach ($name in @(Coop-ManifestKeys 'extensions')) {
    $extensions += [pscustomobject]@{ Name = [string]$name; Pin = [string](Coop-ManifestObjectGet 'extensions' $name); Spec = [string](Coop-ManifestExtensionSpec $name) }
  }
  $pythonTools = @()
  $fabric = $null
  foreach ($name in @(Coop-ManifestKeys 'python_tools')) {
    if ($script:CoopFabricRuntimeLibraries -contains $name) { continue }
    $pin = [string](Coop-ManifestObjectGet 'python_tools' $name)
    $spec = if (-not $Edge -and $pin) { "${name}==${pin}" } else { [string]$name }
    $row = [pscustomobject]@{ Name = [string]$name; Pin = $pin; Spec = $spec }
    if ($name -eq $script:CoopFabricCliPackage) { if (-not $NoFabric) { $fabric = $row } }
    else { $pythonTools += $row }
  }
  $npmTools = @()
  foreach ($name in @(Coop-ManifestKeys 'npm_tools')) {
    if (($script:CoopWindowsOnlyNpmTools -contains $name) -and ($env:OS -ne 'Windows_NT')) { continue }
    $pin = [string](Coop-ManifestObjectGet 'npm_tools' $name)
    $spec = if ($Edge) { [string]$name } elseif ($pin) { "${name}@${pin}" } else { '' }
    $npmTools += [pscustomobject]@{ Name = [string]$name; Pin = $pin; Spec = $spec }
  }
  return [pscustomobject]@{
    PiPackage     = [string]$piPackage
    PiPin         = [string]$piPin
    PiSpec        = [string]$piSpec
    Extensions    = @($extensions)
    PythonTools   = @($pythonTools)
    Fabric        = $fabric
    FabricRuntime = @($script:CoopFabricRuntimeLibraries)
    NpmTools      = @($npmTools)
  }
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

# --- pipx inventory probes (truthful tool inventory) --------------------------
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
  # No pipx yet (a fresh machine, the coop window package before its first
  # setup): no version, and no raw "term 'pipx' is not recognized" on the console.
  if (-not (Get-Command $pipx -ErrorAction SilentlyContinue)) { return '' }
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
  # The coop window package's own Python (D1k) wins: its wheel folder holds the
  # Fabric CLI for exactly this interpreter.
  $bundled = Get-CoopBundledPython
  if ($bundled -and ((Get-CoopPythonMinorVersion $bundled) -match '^3\.(10|11|12|13)$')) { return $bundled }
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

# Converge the runtime libraries inside the Fabric CLI venv. A library whose
# installed version already equals its manifest pin is left alone, so a sync
# with everything present makes no pipx inject call and needs no network; only a
# missing or drifted library (or fabric-cicd under -Edge, which means upstream
# latest) is re-injected, with --force so a drifted one is replaced (#186). When
# pip fails, its last ERROR line rides on the warning so the cause is visible.
function Sync-CoopFabricPythonPackages([bool]$Edge = $false) {
  if (-not $env:COOP_FABRIC_PYTHON) {
    $pipx = Get-CoopPipxCmd
    foreach ($pkg in $script:CoopFabricRuntimeLibraries) {
      $pin = Coop-ManifestGet -Key "python_tools.$pkg"
      if (-not $pin) { return $false }
      $wantLatest = ($Edge -and $pkg -eq 'fabric-cicd')
      if (-not $wantLatest) {
        $installed = Get-CoopVenvDistVersion 'ms-fabric-cli' $pkg
        if ($installed -eq $pin) { continue }
      }
      $spec = if ($wantLatest) { $pkg } else { "$pkg==$pin" }
      # pip's errors arrive on stderr; keep them as text rather than letting a
      # caller's $ErrorActionPreference = 'Stop' turn the first line terminating.
      $previousEap = $ErrorActionPreference
      $wheelEnv = Use-CoopBundledWheels @('inject', 'ms-fabric-cli', $spec, '--force')
      try {
        $ErrorActionPreference = 'Continue'
        $out = (& $pipx inject ms-fabric-cli $spec --force 2>&1 | Out-String)
        $rc = $LASTEXITCODE
      } finally { $ErrorActionPreference = $previousEap; Restore-CoopBundledWheels $wheelEnv }
      if ($rc -ne 0) { Coop-Warn "failed to install $spec in the ms-fabric-cli environment" (Coop-PipErrorTail $out); return $false }
    }
  }
  $status = Get-CoopFabricSqlRuntimeStatus
  return ($status.state -eq 'ready' -or $status.state -eq 'driver_missing')
}

# The coop window package's ODBC Driver 18 (D1k, Aaron 2026-10-06 "ask"): its
# VC++ runtime, then the MSI with the license accepted, in ONE elevated cmd.exe so
# Windows asks for administrator permission once. Returns 'ok', 'declined' (the
# permission prompt was refused) or 'failed'. msiexec 0 and 3010 (restart later)
# are success; the VC++ runtime's own code is ignored (1638 = a newer one is
# already installed), the driver check afterwards is the verdict.
function Install-CoopBundledOdbc {
  $b = $script:CoopBundledOdbc
  if (-not $b) { return 'failed' }
  $inner = '"' + $b.VcRedist + '" /install /quiet /norestart & msiexec.exe /i "' + $b.Msi + '" /quiet /norestart IACCEPTMSODBCSQLLICENSETERMS=YES'
  $p = $null
  try {
    $p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/s', '/c', ('"' + $inner + '"')) -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop
  } catch {
    return 'declined'
  }
  if ($p -and @(0, 3010) -notcontains $p.ExitCode) { return 'failed' }
  return 'ok'
}

function Ensure-CoopFabricOdbcDriver([bool]$AllowPrereqs = $true, [bool]$Auto = $false) {
  $status = Get-CoopFabricSqlRuntimeStatus
  if ($status.state -eq 'ready') { return $true }
  if ($status.state -ne 'driver_missing') { return $false }
  if ($env:OS -ne 'Windows_NT') {
    Coop-Warn 'ODBC Driver 18+ for SQL Server is missing' 'install Microsoft ODBC Driver 18 for SQL Server, then run: coop doctor'
    return $true
  }
  if (-not $AllowPrereqs) { Coop-Warn 'ODBC Driver 18+ is missing (--no-prereqs)' 'install Microsoft.msodbcsql.18, then run: coop doctor'; return $false }
  if ($script:CoopBundledOdbc) {
    # The window's first launch (--prereqs auto) needs no keyboard question: the
    # Windows administrator prompt is the ask, and the docs name the license.
    if (-not $Auto -and -not (Coop-Confirm 'Install Microsoft ODBC Driver 18 for SQL Server from the coop window package and accept its license?')) {
      Coop-Warn 'ODBC Driver 18+ is required for live SQL; license was not accepted' 're-run with --yes, or start the coop window again'
      return $false
    }
    Coop-Info "installing ODBC Driver $($script:CoopBundledOdbc.Version) for SQL Server from the coop window package: Windows asks for administrator permission once, and installing it accepts Microsoft's license for the driver"
    $result = Install-CoopBundledOdbc
    if ($result -eq 'declined') { Coop-Warn 'ODBC Driver 18 was not installed: the administrator prompt was declined' 'live SQL needs it; start the coop window again and choose Yes, or ask whoever manages this machine'; return $false }
    if ($result -ne 'ok') { Coop-Warn 'ODBC Driver 18 installation failed' 'start the coop window again, or install Microsoft ODBC Driver 18 for SQL Server yourself, then run: coop doctor'; return $false }
    $after = Get-CoopFabricSqlRuntimeStatus
    if ($after.state -ne 'ready') { Coop-Warn 'ODBC Driver 18 installation completed but the selected Fabric runtime cannot see it' 'open a new terminal, then run: coop doctor'; return $false }
    Coop-Ok 'ODBC Driver 18 for SQL Server installed'
    return $true
  }
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
  # as argv[0] (effectively `npm npm --version`). Prefer the native .cmd shim on
  # Windows only: pwsh on Linux/macOS also resolves an `npm.cmd` on PATH and
  # cannot run it ("Cannot run a document in the middle of a pipeline").
  $npmCommand = $null
  if ($env:OS -eq 'Windows_NT') { $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1 }
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
# versions and reinstall. PRODUCTION
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
# install (better-sqlite3 and sharp build or fetch their binaries).
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
# config\extensions-lock.json.
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
  # Native stderr (extlock's "tree declares X" line, npm warnings) is a
  # NativeCommandError under Windows PowerShell 5.1 when redirected, and a
  # terminating one in a caller running with $ErrorActionPreference = 'Stop';
  # the exit code is the only signal these two commands carry.
  $previousEap = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    node (Join-Path $script:CoopRoot 'lib\extlock.js') matches $AgentDir $lock *> $null
    $matchRc = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousEap }
  if ($matchRc -ne 0) { return $false }
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
    $ErrorActionPreference = 'Continue'
    & $Npm ci --no-audit --no-fund *> $null
    $rc = $LASTEXITCODE
  } catch { $rc = 1 } finally { $ErrorActionPreference = $previousEap; Pop-Location }
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

# Copy a folder tree: robocopy on Windows (it copies tens of thousands of
# node_modules files far faster than Copy-Item; exit codes below 8 are success),
# Copy-Item elsewhere. Returns $true when the copy succeeded.
function Copy-CoopTree([string]$Source, [string]$Destination) {
  if ($env:OS -eq 'Windows_NT' -and (Test-Have 'robocopy')) {
    & robocopy $Source $Destination /E /NFL /NDL /NJH /NJS /NP /R:2 /W:1 *> $null
    return ($LASTEXITCODE -lt 8)
  }
  try { Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force -ErrorAction Stop; return $true } catch { return $false }
}

# Seed the isolated extension tree from the window package (master plan D1d):
# when the package's bundled tree was installed from THIS release's lock and the
# agent dir does not carry that lock yet, copy package.json, package-lock.json
# and node_modules into <agent dir>\npm and declare each manifest extension in
# settings.json the way `pi install` records it, so Pi loads the tree without
# a network or an npm run. Returns $true when the tree was seeded; $false when
# there is no bundle, it was built for another lock, or the tree already carries
# the lock (nothing to do; the regular convergence then sees every pin in place).
function Restore-CoopBundledExtensions([string]$AgentDir) {
  if (-not $script:CoopBundledRuntime -or -not $script:CoopBundledRuntimeInfo.extensions) { return $false }
  $src = Join-Path $script:CoopBundledRuntime ([string]$script:CoopBundledRuntimeInfo.extensions.dir)
  $lock = Join-Path $script:CoopRoot 'config\extensions-lock.json'
  if (-not (Test-Path -LiteralPath (Join-Path $src 'node_modules') -PathType Container) -or -not (Test-Path -LiteralPath $lock -PathType Leaf)) { return $false }
  if ((Get-CoopFileSha256 (Join-Path $src 'package-lock.json')) -ne (Get-CoopFileSha256 $lock)) { return $false }
  if (-not (Test-CoopExtensionsLockPending -AgentDir $AgentDir -PiVersion (Get-CoopPiVersion))) { return $false }
  $npmDir = Join-Path $AgentDir 'npm'
  Coop-Info "seeding the extension tree from the coop window package into $npmDir..."
  try {
    New-Item -ItemType Directory -Force -Path $npmDir | Out-Null
    Remove-Item -LiteralPath (Join-Path $npmDir 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Copy-CoopTree (Join-Path $src 'node_modules') (Join-Path $npmDir 'node_modules'))) { throw 'the copy failed' }
    Copy-Item -LiteralPath (Join-Path $src 'package.json') -Destination (Join-Path $npmDir 'package.json') -Force -ErrorAction Stop
    Copy-Item -LiteralPath (Join-Path $src 'package-lock.json') -Destination (Join-Path $npmDir 'package-lock.json') -Force -ErrorAction Stop
    Remove-Item -LiteralPath (Join-Path $npmDir '.coop-lock-failed.json') -Force -ErrorAction SilentlyContinue
  } catch {
    Coop-Warn "could not seed the extension tree from the package: $($_.Exception.Message)" 'coop sync installs it from the lock instead'
    return $false
  }
  $sources = @()
  foreach ($ext in (Get-CoopFleetPlan).Extensions) { if ($ext.Spec) { $sources += [string]$ext.Spec } }
  $py = Get-CoopPython
  if (-not $py) { Coop-Warn 'could not declare the bundled extensions in settings.json (Python not found)' 'run: coop sync'; return $false }
  if ($sources.Count -gt 0) {
    & $py (Join-Path $script:CoopRoot 'lib\pi_settings.py') ensure-packages (Join-Path $AgentDir 'settings.json') @sources
    if ($LASTEXITCODE -ne 0) { Coop-Warn 'could not declare the bundled extensions in settings.json' 'run: coop sync'; return $false }
  }
  Coop-Ok "extension tree seeded from the coop window package ($($sources.Count) extension(s) at their pins)"
  return $true
}

# --- One writer for the extension tree ---------------------------------------
# `coop sync`, `coop install`, `coop update` and the coop window's first launch
# (Restore-CoopBundledExtensions, then the same convergence) all rewrite
# <agent dir>\npm. Two at once leave a half-written tree: on 2026-10-05 the
# window's first launch deleted node_modules and copied the bundled tree while a
# `coop sync` ran `npm ci` in the same folder, and Pi then failed to load
# pi-mcp-adapter and pi-hermes-memory ("Cannot find module"). One named mutex per
# agent dir (machine-wide for this user session): a second writer waits for the
# first to finish, and a launch waits the same way before Pi loads the tree.
# COOP_EXT_TREE_LOCK_TIMEOUT (seconds) overrides the wait, for the tests.
function Get-CoopExtensionTreeMutexName([string]$AgentDir) {
  $key = ConvertTo-CoopComparablePath $AgentDir
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $hex = -join ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($key)) | ForEach-Object { $_.ToString('x2') }) }
  finally { $sha.Dispose() }
  return 'coop-extension-tree-' + $hex.Substring(0, 16)
}
# Returns the held mutex (pass it to Unlock-CoopExtensionTree), or $null when the
# other writer did not finish within the timeout. A mutex a crashed process left
# behind counts as acquired.
function Lock-CoopExtensionTree {
  param([string]$AgentDir, [int]$TimeoutSeconds = 900, [string]$Who = 'another coop process')
  if ($env:COOP_EXT_TREE_LOCK_TIMEOUT -match '^\d+$') { $TimeoutSeconds = [int]$env:COOP_EXT_TREE_LOCK_TIMEOUT }
  $mutex = New-Object System.Threading.Mutex($false, (Get-CoopExtensionTreeMutexName $AgentDir))
  $got = $false
  try { $got = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $got = $true }
  if (-not $got) {
    Coop-Info "$Who is updating the extension tree in $AgentDir; waiting for it to finish (up to $TimeoutSeconds s)..."
    try { $got = $mutex.WaitOne([TimeSpan]::FromSeconds($TimeoutSeconds)) } catch [System.Threading.AbandonedMutexException] { $got = $true }
  }
  if (-not $got) { $mutex.Dispose(); return $null }
  return $mutex
}
function Unlock-CoopExtensionTree($Mutex) {
  if (-not $Mutex) { return }
  try { $Mutex.ReleaseMutex() } catch { }
  $Mutex.Dispose()
}
# Before Pi loads the tree: wait for a writer that is still at work (the half-
# written tree is what Pi would otherwise load). $true when the tree is free.
function Wait-CoopExtensionTreeIdle([string]$AgentDir) {
  $m = Lock-CoopExtensionTree -AgentDir $AgentDir -Who 'coop sync'
  if (-not $m) { return $false }
  Unlock-CoopExtensionTree $m
  return $true
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
# redirected output gets plain text.
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
# Built for installers where each item (npm/pipx/pi install)
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
  # TTY redraw branch below is unchanged.
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
# Optional second argument is the "how to fix" hint. `coop desktop` also collects
# its launch warnings in $script:CoopWarnSink (a List[string]; $null elsewhere) and
# hands them to the window, whose console closes once the window opens.
$script:CoopWarnSink = $null
function Coop-Warn {
  param([string]$m, [string]$Hint = '')
  $text = $m + $(if ($Hint) { " — $Hint" } else { '' })
  Coop-Emit "$($script:C_OLIVE)!$($script:C_RST) $text"
  if ($null -ne $script:CoopWarnSink) { [void]$script:CoopWarnSink.Add($text) }
}
function Coop-Err  { param([string]$m) Coop-Emit "$($script:C_RED)$($script:G_CROSS)$($script:C_RST) $m" }
function Coop-Die  { param([string]$m) Coop-Err $m; exit 1 }
function Coop-Head { param([string]$m) Coop-Emit "`n$($script:C_BOLD)$($script:C_NAVY)$m$($script:C_RST)" }

# --- Small utilities ----------------------------------------------------------
# Is a command available on PATH?
function Test-Have { param([string]$Name) [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

# Pick a usable python interpreter that ACTUALLY runs — not the Windows Store
# App-Execution-Alias stub. python.org's installer never creates python3.exe, so
# on stock Windows `python3` resolves ONLY to the Store stub under
# ...\WindowsApps\: Get-Command succeeds while `--version` prints nothing.
# Prefer python3, fall back to python; $null when neither is real.
# THE one python resolver; don't re-add per-script copies.
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

  # The window package carries Git, Python with pipx, and the Azure CLI (D1k): a
  # row met by the package's own copy says so.
  $bundledNote = {
    param([string]$Name, [string]$Detail)
    $c = Get-Command $Name -ErrorAction SilentlyContinue
    if ($c -and $c.Source -and (Test-CoopBundledPath $c.Source)) { if ($Detail) { return "$Detail, bundled with the coop window" } else { return 'bundled with the coop window' } }
    return $Detail
  }
  $gitOk = Test-Have 'git'
  $rows += & $row 1 'Git' $true $gitOk $(if ($gitOk) { & $bundledNote 'git' (& $ver 'git') } else { 'not found' }) $fix.git

  $nodeMin = Coop-ManifestGet -Key 'node.min' -Default '22.19.0'
  $nodeOk = $false; $nodeDet = 'not found'
  if (Test-Have 'node') {
    $nv = & $ver 'node'
    if ($nv -and ([version]$nv -ge [version]$nodeMin)) { $nodeOk = $true; $nodeDet = $nv }
    else { $nodeDet = "$(if ($nv) { $nv } else { 'unknown version' }) is older than $nodeMin" }
  }
  # The window package carries its own Node (D1d), so the row is never a fix there.
  if ($nodeOk -and (Test-CoopBundledRuntime)) { $nodeDet = "$nodeDet, bundled with the coop window" }
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
  if ($pyOk -and $fabPy -and (Test-CoopBundledPath $fabPy)) { $pyDet = "$pyDet, bundled with the coop window" }
  $rows += & $row 3 'Python 3.10-3.13 (3.12 recommended)' $true $pyOk $pyDet $pyFix

  if ($pipxVia.Count -gt 0 -and $pipxVia[0] -eq 'pipx') { $pipxDet = & $bundledNote 'pipx' $pipxDet }
  $rows += & $row 4 'pipx' $true ($pipxVia.Count -gt 0) $pipxDet $fix.pipx

  $azOk = Test-Have 'az'
  $rows += & $row 5 'Azure CLI' $true $azOk $(if ($azOk) { & $bundledNote 'az' '' } else { 'not found' }) $fix.az

  # Not blocking here: install offers ODBC with its license prompt after the
  # Fabric CLI, and doctor checks that the Fabric runtime can load it. The window
  # package installs its own copy there with one administrator prompt (D1k).
  $odbcOk = Test-CoopOdbcDriver18
  $odbcFix = $fix.odbc
  if ($script:CoopBundledOdbc) { $odbcFix = 'see below: this setup installs it from the coop window package (Windows asks for administrator permission once)' }
  $rows += & $row 6 'ODBC Driver 18 for SQL Server' $false $odbcOk $(if ($odbcOk) { '' } else { 'not found; needed for live SQL' }) $odbcFix

  $teOk = Test-Have 'te'
  $rows += & $row 7 'Tabular Editor CLI (optional, BPA reviews)' $false $teOk $(if ($teOk) { '' } else { 'not found' }) 'download te from https://tabulareditor.com/product/features-and-tools/tabular-editor-cli, put it on PATH, then: te auth login'
  return $rows
}

# --- One profile root (master plan S3) ----------------------------------------
# The ONE meaning of the location variables, mirrored by lib/coop_paths.py and
# lib/paths.mjs:
#   COOP_DIR is the PARENT of .coop: the profile dir is $COOP_DIR\.coop, default
#   $HOME\.coop (config, user.json, agent\, support\, standards\, devops\).
#   The agent dir Pi ACTUALLY loads is one chain everywhere: PI_CODING_AGENT_DIR
#   -> COOP_NO_ISOLATE truthy (1|true|yes|on, any case) -> $HOME\.pi\agent
#   -> COOP_AGENT_DIR -> <profile dir>\agent.
# With no variables set every helper yields the historical ~/.coop/... path.
function Get-CoopProfileDir {
  $base = if ($env:COOP_DIR) { $env:COOP_DIR } else { $HOME }
  return (Join-Path $base '.coop')
}

# The fleet/integration config written by scripts/onboard.py.
function Get-CoopConfigFile { return (Join-Path (Get-CoopProfileDir) 'config') }

# The local user profile written by scripts/onboard.py.
function Get-CoopUserProfileFile { return (Join-Path (Get-CoopProfileDir) 'user.json') }

# The machine-level profile (master plan P1): one user.json per machine for the
# team's VMs, where every client is its own Windows user and one person owns the
# machine. COOP_MACHINE_DIR names its folder (tests, sandboxes); else
# %ProgramData%\coop on Windows and /etc/coop elsewhere. It holds only the
# person's name and communication preference, never anything client-shaped; the
# per-user file wins field by field (mirror of lib/paths.mjs machineProfilePath).
function Get-CoopMachineProfileDir {
  if ($env:COOP_MACHINE_DIR) { return [string]$env:COOP_MACHINE_DIR }
  if ($env:ProgramData) { return (Join-Path $env:ProgramData 'coop') }
  if ([System.IO.Path]::DirectorySeparatorChar -eq '\') { return 'C:\ProgramData\coop' }
  return '/etc/coop'
}
function Get-CoopMachineProfileFile { return (Join-Path (Get-CoopMachineProfileDir) 'user.json') }

# The name coop calls the person and the file that supplied it: @{ Name; Source }
# with Source 'user', 'machine' or '' (no usable name anywhere). Same resolution
# as lib/user-profile.mjs effectiveProfile; a malformed file counts as absent.
function Get-CoopEffectiveProfileName {
  foreach ($pair in @(@('user', (Get-CoopUserProfileFile)), @('machine', (Get-CoopMachineProfileFile)))) {
    $file = $pair[1]
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
    try {
      $raw = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($null -eq $raw -or $raw.schema_version -ne 1) { continue }
      $name = [string]$raw.name
      $name = ($name -replace '[\x00-\x1f\x7f-\x9f\u2028\u2029]+', ' ') -replace '\s+', ' '
      $name = $name.Trim()
      if ($name.Length -gt 100) { $name = $name.Substring(0, 100) }
      if ($name) { return @{ Name = $name; Source = $pair[0] } }
    } catch { }
  }
  return @{ Name = ''; Source = '' }
}

# True when COOP_NO_ISOLATE asks for the personal ~/.pi/agent (1|true|yes|on).
function Test-CoopNoIsolate { return ([string]$env:COOP_NO_ISOLATE).Trim() -match '^(1|true|yes|on)$' }

# The user's own Pi agent dir: the one Pi loads with COOP_NO_ISOLATE, and the
# one coop shares the login (auth/models) in from.
function Get-CoopPersonalPiAgentDir { return (Join-Path (Join-Path $HOME '.pi') 'agent') }

# coop runs Pi against an ISOLATED agent dir so coop's extensions/settings/theme
# never mix with the user's personal `pi`. Override with COOP_AGENT_DIR.
# (the same chain as lib/coop_paths.py coop_agent_dir and lib/paths.mjs coopAgentDir)
function Get-CoopPiAgentDir { if ($env:COOP_AGENT_DIR) { $env:COOP_AGENT_DIR } else { Join-Path (Get-CoopProfileDir) 'agent' } }

# The agent dir Pi will ACTUALLY load: PI_CODING_AGENT_DIR when set; with
# COOP_NO_ISOLATE truthy Pi falls back to the personal ~/.pi/agent.
# (the same chain as lib/coop_paths.py agent_dir and lib/paths.mjs agentDir)
function Get-CoopEffectiveAgentDir {
  if ($env:PI_CODING_AGENT_DIR) { return $env:PI_CODING_AGENT_DIR }
  if (Test-CoopNoIsolate) { return (Get-CoopPersonalPiAgentDir) }
  return (Get-CoopPiAgentDir)
}

# The managed MCP config (mcp-adapter.json in the agent dir Pi loads) carries the
# Warehouse target of ONE project: the contract above the folder it was generated
# in. `coop sync` writes it, and every launch rewrites it for the folder coop
# starts in (same generator, ownership-aware, non-destructive), so a `coop update`
# or the window's first launch run from the home folder never leaves the project
# folder pointed at the global endpoint ("target_mismatch", no execute_query tool;
# seen 2026-10-05). Returns 'ok', 'no_python' or 'failed'; -Quiet keeps the
# generator's stderr off the console (the launch prints its own one-line warning).
function Update-CoopManagedMcpConfig {
  param(
    [string]$OutputPath = (Join-Path (Get-CoopEffectiveAgentDir) 'mcp-adapter.json'),
    [string]$ProjectCwd = (Get-Location).Path,
    [switch]$Quiet
  )
  $py = Get-CoopPython
  if (-not $py) { return 'no_python' }
  $generator = Join-Path $script:CoopRoot 'lib\mcp_config.py'
  $previousEap = $ErrorActionPreference
  $rc = 1
  try {
    # Native stderr under Windows PowerShell 5.1 would otherwise become a
    # terminating error; capture it and decide below.
    $ErrorActionPreference = 'Continue'
    $out = @(& $py $generator --config (Get-CoopConfigFile) --output $OutputPath --project-cwd $ProjectCwd 2>&1)
    $rc = $LASTEXITCODE
  } catch {
    $rc = 1
  } finally {
    $ErrorActionPreference = $previousEap
  }
  if ($rc -eq 0) { return 'ok' }
  if (-not $Quiet) { foreach ($line in $out) { Write-Host ([string]$line) } }
  return 'failed'
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
# agent's OWN version. coop's
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
  # unrelated native dependency such as pi-hermes-memory's better-sqlite3.
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

# Extensions an earlier release installed and this one no longer ships. Leaving a
# manifest does not uninstall: its `npm:<name>@<pin>` entry stays in the agent
# dir's settings.json `packages` (Pi loads it, and reinstalls it if the tree lost
# it) and in npm/package.json (lib/pins.js only adds). `pi remove` drops both.
#   context-mode: dropped in U1 (its ctx_* tools ran shell commands the
#   guardrails never saw, and its tool schemas cost ~7k tokens per request).
$script:CoopRetiredExtensions = @('context-mode')

# Remove every retired extension still present in the isolated agent dir, through
# `pi remove` (the caller has PI_CODING_AGENT_DIR pointed at $AgentDir). Returns
# the failure count; absent extensions are a silent no-op.
function Remove-CoopRetiredExtensions([string]$AgentDir) {
  $failures = 0
  $settingsPath = Join-Path $AgentDir 'settings.json'
  $settingsText = ''
  if (Test-Path -LiteralPath $settingsPath) {
    try { $settingsText = Get-Content -LiteralPath $settingsPath -Raw } catch { $settingsText = '' }
  }
  foreach ($name in $script:CoopRetiredExtensions) {
    $listed = $settingsText -match ('"npm:' + [regex]::Escape($name) + '(@[^"]*)?"')
    $installed = [bool](Get-CoopExtInstalledVersion -AgentDir $AgentDir -Name $name)
    if (-not $listed -and -not $installed) { continue }
    Coop-Info "Removing $name (no longer part of coop)…"
    & pi remove "npm:$name" > $null 2>&1
    if ($LASTEXITCODE -ne 0 -or (Get-CoopExtInstalledVersion -AgentDir $AgentDir -Name $name)) {
      Coop-Warn "could not remove $name from the isolated tree" "run: pi remove npm:$name (with PI_CODING_AGENT_DIR=$AgentDir)"
      $failures++
    } else {
      Coop-Ok "Removed $name"
    }
  }
  return $failures
}

# --- The todo panel's key (@juicesharp/rpiv-todo) --------------------------------
# rpiv-todo collapses its task panel with Ctrl+Shift+T by default, which is also
# Pi's `app.session.tree` key; Pi's editor runs extension shortcuts first, so the
# tree would never open from that key in a coop terminal. The extension reads only
# `~/.config/rpiv-todo/config.json` (no agent-dir setting), so sync seeds that file
# once with Alt+T, free in Pi, Windows Terminal and the coop window, which binds
# the same key (desktop/PARITY.md). A file the user already has is never
# rewritten. Best-effort: returns $true only when it wrote the file.
function Set-CoopTodoConfig {
  param([string]$HomeDir = $HOME)
  $dir = Join-Path (Join-Path $HomeDir '.config') 'rpiv-todo'
  $file = Join-Path $dir 'config.json'
  if (Test-Path -LiteralPath $file) { return $false }
  try {
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $json = "{`n  `"collapseKey`": `"alt+t`"`n}`n"
    [System.IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding $false))
    return $true
  } catch {
    Coop-Warn "could not write $file ($($_.Exception.Message))" 'the todo panel keeps Ctrl+Shift+T until collapseKey is set there'
    return $false
  }
}

# --- Extension fleet convergence (the ONE `pi install` path; S2, #222) ---------
# Converge every manifest extension INTO the isolated agent dir, idempotently:
#   1. `pi install <npm:name@pin>` for each extension whose installed version
#      (package.json in the tree) differs from the pin — an exact installed pin
#      needs no network or package-manager mutation, so repeat runs are offline
#      no-ops;
#   2. Sync-CoopExtensionPins (exact pins in package.json, the shipped lockfile
#      via npm ci, else npm install) — pins FIRST, then
#   3. Sync-CoopExtDeps (pi-ai / pi-tui aligned to the installed Pi) LAST, so its
#      overrides are what ships and no later reinstall recreates the startup skew;
#   4. postconditions: every extension present at its pin (a `pi install` that
#      exited 0 proves nothing on its own), then `_extdeps.py align --check`
#      (rc 10 = skew remains, rc 11 = an extension needs a newer pi-ai).
# Returns the failure count; the caller (`coop sync`, which install and update
# run as a child) turns a non-zero count into its exit code. Every Pi operation
# targets $AgentDir through PI_CODING_AGENT_DIR, never the personal ~/.pi; the
# caller's value is restored afterwards. Extensions are always pinned: --edge is
# a Pi and tools channel, not an extension one.
function Sync-CoopExtensionFleet {
  param([string]$AgentDir = (Get-CoopPiAgentDir))
  $failures = 0
  # One writer at a time (Lock-CoopExtensionTree): a `coop sync` and the window's
  # first launch that overlap would otherwise interleave their writes.
  $treeLock = Lock-CoopExtensionTree -AgentDir $AgentDir
  if (-not $treeLock) {
    Coop-Err "another coop process is still updating the extension tree in $AgentDir — wait for it to finish (or close it), then run: coop sync"
    return 1
  }
  $priorAgentDir = $env:PI_CODING_AGENT_DIR
  try {
    $env:PI_CODING_AGENT_DIR = $AgentDir
    if (-not (Test-Have 'pi')) {
      # No runtime means NO fleet convergence happened at all: per contract that
      # is a failure, not a warning.
      Coop-Err 'pi is not installed — no extensions were converged or verified' 'install Pi first: coop install'
      return 1
    }
    $failures += Remove-CoopRetiredExtensions -AgentDir $AgentDir
    # The window package ships the tree installed from the lock (D1d): seeded
    # here, every pin below is already in place and no `pi install` runs.
    [void](Restore-CoopBundledExtensions -AgentDir $AgentDir)
    $fleetSpecs = @(); $fleetNames = @(); $fleetPins = @(); $preVers = @{}
    foreach ($ext in (Get-CoopFleetPlan).Extensions) {
      if (-not $ext.Spec -or -not $ext.Pin) { Coop-Warn "manifest pin missing for $($ext.Name)"; $failures++; continue }
      # Strip only the literal four-character `npm:` transport prefix (a longer
      # cut once produced `juicesharp/...` for scoped packages).
      $fleetSpecs += ($ext.Spec -replace '^npm:', '')
      $fleetNames += $ext.Name
      $fleetPins += $ext.Pin
      $pre = Get-CoopExtInstalledVersion -AgentDir $AgentDir -Name $ext.Name
      $preVers[$ext.Name] = $pre
      Coop-Info "Ensuring isolated $($ext.Name) is version $($ext.Pin)…"
      if ($pre -ne $ext.Pin) {
        & pi install $ext.Spec > $null 2>&1
        if ($LASTEXITCODE -ne 0) { Coop-Warn "could not install $($ext.Name) (pin $($ext.Pin))"; $failures++ }
      }
    }

    if ($fleetSpecs.Count -gt 0) {
      # Sync-CoopExtensionPins runs lib/pins.js un-redirected, so its output can
      # carry node's lines ahead of the verdict: the last Boolean is the verdict.
      $pinsOk = $false
      foreach ($item in @(Sync-CoopExtensionPins -AgentDir $AgentDir -Specs $fleetSpecs)) { if ($item -is [bool]) { $pinsOk = $item } }
      if (-not $pinsOk) {
        Coop-Warn "could not enforce exact extension pins in $AgentDir\npm" 'run: coop sync'
        $failures++
      }
    }

    $piRuntime = Get-CoopPiVersion
    if ($piRuntime) { Coop-Info "Aligning shared Pi libraries with the installed Pi runtime ${piRuntime}…" }
    Sync-CoopExtDeps -AgentDir $AgentDir

    for ($k = 0; $k -lt $fleetNames.Count; $k++) {
      $ext = $fleetNames[$k]; $extPin = $fleetPins[$k]; $pre = $preVers[$ext]
      $postVer = Get-CoopExtInstalledVersion -AgentDir $AgentDir -Name $ext
      if (-not $postVer) {
        Coop-Warn "postcondition failed: pi install reported success, but $ext is MISSING from the isolated tree (wanted $extPin)" 'run: coop sync'
        $failures++
        continue
      }
      if ($postVer -ne $extPin) {
        Coop-Warn "postcondition failed: pi install reported success, but $ext is version $postVer, not the pinned $extPin" 'run: coop sync'
        $failures++
        continue
      }
      switch ($pre) {
        ''             { Coop-Ok "Installed release version $extPin ($ext)" }
        $extPin        { Coop-Ok "Already at release version $extPin ($ext)" }
        default {
          if (Coop-VersionLessThan $extPin $pre) { Coop-Ok "Downgraded untested $pre → release version $extPin ($ext)" }
          else { Coop-Ok "Updated $pre → $extPin ($ext)" }
        }
      }
    }

    if ($piRuntime) {
      $py = Get-CoopPython
      if ($py) {
        & $py (Join-Path $script:CoopRoot 'lib\_extdeps.py') align $AgentDir $piRuntime --check *> $null
        $alignRc = $LASTEXITCODE
        if ($alignRc -eq 10) {
          Coop-Err "shared-library skew remains after alignment (wanted pi-ai/pi-tui for pi $piRuntime)"
          $failures++
        } elseif ($alignRc -eq 11) {
          Coop-Err "an installed extension needs newer pi-ai libraries than pi $piRuntime provides — run: coop update (moves Pi to this release's tested version), then: coop sync"
          $failures++
        }
      }
    }
  }
  finally {
    Unlock-CoopExtensionTree $treeLock
    if ($null -ne $priorAgentDir) { $env:PI_CODING_AGENT_DIR = $priorAgentDir }
    else { Remove-Item Env:PI_CODING_AGENT_DIR -ErrorAction SilentlyContinue }
  }
  return $failures
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
# and Ctrl-C cancels it (read as a key, so it does not stop the launch). A
# timeout or a non-authentication error never opens a sign-in. Any failure
# prints ONE line naming the command to run (Get-CoopAzLoginHint /
# Get-CoopAzTokenHint, the same pair `coop doctor` prints), and the launch
# continues.
#
# Cached: a verified check stamps the tenant id into <agent-dir>/.az-ok. Tokens
# live ~60 minutes and `az` cold-starts in ~1-3s, so within 30 minutes of a
# success for the SAME tenant no az call is made. A failed check (or a stale,
# missing or mismatched marker) re-checks; marker I/O is best-effort and never
# fails the launch.

# Resolve the client Azure tenant. The chain and its
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

# Run az with a hard time limit. Returns
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
function Invoke-CoopAz {
  param([int]$Seconds, [string[]]$AzArgs, [switch]$Quiet)
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
  $errTask = $null
  $p = $null
  try {
    $ErrorActionPreference = 'Continue'
    # Start-Process on Windows PowerShell 5.1 cannot set a child-only variable.
    $env:AZURE_CORE_LOGIN_EXPERIENCE_V2 = 'off'
    if (-not $Quiet) {
      # Throws when there is no console input (redirected, CI): Ctrl-C then
      # keeps its default and stops coop, and the finally block ends az.
      try {
        $previousCtrlC = [Console]::TreatControlCAsInput
        [Console]::TreatControlCAsInput = $true
      } catch { $previousCtrlC = $null }
    }
    if ($env:OS -eq 'Windows_NT') {
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
      }
      $p = Start-Process @start
      $null = $p.Handle   # Windows PowerShell 5.1: keeps ExitCode readable after exit
    } else {
      # Linux/macOS (pwsh 7): Start-Process writes -RedirectStandardInput into the
      # child's stdin only after it has started, so a child that exits first (the
      # fast fake az in CI) fails that write with "Broken pipe" and the process
      # object is lost (Rc 127, "not an auth error"). .NET starts az directly
      # instead: stdin is closed at once, stdout is drained and dropped, and
      # stderr is drained into Err for -Quiet (else it stays on the console).
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      $psi.FileName = $az
      foreach ($a in $AzArgs) { $psi.ArgumentList.Add($a) }
      $psi.UseShellExecute = $false
      $psi.RedirectStandardInput = $true
      $psi.RedirectStandardOutput = $true
      $psi.RedirectStandardError = [bool]$Quiet
      $p = [System.Diagnostics.Process]::Start($psi)
      $p.StandardInput.Close()
      $null = $p.StandardOutput.ReadToEndAsync()
      if ($Quiet) { $errTask = $p.StandardError.ReadToEndAsync() }
    }
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
    if ($errTask) {
      # EOF once az (or the tree Stop-CoopAzTree ended) has closed its stderr.
      try { if ($errTask.Wait(5000)) { $result.Err = $errTask.Result } } catch { }
    } elseif ($errFile) {
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

# The az stderr markers that mean "a sign-in is needed". The one other copy is
# the `authError` list in lib/fabric_request_headers.mjs (the Node token helper
# cannot load this file); tests/warehouse-mcp.test.py asserts the two are equal.
$script:CoopAzAuthMarkers = @('az login', 'not logged in', 'login required', 'authentication required',
                              'interaction_required', 'interactionrequired', 'invalid_grant',
                              'aadsts50058', 'aadsts50076', 'aadsts50078', 'aadsts50079', 'aadsts50158')

# True when az's stderr reports an authentication failure (a sign-in is needed).
function Test-CoopAzAuthError {
  param([string]$Text)
  if (-not $Text) { return $false }
  $lower = $Text.ToLowerInvariant()
  foreach ($marker in $script:CoopAzAuthMarkers) {
    if ($lower.Contains($marker)) { return $true }
  }
  return $false
}

# The one pair of "what to run" hints for a client tenant, printed by the launch
# preflight and by `coop doctor`'s Azure sign-in row.
function Get-CoopAzLoginHint([string]$Tenant) {
  "run: az login --tenant $Tenant --allow-no-subscriptions"
}
function Get-CoopAzTokenHint([string]$Tenant) {
  # The platform's first audience: Fabric REST, or SQL on an Azure SQL-only machine.
  $resource = @(Get-CoopAzTokenResources)[0]
  "run: az account get-access-token --tenant $Tenant --resource $resource"
}

# Check that az can mint the Fabric token, then the Power BI token, for -Tenant
#. 15 seconds each; stops at the first failure.
# Returns 0 when both mint, 1 when az reports an authentication failure, 2 for
# any other failure, 124 on timeout.
# The token audiences the client platform needs (mirror of coop_az_token_resources):
# Fabric REST then Power BI for a Fabric client, the SQL audience alone for an
# Azure SQL-only client. An unset platform means Fabric (today's behavior).
function Get-CoopAzTokenResources {
  if ((Get-CoopClientPlatform) -ceq 'azure_sql') { return @('https://database.windows.net/') }
  return @('https://api.fabric.microsoft.com', 'https://analysis.windows.net/powerbi/api')
}

function Get-CoopAzTokenRc {
  param([string]$Tenant)
  foreach ($resource in (Get-CoopAzTokenResources)) {
    $r = Invoke-CoopAz -Seconds 15 -Quiet -AzArgs @('account', 'get-access-token', '--tenant', $Tenant, '--resource', $resource, '--output', 'none')
    if ($r.Rc -eq 0) { continue }
    if ($r.Rc -eq 124) { return 124 }
    if (Test-CoopAzAuthError $r.Err) { return 1 }
    return 2
  }
  return 0
}

function Invoke-CoopAzPreflight {
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
  if ($rc -eq 1 -and ($interactive -or $env:COOP_ASSUME_YES -eq '1')) {
    $tried = $true
    Coop-Info "Opening Azure sign-in for tenant $tenant..."
    $login = Invoke-CoopAz -Seconds 300 -AzArgs @('login', '--tenant', $tenant, '--allow-no-subscriptions', '--output', 'none')
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
    Coop-Warn "Azure sign-in for tenant $tenant is not verified; continuing." (Get-CoopAzLoginHint $tenant)
  } elseif ($rc -eq 124) {
    Coop-Warn "Azure token check timed out for tenant $tenant (network or VPN?); continuing." (Get-CoopAzTokenHint $tenant)
  } elseif ($rc -eq 1) {
    Coop-Warn "Azure: not signed in to tenant $tenant; continuing." (Get-CoopAzLoginHint $tenant)
  } else {
    Coop-Warn "Azure token check failed for tenant $tenant (not an auth error); continuing." (Get-CoopAzTokenHint $tenant)
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
# origin remote).
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
function Get-CoopRepoBranch {
  $ErrorActionPreference = 'Continue'
  $ref = Get-CoopRepoGitLine @('symbolic-ref', '-q', 'HEAD')
  if ($ref -cmatch '^refs/heads/(.+)$') { return $Matches[1] }
  return ''
}

# True when HEAD follows release tags: a detached HEAD, or a branch whose upstream
# is origin/main (main, or a renamed branch that tracks it). Any other branch,
# including one with no upstream, is a hold.
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
# renamed origin would come first.
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
# a stranded machine is never silent.
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
function Write-CoopRepoStranded {
  $s = Get-CoopRepoStranded
  if ($null -eq $s) { return $false }
  Coop-Warn $s.Message $s.Hint
  return $true
}

# The repo line of `coop update --check` (#107), as @{ Line; Hint } (Hint '' when
# none): what step 1 would do to this checkout. Local only, no fetch, so --check
# still changes nothing.
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

# Refresh origin so the release helpers see every tag pushed since the last
# fetch: `git fetch origin` (branches and the tags on them), never a prompt.
# Shared by step 1 of `coop update` and `coop update --check`, which otherwise
# read the tags already on the machine and call a fresh release "no newer
# release" until something else fetches. Warn-and-continue: offline, the
# releases already fetched are used. $true when the fetch succeeded. Fetching
# changes no file in the checkout, so --check still changes nothing.
function Invoke-CoopRepoFetchOrigin {
  $ErrorActionPreference = 'Continue'
  if (-not (Test-Have 'git') -or -not (Test-CoopGitCheckout $script:CoopRoot)) { return $false }
  $root = $script:CoopRoot
  & git -C $root remote get-url origin *> $null
  if ($LASTEXITCODE -ne 0) { return $false }
  $oldPrompt = $env:GIT_TERMINAL_PROMPT
  $env:GIT_TERMINAL_PROMPT = '0'
  try {
    $fetchOut = @(& git -C $root fetch --quiet origin 2>&1)
    if ($LASTEXITCODE -eq 0) { return $true }
    $line = 'fetch failed'
    foreach ($o in $fetchOut) { $s = ([string]$o).Trim(); if ($s) { $line = $s; break } }
    Coop-Warn 'could not fetch from origin — using the releases already on this machine' "git: $line"
    return $false
  } finally {
    if ($null -eq $oldPrompt) { Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue }
    else { $env:GIT_TERMINAL_PROMPT = $oldPrompt }
  }
}

# Step 1 of `coop update`: move the coop-agent checkout. Default: fast-forward to
# Get-CoopRepoNextRelease, never backwards, never a tag checkout or reset. -Edge:
# head of main, via today's `git pull --ff-only` on a branch, or a guarded
# re-attach of a detached HEAD to main. Tracked-file changes skip the move; a hold
# is not fetched or moved. Warn-and-continue: never touches the update's failure
# count.
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
    $null = Invoke-CoopRepoFetchOrigin
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
function Get-CoopPiVersion {
  if (-not (Test-Have 'pi')) { return '' }
  $raw = (& pi --version 2>$null | Select-Object -First 1)
  $m = [regex]::Match([string]$raw, '\d+\.\d+\.\d+')
  if ($m.Success) { return $m.Value } else { return '' }
}

# --- Fleet convergence (install / update share these; master plan S2, #222) ----
# One probe and one install branch per component. Each Invoke-Coop*Converge
# returns the Coop-Unit result contract, @{ ok = <bool>; msg = <string> }, and
# takes every input as an argument, so the same function runs inside a Coop-Unit
# job (a fresh runspace that dot-sources this library; see $script:CoopConvergeUnit)
# and in-process from `coop doctor --fix`.
function Coop-UnitResult([bool]$Ok, [string]$Message) { return [pscustomobject]@{ ok = $Ok; msg = $Message } }

# The Coop-Unit body every convergence unit uses: dot-source lib/common.ps1 in the
# job's runspace, then call one convergence function with splatted parameters.
#   Coop-Unit <label> $script:CoopConvergeUnit @($script:CoopCommonPath, 'Invoke-CoopPiConverge', @{ Package = ...; Pin = ...; Edge = $false; Force = $false })
$script:CoopCommonPath = Join-Path $script:CoopRoot 'lib\common.ps1'
$script:CoopConvergeUnit = {
  param([string]$Common, [string]$Function, [hashtable]$Params)
  . $Common
  return (& $Function @Params)
}

# Windows in-place Pi updates (`npm install -g` over an installed agent) replace the
# global package via an atomic rename. If a coop/pi session has those files open,
# the rename fails and leaves a half-written tree plus a leftover
# `.pi-coding-agent-*` staging dir (see the pi-ai/pi-tui skew issue). So install
# and update both clean stale staging dirs and refuse the in-place Pi convergence
# while a session is open.
function Get-CoopNpmGlobalRoots {
  $roots = @()
  # The window package's bundled prefix holds its Pi (D1d): no npm call needed.
  $bundledRoot = Get-CoopBundledNpmRoot
  if ($bundledRoot) { $roots += $bundledRoot }
  try { $r = (& npm root -g 2>$null | Select-Object -First 1); if ($r) { $roots += $r.Trim() } } catch { }
  if ($env:APPDATA) { $roots += (Join-Path $env:APPDATA 'npm\node_modules') }
  return @($roots | Where-Object { $_ } | Select-Object -Unique)
}

function Remove-CoopPiStagingDirs {
  foreach ($root in (Get-CoopNpmGlobalRoots)) {
    $ew = Join-Path $root '@earendil-works'
    if (Test-Path -LiteralPath $ew) {
      Get-ChildItem -LiteralPath $ew -Directory -Filter '.pi-coding-agent-*' -Force -ErrorAction SilentlyContinue | ForEach-Object {
        $name = $_.Name
        Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $_.FullName)) { Coop-Info "removed leftover npm staging dir: $name" }
      }
    }
  }
}

# Path text for a substring match: lowercase, `\` separators, no trailing
# separator. Win32_Process.CommandLine carries paths as the launcher wrote them
# (npm's .cmd shims use backslashes; `npm root -g` may not).
function ConvertTo-CoopPathKey([string]$Path) {
  return ([string]$Path).Trim().Replace('/', '\').TrimEnd('\').ToLowerInvariant()
}

# True when one node.exe command line is a Pi session run from THIS install's npm
# tree (#234): it names pi-coding-agent under one of $Roots, the npm global roots
# this install converges (Get-CoopNpmGlobalRoots). A session launched from
# another install has another root (a daily C: install while a sandbox installs
# into a redirected E: profile) and is no reason to skip the convergence here.
# With no root known (npm did not answer) every pi-coding-agent session counts,
# as before.
function Test-CoopPiCommandLineOwned([string]$CommandLine, [string[]]$Roots) {
  if (-not $CommandLine -or $CommandLine -notmatch 'pi-coding-agent') { return $false }
  $known = @($Roots | Where-Object { $_ })
  if ($known.Count -eq 0) { return $true }
  $cmd = ConvertTo-CoopPathKey $CommandLine
  foreach ($r in $known) {
    $key = ConvertTo-CoopPathKey $r
    if ($key -and $cmd.Contains($key + '\')) { return $true }
  }
  return $false
}

# A coop/pi session of THIS install is open: a node.exe (not this process) whose
# command line Test-CoopPiCommandLineOwned accepts. $Rows / $Roots let a fixture
# pass fake process rows (ProcessId, CommandLine) and roots; by default the rows
# come from Win32_Process and the roots from Get-CoopNpmGlobalRoots.
function Test-CoopPiRunning([object[]]$Rows = $null, [string[]]$Roots = $null) {
  if ($null -eq $Roots) { $Roots = @(Get-CoopNpmGlobalRoots) }
  try {
    if ($null -eq $Rows) { $Rows = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue) }
    foreach ($p in $Rows) {
      if ($null -eq $p) { continue }
      if ($p.ProcessId -eq $PID) { continue }
      if (Test-CoopPiCommandLineOwned ([string]$p.CommandLine) $Roots) { return $true }
    }
  } catch { }
  return $false
}

# The busy guard install and update share: clear leftover staging dirs, then say
# whether Pi may be converged in place. $false (with the warning printed) when a
# coop/pi session of this install has the agent files open (sessions from another
# install's npm tree do not count, #234); the caller skips the Pi unit and counts
# a failure. $Command names the lifecycle command to re-run.
function Test-CoopPiConvergeAllowed([string]$Command = 'coop update') {
  if (-not (Test-Have 'pi')) { return $true }
  Remove-CoopPiStagingDirs
  if (-not (Test-CoopPiRunning)) { return $true }
  Coop-Warn 'a coop/pi session appears to be running — skipping the in-place Pi convergence (Windows locks open files, which can corrupt the agent install and leave a `.pi-coding-agent-*` staging dir).'
  Coop-Say  "      Close all coop/pi windows, then re-run: $Command"
  return $false
}

# Pi: probe `pi --version`; skip at the pin; else `npm install -g <spec>`.
# -Edge converges an existing install to the unpinned package (upstream latest);
# -Force reinstalls the spec even at the pin.
function Invoke-CoopPiConverge {
  param([string]$Package, [string]$Pin, [bool]$Edge = $false, [bool]$Force = $false)
  $spec = if (-not $Edge -and $Pin) { "${Package}@${Pin}" } else { $Package }
  $cur = Get-CoopPiVersion
  $hasNpm = Test-Have 'npm'
  if ($cur -and -not $Force) {
    if ($Edge) {
      # Edge means upstream/latest for EXISTING installs too.
      if (-not $hasNpm) { return (Coop-UnitResult $false 'cannot update pi (npm missing) — install Node.js, then re-run: coop install') }
      & npm install -g $Package *> $null
      if ($LASTEXITCODE -eq 0) { return (Coop-UnitResult $true "pi updated to latest ($(Get-CoopPiVersion))") }
      return (Coop-UnitResult $false "failed to update pi to latest (npm install -g $Package)")
    }
    if (-not $Pin) { return (Coop-UnitResult $true "pi present ($cur) — no manifest pin") }
    if ($cur -eq $Pin) { return (Coop-UnitResult $true "pi $cur matches manifest") }
    if (-not $hasNpm) { return (Coop-UnitResult $false 'cannot converge pi (npm missing) — install Node.js, then re-run: coop install') }
    & npm install -g $spec *> $null
    if ($LASTEXITCODE -eq 0) { return (Coop-UnitResult $true "pi converged $cur -> $Pin") }
    return (Coop-UnitResult $false "failed to converge pi to $spec — try: npm install -g $spec")
  }
  if (-not $hasNpm) { return (Coop-UnitResult $false 'cannot install pi (npm missing) — install Node.js, then re-run: coop install') }
  & npm install -g $spec *> $null
  if ($LASTEXITCODE -eq 0) { return (Coop-UnitResult $true "pi installed ($spec)") }
  return (Coop-UnitResult $false "npm install of pi failed — try: npm install -g $spec")
}

# --- pipx runner and probe (one copy; the install units used to carry three) --
# The pipx to run: COOP_PIPX_BIN when set (tests pin one), else `pipx` on PATH,
# else `python -m pipx` for a pipx that `pip install --user pipx` put in a Scripts
# dir not on PATH yet (the Windows Store alias is skipped). @() when none answers.
function Get-CoopPipxInvocation {
  if ($env:COOP_PIPX_BIN) {
    if (Get-Command $env:COOP_PIPX_BIN -ErrorAction SilentlyContinue) { return @([string]$env:COOP_PIPX_BIN) }
    return @()
  }
  if (Get-Command pipx -ErrorAction SilentlyContinue) { return @('pipx') }
  foreach ($name in @('python3', 'python')) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $c -or ($c.Source -and $c.Source -match '\\WindowsApps\\')) { continue }
    & $c.Source -m pipx --version *> $null
    if ($LASTEXITCODE -eq 0) { return @($c.Source, '-m', 'pipx') }
  }
  return @()
}
function Test-CoopPipxAvailable { return ((@(Get-CoopPipxInvocation)).Count -gt 0) }
# The install's pipx unit (Coop-Unit body, runs in a job): a pipx that answers
# (on PATH, COOP_PIPX_BIN, or `python -m pipx`, the same probe every other pipx
# step uses) is present; else `pip install --user pipx` with the generic Python
# and `pipx ensurepath` for the next shell. The verdict is whether pipx answers
# afterwards, not the exit codes alone: a pipx that `pip install --user` put in
# a Scripts dir off PATH is fine (Add-CoopUserPaths and `python -m pipx` reach
# it). Before this, the unit saw only `pipx` on PATH, so such a pipx was
# "missing" and re-installed on every install run.
function Invoke-CoopPipxBootstrap {
  $ErrorActionPreference = 'Continue'
  if (Test-CoopPipxAvailable) { return (Coop-UnitResult $true 'pipx present') }
  $py = Get-CoopPython
  if (-not $py) { return (Coop-UnitResult $false 'skipping pipx (python missing)') }
  & $py -m pip install --user pipx *> $null
  if ($LASTEXITCODE -ne 0) { return (Coop-UnitResult $false "could not install pipx automatically (`"$py`" -m pip install --user pipx failed) — see https://pipx.pypa.io") }
  & $py -m pipx ensurepath *> $null
  $pathNote = if ($LASTEXITCODE -eq 0) { 'open a new shell for PATH changes' } else { 'pipx ensurepath failed: add the pipx bin dir to PATH yourself' }
  if (Test-CoopPipxAvailable) { return (Coop-UnitResult $true "pipx installed ($pathNote)") }
  return (Coop-UnitResult $false "pipx was installed but does not answer (`"$py`" -m pipx --version) — see https://pipx.pypa.io")
}
# Run pipx quietly; the exit code (1 when no pipx answers).
function Invoke-CoopPipx([string[]]$PipxArgs) {
  $inv = @(Get-CoopPipxInvocation)
  if ($inv.Count -eq 0) { return 1 }
  $exe = $inv[0]
  $rest = @($inv | Select-Object -Skip 1) + @($PipxArgs)
  $wheelEnv = Use-CoopBundledWheels $PipxArgs
  try { & $exe @rest *> $null; $rc = $LASTEXITCODE }
  finally { Restore-CoopBundledWheels $wheelEnv }
  return $rc
}
# pipx's stdout as one string ('' when no pipx answers).
function Get-CoopPipxOutput([string[]]$PipxArgs) {
  $inv = @(Get-CoopPipxInvocation)
  if ($inv.Count -eq 0) { return '' }
  $exe = $inv[0]
  $rest = @($inv | Select-Object -Skip 1) + @($PipxArgs)
  return [string](& $exe @rest 2>$null | Out-String)
}
# Installed version of a pipx tool per `pipx list` ('' when absent). The
# convergence probe; doctor's inventory rows keep reading in-venv metadata.
# $ListText lets a caller probe several tools from one `pipx list`.
function Get-CoopPipxToolVersion([string]$Package, [string]$ListText = '') {
  if (-not $ListText) { $ListText = Get-CoopPipxOutput @('list') }
  if (-not $ListText) { return '' }
  $m = [regex]::Match([string]$ListText, ('(?i)package ' + [regex]::Escape($Package) + ' (\d+\.\d+\.\d+)'))
  if ($m.Success) { return $m.Groups[1].Value } else { return '' }
}

# pipx tool: probe `pipx list`; skip at the pin; drifted (or a matching package
# that must be rebuilt on pipx's standalone Python, $FetchPython set) ->
# `pipx install --force <spec>`; missing -> `pipx install <spec>`; -Force ->
# `pipx install --force <spec>`; -Edge on an existing tool -> `pipx upgrade`, or a
# forced unpinned reinstall when the tool runs on an explicit interpreter
# ($Python, the Fabric CLI), so an unsupported venv is repaired. Postcondition:
# outside --edge the installed version must equal the pin afterwards, so an old
# launcher left on PATH never reads as a converged tool.
function Invoke-CoopPipxConverge {
  param([string]$Package, [string]$Pin, [bool]$Edge = $false, [bool]$Force = $false, [string]$Python = '', [string]$FetchPython = '')
  if (-not (Test-CoopPipxAvailable)) { return (Coop-UnitResult $false "skipping $Package (pipx missing)") }
  $spec = if (-not $Edge -and $Pin) { "${Package}==${Pin}" } else { $Package }
  function New-PipxInstallArgs([bool]$WithForce) {
    $a = @('install')
    if ($WithForce) { $a += '--force' }
    if ($FetchPython) { $a += $FetchPython }
    if ($Python) { $a += @('--python', $Python) }
    $a += $spec
    return $a
  }
  $installed = Get-CoopPipxToolVersion $Package
  $outcome = ''
  if ($Force) {
    if ((Invoke-CoopPipx (New-PipxInstallArgs $true)) -ne 0) { return (Coop-UnitResult $false "failed to reinstall $Package ($spec)") }
    $outcome = "$Package reinstalled ($spec)"
  } elseif ($installed) {
    if ($Edge) {
      # Edge means upstream/latest for EXISTING installs too.
      if ($Python) {
        if ((Invoke-CoopPipx (New-PipxInstallArgs $true)) -ne 0) { return (Coop-UnitResult $false "failed to update $Package with Python $Python") }
      } elseif ((Invoke-CoopPipx @('upgrade', $Package)) -ne 0) { return (Coop-UnitResult $false "failed to upgrade $Package to latest") }
      $now = Get-CoopPipxToolVersion $Package
      return (Coop-UnitResult $true "$Package updated to latest ($(if ($now) { $now } else { '?' }))")
    }
    if (-not $Pin) { return (Coop-UnitResult $true "$Package present ($installed) — no manifest pin") }
    if ($installed -eq $Pin -and -not $FetchPython) { return (Coop-UnitResult $true "$Package $installed matches manifest") }
    if ((Invoke-CoopPipx (New-PipxInstallArgs $true)) -ne 0) {
      if ($installed -eq $Pin) { return (Coop-UnitResult $false "failed to rebuild $Package with standalone Python $Python") }
      return (Coop-UnitResult $false "failed to converge $Package to $Pin")
    }
    $outcome = if ($installed -eq $Pin) { "$Package $Pin rebuilt with Python $Python" } else { "$Package converged $installed -> $Pin" }
  } else {
    if ((Invoke-CoopPipx (New-PipxInstallArgs $false)) -ne 0) { return (Coop-UnitResult $false "could not install $Package ($spec)") }
    $outcome = "$Package installed ($spec)"
  }
  if (-not $Edge -and $Pin) {
    $now = Get-CoopPipxToolVersion $Package
    if ($now -ne $Pin) {
      $nowDisp = if ($now) { $now } else { 'none' }
      return (Coop-UnitResult $false "$Package remains at $nowDisp; expected $Pin")
    }
  }
  return (Coop-UnitResult $true $outcome)
}

# Microsoft Fabric CLI: the pipx convergence on the interpreter the plan chose
# (Get-CoopFabricPipxPlan: a local 3.10-3.13, or pipx's standalone 3.12 via
# $FetchPython), then the `fab` identity check: Python Fabric (SSH) on PATH is
# not the Microsoft Fabric CLI. Runtime-library convergence (fabric-cicd, pyodbc)
# is the caller's Sync-CoopFabricPythonPackages, after this unit.
function Invoke-CoopFabricCliConverge {
  param([string]$Package, [string]$Pin, [bool]$Edge = $false, [bool]$Force = $false, [string]$Python = '', [string]$FetchPython = '', [string]$Command = 'coop install')
  if (-not (Test-CoopPipxAvailable)) { return (Coop-UnitResult $false 'skipping Fabric CLI (pipx missing)') }
  if (-not $Python) { return (Coop-UnitResult $false "Microsoft Fabric CLI needs Python 3.10-3.13 — install Python 3.12 or upgrade pipx (1.12+ fetches one), then re-run: $Command") }
  $r = Invoke-CoopPipxConverge -Package $Package -Pin $Pin -Edge $Edge -Force $Force -Python $Python -FetchPython $FetchPython
  if (-not $r.ok) { return $r }
  if (Get-Command fab -ErrorAction SilentlyContinue) {
    $fv = ((& fab --version 2>&1) -join ' ')
    if ($fv -match '(?i)paramiko|invoke') {
      return (Coop-UnitResult $false "'fab' is Python Fabric (SSH), not Microsoft Fabric CLI — put the pipx Scripts dir first on PATH, then: fab --version")
    }
    $v = (& fab --version 2>$null | Select-Object -First 1)
    return (Coop-UnitResult $true "Microsoft Fabric CLI ready ($v)")
  }
  $localFab = Join-Path $HOME '.local\bin\fab.exe'
  if (Test-Path -LiteralPath $localFab) {
    $v = (& $localFab --version 2>$null | Select-Object -First 1)
    return (Coop-UnitResult $true "Microsoft Fabric CLI ready ($v)")
  }
  return (Coop-UnitResult $false "$Package installed but 'fab' not on PATH yet — open a new shell")
}

# Installed version of a global npm tool per `npm ls -g --depth=0` ('' when absent).
function Get-CoopNpmToolVersion([string]$Package) {
  if (-not (Test-Have 'npm')) { return '' }
  $text = [string](& npm ls -g --depth=0 $Package 2>$null | Out-String)
  if (-not $text) { return '' }
  $m = [regex]::Match($text, ([regex]::Escape($Package) + '@(\d+\.\d+\.\d+[^\s]*)'))
  if (-not $m.Success) { $m = [regex]::Match($text, ([regex]::Escape($Package) + '@(\S+)')) }
  if ($m.Success) { return $m.Groups[1].Value } else { return '' }
}

# npm tool (Power BI / Fabric authoring): probe `npm ls -g`; skip at the pin; else
# `npm install -g <spec>`. Normal mode installs the pin only: a tool without one
# is a failure, never npm's latest, and there is no `npm update -g` fallback
# (it ignores the version). -Edge takes the bare package for an existing install.
function Invoke-CoopNpmToolConverge {
  param([string]$Package, [string]$Pin, [bool]$Edge = $false, [bool]$Force = $false)
  if (-not (Test-Have 'npm')) { return (Coop-UnitResult $false "skipping $Package (npm missing)") }
  if (-not $Edge -and -not $Pin) { return (Coop-UnitResult $false "no manifest pin for $Package (normal mode installs pins only)") }
  $spec = if ($Edge) { $Package } else { "${Package}@${Pin}" }
  $cur = Get-CoopNpmToolVersion $Package
  if ($cur -and -not $Force) {
    if ($Edge) {
      & npm install -g $Package *> $null
      if ($LASTEXITCODE -eq 0) { $now = Get-CoopNpmToolVersion $Package; return (Coop-UnitResult $true "$Package updated to latest ($(if ($now) { $now } else { '?' }))") }
      return (Coop-UnitResult $false "failed to update $Package to latest (npm install -g $Package)")
    }
    if ($cur -eq $Pin) { return (Coop-UnitResult $true "$Package $cur matches manifest") }
    & npm install -g $spec *> $null
    if ($LASTEXITCODE -eq 0) { return (Coop-UnitResult $true "$Package converged $cur -> $Pin") }
    return (Coop-UnitResult $false "failed to converge $Package to $spec — try: npm install -g $spec")
  }
  & npm install -g $spec *> $null
  if ($LASTEXITCODE -eq 0) { return (Coop-UnitResult $true "$Package installed ($spec)") }
  return (Coop-UnitResult $false "could not install $Package — try: npm install -g $spec")
}

# All npm tools of the plan as one unit result (install and update show one
# "Power BI/Fabric authoring tools" item). $Names and $Pins are parallel.
function Invoke-CoopNpmToolsConverge {
  param([string[]]$Names, [string[]]$Pins, [bool]$Edge = $false, [bool]$Force = $false)
  if (-not (Test-Have 'npm')) { return (Coop-UnitResult $false 'skipping Power BI/Fabric authoring tools (npm missing)') }
  $ok = 0; $failed = 0; $problems = @()
  for ($i = 0; $i -lt @($Names).Count; $i++) {
    $pin = if ($i -lt @($Pins).Count) { [string]$Pins[$i] } else { '' }
    $r = Invoke-CoopNpmToolConverge -Package $Names[$i] -Pin $pin -Edge $Edge -Force $Force
    if ($r.ok) { $ok++ } else { $failed++; $problems += $r.msg }
  }
  if ($failed -eq 0) { return (Coop-UnitResult $true "$ok Power BI/Fabric authoring tool(s) ready") }
  return (Coop-UnitResult $false "$ok ready, $failed failed: $($problems -join '; ')")
}

# True if version $A's MAJOR.MINOR is strictly newer than $B's (patch ignored).
function Test-CoopMinorNewer {
  param([string]$A, [string]$B)
  $ma = [regex]::Match([string]$A, '^(\d+)\.(\d+)'); $mb = [regex]::Match([string]$B, '^(\d+)\.(\d+)')
  if (-not $ma.Success -or -not $mb.Success) { return $false }
  return ([version]("{0}.{1}" -f $ma.Groups[1].Value, $ma.Groups[2].Value) -gt [version]("{0}.{1}" -f $mb.Groups[1].Value, $mb.Groups[2].Value))
}

# Read a dotted scalar key from a YAML file via lib/_yaml.py (PyYAML when present,
# else a dependency-free fallback parser).
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
# Absent/disabled/unreadable is a clean no-op everywhere. The file is
# Get-CoopConfigFile (<profile dir>\config; COOP_DIR is the parent of .coop).

# The machine's client platform from the fleet config (client.platform, written
# by scripts/onboard.py): 'fabric', 'azure_sql' or 'both'. Empty when the config
# or the key is absent or malformed; every caller treats empty as Fabric, which
# is what a machine that predates the setting ran as.
function Get-CoopClientPlatform {
  $f = Get-CoopConfigFile
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return '' }
  try {
    $cfg = Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json
    $v = [string]$cfg.client.platform
    if ($v -cin @('fabric', 'azure_sql', 'both')) { return $v }
  } catch { return '' }
  return ''
}

# True when this machine is an Azure SQL-only client, so Fabric-only rows and
# defaults step aside (master plan section 8 item 7).
function Test-CoopAzureSqlOnly { return ((Get-CoopClientPlatform) -ceq 'azure_sql') }

function Get-CoopKnowledgeBlock {
  $f = Get-CoopConfigFile
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $null }
  try {
    $cfg = Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.knowledge) { return $cfg.knowledge }
  } catch { return $null }
  return $null
}

# K3: the TeamAI trial's team skills root for the subordinate team-skills launch
# slot. Only when knowledge.teamai.enabled AND knowledge.teamai.skills are truthy
# and lib/teamai.py recorded the isolated clone (state.json clone_path at init).
# Returns the <clone>\skills path or '' (never throws: a malformed state file is
# "no team skills", not a launcher abort).
function Get-CoopTeamaiSkillsRoot {
  $k = Get-CoopKnowledgeBlock
  if (-not $k -or -not $k.teamai) { return '' }
  $t = $k.teamai
  $on = [string]$t.enabled; $sk = [string]$t.skills
  if (@('1','true','yes','on') -notcontains $on.Trim().ToLowerInvariant()) { return '' }
  if (@('1','true','yes','on') -notcontains $sk.Trim().ToLowerInvariant()) { return '' }
  $stateFile = Join-Path (Join-Path (Get-CoopProfileDir) 'teamai') 'state.json'
  if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf)) { return '' }
  try {
    $st = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $clone = [string]$st.clone_path
  } catch { return '' }
  if (-not $clone) { return '' }
  $skills = Join-Path $clone 'skills'
  if (Test-Path -LiteralPath $skills -PathType Container) { return $skills }
  return ''
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
# $PWD, else the bundled one at COOP_ROOT/.coop/project.yml.
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
  # C1: the contract this launch resolved, else the client home repository
  # beside this one (its contract lists this repository).
  if ($env:COOP_PROJECT_YML -and (Test-Path -LiteralPath $env:COOP_PROJECT_YML -PathType Leaf)) { return $env:COOP_PROJECT_YML }
  $sibling = Find-CoopSiblingContract $StartDir
  if ($sibling) { return $sibling }
  $child = Find-CoopChildContract $StartDir
  if ($child) { return $child }
  $bundled = Join-Path $script:CoopRoot '.coop\project.yml'
  if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
  return ''
}

# Prompt and skill tiers (master plan PR1). Three places hold prompts and
# skills, with one precedence rule, shipped > client > personal:
#   shipped  — this repository's prompts\ and skills\ (as always)
#   client   — .coop\prompts and .coop\skills beside the committed contract (C1),
#              so a client's own travel with its repository
#   personal — <profile>\prompts and <profile>\skills (~/.coop by default)
# Returns the tiers in precedence order. The client tier is listed only when a
# real contract is found (the bundled .coop/project.yml is coop's own, not a
# client's). A tier's folders may be missing; callers test them.
function Get-CoopResourceTiers {
  param([string]$StartDir = (Get-Location).Path)
  $tiers = @()
  $tiers += [pscustomobject]@{ Tier = 'shipped'; Root = $script:CoopRoot; Skills = (Join-Path $script:CoopRoot 'skills'); Prompts = (Join-Path $script:CoopRoot 'prompts') }
  $proj = Find-CoopProjectYml -StartDir $StartDir
  $bundled = [System.IO.Path]::GetFullPath((Join-Path $script:CoopRoot '.coop\project.yml'))
  if ($proj -and ([System.IO.Path]::GetFullPath($proj) -ne $bundled)) {
    $coopDir = Split-Path -Parent $proj
    $tiers += [pscustomobject]@{ Tier = 'client'; Root = (Split-Path -Parent $coopDir); Skills = (Join-Path $coopDir 'skills'); Prompts = (Join-Path $coopDir 'prompts') }
  }
  $profileDir = Get-CoopProfileDir
  $tiers += [pscustomobject]@{ Tier = 'personal'; Root = $profileDir; Skills = (Join-Path $profileDir 'skills'); Prompts = (Join-Path $profileDir 'prompts') }
  return @($tiers)
}

# The skills one tier folder holds: every <dir>\SKILL.md, as @{ Folder; Dir; Name }
# where Name is the frontmatter name, or the folder name when the file has none
# (Pi falls back the same way). Subordinate slot folders are never a tier skill.
function Get-CoopTierSkills {
  param([string]$SkillsDir)
  $out = @()
  if (-not (Test-Path -LiteralPath $SkillsDir -PathType Container)) { return @() }
  foreach ($d in (Get-ChildItem -LiteralPath $SkillsDir -Directory | Where-Object { $_.Name -notin @('_microsoft', '_microsoft_fabric') })) {
    $sk = Join-Path $d.FullName 'SKILL.md'
    if (-not (Test-Path -LiteralPath $sk -PathType Leaf)) { continue }
    $fm = Get-CoopSkillName $sk
    $out += [pscustomobject]@{ Folder = $d.Name; Dir = $d.FullName; Name = $(if ($fm) { $fm } else { $d.Name }) }
  }
  return @($out)
}

# The prompt templates one tier folder holds: every top-level *.md, as
# @{ Name; File } where Name is the /command (the file name without .md).
function Get-CoopTierPrompts {
  param([string]$PromptsDir)
  $out = @()
  if (-not (Test-Path -LiteralPath $PromptsDir -PathType Container)) { return @() }
  foreach ($f in (Get-ChildItem -LiteralPath $PromptsDir -File -Filter '*.md')) {
    $out += [pscustomobject]@{ Name = ($f.Name -replace '\.md$', ''); File = $f.FullName }
  }
  return @($out)
}

# The nearest folder at or above $StartDir with a .git entry, or ''.
function Find-CoopGitRoot {
  param([string]$StartDir = (Get-Location).Path)
  $dir = [System.IO.Path]::GetFullPath($StartDir).TrimEnd('\', '/')
  while ($dir) {
    if (Test-Path -LiteralPath (Join-Path $dir '.git')) { return $dir }
    $parent = Split-Path -Parent $dir
    if ($parent -eq $dir -or -not $parent) { break }
    $dir = $parent
  }
  return ''
}

# The `repositories.*.local_path` values of a block-YAML contract (a line scan:
# no Python needed at launch), quotes stripped.
function Get-CoopContractLocalPaths {
  param([string]$File)
  $paths = @()
  $inRepos = $false
  foreach ($line in (Get-Content -LiteralPath $File -ErrorAction SilentlyContinue)) {
    if ($line -match '^\S') { $inRepos = ($line -match '^repositories:\s*(#.*)?$'); continue }
    if (-not $inRepos) { continue }
    if ($line -match '^\s+local_path:\s*(.+?)\s*$') {
      $value = $Matches[1].Trim()
      if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) { $value = $value.Substring(1, $value.Length - 2) }
      if ($value -and $value -notmatch '^TODO') { $paths += $value }
    }
  }
  return $paths
}

# C1: the client home repository beside the repository holding $StartDir, when
# its .coop/project.yml lists that repository (one level up only; the folder
# between the repositories is never a home). Returns the contract path or ''.
function Find-CoopSiblingContract {
  param([string]$StartDir = (Get-Location).Path)
  $gitRoot = Find-CoopGitRoot $StartDir
  if (-not $gitRoot) { return '' }
  $parent = Split-Path -Parent $gitRoot
  if (-not $parent -or $parent -eq $gitRoot) { return '' }
  $target = [System.IO.Path]::GetFullPath($gitRoot).TrimEnd('\', '/')
  foreach ($child in (Get-ChildItem -LiteralPath $parent -Directory -ErrorAction SilentlyContinue | Where-Object { -not $_.Name.StartsWith('.') } | Sort-Object Name)) {
    if ($child.FullName -eq $gitRoot) { continue }
    $contract = Join-Path $child.FullName '.coop\project.yml'
    if (-not (Test-Path -LiteralPath $contract -PathType Leaf)) { continue }
    foreach ($rel in (Get-CoopContractLocalPaths $contract)) {
      $expanded = $rel
      if ($expanded -match '^~([\\/]|$)') { $expanded = (Join-Path $HOME $expanded.Substring(1).TrimStart('\', '/')) }
      $resolved = [System.IO.Path]::GetFullPath((Join-Path $child.FullName $expanded)).TrimEnd('\', '/')
      if ($resolved -eq $target) { return $contract }
    }
  }
  return ''
}

# The nearest .coop/project.yml at or above $StartDir, or ''.
function Find-CoopContractAbove {
  param([string]$StartDir = (Get-Location).Path)
  $dir = $StartDir
  while ($dir) {
    $candidate = Join-Path $dir '.coop\project.yml'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    $parent = Split-Path -Parent $dir
    if ($parent -eq $dir -or -not $parent) { break }
    $dir = $parent
  }
  return ''
}

# C1: coop opened in the folder that holds the client's repositories ($StartDir
# in no repository): the one repository directly inside it with a committed
# .coop/project.yml. '' when none or several do (with several, the user opens
# the repository they mean). Mirrors findChildContract in lib/project-contract.mjs.
function Get-CoopChildContracts {
  param([string]$StartDir = (Get-Location).Path)
  $found = @()
  foreach ($child in (Get-ChildItem -LiteralPath $StartDir -Directory -ErrorAction SilentlyContinue | Where-Object { -not $_.Name.StartsWith('.') } | Sort-Object Name)) {
    if (-not (Test-Path -LiteralPath (Join-Path $child.FullName '.git'))) { continue }
    $contract = Join-Path $child.FullName '.coop\project.yml'
    if (Test-Path -LiteralPath $contract -PathType Leaf) { $found += $contract }
  }
  return $found
}
function Find-CoopChildContract {
  param([string]$StartDir = (Get-Location).Path)
  if (Find-CoopGitRoot $StartDir) { return '' }
  $found = @(Get-CoopChildContracts $StartDir)
  if ($found.Count -eq 1) { return $found[0] }
  return ''
}

# Hand the resolved contract to Pi and the window (COOP_PROJECT_YML) when it
# lives in the client home repository beside the launch folder, or in the one
# repository inside it (opened in the folder that holds the repositories), so every finder
# (coop-tools, the guardrails, the Python helpers) reads the same file.
function Set-CoopProjectYmlEnv {
  param([string]$StartDir = (Get-Location).Path)
  Remove-Item Env:COOP_PROJECT_YML -ErrorAction SilentlyContinue
  if (Find-CoopContractAbove $StartDir) { return '' }
  $sibling = Find-CoopSiblingContract $StartDir
  if (-not $sibling) { $sibling = Find-CoopChildContract $StartDir }
  if ($sibling) { $env:COOP_PROJECT_YML = $sibling }
  return $sibling
}

# Confirm a potentially-destructive action unless --yes / COOP_ASSUME_YES is set.
# C1: where a project contract belongs for a folder (the shared project file
# design: one committed contract per client, in a repository the team clones).
# Mirrors proposeContractRoot in lib/project-contract.mjs. Returns a hashtable
# with Kind ('existing' | 'home-repo' | 'git-root' | 'folder'), Root, Path, Repos
# and, for home-repo, Parent (the folder holding the repositories; Root is the
# home repository <Parent>\<client>-coop once -Client is known, else a placeholder).
function Get-CoopContractRootProposal {
  param([string]$StartDir = (Get-Location).Path, [string]$Client = '')
  $start = [System.IO.Path]::GetFullPath($StartDir).TrimEnd('\', '/')
  if (-not $start) { $start = $StartDir }
  $dir = $start
  $gitRoot = ''
  while ($dir) {
    $candidate = Join-Path $dir '.coop\project.yml'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return @{ Kind = 'existing'; Root = $dir; Path = $candidate; Repos = @(); Sibling = $false }
    }
    if (-not $gitRoot -and (Test-Path -LiteralPath (Join-Path $dir '.git'))) { $gitRoot = $dir }
    $parent = Split-Path -Parent $dir
    if ($parent -eq $dir -or -not $parent) { break }
    $dir = $parent
  }
  $sibling = Find-CoopSiblingContract $start
  if ($sibling) {
    return @{ Kind = 'existing'; Root = (Split-Path -Parent (Split-Path -Parent $sibling)); Path = $sibling; Repos = @(); Sibling = $true }
  }
  $child = Find-CoopChildContract $start
  if ($child) {
    return @{ Kind = 'existing'; Root = (Split-Path -Parent (Split-Path -Parent $child)); Path = $child; Repos = @(); Sibling = $false; Child = $true }
  }
  if ($gitRoot) {
    $parent = Split-Path -Parent $gitRoot
    if ($parent -and $parent -ne $gitRoot) {
      $repos = @(Get-ChildItem -LiteralPath $parent -Directory -ErrorAction SilentlyContinue |
        Where-Object { -not $_.Name.StartsWith('.') -and (Test-Path -LiteralPath (Join-Path $_.FullName '.git')) } |
        Sort-Object Name | ForEach-Object { $_.Name })
      if ($repos.Count -ge 2 -and $repos -contains (Split-Path -Leaf $gitRoot)) {
        $slug = Get-CoopClientSlug $Client
        $homeRepo = if ($Client) { Join-Path $parent ($slug + '-coop') } else { Join-Path $parent '<client>-coop' }
        $others = @($repos | Where-Object { $_ -ne (Split-Path -Leaf $homeRepo) })
        return @{ Kind = 'home-repo'; Root = $homeRepo; Path = (Join-Path $homeRepo '.coop\project.yml'); Repos = $others; Parent = $parent; Pending = (-not $Client) }
      }
    }
    return @{ Kind = 'git-root'; Root = $gitRoot; Path = (Join-Path $gitRoot '.coop\project.yml'); Repos = @() }
  }
  return @{ Kind = 'folder'; Root = $start; Path = (Join-Path $start '.coop\project.yml'); Repos = @() }
}

# A short, safe slug of the client name for folder names (mirrors clientSlug).
function Get-CoopClientSlug {
  param([string]$Client)
  $slug = ([string]$Client).ToLowerInvariant() -replace '[^a-z0-9]+', '-'
  $slug = $slug.Trim('-')
  if (-not $slug) { $slug = 'client' }
  return $slug
}

# Create the client home repository (folder, `git init`, README from
# templates\client-home) when it does not exist yet. Returns $true on success.
function New-CoopHomeRepository {
  param([string]$Root, [string]$Client)
  if (-not (Test-Path -LiteralPath $Root)) { New-Item -ItemType Directory -Force -Path $Root | Out-Null }
  if (-not (Test-Path -LiteralPath (Join-Path $Root '.git'))) {
    if (-not (Test-Have 'git')) { Coop-Warn 'git is not installed: the home repository folder was created without `git init`'; }
    else {
      & git -C $Root init --quiet 2>$null
      if ($LASTEXITCODE -ne 0) { Coop-Warn "git init failed in $Root"; return $false }
    }
  }
  $readme = Join-Path $Root 'README.md'
  if (-not (Test-Path -LiteralPath $readme)) {
    $template = Join-Path $script:CoopRoot 'templates\client-home\README.md'
    $text = if (Test-Path -LiteralPath $template -PathType Leaf) { [System.IO.File]::ReadAllText($template) } else { "# $(Split-Path -Leaf $Root)`n`nThe coop client home repository for $Client.`n" }
    $text = $text.Replace('<client>', $Client).Replace('<slug>', (Get-CoopClientSlug $Client))
    [System.IO.File]::WriteAllText($readme, $text, (New-Object System.Text.UTF8Encoding($false)))
  }
  return $true
}

function Coop-Confirm {
  param([string]$Prompt = 'Proceed?')
  if ($env:COOP_ASSUME_YES -eq '1') { return $true }
  if ([Console]::IsInputRedirected) { Coop-Warn 'Non-interactive shell; refusing without --yes.'; return $false }
  [Console]::Error.Write("$($script:C_OLIVE)$Prompt$($script:C_RST) [y/N] ")
  $ans = [Console]::In.ReadLine()
  if ($ans -match '^(y|yes)$') { return $true } else { return $false }
}

# Test whether a COOP user profile exists: the per-user file (in the profile dir
# onboarding writes to, so COOP_DIR is honoured) or the machine-level file
# (master plan P1), which stands in for it on a one-user-per-client VM.
function Test-CoopUserProfileMissing {
  if (Test-Path -LiteralPath (Get-CoopUserProfileFile) -PathType Leaf) { return $false }
  return -not (Test-Path -LiteralPath (Get-CoopMachineProfileFile) -PathType Leaf)
}

function Test-CoopOnboardingMissing {
  return (Test-CoopUserProfileMissing) -or -not (Test-Path -LiteralPath (Get-CoopConfigFile) -PathType Leaf)
}

# The stamp coop writes the first time an interactive launch hands the Start Here
# menu to coop-tools (master plan FR1): `<profile dir>/first-run`.
function Get-CoopFirstRunStampFile { return (Join-Path (Get-CoopProfileDir) 'first-run') }

# First launch (master plan FR1): a plain `coop` never runs the onboarding wizard
# and nothing here can stop the launch. An incomplete profile gets one line that
# names where the questions now live (the Start Here menu's project item, or
# `coop onboard`). The first interactive launch per profile dir also sets
# COOP_FIRST_RUN=1 so coop-tools opens the Start Here menu once Pi is up; the
# stamp keeps later launches at the plain prompt (`/start` any time).
# $Interactive defaults to the real terminal state; fixtures pass it explicitly.
# -Window is `coop desktop`: a person is about to see the window whatever this
# console's stdin is (the installed package starts coop with no console input),
# so the first launch counts as interactive, and the onboarding line goes out as
# a warning because the window's set-up card is built from the launch warnings.
function Set-CoopFirstRunLaunch {
  param([bool] $Interactive = (-not [Console]::IsInputRedirected), [switch] $Window)
  $script:CoopOnboardRc = 0
  if ($Window) { $Interactive = $true }
  if (Test-CoopOnboardingMissing) {
    if ($Interactive -and -not $Window) {
      Coop-Info 'First run: no COOP profile yet. Pick "Start a client project" in the menu to set your name, or run: coop onboard'
    } else {
      Coop-Warn 'COOP onboarding is incomplete (user.json or config missing). Run: coop onboard'
    }
  }
  if (-not $Interactive) { return }
  $stamp = Get-CoopFirstRunStampFile
  if (Test-Path -LiteralPath $stamp -PathType Leaf) { return }
  try {
    $dir = Split-Path -Parent $stamp
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($stamp, ((Get-Date).ToUniversalTime().ToString('o') + "`n"))
  } catch {
    # A read-only profile dir must not block the launch; the menu simply opens again next time.
  }
  $env:COOP_FIRST_RUN = '1'
}

# Interactive onboarding wizard (name, communication preference, client platform,
# tenant, integrations). Run by `coop install` and `coop onboard`; the launch
# never calls it (Set-CoopFirstRunLaunch).
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
  else {
    Initialize-CoopJobPersistencePath
    Start-Job -ScriptBlock $Sb -ArgumentList $JobArgs
  }
}

# Windows PowerShell 5.1's process-backed jobs keep their startup data under
# %LOCALAPPDATA%\Microsoft\Windows\PowerShell. On a profile that has never
# run a job (a fresh user, or an install whose profile variables point at a new
# folder) that directory does not exist yet, the first job fails with "The
# Persistence Path does not exist" and returns nothing — which is how the first
# install unit (pipx) came back with no result on every fresh profile while pipx
# itself was fine. Create it before the first job. No-op when LOCALAPPDATA is
# unset (pwsh on macOS/Linux) or the directory exists.
function Initialize-CoopJobPersistencePath {
  if (-not $env:LOCALAPPDATA) { return }
  $dir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\PowerShell'
  if (Test-Path -LiteralPath $dir -PathType Container) { return }
  New-Item -ItemType Directory -Force -Path $dir -ErrorAction SilentlyContinue | Out-Null
}

# Coop-Unit <label> <scriptblock> [args]
#   Runs the scriptblock in a background job (it returns @{ok=<bool>; msg=<string>}).
#   While it runs, the active-item line animates under the overall bar; on completion
#   the bar advances by one and a permanent ✓/! line is printed. NB: the scriptblock
#   runs in a FRESH runspace — it sees none of these functions/variables, so units
#   must be self-contained and take their inputs as arguments.
# Why a finished job produced no result object: the job's failure reason, else
# its first error record, else its state. '' when nothing is known.
function Get-CoopJobFailure($Job) {
  $reason = ''
  try {
    $jobs = @($Job.ChildJobs); if ($jobs.Count -eq 0) { $jobs = @($Job) }
    foreach ($j in $jobs) {
      $r = $j.JobStateInfo.Reason
      if ($r -and $r.Message) { $reason = [string]$r.Message; break }
      foreach ($e in @($j.Error)) { if ($e) { $reason = [string]$e; break } }
      if ($reason) { break }
    }
    if (-not $reason -and $Job.State -and $Job.State -ne 'Completed') { $reason = "job $($Job.State)" }
  } catch { }
  return ($reason -replace '\s+', ' ').Trim()
}

# -Verify: an optional parent-side check run after the job with the job's
# verdict ($ok, $msg); it returns a Coop-UnitResult to replace that verdict, or
# $null to keep it. For a unit whose outcome the parent can observe (pipx
# answers, a file exists), the observation wins over a job that died or
# returned nothing — on Windows PowerShell 5.1 the pipx bootstrap job came back
# empty on machines where pipx then worked (v0.23.5 to v0.29.0).
function Coop-Unit {
  param([string]$Label, [scriptblock]$Work, [object[]]$WorkArgs = @(), [scriptblock]$Verify = $null)
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
  $why = if ($null -eq $res) { Get-CoopJobFailure $job } else { '' }
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  if ($null -eq $res) {
    # The job came back with nothing: it never started (a job child that could
    # not load) or died before returning its result. Units are self-contained
    # and idempotent, so run the same unit once more in this process and report
    # THAT result — a working tool must not be reported as a failed step because
    # the job runner broke. Continue, not Stop: a unit's native commands redirect
    # stderr, which under Stop is a terminating error on Windows PowerShell 5.1.
    $ErrorActionPreference = 'Continue'
    try { $res = & $Work @WorkArgs | Select-Object -Last 1 } catch { $res = $null; if (-not $why) { $why = ([string]$_.Exception.Message -replace '\s+', ' ').Trim() } }
  }
  $ok = $false; $msg = $Label
  if ($null -ne $res) {
    if ($res.PSObject.Properties.Name -contains 'ok')  { $ok  = [bool]$res.ok }
    if ($res.PSObject.Properties.Name -contains 'msg') { $msg = [string]$res.msg }
  } else {
    # A bare label told nobody anything; name what the job reported.
    $msg = if ($why) { "$Label (the step returned no result: $why)" } else { "$Label (the step returned no result)" }
  }
  if ($null -ne $Verify) {
    $v = $null
    try { $v = & $Verify $ok $msg } catch { }
    if ($null -ne $v -and ($v.PSObject.Properties.Name -contains 'ok')) {
      $ok = [bool]$v.ok
      if (($v.PSObject.Properties.Name -contains 'msg') -and $v.msg) { $msg = [string]$v.msg }
    }
  }
  $script:ProgDone++
  $script:ProgSpinline = ''
  # Callers that need a truthful aggregate result read this after each unit.
  # Do not emit a Boolean: that would pollute command output and job results.
  $script:CoopUnitLastOk = $ok
  if ($ok) { Coop-Ok $msg } else { Coop-Warn $msg }
}

# Run a sibling coop script (sync/doctor) in a CHILD process so its `exit` cannot
# abort the caller. Returns the child's exit code.
# The child is pwsh when PATH has it, else the host running this script (its
# own executable, which exists whatever PATH says: the coop window package
# starts coop.ps1 with a PATH of its own). A child that could not start is a
# failure (1), never a stale $LASTEXITCODE.
function Invoke-CoopScript {
  param([string]$ScriptPath, [string[]]$ScriptArgs = @())
  $psExe = $null
  if (Get-Command pwsh -ErrorAction SilentlyContinue) { $psExe = 'pwsh' }
  if (-not $psExe) { try { $psExe = (Get-Process -Id $PID -ErrorAction Stop).Path } catch { $psExe = $null } }
  if (-not $psExe) { $psExe = 'powershell' }
  $global:LASTEXITCODE = $null
  try {
    & $psExe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @ScriptArgs
  } catch {
    Coop-Warn "could not run $(Split-Path -Leaf $ScriptPath): $($_.Exception.Message)"
    return 1
  }
  if ($null -eq $LASTEXITCODE) { return 1 }
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

# The double-click launchers (master plan D1m: the icon is the front door).
# "coop" opens the window once the window runtime is installed (or the installed
# package wrote its own "coop" shortcut, which is left alone) and the terminal
# until then; "coop (terminal)" always opens the terminal, for daily terminal
# work. Both run bin\coop-desktop.ps1 in a console so the launch checks show and
# stay readable on an error. Same folders either way (Get-CoopShortcutDirs); an
# isolated install keeps them inside its profile. Best-effort: returns $true when
# a shortcut was written. -OnlyIfPresent (update) refreshes only what exists.
function Set-CoopDesktopShortcuts {
  param([switch]$OnlyIfPresent)
  if ($env:OS -ne 'Windows_NT') { return $false }
  $desktopLauncher = Join-Path $script:CoopRoot 'bin\coop-desktop.ps1'
  if (-not (Test-Path -LiteralPath $desktopLauncher)) { return $false }
  $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $icon  = Join-Path $script:CoopRoot 'themes\coop.ico'
  $window = Test-CoopWindowAvailable
  $ws = New-Object -ComObject WScript.Shell
  $wrote = $false
  foreach ($dir in (Get-CoopShortcutDirs)) {
    if (-not $dir) { continue }
    $main = Join-Path $dir 'coop.lnk'
    $terminal = Join-Path $dir 'coop (terminal).lnk'
    $legacyWindow = Join-Path $dir 'coop (window).lnk'
    $present = (Test-Path -LiteralPath $main) -or (Test-Path -LiteralPath $terminal) -or (Test-Path -LiteralPath $legacyWindow)
    if ($OnlyIfPresent -and -not $present) { continue }
    # A fresh sandbox profile has no Desktop / Start Menu folder yet.
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    # "coop": the window when there is one, else the terminal. The installed
    # window package (D1c) writes a "coop" shortcut that starts its own exe;
    # that one belongs to its installer and stays.
    # Under -OnlyIfPresent a removed "coop" stays removed (the older "coop
    # (window)" folds into it, so that one still counts as present).
    $keepMain = (-not $OnlyIfPresent) -or (Test-Path -LiteralPath $main) -or (Test-Path -LiteralPath $legacyWindow)
    $sc = $ws.CreateShortcut($main)
    $packaged = (Test-Path -LiteralPath $main) -and $sc.TargetPath -and ($sc.TargetPath -notlike '*powershell.exe')
    if ($keepMain -and -not $packaged) {
      $sc.TargetPath       = $psExe
      $sc.Arguments        = if ($window) { "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$desktopLauncher`" desktop" } else { "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$desktopLauncher`"" }
      $sc.WorkingDirectory = $HOME
      $sc.Description      = if ($window) { 'coop - the Cooptimize analytics agent, in a window' } else { 'coop - the Cooptimize analytics agent' }
      $sc.WindowStyle      = 1
      # ',0' = explicit icon index; some shells show a generic icon without it.
      if (Test-Path -LiteralPath $icon) { $sc.IconLocation = "$icon,0" }
      $sc.Save()
      $wrote = $true
    }
    # "coop (terminal)": always the terminal.
    $tc = $ws.CreateShortcut($terminal)
    $tc.TargetPath       = $psExe
    $tc.Arguments        = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$desktopLauncher`""
    $tc.WorkingDirectory = $HOME
    $tc.Description      = 'coop - the Cooptimize analytics agent, in a terminal'
    $tc.WindowStyle      = 1
    if (Test-Path -LiteralPath $icon) { $tc.IconLocation = "$icon,0" }
    $tc.Save()
    $wrote = $true
    # The older "coop (window)" shortcut this script wrote is folded into "coop";
    # the package's own (an exe target) stays.
    if (Test-Path -LiteralPath $legacyWindow) {
      $lc = $ws.CreateShortcut($legacyWindow)
      if (-not $lc.TargetPath -or ($lc.TargetPath -like '*powershell.exe')) { Remove-Item -LiteralPath $legacyWindow -Force -ErrorAction SilentlyContinue }
    }
  }
  return $wrote
}

# The window runtime is on this profile (Electron's binary in ~/.coop/desktop), or
# this coop is the installed window package's own snapshot (D1d): "coop" opens the window.
function Test-CoopWindowAvailable {
  if ($script:CoopBundledRuntime) { return $true }
  try { return [bool](Get-CoopDesktopElectronExe) } catch { return $false }
}

# After the first `coop desktop` installed the window runtime (master plan D1b,
# D1m): "coop" now opens the window and "coop (terminal)" the terminal, in the
# folders that already have a "coop" shortcut (the install wrote it) or, with
# none, both folders. Best-effort: returns $true when a shortcut was written.
function Set-CoopWindowShortcut {
  param([switch]$OnlyIfPresent)
  if ($env:OS -ne 'Windows_NT') { return $false }
  return (Set-CoopDesktopShortcuts -OnlyIfPresent:$OnlyIfPresent)
}

# --- coop desktop: the window's runtime (master plan D1b) ---------------------
# The window's code is desktop\ in this repo, loaded in place like the
# extensions. It runs on Electron, pinned in the release manifest
# (desktop.electron), with pdf.js beside it (desktop.pdfjs, the pdfjs-dist
# package that reads attached PDFs in a child process); both install from the
# shipped lockfile (config\desktop-lock.json; regenerate with
# `node desktop/scripts/runtime-lock.mjs generate` after a pin bump) into its own
# tree, <profile dir>\desktop\runtime. That tree is not Pi's extension tree and
# not a global npm install: `coop desktop` installs it on first use, `coop sync`
# refreshes it only where it already exists, and uninstall removes it. The
# window's own data (settings, Chromium cache) lives beside it in
# <profile dir>\desktop\data, so a redirected sandbox profile keeps both.
function Get-CoopDesktopDir { return (Join-Path (Get-CoopProfileDir) 'desktop') }
function Get-CoopDesktopRuntimeDir { return (Join-Path (Get-CoopDesktopDir) 'runtime') }
function Get-CoopDesktopDataDir { return (Join-Path (Get-CoopDesktopDir) 'data') }
function Get-CoopDesktopElectronPin { return (Coop-ManifestGet -Key 'desktop.electron') }
function Get-CoopDesktopPdfjsPin { return (Coop-ManifestGet -Key 'desktop.pdfjs') }

# The pdf.js version installed in the runtime tree; '' when absent.
function Get-CoopDesktopPdfjsVersion {
  $f = Join-Path (Get-CoopDesktopRuntimeDir) 'node_modules\pdfjs-dist\package.json'
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return '' }
  try { return ([string]((Get-Content -LiteralPath $f -Raw | ConvertFrom-Json).version)).Trim() } catch { return '' }
}

# The Electron version installed in the runtime tree; '' when absent.
function Get-CoopDesktopElectronVersion {
  $f = Join-Path (Get-CoopDesktopRuntimeDir) 'node_modules\electron\package.json'
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return '' }
  try { return ([string]((Get-Content -LiteralPath $f -Raw | ConvertFrom-Json).version)).Trim() } catch { return '' }
}

# The Electron executable the package's path.txt names under dist\; '' until the
# binary is there.
function Get-CoopDesktopElectronExe {
  $pkg = Join-Path (Get-CoopDesktopRuntimeDir) 'node_modules\electron'
  $pathTxt = Join-Path $pkg 'path.txt'
  if (-not (Test-Path -LiteralPath $pathTxt -PathType Leaf)) { return '' }
  $rel = ''
  try { $rel = ([System.IO.File]::ReadAllText($pathTxt)).Trim() } catch { return '' }
  if (-not $rel -or $rel.Contains('..')) { return '' }
  $exe = Join-Path (Join-Path $pkg 'dist') $rel
  if (Test-Path -LiteralPath $exe -PathType Leaf) { return $exe }
  return ''
}

# 'missing' (never installed), 'current' (both pins, from the shipped lock, with
# Electron's binary) or 'stale' (installed, but not this release's runtime, or
# half installed).
function Get-CoopDesktopRuntimeState {
  $dir = Get-CoopDesktopRuntimeDir
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return 'missing' }
  $pin = Get-CoopDesktopElectronPin
  if (-not $pin -or (Get-CoopDesktopElectronVersion) -ne $pin) { return 'stale' }
  if (-not (Get-CoopDesktopElectronExe)) { return 'stale' }
  $pdfPin = Get-CoopDesktopPdfjsPin
  if (-not $pdfPin -or (Get-CoopDesktopPdfjsVersion) -ne $pdfPin) { return 'stale' }
  $lock = Join-Path $script:CoopRoot 'config\desktop-lock.json'
  if ((Get-CoopFileSha256 $lock) -ne (Get-CoopFileSha256 (Join-Path $dir 'package-lock.json'))) { return 'stale' }
  return 'current'
}

# Install (or refresh) the runtime tree from the shipped lock: `npm ci` with no
# lifecycle scripts and no optional packages (pdf.js's canvas serves rendering
# only), then Electron's own install.js, which downloads the binary for this
# machine and checks it against the checksums.json inside the locked package
# (Electron 44 has no install script of its own). Returns $true when the tree
# is current afterwards. A running window holds electron.exe open, so a refresh
# then fails and says to close it.
function Install-CoopDesktopRuntime {
  $pin = Get-CoopDesktopElectronPin
  $pdfPin = Get-CoopDesktopPdfjsPin
  $lock = Join-Path $script:CoopRoot 'config\desktop-lock.json'
  if (-not $pin -or -not $pdfPin -or -not (Test-Path -LiteralPath $lock -PathType Leaf)) {
    Coop-Warn 'this coop release does not pin the window runtime' 'run: coop update'
    return $false
  }
  if (-not (Test-Have 'node')) { Coop-Warn 'the coop window needs Node.js' 'run: coop install'; return $false }
  $npm = Get-CoopWorkingNpm
  if (-not $npm) { Coop-Warn 'the coop window needs a working npm' 'run: coop install'; return $false }
  $dir = Get-CoopDesktopRuntimeDir
  try {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $pkgJson = "{`n  `"name`": `"coop-desktop-runtime`",`n  `"private`": true,`n  `"dependencies`": {`n    `"electron`": `"$pin`",`n    `"pdfjs-dist`": `"$pdfPin`"`n  }`n}`n"
    [System.IO.File]::WriteAllText((Join-Path $dir 'package.json'), $pkgJson)
    Copy-Item -LiteralPath $lock -Destination (Join-Path $dir 'package-lock.json') -Force
  } catch {
    Coop-Warn "could not prepare $dir`: $($_.Exception.Message)"
    return $false
  }
  Coop-Info "installing the coop window runtime (Electron $pin and pdf.js $pdfPin, about 150 MB to download and 400 MB on disk) into $dir"
  $previousEap = $ErrorActionPreference
  $out = @()
  $rc = 1
  Push-Location -LiteralPath $dir
  try {
    # Native stderr (npm notices, the download progress) is a NativeCommandError
    # under Windows PowerShell 5.1 when redirected; the exit code is the signal.
    $ErrorActionPreference = 'Continue'
    $out = @(& $npm ci --ignore-scripts --omit=optional --no-audit --no-fund 2>&1)
    $rc = $LASTEXITCODE
    if ($rc -eq 0) {
      $out = @(& node (Join-Path $dir 'node_modules\electron\install.js') 2>&1)
      $rc = $LASTEXITCODE
    }
  } catch { $rc = 1 } finally { $ErrorActionPreference = $previousEap; Pop-Location }
  if ($rc -ne 0 -or (Get-CoopDesktopRuntimeState) -ne 'current') {
    $detail = ((@($out | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ }) | Select-Object -Last 6) -join ' | ')
    Coop-Warn ("could not install the coop window runtime{0}" -f $(if ($detail) { ": $detail" } else { '' })) 'close every coop window, then run: coop sync'
    return $false
  }
  Coop-Ok "coop window runtime ready: Electron $pin, pdf.js $pdfPin"
  return $true
}

# Pi's JavaScript entry (the package's bin.pi under the npm global root), which
# the window runs as `node <entry> --mode rpc`. The same package `pi` on PATH
# runs; '' when it is not found.
function Get-CoopPiEntry {
  foreach ($root in (Get-CoopNpmGlobalRoots)) {
    $pkgDir = Join-Path $root '@earendil-works\pi-coding-agent'
    $pkgJson = Join-Path $pkgDir 'package.json'
    if (-not (Test-Path -LiteralPath $pkgJson -PathType Leaf)) { continue }
    $bin = ''
    try {
      $pkg = Get-Content -LiteralPath $pkgJson -Raw | ConvertFrom-Json
      if ($pkg.bin -is [string]) { $bin = [string]$pkg.bin }
      elseif ($pkg.bin -and $pkg.bin.PSObject.Properties['pi']) { $bin = [string]$pkg.bin.pi }
    } catch { continue }
    if (-not $bin) { continue }
    $entry = [System.IO.Path]::GetFullPath((Join-Path $pkgDir $bin))
    if (Test-Path -LiteralPath $entry -PathType Leaf) { return $entry }
  }
  return ''
}

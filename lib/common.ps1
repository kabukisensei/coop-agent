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

function Coop-ManifestKeys([string]$Key) {
  try {
    $m = Get-Content -LiteralPath $script:CoopReleaseManifest -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $parts = $Key -split '\.'
    $v = $m
    foreach ($p in $parts) { if ($v -is [System.Collections.IDictionary]) { $v = $v[$p] } elseif ($v -and $v.PSObject.Properties[$p]) { $v = $v.$p } else { return @() } }
    if ($v -is [System.Collections.IDictionary]) { return $v.Keys }
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
  if (Test-Have 'pipx') {
    $v = (& pipx environment --value PIPX_LOCAL_VENVS 2>$null | Out-String).Trim()
    if ($v) { return (Join-Path $v 'venvs') }
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

function Get-CoopVenvPythonPath([string]$Venv) {
  $base = Join-Path (Get-CoopPipxVenvsDir) $Venv
  foreach ($py in @((Join-Path $base 'Scripts\python.exe'), (Join-Path $base 'bin\python'), (Join-Path $base 'bin/python'))) {
    if (Test-Path -LiteralPath $py) { return $py }
  }
  return $null
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
  $out = (& $py -c $probe $Distribution 2>$null | Out-String).Trim()
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
  $cmd = Get-Command $Command -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  $vdir = (Get-CoopPipxVenvsDir)
  try { $resolved = (Resolve-Path -LiteralPath $cmd.Source -ErrorAction Stop).Path } catch { $resolved = $cmd.Source }
  if ($resolved -like "$vdir*") {
    $rest = $resolved.Substring($vdir.Length).TrimStart('\\', '/')
    return ($rest -split '[\\/]')[0]
  }
  # Console scripts are plain files whose first line names their venv python.
  try {
    $first = (Get-Content -LiteralPath $resolved -TotalCount 1 -ErrorAction Stop)
    if ($first -and $first.Contains($vdir)) {
      $rest = $first.Substring($first.IndexOf($vdir) + $vdir.Length).TrimStart('\\', '/')
      return ($rest -split '[\\/]')[0]
    }
  } catch {}
  return $null
}

# Select an npm that actually WORKS: some workstation shims exit 0 while doing
# nothing (observed with a broken ~/.hermes/node/bin/npm), which silently
# no-ops convergence. Requires real version output.
function Get-CoopWorkingNpm {
  $cand = (Get-Command npm -ErrorAction SilentlyContinue).Source
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
  if (-not $need) { return $true }
  $npm = Get-CoopWorkingNpm
  if (-not $npm) { return $false }
  node (Join-Path $script:CoopRoot 'lib\pins.js') $AgentDir @Specs
  if ($LASTEXITCODE -ne 0) { return $false }
  Push-Location $npmDir
  & $npm install --silent --no-audit --no-fund *> $null
  $rc = $LASTEXITCODE
  Pop-Location
  return ($rc -eq 0)
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
    $env:PATH = "$d$script:PathSep$env:PATH"
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
  if ($script:ProgActive -and (Test-ProgTty)) {
    Coop-ProgLift
    [Console]::Error.WriteLine($Line)
    Coop-ProgDraw
  } else {
    [Console]::Error.WriteLine($Line)
  }
}
function Coop-Say  { param([string]$m) Coop-Emit $m }
function Coop-Info { param([string]$m) Coop-Emit "$($script:C_LIME)$($script:G_BULLET)$($script:C_RST) $m" }
function Coop-Ok   { param([string]$m) Coop-Emit "$($script:C_FOREST)$($script:G_CHECK)$($script:C_RST) $m" }
function Coop-Warn { param([string]$m) Coop-Emit "$($script:C_OLIVE)!$($script:C_RST) $m" }
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
    $v = (& $name --version 2>&1 | ForEach-Object { $_.ToString() }) -join ' '
    if ($v -match '\d+\.\d+') { return $name }
  }
  return $null
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

  if (-not (Test-Have 'npm')) {
    Coop-Warn "extension pi-ai/pi-tui need realignment to pi $ver but npm is missing — install Node.js, then: coop sync"
    return
  }
  # Skewed: drop the lockfile (the thing pinning the stale hoist) so npm re-resolves
  # against the overrides, then reinstall.
  Coop-Info "aligning extension pi-ai / pi-tui to the agent ($ver; tree has $treeAi)…"
  Remove-Item -LiteralPath (Join-Path $npmDir 'package-lock.json') -Force -ErrorAction SilentlyContinue
  Push-Location $npmDir; try { & npm install *> $null } catch { } finally { Pop-Location }
  $r = Invoke-Align -Check
  if ($r.rc -eq 10) {
    # A stale node_modules can keep the old hoist — rebuild it clean as a last resort,
    # but PRESERVE the existing tree: move it aside, reinstall, and restore it if the
    # reinstall fails (offline / registry down). Deleting first would leave coop with
    # NO extensions — strictly worse than a skewed-but-working tree.
    $nm = Join-Path $npmDir 'node_modules'
    $bak = Join-Path $npmDir 'node_modules.coopbak'
    if (Test-Path -LiteralPath $nm) {
      Remove-Item -LiteralPath $bak -Recurse -Force -ErrorAction SilentlyContinue
      Move-Item -LiteralPath $nm -Destination $bak -Force -ErrorAction SilentlyContinue
    }
    $reinstallOk = $false
    Push-Location $npmDir; try { & npm install *> $null; $reinstallOk = ($LASTEXITCODE -eq 0) } catch { } finally { Pop-Location }
    if ($reinstallOk) {
      Remove-Item -LiteralPath $bak -Recurse -Force -ErrorAction SilentlyContinue
    } elseif (Test-Path -LiteralPath $bak) {
      Remove-Item -LiteralPath $nm -Recurse -Force -ErrorAction SilentlyContinue
      Move-Item -LiteralPath $bak -Destination $nm -Force -ErrorAction SilentlyContinue
      Coop-Warn 'extension realignment reinstall failed — restored the previous tree — check your network, then: coop doctor --fix'
    }
    $r = Invoke-Align -Check
  }
  if ($r.rc -eq 0) { Coop-Ok "extension pi-ai / pi-tui aligned to $ver" }
  elseif ($r.rc -eq 11) { Coop-Warn (Format-TooOld $r.parts) }
  else { Coop-Warn "could not fully align extension pi-ai/pi-tui to $ver — close any running coop session, then: coop doctor --fix" }
}

# --- Optional Azure preflight (non-fatal) --------------------------------------
# Mirrors the team's pi-ready habit: if the project pins a Fabric tenant and the
# Azure CLI is present, make sure a Power BI token exists before launching.
# Skipped entirely when COOP_SKIP_AZ=1 or no tenant is configured.
#
# Cached: a successful probe stamps the tenant id into <agent-dir>/.az-ok. Power BI
# tokens live ~60 minutes and `az` cold-starts in ~1-3s, so within 30 minutes of a
# success for the SAME tenant the probe is skipped entirely. A failed probe (or a
# stale/missing/mismatched marker) behaves exactly as before; marker I/O is
# best-effort and never fails the launch. (mirror of coop_az_preflight)
function Invoke-CoopAzPreflight {
  if ($env:COOP_SKIP_AZ -eq '1') { return }
  if (-not (Test-Have 'az')) { return }
  $proj = Find-CoopProjectYml
  if (-not $proj) { return }
  $tenant = Get-CoopYamlValue $proj 'fabric.tenant_id' ''
  if (-not $tenant -or $tenant -like 'TODO*' -or $tenant -like 'TODO:*') { return }
  $agentDir = Get-CoopEffectiveAgentDir
  $marker = Join-Path $agentDir '.az-ok'
  # -Force: pwsh on macOS/Linux treats the dot-prefixed marker as hidden.
  $mi = Get-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  if ($mi -and (((Get-Date) - $mi.LastWriteTime).TotalMinutes -lt 30)) {
    $cached = ''
    try { $cached = ([System.IO.File]::ReadAllText($marker)).Trim() } catch { }
    if ($cached -eq $tenant) { return }
  }
  & az account get-access-token --resource https://analysis.windows.net/powerbi/api > $null 2>&1
  if ($LASTEXITCODE -eq 0) {
    try {
      New-Item -ItemType Directory -Force -Path $agentDir -ErrorAction SilentlyContinue | Out-Null
      [System.IO.File]::WriteAllText($marker, $tenant)
    } catch { }
    return
  }
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  Coop-Warn 'Azure / Power BI token missing or expired.'
  if (Coop-Confirm "Run 'az login' for tenant $tenant now?") {
    & az login --tenant $tenant --allow-no-subscriptions
    if ($LASTEXITCODE -ne 0) { Coop-Warn 'az login failed; continuing anyway.' }
    else { try { [System.IO.File]::WriteAllText($marker, $tenant) } catch { } }
  }
}

# --- Repo staleness (fleet drift) ---------------------------------------------
# coop-agent updates arrive via `git pull` inside `coop update`; a zip/shared-drive
# copy (no .git) silently never updates, and even a git checkout has no signal
# between updates. These helpers power the doctor / launch staleness nudge.

# Quietly refresh origin — at most once per day (marker in the effective agent
# dir) and bounded by a 5s wait, so an offline or VPN-black-holed fetch can never
# stall doctor or a launch. Stamps BEFORE fetching, so an offline machine pays
# the wait at most once a day. Returns $true when THIS call attempted the (daily)
# fetch; $false when throttled or not applicable (non-git copy / no git / no
# origin remote). (mirror of coop_repo_fetch_throttled)
function Invoke-CoopRepoFetchThrottled {
  if (-not (Test-Have 'git')) { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $script:CoopRoot '.git'))) { return $false }
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

# How many commits HEAD is behind origin/main — purely local and instant (counts
# against the last-fetched origin/main; no network). 0 when this is not a git
# checkout, git is missing, or the count is unknowable.
# (mirror of coop_repo_behind_count)
function Get-CoopRepoBehindCount {
  if (-not (Test-Have 'git')) { return 0 }
  if (-not (Test-Path -LiteralPath (Join-Path $script:CoopRoot '.git'))) { return 0 }
  $out = (& git -C $script:CoopRoot rev-list --count 'HEAD..origin/main' 2>$null | Out-String).Trim()
  if ($out -match '^\d+$') { return [int]$out }
  return 0
}

# Launch-time staleness nudge: at most once per day (it fires only when this call
# performed the daily fetch), warn when the checkout is behind origin/main.
# Never blocks or fails the launch; silent offline / non-git / up-to-date.
# (mirror of coop_update_nudge)
function Invoke-CoopUpdateNudge {
  if (-not (Invoke-CoopRepoFetchThrottled)) { return }
  $behind = Get-CoopRepoBehindCount
  if ($behind -gt 0) { Coop-Warn "coop-agent is $behind commit(s) behind — run: coop update" }
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

# Extract the YAML frontmatter `name:` from a SKILL.md (first match), or '' if none.
# (mirror of coop_skill_name)
function Get-CoopSkillName {
  param([string]$File)
  if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return '' }
  $lines = Get-Content -LiteralPath $File -ErrorAction SilentlyContinue
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

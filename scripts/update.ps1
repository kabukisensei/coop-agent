#!/usr/bin/env pwsh
#
# coop update (Windows / PowerShell mirror of scripts/update.sh) —
# keep the whole Cooptimize stack current:
#   1. Pull the latest coop-agent (skills / prompts / vibes / theme)
#   2. Update Pi itself and every installed Pi extension
#   3. Upgrade the Coop tools and the Microsoft Fabric CLI (pipx)
#   4. Re-sync vibes and the powerline extension
#   5. Run doctor
#
$ErrorActionPreference = 'Continue'

# --- Resolve COOP_ROOT and shared helpers (mirror of lib/common.sh) ----------
$script:CoopRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:COOP_ROOT = $script:CoopRoot

$script:CoopVersion = '0.0.0'
$verFile = Join-Path $script:CoopRoot 'VERSION'
if (Test-Path -LiteralPath $verFile -PathType Leaf) {
  $vRaw = (Get-Content -LiteralPath $verFile -Raw -ErrorAction SilentlyContinue)
  if ($vRaw) { $script:CoopVersion = $vRaw.Trim() }
}

$script:CoopColor = ($null -eq $env:NO_COLOR -or $env:NO_COLOR -eq '') -and -not [Console]::IsErrorRedirected
$e = [char]27
if ($script:CoopColor) {
  $script:C_NAVY = "$e[38;2;0;65;107m"; $script:C_FOREST = "$e[38;2;66;120;60m"
  $script:C_OLIVE = "$e[38;2;130;170;67m"; $script:C_LIME = "$e[38;2;178;210;53m"
  $script:C_RED = "$e[38;2;239;65;45m"; $script:C_BOLD = "$e[1m"; $script:C_DIM = "$e[2m"; $script:C_RST = "$e[0m"
} else {
  $script:C_NAVY = ''; $script:C_FOREST = ''; $script:C_OLIVE = ''; $script:C_LIME = ''
  $script:C_RED = ''; $script:C_BOLD = ''; $script:C_DIM = ''; $script:C_RST = ''
}
$script:G_BULLET = [char]0x2022   # bullet
$script:G_CHECK  = [char]0x2713   # check
$script:G_CROSS  = [char]0x2717   # cross
function Coop-Say  { param([string]$m) [Console]::Error.WriteLine($m) }
function Coop-Info { param([string]$m) [Console]::Error.WriteLine("$($script:C_LIME)$($script:G_BULLET)$($script:C_RST) $m") }
function Coop-Ok   { param([string]$m) [Console]::Error.WriteLine("$($script:C_FOREST)$($script:G_CHECK)$($script:C_RST) $m") }
function Coop-Warn { param([string]$m) [Console]::Error.WriteLine("$($script:C_OLIVE)!$($script:C_RST) $m") }
function Coop-Err  { param([string]$m) [Console]::Error.WriteLine("$($script:C_RED)$($script:G_CROSS)$($script:C_RST) $m") }
function Coop-Head { param([string]$m) [Console]::Error.WriteLine("`n$($script:C_BOLD)$($script:C_NAVY)$m$($script:C_RST)") }
function Test-Have { param([string]$Name) [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

# Run a sibling coop script (sync/doctor) in a CHILD process so its `exit` cannot
# abort this update — mirrors bash invoking the script as a subprocess.
function Invoke-CoopScript {
  param([string]$ScriptPath, [string[]]$ScriptArgs = @())
  $psExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
  & $psExe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @ScriptArgs
  return $LASTEXITCODE
}

$PY_TOOLS = @('coop-data-doc', 'coop-sql-review', 'coop-dax-review', 'fabric-cicd', 'ms-fabric-cli')

Coop-Head "coop update (v$($script:CoopVersion))"

# --- 1. Update coop-agent itself ---------------------------------------------
Coop-Head '1/5  coop-agent repository'
if ((Test-Path -LiteralPath (Join-Path $script:CoopRoot '.git')) -and (Test-Have 'git')) {
  & git -C $script:CoopRoot remote get-url origin > $null 2>&1
  if ($LASTEXITCODE -eq 0) {
    $status = (& git -C $script:CoopRoot status --porcelain 2>$null | Out-String)
    if ($status.Trim()) {
      Coop-Warn "local changes present in coop-agent — skipping 'git pull' (commit/stash first)."
    } else {
      Coop-Info 'git pull --ff-only'
      & git -C $script:CoopRoot pull --ff-only > $null 2>&1
      if ($LASTEXITCODE -eq 0) { Coop-Ok 'coop-agent updated' } else { Coop-Warn 'git pull failed (continuing)' }
    }
  } else {
    Coop-Info "no 'origin' remote configured — skipping repo update"
  }
} else {
  Coop-Info 'not a git checkout — skipping repo update'
}

# --- 2. Update Pi + extensions ----------------------------------------------
Coop-Head '2/5  Pi and extensions'
if (Test-Have 'pi') {
  Coop-Info 'pi update pi   (the agent itself)'
  & pi update pi > $null 2>&1
  if ($LASTEXITCODE -eq 0) {
    $pv = (& pi --version 2>$null); if (-not $pv) { $pv = '?' }
    Coop-Ok "pi updated ($pv)"
  } else { Coop-Warn 'pi self-update failed' }
  Coop-Info 'pi update      (installed extensions)'
  & pi update > $null 2>&1
  if ($LASTEXITCODE -eq 0) { Coop-Ok 'extensions updated' } else { Coop-Warn 'extension update failed' }
} else {
  Coop-Warn 'pi not installed — run: coop install'
}

# --- 3. Upgrade pipx tools ---------------------------------------------------
Coop-Head '3/5  Coop tools + Fabric CLI (pipx)'
if (Test-Have 'pipx') {
  $pipxList = (& pipx list 2>$null | Out-String)
  foreach ($pkg in $PY_TOOLS) {
    if ($pipxList -match ("package " + [regex]::Escape($pkg) + " ")) {
      & pipx upgrade $pkg > $null 2>&1
      if ($LASTEXITCODE -eq 0) { Coop-Ok "$pkg" } else { Coop-Warn "upgrade failed: $pkg" }
    } else {
      Coop-Warn "$pkg not installed — run: coop install"
    }
  }
} else {
  Coop-Warn 'pipx not installed — run: coop install'
}

# --- 4. Sync vibes / skills / prompts / extension ----------------------------
Coop-Head '4/5  Sync brand assets'
$syncRc = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\sync.ps1')
if ($syncRc -ne 0) { Coop-Warn 'sync reported issues' }

# --- 5. Doctor ---------------------------------------------------------------
Coop-Head '5/5  Doctor'
$null = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\doctor.ps1')

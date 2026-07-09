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

# --- Shared helpers: dot-source lib/common.ps1 (the twin of lib/common.sh) ----
# Resolves COOP_ROOT/COOP_VERSION and defines the loggers, the progress engine
# (Coop-Prog*/Coop-Emit), Test-Have, Get-CoopPython, Get-CoopYamlValue,
# Test-CoopMinorNewer, Coop-Unit, Invoke-CoopScript, etc.
. (Join-Path $PSScriptRoot '../lib/common.ps1')

# Windows in-place `pi update --all` replaces the global agent via an atomic rename.
# If a coop/pi session has those files open, the rename fails and leaves a half-written
# tree plus a leftover `.pi-coding-agent-*` staging dir (see the pi-ai/pi-tui skew
# issue). So: clean stale staging dirs and refuse the in-place update while a session
# is open. (POSIX can replace open files, so update.sh has no such guard.)
function Get-CoopNpmGlobalRoots {
  $roots = @()
  try { $r = (& npm root -g 2>$null | Select-Object -First 1); if ($r) { $roots += $r.Trim() } } catch { }
  if ($env:APPDATA) { $roots += (Join-Path $env:APPDATA 'npm\node_modules') }
  return ($roots | Where-Object { $_ } | Select-Object -Unique)
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

function Test-CoopPiRunning {
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
      if ($p.ProcessId -eq $PID) { continue }
      if ($p.CommandLine -and $p.CommandLine -match 'pi-coding-agent') { return $true }
    }
  } catch { }
  return $false
}

# --- Parse flags (mirror of update.sh) ---------------------------------------
$NO_FABRIC = $false
$CHECK = $false       # --check: dry-run — report current/latest/tested, change nothing
$PI_LATEST = $false   # --pi-latest: skip the tested-version gate and take latest Pi
foreach ($a in $args) {
  switch -CaseSensitive ($a) {
    '--no-fabric' { $NO_FABRIC = $true }
    '--yes'       { $env:COOP_ASSUME_YES = '1' }
    '-y'          { $env:COOP_ASSUME_YES = '1' }
    '--check'     { $CHECK = $true }
    '--pi-latest' { $PI_LATEST = $true }
    default       { if (-not [string]::IsNullOrWhiteSpace($a)) { Coop-Warn "update: ignoring unknown flag '$a'" } }
  }
}

# The Coop tools to upgrade. Fabric CLI is included unless --no-fabric (matching
# `coop install --no-fabric`), so a fabric-less machine doesn't report a perpetual
# failed item on every update.
$PY_TOOLS = @('coop-data-doc', 'coop-sql-review', 'coop-dax-review')
if (-not $NO_FABRIC) { $PY_TOOLS += 'ms-fabric-cli' }

# Update coop's ISOLATED Pi agent dir (not the user's personal pi).
$env:PI_CODING_AGENT_DIR = Get-CoopPiAgentDir

# --- Tested-version guard (mirror of update.sh) ------------------------------
# coop's one real incident (#1) was a Pi version-compat break. Guard the Pi jump at the
# tested ceiling (config/defaults.yml tested_with.pi). $script:PI_INSTALL_TARGET, when set,
# tells the pi-update unit to PIN Pi to that version (extensions still update) instead of
# `pi update --all`.
$script:PI_PKG = '@earendil-works/pi-coding-agent'
$script:PI_INSTALL_TARGET = ''

# Latest published Pi version. COOP_PI_LATEST_OVERRIDE short-circuits the registry query.
function Get-PiLatest {
  if ($env:COOP_PI_LATEST_OVERRIDE) { return $env:COOP_PI_LATEST_OVERRIDE }
  if (-not (Test-Have 'npm')) { return '' }
  $raw = (& npm view $script:PI_PKG version 2>$null | Select-Object -First 1)
  $m = [regex]::Match([string]$raw, '\d+\.\d+\.\d+')
  if ($m.Success) { return $m.Value } else { return '' }
}
# Confirm the untested-Pi jump (respects --yes / COOP_ASSUME_YES; non-interactive = no).
function Confirm-CoopPiJump {
  param([string]$Prompt)
  if ($env:COOP_ASSUME_YES -eq '1') { return $true }
  if ([Console]::IsInputRedirected) { Coop-Warn 'Non-interactive shell; staying on the tested Pi (pass --yes or --pi-latest to jump).'; return $false }
  $ans = Read-Host ("{0} [y/N]" -f $Prompt)
  return ($ans -match '^(y|yes)$')
}

$PI_TESTED = Get-CoopYamlValue (Join-Path $script:CoopRoot 'config/defaults.yml') 'tested_with.pi' ''

# --- Per-item units (run in a background job; return @{ok=<bool>; msg=<string>}) --
# Same contract as the install units, so the update bar animates identically.
# Runs in a background job (a fresh runspace), so the tested-version DECISION is passed
# in as args — script variables are not inherited. $Target set => pin to that version.
$UnitPiUpdate = {
  param([string]$Target, [string]$Pkg)
  if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
    return [pscustomobject]@{ ok = $false; msg = 'pi not installed — run: coop install' }
  }
  if ($Target) {
    # The tested-version gate was declined: PIN Pi to the tested version (don't jump to an
    # untested minor), then still refresh extensions so those stay current.
    if (Get-Command npm -ErrorAction SilentlyContinue) {
      & npm install -g "$Pkg@$Target" *> $null
      if ($LASTEXITCODE -eq 0) {
        & pi update --extensions *> $null
        return [pscustomobject]@{ ok = $true; msg = "pinned pi to tested $Target + extensions updated" }
      }
    }
    return [pscustomobject]@{ ok = $false; msg = "failed to pin pi to $Target (try: npm install -g $Pkg@$Target)" }
  }
  # `pi update --all` updates the agent AND every installed extension. (Bare
  # `pi update` updates pi ONLY; `--extensions` updates packages only.)
  & pi update --all *> $null
  if ($LASTEXITCODE -eq 0) {
    $v = (& pi --version 2>$null); if (-not $v) { $v = '?' }
    return [pscustomobject]@{ ok = $true; msg = "pi + extensions updated ($v)" }
  }
  return [pscustomobject]@{ ok = $false; msg = 'pi update --all failed (try: pi update --all)' }
}

$UnitPytoolUpgrade = {
  param([string]$Pkg)
  if (-not (Get-Command pipx -ErrorAction SilentlyContinue)) {
    return [pscustomobject]@{ ok = $false; msg = "skipping $Pkg (pipx missing) — run: coop install" }
  }
  $list = (& pipx list 2>$null | Out-String)
  if ($list -notmatch ("package " + [regex]::Escape($Pkg) + " ")) {
    return [pscustomobject]@{ ok = $false; msg = "$Pkg not installed — run: coop install" }
  }
  & pipx upgrade $Pkg *> $null
  if ($LASTEXITCODE -eq 0) { return [pscustomobject]@{ ok = $true; msg = $Pkg } }
  return [pscustomobject]@{ ok = $false; msg = "upgrade failed: $Pkg" }
}

# --- coop update --check (dry-run: report versions, change NOTHING) ----------
if ($CHECK) {
  Coop-Head 'coop update --check (dry-run — nothing is installed)'
  $piCur = if (Test-Have 'pi') { $m = [regex]::Match((& pi --version 2>$null | Out-String), '\d+\.\d+\.\d+'); if ($m.Success) { $m.Value } else { '?' } } else { 'not installed' }
  $piLat = Get-PiLatest; if (-not $piLat) { $piLat = '?' }
  # The version-table rows go to STDOUT (Write-Output), matching update.sh's bare
  # printf — so `coop update --check > versions.txt` captures the table on Windows too.
  Write-Output ('  {0,-24} current {1,-13} latest {2,-13} tested {3}' -f "pi ($script:PI_PKG)", $piCur, $piLat, $(if ($PI_TESTED) { $PI_TESTED } else { '?' }))
  if ($PI_TESTED -and (Test-CoopMinorNewer $piLat $PI_TESTED)) {
    Coop-Warn "latest Pi ($piLat) is a newer MINOR than tested ($PI_TESTED) — 'coop update' will ask before jumping (skip with --pi-latest, or decline to stay on the tested version)."
  }
  $pipxList = if (Test-Have 'pipx') { (& pipx list 2>$null | Out-String) } else { '' }
  foreach ($pkg in $PY_TOOLS) {
    $key = $pkg -replace '-', '_'
    $tv = Get-CoopYamlValue (Join-Path $script:CoopRoot 'config/defaults.yml') "tested_with.$key" '-'
    $cur = 'not installed'
    $cm = [regex]::Match($pipxList, ("package " + [regex]::Escape($pkg) + " (\d+\.\d+\.\d+)"))
    if ($cm.Success) { $cur = $cm.Groups[1].Value }
    Write-Output ('  {0,-24} current {1,-13} {2,-20} tested {3}' -f $pkg, $cur, '', $tv)
  }
  exit 0
}

Coop-Head "coop update (v$($script:CoopVersion))"

# Tested-version gate (mirror of update.sh): if latest Pi crosses the tested MINOR and the
# user didn't pass --pi-latest, ask before jumping. Declining (or a non-interactive shell
# without --yes) pins Pi to the tested version — extensions still update.
if ((Test-Have 'pi') -and $PI_TESTED -and (-not $PI_LATEST)) {
  $piLat = Get-PiLatest
  if ($piLat -and (Test-CoopMinorNewer $piLat $PI_TESTED)) {
    Coop-Warn "Pi $piLat is newer than coop's tested version ($PI_TESTED). New Pi minors have broken coop's extensions before (0.74 -> 0.80)."
    if (Confirm-CoopPiJump "Jump to the untested Pi $piLat anyway?") {
      Coop-Info "Updating to the latest Pi $piLat (untested with this coop build)."
    } else {
      $script:PI_INSTALL_TARGET = $PI_TESTED
      Coop-Info "Staying on the tested Pi $PI_TESTED (extensions will still update). Re-run with --pi-latest to take $piLat."
    }
  }
}

# Test seam: print the resolved gate decision and stop BEFORE any install or side effect.
if ($env:COOP_UPDATE_GATE_DRYRUN -eq '1') {
  if ($script:PI_INSTALL_TARGET) { Write-Output ("GATE pin:{0}" -f $script:PI_INSTALL_TARGET) } else { Write-Output 'GATE all' }
  exit 0
}

# --- 1. Update coop-agent itself ---------------------------------------------
Coop-Head '1/5  coop-agent repository'
if ((Test-Path -LiteralPath (Join-Path $script:CoopRoot '.git')) -and (Test-Have 'git')) {
  & git -C $script:CoopRoot remote get-url origin > $null 2>&1
  if ($LASTEXITCODE -eq 0) {
    # Only uncommitted changes to TRACKED files can block a fast-forward pull; untracked
    # files (stray skills, downloaded drop-ins) are harmless and must NOT freeze updates
    # — `--untracked-files=no` excludes them. (git pull --ff-only still fails loudly on
    # its own if an incoming tracked file would actually overwrite an untracked one.)
    $status = (& git -C $script:CoopRoot status --porcelain --untracked-files=no 2>$null | Out-String)
    if ($status.Trim()) {
      Coop-Warn "uncommitted changes to tracked files in coop-agent — skipping 'git pull' (commit/stash first)."
    } else {
      Coop-Info 'git pull --ff-only'
      & git -C $script:CoopRoot pull --ff-only > $null 2>&1
      if ($LASTEXITCODE -eq 0) { Coop-Ok 'coop-agent updated' } else { Coop-Warn 'git pull failed (continuing)' }
    }
  } else {
    Coop-Info "no 'origin' remote configured — skipping repo update"
  }
} else {
  # A zip/shared-drive copy: Pi + pipx tools above still update, but the repo layer
  # (skills/prompts/guardrails/themes/scripts) is frozen forever — say so loudly.
  Coop-Warn "this coop-agent is not a git checkout — skills/prompts/guardrails will NEVER update — fix: git clone the repo, then run .\bin\coop.cmd install from the clone (your ~/.coop settings carry over)"
}

# Windows-only pre-flight for the in-place `pi update --all`: clear any leftover
# staging dir from a prior interrupted update, and refuse the update while a coop/pi
# session has the agent files open (Windows locks open files). This decides whether
# the pi-update item runs, so it must happen BEFORE we size the bar.
$RunPiUpdate = $true
if (Test-Have 'pi') {
  Remove-CoopPiStagingDirs
  if (Test-CoopPiRunning) {
    Coop-Warn 'a coop/pi session appears to be running — skipping in-place `pi update --all` (Windows locks open files, which can corrupt the agent install and leave a `.pi-coding-agent-*` staging dir).'
    Coop-Say  '      Close all coop/pi windows, then re-run: coop update'
    $RunPiUpdate = $false
  }
}

# Overall-bar denominator: the update ITEMS we attempt (pi update unless skipped +
# each pipx tool). Steps 1/4/5 (git pull / sync / doctor) sit outside the bar,
# exactly as the install bar covers only its install items.
$TOTAL = $PY_TOOLS.Count
if ($RunPiUpdate) { $TOTAL += 1 }

# Pin the overall bar to the bottom for the update phase (steps 2–3); restore the
# cursor even on Ctrl-C / errors via finally.
try {
  Coop-ProgBegin $TOTAL

  # --- 2. Update Pi + extensions ---------------------------------------------
  Coop-Head '2/5  Pi and extensions'
  if ($RunPiUpdate) {
    Coop-Unit 'pi update --all   (the agent + all installed extensions)' $UnitPiUpdate @($script:PI_INSTALL_TARGET, $script:PI_PKG)
  }

  # --- 3. Upgrade pipx tools -------------------------------------------------
  Coop-Head '3/5  Coop tools + Fabric CLI (pipx)'
  foreach ($pkg in $PY_TOOLS) { Coop-Unit $pkg $UnitPytoolUpgrade @($pkg) }
}
finally {
  Coop-ProgEnd
}

# fabric-cicd is a library injected into the Fabric CLI env — refresh it there.
if ((Test-Have 'pipx') -and ((& pipx list 2>$null | Out-String) -match 'package ms-fabric-cli ')) {
  & pipx inject ms-fabric-cli fabric-cicd --force > $null 2>&1
  if ($LASTEXITCODE -eq 0) { Coop-Ok 'fabric-cicd (library) refreshed' }
}

# --- 4. Sync vibes / skills / prompts / extension ----------------------------
Coop-Head '4/5  Sync brand assets'
$syncRc = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\sync.ps1')
if ($syncRc -ne 0) { Coop-Warn 'sync reported issues' }

# --- 5. Doctor ---------------------------------------------------------------
# Propagate doctor's verdict as the update's exit code (mirror of update.sh).
Coop-Head '5/5  Doctor'
$doctorRc = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\doctor.ps1')
exit $doctorRc

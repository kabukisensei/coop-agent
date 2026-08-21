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
$EDGE = $false        # --edge: take latest upstream instead of the release manifest
$PI_LATEST = $false   # --pi-latest: skip the tested-version gate and take latest Pi
foreach ($a in $args) {
  switch -CaseSensitive ($a) {
    '--no-fabric' { $NO_FABRIC = $true }
    '--yes'       { $env:COOP_ASSUME_YES = '1' }
    '-y'          { $env:COOP_ASSUME_YES = '1' }
    '--check'     { $CHECK = $true }
    '--pi-latest' { $PI_LATEST = $true }
    '--edge'      { $EDGE = $true }
    default       { if (-not [string]::IsNullOrWhiteSpace($a)) { Coop-Warn "update: ignoring unknown flag '$a'" } }
  }
}

# The Coop tools to upgrade. Fabric CLI is included unless --no-fabric (matching
# `coop install --no-fabric`), so a fabric-less machine doesn't report a perpetual
# failed item on every update.
$PY_TOOLS = @('coop-data-doc', 'coop-sql-review', 'coop-dax-review')
if (-not $NO_FABRIC) { $PY_TOOLS += 'ms-fabric-cli' }
# Microsoft Fabric/Power BI authoring CLI packages (npm) — kept current by update.
$PBIH_NPM_TOOLS = @('@microsoft/powerbi-report-authoring-cli', '@microsoft/powerbi-modeling-mcp')
if ($env:OS -eq 'Windows_NT') { $PBIH_NPM_TOOLS += '@microsoft/powerbi-desktop-bridge-cli' }

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
  # No stdout (offline, registry/proxy error) leaves $raw as AutomationNull, and Windows
  # PowerShell 5.1 passes that to .NET as a real $null — [regex]::Match would throw
  # ArgumentNullException. Return '' instead, matching update.sh's silent-empty contract.
  if ($null -eq $raw) { return '' }
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
# Generic twin for the pipx/fabric-cicd gate (Non-interactive = stay on tested).
function Confirm-CoopToolJump {
  param([string]$Prompt)
  if ($env:COOP_ASSUME_YES -eq '1') { return $true }
  if ([Console]::IsInputRedirected) { Coop-Warn 'Non-interactive shell; staying on the tested version (pass --yes to jump).'; return $false }
  $ans = Read-Host ("{0} [y/N]" -f $Prompt)
  return ($ans -match '^(y|yes)$')
}

# Latest published version of a pipx/PyPI tool. COOP_PYPI_LATEST_OVERRIDE short-circuits.
function Get-PypiLatest {
  param([string]$Pkg)
  if ($env:COOP_PYPI_LATEST_OVERRIDE) { return $env:COOP_PYPI_LATEST_OVERRIDE }
  $py = Get-CoopPython
  if (-not $py) { return '' }
  # python -c with the package as argv[1]. Keep it %-format (no f-strings) so old
  # pythons parse it; the inner quotes are single, so the PS double-quoted string
  # only needs backtick-n newlines.
  $code = "import json,sys,urllib.request`ntry:`n d=json.load(urllib.request.urlopen('https://pypi.org/pypi/{0}/json'.format(sys.argv[1]),timeout=15))`n print(d['info']['version'])`nexcept Exception: pass"
  $raw = (& $py -c $code $Pkg 2>$null | Select-Object -First 1)
  $m = [regex]::Match([string]$raw, '\d+\.\d+\.\d+')
  if ($m.Success) { return $m.Value } else { return '' }
}

$PI_TESTED = Get-CoopYamlValue (Join-Path $script:CoopRoot 'config/defaults.yml') 'tested_with.pi' ''

# --- Per-item units (run in a background job; return @{ok=<bool>; msg=<string>}) --
# Same contract as the install units, so the update bar animates identically.
# Runs in a background job (a fresh runspace), so the tested-version DECISION is passed
# in as args — script variables are not inherited. $Target set => pin to that version.
$UnitPiUpdate = {
  param([string]$Spec, [string]$Pkg)
  if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
    return [pscustomobject]@{ ok = $false; msg = 'pi not installed — run: coop install' }
  }
  if ($Spec -eq 'edge') {
    & pi update --all *> $null
    if ($LASTEXITCODE -eq 0) {
      $v = (& pi --version 2>$null); if (-not $v) { $v = '?' }
      return [pscustomobject]@{ ok = $true; msg = "pi + extensions updated (edge) ($v)" }
    }
    return [pscustomobject]@{ ok = $false; msg = 'pi update --all failed (try: pi update --all)' }
  }
  # $Spec is "pkg@version" (manifest pin or tested-version gate pin).
  if (Get-Command npm -ErrorAction SilentlyContinue) {
    & npm install -g $Spec *> $null
    if ($LASTEXITCODE -eq 0) {
      & pi update --extensions *> $null
      return [pscustomobject]@{ ok = $true; msg = "pinned pi to tested $($Spec.Split('@')[1]) + extensions updated" }
    }
  }
  return [pscustomobject]@{ ok = $false; msg = "failed to pin pi to $Spec (try: npm install -g $Spec)" }
}

$UnitPytoolUpgrade = {
  param([string]$Pkg, [string]$Target)
  if (-not (Get-Command pipx -ErrorAction SilentlyContinue)) {
    return [pscustomobject]@{ ok = $false; msg = "skipping $Pkg (pipx missing) — run: coop install" }
  }
  $list = (& pipx list 2>$null | Out-String)
  if ($list -notmatch ("package " + [regex]::Escape($Pkg) + " ")) {
    return [pscustomobject]@{ ok = $false; msg = "$Pkg not installed — run: coop install" }
  }
  $target = if ($Target) { $Target } else { $Pkg }
  & pipx install --force $target *> $null
  if ($LASTEXITCODE -eq 0) {
    $ver = if ($target -eq $Pkg) { '' } else { $target.Split('=')[-1] }
    return [pscustomobject]@{ ok = $true; msg = if ($ver) { "pinned $Pkg to tested $ver" } else { $Pkg } }
  }
  return [pscustomobject]@{ ok = $false; msg = "upgrade failed: $Pkg" }
}

$UnitPbihToolsUpgrade = {
  param([array]$Specs)
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    return [pscustomobject]@{ ok = $false; msg = 'skipping Power BI/Fabric authoring tools (npm missing)' }
  }
  $ok = 0; $fail = 0
  foreach ($spec in $Specs) {
    & npm ls -g --depth=0 ($spec.Split('@')[0]) *> $null
    if ($LASTEXITCODE -eq 0) {
      & npm install -g $spec *> $null
      if ($LASTEXITCODE -eq 0) { $ok++ } else { $fail++ }
    } else {
      # Never installed (machine predates these tools) — install rather than fail.
      & npm install -g $spec *> $null
      if ($LASTEXITCODE -eq 0) { $ok++ } else { $fail++ }
    }
  }
  if ($fail -eq 0) { return [pscustomobject]@{ ok = $true; msg = "$ok Power BI/Fabric authoring tool(s) updated" } }
  return [pscustomobject]@{ ok = $false; msg = "$ok updated, $fail failed" }
}

# --- coop update --check (dry-run: report versions, change NOTHING) ----------
if ($CHECK) {
  Coop-Head 'coop update --check (dry-run — nothing is installed)'
  $piCur = if (Test-Have 'pi') { $m = [regex]::Match((& pi --version 2>$null | Out-String), '\d+\.\d+\.\d+'); if ($m.Success) { $m.Value } else { '?' } } else { 'not installed' }
  $piExp = Coop-ManifestGet -Key 'pi.version'; if (-not $piExp) { $piExp = '?' }
  $piLat = Get-PiLatest; if (-not $piLat) { $piLat = '?' }
  # The version-table rows go to STDOUT (Write-Output), matching update.sh's bare
  # printf — so `coop update --check > versions.txt` captures the table on Windows too.
  Write-Output ('  {0,-32} current {1,-13} expected {2,-13} status {3}' -f "pi ($script:PI_PKG)", $piCur, $piExp, (Coop-ManifestStatus -Installed $piCur -Expected $piExp))
  if ($PI_TESTED -and (Test-CoopMinorNewer $piLat $PI_TESTED)) {
    Coop-Warn "latest Pi ($piLat) is a newer MINOR than tested ($PI_TESTED) — 'coop update' will ask before jumping (skip with --edge to take latest)."
  }
  $pipxList = if (Test-Have 'pipx') { (& pipx list 2>$null | Out-String) } else { '' }
  foreach ($pkg in $PY_TOOLS) {
    $tv = Coop-ManifestGet -Key "python_tools.$pkg"; if (-not $tv) { $tv = '?' }
    $cur = 'not installed'
    $cm = [regex]::Match($pipxList, ("package " + [regex]::Escape($pkg) + " (\d+\.\d+\.\d+)"))
    if ($cm.Success) { $cur = $cm.Groups[1].Value }
    Write-Output ('  {0,-32} current {1,-13} expected {2,-13} status {3}' -f $pkg, $cur, $tv, (Coop-ManifestStatus -Installed $cur -Expected $tv))
  }
  foreach ($pkg in $PBIH_NPM_TOOLS) {
    $tv = Coop-ManifestGet -Key "npm_tools.$pkg"; if (-not $tv) { $tv = '?' }
    $cur = 'not installed'
    $nm = (& npm ls -g --depth=0 $pkg 2>$null | Out-String)
    $cm = [regex]::Match($nm, ("" + [regex]::Escape($pkg) + "@(\d+\.\d+\.\d+[^\s]*)"))
    if (-not $cm.Success) { $cm = [regex]::Match($nm, ("" + [regex]::Escape($pkg) + "@(\S+)")) }
    if ($cm.Success) { $cur = $cm.Groups[1].Value }
    Write-Output ('  {0,-32} current {1,-13} expected {2,-13} status {3}' -f $pkg, $cur, $tv, (Coop-ManifestStatus -Installed $cur -Expected $tv))
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

# --- Tested-version gate, pipx tools + fabric-cicd (mirror of update.sh) -------
# Same rule as Pi: a release crossing the tested MINOR asks first; declining (or
# non-interactive without --yes) pins that tool to its tested version.
$script:PY_PIN = @{}
foreach ($pkg in $PY_TOOLS) {
  $key = $pkg -replace '-', '_'
  $tested = Get-CoopYamlValue (Join-Path $script:CoopRoot 'config/defaults.yml') "tested_with.$key" ''
  if (-not $tested) { continue }
  $lat = Get-PypiLatest $pkg
  if ($lat -and (Test-CoopMinorNewer $lat $tested)) {
    Coop-Warn "$pkg $lat is newer than coop's tested version ($tested)."
    if (Confirm-CoopToolJump "Jump to the untested $pkg $lat anyway?") {
      Coop-Info "Updating to the latest $pkg $lat (untested with this coop build)."
    } else {
      $script:PY_PIN[$pkg] = $tested
      Coop-Info "Staying on the tested $pkg $tested. Re-run with --yes to take $lat."
    }
  }
}
$script:FCC_PIN = ''
if ((Test-Have 'pipx') -and ((& pipx list 2>$null | Out-String) -match 'package ms-fabric-cli ')) {
  $fccTested = Get-CoopYamlValue (Join-Path $script:CoopRoot 'config/defaults.yml') 'tested_with.fabric_cicd' ''
  if ($fccTested) {
    $fccLat = Get-PypiLatest 'fabric-cicd'
    if ($fccLat -and (Test-CoopMinorNewer $fccLat $fccTested)) {
      Coop-Warn "fabric-cicd $fccLat is newer than coop's tested version ($fccTested)."
      if (Confirm-CoopToolJump "Jump to the untested fabric-cicd $fccLat anyway?") {
        Coop-Info "Updating to the latest fabric-cicd $fccLat (untested with this coop build)."
      } else {
        $script:FCC_PIN = $fccTested
        Coop-Info "Staying on the tested fabric-cicd $fccTested."
      }
    }
  }
}

# Test seam: print the resolved gate decision and stop BEFORE any install or side effect.
if ($env:COOP_UPDATE_GATE_DRYRUN -eq '1') {
  if ($EDGE) { Write-Output 'GATE all'; exit 0 }
  $pins = @()
  if ($script:PI_INSTALL_TARGET) { $pins += $script:PI_INSTALL_TARGET }
  foreach ($k in $script:PY_PIN.Keys) { $pins += "$k=$($script:PY_PIN[$k])" }
  if ($script:FCC_PIN) { $pins += "fabric-cicd=$($script:FCC_PIN)" }
  if ($pins.Count -gt 0) { Write-Output ("GATE pin:{0}" -f ($pins -join ',')) } else { Write-Output 'GATE all' }
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
# each pipx tool + Power BI/Fabric authoring npm tools). Steps 1/4/5/6 (git pull /
# sync / doctor) sit outside the bar, exactly as the install bar covers only its
# install items.
$TOTAL = $PY_TOOLS.Count + 1
if ($RunPiUpdate) { $TOTAL += 1 }

# Pin the overall bar to the bottom for the update phase (steps 2–4); restore the
# cursor even on Ctrl-C / errors via finally.
try {
  Coop-ProgBegin $TOTAL

  # Resolve exact specs from the release manifest (unless --edge or gate pin).
  $piSpec = if ($EDGE) { 'edge' } elseif ($script:PI_INSTALL_TARGET) { "$script:PI_PKG@$script:PI_INSTALL_TARGET" } else { $manifestPi = Coop-ManifestGet -Key 'pi.version'; if ($manifestPi) { "$script:PI_PKG@$manifestPi" } else { '' } }
  $pytoolTargets = @()
  foreach ($pkg in $PY_TOOLS) {
    $pytoolTargets += if ($EDGE) { $pkg } else { $tv = Coop-ManifestGet -Key "python_tools.$pkg"; if ($tv) { "$pkg==$tv" } else { $pkg } }
  }
  $pbihSpecs = @()
  foreach ($pkg in $PBIH_NPM_TOOLS) {
    $pbihSpecs += if ($EDGE) { $pkg } else { $tv = Coop-ManifestGet -Key "npm_tools.$pkg"; if ($tv) { "$pkg@$tv" } else { $pkg } }
  }

  # --- 2. Update Pi + extensions ---------------------------------------------
  Coop-Head '2/6  Pi and extensions'
  if ($RunPiUpdate) {
    Coop-Unit 'pi update --all   (the agent + all installed extensions)' $UnitPiUpdate @($piSpec, $script:PI_PKG)
  }

  # --- 3. Upgrade pipx tools -------------------------------------------------
  Coop-Head '3/6  Coop tools + Fabric CLI (pipx)'
  for ($i = 0; $i -lt $PY_TOOLS.Count; $i++) { Coop-Unit $PY_TOOLS[$i] $UnitPytoolUpgrade @($PY_TOOLS[$i], $pytoolTargets[$i]) }

  # --- 4. Upgrade Microsoft Fabric / Power BI authoring tools (npm) ----------
  Coop-Head '4/6  Fabric / Power BI authoring tools'
  Coop-Unit 'Power BI/Fabric authoring tools' $UnitPbihToolsUpgrade @($pbihSpecs)
}
finally {
  Coop-ProgEnd
}

# fabric-cicd is a library injected into the Fabric CLI env — refresh it there (or
# pin it to the tested version when the update gate declined a jump).
if ((Test-Have 'pipx') -and ((& pipx list 2>$null | Out-String) -match 'package ms-fabric-cli ')) {
  if ($script:FCC_PIN) {
    & pipx inject ms-fabric-cli "fabric-cicd==$($script:FCC_PIN)" --force > $null 2>&1
    if ($LASTEXITCODE -eq 0) { Coop-Ok "fabric-cicd (library) pinned to tested $($script:FCC_PIN)" }
  } else {
    & pipx inject ms-fabric-cli fabric-cicd --force > $null 2>&1
    if ($LASTEXITCODE -eq 0) { Coop-Ok 'fabric-cicd (library) refreshed' }
  }
}

# --- 5. Sync vibes / skills / prompts / extension ----------------------------
Coop-Head '5/6  Sync brand assets'
$syncRc = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\sync.ps1')
if ($syncRc -ne 0) { Coop-Warn 'sync reported issues' }

# --- 6. Doctor ---------------------------------------------------------------
# Propagate doctor's verdict as the update's exit code (mirror of update.sh).
Coop-Head '6/6  Doctor'
$doctorRc = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\doctor.ps1')
exit $doctorRc

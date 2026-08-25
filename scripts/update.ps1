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
$CHECK = $false       # --check: dry-run — report current/expected, change nothing
$EDGE = $false        # --edge: take latest upstream instead of the release manifest
foreach ($a in $args) {
  switch -CaseSensitive ($a) {
    '--no-fabric' { $NO_FABRIC = $true }
    '--yes'       { $env:COOP_ASSUME_YES = '1' }
    '-y'          { $env:COOP_ASSUME_YES = '1' }
    '--check'     { $CHECK = $true }
    '--pi-latest' { Coop-Warn '--pi-latest is deprecated - use --edge (normal update always pins to the release manifest)'; $EDGE = $true }
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

# --- Fleet mode (mirror of update.sh) ----------------------------------------
# Exactly two modes: NORMAL pins Pi + every extension/tool to the release manifest
# (no registry queries, no prompts); --edge takes latest upstream across the fleet.
# The old tested-version gates (--pi-latest / "Jump to the untested ...?" prompts)
# are gone: they queried latest versions merely to ask about them, and normal
# update resolved back to manifest pins anyway.
$script:PI_PKG = '@earendil-works/pi-coding-agent'

# Latest published Pi version — used ONLY by --check reporting. COOP_PI_LATEST_OVERRIDE
# short-circuits the registry query.
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

# --- Per-item units (run in a background job; return @{ok=<bool>; msg=<string>}) --
# Same contract as the install units, so the update bar animates identically.
# Runs in a background job (a fresh runspace), so the tested-version DECISION is passed
# in as args — script variables are not inherited. $Target set => pin to that version.
$UnitPiUpdate = {
  param([string]$Spec, [string]$Pkg, [string]$ExtensionSpecs)
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
      $failed = $false
      foreach ($extSpec in @($ExtensionSpecs -split '\|' | Where-Object { $_ })) {
        & pi install $extSpec *> $null
        if ($LASTEXITCODE -ne 0) { $failed = $true }
      }
      if (-not $failed) { return [pscustomobject]@{ ok = $true; msg = 'pinned pi and extensions to release manifest' } }
      return [pscustomobject]@{ ok = $false; msg = 'pi pinned but one or more manifest extensions failed' }
    }
  }
  return [pscustomobject]@{ ok = $false; msg = "failed to pin pi to $Spec (try: npm install -g $Spec)" }
}

$UnitPytoolUpgrade = {
  param([string]$Pkg, [string]$Target, [string]$Python)
  if (-not (Get-Command pipx -ErrorAction SilentlyContinue)) {
    return [pscustomobject]@{ ok = $false; msg = "skipping $Pkg (pipx missing) — run: coop install" }
  }
  $list = (& pipx list 2>$null | Out-String)
  $installed = $list -match ("package " + [regex]::Escape($Pkg) + " ")
  $target = if ($Target) { $Target } else { $Pkg }
  if ($Pkg -eq 'ms-fabric-cli' -and -not $Python) {
    return [pscustomobject]@{ ok = $false; msg = 'ms-fabric-cli needs Python 3.12 or 3.13 — install one, then re-run: coop update' }
  }
  $pipxArgs = @('install')
  if ($installed) { $pipxArgs += '--force' }
  if ($Python) { $pipxArgs += @('--python', $Python) }
  $pipxArgs += $target
  & pipx @pipxArgs *> $null
  if ($LASTEXITCODE -eq 0) {
    $ver = if ($target -eq $Pkg) { '' } else { $target.Split('=')[-1] }
    return [pscustomobject]@{ ok = $true; msg = if (-not $installed) { "installed missing $Pkg$(if ($ver) { " at tested $ver" } else { '' })" } elseif ($ver) { "pinned $Pkg to tested $ver" } else { $Pkg } }
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

# Test seam: print the resolved fleet-mode decision and stop BEFORE any install or
# side effect. Normal mode pins everything to the release manifest; --edge takes latest.
if ($env:COOP_UPDATE_GATE_DRYRUN -eq '1') {
  if ($EDGE) { Write-Output 'GATE all'; exit 0 }
  $piPin = Coop-ManifestGet -Key 'pi.version'
  if ($piPin) { Write-Output ("GATE pin:{0}" -f $piPin) } else { Write-Output 'GATE all' }
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
$script:UpdateFailures = 0
if (Test-Have 'pi') {
  Remove-CoopPiStagingDirs
  if (Test-CoopPiRunning) {
    Coop-Warn 'a coop/pi session appears to be running — skipping in-place `pi update --all` (Windows locks open files, which can corrupt the agent install and leave a `.pi-coding-agent-*` staging dir).'
    Coop-Say  '      Close all coop/pi windows, then re-run: coop update'
    $RunPiUpdate = $false
    $script:UpdateFailures++
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
  $piSpec = if ($EDGE) { 'edge' } else { $manifestPi = Coop-ManifestGet -Key 'pi.version'; if ($manifestPi) { "$($script:PI_PKG)@$manifestPi" } else { '' } }
  $pytoolTargets = @()
  foreach ($pkg in $PY_TOOLS) {
    $pytoolTargets += if ($EDGE) { $pkg } else { $tv = Coop-ManifestGet -Key "python_tools.$pkg"; if ($tv) { "$pkg==$tv" } else { $pkg } }
  }
  $fabricPython = Get-CoopFabricPython
  if (-not $fabricPython -and (Get-Command winget -ErrorAction SilentlyContinue)) {
    Coop-Info 'Microsoft Fabric CLI needs Python 3.10–3.13; installing Python 3.12…'
    & winget install --id Python.Python.3.12 -e --source winget --accept-source-agreements --accept-package-agreements --silent --disable-interactivity *> $null
    foreach ($d in @(
      (Join-Path $env:ProgramFiles 'Python312'),
      (Join-Path $env:ProgramFiles 'Python312\Scripts'),
      (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312'),
      (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\Scripts')
    )) {
      if ((Test-Path -LiteralPath $d) -and (($env:PATH -split ';') -notcontains $d)) { $env:PATH = "$d;$env:PATH" }
    }
    $fabricPython = Get-CoopFabricPython
  }
  $extensionSpecs = @()
  foreach ($pkg in @(Coop-ManifestKeys 'extensions')) {
    $spec = Coop-ManifestExtensionSpec $pkg
    if ($spec) { $extensionSpecs += $spec }
  }
  $pbihSpecs = @()
  foreach ($pkg in $PBIH_NPM_TOOLS) {
    $pbihSpecs += if ($EDGE) { $pkg } else { $tv = Coop-ManifestGet -Key "npm_tools.$pkg"; if ($tv) { "$pkg@$tv" } else { $pkg } }
  }

  # --- 2. Update Pi + extensions ---------------------------------------------
  Coop-Head '2/6  Pi and extensions'
  if ($RunPiUpdate) {
    Coop-Unit 'pi + manifest extensions' $UnitPiUpdate @($piSpec, $script:PI_PKG, ($extensionSpecs -join '|'))
    if (-not $script:CoopUnitLastOk) { $script:UpdateFailures++ }
  }

  # --- 3. Upgrade pipx tools -------------------------------------------------
  Coop-Head '3/6  Coop tools + Fabric CLI (pipx)'
  for ($i = 0; $i -lt $PY_TOOLS.Count; $i++) {
    $toolPython = if ($PY_TOOLS[$i] -eq 'ms-fabric-cli') { $fabricPython } else { '' }
    Coop-Unit $PY_TOOLS[$i] $UnitPytoolUpgrade @($PY_TOOLS[$i], $pytoolTargets[$i], $toolPython)
    if (-not $script:CoopUnitLastOk) { $script:UpdateFailures++ }
  }

  # --- 4. Upgrade Microsoft Fabric / Power BI authoring tools (npm) ----------
  Coop-Head '4/6  Fabric / Power BI authoring tools'
  Coop-Unit 'Power BI/Fabric authoring tools' $UnitPbihToolsUpgrade @($pbihSpecs)
  if (-not $script:CoopUnitLastOk) { $script:UpdateFailures++ }
}
finally {
  Coop-ProgEnd
}

# fabric-cicd is manifest-pinned in normal mode; edge alone may take latest.
# fabric-cicd is a library injected into the Fabric CLI env. Normal mode always
# uses the manifest pin; edge mode alone may take latest.
$script:FCC_PIN = ''
if (-not $EDGE) { $script:FCC_PIN = Coop-ManifestObjectGet 'python_tools' 'fabric-cicd' }
if ((Test-Have 'pipx') -and ((& pipx list 2>$null | Out-String) -match 'package ms-fabric-cli ')) {
  if ($script:FCC_PIN) {
    & pipx inject ms-fabric-cli "fabric-cicd==$($script:FCC_PIN)" --force > $null 2>&1
    if ($LASTEXITCODE -eq 0) { Coop-Ok "fabric-cicd (library) pinned to tested $($script:FCC_PIN)" }
    else { Coop-Warn "failed to pin fabric-cicd to $($script:FCC_PIN) in the ms-fabric-cli environment"; $script:UpdateFailures++ }
  } else {
    & pipx inject ms-fabric-cli fabric-cicd --force > $null 2>&1
    if ($LASTEXITCODE -eq 0) { Coop-Ok 'fabric-cicd (library) refreshed' }
    else { Coop-Warn 'failed to refresh fabric-cicd in the ms-fabric-cli environment'; $script:UpdateFailures++ }
  }
}
if ($env:COOP_FLEET_TEST_MODE -eq '1') { if ($script:UpdateFailures -gt 0) { exit 1 } else { exit 0 } }

# --- 5. Sync vibes / skills / prompts / extension ----------------------------
Coop-Head '5/6  Sync brand assets'
$syncRc = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\sync.ps1')
if ($syncRc -ne 0) { Coop-Warn 'sync reported issues'; $script:UpdateFailures++ }

# --- 6. Doctor ---------------------------------------------------------------
# Propagate doctor's verdict as the update's exit code (mirror of update.sh).
Coop-Head '6/6  Doctor'
$doctorRc = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\doctor.ps1')
if ($doctorRc -ne 0 -or $script:UpdateFailures -gt 0) {
  if ($script:UpdateFailures -gt 0) { Coop-Warn "update finished with $($script:UpdateFailures) failed convergence step(s) — see warnings above" }
  exit 1
}
exit 0

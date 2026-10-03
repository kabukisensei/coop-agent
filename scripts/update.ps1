#!/usr/bin/env pwsh
#
# coop update —
# keep the whole Cooptimize stack current:
#   1. Move coop-agent to the newest release tag (--edge: head of main)
#   2. Converge Pi to the release manifest (--edge: upstream latest)
#   3. Converge the Coop tools and the Microsoft Fabric CLI (pipx)
#   4. Converge the Power BI / Fabric authoring tools (npm)
#   5. Sync: the extension fleet at its pins, MCP config, brand assets
#   6. Run doctor
# Every convergence runs the same lib/common.ps1 function `coop install` uses
# (Invoke-Coop*Converge, master plan S2): a component already at its pin is an
# offline no-op.
#
$ErrorActionPreference = 'Continue'

# --- Shared helpers: dot-source lib/common.ps1 ---------------------------------
# Resolves COOP_ROOT/COOP_VERSION and defines the loggers, the progress engine
# (Coop-Prog*/Coop-Emit), Test-Have, Get-CoopPython, Get-CoopFleetPlan, the
# Invoke-Coop*Converge functions, the busy guard (Test-CoopPiConvergeAllowed),
# Coop-Unit, Invoke-CoopScript, etc.
. (Join-Path $PSScriptRoot '../lib/common.ps1')

# --- Parse flags -------------------------------------------------------------
$NO_FABRIC = $false
$CHECK = $false       # --check: dry-run — report current/expected, change nothing
$EDGE = $false        # --edge: head of main + latest upstream instead of the release tag and manifest
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

# What update converges: the release manifest through Get-CoopFleetPlan (the
# same plan install, sync and uninstall read). Fabric CLI is included unless
# --no-fabric (matching `coop install --no-fabric`), so a fabric-less machine
# doesn't report a perpetual failed item on every update. --edge drops the Pi and
# tool pins; the extensions stay pinned (the sync child converges them).
$PLAN = Get-CoopFleetPlan -Edge:$EDGE -NoFabric:$NO_FABRIC

# Update coop's ISOLATED Pi agent dir (not the user's personal pi).
$env:PI_CODING_AGENT_DIR = Get-CoopPiAgentDir

# --- Fleet mode --------------------------------------------------------------
# Exactly two modes: NORMAL moves coop-agent to the newest release tag (never
# backwards) and pins Pi + every extension/tool to that release's manifest (no
# registry queries, no prompts); --edge takes head of main and latest upstream.
# The old tested-version gates (--pi-latest / "Jump to the untested ...?" prompts)
# are gone: they queried latest versions merely to ask about them, and normal
# update resolved back to manifest pins anyway.

# Per-item units: the convergence functions in lib/common.ps1, run through
# $script:CoopConvergeUnit (a background job whose fresh runspace dot-sources the
# library; every input is an argument). Same contract as install, so the bar
# animates identically and both commands converge the same way.

# --- coop update --check (dry-run: report versions, change NOTHING) ----------
if ($CHECK) {
  Coop-Head 'coop update --check (dry-run — nothing is installed)'
  # Step 1's move first (#107), after the same fetch step 1 makes: a release
  # tagged since the last fetch is not on the machine yet, and reading local tags
  # alone called it "no newer release" until something else fetched. Fetching
  # updates no file in the checkout, so --check still changes nothing.
  $null = Invoke-CoopRepoFetchOrigin
  $repoCheck = Get-CoopRepoCheckLine
  Write-Output ('  {0,-32} {1}' -f 'repo (coop-agent)', $repoCheck.Line)
  if ($repoCheck.Hint) { Write-Output ('  {0,-32} {1}' -f '', $repoCheck.Hint) }
  $piCur = if (Test-Have 'pi') { $v = Get-CoopPiVersion; if ($v) { $v } else { '?' } } else { 'not installed' }
  $piExp = $PLAN.PiPin; if (-not $piExp) { $piExp = '?' }
  # The version-table rows go to STDOUT (Write-Output), so
  # `coop update --check > versions.txt` captures the table; status lines are stderr.
  Write-Output ('  {0,-32} current {1,-13} expected {2,-13} status {3}' -f "pi ($($PLAN.PiPackage))", $piCur, $piExp, (Coop-ManifestStatus -Installed $piCur -Expected $piExp))
  # The same probes the convergence units use (Get-CoopPipxToolVersion from one
  # `pipx list`, Get-CoopNpmToolVersion from `npm ls -g`).
  $pipxList = if (Test-CoopPipxAvailable) { Get-CoopPipxOutput @('list') } else { '' }
  $checkTools = @($PLAN.PythonTools); if ($PLAN.Fabric) { $checkTools += $PLAN.Fabric }
  foreach ($tool in $checkTools) {
    $tv = $tool.Pin; if (-not $tv) { $tv = '?' }
    $cur = Get-CoopPipxToolVersion -Package $tool.Name -ListText $pipxList
    if (-not $cur) { $cur = 'not installed' }
    Write-Output ('  {0,-32} current {1,-13} expected {2,-13} status {3}' -f $tool.Name, $cur, $tv, (Coop-ManifestStatus -Installed $cur -Expected $tv))
  }
  foreach ($tool in $PLAN.NpmTools) {
    $tv = $tool.Pin; if (-not $tv) { $tv = '?' }
    $cur = Get-CoopNpmToolVersion $tool.Name
    if (-not $cur) { $cur = 'not installed' }
    Write-Output ('  {0,-32} current {1,-13} expected {2,-13} status {3}' -f $tool.Name, $cur, $tv, (Coop-ManifestStatus -Installed $cur -Expected $tv))
  }
  exit 0
}

Coop-Head "coop update (v$($script:CoopVersion))"

# --- 1. Update coop-agent itself ---------------------------------------------
Coop-Head '1/6  coop-agent repository'
if ((Test-CoopGitCheckout $script:CoopRoot) -and (Test-Have 'git')) {
  & git -C $script:CoopRoot remote get-url origin > $null 2>&1
  if ($LASTEXITCODE -eq 0) {
    # Fast-forward to the newest release tag, never backwards (--edge: head of
    # main). Only uncommitted changes to TRACKED files skip the move; untracked
    # files (stray skills, downloaded drop-ins) never block it, and git refuses on
    # its own a fast-forward that would overwrite one (ignored files excepted, see
    # RELEASE.md). A branch that does not track origin/main is a hold, left alone.
    Invoke-CoopRepoFollowRelease $EDGE
  } else {
    # Renamed or removed origin: warn with the fix (Get-CoopRepoStranded names it).
    if (-not (Write-CoopRepoStranded)) { Coop-Warn "no 'origin' remote configured — skipping repo update" }
  }
} else {
  # A zip/shared-drive copy: Pi + pipx tools above still update, but the repo layer
  # (skills/prompts/guardrails/themes/scripts) is frozen forever — say so loudly.
  Coop-Warn "this coop-agent is not a git checkout — skills/prompts/guardrails will NEVER update — fix: git clone the repo, then run .\bin\coop.cmd install from the clone (your ~/.coop settings carry over)"
}

# The checkout may have just moved to a newer release: re-read the fleet plan from
# the manifest it now carries, so Pi, the pipx tools and the npm tools converge to
# THAT release's pins in this same run (a plan read before the move left them one
# release behind until the next update; #280). Only the manifest is re-read; the
# updater code running here stays the loaded version (RELEASE.md's second-update
# note covers releases that change the updater itself).
$PLAN = Get-CoopFleetPlan -Edge:$EDGE -NoFabric:$NO_FABRIC

# Busy guard (shared with install): clear any leftover staging dir from a prior
# interrupted update, and refuse the in-place Pi convergence while a coop/pi
# session has the agent files open (Windows locks open files). This decides
# whether the Pi item runs, so it must happen BEFORE we size the bar.
$script:UpdateFailures = 0
$RunPiUpdate = Test-CoopPiConvergeAllowed 'coop update'
if (-not $RunPiUpdate) { $script:UpdateFailures++ }

# Overall-bar denominator: the update ITEMS we attempt (Pi unless skipped + each
# pipx tool + the Fabric CLI + Power BI/Fabric authoring npm tools). Steps 1/5/6
# (repo move / sync / doctor) sit outside the bar, exactly as the install bar
# covers only its install items.
$TOTAL = @($PLAN.PythonTools).Count + 1
if ($PLAN.Fabric) { $TOTAL += 1 }
if ($RunPiUpdate) { $TOTAL += 1 }

# Pin the overall bar to the bottom for the update phase (steps 2–4); restore the
# cursor even on Ctrl-C / errors via finally.
try {
  Coop-ProgBegin $TOTAL

  # --- 2. Converge Pi --------------------------------------------------------
  # Probe, skip at the pin, else `npm install -g <spec>` (--edge: the unpinned
  # package). The extensions converge in the sync child (step 5), always pinned.
  Coop-Head "2/6  Pi ($($PLAN.PiPackage))"
  if ($RunPiUpdate) {
    Coop-Unit "pi ($($PLAN.PiPackage))" $script:CoopConvergeUnit @($script:CoopCommonPath, 'Invoke-CoopPiConverge', @{ Package = $PLAN.PiPackage; Pin = $PLAN.PiPin; Edge = $EDGE; Force = $false })
    if (-not $script:CoopUnitLastOk) { $script:UpdateFailures++ }
  }

  # --- 3. Converge the pipx tools --------------------------------------------
  Coop-Head '3/6  Coop tools + Fabric CLI (pipx)'
  foreach ($tool in $PLAN.PythonTools) {
    Coop-Unit $tool.Name $script:CoopConvergeUnit @($script:CoopCommonPath, 'Invoke-CoopPipxConverge', @{ Package = $tool.Name; Pin = $tool.Pin; Edge = $EDGE; Force = $false })
    if (-not $script:CoopUnitLastOk) { $script:UpdateFailures++ }
  }
  if ($PLAN.Fabric) {
    $fabricPython = Get-CoopFabricBootstrapPython
    $fabricFetchPython = ''
    if (-not $fabricPython) {
      # Ladder: the Python launcher/install manager first (`py install` covers both
      # the classic py.exe and the newer Python install manager), then winget.
      # Machines with only Python 3.14 (e.g. pymanager's pythoncore-3.14) get a
      # compatible side-by-side interpreter instead of an unrepairable warning.
      $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
      if ($pyLauncher) {
        Coop-Info 'Microsoft Fabric CLI needs Python 3.10–3.13; installing Python 3.12…'
        & $pyLauncher.Source install 3.12 *> $null
        $fabricPython = Get-CoopFabricBootstrapPython
      }
      if (-not $fabricPython -and (Get-Command winget -ErrorAction SilentlyContinue)) {
        Coop-Info 'Microsoft Fabric CLI needs Python 3.10–3.13; installing Python 3.12 via winget…'
        & winget install --id Python.Python.3.12 -e --source winget --accept-source-agreements --accept-package-agreements --silent --disable-interactivity *> $null
        foreach ($d in @(
          (Join-Path $env:ProgramFiles 'Python312'),
          (Join-Path $env:ProgramFiles 'Python312\Scripts'),
          (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312'),
          (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\Scripts')
        )) {
          if ((Test-Path -LiteralPath $d) -and (($env:PATH -split ';') -notcontains $d)) { $env:PATH = "$d;$env:PATH" }
        }
        $fabricPython = Get-CoopFabricBootstrapPython
      }
    }
    if (-not $fabricPython) {
      # pipx's standalone 3.12 (Get-CoopFabricPipxPlan, shared with install and
      # doctor --fix) when no local 3.10-3.13 could be found or installed above.
      $fabricPlan = Get-CoopFabricPipxPlan
      if ($fabricPlan -and $fabricPlan.FetchFlag) {
        $fabricPython = $fabricPlan.Python
        $fabricFetchPython = $fabricPlan.FetchFlag
        Coop-Info "Microsoft Fabric CLI will use pipx's standalone Python 3.12"
      }
    }
    Coop-Unit $PLAN.Fabric.Name $script:CoopConvergeUnit @($script:CoopCommonPath, 'Invoke-CoopFabricCliConverge', @{ Package = $PLAN.Fabric.Name; Pin = $PLAN.Fabric.Pin; Edge = $EDGE; Force = $false; Python = [string]$fabricPython; FetchPython = [string]$fabricFetchPython; Command = 'coop update' })
    if (-not $script:CoopUnitLastOk) { $script:UpdateFailures++ }
  }

  # --- 4. Converge the Microsoft Fabric / Power BI authoring tools (npm) -----
  Coop-Head '4/6  Fabric / Power BI authoring tools'
  Coop-Unit 'Power BI/Fabric authoring tools' $script:CoopConvergeUnit @($script:CoopCommonPath, 'Invoke-CoopNpmToolsConverge', @{ Names = [string[]]@($PLAN.NpmTools | ForEach-Object { $_.Name }); Pins = [string[]]@($PLAN.NpmTools | ForEach-Object { $_.Pin }); Edge = $EDGE; Force = $false })
  if (-not $script:CoopUnitLastOk) { $script:UpdateFailures++ }
}
finally {
  Coop-ProgEnd
}

# Exact runtime libraries are part of Fabric convergence, not standalone tools.
if ($PLAN.Fabric -and (Get-CoopPipxToolVersion $PLAN.Fabric.Name)) {
  if (Sync-CoopFabricPythonPackages $EDGE) { Coop-Ok 'Fabric Python runtime converged (fabric-cicd + pinned pyodbc)' }
  else { Coop-Warn 'failed to converge the Fabric Python runtime'; $script:UpdateFailures++ }
  if (-not (Ensure-CoopFabricOdbcDriver $true)) { Coop-Warn 'Fabric SQL fallback is not ready'; $script:UpdateFailures++ }
}

# --- 5. Sync: the extension fleet at its pins, MCP config, brand assets -------
# The sync child is the ONE extension convergence path (Sync-CoopExtensionFleet):
# update itself never runs `pi install` or `pi update`.
Coop-Head '5/6  Sync extensions and brand assets'
$priorSkipFabricSync = $env:COOP_SKIP_FABRIC_SYNC
$env:COOP_SKIP_FABRIC_SYNC = '1' # Fabric was converged (or explicitly skipped) above.
$syncRc = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\sync.ps1')
if ($null -eq $priorSkipFabricSync) { Remove-Item Env:COOP_SKIP_FABRIC_SYNC -ErrorAction SilentlyContinue } else { $env:COOP_SKIP_FABRIC_SYNC = $priorSkipFabricSync }
if ($syncRc -ne 0) { Coop-Warn 'sync reported issues'; $script:UpdateFailures++ }
# Repair the double-click launcher where one exists: older installs have a "coop"
# shortcut for the retired browser chat (S5) and a separate "coop (terminal)".
try { if (Set-CoopDesktopShortcuts -OnlyIfPresent) { Coop-Ok 'refreshed the "coop" double-click launcher' } } catch { }

# --- 6. Doctor ---------------------------------------------------------------
# Propagate doctor's verdict as the update's exit code.
Coop-Head '6/6  Doctor'
$doctorRc = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\doctor.ps1')
if ($doctorRc -ne 0 -or $script:UpdateFailures -gt 0) {
  if ($script:UpdateFailures -gt 0) { Coop-Warn "update finished with $($script:UpdateFailures) failed convergence step(s) — see warnings above" }
  exit 1
}
exit 0

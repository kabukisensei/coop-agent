#!/usr/bin/env pwsh
#
# coop sync —
# provision coop's ISOLATED Pi agent dir (~/.coop/agent) + brand assets (non-destructive):
#   • create the isolated dir; share auth/models from your personal pi (login)
#   • enable Pi's quiet startup in the isolated settings (resources still load)
#   • converge the manifest's Pi extensions INTO that dir (Sync-CoopExtensionFleet)
#   • refresh the coop window's Electron runtime where `coop desktop` installed it
#   • place the read-only MCP config into the isolated dir if absent (never clobbers)
#   • verify splash / theme / vibes are present
#
$ErrorActionPreference = 'Continue'

# --- Shared helpers: dot-source lib/common.ps1 ---------------------------------
# Resolves COOP_ROOT/COOP_VERSION and defines the loggers, Test-Have,
# Get-CoopPython, Get-CoopPiVersion, Get-CoopPiAgentDir, Get-CoopFleetPlan and
# Sync-CoopExtensionFleet (the one extension convergence path, which wraps
# Sync-CoopExtDeps, the pi-ai/pi-tui aligner the launch preflight also calls).
. (Join-Path $PSScriptRoot '../lib/common.ps1')

# coop renders its own footer/splash — no third-party powerline footer. The
# extension fleet itself comes from the release manifest (Get-CoopFleetPlan).
$PI_AGENT = Get-CoopPiAgentDir
$GLOBAL_AGENT = Get-CoopPersonalPiAgentDir

Coop-Head "coop sync (v$($script:CoopVersion))"

# --- 1. Launchers (the .ps1/.cmd shims are inherently executable on Windows) --
Coop-Ok 'coop launchers and scripts are runnable'

# --- 2. Isolated Pi agent dir + shared credentials ---------------------------
Coop-Head 'Isolated Pi agent dir'
New-Item -ItemType Directory -Force -Path $PI_AGENT | Out-Null
Coop-Ok "coop Pi agent dir: $PI_AGENT"
foreach ($f in @('auth.json', 'models.json')) {
  $dst = Join-Path $PI_AGENT $f
  $src = Join-Path $GLOBAL_AGENT $f
  if (-not (Test-Path -LiteralPath $dst) -and (Test-Path -LiteralPath $src -PathType Leaf)) {
    # Prefer a symlink so refreshed logins stay live (like bash `ln -sf`); fall back to a
    # static copy when symlinks aren't allowed (no Developer Mode / admin).
    try {
      New-Item -ItemType SymbolicLink -Path $dst -Target $src -ErrorAction Stop | Out-Null
      Coop-Ok "linked $f from your personal pi (login/models)"
    } catch {
      Copy-Item -LiteralPath $src -Destination $dst
      Coop-Ok "copied $f from your personal pi (login/models; enable Developer Mode for a live link)"
    }
  }
}

# --- 3. Fleet Pi settings ----------------------------------------------------
$script:SyncFailures = 0
$settingsPy = Get-CoopPython
if ($settingsPy) {
  & $settingsPy (Join-Path $script:CoopRoot 'lib\pi_settings.py') ensure-quiet-startup (Join-Path $PI_AGENT 'settings.json')
  if ($LASTEXITCODE -eq 0) { Coop-Ok 'quiet startup enabled (guardrails, skills, prompts, extensions, and theme still load)' }
  else { Coop-Warn "could not enable quiet startup in $PI_AGENT\settings.json" 'run: coop sync'; $script:SyncFailures++ }
  # pi-better-openai defaults to replacing the footer, which wipes coop's own footer
  # (issue #203); status mode feeds its usage text into coop's bar instead.
  & $settingsPy (Join-Path $script:CoopRoot 'lib\pi_settings.py') ensure-coop-footer (Join-Path $PI_AGENT 'extensions\pi-better-openai.json')
  if ($LASTEXITCODE -eq 0) { Coop-Ok "pi-better-openai footer set to status mode (coop's own footer stays)" }
  else { Coop-Warn "could not set pi-better-openai footer mode in $PI_AGENT\extensions\pi-better-openai.json" 'run: coop sync'; $script:SyncFailures++ }
} else {
  Coop-Warn 'could not enable quiet startup: Python not found' 'run: coop sync'
  $script:SyncFailures++
}

# --- 4. Managed Fabric Python runtime ----------------------------------------
# Repair an existing Fabric environment, but never install Fabric itself.
if ($env:COOP_SKIP_FABRIC_SYNC -ne '1' -and ($env:COOP_FABRIC_PYTHON -or (Get-CoopVenvPythonPath $script:CoopFabricCliPackage))) {
  if ((Sync-CoopFabricPythonPackages) -and (Ensure-CoopFabricOdbcDriver $true)) {
    $sqlStatus = Get-CoopFabricSqlRuntimeStatus
    if ($sqlStatus.state -eq 'ready') { Coop-Ok 'Fabric SQL Python runtime ready (pyodbc + ODBC Driver 18+)' }
    elseif ($sqlStatus.state -eq 'driver_missing') { Coop-Ok 'Fabric SQL Python packages converged (ODBC Driver 18+ remains operator-managed)' }
  } else {
    Coop-Warn 'Fabric SQL Python runtime is not ready' 'run: coop doctor'
    $script:SyncFailures++
  }
}

# --- 4b. Core Pi extensions — installed INTO the isolated dir (idempotent) ----
# The one `pi install` path (Sync-CoopExtensionFleet in lib/common.ps1, master
# plan S2): the manifest's extensions at their exact pins, the shipped lockfile,
# the shared pi-ai/pi-tui alignment and the postconditions. `coop install` and
# `coop update` run this script as a child, so extensions converge once, here.
# Every Pi operation targets the ISOLATED dir, never the caller's personal ~/.pi.
Coop-Info "Coop keeps its extensions in $PI_AGENT and pins the versions tested"
Coop-Info "together with this Coop release. Your personal Pi extensions are unchanged."
$script:SyncFailures += [int](Sync-CoopExtensionFleet -AgentDir $PI_AGENT)
# The todo panel's collapse key (Set-CoopTodoConfig): seeded once, never rewritten.
if (Set-CoopTodoConfig) { Coop-Ok 'Todo panel key set to Alt+T (~/.config/rpiv-todo/config.json)' }

# --- 4c. The coop window's runtime (master plan D1b; only where installed) ----
# `coop desktop` installs Electron on first use. Sync keeps an installed runtime
# on this release's pin and lock and never installs one. A refresh that fails
# (usually an open window holding electron.exe) is a warning, not a sync
# failure: the window keeps running on the runtime it has.
$desktopState = Get-CoopDesktopRuntimeState
if ($desktopState -eq 'stale') {
  Coop-Head 'coop window'
  [void](Install-CoopDesktopRuntime)
} elseif ($desktopState -eq 'current') {
  Coop-Ok "coop window runtime current (Electron $(Get-CoopDesktopElectronPin), pdf.js $(Get-CoopDesktopPdfjsPin))"
}

# --- 5. MCP config — manifest-pinned, ownership-aware, non-destructive --------
# pi-mcp-adapter 3.x reads mcp-adapter.json; the generator migrates an old mcp.json.
# The Warehouse target follows the folder sync runs in; every launch rewrites it
# for its own folder (Update-CoopManagedMcpConfig), so sync's choice is not final.
$MCP_DST = Join-Path $PI_AGENT 'mcp-adapter.json'
switch (Update-CoopManagedMcpConfig -OutputPath $MCP_DST) {
  'ok' { Coop-Ok "generated manifest-pinned MCP config -> $MCP_DST" }
  'no_python' { Coop-Warn 'python missing — cannot generate MCP config' }
  default { Coop-Warn 'could not generate MCP config — run: coop onboard --edit, then coop sync' }
}

# --- 5b. Team knowledge (optional; fail-soft — never blocks sync) -------------
if (Test-CoopKnowledgeEnabled) {
  Coop-Head 'Team knowledge'
  & (Join-Path $script:CoopRoot 'scripts\sync-knowledge.ps1')
}

# --- 5b2. TeamAI trial (K1; optional; explicit and bounded; fail-soft) -------
# Only when knowledge.teamai.enabled: converge the pinned teamai-cli into the
# isolated prefix and, once initialized, pull the team repo. Launch never does this.
$teamaiPy = Get-CoopPython
if ($teamaiPy) {
  $teamaiAdapter = Join-Path $script:CoopRoot 'lib\teamai.py'
  $teamaiStatus = $null
  try { $teamaiStatus = [string](& $teamaiPy $teamaiAdapter status 2>$null | Out-String) | ConvertFrom-Json } catch { $teamaiStatus = $null }
  if ($teamaiStatus -and $teamaiStatus.enabled) {
    Coop-Head 'TeamAI shared knowledge (trial)'
    foreach ($op in @('install', 'pull')) {
      $doc = $null
      try { $doc = [string](& $teamaiPy $teamaiAdapter $op 2>$null | Out-String) | ConvertFrom-Json } catch { $doc = $null }
      if (-not $doc) { Coop-Warn "teamai $op`: adapter gave no result" 'run: coop teamai status'; break }
      $detail = if ($doc.detail) { $doc.detail } elseif ($doc.warnings -and $doc.warnings.Count -gt 0) { [string]$doc.warnings[0] } else { '' }
      $suffix = if ($detail) { " ($detail)" } else { '' }
      # A `break` inside `switch` only leaves the switch, so a flag stops the loop.
      $stopOps = $true
      switch ([string]$doc.state) {
        'ok'              { Coop-Ok "teamai $op`: ok$suffix"; $stopOps = $false }
        'not_initialized' { Coop-Info ("teamai $op`: not initialized" + $(if ($detail) { $suffix } else { ' (run: coop teamai init)' })) }
        default           { Coop-Warn "teamai $op`: $($doc.state)$suffix" 'the trial stays fail-soft; run: coop teamai status' }
      }
      if ($stopOps) { break }
    }
  }
}

# --- 5c. Canonical standards (forced, bounded, fail-soft) ---------------------
if (Test-Have 'node') {
  $standardsCli = Join-Path $script:CoopRoot 'lib\standards-cli.mjs'
  try {
    $standardsSync = (& node $standardsCli refresh --force 2>$null) -join ''
    Coop-Info "canonical standards: $standardsSync"
  } catch { Coop-Warn 'canonical standards refresh unavailable; LKG preserved' }
}

# --- 5d. Official Microsoft skills catalog (fail-soft; launch uses LKG only) --
$mcpPy = Get-CoopPython
if ($mcpPy) {
  & $mcpPy (Join-Path $script:CoopRoot 'lib\microsoft_skills.py') refresh *> $null
  if ($LASTEXITCODE -eq 0) { Coop-Ok 'Microsoft skills catalog refreshed' }
  else { Coop-Warn 'Microsoft skills catalog refresh unavailable; launch will use last-known-good if present' }
} else {
  Coop-Warn 'python missing — cannot refresh Microsoft skills catalog'
}

# --- 6. Brand assets ---------------------------------------------------------
Coop-Head 'Brand assets'
if (Test-Path -LiteralPath (Join-Path $script:CoopRoot 'extensions\coop-powerline\assets\splash.ansi') -PathType Leaf) { Coop-Ok 'splash present' } else { Coop-Warn 'splash.ansi missing (regenerate from the logo)' }
if (Test-Path -LiteralPath (Join-Path $script:CoopRoot 'themes\cooptimize.json') -PathType Leaf) { Coop-Ok 'theme present' } else { Coop-Warn 'themes/cooptimize.json missing' }
$vibesDir = Join-Path $script:CoopRoot 'vibes'
$vibeCount = 0
if (Test-Path -LiteralPath $vibesDir -PathType Container) {
  $vibeCount = @(Get-ChildItem -LiteralPath $vibesDir -Filter '*.txt' -File -Recurse -ErrorAction SilentlyContinue).Count
}
if ($vibeCount -gt 0) { Coop-Ok "$vibeCount vibe file(s) present" } else { Coop-Warn 'no vibe files found in vibes/' }

# A successful install command is not success: any postcondition failure above
# must surface as a non-zero result so callers (launch preflight, CI, humans)
# never mistake a half-provisioned tree for a converged one.
if ($script:SyncFailures -gt 0) {
  Coop-Warn "sync finished WITH $($script:SyncFailures) failure(s) — see above" 're-run: coop sync'
  exit 1
}

# Report the configured canonical source plus independent optional sources and
# retain verified local fallbacks on any refresh failure.
if (Test-Have 'node') {
  $standardsCli = Join-Path $env:COOP_ROOT 'lib\standards-cli.mjs'
  foreach ($line in (& node $standardsCli doctor-lines '' $PWD.Path 2>$null)) {
    $parts = $line -split "`t", 4
    if ($parts.Count -ge 3 -and $parts[0] -eq 'source') {
      $suffix = if ($parts.Count -gt 3 -and $parts[3]) { " @ $($parts[3])" } else { '' }
      Coop-Info "standards source $($parts[1]): $($parts[2])$suffix"
    }
  }
}

Coop-Ok 'sync complete.'
# Explicit success code so `coop sync` / the launch preflight's child call don't
# inherit an incidental non-zero $LASTEXITCODE from the last native call above.
exit 0

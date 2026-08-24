#!/usr/bin/env pwsh
#
# coop sync (Windows / PowerShell mirror of scripts/sync.sh) —
# provision coop's ISOLATED Pi agent dir (~/.coop/agent) + brand assets (non-destructive):
#   • create the isolated dir; share auth/models from your personal pi (login)
#   • install coop's core Pi extensions INTO that dir (MCP / memory / better-openai)
#   • place the read-only MCP config into the isolated dir if absent (never clobbers)
#   • verify splash / theme / vibes are present
#
$ErrorActionPreference = 'Continue'

# --- Shared helpers: dot-source lib/common.ps1 (the twin of lib/common.sh) ----
# Resolves COOP_ROOT/COOP_VERSION and defines the loggers, Test-Have,
# Get-CoopPython, Get-CoopPiVersion, Get-CoopPiAgentDir, and Sync-CoopExtDeps
# (the shared pi-ai/pi-tui aligner — moved into the shared lib so `coop sync` and
# the launch preflight both call the SAME targeted helper; see lib/common.sh's
# coop_align_ext_deps twin and AGENTS.md rule 1).
. (Join-Path $PSScriptRoot '../lib/common.ps1')

# coop renders its own footer/splash — no third-party powerline footer.
$CORE_EXTENSIONS = @('pi-mcp-adapter', 'pi-hermes-memory', 'pi-better-openai', 'pi-web-access', '@juicesharp/rpiv-ask-user-question', 'context-mode')
$PI_AGENT = Get-CoopPiAgentDir
$GLOBAL_AGENT = Join-Path $HOME '.pi\agent'

Coop-Head "coop sync (v$($script:CoopVersion))"

# --- 1. Launchers (the .ps1/.cmd shims are inherently executable on Windows) --
Coop-Ok 'bin/coop launchers and scripts are runnable'

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

# --- 3. Core Pi extensions — installed INTO the isolated dir (idempotent) -----
# `pi install` exiting 0 proves nothing on its own: every extension is verified
# against the manifest pin AFTER production exact-pin convergence; any failure
# makes sync exit non-zero.
$script:SyncFailures = 0
$fleetSpecs = @(); $fleetNames = @(); $fleetPins = @(); $preVers = @{}

# PI_CODING_AGENT_DIR scoping: every Pi operation must target the ISOLATED dir,
# never the caller's personal ~/.pi. Save and restore any prior value.
$priorAgentDir = $env:PI_CODING_AGENT_DIR
$env:PI_CODING_AGENT_DIR = $PI_AGENT

try {
  Coop-Info "Coop keeps its extensions in $PI_AGENT and pins the versions tested"
  Coop-Info "together with this Coop release. Your personal Pi extensions are unchanged."
  if (Test-Have 'pi') {
  foreach ($ext in $CORE_EXTENSIONS) {
    $extSpec = Coop-ManifestExtensionSpec $ext
    if (-not $extSpec) { Coop-Warn "manifest pin missing for $ext"; $script:SyncFailures++; continue }
    $i = $extSpec.LastIndexOf('@')
    $fleetSpecs += $extSpec.Substring(5)
    $fleetNames += $ext
    $pin = $extSpec.Substring($i + 1)
    $fleetPins += $pin
    $preVers[$ext] = Get-CoopExtInstalledVersion -AgentDir $PI_AGENT -Name $ext
    Coop-Info "Ensuring isolated $ext is version ${pin}…"
    & pi install $extSpec > $null 2>&1
    if ($LASTEXITCODE -ne 0) { Coop-Warn "could not install $ext (pin $pin)"; $script:SyncFailures++ }
  }

  }

  # Order matters: exact extension pins FIRST, then shared-library alignment —
  # the alignment's npm install is the LAST resolution, so its overrides are
  # what ships and no later reinstall can recreate the startup skew.
  if ($fleetSpecs.Count -gt 0) {
    if (-not (Sync-CoopExtensionPins -AgentDir $PI_AGENT -Specs $fleetSpecs)) {
      Coop-Warn "could not enforce exact extension pins in $PI_AGENT\npm" 'run: coop sync'
      $script:SyncFailures++
    }
  }

  $piRuntime = Get-CoopPiVersion
  if ($piRuntime) { Coop-Info "Aligning shared Pi libraries with the installed Pi runtime ${piRuntime}…" }
  Sync-CoopExtDeps -AgentDir $PI_AGENT

  # Postconditions: fleet at manifest versions AND shared libs satisfying the
  # ACTIVE runtime's own metadata, verified after all installs.
  for ($k = 0; $k -lt $fleetNames.Count; $k++) {
    $ext = $fleetNames[$k]; $extPin = $fleetPins[$k]; $pre = $preVers[$ext]
    $postVer = Get-CoopExtInstalledVersion -AgentDir $PI_AGENT -Name $ext
    if (-not $postVer) {
      Coop-Warn "postcondition failed: pi install reported success, but $ext is MISSING from the isolated tree (wanted $extPin)" 'run: coop sync'
      $script:SyncFailures++
      continue
    }
    if ($postVer -ne $extPin) {
      Coop-Warn "postcondition failed: pi install reported success, but $ext is version $postVer, not the pinned $extPin" 'run: coop sync'
      $script:SyncFailures++
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
      & $py (Join-Path $script:CoopRoot 'lib\_extdeps.py') align $PI_AGENT $piRuntime --check *> $null
      $alignRc = $LASTEXITCODE
      if ($alignRc -eq 10) {
        Coop-Err "shared-library skew remains after alignment (wanted pi-ai/pi-tui for pi $piRuntime)"
        $script:SyncFailures++
      } elseif ($alignRc -eq 11) {
        Coop-Err "an installed extension needs newer pi-ai libraries than pi $piRuntime provides" 'update Pi: npm install -g @earendil-works/pi-coding-agent@latest, then: coop sync'
        $script:SyncFailures++
      }
    }
  }
} finally {
  if ($null -ne $priorAgentDir) { $env:PI_CODING_AGENT_DIR = $priorAgentDir }
}

# Missing runtime: NO fleet convergence happened at all — a failure, not a
# warning, per the convergence contract.
if (-not (Test-Have 'pi')) {
  Coop-Err 'pi is not installed — no extensions were converged or verified' 'install Pi first: coop install'
  $script:SyncFailures++
}

# --- 4. MCP config — manifest-pinned, ownership-aware, non-destructive --------
$MCP_DST = Join-Path $PI_AGENT 'mcp.json'
$mcpPy = Get-CoopPython
if ($mcpPy) {
  & $mcpPy (Join-Path $script:CoopRoot 'lib\mcp_config.py') --output $MCP_DST
  if ($LASTEXITCODE -eq 0) { Coop-Ok "generated manifest-pinned MCP config -> $MCP_DST" }
  else { Coop-Warn 'could not generate MCP config — run: coop onboard --edit, then coop sync' }
} else {
  Coop-Warn 'python missing — cannot generate MCP config'
}

# --- 5. Brand assets ---------------------------------------------------------
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

Coop-Ok 'sync complete.'
# Explicit success code so `coop sync` / the launch preflight's child call don't
# inherit an incidental non-zero $LASTEXITCODE from the last native call above.
exit 0

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
$CORE_EXTENSIONS = @('pi-mcp-adapter', 'pi-hermes-memory', 'pi-better-openai', 'pi-web-access', '@juicesharp/rpiv-ask-user-question')
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
$env:PI_CODING_AGENT_DIR = $PI_AGENT
if (Test-Have 'pi') {
  $pilist = (& pi list 2>$null | Out-String)
  foreach ($ext in $CORE_EXTENSIONS) {
    if ($pilist -match [regex]::Escape($ext)) {
      Coop-Ok "$ext present (isolated)"
    } else {
      Coop-Info "installing $ext into coop's dir…"
      & pi install "npm:$ext" > $null 2>&1
      if ($LASTEXITCODE -eq 0) { Coop-Ok "$ext installed" } else { Coop-Warn "could not install $ext" }
    }
  }
  # Share one pi-ai/pi-tui with the agent (else pi-web-access's 0.80 `/compat`
  # import breaks against pi-mcp-adapter's hoisted 0.74.x). Idempotent.
  Sync-CoopExtDeps -AgentDir $PI_AGENT
} else {
  Coop-Warn 'pi not installed — skipping extension sync (run: coop install)'
}

# --- 4. MCP config (read-only) into the isolated dir — non-destructive --------
$MCP_SRC = Join-Path $script:CoopRoot 'config\mcp.example.json'
$MCP_DST = Join-Path $PI_AGENT 'mcp.json'
if (Test-Path -LiteralPath $MCP_SRC -PathType Leaf) {
  if (Test-Path -LiteralPath $MCP_DST -PathType Leaf) {
    Coop-Ok "MCP config already exists: $MCP_DST"
    # Non-destructively ADD any servers new in the example but missing here (the plain
    # copy below only runs on a fresh install, so updates would otherwise never pick up
    # newly-shipped MCP servers). Existing entries — and their tenant ids — are untouched.
    $mcpPy = Get-CoopPython
    $mcpMerge = Join-Path $script:CoopRoot 'lib/_mcpmerge.py'
    if ($mcpPy -and (Test-Path -LiteralPath $mcpMerge -PathType Leaf)) {
      $mcpAdded = (& $mcpPy $mcpMerge $MCP_SRC $MCP_DST 2>$null)
      if ($mcpAdded) {
        Coop-Ok "added missing MCP server(s): $((@($mcpAdded) | Where-Object { $_ }) -join ' ')"
        Coop-Warn "New MCP server(s) may carry TODO org/tenant placeholders — edit $MCP_DST."
      }
    }
  } else {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $MCP_DST) | Out-Null
    Copy-Item -LiteralPath $MCP_SRC -Destination $MCP_DST
    if (Test-Path -LiteralPath $MCP_DST -PathType Leaf) {
      Coop-Ok "wrote read-only MCP config -> $MCP_DST"
      Coop-Warn "Edit $MCP_DST and set your tenant id where marked TODO."
    }
  }
} else {
  Coop-Warn 'config/mcp.example.json missing — cannot sync MCP servers'
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

Coop-Ok 'sync complete.'
# Explicit success code (sync is best-effort) so `coop sync` / the launch preflight's
# child call don't inherit an incidental non-zero $LASTEXITCODE from the last native
# call above — mirrors sync.sh ending on a clean exit 0.
exit 0

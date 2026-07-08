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
function Coop-Head { param([string]$m) [Console]::Error.WriteLine("`n$($script:C_BOLD)$($script:C_NAVY)$m$($script:C_RST)") }
function Test-Have { param([string]$Name) [bool](Get-Command $Name -ErrorAction SilentlyContinue) }
function Get-CoopPython { if (Test-Have 'python3') { 'python3' } elseif (Test-Have 'python') { 'python' } else { $null } }

# The Pi agent's own semver, e.g. '0.80.2' (from `pi --version`). '' if unknown.
function Get-CoopPiVersion {
  if (-not (Test-Have 'pi')) { return '' }
  $raw = (& pi --version 2>$null | Select-Object -First 1)
  $m = [regex]::Match([string]$raw, '\d+\.\d+\.\d+')
  if ($m.Success) { return $m.Value } else { return '' }
}

# Align coop's ISOLATED extension tree's @earendil-works/pi-ai + pi-tui to the Pi
# agent's OWN version (mirror of lib/common.sh coop_align_ext_deps). coop's
# extensions load INTO the running agent, so they must share one pi-ai/pi-tui with
# it; we write an npm `overrides` pin via lib/_extdeps.py and reinstall only when
# the installed tree doesn't already match. Best-effort; never fatal.
function Sync-CoopExtDeps {
  param([string]$AgentDir)
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

# coop renders its own footer/splash — no third-party powerline footer.
$CORE_EXTENSIONS = @('pi-mcp-adapter', 'pi-hermes-memory', 'pi-better-openai', 'pi-web-access', '@juicesharp/rpiv-ask-user-question')
function Get-CoopPiAgentDir { if ($env:COOP_AGENT_DIR) { $env:COOP_AGENT_DIR } else { Join-Path $HOME '.coop\agent' } }
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

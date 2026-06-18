#!/usr/bin/env pwsh
#
# coop sync (Windows / PowerShell mirror of scripts/sync.sh) —
# refresh Cooptimize brand assets and runtime wiring (non-destructive):
#   • ensure the core Pi extensions are installed (MCP / memory / powerline)
#   • place the read-only MCP config (fabric / powerbi / microsoft-learn / context-mode)
#     into ~/.config/mcp/mcp.json IF you don't already have one (never clobbers)
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

# coop renders its own footer/splash — no third-party powerline footer.
$CORE_EXTENSIONS = @('pi-mcp-adapter', 'pi-hermes-memory', 'pi-better-openai')
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
    Copy-Item -LiteralPath $src -Destination $dst
    Coop-Ok "shared $f from your personal pi (login/models)"
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
} else {
  Coop-Warn 'pi not installed — skipping extension sync (run: coop install)'
}

# --- 4. MCP config (read-only) into the isolated dir — non-destructive --------
$MCP_SRC = Join-Path $script:CoopRoot 'config\mcp.example.json'
$MCP_DST = Join-Path $PI_AGENT 'mcp.json'
if (Test-Path -LiteralPath $MCP_SRC -PathType Leaf) {
  if (Test-Path -LiteralPath $MCP_DST -PathType Leaf) {
    Coop-Ok "MCP config already exists: $MCP_DST"
    $dstText = (Get-Content -LiteralPath $MCP_DST -Raw -ErrorAction SilentlyContinue)
    if ($dstText -notmatch '(?i)learn\.microsoft\.com|microsoft-learn') {
      Coop-Warn 'Microsoft Learn MCP not in your config.'
      Coop-Say  "      Merge the 'microsoft-learn' server from: $MCP_SRC"
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

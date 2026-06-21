#!/usr/bin/env pwsh
#
# coop install / bootstrap (Windows / PowerShell mirror of scripts/install.sh) —
# set up the whole Cooptimize stack on a fresh machine. Idempotent: safe to re-run.
# Non-fatal where it can be (warns and keeps going), so `coop doctor` can report
# whatever is still missing at the end.
#
#   Flags:
#     --force        Reinstall pi tools / pipx packages even if already present
#     --no-fabric    Skip installing the Microsoft Fabric CLI (ms-fabric-cli)
#     --yes, -y      Assume yes for prompts
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
# abort this bootstrap — mirrors bash invoking "$COOP_ROOT/scripts/x.sh" as a
# subprocess. Returns the child's exit code.
function Invoke-CoopScript {
  param([string]$ScriptPath, [string[]]$ScriptArgs = @())
  $psExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
  & $psExe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @ScriptArgs
  return $LASTEXITCODE
}

# --- Parse flags -------------------------------------------------------------
$FORCE = $false; $NO_FABRIC = $false
foreach ($a in $args) {
  switch -CaseSensitive ($a) {
    '--force'     { $FORCE = $true }
    '--no-fabric' { $NO_FABRIC = $true }
    '--yes'       { $env:COOP_ASSUME_YES = '1' }
    '-y'          { $env:COOP_ASSUME_YES = '1' }
    default       { Coop-Warn "install: ignoring unknown flag '$a'" }
  }
}

# --- What we install (keep in sync with config/defaults.yml) ------------------
# coop renders its OWN footer/splash via extensions/coop-powerline — no third-party
# powerline footer.
$PI_NPM_PACKAGE = '@earendil-works/pi-coding-agent'
$PI_EXTENSIONS = @(
  'npm:pi-mcp-adapter',       # MCP servers (Fabric / Power BI / Microsoft Learn / context-mode)
  'npm:pi-hermes-memory',     # persistent memory + session search + secret scanning
  'npm:pi-better-openai'      # plan usage limits (5h/7d) — shown in coop's footer
)
$PY_TOOLS = @('coop-data-doc', 'coop-sql-review', 'coop-dax-review')
$FABRIC_PKG = 'ms-fabric-cli'

# Install/operate against coop's ISOLATED Pi agent dir (mirror of coop_pi_agent_dir).
function Get-CoopPiAgentDir { if ($env:COOP_AGENT_DIR) { $env:COOP_AGENT_DIR } else { Join-Path $HOME '.coop\agent' } }
$env:PI_CODING_AGENT_DIR = Get-CoopPiAgentDir
New-Item -ItemType Directory -Force -Path $env:PI_CODING_AGENT_DIR | Out-Null

$OS = 'Windows'

Coop-Head "Cooptimize agent bootstrap (v$($script:CoopVersion))  [$OS]"

# --- 1. Prerequisites (warn-and-continue; these usually need a package manager)
Coop-Head '1/7  Prerequisites'
if (-not (Test-Have 'git'))     { Coop-Warn "git not found — install Git from https://git-scm.com (or 'winget install Git.Git')." }
if (-not (Test-Have 'python3') -and -not (Test-Have 'python')) { Coop-Warn "python3 not found — install Python 3.10+ from https://python.org (or 'winget install Python.Python.3.12')." }
if (-not (Test-Have 'node'))    { Coop-Warn "node not found — install Node.js 22.19+ from https://nodejs.org (needed to install/update pi)." }

# pipx: we can usually install this ourselves.
if (-not (Test-Have 'pipx')) {
  $pyBin = if (Test-Have 'python3') { 'python3' } elseif (Test-Have 'python') { 'python' } else { $null }
  if ($pyBin) {
    Coop-Info "Installing pipx ($pyBin -m pip install --user pipx)…"
    & $pyBin -m pip install --user pipx > $null 2>&1
    $ok1 = ($LASTEXITCODE -eq 0)
    & $pyBin -m pipx ensurepath > $null 2>&1
    $ok2 = ($LASTEXITCODE -eq 0)
    if ($ok1 -and $ok2) { Coop-Ok 'pipx installed (you may need to open a new shell for PATH changes)' }
    else { Coop-Warn 'could not install pipx automatically — see https://pipx.pypa.io' }
  } else {
    Coop-Warn 'skipping pipx (python3 missing)'
  }
} else {
  Coop-Ok 'pipx present'
}

# --- 2. Pi itself ------------------------------------------------------------
Coop-Head '2/7  Pi (@earendil-works/pi-coding-agent)'
if ((Test-Have 'pi') -and -not $FORCE) {
  $pv = (& pi --version 2>$null); if (-not $pv) { $pv = '?' }
  Coop-Ok "pi present ($pv)"
} elseif (Test-Have 'npm') {
  Coop-Info 'Installing pi globally via npm…'
  & npm install -g $PI_NPM_PACKAGE > $null 2>&1
  if ($LASTEXITCODE -eq 0) { Coop-Ok 'pi installed' } else { Coop-Warn "npm install of pi failed — try: npm install -g $PI_NPM_PACKAGE" }
} else {
  Coop-Warn "cannot install pi (npm missing). Install Node.js, then re-run 'coop install'."
}

# --- 3. Pi extensions (branded powerline footer) -----------------------------
Coop-Head '3/7  Pi extensions'
if (Test-Have 'pi') {
  foreach ($ext in $PI_EXTENSIONS) {
    Coop-Info "pi install $ext"
    & pi install $ext > $null 2>&1
    if ($LASTEXITCODE -eq 0) { Coop-Ok "$ext" } else { Coop-Warn "could not install $ext (continuing)" }
  }
} else {
  Coop-Warn 'skipping extensions (pi not installed)'
}

# --- 4. Microsoft Fabric CLI -------------------------------------------------
Coop-Head '4/7  Microsoft Fabric CLI (fab)'
if ($NO_FABRIC) {
  Coop-Warn 'skipped (--no-fabric)'
} elseif (Test-Have 'pipx') {
  if ($FORCE) {
    & pipx install --force $FABRIC_PKG > $null 2>&1
  } else {
    & pipx install $FABRIC_PKG > $null 2>&1
    if ($LASTEXITCODE -ne 0) { & pipx upgrade $FABRIC_PKG > $null 2>&1 }
  }
  # fabric-cicd is a Python LIBRARY (no CLI) — inject it into the Fabric CLI env.
  & pipx inject $FABRIC_PKG fabric-cicd > $null 2>&1
  if ($LASTEXITCODE -eq 0) { Coop-Ok 'fabric-cicd (library) added to the Fabric CLI env' } else { Coop-Warn 'could not add fabric-cicd (optional)' }
  if (Test-Have 'fab') {
    $fabver = ((& fab --version 2>&1) -join ' ')
    if ($fabver -match '(?i)paramiko|invoke') {
      Coop-Warn "'fab' resolves to Python Fabric (SSH), not the Microsoft Fabric CLI."
      Coop-Say  "      Ensure the pipx Scripts dir precedes any other 'fab' on PATH (or remove the conflicting one). Then re-check: fab --version"
    } else {
      $fv = (& fab --version 2>$null | Select-Object -First 1)
      Coop-Ok "Microsoft Fabric CLI ready ($fv)"
    }
  } else {
    Coop-Warn "ms-fabric-cli installed but 'fab' not on PATH yet — open a new shell (pipx ensurepath)."
  }
} else {
  Coop-Warn 'skipping Fabric CLI (pipx missing)'
}

# --- 5. Standalone Coop tools ------------------------------------------------
Coop-Head '5/7  Coop tools (coop-data-doc / coop-sql-review / coop-dax-review)'
if (Test-Have 'pipx') {
  foreach ($pkg in $PY_TOOLS) {
    if ($FORCE) {
      & pipx install --force $pkg > $null 2>&1
      if ($LASTEXITCODE -eq 0) { Coop-Ok "$pkg" } else { Coop-Warn "failed: $pkg" }
    } else {
      & pipx install $pkg > $null 2>&1
      if ($LASTEXITCODE -eq 0) {
        Coop-Ok "$pkg (installed)"
      } else {
        & pipx upgrade $pkg > $null 2>&1
        if ($LASTEXITCODE -eq 0) { Coop-Ok "$pkg (up to date)" } else { Coop-Warn "could not install $pkg" }
      }
    }
  }
} else {
  Coop-Warn 'skipping Coop tools (pipx missing)'
}

# --- 6. Put `coop` on PATH ---------------------------------------------------
Coop-Head "6/7  Link 'coop' onto your PATH"
$LOCALBIN = Join-Path $env:LOCALAPPDATA 'coop\bin'
New-Item -ItemType Directory -Force -Path $LOCALBIN | Out-Null
# Drop a launcher .cmd that forwards to the repo's coop.cmd shim, so `coop` works
# anywhere once $LOCALBIN is on PATH.
$shimTarget = Join-Path $script:CoopRoot 'bin\coop.cmd'
$launcher = Join-Path $LOCALBIN 'coop.cmd'
$launcherBody = "@echo off`r`ncall `"$shimTarget`" %*`r`n"
$existing = if (Test-Path -LiteralPath $launcher -PathType Leaf) { Get-Content -LiteralPath $launcher -Raw } else { '' }
if ($existing -ne $launcherBody) {
  Set-Content -LiteralPath $launcher -Value $launcherBody -NoNewline -Encoding ASCII
  Coop-Ok "linked $launcher -> bin\coop.cmd"
} else {
  Coop-Ok 'coop already linked'
}
$pathEntries = ($env:PATH -split ';')
if ($pathEntries -notcontains $LOCALBIN) {
  Coop-Warn "$LOCALBIN is not on your PATH. Add it (User PATH), e.g.:  setx PATH `"%PATH%;$LOCALBIN`""
}

# --- 7. Sync brand assets + doctor ------------------------------------------
Coop-Head '7/7  Sync assets and run doctor'
$syncRc = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\sync.ps1')
if ($syncRc -ne 0) { Coop-Warn 'sync reported issues' }
[Console]::Error.WriteLine('')
$null = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\doctor.ps1')

[Console]::Error.WriteLine('')
Coop-Ok 'Bootstrap complete. Start the agent with:  coop'

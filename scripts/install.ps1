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

# --- Progress: one determinate "overall" bar + an animated active-item line ---
# Mirror of lib/common.sh. The bar is determinate at the ITEM level (we know the
# total up front); the active item shows a braille spinner + elapsed seconds so it
# is obviously alive. Animates only when stderr is a real console; otherwise the
# loggers fall through to plain lines (Coop-Emit) and units print "• starting…".
$script:ProgActive   = $false
$script:ProgTotal    = 0
$script:ProgDone     = 0
$script:ProgW        = 22
$script:ProgCols     = 80
$script:ProgSpinline = ''
$script:SpinFrames   = @(
  [char]0x280B, [char]0x2819, [char]0x2839, [char]0x2838, [char]0x283C,
  [char]0x2834, [char]0x2826, [char]0x2827, [char]0x2807, [char]0x280F
)
$script:UseThreadJob = [bool](Get-Command Start-ThreadJob -ErrorAction SilentlyContinue)

function Test-ProgTty { $script:CoopColor }   # already folds in -not IsErrorRedirected

function Coop-ProgBar {
  $total = if ($script:ProgTotal -gt 0) { $script:ProgTotal } else { 1 }
  $done  = [Math]::Min([int]$script:ProgDone, [int]$total)
  $w     = $script:ProgW
  $fill  = [int][Math]::Floor($done * $w / $total)
  $pct   = [int][Math]::Floor($done * 100 / $total)
  $on    = ([string][char]0x2588) * $fill
  $off   = ([string][char]0x2591) * ($w - $fill)
  "  [$($script:C_LIME)$on$($script:C_DIM)$off$($script:C_RST)] $done/$total  $pct%"
}

function Coop-ProgSpin {
  param([string]$Glyph, [string]$Label, [int]$Elapsed)
  $max = $script:ProgCols - 14
  if ($max -lt 8)  { $max = 8 }
  if ($max -gt 48) { $max = 48 }
  if ($Label.Length -gt $max) { $Label = $Label.Substring(0, $max - 1) + [char]0x2026 }
  "  $($script:C_LIME)$Glyph$($script:C_RST) $Label $($script:C_DIM)(${Elapsed}s)$($script:C_RST)"
}

# Draw the 2-line region (bar + active item), parking the cursor back at the start
# of the bar line. Relative moves only, so scrolling at the bottom edge stays sane.
function Coop-ProgDraw {
  if (-not (Test-ProgTty)) { return }
  $x = [char]27
  [Console]::Error.Write("`r$x[2K" + (Coop-ProgBar) + "`n")
  [Console]::Error.Write("$x[2K" + $script:ProgSpinline)
  [Console]::Error.Write("$x[1A`r")
}

# Erase the 2-line region, leaving the cursor at the (now empty) bar line, col 0.
function Coop-ProgLift {
  if (-not (Test-ProgTty)) { return }
  $x = [char]27
  [Console]::Error.Write("`r$x[2K")
  [Console]::Error.Write("`n$x[2K")
  [Console]::Error.Write("$x[1A`r")
}

function Coop-ProgBegin {
  param([int]$Total)
  $script:ProgTotal = $Total; $script:ProgDone = 0; $script:ProgSpinline = ''; $script:ProgActive = $true
  try { $script:ProgCols = [Console]::WindowWidth } catch { $script:ProgCols = 80 }
  if ($script:ProgCols -lt 1) { $script:ProgCols = 80 }
  if (Test-ProgTty) { [Console]::Error.Write("$([char]27)[?25l"); Coop-ProgDraw }   # hide cursor, draw 0%
}

function Coop-ProgEnd {
  if ($script:ProgActive -and (Test-ProgTty)) {
    Coop-ProgLift
    $script:ProgSpinline = ''
    [Console]::Error.WriteLine((Coop-ProgBar))            # leave a permanent completed bar
    [Console]::Error.Write("$([char]27)[?25h")            # restore cursor
  }
  $script:ProgActive = $false
}

# --- Logging (progress-aware: lift the pinned bar, print above it, redraw) -----
function Coop-Emit {
  param([string]$Line)
  if ($script:ProgActive -and (Test-ProgTty)) {
    Coop-ProgLift
    [Console]::Error.WriteLine($Line)
    Coop-ProgDraw
  } else {
    [Console]::Error.WriteLine($Line)
  }
}
function Coop-Say  { param([string]$m) Coop-Emit $m }
function Coop-Info { param([string]$m) Coop-Emit "$($script:C_LIME)$($script:G_BULLET)$($script:C_RST) $m" }
function Coop-Ok   { param([string]$m) Coop-Emit "$($script:C_FOREST)$($script:G_CHECK)$($script:C_RST) $m" }
function Coop-Warn { param([string]$m) Coop-Emit "$($script:C_OLIVE)!$($script:C_RST) $m" }
function Coop-Err  { param([string]$m) Coop-Emit "$($script:C_RED)$($script:G_CROSS)$($script:C_RST) $m" }
function Coop-Head { param([string]$m) Coop-Emit "`n$($script:C_BOLD)$($script:C_NAVY)$m$($script:C_RST)" }
function Test-Have { param([string]$Name) [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

# A python that ACTUALLY runs — not a Windows Store App-Execution-Alias stub. Those
# stubs live under ...\WindowsApps\ and exist on stock Win10/11 with no Python, so
# Get-Command succeeds while `--version` prints nothing. Returns the name, or $null.
function Get-CoopRealPython {
  foreach ($name in @('python3', 'python')) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $c) { continue }
    if ($c.Source -and $c.Source -match '\\WindowsApps\\') { continue }
    $v = (& $name --version 2>&1)
    if ($v -match '\d+\.\d+') { return $name }
  }
  return $null
}

function Start-CoopJob {
  param([scriptblock]$Sb, [object[]]$JobArgs)
  if ($script:UseThreadJob) { Start-ThreadJob -ScriptBlock $Sb -ArgumentList $JobArgs }
  else                      { Start-Job       -ScriptBlock $Sb -ArgumentList $JobArgs }
}

# Coop-Unit <label> <scriptblock> [args]
#   Runs the scriptblock in a background job (it returns @{ok=<bool>; msg=<string>}).
#   While it runs, the active-item line animates under the overall bar; on completion
#   the bar advances by one and a permanent ✓/! line is printed.
function Coop-Unit {
  param([string]$Label, [scriptblock]$Work, [object[]]$WorkArgs = @())
  $sw  = [System.Diagnostics.Stopwatch]::StartNew()
  $job = Start-CoopJob $Work $WorkArgs
  if ((Test-ProgTty) -and $script:ProgActive) {
    $i = 0
    while ($job.State -eq 'Running') {
      $g = $script:SpinFrames[$i % $script:SpinFrames.Count]
      $script:ProgSpinline = (Coop-ProgSpin $g $Label ([int]$sw.Elapsed.TotalSeconds))
      Coop-ProgDraw
      $i++
      Start-Sleep -Milliseconds 120
    }
  } else {
    Coop-Info "$Label…"          # non-console: at least show the slow step started
  }
  # Wait for the job to FINISH before reading it. The TTY branch's poll loop already
  # blocks until completion; the non-TTY branch does not, so without this Receive-Job
  # could read an empty (still-running) result and falsely report failure. Mirrors the
  # `wait "$pid"` in bash coop_unit.
  $null = Wait-Job $job -ErrorAction SilentlyContinue
  $res = $null
  try { $res = Receive-Job $job -ErrorAction SilentlyContinue | Select-Object -Last 1 } catch {}
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  $ok = $false; $msg = $Label
  if ($null -ne $res) {
    if ($res.PSObject.Properties.Name -contains 'ok')  { $ok  = [bool]$res.ok }
    if ($res.PSObject.Properties.Name -contains 'msg') { $msg = [string]$res.msg }
  }
  $script:ProgDone++
  $script:ProgSpinline = ''
  if ($ok) { Coop-Ok $msg } else { Coop-Warn $msg }
}

# Make freshly-installed user/pipx/npm bins visible to the REST of this run (their
# dirs are usually not on PATH until a new shell — which is why a one-pass install
# would otherwise "skip" later steps). Best-effort; never fatal.
function Add-CoopUserPaths {
  # pipx creates ~\.local\bin only when it installs the FIRST tool (steps 4/5), so
  # it may not exist yet here — prepend it unconditionally (a not-yet-existing PATH
  # entry is harmless and goes live once the dir appears). The python user-base dirs
  # hold the pipx launcher itself (from `pip install --user pipx`).
  $pipxBin = (Join-Path $HOME '.local\bin')       # pipx default PIPX_BIN_DIR on Windows
  if (($env:PATH -split ';') -notcontains $pipxBin) { $env:PATH = "$pipxBin;$env:PATH" }
  $py = if (Test-Have 'python3') { 'python3' } elseif (Test-Have 'python') { 'python' } else { $null }
  if ($py) {
    $base = (& $py -m site --user-base 2>$null)
    if ($base) {
      foreach ($d in @((Join-Path $base 'Scripts'), (Join-Path $base 'bin'))) {
        if (($env:PATH -split ';') -notcontains $d) { $env:PATH = "$d;$env:PATH" }
      }
    }
  }
}
function Add-CoopNpmPath {
  if (-not (Test-Have 'npm')) { return }
  $prefix = (& npm prefix -g 2>$null)
  if ($prefix) {
    foreach ($d in @($prefix, (Join-Path $prefix 'bin'))) {   # win: shims in prefix; unix: prefix/bin
      if ((Test-Path -LiteralPath $d) -and (($env:PATH -split ';') -notcontains $d)) {
        $env:PATH = "$d;$env:PATH"
      }
    }
  }
}

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
    default       { if (-not [string]::IsNullOrWhiteSpace($a)) { Coop-Warn "install: ignoring unknown flag '$a'" } }
  }
}

# --- What we install (keep in sync with config/defaults.yml) ------------------
# coop renders its OWN footer/splash via extensions/coop-powerline — no third-party
# powerline footer.
$PI_NPM_PACKAGE = '@earendil-works/pi-coding-agent'
$PI_EXTENSIONS = @(
  'npm:pi-mcp-adapter',       # MCP servers (Fabric / Power BI / Microsoft Learn / context-mode)
  'npm:pi-hermes-memory',     # persistent memory + session search + secret scanning
  'npm:pi-better-openai',     # plan usage limits (5h/7d) — shown in coop's footer
  'npm:pi-web-access',        # web search / URL fetch / GitHub clone / PDF / video (read-only)
  'npm:@juicesharp/rpiv-ask-user-question'  # structured questions the model can ask (consent rounds)
)
$PY_TOOLS = @('coop-data-doc', 'coop-sql-review', 'coop-dax-review')
$FABRIC_PKG = 'ms-fabric-cli'

# Install/operate against coop's ISOLATED Pi agent dir (mirror of coop_pi_agent_dir).
function Get-CoopPiAgentDir { if ($env:COOP_AGENT_DIR) { $env:COOP_AGENT_DIR } else { Join-Path $HOME '.coop\agent' } }
$env:PI_CODING_AGENT_DIR = Get-CoopPiAgentDir
New-Item -ItemType Directory -Force -Path $env:PI_CODING_AGENT_DIR | Out-Null

$OS = 'Windows'

# Overall-bar denominator: the install ITEMS we attempt (pipx + pi + each extension
# + each coop tool, plus Fabric unless --no-fabric).
$TOTAL = 2 + $PI_EXTENSIONS.Count + $PY_TOOLS.Count
if (-not $NO_FABRIC) { $TOTAL += 1 }

# --- Per-item units (run in a background job; return @{ok=<bool>; msg=<string>}) --
$UnitPipx = {
  if (Get-Command pipx -ErrorAction SilentlyContinue) { return [pscustomobject]@{ ok = $true; msg = 'pipx present' } }
  # Skip a Windows Store App-Execution-Alias stub (under \WindowsApps\, no real python):
  # it makes Get-Command succeed but every pip call returns rc 9009. Self-contained
  # because this scriptblock runs in a background job without the script's functions.
  $py = $null
  foreach ($name in @('python3', 'python')) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if ($c -and ($c.Source -notmatch '\\WindowsApps\\')) {
      $vv = (& $name --version 2>&1)
      if ($vv -match '\d+\.\d+') { $py = $name; break }
    }
  }
  if (-not $py) { return [pscustomobject]@{ ok = $false; msg = 'skipping pipx (python missing)' } }
  & $py -m pip install --user pipx *> $null; $a = ($LASTEXITCODE -eq 0)
  & $py -m pipx ensurepath          *> $null; $b = ($LASTEXITCODE -eq 0)
  if ($a -and $b) { return [pscustomobject]@{ ok = $true; msg = 'pipx installed (open a new shell for PATH changes)' } }
  return [pscustomobject]@{ ok = $false; msg = 'could not install pipx automatically — see https://pipx.pypa.io' }
}

$UnitPi = {
  param([bool]$Force, [string]$Pkg)
  if ((Get-Command pi -ErrorAction SilentlyContinue) -and -not $Force) {
    $v = (& pi --version 2>$null); if (-not $v) { $v = '?' }
    return [pscustomobject]@{ ok = $true; msg = "pi present ($v)" }
  }
  if (Get-Command npm -ErrorAction SilentlyContinue) {
    & npm install -g $Pkg *> $null
    if ($LASTEXITCODE -eq 0) { return [pscustomobject]@{ ok = $true; msg = 'pi installed' } }
    return [pscustomobject]@{ ok = $false; msg = "npm install of pi failed — try: npm install -g $Pkg" }
  }
  return [pscustomobject]@{ ok = $false; msg = "cannot install pi (npm missing) — install Node.js, then re-run: coop install" }
}

$UnitExt = {
  param([string]$Ext)
  if (-not (Get-Command pi -ErrorAction SilentlyContinue)) { return [pscustomobject]@{ ok = $false; msg = "skipped $Ext (pi not installed)" } }
  & pi install $Ext *> $null
  if ($LASTEXITCODE -eq 0) { return [pscustomobject]@{ ok = $true; msg = $Ext } }
  return [pscustomobject]@{ ok = $false; msg = "could not install $Ext (continuing)" }
}

$UnitFabric = {
  param([bool]$Force, [string]$Pkg)
  if (-not (Get-Command pipx -ErrorAction SilentlyContinue)) { return [pscustomobject]@{ ok = $false; msg = 'skipping Fabric CLI (pipx missing)' } }
  if ($Force) { & pipx install --force $Pkg *> $null }
  else { & pipx install $Pkg *> $null; if ($LASTEXITCODE -ne 0) { & pipx upgrade $Pkg *> $null } }
  # fabric-cicd is a Python LIBRARY (no CLI) — inject it into the Fabric CLI env.
  # (doctor verifies it separately; we don't claim success here unless `fab` works.)
  & pipx inject $Pkg fabric-cicd *> $null
  if (Get-Command fab -ErrorAction SilentlyContinue) {
    $fv = ((& fab --version 2>&1) -join ' ')
    if ($fv -match '(?i)paramiko|invoke') {
      return [pscustomobject]@{ ok = $false; msg = "'fab' is Python Fabric (SSH), not Microsoft Fabric CLI — put the pipx Scripts dir first on PATH, then: fab --version" }
    }
    $v = (& fab --version 2>$null | Select-Object -First 1)
    return [pscustomobject]@{ ok = $true; msg = "Microsoft Fabric CLI ready ($v)" }
  }
  return [pscustomobject]@{ ok = $false; msg = "ms-fabric-cli installed but 'fab' not on PATH yet — open a new shell" }
}

$UnitPytool = {
  param([bool]$Force, [string]$Pkg)
  if (-not (Get-Command pipx -ErrorAction SilentlyContinue)) { return [pscustomobject]@{ ok = $false; msg = "skipping $Pkg (pipx missing)" } }
  if ($Force) {
    & pipx install --force $Pkg *> $null
    if ($LASTEXITCODE -eq 0) { return [pscustomobject]@{ ok = $true; msg = $Pkg } }
    return [pscustomobject]@{ ok = $false; msg = "failed: $Pkg" }
  }
  & pipx install $Pkg *> $null
  if ($LASTEXITCODE -eq 0) { return [pscustomobject]@{ ok = $true; msg = "$Pkg (installed)" } }
  & pipx upgrade $Pkg *> $null
  if ($LASTEXITCODE -eq 0) { return [pscustomobject]@{ ok = $true; msg = "$Pkg (up to date)" } }
  return [pscustomobject]@{ ok = $false; msg = "could not install $Pkg" }
}

Coop-Head "Cooptimize agent bootstrap (v$($script:CoopVersion))  [$OS]"

# Pin the overall bar to the bottom for the install phase; restore the cursor even
# on Ctrl-C / errors via finally. Begin is INSIDE the try so an interrupt between
# hiding the cursor and the first loop still reaches the finally.
try {
  Coop-ProgBegin $TOTAL
  # --- 1. Prerequisites ------------------------------------------------------
  Coop-Head '1/7  Prerequisites'
  if (-not (Test-Have 'git'))  { Coop-Warn "git not found — install Git from https://git-scm.com (or 'winget install Git.Git')." }
  if (-not (Get-CoopRealPython)) { Coop-Warn "python not found — install Python 3.10+ from https://python.org (or 'winget install Python.Python.3.12'). (A Windows Store 'python' stub does not count.)" }
  if (-not (Test-Have 'node')) { Coop-Warn "node not found — install Node.js 22.19+ from https://nodejs.org (needed to install/update pi)." }
  Coop-Unit 'pipx' $UnitPipx
  Add-CoopUserPaths    # make a just-installed pipx + its tool-bin visible this run

  # --- 2. Pi itself ----------------------------------------------------------
  Coop-Head '2/7  Pi (@earendil-works/pi-coding-agent)'
  Coop-Unit 'pi (@earendil-works/pi-coding-agent)' $UnitPi @($FORCE, $PI_NPM_PACKAGE)
  Add-CoopNpmPath      # make a just-npm-installed `pi` visible to step 3 this run

  # --- 3. Pi extensions ------------------------------------------------------
  Coop-Head '3/7  Pi extensions'
  foreach ($ext in $PI_EXTENSIONS) { Coop-Unit $ext $UnitExt @($ext) }

  # --- 4. Microsoft Fabric CLI ----------------------------------------------
  Coop-Head '4/7  Microsoft Fabric CLI (fab)'
  if ($NO_FABRIC) { Coop-Warn 'skipped (--no-fabric)' }
  else { Coop-Unit 'Microsoft Fabric CLI' $UnitFabric @($FORCE, $FABRIC_PKG) }

  # --- 5. Standalone Coop tools ----------------------------------------------
  Coop-Head '5/7  Coop tools (coop-data-doc / coop-sql-review / coop-dax-review)'
  foreach ($pkg in $PY_TOOLS) { Coop-Unit $pkg $UnitPytool @($FORCE, $pkg) }
}
finally {
  Coop-ProgEnd
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
if (($env:PATH -split ';') -notcontains $LOCALBIN) {
  # Add the launcher dir to the persistent USER PATH (idempotent) so coop works in every
  # shell — not just warn. Read/write the RAW user PATH via the registry as an
  # ExpandString, so any %VAR% tokens already in it stay dynamic ([Environment]::
  # SetEnvironmentVariable would expand and freeze them into REG_SZ). Also prepend it to
  # THIS process so the rest of the install + doctor can call coop now; new terminals
  # pick up the persistent change. NeedNewShell is set ONLY on success, so a failed
  # write doesn't produce a misleading "coop was just added to your PATH" at the end.
  try {
    $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    $userPath = if ($envKey) {
      [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    } else { '' }
    if (($userPath -split ';') -notcontains $LOCALBIN) {
      $newUserPath = (@($userPath, $LOCALBIN) | Where-Object { $_ }) -join ';'
      if ($envKey) { $envKey.SetValue('Path', $newUserPath, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
      # A raw registry SetValue does NOT notify anyone. Setting a User env var via
      # [Environment]::SetEnvironmentVariable DOES broadcast WM_SETTINGCHANGE, so open
      # terminals/Explorer refresh their environment and actually see the new PATH
      # (otherwise "open a new terminal" wouldn't help until a logoff). Set + clear a
      # throwaway var so we trigger the broadcast without leaving residue or touching PATH.
      [Environment]::SetEnvironmentVariable('COOP_PATH_SYNC', '1', 'User')
      [Environment]::SetEnvironmentVariable('COOP_PATH_SYNC', $null, 'User')
      Coop-Ok "added $LOCALBIN to your user PATH (open a new terminal so coop is found there)"
    }
    if ($envKey) { $envKey.Close() }
    $env:PATH = "$LOCALBIN;$env:PATH"
    $script:NeedNewShell = $true
  } catch {
    Coop-Warn "couldn't update PATH automatically — add $LOCALBIN to your user PATH (System Properties > Environment Variables), then open a new terminal."
  }
}

# --- Double-click launcher (Start Menu + Desktop shortcut) -------------------
# A friendly front door so members who aren't comfortable in a terminal can open
# coop by double-clicking an icon. PURELY ADDITIVE: `coop` in any terminal is
# unchanged. The shortcut points at bin\coop-desktop.ps1, which finds/installs
# coop, runs it, and keeps the window open on error. Best-effort — a failure here
# never fails the install (you can always run coop from a terminal).
$desktopLauncher = Join-Path $script:CoopRoot 'bin\coop-desktop.ps1'
if (Test-Path -LiteralPath $desktopLauncher) {
  try {
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $icon  = Join-Path $script:CoopRoot 'themes\coop.ico'
    $ws = New-Object -ComObject WScript.Shell
    # Two shortcuts, each on the Start Menu + Desktop:
    #   coop            -> the friendly chat window (`coop web`, ChatGPT-style; the
    #                      server console starts minimized so the chat is the star —
    #                      closing that minimized window stops coop)
    #   coop (terminal) -> the classic terminal agent, for people who prefer it
    $shortcuts = @(
      @{ Name = 'coop.lnk';            ExtraArgs = ' web'; Window = 7; Desc = 'coop - chat with the Cooptimize analytics agent' },
      @{ Name = 'coop (terminal).lnk'; ExtraArgs = '';     Window = 1; Desc = 'coop - the Cooptimize analytics agent (terminal)' }
    )
    foreach ($def in $shortcuts) {
      foreach ($dir in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
        $sc = $ws.CreateShortcut((Join-Path $dir $def.Name))
        $sc.TargetPath       = $psExe
        $sc.Arguments        = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$desktopLauncher`"$($def.ExtraArgs)"
        $sc.WorkingDirectory = $HOME
        $sc.Description       = $def.Desc
        $sc.WindowStyle       = $def.Window
        # ',0' = explicit icon index; some shells show a generic icon without it.
        if (Test-Path -LiteralPath $icon) { $sc.IconLocation = "$icon,0" }
        $sc.Save()
      }
    }
    Coop-Ok 'created double-click launchers (Start Menu + Desktop): "coop" (chat window) and "coop (terminal)"'
  } catch {
    Coop-Warn "couldn't create the double-click launcher (you can still run coop in a terminal): $($_.Exception.Message)"
  }
}

# --- 7. Sync brand assets + doctor ------------------------------------------
Coop-Head '7/7  Sync assets and run doctor'
$syncRc = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\sync.ps1')
if ($syncRc -ne 0) { Coop-Warn 'sync reported issues' }
[Console]::Error.WriteLine('')
# Propagate doctor's verdict as the install's exit code (mirror of install.sh): a
# genuinely broken install (a required dep still missing → doctor exits 1) is then
# detectable by whatever ran `coop install`, incl. the double-click launcher wrapper.
$doctorRc = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\doctor.ps1')

[Console]::Error.WriteLine('')
if ($script:NeedNewShell) {
  Coop-Ok 'Bootstrap complete. coop was just added to your PATH.'
  Coop-Say "      Open a NEW terminal, then run:  coop"
  Coop-Say "      (or use it right now in this window:  & `"$LOCALBIN\coop.cmd`")"
} else {
  Coop-Ok 'Bootstrap complete. Start the agent with:  coop'
}
exit $doctorRc

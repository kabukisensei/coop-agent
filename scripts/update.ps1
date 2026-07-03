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
# Mirror of lib/common.sh (and scripts/install.ps1). The bar is determinate at the
# ITEM level (total known up front); the active item shows a braille spinner +
# elapsed seconds. Animates only on a real console; otherwise the loggers fall
# through to plain lines and units print "<label>…".
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

# Run a sibling coop script (sync/doctor) in a CHILD process so its `exit` cannot
# abort this update — mirrors bash invoking the script as a subprocess.
function Invoke-CoopScript {
  param([string]$ScriptPath, [string[]]$ScriptArgs = @())
  $psExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
  & $psExe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @ScriptArgs
  return $LASTEXITCODE
}

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
foreach ($a in $args) {
  switch -CaseSensitive ($a) {
    '--no-fabric' { $NO_FABRIC = $true }
    '--yes'       { $env:COOP_ASSUME_YES = '1' }
    '-y'          { $env:COOP_ASSUME_YES = '1' }
    default       { if (-not [string]::IsNullOrWhiteSpace($a)) { Coop-Warn "update: ignoring unknown flag '$a'" } }
  }
}

# The Coop tools to upgrade. Fabric CLI is included unless --no-fabric (matching
# `coop install --no-fabric`), so a fabric-less machine doesn't report a perpetual
# failed item on every update.
$PY_TOOLS = @('coop-data-doc', 'coop-sql-review', 'coop-dax-review')
if (-not $NO_FABRIC) { $PY_TOOLS += 'ms-fabric-cli' }

# Update coop's ISOLATED Pi agent dir (not the user's personal pi).
function Get-CoopPiAgentDir { if ($env:COOP_AGENT_DIR) { $env:COOP_AGENT_DIR } else { Join-Path $HOME '.coop\agent' } }
$env:PI_CODING_AGENT_DIR = Get-CoopPiAgentDir

# --- Per-item units (run in a background job; return @{ok=<bool>; msg=<string>}) --
# Same contract as the install units, so the update bar animates identically.
$UnitPiUpdate = {
  if (-not (Get-Command pi -ErrorAction SilentlyContinue)) {
    return [pscustomobject]@{ ok = $false; msg = 'pi not installed — run: coop install' }
  }
  # `pi update --all` updates the agent AND every installed extension. (Bare
  # `pi update` updates pi ONLY; `--extensions` updates packages only.)
  & pi update --all *> $null
  if ($LASTEXITCODE -eq 0) {
    $v = (& pi --version 2>$null); if (-not $v) { $v = '?' }
    return [pscustomobject]@{ ok = $true; msg = "pi + extensions updated ($v)" }
  }
  return [pscustomobject]@{ ok = $false; msg = 'pi update --all failed (try: pi update --all)' }
}

$UnitPytoolUpgrade = {
  param([string]$Pkg)
  if (-not (Get-Command pipx -ErrorAction SilentlyContinue)) {
    return [pscustomobject]@{ ok = $false; msg = "skipping $Pkg (pipx missing) — run: coop install" }
  }
  $list = (& pipx list 2>$null | Out-String)
  if ($list -notmatch ("package " + [regex]::Escape($Pkg) + " ")) {
    return [pscustomobject]@{ ok = $false; msg = "$Pkg not installed — run: coop install" }
  }
  & pipx upgrade $Pkg *> $null
  if ($LASTEXITCODE -eq 0) { return [pscustomobject]@{ ok = $true; msg = $Pkg } }
  return [pscustomobject]@{ ok = $false; msg = "upgrade failed: $Pkg" }
}

Coop-Head "coop update (v$($script:CoopVersion))"

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
  Coop-Info 'not a git checkout — skipping repo update'
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
# each pipx tool). Steps 1/4/5 (git pull / sync / doctor) sit outside the bar,
# exactly as the install bar covers only its install items.
$TOTAL = $PY_TOOLS.Count
if ($RunPiUpdate) { $TOTAL += 1 }

# Pin the overall bar to the bottom for the update phase (steps 2–3); restore the
# cursor even on Ctrl-C / errors via finally.
try {
  Coop-ProgBegin $TOTAL

  # --- 2. Update Pi + extensions ---------------------------------------------
  Coop-Head '2/5  Pi and extensions'
  if ($RunPiUpdate) {
    Coop-Unit 'pi update --all   (the agent + all installed extensions)' $UnitPiUpdate
  }

  # --- 3. Upgrade pipx tools -------------------------------------------------
  Coop-Head '3/5  Coop tools + Fabric CLI (pipx)'
  foreach ($pkg in $PY_TOOLS) { Coop-Unit $pkg $UnitPytoolUpgrade @($pkg) }
}
finally {
  Coop-ProgEnd
}

# fabric-cicd is a library injected into the Fabric CLI env — refresh it there.
if ((Test-Have 'pipx') -and ((& pipx list 2>$null | Out-String) -match 'package ms-fabric-cli ')) {
  & pipx inject ms-fabric-cli fabric-cicd --force > $null 2>&1
  if ($LASTEXITCODE -eq 0) { Coop-Ok 'fabric-cicd (library) refreshed' }
}

# --- 4. Sync vibes / skills / prompts / extension ----------------------------
Coop-Head '4/5  Sync brand assets'
$syncRc = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\sync.ps1')
if ($syncRc -ne 0) { Coop-Warn 'sync reported issues' }

# --- 5. Doctor ---------------------------------------------------------------
# Propagate doctor's verdict as the update's exit code (mirror of update.sh).
Coop-Head '5/5  Doctor'
$doctorRc = Invoke-CoopScript (Join-Path $script:CoopRoot 'scripts\doctor.ps1')
exit $doctorRc

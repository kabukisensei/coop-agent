#!/usr/bin/env pwsh
#
# coop-agent shared PowerShell library — the twin of lib/common.sh.
# Dot-sourced by bin/coop.ps1 and scripts/*.ps1:
#
#   . (Join-Path $PSScriptRoot '../lib/common.ps1')   # from scripts/ or bin/
#
# Defines helpers only; never calls `exit` except via Coop-Die. Dot-sourcing runs
# this file in the CALLER's script scope, so every $script:* variable and function
# here lands in (and binds to) the calling script — exactly like `. lib/common.sh`
# on the bash side. When you change a helper in lib/common.sh, port it here in the
# same change (scripts/check-parity.sh gates the pairing + this file's BOM).

# --- Resolve COOP_ROOT (the directory that contains bin/, lib/, scripts/) -----
# $PSScriptRoot inside a dot-sourced file is THIS file's directory (lib/), so the
# repo root is one level up — mirror of common.sh's self-location logic.
$script:CoopRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$env:COOP_ROOT = $script:CoopRoot

$script:CoopVersion = '0.0.0'
$coopVerFile = Join-Path $script:CoopRoot 'VERSION'
if (Test-Path -LiteralPath $coopVerFile -PathType Leaf) {
  $coopVerRaw = (Get-Content -LiteralPath $coopVerFile -Raw -ErrorAction SilentlyContinue)
  if ($coopVerRaw) { $script:CoopVersion = $coopVerRaw.Trim() }
}
$env:COOP_VERSION = $script:CoopVersion

# --- Colors (respect NO_COLOR and non-TTY) -----------------------------------
# Cooptimize brand palette (truecolor). Folds "is stderr a real console" in, so
# redirected output gets plain text — mirror of common.sh's [ -t 2 ] check.
$script:CoopColor = ($null -eq $env:NO_COLOR -or $env:NO_COLOR -eq '') -and -not [Console]::IsErrorRedirected
$e = [char]27
if ($script:CoopColor) {
  $script:C_NAVY   = "$e[38;2;0;65;107m"
  $script:C_FOREST = "$e[38;2;66;120;60m"
  $script:C_OLIVE  = "$e[38;2;130;170;67m"
  $script:C_LIME   = "$e[38;2;178;210;53m"
  $script:C_RED    = "$e[38;2;239;65;45m"
  $script:C_BOLD   = "$e[1m"
  $script:C_DIM    = "$e[2m"
  $script:C_RST    = "$e[0m"
} else {
  $script:C_NAVY = ''; $script:C_FOREST = ''; $script:C_OLIVE = ''; $script:C_LIME = ''; $script:C_RED = ''
  $script:C_BOLD = ''; $script:C_DIM = ''; $script:C_RST = ''
}
function Coop-Navy { $script:C_NAVY }
function Coop-Bold { $script:C_BOLD }
function Coop-Dim  { $script:C_DIM }
function Coop-Rst  { $script:C_RST }

# Status glyphs (defined with [char] codepoints for Windows PowerShell 5.1 compat).
$script:G_BULLET = [char]0x2022   # •
$script:G_CHECK  = [char]0x2713   # ✓
$script:G_CROSS  = [char]0x2717   # ✗

# --- Progress: one determinate "overall" bar + an animated active-item line ---
# Mirror of common.sh. Built for installers where each item (npm/pipx/pi install)
# takes a while and its own % is unknowable. The bar is determinate at the ITEM
# level (total known up front); the active item shows a braille spinner + elapsed
# seconds so it is obviously alive. Animates only when stderr is a real console;
# otherwise the loggers fall through to plain lines and units print "<label>…".
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
# All log lines go to stderr. When no progress region is active (the common case —
# doctor/sync/dispatcher) this is a plain WriteLine, exactly as before.
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
function Coop-Die  { param([string]$m) Coop-Err $m; exit 1 }
function Coop-Head { param([string]$m) Coop-Emit "`n$($script:C_BOLD)$($script:C_NAVY)$m$($script:C_RST)" }

# --- Small utilities ----------------------------------------------------------
# Is a command available on PATH? (mirror of have())
function Test-Have { param([string]$Name) [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

# Pick a usable python interpreter that ACTUALLY runs — not the Windows Store
# App-Execution-Alias stub. python.org's installer never creates python3.exe, so
# on stock Windows `python3` resolves ONLY to the Store stub under
# ...\WindowsApps\: Get-Command succeeds while `--version` prints nothing.
# Prefer python3, fall back to python; $null when neither is real.
# (mirror of coop_python — THE one python resolver; don't re-add per-script copies)
function Get-CoopPython {
  foreach ($name in @('python3', 'python')) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $c) { continue }
    if ($c.Source -and $c.Source -match '\\WindowsApps\\') { continue }
    $v = (& $name --version 2>&1)
    if ($v -match '\d+\.\d+') { return $name }
  }
  return $null
}

# coop runs Pi against an ISOLATED agent dir so coop's extensions/settings/theme
# never mix with the user's personal `pi`. Override with COOP_AGENT_DIR.
# (mirror of coop_pi_agent_dir)
function Get-CoopPiAgentDir { if ($env:COOP_AGENT_DIR) { $env:COOP_AGENT_DIR } else { Join-Path $HOME '.coop\agent' } }

# The agent dir Pi will ACTUALLY load: PI_CODING_AGENT_DIR when set; with
# COOP_NO_ISOLATE=1 Pi falls back to the personal ~/.pi/agent.
# (mirror of coop_effective_agent_dir)
function Get-CoopEffectiveAgentDir {
  if ($env:PI_CODING_AGENT_DIR) { return $env:PI_CODING_AGENT_DIR }
  if ($env:COOP_NO_ISOLATE -eq '1') { return (Join-Path $HOME '.pi\agent') }
  return (Get-CoopPiAgentDir)
}

# --- Optional Azure preflight (non-fatal) --------------------------------------
# Mirrors the team's pi-ready habit: if the project pins a Fabric tenant and the
# Azure CLI is present, make sure a Power BI token exists before launching.
# Skipped entirely when COOP_SKIP_AZ=1 or no tenant is configured.
#
# Cached: a successful probe stamps the tenant id into <agent-dir>/.az-ok. Power BI
# tokens live ~60 minutes and `az` cold-starts in ~1-3s, so within 30 minutes of a
# success for the SAME tenant the probe is skipped entirely. A failed probe (or a
# stale/missing/mismatched marker) behaves exactly as before; marker I/O is
# best-effort and never fails the launch. (mirror of coop_az_preflight)
function Invoke-CoopAzPreflight {
  if ($env:COOP_SKIP_AZ -eq '1') { return }
  if (-not (Test-Have 'az')) { return }
  $proj = Find-CoopProjectYml
  if (-not $proj) { return }
  $tenant = Get-CoopYamlValue $proj 'fabric.tenant_id' ''
  if (-not $tenant -or $tenant -like 'TODO*' -or $tenant -like 'TODO:*') { return }
  $agentDir = Get-CoopEffectiveAgentDir
  $marker = Join-Path $agentDir '.az-ok'
  # -Force: pwsh on macOS/Linux treats the dot-prefixed marker as hidden.
  $mi = Get-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  if ($mi -and (((Get-Date) - $mi.LastWriteTime).TotalMinutes -lt 30)) {
    $cached = ''
    try { $cached = ([System.IO.File]::ReadAllText($marker)).Trim() } catch { }
    if ($cached -eq $tenant) { return }
  }
  & az account get-access-token --resource https://analysis.windows.net/powerbi/api > $null 2>&1
  if ($LASTEXITCODE -eq 0) {
    try {
      New-Item -ItemType Directory -Force -Path $agentDir -ErrorAction SilentlyContinue | Out-Null
      [System.IO.File]::WriteAllText($marker, $tenant)
    } catch { }
    return
  }
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  Coop-Warn 'Azure / Power BI token missing or expired.'
  if (Coop-Confirm "Run 'az login' for tenant $tenant now?") {
    & az login --tenant $tenant --allow-no-subscriptions
    if ($LASTEXITCODE -ne 0) { Coop-Warn 'az login failed; continuing anyway.' }
    else { try { [System.IO.File]::WriteAllText($marker, $tenant) } catch { } }
  }
}

# --- Repo staleness (fleet drift) ---------------------------------------------
# coop-agent updates arrive via `git pull` inside `coop update`; a zip/shared-drive
# copy (no .git) silently never updates, and even a git checkout has no signal
# between updates. These helpers power the doctor / launch staleness nudge.

# Quietly refresh origin — at most once per day (marker in the effective agent
# dir) and bounded by a 5s wait, so an offline or VPN-black-holed fetch can never
# stall doctor or a launch. Stamps BEFORE fetching, so an offline machine pays
# the wait at most once a day. Returns $true when THIS call attempted the (daily)
# fetch; $false when throttled or not applicable (non-git copy / no git / no
# origin remote). (mirror of coop_repo_fetch_throttled)
function Invoke-CoopRepoFetchThrottled {
  if (-not (Test-Have 'git')) { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $script:CoopRoot '.git'))) { return $false }
  & git -C $script:CoopRoot remote get-url origin *> $null
  if ($LASTEXITCODE -ne 0) { return $false }
  $agentDir = Get-CoopEffectiveAgentDir
  $marker = Join-Path $agentDir '.coop-fetch-stamp'
  # -Force: pwsh on macOS/Linux treats the dot-prefixed marker as hidden and
  # Get-Item won't return it otherwise (Windows has no Hidden attribute on it).
  $mi = Get-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  if ($mi -and (((Get-Date) - $mi.LastWriteTime).TotalHours -lt 24)) { return $false }
  New-Item -ItemType Directory -Force -Path $agentDir -ErrorAction SilentlyContinue | Out-Null
  New-Item -ItemType File -Force -Path $marker -ErrorAction SilentlyContinue | Out-Null
  # Watchdog via a raw child process (mirrors bash's bg-fetch + 5s killer).
  # Deliberately NOT a PowerShell job: Stop-Job can block indefinitely while a
  # native command is mid-flight inside the job, which would hang doctor/launch —
  # Process.WaitForExit(ms) + Kill() can't.
  $oldPrompt = $env:GIT_TERMINAL_PROMPT
  $env:GIT_TERMINAL_PROMPT = '0'
  $so = [System.IO.Path]::GetTempFileName(); $se = [System.IO.Path]::GetTempFileName()
  try {
    $p = Start-Process -FilePath 'git' -ArgumentList @('-C', "$script:CoopRoot", 'fetch', '--quiet', 'origin') `
          -NoNewWindow -PassThru -RedirectStandardOutput $so -RedirectStandardError $se -ErrorAction Stop
    if (-not $p.WaitForExit(5000)) { try { $p.Kill() } catch { } }
  } catch { }
  finally {
    Remove-Item $so, $se -Force -ErrorAction SilentlyContinue
    if ($null -eq $oldPrompt) { Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue }
    else { $env:GIT_TERMINAL_PROMPT = $oldPrompt }
  }
  return $true
}

# How many commits HEAD is behind origin/main — purely local and instant (counts
# against the last-fetched origin/main; no network). 0 when this is not a git
# checkout, git is missing, or the count is unknowable.
# (mirror of coop_repo_behind_count)
function Get-CoopRepoBehindCount {
  if (-not (Test-Have 'git')) { return 0 }
  if (-not (Test-Path -LiteralPath (Join-Path $script:CoopRoot '.git'))) { return 0 }
  $out = (& git -C $script:CoopRoot rev-list --count 'HEAD..origin/main' 2>$null | Out-String).Trim()
  if ($out -match '^\d+$') { return [int]$out }
  return 0
}

# Launch-time staleness nudge: at most once per day (it fires only when this call
# performed the daily fetch), warn when the checkout is behind origin/main.
# Never blocks or fails the launch; silent offline / non-git / up-to-date.
# (mirror of coop_update_nudge)
function Invoke-CoopUpdateNudge {
  if (-not (Invoke-CoopRepoFetchThrottled)) { return }
  $behind = Get-CoopRepoBehindCount
  if ($behind -gt 0) { Coop-Warn "coop-agent is $behind commit(s) behind — run: coop update" }
}

# The Pi agent's own semver, e.g. '0.80.2' (from `pi --version`). '' if unknown.
# (mirror of coop_pi_version)
function Get-CoopPiVersion {
  if (-not (Test-Have 'pi')) { return '' }
  $raw = (& pi --version 2>$null | Select-Object -First 1)
  $m = [regex]::Match([string]$raw, '\d+\.\d+\.\d+')
  if ($m.Success) { return $m.Value } else { return '' }
}

# True if version $A's MAJOR.MINOR is strictly newer than $B's (patch ignored).
# (mirror of coop_minor_newer)
function Test-CoopMinorNewer {
  param([string]$A, [string]$B)
  $ma = [regex]::Match([string]$A, '^(\d+)\.(\d+)'); $mb = [regex]::Match([string]$B, '^(\d+)\.(\d+)')
  if (-not $ma.Success -or -not $mb.Success) { return $false }
  return ([version]("{0}.{1}" -f $ma.Groups[1].Value, $ma.Groups[2].Value) -gt [version]("{0}.{1}" -f $mb.Groups[1].Value, $mb.Groups[2].Value))
}

# Read a dotted scalar key from a YAML file via lib/_yaml.py (PyYAML when present,
# else a dependency-free fallback parser). (mirror of coop_yaml_get)
function Get-CoopYamlValue {
  param([string]$File, [string]$Key, [string]$Default = '')
  if (-not $File -or -not (Test-Path -LiteralPath $File -PathType Leaf)) { return $Default }
  $py = Get-CoopPython
  if (-not $py) { return $Default }
  $yamlPy = Join-Path $script:CoopRoot 'lib/_yaml.py'
  try {
    $out = (& $py $yamlPy get $File $Key $Default 2>$null)
    if ($null -eq $out) { return $Default }
    $out = ($out | Out-String).TrimEnd("`r", "`n")
    if ($out -eq '') { return $Default }
    return $out
  } catch { return $Default }
}

# Read a dotted key that is a YAML list of scalars, returning a string array.
# (mirror of coop_yaml_list)
function Get-CoopYamlList {
  param([string]$File, [string]$Key)
  if (-not $File -or -not (Test-Path -LiteralPath $File -PathType Leaf)) { return @() }
  $py = Get-CoopPython
  if (-not $py) { return @() }
  $yamlPy = Join-Path $script:CoopRoot 'lib/_yaml.py'
  try {
    $out = (& $py $yamlPy list $File $Key 2>$null)
    if ($null -eq $out) { return @() }
    return @($out -split "`r?`n" | Where-Object { $_ -ne '' })
  } catch { return @() }
}

# Extract the YAML frontmatter `name:` from a SKILL.md (first match), or '' if none.
# (mirror of coop_skill_name)
function Get-CoopSkillName {
  param([string]$File)
  if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return '' }
  $lines = Get-Content -LiteralPath $File -ErrorAction SilentlyContinue
  if (-not $lines -or $lines.Count -eq 0 -or $lines[0].Trim() -ne '---') { return '' }
  for ($i = 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -eq '---') { break }
    if ($lines[$i] -match '^\s*name:\s*(.+?)\s*$') {
      return ($matches[1].Trim() -replace '^["'']|["'']$', '')
    }
  }
  return ''
}

# Locate the active project contract: nearest .coop/project.yml walking up from
# $PWD, else the bundled one at COOP_ROOT/.coop/project.yml. (mirror of coop_find_project_yml)
function Find-CoopProjectYml {
  param([string]$StartDir = (Get-Location).Path)
  $dir = $StartDir
  while ($dir) {
    $candidate = Join-Path $dir '.coop\project.yml'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    $parent = Split-Path -Parent $dir
    if ($parent -eq $dir -or -not $parent) { break }
    $dir = $parent
  }
  $bundled = Join-Path $script:CoopRoot '.coop\project.yml'
  if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
  return ''
}

# Confirm a potentially-destructive action unless --yes / COOP_ASSUME_YES is set.
# (mirror of coop_confirm)
function Coop-Confirm {
  param([string]$Prompt = 'Proceed?')
  if ($env:COOP_ASSUME_YES -eq '1') { return $true }
  if ([Console]::IsInputRedirected) { Coop-Warn 'Non-interactive shell; refusing without --yes.'; return $false }
  [Console]::Error.Write("$($script:C_OLIVE)$Prompt$($script:C_RST) [y/N] ")
  $ans = [Console]::In.ReadLine()
  if ($ans -match '^(y|yes)$') { return $true } else { return $false }
}

# --- Background units (install/update items) ----------------------------------
function Start-CoopJob {
  param([scriptblock]$Sb, [object[]]$JobArgs)
  if ($script:UseThreadJob) { Start-ThreadJob -ScriptBlock $Sb -ArgumentList $JobArgs }
  else                      { Start-Job       -ScriptBlock $Sb -ArgumentList $JobArgs }
}

# Coop-Unit <label> <scriptblock> [args]
#   Runs the scriptblock in a background job (it returns @{ok=<bool>; msg=<string>}).
#   While it runs, the active-item line animates under the overall bar; on completion
#   the bar advances by one and a permanent ✓/! line is printed. NB: the scriptblock
#   runs in a FRESH runspace — it sees none of these functions/variables, so units
#   must be self-contained and take their inputs as arguments. (mirror of coop_unit)
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
# abort the caller — mirrors bash invoking "$COOP_ROOT/scripts/x.sh" as a
# subprocess. Returns the child's exit code.
function Invoke-CoopScript {
  param([string]$ScriptPath, [string[]]$ScriptArgs = @())
  $psExe = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
  & $psExe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @ScriptArgs
  return $LASTEXITCODE
}

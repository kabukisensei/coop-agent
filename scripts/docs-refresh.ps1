#!/usr/bin/env pwsh
#
# scripts/docs-refresh.ps1 - the daily lineage refresh (FEATURES-DESIGN CW6), the
# "Daily lineage refresh" feature: off by default, `coop settings set docs-refresh
# on` turns it on for this client (~/.coop/config features.docs_refresh).
#
# When it runs (Aaron, 2026-11-26): at most once per calendar day, 20 minutes
# after Windows sign-in or 20 minutes after coop starts, whichever comes first,
# never during start-up. Two starters, no Task Scheduler task:
#   - scripts/sign-in.ps1 (coop at sign-in), once it has waited for coop's own
#     update and opened the window: due 20 minutes after the sign-in started (the
#     update wait counts toward them);
#   - bin/coop.ps1, once Pi or the window is started: due 20 minutes after that
#     coop process started.
# Off (the default), each looks at the config's text and stops there (a
# few milliseconds; this file is not even loaded): nothing starts and nothing is
# written. When the text may say "docs_refresh": true, each loads this file and
# calls Start-CoopDocsRefresh, which reads the switch properly; on, it does nothing when
# today's run is claimed, passes an earlier due to a waiter that is already
# waiting (pending.json), and otherwise starts this file as the waiter in the
# built-in powershell.exe (the update task does not count it as coop in use),
# hidden, below normal priority, detached from the console that started it.
#
# The waiter sleeps until its due time on the wall clock (so a machine asleep at
# the due time runs it on waking, and one that slept past midnight schedules that
# day's run 20 minutes after waking), exits if the feature was switched off or
# the day is claimed, waits up to 30 minutes past the due time while a coop
# update installs (then exits without claiming: update_running), and claims the
# day with a create-new file (~/.coop/docs-refresh/day-<yyyy-MM-dd>), so two
# waiters (two coop windows started at once, sign-in and coop) give one run. The
# claim comes before the run: a failed run is not retried that day
# (`/setup-docs refresh` runs it by hand).
#
# The run is a fixed script, not an agent: no Pi, no model, no Git, no write
# tool. It reads the client folder from ~/.coop/client.json, gives the child
# COOP_PROJECT_YML (its project file) and runs lib\live_docs.py twice with
# stdin JSON: `refresh` with `mint` (dev targets only; it checks the docs config,
# the tool, the live sources and the dev targets, refuses a dev entry that names
# production, dev_is_prod, and only then mints the tenant-pinned sign-in in its
# own process, never prompting) and, when something was read, `build` (coop-data-doc build into the docs
# folder, as the weekly refresh does, counting the files it changed). The whole
# run is capped at 20 minutes (timeout). The changed docs show in the Changes
# pane like any other change; nothing is committed. The result goes to
# ~/.coop/docs-refresh/state.json (its `line` is what doctor and the next
# session start show) and ~/.coop/logs/docs-refresh.log (under 1 MB).
#
# Windows PowerShell 5.1 syntax. Dot-sourcing this file defines the functions and
# runs nothing (sign-in.ps1 and lib\common.ps1 do that).
#
# Test seams (the fixtures only; this file loads only while the feature is on):
# COOP_DOCS_REFRESH_CLOCK names a file holding a number of seconds added to the
# clock; COOP_DOCS_REFRESH_POLL_MS is the waiter's poll interval (100 ms to the
# default 30 s); COOP_DOCS_REFRESH_LIMIT_SECONDS shortens the 20 minute cap
# (never lengthens it); COOP_BUILTIN_POWERSHELL replaces the built-in
# powershell.exe for coop's starter (sign-in.ps1 passes its -PowerShellPath);
# -WaiterTick makes the waiter look once and report instead of sleeping.
param(
  [string]$WaiterFrom = '',
  [string]$WaiterDue = '',
  [switch]$WaiterTick
)

$script:DocsRefreshDelayMinutes = 20
$script:DocsRefreshUpdateWaitMinutes = 30
$script:DocsRefreshLimitSeconds = 1200

# --- the clock and the files ----------------------------------------------------------
function Get-CoopDocsRefreshNow {
  $now = Get-Date
  $clock = [string]$env:COOP_DOCS_REFRESH_CLOCK
  if ($clock) { try { $now = $now.AddSeconds([double](([System.IO.File]::ReadAllText($clock)).Trim())) } catch { } }
  return $now
}
function ConvertTo-CoopDocsRefreshUnix([datetime]$Time) { return (New-Object System.DateTimeOffset($Time)).ToUnixTimeSeconds() }
function ConvertFrom-CoopDocsRefreshUnix([long]$Seconds) { return [System.DateTimeOffset]::FromUnixTimeSeconds($Seconds).LocalDateTime }
function Get-CoopDocsRefreshDay([datetime]$Time) { return $Time.ToString('yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture) }
function Get-CoopDocsRefreshDir([string]$ProfileDir) { return (Join-Path $ProfileDir 'docs-refresh') }

# On only when ~/.coop/config says features.docs_refresh is exactly true, as
# lib\features.mjs reads it; missing, unreadable or anything else is off.
function Test-CoopDocsRefreshOn([string]$ProfileDir) {
  $file = Join-Path $ProfileDir 'config'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
  try {
    $cfg = [System.IO.File]::ReadAllText($file) | ConvertFrom-Json
    $value = $cfg.features.docs_refresh
    return (($value -is [bool]) -and $value)
  } catch { return $false }
}

function Read-CoopDocsRefreshJson([string]$File) {
  try { return ([System.IO.File]::ReadAllText($File) | ConvertFrom-Json) } catch { return $null }
}
# A temp file beside it, renamed over (a reader never sees half a file).
function Write-CoopDocsRefreshJson([string]$File, $Data) {
  $dir = Split-Path -Parent $File
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $tmp = $File + '.tmp-' + $PID + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
  [System.IO.File]::WriteAllText($tmp, (ConvertTo-Json -InputObject $Data -Depth 6 -Compress), (New-Object System.Text.UTF8Encoding $false))
  for ($try = 1; ; $try++) {
    try {
      if (Test-Path -LiteralPath $File -PathType Leaf) { [System.IO.File]::Replace($tmp, $File, [System.Management.Automation.Language.NullString]::Value) } else { [System.IO.File]::Move($tmp, $File) }
      return
    } catch {
      # Windows refuses for a moment while another process has the file open.
      if ($try -ge 10) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue; throw }
      Start-Sleep -Milliseconds 50
    }
  }
}

# The built-in Windows PowerShell (not one from coop's install folder, which the
# update task would count as coop in use); elsewhere this PowerShell.
# COOP_BUILTIN_POWERSHELL is the fixtures' stand-in: this file loads only while
# the feature is on, and scripts\sign-in.ps1 passes its own -PowerShellPath.
function Get-CoopBuiltinPowerShell {
  if ($env:COOP_BUILTIN_POWERSHELL) { return [string]$env:COOP_BUILTIN_POWERSHELL }
  if ($env:OS -eq 'Windows_NT') { return (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') }
  return (Get-Process -Id $PID).Path
}

# The variables a launch keeps for its own children that the waiter must never
# inherit (Neon B1): the sign-in token and the window's launch spec. The Windows
# waiter starts through ShellExecute, which takes no environment of its own, so
# they leave this process's environment for the moment of the start.
$script:DocsRefreshPrivateEnv = @('COOP_FABRIC_MCP_TOKEN', 'COOP_DATA_DOC_ACCESS_TOKEN', 'COOP_DESKTOP_SPEC', 'COOP_DESKTOP_DATA', 'COOP_FIRST_RUN', 'COOP_PRIME_MODEL_LOGIN')

# --- the starters ----------------------------------------------------------------------
# A process's start time as unix seconds (0 when it cannot be read).
function Get-CoopDocsRefreshProcessStart($Process) {
  try { return (ConvertTo-CoopDocsRefreshUnix $Process.StartTime) } catch { return 0 }
}

# A waiter is waiting: the pid it recorded is a running PowerShell that started
# when the waiter recorded (a reused pid after a logoff or a reboot is not it),
# for today or yesterday's run; or, before it recorded one, the starter's note
# is under two minutes old.
function Test-CoopDocsRefreshPendingLive($Pending, [datetime]$Now) {
  if ($null -eq $Pending) { return $false }
  $procId = 0
  try { $procId = [int]$Pending.pid } catch { $procId = 0 }
  if ($procId -gt 0) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not ($p -and $p.ProcessName -match '^(powershell|pwsh)')) { return $false }
    $started = 0
    try { $started = [long]$Pending.started } catch { $started = 0 }
    if ($started -le 0 -or [Math]::Abs((Get-CoopDocsRefreshProcessStart $p) - $started) -gt 2) { return $false }
    $day = [string]$Pending.day
    if ($day -and [string]::CompareOrdinal($day, (Get-CoopDocsRefreshDay $Now.AddDays(-1))) -lt 0) { return $false }
    return $true
  }
  $written = 0
  try { $written = [long]$Pending.written } catch { $written = 0 }
  return (((ConvertTo-CoopDocsRefreshUnix $Now) - $written) -lt 120)
}

# The earliest due a waiting waiter knows of: its own (pending.json) or one a
# later starter handed over (earlier.json); 0 when neither says.
function Get-CoopDocsRefreshKnownDue($Pending, $Earlier) {
  $known = 0
  foreach ($doc in @($Pending, $Earlier)) {
    $d = 0
    try { if ($doc) { $d = [long]$doc.due } } catch { $d = 0 }
    if ($d -gt 0 -and ($known -eq 0 -or $d -lt $known)) { $known = $d }
  }
  return $known
}

# Start the waiter, detached and hidden, without the launch's private variables.
# Throws when it cannot be started.
function Start-CoopDocsRefreshWaiter([string]$ProfileDir, [string]$From, [long]$DueUnix, [string]$PowerShell) {
  $dir = Get-CoopDocsRefreshDir $ProfileDir
  $script = Join-Path $PSScriptRoot 'docs-refresh.ps1'
  # Checked here: sh (below) would background a missing one without a word.
  if (-not $PowerShell -or -not (Test-Path -LiteralPath $PowerShell -PathType Leaf)) { throw "no PowerShell at '$PowerShell'" }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  # The waiter's folder is the profile, never coop's install folder (an open
  # folder there would hold up the installer).
  $psi.WorkingDirectory = $ProfileDir
  $kept = @{}
  foreach ($name in $script:DocsRefreshPrivateEnv) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($null -ne $value) { $kept[$name] = $value; [Environment]::SetEnvironmentVariable($name, $null) }
  }
  try {
    # [System.Diagnostics.Process] directly: Start-Process costs a cold
    # PowerShell up to a second, which a launch would wait for.
    if ($env:OS -eq 'Windows_NT') {
      # ShellExecute: a hidden window of its own (and -WindowStyle Hidden, for a
      # console host that shows it anyway), no handle inherited from this console
      # (the window's launcher reads this console's output).
      $psi.FileName = $PowerShell
      $psi.Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $script + '" -WaiterFrom ' + $From + ' -WaiterDue ' + $DueUnix
      $psi.UseShellExecute = $true
      $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
      $p = [System.Diagnostics.Process]::Start($psi)
      if (-not $p) { throw 'the waiter did not start' }
      try { $p.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal } catch { }
      $p.Dispose()
    } else {
      # A developer box: sh puts the waiter in the background with its own
      # output file (kept under 1 MB), so no pipe reading this console stays
      # open until it ends.
      $out = Join-Path $dir 'waiter.log'
      try { if ((Test-Path -LiteralPath $out -PathType Leaf) -and (Get-Item -LiteralPath $out).Length -gt 1MB) { Remove-Item -LiteralPath $out -Force } } catch { }
      $psi.FileName = '/bin/sh'
      foreach ($a in @('-c', 'exec "$0" "$@" </dev/null >>"$DR_OUT" 2>&1 &', $PowerShell, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $script, '-WaiterFrom', $From, '-WaiterDue', [string]$DueUnix)) { $psi.ArgumentList.Add($a) }
      foreach ($name in $script:DocsRefreshPrivateEnv) { [void]$psi.Environment.Remove($name) }
      $psi.Environment['DR_OUT'] = $out
      $psi.UseShellExecute = $false
      $p = [System.Diagnostics.Process]::Start($psi)
      [void]$p.WaitForExit(5000)
      $p.Dispose()
    }
  } finally {
    foreach ($name in $kept.Keys) { [Environment]::SetEnvironmentVariable($name, $kept[$name]) }
  }
}

# Schedule today's run from one starter ('signin' or 'coop'), due 20 minutes
# after -StartedAt and never sooner than 2 minutes from now (a long update wait
# or first-launch setup must not put it in the start-up). Returns 'off' (the
# switch is off: nothing else ran), 'done' (today's run is claimed), 'pending'
# (a waiter is already waiting; it takes this due when earlier), 'started', or
# 'failed' (the waiter could not be started; nothing is left behind). Never throws.
function Start-CoopDocsRefresh {
  param([string]$ProfileDir, [string]$From, [datetime]$StartedAt, [string]$PowerShell = '')
  if (-not (Test-CoopDocsRefreshOn $ProfileDir)) { return 'off' }
  $ours = ''
  try {
    if (-not $PowerShell) { $PowerShell = Get-CoopBuiltinPowerShell }
    $now = Get-CoopDocsRefreshNow
    # The time since -StartedAt (the sign-in's update wait, coop's own start)
    # counts toward the 20 minutes; a clock set back counts as none.
    $elapsed = (Get-Date) - $StartedAt
    if ($elapsed.Ticks -lt 0) { $elapsed = [TimeSpan]::Zero }
    $due = $now.AddMinutes($script:DocsRefreshDelayMinutes).Add(-$elapsed)
    if ($due -lt $now.AddMinutes(2)) { $due = $now.AddMinutes(2) }
    $dueUnix = ConvertTo-CoopDocsRefreshUnix $due
    $dir = Get-CoopDocsRefreshDir $ProfileDir
    if (Test-Path -LiteralPath (Join-Path $dir ('day-' + (Get-CoopDocsRefreshDay $due))) -PathType Leaf) { return 'done' }
    $pendingFile = Join-Path $dir 'pending.json'
    $earlierFile = Join-Path $dir 'earlier.json'
    $pending = Read-CoopDocsRefreshJson $pendingFile
    if (Test-CoopDocsRefreshPendingLive $pending $now) {
      # Whichever comes first: hand the waiter this due when it is earlier. Only
      # the waiter writes pending.json; a starter writes earlier.json.
      $known = Get-CoopDocsRefreshKnownDue $pending (Read-CoopDocsRefreshJson $earlierFile)
      if ($known -eq 0 -or $known -gt $dueUnix) {
        Write-CoopDocsRefreshJson $earlierFile ([ordered]@{ due = $dueUnix; from = $From; written = (ConvertTo-CoopDocsRefreshUnix $now) })
      }
      return 'pending'
    }
    if (Test-Path -LiteralPath $pendingFile -PathType Leaf) {
      # Another starter is writing its note right now, or a waiter that is gone left it.
      $item = Get-Item -LiteralPath $pendingFile -Force -ErrorAction SilentlyContinue
      if ($item -and ((Get-Date) - $item.LastWriteTime).TotalSeconds -lt 10) { return 'pending' }
      Remove-Item -LiteralPath $pendingFile -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $earlierFile -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    # Create-new: of two coops starting at once, one writes the note and starts
    # the waiter. pid 0: the waiter records its own pid and start time first thing.
    $note = ConvertTo-Json -Compress -InputObject ([ordered]@{ pid = 0; started = 0; day = (Get-CoopDocsRefreshDay $due); due = $dueUnix; from = $From; written = (ConvertTo-CoopDocsRefreshUnix $now) })
    try {
      $fs = [System.IO.File]::Open($pendingFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
      try { $bytes = (New-Object System.Text.UTF8Encoding $false).GetBytes($note); $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Close() }
    } catch { return 'pending' }
    $ours = $pendingFile
    Start-CoopDocsRefreshWaiter -ProfileDir $ProfileDir -From $From -DueUnix $dueUnix -PowerShell $PowerShell
    return 'started'
  } catch {
    # The note of a waiter that never started would hold off the next starter.
    if ($ours) { Remove-Item -LiteralPath $ours -Force -ErrorAction SilentlyContinue }
    return 'failed'
  }
}

# --- the waiter ----------------------------------------------------------------------
# A coop update is installing: the update task writes <machine dir>\updating.json
# while its installer runs (scripts\auto-update.ps1); an hour and a half old
# means a run that died (desktop\lib\bootstrap.mjs reads it the same way).
function Test-CoopDocsRefreshUpdateRunning([datetime]$Now) {
  $machine = if ($env:COOP_MACHINE_DIR) { [string]$env:COOP_MACHINE_DIR } elseif ($env:ProgramData) { Join-Path $env:ProgramData 'coop' } else { '' }
  if (-not $machine) { return $false }
  $record = Join-Path $machine 'updating.json'
  if (-not (Test-Path -LiteralPath $record -PathType Leaf)) { return $false }
  $info = Read-CoopDocsRefreshJson $record
  if ($null -eq $info) { return $false }
  try {
    $started = $info.started
    if (-not ($started -is [datetime])) { $started = [datetime]::Parse([string]$started, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind) }
    $age = ($Now.ToUniversalTime() - $started.ToUniversalTime()).TotalMinutes
    return ($age -ge -5 -and $age -lt 90)
  } catch { return $false }
}

function Write-CoopDocsRefreshLog([string]$ProfileDir, [string]$Text) {
  try { Add-CoopUpdateLogLine (Join-Path $ProfileDir 'logs\docs-refresh.log') $Text } catch { }
}

# Claim the day: true for the one waiter that creates the file.
function New-CoopDocsRefreshClaim([string]$Dir, [string]$Day) {
  try {
    if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { New-Item -ItemType Directory -Force -Path $Dir | Out-Null }
    $fs = [System.IO.File]::Open((Join-Path $Dir ('day-' + $Day)), [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
    $fs.Close()
    return $true
  } catch { return $false }
}

# Claim files older than 7 days go.
function Remove-CoopDocsRefreshOldClaims([string]$Dir, [datetime]$Now) {
  $oldest = Get-CoopDocsRefreshDay $Now.AddDays(-7)
  foreach ($f in @(Get-ChildItem -LiteralPath $Dir -Filter 'day-*' -File -Force -ErrorAction SilentlyContinue)) {
    $day = $f.Name.Substring(4)
    if ($day -match '^\d{4}-\d{2}-\d{2}$' -and [string]::CompareOrdinal($day, $oldest) -lt 0) { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue }
  }
}

# Wait for the due time, then claim the day and run. Returns the outcome:
# 'off', 'done' (another waiter claimed the day), 'update_running', the run's
# result, or with -Tick 'waiting' / 'update-wait' (looked once, not due yet).
function Invoke-CoopDocsRefreshWaiter {
  param([string]$From, [long]$DueUnix, [switch]$Tick)
  $profileDir = if ($env:COOP_DIR) { Join-Path $env:COOP_DIR '.coop' } else { Join-Path $HOME '.coop' }
  $dir = Get-CoopDocsRefreshDir $profileDir
  $pendingFile = Join-Path $dir 'pending.json'
  $earlierFile = Join-Path $dir 'earlier.json'
  # COOP_DOCS_REFRESH_POLL_MS (the fixtures): 100 ms to the default 30 s, never faster.
  $poll = 30000
  if ($env:COOP_DOCS_REFRESH_POLL_MS) { try { $poll = [Math]::Min(30000, [Math]::Max(100, [int]$env:COOP_DOCS_REFRESH_POLL_MS)) } catch { } }
  $due = ConvertFrom-CoopDocsRefreshUnix $DueUnix
  $mine = $false
  $myStart = Get-CoopDocsRefreshProcessStart ([System.Diagnostics.Process]::GetCurrentProcess())
  # This waiter in pending.json (its pid and start time, so a pid reused after
  # a logoff is not taken for it): only the waiter writes it.
  $record = {
    param([datetime]$Due, [datetime]$Now)
    Write-CoopDocsRefreshJson $pendingFile ([ordered]@{ pid = $PID; started = $myStart; day = (Get-CoopDocsRefreshDay $Due); due = (ConvertTo-CoopDocsRefreshUnix $Due); from = $From; written = (ConvertTo-CoopDocsRefreshUnix $Now) })
  }
  if (-not $Tick) {
    # Keep an earlier due the starter's note or a later starter handed over.
    $known = Get-CoopDocsRefreshKnownDue (Read-CoopDocsRefreshJson $pendingFile) (Read-CoopDocsRefreshJson $earlierFile)
    if ($known -gt 0 -and $known -lt $DueUnix) { $due = ConvertFrom-CoopDocsRefreshUnix $known }
    try { & $record $due (Get-CoopDocsRefreshNow); $mine = $true } catch { }
    Write-CoopDocsRefreshLog $profileDir ("waiting: started at $From, due " + $due.ToString('yyyy-MM-dd HH:mm', [System.Globalization.CultureInfo]::InvariantCulture))
  }
  try {
    while ($true) {
      $now = Get-CoopDocsRefreshNow
      # Whichever comes first: a later starter's earlier due, for today.
      $earlier = Read-CoopDocsRefreshJson $earlierFile
      $handed = 0
      try { if ($earlier) { $handed = [long]$earlier.due } } catch { $handed = 0 }
      if ($handed -gt 0 -and $handed -lt (ConvertTo-CoopDocsRefreshUnix $due) -and (ConvertFrom-CoopDocsRefreshUnix $handed).Date -ge $now.Date) {
        $due = ConvertFrom-CoopDocsRefreshUnix $handed
        Write-CoopDocsRefreshLog $profileDir ('a ' + [string]$earlier.from + ' start moved the refresh to ' + $due.ToString('HH:mm', [System.Globalization.CultureInfo]::InvariantCulture))
      }
      if (-not (Test-CoopDocsRefreshOn $profileDir)) { Write-CoopDocsRefreshLog $profileDir 'the feature was switched off; nothing ran'; return 'off' }
      if (Test-Path -LiteralPath (Join-Path $dir ('day-' + (Get-CoopDocsRefreshDay $now))) -PathType Leaf) { return 'done' }
      if ($now.Date -gt $due.Date) {
        # Asleep past midnight: that day's run, 20 minutes after waking.
        $due = $now.AddMinutes($script:DocsRefreshDelayMinutes)
        if ($mine) {
          Remove-Item -LiteralPath $earlierFile -Force -ErrorAction SilentlyContinue
          try { & $record $due $now } catch { }
        }
        Write-CoopDocsRefreshLog $profileDir ('the computer was asleep past midnight; today''s refresh is due ' + $due.ToString('yyyy-MM-dd HH:mm', [System.Globalization.CultureInfo]::InvariantCulture))
      } elseif ($now -ge $due) {
        if (-not (Test-CoopDocsRefreshUpdateRunning $now)) { break }
        if ($now -ge $due.AddMinutes($script:DocsRefreshUpdateWaitMinutes)) {
          [void](Write-CoopDocsRefreshState $profileDir ([ordered]@{ day = (Get-CoopDocsRefreshDay $now); from = $From; started = $now.ToString('o'); finished = $now.ToString('o'); result = 'update_running'; files_changed = 0; objects_changed = 0; sources = @() }))
          Write-CoopDocsRefreshLog $profileDir 'a coop update was still installing 30 minutes after the due time; today is not claimed (the next sign-in or coop start tries again)'
          return 'update_running'
        }
        if ($Tick) { return 'update-wait' }
      }
      if ($Tick) { return 'waiting' }
      Start-Sleep -Milliseconds $poll
    }
    $day = Get-CoopDocsRefreshDay $now
    if (-not (New-CoopDocsRefreshClaim $dir $day)) { return 'done' }
    Remove-CoopDocsRefreshOldClaims $dir $now
    Write-CoopDocsRefreshLog $profileDir "claimed $day; refreshing"
    $state = Invoke-CoopDocsRefreshRun -ProfileDir $profileDir -From $From -Day $day
    Write-CoopDocsRefreshLog $profileDir (Get-CoopDocsRefreshLogLine $state)
    return [string]$state.result
  } finally {
    if ($mine) {
      $pending = Read-CoopDocsRefreshJson $pendingFile
      try {
        if ($null -eq $pending -or [int]$pending.pid -eq $PID) {
          Remove-Item -LiteralPath $pendingFile -Force -ErrorAction SilentlyContinue
          Remove-Item -LiteralPath $earlierFile -Force -ErrorAction SilentlyContinue
        }
      } catch { }
    }
  }
}

# --- the run ---------------------------------------------------------------------------
# What a result code means, for the status line: what happened and where to fix
# it, in the window's words, then the slash command or the CLI (Aaron,
# 2026-11-26). The code itself goes only to the log.
function Get-CoopDocsRefreshReason([string]$Code, [string]$LogFile = '') {
  $log = if ($LogFile) { $LogFile } else { 'docs-refresh.log' }
  switch ($Code) {
    'no_client' { return 'No client folder is set. Choose one in File > Switch client (or coop project home <folder>).' }
    'no_project' { return 'The client folder has no project file. Create it in Project (or /setup-project).' }
    'no_docs_config' { return 'The lineage docs are not set up. Open Docs > Set up the docs (or /setup-docs).' }
    'no_live_sources' { return 'The docs do not read the dev database. Open Docs > Use the live dev database (or /setup-docs live).' }
    'no_dev_target' { return 'There is no dev SQL target. Add a dev SQL target in Project > SQL targets (or /setup-project).' }
    'dev_is_prod' { return 'The dev SQL target points at production, so nothing was read. Point the dev target at a dev database in Project > SQL targets.' }
    'config_unreadable' { return 'The docs setup file could not be read. Fix it in Docs > Change the setup (or /setup-docs).' }
    'tool_unavailable' { return 'The docs tool or Python is missing. Run coop update (or coop install).' }
    'azure_unavailable' { return 'The Azure CLI is missing or would not start. Run coop update (or coop install).' }
    'signin_needed' { return 'The Azure sign-in has expired. Run az login (File > Open in terminal), then Docs > Refresh from dev.' }
    'azure_failed' { return 'The Azure CLI gave no sign-in token. Check the network or VPN, then Docs > Refresh from dev.' }
    'timeout' { return "It did not finish within 20 minutes. Check the network or VPN; the log is $log." }
    'snapshot_failed' { return 'The dev database could not be read. Docs > Refresh from dev (or /setup-docs refresh) shows why.' }
    'build_failed' { return 'The docs did not rebuild. Docs > Build (or coop data-doc build) shows why.' }
  }
  return "Something went wrong. The log is $log."
}
# The codes that are a skip (nothing to retry until the setup changes); every
# other code is a failure, tried again the next day.
$script:DocsRefreshSkips = @('no_client', 'no_project', 'no_docs_config', 'no_live_sources', 'no_dev_target', 'dev_is_prod', 'config_unreadable', 'tool_unavailable', 'azure_unavailable')
# The log's line for a finished run: the status line, then the code and what
# the helper said.
function Get-CoopDocsRefreshLogLine($State) {
  $why = [string]$State.result
  if ([string]$State.detail) { $why += ': ' + [string]$State.detail }
  return ([string]$State.line + ' [' + $why + ']')
}
# The one line doctor and the next session start show.
function Get-CoopDocsRefreshLine($State, [string]$LogFile = '') {
  $at = ''
  try {
    $t = $State.finished
    if (-not ($t -is [datetime])) { $t = [datetime]::Parse([string]$t, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind) }
    $at = $t.ToString('HH:mm', [System.Globalization.CultureInfo]::InvariantCulture)
  } catch { $at = '' }
  $code = [string]$State.result
  if ($code -eq 'ok') {
    $n = 0
    try { $n = [int]$State.files_changed } catch { $n = 0 }
    $files = if ($n -eq 0) { 'no files changed' } elseif ($n -eq 1) { '1 file changed' } else { "$n files changed" }
    $line = "Docs refreshed $at, $files."
    $unread = @(@($State.sources) | Where-Object { $_ -and $_.state -ne 'taken' } | ForEach-Object { [string]$_.name })
    if ($unread.Count) { $line += ' Not read: ' + ($unread -join ', ') + '.' }
    return $line
  }
  if ($code -eq 'update_running') { return 'Docs refresh waited for a coop update. It runs at the next sign-in or coop start.' }
  $reason = Get-CoopDocsRefreshReason $code $LogFile
  if ($script:DocsRefreshSkips -contains $code) { return "Docs refresh skipped $($at): $reason" }
  return "Docs refresh failed $($at): $reason It runs again tomorrow."
}

function Write-CoopDocsRefreshState([string]$ProfileDir, $State) {
  $full = [ordered]@{ schema_version = 1 }
  foreach ($k in $State.Keys) { $full[$k] = $State[$k] }
  $full['line'] = Get-CoopDocsRefreshLine ([pscustomobject]$full) (Join-Path $ProfileDir 'logs\docs-refresh.log')
  try { Write-CoopDocsRefreshJson (Join-Path (Get-CoopDocsRefreshDir $ProfileDir) 'state.json') $full } catch { }
  return [pscustomobject]$full
}

# lib\live_docs.py with one stdin JSON request, in a child with no window, no
# longer than $TimeoutSeconds: @{ TimedOut; Rc; Data }. Non-ASCII in the request
# travels as \u escapes, so no console code page garbles a path.
function Invoke-CoopDocsRefreshHelper {
  param([string]$Python, [string]$Helper, $Request, [string]$Cwd, [hashtable]$ChildEnv, [int]$TimeoutSeconds)
  $json = ConvertTo-Json -InputObject $Request -Compress
  $json = [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Python
  $psi.Arguments = '"' + $Helper + '"'
  $psi.WorkingDirectory = $Cwd
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding $false
  $psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding $false
  # An empty value removes the variable (an inherited one is never passed on).
  foreach ($k in $ChildEnv.Keys) {
    if ([string]$ChildEnv[$k]) { $psi.EnvironmentVariables[$k] = [string]$ChildEnv[$k] } else { $psi.EnvironmentVariables.Remove($k) }
  }
  # No BOM before the request (lib\live_docs.py's json.load rejects one), as the
  # coop-tools extension sends it (Node writes UTF-8 without one). pwsh 7 takes
  # StandardInputEncoding. .NET Framework (Windows PowerShell 5.1) has no such
  # property: its Process.Start wraps stdin in a writer on Console.InputEncoding
  # and flushes that encoding's preamble at once, so on a UTF-8 console the BOM
  # is in the pipe before anything is written. For the start only, the console
  # input encoding becomes UTF-8 without a preamble (same code page; restored).
  $noBom = New-Object System.Text.UTF8Encoding $false
  $restoreInput = $null
  if ($psi.PSObject.Properties['StandardInputEncoding']) {
    $psi.StandardInputEncoding = $noBom
  } else {
    try {
      $inputEncoding = [Console]::InputEncoding
      if ($inputEncoding.GetPreamble().Length -gt 0) { [Console]::InputEncoding = $noBom; $restoreInput = $inputEncoding }
    } catch { $restoreInput = $null }
  }
  try {
    $p = [System.Diagnostics.Process]::Start($psi)
  } finally {
    if ($null -ne $restoreInput) { try { [Console]::InputEncoding = $restoreInput } catch { } }
  }
  try {
    $outRead = $p.StandardOutput.ReadToEndAsync()
    $errRead = $p.StandardError.ReadToEndAsync()
    # The bytes themselves (the request is ASCII): no writer adds anything.
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($json)
    $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $p.StandardInput.BaseStream.Flush()
    $p.StandardInput.Close()
    if (-not $p.WaitForExit([Math]::Max(1, $TimeoutSeconds) * 1000)) {
      # The whole tree: Python's coop-data-doc child too (Neon B2).
      Stop-CoopDocsRefreshTree $p
      return @{ TimedOut = $true; Rc = -1; Data = $null }
    }
    # The answer, no longer than 15 s more: a grandchild still holding the pipe
    # must not hold the run past its cap (it is ended with the tree).
    $data = $null
    if (-not $outRead.Wait(15000)) {
      Stop-CoopDocsRefreshTree $p
      return @{ TimedOut = $false; Rc = $p.ExitCode; Data = $null }
    }
    try { $data = $outRead.Result | ConvertFrom-Json } catch { $data = $null }
    [void]$errRead
    return @{ TimedOut = $false; Rc = $p.ExitCode; Data = $data }
  } finally {
    $p.Dispose()
  }
}

# Stop a helper and every process under it. Windows: taskkill /T /F, as
# lib\fabric_request_headers.mjs does (Windows PowerShell 5.1's Kill() ends only
# the one process); elsewhere .NET's own tree kill (pwsh).
function Stop-CoopDocsRefreshTree($Process) {
  if ($env:OS -eq 'Windows_NT') {
    try {
      $k = New-Object System.Diagnostics.ProcessStartInfo
      $k.FileName = Join-Path $env:SystemRoot 'System32\taskkill.exe'
      $k.Arguments = '/PID ' + $Process.Id + ' /T /F'
      $k.WorkingDirectory = $env:SystemRoot
      $k.UseShellExecute = $false
      $k.CreateNoWindow = $true
      $k.RedirectStandardOutput = $true
      $k.RedirectStandardError = $true
      $kill = [System.Diagnostics.Process]::Start($k)
      [void]$kill.StandardOutput.ReadToEnd()
      [void]$kill.WaitForExit(15000)
      $kill.Dispose()
    } catch { }
  } else {
    try { $Process.Kill($true) } catch { }
  }
  try { if (-not $Process.HasExited) { $Process.Kill() } } catch { }
  try { [void]$Process.WaitForExit(5000) } catch { }
}

# The refresh's answer as one result code ('' when something was read).
function Get-CoopDocsRefreshReadCode($Data) {
  if ($null -eq $Data) { return 'snapshot_failed' }
  $state = [string]$Data.state
  $taken = 0
  try { $taken = [int]$Data.taken } catch { $taken = 0 }
  if (@('ok', 'partial') -contains $state -and $taken -gt 0) { return '' }
  $rows = @(@($Data.sources) | Where-Object { $_ })
  if (@('ok', 'partial', 'failed') -contains $state -or ($rows.Count -and $state -eq 'dev_is_prod')) {
    if ($state -eq 'dev_is_prod') { return 'dev_is_prod' }
    if ($rows.Count -and @($rows | Where-Object { $_.state -ne 'not_a_dev_target' }).Count -eq 0) { return 'no_dev_target' }
    if (@($rows | Where-Object { $_.state -eq 'tool_timeout' }).Count) { return 'timeout' }
    if (@($rows | Where-Object { $_.state -eq 'tool_unavailable' }).Count) { return 'tool_unavailable' }
    return 'snapshot_failed'
  }
  # Only a sign-in that failed is signin_needed: az says to sign in again, or it is another account.
  if (@('auth_required', 'identity_mismatch') -contains $state) { return 'signin_needed' }
  if (@('azure_cli_unavailable', 'token_launch_failed') -contains $state) { return 'azure_unavailable' }
  if (@('launch_identity_missing', 'token_timeout', 'token_command_failed', 'token_output_invalid') -contains $state) { return 'azure_failed' }
  if ($state -eq 'project_unavailable') { return 'no_project' }
  if ($state) { return $state }
  return 'snapshot_failed'
}

function Invoke-CoopDocsRefreshRun {
  param([string]$ProfileDir, [string]$From, [string]$Day)
  $started = Get-CoopDocsRefreshNow
  $limit = $script:DocsRefreshLimitSeconds
  # COOP_DOCS_REFRESH_LIMIT_SECONDS (the fixtures) can only shorten the cap.
  if ($env:COOP_DOCS_REFRESH_LIMIT_SECONDS) { try { $limit = [Math]::Min($script:DocsRefreshLimitSeconds, [Math]::Max(1, [int]$env:COOP_DOCS_REFRESH_LIMIT_SECONDS)) } catch { } }
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $state = [ordered]@{ day = $Day; from = $From; started = $started.ToString('o'); finished = ''; result = ''; detail = ''; files_changed = 0; objects_changed = 0; sources = @() }
  $finish = {
    param($Code)
    $state['result'] = $Code
    $state['finished'] = (Get-CoopDocsRefreshNow).ToString('o')
    return (Write-CoopDocsRefreshState $ProfileDir $state)
  }
  try {
    $coopRoot = Split-Path -Parent $PSScriptRoot
    . (Join-Path $coopRoot 'lib\common.ps1')
    $record = Get-CoopClientRecord
    $root = [string]$record.Root
    if (-not $root -or -not (Test-Path -LiteralPath $root -PathType Container)) { return (& $finish 'no_client') }
    $project = [string]$record.ProjectFile
    if (-not $project -or -not (Test-Path -LiteralPath $project -PathType Leaf)) { $project = Join-Path $root '.coop\project.yml' }
    if (-not (Test-Path -LiteralPath $project -PathType Leaf)) { return (& $finish 'no_project') }
    $config = ''
    foreach ($candidate in @((Join-Path $root 'coop-data-doc.yml'), (Join-Path (Split-Path -Parent (Split-Path -Parent $project)) 'coop-data-doc.yml'))) {
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { $config = $candidate; break }
    }
    if (-not $config) { return (& $finish 'no_docs_config') }
    $py = Get-CoopPython
    if (-not $py) { return (& $finish 'tool_unavailable') }
    $helper = Join-Path $coopRoot 'lib\live_docs.py'
    $cwd = Split-Path -Parent $config
    # No token from here: live_docs.py checks the docs config, the tool, the live
    # sources, the project file and its dev targets (dev_is_prod) first, and
    # mints the sign-in itself (mint) only when a real dev target needs it, from
    # the client folder's project file. An inherited one is never passed on.
    $childEnv = @{ COOP_PROJECT_YML = $project; COOP_FABRIC_MCP_TOKEN = ''; PYTHONIOENCODING = 'utf-8'; PYTHONUTF8 = '1' }
    $left = $limit - [int]$watch.Elapsed.TotalSeconds
    if ($left -le 0) { return (& $finish 'timeout') }
    $read = Invoke-CoopDocsRefreshHelper -Python $py -Helper $helper -Request ([ordered]@{ command = 'refresh'; config = $config; mint = $true }) -Cwd $cwd -ChildEnv $childEnv -TimeoutSeconds $left
    if ($read.TimedOut) { return (& $finish 'timeout') }
    $rows = @(@($read.Data.sources) | Where-Object { $_ } | ForEach-Object { [ordered]@{ name = [string]$_.name; state = [string]$_.state } })
    $state['sources'] = $rows
    $objects = 0
    foreach ($row in @(@($read.Data.sources) | Where-Object { $_ -and $_.changes })) {
      foreach ($word in @('added', 'changed', 'removed')) { $objects += @($row.changes.$word | Where-Object { $_ }).Count }
    }
    $state['objects_changed'] = $objects
    $code = Get-CoopDocsRefreshReadCode $read.Data
    if ($code) {
      # The helper's own answer, for the log.
      if ($read.Data) { $state['detail'] = [string]$read.Data.state + $(if ($read.Data.stage) { ' at ' + [string]$read.Data.stage } else { '' }) }
      return (& $finish $code)
    }
    $left = $limit - [int]$watch.Elapsed.TotalSeconds
    if ($left -le 0) { return (& $finish 'timeout') }
    $built = Invoke-CoopDocsRefreshHelper -Python $py -Helper $helper -Request ([ordered]@{ command = 'build'; config = $config; timeout_seconds = $left }) -Cwd $cwd -ChildEnv $childEnv -TimeoutSeconds ($left + 15)
    if ($built.TimedOut) { return (& $finish 'timeout') }
    $bstate = if ($built.Data) { [string]$built.Data.state } else { '' }
    if ($bstate -eq 'ok') {
      try { $state['files_changed'] = [int]$built.Data.files_changed } catch { }
      return (& $finish 'ok')
    }
    if ($bstate -eq 'tool_timeout') { return (& $finish 'timeout') }
    if ($bstate -eq 'tool_unavailable') { return (& $finish 'tool_unavailable') }
    $state['detail'] = if ($bstate) { $bstate } else { "no answer (exit $($built.Rc))" }
    return (& $finish 'build_failed')
  } catch {
    # Why, for the log (Neon nice-to-have 2).
    $state['detail'] = [string]$_.Exception.Message
    return (& $finish 'internal_error')
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  # Add-CoopUpdateLogLine: the log line cut to its newest half past 1 MB, shared with the update task.
  . (Join-Path $PSScriptRoot 'auto-update.ps1')
  $due = 0
  if (-not [long]::TryParse($WaiterDue, [ref]$due) -or $due -le 0 -or @('signin', 'coop') -notcontains $WaiterFrom) {
    Write-Output 'usage: docs-refresh.ps1 -WaiterFrom signin|coop -WaiterDue <unix seconds> [-WaiterTick]'
    exit 2
  }
  Write-Output (Invoke-CoopDocsRefreshWaiter -From $WaiterFrom -DueUnix $due -Tick:$WaiterTick)
  exit 0
}

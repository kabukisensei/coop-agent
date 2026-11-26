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
# tool. It reads the client folder from ~/.coop/client.json, sets
# COOP_PROJECT_YML to its project file, mints the tenant-pinned token
# (Get-CoopFabricMcpToken, lib\common.ps1; it never prompts) into the child's
# environment only, and runs lib\live_docs.py twice with stdin JSON: `refresh`
# (dev targets only; a dev entry that names production is refused, dev_is_prod)
# and, when something was read, `build` (coop-data-doc build into the docs
# folder, as the weekly refresh does, counting the files it changed). The whole
# run is capped at 20 minutes (timeout). The changed docs show in the Changes
# pane like any other change; nothing is committed. The result goes to
# ~/.coop/docs-refresh/state.json (its `line` is what doctor and the next
# session start show) and ~/.coop/logs/docs-refresh.log (under 1 MB).
#
# Windows PowerShell 5.1 syntax. Dot-sourcing this file defines the functions and
# runs nothing (sign-in.ps1 and lib\common.ps1 do that).
#
# Test seams (the fixtures only): COOP_DOCS_REFRESH_CLOCK names a file holding a
# number of seconds added to the clock; COOP_DOCS_REFRESH_POLL_MS is the
# waiter's poll interval (default 30 s); COOP_DOCS_REFRESH_LIMIT_SECONDS
# shortens the 20 minute cap; COOP_BUILTIN_POWERSHELL replaces the built-in
# powershell.exe; -WaiterTick makes the waiter look once and report instead of
# sleeping.
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
function Get-CoopBuiltinPowerShell {
  if ($env:COOP_BUILTIN_POWERSHELL) { return [string]$env:COOP_BUILTIN_POWERSHELL }
  if ($env:OS -eq 'Windows_NT') { return (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') }
  return (Get-Process -Id $PID).Path
}

# --- the starters ----------------------------------------------------------------------
# A waiter is waiting: the pid it recorded is a running PowerShell, or, before it
# recorded one, the starter's note is under two minutes old.
function Test-CoopDocsRefreshPendingLive($Pending, [datetime]$Now) {
  if ($null -eq $Pending) { return $false }
  $procId = 0
  try { $procId = [int]$Pending.pid } catch { $procId = 0 }
  if ($procId -gt 0) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    return [bool]($p -and $p.ProcessName -match '^(powershell|pwsh)')
  }
  $written = 0
  try { $written = [long]$Pending.written } catch { $written = 0 }
  return (((ConvertTo-CoopDocsRefreshUnix $Now) - $written) -lt 120)
}

# Schedule today's run from one starter ('signin' or 'coop'), due 20 minutes
# after -StartedAt. Returns 'off' (the switch is off: nothing else ran),
# 'done' (today's run is claimed), 'pending' (a waiter is already waiting; it
# takes this due when earlier) or 'started'. Never throws.
function Start-CoopDocsRefresh {
  param([string]$ProfileDir, [string]$From, [datetime]$StartedAt)
  if (-not (Test-CoopDocsRefreshOn $ProfileDir)) { return 'off' }
  try {
    $now = Get-CoopDocsRefreshNow
    # The time since -StartedAt (the sign-in's update wait, coop's own start) counts toward the 20 minutes.
    $due = $now.AddMinutes($script:DocsRefreshDelayMinutes).Add(-((Get-Date) - $StartedAt))
    $dueUnix = ConvertTo-CoopDocsRefreshUnix $due
    $dir = Get-CoopDocsRefreshDir $ProfileDir
    if (Test-Path -LiteralPath (Join-Path $dir ('day-' + (Get-CoopDocsRefreshDay $due))) -PathType Leaf) { return 'done' }
    $pendingFile = Join-Path $dir 'pending.json'
    $pending = Read-CoopDocsRefreshJson $pendingFile
    if (Test-CoopDocsRefreshPendingLive $pending $now) {
      # Whichever comes first: hand the waiter this due when it is earlier.
      $theirs = 0
      try { $theirs = [long]$pending.due } catch { $theirs = 0 }
      if ($theirs -gt $dueUnix) {
        Write-CoopDocsRefreshJson $pendingFile ([ordered]@{ pid = $pending.pid; due = $dueUnix; from = $From; written = $pending.written })
      }
      return 'pending'
    }
    if (Test-Path -LiteralPath $pendingFile -PathType Leaf) {
      # Another starter is writing its note right now, or a waiter that is gone left it.
      $item = Get-Item -LiteralPath $pendingFile -Force -ErrorAction SilentlyContinue
      if ($item -and ((Get-Date) - $item.LastWriteTime).TotalSeconds -lt 10) { return 'pending' }
      Remove-Item -LiteralPath $pendingFile -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    # Create-new: of two coops starting at once, one writes the note and starts the waiter.
    $note = ConvertTo-Json -Compress -InputObject ([ordered]@{ pid = 0; due = $dueUnix; from = $From; written = (ConvertTo-CoopDocsRefreshUnix $now) })
    try {
      $fs = [System.IO.File]::Open($pendingFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
      try { $bytes = (New-Object System.Text.UTF8Encoding $false).GetBytes($note); $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Close() }
    } catch { return 'pending' }
    $script = Join-Path $PSScriptRoot 'docs-refresh.ps1'
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    # The waiter's folder is the profile, never coop's install folder (an open
    # folder there would hold up the installer).
    $psi.WorkingDirectory = $ProfileDir
    # [System.Diagnostics.Process] directly: Start-Process costs a cold
    # PowerShell up to a second, which a launch would wait for.
    if ($env:OS -eq 'Windows_NT') {
      # ShellExecute: a hidden window of its own, no handle inherited from this
      # console (the window's launcher reads this console's output).
      $psi.FileName = Get-CoopBuiltinPowerShell
      $psi.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '" -WaiterFrom ' + $From + ' -WaiterDue ' + $dueUnix
      $psi.UseShellExecute = $true
      $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
      $p = [System.Diagnostics.Process]::Start($psi)
      try { if ($p) { $p.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal } } catch { }
    } else {
      # A developer box: sh puts the waiter in the background with its own
      # output files, so no pipe reading this console stays open until it ends.
      $psi.FileName = '/bin/sh'
      foreach ($a in @('-c', 'exec "$0" "$@" </dev/null >>"$DR_OUT" 2>&1 &', (Get-CoopBuiltinPowerShell), '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $script, '-WaiterFrom', $From, '-WaiterDue', [string]$dueUnix)) { $psi.ArgumentList.Add($a) }
      $psi.Environment['DR_OUT'] = Join-Path $dir 'waiter.log'
      $psi.UseShellExecute = $false
      $p = [System.Diagnostics.Process]::Start($psi)
      [void]$p.WaitForExit(5000)
    }
    return 'started'
  } catch {
    return 'pending'
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
  $poll = 30000
  if ($env:COOP_DOCS_REFRESH_POLL_MS) { try { $poll = [Math]::Max(10, [int]$env:COOP_DOCS_REFRESH_POLL_MS) } catch { } }
  $due = ConvertFrom-CoopDocsRefreshUnix $DueUnix
  $mine = $false
  if (-not $Tick) {
    # Record this waiter, keeping an earlier due another starter handed over.
    $pending = Read-CoopDocsRefreshJson $pendingFile
    try { if ($pending -and [long]$pending.due -lt $DueUnix -and [long]$pending.due -gt 0) { $due = ConvertFrom-CoopDocsRefreshUnix ([long]$pending.due) } } catch { }
    try { Write-CoopDocsRefreshJson $pendingFile ([ordered]@{ pid = $PID; due = (ConvertTo-CoopDocsRefreshUnix $due); from = $From; written = (ConvertTo-CoopDocsRefreshUnix (Get-CoopDocsRefreshNow)) }); $mine = $true } catch { }
    Write-CoopDocsRefreshLog $profileDir ("waiting: started at $From, due " + $due.ToString('yyyy-MM-dd HH:mm', [System.Globalization.CultureInfo]::InvariantCulture))
  }
  try {
    while ($true) {
      $now = Get-CoopDocsRefreshNow
      if ($mine) {
        $pending = Read-CoopDocsRefreshJson $pendingFile
        try { if ($pending -and [int]$pending.pid -eq $PID -and [long]$pending.due -lt (ConvertTo-CoopDocsRefreshUnix $due)) { $due = ConvertFrom-CoopDocsRefreshUnix ([long]$pending.due) } } catch { }
      }
      if (-not (Test-CoopDocsRefreshOn $profileDir)) { Write-CoopDocsRefreshLog $profileDir 'the feature was switched off; nothing ran'; return 'off' }
      if (Test-Path -LiteralPath (Join-Path $dir ('day-' + (Get-CoopDocsRefreshDay $now))) -PathType Leaf) { return 'done' }
      if ($now.Date -gt $due.Date) {
        # Asleep past midnight: that day's run, 20 minutes after waking.
        $due = $now.AddMinutes($script:DocsRefreshDelayMinutes)
        if ($mine) { try { Write-CoopDocsRefreshJson $pendingFile ([ordered]@{ pid = $PID; due = (ConvertTo-CoopDocsRefreshUnix $due); from = $From; written = (ConvertTo-CoopDocsRefreshUnix $now) }) } catch { } }
        Write-CoopDocsRefreshLog $profileDir ('the computer was asleep past midnight; today''s refresh is due ' + $due.ToString('HH:mm', [System.Globalization.CultureInfo]::InvariantCulture))
      } elseif ($now -ge $due) {
        if (-not (Test-CoopDocsRefreshUpdateRunning $now)) { break }
        if ($now -ge $due.AddMinutes($script:DocsRefreshUpdateWaitMinutes)) {
          Write-CoopDocsRefreshState $profileDir ([ordered]@{ day = (Get-CoopDocsRefreshDay $now); from = $From; started = $now.ToString('o'); finished = $now.ToString('o'); result = 'update_running'; files_changed = 0; objects_changed = 0; sources = @() })
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
    Write-CoopDocsRefreshLog $profileDir ([string]$state.line)
    return [string]$state.result
  } finally {
    if ($mine) {
      $pending = Read-CoopDocsRefreshJson $pendingFile
      try { if ($null -eq $pending -or [int]$pending.pid -eq $PID) { Remove-Item -LiteralPath $pendingFile -Force -ErrorAction SilentlyContinue } } catch { }
    }
  }
}

# --- the run ---------------------------------------------------------------------------
# What a result code means, for the status line.
function Get-CoopDocsRefreshReason([string]$Code) {
  switch ($Code) {
    'no_client' { return 'no client folder is recorded (open coop in the client folder once)' }
    'no_project' { return 'the client folder has no .coop/project.yml (/setup-project makes one)' }
    'no_docs_config' { return 'the client folder has no coop-data-doc.yml (/setup-docs makes one)' }
    'no_live_sources' { return 'the docs are not set up to read the dev database (/setup-docs live)' }
    'no_dev_target' { return 'the project file names no ready dev SQL target' }
    'dev_is_prod' { return 'the dev target names a production database, which is never read' }
    'tool_unavailable' { return 'coop-data-doc or Python is not installed (run coop doctor)' }
    'signin_needed' { return 'the Azure sign-in expired (open coop to sign in)' }
    'timeout' { return 'it did not finish within 20 minutes' }
    'snapshot_failed' { return 'the dev database could not be read (run /setup-docs refresh for the reason)' }
    'build_failed' { return 'the docs did not rebuild (run coop data-doc build for the reason)' }
    'config_unreadable' { return 'coop-data-doc.yml could not be read' }
    'update_running' { return 'a coop update was installing' }
  }
  return "it stopped ($Code)"
}
# The one line doctor and the next session start show.
function Get-CoopDocsRefreshLine($State) {
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
  if ($code -eq 'update_running') { return "Docs refresh waited for a coop update ($code); it runs at the next sign-in or coop start." }
  $reason = Get-CoopDocsRefreshReason $code
  if (@('no_client', 'no_project', 'no_docs_config', 'no_live_sources', 'no_dev_target', 'dev_is_prod', 'tool_unavailable') -contains $code) {
    return "Docs refresh skipped $($at): $reason ($code)."
  }
  return "Docs refresh failed $($at): $reason ($code). It runs again tomorrow; /setup-docs refresh runs it now."
}

function Write-CoopDocsRefreshState([string]$ProfileDir, $State) {
  $full = [ordered]@{ schema_version = 1 }
  foreach ($k in $State.Keys) { $full[$k] = $State[$k] }
  $full['line'] = Get-CoopDocsRefreshLine ([pscustomobject]$full)
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
  foreach ($k in $ChildEnv.Keys) { $psi.EnvironmentVariables[$k] = [string]$ChildEnv[$k] }
  $p = [System.Diagnostics.Process]::Start($psi)
  $outRead = $p.StandardOutput.ReadToEndAsync()
  $errRead = $p.StandardError.ReadToEndAsync()
  $p.StandardInput.Write($json)
  $p.StandardInput.Close()
  if (-not $p.WaitForExit([Math]::Max(1, $TimeoutSeconds) * 1000)) {
    try { $p.Kill() } catch { }
    return @{ TimedOut = $true; Rc = -1; Data = $null }
  }
  $p.WaitForExit()
  $data = $null
  try { $data = $outRead.Result | ConvertFrom-Json } catch { $data = $null }
  [void]$errRead
  return @{ TimedOut = $false; Rc = $p.ExitCode; Data = $data }
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
  if (@('launch_identity_missing', 'auth_required', 'identity_mismatch', 'azure_cli_unavailable', 'token_launch_failed', 'token_timeout', 'token_command_failed', 'token_output_invalid') -contains $state) { return 'signin_needed' }
  if ($state -eq 'project_unavailable') { return 'no_project' }
  if ($state) { return $state }
  return 'snapshot_failed'
}

function Invoke-CoopDocsRefreshRun {
  param([string]$ProfileDir, [string]$From, [string]$Day)
  $started = Get-CoopDocsRefreshNow
  $limit = $script:DocsRefreshLimitSeconds
  if ($env:COOP_DOCS_REFRESH_LIMIT_SECONDS) { try { $limit = [Math]::Max(1, [int]$env:COOP_DOCS_REFRESH_LIMIT_SECONDS) } catch { } }
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $state = [ordered]@{ day = $Day; from = $From; started = $started.ToString('o'); finished = ''; result = ''; files_changed = 0; objects_changed = 0; sources = @() }
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
    # As lib\data-doc-setup.mjs hasLiveSources reads it: a live_sources block with entries.
    if ([System.IO.File]::ReadAllText($config) -notmatch '(?m)^live_sources\s*:\s*(#.*)?\r?\n[ \t]+\S') { return (& $finish 'no_live_sources') }
    $py = Get-CoopPython
    if (-not $py) { return (& $finish 'tool_unavailable') }
    $env:COOP_PROJECT_YML = $project
    # Minted without a prompt; '' when the az CLI cache cannot give one.
    $token = Get-CoopFabricMcpToken
    if (-not $token) { return (& $finish 'signin_needed') }
    $helper = Join-Path $coopRoot 'lib\live_docs.py'
    $cwd = Split-Path -Parent $config
    $childEnv = @{ COOP_PROJECT_YML = $project; COOP_FABRIC_MCP_TOKEN = $token; PYTHONIOENCODING = 'utf-8'; PYTHONUTF8 = '1' }
    $left = $limit - [int]$watch.Elapsed.TotalSeconds
    if ($left -le 0) { return (& $finish 'timeout') }
    $read = Invoke-CoopDocsRefreshHelper -Python $py -Helper $helper -Request ([ordered]@{ command = 'refresh'; config = $config }) -Cwd $cwd -ChildEnv $childEnv -TimeoutSeconds $left
    if ($read.TimedOut) { return (& $finish 'timeout') }
    $rows = @(@($read.Data.sources) | Where-Object { $_ } | ForEach-Object { [ordered]@{ name = [string]$_.name; state = [string]$_.state } })
    $state['sources'] = $rows
    $objects = 0
    foreach ($row in @(@($read.Data.sources) | Where-Object { $_ -and $_.changes })) {
      foreach ($word in @('added', 'changed', 'removed')) { $objects += @($row.changes.$word | Where-Object { $_ }).Count }
    }
    $state['objects_changed'] = $objects
    $code = Get-CoopDocsRefreshReadCode $read.Data
    if ($code) { return (& $finish $code) }
    $left = $limit - [int]$watch.Elapsed.TotalSeconds
    if ($left -le 0) { return (& $finish 'timeout') }
    # The token is not needed to build: only the read got it.
    $buildEnv = @{ COOP_PROJECT_YML = $project; PYTHONIOENCODING = 'utf-8'; PYTHONUTF8 = '1'; COOP_FABRIC_MCP_TOKEN = '' }
    $built = Invoke-CoopDocsRefreshHelper -Python $py -Helper $helper -Request ([ordered]@{ command = 'build'; config = $config; timeout_seconds = $left }) -Cwd $cwd -ChildEnv $buildEnv -TimeoutSeconds ($left + 15)
    if ($built.TimedOut) { return (& $finish 'timeout') }
    $bstate = if ($built.Data) { [string]$built.Data.state } else { '' }
    if ($bstate -eq 'ok') {
      try { $state['files_changed'] = [int]$built.Data.files_changed } catch { }
      return (& $finish 'ok')
    }
    if ($bstate -eq 'tool_timeout') { return (& $finish 'timeout') }
    if ($bstate -eq 'tool_unavailable') { return (& $finish 'tool_unavailable') }
    return (& $finish 'build_failed')
  } catch {
    return (& $finish 'internal_error')
  } finally {
    Remove-Item Env:COOP_FABRIC_MCP_TOKEN -ErrorAction SilentlyContinue
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

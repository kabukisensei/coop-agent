#!/usr/bin/env pwsh
# Daily lineage refresh (FEATURES-DESIGN CW6), extended lane (process fixture:
# real detached waiters that poll a fake clock, so it waits on background
# processes, which docs/ci.md keeps out of the gate lane). The real sign-in script
# and the real launcher start the real waiter (scripts\docs-refresh.ps1) through
# the built-in powershell.exe stand-in, which runs it; the run's tools are the
# fakes of _docs-refresh.ps1.
#   - sign-in alone: the waiter outlives the sign-in script and runs once at 21 minutes;
#   - coop closed before the 20 minutes: its waiter still runs once;
#   - two coops started at once: one run, every waiter gone afterwards;
#   - two waiters due at the same moment race for the day's claim: one run;
#   - whichever comes first, live: a waiter already polling takes a later
#     starter's earlier due (earlier.json) and runs then;
#   - the computer asleep past midnight: no run on waking; today's run 20 minutes later;
#   - the 20 minute cap: a read that hangs ends as timeout, and its process and
#     the child it started (coop-data-doc's place) are both stopped (Neon B2).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
. (Join-Path $PSScriptRoot '_docs-refresh.ps1') -Forward
$env:COOP_DOCS_REFRESH_POLL_MS = '100'
try {
  function Get-DrWaiterLog { return @(Read-DrJsonLines ($env:COOP_TEST_DR_CALLS + '.waiters')) }
  function Get-DrLiveWaiters {
    $log = @(Get-DrWaiterLog)
    $ended = @($log | Where-Object { $_.PSObject.Properties['exit'] } | ForEach-Object { [int]$_.exit })
    return @($log | Where-Object { $_.PSObject.Properties['pid'] -and $ended -notcontains [int]$_.pid } | ForEach-Object { [int]$_.pid })
  }
  # Wait (at most $Seconds) for the condition; true when it held.
  function Wait-Dr([scriptblock]$Condition, [int]$Seconds = 30) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) { if (& $Condition) { return $true }; Start-Sleep -Milliseconds 100 }
    return [bool](& $Condition)
  }
  function Get-DrRefreshCount { return @(Get-DrHelperCalls | Where-Object { $_.request.command -ceq 'refresh' }).Count }
  function Test-DrWaiting { $p = Get-DrPending; return [bool]($p -and [int]$p.pid -gt 0 -and (Get-Process -Id ([int]$p.pid) -ErrorAction SilentlyContinue)) }

  Set-DrFeature 'on'

  # --- sign-in alone ------------------------------------------------------------------------
  $r = Invoke-DrSignIn
  $waiting = Wait-Dr { Test-DrWaiting } 30
  Start-Sleep -Seconds 1
  $early = (Get-DrRefreshCount) -eq 0 -and -not (Test-Path -LiteralPath $drState)
  if ($r.Rc -eq 0 -and $waiting -and $early) { Ok 'sign-in: the waiter is running after the sign-in script ended, and nothing ran before the due time' } else { Ko "sign-in waiter: waiting=$waiting early=$early" $r.Out }
  Set-DrClock (21 * 60)
  $ran = Wait-Dr { (Get-DrStateDoc) -and (@(Get-DrLiveWaiters).Count -eq 0) } 60
  $state = Get-DrStateDoc
  if ($ran -and $state.result -ceq 'ok' -and $state.from -ceq 'signin' -and (Get-DrRefreshCount) -eq 1 -and $null -eq (Get-DrPending)) { Ok 'at 21 minutes the detached waiter ran once and exited' } else { Ko "sign-in run: ran=$ran result=$($state.result) refreshes=$(Get-DrRefreshCount)" }

  # --- coop closed before the 20 minutes ----------------------------------------------------------
  Set-DrClock 86400
  $r = Invoke-DrCoop
  $waiting = Wait-Dr { Test-DrWaiting } 30
  Set-DrClock (86400 + 21 * 60)
  $ran = Wait-Dr { (Get-DrRefreshCount) -eq 2 -and @(Get-DrLiveWaiters).Count -eq 0 } 60
  if ($r.Rc -eq 0 -and $waiting -and $ran -and (Get-DrStateDoc).from -ceq 'coop') { Ok 'coop closed before the 20 minutes: its waiter kept waiting and ran once' } else { Ko "coop closed early: waiting=$waiting ran=$ran" $r.Out }

  # --- two coops started at once ------------------------------------------------------------------
  Set-DrClock (2 * 86400)
  $in = Join-Path $t 'two.in'
  [System.IO.File]::WriteAllText($in, '')
  $argList = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $coop + '"'), '-p', '"say hi"')
  $procs = @(1, 2 | ForEach-Object { Start-Process -FilePath $psExe -ArgumentList $argList -WorkingDirectory $t -PassThru -NoNewWindow -RedirectStandardInput $in -RedirectStandardOutput (Join-Path $t "two$_.out") -RedirectStandardError (Join-Path $t "two$_.err") })
  foreach ($p in $procs) { $null = $p.Handle; $p.WaitForExit() }
  $null = Wait-Dr { Test-DrWaiting } 30
  Set-DrClock (2 * 86400 + 21 * 60)
  $ran = Wait-Dr { (Get-DrRefreshCount) -ge 3 -and @(Get-DrLiveWaiters).Count -eq 0 } 60
  Start-Sleep -Seconds 1
  if ($ran -and (Get-DrRefreshCount) -eq 3) { Ok "two coops at once: $(@(Get-DrWaiterLog | Where-Object { $_.PSObject.Properties['pid'] }).Count - 2) waiter(s) for that day, one run, every waiter gone" } else { Ko "two coops at once: ran=$ran refreshes=$(Get-DrRefreshCount) live=$(@(Get-DrLiveWaiters) -join ',')" }

  # --- two waiters race for the day's claim ---------------------------------------------------------
  $day = 2 * 86400 + 86400 + 3600 * 5
  Set-DrClock $day
  $due = [string]([System.DateTimeOffset](Get-DrNow).AddMinutes(-1)).ToUnixTimeSeconds()
  $before = Get-DrRefreshCount
  $racers = @(1, 2 | ForEach-Object {
    Start-Process -FilePath $psExe -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $drScript + '"'), '-WaiterFrom', 'coop', '-WaiterDue', $due) -WorkingDirectory $drProfile -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $t "race$_.out") -RedirectStandardError (Join-Path $t "race$_.err")
  })
  foreach ($p in $racers) { $null = $p.Handle; $p.WaitForExit() }
  $outcomes = @(1, 2 | ForEach-Object { ([System.IO.File]::ReadAllText((Join-Path $t "race$_.out"))).Trim() } | Sort-Object)
  if ((Get-DrRefreshCount) -eq $before + 1 -and ($outcomes -join ',') -ceq 'done,ok') { Ok 'two waiters due at once race for the day''s claim: one run (ok), the other finds the day claimed (done)' } else { Ko "claim race: $($outcomes -join ',') with $((Get-DrRefreshCount) - $before) runs" }
  Remove-Item -LiteralPath (Join-Path $drDir 'pending.json') -Force -ErrorAction SilentlyContinue

  # --- whichever comes first, to a waiter already polling ------------------------------------------
  $day = 2 * 86400 + 2 * 86400 + 3600 * 5
  Set-DrClock $day
  $before = Get-DrRefreshCount
  $null = Invoke-DrCoop
  $waiting = Wait-Dr { Test-DrWaiting } 30
  $handed = (Invoke-Native { & $psExe -NoProfile -Command ". '$($drScript -replace "'", "''")'; Start-CoopDocsRefresh -ProfileDir '$($drProfile -replace "'", "''")' -From signin -StartedAt (Get-Date).AddMinutes(-12)" 2>&1 } | Out-String).Trim()
  Set-DrClock ($day + 9 * 60)
  $ran = Wait-Dr { (Get-DrRefreshCount) -eq $before + 1 -and @(Get-DrLiveWaiters).Count -eq 0 } 60
  $state = Get-DrStateDoc
  if ($waiting -and $handed -ceq 'pending' -and $ran -and $state.from -ceq 'coop' -and -not (Test-Path -LiteralPath (Join-Path $drDir 'earlier.json'))) { Ok 'whichever comes first, live: the polling coop waiter took the sign-in''s earlier due and ran at 9 minutes' } else { Ko "live handover: waiting=$waiting handed=$handed ran=$ran from=$($state.from)" }
  Remove-Item -LiteralPath (Join-Path $drDir 'pending.json') -Force -ErrorAction SilentlyContinue

  # --- asleep past midnight ---------------------------------------------------------------------
  $day = 5 * 86400
  Set-DrClock $day
  $before = Get-DrRefreshCount
  $null = Invoke-DrCoop
  $null = Wait-Dr { Test-DrWaiting } 30
  Set-DrClock ($day + 86400 + 2 * 3600)
  $moved = Wait-Dr { $p = Get-DrPending; $p -and [long]$p.due -gt ([System.DateTimeOffset](Get-DrNow)).ToUnixTimeSeconds() + 19 * 60 } 15
  $noRun = (Get-DrRefreshCount) -eq $before
  Set-DrClock ($day + 86400 + 2 * 3600 + 21 * 60)
  $ran = Wait-Dr { (Get-DrRefreshCount) -eq $before + 1 -and @(Get-DrLiveWaiters).Count -eq 0 } 60
  if ($moved -and $noRun -and $ran -and (Get-DrStateDoc).day -ceq (Get-DrDay ($day + 86400))) { Ok 'asleep past midnight: no run on waking; that day''s run 20 minutes later, claimed for that day' } else { Ko "asleep: moved=$moved noRun=$noRun ran=$ran day=$((Get-DrStateDoc).day)" }

  # --- the 20 minute cap ------------------------------------------------------------------------
  Set-DrClock (8 * 86400)
  $env:COOP_DOCS_REFRESH_LIMIT_SECONDS = '2'
  $env:COOP_TEST_DR_SLEEP = '60'
  $grandFile = Join-Path $t 'grandchild.pid'
  $env:COOP_TEST_DR_GRANDCHILD = $grandFile
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  try { $w = Invoke-DrWaiter @('-WaiterFrom', 'coop', '-WaiterDue', [string]([System.DateTimeOffset](Get-DrNow).AddMinutes(-1)).ToUnixTimeSeconds()) } finally { Remove-Item Env:COOP_DOCS_REFRESH_LIMIT_SECONDS; Remove-Item Env:COOP_TEST_DR_SLEEP; Remove-Item Env:COOP_TEST_DR_GRANDCHILD }
  $took = $watch.Elapsed.TotalSeconds
  $hung = @(Get-DrHelperCalls)[-1]
  $grandPid = 0
  try { $grandPid = [int]([System.IO.File]::ReadAllText($grandFile).Trim()) } catch { $grandPid = 0 }
  $gone = Wait-Dr { -not (Get-Process -Id ([int]$hung.pid) -ErrorAction SilentlyContinue) } 5
  # A zombie (killed, not yet reaped) counts as gone: /proc/<pid>/stat says Z.
  $grandGone = $grandPid -gt 0 -and (Wait-Dr { $g = Get-Process -Id $grandPid -ErrorAction SilentlyContinue; (-not $g) -or ((Test-Path "/proc/$grandPid/stat") -and ((Get-Content "/proc/$grandPid/stat" -Raw -ErrorAction SilentlyContinue) -match '^\d+ \(.*\) Z')) } 5)
  $state = Get-DrStateDoc
  if ($w.Outcome -ceq 'timeout' -and $took -lt 20 -and $gone -and $grandGone -and ([string]$state.line) -match '^Docs refresh failed 09:00: It did not finish within 20 minutes\. Check the network or VPN; the log is .+docs-refresh\.log\. It runs again tomorrow\.$') { Ok "the cap: a hung read ends as timeout ($([int]$took) s with a 2 s cap); the helper and the child it started are both stopped" } else { Ko "timeout: $($w.Outcome) in $took s, helper gone=$gone, child $grandPid gone=$grandGone, line $($state.line)" $w.Out }
  if ($grandPid -gt 0) { Stop-Process -Id $grandPid -Force -ErrorAction SilentlyContinue }
} finally {
  foreach ($procId in @(Get-DrLiveWaiters)) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue }
  Restore-Env $drSaved
  Start-Sleep -Milliseconds 300
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
exit $fail

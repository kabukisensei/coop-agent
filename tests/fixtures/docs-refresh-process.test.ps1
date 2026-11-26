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
#   - the computer asleep past midnight: no run on waking; today's run 20 minutes later;
#   - the 20 minute cap: a read that hangs ends as timeout and its process is stopped.
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

  # --- asleep past midnight ---------------------------------------------------------------------
  $day = 3 * 86400
  Set-DrClock $day
  $null = Invoke-DrCoop
  $null = Wait-Dr { Test-DrWaiting } 30
  Set-DrClock ($day + 86400 + 2 * 3600)
  $moved = Wait-Dr { $p = Get-DrPending; $p -and [long]$p.due -gt ([System.DateTimeOffset](Get-DrNow)).ToUnixTimeSeconds() + 19 * 60 } 15
  $noRun = (Get-DrRefreshCount) -eq 3
  Set-DrClock ($day + 86400 + 2 * 3600 + 21 * 60)
  $ran = Wait-Dr { (Get-DrRefreshCount) -eq 4 -and @(Get-DrLiveWaiters).Count -eq 0 } 60
  if ($moved -and $noRun -and $ran -and (Get-DrStateDoc).day -ceq (Get-DrDay ($day + 86400))) { Ok 'asleep past midnight: no run on waking; that day''s run 20 minutes later, claimed for that day' } else { Ko "asleep: moved=$moved noRun=$noRun ran=$ran day=$((Get-DrStateDoc).day)" }

  # --- the 20 minute cap ------------------------------------------------------------------------
  Set-DrClock (6 * 86400)
  $env:COOP_DOCS_REFRESH_LIMIT_SECONDS = '2'
  $env:COOP_TEST_DR_SLEEP = '30'
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  try { $w = Invoke-DrWaiter @('-WaiterFrom', 'coop', '-WaiterDue', [string]([System.DateTimeOffset](Get-DrNow).AddMinutes(-1)).ToUnixTimeSeconds()) } finally { Remove-Item Env:COOP_DOCS_REFRESH_LIMIT_SECONDS; Remove-Item Env:COOP_TEST_DR_SLEEP }
  $took = $watch.Elapsed.TotalSeconds
  $hung = @(Get-DrHelperCalls)[-1]
  $gone = Wait-Dr { -not (Get-Process -Id ([int]$hung.pid) -ErrorAction SilentlyContinue) } 5
  $state = Get-DrStateDoc
  if ($w.Outcome -ceq 'timeout' -and $took -lt 20 -and $gone -and ([string]$state.line) -match '^Docs refresh failed 09:00: it did not finish within 20 minutes \(timeout\)') { Ok "the cap: a hung read ends as timeout ($([int]$took) s with a 2 s cap) and its process is stopped" } else { Ko "timeout: $($w.Outcome) in $took s, gone=$gone" $w.Out }
} finally {
  foreach ($procId in @(Get-DrLiveWaiters)) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue }
  Restore-Env $drSaved
  Start-Sleep -Milliseconds 300
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
exit $fail

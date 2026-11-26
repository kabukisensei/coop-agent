#!/usr/bin/env pwsh
# Daily lineage refresh (FEATURES-DESIGN CW6), gate lane: the real sign-in script
# (scripts\sign-in.ps1) and the real launcher (`coop -p hi` with a fake Pi) start
# the waiter through a recorder that stands in for the built-in powershell.exe;
# the fixture then runs each recorded waiter itself, to its end, against a fake
# clock (nothing sleeps, polls or waits in the background: the process cases are
# in docs-refresh-process.test.ps1, extended lane). The run's tools are fakes
# (_docs-refresh.ps1): the token helper and lib\live_docs.py answer from a
# sitecustomize.py, and record every request.
#   - off: sign-in and coop start nothing new (the recorder's calls are counted),
#     write nothing, and no docs-refresh folder appears;
#   - sign-in alone, coop alone (coop closed before the 20 minutes), both
#     together: one run each, 20 minutes after the start, never before;
#     a run already done today: none; the next day: a second run;
#   - whichever comes first: a later starter hands an earlier due to the waiter;
#   - the computer asleep past midnight: no run on waking, today's is rescheduled;
#   - a coop update installing: waits, then update_running without claiming;
#   - skip codes (no client, no docs config, no live sources, sign-in needed,
#     dev_is_prod, no dev target, tool unavailable), a failed run not retried;
#   - doctor's row and the state's one line.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
. (Join-Path $PSScriptRoot '_docs-refresh.ps1')
try {
  function Flat([string]$Text) { return (($Text -replace '\s+', ' ').Trim()) }

  # --- off: exactly today ------------------------------------------------------------------
  $r = Invoke-DrSignIn
  $calls = @(Get-DrCalls)
  $kinds = @($calls | ForEach-Object { $a = @($_); if ($a -contains '-Command') { 'azure' } elseif (@($a | Where-Object { ([string]$_).EndsWith('coop-desktop.ps1') }).Count) { 'window' } elseif ($a -contains 'update') { 'update' } else { 'other: ' + ($a -join ' ') } })
  if ($r.Rc -eq 0 -and ($kinds -join ',') -ceq 'update,azure,window' -and (Flat $r.Out) -notmatch 'lineage refresh') { Ok 'off, sign-in: the same three starts as before (update, Azure check, window), no refresh line' } else { Ko "off, sign-in (rc=$($r.Rc)): $($kinds -join ', ')" $r.Out }
  $r = Invoke-DrCoop
  if ($r.Rc -eq 0 -and @(Get-DrCalls).Count -eq 3) { Ok 'off, coop start: no start of the built-in powershell.exe' } else { Ko "off, coop start (rc=$($r.Rc)): $(@(Get-DrCalls).Count) starts" $r.Out }
  # A config with other features on and docs_refresh false is off too.
  [System.IO.File]::WriteAllText((Join-Path $drProfile 'config'), '{"features":{"comments":true,"docs_refresh":false}}', $utf8)
  $null = Invoke-DrSignIn
  $null = Invoke-DrCoop
  $noWaiter = (@(Get-DrWaiterCalls).Count -eq 0) -and (@(Get-DrCalls).Count -eq 6)
  if ($noWaiter -and -not (Test-Path -LiteralPath $drDir) -and -not (Test-Path -LiteralPath (Join-Path $drProfile 'logs\docs-refresh.log')) -and @(Get-DrHelperCalls).Count -eq 0) { Ok 'off (docs_refresh false): no waiter, no docs-refresh folder, no log, no live_docs.py call' } else { Ko 'off wrote or started something' ((Get-DrCalls | ForEach-Object { @($_) -join ' ' }) -join "`n") }

  # --- on, sign-in alone -----------------------------------------------------------------------
  Set-DrFeature 'on'
  $before = Get-DrNow
  $r = Invoke-DrSignIn
  $after = Get-DrNow
  $waiters = @(Get-DrWaiterCalls)
  $due = if ($waiters.Count) { ConvertFrom-DrUnix ([long](Get-DrArg $waiters[0] '-WaiterDue')) } else { [datetime]::MinValue }
  $inWindow = ($due -ge $before.AddMinutes(20).AddSeconds(-2)) -and ($due -le $after.AddMinutes(20).AddSeconds(2))
  if ($waiters.Count -eq 1 -and (Get-DrArg $waiters[0] '-WaiterFrom') -ceq 'signin' -and $inWindow -and (Flat $r.Out) -match 'daily lineage refresh: scheduled 20 minutes after sign-in') { Ok 'sign-in: one hidden waiter, due 20 minutes after the sign-in started' } else { Ko "sign-in waiter: $($waiters.Count) starts, due $due" $r.Out }
  $signinWaiter = $waiters[0]
  $w = Invoke-DrRecordedWaiter $signinWaiter -Tick
  Set-DrClock (19 * 60)
  $w2 = Invoke-DrRecordedWaiter $signinWaiter -Tick
  if ($w.Outcome -ceq 'waiting' -and $w2.Outcome -ceq 'waiting' -and @(Get-DrHelperCalls).Count -eq 0 -and -not (Test-Path -LiteralPath (Join-Path $drDir ('day-' + (Get-DrDay 0))))) { Ok 'never during start-up: at 0 and 19 minutes the waiter only waits (nothing claimed, nothing read)' } else { Ko "before the due time: $($w.Outcome) / $($w2.Outcome)" ($w.Out + "`n" + $w2.Out) }
  # coop starting meanwhile adds no second waiter.
  $null = Invoke-DrCoop
  if (@(Get-DrWaiterCalls).Count -eq 1) { Ok 'sign-in and coop together: coop finds the waiting one and starts no second waiter' } else { Ko "both together: $(@(Get-DrWaiterCalls).Count) waiters" }
  Set-DrClock (21 * 60)
  $w = Invoke-DrRecordedWaiter $signinWaiter
  $helper = @(Get-DrHelperCalls)
  $state = Get-DrStateDoc
  $reqOk = $helper.Count -eq 2 -and $helper[0].request.command -ceq 'refresh' -and $helper[0].request.config -ceq $drConfig -and $helper[1].request.command -ceq 'build' -and [int]$helper[1].request.timeout_seconds -gt 0
  $envOk = $helper.Count -eq 2 -and $helper[0].project_yml -ceq $drProject -and $helper[0].token -ceq 'fake.cw6.token' -and -not $helper[1].token -and $helper[0].cwd -ceq $drClient
  if ($w.Outcome -ceq 'ok' -and $reqOk -and $envOk) { Ok 'at 21 minutes: one run, live_docs.py refresh then build (stdin JSON, COOP_PROJECT_YML from client.json, the token only for the read)' } else { Ko "the sign-in run: $($w.Outcome)" ($w.Out + "`n" + (($helper | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 5 }) -join "`n")) }
  $line = 'Docs refreshed 09:21, 3 files changed.'
  if ($state -and $state.result -ceq 'ok' -and $state.from -ceq 'signin' -and $state.day -ceq (Get-DrDay 0) -and [int]$state.files_changed -eq 3 -and [int]$state.objects_changed -eq 2 -and $state.line -ceq $line) { Ok "state.json: ok, from sign-in, `"$line`"" } else { Ko 'state after the sign-in run' ($state | ConvertTo-Json -Depth 5) }
  if ((Test-Path -LiteralPath (Join-Path $drDir ('day-' + (Get-DrDay 0)))) -and $null -eq (Get-DrPending) -and (Get-Content -LiteralPath (Join-Path $drProfile 'logs\docs-refresh.log') -Raw) -match 'Docs refreshed 09:21') { Ok 'the day is claimed, the waiter cleared pending.json, the log has the line' } else { Ko 'claim / pending / log after the run' }

  # --- a run already done today: none -----------------------------------------------------------
  $n = @(Get-DrWaiterCalls).Count
  $null = Invoke-DrCoop
  $null = Invoke-DrSignIn
  $again = Invoke-DrRecordedWaiter $signinWaiter
  if (@(Get-DrWaiterCalls).Count -eq $n -and $again.Outcome -ceq 'done' -and @(Get-DrHelperCalls).Count -eq 2) { Ok 'done today: coop and sign-in start no waiter, a second waiter finds the day claimed' } else { Ko "done today: $(@(Get-DrWaiterCalls).Count - $n) new waiters, second waiter $($again.Outcome)" }

  # --- the next day, coop alone (closed long before the 20 minutes) --------------------------------
  Set-DrClock (86400)
  $r = Invoke-DrCoop
  $waiters = @(Get-DrWaiterCalls)
  $coopWaiter = $waiters[-1]
  $due = ConvertFrom-DrUnix ([long](Get-DrArg $coopWaiter '-WaiterDue'))
  if ($r.Rc -eq 0 -and $waiters.Count -eq $n + 1 -and (Get-DrArg $coopWaiter '-WaiterFrom') -ceq 'coop' -and $due -gt (Get-DrNow).AddMinutes(19) -and $due -le (Get-DrNow).AddMinutes(20)) { Ok 'the next day, coop start: one waiter, due 20 minutes after that coop started' } else { Ko "next day coop waiter: $($waiters.Count - $n) starts, due $due" $r.Out }
  Set-DrClock (86400 + 21 * 60)
  $w = Invoke-DrRecordedWaiter $coopWaiter
  $state = Get-DrStateDoc
  if ($w.Outcome -ceq 'ok' -and $state.day -ceq (Get-DrDay 86400) -and $state.from -ceq 'coop' -and @(Get-DrHelperCalls).Count -eq 4) { Ok 'coop closed before the 20 minutes: its detached waiter still runs once; a second day, a second run' } else { Ko "second day: $($w.Outcome)" $w.Out }

  # --- whichever comes first --------------------------------------------------------------------
  $day = 2 * 86400
  Set-DrClock $day
  $null = Invoke-DrCoop
  $coopWaiter = @(Get-DrWaiterCalls)[-1]
  # A sign-in whose update wait took 12 minutes is due in 8 (dot-sourced, as sign-in.ps1 runs it).
  $handed = (Invoke-Native { & $psExe -NoProfile -Command ". '$($drScript -replace "'", "''")'; Start-CoopDocsRefresh -ProfileDir '$($drProfile -replace "'", "''")' -From signin -StartedAt (Get-Date).AddMinutes(-12)" 2>&1 } | Out-String).Trim()
  $p = Get-DrPending
  $earlier = $p -and [long]$p.due -lt [long](Get-DrArg $coopWaiter '-WaiterDue') -and $p.from -ceq 'signin'
  Set-DrClock ($day + 9 * 60)
  $w = Invoke-DrRecordedWaiter $coopWaiter
  if ($handed -ceq 'pending' -and $earlier -and $w.Outcome -ceq 'ok' -and @(Get-DrHelperCalls).Count -eq 6) { Ok 'whichever comes first: the sign-in''s earlier due goes to the waiting coop waiter, which runs at 9 minutes' } else { Ko "earlier due: handed=$handed earlier=$earlier outcome=$($w.Outcome)" $w.Out }

  # --- asleep past midnight --------------------------------------------------------------------
  $day = 3 * 86400
  Set-DrClock $day
  $null = Invoke-DrCoop
  $coopWaiter = @(Get-DrWaiterCalls)[-1]
  Set-DrClock ($day + 86400 + 2 * 3600)
  $w = Invoke-DrRecordedWaiter $coopWaiter -Tick
  if ($w.Outcome -ceq 'waiting' -and @(Get-DrHelperCalls).Count -eq 6 -and -not (Test-Path -LiteralPath (Join-Path $drDir ('day-' + (Get-DrDay ($day + 86400)))))) { Ok 'asleep past midnight: on waking it does not run at once (today''s run is rescheduled 20 minutes out)' } else { Ko "asleep past midnight: $($w.Outcome)" $w.Out }
  Remove-Item -LiteralPath (Join-Path $drDir 'pending.json') -Force -ErrorAction SilentlyContinue

  # --- a coop update installing --------------------------------------------------------------------
  $day = 5 * 86400
  Set-DrClock $day
  $null = Invoke-DrCoop
  $coopWaiter = @(Get-DrWaiterCalls)[-1]
  $dueAt = ConvertFrom-DrUnix ([long](Get-DrArg $coopWaiter '-WaiterDue'))
  New-Item -ItemType Directory -Force -Path $env:COOP_MACHINE_DIR | Out-Null
  $updating = Join-Path $env:COOP_MACHINE_DIR 'updating.json'
  [System.IO.File]::WriteAllText($updating, (ConvertTo-Json -Compress -InputObject ([ordered]@{ version = '9.9.9'; started = (Get-DrNow).ToUniversalTime().ToString('o') })))
  Set-DrClock ($day + 25 * 60)
  $w = Invoke-DrRecordedWaiter $coopWaiter -Tick
  Set-DrClock ($day + 20 * 60 + 31 * 60)
  $w2 = Invoke-DrRecordedWaiter $coopWaiter
  $state = Get-DrStateDoc
  $claimed = Test-Path -LiteralPath (Join-Path $drDir ('day-' + (Get-DrDay $day)))
  if ($w.Outcome -ceq 'update-wait' -and $w2.Outcome -ceq 'update_running' -and -not $claimed -and $state.result -ceq 'update_running' -and @(Get-DrHelperCalls).Count -eq 6) { Ok 'an update installing: the waiter waits, then gives up 30 minutes past the due time without claiming the day (update_running)' } else { Ko "update running: $($w.Outcome) / $($w2.Outcome), claimed=$claimed" ($w2.Out) }
  Remove-Item -LiteralPath $updating -Force
  $null = Invoke-DrCoop
  $coopWaiter = @(Get-DrWaiterCalls)[-1]
  Set-DrClock ($day + 75 * 60)
  $w = Invoke-DrRecordedWaiter $coopWaiter
  if ($w.Outcome -ceq 'ok' -and @(Get-DrHelperCalls).Count -eq 8) { Ok 'after the update: the next coop start schedules the unclaimed day and it runs' } else { Ko "after the update: $($w.Outcome)" $w.Out }

  # --- skip and failure codes, one day each, through the waiter directly ---------------------------------
  $cases = @(
    @{ Code = 'signin_needed'; Setup = { $env:COOP_TEST_DR_TOKEN = 'auth' }; Undo = { Remove-Item Env:COOP_TEST_DR_TOKEN }; Calls = 0; Kind = 'failed' },
    @{ Code = 'no_docs_config'; Setup = { Rename-Item -LiteralPath $drConfig -NewName 'coop-data-doc.off' }; Undo = { Rename-Item -LiteralPath (Join-Path $drClient 'coop-data-doc.off') -NewName 'coop-data-doc.yml' }; Calls = 0; Kind = 'skipped' },
    @{ Code = 'no_live_sources'; Setup = { $script:keep = [System.IO.File]::ReadAllText($drConfig); [System.IO.File]::WriteAllText($drConfig, "repos:`n  sql:`n    path: ./sql`n") }; Undo = { [System.IO.File]::WriteAllText($drConfig, $script:keep) }; Calls = 0; Kind = 'skipped' },
    @{ Code = 'no_client'; Setup = { Rename-Item -LiteralPath (Join-Path $drProfile 'client.json') -NewName 'client.off' }; Undo = { Rename-Item -LiteralPath (Join-Path $drProfile 'client.off') -NewName 'client.json' }; Calls = 0; Kind = 'skipped' },
    @{ Code = 'dev_is_prod'; Setup = { $env:COOP_TEST_DR_REFRESH = '{"ok":false,"state":"dev_is_prod","target":"dev","sources":[]}' }; Undo = { Remove-Item Env:COOP_TEST_DR_REFRESH }; Calls = 1; Kind = 'skipped' },
    @{ Code = 'no_dev_target'; Setup = { $env:COOP_TEST_DR_REFRESH = '{"ok":false,"state":"failed","taken":0,"sources":[{"name":"dev","state":"not_a_dev_target"}]}' }; Undo = { Remove-Item Env:COOP_TEST_DR_REFRESH }; Calls = 1; Kind = 'skipped' },
    @{ Code = 'tool_unavailable'; Setup = { $env:COOP_TEST_DR_REFRESH = '{"ok":false,"state":"tool_unavailable","tool":"coop-data-doc"}' }; Undo = { Remove-Item Env:COOP_TEST_DR_REFRESH }; Calls = 1; Kind = 'skipped' },
    @{ Code = 'build_failed'; Setup = { $env:COOP_TEST_DR_BUILD = '{"ok":false,"state":"build_failed"}' }; Undo = { Remove-Item Env:COOP_TEST_DR_BUILD }; Calls = 2; Kind = 'failed' })
  $day = 10 * 86400
  foreach ($case in $cases) {
    $day += 86400
    Set-DrClock $day
    $count = @(Get-DrHelperCalls).Count
    & $case.Setup
    try { $w = Invoke-DrWaiter @('-WaiterFrom', 'coop', '-WaiterDue', [string]([System.DateTimeOffset](Get-DrNow).AddMinutes(-1)).ToUnixTimeSeconds()) } finally { & $case.Undo }
    $state = Get-DrStateDoc
    $want = if ($case.Kind -eq 'skipped') { "^Docs refresh skipped 09:00: .+ \($($case.Code)\)\.$" } else { "^Docs refresh failed 09:00: .+ \($($case.Code)\)\. It runs again tomorrow; /setup-docs refresh runs it now\.$" }
    if ($w.Outcome -ceq $case.Code -and $state.result -ceq $case.Code -and ([string]$state.line) -match $want -and (@(Get-DrHelperCalls).Count - $count) -eq $case.Calls) { Ok "$($case.Code): $($state.line)" } else { Ko "$($case.Code): outcome $($w.Outcome), line $($state.line), $(@(Get-DrHelperCalls).Count - $count) helper calls" $w.Out }
  }
  # A failed run is not retried that day.
  $n = @(Get-DrWaiterCalls).Count
  $null = Invoke-DrCoop
  if (@(Get-DrWaiterCalls).Count -eq $n) { Ok 'a failed run is not retried the same day (the claim comes first)' } else { Ko 'a failed run was rescheduled the same day' }

  # --- switched off while waiting ----------------------------------------------------------------------
  $day += 86400
  Set-DrClock $day
  $null = Invoke-DrCoop
  $coopWaiter = @(Get-DrWaiterCalls)[-1]
  Set-DrFeature 'off'
  Set-DrClock ($day + 21 * 60)
  $count = @(Get-DrHelperCalls).Count
  $w = Invoke-DrRecordedWaiter $coopWaiter
  if ($w.Outcome -ceq 'off' -and @(Get-DrHelperCalls).Count -eq $count -and -not (Test-Path -LiteralPath (Join-Path $drDir ('day-' + (Get-DrDay $day))))) { Ok 'switched off while waiting: the waiter exits on waking, nothing runs' } else { Ko "switched off while waiting: $($w.Outcome)" $w.Out }
  Set-DrFeature 'on'

  # --- doctor ----------------------------------------------------------------------------------------------
  # The last state is the build_failed day: a warning row with the line and where the log is.
  $script:doctor = Join-Path $drRoot 'scripts\doctor.ps1'
  $drows = @(Get-DoctorRows | Where-Object { $_.section -ceq 'Features (this client)' })
  $row = @($drows | Where-Object { ([string]$_.name).StartsWith('Daily lineage refresh on: Docs refresh failed') })
  if ($row.Count -eq 1 -and $row[0].status -ceq 'warn' -and ([string]$row[0].hint).Contains('docs-refresh.log')) { Ok 'doctor: "Daily lineage refresh on: <the last line>", a warning naming the log' } else { Ko 'doctor row' (Show-Rows $drows) }
} finally {
  Restore-Env $drSaved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
exit $fail

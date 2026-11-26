#!/usr/bin/env pwsh
# Daily lineage refresh (FEATURES-DESIGN CW6), gate lane: the real sign-in script
# (scripts\sign-in.ps1), the real launcher (`coop -p hi` with a fake Pi) and the
# real window launch (`coop desktop --app <fake window>`) start the waiter
# through a recorder that stands in for the built-in powershell.exe; the fixture
# then runs each recorded waiter itself, to its end, against a fake clock
# (nothing sleeps, polls or waits in the background: the process cases are in
# docs-refresh-process.test.ps1, extended lane). The run's tools are fakes
# (_docs-refresh.ps1): lib\live_docs.py answers from a sitecustomize.py and
# records every request, except in the "real live_docs.py" cases, where it is
# the real helper against a fake az and a fake coop-data-doc.
#   - off: sign-in and coop start nothing new (the recorder's calls are counted),
#     write nothing, and no docs-refresh folder appears;
#   - sign-in alone, coop alone (coop closed before the 20 minutes), both
#     together: one run each, 20 minutes after the start, never before;
#     a run already done today: none; the next day: a second run;
#   - no waiter ever inherits the launch token, the window's launch spec or the
#     first-run marker, from sign-in, coop or the window launch (Neon B1);
#   - the window launch schedules once the window is open;
#   - whichever comes first: a later starter hands an earlier due to the waiter;
#   - due never sooner than 2 minutes from the start; a clock set back adds nothing;
#   - the computer asleep past midnight: no run on waking, today's is rescheduled
#     20 minutes after waking;
#   - a coop update installing: waits, then update_running without claiming;
#   - a pid reused after a logoff is not taken for a waiter; a waiter that
#     cannot start leaves no note behind;
#   - every skip and failure code with its line (what happened, where to fix it,
#     no code in the sentence), a failed run not retried, internal_error logged
#     with its reason;
#   - the real live_docs.py: a named-set-only dev target mints and reads; no dev
#     target, dev_is_prod mint nothing; an expired az sign-in is signin_needed;
#     a stray ~/.coop/.coop/project.yml is never used (Neon B4);
#   - doctor's row and the state's one line.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
. (Join-Path $PSScriptRoot '_docs-refresh.ps1')
try {
  function Flat([string]$Text) { return (($Text -replace '\s+', ' ').Trim()) }
  $drLog = Join-Path $drProfile 'logs\docs-refresh.log'
  # The launch-private variables, set in the parent so the scripts inherit them.
  $privateNames = @('COOP_FABRIC_MCP_TOKEN', 'COOP_DATA_DOC_ACCESS_TOKEN', 'COOP_DESKTOP_SPEC', 'COOP_DESKTOP_DATA', 'COOP_FIRST_RUN', 'COOP_PRIME_MODEL_LOGIN')
  function Invoke-WithPrivateEnv([scriptblock]$Block) {
    foreach ($n in $privateNames) { Set-Item -LiteralPath "Env:\$n" -Value "private-$n" }
    try { return (& $Block) } finally { foreach ($n in $privateNames) { Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue } }
  }
  function Test-DrWaiterEnvClean { return (@(Get-DrWaiterEnv | Where-Object { @($_.private).Count -gt 0 }).Count -eq 0) }
  function Get-DrUnix([double]$Minutes) { return [string]([System.DateTimeOffset](Get-DrNow).AddMinutes($Minutes)).ToUnixTimeSeconds() }

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
  if ($noWaiter -and -not (Test-Path -LiteralPath $drDir) -and -not (Test-Path -LiteralPath $drLog) -and @(Get-DrHelperCalls).Count -eq 0) { Ok 'off (docs_refresh false): no waiter, no docs-refresh folder, no log, no live_docs.py call' } else { Ko 'off wrote or started something' ((Get-DrCalls | ForEach-Object { @($_) -join ' ' }) -join "`n") }
  # sign-in.ps1 has no environment seam: with the feature off, COOP_BUILTIN_POWERSHELL changes nothing (Neon B5).
  $saveBuiltin = $env:COOP_BUILTIN_POWERSHELL
  $env:COOP_BUILTIN_POWERSHELL = Join-Path $t 'no-such-powershell'
  $seam = (Invoke-Native { & $psExe -NoProfile -Command ". '$($signIn -replace "'", "''")'; Get-CoopSignInPowerShell" 2>&1 } | Out-String).Trim()
  $env:COOP_BUILTIN_POWERSHELL = $saveBuiltin
  if ($seam -notmatch 'no-such-powershell') { Ok 'off, sign-in: COOP_BUILTIN_POWERSHELL does not redirect sign-in.ps1 (a -PowerShellPath parameter only)' } else { Ko "sign-in.ps1 still reads COOP_BUILTIN_POWERSHELL: $seam" }

  # --- on, sign-in alone -----------------------------------------------------------------------
  Set-DrFeature 'on'
  $before = Get-DrNow
  $r = Invoke-WithPrivateEnv { Invoke-DrSignIn }
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
  $null = Invoke-WithPrivateEnv { Invoke-DrCoop }
  if (@(Get-DrWaiterCalls).Count -eq 1) { Ok 'sign-in and coop together: coop finds the waiting one and starts no second waiter' } else { Ko "both together: $(@(Get-DrWaiterCalls).Count) waiters" }
  Set-DrClock (21 * 60)
  $w = Invoke-DrRecordedWaiter $signinWaiter
  $helper = @(Get-DrHelperCalls)
  $state = Get-DrStateDoc
  $reqOk = $helper.Count -eq 2 -and $helper[0].request.command -ceq 'refresh' -and $helper[0].request.config -ceq $drConfig -and $helper[0].request.mint -eq $true -and $helper[1].request.command -ceq 'build' -and [int]$helper[1].request.timeout_seconds -gt 0
  $envOk = $helper.Count -eq 2 -and $helper[0].project_yml -ceq $drProject -and -not $helper[0].token -and -not $helper[1].token -and $helper[0].cwd -ceq $drClient
  if ($w.Outcome -ceq 'ok' -and $reqOk -and $envOk) { Ok 'at 21 minutes: one run, live_docs.py refresh (mint) then build (stdin JSON, COOP_PROJECT_YML from client.json, no token from the waiter)' } else { Ko "the sign-in run: $($w.Outcome)" ($w.Out + "`n" + (($helper | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 5 }) -join "`n")) }
  $line = 'Docs refreshed 09:21, 3 files changed.'
  if ($state -and $state.result -ceq 'ok' -and $state.from -ceq 'signin' -and $state.day -ceq (Get-DrDay 0) -and [int]$state.files_changed -eq 3 -and [int]$state.objects_changed -eq 2 -and $state.line -ceq $line) { Ok "state.json: ok, from sign-in, `"$line`"" } else { Ko 'state after the sign-in run' ($state | ConvertTo-Json -Depth 5) }
  if ((Test-Path -LiteralPath (Join-Path $drDir ('day-' + (Get-DrDay 0)))) -and $null -eq (Get-DrPending) -and (Get-Content -LiteralPath $drLog -Raw) -match 'Docs refreshed 09:21, 3 files changed\. \[ok\]') { Ok 'the day is claimed, the waiter cleared pending.json, the log has the line and its code' } else { Ko 'claim / pending / log after the run' }

  # --- a run already done today: none -----------------------------------------------------------
  $n = @(Get-DrWaiterCalls).Count
  $null = Invoke-DrCoop
  $null = Invoke-DrSignIn
  $again = Invoke-DrRecordedWaiter $signinWaiter
  if (@(Get-DrWaiterCalls).Count -eq $n -and $again.Outcome -ceq 'done' -and @(Get-DrHelperCalls).Count -eq 2) { Ok 'done today: coop and sign-in start no waiter, a second waiter finds the day claimed' } else { Ko "done today: $(@(Get-DrWaiterCalls).Count - $n) new waiters, second waiter $($again.Outcome)" }

  # --- the next day, coop alone (closed long before the 20 minutes) --------------------------------
  Set-DrClock (86400)
  $r = Invoke-WithPrivateEnv { Invoke-DrCoop }
  $waiters = @(Get-DrWaiterCalls)
  $coopWaiter = $waiters[-1]
  $due = ConvertFrom-DrUnix ([long](Get-DrArg $coopWaiter '-WaiterDue'))
  if ($r.Rc -eq 0 -and $waiters.Count -eq $n + 1 -and (Get-DrArg $coopWaiter '-WaiterFrom') -ceq 'coop' -and $due -gt (Get-DrNow).AddMinutes(19) -and $due -le (Get-DrNow).AddMinutes(20)) { Ok 'the next day, coop start: one waiter, due 20 minutes after that coop started' } else { Ko "next day coop waiter: $($waiters.Count - $n) starts, due $due" $r.Out }
  $envRows = @(Get-DrWaiterEnv)
  if ($envRows.Count -ge 2 -and (Test-DrWaiterEnvClean)) { Ok "no waiter inherits the launch token, the window spec or the first-run marker (sign-in and coop, $($envRows.Count) starts)" } else { Ko 'a waiter inherited a launch-private variable' (($envRows | ForEach-Object { $_ | ConvertTo-Json -Compress }) -join "`n") }
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
  $earlierDoc = Get-Content -LiteralPath (Join-Path $drDir 'earlier.json') -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
  $earlier = $p -and $earlierDoc -and [long]$earlierDoc.due -lt [long](Get-DrArg $coopWaiter '-WaiterDue') -and $earlierDoc.from -ceq 'signin' -and [long]$p.due -eq [long](Get-DrArg $coopWaiter '-WaiterDue')
  Set-DrClock ($day + 9 * 60)
  $w = Invoke-DrRecordedWaiter $coopWaiter
  if ($handed -ceq 'pending' -and $earlier -and $w.Outcome -ceq 'ok' -and @(Get-DrHelperCalls).Count -eq 6 -and -not (Test-Path -LiteralPath (Join-Path $drDir 'earlier.json'))) { Ok 'whichever comes first: the sign-in''s earlier due goes to earlier.json (pending.json is the waiter''s alone), and the coop waiter runs at 9 minutes' } else { Ko "earlier due: handed=$handed earlier=$earlier outcome=$($w.Outcome)" $w.Out }

  # --- the due is floored and a clock set back adds nothing ---------------------------------------
  # (the same day, its claim lifted for the two starts and put back after)
  $floorOut = (Invoke-Native { & $psExe -NoProfile -Command ". '$($drScript -replace "'", "''")'; Remove-Item -LiteralPath '$((Join-Path $drDir ('day-' + (Get-DrDay (2 * 86400)))) -replace "'", "''")'; `$null = Start-CoopDocsRefresh -ProfileDir '$($drProfile -replace "'", "''")' -From signin -StartedAt (Get-Date).AddMinutes(-25); (Get-Content -Raw -LiteralPath '$((Join-Path $drDir 'pending.json') -replace "'", "''")' | ConvertFrom-Json).due" 2>&1 } | Out-String).Trim()
  $lastDue = @(Get-DrWaiterCalls)[-1]
  $dueFloor = ConvertFrom-DrUnix ([long](Get-DrArg $lastDue '-WaiterDue'))
  $floorOk = ($dueFloor -ge (Get-DrNow).AddSeconds(115)) -and ($dueFloor -le (Get-DrNow).AddSeconds(125))
  Remove-Item -LiteralPath (Join-Path $drDir 'pending.json') -Force -ErrorAction SilentlyContinue
  $backOut = (Invoke-Native { & $psExe -NoProfile -Command ". '$($drScript -replace "'", "''")'; `$null = Start-CoopDocsRefresh -ProfileDir '$($drProfile -replace "'", "''")' -From coop -StartedAt (Get-Date).AddMinutes(30)" 2>&1 } | Out-String).Trim()
  $lastDue = @(Get-DrWaiterCalls)[-1]
  $dueBack = ConvertFrom-DrUnix ([long](Get-DrArg $lastDue '-WaiterDue'))
  $backOk = ($dueBack -ge (Get-DrNow).AddMinutes(20).AddSeconds(-5)) -and ($dueBack -le (Get-DrNow).AddMinutes(20).AddSeconds(5))
  if ($floorOk -and $backOk) { Ok 'the due: 25 minutes of update wait gives now + 2 minutes (never in the start-up); a start time in the future (clock set back) gives now + 20' } else { Ko "due floor=$dueFloor ($floorOk) back=$dueBack ($backOk) at $(Get-DrNow)" ($floorOut + "`n" + $backOut) }
  Remove-Item -LiteralPath (Join-Path $drDir 'pending.json') -Force -ErrorAction SilentlyContinue
  [System.IO.File]::WriteAllText((Join-Path $drDir ('day-' + (Get-DrDay (2 * 86400)))), '')

  # --- a reused pid is not a waiter; a waiter that cannot start leaves nothing -----------------------
  Set-DrClock (3 * 86400)
  # pending.json naming this test's own PowerShell (a live pwsh, today) with another start time: stale.
  $stale = [ordered]@{ pid = $PID; started = 1000; day = (Get-DrDay (3 * 86400)); due = [long](Get-DrUnix 5); from = 'coop'; written = [long](Get-DrUnix -600) }
  New-Item -ItemType Directory -Force -Path $drDir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $drDir 'pending.json'), (ConvertTo-Json -Compress -InputObject $stale), $utf8)
  (Get-Item -LiteralPath (Join-Path $drDir 'pending.json')).LastWriteTime = (Get-Date).AddMinutes(-10)
  $n = @(Get-DrWaiterCalls).Count
  $r = Invoke-DrCoop
  $p = Get-DrPending
  $reused = (@(Get-DrWaiterCalls).Count -eq $n + 1) -and $p -and [int]$p.pid -eq 0
  if ($reused) { Ok 'a pid reused after a logoff (a running PowerShell with another start time) is not taken for a waiter: a new one starts' } else { Ko "reused pid: $(@(Get-DrWaiterCalls).Count - $n) new waiters" ($p | ConvertTo-Json -Compress) }
  Remove-Item -LiteralPath (Join-Path $drDir 'pending.json') -Force -ErrorAction SilentlyContinue
  $failed = (Invoke-Native { & $psExe -NoProfile -Command ". '$($drScript -replace "'", "''")'; Start-CoopDocsRefresh -ProfileDir '$($drProfile -replace "'", "''")' -From coop -StartedAt (Get-Date) -PowerShell '$((Join-Path $t 'no-such-dir\no-such-powershell') -replace "'", "''")'" 2>&1 } | Out-String).Trim()
  if ($failed -ceq 'failed' -and -not (Test-Path -LiteralPath (Join-Path $drDir 'pending.json'))) { Ok 'a waiter that cannot be started: the starter says failed and removes its note (the next start is not held off)' } else { Ko "failed start: $failed, pending=$(Test-Path -LiteralPath (Join-Path $drDir 'pending.json'))" }

  # --- asleep past midnight --------------------------------------------------------------------
  $day = 3 * 86400
  Set-DrClock $day
  $null = Invoke-DrCoop
  $coopWaiter = @(Get-DrWaiterCalls)[-1]
  Set-DrClock ($day + 86400 + 2 * 3600)
  $w = Invoke-DrRecordedWaiter $coopWaiter -Tick
  $wantDue = (Get-DrNow).AddMinutes(20).ToString('yyyy-MM-dd HH:mm', [System.Globalization.CultureInfo]::InvariantCulture)
  $rescheduled = (Get-Content -LiteralPath $drLog -Raw) -match [regex]::Escape("today's refresh is due $wantDue")
  if ($w.Outcome -ceq 'waiting' -and $rescheduled -and @(Get-DrHelperCalls).Count -eq 6 -and -not (Test-Path -LiteralPath (Join-Path $drDir ('day-' + (Get-DrDay ($day + 86400)))))) { Ok "asleep past midnight: on waking it does not run; today's run is rescheduled to waking + 20 minutes ($wantDue)" } else { Ko "asleep past midnight: $($w.Outcome), rescheduled=$rescheduled" $w.Out }
  Remove-Item -LiteralPath (Join-Path $drDir 'pending.json') -Force -ErrorAction SilentlyContinue

  # --- the window launch: schedules once the window is open, without its spec or token ----------------
  $day = 4 * 86400
  Set-DrClock $day
  $n = @(Get-DrWaiterCalls).Count
  $r = Invoke-WithPrivateEnv { Invoke-DrDesktop }
  $deadline = (Get-Date).AddSeconds(15)
  while (@(Get-DrWindowStarts).Count -eq 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
  $windowStart = @(Get-DrWindowStarts)
  $waiters = @(Get-DrWaiterCalls)
  $deskOk = $r.Rc -eq 0 -and $windowStart.Count -eq 1 -and $windowStart[0].spec -and $waiters.Count -eq $n + 1 -and (Get-DrArg $waiters[-1] '-WaiterFrom') -ceq 'coop'
  $deskEnv = @(Get-DrWaiterEnv)[-1]
  if ($deskOk -and @($deskEnv.private).Count -eq 0) { Ok 'coop desktop: the window gets its launch spec, then one waiter is scheduled, with no launch spec, token or first-run marker' } else { Ko "coop desktop (rc=$($r.Rc)): window starts $($windowStart.Count), waiters +$($waiters.Count - $n), waiter env $(@($deskEnv.private) -join ',')" $r.Out }
  Remove-Item -LiteralPath (Join-Path $drDir 'pending.json') -Force -ErrorAction SilentlyContinue

  # --- a coop update installing --------------------------------------------------------------------
  $day = 5 * 86400
  Set-DrClock $day
  $null = Invoke-DrCoop
  $coopWaiter = @(Get-DrWaiterCalls)[-1]
  New-Item -ItemType Directory -Force -Path $env:COOP_MACHINE_DIR | Out-Null
  $updating = Join-Path $env:COOP_MACHINE_DIR 'updating.json'
  [System.IO.File]::WriteAllText($updating, (ConvertTo-Json -Compress -InputObject ([ordered]@{ version = '9.9.9'; started = (Get-DrNow).ToUniversalTime().ToString('o') })))
  Set-DrClock ($day + 25 * 60)
  $w = Invoke-DrRecordedWaiter $coopWaiter -Tick
  Set-DrClock ($day + 20 * 60 + 31 * 60)
  $w2 = Invoke-DrRecordedWaiter $coopWaiter
  $state = Get-DrStateDoc
  $claimed = Test-Path -LiteralPath (Join-Path $drDir ('day-' + (Get-DrDay $day)))
  if ($w.Outcome -ceq 'update-wait' -and $w2.Outcome -ceq 'update_running' -and -not $claimed -and $state.result -ceq 'update_running' -and $state.line -ceq 'Docs refresh waited for a coop update. It runs at the next sign-in or coop start.' -and @(Get-DrHelperCalls).Count -eq 6) { Ok 'an update installing: the waiter waits, then gives up 30 minutes past the due time without claiming the day (update_running)' } else { Ko "update running: $($w.Outcome) / $($w2.Outcome), claimed=$claimed" ($w2.Out) }
  Remove-Item -LiteralPath $updating -Force
  $null = Invoke-DrCoop
  $coopWaiter = @(Get-DrWaiterCalls)[-1]
  Set-DrClock ($day + 75 * 60)
  $w = Invoke-DrRecordedWaiter $coopWaiter
  if ($w.Outcome -ceq 'ok' -and @(Get-DrHelperCalls).Count -eq 8) { Ok 'after the update: the next coop start schedules the unclaimed day and it runs' } else { Ko "after the update: $($w.Outcome)" $w.Out }

  # --- skip and failure codes, one day each, through the waiter directly ---------------------------------
  # Each line says what happened and where to fix it (the window, then the slash
  # command or the CLI); the code is in the log only.
  $cases = @(
    @{ Code = 'no_client'; Setup = { Rename-Item -LiteralPath (Join-Path $drProfile 'client.json') -NewName 'client.off' }; Undo = { Rename-Item -LiteralPath (Join-Path $drProfile 'client.off') -NewName 'client.json' }; Calls = 0
       Line = 'Docs refresh skipped 09:00: No client folder is set. Choose one in File > Switch client (or coop project home <folder>).' },
    @{ Code = 'no_project'; Setup = { Rename-Item -LiteralPath $drProject -NewName 'project.off' }; Undo = { Rename-Item -LiteralPath (Join-Path $drClient '.coop\project.off') -NewName 'project.yml' }; Calls = 0
       Line = 'Docs refresh skipped 09:00: The client folder has no project file. Create it in Project (or /setup-project).' },
    @{ Code = 'no_docs_config'; Setup = { Rename-Item -LiteralPath $drConfig -NewName 'coop-data-doc.off' }; Undo = { Rename-Item -LiteralPath (Join-Path $drClient 'coop-data-doc.off') -NewName 'coop-data-doc.yml' }; Calls = 0
       Line = 'Docs refresh skipped 09:00: The lineage docs are not set up. Open Docs > Set up the docs (or /setup-docs).' },
    @{ Code = 'no_live_sources'; Setup = { $env:COOP_TEST_DR_REFRESH = '{"ok":false,"state":"no_live_sources"}' }; Undo = { Remove-Item Env:COOP_TEST_DR_REFRESH }; Calls = 1
       Line = 'Docs refresh skipped 09:00: The docs do not read the dev database. Open Docs > Use the live dev database (or /setup-docs live).' },
    @{ Code = 'no_dev_target'; Setup = { $env:COOP_TEST_DR_REFRESH = '{"ok":false,"state":"failed","taken":0,"sources":[{"name":"dev","state":"not_a_dev_target"}]}' }; Undo = { Remove-Item Env:COOP_TEST_DR_REFRESH }; Calls = 1
       Line = 'Docs refresh skipped 09:00: There is no dev SQL target. Add a dev SQL target in Project > SQL targets (or /setup-project).' },
    @{ Code = 'dev_is_prod'; Setup = { $env:COOP_TEST_DR_REFRESH = '{"ok":false,"state":"dev_is_prod","target":"dev","sources":[]}' }; Undo = { Remove-Item Env:COOP_TEST_DR_REFRESH }; Calls = 1
       Line = 'Docs refresh skipped 09:00: The dev SQL target points at production, so nothing was read. Point the dev target at a dev database in Project > SQL targets.' },
    @{ Code = 'config_unreadable'; Setup = { $env:COOP_TEST_DR_REFRESH = '{"ok":false,"state":"config_unreadable"}' }; Undo = { Remove-Item Env:COOP_TEST_DR_REFRESH }; Calls = 1
       Line = 'Docs refresh skipped 09:00: The docs setup file could not be read. Fix it in Docs > Change the setup (or /setup-docs).' },
    @{ Code = 'tool_unavailable'; Setup = { $env:COOP_TEST_DR_REFRESH = '{"ok":false,"state":"tool_unavailable","tool":"coop-data-doc"}' }; Undo = { Remove-Item Env:COOP_TEST_DR_REFRESH }; Calls = 1
       Line = 'Docs refresh skipped 09:00: The docs tool or Python is missing. Run coop update (or coop install).' },
    @{ Code = 'azure_unavailable'; Setup = { $env:COOP_TEST_DR_REFRESH = '{"ok":false,"state":"azure_cli_unavailable","stage":"launch_token","sources":[]}' }; Undo = { Remove-Item Env:COOP_TEST_DR_REFRESH }; Calls = 1
       Line = 'Docs refresh skipped 09:00: The Azure CLI is missing or would not start. Run coop update (or coop install).' },
    @{ Code = 'signin_needed'; Setup = { $env:COOP_TEST_DR_REFRESH = '{"ok":false,"state":"auth_required","stage":"launch_token","sources":[]}' }; Undo = { Remove-Item Env:COOP_TEST_DR_REFRESH }; Calls = 1
       Line = 'Docs refresh failed 09:00: The Azure sign-in has expired. Run az login (File > Open in terminal), then Docs > Refresh from dev. It runs again tomorrow.' },
    @{ Code = 'azure_failed'; Setup = { $env:COOP_TEST_DR_REFRESH = '{"ok":false,"state":"token_timeout","stage":"launch_token","sources":[]}' }; Undo = { Remove-Item Env:COOP_TEST_DR_REFRESH }; Calls = 1
       Line = 'Docs refresh failed 09:00: The Azure CLI gave no sign-in token. Check the network or VPN, then Docs > Refresh from dev. It runs again tomorrow.' },
    @{ Code = 'snapshot_failed'; Setup = { $env:COOP_TEST_DR_REFRESH = '{"ok":false,"state":"failed","taken":0,"sources":[{"name":"dev","state":"snapshot_failed"}]}' }; Undo = { Remove-Item Env:COOP_TEST_DR_REFRESH }; Calls = 1
       Line = 'Docs refresh failed 09:00: The dev database could not be read. Docs > Refresh from dev (or /setup-docs refresh) shows why. It runs again tomorrow.' },
    @{ Code = 'internal_error'; Setup = { $env:COOP_TEST_DR_REFRESH = '{"ok":false,"state":"internal_error"}' }; Undo = { Remove-Item Env:COOP_TEST_DR_REFRESH }; Calls = 1
       Line = "Docs refresh failed 09:00: Something went wrong. The log is $drLog. It runs again tomorrow." },
    @{ Code = 'build_failed'; Setup = { $env:COOP_TEST_DR_BUILD = '{"ok":false,"state":"build_failed"}' }; Undo = { Remove-Item Env:COOP_TEST_DR_BUILD }; Calls = 2
       Line = 'Docs refresh failed 09:00: The docs did not rebuild. Docs > Build (or coop data-doc build) shows why. It runs again tomorrow.' })
  $day = 10 * 86400
  foreach ($case in $cases) {
    $day += 86400
    Set-DrClock $day
    $count = @(Get-DrHelperCalls).Count
    & $case.Setup
    try { $w = Invoke-DrWaiter @('-WaiterFrom', 'coop', '-WaiterDue', (Get-DrUnix -1)) } finally { & $case.Undo }
    $state = Get-DrStateDoc
    $logged = (Get-Content -LiteralPath $drLog -Raw) -match ([regex]::Escape($case.Line) + ' \[' + $case.Code + '[\]:]')
    if ($w.Outcome -ceq $case.Code -and $state.result -ceq $case.Code -and ([string]$state.line) -ceq $case.Line -and $logged -and (@(Get-DrHelperCalls).Count - $count) -eq $case.Calls) { Ok "$($case.Code): $($state.line)" } else { Ko "$($case.Code): outcome $($w.Outcome), line $($state.line), logged=$logged, $(@(Get-DrHelperCalls).Count - $count) helper calls" $w.Out }
  }
  # A failed run is not retried that day.
  $n = @(Get-DrWaiterCalls).Count
  $null = Invoke-DrCoop
  if (@(Get-DrWaiterCalls).Count -eq $n) { Ok 'a failed run is not retried the same day (the claim comes first)' } else { Ko 'a failed run was rescheduled the same day' }
  $lastFailed = Get-DrStateDoc

  # internal_error from an exception in the run: the log says why (Neon nice-to-have 2).
  $day += 86400
  Set-DrClock $day
  $boom = "& { . '$((Join-Path $drRoot 'scripts\auto-update.ps1') -replace "'", "''")'; . '$($drScript -replace "'", "''")'; function Invoke-CoopDocsRefreshHelper { throw 'boom from the fixture' }; Invoke-CoopDocsRefreshWaiter -From coop -DueUnix $(Get-DrUnix -1) }"
  $out = (Invoke-Native { & $psExe -NoProfile -Command $boom 2>&1 } | Out-String).Trim()
  $state = Get-DrStateDoc
  if ($out -ceq 'internal_error' -and $state.result -ceq 'internal_error' -and $state.detail -ceq 'boom from the fixture' -and (Get-Content -LiteralPath $drLog -Raw) -match 'Something went wrong\. .+ \[internal_error: boom from the fixture\]') { Ok 'internal_error from an exception: one plain line, and the log names the exception' } else { Ko "internal_error exception: $out" ($state | ConvertTo-Json -Compress) }
  # Put the last code-table state back for doctor below.
  [System.IO.File]::WriteAllText($drState, ($lastFailed | ConvertTo-Json -Depth 6 -Compress), $utf8)

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
  Remove-Item -LiteralPath (Join-Path $drDir 'pending.json') -Force -ErrorAction SilentlyContinue

  # --- doctor ----------------------------------------------------------------------------------------------
  # The last state is the build_failed day: a warning row with the line, the hint only where the log is.
  $script:doctor = Join-Path $drRoot 'scripts\doctor.ps1'
  $drows = @(Get-DoctorRows | Where-Object { $_.section -ceq 'Features (this client)' })
  $row = @($drows | Where-Object { ([string]$_.name).StartsWith('Daily lineage refresh on: Docs refresh failed') })
  if ($row.Count -eq 1 -and $row[0].status -ceq 'warn' -and ([string]$row[0].name).Contains('Docs > Build') -and ([string]$row[0].hint).Contains('docs-refresh.log') -and -not ([string]$row[0].hint).Contains('/setup-docs refresh')) { Ok 'doctor: "Daily lineage refresh on: <the last line>", a warning naming the log (no "/setup-docs refresh runs it now")' } else { Ko 'doctor row' (Show-Rows $drows) }

  # --- the real live_docs.py (Neon B4): validates first, mints only for a real dev target ---------------
  # A stray project file in the waiter's own folder (~/.coop) must never be used.
  New-Item -ItemType Directory -Force -Path (Join-Path $drProfile '.coop') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $drProfile '.coop\project.yml'), "schema_version: 1`nsql_targets:`n  dev:`n    kind: azure_sql`n    server: `"stray-prod.database.windows.net`"`n    database: Stray`n", $utf8)
  $named = "schema_version: 1`nprofile:`n  client: Contoso`nsql_targets:`n  named:`n    lake:`n      dev:`n        kind: azure_sql`n        server: `"contoso-dev.database.windows.net`"`n        database: SalesDev`n"
  $none = "schema_version: 1`nprofile:`n  client: Contoso`n"
  $prodDev = "schema_version: 1`nprofile:`n  client: Contoso`nsql_targets:`n  default_environment: dev`n  dev:`n    kind: azure_sql`n    server: `"contoso.database.windows.net`"`n    database: Sales`n  prod:`n    kind: azure_sql`n    server: `"contoso.database.windows.net`"`n    database: Sales`n"
  $realCases = @(
    @{ Name = 'a named-set-only dev target: minted and read'; Project = $named; Sources = @{ dev_lake = @('contoso-dev.database.windows.net', 'SalesDev') }; Az = 'ok'; Code = 'ok'; AzCalls = $true; Snapshot = $true },
    @{ Name = 'no dev target: nothing minted'; Project = $none; Sources = @{ dev = @('contoso-dev.database.windows.net', 'SalesDev') }; Az = 'ok'; Code = 'no_dev_target'; AzCalls = $false; Snapshot = $false },
    @{ Name = 'a dev target that is production: nothing minted'; Project = $prodDev; Sources = @{ dev = @('contoso.database.windows.net', 'Sales') }; Az = 'ok'; Code = 'dev_is_prod'; AzCalls = $false; Snapshot = $false },
    @{ Name = 'an expired az sign-in: signin_needed'; Project = $named; Sources = @{ dev_lake = @('contoso-dev.database.windows.net', 'SalesDev') }; Az = 'auth'; Code = 'signin_needed'; AzCalls = $true; Snapshot = $false })
  foreach ($case in $realCases) {
    $day += 86400
    Set-DrClock $day
    Set-DrReal $case.Sources $case.Project
    Set-DrAzMode $case.Az
    Remove-Item -LiteralPath (Join-Path $drMarker 'az-calls.jsonl'), $drDataDocLog -Force -ErrorAction SilentlyContinue
    try { $w = Invoke-DrWaiter @('-WaiterFrom', 'coop', '-WaiterDue', (Get-DrUnix -1)) } finally { Reset-DrReal; Set-DrAzMode 'ok' }
    $az = @(Get-DrAzCalls)
    $snaps = @(Get-DrDataDocCalls | Where-Object { $_.argv[0] -ceq 'snapshot' })
    $azOk = if ($case.AzCalls) { $az.Count -ge 1 -and (@($az | Where-Object { ($_ -join ' ') -match 'get-access-token --resource https://database\.windows\.net/' }).Count -ge 1) } else { $az.Count -eq 0 }
    $snapOk = if ($case.Snapshot) { $snaps.Count -eq 1 -and $snaps[0].argv[1] -ceq 'dev_lake' -and $snaps[0].token -and -not $snaps[0].launch_token } else { $snaps.Count -eq 0 }
    if ($w.Outcome -ceq $case.Code -and $azOk -and $snapOk) { Ok "real live_docs.py, $($case.Name) ($($az.Count) az call(s))" } else { Ko "real live_docs.py, $($case.Name): outcome $($w.Outcome), az $($az.Count), snapshots $($snaps.Count)" ($w.Out + "`n" + (Get-Content -LiteralPath $drLog -Tail 3 | Out-String)) }
  }
} finally {
  Restore-Env $drSaved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
exit $fail

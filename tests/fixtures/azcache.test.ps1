#!/usr/bin/env pwsh
# H2: Azure sign-in preflight. Invoke-CoopAzPreflight and
# Get-CoopAzTokenRc (lib/common.ps1) against the shared fake az
# (tests/fixtures/fake-az.mjs): tenant chain, Fabric then Power BI check, the
# ~30-min .az-ok cache, automatic bounded sign-in, one-line failures, and the
# doctor.ps1 Azure row. On Windows the fake az.cmd sits under
# "Program Files (x86)", the default 32-bit Azure CLI location. Stub-driven, never
# the real az or ~/.coop; the only waits are the shortened 3 s limits, and the
# Ctrl-C case uses a Python pty on POSIX legs only. Cases 10, 13c, 13d and 13f end
# a real process (the fake az's own exit 143/SIGTERM, a hanging az stopped at its
# limit, Ctrl-C through a pty), so they run only in the extended lane
# (COOP_TEST_EXTENDED=1, #96), like cases 10, 13c and 13d of the bash twin.
# Assertions stay ASCII: Windows PowerShell 5.1 re-encodes child stderr.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-azcache-' + [guid]::NewGuid().ToString('N'))
$extendedLane = ($env:COOP_TEST_EXTENDED -eq '1')
function Skipped([string]$m) { Write-Host "  - skipped in the gate lane: $m (COOP_TEST_EXTENDED=1 runs it)" }

$T1 = '11111111-1111-4111-8111-111111111111'
$T2 = '22222222-2222-4222-8222-222222222222'
$Fabric = 'https://api.fabric.microsoft.com'
$Pbi = 'https://analysis.windows.net/powerbi/api'
$state = Join-Path $t 'az'
$proj = Join-Path $t 'proj'
$noContract = Join-Path $t 'nocontract'
$coopDir = Join-Path $t 'coop'
$agent = Join-Path $t 'agent'
$marker = Join-Path $agent '.az-ok'
$bin = if ($isWindowsHost) { Join-Path $t 'Program Files (x86)\Azure\wbin' } else { Join-Path $t 'bin' }

$saved = Save-Env @('PATH','HOME','USERPROFILE','COOP_DIR','COOP_AGENT_DIR','PI_CODING_AGENT_DIR','COOP_NO_ISOLATE',
           'COOP_SKIP_AZ','COOP_ASSUME_YES','COOP_TEST_AZ_STATE','NO_COLOR','AZURE_CORE_LOGIN_EXPERIENCE_V2')
$savedLocation = Get-Location
try {
  New-Item -ItemType Directory -Force -Path $bin, (Join-Path $t 'home'), (Join-Path $coopDir '.coop'), (Join-Path $proj '.coop'), $noContract | Out-Null
  $node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $fake = Join-Path $root 'tests\fixtures\fake-az.mjs'
  if ($isWindowsHost) {
    $azPath = Join-Path $bin 'az.cmd'
    [System.IO.File]::WriteAllText($azPath, "@`"$node`" `"$fake`" %*`r`n", [System.Text.Encoding]::ASCII)
  } else {
    $azPath = Join-Path $bin 'az'
    [System.IO.File]::WriteAllText($azPath, "#!/bin/sh`nexec `"$node`" `"$fake`" `"`$@`"`n", $utf8)
    & chmod +x $azPath
  }

  $env:PATH = "$bin$([System.IO.Path]::PathSeparator)$($env:PATH)"
  $env:HOME = Join-Path $t 'home'
  $env:USERPROFILE = $env:HOME
  $env:COOP_DIR = $coopDir
  $env:COOP_AGENT_DIR = $agent
  $env:COOP_TEST_AZ_STATE = $state
  $env:NO_COLOR = '1'
  # Remove-Item, not SetEnvironmentVariable($n, $null): PowerShell passes $null
  # to a .NET string parameter as '', which leaves an empty variable behind.
  foreach ($n in @('PI_CODING_AGENT_DIR','COOP_NO_ISOLATE','COOP_SKIP_AZ','COOP_ASSUME_YES','AZURE_CORE_LOGIN_EXPERIENCE_V2')) {
    Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue
  }
  . (Join-Path $root 'lib\common.ps1')
  $resolvedAz = (Get-Command az -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  if ($resolvedAz -ne $azPath) { throw "fixture must resolve the fake az (got $resolvedAz)" }

  function Reset-Az([string[]]$Tokens = @()) {
    Remove-Item -LiteralPath $state -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $state | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $state 'argv.log'), '')
    if ($Tokens.Count -gt 0) { [System.IO.File]::WriteAllText((Join-Path $state 'tokens'), (($Tokens -join "`n") + "`n")) }
  }
  function Set-AzState([string]$Name, [string]$Value) { [System.IO.File]::WriteAllText((Join-Path $state $Name), $Value) }
  function Get-AzLines { @([System.IO.File]::ReadAllLines((Join-Path $state 'argv.log')) | Where-Object { $_ }) }
  function Get-Probes { @(Get-AzLines | Where-Object { $_.StartsWith('account get-access-token ') }).Count }
  function Get-Logins { @(Get-AzLines | Where-Object { $_.StartsWith('login ') }).Count }
  function Set-Project([string]$Tenant) { [System.IO.File]::WriteAllText((Join-Path $proj '.coop\project.yml'), "fabric:`n  tenant_id: $Tenant`n", $utf8) }
  function Set-Config([string]$Json) {
    [System.IO.File]::WriteAllText((Join-Path $coopDir '.coop\config'), $Json, (New-Object System.Text.UTF8Encoding($true)))
  }
  function Get-WarnCount([string]$Out) { @($Out -split "`r?`n" | Where-Object { $_.StartsWith('! ') }).Count }
  function Probe-Line([string]$Tenant, [string]$Resource) { "account get-access-token --tenant $Tenant --resource $Resource --output none" }
  function Invoke-Preflight([switch]$AssumeYes) {
    $writer = New-Object System.IO.StringWriter
    $previous = [Console]::Error
    if ($AssumeYes) { $env:COOP_ASSUME_YES = '1' }
    try {
      [Console]::SetError($writer)
      Invoke-CoopAzPreflight
    } finally {
      [Console]::SetError($previous)
      Remove-Item Env:\COOP_ASSUME_YES -ErrorAction SilentlyContinue
    }
    return $writer.ToString()
  }
  # Stdin, stdout and stderr redirected: the launch is not interactive.
  function Invoke-PreflightRedirected {
    $child = Join-Path $t 'child.ps1'
    [System.IO.File]::WriteAllText($child, ". '$((Join-Path $root 'lib\common.ps1').Replace("'", "''"))'`nInvoke-CoopAzPreflight`nexit 0`n", $utf8)
    $in = Join-Path $t 'child.in'; $so = Join-Path $t 'child.out'; $se = Join-Path $t 'child.err'
    [System.IO.File]::WriteAllText($in, '')
    $p = Start-Process -FilePath $psExe -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $child + '"')) `
      -PassThru -NoNewWindow -RedirectStandardInput $in -RedirectStandardOutput $so -RedirectStandardError $se
    $null = $p.Handle
    $p.WaitForExit()
    return [pscustomobject]@{ Rc = $p.ExitCode; Out = ([System.IO.File]::ReadAllText($se) + [System.IO.File]::ReadAllText($so)).Trim() }
  }

  Set-Location -LiteralPath $proj

  # 1. Signed in: Fabric then Power BI, no sign-in, no output, marker holds the tenant.
  Set-Project $T1; Reset-Az @("$T1 *")
  $out = Invoke-Preflight
  $lines = @(Get-AzLines)
  if ((Get-Probes) -ne 2 -or $lines[0] -ne (Probe-Line $T1 $Fabric) -or $lines[1] -ne (Probe-Line $T1 $Pbi)) { Ko 'signed in: expected the Fabric probe, then the Power BI probe' ($lines -join "`n") }
  elseif ((Get-Logins) -ne 0 -or $out.Trim()) { Ko 'signed in: no sign-in and no output expected' $out }
  elseif (([System.IO.File]::ReadAllText($marker)) -ne $T1) { Ko 'signed in: marker should hold the tenant' }
  else { Ok 'signed in: Fabric then Power BI probe with --output none, marker stamped, silent' }

  # 2. Cache hit: no az call.
  Reset-Az @("$T1 *")
  $null = Invoke-Preflight
  if ((Get-AzLines).Count -ne 0) { Ko 'cached preflight must not invoke az' } else { Ok 'second preflight within 30 min performs no az invocation' }

  # 3. Tenant change re-probes.
  Set-Project $T2; Reset-Az @("$T2 *")
  $null = Invoke-Preflight
  if ((Get-Probes) -ne 2 -or ([System.IO.File]::ReadAllText($marker)) -ne $T2) { Ko 'tenant change should re-probe and re-stamp' } else { Ok 'tenant change re-runs the check and re-stamps' }

  # 4. Stale marker re-probes.
  Reset-Az @("$T2 *")
  (Get-Item -LiteralPath $marker -Force).LastWriteTime = (Get-Date).AddHours(-2)
  $null = Invoke-Preflight
  if ((Get-Probes) -ne 2) { Ko 'stale marker should re-probe' } else { Ok 'stale marker (past the TTL) re-runs the check' }

  # 5. COOP_SKIP_AZ=1 skips everything.
  Remove-Item -LiteralPath $marker -Force; Reset-Az
  $env:COOP_SKIP_AZ = '1'
  $out = Invoke-Preflight
  Remove-Item Env:\COOP_SKIP_AZ
  if ((Get-AzLines).Count -ne 0 -or $out.Trim()) { Ko 'COOP_SKIP_AZ=1 must skip the check' $out } else { Ok 'COOP_SKIP_AZ=1 skips everything' }

  # 6. Signed out, not interactive: one probe, never a sign-in, one line.
  Reset-Az
  $r = Invoke-PreflightRedirected
  if ($r.Rc -ne 0) { Ko "a failed check must not fail the launch (rc=$($r.Rc))" $r.Out }
  elseif ((Get-Probes) -ne 1 -or (Get-Logins) -ne 0) { Ko 'non-interactive: expected 1 probe and 0 logins' ((Get-AzLines) -join "`n") }
  elseif (Test-Path -LiteralPath $marker) { Ko 'a failed check must not leave a marker' }
  elseif ((Get-WarnCount $r.Out) -ne 1 -or -not $r.Out.Contains("not signed in to tenant $T2") -or -not $r.Out.Contains("az login --tenant $T2 --allow-no-subscriptions")) { Ko 'non-interactive: one line naming az login expected' $r.Out }
  elseif ($r.Out.Contains('[y/N]') -or $r.Out.Contains('refusing')) { Ko 'no prompt and no refusal expected' $r.Out }
  else { Ok 'signed out, non-interactive: one probe, no sign-in, one line naming az login' }

  # 7. Fabric token missing (Power BI present): one automatic sign-in.
  Reset-Az @("$T2 $Pbi")
  $out = Invoke-Preflight -AssumeYes
  $login = @(Get-AzLines | Where-Object { $_.StartsWith('login ') })
  if ($login.Count -ne 1 -or $login[0] -ne "login --tenant $T2 --allow-no-subscriptions --output none LXV2=off") { Ko 'missing Fabric token: one sign-in with LXV2=off expected' ((Get-AzLines) -join "`n") }
  elseif ((Get-Probes) -ne 3) { Ko 'sign-in must re-check both tokens' ((Get-AzLines) -join "`n") }
  elseif (-not (Test-Path -LiteralPath $marker) -or ([System.IO.File]::ReadAllText($marker)) -ne $T2) { Ko 'a verified sign-in stamps the marker' }
  elseif (-not $out.Contains("Signed in to Azure for tenant $T2")) { Ko 'sign-in success should be reported' $out }
  elseif ($null -ne $env:AZURE_CORE_LOGIN_EXPERIENCE_V2) { Ko 'AZURE_CORE_LOGIN_EXPERIENCE_V2 must be restored after the call' }
  else { Ok 'missing Fabric token: one automatic sign-in (LXV2=off), both tokens re-checked, marker stamped' }

  # 8. Power BI token missing: either token missing signs in.
  Remove-Item -LiteralPath $marker -Force; Reset-Az @("$T2 $Fabric")
  $null = Invoke-Preflight -AssumeYes
  if ((Get-Logins) -ne 1 -or (Get-Probes) -ne 4) { Ko 'missing Power BI token: 1 login and 4 probes expected' ((Get-AzLines) -join "`n") } else { Ok 'missing Power BI token also signs in' }

  # 9. Sign-in fails: exactly one attempt, one line, no marker.
  Remove-Item -LiteralPath $marker -Force; Reset-Az; Set-AzState 'login-rc' '1'
  $out = Invoke-Preflight -AssumeYes
  if ((Get-Logins) -ne 1 -or (Get-Probes) -ne 1) { Ko 'failed sign-in: 1 login, no retry, no re-probe' ((Get-AzLines) -join "`n") }
  elseif (Test-Path -LiteralPath $marker) { Ko 'a failed sign-in must not leave a marker' }
  elseif ((Get-WarnCount $out) -ne 1 -or -not $out.Contains('not verified') -or -not $out.Contains("az login --tenant $T2 --allow-no-subscriptions")) { Ko 'failed sign-in: one line naming az login expected' $out }
  else { Ok 'failed sign-in: one attempt, one line naming az login, launch continues' }

  # 10. Timeout (exit code above 128 maps to 124): never a sign-in.
  #      Extended lane: the fake az ends itself (exit 143 or SIGTERM).
  if ($extendedLane) {
    Reset-Az; Set-AzState 'mode' 'term'
    $out = Invoke-Preflight -AssumeYes
    if ((Get-Probes) -ne 1 -or (Get-Logins) -ne 0) { Ko 'timeout: 1 probe and 0 logins expected' ((Get-AzLines) -join "`n") }
    elseif (Test-Path -LiteralPath $marker) { Ko 'a timed-out check must not leave a marker' }
    elseif ((Get-WarnCount $out) -ne 1 -or -not $out.Contains("timed out for tenant $T2 (network or VPN?)") -or -not $out.Contains("az account get-access-token --tenant $T2 --resource $Fabric")) { Ko 'timeout line mismatch' $out }
    else { Ok 'timed-out check: no sign-in, one line naming the token command' }
  } else {
    Skipped '10 timed-out check (the fake az ends itself: exit 143 or SIGTERM)'
  }

  # 11. A non-authentication failure never signs in or says "not signed in".
  Reset-Az; Set-AzState 'mode' 'error'
  $out = Invoke-Preflight -AssumeYes
  if ((Get-Probes) -ne 1 -or (Get-Logins) -ne 0) { Ko 'non-auth error: 1 probe and 0 logins expected' ((Get-AzLines) -join "`n") }
  elseif ((Get-WarnCount $out) -ne 1 -or -not $out.Contains('(not an auth error)') -or $out.Contains('not signed in') -or $out.Contains('az login')) { Ko 'non-auth line mismatch' $out }
  elseif (-not $out.Contains('(not an auth error): HTTPSConnectionPool: connection reset by proxy')) { Ko "non-auth line does not carry az's reason" $out }
  else { Ok "non-auth failure: no sign-in, 'not an auth error' line with az's reason" }

  # 12. Tenant chain (no contract / TODO contracts / purpose / no config).
  Set-Config '{"schema_version":1,"azure":{"purpose":"client_resources","tenant_id":"tenant-ccc.example"}}'
  $chainOk = $true
  Set-Location -LiteralPath $noContract
  Reset-Az @('tenant-ccc.example *')
  $null = Invoke-Preflight
  if (@(Get-AzLines)[0] -ne (Probe-Line 'tenant-ccc.example' $Fabric)) { $chainOk = $false; Ko 'no contract: the config tenant must be used' ((Get-AzLines) -join "`n") }
  Set-Location -LiteralPath $proj
  foreach ($placeholder in @('"TODO: tenant id"', 'todo')) {
    Set-Project $placeholder; Reset-Az @('tenant-ccc.example *')
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    $null = Invoke-Preflight
    if (@(Get-AzLines)[0] -ne (Probe-Line 'tenant-ccc.example' $Fabric)) { $chainOk = $false; Ko "contract $placeholder must fall through to the config tenant" ((Get-AzLines) -join "`n") }
  }
  Set-Config '{"schema_version":1,"azure":{"purpose":"internal","tenant_id":"tenant-ccc.example"}}'
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  Reset-Az
  $out = Invoke-Preflight
  if ((Get-AzLines).Count -ne 0 -or $out.Trim()) { $chainOk = $false; Ko 'purpose internal: no az call and no output' $out }
  Remove-Item -LiteralPath (Join-Path $coopDir '.coop\config') -Force
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  Reset-Az
  $out = Invoke-Preflight
  if ((Get-AzLines).Count -ne 0 -or $out.Trim()) { $chainOk = $false; Ko 'no tenant anywhere: silent' $out }
  if ($chainOk) { Ok 'tenant chain: contract -> ~/.coop/config (BOM, client resources only) -> silent' }

  # 13. Injection boundary: an invalid contract tenant stops the chain; no az call.
  Set-Config '{"schema_version":1,"azure":{"tenant_id":"tenant-ccc.example"}}'
  $injectOk = $true
  foreach ($bad in @('"x&calc"', "'x`"y'", '"x&type nul>coop-injected"', 'TBD')) {
    Set-Project $bad; Reset-Az
    $out = Invoke-Preflight -AssumeYes
    if ((Get-AzLines).Count -ne 0) { $injectOk = $false; Ko "invalid tenant $bad must not reach az" }
    elseif ((Get-WarnCount $out) -ne 1 -or -not $out.Contains('not a GUID or domain name') -or $out.Contains('tenant-ccc')) { $injectOk = $false; Ko "invalid tenant $bad line mismatch" $out }
  }
  if (Test-Path -LiteralPath (Join-Path $proj 'coop-injected')) { $injectOk = $false; Ko 'an injected command created a file' }
  if ($injectOk) { Ok 'invalid contract tenant (x&calc, x"y, TBD): no az call, config tenant not used, one line' }

  # 13b. The contract is found the way the launchers and doctor find it (walk to
  #      the root, then the bundled one): from 8 folders below the project the
  #      contract tenant still wins over the config tenant.
  Set-Project $T1; Reset-Az @("$T1 *")
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  $deep = Join-Path $proj 'a\b\c\d\e\f\g\h'
  New-Item -ItemType Directory -Force -Path $deep | Out-Null
  Set-Location -LiteralPath $deep
  $null = Invoke-Preflight
  Set-Location -LiteralPath $proj
  if (@(Get-AzLines)[0] -ne (Probe-Line $T1 $Fabric)) { Ko 'a deep cwd must still use the contract tenant' ((Get-AzLines) -join "`n") }
  else { Ok 'deep cwd (8 folders below the project): the contract tenant, as doctor shows it' }

  # Wait up to 2 s for the process a hanging fake az recorded to be gone (no
  # record: az was stopped before it started).
  # A hanging fake az that ran out by itself (nothing stopped it) leaves hang.expired.
  function Test-HangExpired { Test-Path -LiteralPath (Join-Path $state 'hang.expired') }
  function Test-HangGone {
    $hangFile = Join-Path $state 'hang.pid'
    if (-not (Test-Path -LiteralPath $hangFile)) { return $true }
    $hangPid = [int]([System.IO.File]::ReadAllText($hangFile).Trim())
    # Bounded wait: the stopped probe's child exits on its own schedule, and under
    # a loaded host (the suite's parallel lanes) 2 seconds was not always enough.
    for ($i = 0; $i -lt 100; $i++) {
      if (-not (Get-Process -Id $hangPid -ErrorAction SilentlyContinue)) { return $true }
      Start-Sleep -Milliseconds 100
    }
    return $false
  }

  # 13c. A sign-in stopped at its limit (5 minutes, shortened here) prints exactly
  #      one line, and az is ended.
  #      Extended lane: a hanging sign-in stopped at its limit.
  if ($extendedLane) {
    $realInvokeCoopAz = ${function:Invoke-CoopAz}
    function Invoke-CoopAz {
      param([int]$Seconds, [string[]]$AzArgs, [switch]$Quiet)
      if ($Seconds -eq 300) { $Seconds = 3 }
      & $realInvokeCoopAz -Seconds $Seconds -AzArgs $AzArgs -Quiet:$Quiet
    }
    try {
      Set-Project $T2; Reset-Az; Set-AzState 'login-rc' 'hang'
      Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
      $out = Invoke-Preflight -AssumeYes
    } finally {
      ${function:Invoke-CoopAz} = $realInvokeCoopAz
    }
    $outLines = @($out -split "`r?`n" | Where-Object { $_.Trim() })
    if ((Get-Logins) -ne 1 -or (Get-Probes) -ne 1) { Ko 'stopped sign-in: 1 login, no re-probe' ((Get-AzLines) -join "`n") }
    elseif (Test-Path -LiteralPath $marker) { Ko 'a stopped sign-in must not leave a marker' }
    elseif ((Get-WarnCount $out) -ne 1 -or $outLines.Count -ne 2 -or -not $out.Contains('not verified') -or -not $out.Contains("az login --tenant $T2 --allow-no-subscriptions")) { Ko 'stopped sign-in: the Opening line and exactly one warning line expected' $out }
    elseif (-not (Test-HangGone)) { Ko 'the stopped sign-in is still running' }
    elseif (Test-HangExpired) { Ko 'the sign-in ran out by itself: the limit did not end it' }
    else { Ok 'sign-in stopped at its limit: exactly one line, az ended' }
  } else {
    Skipped '13c sign-in stopped at its limit (a hanging az, 3 s limit)'
  }

  # 13d. A stopped probe also ends az's child process: az.cmd (Windows) and the
  #      wbin/az wrapper script run Python as a child. POSIX gets a wrapper script.
  #      Extended lane: a hanging probe stopped at its limit.
  if ($extendedLane) {
    $pathBefore = $env:PATH
    if (-not $isWindowsHost) {
      $wrapBin = Join-Path $t 'wrapbin'
      New-Item -ItemType Directory -Force -Path $wrapBin | Out-Null
      $wrap = Join-Path $wrapBin 'az'
      [System.IO.File]::WriteAllText($wrap, "#!/bin/sh`n`"$node`" `"$fake`" `"`$@`"`n", $utf8)
      & chmod +x $wrap
      $env:PATH = "$wrapBin$([System.IO.Path]::PathSeparator)$($env:PATH)"
    }
    Reset-Az; Set-AzState 'mode' 'hang'
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
      $r = Invoke-CoopAz -Seconds 3 -Quiet -AzArgs @('account', 'get-access-token', '--tenant', $T2, '--resource', $Fabric, '--output', 'none')
    } finally {
      $env:PATH = $pathBefore
    }
    $sw.Stop()
    if ($r.Rc -ne 124) { Ko "a stopped probe must return 124 (got $($r.Rc))" }
    elseif ($sw.Elapsed.TotalSeconds -ge 15) { Ko "the stopped probe took $([int]$sw.Elapsed.TotalSeconds)s (limit 3s)" }
    elseif (-not (Test-HangGone)) { Ko "the az wrapper's child is still running" }
    elseif (Test-HangExpired) { Ko "the probe ran out by itself: the limit did not end it" }
    else { Ok "a stopped probe ends the az wrapper's child too (rc 124)" }
  } else {
    Skipped '13d a stopped probe also ends the az wrapper child (a hanging az, 3 s limit)'
  }

  # 13f. Ctrl-C during an in-console sign-in cancels it: one line, and the launch
  #      goes on. Needs a terminal, so POSIX legs drive pwsh through a Python pty.
  #      Extended lane: a hanging sign-in, a pty and a fixed wait.
  $py3 = if ($isWindowsHost) { $null } else { Get-Command python3 -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 }
  if ($py3 -and -not $extendedLane) { Skipped '13f Ctrl-C during the sign-in (a hanging az driven through a pty)' }
  elseif ($py3) {
    Set-Project $T2; Reset-Az; Set-AzState 'login-rc' 'hang'
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    $child = Join-Path $t 'ctrlc.ps1'
    [System.IO.File]::WriteAllText($child, ". '$((Join-Path $root 'lib\common.ps1').Replace("'", "''"))'`nInvoke-CoopAzPreflight`nWrite-Host 'AFTER-PREFLIGHT'`nexit 0`n", $utf8)
    $harness = Join-Path $t 'ctrlc.py'
    [System.IO.File]::WriteAllText($harness, @'
import os, pty, select, sys, time
hang = os.path.join(os.environ["COOP_TEST_AZ_STATE"], "hang.pid")
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], [sys.argv[1], "-NoLogo", "-NoProfile", "-File", sys.argv[2]])
buf, sent, start = b"", False, time.time()
while time.time() - start < 30:
    if select.select([fd], [], [], 0.2)[0]:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        buf += data
    # Ctrl-C once the fake az login is running (coop is then polling for it).
    if not sent and b"Opening Azure sign-in" in buf and os.path.exists(hang):
        time.sleep(0.5)
        os.write(fd, b"\x03")
        sent = True
os.waitpid(pid, 0)
sys.stdout.write(buf.decode("utf-8", "replace"))
'@, $utf8)
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $ptyOut = (& $py3.Source $harness $psExe $child 2>&1 | Out-String)
    $ErrorActionPreference = $eap
    if (-not $ptyOut.Contains('Opening Azure sign-in')) { Ko 'Ctrl-C case: the sign-in did not start' $ptyOut }
    elseif (-not $ptyOut.Contains("Azure sign-in for tenant $T2 is not verified") -or -not $ptyOut.Contains('AFTER-PREFLIGHT')) { Ko 'Ctrl-C must cancel the sign-in, print one line and let the launch continue' $ptyOut }
    elseif (Test-Path -LiteralPath $marker) { Ko 'a cancelled sign-in must not leave a marker' }
    elseif (-not (Test-HangGone)) { Ko 'the cancelled sign-in is still running' }
    elseif (Test-HangExpired) { Ko 'Ctrl-C did not cancel the sign-in: it ran out by itself' }
    else { Ok 'Ctrl-C during the sign-in: cancelled, one line, the launch continues' }
  }

  # 14. doctor.ps1's Azure sign-in row: probe only, never a sign-in, never the
  #     launch cache, same tenant chain.
  $doctor = Join-Path $root 'scripts\doctor.ps1'
  # Read the Azure row from `doctor.ps1 --json` (stdout, one document). Captured
  # human output is stderr, which Windows PowerShell 5.1 wraps at the console
  # width, so a long hint can split across lines.
  function Invoke-Doctor {
    $env:COOP_ASSUME_YES = '1'
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
      $raw = (& $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $doctor --json 2>$null | Out-String)
      # Parse only the document line (stray hint lines can precede it; see the issue linked in the PR).
      $doc = @($raw -split "`r?`n" | Where-Object { $_.StartsWith('{"checks"') }) | Select-Object -Last 1
      if (-not $doc) { return "(no JSON document) $raw" }
      $row = @(($doc | ConvertFrom-Json).checks | Where-Object { ([string]$_.name).StartsWith('Azure sign-in:') }) | Select-Object -First 1
      if ($null -eq $row) { return "(no Azure sign-in row) $raw" }
      return "$($row.status) | $($row.name) | $($row.hint)"
    } finally {
      $ErrorActionPreference = $eap
      Remove-Item Env:\COOP_ASSUME_YES -ErrorAction SilentlyContinue
    }
  }
  Set-Location -LiteralPath $noContract
  Remove-Item -LiteralPath (Join-Path $coopDir '.coop\config') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  # Doctor refreshes the coop-agent checkout at most once a day; a fresh stamp in
  # the sandbox agent dir keeps doctor.ps1 from fetching this checkout's origin
  # (as tests/fixtures/doctor-warehouse.test.ps1 does).
  New-Item -ItemType Directory -Force -Path $agent | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $agent '.coop-fetch-stamp'), '')
  $doctorOk = $true
  Reset-Az
  $dout = Invoke-Doctor
  if ($dout -ne 'warn | Azure sign-in: no client tenant configured | run: coop onboard --config-only') { $doctorOk = $false; Ko 'doctor.ps1 must warn when no client tenant is configured' $dout }
  Set-Config '{"schema_version":1,"azure":{"purpose":"client_resources","tenant_id":"tenant-9.example"}}'
  Reset-Az
  $dout = Invoke-Doctor
  if ($dout -ne 'warn | Azure sign-in: not signed in to tenant tenant-9.example | run: az login --tenant tenant-9.example --allow-no-subscriptions') { $doctorOk = $false; Ko 'doctor.ps1 must report the signed-out tenant with the sign-in command' $dout }
  elseif ((Get-Logins) -ne 0 -or (Get-Probes) -lt 1) { $doctorOk = $false; Ko 'doctor.ps1 must only probe, never sign in' ((Get-AzLines) -join "`n") }
  Reset-Az @('tenant-9.example *')
  $dout = Invoke-Doctor
  if (-not $dout.StartsWith('ok | Azure sign-in: signed in to tenant tenant-9.example')) { $doctorOk = $false; Ko 'doctor.ps1 must report the signed-in tenant' $dout }
  elseif ((Get-Logins) -ne 0) { $doctorOk = $false; Ko 'doctor.ps1 must never sign in' }
  if (Test-Path -LiteralPath $marker) { $doctorOk = $false; Ko 'doctor.ps1 must never write the launch cache (.az-ok)' }
  Set-Location -LiteralPath $proj
  if ($doctorOk) { Ok 'doctor.ps1 Azure sign-in row: no tenant hint, signed out (no login), signed in, .az-ok untouched' }
} catch {
  Ko "fixture error: $($_.Exception.Message)" ($_.ScriptStackTrace)
} finally {
  Set-Location -LiteralPath $savedLocation
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}

if ($fail -ne 0) { Write-Host "  $G_CROSS az sign-in preflight (PowerShell) tests FAILED"; exit 1 }
Write-Host '  az sign-in preflight (PowerShell) tests passed'
exit 0

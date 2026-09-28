#!/usr/bin/env pwsh
# H2: the PowerShell twin of tests/azcache.test.sh. Invoke-CoopAzPreflight and
# Get-CoopAzTokenRc (lib/common.ps1) against the shared fake az
# (tests/fixtures/fake-az.mjs): tenant chain, Fabric then Power BI check, the
# ~30-min .az-ok cache, automatic bounded sign-in, one-line failures. On Windows
# the fake az.cmd sits under "Program Files (x86)", the default 32-bit Azure CLI
# location. Stub-driven: no sleeps, no PTY, never the real az or ~/.coop.
# Assertions stay ASCII: Windows PowerShell 5.1 re-encodes child stderr.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$psExe = try { (Get-Process -Id $PID).Path } catch { 'pwsh' }
$isWindowsHost = ($env:OS -eq 'Windows_NT')
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-azcache-' + [guid]::NewGuid().ToString('N'))
$fail = 0
function Ok([string]$m) { Write-Host "  ok $m" }
function Ko([string]$m, [string]$out = '') { Write-Host "  x $m"; if ($out) { Write-Host $out }; $script:fail = 1 }

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
$utf8 = New-Object System.Text.UTF8Encoding($false)

$saved = @{}
$names = @('PATH','HOME','USERPROFILE','COOP_DIR','COOP_AGENT_DIR','PI_CODING_AGENT_DIR','COOP_NO_ISOLATE',
           'COOP_SKIP_AZ','COOP_ASSUME_YES','COOP_TEST_AZ_STATE','NO_COLOR','AZURE_CORE_LOGIN_EXPERIENCE_V2')
foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
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
  Reset-Az; Set-AzState 'mode' 'term'
  $out = Invoke-Preflight -AssumeYes
  if ((Get-Probes) -ne 1 -or (Get-Logins) -ne 0) { Ko 'timeout: 1 probe and 0 logins expected' ((Get-AzLines) -join "`n") }
  elseif (Test-Path -LiteralPath $marker) { Ko 'a timed-out check must not leave a marker' }
  elseif ((Get-WarnCount $out) -ne 1 -or -not $out.Contains("timed out for tenant $T2 (network or VPN?)") -or -not $out.Contains("az account get-access-token --tenant $T2 --resource $Fabric")) { Ko 'timeout line mismatch' $out }
  else { Ok 'timed-out check: no sign-in, one line naming the token command' }

  # 11. A non-authentication failure never signs in or says "not signed in".
  Reset-Az; Set-AzState 'mode' 'error'
  $out = Invoke-Preflight -AssumeYes
  if ((Get-Probes) -ne 1 -or (Get-Logins) -ne 0) { Ko 'non-auth error: 1 probe and 0 logins expected' ((Get-AzLines) -join "`n") }
  elseif ((Get-WarnCount $out) -ne 1 -or -not $out.Contains('(not an auth error)') -or $out.Contains('not signed in') -or $out.Contains('az login')) { Ko 'non-auth line mismatch' $out }
  else { Ok "non-auth failure: no sign-in, 'not an auth error' line" }

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
} catch {
  Ko "fixture error: $($_.Exception.Message)" ($_.ScriptStackTrace)
} finally {
  Set-Location -LiteralPath $savedLocation
  foreach ($n in $names) {
    if ($null -eq $saved[$n]) { Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
  }
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}

if ($fail -ne 0) { Write-Host '  x az sign-in preflight (PowerShell) tests FAILED'; exit 1 }
Write-Host '  az sign-in preflight (PowerShell) tests passed'
exit 0

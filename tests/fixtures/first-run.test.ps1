#!/usr/bin/env pwsh
# The launcher's first-run
# control flow in bin/coop.ps1 / lib/common.ps1, without a PTY.
#   A. Onboarding gate (in-process, stdin redirected): Test-CoopUserProfileMissing /
#      Test-CoopOnboardingMissing per state; the launch gate Set-CoopFirstRunLaunch
#      never starts the wizard, warns "Run: coop onboard" without a terminal and
#      reports rc 0 so the launch continues; the installer's Invoke-CoopMaybeOnboard
#      still never starts the wizard without an interactive terminal.
#   A2. First-run menu handoff (master plan FR1), in-process with -Interactive
#      passed explicitly: an interactive first launch sets COOP_FIRST_RUN=1 and
#      writes the <profile dir>\first-run stamp (once); a later launch sets nothing;
#      a non-interactive launch sets nothing and writes no stamp.
#   B. End-to-end `coop` (no args) with a stub pi on a fresh home: the launcher
#      continues into pi (coop-profile extension loaded), prints the incomplete-
#      onboarding warning, creates no profile and no first-run stamp, hands pi no
#      COOP_FIRST_RUN, does not prime the model login (stdin/stdout are redirected)
#      and exits 0; with a complete profile the warning is gone.
# The wizard itself (scripts/onboard.py) is covered by tests/onboard.test.sh; the
# launch never runs it any more.
# Sandboxed HOME/USERPROFILE/agent dir, never ~/.coop; COOP_SKIP_AZ=1, no network
# (fresh fetch stamp in the sandbox agent dir).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-first-run-ps-' + [guid]::NewGuid().ToString('N'))

$sandboxHome = Join-Path $t 'home'
$agent = Join-Path $t 'agent'
$marker = Join-Path $t 'marker'
$bin = Join-Path $t 'bin'

$saved = Save-Env @('PATH','HOME','USERPROFILE','COOP_DIR','COOP_AGENT_DIR','PI_CODING_AGENT_DIR','COOP_NO_ISOLATE','COOP_SKIP_AZ','COOP_AZ_BIN',
           'COOP_SKIP_EXT_CHECK','COOP_NO_ONBOARD','COOP_NO_MODEL_LOGIN','COOP_PRIME_MODEL_LOGIN','COOP_FIRST_RUN','NO_COLOR',
           'COOP_STANDARDS_ROOT','COOP_STANDARDS_STATE','COOP_STANDARDS_SNAPSHOT_ROOT')
try {
  New-Item -ItemType Directory -Force -Path $sandboxHome, $agent, $marker, $bin | Out-Null
  # The launch's once-a-day refresh fetches origin into this checkout; a fresh
  # stamp in the sandbox agent dir keeps the fixture offline and the tree untouched.
  [System.IO.File]::WriteAllText((Join-Path $agent '.coop-fetch-stamp'), '')

  $env:HOME = $sandboxHome
  $env:USERPROFILE = $sandboxHome
  $env:COOP_AGENT_DIR = $agent
  $env:COOP_SKIP_AZ = '1'
  $env:COOP_AZ_BIN = Join-Path $t 'nonexistent-az'
  $env:COOP_SKIP_EXT_CHECK = '1'
  $env:NO_COLOR = '1'
  foreach ($n in @('COOP_DIR','PI_CODING_AGENT_DIR','COOP_NO_ISOLATE','COOP_NO_ONBOARD','COOP_NO_MODEL_LOGIN','COOP_PRIME_MODEL_LOGIN',
                   'COOP_FIRST_RUN','COOP_STANDARDS_ROOT','COOP_STANDARDS_STATE','COOP_STANDARDS_SNAPSHOT_ROOT')) {
    Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue
  }

  $realPy = Get-FixturePython
  if (-not $realPy) { $c = Get-Command py -ErrorAction SilentlyContinue; if ($c) { $realPy = $c.Source } }
  if (-not $realPy) { throw 'python3 is required for the stub pi' }
  # Stub pi: records its argv and COOP_PRIME_MODEL_LOGIN, marks that it ran.
  $null = New-PyStub $bin 'pi' @"
import os, sys
m = r'''$marker'''
open(os.path.join(m, 'pi-args'), 'w', encoding='utf-8').write(' '.join(sys.argv[1:]) + '\n')
open(os.path.join(m, 'pi-prime-login'), 'w', encoding='utf-8').write(os.environ.get('COOP_PRIME_MODEL_LOGIN', '') + '\n')
open(os.path.join(m, 'pi-first-run'), 'w', encoding='utf-8').write(os.environ.get('COOP_FIRST_RUN', '') + '\n')
open(os.path.join(m, 'pi-ran'), 'w').close()
print('STUB-PI-READY')
sys.exit(0)
"@
  # npm stub: Add-CoopRuntimePaths asks `npm prefix -g`; answer nothing.
  $null = New-PyStub $bin 'npm' "import sys`nif sys.argv[1:2] == ['--version']:`n    print('10.0.0')`nsys.exit(0)`n"
  # A "python" that must never run: the onboarding wizard under a redirected stdin.
  $wizardPy = New-PyStub $bin 'wizard-python' "import os`nopen(os.path.join(r'''$marker''', 'wizard-ran'), 'w').close()`n"
  $env:PATH = "$bin$sep$($saved['PATH'])"

  function Read-Marker([string]$Name) {
    $p = Join-Path $marker $Name
    if (Test-Path -LiteralPath $p) { return ([System.IO.File]::ReadAllText($p)).Trim() } else { return $null }
  }
  function Clear-Markers { Get-ChildItem -LiteralPath $marker -File -ErrorAction SilentlyContinue | Remove-Item -Force }
  # Runs a PowerShell script with stdin/stdout/stderr redirected (no terminal).
  function Invoke-Redirected([string]$Script, [string[]]$ScriptArgs = @()) {
    $in = Join-Path $t 'child.in'; $so = Join-Path $t 'child.out'; $se = Join-Path $t 'child.err'
    [System.IO.File]::WriteAllText($in, '')
    $argList = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $Script + '"')) + $ScriptArgs
    $p = Start-Process -FilePath $psExe -ArgumentList $argList -WorkingDirectory $t `
      -PassThru -NoNewWindow -RedirectStandardInput $in -RedirectStandardOutput $so -RedirectStandardError $se
    $null = $p.Handle
    $p.WaitForExit()
    return [pscustomobject]@{ Rc = $p.ExitCode; Out = [System.IO.File]::ReadAllText($so); Err = [System.IO.File]::ReadAllText($se) }
  }
  function Get-CoopFirstRunStampFileAt([string]$Base) { return (Join-Path $Base '.coop\first-run') }
  function Reset-Home {
    Remove-Item -LiteralPath (Join-Path $sandboxHome '.coop') -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path (Join-Path $sandboxHome '.coop') | Out-Null
  }
  function Write-Profile([bool]$User, [bool]$Config) {
    Reset-Home
    if ($User) { [System.IO.File]::WriteAllText((Join-Path $sandboxHome '.coop\user.json'), '{"name":"Tester","communication_style":"balanced"}' + "`n", $utf8) }
    if ($Config) { [System.IO.File]::WriteAllText((Join-Path $sandboxHome '.coop\config'), '{"schema_version":1,"integrations":{}}' + "`n", $utf8) }
  }

  # --- A. onboarding gate without a terminal ---------------------------------------
  $gate = Join-Path $t 'gate.ps1'
  [System.IO.File]::WriteAllText($gate, (@(
    "`$ErrorActionPreference = 'Continue'",
    ". '$((Join-Path $root 'lib\common.ps1').Replace("'", "''"))'",
    "function Get-CoopPython { return '$($wizardPy.Replace("'", "''"))' }",
    "Write-Output ('profileMissing=' + (Test-CoopUserProfileMissing))",
    "Write-Output ('onboardingMissing=' + (Test-CoopOnboardingMissing))",
    "Write-Output ('inputRedirected=' + [Console]::IsInputRedirected)",
    "Set-CoopFirstRunLaunch",
    "Write-Output ('rc=' + `$script:CoopOnboardRc)",
    "Write-Output ('firstRunFlag=' + `$env:COOP_FIRST_RUN)",
    "Write-Output ('stamp=' + (Test-Path -LiteralPath (Get-CoopFirstRunStampFile) -PathType Leaf))",
    "Invoke-CoopMaybeOnboard",
    "Write-Output ('installRc=' + `$script:CoopOnboardRc)",
    "exit 0") -join "`n") + "`n", $utf8)
  function Get-GateValue([string]$Out, [string]$Key) {
    $line = @($Out -split "`r?`n" | Where-Object { $_.StartsWith("$Key=") }) | Select-Object -First 1
    if ($line) { return $line.Substring($Key.Length + 1).Trim() } else { return $null }
  }
  $warnText = 'onboarding is incomplete'

  foreach ($state in @(
      @{ Label = 'fresh home';        User = $false; Config = $false; Profile = 'True';  Missing = 'True';  Warn = $true },
      @{ Label = 'user.json only';    User = $true;  Config = $false; Profile = 'False'; Missing = 'True';  Warn = $true },
      @{ Label = 'config only';       User = $false; Config = $true;  Profile = 'True';  Missing = 'True';  Warn = $true },
      @{ Label = 'complete profile';  User = $true;  Config = $true;  Profile = 'False'; Missing = 'False'; Warn = $false })) {
    Write-Profile $state.User $state.Config
    Clear-Markers
    $r = Invoke-Redirected $gate
    $all = $r.Out + $r.Err
    $problems = @()
    if ($r.Rc -ne 0) { $problems += "exit $($r.Rc)" }
    if ((Get-GateValue $r.Out 'inputRedirected') -ne 'True') { $problems += 'stdin was not redirected' }
    if ((Get-GateValue $r.Out 'profileMissing') -ne $state.Profile) { $problems += "profileMissing=$(Get-GateValue $r.Out 'profileMissing')" }
    if ((Get-GateValue $r.Out 'onboardingMissing') -ne $state.Missing) { $problems += "onboardingMissing=$(Get-GateValue $r.Out 'onboardingMissing')" }
    if ((Get-GateValue $r.Out 'rc') -ne '0') { $problems += "CoopOnboardRc=$(Get-GateValue $r.Out 'rc')" }
    if ((Get-GateValue $r.Out 'installRc') -ne '0') { $problems += "installer gate rc=$(Get-GateValue $r.Out 'installRc')" }
    if ((Get-GateValue $r.Out 'firstRunFlag') -ne '') { $problems += 'COOP_FIRST_RUN set without a terminal' }
    if ((Get-GateValue $r.Out 'stamp') -ne 'False') { $problems += 'first-run stamp written without a terminal' }
    if ($all.Contains($warnText) -ne $state.Warn) { $problems += "warning present=$($all.Contains($warnText))" }
    if ($state.Warn -and -not $all.Contains('coop onboard')) { $problems += 'warning does not name coop onboard' }
    if (Test-Path -LiteralPath (Join-Path $marker 'wizard-ran')) { $problems += 'the wizard ran without a terminal' }
    if ($problems.Count -eq 0) { Ok "gate ($($state.Label)): missing=$($state.Missing), warns=$($state.Warn), rc 0, no wizard" }
    else { Ko "gate ($($state.Label)): $($problems -join '; ')" $all }
  }

  # --- A2. first-run menu handoff with an explicit interactive flag -----------------
  $hand = Join-Path $t 'handoff.ps1'
  [System.IO.File]::WriteAllText($hand, (@(
    "`$ErrorActionPreference = 'Continue'",
    ". '$((Join-Path $root 'lib\common.ps1').Replace("'", "''"))'",
    "function Get-CoopPython { return '$($wizardPy.Replace("'", "''"))' }",
    "Set-CoopFirstRunLaunch -Interactive ([bool]::Parse(`$args[0]))",
    "Write-Output ('rc=' + `$script:CoopOnboardRc)",
    "Write-Output ('firstRunFlag=' + `$env:COOP_FIRST_RUN)",
    "Write-Output ('stamp=' + (Test-Path -LiteralPath (Get-CoopFirstRunStampFile) -PathType Leaf))",
    "exit 0") -join "`n") + "`n", $utf8)
  Reset-Home
  Clear-Markers
  $r = Invoke-Redirected $hand @('True')
  $all = $r.Out + $r.Err
  if ((Get-GateValue $r.Out 'firstRunFlag') -eq '1' -and (Get-GateValue $r.Out 'stamp') -eq 'True' -and (Get-GateValue $r.Out 'rc') -eq '0') { Ok 'interactive first launch: COOP_FIRST_RUN=1, stamp written, rc 0' }
  else { Ko "interactive first launch: flag=$(Get-GateValue $r.Out 'firstRunFlag') stamp=$(Get-GateValue $r.Out 'stamp') rc=$(Get-GateValue $r.Out 'rc')" $all }
  if ($all.Contains('First run') -and $all.Contains('coop onboard') -and -not $all.Contains($warnText)) { Ok 'interactive first launch: one info line names the menu item and coop onboard' }
  else { Ko 'interactive first launch: info line missing or the non-interactive warning printed' $all }
  if (-not (Test-Path -LiteralPath (Join-Path $marker 'wizard-ran'))) { Ok 'interactive first launch: the wizard never ran' } else { Ko 'interactive first launch: the wizard ran' }
  if (-not (Test-Path -LiteralPath (Join-Path $sandboxHome '.coop\user.json'))) { Ok 'interactive first launch: no profile written' } else { Ko 'interactive first launch: user.json was written' }
  $r = Invoke-Redirected $hand @('True')
  if ((Get-GateValue $r.Out 'firstRunFlag') -eq '' -and (Get-GateValue $r.Out 'stamp') -eq 'True') { Ok 'second interactive launch: stamp present, no COOP_FIRST_RUN' }
  else { Ko "second interactive launch: flag=$(Get-GateValue $r.Out 'firstRunFlag') stamp=$(Get-GateValue $r.Out 'stamp')" ($r.Out + $r.Err) }
  Write-Profile $true $true
  $r = Invoke-Redirected $hand @('True')
  $all = $r.Out + $r.Err
  if ((Get-GateValue $r.Out 'firstRunFlag') -eq '1' -and -not $all.Contains('First run') -and -not $all.Contains($warnText)) { Ok 'complete profile, no stamp: menu handoff without any onboarding line' }
  else { Ko "complete profile, no stamp: flag=$(Get-GateValue $r.Out 'firstRunFlag')" $all }
  Reset-Home
  $r = Invoke-Redirected $hand @('False')
  if ((Get-GateValue $r.Out 'firstRunFlag') -eq '' -and (Get-GateValue $r.Out 'stamp') -eq 'False') { Ok 'non-interactive launch: no COOP_FIRST_RUN, no stamp' }
  else { Ko "non-interactive launch: flag=$(Get-GateValue $r.Out 'firstRunFlag') stamp=$(Get-GateValue $r.Out 'stamp')" ($r.Out + $r.Err) }

  # --- B. end-to-end: plain `coop` on a fresh home continues into pi ----------------
  $coop = Join-Path $root 'bin\coop.ps1'
  Reset-Home
  Clear-Markers
  $r = Invoke-Redirected $coop
  $all = $r.Out + $r.Err
  if (Test-Path -LiteralPath (Join-Path $marker 'pi-ran')) { Ok 'fresh home: launcher continued into pi' } else { Ko "fresh home: pi was never launched (rc=$($r.Rc))" $all }
  if ($r.Rc -eq 0) { Ok 'fresh home: launcher exits 0 (stub pi rc)' } else { Ko "fresh home: launcher exited $($r.Rc)" $all }
  $piArgs = Read-Marker 'pi-args'
  if ($piArgs -and $piArgs.Contains('coop-profile')) { Ok 'launched pi loads the coop-profile extension' }
  elseif (-not $piArgs) { Ko 'no pi invocation recorded' $all }
  else { Ko 'pi args missing coop-profile' $piArgs }
  if ($all.Contains($warnText) -and $all.Contains('coop onboard')) { Ok 'fresh home: incomplete-onboarding warning names coop onboard' } else { Ko 'fresh home: no incomplete-onboarding warning' $all }
  if (-not (Test-Path -LiteralPath (Join-Path $sandboxHome '.coop\user.json'))) { Ok 'fresh home: no profile written without a terminal' } else { Ko 'fresh home: user.json was written' }
  if ((Read-Marker 'pi-prime-login') -eq '') { Ok 'redirected launch does not prime the model login' } else { Ko "redirected launch primed the model login: $(Read-Marker 'pi-prime-login')" }
  if ((Read-Marker 'pi-first-run') -eq '') { Ok 'redirected launch hands pi no COOP_FIRST_RUN' } else { Ko "redirected launch set COOP_FIRST_RUN: $(Read-Marker 'pi-first-run')" }
  if (-not (Test-Path -LiteralPath (Get-CoopFirstRunStampFileAt $sandboxHome))) { Ok 'fresh home: no first-run stamp written without a terminal' } else { Ko 'fresh home: first-run stamp was written' }
  if (-not (Test-Path -LiteralPath (Join-Path $marker 'wizard-ran'))) { Ok 'fresh home: the wizard never ran' } else { Ko 'fresh home: the wizard ran' }

  # --- B2. complete profile: no warning, pi still launched ---------------------------
  Write-Profile $true $true
  Clear-Markers
  $r = Invoke-Redirected $coop
  $all = $r.Out + $r.Err
  if ((Test-Path -LiteralPath (Join-Path $marker 'pi-ran')) -and $r.Rc -eq 0) { Ok 'complete profile: launcher continues into pi, exit 0' } else { Ko "complete profile: pi-ran=$(Test-Path -LiteralPath (Join-Path $marker 'pi-ran')) rc=$($r.Rc)" $all }
  if (-not $all.Contains($warnText)) { Ok 'complete profile: no onboarding warning' } else { Ko 'complete profile: onboarding warning still printed' $all }
} catch {
  Ko "fixture error: $($_.Exception.Message)" ($_.ScriptStackTrace)
} finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}

if ($fail -ne 0) { Write-Host "  $G_CROSS first-run launcher (PowerShell) tests FAILED"; exit 1 }
Write-Host '  first-run launcher (PowerShell) tests passed'
exit 0

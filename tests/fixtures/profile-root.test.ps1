#!/usr/bin/env pwsh
# One profile root (master plan S3, issue #220): the lib/common.ps1 helpers
# resolve every profile location from ONE meaning of the variables.
#   COOP_DIR is the PARENT of .coop: Get-CoopProfileDir = $COOP_DIR\.coop (default
#   $HOME\.coop); Get-CoopConfigFile / Get-CoopUserProfileFile hang off it, and so
#   do the first-run gates (Test-CoopUserProfileMissing / Test-CoopOnboardingMissing).
#   The agent dir is one chain: PI_CODING_AGENT_DIR -> COOP_NO_ISOLATE truthy
#   (1|true|yes|on, any case) -> $HOME\.pi\agent -> COOP_AGENT_DIR -> <profile>\agent.
# Mirrors tests/coop-paths.test.py (Python) and tests/paths.test.mjs (Node).
# In-process, offline; writes only under a temp dir. $HOME is PowerShell's
# automatic variable (not re-read from $env:HOME in-process), so the default-path
# cases compare strings against it and never touch the real home.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-profile-root-' + [guid]::NewGuid().ToString('N'))
$G_CHECK = [char]0x2713; $G_CROSS = [char]0x2717
$fail = 0
function Ok([string]$m) { Write-Host "  $G_CHECK $m" }
function Ko([string]$m, [string]$Out = '') { Write-Host "  $G_CROSS $m"; if ($Out) { Write-Host $Out }; $script:fail = 1 }
function Same([string]$Label, [string]$Got, [string]$Want) {
  if ([System.IO.Path]::GetFullPath($Got) -eq [System.IO.Path]::GetFullPath($Want)) { Ok $Label } else { Ko "$Label (got '$Got', want '$Want')" }
}
function Clear-Vars { foreach ($n in @('COOP_DIR', 'COOP_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'COOP_NO_ISOLATE')) { Remove-Item "Env:\$n" -ErrorAction SilentlyContinue } }

$saved = @{}
$names = @('COOP_DIR', 'COOP_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'COOP_NO_ISOLATE')
foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
try {
  $cdir = Join-Path $t 'cdir'; $agent = Join-Path $t 'agent'; $pidir = Join-Path $t 'pidir'
  New-Item -ItemType Directory -Force -Path $cdir, $agent, $pidir | Out-Null
  . (Join-Path $root 'lib\common.ps1')
  $homeProfile = Join-Path $HOME '.coop'
  $personalPi = Join-Path (Join-Path $HOME '.pi') 'agent'

  # --- no variables: the historical ~/.coop defaults, byte for byte ------------
  Clear-Vars
  Same 'no vars: profile dir is $HOME\.coop'            (Get-CoopProfileDir)      $homeProfile
  Same 'no vars: config is $HOME\.coop\config'           (Get-CoopConfigFile)      (Join-Path $homeProfile 'config')
  Same 'no vars: user profile is $HOME\.coop\user.json'  (Get-CoopUserProfileFile) (Join-Path $homeProfile 'user.json')
  Same 'no vars: isolated agent dir is $HOME\.coop\agent' (Get-CoopPiAgentDir)     (Join-Path $homeProfile 'agent')
  Same 'no vars: effective agent dir is the isolated one' (Get-CoopEffectiveAgentDir) (Join-Path $homeProfile 'agent')
  Same 'personal Pi agent dir is $HOME\.pi\agent'        (Get-CoopPersonalPiAgentDir) $personalPi
  if (Test-CoopNoIsolate) { Ko 'no vars: isolation is on' } else { Ok 'no vars: isolation is on' }

  # --- COOP_DIR=X: X\.coop\... everywhere (X is the PARENT of .coop) -----------
  $env:COOP_DIR = $cdir
  Same 'COOP_DIR=X: profile dir is X\.coop'              (Get-CoopProfileDir)      (Join-Path $cdir '.coop')
  Same 'COOP_DIR=X: config is X\.coop\config'            (Get-CoopConfigFile)      (Join-Path $cdir '.coop\config')
  Same 'COOP_DIR=X: user profile is X\.coop\user.json'   (Get-CoopUserProfileFile) (Join-Path $cdir '.coop\user.json')
  Same 'COOP_DIR=X: isolated agent dir is X\.coop\agent' (Get-CoopPiAgentDir)      (Join-Path $cdir '.coop\agent')
  Same 'COOP_DIR=X: effective agent dir follows'         (Get-CoopEffectiveAgentDir) (Join-Path $cdir '.coop\agent')
  # The first-run gates read the same files onboarding writes there.
  if ((Test-CoopUserProfileMissing) -and (Test-CoopOnboardingMissing)) { Ok 'COOP_DIR=X: empty profile reports onboarding missing' } else { Ko 'COOP_DIR=X: empty profile must report onboarding missing' }
  New-Item -ItemType Directory -Force -Path (Join-Path $cdir '.coop') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $cdir '.coop\user.json'), '{"schema_version":1,"name":"T","communication":{"preset":"concise"}}')
  if (-not (Test-CoopUserProfileMissing) -and (Test-CoopOnboardingMissing)) { Ok 'COOP_DIR=X: user.json found, config still missing' } else { Ko 'COOP_DIR=X: user.json under X\.coop must satisfy the profile gate only' }
  [System.IO.File]::WriteAllText((Join-Path $cdir '.coop\config'), '{"schema_version":1}')
  if (-not (Test-CoopOnboardingMissing)) { Ok 'COOP_DIR=X: user.json + config satisfy the onboarding gate' } else { Ko 'COOP_DIR=X: config under X\.coop must satisfy the onboarding gate' }

  # --- COOP_AGENT_DIR only ----------------------------------------------------
  Clear-Vars; $env:COOP_AGENT_DIR = $agent
  Same 'COOP_AGENT_DIR only: isolated agent dir'          (Get-CoopPiAgentDir)        $agent
  Same 'COOP_AGENT_DIR only: effective agent dir'         (Get-CoopEffectiveAgentDir) $agent
  Same 'COOP_AGENT_DIR only: profile dir is untouched'    (Get-CoopProfileDir)        $homeProfile
  $env:COOP_DIR = $cdir
  Same 'COOP_AGENT_DIR beats COOP_DIR\.coop\agent'        (Get-CoopPiAgentDir)        $agent

  # --- PI_CODING_AGENT_DIR wins over everything --------------------------------
  Clear-Vars; $env:COOP_DIR = $cdir; $env:COOP_AGENT_DIR = $agent; $env:PI_CODING_AGENT_DIR = $pidir; $env:COOP_NO_ISOLATE = '1'
  Same 'PI_CODING_AGENT_DIR wins (over NO_ISOLATE, COOP_AGENT_DIR, COOP_DIR)' (Get-CoopEffectiveAgentDir) $pidir
  Same 'PI_CODING_AGENT_DIR does not change the isolated dir' (Get-CoopPiAgentDir) $agent

  # --- COOP_NO_ISOLATE truthiness: 1|true|yes|on, any case ---------------------
  Clear-Vars; $env:COOP_AGENT_DIR = $agent
  foreach ($v in @('1', 'true', 'TRUE', 'Yes', 'on', ' On ')) {
    $env:COOP_NO_ISOLATE = $v
    if (Test-CoopNoIsolate) { Ok "COOP_NO_ISOLATE='$v' is truthy" } else { Ko "COOP_NO_ISOLATE='$v' must be truthy" }
    Same "COOP_NO_ISOLATE='$v': effective agent dir is the personal ~/.pi/agent" (Get-CoopEffectiveAgentDir) $personalPi
  }
  foreach ($v in @('0', 'false', 'no', 'off', 'yes please', '')) {
    $env:COOP_NO_ISOLATE = $v
    if (Test-CoopNoIsolate) { Ko "COOP_NO_ISOLATE='$v' must not be truthy" } else { Ok "COOP_NO_ISOLATE='$v' is not truthy" }
    Same "COOP_NO_ISOLATE='$v': effective agent dir stays isolated" (Get-CoopEffectiveAgentDir) $agent
  }

  # --- no inline duplicates of the chain or the profile paths remain -----------
  $inline = @()
  foreach ($f in @('bin\coop.ps1', 'lib\common.ps1', 'scripts\sync.ps1', 'scripts\doctor.ps1', 'scripts\uninstall.ps1', 'scripts\install.ps1', 'scripts\update.ps1')) {
    $txt = [System.IO.File]::ReadAllText((Join-Path $root $f))
    foreach ($needle in @("'.coop\agent'", "'.coop\config'", "'.coop\user.json'", "'.pi\agent'", "expanduser('~/.coop")) {
      if ($txt.Contains($needle)) { $inline += "$f contains $needle" }
    }
  }
  if ($inline.Count -eq 0) { Ok 'launcher and scripts build profile paths only through the helpers' } else { Ko 'inline profile paths remain' ($inline -join "`n") }
}
finally {
  foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  profile-root tests passed' } else { Write-Host "  $G_CROSS profile-root tests FAILED" }
exit $fail

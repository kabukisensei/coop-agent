#!/usr/bin/env pwsh
# #167 (port of tests/login-present.test.sh): Pi writes an empty `{}` auth.json on
# startup, so "the file is non-empty" is not proof of a model login.
# Test-CoopPiLoginPresent (the effective agent dir) and Test-CoopAuthHasCredential
# (by path, the helper coop doctor uses for both auth.json files) must count only
# a stored provider credential. Offline; temp agent dirs only.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-login-present-' + [guid]::NewGuid().ToString('N'))
$G_CHECK = [char]0x2713; $G_CROSS = [char]0x2717
$fail = 0
function Ok([string]$m) { Write-Host "  $G_CHECK $m" }
function Ko([string]$m, [string]$Out = '') { Write-Host "  $G_CROSS $m"; if ($Out) { Write-Host $Out }; $script:fail = 1 }
function Write-Bytes([string]$Path, [byte[]]$Bytes) { [System.IO.File]::WriteAllBytes($Path, $Bytes) }
function Write-Text([string]$Path, [string]$Text) { Write-Bytes $Path ([System.Text.Encoding]::UTF8.GetBytes($Text)) }

$saved = @{}
$names = @('HOME', 'USERPROFILE', 'COOP_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'COOP_NO_ISOLATE', 'COOP_SKIP_AZ')
foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
try {
  $agent = Join-Path $t 'agent'
  $other = Join-Path $t 'other'
  New-Item -ItemType Directory -Force -Path $agent, $other, (Join-Path $t 'home') | Out-Null
  $env:HOME = Join-Path $t 'home'
  $env:USERPROFILE = $env:HOME
  $env:COOP_SKIP_AZ = '1'
  # The effective agent dir is the one Pi will load: PI_CODING_AGENT_DIR, isolation on.
  Remove-Item Env:\COOP_NO_ISOLATE -ErrorAction SilentlyContinue
  $env:COOP_AGENT_DIR = $agent
  $env:PI_CODING_AGENT_DIR = $agent

  . (Join-Path $root 'lib\common.ps1')

  $auth = Join-Path $agent 'auth.json'
  function Check([string]$Label, [bool]$Want) {
    $got = [bool](Test-CoopPiLoginPresent)
    if ($got -eq $Want) { Ok "effective agent dir: $Label" } else { Ko "effective agent dir: $Label (got $got, want $Want)" }
  }
  Check 'no auth.json is not a login' $false
  Write-Text $auth '';                        Check 'an empty auth.json is not a login' $false
  Write-Text $auth '{}';                      Check "Pi's startup {} is not a login" $false
  Write-Text $auth "{`n}`n";                  Check 'a pretty-printed {} is not a login' $false
  Write-Text $auth 'not json';                Check 'a corrupt auth.json is not a login' $false
  Write-Text $auth '{"openai-codex": {"type": "oauth", "access": "x"}}'
  Check 'a stored openai-codex credential is a login' $true
  Write-Text $auth "{`n  `"openai-codex`": {`n    `"type`": `"oauth`",`n    `"access`": `"x`"`n  }`n}`n"
  Check 'a pretty-printed stored credential is a login' $true
  Write-Bytes $auth ([byte[]](0xEF, 0xBB, 0xBF) + [System.Text.Encoding]::UTF8.GetBytes('{"openai":{"type":"oauth"}}'))
  Check 'a BOM-prefixed credential is a login' $true
  Write-Text $auth '{"openai-codex": {}}';    Check 'an empty provider entry is not a login' $false
  Write-Text $auth '{"openai-codex": "x"}';   Check 'a scalar provider entry is not a login' $false

  # coop doctor checks coop's auth.json and the shared ~/.pi/agent one with the same
  # helper, by path (the #167 fix first missed doctor).
  $otherAuth = Join-Path $other 'auth.json'
  function PathCheck([string]$Label, [bool]$Want) {
    $got = [bool](Test-CoopAuthHasCredential $otherAuth)
    if ($got -eq $Want) { Ok "by path: $Label" } else { Ko "by path: $Label (got $got, want $Want)" }
  }
  PathCheck 'a missing file is not a login' $false
  Write-Text $otherAuth '{}';                 PathCheck "Pi's startup {} is not a login" $false
  Write-Text $otherAuth '{"openai-codex":{"type":"oauth","access":"x"}}'; PathCheck 'a stored credential is a login' $true
  if ([bool](Test-CoopAuthHasCredential '')) { Ko 'an empty path is not a login' } else { Ok 'by path: an empty path is not a login' }

  $doctor = [System.IO.File]::ReadAllText((Join-Path $root 'scripts\doctor.ps1'))
  $uses = ([regex]::Matches($doctor, 'Test-CoopAuthHasCredential')).Count
  if ($uses -ge 2 -and -not $doctor.Contains('(Test-Path -LiteralPath $authA')) {
    Ok 'doctor.ps1 checks both auth.json files for a stored credential'
  } else {
    Ko 'doctor.ps1 must use Test-CoopAuthHasCredential for both auth.json files'
  }
}
finally {
  foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  login-present tests passed' } else { Write-Host "  $G_CROSS login-present tests FAILED" }
exit $fail

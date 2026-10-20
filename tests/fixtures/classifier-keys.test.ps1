#!/usr/bin/env pwsh
# The third-party classifier key check (master plan section 6.6): until a signed
# DPA, no TypeSafe, Cloudflare or OpenRouter key belongs on a client profile, so
# Get-CoopThirdPartyClassifierSigns (the doctor row) sees one in the environment
# or an auth.json and names it without echoing its value. The classifier trial
# that once used such keys (`coop router-trial`, J0) is gone; the policy row stays.
# Offline; temp dirs only.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-classifier-keys-' + [guid]::NewGuid().ToString('N'))
$utf8 = New-Object System.Text.UTF8Encoding($false)

$saved = Save-Env @('HOME', 'USERPROFILE', 'COOP_DIR', 'NO_COLOR', 'COOP_SKIP_AZ', 'TYPESAFE_API_KEY', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'OPENROUTER_API_KEY')
try {
  New-Item -ItemType Directory -Force -Path $t | Out-Null
  $null = New-SandboxHome (Join-Path $t 'home')
  $env:NO_COLOR = '1'
  $env:COOP_SKIP_AZ = '1'
  foreach ($n in @('TYPESAFE_API_KEY', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'OPENROUTER_API_KEY')) { Remove-Item ("Env:\" + $n) -ErrorAction SilentlyContinue }

  . (Join-Path $root 'lib\common.ps1')

  $auth = Join-Path $t 'auth.json'
  $signs = @(Get-CoopThirdPartyClassifierSigns -AuthPaths @($auth, ''))
  if ($signs.Count -eq 0) { Ok 'no key, no auth.json: no sign' } else { Ko "expected no sign, got: $($signs -join '; ')" }

  [System.IO.File]::WriteAllText($auth, '{"openai-codex":{"type":"oauth","access":"x"}}', $utf8)
  $signs = @(Get-CoopThirdPartyClassifierSigns -AuthPaths @($auth))
  if ($signs.Count -eq 0) { Ok 'the Codex sign-in alone is no sign' } else { Ko "Codex sign-in flagged: $($signs -join '; ')" }

  [System.IO.File]::WriteAllText($auth, '{"openai-codex":{"type":"oauth"},"typesafe":{"type":"api_key","key":"x"},"openrouter":{}}', $utf8)
  $signs = @(Get-CoopThirdPartyClassifierSigns -AuthPaths @($auth))
  if ($signs.Count -eq 1 -and $signs[0] -like 'typesafe sign-in stored in *') { Ok 'a stored typesafe entry is one sign; an empty openrouter entry is none' } else { Ko "auth.json signs: $($signs -join '; ')" }

  $env:TYPESAFE_API_KEY = 'x'
  $env:CLOUDFLARE_API_KEY = 'y'
  $signs = @(Get-CoopThirdPartyClassifierSigns -AuthPaths @($auth))
  if ($signs.Count -eq 3 -and ($signs -contains 'TYPESAFE_API_KEY is set') -and ($signs -contains 'CLOUDFLARE_API_KEY is set')) { Ok 'environment keys are signs, and never echo their value' } else { Ko "env signs: $($signs -join '; ')" }
  if (($signs -join ' ') -match '\by\b' -or ($signs -join ' ') -match 'key":"x') { Ko 'a sign printed a key value' }
  foreach ($n in @('TYPESAFE_API_KEY', 'CLOUDFLARE_API_KEY')) { Remove-Item ("Env:\" + $n) -ErrorAction SilentlyContinue }

  $doctor = [System.IO.File]::ReadAllText((Join-Path $root 'scripts\doctor.ps1'))
  if ($doctor.Contains('Get-CoopThirdPartyClassifierSigns')) { Ok 'doctor.ps1 carries the classifier-key row' } else { Ko 'doctor.ps1 must call Get-CoopThirdPartyClassifierSigns' }

  # The trial is gone: no command, no helper, no key reaches a vendor from coop.
  $launcher = [System.IO.File]::ReadAllText((Join-Path $root 'bin\coop.ps1'))
  if ($launcher -match 'router-trial' -or (Test-Path -LiteralPath (Join-Path $root 'lib\router-trial.mjs'))) { Ko 'the router-trial command or helper is still present' } else { Ok 'coop has no router-trial command or helper' }
}
finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  classifier-keys tests passed' } else { Write-Host "  $G_CROSS classifier-keys tests FAILED" }
exit $fail

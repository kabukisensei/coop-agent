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

  # The trial is gone: no helper, no dispatch to it, no key reaches a vendor from
  # coop. The word itself stays in the launcher as a retired command that says
  # so, instead of falling through to Pi as a message and opening a session.
  $launcher = [System.IO.File]::ReadAllText((Join-Path $root 'bin\coop.ps1'))
  if ($launcher -match 'router-trial\.mjs' -or $launcher -match 'Invoke-CoopRouterTrial' -or (Test-Path -LiteralPath (Join-Path $root 'lib\router-trial.mjs'))) { Ko 'the router-trial helper or its dispatch is still present' } else { Ok 'coop has no router-trial helper' }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
  if (-not $psi.FileName) { $psi.FileName = (Get-Command powershell).Source }
  $psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $root 'bin\coop.ps1')`" router-trial"
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardInput = $true
  $psi.Environment['COOP_SKIP_AZ'] = '1'
  $proc = [System.Diagnostics.Process]::Start($psi)
  $proc.StandardInput.Close()
  $ended = $proc.WaitForExit(60000)
  $text = ''
  if ($ended) { $text = $proc.StandardOutput.ReadToEnd() + $proc.StandardError.ReadToEnd() } else { try { $proc.Kill($true) } catch { } }
  if ($ended -and $proc.ExitCode -ne 0 -and $text -match 'router-trial was removed') { Ok 'coop router-trial says it was removed and exits non-zero, no session opens' }
  else { Ko "coop router-trial must say it was removed and exit non-zero (ended=$ended exit=$(if ($ended) { $proc.ExitCode } else { 'hung' }))" }
}
finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  classifier-keys tests passed' } else { Write-Host "  $G_CROSS classifier-keys tests FAILED" }
exit $fail

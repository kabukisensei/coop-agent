#!/usr/bin/env pwsh
# J0 (master plan section 6.6): `coop router-trial` and the third-party classifier
# key check. The command never runs on Windows (a client VM), prints the helper's
# usage with --help elsewhere, and Get-CoopThirdPartyClassifierSigns (the doctor
# row) sees a TypeSafe, Cloudflare or OpenRouter key in the environment or an
# auth.json. Offline; temp dirs only; no classifier is called.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$coop = Join-Path (Join-Path $root 'bin') 'coop.ps1'
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-router-trial-' + [guid]::NewGuid().ToString('N'))
$utf8 = New-Object System.Text.UTF8Encoding($false)
$onWindows = [bool]$isWindowsHost

$saved = Save-Env @('HOME', 'USERPROFILE', 'COOP_DIR', 'NO_COLOR', 'COOP_SKIP_AZ', 'TYPESAFE_API_KEY', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'OPENROUTER_API_KEY')
try {
  New-Item -ItemType Directory -Force -Path $t | Out-Null
  $null = New-SandboxHome (Join-Path $t 'home')
  $env:NO_COLOR = '1'
  $env:COOP_SKIP_AZ = '1'
  foreach ($n in @('TYPESAFE_API_KEY', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'OPENROUTER_API_KEY')) { Remove-Item ("Env:\" + $n) -ErrorAction SilentlyContinue }

  . (Join-Path $root 'lib\common.ps1')

  # --- the doctor helper ------------------------------------------------------
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

  # --- the command ------------------------------------------------------------
  $oldEa = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = (& $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $coop router-trial --help 2>&1 | Out-String)
  $rc = $LASTEXITCODE
  $ErrorActionPreference = $oldEa
  if ($onWindows) {
    if ($rc -ne 0 -and $out -match 'never on a client VM') { Ok 'router-trial refuses on Windows' } else { Ko "router-trial on Windows (rc=$rc): $out" }
  } elseif (Get-Command node -ErrorAction SilentlyContinue) {
    if ($rc -eq 0 -and $out -match 'usage: coop router-trial') { Ok 'router-trial --help prints the usage without Pi' } else { Ko "router-trial --help (rc=$rc): $out" }
  } else {
    if ($rc -ne 0 -and $out -match 'node is required') { Ok 'router-trial names node when it is missing' } else { Ko "router-trial without node (rc=$rc): $out" }
  }

  $set = Join-Path $root 'tests\fixtures\router-trial\prompts.jsonl'
  $rows = @([System.IO.File]::ReadAllLines($set) | Where-Object { $_.Trim() })
  if ($rows.Count -eq 50) { Ok 'the shipped set holds 50 rows' } else { Ko "the shipped set holds $($rows.Count) rows, want 50" }
}
finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  router-trial tests passed' } else { Write-Host "  $G_CROSS router-trial tests FAILED" }
exit $fail

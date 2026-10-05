#!/usr/bin/env pwsh
# coop unlock-prod (master plan G1): the human-only, time-bounded production-write
# unlock. Writes <profile dir>\prod-unlock.json for ONE client with a grant id,
# created_at and expires_at (UTC, round-trip format); --status reads it back;
# --revoke deletes it; bad minutes, a missing client and unknown options exit 1
# and write nothing. The command is deliberately absent from `coop help`.
# Sandboxed COOP_DIR, never ~/.coop; offline; no waits.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$coop = Join-Path $root 'bin\coop.ps1'
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-unlock-prod-' + [guid]::NewGuid().ToString('N'))
$saved = Save-Env @('COOP_DIR', 'COOP_SKIP_AZ', 'NO_COLOR')
try {
  New-Item -ItemType Directory -Force -Path $t | Out-Null
  $env:COOP_DIR = $t
  $env:COOP_SKIP_AZ = '1'
  $env:NO_COLOR = '1'
  $file = Join-Path (Join-Path $t '.coop') 'prod-unlock.json'

  $out = (& $psExe -NoProfile -File $coop unlock-prod Contoso --minutes 15 2>&1 | Out-String)
  if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $file)) { Ok 'unlock-prod <client> --minutes 15 writes the grant and exits 0' } else { Ko 'unlock-prod must write the grant and exit 0' $out }
  if ($out -match 'UNLOCKED for Contoso for 15 min \(grant [0-9a-f]{8}') { Ok 'the message names the client, the minutes and the grant id' } else { Ko 'message must name client, minutes and grant id' $out }
  $g = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
  if ($g.schema_version -eq 1 -and $g.client -eq 'Contoso' -and $g.minutes -eq 15 -and ([string]$g.id) -match '^[0-9a-f]{8}$') { Ok 'the file carries schema_version 1, the client, the minutes and an 8-hex id' } else { Ko 'grant fields' (Get-Content -LiteralPath $file -Raw) }
  $created = [DateTime]::Parse([string]$g.created_at, $null, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
  $expires = [DateTime]::Parse([string]$g.expires_at, $null, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
  if ([Math]::Abs((($expires - $created).TotalMinutes) - 15) -lt 0.01) { Ok 'expires_at is created_at plus the minutes' } else { Ko "expires_at - created_at must be 15 min (got $(($expires - $created).TotalMinutes))" }
  if ([Math]::Abs(((Get-Date).ToUniversalTime() - $created).TotalMinutes) -lt 5) { Ok 'created_at is now (UTC)' } else { Ko 'created_at must be about now' }
  $raw = Get-Content -LiteralPath $file -Raw
  if ($raw -match '"created_at":"\d{4}-\d{2}-\d{2}T[0-9:.]+Z"') { Ok 'timestamps are UTC round-trip strings the guardrail parses' } else { Ko 'timestamps must be ISO 8601 UTC' $raw }
  $bytes = [System.IO.File]::ReadAllBytes($file)
  if (-not ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)) { Ok 'the file has no BOM (JSON.parse in the guardrail reads it as is)' } else { Ko 'the unlock file must not carry a BOM' }

  $out = (& $psExe -NoProfile -File $coop unlock-prod --status 2>&1 | Out-String)
  if ($LASTEXITCODE -eq 0 -and $out -match 'UNLOCKED for Contoso: grant [0-9a-f]{8}, \d+ min left') { Ok '--status reports the active grant with minutes left' } else { Ko '--status must report the active grant' $out }

  foreach ($bad in @(@('Contoso', '--minutes', '900'), @('Contoso', '--minutes', 'soon'), @('--minutes', '5'), @('Contoso', '--force'), @('Contoso', 'Fabrikam'))) {
    $before = Get-Content -LiteralPath $file -Raw
    $out = (& $psExe -NoProfile -File $coop unlock-prod @bad 2>&1 | Out-String)
    $after = Get-Content -LiteralPath $file -Raw
    if ($LASTEXITCODE -ne 0 -and $before -eq $after) { Ok "unlock-prod $($bad -join ' ') exits 1 and leaves the grant untouched" } else { Ko "unlock-prod $($bad -join ' ') must exit 1 and change nothing" $out }
  }

  $out = (& $psExe -NoProfile -File $coop unlock-prod --revoke 2>&1 | Out-String)
  if ($LASTEXITCODE -eq 0 -and -not (Test-Path -LiteralPath $file) -and $out -match 'blocked again') { Ok '--revoke deletes the grant' } else { Ko '--revoke must delete the grant and say so' $out }
  $out = (& $psExe -NoProfile -File $coop unlock-prod --status 2>&1 | Out-String)
  if ($LASTEXITCODE -eq 0 -and $out -match 'blocked \(no unlock\)') { Ok '--status without a grant says production writes are blocked' } else { Ko '--status without a grant' $out }
  $out = (& $psExe -NoProfile -File $coop unlock-prod --revoke 2>&1 | Out-String)
  if ($LASTEXITCODE -eq 0) { Ok '--revoke with no grant is a no-op that exits 0' } else { Ko '--revoke with no grant must exit 0' $out }

  $out = (& $psExe -NoProfile -File $coop help 2>&1 | Out-String)
  if ($out -notmatch 'unlock-prod') { Ok 'coop help does not list unlock-prod (human-only, documented in guardrails-reference.md)' } else { Ko 'coop help must not list unlock-prod' }
} finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
exit $fail

#!/usr/bin/env pwsh
# The Features list in the terminal (FEATURES-DESIGN, the shared piece):
# `coop settings` lists this client's five feature switches, all off unless
# ~/.coop/config says true (absent keys are off), and `coop settings set <key>
# on|off` changes one through the one writer, lib\features.mjs. Set-CoopCleanupDays
# (and so `coop cleanup days|off`) delegates to the same writer: a BOM-prefixed
# config is read and rewritten keeping every key, and a corrupt one is reported
# and left byte for byte. Offline, sandbox home only.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$coop = Join-Path (Join-Path $root 'bin') 'coop.ps1'
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-settings-' + [guid]::NewGuid().ToString('N'))

$saved = Save-Env @('HOME', 'USERPROFILE', 'COOP_DIR', 'COOP_MACHINE_DIR', 'NO_COLOR', 'COOP_SKIP_AZ')
try {
  $home_ = New-SandboxHome (Join-Path $t 'home')
  $env:HOME = $home_
  $env:USERPROFILE = $home_
  $env:COOP_DIR = $home_
  $env:COOP_MACHINE_DIR = Join-Path $t 'machine'
  $env:NO_COLOR = '1'
  $env:COOP_SKIP_AZ = '1'
  . (Join-Path $root 'lib\common.ps1')
  $cfg = Join-Path $home_ '.coop\config'
  function Run-Coop([string[]]$CoopArgs) {
    $out = (Invoke-Native { & $psExe -NoProfile -File $coop @CoopArgs 2>&1 } | Out-String)
    return @{ Rc = $LASTEXITCODE; Out = $out }
  }
  $rows = @(
    '  Client instructions     off  instructions  (not in this version yet)',
    '  Change history          off  history  (not in this version yet)',
    '  Diff review comments    off  comments',
    '  Daily lineage refresh   off  docs-refresh  (not in this version yet)',
    '  SQL source control      off  sql-source')

  # --- every feature off: no config, then a config without the keys ------------------
  $r = Run-Coop @('settings')
  $missing = @($rows | Where-Object { -not $r.Out.Contains($_) })
  if ($r.Rc -eq 0 -and $missing.Count -eq 0 -and $r.Out -match 'Features \(all off unless you turn them on\)' -and $r.Out -match 'cleanup   45 days') { Ok 'coop settings with no config: the five features, all off, with their plain labels and keys' } else { Ko "coop settings (rc=$($r.Rc)) missing: $($missing -join ' | ')" $r.Out }
  if (-not (Test-Path -LiteralPath $cfg)) { Ok 'showing the settings writes nothing' } else { Ko 'coop settings created ~/.coop/config' }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cfg) | Out-Null
  [System.IO.File]::WriteAllText($cfg, '{"client":{"platform":"fabric"},"features":{},"sql_source_control":{}}', $utf8)
  $r = Run-Coop @('settings')
  $missing = @($rows | Where-Object { -not $r.Out.Contains($_) })
  if ($r.Rc -eq 0 -and $missing.Count -eq 0) { Ok 'absent keys are off' } else { Ko 'absent keys did not read as off' $r.Out }

  # --- set ---------------------------------------------------------------------------
  $r = Run-Coop @('settings', 'set', 'comments', 'on')
  $doc = Get-Content -LiteralPath $cfg -Raw | ConvertFrom-Json
  if ($r.Rc -eq 0 -and $doc.features.comments -eq $true -and $doc.client.platform -ceq 'fabric' -and $r.Out -match 'Diff review comments is on for this client \(applies at once') { Ok 'coop settings set comments on: saved, other keys kept, says when it applies' } else { Ko "set comments on (rc=$($r.Rc))" $r.Out }
  $r = Run-Coop @('settings', '--json')
  $shown = $null; try { $shown = $r.Out | ConvertFrom-Json } catch { }
  if ($r.Rc -eq 0 -and $shown -and (@($shown.features | Where-Object { $_.key -ceq 'comments' })[0].on -eq $true)) { Ok 'coop settings --json reads the same switch' } else { Ko 'coop settings --json' $r.Out }
  $before = [System.IO.File]::ReadAllText($cfg)
  $r = Run-Coop @('settings', 'set', 'history', 'on')
  if ($r.Rc -eq 2 -and $r.Out -match 'not in this version of coop yet' -and [System.IO.File]::ReadAllText($cfg) -ceq $before) { Ok 'a feature this version does not carry cannot be turned on' } else { Ko "set history on (rc=$($r.Rc))" $r.Out }
  $r = Run-Coop @('settings', 'set', 'autopilot', 'on')
  if ($r.Rc -eq 2 -and $r.Out -match "unknown feature 'autopilot'") { Ok 'an unknown key is refused and named' } else { Ko "unknown key (rc=$($r.Rc))" $r.Out }
  $r = Run-Coop @('settings', 'set', 'comments', 'maybe')
  if ($r.Rc -ne 0 -and $r.Out -match 'usage: coop settings') { Ok 'on|off only' } else { Ko "set comments maybe (rc=$($r.Rc))" $r.Out }
  $r = Run-Coop @('settings', 'set', 'sql-source', 'on')
  $doc = Get-Content -LiteralPath $cfg -Raw | ConvertFrom-Json
  if ($r.Rc -eq 0 -and $doc.sql_source_control.enabled -eq $true -and $doc.features.comments -eq $true) { Ok 'SQL source control is in the same list and writes its existing key' } else { Ko "set sql-source on (rc=$($r.Rc))" $r.Out }

  # --- Set-CoopCleanupDays through the one writer ------------------------------------
  $bom = New-Object System.Text.UTF8Encoding($true)
  [System.IO.File]::WriteAllText($cfg, '{"client":{"platform":"azure_sql"},"cleanup":{"days":30},"features":{"comments":true}}', $bom)
  $bytes = [System.IO.File]::ReadAllBytes($cfg)
  if ($bytes[0] -ne 0xEF) { Ko 'the fixture did not write a BOM' }
  Set-CoopCleanupDays 20
  $doc = Get-Content -LiteralPath $cfg -Raw -Encoding UTF8 | ConvertFrom-Json
  if ((Get-CoopCleanupDays) -eq 20 -and $doc.client.platform -ceq 'azure_sql' -and $doc.features.comments -eq $true) { Ok 'Set-CoopCleanupDays on a BOM-prefixed config: saved, every other key kept' } else { Ko 'Set-CoopCleanupDays on a BOM config' ([System.IO.File]::ReadAllText($cfg)) }
  $body = [regex]::Match([System.IO.File]::ReadAllText((Join-Path $root 'lib\common.ps1')), '(?s)function Set-CoopCleanupDays.*?\r?\n}\r?\n').Value
  if ($body -match 'Invoke-CoopFeaturesCli' -and $body -notmatch 'WriteAllText|ConvertTo-Json') { Ok 'Set-CoopCleanupDays delegates to lib\features.mjs (no rewrite of its own)' } else { Ko 'Set-CoopCleanupDays still writes the file itself' $body }

  $corrupt = '{"cleanup": {"days": 30}, oops'
  [System.IO.File]::WriteAllText($cfg, $corrupt, $utf8)
  $threw = ''
  try { Set-CoopCleanupDays 10 } catch { $threw = $_.Exception.Message }
  if ($threw -match 'not valid JSON' -and [System.IO.File]::ReadAllText($cfg) -ceq $corrupt) { Ok 'Set-CoopCleanupDays on a corrupt config: reported, file left byte for byte' } else { Ko "corrupt config: threw '$threw'" ([System.IO.File]::ReadAllText($cfg)) }
  $r = Run-Coop @('cleanup', 'days', '10')
  if ($r.Rc -ne 0 -and $r.Out -match 'could not save the setting' -and [System.IO.File]::ReadAllText($cfg) -ceq $corrupt) { Ok 'coop cleanup days on a corrupt config fails and leaves it' } else { Ko "coop cleanup days on corrupt (rc=$($r.Rc))" $r.Out }
  $r = Run-Coop @('settings', 'set', 'comments', 'on')
  if ($r.Rc -eq 1 -and [System.IO.File]::ReadAllText($cfg) -ceq $corrupt) { Ok 'coop settings set on a corrupt config fails and leaves it' } else { Ko "settings set on corrupt (rc=$($r.Rc))" $r.Out }
  $r = Run-Coop @('settings')
  $missing = @($rows | Where-Object { -not $r.Out.Contains($_) })
  if ($r.Rc -eq 0 -and $missing.Count -eq 0 -and $r.Out -match 'is not valid JSON') { Ok 'coop settings on a corrupt config: all off, and it says why' } else { Ko "settings on corrupt (rc=$($r.Rc))" $r.Out }

  # --- doctor: a "Features (this client)" section, one fact per feature that is on ----
  $script:doctor = Join-Path $root 'scripts\doctor.ps1'
  [System.IO.File]::WriteAllText($cfg, '{"features":{"comments":true,"history":true},"sql_source_control":{"enabled":true}}', $utf8)
  $drows = @(Get-DoctorRows | Where-Object { $_.section -ceq 'Features (this client)' })
  $names = @($drows | ForEach-Object { [string]$_.name })
  $commentsRow = @($names | Where-Object { $_ -like 'Diff review comments on:*' }).Count -eq 1
  $sqlRow = @($names | Where-Object { $_ -like 'SQL source control on*' }).Count -eq 1
  $noHistory = @($names | Where-Object { $_ -like '*Change history*' }).Count -eq 0
  if ($commentsRow -and $sqlRow -and $noHistory -and $drows.Count -eq 2) { Ok 'doctor: one row per feature that is on (a feature this version lacks stays off)' } else { Ko 'doctor Features rows' (Show-Rows $drows) }
  Remove-Item -LiteralPath $cfg -Force
  $drows = @(Get-DoctorRows | Where-Object { $_.section -ceq 'Features (this client)' })
  if ($drows.Count -eq 1 -and $drows[0].status -ceq 'ok' -and $drows[0].name -like 'every feature is off*') { Ok 'doctor: no config, every feature off in one ok row' } else { Ko 'doctor Features rows with no config' (Show-Rows $drows) }
  [System.IO.File]::WriteAllText($cfg, '{oops', $utf8)
  $drows = @(Get-DoctorRows | Where-Object { $_.section -ceq 'Features (this client)' })
  # The warning only: not also a green "every feature is off" row under it.
  if ($drows.Count -eq 1 -and @($drows | Where-Object { $_.status -ceq 'warn' -and $_.name -like '*is not valid JSON*' }).Count -eq 1 -and [System.IO.File]::ReadAllText($cfg) -ceq '{oops') { Ok 'doctor: a corrupt config is one warning (no ok row under it), and the file is left alone' } else { Ko 'doctor Features rows with a corrupt config' (Show-Rows $drows) }

  # --- a config coop cannot open (a lock, an AV scan, a permission) is not "not valid JSON" ---
  if ($env:OS -ne 'Windows_NT') {
    [System.IO.File]::WriteAllText($cfg, '{"features":{"comments":true}}', $utf8)
    & chmod 000 $cfg
    try {
      $r = Run-Coop @('settings')
      if ($r.Rc -eq 0 -and $r.Out -match 'could not be read just now' -and $r.Out -notmatch 'not valid JSON|fix or remove') { Ok 'coop settings on a config it cannot open: says so, and does not ask to remove it' } else { Ko "settings on an unreadable config (rc=$($r.Rc))" $r.Out }
      $drows = @(Get-DoctorRows | Where-Object { $_.section -ceq 'Features (this client)' })
      if ($drows.Count -eq 1 -and $drows[0].status -ceq 'warn' -and $drows[0].name -like '*could not be read just now*') { Ok 'doctor: a config it cannot open is one warning, not "not valid JSON"' } else { Ko 'doctor Features rows with an unreadable config' (Show-Rows $drows) }
    } finally { & chmod 600 $cfg }
  }
} finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  settings tests passed' } else { Write-Host "  $G_CROSS settings tests FAILED" }
exit $fail

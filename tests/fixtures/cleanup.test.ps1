#!/usr/bin/env pwsh
# The cleanup (lib/common.ps1, Aaron 2026-11-11): this client's saved sessions,
# backups and drafts older than the cleanup age go; everything newer, every other
# file and the roots stay. Get-CoopCleanupDays / Set-CoopCleanupDays (the
# ~/.coop/config setting), Invoke-CoopCleanup (age = the newer of creation and
# last-write time; dry run; emptied folders), Invoke-CoopDailyCleanup (once a day,
# off when the age is 0) and `coop cleanup` (bin\coop.ps1). Offline, no real home.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$coop = Join-Path (Join-Path $root 'bin') 'coop.ps1'
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-cleanup-' + [guid]::NewGuid().ToString('N'))

$saved = Save-Env @('HOME', 'USERPROFILE', 'COOP_DIR', 'COOP_MACHINE_DIR', 'COOP_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'COOP_NO_ISOLATE', 'NO_COLOR', 'COOP_SKIP_AZ')
try {
  $home_ = New-SandboxHome (Join-Path $t 'home')
  $env:HOME = $home_
  $env:USERPROFILE = $home_
  $env:COOP_DIR = $home_
  $env:COOP_MACHINE_DIR = Join-Path $t 'machine'
  $env:COOP_AGENT_DIR = $null
  $env:PI_CODING_AGENT_DIR = $null
  $env:COOP_NO_ISOLATE = $null
  $env:NO_COLOR = '1'
  $env:COOP_SKIP_AZ = '1'
  . (Join-Path $root 'lib\common.ps1')
  # The launch line is captured here: under Windows PowerShell 5.1 a child's stderr
  # line is an error record in the parent (tests/run.ps1 runs this file as a child).
  $infoLines = New-Object System.Collections.Generic.List[string]
  function Coop-Info([string]$m) { $script:infoLines.Add($m) }
  $profile_ = Join-Path $home_ '.coop'
  $sessions = Join-Path $profile_ 'agent\sessions'
  $backups = Join-Path $profile_ 'backups'
  $drafts = Join-Path $profile_ 'drafts'
  $now = [datetime]::UtcNow

  # A file whose creation and last-write times are both $AgeDays old.
  function New-AgedFile([string]$Path, [int]$AgeDays, [string]$Text = 'x') {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [System.IO.File]::WriteAllText($Path, $Text)
    $when = $now.AddDays(-1 * $AgeDays)
    [System.IO.File]::SetCreationTimeUtc($Path, $when)
    [System.IO.File]::SetLastWriteTimeUtc($Path, $when)
  }
  function Seed {
    New-AgedFile (Join-Path $sessions '--c--work--\old.jsonl') 90 '0123456789'
    New-AgedFile (Join-Path $sessions '--c--work--\new.jsonl') 3
    New-AgedFile (Join-Path $sessions '--c--gone--\old.jsonl') 60
    New-AgedFile (Join-Path $sessions 'notes.txt') 400
    New-AgedFile (Join-Path $backups 'repo\src\a.sql.20260101.bak') 200
    New-AgedFile (Join-Path $backups 'repo\src\b.sql.20261101.bak') 5
    New-AgedFile (Join-Path $drafts 'repo\old\deep\draft.sql') 46
    New-AgedFile (Join-Path $drafts 'repo\edge.sql') 44
    New-AgedFile (Join-Path $profile_ 'agent\auth.json') 500
    New-AgedFile (Join-Path $profile_ 'user.json') 500
  }
  Seed

  # --- the setting ------------------------------------------------------------------
  if ((Get-CoopCleanupDays) -eq 45) { Ok 'no config: the age is 45 days' } else { Ko "default age was $(Get-CoopCleanupDays)" }
  $cfg = Join-Path $profile_ 'config'
  [System.IO.File]::WriteAllText($cfg, '{"client":{"platform":"azure_sql"},"cleanup":{"days":"soon"}}', $utf8)
  if ((Get-CoopCleanupDays) -eq 45) { Ok 'an invalid age is the default' } else { Ko 'an invalid age was accepted' }
  Set-CoopCleanupDays 30
  $back = Get-Content -LiteralPath $cfg -Raw | ConvertFrom-Json
  if ((Get-CoopCleanupDays) -eq 30 -and $back.client.platform -ceq 'azure_sql') { Ok 'the age is saved and the other config keys are kept' } else { Ko 'saving the age lost a key or the value' (Get-Content -LiteralPath $cfg -Raw) }
  Set-CoopCleanupDays 45

  # --- dry run ----------------------------------------------------------------------
  $dry = @(Invoke-CoopCleanup -Days 45 -DryRun -Now $now)
  $s = $dry | Where-Object { $_.Name -ceq 'sessions' }
  if ($dry.Count -eq 3 -and $s.Files -eq 2 -and $s.Kept -eq 1 -and $s.Bytes -eq 11 -and (Test-Path -LiteralPath (Join-Path $sessions '--c--work--\old.jsonl'))) { Ok 'the dry run counts what is due and removes nothing' } else { Ko 'dry run' ($dry | Out-String) }

  # --- the cleanup ------------------------------------------------------------------
  $rows = @(Invoke-CoopCleanup -Days 45 -Now $now)
  $gone = @((Join-Path $sessions '--c--work--\old.jsonl'), (Join-Path $sessions '--c--gone--'), (Join-Path $backups 'repo\src\a.sql.20260101.bak'), (Join-Path $drafts 'repo\old'))
  $kept = @((Join-Path $sessions '--c--work--\new.jsonl'), (Join-Path $sessions 'notes.txt'), (Join-Path $backups 'repo\src\b.sql.20261101.bak'), (Join-Path $drafts 'repo\edge.sql'), (Join-Path $profile_ 'agent\auth.json'), (Join-Path $profile_ 'user.json'), $sessions, $backups, $drafts)
  $bad = @($gone | Where-Object { Test-Path -LiteralPath $_ }) + @($kept | Where-Object { -not (Test-Path -LiteralPath $_) })
  if ($bad.Count -eq 0) { Ok 'files past the age and the folders they emptied are gone; newer files, other files and the roots stay' } else { Ko 'cleanup removed or kept the wrong things' ($bad -join "`n") }
  $total = 0; foreach ($r in $rows) { $total += $r.Files }
  if ($total -eq 4) { Ok 'the rows count the four removed files' } else { Ko "removed count was $total" ($rows | Out-String) }

  # A backup copied from an old file keeps the old write time: its creation time counts.
  $copied = Join-Path $backups 'repo\copied.bak'
  New-AgedFile $copied 300
  [System.IO.File]::SetCreationTimeUtc($copied, $now.AddDays(-2))
  $creationKept = ([System.IO.File]::GetCreationTimeUtc($copied) -gt $now.AddDays(-45))
  $null = Invoke-CoopCleanup -Days 45 -Now $now
  if (-not $creationKept) { Ok 'this file system keeps no creation time (the creation-time case runs on Windows)' }
  elseif (Test-Path -LiteralPath $copied) { Ok 'a recent copy of an old file stays (the newer of creation and write time)' } else { Ko 'a backup made two days ago was removed for its source file''s old write time' }

  # A link inside a root is neither followed nor removed.
  if (-not $isWindowsHost) {
    $outside = Join-Path $t 'outside'
    New-AgedFile (Join-Path $outside 'precious.jsonl') 900
    New-Item -ItemType SymbolicLink -Path (Join-Path $sessions 'link') -Target $outside | Out-Null
    $null = Invoke-CoopCleanup -Days 45 -Now $now
    if ((Test-Path -LiteralPath (Join-Path $outside 'precious.jsonl')) -and (Test-Path -LiteralPath (Join-Path $sessions 'link'))) { Ok 'a link inside the sessions folder is not followed' } else { Ko 'the cleanup followed or removed a link' }
    Remove-Item -LiteralPath (Join-Path $sessions 'link') -Force
  }

  # Not isolated: the personal Pi sessions are not coop's to remove.
  $env:COOP_NO_ISOLATE = '1'
  $names = @(Get-CoopCleanupTargets | ForEach-Object { $_.Name })
  $env:COOP_NO_ISOLATE = $null
  if ($names -notcontains 'sessions' -and $names -contains 'backups') { Ok 'COOP_NO_ISOLATE: sessions are left out' } else { Ko "targets without isolation: $($names -join ',')" }

  # --- once a day at launch -----------------------------------------------------------
  Seed
  Set-CoopCleanupDays 0
  Invoke-CoopDailyCleanup -Now $now
  if ((Test-Path -LiteralPath (Join-Path $sessions '--c--work--\old.jsonl')) -and -not (Test-Path -LiteralPath (Get-CoopCleanupStampFile)) -and $infoLines.Count -eq 0) { Ok 'off (0 days): the launch removes nothing' } else { Ko 'the launch cleaned up while off' }
  Set-CoopCleanupDays 45
  Invoke-CoopDailyCleanup -Now $now
  if (-not (Test-Path -LiteralPath (Join-Path $sessions '--c--work--\old.jsonl')) -and $infoLines.Count -eq 1 -and $infoLines[0] -match 'removed 4 file\(s\) older than 45 days') { Ok 'the first launch removes what built up and says so in one line' } else { Ko 'the first launch left an old session' }
  New-AgedFile (Join-Path $sessions '--c--work--\later.jsonl') 80
  Invoke-CoopDailyCleanup -Now $now
  $sameDay = Test-Path -LiteralPath (Join-Path $sessions '--c--work--\later.jsonl')
  Invoke-CoopDailyCleanup -Now $now.AddDays(1)
  $nextDay = Test-Path -LiteralPath (Join-Path $sessions '--c--work--\later.jsonl')
  if ($sameDay -and -not $nextDay) { Ok 'a second launch the same day does nothing; the next day it runs again' } else { Ko "same day kept=$sameDay, next day kept=$nextDay" }

  # --- coop cleanup -------------------------------------------------------------------
  Seed
  $out = (Invoke-Native { & $psExe -NoProfile -File $coop cleanup 2>&1 } | Out-String)
  if ($LASTEXITCODE -eq 0 -and $out -match 'older than 45 days' -and $out -match 'sessions: \d+ file' -and (Test-Path -LiteralPath (Join-Path $sessions '--c--work--\old.jsonl'))) { Ok 'coop cleanup: shows the age and each folder, removes nothing' } else { Ko "coop cleanup status (rc=$LASTEXITCODE)" $out }
  $out = (Invoke-Native { & $psExe -NoProfile -File $coop cleanup now 2>&1 } | Out-String)
  if ($LASTEXITCODE -eq 0 -and $out -match 'sessions: removed 2 file' -and -not (Test-Path -LiteralPath (Join-Path $sessions '--c--work--\old.jsonl')) -and (Test-Path -LiteralPath (Join-Path $sessions '--c--work--\new.jsonl'))) { Ok 'coop cleanup now: removes what is due' } else { Ko "coop cleanup now (rc=$LASTEXITCODE)" $out }
  $out = (Invoke-Native { & $psExe -NoProfile -File $coop cleanup days 10 2>&1 } | Out-String)
  if ($LASTEXITCODE -eq 0 -and (Get-CoopCleanupDays) -eq 10) { Ok 'coop cleanup days 10: saved' } else { Ko "coop cleanup days (rc=$LASTEXITCODE)" $out }
  $out = (Invoke-Native { & $psExe -NoProfile -File $coop cleanup off 2>&1 } | Out-String)
  if ($LASTEXITCODE -eq 0 -and (Get-CoopCleanupDays) -eq 0) { Ok 'coop cleanup off: saved as 0' } else { Ko "coop cleanup off (rc=$LASTEXITCODE)" $out }
  $out = (Invoke-Native { & $psExe -NoProfile -File $coop cleanup now 2>&1 } | Out-String)
  if ($LASTEXITCODE -ne 0 -and $out -match 'cleanup is off') { Ok 'coop cleanup now while off: refuses' } else { Ko "coop cleanup now while off (rc=$LASTEXITCODE)" $out }
  $out = (Invoke-Native { & $psExe -NoProfile -File $coop cleanup days 0 2>&1 } | Out-String)
  if ($LASTEXITCODE -ne 0 -and $out -match 'usage: coop cleanup') { Ok 'coop cleanup days 0: usage' } else { Ko "coop cleanup days 0 (rc=$LASTEXITCODE)" $out }
} finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
exit $fail

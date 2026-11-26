#!/usr/bin/env pwsh
# Change history (FEATURES-DESIGN, CW2) in the terminal: `coop settings set history
# on` saves the switch through the one writer; the daily cleanup removes the
# history's month folders whose month ended more than cleanup.days ago, whole
# (never single files inside a month, never through a link, nothing when the
# cleanup is off); doctor's "Features (this client)" row reads the store's size
# from lib\action-history.mjs. Rows are read from doctor --json, so a line Windows
# PowerShell 5.1 wraps is never matched line by line. Offline, sandbox home only.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$coop = Join-Path (Join-Path $root 'bin') 'coop.ps1'
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-cw2-' + [guid]::NewGuid().ToString('N'))

$saved = Save-Env @('HOME', 'USERPROFILE', 'COOP_DIR', 'COOP_MACHINE_DIR', 'NO_COLOR', 'COOP_SKIP_AZ', 'COOP_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'COOP_NO_ISOLATE', 'TEMP', 'TMP', 'TMPDIR')
try {
  $temp_ = Join-Path $t 'temp'
  New-Item -ItemType Directory -Force -Path $temp_ | Out-Null
  $env:TEMP = $temp_; $env:TMP = $temp_; $env:TMPDIR = $temp_
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
  $cfg = Join-Path $home_ '.coop\config'
  function Run-Coop([string[]]$CoopArgs) {
    $out = (Invoke-Native { & $psExe -NoProfile -File $coop @CoopArgs 2>&1 } | Out-String)
    return @{ Rc = $LASTEXITCODE; Out = $out }
  }
  function Flat([string]$Text) { return (($Text -replace '\s+', ' ').Trim()) }

  # --- the switch --------------------------------------------------------------------
  $r = Run-Coop @('settings', 'set', 'history', 'on')
  $doc = $null
  try { $doc = Get-Content -LiteralPath $cfg -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $doc = $null }
  if ($r.Rc -eq 0 -and $null -ne $doc -and $doc.features.history -eq $true -and (Flat $r.Out) -match 'Change history is on for this client \(takes effect after /new or a restart\)') { Ok 'coop settings set history on: saved, says it takes effect after /new' } else { Ko "set history on (rc=$($r.Rc))" $r.Out }
  $r = Run-Coop @('settings')
  if ($r.Rc -eq 0 -and $r.Out.Contains('  Change history          on   history') -and -not (Flat $r.Out).Contains('history (not in this version yet)')) { Ok 'coop settings lists Change history on, with no "not in this version" note' } else { Ko 'coop settings after set history on' $r.Out }

  # --- whole-month cleanup ---------------------------------------------------------------
  $now = New-Object System.DateTime(2026, 11, 26, 12, 0, 0, [System.DateTimeKind]::Utc)
  $store = Join-Path $home_ '.coop\history\client-0123abcd'
  $other = Join-Path $home_ '.coop\history\sql-89abcdef'
  function New-Month([string]$Store, [string]$Month, [int]$FileAgeDays) {
    $dir = Join-Path $Store $Month
    New-Item -ItemType Directory -Force -Path (Join-Path $dir 'blobs') | Out-Null
    foreach ($f in @((Join-Path $dir 'log.jsonl'), (Join-Path $dir 'blobs\aa.gz'))) {
      [System.IO.File]::WriteAllText($f, 'x')
      [System.IO.File]::SetLastWriteTimeUtc($f, $now.AddDays(-1 * $FileAgeDays))
      [System.IO.File]::SetCreationTimeUtc($f, $now.AddDays(-1 * $FileAgeDays))
    }
    return $dir
  }
  # 45 days before 2026-11-26 is 2026-10-12: August and September ended before it,
  # October did not. File ages do not matter: a fresh file in an old month goes, an
  # old file in a recent month stays.
  $aug = New-Month $store '2026-08' 0
  $sep = New-Month $other '2026-09' 1
  $oct = New-Month $store '2026-10' 80
  $nov = New-Month $store '2026-11' 0
  $odd = Join-Path $store 'notes'
  New-Item -ItemType Directory -Force -Path $odd | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $odd 'keep.txt'), 'x')
  [System.IO.File]::SetLastWriteTimeUtc((Join-Path $odd 'keep.txt'), $now.AddDays(-400))
  $listed = @(Get-CoopStaleHistoryMonthDirs -Days 45 -Now $now)
  if ($listed.Count -eq 2 -and ($listed -contains $aug) -and ($listed -contains $sep)) { Ok 'the month folders whose month ended before the cleanup age are listed, in every repository store' } else { Ko 'stale history months' ($listed -join "`n") }
  if (@(Get-CoopStaleHistoryMonthDirs -Days 0 -Now $now).Count -eq 0) { Ok 'off (0 days): no month folder is old' } else { Ko 'history months listed while the cleanup was off' }
  $dry = @(Invoke-CoopCleanup -Days 45 -DryRun -Now $now)
  $h = @($dry | Where-Object { $_.Name -ceq 'old change history' })
  if ($h.Count -eq 2 -and @($h | Where-Object { $_.Files -eq 2 -and $_.Kept -eq 0 }).Count -eq 2 -and (Test-Path -LiteralPath $aug)) { Ok 'the dry run lists each old month folder whole and removes nothing' } else { Ko 'history dry run' ($dry | Format-Table Name, Files, Kept, Root | Out-String) }
  $null = Invoke-CoopCleanup -Days 0 -Now $now.AddDays(400)
  if ((Test-Path -LiteralPath $aug) -and (Test-Path -LiteralPath $sep)) { Ok 'off (0 days): the history stays' } else { Ko 'a month folder was removed while the cleanup was off' }
  $null = Invoke-CoopCleanup -Days 45 -Now $now
  $gone = @(@($aug, $sep) | Where-Object { Test-Path -LiteralPath $_ })
  $kept = @(@($oct, (Join-Path $oct 'log.jsonl'), (Join-Path $oct 'blobs\aa.gz'), $nov, (Join-Path $odd 'keep.txt')) | Where-Object { -not (Test-Path -LiteralPath $_) })
  if ($gone.Count -eq 0 -and $kept.Count -eq 0) { Ok 'old month folders go whole; a recent month keeps even its old files, and a folder with another name stays' } else { Ko 'history cleanup: the wrong folders went or stayed' (($gone + $kept) -join "`n") }

  # A month folder that is a link (a junction on Windows) is never followed or removed through.
  $outside = Join-Path $t 'outside'
  New-Item -ItemType Directory -Force -Path $outside | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $outside 'precious.txt'), 'x')
  $linked = Join-Path $store '2025-01'
  $made = $false
  try {
    if ($env:OS -eq 'Windows_NT') { New-Item -ItemType Junction -Path $linked -Target $outside | Out-Null } else { New-Item -ItemType SymbolicLink -Path $linked -Target $outside | Out-Null }
    $made = $true
  } catch { }
  if ($made) {
    $null = Invoke-CoopCleanup -Days 45 -Now $now
    if (Test-Path -LiteralPath (Join-Path $outside 'precious.txt')) { Ok 'a month folder that is a link is not followed' } else { Ko 'the cleanup removed a file through a linked month folder' }
  } else { Ok 'a month folder that is a link is not followed (no link could be made here; skipped)' }

  # --- doctor ---------------------------------------------------------------------------
  $script:doctor = Join-Path $root 'scripts\doctor.ps1'
  $drows = @(Get-DoctorRows | Where-Object { $_.section -ceq 'Features (this client)' })
  $row = @($drows | Where-Object { ([string]$_.name) -like 'Change history on:*' })
  if ($row.Count -eq 1 -and $row[0].status -ceq 'ok' -and (Flat ([string]$row[0].name)) -match '^Change history on: 2 month folder\(s\), \d+ B of 1(\.0)? GB \(.*history\)$') { Ok 'doctor: Change history on, its month folders and size against the 1 GB cap' } else { Ko 'doctor Change history row' (Show-Rows $drows) }

  # --- fix round (Neon's review B4) --------------------------------------------------------
  # Month names that are no real month (0000-01, 9999-12, 2026-13) are skipped, never a crash.
  $bad = @()
  foreach ($name in @('0000-01', '9999-12', '2026-13')) { $bad += (New-Month $store $name 0) }
  $listed = $null; $threw = ''
  try { $listed = @(Get-CoopStaleHistoryMonthDirs -Days 45 -Now $now) } catch { $threw = $_.Exception.Message }
  $targetsOk = $true
  try { $null = @(Get-CoopCleanupTargets -Days 45 -Now $now) } catch { $targetsOk = $false; $threw += $_.Exception.Message }
  if (-not $threw -and $targetsOk -and @($listed | Where-Object { $bad -contains $_ }).Count -eq 0) { Ok 'month names that are no real month (0000-01, 9999-12, 2026-13) are skipped, and the cleanup still runs' } else { Ko 'bad month names' "$threw $($listed -join ', ')" }
  foreach ($b in $bad) { Remove-Item -LiteralPath $b -Recurse -Force -ErrorAction SilentlyContinue }

  # An old month folder that is already empty goes too.
  $emptyOld = Join-Path $store '2026-07'
  New-Item -ItemType Directory -Force -Path $emptyOld | Out-Null
  $null = Invoke-CoopCleanup -Days 45 -Now $now
  if (-not (Test-Path -LiteralPath $emptyOld)) { Ok 'an empty old month folder is removed as well' } else { Ko 'an empty old month folder stayed' }

  # The current month is never listed, whatever the age.
  if (@(Get-CoopStaleHistoryMonthDirs -Days 1 -Now (New-Object System.DateTime(2026, 11, 30, 23, 0, 0, [System.DateTimeKind]::Utc)) | Where-Object { $_ -eq $nov }).Count -eq 0) { Ok 'the current month folder is never a cleanup target' } else { Ko 'the current month was listed' }

  # A linked store, and a linked history folder itself: never followed, nothing listed through them.
  $hroot = Join-Path $home_ '.coop\history'
  $outside2 = Join-Path $t 'outside2'
  $old = Join-Path $outside2 'client-0123abcd\2025-02'
  New-Item -ItemType Directory -Force -Path $old | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $old 'precious.txt'), 'x')
  function New-Link([string]$Path, [string]$Target) {
    try {
      if ($env:OS -eq 'Windows_NT') { New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null } else { New-Item -ItemType SymbolicLink -Path $Path -Target $Target | Out-Null }
      return $true
    } catch { return $false }
  }
  $linkedStore = Join-Path $hroot 'linked-89abcdef'
  if (New-Link $linkedStore (Join-Path $outside2 'client-0123abcd')) {
    $null = Invoke-CoopCleanup -Days 45 -Now $now
    if (Test-Path -LiteralPath (Join-Path $old 'precious.txt')) { Ok 'a store folder that is a link is not followed' } else { Ko 'the cleanup removed a file through a linked store' }
    [System.IO.Directory]::Delete($linkedStore)
  } else { Ok 'a store folder that is a link is not followed (no link could be made here; skipped)' }
  $realHistory = Join-Path $t 'history-real'
  Move-Item -LiteralPath $hroot -Destination $realHistory
  if (New-Link $hroot $outside2) {
    $listed = @(Get-CoopStaleHistoryMonthDirs -Days 45 -Now $now)
    $null = Invoke-CoopCleanup -Days 45 -Now $now
    if ($listed.Count -eq 0 -and (Test-Path -LiteralPath (Join-Path $old 'precious.txt'))) { Ok 'a history folder that is itself a link is never followed: nothing listed, nothing removed' } else { Ko 'the cleanup followed a linked history folder' ($listed -join "`n") }
    $drows = @(Get-DoctorRows | Where-Object { $_.section -ceq 'Features (this client)' })
    $row = @($drows | Where-Object { ([string]$_.name) -like 'Change history on:*' })
    if ($row.Count -eq 1 -and $row[0].status -ceq 'warn' -and (Flat ([string]$row[0].hint)) -match 'link or junction') { Ok 'doctor warns that the history folder is a link and is neither measured nor cleaned' } else { Ko 'doctor linked history row' (Show-Rows $drows) }
    [System.IO.Directory]::Delete($hroot)
  } else { Ok 'a history folder that is itself a link is never followed (no link could be made here; skipped)' }
  Move-Item -LiteralPath $realHistory -Destination $hroot
} finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  change history tests passed' } else { Write-Host "  $G_CROSS change history tests FAILED" }
exit $fail

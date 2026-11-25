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

$saved = Save-Env @('HOME', 'USERPROFILE', 'COOP_DIR', 'COOP_MACHINE_DIR', 'COOP_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'COOP_NO_ISOLATE', 'NO_COLOR', 'COOP_SKIP_AZ', 'TEMP', 'TMP', 'TMPDIR')
try {
  # The cleanup looks in the temp folder for Pi's per-call files: a sandbox one,
  # never the machine's.
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

  # --- what coop and its parts leave behind (2026-11-24) -------------------------------
  Set-CoopCleanupDays 45
  $memory = Join-Path $profile_ 'agent\pi-hermes-memory'
  New-AgedFile (Join-Path $memory '.failures.md.recovery-1') 9
  New-AgedFile (Join-Path $memory '.USER.md.retired-7') 8
  New-AgedFile (Join-Path $memory '.failures.md.recovery-2') 3
  New-AgedFile (Join-Path $memory 'failures.md') 300
  New-AgedFile (Join-Path $memory 'MEMORY.md') 300
  New-AgedFile (Join-Path $memory 'sessions.db') 300
  New-AgedFile (Join-Path $temp_ 'pi-codemode-0a1b') 3
  New-AgedFile (Join-Path $temp_ 'pi-mcp-output-abc123\out.json') 3
  New-AgedFile (Join-Path $temp_ 'pi-bash-ff') 1
  New-AgedFile (Join-Path $temp_ 'pi-mcp-output-new\out.json') 0
  New-AgedFile (Join-Path $temp_ 'someone-elses.tmp') 300
  New-AgedFile (Join-Path $temp_ 'other\pi-codemode-nested') 300
  New-AgedFile (Join-Path $profile_ 'web-app-profile\Default\Cache\data_0') 130
  New-AgedFile (Join-Path $profile_ 'web-app-profile\Local State') 130
  # This user's standards copies: kept while launches use them, removed once
  # launches use the machine's folder and the marker says so.
  New-AgedFile (Join-Path $profile_ 'standards\canonical-generations\abc\checkout\SQL.md') 30
  # Old .backups folders: the repository's (untracked) goes by age, one with a
  # tracked file is left alone, the client folder's goes by age.
  $client = Join-Path $t 'client'
  $repoA = Join-Path $client 'repo-a'
  $repoB = Join-Path $client 'repo-b'
  $hasGit = [bool](Get-Command git -ErrorAction SilentlyContinue)
  foreach ($r in @($repoA, $repoB)) {
    New-Item -ItemType Directory -Force -Path $r | Out-Null
    if ($hasGit) { & git -C $r init -q 2>$null | Out-Null } else { New-Item -ItemType Directory -Force -Path (Join-Path $r '.git') | Out-Null }
  }
  New-AgedFile (Join-Path $repoA '.backups\a.sql.20260601_101010.bak') 170
  New-AgedFile (Join-Path $repoA '.backups\run_20261120\b.sql.bak') 4
  New-AgedFile (Join-Path $repoA 'src\keep.sql.bak') 400
  New-AgedFile (Join-Path $repoB '.backups\mine.bak') 400
  if ($hasGit) {
    & git -C $repoB add -f .backups/mine.bak 2>$null | Out-Null
    # git add rewrites nothing in the work tree, but be sure of the age.
    [System.IO.File]::SetCreationTimeUtc((Join-Path $repoB '.backups\mine.bak'), $now.AddDays(-400))
    [System.IO.File]::SetLastWriteTimeUtc((Join-Path $repoB '.backups\mine.bak'), $now.AddDays(-400))
  }
  New-AgedFile (Join-Path $client '.backups\data-doc-build_20260909\site\index.html') 76
  [System.IO.File]::WriteAllText((Join-Path $profile_ 'client.json'), (@{ schema_version = 1; client = 'Fixture'; root = $client; project_file = '' } | ConvertTo-Json -Compress), $utf8)

  $names = @(Get-CoopCleanupTargets $repoA | ForEach-Object { $_.Name })
  if ($names -notcontains 'old standards copies') { Ok 'the user standards folder is no target while launches may use it' } else { Ko 'the user standards folder was a target with no marker' }
  $dry = @(Invoke-CoopCleanup -Days 45 -DryRun -Now $now -StartDir $repoA)
  $dryNames = @($dry | ForEach-Object { $_.Name })
  $m = $dry | Where-Object { $_.Name -ceq 'memory copies' }
  if ($m.Files -eq 2 -and $m.Kept -eq 1 -and $m.Days -eq 7 -and (Test-Path -LiteralPath (Join-Path $memory '.failures.md.recovery-1')) -and $dryNames -contains 'temp files' -and $dryNames -contains 'old coop web profile' -and @($dry | Where-Object { $_.Name -ceq 'old backups' }).Count -eq 2) { Ok 'the dry run lists the leftovers with each one''s own age and removes nothing' } else { Ko 'leftover dry run' ($dry | Format-Table Name, Files, Kept, Days, Root | Out-String) }

  $null = Invoke-CoopCleanup -Days 45 -Now $now -StartDir $repoA
  $gone = @((Join-Path $memory '.failures.md.recovery-1'), (Join-Path $memory '.USER.md.retired-7'), (Join-Path $temp_ 'pi-codemode-0a1b'), (Join-Path $temp_ 'pi-mcp-output-abc123'), (Join-Path $profile_ 'web-app-profile'), (Join-Path $repoA '.backups\a.sql.20260601_101010.bak'), (Join-Path $client '.backups'))
  $kept = @((Join-Path $memory '.failures.md.recovery-2'), (Join-Path $memory 'failures.md'), (Join-Path $memory 'MEMORY.md'), (Join-Path $memory 'sessions.db'), (Join-Path $temp_ 'pi-bash-ff'), (Join-Path $temp_ 'pi-mcp-output-new\out.json'), (Join-Path $temp_ 'someone-elses.tmp'), (Join-Path $temp_ 'other\pi-codemode-nested'), (Join-Path $repoA '.backups\run_20261120\b.sql.bak'), (Join-Path $repoA 'src\keep.sql.bak'), (Join-Path $profile_ 'standards\canonical-generations\abc\checkout\SQL.md'))
  if ($hasGit) { $kept += (Join-Path $repoB '.backups\mine.bak') }
  $bad = @($gone | Where-Object { Test-Path -LiteralPath $_ }) + @($kept | Where-Object { -not (Test-Path -LiteralPath $_) })
  if ($bad.Count -eq 0) { Ok 'old memory copies, Pi temp files, the coop web profile and old .backups go; live memory, other temp files, newer backups and a .bak outside .backups stay' } else { Ko 'leftover cleanup removed or kept the wrong things' ($bad -join "`n") }

  if ($hasGit) {
    $null = Invoke-CoopCleanup -Days 45 -Now $now -StartDir $repoB
    if (Test-Path -LiteralPath (Join-Path $repoB '.backups\mine.bak')) { Ok 'a .backups folder with a file git tracks is left alone' } else { Ko 'the cleanup removed a tracked file' }
  } else { Ok 'no git here: the tracked .backups case runs where git is installed' }

  # The marker and a writable machine folder: the user's old standards copies go.
  New-Item -ItemType Directory -Force -Path (Join-Path $env:COOP_MACHINE_DIR 'standards') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $profile_ 'standards-moved'), "2026-10-22`n", $utf8)
  if ((Get-CoopStandardsLocation).Tier -ceq 'machine') {
    $null = Invoke-CoopCleanup -Days 45 -Now $now -StartDir $repoA
    if (-not (Test-Path -LiteralPath (Join-Path $profile_ 'standards')) -and (Test-Path -LiteralPath (Join-Path $env:COOP_MACHINE_DIR 'standards'))) { Ok 'after the move to the machine folder the user''s old standards copies go; the machine folder stays' } else { Ko 'old standards copies stayed, or the machine folder went' }
  } else { Ko 'the fixture machine folder was not used for standards' }

  # --- large backups, NUL files, old window data (2026-11-25) --------------------------
  # A backup of 50 MB or more is kept a week; a smaller one keeps the cleanup age.
  function New-SizedFile([string]$Path, [long]$Bytes, [int]$AgeDays) {
    New-AgedFile $Path $AgeDays
    $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open)
    try { $fs.SetLength($Bytes) } finally { $fs.Dispose() }
    [System.IO.File]::SetCreationTimeUtc($Path, $now.AddDays(-1 * $AgeDays))
    [System.IO.File]::SetLastWriteTimeUtc($Path, $now.AddDays(-1 * $AgeDays))
  }
  $bigOld = Join-Path $backups 'repo\tools\setup.exe.20261110.bak'
  $bigNew = Join-Path $backups 'repo\tools\setup.exe.20261122.bak'
  $smallOld = Join-Path $backups 'repo\src\c.sql.20261110.bak'
  $justUnder = Join-Path $backups 'repo\src\model.20261110.bak'
  New-SizedFile $bigOld 50MB 10
  New-SizedFile $bigNew 50MB 3
  New-SizedFile $justUnder (50MB - 1) 10
  New-AgedFile $smallOld 10
  $dry = @(Invoke-CoopCleanup -Days 45 -DryRun -Now $now -StartDir $repoA)
  $large = $dry | Where-Object { $_.Name -ceq 'large backups' }
  $plain = $dry | Where-Object { $_.Name -ceq 'backups' }
  if ($large.Files -eq 1 -and $large.Kept -eq 1 -and $large.Days -eq 7 -and $plain.KeptBytes -lt 100MB) { Ok 'the dry run lists a large backup once, with its week' } else { Ko 'large backups dry run' ($dry | Format-Table Name, Files, Kept, KeptBytes, Days | Out-String) }
  $null = Invoke-CoopCleanup -Days 45 -Now $now -StartDir $repoA
  if (-not (Test-Path -LiteralPath $bigOld) -and (Test-Path -LiteralPath $bigNew) -and (Test-Path -LiteralPath $justUnder) -and (Test-Path -LiteralPath $smallOld)) { Ok 'a 50 MB backup goes after a week; a newer one, one just under the size and a small one of the same age stay' } else { Ko 'large backups: the wrong files went or stayed' }
  $null = Invoke-CoopCleanup -Days 0 -Now $now.AddDays(30) -StartDir $repoA
  if (Test-Path -LiteralPath $bigNew) { Ok 'off (0 days): a large backup stays' } else { Ko 'a large backup was removed while the cleanup was off' }
  Remove-Item -LiteralPath $bigNew, $justUnder -Force

  # A file named NUL in the launch folder, the repository, the client folder or
  # the home folder goes after a day; nothing below those folders is looked at.
  $launch = Join-Path $repoA 'src'
  $nulDirs = @(Get-CoopStrayNulDirs $launch)
  $wantDirs = @($launch, $repoA, $client, $home_) | ForEach-Object { [System.IO.Path]::GetFullPath($_).TrimEnd('\', '/') }
  if ($nulDirs.Count -eq 4 -and @($wantDirs | Where-Object { $nulDirs -notcontains $_ }).Count -eq 0) { Ok 'NUL files are looked for in the launch folder, the repository, the client folder and the home folder' } else { Ko 'stray NUL folders' ($nulDirs -join "`n") }
  if ($isWindowsHost) {
    function New-NulFile([string]$Dir, [int]$AgeDays) {
      $p = '\\?\' + (Join-Path $Dir 'NUL')
      [System.IO.File]::WriteAllText($p, 'stray output')
      [System.IO.File]::SetCreationTimeUtc($p, $now.AddDays(-1 * $AgeDays))
      [System.IO.File]::SetLastWriteTimeUtc($p, $now.AddDays(-1 * $AgeDays))
    }
    function Test-NulFile([string]$Dir) { return [System.IO.File]::Exists('\\?\' + (Join-Path $Dir 'NUL')) }
    New-NulFile $repoA 3
    New-NulFile $home_ 3
    New-NulFile $launch 0
    New-NulFile (Join-Path $repoA '.backups') 30
    $null = Invoke-CoopCleanup -Days 45 -Now $now -StartDir $launch
    if (-not (Test-NulFile $repoA) -and -not (Test-NulFile $home_) -and (Test-NulFile $launch) -and (Test-NulFile (Join-Path $repoA '.backups'))) { Ok 'a NUL file older than a day goes from the repository and the home folder; today''s stays' } else { Ko "NUL files: repo=$(Test-NulFile $repoA) home=$(Test-NulFile $home_) launch=$(Test-NulFile $launch)" }
    [System.IO.File]::Delete('\\?\' + (Join-Path $launch 'NUL'))
    [System.IO.File]::Delete('\\?\' + (Join-Path (Join-Path $repoA '.backups') 'NUL'))
  } else {
    $names = @(Get-CoopCleanupTargets $launch | ForEach-Object { $_.Name })
    New-AgedFile (Join-Path $t 'nul\NUL') 3
    New-AgedFile (Join-Path $t 'nul2\NUL\work.sql') 3
    $asFile = Get-CoopCleanupFiles (Join-Path $t 'nul') @('*') @('NUL') $true
    $asDir = Get-CoopCleanupFiles (Join-Path $t 'nul2') @('*') @('NUL') $true
    if ($names -notcontains 'stray NUL files' -and $asFile.Files.Count -eq 1 -and $asDir.Files.Count -eq 0 -and $asDir.Dirs.Count -eq 0) { Ok 'NUL files are a Windows target only; a folder with that name is never entered' } else { Ko "NUL off Windows: targets=$($names -join ','), file=$($asFile.Files.Count), folder files=$($asDir.Files.Count)" }
  }

  # A folder literally named %SystemDrive% (Windows writes one for a program
  # started without that variable): its ProgramData tree goes after a day, an
  # empty one at once, and the folder with it; anything else inside stays.
  $literalA = Join-Path $repoA '%SystemDrive%'
  $literalB = Join-Path $client '%SystemDrive%'
  $literalC = Join-Path $home_ '%SystemDrive%'
  New-AgedFile (Join-Path $literalA 'ProgramData\Microsoft\Windows\Caches\cversions.2.db') 3
  New-Item -ItemType Directory -Force -Path (Join-Path $literalB 'ProgramData\Microsoft\Windows\Caches') | Out-Null
  New-AgedFile (Join-Path $literalC 'ProgramData\Microsoft\Windows\Caches\cversions.2.db') 3
  New-AgedFile (Join-Path $literalC 'mine\notes.txt') 300
  New-AgedFile (Join-Path $repoA 'src\%SystemDrive%\ProgramData\x.db') 300
  $null = Invoke-CoopCleanup -Days 0 -Now $now -StartDir $repoA
  $offKept = (Test-Path -LiteralPath $literalA) -and (Test-Path -LiteralPath $literalB)
  $null = Invoke-CoopCleanup -Days 45 -Now $now -StartDir $repoA
  $bad = @(@($literalA, $literalB, (Join-Path $literalC 'ProgramData')) | Where-Object { Test-Path -LiteralPath $_ }) + @(@((Join-Path $literalC 'mine\notes.txt'), (Join-Path $repoA 'src\%SystemDrive%\ProgramData\x.db')) | Where-Object { -not (Test-Path -LiteralPath $_ ) })
  if ($offKept -and $bad.Count -eq 0) { Ok 'a folder literally named %SystemDrive% goes with its ProgramData tree, an empty one too; other content in it and one below the launch folders stay; off keeps them' } else { Ko "stray %SystemDrive% folders (off kept=$offKept)" ($bad -join "`n") }

  # The window's data folders: one no window has opened for the cleanup age goes
  # whole; the one used last stays, and so does a folder with another name.
  $data = Join-Path $profile_ 'desktop\data'
  function New-WindowData([string]$Name, [int]$AgeDays) {
    $d = Join-Path $data $Name
    New-AgedFile (Join-Path $d 'settings.json') $AgeDays '{}'
    New-AgedFile (Join-Path $d 'Local State') $AgeDays
    New-AgedFile (Join-Path $d 'Cache\Cache_Data\data_0') $AgeDays
    New-AgedFile (Join-Path $d 'attachments\note.txt') $AgeDays
    foreach ($sub in @((Join-Path $d 'Cache\Cache_Data'), (Join-Path $d 'Cache'), (Join-Path $d 'attachments'), $d)) { [System.IO.Directory]::SetLastWriteTimeUtc($sub, $now.AddDays(-1 * $AgeDays)) }
    return $d
  }
  $only = New-WindowData 'aaaaaaaaaaaa' 400
  if (@(Get-CoopStaleDesktopDataDirs -Days 45 -Now $now).Count -eq 0) { Ok 'the only window data folder stays however old it is' } else { Ko 'the only window data folder was listed as old' }
  $stale = New-WindowData '0123456789ab' 90
  $recent = New-WindowData 'bbbbbbbbbbbb' 20
  $inUse = New-WindowData 'cccccccccccc' 2
  $other = New-WindowData 'not-a-window' 400
  # A folder whose own time is old but which holds something newer is in use.
  $touched = New-WindowData 'dddddddddddd' 90
  New-AgedFile (Join-Path $touched 'Local State') 5
  [System.IO.Directory]::SetLastWriteTimeUtc($touched, $now.AddDays(-90))
  if (@(Get-CoopStaleDesktopDataDirs -Days 0 -Now $now).Count -eq 0) { Ok 'off (0 days): no window data folder is old' } else { Ko 'a window data folder was listed while the cleanup was off' }
  $dry = @(Invoke-CoopCleanup -Days 45 -DryRun -Now $now -StartDir $repoA)
  $w = @($dry | Where-Object { $_.Name -ceq 'old window data' })
  if ($w.Count -eq 2 -and $w[0].Files -eq 4 -and $w[0].Kept -eq 0 -and (Test-Path -LiteralPath $stale)) { Ok 'the dry run lists each old window data folder whole and removes nothing' } else { Ko 'old window data dry run' ($dry | Format-Table Name, Files, Kept, Root | Out-String) }
  $null = Invoke-CoopCleanup -Days 45 -Now $now -StartDir $repoA
  $bad = @(@($stale, $only) | Where-Object { Test-Path -LiteralPath $_ }) + @(@($recent, $inUse, $other, $touched, (Join-Path $inUse 'settings.json'), (Join-Path $recent 'attachments\note.txt'), $data) | Where-Object { -not (Test-Path -LiteralPath $_) })
  if ($bad.Count -eq 0) { Ok 'window data folders unused for the cleanup age go whole; recent ones, the one in use, one with something newer inside and a folder with another name stay' } else { Ko 'old window data: the wrong folders went or stayed' ($bad -join "`n") }

  # --- the report (dev VM, 2026-11-24) --------------------------------------------------
  # A read-only file's size is counted (git's files in the old standards copies).
  $ro1 = Join-Path $backups 'repo\ro\pack-1.bak'
  $ro2 = Join-Path $backups 'repo\ro\pack-2.bak'
  New-AgedFile $ro1 90 ('x' * 1000)
  New-AgedFile $ro2 90 ('x' * 500)
  (Get-Item -LiteralPath $ro1).IsReadOnly = $true
  $rows = @(Invoke-CoopCleanup -Days 45 -Now $now -StartDir $repoA)
  $b = $rows | Where-Object { $_.Name -ceq 'backups' }
  if (-not (Test-Path -LiteralPath $ro1) -and $b.Files -eq 2 -and $b.Bytes -eq 1500 -and $b.Failed -eq 0 -and $b.Folders -eq 1) { Ok 'a removed read-only file counts with its full size, and the folder it emptied is counted' } else { Ko 'read-only size' ($b | Format-List | Out-String) }
  # Empty Pi temp folders: an old one goes and is reported, one made just now stays.
  $emptyOld = Join-Path $temp_ 'pi-mcp-output-emptyold'
  $emptyNew = Join-Path $temp_ 'pi-mcp-output-emptynew'
  New-Item -ItemType Directory -Force -Path $emptyOld, $emptyNew | Out-Null
  [System.IO.Directory]::SetLastWriteTimeUtc($emptyOld, $now.AddDays(-5))
  $dry = @(Invoke-CoopCleanup -Days 45 -DryRun -Now $now -StartDir $repoA)
  $dryTemp = $dry | Where-Object { $_.Name -ceq 'temp files' }
  $rows = @(Invoke-CoopCleanup -Days 45 -Now $now -StartDir $repoA)
  $tempRow = $rows | Where-Object { $_.Name -ceq 'temp files' }
  if ($dryTemp.Folders -eq 1 -and (Test-Path -LiteralPath $emptyNew) -and -not (Test-Path -LiteralPath $emptyOld) -and $tempRow.Folders -eq 1) { Ok 'an old empty Pi temp folder is listed, removed and reported; one made just now stays' } else { Ko "empty temp folders: dry=$($dryTemp.Folders) removed=$($tempRow.Folders) new kept=$(Test-Path -LiteralPath $emptyNew)" }
  New-Item -ItemType Directory -Force -Path $emptyOld | Out-Null
  [System.IO.Directory]::SetLastWriteTimeUtc($emptyOld, $now.AddDays(-5))
  $out = (Invoke-Native { & $psExe -NoProfile -File $coop cleanup now 2>&1 } | Out-String)
  if ($out -match 'temp files: removed 0 file\(s\).* and 1 empty folder\(s\)') { Ok 'coop cleanup now names the empty folders it removed' } else { Ko 'coop cleanup now did not report the empty folder' $out }

  # Off is off for the leftovers too.
  New-AgedFile (Join-Path $temp_ 'pi-codemode-late') 30
  $null = Invoke-CoopCleanup -Days 0 -Now $now -StartDir $repoA
  if (Test-Path -LiteralPath (Join-Path $temp_ 'pi-codemode-late')) { Ok 'off (0 days): the leftovers stay too' } else { Ko 'a leftover was removed while the cleanup was off' }
} finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
exit $fail

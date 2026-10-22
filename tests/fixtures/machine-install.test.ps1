#!/usr/bin/env pwsh
# One install per machine (master plan F3; Aaron 2026-10-20). Offline, any OS:
#   - scripts/machine-install.ps1's pure parts: the machine shim body (this
#     account's link first, else the package), the PATH entry helpers, the
#     marker, the "coop update" task XML (SYSTEM, daily 03:00 hourly, logon,
#     the limits) and the "already current" test; dot-sourced, nothing runs;
#   - scripts/auto-update.ps1's pure parts: release tags only, never backwards,
#     the release URLs, the in-use test (processes under the install dir), the
#     acceptance-report check, the state document, the log trim;
#   - auto-update.ps1 run as a dry run against a fake package: the state file
#     and log, "up to date", "dry run: would install", "failed" without the
#     machine marker, exit codes;
#   - lib/common.ps1: Test-CoopMachineInstall and Get-CoopInstallKind from the
#     marker, the doctor row, the update summary, the launch lines (pure and
#     written, with the per-account last-seen marker and the warn sink);
#   - scripts/update.ps1 on a machine install: reports the task's state and
#     exits 0; --check reads the state file; --edge refuses.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-machine-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $t | Out-Null

$saved = Save-Env @('COOP_BUNDLED_RUNTIME', 'COOP_MACHINE_DIR', 'COOP_DIR', 'COOP_AUTO_UPDATE_DRY_RUN', 'COOP_AUTO_UPDATE_LATEST', 'HOME', 'USERPROFILE', 'NO_COLOR', 'COOP_SKIP_UPDATE_CHECK', 'GH_TOKEN', 'GITHUB_TOKEN')
try {
  # --- machine-install.ps1, dot-sourced --------------------------------------------
  . (Join-Path $root 'scripts\machine-install.ps1')
  $app = 'C:\Program Files\coop'
  $shim = Get-CoopMachineShimBody $app
  if ($shim -notmatch '(?m)^if not exist "%LOCALAPPDATA%\\coop\\bin\\coop\.cmd" goto machine') { Ko 'the shim does not check this account''s link first' $shim }
  elseif ($shim -notmatch '(?m)^findstr /I /C:"\\Programs\\coop\\\\" "%LOCALAPPDATA%\\coop\\bin\\coop\.cmd" >nul 2>nul\r?$\s+^if not errorlevel 1 goto machine\r?$\s+^rem [^\r\n]*\r?$\s+^ver >nul\r?$\s+^call "%LOCALAPPDATA%') { Ko 'the shim does not skip a link into an older per-account package (findstr''s \\" quoting), or leaves findstr''s ERRORLEVEL 1 for the link' $shim }
  elseif ($shim -notmatch [regex]::Escape('call "C:\Program Files\coop\resources\coop\bin\coop.cmd" %*')) { Ko 'the shim does not fall back to the package''s coop' $shim }
  elseif ($shim -notmatch [regex]::Escape('call "%LOCALAPPDATA%\coop\bin\coop.cmd" %*')) { Ko 'the shim does not run this account''s link' $shim }
  elseif (($shim -split "`r`n" | Where-Object { $_ -eq 'exit /b %ERRORLEVEL%' }).Count -ne 2) { Ko 'the shim does not pass the exit code through' $shim }
  elseif ($shim -match '[^\x00-\x7F]') { Ko 'the shim is not ASCII' }
  else { Ok 'the machine shim runs this account''s clone link when there is one, skips a link into an older package, else runs the package''s coop, and passes the exit code through' }

  if (-not (Test-CoopLinkPointsIntoPackage "@echo off`r`ncall `"C:\Users\a\AppData\Local\Programs\coop\resources\coop\bin\coop.cmd`" %*`r`n")) { Ko 'Test-CoopLinkPointsIntoPackage misses a link into a per-account package' }
  elseif (Test-CoopLinkPointsIntoPackage "@echo off`r`ncall `"C:\dev\coop-agent\bin\coop.cmd`" %*`r`n") { Ko 'Test-CoopLinkPointsIntoPackage flags a developer clone' }
  elseif (-not (Test-CoopLinkPointsIntoPackage 'c:\users\a\appdata\local\programs\coop\coop.exe')) { Ko 'Test-CoopLinkPointsIntoPackage misses a shortcut target into a package (any case)' }
  elseif (Test-CoopLinkPointsIntoPackage '') { Ko 'Test-CoopLinkPointsIntoPackage flags an empty body' }
  else { Ok 'a link or shortcut into %LOCALAPPDATA%\Programs\coop is an older package''s; a developer clone is not' }

  $users = Join-Path $t 'Users'
  foreach ($d in @('Public', 'Default', 'Default User', 'All Users', 'alice', 'bob.admin')) { New-Item -ItemType Directory -Force -Path (Join-Path $users $d) | Out-Null }
  $profiles = @(Get-CoopProfileDirs $users | ForEach-Object { Split-Path -Leaf $_ } | Sort-Object)
  if (($profiles -join ',') -ne 'alice,bob.admin') { Ko "Get-CoopProfileDirs: $($profiles -join ',')" }
  elseif (@(Get-CoopProfileDirs (Join-Path $t 'nowhere')).Count -ne 0) { Ko 'Get-CoopProfileDirs invents profiles under a missing folder' }
  else { Ok 'the per-account sweep visits every profile but Public and Default*' }

  # 4c: the ODBC installers from coop-runtime.json, and the registered-driver test.
  $pkg = Join-Path $t 'pkg'
  $rtDir = Join-Path $pkg 'resources\runtime'
  New-Item -ItemType Directory -Force -Path (Join-Path $rtDir 'installers') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $rtDir 'coop-runtime.json'), '{"schema":1,"node":{"dir":"node"},"npm":{"prefix":"npm"},"odbc":{"version":"18.6.2.1","dir":"installers","msi":"msodbcsql.msi","vcRedist":"VC_redist.x64.exe"}}')
  if ($null -ne (Get-CoopBundledOdbcInstallers $pkg)) { Ko 'Get-CoopBundledOdbcInstallers names installers that are not on disk' }
  else {
    foreach ($f in @('msodbcsql.msi', 'VC_redist.x64.exe')) { [System.IO.File]::WriteAllText((Join-Path (Join-Path $rtDir 'installers') $f), 'x') }
    $odbc = Get-CoopBundledOdbcInstallers $pkg
    if (-not $odbc -or $odbc.Version -ne '18.6.2.1' -or $odbc.Msi -ne (Join-Path $rtDir 'installers\msodbcsql.msi') -or $odbc.VcRedist -ne (Join-Path $rtDir 'installers\VC_redist.x64.exe')) { Ko "Get-CoopBundledOdbcInstallers: $($odbc | Out-String)" }
    elseif ($null -ne (Get-CoopBundledOdbcInstallers (Join-Path $t 'nowhere'))) { Ko 'Get-CoopBundledOdbcInstallers invents installers without a marker' }
    elseif (-not (Test-CoopOdbcDriverNames @('SQL Server', 'ODBC Driver 18 for SQL Server')) -or -not (Test-CoopOdbcDriverNames @('ODBC Driver 19 for SQL Server'))) { Ko 'Test-CoopOdbcDriverNames misses Driver 18 or newer' }
    elseif ((Test-CoopOdbcDriverNames @('SQL Server', 'ODBC Driver 17 for SQL Server')) -or (Test-CoopOdbcDriverNames @())) { Ko 'Test-CoopOdbcDriverNames accepts Driver 17 or nothing' }
    else { Ok 'the machine install finds the package''s ODBC MSI and VC++ runtime from coop-runtime.json and installs them only when no Driver 18+ is registered' }
  }

  $path = 'C:\Windows;C:\Windows\System32;%SystemRoot%\x'
  $with = Add-CoopPathEntry $path 'C:\Program Files\coop\bin'
  if ($with -ne ($path + ';C:\Program Files\coop\bin')) { Ko "Add-CoopPathEntry: $with" }
  elseif ((Add-CoopPathEntry $with 'c:\program files\coop\bin\') -ne $with) { Ko 'Add-CoopPathEntry added a second spelling' }
  elseif (-not (Test-CoopPathHasEntry $with 'C:\PROGRAM FILES\coop\bin')) { Ko 'Test-CoopPathHasEntry misses a case variant' }
  elseif ((Remove-CoopPathEntry $with 'C:\Program Files\coop\bin\') -ne $path) { Ko "Remove-CoopPathEntry: $(Remove-CoopPathEntry $with 'C:\Program Files\coop\bin\')" }
  elseif ((Remove-CoopPathEntry $path 'C:\nowhere') -ne $path) { Ko 'Remove-CoopPathEntry changed a PATH without the entry' }
  else { Ok 'the machine PATH entry is added once (any spelling) and removed cleanly, %VAR% tokens untouched' }

  $markerJson = Get-CoopMachineInstallMarkerJson $app '0.38.0'
  $marker = $markerJson | ConvertFrom-Json
  # pwsh 7's ConvertFrom-Json turns the ISO time into a DateTime: check the text.
  if ($marker.schema_version -ne 1 -or $marker.install_dir -ne $app -or $marker.version -ne '0.38.0' -or $marker.task -ne 'coop update' -or $markerJson -notmatch '"installed_at":\s*"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ"') { Ko "the machine marker is wrong: $markerJson" }
  else { Ok 'machine-install.json names the install dir, the version, the time and the task' }

  $xmlText = Get-CoopUpdateTaskXml $app 'C:\ProgramData\coop' 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
  $xml = $null
  try { $xml = [xml]$xmlText } catch { Ko "the task XML does not parse: $($_.Exception.Message)" $xmlText }
  if ($xml) {
    $ns = New-Object System.Xml.XmlNamespaceManager $xml.NameTable
    $ns.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $sel = { param($p) $n = $xml.SelectSingleNode($p, $ns); if ($n) { $n.InnerText } else { '' } }
    $checks = @(
      @('/t:Task/t:Principals/t:Principal/t:UserId', 'S-1-5-18'),
      @('/t:Task/t:Principals/t:Principal/t:RunLevel', 'HighestAvailable'),
      @('/t:Task/t:Triggers/t:CalendarTrigger/t:StartBoundary', '2026-01-01T03:00:00'),
      @('/t:Task/t:Triggers/t:CalendarTrigger/t:Repetition/t:Interval', 'PT1H'),
      @('/t:Task/t:Triggers/t:CalendarTrigger/t:Repetition/t:Duration', 'P1D'),
      @('/t:Task/t:Triggers/t:CalendarTrigger/t:ScheduleByDay/t:DaysInterval', '1'),
      @('/t:Task/t:Triggers/t:LogonTrigger/t:Enabled', 'true'),
      @('/t:Task/t:Settings/t:StartWhenAvailable', 'true'),
      @('/t:Task/t:Settings/t:RunOnlyIfNetworkAvailable', 'true'),
      @('/t:Task/t:Settings/t:ExecutionTimeLimit', 'PT30M'),
      @('/t:Task/t:Settings/t:MultipleInstancesPolicy', 'IgnoreNew'),
      @('/t:Task/t:Actions/t:Exec/t:Command', 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'),
      @('/t:Task/t:Actions/t:Exec/t:Arguments', '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Program Files\coop\resources\coop\scripts\auto-update.ps1"'),
      @('/t:Task/t:Actions/t:Exec/t:WorkingDirectory', 'C:\ProgramData\coop'),
      @('/t:Task/t:RegistrationInfo/t:URI', '\coop update'))
    $bad = @()
    foreach ($c in $checks) { $got = & $sel $c[0]; if ($got -ne $c[1]) { $bad += "$($c[0]) = '$got' (want '$($c[1])')" } }
    $logon = $xml.SelectSingleNode('/t:Task/t:Triggers/t:LogonTrigger', $ns)
    if ($logon -and $logon.SelectSingleNode('t:UserId', $ns)) { $bad += 'the logon trigger names one user; it must fire for any user' }
    if ($bad.Count) { Ko 'the task XML is wrong' ($bad -join "`n") }
    else { Ok 'the "coop update" task: SYSTEM, highest; daily 03:00 repeating hourly for a day and at any logon; starts when missed, network only, 30 minutes, one instance; runs the snapshot''s auto-update.ps1' }
    if (-not (Test-CoopUpdateTaskCurrent $xmlText $xmlText)) { Ko 'Test-CoopUpdateTaskCurrent rejects the task it would write' }
    elseif (Test-CoopUpdateTaskCurrent ($xmlText -replace 'auto-update\.ps1', 'other.ps1') $xmlText) { Ko 'Test-CoopUpdateTaskCurrent accepts a task running another script' }
    elseif (Test-CoopUpdateTaskCurrent '' $xmlText) { Ko 'Test-CoopUpdateTaskCurrent accepts a missing task' }
    elseif (-not (Test-CoopUpdateTaskCurrent (($xmlText -replace '&quot;', '&amp;quot;') -replace '<Command>', "<Command>`r`n      ") $xmlText)) { Ko 'Test-CoopUpdateTaskCurrent rejects the XML schtasks /Query writes back (&amp;quot; for the quotes, re-wrapped)' }
    else { Ok 'a registered task running this script as SYSTEM is left alone; any other is re-registered' }
  }
  $escaped = Get-CoopUpdateTaskXml 'C:\A & B\coop' 'C:\ProgramData\coop' 'C:\ps.exe'
  try { $null = [xml]$escaped; Ok 'an install dir with an ampersand is escaped in the task XML' } catch { Ko 'an install dir with an ampersand breaks the task XML' }

  # --- auto-update.ps1, dot-sourced --------------------------------------------------
  . (Join-Path $root 'scripts\auto-update.ps1')
  if ((Get-CoopReleaseTagVersion 'v0.38.0') -ne '0.38.0' -or (Get-CoopReleaseTagVersion 'v0.38.0-rc1') -or (Get-CoopReleaseTagVersion 'main') -or (Get-CoopReleaseTagVersion '0.38.0')) { Ko 'Get-CoopReleaseTagVersion accepts something that is not a release tag' }
  elseif (-not (Test-CoopVersionNewer '0.38.0' '0.37.0') -or (Test-CoopVersionNewer '0.37.0' '0.37.0') -or (Test-CoopVersionNewer '0.36.9' '0.37.0') -or (Test-CoopVersionNewer 'x' '0.37.0') -or -not (Test-CoopVersionNewer '0.37.10' '0.37.9')) { Ko 'Test-CoopVersionNewer is not a version compare' }
  else { Ok 'release tags only (vX.Y.Z), compared as versions, never backwards' }
  $urls = Get-CoopReleaseUrls 'kabukisensei/coop-agent' '0.38.0'
  if ($urls.Installer -ne 'https://github.com/kabukisensei/coop-agent/releases/download/v0.38.0/coop-window-0.38.0-win-x64.exe' -or $urls.Report -ne 'https://github.com/kabukisensei/coop-agent/releases/download/v0.38.0/installer-acceptance.json' -or $urls.Page -ne 'https://github.com/kabukisensei/coop-agent/releases/tag/v0.38.0' -or $urls.Name -ne 'coop-window-0.38.0-win-x64.exe') { Ko "the release URLs are wrong: $($urls | ConvertTo-Json -Compress)" }
  else { Ok 'the installer and its acceptance report come from the release page on github.com, nowhere else' }
  $procs = @(
    [pscustomobject]@{ Name = 'coop.exe'; ExecutablePath = 'C:\Program Files\coop\coop.exe' },
    [pscustomobject]@{ Name = 'node.exe'; ExecutablePath = 'C:\Program Files\coop\resources\runtime\node\node.exe' },
    [pscustomobject]@{ Name = 'node.exe'; ExecutablePath = 'C:\Program Files\nodejs\node.exe' },
    [pscustomobject]@{ Name = 'coop.exe'; ExecutablePath = 'C:\Program Files\coopx\coop.exe' },
    [pscustomobject]@{ Name = 'System'; ExecutablePath = $null },
    [pscustomobject]@{ ProcessName = 'git'; Path = 'c:\program files\coop\resources\runtime\git\cmd\git.exe' })
  $inUse = @(Get-CoopInstallInUse 'C:\Program Files\coop' $procs)
  if (($inUse -join ',') -ne 'coop.exe,node.exe,git') { Ko "Get-CoopInstallInUse: $($inUse -join ',')" }
  elseif (@(Get-CoopInstallInUse 'C:\Program Files\coop' @()).Count -ne 0) { Ko 'Get-CoopInstallInUse finds something in no processes' }
  else { Ok 'any process running from the install dir (coop.exe, the bundled node, git) means waiting; a node or coop elsewhere does not' }
  $good = [pscustomobject]@{ ok = $true; version = '0.38.0'; installerSha256 = ('a' * 64) }
  if ((Test-CoopInstallerReport $good '0.38.0') -ne '') { Ko "a good report is refused: $(Test-CoopInstallerReport $good '0.38.0')" }
  elseif ((Test-CoopInstallerReport ([pscustomobject]@{ ok = $false; error = 'uninstall left files'; version = '0.38.0'; installerSha256 = ('a' * 64) }) '0.38.0') -notmatch 'does not say ok: uninstall left files') { Ko 'a failed report is accepted' }
  elseif ((Test-CoopInstallerReport ([pscustomobject]@{ ok = $true; version = '0.37.0'; installerSha256 = ('a' * 64) }) '0.38.0') -notmatch 'ran on version 0\.37\.0') { Ko 'a report for another version is accepted' }
  elseif ((Test-CoopInstallerReport ([pscustomobject]@{ ok = $true; version = '0.38.0'; installerSha256 = 'short' }) '0.38.0') -notmatch 'no installer SHA-256') { Ko 'a report without a SHA-256 is accepted' }
  elseif ((Test-CoopInstallerReport $null '0.38.0') -ne 'no acceptance report') { Ko 'a missing report is accepted' }
  else { Ok 'the acceptance report must say ok, name the release version and carry the installer SHA-256 (the bootstrap''s check)' }
  $state = New-CoopUpdateState 'waiting: coop is open (coop.exe)' '0.37.0' '0.38.0' '0.38.0' 'https://github.com/kabukisensei/coop-agent/releases/tag/v0.38.0'
  if ($state.schema_version -ne 1 -or $state.last_result -ne 'waiting: coop is open (coop.exe)' -or $state.installed_version -ne '0.37.0' -or $state.pending_version -ne '0.38.0' -or -not $state.last_run) { Ko "New-CoopUpdateState: $($state | ConvertTo-Json -Compress)" }
  else { Ok 'the state document carries schema_version, last_run, last_result, installed_version, pending_version, latest_version and release_url' }
  $log = Join-Path $t 'logs\update.log'
  Add-CoopUpdateLogLine $log 'first'
  $filler = 'x' * 200
  for ($i = 0; $i -lt 20; $i++) { Add-CoopUpdateLogLine $log $filler 2048 }
  $len = (Get-Item -LiteralPath $log).Length
  $text = [System.IO.File]::ReadAllText($log)
  if ($len -gt 2048) { Ko "the log grew past its limit: $len bytes" }
  elseif ($text.Contains('first')) { Ko 'the log kept its oldest line after the trim' }
  elseif (-not $text.EndsWith("$filler`r`n") -or ($text -split "`r`n")[0] -notmatch '^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d x+$') { Ko 'the trimmed log does not start on a whole line or end with the newest' $text }
  else { Ok 'the log is cut to its newest half on whole lines once it passes the limit (1 MB in the task)' }

  # --- auto-update.ps1 as a dry run against a fake package ------------------------------
  $fakeApp = Join-Path $t 'app'
  $snapshot = Join-Path $fakeApp 'resources\coop'
  $runtime = Join-Path $fakeApp 'resources\runtime'
  New-Item -ItemType Directory -Force -Path (Join-Path $snapshot 'scripts'), $runtime | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $snapshot 'VERSION'), "0.37.0`n", $utf8)
  Copy-Item -LiteralPath (Join-Path $root 'scripts\auto-update.ps1') -Destination (Join-Path $snapshot 'scripts\auto-update.ps1')
  $machineDir = Join-Path $t 'ProgramData\coop'
  $stateFile = Join-Path $machineDir 'update-state.dry-run.json'
  $liveState = Join-Path $machineDir 'update-state.json'
  function Invoke-AutoUpdate([string[]]$MoreArgs) {
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $lines = @(& $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $snapshot 'scripts\auto-update.ps1') -MachineDir $machineDir @MoreArgs 2>&1 | ForEach-Object { "$_" })
    $script:autoRc = $LASTEXITCODE
    $ErrorActionPreference = $eap
    return ($lines -join "`n")
  }
  function Get-State { if (Test-Path -LiteralPath $stateFile) { Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json } else { $null } }
  # No marker: not a machine install, failed, nothing fetched (the LatestVersion is never reached).
  $out = Invoke-AutoUpdate @('-DryRun', '-LatestVersion', '99.0.0')
  $s = Get-State
  if ($autoRc -ne 1 -or -not $s -or [string]$s.last_result -notmatch '^failed: .*machine-install\.json' -or $s.installed_version -ne '0.37.0') { Ko "without the machine marker the dry run should fail: rc=$autoRc state=$($s | ConvertTo-Json -Compress)" $out }
  else { Ok 'without resources\runtime\machine-install.json the task records "failed: ... not this machine''s install" and exits 1' }
  [System.IO.File]::WriteAllText((Join-Path $runtime 'machine-install.json'), (Get-CoopMachineInstallMarkerJson $fakeApp '0.37.0'), $utf8)
  # The install dir comes from the script's own location (<app>\resources\coop\scripts).
  $out = Invoke-AutoUpdate @('-DryRun', '-LatestVersion', '99.0.0')
  $s = Get-State
  if ($autoRc -ne 0 -or [string]$s.last_result -ne 'dry run: would install v99.0.0' -or $s.pending_version -ne '99.0.0' -or $s.latest_version -ne '99.0.0' -or $s.installed_version -ne '0.37.0' -or $s.release_url -ne 'https://github.com/kabukisensei/coop-agent/releases/tag/v99.0.0' -or $s.schema_version -ne 1) { Ko "the dry run with a newer release: rc=$autoRc state=$($s | ConvertTo-Json -Compress)" $out }
  elseif (-not (Test-Path -LiteralPath (Join-Path $machineDir 'logs\update.log'))) { Ko 'the dry run wrote no log' }
  elseif (Test-Path -LiteralPath (Join-Path $machineDir 'updates')) { Ko 'the dry run downloaded something' }
  elseif ($out -notmatch 'coop auto-update: dry run: would install v99\.0\.0') { Ko 'the dry run does not say what it would do' $out }
  elseif (Test-Path -LiteralPath $liveState) { Ko 'the dry run wrote the live update-state.json (every launch would announce a version nobody installs)' }
  else { Ok 'a dry run with a newer release records "dry run: would install", the pending version and the release page, downloads nothing, exits 0' }
  $out = Invoke-AutoUpdate @('-DryRun', '-LatestVersion', '0.37.0')
  $s = Get-State
  if ($autoRc -ne 0 -or [string]$s.last_result -ne 'up to date' -or $s.pending_version -ne '' -or $s.release_url -ne 'https://github.com/kabukisensei/coop-agent/releases/tag/v0.37.0') { Ko "at the newest release: rc=$autoRc state=$($s | ConvertTo-Json -Compress)" $out }
  else { Ok 'at the newest release the task records "up to date" with no pending version' }
  $env:COOP_AUTO_UPDATE_DRY_RUN = '1'; $env:COOP_AUTO_UPDATE_LATEST = '0.36.0'
  $out = Invoke-AutoUpdate @()
  $s = Get-State
  Remove-Item Env:\COOP_AUTO_UPDATE_DRY_RUN, Env:\COOP_AUTO_UPDATE_LATEST -ErrorAction SilentlyContinue
  if ($autoRc -ne 0 -or [string]$s.last_result -ne 'up to date' -or $s.latest_version -ne '0.36.0') { Ko "an older release (never backwards, through the environment switches): rc=$autoRc state=$($s | ConvertTo-Json -Compress)" $out }
  else { Ok 'an older release is "up to date" (never backwards); COOP_AUTO_UPDATE_DRY_RUN=1 and COOP_AUTO_UPDATE_LATEST work like the switches' }
  $logText = [System.IO.File]::ReadAllText((Join-Path $machineDir 'logs\update.log'))
  if (($logText -split "`n" | Where-Object { $_ }).Count -ne 4 -or $logText -notmatch 'dry run: would install v99\.0\.0 \(installed 0\.37\.0, newest 99\.0\.0\)') { Ko 'the log does not carry one line per run' $logText }
  else { Ok 'the log carries one line per run with the result, the installed and the newest version' }

  # --- lib/common.ps1 on a machine install ------------------------------------------------
  # The live state the task writes (the dry runs above wrote only their own file): the last run's.
  $stateFile = $liveState
  Write-CoopUpdateStateFile $stateFile (Get-Content -LiteralPath (Join-Path $machineDir 'update-state.dry-run.json') -Raw | ConvertFrom-Json)
  $env:COOP_BUNDLED_RUNTIME = $runtime
  $env:COOP_MACHINE_DIR = $machineDir
  $home2 = New-SandboxHome (Join-Path $t 'home')
  $env:HOME = $home2; $env:USERPROFILE = $home2
  Remove-Item Env:\COOP_DIR -ErrorAction SilentlyContinue
  $script:CoopRoot = $snapshot
  . (Join-Path $root 'lib\common.ps1')
  $script:CoopRoot = $snapshot
  $script:CoopVersion = '0.37.0'
  if (-not (Test-CoopMachineInstall)) { Ko 'Test-CoopMachineInstall misses the marker' }
  elseif ((Get-CoopInstallKind) -ne 'machine') { Ko "Get-CoopInstallKind: $(Get-CoopInstallKind)" }
  elseif ((Get-CoopPackageRoot) -ne $fakeApp) { Ko "Get-CoopPackageRoot: $(Get-CoopPackageRoot)" }
  elseif ((Get-CoopMachineInstallInfo).version -ne '0.37.0') { Ko 'Get-CoopMachineInstallInfo does not read the marker' }
  else { Ok 'the snapshot knows it is this machine''s install from runtime\machine-install.json' }
  $row = Get-CoopInstallDoctorRow
  if ($row.Level -ne 'ok' -or $row.Message -notmatch '^install: this machine \(' -or $row.Message -notmatch 'version 0\.37\.0' -or $row.Message -notmatch 'updates itself \(last run \d{4}-\d\d-\d\d \d\d:\d\d, installed 0\.37\.0, result: up to date\)') { Ko "the doctor row: $($row | ConvertTo-Json -Compress)" }
  else { Ok 'doctor: "install: this machine (<dir>), version X, updates itself (last run <time>, installed <ver>, result: up to date)"' }
  $summary = Get-CoopMachineUpdateSummary
  if ($summary -notmatch '^This coop updates itself \(this machine\): last checked \d{4}-\d\d-\d\d \d\d:\d\d, installed 0\.37\.0$') { Ko "the update summary: $summary" }
  else { Ok 'coop update''s line: "This coop updates itself (this machine): last checked <time>, installed <version>"' }
  $failed = New-CoopUpdateState 'failed: could not read the newest release from github.com' '0.37.0' '' '' ''
  Write-CoopUpdateStateFile $stateFile $failed
  $row = Get-CoopInstallDoctorRow
  if ($row.Level -ne 'warn' -or $row.Hint -notmatch 'update\.log') { Ko "a failed run should warn with the log: $($row | ConvertTo-Json -Compress)" }
  else { Ok 'a failed update run turns the doctor row into a warning that names the log' }
  # The launch lines, pure.
  $waiting = [pscustomobject]@{ schema_version = 1; last_result = 'waiting: coop is open (coop.exe)'; pending_version = '0.38.0'; installed_version = '0.37.0'; release_url = 'https://github.com/kabukisensei/coop-agent/releases/tag/v0.38.0' }
  $lines = @(Get-CoopUpdateLines -Installed '0.37.0' -LastSeen '0.36.0' -State $waiting)
  if ($lines.Count -ne 2 -or $lines[0] -ne "coop updated to v0.37.0 (this machine): https://github.com/kabukisensei/coop-agent/releases/tag/v0.37.0. Your client's sessions and settings are unchanged." -or $lines[1] -ne 'An update to v0.38.0 is ready; it installs within the hour after coop closes.') { Ko "Get-CoopUpdateLines: $($lines -join ' | ')" }
  elseif (@(Get-CoopUpdateLines -Installed '0.37.0' -LastSeen '0.37.0' -State $null).Count -ne 0) { Ko 'Get-CoopUpdateLines speaks when nothing changed' }
  elseif (@(Get-CoopUpdateLines -Installed '0.37.0' -LastSeen '' -State $null).Count -ne 0) { Ko 'Get-CoopUpdateLines speaks on the very first launch' }
  elseif (@(Get-CoopUpdateLines -Installed '0.38.0' -LastSeen '0.38.0' -State $waiting).Count -ne 0) { Ko 'Get-CoopUpdateLines announces a pending version that is already installed' }
  elseif (@(Get-CoopUpdateLines -Installed '0.37.0' -LastSeen '0.36.0' -State $null -ReleaseUrl 'https://example.test/r')[0] -notmatch 'https://example\.test/r') { Ko 'Get-CoopUpdateLines ignores the state''s release url' }
  else { Ok 'the launch lines: "coop updated to v<ver> (this machine): <url>. Your client''s sessions and settings are unchanged." and "An update to v<ver> is ready; it installs within the hour after coop closes."' }
  # Written: the first launch records the version silently; a changed version speaks, into the console and the window's notices.
  Write-CoopUpdateStateFile $stateFile $waiting
  $seenFile = Get-CoopLastSeenVersionFile
  if (Test-Path -LiteralPath $seenFile) { Remove-Item -LiteralPath $seenFile -Force }
  $script:CoopWarnSink = New-Object System.Collections.Generic.List[string]
  Write-CoopUpdateLines
  $first = @($script:CoopWarnSink)
  $seen = if (Test-Path -LiteralPath $seenFile) { ([System.IO.File]::ReadAllText($seenFile)).Trim() } else { '' }
  if ($seen -ne '0.37.0') { Ko "the first launch did not record last-seen-version: '$seen' at $seenFile" }
  elseif (($first | Where-Object { $_ -like 'coop updated*' }).Count -ne 0) { Ko 'the first launch announced an update' ($first -join ' | ') }
  elseif (($first | Where-Object { $_ -like 'An update to v0.38.0*' }).Count -ne 1) { Ko 'the waiting update was not announced' ($first -join ' | ') }
  else { Ok 'the first launch records <profile dir>\last-seen-version silently and names the update waiting' }
  $script:CoopVersion = '0.38.0'
  $script:CoopWarnSink = New-Object System.Collections.Generic.List[string]
  Write-CoopUpdateLines
  $second = @($script:CoopWarnSink)
  $seen = ([System.IO.File]::ReadAllText($seenFile)).Trim()
  if ($seen -ne '0.38.0' -or $second.Count -ne 1 -or $second[0] -notmatch '^coop updated to v0\.38\.0 \(this machine\): https://github\.com/kabukisensei/coop-agent/releases/tag/v0\.38\.0\.') { Ko "after an update: seen=$seen lines=$($second -join ' | ')" }
  else { Ok 'the next launch after an update says so once (console and the window''s notices) and moves the marker' }
  $script:CoopWarnSink = $null
  $script:CoopVersion = '0.37.0'

  # An older terminal install this account linked (Aaron's client VM, 2026-10-22: the
  # link kept `coop` and the icons on 0.35.0 over the machine's 0.38.1): retired when
  # its checkout is older; a developer's checkout at this version or newer stays.
  $clone = Join-Path $t 'old-clone'
  $linkDir = Join-Path $t 'linkdir'
  New-Item -ItemType Directory -Force -Path (Join-Path $clone 'bin'), $linkDir | Out-Null
  $cloneCmd = Join-Path (Join-Path $clone 'bin') 'coop.cmd'
  [System.IO.File]::WriteAllText($cloneCmd, "@echo off`r`n", $utf8)
  [System.IO.File]::WriteAllText((Join-Path $linkDir 'coop.cmd'), "@echo off`r`ncall `"$cloneCmd`" %*`r`n")
  $older = @()
  foreach ($v in @('0.35.0', '0.37.0', '0.38.0')) {
    [System.IO.File]::WriteAllText((Join-Path $clone 'VERSION'), "$v`n", $utf8)
    $older += (Get-CoopOlderCloneRoot -LauncherDir $linkDir)
  }
  Remove-Item -LiteralPath (Join-Path $clone 'VERSION') -Force
  $noVersion = Get-CoopOlderCloneRoot -LauncherDir $linkDir
  if ((ConvertTo-CoopComparablePath $older[0]) -ne (ConvertTo-CoopComparablePath $clone)) { Ko "Get-CoopOlderCloneRoot misses a 0.35.0 checkout under a 0.37.0 install: '$($older[0])'" }
  elseif ($older[1] -or $older[2]) { Ko "Get-CoopOlderCloneRoot retires a checkout at this version or newer: '$($older[1])' '$($older[2])'" }
  elseif ($noVersion) { Ko 'Get-CoopOlderCloneRoot retires a checkout with no VERSION file' }
  elseif (Get-CoopOlderCloneRoot -LauncherDir (Join-Path $t 'nowhere')) { Ko 'Get-CoopOlderCloneRoot invents a checkout with no link' }
  else { Ok 'an account link to a checkout older than the machine install is an older terminal install (retired at first launch); a current or newer checkout is a developer''s and stays' }
  if (@(Repair-CoopOlderCloneShortcuts '').Count -ne 0) { Ko 'Repair-CoopOlderCloneShortcuts changes something with no checkout' }

  # --- scripts/update.ps1 on a machine install -----------------------------------------------
  Write-CoopUpdateStateFile $stateFile (New-CoopUpdateState 'up to date' '0.37.0' '' '0.37.0' 'https://github.com/kabukisensei/coop-agent/releases/tag/v0.37.0')
  foreach ($d in @('bin', 'lib', 'config')) { Copy-Item -LiteralPath (Join-Path $root $d) -Destination (Join-Path $snapshot $d) -Recurse -Force }
  Copy-Item -LiteralPath (Join-Path $root 'scripts\update.ps1') -Destination (Join-Path $snapshot 'scripts\update.ps1')
  # A stand-in for scripts\install.ps1: records its arguments (B6: coop update runs it for this account).
  # The package's runtime marker (a bare node dir and npm prefix): the child update.ps1 then
  # sees the bundled runtime, as the real package does, and records the setup marker.
  New-Item -ItemType Directory -Force -Path (Join-Path $runtime 'node'), (Join-Path $runtime 'npm') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $runtime 'coop-runtime.json'), '{"schema":1,"node":{"dir":"node"},"npm":{"prefix":"npm"}}', $utf8)
  $installArgsFile = Join-Path $t 'install-args.txt'
  [System.IO.File]::WriteAllText((Join-Path $snapshot 'scripts\install.ps1'), ("[System.IO.File]::WriteAllText('" + $installArgsFile.Replace("'", "''") + "', (`$args -join ' '))`nexit 0`n"), $utf8)
  $env:NO_COLOR = '1'
  function Invoke-Update([string[]]$UpdArgs) {
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $lines = @(& $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $snapshot 'scripts\update.ps1') @UpdArgs 2>&1 | ForEach-Object { "$_" })
    $script:updRc = $LASTEXITCODE
    $ErrorActionPreference = $eap
    return ($lines -join "`n")
  }
  $out = Invoke-Update @()
  $installArgs = if (Test-Path -LiteralPath $installArgsFile) { ([System.IO.File]::ReadAllText($installArgsFile)).Trim() } else { '' }
  $setupMarker = Join-Path $home2 '.coop\desktop\window-setup-version'
  if ($updRc -ne 0 -or $out -notmatch 'This coop updates itself \(this machine\): last checked .*, installed 0\.37\.0') { Ko "coop update on a machine install (rc=$updRc)" $out }
  elseif ($out -cmatch '1/6|Doctor|repository') { Ko 'coop update on a machine install started the fleet update' $out }
  elseif ($installArgs -ne '--prereqs auto' -or $out -notmatch "Bringing this account's tools to this package's pins") { Ko "coop update on a machine install did not run this account's setup (install.ps1 args: '$installArgs')" $out }
  elseif (-not (Test-Path -LiteralPath $setupMarker) -or ([System.IO.File]::ReadAllText($setupMarker)).Trim() -notmatch '^0\.37\.0\+[0-9a-f]{16}$') { Ko "coop update did not record the setup marker at $setupMarker" $out }
  else { Ok 'coop update on a machine install says the task moves coop, runs install.ps1 --prereqs auto for this account and records the setup marker (B6)' }
  $out = Invoke-Update @('--check')
  if ($updRc -ne 0 -or $out -notmatch 'install\s+this machine \(' -or $out -notmatch 'update task result\s+up to date' -or $out -notmatch 'installed by the task\s+0\.37\.0') { Ko "coop update --check on a machine install (rc=$updRc)" $out }
  else { Ok 'coop update --check on a machine install reports the state file' }
  $out = Invoke-Update @('--edge')
  if ($updRc -ne 1 -or $out -notmatch 'developer clones') { Ko "coop update --edge on a machine install should refuse (rc=$updRc)" $out }
  else { Ok 'coop update --edge on a machine install says it is for developer clones and exits 1' }
}
finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
exit $fail

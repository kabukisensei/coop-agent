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
#   - scripts/sign-in.ps1 (coop startup): the wait for this sign-in's update
#     run, the client folder; lib/common.ps1's Run value;
#   - scripts/update.ps1 on a machine install: reports the task's state and
#     exits 0; --check reads the state file; --edge refuses.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-machine-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $t | Out-Null

$saved = Save-Env @('COOP_BUNDLED_RUNTIME', 'COOP_MACHINE_DIR', 'COOP_DIR', 'COOP_AUTO_UPDATE_DRY_RUN', 'COOP_AUTO_UPDATE_LATEST', 'HOME', 'USERPROFILE', 'NO_COLOR', 'COOP_SKIP_UPDATE_CHECK', 'GH_TOKEN', 'GITHUB_TOKEN', 'COOP_PIPX_BIN', 'PIPX_STATE', 'COOP_PIPX_HOME', 'COOP_AGENT_DIR', 'PI_CODING_AGENT_DIR')
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

  if (-not (Test-CoopShortcutDuplicatesMachine 'c:\program files\COOP\coop.exe' 'C:\Program Files\coop\')) { Ko 'Test-CoopShortcutDuplicatesMachine misses an account''s shortcut to the machine exe (any case, trailing slash)' }
  elseif (Test-CoopShortcutDuplicatesMachine 'C:\Users\a\AppData\Local\Programs\coop\coop.exe' 'C:\Program Files\coop') { Ko 'Test-CoopShortcutDuplicatesMachine flags another install''s exe' }
  elseif (Test-CoopShortcutDuplicatesMachine 'C:\Program Files\coop\coop.exe' '') { Ko 'Test-CoopShortcutDuplicatesMachine flags with no install dir' }
  elseif (-not (Test-CoopElectronIconOfProfile 'C:\Users\a\.coop\desktop\runtime\node_modules\electron\dist\electron.exe' 'C:\Users\a')) { Ko 'Test-CoopElectronIconOfProfile misses the early window''s Electron icon' }
  elseif (Test-CoopElectronIconOfProfile 'C:\Users\b\.coop\desktop\runtime\node_modules\electron\dist\electron.exe' 'C:\Users\a') { Ko 'Test-CoopElectronIconOfProfile flags another account''s runtime' }
  elseif (Test-CoopElectronIconOfProfile 'C:\Program Files\SomeApp\electron.exe' 'C:\Users\a') { Ko 'Test-CoopElectronIconOfProfile flags another Electron app' }
  else { Ok 'the sweep also drops an account''s duplicate "coop" to the machine exe and the early window''s "Electron" icon, nothing else' }

  # The sweep retires an older terminal install's link and shortcuts in every account
  # (2026-11-03: accounts still on 0.35.0 under a 0.38.13 machine install).
  $sweepClone = Join-Path $t 'sweep-clone'
  New-Item -ItemType Directory -Force -Path $sweepClone | Out-Null
  $olderThan = @()
  foreach ($v in @('0.35.0', 'v0.38.13', '0.39.0-rc1')) {
    [System.IO.File]::WriteAllText((Join-Path $sweepClone 'VERSION'), "$v`n")
    $olderThan += [bool](Test-CoopCloneOlderThan $sweepClone '0.38.13')
  }
  [System.IO.File]::WriteAllText((Join-Path $sweepClone 'VERSION'), "not a version`n")
  $badVersion = Test-CoopCloneOlderThan $sweepClone '0.38.13'
  Remove-Item -LiteralPath (Join-Path $sweepClone 'VERSION') -Force
  if (($olderThan -join ',') -ne 'True,False,False') { Ko "Test-CoopCloneOlderThan 0.35.0 / v0.38.13 / 0.39.0-rc1 under 0.38.13: $($olderThan -join ',')" }
  elseif ($badVersion -or (Test-CoopCloneOlderThan $sweepClone '0.38.13')) { Ko 'Test-CoopCloneOlderThan retires a checkout with no or an unreadable VERSION' }
  elseif (-not (Test-CoopCloneOlderThan (Join-Path $t 'gone-clone') '0.38.13' -AllowMissing)) { Ko 'Test-CoopCloneOlderThan -AllowMissing misses a deleted checkout' }
  elseif ((Test-CoopCloneOlderThan (Join-Path $t 'gone-clone') '0.38.13') -or (Test-CoopCloneOlderThan $sweepClone '')) { Ko 'Test-CoopCloneOlderThan retires a missing folder without -AllowMissing, or with no package version' }
  else { Ok 'the every-account sweep retires a link or shortcut into a checkout older than the package (or deleted); a current, newer or unversioned checkout stays' }

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

  # --- sign-in.ps1 (coop startup), dot-sourced -------------------------------------------
  . (Join-Path $root 'scripts\sign-in.ps1')
  $since = [datetime]'2026-11-04T08:00:00'
  $after = $since.AddMinutes(1).ToString('o')
  $before = $since.AddHours(-5).ToString('o')
  $mk = { param($ran, $result, $ver) [pscustomobject]@{ schema_version = 1; last_run = $ran; last_result = $result; installed_version = $ver } }
  $cases = @(
    @($null, 'wait', 'no state yet'),
    @((& $mk $before 'waiting: coop is open (coop.exe)' '0.39.1'), 'wait', 'a run before this sign-in'),
    @((& $mk $after 'installed' '0.39.2'), 'installed', 'this sign-in''s run installed the release'),
    @((& $mk $after 'installed' '0.39.1'), 'wait', 'an install of another version'),
    @((& $mk $after 'failed: no network' '0.39.1'), 'stop: the update task says failed: no network', 'a failed run'),
    @((& $mk $after 'waiting: coop is open (coop.exe)' '0.39.1'), 'stop: the update task says waiting: coop is open (coop.exe)', 'a run waiting for an open coop'),
    @((& $mk $after 'up to date' '0.39.1'), 'stop: the update task found no newer release yet', 'a run that saw no newer release'))
  $bad = @()
  foreach ($c in $cases) { $got = Get-CoopSignInWaitStep '0.39.2' $c[0] $since; if ($got -ne $c[1]) { $bad += "$($c[2]): '$got' (want '$($c[1])')" } }
  if ($bad.Count) { Ko 'Get-CoopSignInWaitStep is wrong' ($bad -join "`n") }
  else { Ok 'coop at sign-in waits for this sign-in''s update run: done when it installed the release, stops when it failed, waits for an open coop or saw nothing newer; earlier runs do not count' }
  if ((Format-CoopMinutes 1) -ne '1 minute' -or (Format-CoopMinutes 12) -ne '12 minutes') { Ko "Format-CoopMinutes: '$(Format-CoopMinutes 1)', '$(Format-CoopMinutes 12)'" }
  elseif ((Get-CoopSignInAzureLine 0) -notmatch 'signed in' -or (Get-CoopSignInAzureLine 3) -notmatch 'not signed in' -or (Get-CoopSignInAzureLine 4) -notmatch 'skipped' -or (Get-CoopSignInAzureLine 7) -notmatch 'exit 7') { Ko 'Get-CoopSignInAzureLine does not say the Azure outcome' }
  else { Ok 'the sign-in log says "1 minute" and names the Azure outcome (signed in, not signed in, skipped), not a bare exit code' }
  $signProfile = Join-Path $t 'sign-in-profile'
  New-Item -ItemType Directory -Force -Path $signProfile | Out-Null
  if ((Get-CoopSignInClientRoot $signProfile) -ne '') { Ko 'Get-CoopSignInClientRoot finds a client folder with no client.json' }
  else {
    [System.IO.File]::WriteAllText((Join-Path $signProfile 'client.json'), (@{ schema_version = 1; root = $t } | ConvertTo-Json))
    $gotRoot = Get-CoopSignInClientRoot $signProfile
    [System.IO.File]::WriteAllText((Join-Path $signProfile 'client.json'), (@{ schema_version = 1; root = (Join-Path $t 'gone') } | ConvertTo-Json))
    if ($gotRoot -ne $t) { Ko "Get-CoopSignInClientRoot: '$gotRoot' (want '$t')" }
    elseif ((Get-CoopSignInClientRoot $signProfile) -ne '') { Ko 'Get-CoopSignInClientRoot returns a folder that is gone' }
    else { Ok 'coop at sign-in checks the Azure sign-in from the recorded client folder, and from the home folder when there is none' }
  }

  # The installer runs in update mode (--updated, electron-builder's flag): the
  # previous version's uninstaller keeps the all-users shortcuts and their pins.
  $autoCode = [System.IO.File]::ReadAllText((Join-Path $root 'scripts\auto-update.ps1'))
  if ($autoCode -notmatch "-ArgumentList @\('/S', '/allusers', '--updated', `"/D=\`$app`"\)") { Ko 'auto-update.ps1 must run the installer with /S /allusers --updated and /D last, so the shortcuts and pins survive the update' }
  else { Ok 'auto-update.ps1 runs the installer with --updated (shortcuts and pins kept) and /D last' }

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
  # #515: copied files whose machine setup did not finish are not "up to date": no
  # record of a finished setup (or one for another version) keeps the failure.
  $setupRecord = Join-Path $machineDir 'machine-setup.json'
  $out = Invoke-AutoUpdate @('-DryRun', '-LatestVersion', '0.37.0')
  $s = Get-State
  if ($autoRc -ne 1 -or [string]$s.last_result -notmatch '^failed: the machine setup for v0\.37\.0 did not finish' -or $s.installed_version -ne '0.37.0') { Ko "at the newest release with no finished setup: rc=$autoRc state=$($s | ConvertTo-Json -Compress)" $out }
  else { Ok 'at the newest release with no record of a finished machine setup the task keeps "failed: the machine setup ... did not finish" and exits 1' }
  [System.IO.File]::WriteAllText($setupRecord, (Get-CoopMachineSetupRecordJson $fakeApp '0.36.0'), $utf8)
  $out = Invoke-AutoUpdate @('-DryRun', '-LatestVersion', '0.37.0')
  $s = Get-State
  if ($autoRc -ne 1 -or [string]$s.last_result -notmatch '^failed: the machine setup') { Ko "a finished setup of another version: rc=$autoRc state=$($s | ConvertTo-Json -Compress)" $out }
  else { Ok 'a record of a finished setup for another version does not count' }
  [System.IO.File]::WriteAllText($setupRecord, (Get-CoopMachineSetupRecordJson $fakeApp '0.37.0'), $utf8)
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
  if (($logText -split "`n" | Where-Object { $_ }).Count -ne 6 -or $logText -notmatch 'dry run: would install v99\.0\.0 \(installed 0\.37\.0, newest 99\.0\.0\)') { Ko 'the log does not carry one line per run' $logText }
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
  $runValue = Get-CoopStartupCommand 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' 'C:\Program Files\coop\resources\coop\'
  $wantRun = '"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Normal -File "C:\Program Files\coop\resources\coop\scripts\sign-in.ps1"'
  $oldRun = $wantRun -replace '-WindowStyle Normal', '-WindowStyle Minimized'
  if (-not (Test-CoopStartupEntryStale $oldRun $wantRun)) { Ko 'Test-CoopStartupEntryStale misses an older release''s entry for the same sign-in.ps1 (minimized)' }
  elseif ((Test-CoopStartupEntryStale $wantRun $wantRun) -or (Test-CoopStartupEntryStale '' $wantRun) -or (Test-CoopStartupEntryStale ($oldRun -replace 'Program Files\\coop', 'dev\coop-agent') $wantRun)) { Ko 'Test-CoopStartupEntryStale claims the current entry, no entry, or another checkout''s' }
  else { Ok 'a launch refreshes an older release''s "coop at sign-in" entry (minimized console) for the same coop, never another checkout''s' }
  if ($runValue -ne $wantRun) { Ko 'the coop startup Run value is wrong' "$runValue`nwant: $wantRun" }
  elseif ($script:CoopStartupValueName -ne 'coop at sign-in' -or $script:CoopStartupRunKey -ne 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run') { Ko 'coop startup writes another key or value name' }
  else { Ok 'coop startup on writes one Run value: the built-in powershell.exe running the snapshot''s sign-in.ps1 in a normal console' }
  $bad = @()
  if (-not (Test-CoopStartupDefaultWanted $true $true '' $false $false)) { $bad += 'a machine install with no entry is not turned on' }
  if (Test-CoopStartupDefaultWanted $true $true '' $true $false) { $bad += 'an account that opted out is turned back on' }
  if (Test-CoopStartupDefaultWanted $true $true 'x' $false $false) { $bad += 'an existing entry is rewritten' }
  if (Test-CoopStartupDefaultWanted $true $false '' $false $false) { $bad += 'a developer clone is turned on' }
  if (Test-CoopStartupDefaultWanted $false $true '' $false $false) { $bad += 'turned on off Windows' }
  if (Test-CoopStartupDefaultWanted $true $true '' $false $true) { $bad += 'turned on on a CI runner' }
  if (-not (Test-CoopStartupDefaultSkipped)) { $bad += 'a sandboxed profile (this test''s HOME) is not skipped' }
  if ((Get-CoopStartupOptOutFile) -ne (Join-Path (Get-CoopProfileDir) 'startup-off')) { $bad += "opt-out file: $(Get-CoopStartupOptOutFile)" }
  if ($bad.Count) { Ko 'the coop startup default is wrong' ($bad -join "`n") }
  else { Ok 'coop startup is on by default on a machine install, once per account; an opt-out (~\.coop\startup-off) keeps it off through updates; never on a clone or a CI runner' }
  $row = Get-CoopInstallDoctorRow
  if ($row.Level -ne 'ok' -or $row.Message -notmatch '^install: this machine \(' -or $row.Message -notmatch 'version 0\.37\.0' -or $row.Message -notmatch 'updates itself \(last run \d{4}-\d\d-\d\d \d\d:\d\d, installed 0\.37\.0, result: up to date\)') { Ko "the doctor row: $($row | ConvertTo-Json -Compress)" }
  else { Ok 'doctor: "install: this machine (<dir>), version X, updates itself (last run <time>, installed <ver>, result: up to date)"' }
  $summary = Get-CoopMachineUpdateSummary
  if ($summary -notmatch '^This coop updates itself \(this machine\): last checked \d{4}-\d\d-\d\d \d\d:\d\d, installed 0\.37\.0 \(task: up to date\)$') { Ko "the update summary: $summary" }
  else { Ok 'coop update''s line: "This coop updates itself (this machine): last checked <time>, installed <version> (task: <last result>)"' }
  # What coop update adds when a newer release is out (2026-11-12: a client VM's coop
  # update said "installed 0.40.1" a day after 0.41.0 shipped and only refreshed 0.40.1).
  $waitingState = [pscustomobject]@{ schema_version = 1; last_result = 'waiting: coop is open (coop.exe)'; pending_version = '0.38.0'; installed_version = '0.37.0'; latest_version = '0.38.0' }
  $failedState = [pscustomobject]@{ schema_version = 1; last_result = 'failed: the installer exited with code 2'; installed_version = '0.37.0'; latest_version = '0.38.0' }
  $oldState = [pscustomobject]@{ schema_version = 1; last_result = 'up to date'; installed_version = '0.37.0'; latest_version = '0.37.0' }
  $bad = @()
  if (@(Get-CoopMachineUpdateNews -Installed '0.37.0' -Latest '0.37.0' -State $waitingState).Count -ne 0) { $bad += 'speaks when the installed version is the newest' }
  if (@(Get-CoopMachineUpdateNews -Installed '0.37.0' -Latest '' -State $waitingState).Count -ne 0) { $bad += 'speaks when the newest release is unknown' }
  $news = @(Get-CoopMachineUpdateNews -Installed '0.37.0' -Latest '0.38.0' -State $waitingState)
  if ($news.Count -ne 3 -or $news[0] -notmatch '^coop v0\.38\.0 is out; this machine still has v0\.37\.0\.' -or $news[1] -notmatch 'waited because coop was open' -or $news[2] -notmatch 'releases/tag/v0\.38\.0' -or $news[2] -notmatch 'schtasks /Run /TN "coop update"') { $bad += "waiting: $($news -join ' | ')" }
  $news = @(Get-CoopMachineUpdateNews -Installed '0.37.0' -Latest '0.38.0' -State $failedState)
  if ($news[1] -notmatch '^The task''s last run failed: the installer exited with code 2 \(log: .*update\.log\)\.$') { $bad += "failed: $($news -join ' | ')" }
  $news = @(Get-CoopMachineUpdateNews -Installed '0.37.0' -Latest '0.38.0' -State $oldState -OpenNames @('coop.exe', 'node.exe'))
  if ($news[1] -notmatch '^coop is open \(coop\.exe, node\.exe\)') { $bad += "open: $($news -join ' | ')" }
  $news = @(Get-CoopMachineUpdateNews -Installed '0.37.0' -Latest '0.38.0' -State $null -TaskName 'coop update' -Started)
  if ($news[1] -ne 'The task has not tried this release yet.' -or $news[2] -notmatch '^Started the "coop update" task now') { $bad += "started: $($news -join ' | ')" }
  $env:COOP_AUTO_UPDATE_LATEST = '0.39.0'
  if ((Get-CoopNewestReleaseVersion $oldState) -ne '0.39.0') { $bad += 'COOP_AUTO_UPDATE_LATEST is not read' }
  Remove-Item Env:\COOP_AUTO_UPDATE_LATEST -ErrorAction SilentlyContinue
  $env:COOP_SKIP_UPDATE_CHECK = '1'
  if ((Get-CoopNewestReleaseVersion $waitingState) -ne '0.38.0') { $bad += 'COOP_SKIP_UPDATE_CHECK=1 does not fall back to the task''s latest_version' }
  Remove-Item Env:\COOP_SKIP_UPDATE_CHECK -ErrorAction SilentlyContinue
  if ($bad.Count) { Ko 'coop update''s newer-release lines are wrong' ($bad -join "`n") }
  else { Ok 'coop update names a newer release, why the task has not installed it (open, waiting, failed, not tried) and how to get it now' }
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

  # A shortcut into an older checkout whose link is already gone (Aaron's client VM,
  # 2026-11-03: "coop (terminal)" still opened 0.35.0 over the machine's 0.38.13).
  $lnkArgs = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$clone\bin\coop-desktop.ps1`" desktop"
  [System.IO.File]::WriteAllText((Join-Path $clone 'VERSION'), "0.35.0`n", $utf8)
  $gone = Join-Path $t 'deleted-clone'
  if ((ConvertTo-CoopComparablePath (Get-CoopShortcutCloneRoot $lnkArgs)) -ne (ConvertTo-CoopComparablePath $clone)) { Ko "Get-CoopShortcutCloneRoot: '$(Get-CoopShortcutCloneRoot $lnkArgs)'" }
  elseif (Get-CoopShortcutCloneRoot '-NoLogo -File "C:\x\other.ps1"') { Ko 'Get-CoopShortcutCloneRoot reads a root from another script' }
  elseif (Get-CoopShortcutCloneRoot '') { Ko 'Get-CoopShortcutCloneRoot reads a root from a shortcut with no arguments (the package''s exe)' }
  elseif (-not (Test-CoopOlderCloneRoot $clone)) { Ko 'Test-CoopOlderCloneRoot misses a 0.35.0 checkout under a 0.37.0 install' }
  elseif (-not (Test-CoopOlderCloneRoot $gone -AllowMissing)) { Ko 'Test-CoopOlderCloneRoot -AllowMissing misses a deleted checkout' }
  elseif (Test-CoopOlderCloneRoot $gone) { Ko 'Test-CoopOlderCloneRoot retires a missing folder without -AllowMissing' }
  elseif (Test-CoopOlderCloneRoot $script:CoopRoot -AllowMissing) { Ko 'Test-CoopOlderCloneRoot retires this coop''s own root' }
  else { Ok 'a "coop" shortcut into an older or deleted checkout is found from the shortcut itself, link or no link; this coop''s own and unversioned checkouts stay' }
  Remove-Item -LiteralPath (Join-Path $clone 'VERSION') -Force

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
  # The newest release, without github.com: this package's own version for every
  # case below except the newer-release one at the end.
  $env:COOP_AUTO_UPDATE_LATEST = '0.37.0'
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
  elseif ($installArgs -ne '--prereqs auto --unattended' -or $out -notmatch "Bringing this account's tools to this package's pins") { Ko "coop update on a machine install did not run this account's setup (install.ps1 args: '$installArgs')" $out }
  elseif (-not (Test-Path -LiteralPath $setupMarker) -or ([System.IO.File]::ReadAllText($setupMarker)).Trim() -notmatch '^0\.37\.0\+[0-9a-f]{16}$') { Ko "coop update did not record the setup marker at $setupMarker" $out }
  else { Ok 'coop update on a machine install says the task moves coop, runs install.ps1 --prereqs auto --unattended for this account and records the setup marker (B6)' }
  # --- a second run (#478): the marker is current, so only a tool that is not installed
  # as pinned any more sends it back to install.ps1; with every pin in place it syncs.
  # A stand-in pipx: `list` prints $PIPX_STATE, the interpreter question has no answer.
  # The extension lock is installed too (a `pi` at the manifest's version on PATH would
  # otherwise keep the full setup pending, which is not what these cases are about).
  $env:COOP_AGENT_DIR = Join-Path $home2 '.coop\agent'; $env:PI_CODING_AGENT_DIR = $env:COOP_AGENT_DIR
  $agentNpm = Join-Path $env:COOP_AGENT_DIR 'npm'
  New-Item -ItemType Directory -Force -Path $agentNpm | Out-Null
  Copy-Item -LiteralPath (Join-Path $snapshot 'config\extensions-lock.json') -Destination (Join-Path $agentNpm 'package-lock.json') -Force
  $syncArgsFile = Join-Path $t 'sync-args.txt'
  [System.IO.File]::WriteAllText((Join-Path $snapshot 'scripts\sync.ps1'), ("[System.IO.File]::WriteAllText('" + $syncArgsFile.Replace("'", "''") + "', ('sync skip-fabric=' + `$env:COOP_SKIP_FABRIC_SYNC))`nexit 0`n"), $utf8)
  $pipxState = Join-Path $t 'pipx-state.txt'
  $pipxBin = Join-Path $t 'pipx-bin'
  $env:COOP_PIPX_BIN = New-PyStub $pipxBin 'pipx' @'
import os, sys
args = sys.argv[1:]
if args[:1] == ['list']:
    p = os.environ.get('PIPX_STATE', '')
    if p and os.path.exists(p):
        with open(p, encoding='utf-8') as f:
            sys.stdout.write(f.read())
    sys.exit(0)
if args[:3] == ['environment', '--value', 'PIPX_DEFAULT_PYTHON']:
    print('')
    sys.exit(0)
sys.exit(1)
'@
  $env:PIPX_STATE = $pipxState
  $env:COOP_PIPX_HOME = Join-Path $t 'pipx-home'
  $plan = Get-CoopFleetPlan
  $pinned = @($plan.PythonTools) + @($plan.Fabric) | Where-Object { $_ } | ForEach-Object { "package $($_.Name) $($_.Pin)" }
  function Invoke-SecondRun([string[]]$State, [string[]]$UpdArgs = @()) {
    [System.IO.File]::WriteAllText($pipxState, (($State -join "`n") + "`n"), $utf8)
    Remove-Item -LiteralPath $installArgsFile, $syncArgsFile -Force -ErrorAction SilentlyContinue
    return (Invoke-Update $UpdArgs)
  }
  $out = Invoke-SecondRun $pinned
  if ($updRc -ne 0 -or (Test-Path -LiteralPath $installArgsFile) -or -not (Test-Path -LiteralPath $syncArgsFile) -or $out -notmatch 'already installed for this account; refreshing') { Ko "coop update with every pin installed should sync only (rc=$updRc)" $out }
  else { Ok 'coop update on a machine install with the marker current and every pinned tool installed refreshes extensions and settings only' }
  $missing = @($pinned | Where-Object { $_ -notmatch '^package coop-data-doc ' })
  $out = Invoke-SecondRun $missing
  $installArgs = if (Test-Path -LiteralPath $installArgsFile) { ([System.IO.File]::ReadAllText($installArgsFile)).Trim() } else { '' }
  if ($updRc -ne 0 -or $installArgs -ne '--prereqs auto --unattended' -or (Test-Path -LiteralPath $syncArgsFile) -or $out -notmatch 'back to this package''s pins: coop-data-doc \(not installed, pin ') { Ko "coop update with a tool uninstalled since the marker should run install.ps1 (rc=$updRc, install.ps1 args: '$installArgs')" $out }
  else { Ok 'coop update on a machine install runs this account''s setup again for a pinned tool that is no longer installed (#478)' }
  $older = @($pinned | ForEach-Object { if ($_ -match '^package coop-schema-compare ') { 'package coop-schema-compare 0.0.1' } else { $_ } })
  $out = Invoke-SecondRun $older
  $installArgs = if (Test-Path -LiteralPath $installArgsFile) { ([System.IO.File]::ReadAllText($installArgsFile)).Trim() } else { '' }
  if ($updRc -ne 0 -or $installArgs -ne '--prereqs auto --unattended' -or $out -notmatch 'coop-schema-compare \(0\.0\.1 installed, pin ') { Ko "coop update with a tool at another version should run install.ps1 (rc=$updRc, install.ps1 args: '$installArgs')" $out }
  else { Ok 'coop update on a machine install runs this account''s setup again for a pinned tool at another version (#478)' }
  # --no-fabric reaches the account setup and the sync (#495): install.ps1 gets the flag,
  # sync.ps1 runs with COOP_SKIP_FABRIC_SYNC=1, and without the flag neither changes.
  $out = Invoke-SecondRun $older @('--no-fabric')
  $installArgs = if (Test-Path -LiteralPath $installArgsFile) { ([System.IO.File]::ReadAllText($installArgsFile)).Trim() } else { '' }
  if ($updRc -ne 0 -or $installArgs -ne '--prereqs auto --unattended --no-fabric') { Ko "coop update --no-fabric with a drifted tool should pass --no-fabric to install.ps1 (rc=$updRc, install.ps1 args: '$installArgs')" $out }
  else { Ok 'coop update --no-fabric on a machine install passes --no-fabric to the account setup for a drifted tool (#495)' }
  $priorSkip = $env:COOP_SKIP_FABRIC_SYNC; $env:COOP_SKIP_FABRIC_SYNC = $null
  $out = Invoke-SecondRun $pinned @('--no-fabric')
  $syncSeen = if (Test-Path -LiteralPath $syncArgsFile) { ([System.IO.File]::ReadAllText($syncArgsFile)).Trim() } else { '' }
  if ($updRc -ne 0 -or $syncSeen -ne 'sync skip-fabric=1') { Ko "coop update --no-fabric with every pin installed should sync with the Fabric repair skipped (rc=$updRc, sync saw: '$syncSeen')" $out }
  else { Ok 'coop update --no-fabric on a machine install syncs with the Fabric runtime repair skipped (#495)' }
  $out = Invoke-SecondRun $pinned
  $syncSeen = if (Test-Path -LiteralPath $syncArgsFile) { ([System.IO.File]::ReadAllText($syncArgsFile)).Trim() } else { '' }
  if ($updRc -ne 0 -or $syncSeen -ne 'sync skip-fabric=') { Ko "coop update without --no-fabric should leave the Fabric runtime repair on (rc=$updRc, sync saw: '$syncSeen')" $out }
  else { Ok 'coop update without --no-fabric leaves the sync''s Fabric runtime repair on' }
  Remove-Item -LiteralPath $setupMarker -Force
  $out = Invoke-SecondRun $pinned @('--no-fabric')
  $installArgs = if (Test-Path -LiteralPath $installArgsFile) { ([System.IO.File]::ReadAllText($installArgsFile)).Trim() } else { '' }
  if ($updRc -ne 0 -or $installArgs -ne '--prereqs auto --unattended --no-fabric') { Ko "coop update --no-fabric with the setup pending should pass --no-fabric to install.ps1 (rc=$updRc, install.ps1 args: '$installArgs')" $out }
  else { Ok 'coop update --no-fabric on a machine install passes --no-fabric to the pending account setup (#495)' }
  $env:COOP_SKIP_FABRIC_SYNC = $priorSkip
  $env:COOP_PIPX_BIN = Join-Path $t 'no-pipx-here'
  $out = Invoke-SecondRun @()
  if ($updRc -ne 0 -or (Test-Path -LiteralPath $installArgsFile) -or -not (Test-Path -LiteralPath $syncArgsFile)) { Ko "coop update without pipx should sync only, as nothing can be installed (rc=$updRc)" $out }
  else { Ok 'coop update on a machine install without pipx judges no tool drifted and syncs' }
  $env:COOP_PIPX_BIN = $null; $env:PIPX_STATE = $null; $env:COOP_PIPX_HOME = $null; $env:COOP_AGENT_DIR = $null; $env:PI_CODING_AGENT_DIR = $null

  $out = Invoke-Update @('--check')
  if ($updRc -ne 0 -or $out -notmatch 'install\s+this machine \(' -or $out -notmatch 'update task result\s+up to date' -or $out -notmatch 'installed by the task\s+0\.37\.0') { Ko "coop update --check on a machine install (rc=$updRc)" $out }
  else { Ok 'coop update --check on a machine install reports the state file' }
  $out = Invoke-Update @('--edge')
  if ($updRc -ne 1 -or $out -notmatch 'developer clones') { Ko "coop update --edge on a machine install should refuse (rc=$updRc)" $out }
  else { Ok 'coop update --edge on a machine install says it is for developer clones and exits 1' }
  # A newer release than this package: coop update says so and why, and leaves
  # this account's tools alone (the new package's first launch sets them up).
  Write-CoopUpdateStateFile $stateFile (New-CoopUpdateState 'waiting: coop is open (coop.exe)' '0.37.0' '0.38.0' '0.38.0' 'https://github.com/kabukisensei/coop-agent/releases/tag/v0.38.0')
  $env:COOP_AUTO_UPDATE_LATEST = '0.38.0'
  Remove-Item -LiteralPath $installArgsFile, $syncArgsFile -Force -ErrorAction SilentlyContinue
  $out = Invoke-Update @()
  if ($updRc -ne 0 -or $out -notmatch 'installed 0\.37\.0 \(task: waiting: coop is open \(coop\.exe\)\)' -or $out -notmatch 'coop v0\.38\.0 is out; this machine still has v0\.37\.0' -or $out -notmatch 'waited because coop was open' -or $out -notmatch 'releases/tag/v0\.38\.0') { Ko "coop update with a newer release out should say so and why (rc=$updRc)" $out }
  elseif ((Test-Path -LiteralPath $installArgsFile) -or (Test-Path -LiteralPath $syncArgsFile) -or $out -match 'refreshing extensions') { Ko 'coop update with a newer release out still refreshed the old package for this account' $out }
  else { Ok 'coop update on a machine install with a newer release out names it, why the task has not installed it and the installer link, and skips the old package''s refresh' }
  $out = Invoke-Update @('--check')
  if ($updRc -ne 0 -or $out -notmatch 'newest release\s+0\.38\.0 \(newer') { Ko "coop update --check should name the newer release (rc=$updRc)" $out }
  else { Ok 'coop update --check on a machine install names the newest release' }
}
finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
exit $fail

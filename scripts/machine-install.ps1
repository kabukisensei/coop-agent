#!/usr/bin/env pwsh
#
# scripts/machine-install.ps1 - the coop window installer's per-machine step
# (master plan F3; Aaron 2026-10-20: one install per machine, shared by every
# Windows account, updating itself). desktop/installer/resources/installer.nsh
# runs it elevated from customInstall with the install dir (<app>, normally
# %ProgramFiles%\coop) and from customUnInstall with -Remove. It
#   1. writes the machine shim <app>\bin\coop.cmd: a developer clone linked at
#      %LOCALAPPDATA%\coop\bin\coop.cmd wins for that account (a link into an
#      older per-account window package does not), else the package's own
#      resources\coop\bin\coop.cmd runs;
#   2. puts <app>\bin on the MACHINE PATH (HKLM), so `coop` works in every
#      account's new terminal;
#   3. writes resources\runtime\machine-install.json beside coop-runtime.json,
#      the marker lib/common.ps1's Test-CoopMachineInstall reads;
#   4. creates %ProgramData%\coop\updates and \logs for the update task, and
#      %ProgramData%\coop\standards writable by every account (F2: the
#      standards live once on this machine);
#   4b. removes every account's older per-account window package
#      (%LOCALAPPDATA%\Programs\coop): its own uninstaller, then the "coop"
#      shortcuts and the `coop` link that pointed into it, so no account keeps
#      an old icon; ~\.coop is never touched;
#   4c. installs the package's ODBC Driver 18 for SQL Server (with its VC++
#      runtime) when no Driver 18+ is registered on the machine: the one
#      machine prerequisite, done here, already elevated, so no account's first
#      launch asks for an administrator (the dev VM, 2026-10-20: a standard
#      user's first launch hung on that prompt);
#   5. registers the scheduled task "coop update" (SYSTEM, highest; daily at
#      03:00 repeating every hour for a day, and two minutes after any user's
#      logon; starts when missed, only with a network, 30 minutes at most, one
#      instance) that runs scripts\auto-update.ps1 from the installed snapshot.
# -Remove undoes 1, 2, 3 and 5; the state and the log under %ProgramData%\coop
# stay, the downloaded installers go.
# Standalone on purpose (no lib/common.ps1): it runs while the package is half
# written or half gone. Windows PowerShell 5.1 syntax only (the installer runs
# the built-in powershell.exe). Exit 0 on success, 2 when not elevated, 1 when a
# step failed (each step is tried; the installer shows the log). The tests
# dot-source this file for its functions: nothing runs then.
param(
  [string]$InstallDir = '',
  [switch]$Remove,
  [string]$TaskName = 'coop update',
  # %ProgramData%\coop (COOP_MACHINE_DIR, as lib/common.ps1 reads it, for the tests).
  [string]$MachineDir = ''
)

$script:MachineInstallRc = 0
# Every line also goes to <machine dir>\logs\machine-install.log (the installer
# keeps no log of its own), so a VM check can read what each step did.
$script:MachineInstallLog = ''
function Write-MachineInstallLine([string]$Mark, [string]$Text) {
  Write-Host "  $Mark $Text"
  if ($script:MachineInstallLog) {
    try { [System.IO.File]::AppendAllText($script:MachineInstallLog, ("{0:yyyy-MM-ddTHH:mm:ssZ} {1} {2}`r`n" -f [DateTime]::UtcNow, $Mark, $Text), (New-Object System.Text.UTF8Encoding $false)) } catch { }
  }
}
function Coop-MachineOk([string]$m) { Write-MachineInstallLine '+' $m }
function Coop-MachineInfo([string]$m) { Write-MachineInstallLine '-' $m }
function Coop-MachineFail([string]$m) { Write-MachineInstallLine 'x' $m; $script:MachineInstallRc = 1 }

# --- pure parts (tested on every OS) ------------------------------------------
# The shim every account's `coop` resolves to. cmd.exe reads it in the OEM code
# page, so it carries only the install dir (an ASCII path under Program Files)
# and %LOCALAPPDATA%, expanded per account at run time: a developer clone this
# account linked with `coop install` wins, else the package's own coop runs.
function Get-CoopMachineShimBody([string]$InstallDir) {
  # String concatenation, not Join-Path: the pure parts render Windows paths on any OS (the tests).
  $target = $InstallDir.TrimEnd('\') + '\resources\coop\bin\coop.cmd'
  return (@(
    '@echo off',
    'rem coop.cmd - the coop command for every account on this machine (coop-agent scripts\machine-install.ps1).',
    'rem A developer clone this account linked (coop install) wins; else the installed coop runs.',
    'if not exist "%LOCALAPPDATA%\coop\bin\coop.cmd" goto machine',
    'rem A link into an older per-account window package is not a clone: the machine install wins.',
    'rem (\\" at the end: findstr reads \" as a quote, so the backslash is doubled to reach it.)',
    'findstr /I /C:"\Programs\coop\\" "%LOCALAPPDATA%\coop\bin\coop.cmd" >nul 2>nul',
    'if not errorlevel 1 goto machine',
    'rem No match left ERRORLEVEL 1; clear it so a link that sets none passes 0 through.',
    'ver >nul',
    'call "%LOCALAPPDATA%\coop\bin\coop.cmd" %*',
    'exit /b %ERRORLEVEL%',
    ':machine',
    ('call "' + $target + '" %*'),
    'exit /b %ERRORLEVEL%'
  ) -join "`r`n") + "`r`n"
}
# A PATH value split into its entries (blank ones dropped).
function Get-CoopPathEntries([string]$PathValue) {
  return @(($PathValue -split ';') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}
function Test-CoopPathHasEntry([string]$PathValue, [string]$Entry) {
  $needle = $Entry.Trim().TrimEnd('\')
  foreach ($e in (Get-CoopPathEntries $PathValue)) { if ($e.TrimEnd('\') -ieq $needle) { return $true } }
  return $false
}
# The PATH value with $Entry appended once (unchanged when already there).
function Add-CoopPathEntry([string]$PathValue, [string]$Entry) {
  if (Test-CoopPathHasEntry $PathValue $Entry) { return $PathValue }
  return ((@(Get-CoopPathEntries $PathValue) + @($Entry.Trim())) -join ';')
}
# The PATH value without $Entry (every spelling of it).
function Remove-CoopPathEntry([string]$PathValue, [string]$Entry) {
  $needle = $Entry.Trim().TrimEnd('\')
  return (@(Get-CoopPathEntries $PathValue | Where-Object { $_.TrimEnd('\') -ine $needle }) -join ';')
}
# resources\runtime\machine-install.json: what lib/common.ps1 reads to know this
# coop is this machine's install.
function Get-CoopMachineInstallMarkerJson([string]$InstallDir, [string]$Version, [string]$TaskName = 'coop update') {
  $marker = [ordered]@{
    schema_version = 1
    install_dir    = $InstallDir
    version        = $Version
    installed_at   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    task           = $TaskName
  }
  return ($marker | ConvertTo-Json)
}
# The package's ODBC installers, from resources\runtime\coop-runtime.json (the
# D1k entries lib/common.ps1 reads as $script:CoopBundledOdbc; this script loads
# no common.ps1). $null for a package without them or files that are not there.
function Get-CoopBundledOdbcInstallers([string]$InstallDir) {
  $marker = Join-Path $InstallDir 'resources\runtime\coop-runtime.json'
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { return $null }
  $info = $null
  try { $info = Get-Content -LiteralPath $marker -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch { return $null }
  if (-not $info -or -not $info.odbc -or -not $info.odbc.dir -or -not $info.odbc.msi -or -not $info.odbc.vcRedist) { return $null }
  $odbcDir = Join-Path (Join-Path $InstallDir 'resources\runtime') ([string]$info.odbc.dir)
  $msi = Join-Path $odbcDir ([string]$info.odbc.msi)
  $vc = Join-Path $odbcDir ([string]$info.odbc.vcRedist)
  if (-not (Test-Path -LiteralPath $msi -PathType Leaf) -or -not (Test-Path -LiteralPath $vc -PathType Leaf)) { return $null }
  return [pscustomobject]@{ Version = [string]$info.odbc.version; Msi = $msi; VcRedist = $vc }
}
# Is an ODBC Driver 18 or newer for SQL Server among the registered driver names
# (HKLM:\SOFTWARE\ODBC\ODBCINST.INI\ODBC Drivers, what pyodbc.drivers() lists)?
function Test-CoopOdbcDriverNames([string[]]$Names) {
  foreach ($n in @($Names)) {
    $m = [regex]::Match([string]$n, '^ODBC Driver (\d+) for SQL Server$')
    if ($m.Success -and [int]$m.Groups[1].Value -ge 18) { return $true }
  }
  return $false
}
function ConvertTo-CoopXmlText([string]$Text) { return [System.Security.SecurityElement]::Escape($Text) }
# The "coop update" task as Task Scheduler XML (schtasks /Create /XML): SYSTEM,
# highest; daily 03:00 repeating hourly for a day, and two minutes after any
# logon; starts when a run was missed, only with a network, 30 minutes at most,
# one instance at a time. Element order follows the Task schema.
function Get-CoopUpdateTaskXml([string]$InstallDir, [string]$MachineDir, [string]$PowerShellExe, [string]$TaskName = 'coop update') {
  $script = $InstallDir.TrimEnd('\') + '\resources\coop\scripts\auto-update.ps1'
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '"'
  return (@(
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>coop: installs each new coop release for every account on this machine, silently, from github.com (coop-agent scripts\auto-update.ps1). Waits while coop is open.</Description>',
    ('    <URI>\' + (ConvertTo-CoopXmlText $TaskName) + '</URI>'),
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <CalendarTrigger>',
    '      <Repetition>',
    '        <Interval>PT1H</Interval>',
    '        <Duration>P1D</Duration>',
    '        <StopAtDurationEnd>false</StopAtDurationEnd>',
    '      </Repetition>',
    '      <StartBoundary>2026-01-01T03:00:00</StartBoundary>',
    '      <Enabled>true</Enabled>',
    '      <ScheduleByDay>',
    '        <DaysInterval>1</DaysInterval>',
    '      </ScheduleByDay>',
    '    </CalendarTrigger>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    '      <Delay>PT2M</Delay>',
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    '      <UserId>S-1-5-18</UserId>',
    '      <RunLevel>HighestAvailable</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    ('      <Command>' + (ConvertTo-CoopXmlText $PowerShellExe) + '</Command>'),
    ('      <Arguments>' + (ConvertTo-CoopXmlText $arguments) + '</Arguments>'),
    ('      <WorkingDirectory>' + (ConvertTo-CoopXmlText $MachineDir) + '</WorkingDirectory>'),
    '    </Exec>',
    '  </Actions>',
    '</Task>'
  ) -join "`r`n") + "`r`n"
}
# Does the registered task's XML (schtasks /Query /XML) already run this script
# as SYSTEM? Then it stays as it is: re-registering while the task itself runs
# the installer (the self-update) is not needed.
# schtasks /Query /XML writes the quotes in Arguments back escaped (&quot;, seen
# doubly escaped too) and may re-wrap the text, so both sides are read as XML
# text, decoded until stable and trimmed before they are compared.
function Get-CoopTaskXmlText([string]$Xml, [string]$Tag) {
  $m = [regex]::Match($Xml, "<$Tag>(.*?)</$Tag>", [System.Text.RegularExpressions.RegexOptions]::Singleline)
  if (-not $m.Success) { return $null }
  $text = $m.Groups[1].Value
  for ($i = 0; $i -lt 3; $i++) {
    $decoded = [System.Net.WebUtility]::HtmlDecode($text)
    if ($decoded -eq $text) { break }
    $text = $decoded
  }
  return (($text -replace '\s+', ' ').Trim())
}
function Test-CoopUpdateTaskCurrent([string]$ExistingXml, [string]$WantedXml) {
  if (-not $ExistingXml -or -not $WantedXml) { return $false }
  foreach ($tag in @('Command', 'Arguments', 'UserId')) {
    $want = Get-CoopTaskXmlText $WantedXml $tag
    $have = Get-CoopTaskXmlText $ExistingXml $tag
    if ($null -eq $want -or $null -eq $have) { return $false }
    if (-not [string]::Equals($want, $have, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  }
  return $true
}

# --- Windows parts --------------------------------------------------------------
# A launcher link body (%LOCALAPPDATA%\coop\bin\coop.cmd) that calls into a
# window package rather than a developer clone.
function Test-CoopLinkPointsIntoPackage([string]$Body) {
  return ([string]$Body -match '(?i)\\Programs\\coop\\')
}
# The user profiles under <SystemDrive>\Users that may hold a per-account
# package: every folder but Public and Default*.
function Get-CoopProfileDirs([string]$UsersRoot) {
  if (-not $UsersRoot -or -not (Test-Path -LiteralPath $UsersRoot -PathType Container)) { return @() }
  return @(Get-ChildItem -LiteralPath $UsersRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '^(Public|Default|Default User|All Users)$' } | ForEach-Object { $_.FullName })
}
function Test-CoopElevated {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}
$script:MachinePathKey = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
# The machine PATH with <app>\bin added or removed: the raw ExpandString, so
# %VAR% tokens stay dynamic; then a WM_SETTINGCHANGE broadcast (through a
# throwaway Machine variable), so new terminals see it without a logoff.
function Set-CoopMachinePathEntry([string]$Entry, [bool]$Present) {
  $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($script:MachinePathKey, $true)
  if (-not $key) { throw "cannot open HKLM\$($script:MachinePathKey)" }
  try {
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $new = if ($Present) { Add-CoopPathEntry $raw $Entry } else { Remove-CoopPathEntry $raw $Entry }
    if ($new -eq $raw) { return $false }
    $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::ExpandString)
  } finally { $key.Close() }
  try {
    [Environment]::SetEnvironmentVariable('COOP_PATH_SYNC', '1', 'Machine')
    [Environment]::SetEnvironmentVariable('COOP_PATH_SYNC', $null, 'Machine')
  } catch { }
  return $true
}
function Test-CoopOdbcDriver18Installed {
  $names = @()
  try {
    $key = Get-Item -LiteralPath 'HKLM:\SOFTWARE\ODBC\ODBCINST.INI\ODBC Drivers' -ErrorAction Stop
    $names = @($key.GetValueNames())
  } catch { $names = @() }
  return (Test-CoopOdbcDriverNames $names)
}
# The VC++ runtime, then the driver MSI with Microsoft's license accepted (the
# installer's own "Install" is the yes; the docs name the license), quietly, in
# this elevated process. msiexec 0 and 3010 (restart later) are success; the
# runtime's own code is ignored (1638: a newer one is already there).
function Install-CoopMachineOdbc($Installers) {
  $vc = Start-Process -FilePath $Installers.VcRedist -ArgumentList @('/install', '/quiet', '/norestart') -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop
  Coop-MachineInfo "VC++ runtime installer exited $($vc.ExitCode)"
  $msi = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', ('"' + $Installers.Msi + '"'), '/quiet', '/norestart', 'IACCEPTMSODBCSQLLICENSETERMS=YES') -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop
  if (@(0, 3010) -notcontains $msi.ExitCode) { throw "msiexec exited $($msi.ExitCode)" }
  if (-not (Test-CoopOdbcDriver18Installed)) { throw 'msiexec succeeded but no ODBC Driver 18+ for SQL Server is registered' }
}
function Get-CoopRegisteredTaskXml([string]$Name) {
  try {
    $out = & schtasks.exe /Query /TN $Name /XML 2>$null
    if ($LASTEXITCODE -ne 0) { return '' }
    return (($out | ForEach-Object { [string]$_ }) -join "`n")
  } catch { return '' }
}
function Register-CoopUpdateTask([string]$Name, [string]$Xml, [string]$WorkDir) {
  $existing = Get-CoopRegisteredTaskXml $Name
  if (Test-CoopUpdateTaskCurrent $existing $Xml) { Coop-MachineOk "scheduled task `"$Name`" already runs this install's auto-update.ps1"; return }
  $file = Join-Path $WorkDir 'coop-update-task.xml'
  [System.IO.File]::WriteAllText($file, $Xml, [System.Text.Encoding]::Unicode)
  $out = & schtasks.exe /Create /TN $Name /XML $file /F 2>&1
  $rc = $LASTEXITCODE
  Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  Coop-MachineInfo "schtasks /Create exited $rc`: $(($out | ForEach-Object { [string]$_ }) -join ' ')"
  if ($rc -ne 0) { throw "schtasks /Create exited $rc`: $(($out | ForEach-Object { [string]$_ }) -join ' ')" }
  Coop-MachineOk "scheduled task `"$Name`": daily at 03:00 (hourly retries) and at logon, as SYSTEM, runs scripts\auto-update.ps1"
}
function Unregister-CoopUpdateTask([string]$Name) {
  if (-not (Get-CoopRegisteredTaskXml $Name)) { Coop-MachineInfo "scheduled task `"$Name`" is not registered"; return }
  $out = & schtasks.exe /Delete /TN $Name /F 2>&1
  if ($LASTEXITCODE -ne 0) { throw "schtasks /Delete exited $LASTEXITCODE`: $(($out | ForEach-Object { [string]$_ }) -join ' ')" }
  Coop-MachineOk "removed the scheduled task `"$Name`""
}

function Invoke-CoopMachineInstall {
  if (-not $InstallDir) { Coop-MachineFail 'usage: machine-install.ps1 -InstallDir <app dir> [-Remove]'; return }
  $dir = $InstallDir.Trim().TrimEnd('\')
  if ($env:OS -ne 'Windows_NT') { Coop-MachineFail 'the machine install step runs on Windows only'; return }
  if (-not (Test-CoopElevated)) { Write-MachineInstallLine 'x' 'this step needs an administrator (the installer runs it elevated)'; $script:MachineInstallRc = 2; return }
  $machine = if ($MachineDir) { $MachineDir } elseif ($env:COOP_MACHINE_DIR) { [string]$env:COOP_MACHINE_DIR } else { Join-Path $env:ProgramData 'coop' }
  try { New-Item -ItemType Directory -Force -Path (Join-Path $machine 'logs') | Out-Null; $script:MachineInstallLog = Join-Path $machine 'logs\machine-install.log' } catch { $script:MachineInstallLog = '' }
  Coop-MachineInfo "machine-install.ps1 $(if ($Remove) { '-Remove ' })-InstallDir $dir (PowerShell $($PSVersionTable.PSVersion), $(if ([Environment]::Is64BitProcess) { '64-bit' } else { '32-bit' }))"
  $binDir = Join-Path $dir 'bin'
  $shim = Join-Path $binDir 'coop.cmd'
  $marker = Join-Path $dir 'resources\runtime\machine-install.json'
  $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

  if ($Remove) {
    Coop-MachineInfo "removing coop's machine-wide pieces for $dir"
    try { Unregister-CoopUpdateTask $TaskName } catch { Coop-MachineFail "could not remove the scheduled task: $($_.Exception.Message)" }
    try { if (Set-CoopMachinePathEntry $binDir $false) { Coop-MachineOk "removed $binDir from the machine PATH" } else { Coop-MachineInfo "$binDir was not on the machine PATH" } } catch { Coop-MachineFail "could not update the machine PATH: $($_.Exception.Message)" }
    foreach ($f in @($shim, $marker)) {
      if (Test-Path -LiteralPath $f -PathType Leaf) { try { Remove-Item -LiteralPath $f -Force -ErrorAction Stop; Coop-MachineOk "removed $f" } catch { Coop-MachineFail "could not remove $f`: $($_.Exception.Message)" } }
    }
    if (Test-Path -LiteralPath $binDir -PathType Container) { Remove-Item -LiteralPath $binDir -Recurse -Force -ErrorAction SilentlyContinue }
    $updates = Join-Path $machine 'updates'
    if (Test-Path -LiteralPath $updates -PathType Container) { Get-ChildItem -LiteralPath $updates -Filter '*.exe' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue }
    return
  }

  Coop-MachineInfo "setting up coop for every account on this machine ($dir)"
  if (-not (Test-Path -LiteralPath (Join-Path $dir 'resources\coop\bin\coop.cmd') -PathType Leaf)) { Coop-MachineFail "$dir holds no resources\coop\bin\coop.cmd; is this the coop window package?"; return }
  $version = ''
  $verFile = Join-Path $dir 'resources\coop\VERSION'
  if (Test-Path -LiteralPath $verFile -PathType Leaf) { try { $version = ([System.IO.File]::ReadAllText($verFile)).Trim() } catch { $version = '' } }
  # 1. the shim
  try {
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    [System.IO.File]::WriteAllText($shim, (Get-CoopMachineShimBody $dir), [System.Text.Encoding]::ASCII)
    Coop-MachineOk "the coop command for every account: $shim"
  } catch { Coop-MachineFail "could not write $shim`: $($_.Exception.Message)" }
  # 2. the machine PATH
  try { if (Set-CoopMachinePathEntry $binDir $true) { Coop-MachineOk "added $binDir to the machine PATH (new terminals see it)" } else { Coop-MachineOk "$binDir is on the machine PATH" } } catch { Coop-MachineFail "could not update the machine PATH: $($_.Exception.Message)" }
  # 3. the marker
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $marker) | Out-Null
    [System.IO.File]::WriteAllText($marker, (Get-CoopMachineInstallMarkerJson $dir $version $TaskName), (New-Object System.Text.UTF8Encoding $false))
    Coop-MachineOk "marked this machine's install: $marker"
  } catch { Coop-MachineFail "could not write $marker`: $($_.Exception.Message)" }
  # 4. %ProgramData%\coop: the update state and log, and the standards folder
  #    every account may refresh (BUILTIN\Users, S-1-5-32-545, gets Modify).
  try {
    foreach ($sub in @('updates', 'logs', 'standards')) { New-Item -ItemType Directory -Force -Path (Join-Path $machine $sub) | Out-Null }
    Coop-MachineOk "update state and log: $machine"
  } catch { Coop-MachineFail "could not create $machine`: $($_.Exception.Message)" }
  try {
    $standards = Join-Path $machine 'standards'
    $aclOut = & icacls.exe $standards /grant '*S-1-5-32-545:(OI)(CI)M' /Q 2>&1
    if ($LASTEXITCODE -ne 0) { throw "icacls exited $LASTEXITCODE`: $(($aclOut | ForEach-Object { [string]$_ }) -join ' ')" }
    Coop-MachineOk "standards folder for every account: $standards"
  } catch { Coop-MachineFail "could not open the standards folder to every account: $($_.Exception.Message)" }
  # 4b. older per-account packages, in every profile
  Coop-MachineInfo 'looking for older per-account copies of coop in every account'
  Remove-CoopPerUserPackages (Join-Path $env:SystemDrive 'Users')
  # 4c. the ODBC driver for every account: the one machine prerequisite, so no
  #     account's first launch needs an administrator.
  try {
    if (Test-CoopOdbcDriver18Installed) { Coop-MachineOk 'ODBC Driver 18+ for SQL Server is installed on this machine' }
    else {
      $odbc = Get-CoopBundledOdbcInstallers $dir
      if (-not $odbc) { Coop-MachineInfo 'this package carries no ODBC driver installer; live SQL needs Microsoft ODBC Driver 18 for SQL Server installed by an administrator' }
      else {
        Coop-MachineInfo "installing ODBC Driver $($odbc.Version) for SQL Server with its VC++ runtime for every account (accepts Microsoft's license for the driver; about a minute)"
        Install-CoopMachineOdbc $odbc
        Coop-MachineOk "ODBC Driver $($odbc.Version) for SQL Server installed for every account"
      }
    }
  } catch { Coop-MachineFail "could not install the ODBC driver: $($_.Exception.Message) (live SQL needs Microsoft ODBC Driver 18 for SQL Server; an administrator can install it and run the installer again)" }
  # 5. the task
  try {
    Register-CoopUpdateTask $TaskName (Get-CoopUpdateTaskXml $dir $machine $psExe $TaskName) $machine
    if (-not (Get-CoopRegisteredTaskXml $TaskName)) { throw "schtasks reported success but `"$TaskName`" is not registered" }
    Coop-MachineOk "the scheduled task `"$TaskName`" installs each new release overnight"
  } catch { Coop-MachineFail "could not register the scheduled task: $($_.Exception.Message)" }
}

# Remove an older per-account window package from every profile under $UsersRoot:
# run its own uninstaller silently (it removes the files), then the "coop"
# shortcuts and the `coop` link that pointed into it (that account's data under
# ~\.coop stays). A stale Add/Remove entry in that account's registry hive is
# cleared by the account's own first launch (scripts/install.ps1, machine mode).
function Remove-CoopPerUserPackages([string]$UsersRoot) {
  $ws = $null
  foreach ($profile in (Get-CoopProfileDirs $UsersRoot)) {
    $pkg = Join-Path $profile 'AppData\Local\Programs\coop'
    $unins = Join-Path $pkg 'Uninstall coop.exe'
    $hadPackage = Test-Path -LiteralPath $pkg -PathType Container
    if ($hadPackage) {
      Coop-MachineInfo "removing the older per-account coop of $(Split-Path -Leaf $profile): $pkg (its data under the user folder stays)"
      if (Test-Path -LiteralPath $unins -PathType Leaf) {
        try {
          $p = Start-Process -FilePath $unins -ArgumentList @('/S', '/currentuser', ('_?=' + $pkg)) -Wait -PassThru -ErrorAction Stop
          Coop-MachineInfo "its uninstaller exited $($p.ExitCode)"
        } catch { Coop-MachineInfo "its uninstaller could not run: $($_.Exception.Message)" }
      }
      try { if (Test-Path -LiteralPath $pkg) { Remove-Item -LiteralPath $pkg -Recurse -Force -ErrorAction Stop }; Coop-MachineOk "removed $pkg" } catch { Coop-MachineFail "could not remove $pkg`: $($_.Exception.Message)" }
    }
    # The link and shortcuts that pointed into a package (gone now, or earlier).
    $link = Join-Path $profile 'AppData\Local\coop\bin\coop.cmd'
    if (Test-Path -LiteralPath $link -PathType Leaf) {
      $body = ''
      try { $body = [System.IO.File]::ReadAllText($link) } catch { $body = '' }
      if (Test-CoopLinkPointsIntoPackage $body) {
        try { Remove-Item -LiteralPath $link -Force -ErrorAction Stop; Coop-MachineOk "removed the account link $link (the machine shim serves this account)" } catch { Coop-MachineFail "could not remove $link`: $($_.Exception.Message)" }
      }
    }
    foreach ($lnk in @((Join-Path $profile 'Desktop\coop.lnk'), (Join-Path $profile 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\coop.lnk'))) {
      if (-not (Test-Path -LiteralPath $lnk -PathType Leaf)) { continue }
      $target = ''
      try { if (-not $ws) { $ws = New-Object -ComObject WScript.Shell }; $target = [string]$ws.CreateShortcut($lnk).TargetPath } catch { $target = '' }
      if ($target -and (Test-CoopLinkPointsIntoPackage $target)) {
        try { Remove-Item -LiteralPath $lnk -Force -ErrorAction Stop; Coop-MachineOk "removed the old icon $lnk" } catch { Coop-MachineFail "could not remove $lnk`: $($_.Exception.Message)" }
      }
    }
  }
}

# Dot-sourced (the tests) nothing runs; invoked, the step runs and the exit code
# carries the result.
if ($MyInvocation.InvocationName -ne '.') {
  Invoke-CoopMachineInstall
  exit $script:MachineInstallRc
}

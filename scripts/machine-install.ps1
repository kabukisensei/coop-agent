#!/usr/bin/env pwsh
#
# scripts/machine-install.ps1 - the coop window installer's per-machine step
# (master plan F3; Aaron 2026-10-20: one install per machine, shared by every
# Windows account, updating itself). desktop/installer/resources/installer.nsh
# runs it elevated from customInstall with the install dir (<app>, normally
# %ProgramFiles%\coop) and from customUnInstall with -Remove. It
#   1. writes the machine shim <app>\bin\coop.cmd: a developer clone linked at
#      %LOCALAPPDATA%\coop\bin\coop.cmd wins for that account, else the
#      package's own resources\coop\bin\coop.cmd runs;
#   2. puts <app>\bin on the MACHINE PATH (HKLM), so `coop` works in every
#      account's new terminal;
#   3. writes resources\runtime\machine-install.json beside coop-runtime.json,
#      the marker lib/common.ps1's Test-CoopMachineInstall reads;
#   4. creates %ProgramData%\coop\updates and \logs for the update task;
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
function Write-MachineInstallLine([string]$Mark, [string]$Text) { Write-Host "  $Mark $Text" }
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
    'if exist "%LOCALAPPDATA%\coop\bin\coop.cmd" goto account',
    ('call "' + $target + '" %*'),
    'exit /b %ERRORLEVEL%',
    ':account',
    'call "%LOCALAPPDATA%\coop\bin\coop.cmd" %*',
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
function Test-CoopUpdateTaskCurrent([string]$ExistingXml, [string]$WantedXml) {
  if (-not $ExistingXml -or -not $WantedXml) { return $false }
  foreach ($tag in @('Command', 'Arguments', 'UserId')) {
    $m = [regex]::Match($WantedXml, "<$tag>(.*?)</$tag>")
    if (-not $m.Success) { return $false }
    if ($ExistingXml.IndexOf($m.Value, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  }
  return $true
}

# --- Windows parts --------------------------------------------------------------
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
  # 4. %ProgramData%\coop
  try {
    foreach ($sub in @('updates', 'logs')) { New-Item -ItemType Directory -Force -Path (Join-Path $machine $sub) | Out-Null }
    Coop-MachineOk "update state and log: $machine"
  } catch { Coop-MachineFail "could not create $machine`: $($_.Exception.Message)" }
  # 5. the task
  try { Register-CoopUpdateTask $TaskName (Get-CoopUpdateTaskXml $dir $machine $psExe $TaskName) $machine } catch { Coop-MachineFail "could not register the scheduled task: $($_.Exception.Message)" }
}

# Dot-sourced (the tests) nothing runs; invoked, the step runs and the exit code
# carries the result.
if ($MyInvocation.InvocationName -ne '.') {
  Invoke-CoopMachineInstall
  exit $script:MachineInstallRc
}

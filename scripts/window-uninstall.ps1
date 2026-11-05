#!/usr/bin/env pwsh
#
# The coop window's uninstaller runs this (desktop/installer/resources/installer.nsh,
# master plan D1d) before it removes the package: the package's first launch
# (scripts/install.ps1 in bundled mode) wrote a `coop` launcher link in
# %LOCALAPPDATA%\coop\bin and "coop" shortcuts on the Desktop and in the Start
# Menu that point into the package, and NSIS knows nothing about them. Each is
# removed only when it points into the install dir given as the one argument:
# a terminal install's own link and shortcuts (another coop checkout) stay.
# It also removes the "coop at sign-in" Run value (`coop startup`, lib/common.ps1)
# of this account and of every signed-in account when it starts this install's
# scripts\sign-in.ps1; one that starts another checkout's stays. The installer
# runs this on a real uninstall only, never on an upgrade (installer.nsh).
# Standalone on purpose (no lib/common.ps1): it must run with the package half
# gone and never fail the uninstall, so every step is best-effort and the exit
# code is always 0.
param(
  [string]$InstallDir,
  # The Run keys to clean (registry paths), for the tests; default: this account's
  # and every signed-in account's.
  [string[]]$RunKey = @()
)

$ErrorActionPreference = 'Continue'
$script:CoopStartupValueName = 'coop at sign-in'
# Does a "coop at sign-in" value start a script inside $Dir? The value is
# `"<powershell.exe>" ... -File "<root>\scripts\sign-in.ps1"`; the -File path
# must sit under $Dir (a path with `..` in it never counts).
function Test-CoopStartupValueInPackage([string]$Value, [string]$Dir) {
  if (-not $Value -or -not $Dir) { return $false }
  $m = [regex]::Match($Value, '(?i)-File\s+"([^"]+)"')
  if (-not $m.Success) { return $false }
  $file = $m.Groups[1].Value
  if ($file -match '(^|[\\/])\.\.([\\/]|$)') { return $false }
  $prefix = $Dir.Trim().TrimEnd('\', '/') + '\'
  return ($prefix.Length -ge 4 -and $file.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase))
}
# This account's Run key and every signed-in account's (HKEY_USERS\<SID>).
function Get-CoopStartupRunKeys {
  $keys = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run')
  try {
    foreach ($hive in @(Get-ChildItem -LiteralPath 'Registry::HKEY_USERS' -ErrorAction Stop)) {
      if ($hive.PSChildName -match '^S-1-5-21-[\d-]+$') { $keys += ('Registry::HKEY_USERS\' + $hive.PSChildName + '\Software\Microsoft\Windows\CurrentVersion\Run') }
    }
  } catch { }
  return $keys
}
function Remove-CoopStartupValues([string]$Dir, [string[]]$Keys) {
  foreach ($key in $Keys) {
    $value = ''
    try { $value = [string](Get-ItemProperty -LiteralPath $key -Name $script:CoopStartupValueName -ErrorAction Stop).($script:CoopStartupValueName) } catch { continue }
    if (-not (Test-CoopStartupValueInPackage $value $Dir)) { continue }
    try { Remove-ItemProperty -LiteralPath $key -Name $script:CoopStartupValueName -ErrorAction Stop; Write-Host "removed `"$($script:CoopStartupValueName)`" from $key" } catch { Write-Host "could not remove `"$($script:CoopStartupValueName)`" from $key : $($_.Exception.Message)" }
  }
}
# Dot-sourced (the tests): the functions only.
if ($MyInvocation.InvocationName -eq '.') { return }

if ([string]::IsNullOrWhiteSpace($InstallDir)) { exit 0 }
$needle = $InstallDir.Trim().TrimEnd('\')
if ($needle.Length -lt 4) { exit 0 }

function Test-PointsIntoPackage([string]$Text) {
  if (-not $Text) { return $false }
  return ($Text.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
}

# 1. The launcher link: %LOCALAPPDATA%\coop\bin\coop.cmd (`call "<root>\bin\coop.cmd" %*`).
if ($env:LOCALAPPDATA) {
  $link = Join-Path (Join-Path (Join-Path $env:LOCALAPPDATA 'coop') 'bin') 'coop.cmd'
  if (Test-Path -LiteralPath $link -PathType Leaf) {
    $body = ''
    try { $body = [System.IO.File]::ReadAllText($link) } catch { $body = '' }
    if (Test-PointsIntoPackage $body) {
      try { Remove-Item -LiteralPath $link -Force -ErrorAction Stop; Write-Host "removed $link" } catch { Write-Host "could not remove $link : $($_.Exception.Message)" }
    }
  }
}

# 2. The "coop" shortcuts (powershell.exe -File "<root>\bin\coop-desktop.ps1").
$dirs = @()
if ($env:APPDATA) { $dirs += (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') }
if ($env:USERPROFILE) { $dirs += (Join-Path $env:USERPROFILE 'Desktop') }
try { $desktop = [Environment]::GetFolderPath('Desktop'); if ($desktop -and ($dirs -notcontains $desktop)) { $dirs += $desktop } } catch { }
$ws = $null
try { $ws = New-Object -ComObject WScript.Shell } catch { $ws = $null }
if ($ws) {
  foreach ($dir in $dirs) {
    foreach ($name in @('coop.lnk', 'coop (terminal).lnk')) {
      $lnk = Join-Path $dir $name
      if (-not (Test-Path -LiteralPath $lnk -PathType Leaf)) { continue }
      $lnkArgs = ''
      try { $lnkArgs = [string]$ws.CreateShortcut($lnk).Arguments } catch { $lnkArgs = '' }
      if (Test-PointsIntoPackage $lnkArgs) {
        try { Remove-Item -LiteralPath $lnk -Force -ErrorAction Stop; Write-Host "removed $lnk" } catch { Write-Host "could not remove $lnk : $($_.Exception.Message)" }
      }
    }
  }
}

# 3. "coop at sign-in" (coop startup) values that start this install's sign-in.ps1.
if ($env:OS -eq 'Windows_NT') {
  $keys = if ($RunKey.Count) { $RunKey } else { Get-CoopStartupRunKeys }
  Remove-CoopStartupValues $InstallDir $keys
}
exit 0

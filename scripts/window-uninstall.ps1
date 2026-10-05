#!/usr/bin/env pwsh
#
# The coop window's uninstaller runs this (desktop/installer/resources/installer.nsh,
# master plan D1d) before it removes the package: the package's first launch
# (scripts/install.ps1 in bundled mode) wrote a `coop` launcher link in
# %LOCALAPPDATA%\coop\bin and "coop" shortcuts on the Desktop and in the Start
# Menu that point into the package, and NSIS knows nothing about them. Each is
# removed only when it points into the install dir given as the one argument:
# a terminal install's own link and shortcuts (another coop checkout) stay.
# Standalone on purpose (no lib/common.ps1): it must run with the package half
# gone and never fail the uninstall, so every step is best-effort and the exit
# code is always 0.
param([string]$InstallDir)

$ErrorActionPreference = 'Continue'
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
exit 0

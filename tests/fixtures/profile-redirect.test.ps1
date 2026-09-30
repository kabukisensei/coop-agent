#!/usr/bin/env pwsh
#
# Shortcut and PATH targets follow a redirected profile (isolated installs).
# An isolated coop (HOME / USERPROFILE / LOCALAPPDATA / APPDATA redirected at a
# sandbox, as the acceptance harness and the VM runbooks do) used to rewrite the
# real account's Desktop / Start Menu "coop" shortcuts, because those came from
# the Windows shell folders rather than the profile in use. The helpers in
# lib/common.ps1 (Test-CoopProfileRedirected, Get-CoopShortcutDirs) now decide
# the target folders; install.ps1 / uninstall.ps1 skip the persistent user-PATH
# registry write on the same signal. Runs under Windows PowerShell 5.1 and pwsh 7
# (Linux/macOS: the folder logic only; writing a .lnk needs Windows).
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
. (Join-Path $root 'lib/common.ps1')

$G_CHECK = [char]0x2713
$n = 0
function Check {
  param([bool]$Cond, [string]$Name, [string]$Detail = '')
  if (-not $Cond) { throw "FAIL: $Name $Detail" }
  $script:n++
  Write-Host "  $G_CHECK $Name"
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("coop-profile-redirect-" + [guid]::NewGuid().ToString('N'))
$sandbox = Join-Path $tmp 'profile'
$roaming = Join-Path $tmp 'roaming'
New-Item -ItemType Directory -Force -Path $sandbox, $roaming | Out-Null

$prior = @{}
foreach ($name in @('USERPROFILE', 'APPDATA')) { $prior[$name] = [Environment]::GetEnvironmentVariable($name) }
$isWin = ($env:OS -eq 'Windows_NT')
$sep = [System.IO.Path]::DirectorySeparatorChar

try {
  $registered = [string][Environment]::GetFolderPath('UserProfile')
  Check ([bool]$registered) 'the registered user profile is known'

  # --- 1. A normal install: the profile in use IS the registered one ----------
  $env:USERPROFILE = $registered
  Check (-not (Test-CoopProfileRedirected)) 'USERPROFILE at the registered profile is not a redirect'
  $env:USERPROFILE = $registered.TrimEnd('\', '/') + $sep
  Check (-not (Test-CoopProfileRedirected)) 'a trailing separator is not a redirect'
  if ($isWin) {
    $env:USERPROFILE = $registered.ToUpperInvariant()
    Check (-not (Test-CoopProfileRedirected)) 'a case variant is not a redirect (Windows)'
  }
  $env:USERPROFILE = $registered
  $expected = @()
  foreach ($folder in @('Programs', 'Desktop')) { $d = [string][Environment]::GetFolderPath($folder); if ($d) { $expected += $d } }
  $dirs = @(Get-CoopShortcutDirs)
  Check (($dirs -join '|') -eq ($expected -join '|')) 'a normal install targets the Windows shell folders (Start Menu, then Desktop)' "got [$($dirs -join '|')] expected [$($expected -join '|')]"

  # --- 2. An isolated install: USERPROFILE + APPDATA redirected at a sandbox ---
  $env:USERPROFILE = $sandbox
  $env:APPDATA = $roaming
  Check (Test-CoopProfileRedirected) 'USERPROFILE at a sandbox folder is a redirect'
  Check ((Get-CoopProfileInUse) -eq $sandbox) 'the profile in use is the sandbox'
  $dirs = @(Get-CoopShortcutDirs)
  Check ($dirs.Count -eq 2) 'a redirected install has a Start Menu and a Desktop target' "got $($dirs.Count)"
  Check ((Test-CoopPathInside $dirs[0] $roaming) -and ($dirs[0] -like '*Start Menu*Programs')) 'the Start Menu target is under the redirected APPDATA' "got $($dirs[0])"
  Check ($dirs[1] -eq (Join-Path $sandbox 'Desktop')) 'the Desktop target is the sandbox Desktop' "got $($dirs[1])"
  foreach ($d in $dirs) { Check (Test-CoopPathInside $d $tmp) "every target is inside the sandbox ($d)" }

  # --- 3. Only USERPROFILE redirected: APPDATA still on the real profile ------
  $env:APPDATA = Join-Path $registered 'AppData\Roaming'
  $dirs = @(Get-CoopShortcutDirs)
  Check ((Test-CoopPathInside $dirs[0] $sandbox) -and ($dirs[0] -like '*Start Menu*Programs')) 'a real-profile APPDATA is ignored: the Start Menu target moves under the sandbox' "got $($dirs[0])"
  Remove-Item Env:\APPDATA -ErrorAction SilentlyContinue
  $dirs = @(Get-CoopShortcutDirs)
  Check (Test-CoopPathInside $dirs[0] $sandbox) 'no APPDATA at all: the Start Menu target is under the sandbox' "got $($dirs[0])"

  # --- 4. Writing the shortcuts lands in the sandbox, never on the real Desktop
  $env:APPDATA = $roaming
  if ($isWin) {
    $realDesktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'coop.lnk'
    $realProgramsLnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'coop.lnk'
    $realStamp = @{}
    foreach ($p in @($realDesktopLnk, $realProgramsLnk)) {
      $realStamp[$p] = if (Test-Path -LiteralPath $p) { (Get-Item -LiteralPath $p).LastWriteTimeUtc } else { $null }
    }
    $sandboxDesktopLnk = Join-Path (Join-Path $sandbox 'Desktop') 'coop.lnk'
    $sandboxProgramsLnk = Join-Path (@(Get-CoopShortcutDirs)[0]) 'coop.lnk'

    Check (Set-CoopDesktopShortcuts) 'Set-CoopDesktopShortcuts wrote a shortcut for the isolated install'
    Check (Test-Path -LiteralPath $sandboxDesktopLnk) 'the Desktop shortcut is in the sandbox Desktop (folder created on demand)'
    Check (Test-Path -LiteralPath $sandboxProgramsLnk) 'the Start Menu shortcut is under the sandbox roaming AppData'
    foreach ($p in @($realDesktopLnk, $realProgramsLnk)) {
      $now = if (Test-Path -LiteralPath $p) { (Get-Item -LiteralPath $p).LastWriteTimeUtc } else { $null }
      Check ($now -eq $realStamp[$p]) "the real shortcut was not written ($p)"
    }
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($sandboxDesktopLnk)
    Check ($sc.Arguments -like "*$(Join-Path $root 'bin\coop-desktop.ps1')*") 'the sandbox shortcut launches this checkout''s coop-desktop.ps1'

    # update's -OnlyIfPresent repairs an existing shortcut and leaves a removed one removed.
    Remove-Item -LiteralPath $sandboxDesktopLnk -Force
    Check (Set-CoopDesktopShortcuts -OnlyIfPresent) '-OnlyIfPresent still refreshes the remaining (Start Menu) shortcut'
    Check (-not (Test-Path -LiteralPath $sandboxDesktopLnk)) '-OnlyIfPresent does not recreate a removed Desktop shortcut'
  } else {
    Check (-not (Set-CoopDesktopShortcuts)) 'off Windows, Set-CoopDesktopShortcuts writes nothing and returns $false'
  }

  Write-Host "  $n profile-redirect checks passed"
}
finally {
  foreach ($name in $prior.Keys) { [Environment]::SetEnvironmentVariable($name, $prior[$name]) }
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

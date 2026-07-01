#!/usr/bin/env pwsh
#
# coop-desktop.ps1 - double-click "front door" for coop (Windows).
#
# Purpose: let people who aren't comfortable opening a terminal launch coop by
# double-clicking an icon. This is PURELY ADDITIVE - it changes nothing for anyone
# who runs `coop` in a terminal. It just finds coop (installing it on first run if
# needed), runs it in this window, and keeps the window open if something goes
# wrong so the error is readable instead of flashing shut.
#
# The Start Menu / Desktop shortcut created by `coop install` points here.

$ErrorActionPreference = 'Stop'
try { $Host.UI.RawUI.WindowTitle = 'coop' } catch { }

function Find-Coop {
  # Prefer whatever is on PATH; otherwise the installer drops a launcher in LOCALAPPDATA.
  $cmd = Get-Command coop -ErrorAction SilentlyContinue
  if ($cmd) { return 'coop' }
  $local = Join-Path $env:LOCALAPPDATA 'coop\bin\coop.cmd'
  if (Test-Path -LiteralPath $local) { return $local }
  return $null
}

$coop = Find-Coop

if (-not $coop) {
  Write-Host ''
  Write-Host 'coop is not installed yet - running first-time setup...' -ForegroundColor Cyan
  Write-Host ''
  $dispatcher = Join-Path $PSScriptRoot 'coop.ps1'
  if (Test-Path -LiteralPath $dispatcher) {
    try { & $dispatcher install } catch { Write-Host "Setup failed: $($_.Exception.Message)" -ForegroundColor Red }
  } else {
    Write-Host "Can't find coop.ps1 next to this launcher." -ForegroundColor Red
  }
  $coop = Find-Coop
}

if (-not $coop) {
  Write-Host ''
  Write-Host "coop couldn't be found or installed automatically." -ForegroundColor Red
  Write-Host 'Open a terminal in the coop-agent folder and run:  .\bin\coop.ps1 install' -ForegroundColor Yellow
  Read-Host 'Press Enter to close'
  exit 1
}

# Run coop in THIS window, forwarding any extra args. On a clean exit the window
# closes; on an error we pause so the message stays on screen for a non-technical user.
$code = 0
try {
  & $coop @args
  $code = $LASTEXITCODE
} catch {
  Write-Host ''
  Write-Host "coop hit a problem: $($_.Exception.Message)" -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

if ($code -and $code -ne 0) {
  Write-Host ''
  Write-Host "coop exited with code $code. Review the messages above." -ForegroundColor Yellow
  Read-Host 'Press Enter to close'
  exit $code
}

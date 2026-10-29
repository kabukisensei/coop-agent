#!/usr/bin/env pwsh
# The window's setup progress (Aaron 2026-10-29): Set-CoopSetupPhase and
# Set-CoopSetupDetail write the small JSON file coop.exe names in
# COOP_BOOT_STATUS (desktop/lib/setup-status.mjs reads it), carry the phase in
# the environment so a child script's items land under its parent's step, and
# write nothing without COOP_BOOT_STATUS. install.ps1 and sync.ps1 name their
# steps and items ("Python tools (3 of 7): <tool> <pin>"). Offline; temp files only.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-setup-status-' + [guid]::NewGuid().ToString('N'))

$saved = Save-Env @('COOP_BOOT_STATUS', 'COOP_BOOT_PHASE', 'COOP_BOOT_STEP', 'COOP_BOOT_STEPS')
try {
  New-Item -ItemType Directory -Force -Path $t | Out-Null
  foreach ($k in @('COOP_BOOT_STATUS', 'COOP_BOOT_PHASE', 'COOP_BOOT_STEP', 'COOP_BOOT_STEPS')) { Remove-Item "Env:\$k" -ErrorAction SilentlyContinue }
  . (Join-Path $root 'lib\common.ps1')
  $file = Join-Path $t 'setup-status.json'

  # No COOP_BOOT_STATUS (every terminal run): nothing written, no phase in the environment.
  Set-CoopSetupPhase 4 8 'Installing coop''s Python tools'
  Set-CoopSetupDetail 'Python tools (1 of 3): x 1.0'
  if (-not (Test-Path -LiteralPath $file) -and -not $env:COOP_BOOT_PHASE) { Ok 'without COOP_BOOT_STATUS nothing is written' } else { Ko 'a status was written without COOP_BOOT_STATUS' }

  $env:COOP_BOOT_STATUS = $file
  Set-CoopSetupPhase 4 8 'Installing coop''s Python tools' 'starting'
  # (pwsh 7's ConvertFrom-Json turns the time into a DateTime: the raw text is checked for it.)
  $s = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
  if ($s.schema -eq 1 -and $s.step -eq 4 -and $s.steps -eq 8 -and $s.phase -eq "Installing coop's Python tools" -and $s.detail -eq 'starting' -and (Get-Content -LiteralPath $file -Raw) -match '"since":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z"') { Ok 'a phase writes schema 1 with its step, count, phase, detail and UTC time' } else { Ko 'phase status wrong' (Get-Content -LiteralPath $file -Raw) }
  if ($env:COOP_BOOT_PHASE -eq "Installing coop's Python tools" -and $env:COOP_BOOT_STEP -eq '4' -and $env:COOP_BOOT_STEPS -eq '8') { Ok 'the phase travels in the environment for child scripts' } else { Ko 'phase not in the environment' }

  # A child process (sync.ps1 under install.ps1) adds its item under the parent's step.
  $psExe = (Get-Process -Id $PID).Path
  $childCmd = ". '" + (Join-Path $root 'lib\common.ps1').Replace("'", "''") + "'; Set-CoopSetupDetail 'Extensions (2 of 9): pi-mcp-adapter 5.4.0'"
  & $psExe -NoProfile -Command $childCmd | Out-Null
  $s = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
  if ($s.step -eq 4 -and $s.steps -eq 8 -and $s.phase -eq "Installing coop's Python tools" -and $s.detail -eq 'Extensions (2 of 9): pi-mcp-adapter 5.4.0') { Ok "a child script's item lands under the parent's step" } else { Ko 'child detail wrong' (Get-Content -LiteralPath $file -Raw) }
  if (-not (Get-ChildItem -LiteralPath $t -Filter '*.tmp')) { Ok 'no temp file is left behind' } else { Ko 'a temp file was left behind' }

  # A status file that cannot be written never fails the setup.
  $env:COOP_BOOT_STATUS = Join-Path $t 'missing\dir\setup-status.json'
  $threw = $false
  try { Set-CoopSetupDetail 'x' } catch { $threw = $true }
  if (-not $threw) { Ok 'an unwritable status file is silent' } else { Ko 'an unwritable status file threw' }

  # The scripts name their steps and items.
  $install = Get-Content -LiteralPath (Join-Path $root 'scripts\install.ps1') -Raw
  foreach ($n in 1..8) {
    if ($install -match "Set-CoopSetupPhase $n 8 '") { Ok "install.ps1 names step $n of 8 for the window" } else { Ko "install.ps1 does not name step $n of 8" }
  }
  if ($install.Contains('$toolLabel = "Python tools ($toolIndex of $toolCount): $($tool.Name) $($tool.Pin)"') -and $install.Contains('Set-CoopSetupDetail $toolLabel') -and $install.Contains('Install-Unit $toolLabel ')) { Ok 'each Python tool is counted, named with its pin, on the console and in the window' } else { Ko 'install.ps1 does not count the Python tools' }
  $common = Get-Content -LiteralPath (Join-Path $root 'lib\common.ps1') -Raw
  if ($common.Contains('Set-CoopSetupDetail "Extensions ($fleetIndex of $($fleetPlan.Count)): $($ext.Name) $($ext.Pin)"')) { Ok 'each extension is counted and named with its pin' } else { Ko 'the extension fleet does not name its items' }
  $coop = Get-Content -LiteralPath (Join-Path $root 'bin\coop.ps1') -Raw
  if ($coop.Contains("Set-CoopSetupPhase 0 8 `"Setting up coop") -and $coop.Contains("Set-CoopSetupPhase 1 1 `"Refreshing this account")) { Ok 'coop desktop names the first launch and the new-version refresh' } else { Ko 'coop desktop does not name its setup' }
}
finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  setup-status tests passed' } else { Write-Host "  $G_CROSS setup-status tests FAILED" }
exit $fail

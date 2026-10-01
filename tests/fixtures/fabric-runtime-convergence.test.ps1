#!/usr/bin/env pwsh
# Sync-CoopFabricPythonPackages: a library already at its manifest pin is left
# alone (no pipx inject, no network); a missing or drifted one is re-injected
# with --force; -Edge re-injects fabric-cicd unpinned; a failing inject returns
# $false and carries pip's last ERROR line on the warning (#186).
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-fabric-runtime-' + [guid]::NewGuid().ToString('N'))
$calls = Join-Path $temp 'calls'
$isWin = ($env:OS -eq 'Windows_NT')
$shim = Join-Path $temp $(if ($isWin) { 'pipx.cmd' } else { 'pipx' })
$failShim = Join-Path $temp $(if ($isWin) { 'pipx-fail.cmd' } else { 'pipx-fail' })
try {
  New-Item -ItemType Directory -Force -Path $temp | Out-Null
  if ($isWin) {
    [System.IO.File]::WriteAllText($shim, "@echo off`r`necho PIPX %*>>`"$calls`"`r`nexit /b 0`r`n")
    [System.IO.File]::WriteAllText($failShim, "@echo off`r`necho PIPX %*>>`"$calls`"`r`necho Collecting %3 1>&2`r`necho ERROR: No matching distribution found for %3 1>&2`r`nexit /b 1`r`n")
  } else {
    [System.IO.File]::WriteAllText($shim, "#!/bin/sh`nprintf 'PIPX %s\\n' `"`$*`" >> '$calls'`nexit 0`n")
    [System.IO.File]::WriteAllText($failShim, "#!/bin/sh`nprintf 'PIPX %s\\n' `"`$*`" >> '$calls'`nprintf 'Collecting %s\n' `"`$3`" >&2`nprintf 'ERROR: No matching distribution found for %s\n' `"`$3`" >&2`nexit 1`n")
    & chmod +x $shim $failShim
  }

  . (Join-Path $root 'lib\common.ps1')
  $script:pipxShim = $shim
  $script:installed = @{}
  $script:warnings = @()
  function Get-CoopPipxCmd { return $script:pipxShim }
  function Get-CoopVenvDistVersion([string]$Venv, [string]$Distribution) {
    if ($Venv -ne 'ms-fabric-cli') { throw "unexpected venv probe: $Venv" }
    if ($script:installed.ContainsKey($Distribution)) { return $script:installed[$Distribution] } else { return '' }
  }
  function Get-CoopFabricSqlRuntimeStatus { return [pscustomobject]@{ state = 'ready'; version = '5.3.0'; driver = 18 } }
  function Coop-Warn { param([string]$m, [string]$Hint = '') $script:warnings += "$m|$Hint" }
  Remove-Item Env:COOP_FABRIC_PYTHON -ErrorAction SilentlyContinue

  $cicdPin = Coop-ManifestGet -Key 'python_tools.fabric-cicd'
  $odbcPin = Coop-ManifestGet -Key 'python_tools.pyodbc'
  if (-not $cicdPin -or -not $odbcPin) { throw 'manifest pins for fabric-cicd / pyodbc are missing' }

  # 1. Nothing installed: both libraries are injected at their pins.
  [System.IO.File]::WriteAllText($calls, '')
  if (-not (Sync-CoopFabricPythonPackages $false)) { throw 'normal convergence failed' }
  $normal = Get-Content -LiteralPath $calls -Raw
  if ($normal -notlike "*PIPX inject ms-fabric-cli fabric-cicd==$cicdPin --force*" -or
      $normal -notlike "*PIPX inject ms-fabric-cli pyodbc==$odbcPin --force*") {
    throw "normal convergence argv mismatch`n$normal"
  }

  # 2. Edge: fabric-cicd unpinned, pyodbc still pinned.
  [System.IO.File]::WriteAllText($calls, '')
  if (-not (Sync-CoopFabricPythonPackages $true)) { throw 'edge convergence failed' }
  $edge = Get-Content -LiteralPath $calls -Raw
  if ($edge -notlike '*PIPX inject ms-fabric-cli fabric-cicd --force*' -or
      $edge -like "*fabric-cicd==$cicdPin*" -or
      $edge -notlike "*PIPX inject ms-fabric-cli pyodbc==$odbcPin --force*") {
    throw "edge convergence argv mismatch`n$edge"
  }

  # 3. Both at their pins: no inject at all (idempotent, offline-safe).
  $script:installed = @{ 'fabric-cicd' = $cicdPin; 'pyodbc' = $odbcPin }
  [System.IO.File]::WriteAllText($calls, '')
  if (-not (Sync-CoopFabricPythonPackages $false)) { throw 'converged runtime reported failure' }
  $none = Get-Content -LiteralPath $calls -Raw
  if ($none -and $none.Trim()) { throw "pinned libraries were re-injected:`n$none" }

  # 3b. Edge with both at pin: fabric-cicd is still refreshed, pyodbc is not.
  [System.IO.File]::WriteAllText($calls, '')
  if (-not (Sync-CoopFabricPythonPackages $true)) { throw 'edge on converged runtime failed' }
  $edgePinned = Get-Content -LiteralPath $calls -Raw
  if ($edgePinned -notlike '*PIPX inject ms-fabric-cli fabric-cicd --force*' -or $edgePinned -like '*pyodbc*') {
    throw "edge on converged runtime argv mismatch`n$edgePinned"
  }

  # 4. One drifted library: only that one is re-injected.
  $script:installed = @{ 'fabric-cicd' = $cicdPin; 'pyodbc' = '0.0.1' }
  [System.IO.File]::WriteAllText($calls, '')
  if (-not (Sync-CoopFabricPythonPackages $false)) { throw 'drift convergence failed' }
  $drift = Get-Content -LiteralPath $calls -Raw
  if ($drift -like '*fabric-cicd*' -or $drift -notlike "*PIPX inject ms-fabric-cli pyodbc==$odbcPin --force*") {
    throw "drift convergence argv mismatch`n$drift"
  }

  # 5. pip fails: the sync reports failure and the warning carries pip's ERROR line.
  $script:installed = @{}
  $script:pipxShim = $failShim
  $script:warnings = @()
  [System.IO.File]::WriteAllText($calls, '')
  if (Sync-CoopFabricPythonPackages $false) { throw 'a failing inject was reported as success' }
  if ($script:warnings.Count -ne 1) { throw "expected one warning, got $($script:warnings.Count): $($script:warnings -join ' / ')" }
  $w = $script:warnings[0]
  # cmd.exe splits arguments on '=', so the Windows shim's %3 is only the
  # package name; the sh shim echoes the full spec. Match the common prefix.
  if ($w -notlike "failed to install fabric-cicd==$cicdPin in the ms-fabric-cli environment|ERROR: No matching distribution found for fabric-cicd*") {
    throw "warning did not carry pip's error line: $w"
  }
  $failed = Get-Content -LiteralPath $calls -Raw
  if ($failed -like '*pyodbc*') { throw "sync went on to pyodbc after fabric-cicd failed:`n$failed" }

  Write-Host '  OK  PowerShell Fabric runtime convergence: pinned libraries skipped, drift and edge re-injected, pip errors surfaced'
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

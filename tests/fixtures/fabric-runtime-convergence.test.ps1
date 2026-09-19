#!/usr/bin/env pwsh
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-fabric-runtime-' + [guid]::NewGuid().ToString('N'))
$calls = Join-Path $temp 'calls'
$shim = Join-Path $temp $(if ($env:OS -eq 'Windows_NT') { 'pipx.cmd' } else { 'pipx' })
try {
  New-Item -ItemType Directory -Force -Path $temp | Out-Null
  if ($env:OS -eq 'Windows_NT') {
    [System.IO.File]::WriteAllText($shim, "@echo off`r`necho PIPX %*>>`"$calls`"`r`nexit /b 0`r`n")
  } else {
    [System.IO.File]::WriteAllText($shim, "#!/bin/sh`nprintf 'PIPX %s\\n' `"`$*`" >> '$calls'`nexit 0`n")
    & chmod +x $shim
  }

  . (Join-Path $root 'lib\common.ps1')
  function Get-CoopPipxCmd { return $shim }
  function Get-CoopFabricSqlRuntimeStatus { return [pscustomobject]@{ state = 'ready'; version = '5.3.0'; driver = 18 } }
  Remove-Item Env:COOP_FABRIC_PYTHON -ErrorAction SilentlyContinue

  [System.IO.File]::WriteAllText($calls, '')
  if (-not (Sync-CoopFabricPythonPackages $false)) { throw 'normal convergence failed' }
  $normal = Get-Content -LiteralPath $calls -Raw
  if ($normal -notlike '*PIPX inject ms-fabric-cli fabric-cicd==1.3.0 --force*' -or
      $normal -notlike '*PIPX inject ms-fabric-cli pyodbc==5.3.0 --force*') {
    throw "normal convergence argv mismatch`n$normal"
  }

  [System.IO.File]::WriteAllText($calls, '')
  if (-not (Sync-CoopFabricPythonPackages $true)) { throw 'edge convergence failed' }
  $edge = Get-Content -LiteralPath $calls -Raw
  if ($edge -notlike '*PIPX inject ms-fabric-cli fabric-cicd --force*' -or
      $edge -like '*fabric-cicd==1.3.0*' -or
      $edge -notlike '*PIPX inject ms-fabric-cli pyodbc==5.3.0 --force*') {
    throw "edge convergence argv mismatch`n$edge"
  }
  Write-Host '  OK  PowerShell normal/edge Fabric runtime argv preserve cicd edge and pinned pyodbc semantics'
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

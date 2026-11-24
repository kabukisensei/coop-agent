#!/usr/bin/env pwsh
# Sync-CoopToolLibraries: coop-data-doc's environment gets pyodbc at the manifest
# pin (its live dev database read needs it). At the pin nothing is injected; a
# missing or drifted one is injected with --force; a failing inject returns a
# message and Invoke-CoopPipxConverge still reports the tool itself as fine.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-data-doc-live-' + [guid]::NewGuid().ToString('N'))
$calls = Join-Path $temp 'calls'
$isWin = ($env:OS -eq 'Windows_NT')
$shim = Join-Path $temp $(if ($isWin) { 'pipx.cmd' } else { 'pipx' })
$failShim = Join-Path $temp $(if ($isWin) { 'pipx-fail.cmd' } else { 'pipx-fail' })
try {
  New-Item -ItemType Directory -Force -Path $temp | Out-Null
  if ($isWin) {
    [System.IO.File]::WriteAllText($shim, "@echo off`r`necho PIPX %*>>`"$calls`"`r`nexit /b 0`r`n")
    [System.IO.File]::WriteAllText($failShim, "@echo off`r`necho PIPX %*>>`"$calls`"`r`nexit /b 1`r`n")
  } else {
    [System.IO.File]::WriteAllText($shim, "#!/bin/sh`nprintf 'PIPX %s\\n' `"`$*`" >> '$calls'`nexit 0`n")
    [System.IO.File]::WriteAllText($failShim, "#!/bin/sh`nprintf 'PIPX %s\\n' `"`$*`" >> '$calls'`nexit 1`n")
    & chmod +x $shim $failShim
  }

  . (Join-Path $root 'lib\common.ps1')
  $script:pipxShim = $shim
  $script:installed = @{}
  function Get-CoopPipxInvocation { return @($script:pipxShim) }
  function Get-CoopVenvDistVersion([string]$Venv, [string]$Distribution) {
    if ($Venv -ne 'coop-data-doc') { throw "unexpected venv probe: $Venv" }
    if ($script:installed.ContainsKey($Distribution)) { return $script:installed[$Distribution] } else { return '' }
  }
  $script:toolResult = $null
  function Invoke-CoopPipxConvergeTool { param([string]$Package, [string]$Pin, [bool]$Edge = $false, [bool]$Force = $false, [string]$Python = '', [string]$FetchPython = '') return $script:toolResult }
  function Get-CoopPipxToolVersion([string]$Package) { return '9.9.9' }

  $odbcPin = Coop-ManifestGet -Key 'python_tools.pyodbc'
  if (-not $odbcPin) { throw 'manifest pin for pyodbc is missing' }

  # 1. Missing: injected at the pin.
  [System.IO.File]::WriteAllText($calls, '')
  $msg = Sync-CoopToolLibraries 'coop-data-doc'
  if ($msg) { throw "a working inject returned a message: $msg" }
  $first = Get-Content -LiteralPath $calls -Raw
  if ($first -notlike "*PIPX inject coop-data-doc pyodbc==$odbcPin --force*") { throw "inject argv mismatch`n$first" }

  # 2. At the pin: nothing runs.
  $script:installed = @{ 'pyodbc' = $odbcPin }
  [System.IO.File]::WriteAllText($calls, '')
  $msg = Sync-CoopToolLibraries 'coop-data-doc'
  $none = Get-Content -LiteralPath $calls -Raw
  if ($msg -or ($none -and $none.Trim())) { throw "a pinned library was re-injected: $msg`n$none" }

  # 3. Drifted: injected again.
  $script:installed = @{ 'pyodbc' = '0.0.1' }
  [System.IO.File]::WriteAllText($calls, '')
  $msg = Sync-CoopToolLibraries 'coop-data-doc'
  $drift = Get-Content -LiteralPath $calls -Raw
  if ($msg -or $drift -notlike "*PIPX inject coop-data-doc pyodbc==$odbcPin --force*") { throw "drift was not repaired: $msg`n$drift" }

  # 4. A tool with no libraries: the converge result is passed through, no pipx call.
  $script:installed = @{}
  $script:toolResult = Coop-UnitResult $true 'coop-schema-compare ok'
  [System.IO.File]::WriteAllText($calls, '')
  $r = Invoke-CoopPipxConverge -Package 'coop-schema-compare' -Pin '1.0.0'
  $other = Get-Content -LiteralPath $calls -Raw
  if (-not $r.ok -or $r.msg -ne 'coop-schema-compare ok' -or ($other -and $other.Trim())) { throw "another tool got a library inject: $($r.msg)`n$other" }

  # 5. coop-data-doc converged: the library follows, the tool's message is kept.
  $script:toolResult = Coop-UnitResult $true 'coop-data-doc ok'
  [System.IO.File]::WriteAllText($calls, '')
  $r = Invoke-CoopPipxConverge -Package 'coop-data-doc' -Pin '1.0.0'
  $conv = Get-Content -LiteralPath $calls -Raw
  if (-not $r.ok -or $r.msg -ne 'coop-data-doc ok' -or $conv -notlike "*PIPX inject coop-data-doc pyodbc==$odbcPin --force*") { throw "converge did not add the library: $($r.msg)`n$conv" }

  # 6. The tool failed: no inject is tried.
  $script:toolResult = Coop-UnitResult $false 'coop-data-doc failed'
  [System.IO.File]::WriteAllText($calls, '')
  $r = Invoke-CoopPipxConverge -Package 'coop-data-doc' -Pin '1.0.0'
  $failedTool = Get-Content -LiteralPath $calls -Raw
  if ($r.ok -or ($failedTool -and $failedTool.Trim())) { throw "a failed tool still got an inject`n$failedTool" }

  # 7. The inject fails: the unit stays ok and says what is missing.
  $script:toolResult = Coop-UnitResult $true 'coop-data-doc ok'
  $script:pipxShim = $failShim
  $r = Invoke-CoopPipxConverge -Package 'coop-data-doc' -Pin '1.0.0'
  if (-not $r.ok -or $r.msg -notlike "coop-data-doc ok; pyodbc $odbcPin could not be added to its environment*") { throw "a failed inject was not reported on the unit: ok=$($r.ok) $($r.msg)" }

  Write-Host '  OK  coop-data-doc live library: pyodbc injected at the pin, skipped when present, a failed inject never fails the tool'
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

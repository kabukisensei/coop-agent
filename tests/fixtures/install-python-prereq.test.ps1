#!/usr/bin/env pwsh
# Execute the real Windows installer with an incompatible generic Python and an
# initially absent explicit Fabric interpreter and no Windows Python installer.
# pipx must fetch a standalone 3.12 runtime, proving install.ps1 does not require
# winget, py, or pymanager to repair a Python 3.14-only workstation.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$install = Join-Path $root 'scripts\install.ps1'
$update = Join-Path $root 'scripts\update.ps1'
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-install-python-' + [guid]::NewGuid().ToString('N'))
$bin = Join-Path $t 'bin'
$calls = Join-Path $t 'calls'
$isWindowsHost = ($env:OS -eq 'Windows_NT')
if (-not $isWindowsHost) {
  Write-Host '  --  Windows fresh-install prerequisite fixture runs in Windows CI'
  exit 0
}

function Write-Shim {
  param([string]$Name, [string]$Sh, [string]$Cmd)
  [System.IO.File]::WriteAllText((Join-Path $bin $Name), $Sh)
  [System.IO.File]::WriteAllText((Join-Path $bin ($Name + '.cmd')), $Cmd)
  if (-not $isWindowsHost) { & chmod +x (Join-Path $bin $Name) }
}

$saved = @{}
foreach ($name in @('PATH','HOME','COOP_DIR','PIPX_HOME','PIPX_BIN_DIR','PI_CODING_AGENT_DIR','COOP_AGENT_DIR','COOP_NO_ONBOARD','COOP_FLEET_TEST_MODE','COOP_FABRIC_PYTHON','COOP_TEST_CALLS','COOP_TEST_PY_TEMPLATE','LOCALAPPDATA','ProgramFiles','SystemRoot')) {
  $saved[$name] = [Environment]::GetEnvironmentVariable($name)
}

try {
  New-Item -ItemType Directory -Force -Path $bin, (Join-Path $t 'home'), (Join-Path $t 'pipx-home'), (Join-Path $t 'pipx-bin'), (Join-Path $t 'agent'), (Join-Path $t 'program-files'), (Join-Path $t 'local-app-data'), (Join-Path $t 'system-root') | Out-Null
  $fabricPython = Join-Path $t $(if ($isWindowsHost) { 'python312.cmd' } else { 'python312' })
  $pythonTemplate = Join-Path $t $(if ($isWindowsHost) { 'python-template.cmd' } else { 'python-template' })
  if ($isWindowsHost) {
    [System.IO.File]::WriteAllText($pythonTemplate, "@echo off`r`nif `"%1`"==`"--version`" echo Python 3.12.9`r`nif `"%1`"==`"-c`" echo 3.12`r`nexit /b 0`r`n")
  } else {
    [System.IO.File]::WriteAllText($pythonTemplate, "#!/bin/sh`n[ `"`$1`" = `"--version`" ] && echo 'Python 3.12.9'`n[ `"`$1`" = `"-c`" ] && echo '3.12'`nexit 0`n")
    & chmod +x $pythonTemplate
  }

  Write-Shim 'python3' @'
#!/bin/sh
[ "$1" = "--version" ] && echo 'Python 3.14.6'
[ "$1" = "-c" ] && echo '3.14'
exit 0
'@ @'
@echo off
if "%1"=="--version" echo Python 3.14.6
if "%1"=="-c" echo 3.14
exit /b 0
'@
  Write-Shim 'pi' @'
#!/bin/sh
[ "$1" = "--version" ] && echo 'pi 0.84.3'
exit 0
'@ @'
@echo off
if "%1"=="--version" echo pi 0.84.3
exit /b 0
'@
  Write-Shim 'git' @'
#!/bin/sh
[ "$1" = "--version" ] && { echo 'git version 2.50.0'; exit 0; }
exit 1
'@ @'
@echo off
if "%1"=="--version" (
  echo git version 2.50.0
  exit /b 0
)
exit /b 1
'@
  Write-Shim 'npm' "#!/bin/sh`nexit 0`n" "@echo off`r`nexit /b 0`r`n"
  Write-Shim 'pipx' @'
#!/bin/sh
echo "PIPX $*" >> "$COOP_TEST_CALLS"
if [ "$1" = "list" ]; then
  echo 'package coop-data-doc 1.1.1'; echo 'package coop-sql-review 0.15.2'; echo 'package coop-dax-review 0.22.0'; echo 'package ms-fabric-cli 1.7.0'
fi
exit 0
'@ @'
@echo off
echo PIPX %*>>"%COOP_TEST_CALLS%"
if "%1"=="install" if "%2"=="--help" (
  echo --fetch-python {always,missing,never}
  exit /b 0
)
if "%1"=="list" (
  echo package coop-data-doc 1.1.1
  echo package coop-sql-review 0.15.2
  echo package coop-dax-review 0.22.0
  echo package ms-fabric-cli 1.7.0
)
exit /b 0
'@
  Write-Shim 'fab' "#!/bin/sh`necho 'fab version 1.7.0'`n" "@echo off`r`necho fab version 1.7.0`r`n"
  Write-Shim 'az' "#!/bin/sh`necho 'azure-cli 2.80.0'`n" "@echo off`r`necho azure-cli 2.80.0`r`n"

  # Defect D bounded comparison, stage A: a harmless Start-Job returning a
  # fixed synthetic value in a CLEAN session (real SystemRoot, unmodified
  # PATH/HOME). Establishes whether process-backed job startup works at all on
  # this runner before any fixture environment is applied. Evidence only; no
  # assertion depends on it and no stream is suppressed.
  $jobEvidencePath = Join-Path $t 'start-job-evidence.log'
  $jobEvidence = New-Object System.Collections.Generic.List[string]
  $jobEvidence.Add("parent.ps=$($PSVersionTable.PSVersion)")
  $jobEvidence.Add("parent.start_thread_job_available=$([bool](Get-Command Start-ThreadJob -ErrorAction SilentlyContinue))")
  $jobEvidence.Add("control_a.system_root=$env:SystemRoot")
  $controlA = $null
  try {
    $controlA = Start-Job -ScriptBlock { 'CONTROL_A_OK' }
    $null = Wait-Job $controlA -Timeout 15
    if ($controlA.State -eq 'Running') {
      $jobEvidence.Add('control_a.timeout=15s')
      Stop-Job $controlA -ErrorAction SilentlyContinue
    }
    $jobEvidence.Add("control_a.state=$($controlA.State)")
    if ($controlA.State -eq 'Completed') {
      $aResults = @(Receive-Job $controlA -ErrorAction SilentlyContinue)
      $jobEvidence.Add("control_a.result=$($aResults -join ',')")
    } else {
      $aReason = $controlA.ChildJobs[0].JobStateInfo.Reason
      $jobEvidence.Add("control_a.reason=$(if ($aReason) { [string]$aReason.Message } else { '<none>' })")
    }
  } catch {
    $jobEvidence.Add("control_a.exception=$($_.Exception.Message)")
  } finally {
    if ($controlA) { Remove-Job $controlA -Force -ErrorAction SilentlyContinue }
  }

  $env:PATH = "$bin$([System.IO.Path]::PathSeparator)$($saved['PATH'])"
  $env:HOME = Join-Path $t 'home'
  $env:COOP_DIR = Join-Path $t 'coop-dir'
  $env:PIPX_HOME = Join-Path $t 'pipx-home'
  $env:PIPX_BIN_DIR = Join-Path $t 'pipx-bin'
  $env:PI_CODING_AGENT_DIR = Join-Path $t 'agent'
  $env:COOP_AGENT_DIR = $env:PI_CODING_AGENT_DIR
  $env:COOP_NO_ONBOARD = '1'
  $env:COOP_FLEET_TEST_MODE = '1'
  $env:COOP_FABRIC_PYTHON = $fabricPython
  $env:COOP_TEST_CALLS = $calls
  $env:COOP_TEST_PY_TEMPLATE = $pythonTemplate
  $env:LOCALAPPDATA = Join-Path $t 'local-app-data'
  $env:ProgramFiles = Join-Path $t 'program-files'
  $env:SystemRoot = Join-Path $t 'system-root'
  [System.IO.File]::WriteAllText($calls, '')

  # Defect D bounded comparison, stage B: the SAME harmless job under the
  # fixture's fully controlled environment (synthetic SystemRoot/PATH/HOME...).
  # The child writes a phase marker FIRST, before any other work, so "child
  # process started and runspace entered" is proven independently of the job's
  # final state. Distinguishes job STARTUP failure (environment) from failure
  # inside the materialization body.
  $phaseB = Join-Path $t 'control-b-phase.log'
  $controlB = $null
  try {
    $controlB = Start-Job -ArgumentList $phaseB -ScriptBlock {
      param($phasePath)
      [System.IO.File]::WriteAllText($phasePath, 'phase=entered')
      [pscustomobject]@{ result = 'CONTROL_B_OK'; system_root = $env:SystemRoot }
    }
    $null = Wait-Job $controlB -Timeout 15
    if ($controlB.State -eq 'Running') {
      $jobEvidence.Add('control_b.timeout=15s')
      Stop-Job $controlB -ErrorAction SilentlyContinue
    }
    $jobEvidence.Add("control_b.state=$($controlB.State)")
    $jobEvidence.Add("control_b.phase_entered=$([System.IO.File]::Exists($phaseB))")
    if ($controlB.State -eq 'Completed') {
      $bResults = @($controlB | Receive-Job -ErrorAction SilentlyContinue)
      if ($bResults.Count -gt 0) {
        $jobEvidence.Add("control_b.result=$($bResults[0].result)")
        $jobEvidence.Add("control_b.child_system_root=$($bResults[0].system_root)")
      } else {
        $jobEvidence.Add('control_b.result=<zero-results>')
      }
    } else {
      $bReason = $controlB.ChildJobs[0].JobStateInfo.Reason
      $jobEvidence.Add("control_b.reason=$(if ($bReason) { [string]$bReason.Message } else { '<none>' })")
    }
  } catch {
    $jobEvidence.Add("control_b.exception=$($_.Exception.Message)")
  } finally {
    if ($controlB) { Remove-Job $controlB -Force -ErrorAction SilentlyContinue }
  }

  # Defect D bounded materialization probe. Windows PowerShell 5.1 lacks
  # Start-ThreadJob, so Coop-Unit uses process-backed Start-Job. Exercise that
  # exact isolation boundary before install.ps1: record whether the child
  # runspace materializes (phase-entered marker written before any other work),
  # what SystemRoot it inherits, which synthetic pipx executable it resolves,
  # the harmless exact argv, its exit status, and its sanitized output. Bound
  # the probe to 15s and always remove its owned job.
  $diagPhase = Join-Path $t 'materialize-phase.log'
  $diagJob = $null
  try {
    $diagJob = Start-Job -ArgumentList $diagPhase -ScriptBlock {
      param($phasePath)
      [System.IO.File]::WriteAllText($phasePath, 'phase=entered')
      $argv = @('install', '--help')
      $cmd = Get-Command pipx -ErrorAction SilentlyContinue
      $resolved = if ($cmd) { $cmd.Source } else { '<unresolved>' }
      $out = if ($cmd) { (& $resolved @argv 2>&1 | Out-String).Trim() } else { '' }
      $rc = if ($cmd) { $LASTEXITCODE } else { 127 }
      [pscustomobject]@{
        system_root = $env:SystemRoot
        resolved_executable = $resolved
        arguments = ($argv -join ' ')
        exit_status = $rc
        output = $out
      }
    }
    $null = Wait-Job $diagJob -Timeout 15
    $jobEvidence.Add("job.state=$($diagJob.State)")
    $jobEvidence.Add("job.phase_entered=$([System.IO.File]::Exists($diagPhase))")
    if ($diagJob.State -eq 'Running') {
      $jobEvidence.Add('job.timeout=15s')
      Stop-Job $diagJob -ErrorAction SilentlyContinue
    } else {
      $jobErrors = @()
      $jobResults = @(Receive-Job $diagJob -ErrorVariable jobErrors -ErrorAction SilentlyContinue)
      $jobEvidence.Add("child.result_count=$($jobResults.Count)")
      $r = if ($jobResults.Count -gt 0) { $jobResults | Select-Object -Last 1 } else { $null }
      $reason = $diagJob.ChildJobs[0].JobStateInfo.Reason
      $reasonMessage = if (-not $reason) {
        '<none>'
      } elseif ($reason.PSObject.Properties.Name -contains 'Message') {
        [string]$reason.Message
      } elseif (($reason.PSObject.Properties.Name -contains 'Exception') -and $reason.Exception) {
        [string]$reason.Exception.Message
      } else {
        [string]$reason
      }
      $jobEvidence.Add("job.reason=$reasonMessage")
      $jobEvidence.Add("job.error=$(if ($jobErrors) { ($jobErrors | ForEach-Object { $_.Exception.Message }) -join ' | ' } else { '<none>' })")
      if ($null -ne $r) {
        $jobEvidence.Add("child.system_root=$($r.system_root)")
        $jobEvidence.Add("child.resolved_executable=$($r.resolved_executable)")
        $jobEvidence.Add("child.arguments=$($r.arguments)")
        $jobEvidence.Add("child.exit_status=$($r.exit_status)")
        $jobEvidence.Add("child.output=$($r.output)")
      }
    }
  } catch {
    $jobEvidence.Add("probe.exception=$($_.Exception.Message)")
  } finally {
    if ($diagJob) { Remove-Job $diagJob -Force -ErrorAction SilentlyContinue }
    [System.IO.File]::WriteAllLines($jobEvidencePath, $jobEvidence)
  }
  $jobEvidence | ForEach-Object { Write-Host "DEFECTD| $_" }

  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  # Defect D supplemental stream evidence: capture every REDIRECTABLE pipeline
  # stream and preserve its record kind. Native run 34705091770 established that
  # Windows PowerShell 5.1 child Write-Host/host output can bypass *>&1, leaving
  # this tagged payload empty even while the host visibly prints the installer.
  # Therefore this block does NOT claim complete host-output capture or identify
  # the failing operation by itself; the bounded Start-Job probe above supplies
  # the materialization/executable/argv/status evidence. No stream is globally
  # suppressed and no assertion below is altered.
  $evidencePath = Join-Path $t 'install-evidence.log'
  $outItems = & $install --force *>&1
  $rc = $LASTEXITCODE
  $evidence = ($outItems | ForEach-Object {
    if ($_ -is [System.Management.Automation.ErrorRecord]) { "ERROR| $($_.Exception.Message)" }
    elseif ($_ -is [System.Management.Automation.WarningRecord]) { "WARN| $($_)" }
    else { "OUT| $_" }
  }) -join "`n"
  [System.IO.File]::WriteAllText($evidencePath, "exit=$rc`n$evidence")
  $output = $outItems | Out-String
  $ErrorActionPreference = $oldPreference
  if ($rc -ne 0) { Write-Error "install fixture exited $rc`nevidence file: $evidencePath`n$output`n--- stream-tagged ---`n$evidence`nCALLS:`n$(Get-Content $calls -Raw)" }
  $transcript = Get-Content $calls -Raw
  if ($transcript -like '*WINGET*') { Write-Error "Python 3.14-only install unexpectedly required winget`n$transcript" }
  if ($transcript -notlike '*PIPX install --force --fetch-python=missing --python 3.12 ms-fabric-cli==1.7.0*') { Write-Error "Fabric CLI did not fetch and use a standalone Python 3.12`n$transcript" }
  Write-Host '  OK  Windows installer fetches a standalone Fabric Python without winget/py/pymanager'

  [System.IO.File]::WriteAllText($calls, '')
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $evidencePath = Join-Path $t 'update-evidence.log'
  $outItems = & $update *>&1
  $rc = $LASTEXITCODE
  $evidence = ($outItems | ForEach-Object {
    if ($_ -is [System.Management.Automation.ErrorRecord]) { "ERROR| $($_.Exception.Message)" }
    elseif ($_ -is [System.Management.Automation.WarningRecord]) { "WARN| $($_)" }
    else { "OUT| $_" }
  }) -join "`n"
  [System.IO.File]::WriteAllText($evidencePath, "exit=$rc`n$evidence")
  $output = $outItems | Out-String
  $ErrorActionPreference = $oldPreference
  if ($rc -ne 0) { Write-Error "update fixture exited $rc`nevidence file: $evidencePath`n$output`n--- stream-tagged ---`n$evidence`nCALLS:`n$(Get-Content $calls -Raw)" }
  $transcript = Get-Content $calls -Raw
  if ($transcript -notlike '*PIPX install --force --fetch-python=missing --python 3.12 ms-fabric-cli==1.7.0*') { Write-Error "Updater did not rebuild Fabric CLI with standalone Python 3.12`n$transcript" }
  if ($transcript -notlike '*PIPX inject ms-fabric-cli fabric-cicd==1.3.0 --force*') { Write-Error "Updater did not reinject fabric-cicd after rebuilding Fabric CLI`n$transcript" }
  Write-Host '  OK  Windows updater repairs an existing Python 3.14 Fabric environment'
}
finally {
  foreach ($name in $saved.Keys) {
    if ($null -eq $saved[$name]) { [Environment]::SetEnvironmentVariable($name, $null) }
    else { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
  }
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}

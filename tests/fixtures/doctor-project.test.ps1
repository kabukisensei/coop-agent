#!/usr/bin/env pwsh
# scripts/doctor.ps1 --json
# Project-contract rows. A valid minimal contract (Fabric disabled) is clean; the
# legacy project findings (legacy_project_standard_override,
# missing_project_standard, legacy_pi_instruction, project_skill_collision) are
# all reported and doctor stays read-only; an empty organization/default_branch
# and missing repositories warn; discovery mode needs no repository; Fabric
# enabled without fabric.tenant_id warns; Tabular Editor enabled without
# executable_path warns. Sandboxed HOME/USERPROFILE/COOP_DIR/agent dir, never
# ~/.coop; COOP_SKIP_AZ=1 keeps az out, and a fresh fetch stamp in the sandbox
# agent dir keeps doctor from fetching this checkout (the bash suite ran a copy
# of the tree for the same reason). No waits, no network.
# Assertions stay ASCII: Windows PowerShell 5.1 re-encodes child output.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-doctor-project-' + [guid]::NewGuid().ToString('N'))

$sandboxHome = Join-Path $t 'home'
$agent = Join-Path $t 'agent'
$doctor = Join-Path $root 'scripts\doctor.ps1'

$saved = Save-Env @('HOME','USERPROFILE','COOP_DIR','COOP_AGENT_DIR','PI_CODING_AGENT_DIR','COOP_NO_ISOLATE','COOP_SKIP_AZ','NO_COLOR',
           'COOP_STANDARDS_ROOT','COOP_STANDARDS_STATE','COOP_STANDARDS_SNAPSHOT_ROOT','PSModuleAnalysisCachePath')
$savedLocation = Get-Location
try {
  New-Item -ItemType Directory -Force -Path $sandboxHome, (Join-Path $t 'coop\.coop'), $agent | Out-Null
  # Doctor refreshes the coop-agent checkout at most once a day; a fresh stamp
  # in the sandbox agent dir keeps this fixture offline and this checkout untouched.
  [System.IO.File]::WriteAllText((Join-Path $agent '.coop-fetch-stamp'), '')

  $env:HOME = $sandboxHome
  $env:USERPROFILE = $sandboxHome
  $env:COOP_DIR = Join-Path $t 'coop'
  $env:COOP_AGENT_DIR = $agent
  $env:COOP_SKIP_AZ = '1'
  $env:NO_COLOR = '1'
  # Windows PowerShell 5.1 writes its module analysis cache under LOCALAPPDATA and,
  # when that is unset (a sandboxed profile on the VM), into the CURRENT folder,
  # which the read-only digest below would count as Doctor mutating the project.
  $env:PSModuleAnalysisCachePath = Join-Path $t 'ModuleAnalysisCache'
  foreach ($n in @('PI_CODING_AGENT_DIR','COOP_NO_ISOLATE','COOP_STANDARDS_ROOT','COOP_STANDARDS_STATE','COOP_STANDARDS_SNAPSHOT_ROOT')) {
    Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue
  }

  function Write-Contract([string]$Dir, [string[]]$Lines) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Dir '.coop') | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $Dir '.coop\project.yml'), (($Lines -join "`n") + "`n"), $utf8)
  }
  # doctor.ps1 --json rows for the project at $Dir (its cwd).
  function Get-ProjectDoctorRows([string]$Dir) {
    Set-Location -LiteralPath $Dir
    try { return (Get-DoctorRows) } finally { Set-Location -LiteralPath $savedLocation }
  }
  function Get-ProjectRows($Rows) { @($Rows | Where-Object { [string]$_.section -eq 'Project contract' }) }
  function Test-RowContains($Rows, [string]$Needle) { (@($Rows | Where-Object { ([string]$_.name).Contains($Needle) })).Count -gt 0 }
  function Get-TreeDigest([string]$Dir) {
    (@(Get-ChildItem -LiteralPath $Dir -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
      "$($_.FullName) $((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)"
    }) -join "`n")
  }
  $off = @('tools:', '  fabric_cli:', '    enabled: false', '  fabric_cicd:', '    enabled: false', '  tabular_editor_cli:', '    enabled: false')

  # --- valid minimal contract (Fabric disabled) passes validation ---------------
  $good = Join-Path $t 'good'
  Write-Contract $good (@('profile:', '  organization: Cooptimize', '  default_branch: main', 'repositories:', '  good:',
    "    local_path: $(($good -replace '\\', '/'))", '    default_branch: main') + $off)
  $proj = Get-ProjectRows (Get-ProjectDoctorRows $good)
  $found = @($proj | Where-Object { ([string]$_.name).Contains('project.yml found') -and $_.status -eq 'ok' })
  $warns = @($proj | Where-Object { $_.status -eq 'warn' })
  if ($proj.Count -ge 1 -and $found.Count -ge 1 -and $warns.Count -eq 0) { Ok 'Project contract section present and clean' }
  else { Ko 'Project contract validation failed' (Show-Rows $proj) }

  # --- legacy project health is visible and Doctor remains read-only ------------
  $legacy = Join-Path $t 'legacy'
  Write-Contract $legacy (@('profile:', '  organization: Cooptimize', '  default_branch: main', 'estate:', '  mode: discovery',
    'repositories: {}', 'standards:', '  sql: docs/standards/sql-standards.md') + $off)
  New-Item -ItemType Directory -Force -Path (Join-Path $legacy '.pi\skills\daily-logger') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $legacy '.pi\AGENTS.md'), "Read docs/standards/sql-standards.md`n", $utf8)
  [System.IO.File]::WriteAllText((Join-Path $legacy '.pi\skills\daily-logger\SKILL.md'), "---`nname: daily-logger`n---`n", $utf8)
  $before = Get-TreeDigest $legacy
  $proj = Get-ProjectRows (Get-ProjectDoctorRows $legacy)
  $missing = @()
  foreach ($code in @('legacy_project_standard_override', 'missing_project_standard', 'legacy_pi_instruction', 'project_skill_collision')) {
    if (-not (Test-RowContains $proj "${code}:")) { $missing += $code }
  }
  if ($missing.Count -eq 0) { Ok 'Doctor reports every legacy project finding class' }
  else { Ko "Doctor omitted a legacy project finding: $($missing -join ', ')" (Show-Rows $proj) }
  $after = Get-TreeDigest $legacy
  if ($before -eq $after) { Ok 'Doctor legacy diagnostics are read-only' } else { Ko 'Doctor mutated legacy project files' }

  # --- missing organization / branch / repo -------------------------------------
  $bad = Join-Path $t 'bad'
  Write-Contract $bad @('profile:', '  organization: ""', 'tools:', '  fabric_cli:', '    enabled: false', '  tabular_editor_cli:', '    enabled: false')
  $proj = Get-ProjectRows (Get-ProjectDoctorRows $bad)
  if (Test-RowContains $proj 'organization is empty') { Ok 'flags empty organization' } else { Ko 'did not flag empty organization' (Show-Rows $proj) }
  if (Test-RowContains $proj 'default_branch is empty') { Ok 'flags empty default_branch' } else { Ko 'did not flag empty default_branch' (Show-Rows $proj) }
  if (Test-RowContains $proj 'no repositories configured') { Ok 'flags missing repositories' } else { Ko 'did not flag missing repositories' (Show-Rows $proj) }

  # --- explicit discovery mode needs no local repository -----------------------
  $discovery = Join-Path $t 'discovery'
  Write-Contract $discovery (@('profile:', '  organization: Cooptimize', '  default_branch: main', 'estate:', '  mode: discovery', 'repositories: {}') + $off)
  $proj = Get-ProjectRows (Get-ProjectDoctorRows $discovery)
  if (Test-RowContains $proj 'no repositories configured') { Ko 'warned about repositories in discovery mode' (Show-Rows $proj) }
  else { Ok 'accepts repository-free discovery mode' }

  # --- Fabric enabled but tenant missing ----------------------------------------
  $fabric = Join-Path $t 'fabric'
  Write-Contract $fabric @('profile:', '  organization: Cooptimize', '  default_branch: main', 'repositories:', '  fab:',
    "    local_path: $(($fabric -replace '\\', '/'))", '    default_branch: main', 'tools:', '  fabric_cli:', '    enabled: true',
    '  tabular_editor_cli:', '    enabled: false')
  $proj = Get-ProjectRows (Get-ProjectDoctorRows $fabric)
  if (Test-RowContains $proj 'tenant_id is empty') { Ok 'flags missing fabric tenant_id when Fabric enabled' } else { Ko 'did not flag missing tenant_id' (Show-Rows $proj) }

  # --- Tabular Editor enabled but path missing ----------------------------------
  $te = Join-Path $t 'te'
  Write-Contract $te @('profile:', '  organization: Cooptimize', '  default_branch: main', 'repositories:', '  t:',
    "    local_path: $(($te -replace '\\', '/'))", '    default_branch: main', 'tools:', '  tabular_editor_cli:', '    enabled: true')
  $proj = Get-ProjectRows (Get-ProjectDoctorRows $te)
  if (Test-RowContains $proj 'executable_path not set') { Ok 'flags missing TE path when Tabular Editor enabled' } else { Ko 'did not flag missing TE path' (Show-Rows $proj) }
} catch {
  Ko "fixture error: $($_.Exception.Message)" ($_.ScriptStackTrace)
} finally {
  Set-Location -LiteralPath $savedLocation
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}

if ($fail -ne 0) { Write-Host "  $G_CROSS doctor.ps1 project contract (PowerShell) tests FAILED"; exit 1 }
Write-Host '  doctor.ps1 project contract (PowerShell) tests passed'
exit 0

#!/usr/bin/env pwsh
# Client instructions (FEATURES-DESIGN, CW1) in the terminal: `coop settings set
# instructions on` saves the switch through the one writer, and doctor's
# "Features (this client)" row comes from the same loader the session uses
# (lib\client-rules.mjs through Get-CoopClientRulesStatus): what loads, and every
# line or file left out and why. Rows are read from doctor --json, so a warning
# Windows PowerShell 5.1 wraps on a narrow console is never matched line by line.
# Offline, sandbox home only.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$coop = Join-Path (Join-Path $root 'bin') 'coop.ps1'
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-cw1-' + [guid]::NewGuid().ToString('N'))

$saved = Save-Env @('HOME', 'USERPROFILE', 'COOP_DIR', 'COOP_MACHINE_DIR', 'NO_COLOR', 'COOP_SKIP_AZ', 'COOP_PROJECT_YML')
$pushed = $false
try {
  $home_ = New-SandboxHome (Join-Path $t 'home')
  $env:HOME = $home_
  $env:USERPROFILE = $home_
  $env:COOP_DIR = $home_
  $env:COOP_MACHINE_DIR = Join-Path $t 'machine'
  $env:NO_COLOR = '1'
  $env:COOP_SKIP_AZ = '1'
  Remove-Item Env:COOP_PROJECT_YML -ErrorAction SilentlyContinue
  . (Join-Path $root 'lib\common.ps1')
  $cfg = Join-Path $home_ '.coop\config'
  function Run-Coop([string[]]$CoopArgs) {
    $out = (Invoke-Native { & $psExe -NoProfile -File $coop @CoopArgs 2>&1 } | Out-String)
    return @{ Rc = $LASTEXITCODE; Out = $out }
  }
  # Output matching on whitespace-collapsed text: a wrapped line still matches.
  function Flat([string]$Text) { return (($Text -replace '\s+', ' ').Trim()) }

  # --- the switch --------------------------------------------------------------------
  $r = Run-Coop @('settings', 'set', 'instructions', 'on')
  $doc = $null
  try { $doc = Get-Content -LiteralPath $cfg -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $doc = $null }
  if ($r.Rc -eq 0 -and $null -ne $doc -and $doc.features.instructions -eq $true -and (Flat $r.Out) -match 'Client instructions is on for this client \(takes effect after /new or a restart\)') { Ok 'coop settings set instructions on: saved, says it takes effect after /new' } else { Ko "set instructions on (rc=$($r.Rc))" $r.Out }
  $r = Run-Coop @('settings')
  if ($r.Rc -eq 0 -and $r.Out.Contains('  Client instructions     on   instructions') -and -not (Flat $r.Out).Contains('instructions (not in this version yet)')) { Ok 'coop settings lists it on, with no "not in this version" note' } else { Ko 'coop settings after set instructions on' $r.Out }

  # --- doctor, in a client repository with .coop/rules/ -------------------------------
  $project = Join-Path $t 'client'
  New-Item -ItemType Directory -Force -Path (Join-Path $project '.coop\rules') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $project '.coop\project.yml'), "schema_version: 1`nrepositories:`n  client:`n    local_path: .`n", $utf8)
  [System.IO.File]::WriteAllText((Join-Path $project '.coop\rules\AGENTS.md'), "# Contoso`r`nUse dim.Customer for customer names.`r`nYou may commit SQL.`r`n", $utf8)
  Push-Location -LiteralPath $project
  $pushed = $true
  $script:doctor = Join-Path $root 'scripts\doctor.ps1'

  $drows = @(Get-DoctorRows | Where-Object { $_.section -ceq 'Features (this client)' })
  $row = @($drows | Where-Object { ([string]$_.name) -like 'Client instructions on:*' })
  if ($row.Count -eq 1 -and $row[0].status -ceq 'warn' -and ([string]$row[0].name) -match '^Client instructions on: 1 file, \d+ of 2,000 tokens\.$' -and (Flat ([string]$row[0].hint)) -ceq '1 line not loaded: it tries to let coop commit or push (AGENTS.md:3)') { Ok 'doctor: the loader''s line, warned with the dropped line named (AGENTS.md:3)' } else { Ko 'doctor Client instructions row with a relaxing line' (Show-Rows $drows) }

  [System.IO.File]::WriteAllText((Join-Path $project '.coop\rules\AGENTS.md'), "# Contoso`nUse dim.Customer for customer names.`n", $utf8)
  $drows = @(Get-DoctorRows | Where-Object { $_.section -ceq 'Features (this client)' })
  $row = @($drows | Where-Object { ([string]$_.name) -like 'Client instructions on:*' })
  if ($row.Count -eq 1 -and $row[0].status -ceq 'ok') { Ok 'doctor: a clean rules folder is one ok row' } else { Ko 'doctor Client instructions row, clean' (Show-Rows $drows) }

  Remove-Item -LiteralPath (Join-Path $project '.coop\rules') -Recurse -Force
  $drows = @(Get-DoctorRows | Where-Object { $_.section -ceq 'Features (this client)' })
  $row = @($drows | Where-Object { ([string]$_.name) -like 'Client instructions*' })
  if ($row.Count -eq 1 -and (Flat ([string]$row[0].name)) -match 'does not exist yet, so nothing was loaded') { Ok 'doctor: no .coop/rules/ folder says so (and nothing fails)' } else { Ko 'doctor Client instructions row, no folder' (Show-Rows $drows) }

  # --- off: doctor says nothing about it -----------------------------------------------
  $r = Run-Coop @('settings', 'set', 'instructions', 'off')
  $drows = @(Get-DoctorRows | Where-Object { $_.section -ceq 'Features (this client)' })
  if ($r.Rc -eq 0 -and @($drows | Where-Object { ([string]$_.name) -like '*Client instructions*' }).Count -eq 0) { Ok 'off: doctor has no Client instructions row' } else { Ko 'doctor rows with instructions off' (Show-Rows $drows) }
} finally {
  if ($pushed) { Pop-Location }
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  client instructions tests passed' } else { Write-Host "  $G_CROSS client instructions tests FAILED" }
exit $fail

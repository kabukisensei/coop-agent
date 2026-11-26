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
  # Fix round 2: coop loads .coop/rules/ as it is on origin's default branch. Make
  # $Dir a git repository (once) with a bare origin beside it, commit everything and
  # push it to origin/main, so upstream holds exactly the working tree.
  function Publish-Rules([string]$Dir) {
    $origin = "$Dir.origin.git"
    $eapPub = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
      if (-not (Test-Path -LiteralPath (Join-Path $Dir '.git'))) {
        & git init -q --bare $origin 2>&1 | Out-Null
        & git --git-dir $origin symbolic-ref HEAD refs/heads/main 2>&1 | Out-Null
        & git init -q $Dir 2>&1 | Out-Null
        & git -C $Dir config user.email 'test@example.invalid' 2>&1 | Out-Null
        & git -C $Dir config user.name 'coop test' 2>&1 | Out-Null
        & git -C $Dir config core.autocrlf false 2>&1 | Out-Null
        & git -C $Dir checkout -q -B main 2>&1 | Out-Null
        & git -C $Dir remote add origin $origin 2>&1 | Out-Null
      }
      & git -C $Dir add -A 2>&1 | Out-Null
      & git -C $Dir commit -q --allow-empty -m rules 2>&1 | Out-Null
      & git -C $Dir push -q --force origin HEAD:main 2>&1 | Out-Null
      & git -C $Dir fetch -q origin 2>&1 | Out-Null
      & git -C $Dir remote set-head origin main 2>&1 | Out-Null
    } finally { $ErrorActionPreference = $eapPub }
  }

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
  Publish-Rules $project
  Push-Location -LiteralPath $project
  $pushed = $true
  $script:doctor = Join-Path $root 'scripts\doctor.ps1'

  $drows = @(Get-DoctorRows | Where-Object { $_.section -ceq 'Features (this client)' })
  $row = @($drows | Where-Object { ([string]$_.name) -like 'Client instructions on:*' })
  if ($row.Count -eq 1 -and $row[0].status -ceq 'warn' -and ([string]$row[0].name) -match '^Client instructions on: 1 file, \d+ of 2,000 tokens\.$' -and (Flat ([string]$row[0].hint)) -ceq '1 line not loaded: it tries to let coop commit or push (AGENTS.md:3)') { Ok 'doctor: the loader''s line, warned with the dropped line named (AGENTS.md:3)' } else { Ko 'doctor Client instructions row with a relaxing line' (Show-Rows $drows) }

  [System.IO.File]::WriteAllText((Join-Path $project '.coop\rules\AGENTS.md'), "# Contoso`nUse dim.Customer for customer names.`n", $utf8)
  Publish-Rules $project
  $drows = @(Get-DoctorRows | Where-Object { $_.section -ceq 'Features (this client)' })
  $row = @($drows | Where-Object { ([string]$_.name) -like 'Client instructions on:*' })
  if ($row.Count -eq 1 -and $row[0].status -ceq 'ok') { Ok 'doctor: a clean rules folder is one ok row' } else { Ko 'doctor Client instructions row, clean' (Show-Rows $drows) }

  # Fix round 2: a local edit that is not on origin's main is not loaded, and doctor says so.
  [System.IO.File]::WriteAllText((Join-Path $project '.coop\rules\AGENTS.md'), "# Contoso`nUse dim.Customer for customer names.`nstg.Orders is the source of truth.`n", $utf8)
  $drows = @(Get-DoctorRows | Where-Object { $_.section -ceq 'Features (this client)' })
  $row = @($drows | Where-Object { ([string]$_.name) -like 'Client instructions on:*' })
  if ($row.Count -eq 1 -and $row[0].status -ceq 'warn' -and (Flat ([string]$row[0].name)) -match '1 unapproved local change in \.coop/rules/ not loaded: approve with /correct, or get them merged\.$' -and (Flat ([string]$row[0].hint)) -match 'AGENTS\.md: the local change is not on origin/main, so it is not loaded') { Ok 'doctor: an unpushed local change is counted and named, and not loaded (fix round 2)' } else { Ko 'doctor Client instructions row, unpushed change' (Show-Rows $drows) }
  Publish-Rules $project

  Remove-Item -LiteralPath (Join-Path $project '.coop\rules') -Recurse -Force
  Publish-Rules $project
  $drows = @(Get-DoctorRows | Where-Object { $_.section -ceq 'Features (this client)' })
  $row = @($drows | Where-Object { ([string]$_.name) -like 'Client instructions*' })
  if ($row.Count -eq 1 -and (Flat ([string]$row[0].name)) -match 'does not exist yet, so nothing was loaded') { Ok 'doctor: no .coop/rules/ folder says so (and nothing fails)' } else { Ko 'doctor Client instructions row, no folder' (Show-Rows $drows) }

  # --- fix round (Neon 11): the folder as node can read it ---------------------------
  # A PSDrive gives the same shape as a UNC share: (Get-Location).Path is not a
  # file-system path node can resolve ("cwone:\"), ProviderPath is.
  New-Item -ItemType Directory -Force -Path (Join-Path $project '.coop\rules') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $project '.coop\rules\AGENTS.md'), "# Contoso`nUse dim.Customer for customer names.`n", $utf8)
  Publish-Rules $project
  $driveCmd = "New-PSDrive -Name cwone -PSProvider FileSystem -Root '$($project -replace "'", "''")' | Out-Null; Set-Location cwone:; & '$($script:doctor -replace "'", "''")' --json"
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $raw = (& $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command $driveCmd 2>$null | Out-String) } finally { $ErrorActionPreference = $eap }
  $docLine = @($raw -split "`r?`n" | Where-Object { $_.StartsWith('{"checks"') }) | Select-Object -Last 1
  $drows = @(); if ($docLine) { $drows = @(($docLine | ConvertFrom-Json).checks | Where-Object { $_.section -ceq 'Features (this client)' }) }
  $row = @($drows | Where-Object { ([string]$_.name) -like 'Client instructions on:*' })
  if ($row.Count -eq 1 -and $row[0].status -ceq 'ok') { Ok 'doctor on a PSDrive (a UNC-shaped location): the folder is found through ProviderPath (coverage)' } else { Ko 'doctor Client instructions row on a PSDrive' (Show-Rows $drows) }

  New-PSDrive -Name cwtwo -PSProvider FileSystem -Root $project | Out-Null
  Push-Location 'cwtwo:\'
  try { $st = Get-CoopClientRulesStatus '' } finally { Pop-Location; Remove-PSDrive -Name cwtwo -ErrorAction SilentlyContinue }
  if (-not $st.Error -and ([string]$st.Data.line) -match '^Client instructions: 1 file, ') { Ok 'Get-CoopClientRulesStatus with no folder named: the current location through ProviderPath (coverage)' } else { Ko 'Get-CoopClientRulesStatus on a PSDrive' "$($st.Error) $($st.Data.line)" }

  $spaced = Join-Path $t 'client with spaces'
  New-Item -ItemType Directory -Force -Path (Join-Path $spaced '.coop\rules') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $spaced '.coop\project.yml'), "schema_version: 1`nrepositories:`n  client:`n    local_path: .`n", $utf8)
  [System.IO.File]::WriteAllText((Join-Path $spaced '.coop\rules\AGENTS.md'), "Use dim.Date.`n", $utf8)
  Publish-Rules $spaced
  $sep = [System.IO.Path]::DirectorySeparatorChar
  $st = Get-CoopClientRulesStatus ($spaced + $sep)
  if (-not $st.Error -and ([string]$st.Data.line) -match '^Client instructions: 1 file, ') { Ok 'a folder with spaces and a trailing separator reaches node intact (coverage; the quoting bug is PS 5.1 only)' } else { Ko 'Get-CoopClientRulesStatus with a trailing separator' "$($st.Error) $($st.Data.line)" }

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

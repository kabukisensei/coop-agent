#!/usr/bin/env pwsh
#
# coop PowerShell behavioral tests (twin of the PS-relevant assertions in tests/run.sh).
# Windows is coop's PRIMARY target, yet every behavioral test drove the BASH side only —
# the .ps1 dispatcher (coop.ps1) and update gate (update.ps1) had no executable safety
# net. This exercises the SAME seams tests/run.sh does, but through PowerShell:
#   1. coop.ps1 launch-spec resolves guardrails, prompts, theme, all 3 extensions
#   2. coop.ps1 --no-launch exits 0 + prints the spec; --no-launch --json emits {bin,args,env}
#   3. update.ps1 fleet-mode decisions via COOP_UPDATE_GATE_DRYRUN
#      (the same seams tests/update-guard.test.sh drives against update.sh)
#   4. update.ps1 --check is a dry-run that reports current/expected and exits 0
#   5. coop.ps1 forwards a single trailing --check argument intact to update.ps1
#   6. coop.ps1 review --help exits 0; an unknown review flag dies non-zero
#
# No network: the fleet-mode decision stops before any install via
# COOP_UPDATE_GATE_DRYRUN. Runs under Windows PowerShell 5.1
# (coop.cmd's runtime) and pwsh 7 (macOS/Linux CI). CI wires it into the windows +
# tests jobs; run locally with `pwsh -File tests/run.ps1`.
#
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$coop = Join-Path (Join-Path $root 'bin') 'coop.ps1'
$update = Join-Path (Join-Path $root 'scripts') 'update.ps1'

# Run the child gate/check invocations under the SAME PowerShell edition that runs
# this file — so under `shell: powershell` (coop.cmd's Windows PowerShell 5.1) the
# gate is exercised on 5.1, and under pwsh 7 (CI ubuntu / macOS) on pwsh. Falls back
# to 'pwsh' if the host path can't be resolved.
$psExe = try { (Get-Process -Id $PID).Path } catch { $null }
if (-not $psExe) { $psExe = 'pwsh' }

# Status glyphs via [char] codepoints (Windows PowerShell 5.1 compat, matching
# lib/common.ps1) — a BOM-less or mis-encoded literal glyph mojibakes on 5.1.
$G_CHECK = [char]0x2713   # ✓
$G_CROSS = [char]0x2717   # ✗
$G_ARROW = [char]0x2192   # →

$fail = 0
function Ok   { param([string]$m) Write-Host "  $G_CHECK $m" }
function Ko   { param([string]$m) Write-Host "  $G_CROSS $m"; $script:fail = 1 }
function Head { param([string]$m) Write-Host "$G_ARROW $m" }

# --- pi/npm stubs on a scratch PATH -----------------------------------------
# The gate + --check need a `pi` (reporting 0.80.2) and an `npm` that Get-Command
# resolves. Windows PowerShell 5.1 finds a stub only via a PATHEXT extension
# (.cmd), so write BOTH an extension-less Unix executable and a .cmd wrapper.
$stub = Join-Path ([System.IO.Path]::GetTempPath()) ("coop-ps-test-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $stub -Force | Out-Null
try {
  # Unix executables (extension-less, +x) — resolved by Get-Command on macOS/Linux.
  $piSh = "#!/bin/sh`n[ `"`$1`" = `"--version`" ] && { echo `"pi 0.84.3`"; exit 0; }`nexit 0`n"
  [System.IO.File]::WriteAllText((Join-Path $stub 'pi'),  $piSh)
  [System.IO.File]::WriteAllText((Join-Path $stub 'npm'), "#!/bin/sh`nexit 0`n")
  if ($IsLinux -or $IsMacOS) { & chmod +x (Join-Path $stub 'pi') (Join-Path $stub 'npm') }
  # Windows .cmd wrappers — resolved by Get-Command on Windows PowerShell 5.1.
  [System.IO.File]::WriteAllText((Join-Path $stub 'pi.cmd'),  "@echo off`r`nif `"%1`"==`"--version`" (echo pi 0.80.2& exit /b 0)`r`nexit /b 0`r`n")
  [System.IO.File]::WriteAllText((Join-Path $stub 'npm.cmd'), "@echo off`r`nexit /b 0`r`n")

  $sep = [System.IO.Path]::PathSeparator
  $stubPath = "$stub$sep$($env:PATH)"
  # The launch preflight can repair an extension tree. Point every writable
  # Coop/Pi location at this fixture and make the fake Pi authoritative so this
  # behavioral suite never inspects or changes the developer's real ~/.coop.
  $priorPath = $env:PATH
  $priorCoopDir = $env:COOP_DIR
  $priorCoopAgentDir = $env:COOP_AGENT_DIR
  $priorPiAgentDir = $env:PI_CODING_AGENT_DIR
  $priorNoOnboard = $env:COOP_NO_ONBOARD
  $env:PATH = $stubPath
  $env:COOP_DIR = Join-Path $stub 'coop-dir'
  $env:COOP_AGENT_DIR = Join-Path $stub 'agent'
  $env:PI_CODING_AGENT_DIR = $env:COOP_AGENT_DIR
  $env:COOP_NO_ONBOARD = '1'

  # --- 1. launch-spec resolves the governed pi invocation --------------------
  Head 'launch-spec (shared launch builder) test'
  # Join-Path emits native separators, so on Windows PowerShell 5.1 the spec paths
  # are backslash-delimited (docs\guardrails.md); the forward-slash needles below
  # would never match. Normalize '\' -> '/' so the check is separator-agnostic.
  $spec = (& $coop launch-spec 2>&1 | Out-String) -replace '\\', '/'
  $miss = $false
  foreach ($needle in @('docs/guardrails.md', '--prompt-template', 'themes/cooptimize.json',
                        'extensions/coop-powerline', 'extensions/coop-tools', 'extensions/coop-guardrails', 'extensions/coop-profile')) {
    if ($spec -notlike "*$needle*") { Ko "launch-spec missing: $needle"; $miss = $true }
  }
  if (-not $miss) { Ok 'launch-spec resolves guardrails, prompts, theme, and all 4 extensions' }

  # --- 2. --no-launch is a dry-run: exits 0, prints the spec -----------------
  Head '--no-launch dry-run (must NOT start pi; prints the spec)'
  $nlOut = (& $coop --no-launch 2>&1 | Out-String) -replace '\\', '/'
  if ($LASTEXITCODE -eq 0) { Ok '--no-launch exits 0' } else { Ko "--no-launch exited $LASTEXITCODE (expected 0)" }
  if ($nlOut -like '*docs/guardrails.md*') { Ok '--no-launch prints the launch spec' } else { Ko '--no-launch did not print the spec (no docs/guardrails.md)' }
  $jsonOut = & $coop --no-launch --json 2>&1 | Out-String
  if (($jsonOut -like '*"bin"*') -and ($jsonOut -like '*"args"*') -and ($jsonOut -like '*"env"*')) {
    Ok '--no-launch --json emits {bin,args,env}'
  } else { Ko '--no-launch --json did not emit the JSON spec' }

  # --- 3. context-budget via PowerShell dispatcher ---------------------------
  Head 'coop context-budget (PowerShell dispatch)'
  $pythonAvailable = (Get-Command python3 -ErrorAction SilentlyContinue) -or (Get-Command python -ErrorAction SilentlyContinue)
  if (-not $pythonAvailable) {
    Ok 'python not available on this runner; skipping context-budget PowerShell tests'
  } else {
    $cbOut = & $coop context-budget 2>&1 | Out-String
    if ($cbOut -like '*COOP context budget*') { Ok 'context-budget prints the human header' } else { Ko 'context-budget missing human header' }
    if ($cbOut -like '*Estimated fixed total*') { Ok 'context-budget reports the estimated fixed total' } else { Ko 'context-budget missing estimated fixed total' }
    if ($cbOut -like '*On-demand inventory*') { Ok 'context-budget lists on-demand inventory separately' } else { Ko 'context-budget missing on-demand inventory section' }
    $cbJsonOut = & $coop context-budget --json 2>&1 | Out-String
    try {
      $cbData = $cbJsonOut | ConvertFrom-Json
      if ($cbData.schema_version -eq 1) { Ok 'context-budget --json schema_version is 1' } else { Ko 'context-budget --json schema_version unexpected' }
      if ($cbData.estimated_fixed_total_tokens -gt 0) { Ok 'context-budget --json fixed total is positive' } else { Ko 'context-budget --json fixed total not positive' }
      $prompts = $cbData.categories.on_demand_inventory.prompts
      if ($prompts.chars -gt 0) { Ok 'context-budget --json reports on-demand prompt inventory' } else { Ko 'context-budget --json missing prompt inventory' }
    } catch {
      Ko "context-budget --json did not parse as JSON: $_"
    }
    $cbCheck = Join-Path $root 'scripts\check-context-budget.ps1'
    & $cbCheck
    if ($LASTEXITCODE -eq 0) { Ok 'check-context-budget.ps1 gate passes' } else { Ko 'check-context-budget.ps1 gate failed' }
  }

  # --- 4. update fleet-mode decisions (COOP_UPDATE_GATE_DRYRUN stops before install) -
  # Normal mode pins to the release manifest ('GATE pin:<v>'); --edge takes latest
  # ('GATE all'); --pi-latest is a deprecated alias for --edge.
  Head 'coop update fleet-mode decision (COOP_UPDATE_GATE_DRYRUN)'
  function Invoke-Gate {
    param([string[]]$GateArgs = @())
    $out = & $psExe -NoProfile -Command @"
`$env:PATH = '$stubPath'
`$env:COOP_UPDATE_GATE_DRYRUN = '1'
& '$update' $($GateArgs -join ' ') 2>`$null
"@ 6>$null
    # The gate line is the last emitted 'GATE …' line.
    return (($out | Where-Object { $_ -match 'GATE' }) | Select-Object -Last 1)
  }
  $d = Invoke-Gate
  if ($d -eq 'GATE pin:0.80.2') { Ok 'normal mode pins Pi to the release manifest' } else { Ko "expected 'GATE pin:0.80.2', got '$d'" }
  $d = Invoke-Gate -GateArgs @('--edge')
  if ($d -eq 'GATE all') { Ok '--edge is the only latest/upstream mode' } else { Ko "with --edge expected 'GATE all', got '$d'" }
  $d = Invoke-Gate -GateArgs @('--pi-latest')
  if ($d -eq 'GATE all') { Ok '--pi-latest is a deprecated alias for --edge' } else { Ko "with --pi-latest expected 'GATE all', got '$d'" }

  # --- 4. update --check is a dry-run: reports versions, exits 0 -------------
  Head 'coop update --check (dry-run — reports current/expected)'
  $checkOut = & $psExe -NoProfile -Command @"
`$env:PATH = '$stubPath'
& '$update' --check 2>`$null
"@ 6>$null | Out-String
  if ($LASTEXITCODE -eq 0) { Ok '--check exits 0' } else { Ko "--check exit was $LASTEXITCODE" }
  if ($checkOut -like '*expected 0.80.2*') { Ok '--check prints the pi expected version' } else { Ko '--check missing pi expected version' }
  if ($checkOut -like '*status *') { Ok '--check prints a status column' } else { Ko '--check missing status column' }
  if ($checkOut -like '*@microsoft/powerbi-report-authoring-cli*') { Ok '--check lists npm authoring tools' } else { Ko '--check missing npm authoring tools' }

  # --- 5. dispatcher preserves one trailing argument -------------------------
  # COOP_UPDATE_GATE_DRYRUN is a safety net: before the fix, coop.ps1 split the
  # scalar '--check' into six characters and update.ps1 entered its mutating path.
  # The gate seam stops that broken path before any install while this test asserts
  # that the real --check dry-run was reached through the public wrapper.
  Head 'coop update --check wrapper forwarding (single trailing argument)'
  $wrappedCheckOut = & $psExe -NoProfile -Command @"
`$env:PATH = '$stubPath'
`$env:COOP_UPDATE_GATE_DRYRUN = '1'
& '$coop' update --check 2>&1
"@ 6>$null | Out-String
  if (($wrappedCheckOut -like '*expected 0.80.2*') -and ($wrappedCheckOut -like '*status *')) {
    Ok 'coop wrapper forwards --check intact to the read-only path'
  } else { Ko "coop wrapper did not reach the --check dry-run: $wrappedCheckOut" }
  if ($wrappedCheckOut -notlike '*ignoring unknown flag*' -and $wrappedCheckOut -notlike '*GATE *') {
    Ok 'coop wrapper does not split --check or enter the update gate'
  } else { Ko 'coop wrapper split --check or entered the mutating update path' }

  # --- 6. review --help exits 0; an unknown review flag dies -----------------
  Head 'coop review arg parsing (--help ok; unknown flag dies)'
  & $coop review --help *> $null
  if ($LASTEXITCODE -eq 0) { Ok 'review --help exits 0' } else { Ko "review --help exit was $LASTEXITCODE" }
  & $coop review --bogus-flag *> $null
  if ($LASTEXITCODE -ne 0) { Ok 'review with an unknown flag dies non-zero' } else { Ko 'review --bogus-flag did not die' }

  # --- 7. pipx launcher ownership (Windows .exe metadata fallback) ----------
  Head 'pipx executable ownership'
  $ownerOut = & $psExe -NoProfile -File (Join-Path $root 'tests\fixtures\pipx-ownership.test.ps1') 2>&1
  if ($LASTEXITCODE -eq 0) {
    $ownerOut | ForEach-Object { Write-Host $_ }
  } else {
    Ko "pipx ownership fixture failed: $($ownerOut | Out-String)"
  }

  # --- 8. release transaction ------------------------------------------------
  Head 'release transaction consistency'
  # Coop status output intentionally uses stderr. Windows PowerShell 5.1 turns
  # redirected native stderr into NativeCommandError records; with this suite's
  # ErrorActionPreference=Stop that would abort despite a zero child exit.
  $oldErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $releaseOut = & $psExe -NoProfile -File (Join-Path $root 'tests\fixtures\release.test.ps1') 2>&1
  $releaseRc = $LASTEXITCODE
  $ErrorActionPreference = $oldErrorAction
  if ($releaseRc -eq 0) {
    $releaseOut | ForEach-Object { Write-Host $_ }
  } else {
    Ko "release transaction fixture failed: $($releaseOut | Out-String)"
  }
}
finally {
  $env:PATH = $priorPath
  if ($null -eq $priorCoopDir) { Remove-Item Env:\COOP_DIR -ErrorAction SilentlyContinue } else { $env:COOP_DIR = $priorCoopDir }
  if ($null -eq $priorCoopAgentDir) { Remove-Item Env:\COOP_AGENT_DIR -ErrorAction SilentlyContinue } else { $env:COOP_AGENT_DIR = $priorCoopAgentDir }
  if ($null -eq $priorPiAgentDir) { Remove-Item Env:\PI_CODING_AGENT_DIR -ErrorAction SilentlyContinue } else { $env:PI_CODING_AGENT_DIR = $priorPiAgentDir }
  if ($null -eq $priorNoOnboard) { Remove-Item Env:\COOP_NO_ONBOARD -ErrorAction SilentlyContinue } else { $env:COOP_NO_ONBOARD = $priorNoOnboard }
  Remove-Item -LiteralPath $stub -Recurse -Force -ErrorAction SilentlyContinue
}

if ($fail -ne 0) { Write-Host "$G_CROSS PowerShell behavioral tests FAILED"; exit 1 }
Write-Host "$G_CHECK PowerShell behavioral tests passed"

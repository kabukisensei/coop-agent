#!/usr/bin/env pwsh
#
# coop PowerShell behavioral tests (twin of the PS-relevant assertions in tests/run.sh).
# Windows is coop's PRIMARY target, yet every behavioral test drove the BASH side only —
# the .ps1 dispatcher (coop.ps1) and update gate (update.ps1) had no executable safety
# net. This exercises the SAME seams tests/run.sh does, but through PowerShell:
#   1. coop.ps1 launch-spec resolves guardrails, prompts, theme, all 3 extensions
#   2. coop.ps1 --no-launch exits 0 + prints the spec; --no-launch --json emits {bin,args,env}
#   3. update.ps1 gate decisions via COOP_UPDATE_GATE_DRYRUN / COOP_PI_LATEST_OVERRIDE
#      (the same seams tests/update-guard.test.sh drives against update.sh)
#   4. update.ps1 --check is a dry-run that reports current/latest/tested and exits 0
#   5. coop.ps1 review --help exits 0; an unknown review flag dies non-zero
#
# No network: the registry query is mocked with COOP_PI_LATEST_OVERRIDE, and the gate
# stops before any install via COOP_UPDATE_GATE_DRYRUN. Runs under Windows PowerShell 5.1
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
  $piSh = "#!/bin/sh`n[ `"`$1`" = `"--version`" ] && { echo `"pi 0.80.2`"; exit 0; }`nexit 0`n"
  [System.IO.File]::WriteAllText((Join-Path $stub 'pi'),  $piSh)
  [System.IO.File]::WriteAllText((Join-Path $stub 'npm'), "#!/bin/sh`nexit 0`n")
  if ($IsLinux -or $IsMacOS) { & chmod +x (Join-Path $stub 'pi') (Join-Path $stub 'npm') }
  # Windows .cmd wrappers — resolved by Get-Command on Windows PowerShell 5.1.
  [System.IO.File]::WriteAllText((Join-Path $stub 'pi.cmd'),  "@echo off`r`nif `"%1`"==`"--version`" (echo pi 0.80.2& exit /b 0)`r`nexit /b 0`r`n")
  [System.IO.File]::WriteAllText((Join-Path $stub 'npm.cmd'), "@echo off`r`nexit /b 0`r`n")

  $sep = [System.IO.Path]::PathSeparator
  $stubPath = "$stub$sep$($env:PATH)"

  # --- 1. launch-spec resolves the governed pi invocation --------------------
  Head 'launch-spec (shared launch builder) test'
  $spec = & $coop launch-spec 2>&1 | Out-String
  $miss = $false
  foreach ($needle in @('docs/guardrails.md', '--prompt-template', 'themes/cooptimize.json',
                        'extensions/coop-powerline', 'extensions/coop-tools', 'extensions/coop-guardrails')) {
    if ($spec -notlike "*$needle*") { Ko "launch-spec missing: $needle"; $miss = $true }
  }
  if (-not $miss) { Ok 'launch-spec resolves guardrails, prompts, theme, and all 3 extensions' }

  # --- 2. --no-launch is a dry-run: exits 0, prints the spec -----------------
  Head '--no-launch dry-run (must NOT start pi; prints the spec)'
  $nlOut = & $coop --no-launch 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0) { Ok '--no-launch exits 0' } else { Ko "--no-launch exited $LASTEXITCODE (expected 0)" }
  if ($nlOut -like '*docs/guardrails.md*') { Ok '--no-launch prints the launch spec' } else { Ko '--no-launch did not print the spec (no docs/guardrails.md)' }
  $jsonOut = & $coop --no-launch --json 2>&1 | Out-String
  if (($jsonOut -like '*"bin"*') -and ($jsonOut -like '*"args"*') -and ($jsonOut -like '*"env"*')) {
    Ok '--no-launch --json emits {bin,args,env}'
  } else { Ko '--no-launch --json did not emit the JSON spec' }

  # --- 3. update gate decisions (COOP_UPDATE_GATE_DRYRUN stops before install) -
  # Run each case in a child pwsh with the scratch PATH + a mocked latest, stdin
  # redirected (a non-interactive shell declines the untested-Pi jump). The child
  # prints exactly 'GATE pin:<v>' or 'GATE all' on the last line.
  Head 'coop update gate decision (COOP_PI_LATEST_OVERRIDE / COOP_UPDATE_GATE_DRYRUN)'
  function Invoke-Gate {
    param([string]$Latest, [string]$Yes, [string[]]$GateArgs = @())
    $out = & $psExe -NoProfile -Command @"
`$env:PATH = '$stubPath'
`$env:COOP_UPDATE_GATE_DRYRUN = '1'
`$env:COOP_PI_LATEST_OVERRIDE = '$Latest'
`$env:COOP_ASSUME_YES = '$Yes'
& '$update' $($GateArgs -join ' ') 2>`$null
"@ 6>$null
    # The gate line is the last emitted 'GATE …' line.
    return (($out | Where-Object { $_ -match 'GATE' }) | Select-Object -Last 1)
  }
  $d = Invoke-Gate -Latest '0.99.0'
  if ($d -eq 'GATE pin:0.80.2') { Ok 'crossing the tested minor + declined -> pins to tested' } else { Ko "expected 'GATE pin:0.80.2', got '$d'" }
  $d = Invoke-Gate -Latest '0.99.0' -Yes '1'
  if ($d -eq 'GATE all') { Ok '--yes / COOP_ASSUME_YES bypasses the gate (takes latest)' } else { Ko "with --yes expected 'GATE all', got '$d'" }
  $d = Invoke-Gate -Latest '0.99.0' -GateArgs @('--pi-latest')
  if ($d -eq 'GATE all') { Ok '--pi-latest bypasses the gate (takes latest)' } else { Ko "with --pi-latest expected 'GATE all', got '$d'" }
  $d = Invoke-Gate -Latest '0.80.5'
  if ($d -eq 'GATE all') { Ok 'a newer PATCH (same minor) is NOT gated' } else { Ko "0.80.5 should not gate, got '$d'" }

  # --- 4. update --check is a dry-run: reports versions, exits 0 -------------
  Head 'coop update --check (dry-run — reports current/latest/tested)'
  $checkOut = & $psExe -NoProfile -Command @"
`$env:PATH = '$stubPath'
`$env:COOP_PI_LATEST_OVERRIDE = '0.99.0'
& '$update' --check 2>`$null
"@ 6>$null | Out-String
  if ($LASTEXITCODE -eq 0) { Ok '--check exits 0' } else { Ko "--check exit was $LASTEXITCODE" }
  if ($checkOut -like '*tested 0.80.2*') { Ok '--check prints the pi tested version' } else { Ko '--check missing pi tested version' }
  if ($checkOut -like '*latest 0.99.0*') { Ok '--check prints the (mocked) latest' } else { Ko '--check missing latest' }

  # --- 5. review --help exits 0; an unknown review flag dies -----------------
  Head 'coop review arg parsing (--help ok; unknown flag dies)'
  & $coop review --help *> $null
  if ($LASTEXITCODE -eq 0) { Ok 'review --help exits 0' } else { Ko "review --help exit was $LASTEXITCODE" }
  & $coop review --bogus-flag *> $null
  if ($LASTEXITCODE -ne 0) { Ok 'review with an unknown flag dies non-zero' } else { Ko 'review --bogus-flag did not die' }
}
finally {
  Remove-Item -LiteralPath $stub -Recurse -Force -ErrorAction SilentlyContinue
}

if ($fail -ne 0) { Write-Host "$G_CROSS PowerShell behavioral tests FAILED"; exit 1 }
Write-Host "$G_CHECK PowerShell behavioral tests passed"

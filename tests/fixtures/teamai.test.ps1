#!/usr/bin/env pwsh
# K1 (master plan Phase 7): `coop teamai` is the only entry to the isolated TeamAI
# adapter (lib/teamai.py). Off by default: with no knowledge.teamai block the
# status document says `disabled` and nothing is created under the profile.
# Offline; a temp COOP_DIR only; the real teamai-cli is never installed.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$coop = Join-Path $root 'bin\coop.ps1'
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-teamai-' + [guid]::NewGuid().ToString('N'))

$saved = Save-Env @('COOP_DIR', 'HOME', 'USERPROFILE', 'COOP_SKIP_AZ', 'TEAMAI_API_TOKEN')
try {
  $cdir = Join-Path $t 'cdir'
  New-Item -ItemType Directory -Force -Path (Join-Path $cdir '.coop'), (Join-Path $t 'home') | Out-Null
  $env:COOP_DIR = $cdir
  $env:HOME = Join-Path $t 'home'
  $env:USERPROFILE = $env:HOME
  $env:COOP_SKIP_AZ = '1'
  [System.IO.File]::WriteAllText((Join-Path $cdir '.coop\config'), '{"schema_version":1,"knowledge":{"enabled":false,"repos":[]}}')

  # --- status: disabled, one JSON document, exit 0 ----------------------------
  $out = Invoke-Native { & $coop teamai status 2>$null }
  $rc = $LASTEXITCODE
  $doc = $null
  try { $doc = ([string]($out | Out-String)) | ConvertFrom-Json } catch { $doc = $null }
  if ($rc -eq 0 -and $doc -and $doc.state -eq 'disabled' -and $doc.enabled -eq $false) { Ok 'coop teamai status: no knowledge.teamai block -> {state: disabled}, exit 0' } else { Ko 'coop teamai status must report disabled with exit 0' ([string]($out | Out-String)) }
  if ($doc -and $doc.command -eq 'status' -and $doc.schema_version -eq 1) { Ok 'status document carries command and schema_version' } else { Ko 'status document shape' }
  if ($doc -and $doc.roots.home -like (Join-Path (Join-Path $cdir '.coop') 'teamai*')) { Ok 'roots resolve under <profile dir>\teamai' } else { Ko "roots must resolve under the profile dir (got '$($doc.roots.home)')" }
  if (-not (Test-Path -LiteralPath (Join-Path $cdir '.coop\teamai'))) { Ok 'disabled: nothing created under the profile' } else { Ko 'disabled status must not create <profile>\teamai' }

  # --- recall while disabled: empty results, exit 0 ----------------------------
  $out = Invoke-Native { & $coop teamai recall --query 'watermark' 2>$null }
  $rc = $LASTEXITCODE
  $doc = $null
  try { $doc = ([string]($out | Out-String)) | ConvertFrom-Json } catch { $doc = $null }
  if ($rc -eq 0 -and $doc -and $doc.state -eq 'disabled' -and @($doc.results).Count -eq 0) { Ok 'coop teamai recall --query: disabled -> no results, exit 0' } else { Ko 'disabled recall must return an empty document with exit 0' ([string]($out | Out-String)) }

  # --- usage (status lines go through [Console]::Error: capture a child's stderr) ---
  $psExe = (Get-Process -Id $PID).Path
  $so = Join-Path $t 'usage.out'; $se = Join-Path $t 'usage.err'; $si = Join-Path $t 'usage.in'
  [System.IO.File]::WriteAllText($si, '')
  $p = Start-Process -FilePath $psExe -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $coop + '"'), 'teamai') -WorkingDirectory $t `
    -PassThru -NoNewWindow -RedirectStandardInput $si -RedirectStandardOutput $so -RedirectStandardError $se
  $null = $p.Handle
  $p.WaitForExit()
  $usage = [System.IO.File]::ReadAllText($so) + [System.IO.File]::ReadAllText($se)
  if ($p.ExitCode -ne 0 -and $usage.Contains('usage: coop teamai')) { Ok 'coop teamai (no command) -> usage, non-zero exit' } else { Ko "coop teamai without a command must print usage and fail (rc=$($p.ExitCode))" $usage }

  # --- help lists the command -------------------------------------------------
  $help = [string]((Invoke-Native { & $coop help *>&1 }) | Out-String)
  if ($help -match 'coop teamai <cmd>') { Ok 'coop help lists coop teamai' } else { Ko 'coop help must list coop teamai' }

  # --- launch never touches TeamAI: no adapter call in the launch path ---------
  $launcher = [System.IO.File]::ReadAllText($coop)
  $launchFn = [regex]::Match($launcher, 'function Invoke-LaunchPi[\s\S]*?\n}\r?\n').Value
  if ($launchFn -and -not ($launchFn -match 'teamai')) { Ok 'Invoke-LaunchPi never calls the TeamAI adapter' } else { Ko 'the launch path must not reference teamai' }
}
finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  teamai tests passed' } else { Write-Host "  $G_CROSS teamai tests FAILED" }
exit $fail

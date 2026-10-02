#!/usr/bin/env pwsh
# Coop-Unit (lib/common.ps1): the install/update item runner. On Windows
# PowerShell 5.1 the first process job of a fresh profile fails with "The
# Persistence Path does not exist" (%LOCALAPPDATA%\Microsoft\Windows\PowerShell
# missing) and returns nothing — the `! pipx` unit with no message on every
# sandboxed install, v0.23.5 to v0.29.0. Start-CoopJob creates that path first.
# A job that still comes back with NOTHING is run once more in-process and THAT
# result is reported; when the unit returns nothing both ways, the warning names
# the step and the reason. Offline, no sleep, no real home.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-unit-' + [guid]::NewGuid().ToString('N'))
# Coop-Emit writes through [Console]::Error; capture it the way update-follow does.
function Invoke-Captured([scriptblock]$Body) {
  $writer = New-Object System.IO.StringWriter
  $previous = [Console]::Error
  try { [Console]::SetError($writer); & $Body } finally { [Console]::SetError($previous) }
  return $writer.ToString()
}

$saved = Save-Env @('HOME', 'USERPROFILE', 'LOCALAPPDATA', 'COOP_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'NO_COLOR')
try {
  New-Item -ItemType Directory -Force -Path $t, (Join-Path $t 'home') | Out-Null
  $env:HOME = Join-Path $t 'home'
  $env:USERPROFILE = $env:HOME
  $env:COOP_AGENT_DIR = Join-Path $t 'agent'
  $env:PI_CODING_AGENT_DIR = $env:COOP_AGENT_DIR
  $env:NO_COLOR = '1'    # non-TTY emission: every ✓ / ! line goes through [Console]::Error
  . (Join-Path $root 'lib\common.ps1')

  # 1. The Windows PowerShell 5.1 job persistence path is created before the first
  #    process job (a fresh profile has none); unset LOCALAPPDATA is left alone.
  $env:LOCALAPPDATA = Join-Path $t 'local-app-data'
  $persist = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\PowerShell'
  Initialize-CoopJobPersistencePath
  $madeFresh = Test-Path -LiteralPath $persist -PathType Container
  Initialize-CoopJobPersistencePath   # idempotent
  $stillThere = Test-Path -LiteralPath $persist -PathType Container
  Remove-Item Env:LOCALAPPDATA -ErrorAction SilentlyContinue
  $unsetOk = $true
  try { Initialize-CoopJobPersistencePath } catch { $unsetOk = $false }
  if (-not $madeFresh) { Ko 'the 5.1 job persistence path must be created under a fresh LOCALAPPDATA' $persist }
  elseif (-not $stillThere) { Ko 'creating the persistence path twice must keep it' }
  elseif (-not $unsetOk) { Ko 'an unset LOCALAPPDATA must be a no-op' }
  else { Ok 'Start-CoopJob creates %LOCALAPPDATA%\Microsoft\Windows\PowerShell on a fresh profile (no-op when unset)' }
  $env:LOCALAPPDATA = Join-Path $t 'local-app-data'

  # 2. A unit that returns its result is reported as is (ok and not ok).
  $okUnit = { param($label) [pscustomobject]@{ ok = $true; msg = "$label present" } }
  $outOk = Invoke-Captured { Coop-Unit 'pipx' $okUnit @('pipx') }
  $lastOk = $script:CoopUnitLastOk
  $badUnit = { [pscustomobject]@{ ok = $false; msg = 'could not install pipx automatically' } }
  $outBad = Invoke-Captured { Coop-Unit 'pipx' $badUnit }
  $lastBad = $script:CoopUnitLastOk
  if (-not $lastOk -or -not $outOk.Contains('pipx present')) { Ko 'a unit returning ok=true is reported ok with its message' $outOk }
  elseif ($lastBad -or -not $outBad.Contains('could not install pipx automatically')) { Ko 'a unit returning ok=false is reported as a warning with its message' $outBad }
  else { Ok 'a unit''s own result is reported as is (ok and warning)' }

  # 3. The job returns nothing (it throws before its result) but the unit works
  #    in-process: the in-process result is reported, and the step is ok.
  $marker = Join-Path $t 'second-call'
  $flaky = {
    param($marker)
    if (Test-Path -LiteralPath $marker) { return [pscustomobject]@{ ok = $true; msg = 'pipx present (second call)' } }
    [System.IO.File]::WriteAllText($marker, 'first call failed')
    throw 'The Persistence Path does not exist'
  }
  $outFlaky = Invoke-Captured { Coop-Unit 'pipx' $flaky @($marker) }
  $lastFlaky = $script:CoopUnitLastOk
  if (-not (Test-Path -LiteralPath $marker)) { Ko 'fixture: the job must have run the unit once' $outFlaky }
  elseif (-not $lastFlaky -or -not $outFlaky.Contains('pipx present (second call)')) { Ko 'a job that returns nothing must be re-run in-process and its result reported' $outFlaky }
  elseif ($outFlaky.Contains('returned no result')) { Ko 'a job that returns nothing, with a unit that then works, must not be reported as no result' $outFlaky }
  else { Ok 'a job that returns nothing: the unit is re-run in-process and that result is reported (ok)' }

  # 4. Nothing both ways: the warning names the step and the reason, never a bare label.
  $dead = { throw 'unit exploded' }
  $outDead = Invoke-Captured { Coop-Unit 'pipx' $dead }
  $lastDead = $script:CoopUnitLastOk
  if ($lastDead) { Ko 'a unit that returns nothing both ways is a failed step' $outDead }
  elseif (-not $outDead.Contains('pipx (the step returned no result')) { Ko 'a unit that returns nothing both ways must say so, naming the step' $outDead }
  elseif (-not $outDead.Contains('unit exploded')) { Ko 'the warning must carry the reason' $outDead }
  else { Ok 'nothing both ways: "! pipx (the step returned no result: <reason>)", counted as a failure' }
} finally {
  Restore-Env $saved
  Remove-Item -Recurse -Force $t -ErrorAction SilentlyContinue
}
exit $fail

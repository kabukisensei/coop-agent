#!/usr/bin/env pwsh
#
# tests/fixtures/_common.ps1 — the one copy of the helpers coop's PowerShell
# fixtures share. Every fixture dot-sources it first:
#
#   . (Join-Path $PSScriptRoot '_common.ps1')
#
# Dot-sourcing runs this file in the fixture's own scope, so the variables and
# functions below land there (a fixture may still override one). Windows
# PowerShell 5.1 and pwsh 7 both run it; no module, no framework.
#
# Printers        Ok / Ko (the ✓ / ✗ lines tests/run.ps1 prints through; Ko sets
#                 $fail, which the fixture returns with `exit $fail`).
# Host facts      $psExe (this PowerShell, for child processes), $isWindowsHost,
#                 $utf8 (no BOM), $sep (PATH separator), $chmod (captured here,
#                 before a fixture restricts PATH).
# Environment     Save-Env / Restore-Env over a name list.
# Sandboxes       New-SandboxHome: a temp profile with the AppData folders
#                 Windows PowerShell 5.1 needs.
# Stubs           Write-Shim (a sh script + its .cmd twin on Windows),
#                 New-PyStub (one Python script behind a forwarder, exit code
#                 passed through), Get-FixturePython.
# doctor --json   Get-DoctorRows / Find-Rows / Find-Row / Show-Rows.
# git             Invoke-FixtureGit / Get-FixtureGit (fixture repos only).
# Native calls    Invoke-Native (5.1-safe stderr), Assert-SleeperGone.

$G_CHECK = [char]0x2713   # ✓
$G_CROSS = [char]0x2717   # ✗
$G_ARROW = [char]0x2192   # →
$fail = 0
function Ok([string]$m) { Write-Host "  $G_CHECK $m" }
function Ko([string]$m, [string]$Out = '') { Write-Host "  $G_CROSS $m"; if ($Out) { Write-Host $Out }; $script:fail = 1 }

# The PowerShell running this fixture, so children run under the same edition
# (Windows PowerShell 5.1 under coop.cmd's lane, pwsh 7 elsewhere).
$psExe = try { (Get-Process -Id $PID).Path } catch { $null }
if (-not $psExe) { $psExe = 'pwsh' }
$isWindowsHost = ($env:OS -eq 'Windows_NT')
$utf8 = New-Object System.Text.UTF8Encoding($false)
$sep = [System.IO.Path]::PathSeparator
# Captured BEFORE a fixture restricts PATH to its stub dir: later shims need it.
$chmod = if ($isWindowsHost) { '' } else { (Get-Command chmod -ErrorAction Stop).Source }

# --- environment -------------------------------------------------------------
# $saved = Save-Env @('PATH', 'HOME', ...)   ...   finally { Restore-Env $saved }
function Save-Env([string[]]$Names) {
  $h = @{}
  foreach ($n in $Names) { $h[$n] = [Environment]::GetEnvironmentVariable($n) }
  return $h
}
function Restore-Env([hashtable]$Saved) {
  foreach ($n in @($Saved.Keys)) { [Environment]::SetEnvironmentVariable($n, $Saved[$n]) }
}

# --- sandbox profile -----------------------------------------------------------
# A profile shape Windows PowerShell 5.1 needs: its known folders expand from
# USERPROFILE, and Receive-Job fails ("The Persistence Path does not exist")
# when AppData\Local is missing. Returns the path.
function New-SandboxHome([string]$Path) {
  foreach ($sub in @('', 'AppData\Local\Microsoft\Windows\PowerShell', 'AppData\Roaming')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Path $sub) | Out-Null
  }
  return $Path
}

# --- stubs ---------------------------------------------------------------------
# A command on a stub PATH: `#!/bin/sh` + $Sh in <Dir>/<Name> (+x off Windows) and,
# on Windows only, `@echo off` + $Cmd in <Name>.cmd (Get-Command resolves a stub
# through PATHEXT there; a .cmd on Linux/macOS would only mislead helpers that
# prefer npm.cmd). -Raw writes $Sh and $Cmd verbatim (whole files). $Dir defaults
# to the fixture's $bin.
function Write-Shim {
  param([string]$Name, [string]$Sh, [string]$Cmd, [string]$Dir = $script:bin, [switch]$Raw)
  $shText = if ($Raw) { $Sh } else { "#!/bin/sh`n$Sh`n" }
  $cmdText = if ($Raw) { $Cmd } else { "@echo off`r`n$Cmd`r`n" }
  [System.IO.File]::WriteAllText((Join-Path $Dir $Name), $shText)
  if ($isWindowsHost) { [System.IO.File]::WriteAllText((Join-Path $Dir ($Name + '.cmd')), $cmdText) }
  else { & $chmod +x (Join-Path $Dir $Name) }
}

# A Fabric-compatible (3.10-3.13) real Python, preferring a versioned one so a
# host whose python3 is 3.14 still qualifies; the Windows Store App-Execution-Alias
# stub under WindowsApps is not an interpreter. '' when none.
function Get-FixturePython {
  foreach ($n in @('python3.13', 'python3.12', 'python3', 'python')) {
    $c = Get-Command $n -ErrorAction SilentlyContinue
    if (-not $c -or -not $c.Source -or $c.Source -match '\\WindowsApps\\') { continue }
    return $c.Source
  }
  return ''
}

# A command backed by ONE Python script (<Name>.stub.py) behind a one-line
# forwarder: a .cmd on Windows (exit code passed through), a #!/bin/sh exec
# elsewhere, so a stub behaves identically on every platform. $Python defaults
# to the fixture's $realPy, else Get-FixturePython. Returns the forwarder path.
function New-PyStub([string]$Dir, [string]$Name, [string]$Source, [string]$Python = '') {
  if (-not $Python) { $Python = $script:realPy }
  if (-not $Python) { $Python = Get-FixturePython }
  if (-not $Python) { throw 'New-PyStub: no real Python found for the stub forwarder' }
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $py = Join-Path $Dir "$Name.stub.py"
  [System.IO.File]::WriteAllText($py, $Source, $utf8)
  if ($isWindowsHost) {
    $p = Join-Path $Dir "$Name.cmd"
    [System.IO.File]::WriteAllText($p, "@`"$Python`" `"$py`" %*`r`n@exit /b %ERRORLEVEL%`r`n", [System.Text.Encoding]::ASCII)
  } else {
    $p = Join-Path $Dir $Name
    [System.IO.File]::WriteAllText($p, "#!/bin/sh`nexec `"$Python`" `"$py`" `"`$@`"`n", $utf8)
    & $chmod +x $p
  }
  return $p
}

# --- doctor --json rows ----------------------------------------------------------
# Runs the fixture's $doctor (scripts/doctor.ps1) with --json plus $DoctorArgs in
# a child of this PowerShell and returns its `checks` rows; the exit code lands in
# $script:LastDoctorRc. The JSON document is the last stdout line starting with
# {"checks"; the human report is stderr (which Windows PowerShell 5.1 wraps).
function Get-DoctorRows([string[]]$DoctorArgs = @()) {
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $raw = (& $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $script:doctor --json @DoctorArgs 2>$null | Out-String)
    $script:LastDoctorRc = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $eap
  }
  $doc = @($raw -split "`r?`n" | Where-Object { $_.StartsWith('{"checks"') }) | Select-Object -Last 1
  if (-not $doc) { throw "doctor.ps1 --json printed no document: $raw" }
  return @(($doc | ConvertFrom-Json).checks)
}
# Rows whose name contains $Needle (-Hint: or whose hint does).
function Find-Rows($Rows, [string]$Needle, [switch]$Hint) {
  @($Rows | Where-Object { ([string]$_.name).Contains($Needle) -or ($Hint -and ([string]$_.hint).Contains($Needle)) })
}
function Find-Row($Rows, [string]$Needle) { Find-Rows $Rows $Needle | Select-Object -First 1 }
# "status | name | hint" lines for a diagnostic: every row, or those whose name,
# section or hint contains $Needle.
function Show-Rows($Rows, [string]$Needle = '') {
  $picked = if ($Needle) { @($Rows | Where-Object { ([string]$_.name).Contains($Needle) -or ([string]$_.section).Contains($Needle) -or ([string]$_.hint).Contains($Needle) }) } else { @($Rows) }
  return (@($picked | ForEach-Object { "$($_.status) | $($_.name) | $($_.hint)" }) -join "`n")
}

# --- fixture git ---------------------------------------------------------------
# Fixture git runs in its own Continue scope (the fixture keeps EAP=Stop) and
# throws on a real failure; Get-FixtureGit returns the first output line, '' on
# failure or no output.
function Invoke-FixtureGit {
  param([string[]]$GitArgs)
  $ErrorActionPreference = 'Continue'
  $o = @(& git @GitArgs 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "fixture git $($GitArgs -join ' ') failed: $($o | Out-String)" }
}
function Get-FixtureGit {
  param([string[]]$GitArgs)
  $ErrorActionPreference = 'Continue'
  $o = @(& git @GitArgs 2>$null)
  if ($LASTEXITCODE -ne 0 -or $o.Count -eq 0 -or $null -eq $o[0]) { return '' }
  return ([string]$o[0]).Trim()
}

# --- native commands ---------------------------------------------------------------
# Windows PowerShell 5.1 turns native stderr into terminating NativeCommandError
# records under $ErrorActionPreference='Stop', even with call-site 2>$null or
# 2>&1, when the fixture runs nested (powershell -File under a capturing parent,
# as tests/run.ps1 does; CI runs 34672102094 and 34673322072). Lower EAP for the
# native invocation only; $LASTEXITCODE is unaffected.
function Invoke-Native([Parameter(Mandatory=$true)][scriptblock]$Command) {
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Command } finally { $ErrorActionPreference = $prevEap }
}

# The fake git of the knowledge-sync fixtures records the PID of the sleeper it
# spawned in $sleeperFile and a spawn-time liveness line in $fakeLog; after a
# bounded kill, THAT process must be gone (and provably existed).
function Assert-SleeperGone([string]$label) {
  Start-Sleep -Seconds 2   # allow the killed tree to be reaped
  if (-not (Test-Path -LiteralPath $script:sleeperFile)) {
    Ko "${label}: fake git never spawned its sleeper"
    return
  }
  $sleeperPid = [int]((Get-Content -LiteralPath $script:sleeperFile) -join '')
  $proof = $false
  if (Test-Path -LiteralPath $script:fakeLog) {
    $proof = (Get-Content -LiteralPath $script:fakeLog -Raw) -match ("spawned-sleeper pid=" + $sleeperPid + "(?!\d)")
  }
  if (-not $proof) {
    Ko "${label}: no spawn-time existence proof for pid $sleeperPid (recorded value was not a real PID?)"
    Remove-Item -LiteralPath $script:sleeperFile -ErrorAction SilentlyContinue
    return
  }
  $alive = Get-Process -Id $sleeperPid -ErrorAction SilentlyContinue
  if ($alive) { Ko "${label}: sleeper $sleeperPid survived the deadline" }
  else { Ok "${label}: sleeper $sleeperPid provably existed and is gone" }
  Remove-Item -LiteralPath $script:sleeperFile -ErrorAction SilentlyContinue
}

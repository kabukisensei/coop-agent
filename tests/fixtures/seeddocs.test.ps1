#!/usr/bin/env pwsh
# PowerShell twin of tests/seeddocs.test.sh's config-set status checks (#102):
# `coop init --seed-docs` through bin/coop.ps1 against a stub coop-data-doc that
# prints config-set's status line (coop-data-doc 1.2.0 wording). The status is
# shown, and "saved, not runnable yet" is a warning, never discarded. The stub is
# an extension-less script on macOS/Linux and a .cmd on Windows; an npm stub keeps
# Add-CoopRuntimePaths from putting a real npm prefix (and a real coop-data-doc)
# first on PATH. Sandboxed HOME/USERPROFILE/COOP_DIR/agent dir, never ~/.coop.
# No waits. Assertions stay ASCII (Windows PowerShell 5.1 re-encodes child output)
# and ignore whitespace.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$coop = Join-Path (Join-Path $root 'bin') 'coop.ps1'
$psExe = try { (Get-Process -Id $PID).Path } catch { 'pwsh' }
$isWindowsHost = ($env:OS -eq 'Windows_NT')
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-seeddocs-ps-' + [guid]::NewGuid().ToString('N'))
$fail = 0
function Ok([string]$m) { Write-Host "  ok $m" }
function Ko([string]$m, [string]$out = '') { Write-Host "  x $m"; if ($out) { Write-Host $out }; $script:fail = 1 }

$bin = Join-Path $t 'bin'
$proj = Join-Path $t 'proj'
$sandboxHome = Join-Path $t 'home'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$saved = @{}
$names = @('PATH','HOME','USERPROFILE','COOP_DIR','COOP_AGENT_DIR','PI_CODING_AGENT_DIR','COOP_SKIP_AZ',
           'NO_COLOR','COOP_ASSUME_YES','SEED_STATUS')
foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
try {
  New-Item -ItemType Directory -Force -Path $bin, (Join-Path $proj '.coop'), (Join-Path $proj 'pbirepo'),
    (Join-Path $proj 'sqlrepo'), $sandboxHome, (Join-Path $t 'coop\.coop') | Out-Null
  $pbi = (Join-Path $proj 'pbirepo') -replace '\\', '/'
  $sql = (Join-Path $proj 'sqlrepo') -replace '\\', '/'
  [System.IO.File]::WriteAllText((Join-Path $proj '.coop\project.yml'), (@(
    'repositories:',
    '  fabric:',
    '    role: powerbi',
    "    local_path: '$pbi'",
    '  fabric_dw:',
    '    role: sql',
    "    local_path: '$sql'"
  ) -join "`n") + "`n", $utf8)

  if ($isWindowsHost) {
    # config-set --config <cfg> --from-json - : the config path is %~3.
    [System.IO.File]::WriteAllText((Join-Path $bin 'coop-data-doc.cmd'), (@(
      '@echo off',
      'more > nul',
      'if "%SEED_STATUS%"=="not-runnable" goto notrunnable',
      'echo Wrote %~3 (validated).',
      'exit /b 0',
      ':notrunnable',
      "echo Wrote %~3 (saved, not runnable yet (Repo 'powerbi' path does not exist: C:\nowhere\pbi-repo (configured in %~3))).",
      'exit /b 0'
    ) -join "`r`n") + "`r`n", [System.Text.Encoding]::ASCII)
    [System.IO.File]::WriteAllText((Join-Path $bin 'npm.cmd'), "@echo off`r`nif `"%1`"==`"--version`" (echo 10.0.0& exit /b 0)`r`nexit /b 0`r`n", [System.Text.Encoding]::ASCII)
  } else {
    [System.IO.File]::WriteAllText((Join-Path $bin 'coop-data-doc'), (@(
      '#!/bin/sh',
      'cat > /dev/null',
      'cfg=""; prev=""',
      'for a in "$@"; do [ "$prev" = "--config" ] && cfg="$a"; prev="$a"; done',
      'if [ "${SEED_STATUS:-validated}" = "not-runnable" ]; then',
      '  echo "Wrote $cfg (saved, not runnable yet (Repo ''powerbi'' path does not exist: /nowhere/pbi-repo (configured in $cfg)))."',
      'else',
      '  echo "Wrote $cfg (validated)."',
      'fi'
    ) -join "`n") + "`n", $utf8)
    [System.IO.File]::WriteAllText((Join-Path $bin 'npm'), "#!/bin/sh`n[ `"`$1`" = `"--version`" ] && echo 10.0.0`nexit 0`n", $utf8)
    & chmod +x (Join-Path $bin 'coop-data-doc') (Join-Path $bin 'npm')
  }

  $env:PATH = "$bin$([System.IO.Path]::PathSeparator)$($env:PATH)"
  $env:HOME = $sandboxHome
  $env:USERPROFILE = $sandboxHome
  $env:COOP_DIR = Join-Path $t 'coop'
  $env:COOP_AGENT_DIR = Join-Path $t 'agent'
  $env:PI_CODING_AGENT_DIR = $env:COOP_AGENT_DIR
  $env:COOP_SKIP_AZ = '1'
  $env:NO_COLOR = '1'
  $env:COOP_ASSUME_YES = '1'

  function Invoke-Seed([string]$Status) {
    $env:SEED_STATUS = $Status
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
      # [string] each record: Windows PowerShell 5.1 wraps native stderr lines in
      # ErrorRecords, and their default formatting adds noise and line wraps.
      $lines = @(& $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $coop init --seed-docs $proj 2>&1 | ForEach-Object { [string]$_ })
      $rc = $LASTEXITCODE
      $raw = $lines -join "`n"
    } finally { $ErrorActionPreference = $eap }
    return @{ Out = $raw; Flat = ($raw -replace '\s', ''); Rc = $rc }
  }

  $r = Invoke-Seed 'validated'
  if ($r.Rc -eq 0 -and $r.Flat.Contains('(validated).')) { Ok 'config-set status is shown' }
  else { Ko "seed-docs should show config-set's validated status (exit $($r.Rc))" $r.Out }

  $r = Invoke-Seed 'not-runnable'
  if ($r.Rc -ne 0) { Ko "a not-runnable seed still writes the config and exits 0 (got $($r.Rc))" $r.Out }
  elseif ($r.Flat.Contains('!Wrote') -and $r.Flat.Contains('notrunnableyet') -and $r.Flat.Contains('pbi-repo')) {
    Ok 'not-runnable status is a warning naming the repo path'
  } else { Ko 'the not-runnable status should be a warning naming the repo path' $r.Out }
} finally {
  foreach ($n in $names) {
    if ($null -eq $saved[$n]) { Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
  }
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -ne 0) { exit 1 }

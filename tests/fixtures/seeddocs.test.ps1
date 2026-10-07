#!/usr/bin/env pwsh
# End-to-end `coop init --seed-docs` (#25, #102) through bin/coop.ps1 against a
# stub coop-data-doc that records its arguments and the repos patch file and
# prints config-set's status line (coop-data-doc 1.2.0 wording). Checks: the patch
# reaches `config-set --config <dir>/coop-data-doc.yml --from-json <file>` as
# UTF-8 without a byte order mark (Windows PowerShell 5.1 pipes add one), the
# status is shown, "saved, not runnable yet" is a warning (never discarded), a
# non-interactive run without --yes declines and changes nothing, and a TODO-only
# contract exits non-zero without calling the tool. tests/seeddocs.test.sh runs
# this file after lib/_seeddocs.py's own cases (it carried these cases itself
# until master plan S1 retired the bash dispatcher). The stub is an extension-less
# script on macOS/Linux and a .cmd on Windows; an npm stub keeps
# Add-CoopRuntimePaths from putting a real npm prefix (and a real coop-data-doc)
# first on PATH. Sandboxed HOME/USERPROFILE/COOP_DIR/agent dir, never ~/.coop.
# No waits. Assertions stay ASCII (Windows PowerShell 5.1 re-encodes child output)
# and ignore whitespace.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$coop = Join-Path (Join-Path $root 'bin') 'coop.ps1'
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-seeddocs-ps-' + [guid]::NewGuid().ToString('N'))

$bin = Join-Path $t 'bin'
$proj = Join-Path $t 'proj'
$sandboxHome = Join-Path $t 'home'
$saved = Save-Env @('PATH','HOME','USERPROFILE','COOP_DIR','COOP_AGENT_DIR','PI_CODING_AGENT_DIR','COOP_SKIP_AZ',
                    'NO_COLOR','COOP_ASSUME_YES','SEED_STATUS','SEED_ARGS_LOG','SEED_STDIN')
$argsLog = Join-Path $t 'dd-args.log'
$stdinFile = Join-Path $t 'dd-stdin.json'
try {
  $empty = Join-Path $t 'empty'
  New-Item -ItemType Directory -Force -Path $bin, (Join-Path $proj '.coop'), (Join-Path $proj 'pbirepo'),
    (Join-Path $proj 'sqlrepo'), (Join-Path $empty '.coop'), $sandboxHome, (Join-Path $t 'coop\.coop') | Out-Null
  # A contract whose only repo is still a TODO placeholder: nothing to seed.
  [System.IO.File]::WriteAllText((Join-Path $empty '.coop\project.yml'),
    "repositories:`n  fabric:`n    local_path: 'TODO: /x'`n", $utf8)
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
    # config-set --config <cfg> --from-json <file> : the config path is %~3 and
    # the patch file %~5. The stub appends its arguments to SEED_ARGS_LOG and
    # copies the patch file to SEED_STDIN.
    [System.IO.File]::WriteAllText((Join-Path $bin 'coop-data-doc.cmd'), (@(
      '@echo off',
      'echo %* >> "%SEED_ARGS_LOG%"',
      'copy /y "%~5" "%SEED_STDIN%" >nul',
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
      'echo "$*" >> "$SEED_ARGS_LOG"',
      'cfg=""; src=""; prev=""',
      'for a in "$@"; do [ "$prev" = "--config" ] && cfg="$a"; [ "$prev" = "--from-json" ] && src="$a"; prev="$a"; done',
      'cp "$src" "$SEED_STDIN"',
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
  $env:SEED_ARGS_LOG = $argsLog
  $env:SEED_STDIN = $stdinFile

  # Invoke-Seed <status> [<dir>] [-NoTty]: run `coop init --seed-docs <dir>`. With
  # -NoTty the child's stdin is a pipe (a non-interactive shell) and COOP_ASSUME_YES
  # is unset, so Coop-Confirm must refuse.
  function Invoke-Seed([string]$Status, [string]$Dir = $proj, [switch]$NoTty) {
    $env:SEED_STATUS = $Status
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $yes = $env:COOP_ASSUME_YES
    try {
      # [string] each record: Windows PowerShell 5.1 wraps native stderr lines in
      # ErrorRecords, and their default formatting adds noise and line wraps.
      if ($NoTty) {
        Remove-Item -LiteralPath 'Env:\COOP_ASSUME_YES' -ErrorAction SilentlyContinue
        $lines = @('' | & $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $coop init --seed-docs $Dir 2>&1 | ForEach-Object { [string]$_ })
      } else {
        $lines = @(& $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $coop init --seed-docs $Dir 2>&1 | ForEach-Object { [string]$_ })
      }
      $rc = $LASTEXITCODE
      $raw = $lines -join "`n"
    } finally { $ErrorActionPreference = $eap; if ($null -ne $yes) { $env:COOP_ASSUME_YES = $yes } }
    return @{ Out = $raw; Flat = ($raw -replace '\s', ''); Rc = $rc }
  }

  # 1. The repos patch reaches config-set, as a file, against the project's coop-data-doc.yml.
  $r = Invoke-Seed 'validated'
  if ($r.Rc -ne 0) { Ko "coop init --seed-docs should succeed (exit $($r.Rc))" $r.Out }
  $argText = if (Test-Path -LiteralPath $argsLog) { [System.IO.File]::ReadAllText($argsLog) } else { '' }
  $cfgPath = Join-Path $proj 'coop-data-doc.yml'
  $argFlat = $argText -replace '\s', ''
  $cfgFlat = ('--config ' + $cfgPath) -replace '\s', ''
  if ($argFlat.Contains('--from-json') -and -not $argFlat.Contains('--from-json-')) { Ok 'config-set --from-json <file> is invoked' }
  else { Ko 'config-set --from-json <file> not invoked' $argText }
  $head = if (Test-Path -LiteralPath $stdinFile) { [System.IO.File]::ReadAllBytes($stdinFile) } else { @() }
  if ($head.Count -ge 1 -and $head[0] -ne 0xEF) { Ok 'the patch file has no byte order mark' }
  else { Ko 'the patch file is missing or starts with a byte order mark' }
  if ($argFlat.Contains($cfgFlat)) { Ok "config-set targets the project dir's coop-data-doc.yml" }
  else { Ko "config-set should target $cfgPath" $argText }
  $patchOk = $false
  try {
    $patch = [System.IO.File]::ReadAllText($stdinFile) | ConvertFrom-Json
    $patchOk = [bool]($patch.repos -and $patch.repos.sql -and $patch.repos.powerbi)
  } catch { $patchOk = $false }
  if ($patchOk) { Ok 'the repos patch (sql + powerbi) reaches config-set' }
  else { Ko 'the patch given to config-set is wrong' (Get-Content -LiteralPath $stdinFile -Raw -ErrorAction SilentlyContinue) }
  if ($r.Flat.Contains('(validated).')) { Ok 'config-set status is shown' }
  else { Ko "seed-docs should show config-set's validated status (exit $($r.Rc))" $r.Out }

  $r = Invoke-Seed 'not-runnable'
  if ($r.Rc -ne 0) { Ko "a not-runnable seed still writes the config and exits 0 (got $($r.Rc))" $r.Out }
  elseif ($r.Flat.Contains('!Wrote') -and $r.Flat.Contains('notrunnableyet') -and $r.Flat.Contains('pbi-repo')) {
    Ok 'not-runnable status is a warning naming the repo path'
  } else { Ko 'the not-runnable status should be a warning naming the repo path' $r.Out }

  # 2. Declining leaves everything untouched (non-interactive without --yes refuses).
  Remove-Item -LiteralPath $argsLog, $stdinFile -Force -ErrorAction SilentlyContinue
  $r = Invoke-Seed 'validated' $proj -NoTty
  if ($r.Rc -ne 0 -and -not (Test-Path -LiteralPath $stdinFile)) { Ok 'declining the confirmation exits non-zero and never calls config-set' }
  elseif ($r.Rc -eq 0) { Ko 'declining should exit non-zero' $r.Out }
  else { Ko 'declining must not invoke config-set' $r.Out }

  # 3. A still-TODO contract warns and exits non-zero without calling the tool.
  Remove-Item -LiteralPath $argsLog, $stdinFile -Force -ErrorAction SilentlyContinue
  $r = Invoke-Seed 'validated' $empty
  if ($r.Rc -ne 0 -and -not (Test-Path -LiteralPath $stdinFile) -and $r.Flat.Contains('nothingtoseedyet')) {
    Ok 'TODO-only contract: warns, exits non-zero, config-set never called'
  } elseif ($r.Rc -eq 0) { Ko 'TODO-only contract should exit non-zero' $r.Out }
  elseif (Test-Path -LiteralPath $stdinFile) { Ko 'TODO-only contract must not invoke config-set' $r.Out }
  else { Ko 'TODO-only contract should warn that there is nothing to seed yet' $r.Out }
} finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -ne 0) { exit 1 }

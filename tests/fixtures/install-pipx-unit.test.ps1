#!/usr/bin/env pwsh
# The install's pipx unit (Invoke-CoopPipxBootstrap) and the Coop-Unit verdict
# around it. On the client VM (v0.23.5 to v0.29.0, Windows PowerShell 5.1) the
# pipx job came back with no result on every installer run although pipx
# worked, and `coop install` exited 1 for it. Offline: pipx, python and pip are
# shims in a temp dir; nothing is installed.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-pipx-unit-' + [guid]::NewGuid().ToString('N'))
$bin = Join-Path $t 'bin'
$calls = Join-Path $t 'calls.log'
function Invoke-Captured([scriptblock]$Body) {
  $writer = New-Object System.IO.StringWriter
  $previous = [Console]::Error
  try { [Console]::SetError($writer); & $Body } finally { [Console]::SetError($previous) }
  return $writer.ToString()
}
function Get-Calls { if (Test-Path -LiteralPath $calls) { return ([System.IO.File]::ReadAllText($calls)) } else { return '' } }

$saved = Save-Env @('PATH', 'COOP_PIPX_BIN', 'COOP_TEST_CALLS', 'COOP_TEST_PIPX_ANSWERS', 'NO_COLOR')
try {
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $env:NO_COLOR = '1'
  $env:COOP_TEST_CALLS = $calls
  Remove-Item Env:\COOP_PIPX_BIN -ErrorAction SilentlyContinue
  # python: `--version` answers; `-m pip install --user pipx` logs the call and
  # succeeds; `-m pipx ...` answers only once COOP_TEST_PIPX_ANSWERS is set (the
  # "installed, in a Scripts dir not on PATH" state); `-m pipx ensurepath` logs.
  Write-Shim 'python' -Dir $bin -Sh @'
if [ "$1" = "--version" ]; then echo "Python 3.12.0"; exit 0; fi
printf '%s\n' "python $*" >> "$COOP_TEST_CALLS"
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then echo "WARNING: pipx.exe is not on PATH" >&2; exit 0; fi
if [ "$1" = "-m" ] && [ "$2" = "pipx" ]; then if [ -n "$COOP_TEST_PIPX_ANSWERS" ]; then echo "1.7.1"; exit 0; fi; exit 1; fi
exit 1
'@ -Cmd @'
if "%1"=="--version" (echo Python 3.12.0 & exit /b 0)
echo python %* >> "%COOP_TEST_CALLS%"
if "%1"=="-m" if "%2"=="pip" (echo WARNING: pipx.exe is not on PATH 1>&2 & exit /b 0)
if "%1"=="-m" if "%2"=="pipx" (if defined COOP_TEST_PIPX_ANSWERS (echo 1.7.1 & exit /b 0) else (exit /b 1))
exit /b 1
'@
  Write-Shim 'python3' -Dir $bin -Sh @'
exec "${0%/*}/python" "$@"
'@ -Cmd @'
"%~dp0python.cmd" %*
'@
  $env:PATH = $bin
  if ($isWindowsHost) { $env:PATH = "$bin$sep$env:SystemRoot\System32" }
  . (Join-Path $root 'lib\common.ps1')

  # 1. A pipx that answers only as `python -m pipx` (pip install --user put it in a
  #    Scripts dir off PATH) is present: no pip call.
  $env:COOP_TEST_PIPX_ANSWERS = '1'
  $r = Invoke-CoopPipxBootstrap
  if (-not $r.ok -or $r.msg -cne 'pipx present' -or (Get-Calls).Contains('pip install')) { Ko 'a python -m pipx that answers is present, nothing is installed' "$($r.ok) $($r.msg) / $(Get-Calls)" }
  else { Ok 'pipx reachable as python -m pipx: present, no install' }

  # 2. No pipx anywhere: pip install --user pipx and ensurepath run; the verdict
  #    is whether pipx answers afterwards. Here it never does.
  Remove-Item -LiteralPath $calls -Force -ErrorAction SilentlyContinue
  Remove-Item Env:\COOP_TEST_PIPX_ANSWERS -ErrorAction SilentlyContinue
  $r = Invoke-CoopPipxBootstrap
  $c = Get-Calls
  if ($r.ok -or -not $c.Contains('-m pip install --user pipx') -or -not $c.Contains('-m pipx ensurepath') -or -not $r.msg.Contains('does not answer')) { Ko 'pip ran and pipx still does not answer: the unit says so' "$($r.ok) $($r.msg) / $c" }
  else { Ok 'no pipx: pip install --user pipx + ensurepath run; a pipx that then does not answer is reported' }

  # 3. The same with a pip whose install drops a pipx shim on PATH (as a real
  #    `pip install --user pipx` does, in a Scripts dir): installed and answering.
  Remove-Item -LiteralPath $calls -Force -ErrorAction SilentlyContinue
  Write-Shim 'python' -Dir $bin -Sh @'
if [ "$1" = "--version" ]; then echo "Python 3.12.0"; exit 0; fi
printf '%s\n' "python $*" >> "$COOP_TEST_CALLS"
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then printf '#!/bin/sh\necho 1.7.1\n' > "${0%/*}/pipx"; /bin/chmod +x "${0%/*}/pipx"; exit 0; fi
if [ "$1" = "-m" ] && [ "$2" = "pipx" ]; then if [ -x "${0%/*}/pipx" ]; then echo 1.7.1; exit 0; fi; exit 1; fi
exit 1
'@ -Cmd @'
if "%1"=="--version" (echo Python 3.12.0 & exit /b 0)
echo python %* >> "%COOP_TEST_CALLS%"
if "%1"=="-m" if "%2"=="pip" (echo @echo 1.7.1> "%~dp0pipx.cmd" & exit /b 0)
if "%1"=="-m" if "%2"=="pipx" (if exist "%~dp0pipx.cmd" (echo 1.7.1 & exit /b 0) else (exit /b 1))
exit /b 1
'@
  $r = Invoke-CoopPipxBootstrap
  $c = Get-Calls
  if (-not $r.ok -or -not $r.msg.StartsWith('pipx installed') -or -not $c.Contains('-m pip install --user pipx') -or -not (Test-CoopPipxAvailable)) { Ko 'pip installs pipx and it answers: the unit succeeds' "$($r.ok) $($r.msg) / $c" }
  else { Ok 'no pipx: pip installs it, and the unit reports it once pipx answers' }

  # 4. Coop-Unit: a job that dies returns no result; the message names why, and
  #    -Verify lets the parent overrule from what it can see (the install's
  #    $VerifyPipx: pipx answers). Non-TTY: the plain Info/Ok/Warn lines. The
  #    pipx shim from case 3 is still on PATH.
  $dies = { throw 'boom from the job' }
  $out = Invoke-Captured { Coop-Unit 'pipx' $dies @() }
  if ($script:CoopUnitLastOk -or -not $out.Contains('pipx (the step returned no result: boom from the job)')) { Ko 'a job that throws: the unit fails and names the reason' $out }
  else { Ok 'a job that throws: ! with the reason (not a bare label)' }
  $verify = { param([bool]$ok, [string]$msg) if ($ok) { return $null }; if (Test-CoopPipxAvailable) { return (Coop-UnitResult $true 'pipx answers (checked by the installer after the step)') }; return $null }
  $out = Invoke-Captured { Coop-Unit 'pipx' $dies @() -Verify $verify }
  if (-not $script:CoopUnitLastOk -or -not $out.Contains('pipx answers (checked by the installer after the step)')) { Ko 'a job that throws while pipx answers: -Verify turns the unit ok' $out }
  else { Ok 'a job that throws while pipx answers: the parent-side check wins' }
  Remove-Item -LiteralPath (Join-Path $bin 'pipx') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $bin 'pipx.cmd') -Force -ErrorAction SilentlyContinue
  $out = Invoke-Captured { Coop-Unit 'pipx' $dies @() -Verify $verify }
  if ($script:CoopUnitLastOk -or -not $out.Contains('returned no result')) { Ko 'a job that throws while pipx is missing: -Verify keeps the failure' $out }
  else { Ok 'a job that throws while pipx is missing: still a failure' }
  $empty = { $null }
  $out = Invoke-Captured { Coop-Unit 'pipx' $empty @() }
  if ($script:CoopUnitLastOk -or -not $out.Contains('pipx (the step returned no result)')) { Ko 'a job that returns nothing: the unit fails and says so' $out }
  else { Ok 'a job that returns nothing: ! says the step returned no result' }

  # 5. install.ps1 wires the unit through the shared converge body with the verify.
  $installPs = [System.IO.File]::ReadAllText((Join-Path (Join-Path $root 'scripts') 'install.ps1'))
  if (-not $installPs.Contains("Install-Unit 'pipx' `$script:CoopConvergeUnit @(`$script:CoopCommonPath, 'Invoke-CoopPipxBootstrap', @{}) -Verify `$VerifyPipx") -or -not $installPs.Contains('if (Test-CoopPipxAvailable) { return (Coop-UnitResult $true')) { Ko 'install.ps1 must run Invoke-CoopPipxBootstrap through Coop-Unit with the pipx-answers verify' }
  else { Ok 'install.ps1 runs the pipx unit with the parent-side verify' }
}
catch {
  Ko "fixture error: $($_.Exception.Message)"
}
finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
exit $fail

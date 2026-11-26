#!/usr/bin/env pwsh
# Pi's exit code versus a failed launch (Invoke-CoopPiProcess in bin/coop.ps1).
# `$?` is false after ANY non-zero native exit, so a Pi that started and exited 1
# (no model signed in, a failed -p turn) used to print "! Pi launch failed
# (code=<a stale $error[0].HResult>)" after Pi's own message. End to end
# `coop -p "say hi"` on a sandboxed home:
#   1. a stub pi that prints its own error and exits 1: coop exits 1, no launch line
#   2. the same stub exiting 3: coop exits 3 (Pi's code passes through)
#   3. a pi found on PATH that cannot start (bad interpreter / not an executable):
#      coop still says "Pi launch failed" and exits 1
# Sandboxed HOME/USERPROFILE/agent dir, COOP_SKIP_AZ=1, no network.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$coop = Join-Path (Join-Path $root 'bin') 'coop.ps1'
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-pi-exit-' + [guid]::NewGuid().ToString('N'))
$sandboxHome = Join-Path $t 'home'
$agent = Join-Path $t 'agent'

$saved = Save-Env @('PATH','HOME','USERPROFILE','COOP_DIR','COOP_AGENT_DIR','PI_CODING_AGENT_DIR','COOP_NO_ISOLATE','COOP_SKIP_AZ','COOP_AZ_BIN',
           'COOP_SKIP_EXT_CHECK','COOP_NO_MODEL_LOGIN','NO_COLOR')
try {
  New-Item -ItemType Directory -Force -Path $agent | Out-Null
  $null = New-SandboxHome $sandboxHome
  # A fresh fetch stamp keeps the launch's once-a-day refresh offline.
  [System.IO.File]::WriteAllText((Join-Path $agent '.coop-fetch-stamp'), '')
  $env:HOME = $sandboxHome
  $env:USERPROFILE = $sandboxHome
  $env:COOP_AGENT_DIR = $agent
  $env:COOP_SKIP_AZ = '1'
  $env:COOP_AZ_BIN = Join-Path $t 'nonexistent-az'
  $env:COOP_SKIP_EXT_CHECK = '1'
  $env:COOP_NO_MODEL_LOGIN = '1'
  $env:NO_COLOR = '1'
  foreach ($n in @('COOP_DIR','PI_CODING_AGENT_DIR','COOP_NO_ISOLATE')) { Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue }

  $realPy = Get-FixturePython
  if (-not $realPy) { throw 'python3 is required for the stub pi' }

  # One stub dir per case, first on PATH (ahead of any real pi).
  function New-CaseBin([string]$Name) {
    $dir = Join-Path $t $Name
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    # npm stub: Add-CoopRuntimePaths asks `npm prefix -g`; answer nothing.
    $null = New-PyStub $dir 'npm' "import sys`nif sys.argv[1:2] == ['--version']:`n    print('10.0.0')`nsys.exit(0)`n"
    return $dir
  }
  function Invoke-Coop([string]$Bin) {
    $env:PATH = "$Bin$sep$($saved['PATH'])"
    $in = Join-Path $t 'child.in'; $so = Join-Path $t 'child.out'; $se = Join-Path $t 'child.err'
    [System.IO.File]::WriteAllText($in, '')
    $argList = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $coop + '"'),'-p','"say hi"')
    $p = Start-Process -FilePath $psExe -ArgumentList $argList -WorkingDirectory $t `
      -PassThru -NoNewWindow -RedirectStandardInput $in -RedirectStandardOutput $so -RedirectStandardError $se
    $null = $p.Handle
    $p.WaitForExit()
    $env:PATH = $saved['PATH']
    return [pscustomobject]@{ Rc = $p.ExitCode; All = [System.IO.File]::ReadAllText($so) + [System.IO.File]::ReadAllText($se) }
  }
  $launchLine = 'Pi launch failed'

  # 1-2. Pi starts, explains itself, and exits non-zero.
  foreach ($code in @(1, 3)) {
    $bin = New-CaseBin "exit$code"
    $null = New-PyStub $bin 'pi' "import sys`nsys.stderr.write('STUB-PI: no model signed in\n')`nsys.exit($code)`n"
    $r = Invoke-Coop $bin
    $problems = @()
    if (-not $r.All.Contains('STUB-PI: no model signed in')) { $problems += 'the stub pi never ran' }
    if ($r.Rc -ne $code) { $problems += "coop exited $($r.Rc), want $code" }
    if ($r.All.Contains($launchLine)) { $problems += 'printed the false launch-failure line' }
    if ($problems.Count -eq 0) { Ok "pi exits ${code}: coop exits $code with Pi's own message and no launch-failure line" }
    else { Ko "pi exits ${code}: $($problems -join '; ')" $r.All }
  }

  # 3. pi is on PATH but cannot start.
  $bin = New-CaseBin 'unstartable'
  if ($isWindowsHost) {
    [System.IO.File]::WriteAllBytes((Join-Path $bin 'pi.exe'), [byte[]](0x6E, 0x6F, 0x74, 0x20, 0x61, 0x6E, 0x20, 0x65, 0x78, 0x65))
  } else {
    [System.IO.File]::WriteAllText((Join-Path $bin 'pi'), "#!/nonexistent/coop-test-interpreter`n")
    & $chmod +x (Join-Path $bin 'pi')
  }
  $r = Invoke-Coop $bin
  if ($r.All.Contains($launchLine) -and $r.Rc -eq 1) { Ok 'pi cannot start: coop says "Pi launch failed" and exits 1' }
  else { Ko "pi cannot start: rc=$($r.Rc), launch line present=$($r.All.Contains($launchLine))" $r.All }
} finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
exit $fail

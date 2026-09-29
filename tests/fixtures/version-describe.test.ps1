#!/usr/bin/env pwsh
# #108: PowerShell twin of tests/version-describe.test.sh. `coop.ps1 version`
# and `doctor.ps1 --publish` carry the checkout's git describe
# (Get-CoopRepoDescribe), so two machines on different commits past the same
# release tag are told apart; a copy that is not a git checkout prints VERSION
# only, with no error. Offline: every checkout is a throwaway clone of a copy of
# this tree (never the checkout running the tests, #104) with its origin
# removed, so doctor has nothing to fetch; HOME/USERPROFILE/COOP_DIR, the agent
# dir and the publish dir are temp dirs, and pi/npm/pipx/az/fab/brew/winget are
# stubs. No waits. Assertions stay ASCII: Windows PowerShell 5.1 re-encodes
# child output.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$psExe = try { (Get-Process -Id $PID).Path } catch { 'pwsh' }
$isWindowsHost = ($env:OS -eq 'Windows_NT')
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-version-describe-' + [guid]::NewGuid().ToString('N'))
$fail = 0
function Ok([string]$m) { Write-Host "  ok $m" }
function Ko([string]$m, [string]$out = '') { Write-Host "  x $m"; if ($out) { Write-Host $out }; $script:fail = 1 }

$bin = Join-Path $t 'bin'
$cwd = Join-Path $t 'cwd'
$sandboxHome = Join-Path $t 'home'
$pub = Join-Path $t 'published'
$seed = Join-Path $t 'seed'
$utf8 = New-Object System.Text.UTF8Encoding($false)

# Fixture git runs in its own Continue scope and throws on a real failure.
function Invoke-FixtureGit([string[]]$GitArgs) {
  $ErrorActionPreference = 'Continue'
  $o = @(& git @GitArgs 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "fixture git $($GitArgs -join ' ') failed: $($o | Out-String)" }
  if ($o.Count -gt 0) { return ([string]$o[0]).Trim() }
}
function Write-Shim([string]$Name, [string]$Sh, [string]$Cmd) {
  [System.IO.File]::WriteAllText((Join-Path $bin $Name), $Sh)
  [System.IO.File]::WriteAllText((Join-Path $bin ($Name + '.cmd')), $Cmd)
  if (-not $isWindowsHost) { & chmod +x (Join-Path $bin $Name) }
}
function New-Machine([string]$Name, [string]$Rev) {
  $d = Join-Path (Join-Path $t $Name) 'coop-agent'
  $null = Invoke-FixtureGit @('clone', '-q', $seed, $d)
  $null = Invoke-FixtureGit @('-C', $d, 'reset', '-q', '--hard', $Rev)
  $null = Invoke-FixtureGit @('-C', $d, 'remote', 'remove', 'origin')
  return $d
}
# `coop.ps1 version` from one copy: stdout lines; stderr lands in $script:VersionErr.
function Get-VersionLines([string]$CoopRoot) {
  $errFile = Join-Path $t 'version.err'
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  Push-Location -LiteralPath $cwd
  try {
    $lines = @(& $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $CoopRoot 'bin\coop.ps1') version 2>$errFile)
    $script:VersionRc = $LASTEXITCODE
  } finally {
    Pop-Location
    $ErrorActionPreference = $eap
  }
  $script:VersionErr = ''
  if (Test-Path -LiteralPath $errFile) { $script:VersionErr = [System.IO.File]::ReadAllText($errFile).Trim() }
  return @($lines | ForEach-Object { ([string]$_).TrimEnd() })
}

$saved = @{}
$names = @('PATH','HOME','USERPROFILE','COOP_DIR','COOP_AGENT_DIR','PI_CODING_AGENT_DIR','PIPX_HOME','PIPX_BIN_DIR',
           'npm_config_prefix','COOP_TEST_STUB_PATH','COOP_SKIP_AZ','COOP_NO_ONBOARD','COOP_NO_ISOLATE','NO_COLOR',
           'COOP_ROOT','COOP_RELEASE_MANIFEST','USER','USERNAME','GIT_CONFIG_NOSYSTEM','GIT_AUTHOR_NAME',
           'GIT_AUTHOR_EMAIL','GIT_COMMITTER_NAME','GIT_COMMITTER_EMAIL')
foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
try {
  New-Item -ItemType Directory -Force -Path $bin, $cwd, (Join-Path $sandboxHome '.coop'), (Join-Path $t 'agent'), $pub, $seed | Out-Null
  Write-Shim 'pi' @'
#!/bin/sh
[ "$1" = "--version" ] && { echo 0.84.3; exit 0; }
exit 0
'@ "@echo off`r`nif `"%~1`"==`"--version`" (echo 0.84.3& exit /b 0)`r`nexit /b 0`r`n"
  Write-Shim 'npm' @'
#!/bin/sh
[ "$1" = "--version" ] && { echo 10.9.0; exit 0; }
exit 0
'@ "@echo off`r`nif `"%~1`"==`"--version`" (echo 10.9.0& exit /b 0)`r`nexit /b 0`r`n"
  foreach ($n in @('pipx', 'az', 'fab', 'brew', 'winget')) {
    Write-Shim $n "#!/bin/sh`nexit 1`n" "@echo off`r`nexit /b 1`r`n"
  }
  # doctor.ps1 --publish writes here, never to a shared folder.
  [System.IO.File]::WriteAllText((Join-Path $sandboxHome '.coop\config'),
    "fleet:`n  publish_dir: '$($pub -replace '\\', '/')'`n", $utf8)

  $env:PATH = "$bin$([System.IO.Path]::PathSeparator)$($env:PATH)"
  $env:HOME = $sandboxHome
  $env:USERPROFILE = $sandboxHome
  $env:COOP_DIR = $sandboxHome
  $env:COOP_AGENT_DIR = Join-Path $t 'agent'
  $env:PI_CODING_AGENT_DIR = $env:COOP_AGENT_DIR
  $env:PIPX_HOME = Join-Path $t 'pipx-home'
  $env:PIPX_BIN_DIR = Join-Path $t 'pipx-bin'
  $env:npm_config_prefix = Join-Path $t 'npm-prefix'
  $env:COOP_TEST_STUB_PATH = $bin
  $env:COOP_SKIP_AZ = '1'
  $env:COOP_NO_ONBOARD = '1'
  $env:NO_COLOR = '1'
  $env:GIT_CONFIG_NOSYSTEM = '1'
  $env:GIT_AUTHOR_NAME = 't'; $env:GIT_AUTHOR_EMAIL = 't@t'
  $env:GIT_COMMITTER_NAME = 't'; $env:GIT_COMMITTER_EMAIL = 't@t'
  # Remove-Item, not SetEnvironmentVariable($n, $null): PowerShell passes $null
  # to a .NET string parameter as '', which leaves an empty variable behind.
  foreach ($n in @('COOP_NO_ISOLATE', 'COOP_ROOT', 'COOP_RELEASE_MANIFEST')) {
    Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue
  }

  # The release history: c1 tagged v0.23.5 (VERSION 0.23.5), then c2 and c3.
  # Dot entries other than the bundled .coop contract are git, CI and cache files.
  Get-ChildItem -LiteralPath $root -Force |
    Where-Object { $_.Name -eq '.coop' -or -not $_.Name.StartsWith('.') } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $seed -Recurse -Force }
  [System.IO.File]::WriteAllText((Join-Path $seed 'VERSION'), "0.23.5`n", $utf8)
  $null = Invoke-FixtureGit @('init', '-q', $seed)
  $null = Invoke-FixtureGit @('-C', $seed, 'add', '-A')
  $null = Invoke-FixtureGit @('-C', $seed, 'commit', '-q', '-m', 'c1')
  $null = Invoke-FixtureGit @('-C', $seed, 'tag', '-a', 'v0.23.5', '-m', 'v0.23.5')
  foreach ($c in @('c2', 'c3')) {
    [System.IO.File]::WriteAllText((Join-Path $seed "$c.txt"), "$c`n", $utf8)
    $null = Invoke-FixtureGit @('-C', $seed, 'add', "$c.txt")
    $null = Invoke-FixtureGit @('-C', $seed, 'commit', '-q', '-m', $c)
  }

  # Machine A runs c2 (one past the tag), machine B runs c3 (two past it).
  $a = New-Machine 'a' 'HEAD~1'
  $b = New-Machine 'b' 'HEAD'
  $descA = 'v0.23.5-1-g' + (Invoke-FixtureGit @('-C', $a, 'rev-parse', '--short', 'HEAD'))
  $descB = 'v0.23.5-2-g' + (Invoke-FixtureGit @('-C', $b, 'rev-parse', '--short', 'HEAD'))

  # 1. Two machines past the same tag print different, exact version lines.
  $outA = Get-VersionLines $a
  $outB = Get-VersionLines $b
  if ($outA.Count -lt 2 -or $outA[0] -cne "coop 0.23.5 ($descA)" -or $outA[1] -cne 'pi   0.84.3') {
    Ko "coop.ps1 version on machine A must read 'coop 0.23.5 ($descA)' then the pi line" ($outA -join "`n")
  } elseif ($outB.Count -lt 1 -or $outB[0] -cne "coop 0.23.5 ($descB)") {
    Ko "coop.ps1 version on machine B must read 'coop 0.23.5 ($descB)'" ($outB -join "`n")
  } else { Ok "coop.ps1 version names the commit: $descA vs $descB past the same v0.23.5" }

  # 2. A copy that is not a git checkout prints VERSION only, with no error, even
  #    inside another repository whose tags must not be borrowed.
  $outer = Join-Path $t 'outer'
  $null = Invoke-FixtureGit @('init', '-q', $outer)
  [System.IO.File]::WriteAllText((Join-Path $outer 'x'), "x`n", $utf8)
  $null = Invoke-FixtureGit @('-C', $outer, 'add', 'x')
  $null = Invoke-FixtureGit @('-C', $outer, 'commit', '-q', '-m', 'outer')
  $null = Invoke-FixtureGit @('-C', $outer, 'tag', 'v9.9.9')
  $plain = Join-Path $outer 'coop-agent'
  New-Item -ItemType Directory -Force -Path $plain | Out-Null
  Get-ChildItem -LiteralPath $seed -Force |
    Where-Object { $_.Name -eq '.coop' -or -not $_.Name.StartsWith('.') } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $plain -Recurse -Force }
  $outPlain = Get-VersionLines $plain
  if ($script:VersionRc -ne 0 -or $outPlain.Count -lt 1 -or $outPlain[0] -cne 'coop 0.23.5') {
    Ko "a non-git copy must print 'coop 0.23.5' (exit $script:VersionRc)" ($outPlain -join "`n")
  } elseif ($script:VersionErr) {
    Ko 'a non-git copy must print no error' $script:VersionErr
  } else { Ok "a non-git copy prints VERSION only, with no error (and never the enclosing repo's tag)" }

  # 3. doctor.ps1 --publish carries coop_describe next to coop_version; a non-git
  #    copy publishes it empty.
  $publishOk = $true
  foreach ($case in @(@{ Root = $b; User = 'bob'; Want = $descB }, @{ Root = $plain; User = 'dana'; Want = '' })) {
    $env:USERNAME = $case.User; $env:USER = $case.User
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    Push-Location -LiteralPath $cwd
    try {
      $raw = (& $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $case.Root 'scripts\doctor.ps1') --publish 2>&1 | Out-String)
    } finally {
      Pop-Location
      $ErrorActionPreference = $eap
    }
    $snap = @(Get-ChildItem -LiteralPath $pub -Filter "*_$($case.User).json")
    if ($snap.Count -ne 1) {
      Ko "doctor.ps1 --publish wrote no snapshot for $($case.User)" $raw
      $publishOk = $false
      continue
    }
    $text = [System.IO.File]::ReadAllText($snap[0].FullName)
    $doc = $text | ConvertFrom-Json
    if (@($doc.PSObject.Properties.Name) -notcontains 'coop_describe' -or
        $doc.coop_describe -cne $case.Want -or $doc.coop_version -cne '0.23.5') {
      Ko "doctor.ps1 --publish from $($case.User)'s copy must carry coop_describe '$($case.Want)' next to coop_version 0.23.5" $text
      $publishOk = $false
    }
  }
  if ($publishOk) { Ok "doctor.ps1 --publish adds coop_describe next to coop_version ('' for a non-git copy)" }
} catch {
  Ko "fixture error: $($_.Exception.Message)" ($_.ScriptStackTrace)
} finally {
  foreach ($n in $names) {
    if ($null -eq $saved[$n]) { Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
  }
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}

if ($fail -ne 0) { Write-Host '  x coop.ps1 version and doctor.ps1 --publish describe (PowerShell) tests FAILED'; exit 1 }
Write-Host '  coop.ps1 version and doctor.ps1 --publish describe (PowerShell) tests passed'
exit 0

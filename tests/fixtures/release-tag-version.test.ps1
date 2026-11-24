#!/usr/bin/env pwsh
# A vX.Y.Z tag is a release only when VERSION at that tag is X.Y.Z.
# The stray v1.0.19 (VERSION still 0.42.0) must not outrank v0.42.1, and a
# checkout sitting on that commit must still be offered v0.42.1.
# Offline: the origin is a local bare repo. The caller runs with EAP=Stop.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
# pwsh 7.3+: a failed native command honors EAP=Stop too, as redirected stderr does
# on Windows PowerShell 5.1, so the helper's function-local Continue is what runs.
$PSNativeCommandUseErrorActionPreference = $true
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-release-tag-version-' + [guid]::NewGuid().ToString('N'))

function Add-ReleaseCommit([string]$Repo, [string]$Version, [string]$Message) {
  [System.IO.File]::WriteAllText((Join-Path $Repo 'VERSION'), "$Version`n")
  [System.IO.File]::WriteAllText((Join-Path $Repo 'README'), "$Message`n")
  Invoke-FixtureGit @('-C', $Repo, 'add', 'VERSION', 'README')
  Invoke-FixtureGit @('-C', $Repo, 'commit', '-q', '-m', $Message)
}

$saved = Save-Env @('HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL')
try {
  New-Item -ItemType Directory -Force -Path $t, (Join-Path $t 'home') | Out-Null
  $env:HOME = Join-Path $t 'home'
  $env:GIT_CONFIG_NOSYSTEM = '1'
  $env:GIT_AUTHOR_NAME = 't'; $env:GIT_AUTHOR_EMAIL = 't@t'
  $env:GIT_COMMITTER_NAME = 't'; $env:GIT_COMMITTER_EMAIL = 't@t'

  # v0.42.0 (VERSION matches), then a stray v1.0.19 on main whose VERSION is
  # still 0.42.0, then v0.42.1 (VERSION matches). Same shape as the 2026-11-23 tag.
  $origin = Join-Path $t 'origin.git'
  $seed = Join-Path $t 'seed'
  Invoke-FixtureGit @('init', '-q', '--bare', $origin)
  Invoke-FixtureGit @('-C', $origin, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  Invoke-FixtureGit @('init', '-q', $seed)
  Invoke-FixtureGit @('-C', $seed, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  Add-ReleaseCommit $seed '0.42.0' 'v0.42.0'
  Invoke-FixtureGit @('-C', $seed, 'tag', '-a', 'v0.42.0', '-m', 'v0.42.0')
  Add-ReleaseCommit $seed '0.42.0' 'stray'
  Invoke-FixtureGit @('-C', $seed, 'tag', 'v1.0.19')
  Add-ReleaseCommit $seed '0.42.1' 'v0.42.1'
  Invoke-FixtureGit @('-C', $seed, 'tag', '-a', 'v0.42.1', '-m', 'v0.42.1')
  Invoke-FixtureGit @('-C', $seed, 'push', '-q', $origin, 'main', '--tags')
  $at0421 = Get-FixtureGit @('-C', $seed, 'rev-parse', 'v0.42.1^{commit}')

  $clone = Join-Path $t 'clone'
  Invoke-FixtureGit @('clone', '-q', $origin, $clone)
  . (Join-Path $root 'lib\common.ps1')
  $script:CoopRoot = $clone

  Invoke-FixtureGit @('-C', $clone, 'reset', '-q', '--hard', 'v0.42.0')
  $next = Get-CoopRepoNextRelease
  $newest = Get-CoopRepoNewestRelease
  if ($next -ne 'v0.42.1' -or $newest -ne 'v0.42.1') {
    Ko "from v0.42.0 the next release is v0.42.1 (got next '$next', newest '$newest')"
  } else { Ok 'from v0.42.0 the next release is v0.42.1' }

  Invoke-FixtureGit @('-C', $clone, 'reset', '-q', '--hard', 'v1.0.19')
  $next = Get-CoopRepoNextRelease
  if ($next -ne 'v0.42.1') {
    Ko "from the stray v1.0.19 commit the next release is v0.42.1 (got '$next')"
  } else { Ok 'from the stray commit the next release is v0.42.1' }

  # The step 2 checkout in docs/install-windows.md, pasted as a user pastes it.
  # Start behind v0.42.1 so a no-op checkout cannot pass.
  $install = Join-Path $t 'install'
  Invoke-FixtureGit @('clone', '-q', $origin, $install)
  Invoke-FixtureGit @('-C', $install, 'reset', '-q', '--hard', 'v0.42.0')
  $docPath = Join-Path $root 'docs\install-windows.md'
  $line = @(Get-Content -LiteralPath $docPath | Where-Object { $_ -match 'git tag --merged' -and $_ -match 'git checkout' } | Select-Object -First 1)
  if (-not $line) { Ko 'docs/install-windows.md step 2 checkout line is missing' }
  else {
    Push-Location -LiteralPath $install
    try { Invoke-Expression $line.Trim() }
    finally { Pop-Location }
    $at = Get-FixtureGit @('-C', $install, 'rev-parse', 'HEAD')
    if ($at -ne $at0421) {
      $landed = Get-FixtureGit @('-C', $install, 'describe', '--tags', '--exact-match', 'HEAD')
      Ko "the install checkout line must land on v0.42.1 (got '$landed')"
    } else { Ok 'the install checkout line lands on v0.42.1' }
  }
}
catch {
  Ko "fixture error: $($_.Exception.Message)"
}
finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
exit $fail

#!/usr/bin/env pwsh
# H5: PowerShell twin of tests/update-follow.test.sh. Step 1 of `coop update`
# (Invoke-CoopRepoFollowRelease) follows release tags and never moves a checkout
# backwards; the doctor/launch helpers (Get-CoopRepoNextRelease,
# Get-CoopRepoBehindCount, Invoke-CoopUpdateNudge, Get-CoopRepoStranded) count
# against the same release. Offline: every "origin" is a local bare repo in a
# temp dir; no sleep, no marker, no network, never this checkout. The caller runs
# with EAP=Stop, which proves the helpers' function-local Continue on 5.1.
# Assertions read git state; message text is checked only where no state differs.
$ErrorActionPreference = 'Stop'
# pwsh 7.3+: a failed native command honors EAP=Stop too, as redirected stderr does
# on Windows PowerShell 5.1, so every host proves the helpers' local Continue.
$PSNativeCommandUseErrorActionPreference = $true
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-update-follow-' + [guid]::NewGuid().ToString('N'))
$failed = $false
function Ok([string]$Message) { Write-Host "  OK  $Message" }
function Ko([string]$Message, [string]$Out = '') { Write-Host "  FAIL $Message"; if ($Out) { Write-Host $Out }; $script:failed = $true }

# Fixture git runs in its own Continue scope and throws on a real failure.
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
function Add-FixtureCommit([string]$Repo, [string]$Message, [string]$File) {
  [System.IO.File]::WriteAllText((Join-Path $Repo $File), "$Message`n")
  Invoke-FixtureGit @('-C', $Repo, 'add', $File)
  Invoke-FixtureGit @('-C', $Repo, 'commit', '-q', '-m', $Message)
}
function New-FixtureClone([string]$Name, [string[]]$CloneArgs = @()) {
  $d = Join-Path $t $Name
  Invoke-FixtureGit (@('clone', '-q') + $CloneArgs + @($script:Origin, $d))
  $script:CoopRoot = $d
  return $d
}
function Get-At { Get-FixtureGit @('-C', $script:CoopRoot, 'rev-parse', 'HEAD') }
function Get-BranchRef { Get-FixtureGit @('-C', $script:CoopRoot, 'symbolic-ref', '-q', 'HEAD') }
function Get-Upstream { Get-FixtureGit @('-C', $script:CoopRoot, 'rev-parse', '-q', '--symbolic-full-name', '@{u}') }
# Coop-Emit writes through [Console]::Error; capture it the way azcache.test.ps1 does.
function Invoke-Captured([scriptblock]$Body) {
  $writer = New-Object System.IO.StringWriter
  $previous = [Console]::Error
  try { [Console]::SetError($writer); & $Body } finally { [Console]::SetError($previous) }
  return $writer.ToString()
}

$saved = @{}
$names = @('HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'COOP_AGENT_DIR', 'NO_COLOR')
foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
try {
  New-Item -ItemType Directory -Force -Path $t, (Join-Path $t 'home') | Out-Null
  # Hermetic git: no user or system config, a fixed identity.
  $env:HOME = Join-Path $t 'home'
  $env:GIT_CONFIG_NOSYSTEM = '1'
  $env:GIT_AUTHOR_NAME = 't'; $env:GIT_AUTHOR_EMAIL = 't@t'
  $env:GIT_COMMITTER_NAME = 't'; $env:GIT_COMMITTER_EMAIL = 't@t'
  $env:COOP_AGENT_DIR = Join-Path $t 'agent'
  $env:NO_COLOR = '1'

  # Same origin as the bash test: c1 v0.9.0 (annotated), c2 v0.10.0 (lightweight),
  # c3 v0.11.0-rc1 (annotated), c4 unreleased; side branch from c2 tagged v9.9.9.
  $script:Origin = Join-Path $t 'origin.git'
  $seed = Join-Path $t 'seed'
  Invoke-FixtureGit @('init', '-q', '--bare', $script:Origin)
  Invoke-FixtureGit @('-C', $script:Origin, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  Invoke-FixtureGit @('init', '-q', $seed)
  Invoke-FixtureGit @('-C', $seed, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  Add-FixtureCommit $seed 'c1' 'README'; Invoke-FixtureGit @('-C', $seed, 'tag', '-a', 'v0.9.0', '-m', 'v0.9.0')
  Add-FixtureCommit $seed 'c2' 'f2';     Invoke-FixtureGit @('-C', $seed, 'tag', 'v0.10.0')
  Add-FixtureCommit $seed 'c3' 'f3';     Invoke-FixtureGit @('-C', $seed, 'tag', '-a', 'v0.11.0-rc1', '-m', 'rc1')
  Add-FixtureCommit $seed 'c4' 'f4'
  Invoke-FixtureGit @('-C', $seed, 'checkout', '-q', '-b', 'side', 'v0.10.0')
  Add-FixtureCommit $seed 's1' 'side';   Invoke-FixtureGit @('-C', $seed, 'tag', '-a', 'v9.9.9', '-m', 'side')
  Invoke-FixtureGit @('-C', $seed, 'checkout', '-q', 'main')
  Invoke-FixtureGit @('-C', $seed, 'push', '-q', $script:Origin, 'main', 'side', '--tags')
  $C1 = Get-FixtureGit @('-C', $seed, 'rev-parse', 'v0.9.0^{commit}')
  $C2 = Get-FixtureGit @('-C', $seed, 'rev-parse', 'v0.10.0^{commit}')
  $C4 = Get-FixtureGit @('-C', $seed, 'rev-parse', 'main')

  . (Join-Path $root 'lib\common.ps1')
  # The launch nudge's daily fetch is stubbed out (tests/staleness.test.sh covers
  # the throttle), so the nudge's own logic runs with no subprocess wait.
  function Invoke-CoopRepoFetchThrottled { return $true }

  # 1. Ahead of every release: stays put; no count, no nudge (the loop H5 must avoid).
  $null = New-FixtureClone 'ahead'
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
  if ((Get-At) -ne $C4 -or (Get-BranchRef) -ne 'refs/heads/main') { Ko 'ahead of every release: must not move' $out }
  elseif ((Get-CoopRepoNextRelease) -or (Get-CoopRepoBehindCount) -ne 0) { Ko 'ahead of every release: next release empty and 0 behind expected' }
  elseif ((Invoke-Captured { Invoke-CoopUpdateNudge }).Trim()) { Ko 'ahead of every release: the launch nudge must stay silent' }
  elseif ($null -ne (Get-CoopRepoStranded)) { Ko 'ahead of every release is not a stranded state' }
  else { Ok 'ahead of the newest release: stays put, 0 behind, nudge silent' }

  # 2. Behind: moves to exactly the next release (version sort; rc, off-main and
  #    same-named-branch cases) and stays attached with its upstream.
  $null = New-FixtureClone 'behind'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'branch', 'v0.10.0', $C2)
  $next = Get-CoopRepoNextRelease
  $nudge = Invoke-Captured { Invoke-CoopUpdateNudge }
  if ($next -ne 'v0.10.0') { Ko "at v0.9.0 the next release is v0.10.0 (got '$next')" }
  elseif ((Get-CoopRepoBehindCount) -ne 1) { Ko 'at v0.9.0 behind should be 1' }
  elseif (-not $nudge.Contains('1 commit(s) behind release v0.10.0')) { Ko 'the launch nudge should name the release' $nudge }
  else { Ok 'behind: next release v0.10.0, 1 behind, nudge names the release' }
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
  if ((Get-At) -ne $C2) { Ko 'should land exactly on v0.10.0, not head of main' $out }
  elseif ((Get-BranchRef) -ne 'refs/heads/main' -or (Get-Upstream) -ne 'refs/remotes/origin/main') { Ko 'main must stay attached and keep its upstream' }
  elseif (Get-CoopRepoNextRelease) { Ko 'on the newest release the next release must be empty (rc tags are not releases)' }
  elseif ((Get-CoopRepoBehindCount) -ne 0) { Ko 'on the newest release, unreleased commits on main must read 0 behind' }
  elseif ((Invoke-Captured { Invoke-CoopUpdateNudge }).Trim()) { Ko 'on the newest release, unreleased commits on main must not nudge' }
  else { Ok 'behind: fast-forwards to exactly v0.10.0 on main; then 0 behind and no nudge despite unreleased main' }
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
  if ((Get-At) -ne $C2 -or $out.Contains('moved')) { Ko 'a second run must be a quiet no-op' $out }
  else { Ok 'a second run is a no-op' }

  # 3. Dirty tracked file: the move is skipped.
  $null = New-FixtureClone 'dirty'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  [System.IO.File]::AppendAllText((Join-Path $script:CoopRoot 'README'), "local edit`n")
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
  if ((Get-At) -ne $C1 -or -not $out.Contains('uncommitted')) { Ko 'a dirty checkout must warn and not move' $out }
  else { Ok 'dirty tracked files skip the move' }

  # 4. Detached `clone --branch v0.9.0`: moves forward, stays detached.
  $null = New-FixtureClone 'detached' @('--branch', 'v0.9.0')
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
  if ((Get-At) -ne $C2 -or (Get-BranchRef)) { Ko 'a detached release checkout should move to v0.10.0 and stay detached' $out }
  else { Ok 'detached release checkout: moves forward and stays detached' }

  # 5. -Edge from a detached HEAD: re-attaches to main at origin/main.
  $null = New-FixtureClone 'edge-detached' @('--branch', 'v0.9.0')
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $true }
  if ((Get-At) -ne $C4 -or (Get-BranchRef) -ne 'refs/heads/main' -or (Get-Upstream) -ne 'refs/remotes/origin/main') { Ko '--edge should land on main at origin/main, tracking it' $out }
  else { Ok '--edge: detached checkout re-attaches to main at origin/main' }

  # 6. -Edge guard: a local main with an unpushed commit is never reset.
  $null = New-FixtureClone 'edge-local-main'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  Add-FixtureCommit $script:CoopRoot 'unpushed' 'unpushed'
  $x = Get-At
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'checkout', '-q', '--detach', 'v0.9.0')
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $true }
  if ((Get-FixtureGit @('-C', $script:CoopRoot, 'rev-parse', 'refs/heads/main')) -ne $x) { Ko '--edge reset a local main that had unpushed commits' $out }
  elseif ((Get-At) -ne $C1 -or (Get-BranchRef)) { Ko '--edge must stay put when local main has unpushed commits' $out }
  else { Ok '--edge guard: a local main with unpushed commits stays put' }

  # 7. Hold: a branch with no upstream is not moved, and the state is named.
  $null = New-FixtureClone 'hold'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'checkout', '-q', '-b', 'hold', 'v0.9.0')
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
  $s = Get-CoopRepoStranded
  if ((Get-At) -ne $C1 -or (Get-CoopRepoBehindCount) -ne 0) { Ko 'a hold must not move and reads 0 behind' $out }
  elseif ($null -eq $s -or -not $s.Message.Contains("held on branch 'hold'") -or -not $s.Hint.Contains('switch main')) { Ko 'the hold should be named with the fix' }
  else { Ok 'hold branch: not moved, named with the fix' }

  # 7b. Keyed on the upstream, not the name: a renamed branch tracking origin/main
  #     follows releases; a main that tracks nothing is a hold.
  $null = New-FixtureClone 'renamed'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'branch', '-q', '-m', 'main', 'master')
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
  if ((Get-At) -ne $C2 -or (Get-BranchRef) -ne 'refs/heads/master') { Ko 'a renamed branch tracking origin/main should follow releases' $out }
  else { Ok 'renamed branch tracking origin/main: follows releases' }
  $null = New-FixtureClone 'non-tracking'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'branch', '--unset-upstream')
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
  $s = Get-CoopRepoStranded
  if ((Get-At) -ne $C1) { Ko 'a main that does not track origin/main is a hold' $out }
  elseif ($null -eq $s -or -not $s.Hint.Contains('branch --set-upstream-to=origin/main main')) { Ko 'a non-tracking main should name the fix' }
  else { Ok 'non-tracking main: a hold, named with the fix' }

  # 8. Diverged: a local commit blocks the next release; named, 0 behind.
  $null = New-FixtureClone 'diverged'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  Add-FixtureCommit $script:CoopRoot 'local-work' 'local'
  $l = Get-At
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
  $s = Get-CoopRepoStranded
  if ((Get-At) -ne $l -or (Get-CoopRepoBehindCount) -ne 0) { Ko 'a diverged checkout must not move and reads 0 behind' $out }
  elseif ($null -eq $s -or -not $s.Message.Contains('release v0.10.0 does not contain') -or -not $s.Hint.Contains('reset --keep v0.10.0')) { Ko 'the diverged state should be named with the fix' }
  else { Ok 'diverged: not moved, 0 behind, named with the fix' }
}
catch {
  Ko "fixture error: $($_.Exception.Message)"
}
finally {
  foreach ($n in $saved.Keys) {
    if ($null -eq $saved[$n]) { Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
  }
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failed) { exit 1 }

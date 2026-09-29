#!/usr/bin/env pwsh
# H5: PowerShell twin of tests/update-follow.test.sh. Step 1 of `coop update`
# (Invoke-CoopRepoFollowRelease) follows release tags and never moves a checkout
# backwards; the doctor/launch helpers (Get-CoopRepoNextRelease,
# Get-CoopRepoBehindCount, Invoke-CoopUpdateNudge, Get-CoopRepoStranded,
# Get-CoopRepoDoctorRow) count against the same release. Offline: every "origin" is a local bare repo in a
# temp dir; no sleep, no marker, no network, never this checkout. The caller runs
# with EAP=Stop, which proves the helpers' function-local Continue on 5.1.
# Assertions read git state; message text is checked only where no state differs.
# Printed fixes are run the way a user pastes them into PowerShell (Invoke-Hint).
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
function New-FixtureClone([string]$Name, [string[]]$CloneArgs = @(), [string]$From = '') {
  if (-not $From) { $From = $script:Origin }
  $d = Join-Path $t $Name
  Invoke-FixtureGit (@('clone', '-q') + $CloneArgs + @($From, $d))
  $script:CoopRoot = $d
  return $d
}
# Run the command part of a printed hint ('<label>: <command>') as a user pastes it
# into PowerShell. Local Continue: a git failure inside the hint is the point.
function Invoke-Hint([string]$Hint) {
  $ErrorActionPreference = 'Continue'
  $PSNativeCommandUseErrorActionPreference = $false
  $null = Invoke-Expression $Hint.Substring($Hint.IndexOf(': ') + 2) *>&1
}
# The output of a printed command, run as a user pastes it into PowerShell.
function Get-PastedOutput([string]$Command) {
  $ErrorActionPreference = 'Continue'
  $PSNativeCommandUseErrorActionPreference = $false
  return ((Invoke-Expression $Command 2>$null) | Out-String)
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
  # c3 v0.11.0-rc1 (annotated) plus v0.99, v0.10.0.1 and v1 (not shaped vX.Y.Z,
  # and each sorts above v0.10.0, so the strict filter is what skips them), c4
  # unreleased; side branch from c2 tagged v9.9.9.
  $script:Origin = Join-Path $t 'origin.git'
  $seed = Join-Path $t 'seed'
  Invoke-FixtureGit @('init', '-q', '--bare', $script:Origin)
  Invoke-FixtureGit @('-C', $script:Origin, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  Invoke-FixtureGit @('init', '-q', $seed)
  Invoke-FixtureGit @('-C', $seed, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  Add-FixtureCommit $seed 'c1' 'README'; Invoke-FixtureGit @('-C', $seed, 'tag', '-a', 'v0.9.0', '-m', 'v0.9.0')
  Add-FixtureCommit $seed 'c2' 'f2';     Invoke-FixtureGit @('-C', $seed, 'tag', 'v0.10.0')
  Add-FixtureCommit $seed 'c3' 'f3';     Invoke-FixtureGit @('-C', $seed, 'tag', '-a', 'v0.11.0-rc1', '-m', 'rc1')
  foreach ($junk in @('v0.99', 'v0.10.0.1', 'v1')) { Invoke-FixtureGit @('-C', $seed, 'tag', $junk) }
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
  elseif ((Get-CoopRepoDescribe) -notlike 'v0.10.0-2-g*' -or $out.Contains('rc1')) { Ko "describe must skip the rc and non-vX.Y.Z tags (got '$(Get-CoopRepoDescribe)')" $out }
  else { Ok 'ahead of the newest release: stays put, 0 behind, nudge silent, no rc in describe' }

  # 2. Behind: moves to exactly the next release (version sort; rc, off-main and
  #    same-named-branch cases) and stays attached with its upstream.
  $null = New-FixtureClone 'behind'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'branch', 'v0.10.0', $C2)
  $next = Get-CoopRepoNextRelease
  $nudge = Invoke-Captured { Invoke-CoopUpdateNudge }
  if ($next -ne 'v0.10.0') { Ko "at v0.9.0 the next release is v0.10.0, not rc, v1, v0.99 or v0.10.0.1 (got '$next')" }
  elseif ((Get-CoopRepoBehindCount) -ne 1) { Ko 'at v0.9.0 behind should be 1' }
  elseif (-not $nudge.Contains('1 commit(s) behind release v0.10.0')) { Ko 'the launch nudge should name the release' $nudge }
  else { Ok 'behind: next release v0.10.0, 1 behind, nudge names the release' }
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
  if ((Get-At) -ne $C2) { Ko 'should land exactly on v0.10.0, not head of main' $out }
  elseif ((Get-BranchRef) -ne 'refs/heads/main' -or (Get-Upstream) -ne 'refs/remotes/origin/main') { Ko 'main must stay attached and keep its upstream' }
  elseif (Get-CoopRepoNextRelease) { Ko 'on the newest release the next release must be empty (rc, v0.99, v0.10.0.1 and v1 are not releases)' }
  elseif ((Get-CoopRepoBehindCount) -ne 0) { Ko 'on the newest release, unreleased commits on main must read 0 behind' }
  elseif ((Invoke-Captured { Invoke-CoopUpdateNudge }).Trim()) { Ko 'on the newest release, unreleased commits on main must not nudge' }
  else { Ok 'behind: fast-forwards to exactly v0.10.0 on main; then 0 behind and no nudge despite unreleased main' }
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
  if ((Get-At) -ne $C2 -or $out.Contains('moved')) { Ko 'a second run must be a quiet no-op' $out }
  else { Ok 'a second run is a no-op' }

  # 2b. A tag named like the branch (a stray 'main' tag, which every fetch
  #     auto-follows) must not turn main into a hold in either mode.
  $null = New-FixtureClone 'tag-main'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'tag', 'main', $C1)
  $s = Get-CoopRepoStranded
  if ($null -ne $s) { Ko "a tag named main must not make main a hold (got: $($s.Message))" }
  elseif ((Get-CoopRepoNextRelease) -ne 'v0.10.0') { Ko 'a tag named main must not hide the next release' }
  else {
    $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
    if ((Get-At) -ne $C2 -or (Get-BranchRef) -ne 'refs/heads/main') { Ko 'a tag named main must not stop the release move' $out }
    else {
      $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $true }
      if ((Get-At) -ne $C4 -or (Get-BranchRef) -ne 'refs/heads/main') { Ko 'a tag named main must not stop --edge' $out }
      else { Ok 'a tag named main: main still follows releases, and --edge still pulls' }
    }
  }
  # The -Edge local-main guard's hint, pasted into PowerShell, lists the unpushed
  # commit: it names refs/heads/main, since a bare 'main' would read the tag.
  $null = New-FixtureClone 'tag-main-edge'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'tag', 'main', $C1)
  Add-FixtureCommit $script:CoopRoot 'unpushed-work' 'unpushed'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'checkout', '-q', '--detach', 'v0.9.0')
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $true }
  $cmd = ''
  if ($out -cmatch 'see: (git [^\r\n]+)') { $cmd = $Matches[1] }
  if (-not $out.Contains('local branch main has commits') -or -not $cmd) { Ko '--edge should warn about local main with a hint' $out }
  elseif (-not (Get-PastedOutput $cmd).Contains('unpushed-work')) { Ko 'the --edge local-main hint must list the unpushed commit when a tag is named main' $cmd }
  else { Ok 'a tag named main: the --edge local-main hint lists the unpushed commit' }

  # 3. Dirty tracked file: the move is skipped.
  $null = New-FixtureClone 'dirty'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  [System.IO.File]::AppendAllText((Join-Path $script:CoopRoot 'README'), "local edit`n")
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
  if ((Get-At) -ne $C1 -or -not $out.Contains('uncommitted')) { Ko 'a dirty checkout must warn and not move' $out }
  else { Ok 'dirty tracked files skip the move' }

  # 3b. No source loss: an untracked file where the release adds one blocks the move.
  $null = New-FixtureClone 'untracked'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  $f2 = Join-Path $script:CoopRoot 'f2'
  [System.IO.File]::WriteAllText($f2, "mine`n")
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
  if ((Get-At) -ne $C1) { Ko 'the move must refuse to overwrite an untracked file' $out }
  elseif ([System.IO.File]::ReadAllText($f2) -ne "mine`n") { Ko "the untracked file's content changed" $out }
  elseif (-not $out.Contains('could not fast-forward coop-agent to v0.10.0')) { Ko 'a refused move should warn' $out }
  else { Ok 'an untracked file in the way: move refused, file intact' }

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

  # 5b. -Edge on an attached main pulls the head of main.
  $null = New-FixtureClone 'edge-attached'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $true }
  if ((Get-At) -ne $C4 -or (Get-BranchRef) -ne 'refs/heads/main') { Ko '--edge on main should pull head of main and stay attached' $out }
  else { Ok '--edge: pulls head of main on an attached main' }

  # 5c. -Edge guard: a detached commit that is not on origin/main stays put.
  $null = New-FixtureClone 'edge-local-commit' @('--branch', 'v0.9.0')
  Add-FixtureCommit $script:CoopRoot 'local-work' 'local'
  $l = Get-At
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $true }
  if ((Get-At) -ne $l -or (Get-BranchRef)) { Ko '--edge must not leave a detached local commit' $out }
  elseif (-not $out.Contains('not on origin/main')) { Ko '--edge should warn about the local commit' $out }
  else { Ok '--edge guard: a detached local commit stays put' }

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

  # 7. Hold: a branch with no upstream is not fetched or moved, and the state is
  #    named. Its origin gains a commit after the clone (its own copy, so later
  #    cases keep c4).
  $holdOrigin = Join-Path $t 'origin-hold.git'
  Invoke-FixtureGit @('clone', '-q', '--bare', $script:Origin, $holdOrigin)
  $null = New-FixtureClone 'hold' @() $holdOrigin
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'checkout', '-q', '-b', 'hold', 'v0.9.0')
  $writer = Join-Path $t 'hold-writer'
  Invoke-FixtureGit @('clone', '-q', $holdOrigin, $writer)
  Add-FixtureCommit $writer 'c5' 'f5'
  Invoke-FixtureGit @('-C', $writer, 'push', '-q', 'origin', 'main')
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
  $s = Get-CoopRepoStranded
  if ((Get-FixtureGit @('-C', $script:CoopRoot, 'rev-parse', 'refs/remotes/origin/main')) -ne $C4) { Ko 'a hold must not be fetched' $out }
  elseif ((Get-At) -ne $C1 -or (Get-CoopRepoBehindCount) -ne 0) { Ko 'a hold must not move and reads 0 behind' $out }
  elseif ($null -eq $s -or -not $s.Message.Contains("held on branch 'hold'") -or -not $s.Hint.Contains('switch main')) { Ko 'the hold should be named with the fix' }
  else { Ok 'hold branch: not fetched, not moved, named with the fix' }
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $true }
  if ((Get-At) -ne $C1 -or -not $out.Contains("held on branch 'hold'")) { Ko '--edge has nothing to pull on a hold with no upstream and should name it' $out }
  else { Ok '--edge on a hold with no upstream: not moved, named' }

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

  # 7c. Keyed on the upstream being origin/main, not on having one: the usual hold
  #     (`git switch pinned`, which tracks origin/pinned) and a main that tracks
  #     another remote's main are holds. Default mode neither fetches nor moves
  #     them; -Edge pulls the hold's own upstream.
  Invoke-FixtureGit @('-C', $writer, 'push', '-q', 'origin', ($C1 + ':refs/heads/pinned'))
  $null = New-FixtureClone 'pinned' @() $holdOrigin
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'checkout', '-q', '-b', 'pinned', '--track', 'origin/pinned')
  Invoke-FixtureGit @('-C', $writer, 'checkout', '-q', '-b', 'pinned', $C1)
  Add-FixtureCommit $writer 'p2' 'fp'
  Invoke-FixtureGit @('-C', $writer, 'push', '-q', 'origin', 'pinned')
  $p2 = Get-FixtureGit @('-C', $writer, 'rev-parse', 'HEAD')
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
  if ((Get-At) -ne $C1) { Ko 'a branch tracking origin/pinned is a hold: default mode must not move it' $out }
  elseif ((Get-FixtureGit @('-C', $script:CoopRoot, 'rev-parse', 'refs/remotes/origin/pinned')) -ne $C1) { Ko 'a hold with an upstream must not be fetched' $out }
  elseif (-not $out.Contains("held on branch 'pinned'")) { Ko 'step 1 should name the pinned hold' $out }
  else { Ok 'hold tracking origin/pinned: not fetched, not moved, named' }
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $true }
  if ((Get-At) -ne $p2 -or (Get-BranchRef) -ne 'refs/heads/pinned') { Ko "--edge should pull a hold's own upstream" $out }
  else { Ok "--edge pulls a hold's own upstream" }
  $null = New-FixtureClone 'fork-main'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'remote', 'add', 'fork', $script:Origin)
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'fetch', '-q', 'fork')
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'branch', '-q', '--set-upstream-to=fork/main')
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
  $s = Get-CoopRepoStranded
  if ((Get-At) -ne $C1) { Ko 'a main that tracks fork/main is a hold' $out }
  elseif ($null -eq $s -or -not $s.Hint.Contains('branch --set-upstream-to=origin/main main')) { Ko 'a main tracking fork/main should be named with the fix' }
  else { Ok 'main tracking fork/main: a hold, named with the fix' }

  # 8. Diverged: a local commit blocks the next release; named, 0 behind.
  $null = New-FixtureClone 'diverged'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'branch', 'my-work')   # a leftover from an earlier rejoin
  Add-FixtureCommit $script:CoopRoot 'local-work' 'local'
  $l = Get-At
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
  $s = Get-CoopRepoStranded
  if ((Get-At) -ne $l -or (Get-CoopRepoBehindCount) -ne 0) { Ko 'a diverged checkout must not move and reads 0 behind' $out }
  elseif ($null -eq $s -or -not $s.Message.Contains('release v0.10.0 does not contain') -or -not $s.Hint.Contains('reset --keep v0.10.0')) { Ko 'the diverged state should be named with the fix' }
  else { Ok 'diverged: not moved, 0 behind, named with the fix' }
  # The printed fix, pasted into PowerShell, rejoins the release and keeps the
  # local commit on a branch, even with a leftover my-work branch.
  if ($null -ne $s) { Invoke-Hint $s.Hint }
  if ((Get-At) -ne $C2 -or (Get-BranchRef) -ne 'refs/heads/main') { Ko 'the printed fix should rejoin release v0.10.0 on main' $s.Hint }
  elseif (-not (Get-FixtureGit @('-C', $script:CoopRoot, 'branch', '--contains', $l))) { Ko 'the printed fix must keep the local commit on a branch' $s.Hint }
  else { Ok 'diverged: the printed fix rejoins and keeps the local commit on a branch' }
  # If the aside branch cannot be made, the fix must not reset (no orphaned commit).
  $null = New-FixtureClone 'diverged-collide'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  Add-FixtureCommit $script:CoopRoot 'local-work' 'local'
  $l = Get-At
  $s = Get-CoopRepoStranded
  $aside = ''
  if ($null -ne $s -and $s.Hint -cmatch ' branch (\S+);') { $aside = $Matches[1] }
  if (-not $aside) { Ko 'the diverged hint should name its aside branch' }
  else {
    Invoke-FixtureGit @('-C', $script:CoopRoot, 'branch', $aside, $C1)
    Invoke-Hint $s.Hint
    if ((Get-At) -ne $l -or (Get-FixtureGit @('-C', $script:CoopRoot, 'rev-parse', 'refs/heads/main')) -ne $l) { Ko 'the printed fix reset although its aside branch could not be made' $s.Hint }
    else { Ok 'diverged: the printed fix never resets without its aside branch' }
  }

  # 9. Offline: a failed fetch warns and still moves on known tags.
  $null = New-FixtureClone 'offline'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'remote', 'set-url', 'origin', (Join-Path $t 'missing.git'))
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
  if (-not $out.Contains('could not fetch from origin')) { Ko 'a failed fetch should warn' $out }
  elseif ((Get-At) -ne $C2) { Ko 'offline, the move should use the releases already fetched' $out }
  else { Ok 'offline: warns and moves to a release it already knows' }

  # 10. A tag-only shallow clone has no origin/main: named, and the printed fix works.
  $u = $script:Origin -replace '\\', '/'
  $url = if ($u.StartsWith('/')) { 'file://' + $u } else { 'file:///' + $u }
  $null = New-FixtureClone 'shallow' @('--depth', '1', '--branch', 'v0.9.0') $url
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
  $s = Get-CoopRepoStranded
  if ((Get-At) -ne $C1) { Ko 'a tag-only clone cannot move' $out }
  elseif (-not $out.Contains('no origin/main to follow') -or $null -eq $s -or -not $s.Hint.Contains("remote set-branches origin '*'")) { Ko 'step 1 should name the missing origin/main and the fix' $out }
  else {
    Invoke-Hint $s.Hint
    $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
    if ((Get-At) -ne $C2) { Ko 'after the printed fix the clone should follow releases' $out }
    else { Ok 'tag-only shallow clone: no origin/main is named; the printed fix makes it follow releases' }
  }

  # 11. No origin remote (renamed or removed) is named as such, not as a hold,
  #     with a fix that works when run as printed.
  $null = New-FixtureClone 'renamed-remote'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'remote', 'rename', 'origin', 'upstream')
  $s = Get-CoopRepoStranded
  if ($null -eq $s -or -not $s.Message.StartsWith('coop-agent has no origin remote') -or -not $s.Hint.EndsWith('remote rename upstream origin')) { Ko 'a renamed origin should be named with the rename fix' "$($s.Message) / $($s.Hint)" }
  else {
    Invoke-Hint $s.Hint
    $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
    if ($null -ne (Get-CoopRepoStranded) -or (Get-At) -ne $C2) { Ko 'after the printed rename fix the checkout should follow releases' $out }
    else { Ok 'renamed origin: named, and the printed fix restores release following' }
  }
  $null = New-FixtureClone 'removed-remote'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'remote', 'remove', 'origin')
  $s = Get-CoopRepoStranded
  $canonical = 'https://github.com/kabukisensei/coop-agent.git'
  if ($null -eq $s -or -not $s.Message.StartsWith('coop-agent has no origin remote') -or -not $s.Hint.Contains("remote add origin $canonical")) { Ko 'a removed origin should be named with the add fix' "$($s.Message) / $($s.Hint)" }
  else {
    # Offline stand-in for the canonical URL: the add fix, then the fix it leads to.
    Invoke-Hint $s.Hint.Replace($canonical, ('"' + $script:Origin + '"'))
    $s = Get-CoopRepoStranded
    if ($null -ne $s) { Invoke-Hint $s.Hint }
    $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
    if ((Get-At) -ne $C2) { Ko 'after the printed fixes the checkout should follow releases' $out }
    else { Ok 'removed origin: named, and the printed fixes restore release following' }
  }
  # Two remotes: origin renamed to upstream, then a fork added (it sorts first).
  # The rename names the branch's remote, never the first one `git remote` lists.
  $null = New-FixtureClone 'renamed-remote-fork'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'remote', 'rename', 'origin', 'upstream')
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'remote', 'add', 'fork', (Join-Path $t 'fork.git'))
  $s = Get-CoopRepoStranded
  if ($null -eq $s -or -not $s.Hint.EndsWith('remote rename upstream origin')) { Ko "with a fork added, the rename fix must name the branch's remote (upstream)" "$($s.Message) / $($s.Hint)" }
  else {
    Invoke-Hint $s.Hint
    $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
    if ((Get-At) -ne $C2) { Ko 'after the printed rename fix (fork present) the checkout should follow releases' $out }
    else { Ok "renamed origin beside a fork: the rename names the branch's remote, and works" }
  }
  # No branch remote to go by (detached): two remotes with no canonical URL are
  # ambiguous, so the fix adds origin; one canonical URL is renamed. A branch whose
  # remote is not the canonical one while another remote is, is ambiguous too.
  # (Text only: running these would reach GitHub.)
  $null = New-FixtureClone 'renamed-remote-detached' @('--branch', 'v0.9.0')
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'remote', 'rename', 'origin', 'upstream')
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'remote', 'add', 'fork', (Join-Path $t 'fork.git'))
  $sAdd = Get-CoopRepoStranded
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'remote', 'set-url', 'upstream', $canonical)
  $sRename = Get-CoopRepoStranded
  $null = New-FixtureClone 'fork-tracking-no-origin'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'remote', 'add', 'fork', $script:Origin)
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'fetch', '-q', 'fork')
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'branch', '-q', '--set-upstream-to=fork/main')
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'remote', 'rename', 'origin', 'upstream')
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'remote', 'set-url', 'upstream', $canonical)
  $sFork = Get-CoopRepoStranded
  if ($null -eq $sAdd -or -not $sAdd.Hint.Contains("remote add origin $canonical")) { Ko 'two remotes and no branch remote: the fix must add origin, not rename one' "$($sAdd.Message) / $($sAdd.Hint)" }
  elseif ($null -eq $sRename -or -not $sRename.Hint.EndsWith('remote rename upstream origin')) { Ko 'the one remote at the canonical URL should be named for the rename' "$($sRename.Message) / $($sRename.Hint)" }
  elseif ($null -eq $sFork -or -not $sFork.Hint.Contains("remote add origin $canonical")) { Ko 'a branch tracking a fork beside a canonical remote must not rename the fork' "$($sFork.Message) / $($sFork.Hint)" }
  else { Ok 'no origin remote with two remotes: the rename names the one canonical URL, else adds origin' }

  # 12. A release tagged after the clone is fetched by step 1 and followed.
  $newOrigin = Join-Path $t 'origin-new.git'
  Invoke-FixtureGit @('clone', '-q', '--bare', $script:Origin, $newOrigin)
  $null = New-FixtureClone 'new-release' @() $newOrigin
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.10.0')
  Invoke-FixtureGit @('-C', $seed, 'tag', '-a', 'v0.12.0', '-m', 'v0.12.0', $C4)
  Invoke-FixtureGit @('-C', $seed, 'push', '-q', $newOrigin, 'v0.12.0')
  $out = Invoke-Captured { Invoke-CoopRepoFollowRelease $false }
  if ((Get-At) -ne $C4 -or -not $out.Contains('to release v0.12.0')) { Ko 'a release tagged after the clone should be fetched and followed' $out }
  else { Ok 'a release tagged after the clone: fetched and followed' }

  # 13. The doctor row (Get-CoopRepoDoctorRow): behind is a warn to update; a
  #     stranded state (diverged, hold) is a warn with its fix; else ok. doctor.ps1
  #     only dispatches it.
  $null = New-FixtureClone 'row-ahead'
  $rAhead = Get-CoopRepoDoctorRow
  $null = New-FixtureClone 'row-behind'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  $rBehind = Get-CoopRepoDoctorRow
  $null = New-FixtureClone 'row-diverged'
  Invoke-FixtureGit @('-C', $script:CoopRoot, 'reset', '-q', '--hard', 'v0.9.0')
  Add-FixtureCommit $script:CoopRoot 'local-work' 'local'
  $rDiverged = Get-CoopRepoDoctorRow
  $script:CoopRoot = Join-Path $t 'hold'
  $rHold = Get-CoopRepoDoctorRow
  if ($rAhead.Level -cne 'ok' -or $rAhead.Message -notlike 'coop-agent v0.10.0-2-g*(follows release tags via: coop update)') { Ko 'doctor row: ahead of every release is ok and names the describe' "$($rAhead.Level) $($rAhead.Message)" }
  elseif ($rBehind.Level -cne 'warn' -or $rBehind.Message -cne 'coop-agent is 1 commit(s) behind release v0.10.0' -or $rBehind.Hint -cne 'run: coop update') { Ko 'doctor row: behind names the release and coop update' "$($rBehind.Level) $($rBehind.Message) / $($rBehind.Hint)" }
  elseif ($rDiverged.Level -cne 'warn' -or -not $rDiverged.Message.Contains('release v0.10.0 does not contain') -or -not $rDiverged.Hint.StartsWith('set them aside and rejoin: ') -or -not $rDiverged.Hint.Contains('reset --keep v0.10.0')) { Ko 'doctor row: a diverged checkout is a warn with the fix as the hint' "$($rDiverged.Level) $($rDiverged.Message) / $($rDiverged.Hint)" }
  elseif ($rHold.Level -cne 'warn' -or -not $rHold.Message.Contains("held on branch 'hold'") -or -not $rHold.Hint.EndsWith('switch main')) { Ko 'doctor row: a hold is a warn with the fix as the hint' "$($rHold.Level) $($rHold.Message) / $($rHold.Hint)" }
  else { Ok 'doctor row: ok when current; warns behind, diverged and hold with the fix as the hint' }
  $doctorPs = [System.IO.File]::ReadAllText((Join-Path (Join-Path $root 'scripts') 'doctor.ps1'))
  if (-not $doctorPs.Contains('$repoRow = Get-CoopRepoDoctorRow') -or -not $doctorPs.Contains('if ($repoRow.Level -ceq ''ok'') { D-Ok $repoRow.Message } else { D-Warn $repoRow.Message $repoRow.Hint }')) { Ko 'doctor.ps1 must dispatch Get-CoopRepoDoctorRow: ok, else warn with the hint' }
  else { Ok 'doctor.ps1 dispatches the shared repo row' }
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

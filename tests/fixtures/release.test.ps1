#!/usr/bin/env pwsh
# Exercises the real coop.ps1 release
# path in disposable repositories: every "origin" is a local bare repo, so nothing
# leaves this machine. The tag may only reach origin together with main (#105).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-release-ps-' + [guid]::NewGuid().ToString('N'))


# A coop checkout on main with a bare origin at <dir>.git, main == origin/main.
function New-ReleaseFixture([string]$Path) {
  New-Item -ItemType Directory -Force -Path $Path, (Join-Path $Path 'bin'), (Join-Path $Path 'lib'), (Join-Path $Path 'config'), (Join-Path $Path 'extensions') | Out-Null
  Copy-Item (Join-Path $root 'bin\coop.ps1') (Join-Path $Path 'bin\coop.ps1')
  Copy-Item (Join-Path $root 'lib\common.ps1') (Join-Path $Path 'lib\common.ps1')
  Copy-Item (Join-Path $root 'lib\_yaml.py') (Join-Path $Path 'lib\_yaml.py')
  Copy-Item (Join-Path $root 'VERSION') (Join-Path $Path 'VERSION')
  Copy-Item (Join-Path $root 'CHANGELOG.md') (Join-Path $Path 'CHANGELOG.md')
  Copy-Item (Join-Path $root 'config\release-manifest.json') (Join-Path $Path 'config\release-manifest.json')
  Get-ChildItem (Join-Path $root 'extensions') -Directory | ForEach-Object {
    $source = Join-Path $_.FullName 'package.json'
    if (Test-Path -LiteralPath $source) {
      $dest = Join-Path (Join-Path $Path 'extensions') $_.Name
      New-Item -ItemType Directory -Force -Path $dest | Out-Null
      Copy-Item $source (Join-Path $dest 'package.json')
    }
  }
  $origin = $Path + '.git'
  Invoke-FixtureGit @('-C', $Path, 'init', '-q')
  Invoke-FixtureGit @('-C', $Path, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  Invoke-FixtureGit @('-C', $Path, 'add', '.')
  Invoke-FixtureGit @('-C', $Path, 'commit', '-q', '-m', 'fixture')
  Invoke-FixtureGit @('init', '-q', '--bare', $origin)
  Invoke-FixtureGit @('-C', $origin, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  Invoke-FixtureGit @('-C', $Path, 'remote', 'add', 'origin', $origin)
  Invoke-FixtureGit @('-C', $Path, 'push', '-q', '-u', 'origin', 'main')
}

# Run the fixture's own coop.ps1 release in-process. Coop-Emit writes through
# [Console]::Error, so capture it the way update-follow.test.ps1 does; the exit
# code lands in $script:releaseRc.
function Invoke-Release([string]$Dir, [string[]]$ReleaseArgs) {
  $ErrorActionPreference = 'Continue'
  $coop = Join-Path (Join-Path $Dir 'bin') 'coop.ps1'
  $writer = New-Object System.IO.StringWriter
  $previous = [Console]::Error
  $streams = ''
  $script:releaseRc = $null
  try {
    [Console]::SetError($writer)
    $streams = & $coop release @ReleaseArgs 2>&1 6>&1 | Out-String
    $script:releaseRc = $LASTEXITCODE
  } finally { [Console]::SetError($previous) }
  return ($writer.ToString() + $streams)
}

$saved = Save-Env @('HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'COOP_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'NO_COLOR')
New-Item -ItemType Directory -Force -Path $temp, (Join-Path $temp 'home') | Out-Null
try {
  # Hermetic git: no user or system config, a fixed identity.
  $env:HOME = Join-Path $temp 'home'
  $env:GIT_CONFIG_NOSYSTEM = '1'
  $env:GIT_AUTHOR_NAME = 'Coop Release Test'; $env:GIT_AUTHOR_EMAIL = 'coop-release-test@example.invalid'
  $env:GIT_COMMITTER_NAME = 'Coop Release Test'; $env:GIT_COMMITTER_EMAIL = 'coop-release-test@example.invalid'
  $env:COOP_AGENT_DIR = Join-Path $temp 'agent'
  $env:NO_COLOR = '1'

  $current = (Get-Content (Join-Path $root 'VERSION') -Raw).Trim()
  $parts = $current.Split('.')
  $next = "$($parts[0]).$($parts[1]).$([int]$parts[2] + 1)"

  Write-Host '-> coop.ps1 release keeps every version authority in one transaction'
  $fixture = Join-Path $temp 'happy'
  New-ReleaseFixture $fixture
  $releaseOut = Invoke-Release $fixture @('patch', '--yes', '--no-push', '--no-check')
  if ($script:releaseRc -eq 0) { Ok 'fixture release exits zero' } else { Ko 'fixture release failed' $releaseOut }

  $manifest = Get-Content (Join-Path $fixture 'config\release-manifest.json') -Raw | ConvertFrom-Json
  $packagesOk = $true
  Get-ChildItem (Join-Path $fixture 'extensions') -Directory | ForEach-Object {
    $package = Get-Content (Join-Path $_.FullName 'package.json') -Raw | ConvertFrom-Json
    if ($package.version -ne $next) { $packagesOk = $false }
  }
  if (((Get-Content (Join-Path $fixture 'VERSION') -Raw).Trim() -eq $next) -and
      ($manifest.coop_version -eq $next) -and $packagesOk) {
    Ok "VERSION, release manifest, and extension manifests share $next"
  } else { Ko 'released version authorities diverged' }
  if (Get-FixtureGit @('-C', $fixture, 'rev-parse', '-q', '--verify', "refs/tags/v$next")) { Ok "release tag v$next exists" } else { Ko "release tag v$next missing" }
  if (-not (Get-FixtureGit @('-C', $fixture, 'status', '--porcelain'))) { Ok 'release commit includes every generated change' } else { Ko 'release left uncommitted files' }
  if (-not (Get-FixtureGit @('-C', ($fixture + '.git'), 'tag', '-l'))) { Ok '--no-push leaves origin untouched' } else { Ko '--no-push pushed a tag' }

  Write-Host '-> coop.ps1 release rejects a pre-existing manifest/VERSION mismatch'
  $bad = Join-Path $temp 'mismatch'
  New-ReleaseFixture $bad
  $badManifestPath = Join-Path $bad 'config\release-manifest.json'
  $badRaw = Get-Content $badManifestPath -Raw
  $badRaw = [regex]::Replace($badRaw, '(?m)^(\s*"coop_version"\s*:\s*")[^"]*(".*)$', '${1}0.0.0${2}')
  [System.IO.File]::WriteAllText($badManifestPath, ($badRaw -replace "`r`n", "`n"))
  Invoke-FixtureGit @('-C', $bad, 'add', 'config/release-manifest.json')
  Invoke-FixtureGit @('-C', $bad, 'commit', '-q', '-m', 'mismatch')
  Invoke-FixtureGit @('-C', $bad, 'push', '-q', 'origin', 'main')
  $badOut = Invoke-Release $bad @('patch', '--yes', '--no-push', '--no-check')
  if ($script:releaseRc -ne 0) { Ok 'mismatched release is rejected' } else { Ko 'mismatched release unexpectedly succeeded' $badOut }
  if ($badOut.Contains('does not match VERSION')) { Ok 'rejection identifies the inconsistent manifest' } else { Ko 'mismatch rejection lacks actionable explanation' $badOut }

  Write-Host '-> coop.ps1 release pushes main and the tag together (#105)'
  $pushed = Join-Path $temp 'pushed'
  New-ReleaseFixture $pushed
  $out = Invoke-Release $pushed @('patch', '--yes', '--no-check')
  if ($script:releaseRc -eq 0) { Ok 'pushed release exits zero' } else { Ko 'pushed release failed' $out }
  if ((Get-FixtureGit @('-C', ($pushed + '.git'), 'rev-parse', '-q', '--verify', 'refs/heads/main')) -eq (Get-FixtureGit @('-C', $pushed, 'rev-parse', 'HEAD'))) {
    Ok 'origin main is the release commit'
  } else { Ko 'origin main is not the release commit' $out }
  $null = Get-FixtureGit @('-C', ($pushed + '.git'), 'merge-base', '--is-ancestor', "v$next", 'refs/heads/main')
  if ($LASTEXITCODE -eq 0) { Ok "origin tag v$next is on origin main" } else { Ko "origin tag v$next missing or off main" $out }

  Write-Host '-> a rejected branch push pushes no tag (#105)'
  $rejected = Join-Path $temp 'rejected'
  New-ReleaseFixture $rejected
  $before = Get-FixtureGit @('-C', ($rejected + '.git'), 'rev-parse', 'refs/heads/main')
  # origin refuses every update to main, as a protected branch or a lost race would.
  $hook = Join-Path (Join-Path ($rejected + '.git') 'hooks') 'update'
  $hookBody = @'
#!/bin/sh
[ "$1" = refs/heads/main ] && { echo "main is protected" >&2; exit 1; }
exit 0
'@
  [System.IO.File]::WriteAllText($hook, (($hookBody -replace "`r`n", "`n").TrimEnd() + "`n"))
  if ($env:OS -ne 'Windows_NT') { & chmod +x $hook }
  $out = Invoke-Release $rejected @('patch', '--yes', '--no-check')
  if ($script:releaseRc -ne 0) { Ok 'rejected push fails the release' } else { Ko 'rejected push still exits zero' $out }
  $originTags = Get-FixtureGit @('-C', ($rejected + '.git'), 'tag', '-l')
  if (-not $originTags) { Ok 'origin has no tag after the rejected branch push' } else { Ko "tag reached origin without main: $originTags" $out }
  if ((Get-FixtureGit @('-C', ($rejected + '.git'), 'rev-parse', 'refs/heads/main')) -eq $before) { Ok 'origin main is unchanged' } else { Ko 'origin main moved despite the rejection' $out }
  if ($out.Contains("git push --atomic origin main v$next")) { Ok 'failure names the atomic retry' } else { Ko 'failure lacks the retry command' $out }

  # Each refusal must happen before the release changes anything, here or on origin.
  function Assert-Refused([string]$Dir, [string]$Label, [string]$Want) {
    $head0 = Get-FixtureGit @('-C', $Dir, 'rev-parse', 'HEAD')
    $out = Invoke-Release $Dir @('patch', '--yes', '--no-check')
    if ($script:releaseRc -ne 0) { Ok "${Label}: refused" } else { Ko "${Label}: release was not refused" $out }
    if ($out.Contains($Want)) { Ok "${Label}: names the fix" } else { Ko "${Label}: message lacks '$Want'" $out }
    if (((Get-FixtureGit @('-C', $Dir, 'rev-parse', 'HEAD')) -eq $head0) -and
        (-not (Get-FixtureGit @('-C', $Dir, 'status', '--porcelain'))) -and
        (-not (Get-FixtureGit @('-C', $Dir, 'rev-parse', '-q', '--verify', "refs/tags/v$next"))) -and
        ((Get-Content (Join-Path $Dir 'VERSION') -Raw).Trim() -eq $current) -and
        (-not (Get-FixtureGit @('-C', ($Dir + '.git'), 'tag', '-l')))) {
      Ok "${Label}: nothing changed locally or on origin"
    } else { Ko "${Label}: the refused release still changed something" $out }
  }

  Write-Host '-> coop.ps1 release refuses a detached HEAD, another branch, or main != origin/main (#105)'
  $detached = Join-Path $temp 'detached'
  New-ReleaseFixture $detached
  Invoke-FixtureGit @('-C', $detached, 'checkout', '-q', '--detach')
  Assert-Refused $detached 'detached HEAD' 'HEAD is detached'

  $branch = Join-Path $temp 'branch'
  New-ReleaseFixture $branch
  Invoke-FixtureGit @('-C', $branch, 'checkout', '-q', '-b', 'topic')
  Assert-Refused $branch 'branch topic' "on branch 'topic'"

  $behind = Join-Path $temp 'behind'
  New-ReleaseFixture $behind
  # Someone else merges to origin/main after this clone last fetched.
  $other = Join-Path $temp 'behind-other'
  Invoke-FixtureGit @('clone', '-q', ($behind + '.git'), $other)
  Invoke-FixtureGit @('-C', $other, 'commit', '-q', '--allow-empty', '-m', 'merged elsewhere')
  Invoke-FixtureGit @('-C', $other, 'push', '-q', 'origin', 'main')
  Assert-Refused $behind 'main behind origin/main' '0 ahead, 1 behind'

  $ahead = Join-Path $temp 'ahead'
  New-ReleaseFixture $ahead
  Invoke-FixtureGit @('-C', $ahead, 'commit', '-q', '--allow-empty', '-m', 'local only')
  Assert-Refused $ahead 'main ahead of origin/main' '1 ahead, 0 behind'
}
finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

exit $fail

#!/usr/bin/env pwsh
# coop.ps1 release is a forwarder: the one release implementation is
# scripts/release.sh (bash dev tooling; tests/release-gate.test.sh exercises it
# in disposable repositories). This proves the PowerShell side hands every
# argument to that script, under bash, and passes its exit code through. A
# stand-in release.sh records what it received, so no git or origin is touched.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-release-ps-' + [guid]::NewGuid().ToString('N'))

# A coop checkout with the files coop.ps1 needs to start, and a stand-in release.sh.
function New-ReleaseFixture([string]$Path) {
  New-Item -ItemType Directory -Force -Path $Path, (Join-Path $Path 'bin'), (Join-Path $Path 'lib'), (Join-Path $Path 'config'), (Join-Path $Path 'scripts'), (Join-Path $Path 'extensions') | Out-Null
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
  # The stand-in: one line with the arguments it received, then exit 7. LF, no BOM.
  $stub = "#!/usr/bin/env bash`nprintf 'release.sh received: [%s] in %s\n' `"`$*`" `"`$(pwd)`"`nexit 7`n"
  [System.IO.File]::WriteAllText((Join-Path $Path 'scripts\release.sh'), $stub, (New-Object System.Text.UTF8Encoding $false))
  # A checkout, as coop.ps1 expects to run from one (git describe, staleness); no origin.
  Invoke-FixtureGit @('-C', $Path, 'init', '-q')
  Invoke-FixtureGit @('-C', $Path, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  Invoke-FixtureGit @('-C', $Path, 'add', '.')
  Invoke-FixtureGit @('-C', $Path, 'commit', '-q', '-m', 'fixture')
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

  Write-Host '-> coop.ps1 release forwards its arguments to scripts/release.sh and returns its exit code'
  $fixture = Join-Path $temp 'forward'
  New-ReleaseFixture $fixture
  $out = Invoke-Release $fixture @('--yes', '--no-check')
  if ($script:releaseRc -eq 7) { Ok 'the exit code is release.sh''s (7)' } else { Ko "exit code $($script:releaseRc), expected release.sh's 7" $out }
  if ($out.Contains('release.sh received: [--yes --no-check]')) { Ok 'every argument reaches release.sh in order' } else { Ko 'release.sh did not receive the arguments' $out }

  Write-Host '-> the bump levels reach release.sh too (it names the release pull request)'
  $out = Invoke-Release $fixture @('patch')
  if ($script:releaseRc -eq 7 -and $out.Contains('release.sh received: [patch]')) { Ok 'coop release patch is release.sh''s to refuse' } else { Ko "coop release patch (rc=$($script:releaseRc))" $out }

  Write-Host '-> nothing is bumped, committed or tagged on the PowerShell side'
  $afterVersion = (Get-Content (Join-Path $fixture 'VERSION') -Raw).Trim()
  $beforeVersion = (Get-Content (Join-Path $root 'VERSION') -Raw).Trim()
  if ($afterVersion -eq $beforeVersion -and -not (Get-FixtureGit @('-C', $fixture, 'status', '--porcelain')) -and -not (Get-FixtureGit @('-C', $fixture, 'tag', '-l'))) { Ok 'VERSION is untouched, the tree is clean and nothing is tagged' } else { Ko 'the forwarder changed the tree' }
}
finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

exit $fail

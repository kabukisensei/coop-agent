#!/usr/bin/env pwsh
# Repo-staleness helpers: Invoke-CoopRepoFetchThrottled
# + Get-CoopRepoBehindCount + Invoke-CoopUpdateNudge in lib/common.ps1. Fully offline:
# the "origin" is a local repo in the sandbox, so `git fetch` never touches the
# network. The count is against the next release tag (H5);
# tests/fixtures/update-follow.test.ps1 covers the release boundaries.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-staleness-' + [guid]::NewGuid().ToString('N'))
# Coop-Warn writes through [Console]::Error; capture it the way update-follow does.
function Invoke-Captured([scriptblock]$Body) {
  $writer = New-Object System.IO.StringWriter
  $previous = [Console]::Error
  try { [Console]::SetError($writer); & $Body } finally { [Console]::SetError($previous) }
  return $writer.ToString()
}

$saved = Save-Env @('HOME', 'USERPROFILE', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'COOP_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'COOP_NO_ISOLATE', 'NO_COLOR', 'COOP_SKIP_AZ')
try {
  New-Item -ItemType Directory -Force -Path $t, (Join-Path $t 'home') | Out-Null
  # Hermetic git: no user or system config, a fixed identity.
  $env:HOME = Join-Path $t 'home'
  $env:USERPROFILE = $env:HOME
  $env:GIT_CONFIG_NOSYSTEM = '1'
  $env:GIT_AUTHOR_NAME = 't'; $env:GIT_AUTHOR_EMAIL = 't@t'
  $env:GIT_COMMITTER_NAME = 't'; $env:GIT_COMMITTER_EMAIL = 't@t'
  $env:NO_COLOR = '1'
  $env:COOP_SKIP_AZ = '1'
  # The fetch marker lives in the effective agent dir: keep it inside the sandbox.
  $env:COOP_AGENT_DIR = Join-Path $t 'agent'
  Remove-Item Env:\PI_CODING_AGENT_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:\COOP_NO_ISOLATE -ErrorAction SilentlyContinue

  # A local "origin" with two commits, and a clone of it.
  $origin = Join-Path $t 'origin'
  $clone = Join-Path $t 'clone'
  Invoke-FixtureGit @('init', '--quiet', $origin)
  Invoke-FixtureGit @('-C', $origin, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  Invoke-FixtureGit @('-C', $origin, 'commit', '--allow-empty', '-qm', 'one')
  Invoke-FixtureGit @('-C', $origin, 'commit', '--allow-empty', '-qm', 'two')
  Invoke-FixtureGit @('clone', '--quiet', $origin, $clone)

  # Dot-source the library, then point it at the CLONE (the helpers read
  # $script:CoopRoot, which dot-sourcing binds to this script's scope).
  . (Join-Path $root 'lib\common.ps1')
  $script:CoopRoot = $clone
  $marker = Join-Path $env:COOP_AGENT_DIR '.coop-fetch-stamp'

  # 1. Fresh clone: up to date, no fetch has happened yet.
  if ((Get-CoopRepoBehindCount) -eq 0) { Ok 'fresh clone reports 0 behind' } else { Ko "fresh clone should be 0 behind (got $(Get-CoopRepoBehindCount))" }

  # 2. origin gains a commit released as v0.2.0 and an unreleased one after it; the
  #    clone's LOCAL refs are stale (tag not yet fetched) -> still 0.
  Invoke-FixtureGit @('-C', $origin, 'commit', '--allow-empty', '-qm', 'three')
  Invoke-FixtureGit @('-C', $origin, 'tag', '-a', 'v0.2.0', '-m', 'v0.2.0')
  Invoke-FixtureGit @('-C', $origin, 'commit', '--allow-empty', '-qm', 'four')
  if ((Get-CoopRepoBehindCount) -eq 0) { Ok 'behind-count is purely local (release not fetched yet -> 0)' } else { Ko 'behind-count must be local (no implicit fetch)' }

  # 3. The throttled fetch runs (marker absent); its plain fetch auto-follows the
  #    release tag on main -> behind=1: counted against release v0.2.0, not the
  #    unreleased head of main (which would be 2).
  if (-not (Invoke-CoopRepoFetchThrottled)) { Ko 'first fetch should run (marker absent)' }
  elseif (-not (Test-Path -LiteralPath $marker)) { Ko 'fetch should stamp the marker' }
  elseif ((Get-CoopRepoBehindCount) -ne 1) { Ko "after fetch, clone should be 1 behind release v0.2.0 (got $(Get-CoopRepoBehindCount))" }
  else { Ok 'throttled fetch brings the release tag (1 behind, marker stamped)' }

  # 4. A second call within the day is throttled (returns $false): the once/day gate.
  if (Invoke-CoopRepoFetchThrottled) { Ko 'second fetch within a day must be throttled' } else { Ok 'second fetch within a day is throttled' }

  # 5. The launch nudge warns exactly when it fetches: throttled now -> silent.
  $out = Invoke-Captured { Invoke-CoopUpdateNudge }
  if ($out.Trim()) { Ko 'throttled nudge must stay silent' $out } else { Ok 'throttled nudge stays silent' }
  # Age the marker past the throttle window and it fires with the behind-count.
  [System.IO.File]::SetLastWriteTime($marker, (Get-Date).AddDays(-2))
  $out = Invoke-Captured { Invoke-CoopUpdateNudge }
  if ($out.Contains('1 commit(s) behind release v0.2.0')) { Ok "nudge warns '1 commit(s) behind release v0.2.0' after the throttle window" }
  else { Ko 'nudge should warn about being 1 behind release v0.2.0' $out }
  if ((Get-Item -LiteralPath $marker -Force).LastWriteTime -gt (Get-Date).AddHours(-1)) { Ok 'the nudge re-stamped the marker' } else { Ko 'the nudge did not re-stamp the marker' }

  # 6. Non-git copy: helpers are silent no-ops (0 behind, fetch not applicable).
  $plain = Join-Path $t 'plain'
  New-Item -ItemType Directory -Force -Path $plain | Out-Null
  $script:CoopRoot = $plain
  if ((Get-CoopRepoBehindCount) -ne 0) { Ko 'non-git copy should report 0 behind' }
  elseif (Invoke-CoopRepoFetchThrottled) { Ko 'non-git copy must not fetch' }
  else {
    $out = Invoke-Captured { Invoke-CoopUpdateNudge }
    if ($out.Trim()) { Ko 'non-git nudge must stay silent' $out } else { Ok 'non-git copy: all three helpers are silent no-ops' }
  }
}
finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  staleness helper tests passed' } else { Write-Host "  $G_CROSS staleness helper tests FAILED" }
exit $fail

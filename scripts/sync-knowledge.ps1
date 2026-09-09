#!/usr/bin/env pwsh
#
# coop sync-knowledge (Windows / PowerShell mirror of scripts/sync-knowledge.sh) —
# sync the configured team knowledge repos (~/.coop/config "knowledge" block):
# clone missing local paths, fast-forward clean checkouts, warn + skip dirty
# checkouts (never reset/clean), warn + continue on unreachable remotes. Always
# fail-soft: team knowledge is an aid, not a gate.
#
# Every git operation runs through scripts/knowledge-git.py: a hard process-tree
# deadline (default 30s, override with COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS), no
# interactive prompts, unattended batch SSH that preserves host-key checking.
# A failed or timed-out `git status` means UNKNOWN state: warn and skip — never
# pull. Clones land in a unique temporary sibling and move into place only on
# success, only when the destination is still absent; interrupted-clone cleanup
# removes ONLY the owned temporary directory, never the configured destination.
# Warnings name the path or repo label, never authenticated URLs.
#
# NOTE: no `exit` here — sync.ps1 invokes this script in-process with `&`, and an
# `exit` would end the parent sync run early. Standalone runs get code 0 by falling
# off the end (fail-soft by design).

$ErrorActionPreference = 'Continue'

# --- Shared helpers: dot-source lib/common.ps1 (the twin of lib/common.sh) ----
. (Join-Path $PSScriptRoot '../lib/common.ps1')

if (-not (Test-CoopKnowledgeEnabled)) {
  Coop-Info 'team knowledge sync is disabled — enable it with: coop onboard --config-only'
  return
}
if (-not (Test-Have 'git')) {
  Coop-Warn 'git is required to sync team knowledge — skipping'
  return
}

# The bounded runner needs Python. Without it we skip rather than fall back to
# unbounded Git — an offline/auth hang must never block `coop`.
$py = Get-CoopPython
if (-not $py) {
  Coop-Warn 'python is required for bounded knowledge sync — skipping'
  return
}
$knowledgeGit = Join-Path $PSScriptRoot '../scripts/knowledge-git.py'
function Invoke-KGit {
  # Runs the bounded git runner; the exit status is captured by the caller
  # IMMEDIATELY (native -> $LASTEXITCODE) before any other command runs.
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  & $py $knowledgeGit -- git @Args
}

$synced = 0
foreach ($repo in (Get-CoopKnowledgeRepos)) {
  $url = $repo.Url
  $path = $repo.LocalPath
  if (-not $url -or -not $path) { continue }
  if (Test-Path -LiteralPath (Join-Path $path '.git')) {
    # State probe: failed/timed-out status means UNKNOWN — never pull.
    $statusOut = Invoke-KGit -C $path status --porcelain 2>$null
    $statusRc = $LASTEXITCODE
    if ($statusRc -ne 0) {
      if ($statusRc -eq 124) {
        Coop-Warn "knowledge repo state unknown (status timed out) — skipping: $path"
      } else {
        Coop-Warn "knowledge repo state unknown (status failed) — skipping: $path"
      }
      continue
    }
    if ($statusOut) {
      Coop-Warn "knowledge repo is dirty — skipping (never resetting your changes): $path"
      continue
    }
    Invoke-KGit -C $path pull --ff-only > $null 2>&1
    $pullRc = $LASTEXITCODE
    if ($pullRc -eq 0) {
      Coop-Ok "updated $(Split-Path -Leaf $path)"
      $synced++
    } elseif ($pullRc -eq 124) {
      Coop-Warn "could not fast-forward $path — timed out; keeping the existing checkout"
    } else {
      Coop-Warn "could not fast-forward $path (offline or diverged) — keeping the existing checkout"
    }
  } elseif (Test-Path -LiteralPath $path) {
    Coop-Warn "$path exists but is not a git checkout — skipping"
  } else {
    # Clone into a unique temporary SIBLING owned by this operation; move it
    # into place only on success and only if the destination is still absent.
    $parent = Split-Path -Parent $path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent -ErrorAction SilentlyContinue | Out-Null }
    $tmp = Join-Path $parent ('.coop-knowledge-clone-' + $PID + '-' + [guid]::NewGuid().ToString('N'))
    Invoke-KGit clone $url $tmp > $null 2>&1
    $cloneRc = $LASTEXITCODE
    if ($cloneRc -eq 0) {
      if (-not (Test-Path -LiteralPath $path)) {
        try {
          Move-Item -LiteralPath $tmp -Destination $path -ErrorAction Stop
          Coop-Ok "cloned $(Split-Path -Leaf $path) -> $path"
          $synced++
        } catch {
          Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
          Coop-Warn 'could not move cloned repo into place — removed the owned temp clone'
        }
      } else {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
        Coop-Warn "destination appeared during clone — keeping the existing $path"
      }
    } else {
      # Owned temp only, never the configured destination.
      Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
      if ($cloneRc -eq 124) {
        Coop-Warn 'clone timed out and was terminated — continuing'
      } else {
        Coop-Warn 'clone failed (offline or no access)'
      }
    }
  }
}

Coop-Ok "team knowledge sync complete ($synced repo(s) current)"

#!/usr/bin/env pwsh
#
# coop sync-knowledge (Windows / PowerShell mirror of scripts/sync-knowledge.sh) —
# sync the configured team knowledge repos (~/.coop/config "knowledge" block):
# clone missing local paths, fast-forward clean checkouts, warn + skip dirty
# checkouts (never reset/clean), warn + continue on unreachable remotes. Always
# fail-soft: team knowledge is an aid, not a gate.
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

$synced = 0
foreach ($repo in (Get-CoopKnowledgeRepos)) {
  $url = $repo.Url
  $path = $repo.LocalPath
  if (-not $url -or -not $path) { continue }
  if (Test-Path -LiteralPath (Join-Path $path '.git')) {
    $dirty = & git -C $path status --porcelain 2>$null
    if ($dirty) {
      Coop-Warn "knowledge repo is dirty — skipping (never resetting your changes): $path"
      continue
    }
    & git -C $path -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=15 pull --ff-only > $null 2>&1
    if ($LASTEXITCODE -eq 0) {
      Coop-Ok "updated $(Split-Path -Leaf $path)"
      $synced++
    } else {
      Coop-Warn "could not fast-forward $path (offline or diverged) — keeping the existing checkout"
    }
  } elseif (Test-Path -LiteralPath $path) {
    Coop-Warn "$path exists but is not a git checkout — skipping"
  } else {
    $parent = Split-Path -Parent $path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent -ErrorAction SilentlyContinue | Out-Null }
    & git clone -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=15 $url $path > $null 2>&1
    if ($LASTEXITCODE -eq 0) {
      Coop-Ok "cloned $(Split-Path -Leaf $path) -> $path"
      $synced++
    } else {
      Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue   # failed-clone husk
      Coop-Warn "clone failed (offline or no access): $url"
    }
  }
}

Coop-Ok "team knowledge sync complete ($synced repo(s) current)"

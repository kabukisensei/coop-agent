#!/usr/bin/env pwsh
# Get-CoopContractRootProposal (lib/common.ps1), master plan C1: one committed
# contract at the client's Git root. A contract above the folder is "existing" and
# `coop init` never writes a second copy below it; with none, the folder that holds
# the client's repositories is proposed (the repository root when it is alone, the
# folder itself outside Git). Mirrors proposeContractRoot in lib/project-contract.mjs.
# Offline, no waits, no real home.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-contract-root-' + [guid]::NewGuid().ToString('N'))

$saved = Save-Env @('HOME', 'USERPROFILE', 'COOP_DIR', 'NO_COLOR')
try {
  New-Item -ItemType Directory -Force -Path $t, (Join-Path $t 'home') | Out-Null
  $env:HOME = Join-Path $t 'home'
  $env:USERPROFILE = $env:HOME
  $env:NO_COLOR = '1'
  . (Join-Path $root 'lib\common.ps1')

  # A client folder holding two repositories, a plain notes folder and no contract.
  $client = Join-Path $t 'client'
  foreach ($name in @('analytics', 'reports')) { New-Item -ItemType Directory -Force -Path (Join-Path (Join-Path $client $name) '.git') | Out-Null }
  New-Item -ItemType Directory -Force -Path (Join-Path (Join-Path $client 'analytics') 'src'), (Join-Path $client 'notes') | Out-Null

  $shared = Get-CoopContractRootProposal (Join-Path (Join-Path $client 'analytics') 'src')
  if ($shared.Kind -ne 'repos-folder') { Ko "inside one of two sibling repositories: Kind=$($shared.Kind), expected repos-folder" }
  elseif ($shared.Root -ne $client) { Ko "repos-folder root is $($shared.Root), expected $client" }
  elseif (($shared.Repos -join ',') -ne 'analytics,reports') { Ko "repos-folder lists $($shared.Repos -join ','), expected analytics,reports" }
  elseif ($shared.Path -ne (Join-Path $client '.coop\project.yml')) { Ko "repos-folder path is $($shared.Path)" }
  else { Ok 'inside one of two sibling repositories: the folder holding them is proposed, with both named' }

  $single = Join-Path $t 'single'
  New-Item -ItemType Directory -Force -Path (Join-Path (Join-Path $single 'work') '.git'), (Join-Path (Join-Path $single 'work') 'sub') | Out-Null
  $alone = Get-CoopContractRootProposal (Join-Path (Join-Path $single 'work') 'sub')
  if ($alone.Kind -ne 'git-root' -or $alone.Root -ne (Join-Path $single 'work')) { Ko "the only repository in its folder: Kind=$($alone.Kind) Root=$($alone.Root)" }
  else { Ok 'the only repository in its folder: its root is proposed' }

  $plain = Get-CoopContractRootProposal (Join-Path $client 'notes')
  if ($plain.Kind -ne 'folder' -or $plain.Root -ne (Join-Path $client 'notes')) { Ko "a folder outside Git: Kind=$($plain.Kind) Root=$($plain.Root)" }
  else { Ok 'a folder outside Git: the folder itself' }

  # A committed contract at the client root covers every folder under it.
  New-Item -ItemType Directory -Force -Path (Join-Path $client '.coop') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $client '.coop\project.yml'), "profile:`n  client: 'Contoso'`n")
  $existing = Get-CoopContractRootProposal (Join-Path (Join-Path $client 'analytics') 'src')
  if ($existing.Kind -ne 'existing' -or $existing.Path -ne (Join-Path $client '.coop\project.yml')) { Ko "below a root contract: Kind=$($existing.Kind) Path=$($existing.Path)" }
  else { Ok 'below a root contract: that contract, so nothing is created under it' }

  # The bundled coop-agent contract is not a client's: the proposal never falls back to it.
  $bare = Join-Path $t 'bare'
  New-Item -ItemType Directory -Force -Path $bare | Out-Null
  $none = Get-CoopContractRootProposal $bare
  if ($none.Kind -eq 'existing') { Ko "an empty folder resolved to an existing contract: $($none.Path)" }
  else { Ok 'an empty folder never resolves to the bundled contract' }
} finally {
  Restore-Env $saved
  Remove-Item -Recurse -Force $t -ErrorAction SilentlyContinue
}
exit $fail

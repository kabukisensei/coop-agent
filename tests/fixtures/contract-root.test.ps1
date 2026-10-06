#!/usr/bin/env pwsh
# Get-CoopContractRootProposal, Find-CoopSiblingContract, Find-CoopChildContract and Set-CoopProjectYmlEnv
# (lib/common.ps1), master plan C1: one committed contract per client in a
# repository the team clones. A contract above the folder, or in the client home
# repository beside it, is "existing" and `coop init` never writes a second copy;
# with none, the home repository <client>-coop is proposed beside several
# repositories, the repository root when it is alone, the folder itself outside
# Git. Mirrors proposeContractRoot in lib/project-contract.mjs.
# Offline, no waits, no real home.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-contract-root-' + [guid]::NewGuid().ToString('N'))

$saved = Save-Env @('HOME', 'USERPROFILE', 'COOP_DIR', 'NO_COLOR', 'COOP_PROJECT_YML')
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
  if ($shared.Kind -ne 'home-repo') { Ko "inside one of two sibling repositories: Kind=$($shared.Kind), expected home-repo" }
  elseif ($shared.Parent -ne $client) { Ko "home-repo parent is $($shared.Parent), expected $client" }
  elseif (($shared.Repos -join ',') -ne 'analytics,reports') { Ko "home-repo lists $($shared.Repos -join ','), expected analytics,reports" }
  elseif ($shared.Root -ne (Join-Path $client '<client>-coop') -or -not $shared.Pending) { Ko "home-repo root before the client is known: $($shared.Root)" }
  else { Ok 'inside one of two sibling repositories: the client home repository beside them is proposed, pending the client name' }
  $named = Get-CoopContractRootProposal (Join-Path (Join-Path $client 'analytics') 'src') 'Contoso Retail'
  if ($named.Kind -ne 'home-repo' -or $named.Root -ne (Join-Path $client 'contoso-retail-coop') -or $named.Pending) { Ko "named home repository: Kind=$($named.Kind) Root=$($named.Root)" }
  elseif ($named.Path -ne (Join-Path (Join-Path $client 'contoso-retail-coop') '.coop\project.yml')) { Ko "named home path is $($named.Path)" }
  else { Ok 'with the client name: <parent>\contoso-retail-coop' }

  # The folder between the repositories is never a contract's home: nothing
  # proposes it, and a contract there is still found only by the walk-up (legacy).
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

  # A client home repository beside the repositories whose contract lists one of
  # them: found from inside that repository (sibling lookup), not from the other.
  $homeRepo = Join-Path $t 'sib'
  foreach ($name in @('analytics', 'reports', 'contoso-coop')) { New-Item -ItemType Directory -Force -Path (Join-Path (Join-Path $homeRepo $name) '.git') | Out-Null }
  New-Item -ItemType Directory -Force -Path (Join-Path (Join-Path $homeRepo 'contoso-coop') '.coop'), (Join-Path (Join-Path $homeRepo 'analytics') 'src') | Out-Null
  $homeContract = Join-Path (Join-Path $homeRepo 'contoso-coop') '.coop\project.yml'
  [System.IO.File]::WriteAllText($homeContract, "profile:`n  client: 'Contoso'`nrepositories:`n  analytics:`n    role: 'sql'`n    local_path: '../analytics'`n  todo:`n    local_path: TODO`n")
  $paths = @(Get-CoopContractLocalPaths $homeContract)
  if (($paths -join ',') -ne '../analytics') { Ko "local paths read as $($paths -join ','), expected ../analytics" } else { Ok 'the contract line scan reads local_path values and skips TODO placeholders' }
  $found = Find-CoopSiblingContract (Join-Path (Join-Path $homeRepo 'analytics') 'src')
  if ($found -ne $homeContract) { Ko "sibling lookup from a listed repository returned '$found'" } else { Ok 'the sibling home repository is found from inside a repository it lists' }
  $notListed = Find-CoopSiblingContract (Join-Path $homeRepo 'reports')
  if ($notListed) { Ko "sibling lookup from an unlisted repository returned '$notListed'" } else { Ok 'a repository the home does not list is not covered' }
  $viaHome = Get-CoopContractRootProposal (Join-Path (Join-Path $homeRepo 'analytics') 'src')
  if ($viaHome.Kind -ne 'existing' -or $viaHome.Path -ne $homeContract -or -not $viaHome.Sibling) { Ko "proposal from a listed repository: Kind=$($viaHome.Kind) Path=$($viaHome.Path)" } else { Ok 'the proposal is the home contract, marked as a sibling' }
  Remove-Item Env:COOP_PROJECT_YML -ErrorAction SilentlyContinue
  $exported = Set-CoopProjectYmlEnv (Join-Path (Join-Path $homeRepo 'analytics') 'src')
  if ($exported -ne $homeContract -or $env:COOP_PROJECT_YML -ne $homeContract) { Ko "Set-CoopProjectYmlEnv exported '$env:COOP_PROJECT_YML'" } else { Ok 'the launcher hands the sibling contract to Pi as COOP_PROJECT_YML' }
  $found2 = Find-CoopProjectYml (Join-Path (Join-Path $homeRepo 'analytics') 'src')
  if ($found2 -ne $homeContract) { Ko "Find-CoopProjectYml returned '$found2'" } else { Ok 'Find-CoopProjectYml resolves the sibling home contract' }
  Remove-Item Env:COOP_PROJECT_YML -ErrorAction SilentlyContinue
  $none2 = Set-CoopProjectYmlEnv (Join-Path $homeRepo 'reports')
  if ($none2 -or $env:COOP_PROJECT_YML) { Ko "Set-CoopProjectYmlEnv exported '$env:COOP_PROJECT_YML' for an unlisted repository" } else { Ok 'nothing is exported for a repository no home lists' }

  # Opened in the folder that holds the repositories (in no repository): the one
  # repository directly inside it with a contract is used; several, none is.
  $down = Join-Path $t 'down'
  foreach ($name in @('analytics', 'reports')) { New-Item -ItemType Directory -Force -Path (Join-Path (Join-Path $down $name) '.git') | Out-Null }
  if (Find-CoopChildContract $down) { Ko 'one level down with no contract found something' } else { Ok 'one level down: nothing when no repository inside has a contract' }
  New-Item -ItemType Directory -Force -Path (Join-Path (Join-Path $down 'analytics') '.coop') | Out-Null
  $childContract = Join-Path (Join-Path $down 'analytics') '.coop\project.yml'
  [System.IO.File]::WriteAllText($childContract, "profile:`n  client: 'Contoso'`n")
  $foundDown = Find-CoopChildContract $down
  if ($foundDown -ne $childContract) { Ko "one level down returned '$foundDown'" } else { Ok 'one level down: the one repository inside with a contract' }
  if (Find-CoopChildContract (Join-Path $down 'reports')) { Ko 'inside a repository coop looked down' } else { Ok 'inside a repository coop never looks down' }
  $viaChild = Get-CoopContractRootProposal $down
  if ($viaChild.Kind -ne 'existing' -or $viaChild.Path -ne $childContract -or -not $viaChild.Child) { Ko "proposal from the parent folder: Kind=$($viaChild.Kind) Path=$($viaChild.Path)" } else { Ok 'the proposal from the parent folder is that contract, so no second one is created' }
  Remove-Item Env:COOP_PROJECT_YML -ErrorAction SilentlyContinue
  $exportedDown = Set-CoopProjectYmlEnv $down
  if ($exportedDown -ne $childContract -or $env:COOP_PROJECT_YML -ne $childContract) { Ko "Set-CoopProjectYmlEnv from the parent folder exported '$env:COOP_PROJECT_YML'" } else { Ok 'the launcher hands the contract one level down to Pi as COOP_PROJECT_YML' }
  Remove-Item Env:COOP_PROJECT_YML -ErrorAction SilentlyContinue
  if ((Find-CoopProjectYml $down) -ne $childContract) { Ko 'Find-CoopProjectYml missed the contract one level down' } else { Ok 'Find-CoopProjectYml resolves the contract one level down' }
  New-Item -ItemType Directory -Force -Path (Join-Path (Join-Path $down 'reports') '.coop') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path (Join-Path $down 'reports') '.coop\project.yml'), "profile:`n  client: 'Contoso'`n")
  $both = @(Get-CoopChildContracts $down)
  if ($both.Count -ne 2) { Ko "Get-CoopChildContracts listed $($both.Count), expected 2" }
  elseif (Find-CoopChildContract $down) { Ko 'several repositories with a contract: one was picked' }
  else { Ok 'several repositories with a contract: none is picked' }

  # coop's own checkout (installed by default at C:\Users\<you>\coop-agent) is never
  # the team project: opened from the home folder, neither the one-level-down nor
  # the sibling lookup takes its sample contract.
  $homeDir = Join-Path $t 'home'
  $coopCheckout = Join-Path $homeDir 'coop-agent'
  foreach ($sub in @('.git', '.coop', 'bin', 'lib')) { New-Item -ItemType Directory -Force -Path (Join-Path $coopCheckout $sub) | Out-Null }
  [System.IO.File]::WriteAllText((Join-Path $coopCheckout 'bin\coop.ps1'), '')
  [System.IO.File]::WriteAllText((Join-Path $coopCheckout 'lib\common.ps1'), '')
  [System.IO.File]::WriteAllText((Join-Path $coopCheckout '.coop\project.yml'), "repositories:`n  fabric:`n    local_path: `"../fabric`"`n")
  New-Item -ItemType Directory -Force -Path (Join-Path (Join-Path $homeDir 'fabric') '.git') | Out-Null
  if (Find-CoopChildContract $homeDir) { Ko "the home folder took coop's own checkout as the project" } else { Ok "one level down skips coop's own checkout" }
  $fromHome = Set-CoopProjectYmlEnv $homeDir
  if ($fromHome -or $env:COOP_PROJECT_YML) { Ko "the launcher exported coop's own contract: '$fromHome'" } else { Ok "the launcher exports no contract from the home folder" }
  Remove-Item Env:COOP_PROJECT_YML -ErrorAction SilentlyContinue
  if (Find-CoopSiblingContract (Join-Path $homeDir 'fabric')) { Ko "a repository beside coop's checkout took its sample contract" } else { Ok "the sibling lookup skips coop's own checkout" }
  $homeProposal = Get-CoopContractRootProposal (Join-Path $homeDir 'fabric')
  if ($homeProposal.Kind -ne 'git-root') { Ko "coop's checkout counted as a client repository: Kind=$($homeProposal.Kind)" } else { Ok "coop's checkout never counts as a client repository" }

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

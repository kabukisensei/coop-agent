#!/usr/bin/env pwsh
# PowerShell twin of tests/release.test.sh. Exercises the real coop.ps1 release
# path in a disposable repository and never pushes.
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-release-ps-' + [guid]::NewGuid().ToString('N'))
$failed = $false
function Ok([string]$Message) { Write-Host "  OK  $Message" }
function Ko([string]$Message) { Write-Host "  FAIL $Message"; $script:failed = $true }

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
  & git -C $Path init -q
  & git -C $Path config user.name 'Coop Release Test'
  & git -C $Path config user.email 'coop-release-test@example.invalid'
  & git -C $Path add .
  & git -C $Path commit -q -m fixture
}

New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
  Write-Host '-> coop.ps1 release keeps every version authority in one transaction'
  $fixture = Join-Path $temp 'happy'
  New-ReleaseFixture $fixture
  $current = (Get-Content (Join-Path $fixture 'VERSION') -Raw).Trim()
  $parts = $current.Split('.')
  $next = "$($parts[0]).$($parts[1]).$([int]$parts[2] + 1)"
  $releaseOut = & (Join-Path $fixture 'bin\coop.ps1') release patch --yes --no-push --no-check 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0) { Ok 'fixture release exits zero' } else { Ko "fixture release failed: $releaseOut" }

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
  & git -C $fixture rev-parse "v$next" *> $null
  if ($LASTEXITCODE -eq 0) { Ok "release tag v$next exists" } else { Ko "release tag v$next missing" }
  if (-not (& git -C $fixture status --porcelain)) { Ok 'release commit includes every generated change' } else { Ko 'release left uncommitted files' }

  Write-Host '-> coop.ps1 release rejects a pre-existing manifest/VERSION mismatch'
  $bad = Join-Path $temp 'mismatch'
  New-ReleaseFixture $bad
  $badManifestPath = Join-Path $bad 'config\release-manifest.json'
  $badRaw = Get-Content $badManifestPath -Raw
  $badRaw = [regex]::Replace($badRaw, '(?m)^(\s*"coop_version"\s*:\s*")[^"]*(".*)$', '${1}0.0.0${2}')
  [System.IO.File]::WriteAllText($badManifestPath, ($badRaw -replace "`r`n", "`n"))
  & git -C $bad add config/release-manifest.json
  & git -C $bad commit -q -m mismatch
  $badOut = & (Join-Path $bad 'bin\coop.ps1') release patch --yes --no-push --no-check 2>&1 6>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { Ok 'mismatched release is rejected' } else { Ko 'mismatched release unexpectedly succeeded' }
}
finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failed) { exit 1 }

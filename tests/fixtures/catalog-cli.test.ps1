#!/usr/bin/env pwsh
# `coop catalog status` (master plan SQ9) run from a repository the client home
# repository lists (C1): the helper reads that home repository's project file,
# as a session does, instead of failing with project_unavailable. Offline: status
# opens no connection. Sandboxed HOME/USERPROFILE/COOP_DIR, never ~/.coop.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$coop = Join-Path (Join-Path $root 'bin') 'coop.ps1'
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-catalog-cli-' + [guid]::NewGuid().ToString('N'))
$utf8 = New-Object System.Text.UTF8Encoding($false)

$saved = Save-Env @('HOME', 'USERPROFILE', 'COOP_DIR', 'NO_COLOR', 'COOP_SKIP_AZ', 'COOP_PROJECT_YML', 'COOP_FABRIC_PYTHON')
try {
  $sandboxHome = New-SandboxHome (Join-Path $t 'home')
  $client = Join-Path $t 'client'
  $homeRepo = Join-Path $client 'contoso-coop'
  $sql = Join-Path $client 'sql'
  New-Item -ItemType Directory -Force -Path (Join-Path $homeRepo '.git'), (Join-Path $homeRepo '.coop'), (Join-Path $sql '.git') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $homeRepo '.coop\project.yml'), (@(
    'profile:',
    '  client: Contoso',
    'sql_targets:',
    '  default_environment: dev',
    '  dev:',
    '    kind: azure_sql',
    '    server: contoso-dev.database.windows.net',
    '    database: ContosoDW',
    'repositories:',
    '  sql:',
    '    local_path: ../sql'
  ) -join "`n") + "`n", $utf8)
  $env:HOME = $sandboxHome
  $env:USERPROFILE = $sandboxHome
  $env:COOP_DIR = Join-Path $sandboxHome '.coop'
  $env:NO_COLOR = '1'
  $env:COOP_SKIP_AZ = '1'
  Remove-Item Env:COOP_PROJECT_YML -ErrorAction SilentlyContinue
  Remove-Item Env:COOP_FABRIC_PYTHON -ErrorAction SilentlyContinue

  Push-Location $sql
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $out = (@(& $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $coop catalog status 2>&1 | ForEach-Object { [string]$_ }) -join "`n")
  } finally { $ErrorActionPreference = $eap; Pop-Location }
  if ($out -match 'project_unavailable') { Ko 'coop catalog status from a listed repository did not find the home repository contract' $out }
  elseif ($out -match 'no catalog snapshot under') { Ok 'coop catalog status from a listed repository reads the home repository contract' }
  else { Ko 'coop catalog status printed something unexpected' $out }
} finally {
  Restore-Env $saved
  Remove-Item -Recurse -Force $t -ErrorAction SilentlyContinue
}
exit $fail

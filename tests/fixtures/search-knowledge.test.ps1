#!/usr/bin/env pwsh
# PowerShell twin of tests/search-knowledge.test.sh — exercises the real
# scripts/search-knowledge.py helper (via Get-CoopPython discovery) against
# temporary fixture roots. No network, no real subscriptions or credentials.
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$helper = Join-Path $root 'scripts\search-knowledge.py'
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-search-knowledge-ps-' + [guid]::NewGuid().ToString('N'))
$failed = $false
function Ok([string]$Message) { Write-Host "  OK  $Message" }
function Ko([string]$Message) { Write-Host "  FAIL $Message"; $script:failed = $true }

. (Join-Path $root 'lib\common.ps1')
$py = Get-CoopPython
if (-not $py) { Write-Host '  FAIL python3/python not found'; exit 1 }

New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
  $cfg = Join-Path $temp 'coopcfg'
  $homeFake = Join-Path $temp 'home'
  $a = Join-Path $temp 'knowledge\repo a'      # path with a space
  $b = Join-Path $temp 'knowledge\repo-b'
  $c = Join-Path $temp 'knowledge\unconfigured'
  New-Item -ItemType Directory -Force -Path (Join-Path $cfg '.coop'), $homeFake, $a, $b, $c | Out-Null

  $marker = 'xzqunique_marker_7731'
  Set-Content (Join-Path $a 'note-one.md') "alpha note mentions $marker here"
  Set-Content (Join-Path $b 'note-two.md') "beta note mentions $marker too"
  Set-Content (Join-Path $c 'rogue.md') "rogue note mentions $marker"

  function Write-Cfg([string]$Json) {
    Set-Content -Encoding utf8 (Join-Path $cfg '.coop\config') $Json
  }
  function Invoke-Helper([string]$Query) {
    $oldCoopDir = $env:COOP_DIR; $oldHome = $env:HOME
    $env:COOP_DIR = $cfg; $env:HOME = $homeFake
    try {
      $out = & $py $helper --query $Query 2>$null
      $rc = $LASTEXITCODE
    } finally {
      if ($null -eq $oldCoopDir) { Remove-Item Env:\COOP_DIR -ErrorAction SilentlyContinue } else { $env:COOP_DIR = $oldCoopDir }
      if ($null -eq $oldHome) { Remove-Item Env:\HOME -ErrorAction SilentlyContinue } else { $env:HOME = $oldHome }
    }
    return @{ Out = ($out -join "`n"); Rc = $rc }
  }
  function Get-Prop([string]$Json, [string]$Expr) {
    # Evaluate a small property expression against the parsed JSON document.
    $d = $Json | ConvertFrom-Json
    switch -Regex ($Expr) {
      '^status$' { return $d.status }
      '^matchCount$' { return @($d.matches).Count }
      '^rootCount$' { return @($d.searched_roots).Count }
      '^warningCount$' { return @($d.warnings).Count }
      '^hasRogue$' { return [bool](@($d.matches | Where-Object { $_.path -like '*rogue*' }).Count) }
      default { throw "unknown expr $Expr" }
    }
  }

  Write-Cfg "{`"knowledge`":{`"enabled`":true,`"repos`":[{`"url`":`"u`",`"local_path`":`"$($a -replace '\\','\\')`"},{`"url`":`"u`",`"local_path`":`"$($b -replace '\\','\\')`"}]}}"

  $r = Invoke-Helper $marker
  if ($r.Rc -eq 0) { Ok 'exit 0 on successful search' } else { Ko "exit $($r.Rc): $($r.Out)" }
  if ((Get-Prop $r.Out 'status') -eq 'ok') { Ok 'status ok' } else { Ko "status: $($r.Out)" }
  if ((Get-Prop $r.Out 'rootCount') -eq 2) { Ok 'both configured roots searched' } else { Ko "roots: $($r.Out)" }
  if (-not (Get-Prop $r.Out 'hasRogue')) { Ok 'unconfigured root C never returned' } else { Ko "rogue leak: $($r.Out)" }
  if ((Get-Prop $r.Out 'matchCount') -eq 2) { Ok 'one match per configured repo' } else { Ko "matches: $($r.Out)" }

  $r = Invoke-Helper 'definitely_not_present_anywhere_99887'
  if ((Get-Prop $r.Out 'status') -eq 'ok' -and (Get-Prop $r.Out 'matchCount') -eq 0) { Ok 'zero matches is status ok' } else { Ko "zero-match: $($r.Out)" }

  Write-Cfg '{\"knowledge\":{\"enabled\":false,\"repos\":[]}}'.Replace('\"','"')
  $r = Invoke-Helper $marker
  if ((Get-Prop $r.Out 'status') -eq 'disabled') { Ok 'disabled config -> status disabled' } else { Ko "disabled: $($r.Out)" }

  Write-Cfg '{not json'
  $r = Invoke-Helper $marker
  if ((Get-Prop $r.Out 'status') -eq 'invalid_config') { Ok 'malformed config -> invalid_config' } else { Ko "malformed: $($r.Out)" }

  $missing = Join-Path $temp 'knowledge\absent'
  Write-Cfg "{`"knowledge`":{`"enabled`":true,`"repos`":[{`"url`":`"u`",`"local_path`":`"$($missing -replace '\\','\\')`"},{`"url`":`"u`",`"local_path`":`"$($b -replace '\\','\\')`"}]}}"
  $r = Invoke-Helper $marker
  if ((Get-Prop $r.Out 'status') -eq 'ok' -and (Get-Prop $r.Out 'matchCount') -eq 1) { Ok 'missing A skipped; B still searched' } else { Ko "missing-A: $($r.Out)" }

  # Empty query is invalid CLI usage (exit 2).
  $r = Invoke-Helper '   '
  if ($r.Rc -eq 2) { Ok 'empty query exits 2' } else { Ko "empty query rc=$($r.Rc)" }

  # TeamAI on PATH cannot change which roots are searched (sentinel must not appear).
  $fake = Join-Path $temp 'fake-teamai'
  New-Item -ItemType Directory -Force -Path $fake | Out-Null
  $sentinel = Join-Path $fake 'sentinel'
  @"
@echo off
echo invoked > "$sentinel"
echo fake teamai output
"@ | Set-Content (Join-Path $fake 'teamai.cmd')
  Write-Cfg "{`"knowledge`":{`"enabled`":true,`"repos`":[{`"url`":`"u`",`"local_path`":`"$($a -replace '\\','\\')`"},{`"url`":`"u`",`"local_path`":`"$($b -replace '\\','\\')`"}]}}"
  $r1 = Invoke-Helper $marker
  $oldPath = $env:PATH; $env:PATH = "$fake;$oldPath"
  try { $r2 = Invoke-Helper $marker } finally { $env:PATH = $oldPath }
  if ($r1.Out -eq $r2.Out) { Ok 'fake teamai cannot change results' } else { Ko 'teamai changed results' }
  if (-not (Test-Path -LiteralPath $sentinel)) { Ok 'helper never invokes teamai' } else { Ko 'teamai was invoked' }
}
finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failed) { exit 1 }
exit 0

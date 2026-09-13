# PowerShell asymmetric SQL/DAX transaction regression.
$ErrorActionPreference = 'Stop'
$root = if ($env:COOP_ROOT) { $env:COOP_ROOT } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-review-transaction-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
function Sha256([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes($Path)))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function Write-Json([string]$Path, $Value) { [System.IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false))) }
try {
  $sqlStandard = Join-Path $tmp 'sql.md'; $daxStandard = Join-Path $tmp 'dax.md'
  [System.IO.File]::WriteAllText($sqlStandard, '# SQL'); [System.IO.File]::WriteAllText($daxStandard, '# DAX')
  $sqlHash = Sha256 $sqlStandard; $daxHash = Sha256 $daxStandard
  $sqlResolution = Join-Path $tmp 'sql-resolution.json'; $daxResolution = Join-Path $tmp 'dax-resolution.json'
  Write-Json $sqlResolution @{ domain='sql'; path=$sqlStandard; sha256=$sqlHash; revision='fixture'; immutable=$true }
  Write-Json $daxResolution @{ domain='dax'; path=$daxStandard; sha256=$daxHash; revision='fixture'; immutable=$true }
  foreach ($badDomain in @('sql','dax')) {
    $sqlReport = Join-Path $tmp 'sql-run.json'; $daxReport = Join-Path $tmp 'dax-run.json'
    $sqlClaim = if ($badDomain -eq 'sql') { '0' * 64 } else { $sqlHash }
    $daxClaim = if ($badDomain -eq 'dax') { '0' * 64 } else { $daxHash }
    Write-Json $sqlReport @{ tool='coop-sql-review'; schema_version=4; version='test'; files_checked=0; standards=@{path=$sqlStandard;sha256=$sqlClaim}; findings=@();diagnostics=@();agent_review=@();summary=@{error=0;warning=0;info=0};verdict=@{clean=$true;highest_severity=$null} }
    Write-Json $daxReport @{ tool='coop-dax-review'; schema_version=3; version='test'; models_checked=0; standards=@{path=$daxStandard;sha256=$daxClaim}; findings=@();diagnostics=@();agent_review=@();summary=@{error=0;warning=0;info=0};verdict=@{clean=$true;highest_severity=$null} }
    $targets = @('coop-sql-review.json','coop-sql-review.provenance.json','coop-dax-review.json','coop-dax-review.provenance.json')
    foreach ($name in $targets) { [System.IO.File]::WriteAllText((Join-Path $tmp $name), "accepted-$name") }
    $saved = $ErrorActionPreference
    try { $ErrorActionPreference='Continue'; & node (Join-Path $root 'lib\standards-cli.mjs') promote-run $tmp $sqlResolution $sqlReport $daxResolution $daxReport 2>$null | Out-Null; $rc=$LASTEXITCODE }
    finally { $ErrorActionPreference=$saved }
    if ($rc -ne 2) { throw "asymmetric $badDomain mutation did not fail closed" }
    foreach ($name in $targets) { if ((Get-Content -LiteralPath (Join-Path $tmp $name) -Raw) -ne "accepted-$name") { throw "asymmetric $badDomain mutation advanced $name" } }
  }
  Write-Host '  ✓ PowerShell asymmetric SQL/DAX transaction preserves all accepted artifacts'
} finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }

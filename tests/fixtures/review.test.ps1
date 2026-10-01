#!/usr/bin/env pwsh
# Port of tests/review.test.sh (master plan S1): `coop review` (Invoke-CoopReview
# in bin/coop.ps1) against shimmed coop-sql-review / coop-dax-review /
# coop-data-doc (Python-backed stubs: a .cmd on Windows, a sh launcher elsewhere).
# The linter shims record argv, honor `-o FILE` by writing a provenance-complete
# canned JSON report there (or a broken one, by mode), and mimic the real exit
# contract (exit 2 under --strict, since the canned report "has findings"). The
# data-doc shim records argv and exits with COOP_TEST_DD_RC. Fully offline.
#   1. contract scope: both reports land in the accepted generation, the resolved
#      repo path (never the TODO / missing ones) is the scope, the standards are
#      immutable byte-identical snapshots, data-doc gets BOTH --reviews files.
#   1b. a rejected run never advances the accepted generation, is quarantined,
#      skips the configured docs composition and emits no suite HTML.
#   1c. one valid + one rejected report is one rejected run.
#   2. --skip-docs   3. explicit paths win   4. --strict exits 2 and reaches both
#   5. data-doc exit 1 is a hint, exit 2 propagates   6. no contract + no paths dies
#      with guidance (a fake COOP_ROOT without the bundled .coop/project.yml)
#   7. --compare passes --diff-against after a prior run, none on the first
#   8. --diff scopes to the files changed in git.
# tests/fixtures/review-transaction.test.ps1 covers the promote-run transaction
# itself. Sandboxed HOME/USERPROFILE/COOP_DIR/agent dir and standards snapshot
# root, never ~/.coop; an npm stub keeps Add-CoopRuntimePaths from putting a real
# npm prefix first on PATH. Assertions stay ASCII (Windows PowerShell 5.1
# re-encodes child output).
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$coop = Join-Path $root 'bin\coop.ps1'
$psExe = try { (Get-Process -Id $PID).Path } catch { 'pwsh' }
$isWindowsHost = ($env:OS -eq 'Windows_NT')
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-review-ps-' + [guid]::NewGuid().ToString('N'))
$fail = 0
function Ok([string]$m) { Write-Host "  ok $m" }
function Ko([string]$m, [string]$out = '') { Write-Host "  x $m"; if ($out) { Write-Host $out }; $script:fail = 1 }

$bin = Join-Path $t 'bin'
$proj = Join-Path $t 'proj'
$reviews = Join-Path $proj '.coop\reviews'
$sandboxHome = Join-Path $t 'home'
$agent = Join-Path $t 'agent'
$snapshots = Join-Path $t 'snapshots'
$standardsCli = Join-Path $root 'lib\standards-cli.mjs'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$sep = [System.IO.Path]::PathSeparator

$saved = @{}
$names = @('PATH','HOME','USERPROFILE','COOP_DIR','COOP_AGENT_DIR','PI_CODING_AGENT_DIR','COOP_NO_ISOLATE','COOP_SKIP_AZ','NO_COLOR',
           'COOP_STANDARDS_ROOT','COOP_STANDARDS_STATE','COOP_STANDARDS_SNAPSHOT_ROOT','COOP_TEST_LOG_DIR','COOP_TEST_PROVENANCE_MODE',
           'COOP_TEST_SQL_MODE','COOP_TEST_DAX_MODE','COOP_TEST_DD_RC')
foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
$savedLocation = Get-Location
try {
  New-Item -ItemType Directory -Force -Path $bin, (Join-Path $proj '.coop'), (Join-Path $proj 'sqlrepo'), (Join-Path $proj 'standards'),
    $sandboxHome, (Join-Path $t 'coop\.coop'), $agent, $snapshots, (Join-Path $t 'elsewhere'), (Join-Path $t 'nowhere') | Out-Null
  $env:HOME = $sandboxHome
  $env:USERPROFILE = $sandboxHome
  $env:COOP_DIR = Join-Path $t 'coop'
  $env:COOP_AGENT_DIR = $agent
  $env:COOP_SKIP_AZ = '1'
  $env:NO_COLOR = '1'
  $env:COOP_STANDARDS_SNAPSHOT_ROOT = $snapshots
  $env:COOP_TEST_LOG_DIR = $t
  foreach ($n in @('PI_CODING_AGENT_DIR','COOP_NO_ISOLATE','COOP_STANDARDS_ROOT','COOP_STANDARDS_STATE','COOP_TEST_PROVENANCE_MODE',
                   'COOP_TEST_SQL_MODE','COOP_TEST_DAX_MODE','COOP_TEST_DD_RC')) {
    Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue
  }
  . (Join-Path $root 'lib\common.ps1')
  $realPy = Get-CoopPython
  if (-not $realPy) { throw 'a real python is required for this fixture' }
  $node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source

  function New-PyStub([string]$Dir, [string]$Name, [string]$Source) {
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    $py = Join-Path $Dir "$Name.stub.py"
    [System.IO.File]::WriteAllText($py, $Source, $utf8)
    if ($isWindowsHost) {
      $p = Join-Path $Dir "$Name.cmd"
      [System.IO.File]::WriteAllText($p, "@`"$realPy`" `"$py`" %*`r`n", [System.Text.Encoding]::ASCII)
    } else {
      $p = Join-Path $Dir $Name
      [System.IO.File]::WriteAllText($p, "#!/bin/sh`nexec `"$realPy`" `"$py`" `"`$@`"`n", $utf8)
      & chmod +x $p
    }
    return $p
  }
  # The linter shim, parameterized by its tool name (argv[0] of the stub script).
  $linterSource = @'
import hashlib, json, os, sys
tool = os.path.basename(sys.argv[0]).replace('.stub.py', '')
schema = 3 if tool == 'coop-dax-review' else 4
args = sys.argv[1:]
with open(os.path.join(os.environ['COOP_TEST_LOG_DIR'], tool + '.args.log'), 'a') as f:
    f.write(' '.join(args) + '\n')
out = ''; standard = ''; rc = 0; prev = ''
for a in args:
    if prev == '-o': out = a
    if prev == '--standards': standard = a
    if a == '--strict': rc = 2
    prev = a
digest = hashlib.sha256(open(standard, 'rb').read()).hexdigest() if standard else ''
def envelope(standards, count_key, model):
    d = {'tool': tool, 'schema_version': schema, 'version': 'test', 'files_checked': 0, 'models_checked': 0,
         'findings': [], 'diagnostics': [], 'agent_review': [], 'summary': {'error': 0, 'warning': 0, 'info': 0},
         'verdict': {'clean': True, 'highest_severity': None}}
    if standards is not None: d['standards'] = standards
    if count_key:
        for k in ('files_checked', 'models_checked'):
            if k != count_key: del d[k]
        d[count_key] = 1
        finding = {'file': 'fixture', 'line': 1, 'rule_id': 'TEST', 'message': 'test finding', 'severity': 'warning',
                   'object': 'fixture', 'standard_ref': '§1', 'fingerprint': '0' * 12}
        if model: finding['model'] = 'fixture-model'
        d['findings'] = [finding]; d['summary'] = {'error': 0, 'warning': 1, 'info': 0}
        d['verdict'] = {'clean': False, 'highest_severity': 'warning'}
    return d
if out:
    mode = os.environ.get('COOP_TEST_PROVENANCE_MODE', 'valid')
    if tool == 'coop-sql-review': mode = os.environ.get('COOP_TEST_SQL_MODE', mode)
    if tool == 'coop-dax-review': mode = os.environ.get('COOP_TEST_DAX_MODE', mode)
    if mode == 'no_report':
        if os.path.exists(out): os.remove(out)
    elif mode == 'malformed':
        open(out, 'w').write('not-json')
    else:
        if mode == 'missing': d = envelope(None, '', False)
        elif mode == 'bad_path': d = envelope({'path': '/wrong/path', 'sha256': digest}, '', False)
        elif mode == 'bad_hash': d = envelope({'path': standard, 'sha256': '0' * 64}, '', False)
        elif mode == 'bad_revision': d = envelope({'path': standard, 'sha256': digest, 'revision': 7}, '', False)
        else:
            dax = tool == 'coop-dax-review'
            d = envelope({'path': standard, 'sha256': digest}, 'models_checked' if dax else 'files_checked', dax)
        with open(out, 'w', encoding='utf-8') as f: json.dump(d, f)
sys.exit(rc)
'@
  $null = New-PyStub $bin 'coop-sql-review' $linterSource
  $null = New-PyStub $bin 'coop-dax-review' $linterSource
  $null = New-PyStub $bin 'coop-data-doc' @'
import os, sys
with open(os.path.join(os.environ['COOP_TEST_LOG_DIR'], 'coop-data-doc.args.log'), 'a') as f:
    f.write(' '.join(sys.argv[1:]) + '\n')
sys.exit(int(os.environ.get('COOP_TEST_DD_RC', '0')))
'@
  # npm stub: Add-CoopRuntimePaths asks `npm prefix -g`; answer nothing so no real
  # prefix (and no real coop tool) is put ahead of the shims.
  $null = New-PyStub $bin 'npm' "import sys`nif sys.argv[1:2] == ['--version']:`n    print('10.0.0')`nsys.exit(0)`n"
  $env:PATH = "$bin$sep$($saved['PATH'])"

  # A work repo with a contract: one existing repo path, one TODO leftover, one
  # path that does not exist on this machine.
  [System.IO.File]::WriteAllText((Join-Path $proj 'standards\sql.md'), "# SQL test standard`n", $utf8)
  [System.IO.File]::WriteAllText((Join-Path $proj 'standards\dax.md'), "# DAX test standard`n", $utf8)
  [System.IO.File]::WriteAllText((Join-Path $proj '.coop\project.yml'), (@(
    'standards:', '  sql: "standards/sql.md"', '  dax: "standards/dax.md"', 'repositories:', '  fabric_dw:',
    '    description: "Warehouse SQL"', '    local_path: "sqlrepo"', '  extras:', '    local_path: "TODO: /path/to/extras"',
    '  gone:', '    local_path: "no-such-dir"') -join "`n") + "`n", $utf8)
  $sqlRepo = Join-Path $proj 'sqlrepo'

  function Invoke-Review([string[]]$ReviewArgs = @(), [string]$Cwd = $proj, [string]$Launcher = $coop) {
    Set-Location -LiteralPath $Cwd
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
      $out = (& $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $Launcher review @ReviewArgs 2>&1 | Out-String)
      $rc = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $eap
      Set-Location -LiteralPath $savedLocation
    }
    return [pscustomobject]@{ Rc = $rc; Out = $out }
  }
  function Get-Log([string]$Tool) {
    $p = Join-Path $t "$Tool.args.log"
    if (Test-Path -LiteralPath $p) { return (Get-Content -LiteralPath $p -Raw) } else { return $null }
  }
  function Clear-Logs { Get-ChildItem -LiteralPath $t -Filter '*.args.log' -ErrorAction SilentlyContinue | Remove-Item -Force }
  function Get-Accepted {
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $json = (& $node $standardsCli accepted-run $reviews 2>$null | Out-String); $rc = $LASTEXITCODE } finally { $ErrorActionPreference = $eap }
    if ($rc -ne 0 -or -not $json.Trim()) { return $null }
    return ($json | ConvertFrom-Json)
  }
  function Get-Bytes([string]$Path) { ([BitConverter]::ToString([System.IO.File]::ReadAllBytes($Path))) }
  function Get-ArgAfter([string]$Log, [string]$Flag) {
    $tokens = @($Log -split '\s+')
    for ($i = 0; $i -lt $tokens.Count - 1; $i++) { if ($tokens[$i] -eq $Flag) { return $tokens[$i + 1] } }
    return ''
  }

  # 1. Contract scope.
  $r = Invoke-Review
  if ($r.Rc -ne 0) { Ko "coop review should exit 0 (got $($r.Rc))" $r.Out }
  $accepted = Get-Accepted
  if ($null -eq $accepted) { throw 'accepted generation pointer missing' }
  $sqlJson = [string]$accepted.reports.sql; $daxJson = [string]$accepted.reports.dax
  $sqlBinding = [string]$accepted.bindings.sql; $daxBinding = [string]$accepted.bindings.dax
  $case1 = $true
  if (-not (Test-Path -LiteralPath $sqlJson)) { Ko 'sql JSON missing from accepted generation'; $case1 = $false }
  if (-not (Test-Path -LiteralPath $daxJson)) { Ko 'dax JSON missing from accepted generation'; $case1 = $false }
  if ($case1) {
    $sqlReport = Get-Content -LiteralPath $sqlJson -Raw | ConvertFrom-Json
    $sqlBind = Get-Content -LiteralPath $sqlBinding -Raw | ConvertFrom-Json
    if ($sqlReport.standards.PSObject.Properties['revision'] -or $sqlBind.owner -ne 'coop' -or $sqlBind.revision -ne 'project-local' -or
        $sqlBind.path -ne $sqlReport.standards.path -or $sqlBind.sha256 -ne $sqlReport.standards.sha256) {
      Ko 'aggregate wrapper provenance binding is missing or rewrote reviewer claims' ((Get-Content -LiteralPath $sqlBinding -Raw) + "`n" + (Get-Content -LiteralPath $sqlJson -Raw)); $case1 = $false
    }
    foreach ($tool in @('coop-sql-review', 'coop-dax-review')) {
      $log = Get-Log $tool
      if (-not $log -or -not $log.Contains("check $sqlRepo --format json")) { Ko "$tool did not get the contract scope" $log; $case1 = $false }
      if ($log -and $log.Contains('TODO')) { Ko "$tool was handed a TODO placeholder path" $log; $case1 = $false }
      if ($log -and $log.Contains('no-such-dir')) { Ko "$tool was handed a missing path" $log; $case1 = $false }
    }
    $sqlSnapshot = Get-ArgAfter (Get-Log 'coop-sql-review') '--standards'
    $daxSnapshot = Get-ArgAfter (Get-Log 'coop-dax-review') '--standards'
    $snapRoot = [System.IO.Path]::GetFullPath($snapshots).TrimEnd('\', '/')
    foreach ($pair in @(@($sqlSnapshot, '-sql.md', 'SQL', 'standards\sql.md'), @($daxSnapshot, '-dax.md', 'DAX', 'standards\dax.md'))) {
      $snap = $pair[0]
      if (-not $snap -or [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($snap)).TrimEnd('\', '/') -ne $snapRoot -or -not $snap.EndsWith($pair[1])) {
        Ko "$($pair[2]) aggregate review did not get an immutable snapshot" "snapshot: $snap"; $case1 = $false
      } elseif ((Get-Bytes $snap) -ne (Get-Bytes (Join-Path $proj $pair[3]))) {
        Ko "$($pair[2]) snapshot is not byte-identical to the project standard"; $case1 = $false
      }
    }
    $ddLog = Get-Log 'coop-data-doc'
    if (-not $ddLog -or -not $ddLog.Contains('build --non-interactive')) { Ko 'data-doc build --non-interactive not invoked' $ddLog; $case1 = $false }
    else {
      $tokens = @($ddLog.Trim() -split '\s+')
      $got = @()
      for ($i = 0; $i -lt $tokens.Count - 1; $i++) { if ($tokens[$i] -eq '--reviews') { $got += [System.IO.Path]::GetFullPath($tokens[$i + 1]) } }
      $expected = @([System.IO.Path]::GetFullPath($sqlJson), [System.IO.Path]::GetFullPath($daxJson))
      if (($got -join '|') -ne ($expected -join '|')) { Ko 'data-doc did not receive the exact pinned SQL and DAX reports' $ddLog; $case1 = $false }
    }
  }
  if ($case1) { Ok 'contract scope + same-source standards: JSONs saved, missing skipped, exact standards and reviews passed' }

  # 1b. Configured canonical review paths never expose a rejected current report.
  [System.IO.File]::WriteAllText((Join-Path $proj 'coop-data-doc.yml'), "reviews:`n  - .coop/reviews/coop-sql-review.json`n  - .coop/reviews/coop-dax-review.json`n", $utf8)
  $acceptedSql = Get-Bytes $sqlJson; $acceptedDax = Get-Bytes $daxJson
  $acceptedSqlBinding = Get-Bytes $sqlBinding; $acceptedDaxBinding = Get-Bytes $daxBinding
  $rejected = Join-Path $reviews 'rejected'
  New-Item -ItemType Directory -Force -Path $rejected | Out-Null
  function Get-QuarantineCount { @(Get-ChildItem -LiteralPath $rejected -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 0 }).Count }
  function Test-AcceptedIntact([string]$Label) {
    $a = Get-Accepted
    if ($null -eq $a) { Ko "$Label destroyed accepted pointer"; return $false }
    if ((Get-Bytes ([string]$a.reports.sql)) -ne $acceptedSql) { Ko "$Label replaced the accepted SQL report"; return $false }
    if ((Get-Bytes ([string]$a.reports.dax)) -ne $acceptedDax) { Ko "$Label replaced the accepted DAX report"; return $false }
    if ((Get-Bytes ([string]$a.bindings.sql)) -ne $acceptedSqlBinding) { Ko "$Label replaced the trusted SQL binding"; return $false }
    if ((Get-Bytes ([string]$a.bindings.dax)) -ne $acceptedDaxBinding) { Ko "$Label replaced the trusted DAX binding"; return $false }
    if (Get-Log 'coop-data-doc') { Ko "$Label reached configured coop-data-doc ingestion"; return $false }
    if (Test-Path -LiteralPath (Join-Path $reviews 'suite.html')) { Ko "$Label generated suite HTML from a rejected or stale report"; return $false }
    return $true
  }
  $case1b = $true
  foreach ($mode in @('no_report', 'malformed', 'missing', 'bad_path', 'bad_hash', 'bad_revision')) {
    $before = Get-QuarantineCount
    Clear-Logs
    $env:COOP_TEST_PROVENANCE_MODE = $mode
    $r = Invoke-Review @('--html')
    Remove-Item -LiteralPath 'Env:\COOP_TEST_PROVENANCE_MODE' -ErrorAction SilentlyContinue
    if ($r.Rc -ne 2) { Ko "$mode provenance should fail closed with exit 2 (got $($r.Rc))" $r.Out; $case1b = $false; continue }
    if (-not $r.Out.Contains('run rejected')) { Ko "$mode rejection diagnostic missing" $r.Out; $case1b = $false }
    if (-not (Test-AcceptedIntact $mode)) { $case1b = $false }
    # Quarantine is asserted on Windows only: the raw run files are dot-files
    # (`.coop-sql-review.current.*.json`), and on POSIX pwsh Get-Item without
    # -Force cannot see hidden dot-files, so bin/coop.ps1's Move-Item never runs
    # there. Windows does not mark dot-files hidden, so the product path works.
    if ($isWindowsHost -and $mode -ne 'no_report' -and (Get-QuarantineCount) -le $before) { Ko "$mode raw reviewer output was not quarantined"; $case1b = $false }
  }
  if ($case1b) {
    if ($isWindowsHost) { Ok 'rejected reports are quarantined; accepted LKG/configured docs/suite HTML stay isolated' }
    else { Ok 'rejected reports keep accepted LKG/configured docs/suite HTML isolated (quarantine move asserted on Windows only)' }
  }

  # 1c. One valid / one rejected is one rejected run: neither report nor binding advances.
  $case1c = $true
  foreach ($pair in @(@('valid', 'bad_hash'), @('bad_hash', 'valid'))) {
    Clear-Logs
    $env:COOP_TEST_SQL_MODE = $pair[0]; $env:COOP_TEST_DAX_MODE = $pair[1]
    $r = Invoke-Review @('--html')
    foreach ($n in @('COOP_TEST_SQL_MODE', 'COOP_TEST_DAX_MODE')) { Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue }
    $label = "asymmetric $($pair -join ' ')"
    if ($r.Rc -ne 2) { Ko "$label should fail closed (got $($r.Rc))" $r.Out; $case1c = $false; continue }
    if (-not (Test-AcceptedIntact $label)) { $case1c = $false }
  }
  if ($case1c) { Ok 'asymmetric SQL/DAX mutation preserves one coherent accepted run' }

  # 2. --skip-docs: linters run, data-doc is never called.
  Clear-Logs
  $r = Invoke-Review @('--skip-docs')
  if ($r.Rc -ne 0) { Ko "coop review --skip-docs should exit 0 (got $($r.Rc))" $r.Out }
  elseif (-not (Get-Log 'coop-sql-review')) { Ko '--skip-docs must still run the linters' }
  elseif (Get-Log 'coop-data-doc') { Ko '--skip-docs must not invoke coop-data-doc' }
  else { Ok '--skip-docs runs the linters only' }

  # 3. Explicit paths win over the contract scope.
  Clear-Logs
  $elsewhere = Join-Path $t 'elsewhere'
  $r = Invoke-Review @($elsewhere, '--skip-docs')
  $log = Get-Log 'coop-sql-review'
  if ($r.Rc -ne 0) { Ko "explicit-path review should exit 0 (got $($r.Rc))" $r.Out }
  elseif (-not $log -or -not $log.Contains("check $elsewhere --format json")) { Ko 'explicit path not passed to the linter' $log }
  elseif ($log.Contains('sqlrepo')) { Ko 'contract scope leaked in despite explicit paths' $log }
  else { Ok 'explicit paths win over the contract' }

  # 4. --strict: passed to both linters; a failing linter makes coop review exit 2.
  Clear-Logs
  $r = Invoke-Review @('--strict', '--skip-docs')
  $sqlLog = Get-Log 'coop-sql-review'; $daxLog = Get-Log 'coop-dax-review'
  if ($r.Rc -ne 2) { Ko "--strict with failing linters should exit 2 (got $($r.Rc))" $r.Out }
  elseif (-not $sqlLog -or -not $sqlLog.Contains('--strict')) { Ko '--strict not passed to coop-sql-review' $sqlLog }
  elseif (-not $daxLog -or -not $daxLog.Contains('--strict')) { Ko '--strict not passed to coop-dax-review' $daxLog }
  else { Ok '--strict flows to both linters and exits 2 on a failing linter' }

  # 5. data-doc's friendly "no config" exit 1 is a hint, not a failure; a hard exit 2 propagates.
  $env:COOP_TEST_DD_RC = '1'; $r1 = Invoke-Review
  $env:COOP_TEST_DD_RC = '2'; $r2 = Invoke-Review
  Remove-Item -LiteralPath 'Env:\COOP_TEST_DD_RC' -ErrorAction SilentlyContinue
  if ($r1.Rc -ne 0) { Ko "data-doc exit 1 (no config) must not fail the run (got $($r1.Rc))" $r1.Out }
  elseif ($r2.Rc -ne 2) { Ko "data-doc exit 2 (hard failure) must propagate (got $($r2.Rc))" $r2.Out }
  else { Ok 'data-doc no-config is a hint; a hard failure propagates' }

  # 6. No contract + no paths dies with guidance, never blind-scans the cwd. A fake
  #    COOP_ROOT (a copy of bin/coop.ps1 + lib, no .coop/) removes the bundled
  #    .coop/project.yml fallback so "no contract anywhere" is reproducible.
  $fakeRoot = Join-Path $t 'fakeroot'
  New-Item -ItemType Directory -Force -Path (Join-Path $fakeRoot 'bin'), (Join-Path $fakeRoot 'config') | Out-Null
  Copy-Item -LiteralPath $coop -Destination (Join-Path $fakeRoot 'bin\coop.ps1')
  Copy-Item -LiteralPath (Join-Path $root 'lib') -Destination (Join-Path $fakeRoot 'lib') -Recurse
  Copy-Item -LiteralPath (Join-Path $root 'VERSION') -Destination (Join-Path $fakeRoot 'VERSION')
  Copy-Item -LiteralPath (Join-Path $root 'config\release-manifest.json') -Destination (Join-Path $fakeRoot 'config\release-manifest.json')
  Clear-Logs
  $r = Invoke-Review @() (Join-Path $t 'nowhere') (Join-Path $fakeRoot 'bin\coop.ps1')
  if ($r.Rc -eq 0) { Ko 'no-contract + no-paths must exit non-zero' $r.Out }
  elseif (-not ($r.Out.Contains('.coop/project.yml') -and $r.Out.Contains('pass paths'))) { Ko 'die message should point at .coop/project.yml and passing paths' $r.Out }
  elseif (Get-Log 'coop-sql-review') { Ko 'no-contract run must not invoke the linters' }
  else { Ok 'no contract + no paths dies with guidance, no blind cwd scan' }

  # 7. --compare: after a prior report exists, each linter gets --diff-against a
  #    snapshot of the previous report; a first run (no prior report) passes none.
  function Reset-Generations {
    Remove-Item -LiteralPath (Join-Path $reviews 'active-review-generation.json') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $reviews 'accepted-generations') -Recurse -Force -ErrorAction SilentlyContinue
  }
  Clear-Logs; Reset-Generations
  $null = Invoke-Review @('--skip-docs')            # baseline run: writes the reports
  Clear-Logs
  $r = Invoke-Review @('--skip-docs', '--compare')
  $sqlLog = Get-Log 'coop-sql-review'; $daxLog = Get-Log 'coop-dax-review'
  $case7 = $true
  if ($r.Rc -ne 0) { Ko "coop review --compare should exit 0 (got $($r.Rc))" $r.Out; $case7 = $false }
  elseif (-not $sqlLog -or -not $sqlLog.Contains('--diff-against')) { Ko '--compare did not pass --diff-against to coop-sql-review' $sqlLog; $case7 = $false }
  elseif (-not $daxLog -or -not $daxLog.Contains('--diff-against')) { Ko '--compare did not pass --diff-against to coop-dax-review' $daxLog; $case7 = $false }
  Clear-Logs; Reset-Generations                      # no prior report now
  $null = Invoke-Review @('--skip-docs', '--compare')
  $sqlLog = Get-Log 'coop-sql-review'
  if ($sqlLog -and $sqlLog.Contains('--diff-against')) { Ko '--compare on a first run must not pass --diff-against' $sqlLog; $case7 = $false }
  if ($case7) { Ok '--compare diffs against the previous report (baseline no-op on the first run)' }

  # 8. --diff: uses git to construct the scope (changed files only).
  Clear-Logs
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    & git -C $proj init -q 2>&1 | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $sqlRepo 'old.sql'), "--`n", $utf8)
    & git -C $proj add sqlrepo/old.sql 2>&1 | Out-Null
    & git -C $proj -c user.email=test@example.com -c user.name=Test commit -q -m init 2>&1 | Out-Null
  } finally { $ErrorActionPreference = $eap }
  [System.IO.File]::WriteAllText((Join-Path $sqlRepo 'new.sql'), '', $utf8)
  $r = Invoke-Review @('--skip-docs', '--diff')
  $sqlLog = Get-Log 'coop-sql-review'
  if ($r.Rc -ne 0) { Ko "coop review --diff should exit 0 (got $($r.Rc))" $r.Out }
  elseif (-not $sqlLog -or -not $sqlLog.Contains('new.sql')) { Ko '--diff did not pass the changed file' $sqlLog }
  elseif ($sqlLog.Contains('old.sql')) { Ko '--diff passed an unchanged file' $sqlLog }
  else { Ok '--diff scopes to changed files via git' }
} catch {
  Ko "fixture error: $($_.Exception.Message)" ($_.ScriptStackTrace)
} finally {
  Set-Location -LiteralPath $savedLocation
  foreach ($n in $names) {
    if ($null -eq $saved[$n]) { Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
  }
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}

if ($fail -ne 0) { Write-Host '  x coop review (composite linters + docs compose, PowerShell) tests FAILED'; exit 1 }
Write-Host '  coop review (composite linters + docs compose, PowerShell) tests passed'
exit 0

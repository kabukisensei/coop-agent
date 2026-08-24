#!/usr/bin/env pwsh
#
# Pi compatibility matrix for ONE runtime version — WINDOWS twin of
# scripts/test-pi-matrix.sh (Slice 4). Run on a Windows host:
#   pwsh -File scripts/test-pi-matrix.ps1 -PiVersion 0.84.3 [-RepoRoot <path>]
#
# Everything is written under a temp directory; the workstation's global npm
# packages and ~/.pi / ~/.coop are never modified. The optional live agent turn
# copies auth.json IN.
param(
  [Parameter(Mandatory = $true)][string]$PiVersion,
  [string]$RepoRoot = ""
)
$ErrorActionPreference = 'Continue'
if (-not $RepoRoot) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$Manifest = Join-Path $RepoRoot 'config\release-manifest.json'

$script:Pass = 0; $script:Failed = 0; $script:Skipped = 0
function Ok($m)  { Write-Host "  OK  $m"; $script:Pass++ }
function Ko($m)  { Write-Host "  FAIL $m"; $script:Failed++ }
function SkipM($m){ Write-Host "  --  $m"; $script:Skipped++ }

$T = Join-Path ([System.IO.Path]::GetTempPath()) ("coop-pi-matrix-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $T | Out-Null
Write-Host "-- Pi $PiVersion matrix (root: $T)"

try {
  # --- 1. Runtime from an explicit temporary npm prefix ------------------------
  $NpmPrefix = Join-Path $T 'npmpkg'
  $npm = (Get-Command npm -ErrorAction SilentlyContinue).Source
  $npmOut = & $npm install --no-audit --no-fund --global --prefix $NpmPrefix ("@earendil-works/pi-coding-agent@" + $PiVersion) 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { Ko "npm install of Pi failed: $($npmOut.Trim())"; exit 1 }
  # npm's Windows prefix layout has varied: traditional global installs expose
  # pi.cmd at the prefix root, while some npm releases place it under a bin or
  # node_modules/.bin directory. Resolve the actual launcher, don't assume one.
  $PiBin = @(
    (Join-Path $NpmPrefix 'pi.cmd'),
    (Join-Path $NpmPrefix 'bin\pi.cmd'),
    (Join-Path $NpmPrefix 'node_modules\.bin\pi.cmd')
  ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $PiBin) {
    $found = @(Get-ChildItem -LiteralPath $NpmPrefix -Filter 'pi.cmd' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 5 -ExpandProperty FullName)
    Ko "pi binary missing after install (found: $($found -join ', '))"
    exit 1
  }
  $PiPackageDir = @(
    (Join-Path $NpmPrefix 'node_modules\@earendil-works\pi-coding-agent'),
    (Join-Path $NpmPrefix 'lib\node_modules\@earendil-works\pi-coding-agent')
  ) | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'package.json') -PathType Leaf } | Select-Object -First 1
  if (-not $PiPackageDir) { Ko 'Pi package directory missing after install'; exit 1 }
  $runtimeVer = (& $PiBin --version 2>$null | Select-String -Pattern '\d+\.\d+\.\d+').Matches.Value
  if ($runtimeVer -eq $PiVersion) { Ok "runtime $PiVersion resolves from temporary prefix" } else { Ko "runtime version mismatch: $runtimeVer" }

  $env:PI_CODING_AGENT_DIR = Join-Path $T 'agent'
  $env:COOP_AGENT_DIR      = $env:PI_CODING_AGENT_DIR
  $env:COOP_DIR            = Join-Path $T 'coop-dir'
  New-Item -ItemType Directory -Force -Path $env:PI_CODING_AGENT_DIR, (Join-Path $env:COOP_DIR '.coop') | Out-Null
  '{"schema_version":1,"azure":{"enabled":false,"tenant_id":"","tenant_name":""},"integrations":{"microsoft_learn":true},"azure_devops":{"organization":""},"mcp":{"safe_mode":"read_only_first"},"fleet":{"publish_dir":""}}' |
    Set-Content (Join-Path $env:COOP_DIR '.coop\config')

  # --- 2. Exact manifest extension fleet ---------------------------------------
  $fleet = node -e "const m=require(process.argv[1]);console.log(Object.entries(m.extensions||{}).map(([k,v])=>k+'@'+v).join('\n'))" $Manifest
  foreach ($spec in @($fleet)) {
    & $PiBin install "npm:$spec" *> $null
    if ($LASTEXITCODE -eq 0) { Ok "installed npm:$spec" } else { Ko "install failed: npm:$spec" }
  }
  # --- 3. coop sync — PRODUCTION convergence, temp runtime FIRST on PATH --------
  # Prepend the temporary prefix so sync.ps1 resolves THIS matrix runtime, not
  # the workstation's global pi. Sync must exit zero: it performs exact-pin
  # convergence and postcondition verification itself, so no harness-side
  # installation happens here.
  $env:PATH = "$(Split-Path -Parent $PiBin);" + $env:PATH
  $syncOut = & (Join-Path $RepoRoot 'scripts\sync.ps1') 2>&1
  $syncRc = $LASTEXITCODE
  $syncText = $syncOut | Out-String
  if ($syncRc -ne 0) {
    Ko ("production sync exited {0} (must be zero)" -f $syncRc)
    $syncText -split "`n" | Select-Object -Last 3 | ForEach-Object { Ko $_ }
  } elseif (($syncOut | Out-String) -match 'Installed release version|Already at release version') {
    Ok 'production sync converged (exit 0, precise convergence messages)'
  } else {
    Ko 'sync output lacks convergence messages'
  }


  # --- 5. Inventory postconditions ----------------------------------------------
  $agentNm = Join-Path $env:PI_CODING_AGENT_DIR 'npm\node_modules'
  function VerOf([string]$pkg) {
    $pj = Join-Path $agentNm "$pkg\package.json"
    if (-not (Test-Path $pj)) { return '' }
    try { return ([string]((Get-Content $pj -Raw | ConvertFrom-Json).version)) } catch { return '' }
  }
  foreach ($spec in @($fleet)) {
    $name = $spec.Substring(0, $spec.LastIndexOf('@')); $want = $spec.Substring($spec.LastIndexOf('@') + 1)
    $got = VerOf $name
    if ($got -eq $want) { Ok "$name at manifest version $want" } else { Ko "$name version '$got', wanted $want" }
  }
  $pkgJson = Get-Content (Join-Path $PiPackageDir 'package.json') -Raw | ConvertFrom-Json
  foreach ($lib in @('@earendil-works/pi-ai', '@earendil-works/pi-tui')) {
    $req = $pkgJson.dependencies.$lib
    $got = VerOf $lib.Replace('/', '\')
    if (-not $req) { if ($got) { Ok "$lib present (runtime declares no exact requirement)" } else { Ko "$lib MISSING" } ; continue }
    $base = $req -replace '^[^\d]*', ''
    if ($got -eq $base) { Ok "$lib $got satisfies runtime requirement ($req)" } else { Ko "$lib '$got' does not satisfy $req" }
  }
  $nested = @(Get-ChildItem -Recurse -Directory -Filter 'pi-ai' $agentNm -ErrorAction SilentlyContinue |
              Where-Object { $_.FullName -notmatch 'node_modules\\@earendil-works\\pi-coding-agent\\' })
  if ($nested.Count -eq 0) { Ok 'no nested/hoisted pi-ai or pi-tui copies' } else { Ko "nested shared-lib copies found" }

  $cmEntry = Join-Path $agentNm 'context-mode'
  if (Test-Path $cmEntry) { Ok ("context-mode installed ({0})" -f (VerOf 'context-mode')) } else { Ko 'context-mode MISSING' }
  try { Get-Content (Join-Path $env:PI_CODING_AGENT_DIR 'mcp.json') -Raw | ConvertFrom-Json | Out-Null; Ok 'generated mcp.json parses' }
  catch { Ko 'mcp.json missing or invalid' }

  # --- 6. First-party extensions through the REAL Pi loader ---------------------
  $loader = Join-Path $PiPackageDir 'dist\core\extensions\loader.js'
  $probe = Join-Path $T 'load-probe.mjs'
  $srcs = @('coop-powerline','coop-tools','coop-guardrails','coop-profile' | ForEach-Object { Join-Path $RepoRoot "extensions\$_\index.ts" })
  @"
import { pathToFileURL } from "node:url";
const { createExtensionRuntime, loadExtensions } = await import(pathToFileURL(`$(JSON.stringify($loader.replace(/\\/g,'/')))`).href);
const targets = process.argv.slice(2).map((p) => pathToFileURL(p.replace(/\\\\/g, '/')).href);
const result = await loadExtensions(targets, process.cwd(), undefined, createExtensionRuntime());
console.log(JSON.stringify({ n: result.extensions.length, errors: result.errors }));
"@ | Set-Content $probe
  $loadOut = node $probe @srcs 2>&1 | Out-String
  if ($loadOut -match '"errors":\[\]') { Ok 'real Pi loader loaded all first-party extensions without error' }
  else { Ko "loader errors: $($loadOut.Trim())" }

  # --- 7. RPC startup -> usable session -> clean shutdown ------------------------
  $authSrc = Join-Path $HOME '.pi\agent\auth.json'
  $authDst = Join-Path $env:PI_CODING_AGENT_DIR 'auth.json'
  if ((Test-Path $authSrc) -and ($authSrc -ne $authDst)) { Copy-Item $authSrc $authDst -ErrorAction SilentlyContinue }
  $rpc = Join-Path $T 'rpc-probe.mjs'
  @"
import { spawn } from "node:child_process";
const child = spawn(process.argv[2], ["--mode", "rpc", "--no-session"], { stdio: ["pipe", "pipe", "pipe"] });
let gotState = false, events = 0;
const timer = setTimeout(() => { try { child.kill(); } catch {} }, 90000);
child.stdout.on("data", () => {});
child.stdout.on("data", (d) => {
  events += d.toString().split("\n").filter(l => l.trim()).length;
  if (!gotState) { gotState = true; clearTimeout(timer); try { child.kill(); } catch {} }
});
child.stdin.write(JSON.stringify({ id: 1, type: "get_state" }) + "\n");
child.once("close", (code) => console.log(JSON.stringify({ code, gotState, events })));
"@ | Set-Content $rpc
  $rpcOut = node $rpc $PiBin 2>$null | Select-Object -Last 1
  try { $r = $rpcOut | ConvertFrom-Json } catch { $r = $null }
  if ($r -and $r.gotState) { Ok "RPC startup reached a usable session (exit $($r.code))" }
  elseif ($rpcOut -match 'auth|provider|login') { SkipM "RPC session unavailable without provider here" }
  else { Ko "RPC startup unusable: $rpcOut" }

  # --- 8. Second sync idempotent --------------------------------------------------
  $sync2 = & (Join-Path $RepoRoot 'scripts\sync.ps1') 2>&1
  $sync2Rc = $LASTEXITCODE
  if ($sync2Rc -eq 0 -and (($sync2 | Out-String) -match 'Already at release version')) {
    Ok "second sync is idempotent ('Already at release version')"
  } else { Ko "second sync not idempotent (exit $sync2Rc)" }

  # --- 9. Deliberate skew (temporary tree only) -----------------------------------
  $skewPkg = Join-Path $T 'skewpkg'
  & $npm install --silent --no-audit --no-fund --prefix $skewPkg '@earendil-works/pi-ai@0.82.1' *> $null
  $skewSrc = Join-Path $skewPkg 'node_modules\@earendil-works\pi-ai'
  $aiDir = Join-Path $agentNm '@earendil-works\pi-ai'
  if (Test-Path $skewSrc) {
    Remove-Item -Recurse -Force $aiDir -ErrorAction SilentlyContinue
    Copy-Item $skewSrc $aiDir -Recurse
    Ok 'deliberate skew planted (pi-ai 0.82.1)'
    # Repair via PRODUCTION sync only; require exit zero before reading state.
    & (Join-Path $RepoRoot 'scripts\sync.ps1') *> $null
    if ($LASTEXITCODE -ne 0) {
      Ko "production sync failed during skew repair (exit $LASTEXITCODE)"
    } else {
      $repaired = VerOf '@earendil-works/pi-ai'
      if ($repaired -eq $base) { Ok "convergence repaired the skew (pi-ai back to $base)" } else { Ko "skew not repaired (pi-ai: $repaired)" }
    }
  } else { SkipM 'skew planting failed (network?)' }
}
finally {
  Remove-Item -Recurse -Force $T -ErrorAction SilentlyContinue
}

Write-Host ("-- Pi {0} result: {1} passed, {2} failed, {3} skipped" -f $PiVersion, $script:Pass, $script:Failed, $script:Skipped)
if ($script:Failed -gt 0) { exit 1 }

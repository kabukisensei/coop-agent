#!/usr/bin/env pwsh
# Port of tests/doctor.test.sh (master plan S1): scripts/doctor.ps1 --json rows
# that tests/fixtures/doctor-warehouse.test.ps1 does not already cover.
#   A. config/mcp.example.json is an empty documentation skeleton (no pins).
#   B. the Warehouse (fabric-sqlendpoint) states map to their exact hints, and
#      a registered probe names the tenant it minted for (python3 stub).
#   C. the Azure sign-in row (H2) against the shared fake az: no tenant, signed
#      out (exact sign-in command, probe only, never az login), signed in, and
#      never the launch cache (.az-ok).
#   D. Power BI Modeling MCP modes: started+read-only, missing --start, the
#      governed read-write mode (#159), a flagless entry, and no agent config.
#   E. model login (#167): Pi's startup {} auth.json is not a login; a stored
#      provider credential in the shared ~/.pi/agent is.
#   F. the extension fleet against the manifest pins through a stub `pi list`:
#      a pinned fleet is green, drift is flagged, the spec line (not the install
#      path) carries the version, and a same-version duplicate still proves the pin.
#   G. Get-CoopPiExtensionVersions parser cases (pre-release, case, malformed,
#      whitespace, CRLF), in process.
#   H. a GENERATED, pretty-printed mcp-adapter.json (lib/mcp_config.py) reads
#      as the governed read-write modeling mode.
# Sandboxed HOME/USERPROFILE/COOP_DIR/agent dir, never ~/.coop; COOP_SKIP_AZ=1
# except in C (fake az); a fresh fetch stamp keeps doctor offline. No waits.
# Assertions stay ASCII: Windows PowerShell 5.1 re-encodes child output.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$psExe = try { (Get-Process -Id $PID).Path } catch { 'pwsh' }
$isWindowsHost = ($env:OS -eq 'Windows_NT')
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-doctor-ps-' + [guid]::NewGuid().ToString('N'))
$fail = 0
function Ok([string]$m) { Write-Host "  ok $m" }
function Ko([string]$m, [string]$out = '') { Write-Host "  x $m"; if ($out) { Write-Host $out }; $script:fail = 1 }

$sandboxHome = Join-Path $t 'home'
$agent = Join-Path $t 'agent'
$cwd = Join-Path $t 'cwd'
$whBin = Join-Path $t 'whbin'
$azBin = Join-Path $t 'azbin'
$azState = Join-Path $t 'azstate'
$azCoop = Join-Path $t 'azcoop'
$piBin = Join-Path $t 'pibin'
$doctor = Join-Path $root 'scripts\doctor.ps1'
$manifest = Join-Path $root 'config\release-manifest.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$sep = [System.IO.Path]::PathSeparator

$saved = @{}
$names = @('PATH','HOME','USERPROFILE','COOP_DIR','COOP_AGENT_DIR','PI_CODING_AGENT_DIR','COOP_NO_ISOLATE','COOP_SKIP_AZ','NO_COLOR',
           'COOP_STANDARDS_ROOT','COOP_STANDARDS_STATE','COOP_STANDARDS_SNAPSHOT_ROOT','COOP_WAREHOUSE_TEST_STATE',
           'COOP_WAREHOUSE_TEST_TENANT','COOP_TEST_AZ_STATE','COOP_TEST_PI_LIST_MODE','COOP_TEST_MANIFEST')
foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
$basePath = $env:PATH
$savedLocation = Get-Location
try {
  New-Item -ItemType Directory -Force -Path $sandboxHome, (Join-Path $t 'coop\.coop'), $agent, $cwd, $whBin, $azBin, $azState, (Join-Path $azCoop '.coop'), $piBin | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $agent '.coop-fetch-stamp'), '')
  $env:HOME = $sandboxHome
  $env:USERPROFILE = $sandboxHome
  $env:COOP_DIR = Join-Path $t 'coop'
  $env:COOP_AGENT_DIR = $agent
  $env:COOP_SKIP_AZ = '1'
  $env:NO_COLOR = '1'
  $env:COOP_TEST_MANIFEST = $manifest
  foreach ($n in @('PI_CODING_AGENT_DIR','COOP_NO_ISOLATE','COOP_STANDARDS_ROOT','COOP_STANDARDS_STATE','COOP_STANDARDS_SNAPSHOT_ROOT',
                   'COOP_WAREHOUSE_TEST_STATE','COOP_WAREHOUSE_TEST_TENANT','COOP_TEST_PI_LIST_MODE')) {
    Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue
  }
  Set-Location -LiteralPath $cwd
  . (Join-Path $root 'lib\common.ps1')
  $realPy = Get-CoopPython
  if (-not $realPy) { throw 'a real python is required for this fixture' }
  $node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source

  # A command backed by a Python script: <Name>.cmd on Windows, a sh launcher elsewhere.
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
  function Get-DoctorRows() {
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
      $raw = (& $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $doctor --json 2>$null | Out-String)
    } finally {
      $ErrorActionPreference = $eap
    }
    $doc = @($raw -split "`r?`n" | Where-Object { $_.StartsWith('{"checks"') }) | Select-Object -Last 1
    if (-not $doc) { throw "doctor.ps1 --json printed no document: $raw" }
    return @(($doc | ConvertFrom-Json).checks)
  }
  function Find-Rows($Rows, [string]$Needle) { @($Rows | Where-Object { ([string]$_.name).Contains($Needle) }) }
  function Find-Row($Rows, [string]$Needle) { Find-Rows $Rows $Needle | Select-Object -First 1 }
  function Show-Rows($Rows, [string]$Needle) {
    (@($Rows | Where-Object { ([string]$_.name).Contains($Needle) -or ([string]$_.section).Contains($Needle) } | ForEach-Object { "$($_.status) | $($_.name) | $($_.hint)" }) -join "`n")
  }
  function Set-Adapter([string]$Json) { [System.IO.File]::WriteAllText((Join-Path $agent 'mcp-adapter.json'), $Json, $utf8) }

  # --- A. checked-in example is documentation only; the generator owns runtime specs
  $example = Get-Content -LiteralPath (Join-Path $root 'config\mcp.example.json') -Raw
  if ($example -match '"mcpServers":\s*\{\s*\}' -and $example -notmatch '@latest|TODO-') { Ok 'mcp.example.json carries no duplicate runtime package authority' }
  else { Ko 'mcp.example.json must remain an empty documentation skeleton' }

  # --- B. Warehouse token-acquisition states -> exact guidance ---------------------
  # python3 stub: answers the interpreter probe and warehouse_mcp.py only, so the
  # Warehouse row is driven by COOP_WAREHOUSE_TEST_STATE / _TENANT.
  if ($isWindowsHost) {
    [System.IO.File]::WriteAllText((Join-Path $whBin 'python3.cmd'), (@(
      '@echo off',
      'if "%~1"=="--version" (echo Python 3.12.0& exit /b 0)',
      'if /i "%~nx1"=="warehouse_mcp.py" goto warehouse',
      'exit /b 1',
      ':warehouse',
      'if /i "%~2"=="tenant" goto tenant',
      'echo {"state":"%COOP_WAREHOUSE_TEST_STATE%","target":{"scope":"global"},"tenant":"%COOP_WAREHOUSE_TEST_TENANT%"}',
      'exit /b 0',
      ':tenant',
      'if "%COOP_WAREHOUSE_TEST_TENANT%"=="" exit /b 1',
      'echo %COOP_WAREHOUSE_TEST_TENANT%',
      'exit /b 0'
    ) -join "`r`n") + "`r`n", [System.Text.Encoding]::ASCII)
  } else {
    $whPy = Join-Path $whBin 'python3'
    [System.IO.File]::WriteAllText($whPy, (@(
      '#!/bin/sh',
      'case "${1:-}" in',
      '  --version) echo "Python 3.12.0"; exit 0 ;;',
      '  *warehouse_mcp.py)',
      '    if [ "${2:-}" = tenant ]; then [ -n "${COOP_WAREHOUSE_TEST_TENANT:-}" ] || exit 1; printf ''%s\n'' "$COOP_WAREHOUSE_TEST_TENANT"; exit 0; fi',
      '    printf ''{"state":"%s","target":{"scope":"global"},"tenant":"%s"}\n'' "$COOP_WAREHOUSE_TEST_STATE" "${COOP_WAREHOUSE_TEST_TENANT:-}"',
      '    exit 0 ;;',
      'esac',
      'exit 1'
    ) -join "`n") + "`n", $utf8)
    & chmod +x $whPy
  }
  Set-Adapter '{"mcpServers":{"fabric-sqlendpoint":{"command":"npx","args":["-y","mcp-remote@0.1.38","https://api.fabric.microsoft.com/v1/mcp/dataPlane/sqlEndpoint","--transport","http-only","--silent"]}}}'
  $env:PATH = "$whBin$sep$basePath"
  $hints = @(
    @('azure_cli_unavailable', 'install/repair Azure CLI and ensure az is on PATH; this is not an authentication diagnosis'),
    @('token_timeout', 'Azure CLI token command exceeded the bounded timeout; retry after checking Azure CLI responsiveness'),
    @('token_output_invalid', 'Azure CLI returned no usable accessToken JSON; verify the Fabric token command output'),
    @('auth_required', 'sign in with Azure CLI/tenant access; doctor never triggers login')
  )
  foreach ($pair in $hints) {
    $state = $pair[0]; $hint = $pair[1]
    $env:COOP_WAREHOUSE_TEST_STATE = $state
    $rows = Get-DoctorRows
    $wh = Find-Row $rows "fabric-sqlendpoint $state (global target)"
    if ($null -ne $wh -and $wh.status -eq 'warn' -and ([string]$wh.hint).Contains($hint)) { Ok "doctor maps Warehouse $state to accurate guidance" }
    else { Ko "doctor misreported Warehouse $state" (Show-Rows $rows 'fabric') }
  }
  $tenant = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd'
  $env:COOP_WAREHOUSE_TEST_STATE = 'registered'
  $env:COOP_WAREHOUSE_TEST_TENANT = $tenant
  $rows = Get-DoctorRows
  $wh = Find-Row $rows "fabric-sqlendpoint registered (global target, tenant $tenant; direct HTTP"
  if ($null -ne $wh -and $wh.status -eq 'ok') { Ok 'doctor names the tenant the Warehouse probe minted for (registered)' }
  else { Ko 'doctor did not name the Warehouse probe tenant on the registered row' (Show-Rows $rows 'fabric') }
  foreach ($n in @('COOP_WAREHOUSE_TEST_STATE','COOP_WAREHOUSE_TEST_TENANT')) { Remove-Item -LiteralPath "Env:\$n" -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath (Join-Path $agent 'mcp-adapter.json') -Force
  $env:PATH = $basePath

  # --- C. Azure sign-in row (H2): probe only, never a sign-in, same tenant chain as the launch
  $fakeAz = Join-Path $root 'tests\fixtures\fake-az.mjs'
  if ($isWindowsHost) {
    [System.IO.File]::WriteAllText((Join-Path $azBin 'az.cmd'), "@`"$node`" `"$fakeAz`" %*`r`n", [System.Text.Encoding]::ASCII)
  } else {
    $azPath = Join-Path $azBin 'az'
    [System.IO.File]::WriteAllText($azPath, "#!/bin/sh`nexec `"$node`" `"$fakeAz`" `"`$@`"`n", $utf8)
    & chmod +x $azPath
  }
  [System.IO.File]::WriteAllText((Join-Path $azState 'argv.log'), '')
  $env:PATH = "$azBin$sep$basePath"
  $env:COOP_DIR = $azCoop
  $env:COOP_TEST_AZ_STATE = $azState
  Remove-Item -LiteralPath 'Env:\COOP_SKIP_AZ' -ErrorAction SilentlyContinue
  try {
    $rows = Get-DoctorRows
    $az = Find-Row $rows 'Azure sign-in: no client tenant configured'
    if ($null -ne $az -and $az.status -eq 'warn' -and ([string]$az.hint).Contains('run: coop onboard --config-only')) { Ok 'doctor warns when no client tenant is configured' }
    else { Ko 'doctor did not report the missing client tenant' (Show-Rows $rows 'Azure') }
    [System.IO.File]::WriteAllText((Join-Path $azCoop '.coop\config'), '{"schema_version":1,"azure":{"purpose":"client_resources","tenant_id":"tenant-9.example"}}', $utf8)
    [System.IO.File]::WriteAllText((Join-Path $azState 'argv.log'), '')
    $rows = Get-DoctorRows
    $az = Find-Row $rows 'Azure sign-in: not signed in to tenant tenant-9.example'
    if ($null -ne $az -and $az.status -eq 'warn' -and ([string]$az.hint).Contains('az login --tenant tenant-9.example --allow-no-subscriptions')) { Ok 'doctor reports a signed-out client tenant with the exact sign-in command' }
    else { Ko 'doctor did not report the signed-out tenant' (Show-Rows $rows 'Azure') }
    $azLines = @([System.IO.File]::ReadAllLines((Join-Path $azState 'argv.log')) | Where-Object { $_ })
    if (@($azLines | Where-Object { $_.StartsWith('login') }).Count -gt 0) { Ko 'doctor must never sign in' ($azLines -join "`n") }
    elseif (@($azLines | Where-Object { $_.StartsWith('account get-access-token --tenant tenant-9.example ') }).Count -eq 0) { Ko 'doctor did not probe the client tenant' ($azLines -join "`n") }
    else { Ok 'doctor only probes (no az login)' }
    [System.IO.File]::WriteAllText((Join-Path $azState 'tokens'), "tenant-9.example *`n")
    $rows = Get-DoctorRows
    $az = Find-Row $rows 'Azure sign-in: signed in to tenant tenant-9.example'
    if ($null -ne $az -and $az.status -eq 'ok') { Ok 'doctor reports a signed-in client tenant' }
    else { Ko 'doctor did not report the signed-in tenant' (Show-Rows $rows 'Azure') }
    if (-not (Test-Path -LiteralPath (Join-Path $agent '.az-ok'))) { Ok 'doctor never writes the launch cache (.az-ok)' } else { Ko 'doctor wrote the launch cache' }
  } finally {
    $env:COOP_SKIP_AZ = '1'
    $env:COOP_DIR = Join-Path $t 'coop'
    Remove-Item -LiteralPath 'Env:\COOP_TEST_AZ_STATE' -ErrorAction SilentlyContinue
    $env:PATH = $basePath
  }

  # --- D. Power BI Modeling MCP modes (agent-dir mcp-adapter.json only, #165) ----
  Set-Adapter "{`n  `"mcpServers`": {`n    `"powerbi-modeling-mcp`": {`n      `"command`": `"npx`",`n      `"args`": [`"-y`", `"@microsoft/powerbi-modeling-mcp@latest`", `"--start`", `"--readonly`"]`n    }`n  }`n}`n"
  $rows = Get-DoctorRows
  if ($null -ne (Find-Row $rows 'started, read-only')) { Ok 'doctor reports powerbi-modeling-mcp started+read-only as healthy' } else { Ko 'doctor did not report good state' (Show-Rows $rows 'MCP') }
  Set-Adapter '{"mcpServers":{"powerbi-modeling-mcp":{"command":"npx","args":["-y","@microsoft/powerbi-modeling-mcp@latest","--readonly"]}}}'
  $rows = Get-DoctorRows
  $ns = Find-Row $rows 'missing --start'
  if ($null -ne $ns -and $ns.status -eq 'warn') { Ok 'doctor warns when powerbi-modeling-mcp lacks --start' } else { Ko 'doctor did not warn on missing --start' (Show-Rows $rows 'MCP') }
  Set-Adapter '{"mcpServers":{"powerbi-modeling-mcp":{"command":"npx","args":["-y","@microsoft/powerbi-modeling-mcp@latest","--start","--readwrite","--accept-eula"]}}}'
  $rows = Get-DoctorRows
  $rw = Find-Row $rows 'started, read-write; coop asks before each edit'
  if ($null -ne $rw -and $rw.status -eq 'ok') { Ok 'doctor reports the governed read-write powerbi-modeling-mcp as healthy' } else { Ko 'doctor did not report the governed read-write mode' (Show-Rows $rows 'MCP') }
  if (@(Find-Rows $rows 'READ-WRITE').Count -eq 0) { Ok 'doctor no longer warns that read-write is accidental' } else { Ko 'doctor still warns that read-write is unsafe' (Show-Rows $rows 'MCP') }
  Set-Adapter '{"mcpServers":{"powerbi-modeling-mcp":{"command":"npx","args":["-y","@microsoft/powerbi-modeling-mcp@latest"]}}}'
  $rows = Get-DoctorRows
  if ($null -ne (Find-Row $rows 'missing --start')) { Ok 'doctor treats a flagless powerbi-modeling-mcp as unusable' } else { Ko 'doctor did not warn on unusable modeling config' (Show-Rows $rows 'MCP') }
  # No agent config at all: a work repo's .mcp.json is named as unused, and the
  # section says no config was found (the config itself is never checked).
  Remove-Item -LiteralPath (Join-Path $agent 'mcp-adapter.json') -Force
  [System.IO.File]::WriteAllText((Join-Path $cwd '.mcp.json'), '{"mcpServers":{"powerbi-modeling-mcp":{"command":"npx","args":["-y","@microsoft/powerbi-modeling-mcp@latest"]}}}', $utf8)
  $rows = Get-DoctorRows
  $unused = Find-Row $rows ('not used: ' + (Join-Path $cwd '.mcp.json'))
  $none = Find-Row $rows 'no MCP config found'
  if ($null -ne $unused -and $null -ne $none -and $none.status -eq 'warn') { Ok "doctor names a work repo's .mcp.json as unused and reports no MCP config" } else { Ko 'doctor did not name the unused repo .mcp.json / missing config' (Show-Rows $rows 'MCP') }
  if ($null -eq (Find-Row $rows 'missing --start')) { Ok "doctor ignores a work repo's .mcp.json" } else { Ko 'doctor checked a repo .mcp.json that coop never reads' (Show-Rows $rows 'MCP') }
  Remove-Item -LiteralPath (Join-Path $cwd '.mcp.json') -Force

  # --- E/F. a stub pi: --version, and `pi list` from the manifest (COOP_TEST_PI_LIST_MODE)
  $null = New-PyStub $piBin 'pi' @'
import json, os, sys
args = sys.argv[1:]
if args[:1] == ['--version']:
    print('pi 0.87.1'); sys.exit(0)
if args[:1] == ['list']:
    mode = os.environ.get('COOP_TEST_PI_LIST_MODE', 'none')
    if mode == 'none':
        sys.exit(1)
    m = json.load(open(os.environ['COOP_TEST_MANIFEST']))['extensions']
    first = sorted(m)[0]
    for k, v in m.items():
        if mode == 'ok':
            print('  npm:%s@%s' % (k, v))
        elif mode == 'drift':
            print('  npm:%s@%s' % (k, '9.9.9' if k == first else v))
        elif mode == 'real':
            print('  npm:%s@%s' % (k, '9.9.9' if k == 'pi-mcp-adapter' else v))
            print('    HOME/.coop/agent/npm/node_modules/%s' % k)
        elif mode == 'dup':
            print('  npm:%s@%s' % (k, v))
            print('  npm:%s@%s' % (k, v))
            print('    HOME/.coop/agent/npm/node_modules/%s' % k)
    sys.exit(0)
sys.exit(1)
'@
  $env:PATH = "$piBin$sep$basePath"

  # E. model login (#167): Pi writes {} on startup; only a stored provider credential is a login.
  $sharedPi = Join-Path $sandboxHome '.pi\agent'
  New-Item -ItemType Directory -Force -Path $sharedPi | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $agent 'auth.json'), '{}', $utf8)
  [System.IO.File]::WriteAllText((Join-Path $sharedPi 'auth.json'), '{}', $utf8)
  $rows = Get-DoctorRows
  if ($null -ne (Find-Row $rows 'no Pi login found yet')) { Ok "doctor does not count Pi's startup {} auth.json as a login" } else { Ko 'doctor counted a {} auth.json as a login' (Show-Rows $rows 'login') }
  [System.IO.File]::WriteAllText((Join-Path $sharedPi 'auth.json'), '{"openai-codex":{"type":"oauth","access":"x"}}', $utf8)
  $rows = Get-DoctorRows
  if ($null -ne (Find-Row $rows 'Pi login present')) { Ok 'doctor finds a stored credential in the shared ~/.pi/agent auth.json' } else { Ko 'doctor missed a stored credential' (Show-Rows $rows 'login') }
  Remove-Item -LiteralPath (Join-Path $agent 'auth.json'), (Join-Path $sharedPi 'auth.json') -Force

  # F. exact extension-fleet verification against the manifest pins.
  function Get-ExtRows($Rows) { @($Rows | Where-Object { [string]$_.section -eq 'Pi extensions' }) }
  function Test-AnyExt($Rows, [string[]]$Needles) {
    foreach ($n in $Needles) { if (@(Find-Rows $Rows $n).Count -gt 0) { return $true } }
    return $false
  }
  $env:COOP_TEST_PI_LIST_MODE = 'ok'
  $ext = Get-ExtRows (Get-DoctorRows)
  if (@(Find-Rows $ext 'matches manifest').Count -gt 0) { Ok 'doctor verifies each managed extension against its manifest pin' } else { Ko 'doctor did not verify extension pins' (Show-Rows $ext 'Pi extensions') }
  if (-not (Test-AnyExt $ext @('not installed', 'differs from manifest', 'newer than manifest'))) { Ok 'a pinned fleet produces no extension warnings' } else { Ko 'pinned fleet must be green in the extension section' (Show-Rows $ext 'Pi extensions') }
  $env:COOP_TEST_PI_LIST_MODE = 'drift'
  $ext = Get-ExtRows (Get-DoctorRows)
  if (@(Find-Rows $ext 'newer than manifest').Count -gt 0) { Ok 'doctor flags an extension newer than its manifest pin' } else { Ko 'doctor missed extension drift' (Show-Rows $ext 'Pi extensions') }
  # Real `pi list` output (spec line + indented install path): only the spec line
  # carries the version; the install path also contains the extension name.
  $env:COOP_TEST_PI_LIST_MODE = 'real'
  $ext = Get-ExtRows (Get-DoctorRows)
  if (Test-AnyExt $ext @('pi-mcp-adapter 9.9.9 is newer than manifest', 'pi-mcp-adapter 9.9.9: differs from manifest')) { Ok 'doctor reads the spec line, not the install path, for the installed version' }
  elseif (@(Find-Rows $ext 'installed but version unknown').Count -gt 0) { Ko 'doctor ignored the spec line and lost the installed version' (Show-Rows $ext 'Pi extensions') }
  else { Ko 'doctor misread the installed extension version' (Show-Rows $ext 'Pi extensions') }
  # A same-version duplicate (one package under two sources) is a single proof.
  $env:COOP_TEST_PI_LIST_MODE = 'dup'
  $ext = Get-ExtRows (Get-DoctorRows)
  $pinMcp = Coop-ManifestGet -Key 'extensions.pi-mcp-adapter'
  if (@(Find-Rows $ext 'several versions').Count -gt 0) { Ko 'a same-version duplicate was reported as ambiguous' (Show-Rows $ext 'Pi extensions') }
  elseif (@(Find-Rows $ext "pi-mcp-adapter $pinMcp matches manifest").Count -gt 0) { Ok 'a same-version duplicate still proves the pin' }
  else { Ko 'duplicate spec line broke the pin proof' (Show-Rows $ext 'Pi extensions') }
  Remove-Item -LiteralPath 'Env:\COOP_TEST_PI_LIST_MODE' -ErrorAction SilentlyContinue
  $env:PATH = $basePath

  # --- G. Get-CoopPiExtensionVersions parser (in process) --------------------------
  $parserFixture = "  npm:pi-mcp-adapter@2.10.0`n    HOME/.coop/agent/npm/node_modules/pi-mcp-adapter`n  npm:pi-mcp-adapter@2.10.0-beta.1`n  npm:pi-mcp-adapter-tools@9.9.9"
  $parsed = @(Get-CoopPiExtensionVersions $parserFixture 'pi-mcp-adapter')
  if ($parsed.Count -eq 2 -and ($parsed -contains '2.10.0') -and ($parsed -contains '2.10.0-beta.1')) { Ok 'parser preserves pre-release conflicts and ignores paths/name prefixes' }
  else { Ko "parser returned unexpected versions: [$($parsed -join ', ')]" }
  foreach ($package in @('pi-mcp-adapter', '@scope/extension')) {
    $caseVersions = @(Get-CoopPiExtensionVersions "npm:${package}@2.10.0-beta.A`nnpm:${package}@2.10.0-beta.a" $package)
    if ($caseVersions.Count -eq 2) { Ok "parser preserves case-distinct prereleases: $package" } else { Ko "parser collapsed case-distinct prereleases: $package" }
    $buildVersions = @(Get-CoopPiExtensionVersions "npm:${package}@2.10.0+BUILD`nnpm:${package}@2.10.0+build" $package)
    if ($buildVersions.Count -eq 2) { Ok "parser preserves case-distinct builds: $package" } else { Ko "parser collapsed case-distinct builds: $package" }
    foreach ($suffix in @('2.10.0/path', '2.10.0@9.9.9', '2.10.0-..', '2.10.0+..', '02.10.0')) {
      $malformed = "npm:${package}@${suffix}"
      $bad = @(Get-CoopPiExtensionVersions $malformed $package)
      if ($bad.Count -eq 0) { Ok "parser rejects malformed package spec: $malformed" } else { Ko "parser accepted malformed package spec: $malformed" }
    }
    $trailing = @(Get-CoopPiExtensionVersions "npm:${package}@2.10.0  " $package)
    if ($trailing.Count -eq 1 -and $trailing[0] -eq '2.10.0') { Ok "parser normalizes trailing whitespace: $package" } else { Ko "parser rejected a whitespace-terminated spec: $package" }
    $crlf = @(Get-CoopPiExtensionVersions "npm:${package}@2.10.0`r`n" $package)
    if ($crlf.Count -eq 1 -and $crlf[0] -eq '2.10.0') { Ok "parser normalizes CRLF: $package" } else { Ko "parser rejected a CRLF-terminated spec: $package" }
  }

  # --- H. doctor against a GENERATED mcp-adapter.json (pretty-printed) ---------------
  $genCfg = Join-Path $t 'gen-config'
  [System.IO.File]::WriteAllText($genCfg, '{"schema_version":1,"azure":{"tenant_id":"tenant-1"},"integrations":{"fabric":false,"power_bi":true,"power_bi_modeling":true,"azure_devops":false,"microsoft_learn":false},"azure_devops":{"organization":"org"}}' + "`n", $utf8)
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $genOut = (& $realPy (Join-Path $root 'lib\mcp_config.py') --config $genCfg --output (Join-Path $agent 'mcp-adapter.json') 2>&1 | Out-String)
    $genRc = $LASTEXITCODE
  } finally { $ErrorActionPreference = $eap }
  if ($genRc -ne 0) { Ko 'generator failed on scratch config' $genOut }
  $rows = Get-DoctorRows
  if ($null -ne (Find-Row $rows 'powerbi-modeling-mcp configured (started, read-write; coop asks before each edit)')) { Ok 'doctor reads generated pretty-printed MCP JSON correctly' } else { Ko 'doctor misreads generated MCP JSON' (Show-Rows $rows 'MCP') }
  $genText = Get-Content -LiteralPath (Join-Path $agent 'mcp-adapter.json') -Raw
  if ($genText -match '"args": \[') { Ok 'fixture really is pretty-printed (multi-line args)' } else { Ok 'generator emitted compact JSON' }
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

if ($fail -ne 0) { Write-Host '  x doctor.ps1 MCP modes, login, fleet and Warehouse rows (PowerShell) tests FAILED'; exit 1 }
Write-Host '  doctor.ps1 MCP modes, login, fleet and Warehouse rows (PowerShell) tests passed'
exit 0

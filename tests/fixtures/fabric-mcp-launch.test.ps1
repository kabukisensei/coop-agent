$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$psHost = (Get-Process -Id $PID).Path
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("coop-fabric-token-" + [guid]::NewGuid().ToString('N'))
$bin = Join-Path $temp 'bin'
$agent = Join-Path $temp 'agent'
$marker = Join-Path $temp 'marker'
function ConvertTo-Base64Url([byte[]]$Bytes) {
  return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}
function ConvertFrom-Base64Url([string]$Value) {
  $padded = $Value.Replace('-','+').Replace('_','/')
  switch ($padded.Length % 4) {
    2 { $padded += '==' }
    3 { $padded += '=' }
  }
  return [Convert]::FromBase64String($padded)
}
$utf8 = [Text.Encoding]::UTF8
$token = (ConvertTo-Base64Url $utf8.GetBytes('{"alg":"none"}')) + '.' +
  (ConvertTo-Base64Url $utf8.GetBytes('{"tid":"11111111-1111-4111-8111-111111111111","oid":"22222222-2222-4222-8222-222222222222"}')) + '.' +
  (ConvertTo-Base64Url $utf8.GetBytes('launch-signature'))
$tokenParts = @($token -split '\.')
if ($tokenParts.Count -ne 3 -or $tokenParts[0] -match '=' -or $tokenParts[1] -match '=') {
  throw 'fixture token is not a canonical three-segment base64url JWT'
}
$tokenHeader = $utf8.GetString((ConvertFrom-Base64Url $tokenParts[0])) | ConvertFrom-Json
$tokenPayload = $utf8.GetString((ConvertFrom-Base64Url $tokenParts[1])) | ConvertFrom-Json
if ($tokenHeader.alg -ne 'none' -or
    $tokenPayload.tid -ne '11111111-1111-4111-8111-111111111111' -or
    $tokenPayload.oid -ne '22222222-2222-4222-8222-222222222222') {
  throw 'fixture token decoded claims do not match the expected JSON'
}
$helperDiagnostic = 'untrusted-helper-diagnostic-93b75a'
$helperTokenlike = 'tokenlike-helper-value-2309'
New-Item -ItemType Directory -Force -Path $bin,$agent,$marker | Out-Null
$azResponse = Join-Path $marker 'az-response.json'
$azResponseJson = '{"accessToken":"' + $token + '"}' + "`r`n"
[System.IO.File]::WriteAllText($azResponse, $azResponseJson, [Text.Encoding]::ASCII)
$oldPythonPath = $env:PYTHONPATH
try {
  $url = 'https://api.fabric.microsoft.com/v1/mcp/dataPlane/sqlEndpoint'
  $config = [ordered]@{
    mcpServers = [ordered]@{
      'fabric-sqlendpoint' = [ordered]@{
        url = $url
        auth = $false
        requestHeadersCommand = [ordered]@{
          command = 'node'
          args = @((Join-Path $root 'lib\fabric_request_headers.mjs'), $url)
          timeoutMs = 10000
        }
        requestTimeoutMs = 60000
        lifecycle = 'lazy'
        _coop_target = [ordered]@{
          scope = 'global'; workspace_id = ''; item_id = ''; item_type = ''
          reason = 'fixture'; client = ''; tenant_id = ''; environment = ''; item_name = ''
        }
      }
    }
    _coop = [ordered]@{ schema_version = 1; managed_servers = @('fabric-sqlendpoint') }
  }
  $config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $agent 'mcp.json') -Encoding UTF8

  if ($env:OS -eq 'Windows_NT') {
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $windowsPathDirs = @($bin, (Split-Path -Parent $nodePath), (Join-Path $env:SystemRoot 'System32'))
    foreach ($commandName in @('python3', 'python', 'git')) {
      $commandPath = (Get-Command $commandName -ErrorAction SilentlyContinue).Source
      if ($commandPath) { $windowsPathDirs += (Split-Path -Parent $commandPath) }
    }
    $windowsFixturePath = (@($windowsPathDirs | Select-Object -Unique) -join [System.IO.Path]::PathSeparator)
    $azProgram = Join-Path $bin 'fake-az.cjs'
    $azProgramSource = @'
const fs = require('node:fs');
const path = require('node:path');
const [marker, response, ...args] = process.argv.slice(2);
fs.writeFileSync(path.join(marker, 'az-helper-entry'), '1');
fs.writeFileSync(path.join(marker, 'az-argv'), args.join(' '));
const mode = fs.readFileSync(path.join(marker, 'az-mode'), 'utf8');
if (mode === 'auth') {
  process.stderr.write("ERROR: Please run 'az login' to setup account.\n");
  process.exit(1);
}
process.stdout.write(fs.readFileSync(response));
'@
    [System.IO.File]::WriteAllText($azProgram, $azProgramSource, [Text.Encoding]::ASCII)
    $azCmd = @'
@echo off
>"__MARKER__\az-wrapper-entry" echo 1
"__NODE__" "__PROGRAM__" "__MARKER__" "__RESPONSE__" %*
set "COOP_TEST_AZ_RC=%ERRORLEVEL%"
>"__MARKER__\az-child-rc" echo %COOP_TEST_AZ_RC%
exit /b %COOP_TEST_AZ_RC%
'@
    $azCmd.Replace('__NODE__', $nodePath).Replace('__PROGRAM__', $azProgram).Replace('__MARKER__', $marker).Replace('__RESPONSE__', $azResponse) | Set-Content -LiteralPath (Join-Path $bin 'az.cmd') -Encoding ASCII
    @'
@echo off
>"%COOP_TEST_MARKER%\pi-entry" echo 1
>"%COOP_TEST_MARKER%\pi-argv" echo %*
if not "%COOP_FABRIC_MCP_TOKEN%"=="" >"%COOP_TEST_MARKER%\pi-token-present" echo 1
if "%COOP_FABRIC_MCP_TOKEN%"=="%COOP_TEST_TOKEN%" >"%COOP_TEST_MARKER%\pi-token-match" echo 1
if "%COOP_TEST_EXPECT_TOKEN%"=="present" if not "%COOP_FABRIC_MCP_TOKEN%"=="%COOP_TEST_TOKEN%" (
  >"%COOP_TEST_MARKER%\pi-child-rc" echo 41
  exit /b 41
)
if "%COOP_TEST_EXPECT_TOKEN%"=="absent" if not "%COOP_FABRIC_MCP_TOKEN%"=="" (
  >"%COOP_TEST_MARKER%\pi-child-rc" echo 42
  exit /b 42
)
>"%COOP_TEST_MARKER%\pi-state" echo launched
>"%COOP_TEST_MARKER%\pi-child-rc" echo 0
exit /b 0
'@ | Set-Content -LiteralPath (Join-Path $bin 'pi.cmd') -Encoding ASCII
  } else {
    $azUnix = @'
#!/bin/sh
printf '%s\n' "$*" > '__MARKER__/az-argv'
if [ "$(cat '__MARKER__/az-mode')" = auth ]; then
  printf '%s\n' "ERROR: Please run 'az login' to setup account." >&2
  exit 1
fi
printf '%s\n' '{"accessToken":"__TOKEN__"}'
'@
    $azUnix.Replace('__MARKER__', $marker).Replace('__TOKEN__', $token) | Set-Content -LiteralPath (Join-Path $bin 'az') -Encoding ASCII
    @'
#!/bin/sh
printf '%s\n' "$*" > "$COOP_TEST_MARKER/pi-argv"
if [ "$COOP_TEST_EXPECT_TOKEN" = present ] && [ "${COOP_FABRIC_MCP_TOKEN:-}" != "$COOP_TEST_TOKEN" ]; then exit 41; fi
if [ "$COOP_TEST_EXPECT_TOKEN" = absent ] && [ -n "${COOP_FABRIC_MCP_TOKEN:-}" ]; then exit 42; fi
printf '%s\n' launched > "$COOP_TEST_MARKER/pi-state"
'@ | Set-Content -LiteralPath (Join-Path $bin 'pi') -Encoding ASCII
    & chmod +x (Join-Path $bin 'az') (Join-Path $bin 'pi')
    if ($LASTEXITCODE -ne 0) { throw 'could not make Unix fixture commands executable' }
  }

  $oldPath = $env:PATH
  if ($env:OS -eq 'Windows_NT') { $env:PATH = $windowsFixturePath }
  else { $env:PATH = "$bin$([System.IO.Path]::PathSeparator)$oldPath" }
  $env:PI_CODING_AGENT_DIR = $agent
  $env:COOP_AGENT_DIR = $agent
  $env:COOP_NO_ONBOARD = '1'
  $env:COOP_SKIP_EXT_CHECK = '1'
  $env:COOP_SKIP_AZ = '1'
  $env:COOP_TEST_MARKER = $marker
  $env:COOP_TEST_TOKEN = $token
  $env:COOP_TEST_AZ_MODE = 'ok'
  $env:COOP_TEST_EXPECT_TOKEN = 'present'
  Set-Content -LiteralPath (Join-Path $marker 'az-mode') -Value 'ok' -NoNewline

  if ($env:OS -eq 'Windows_NT') {
    $piResolved = Get-Command pi -ErrorAction SilentlyContinue
    $piSourceFixture = 0
    $piSourceExt = 'none'
    if ($piResolved) {
      $piSourceFixture = [int]($piResolved.Source -eq (Join-Path $bin 'pi.cmd'))
      switch ([System.IO.Path]::GetExtension($piResolved.Source).ToLowerInvariant()) {
        '.cmd' { $piSourceExt = 'cmd' }
        '.exe' { $piSourceExt = 'exe' }
        '.com' { $piSourceExt = 'com' }
        '.bat' { $piSourceExt = 'bat' }
        '' { $piSourceExt = 'none' }
        default { $piSourceExt = 'other' }
      }
    }
    Write-Host "FABRIC_BOUNDARY pi-source-fixture=$piSourceFixture"
    Write-Host "FABRIC_BOUNDARY pi-source-ext=$piSourceExt"
    $pipxBinDir = Join-Path $HOME '.local\bin'
    $pipxBinPresent = [int](Test-Path -LiteralPath $pipxBinDir)
    Write-Host "FABRIC_BOUNDARY pipx-bin-present=$pipxBinPresent"
    $pipxShadow = 'none'
    if ($pipxBinPresent) {
      foreach ($ext in @($env:PATHEXT -split ';' | Where-Object { $_ })) {
        if (Test-Path -LiteralPath (Join-Path $pipxBinDir ("pi" + $ext))) {
          $pipxShadow = $ext.ToLowerInvariant().TrimStart('.')
          break
        }
      }
      if ($pipxShadow -eq 'none' -and (Test-Path -LiteralPath (Join-Path $pipxBinDir 'pi'))) { $pipxShadow = 'extensionless' }
      Write-Host "FABRIC_BOUNDARY pipx-pi-shadow=$pipxShadow"
      Write-Host "FABRIC_BOUNDARY pathext-ps1=$([int](($env:PATHEXT -split ';') -contains '.PS1'))"
      Write-Host "FABRIC_BOUNDARY pathext-js=$([int](($env:PATHEXT -split ';') -contains '.JS'))"
      foreach ($entry in @(Get-ChildItem -LiteralPath $pipxBinDir -Filter 'pi*' -ErrorAction SilentlyContinue | Select-Object -First 5)) {
        $entryLabel = if ($entry.PSIsContainer) { 'dir' } elseif ([string]::IsNullOrEmpty($entry.Extension)) { 'none' } else { $entry.Extension.ToLowerInvariant().TrimStart('.') }
        Write-Host "FABRIC_BOUNDARY pipx-pi-entry-ext=$entryLabel"
      }
    }
    $comspecMz = 0
    if ($env:ComSpec -and (Test-Path -LiteralPath $env:ComSpec -PathType Leaf)) {
      $comspecBytes = [System.IO.File]::ReadAllBytes($env:ComSpec)
      if ($comspecBytes.Length -ge 2) { $comspecMz = [int]($comspecBytes[0] -eq 0x4D -and $comspecBytes[1] -eq 0x5A) }
    }
    Write-Host "FABRIC_BOUNDARY comspec-mz=$comspecMz"
    $probeMarker = Join-Path $temp 'child-probe-marker'
    New-Item -ItemType Directory -Force -Path $probeMarker | Out-Null
    $childProbe = Join-Path $temp 'child-probe.ps1'
    @'
param([string]$Mode, [string]$Lib, [string]$TokenValue, [string]$Root, [string]$Config)
$ErrorActionPreference = 'Continue'
if ($Mode -eq 'libsrc' -or $Mode -eq 'full') { . $Lib }
if ($Mode -eq 'full') {
  $py = Get-CoopPython
  if ($py) {
    $runner = Join-Path $Root 'lib\fabric_token_runner.mjs'
    $helper = Join-Path $Root 'lib\warehouse_mcp.py'
    $null = @(& node $runner $py $helper $Config 2>&1)
  }
}
if ($Mode -ne 'plain') { $env:COOP_FABRIC_MCP_TOKEN = $TokenValue }
$rc = -1
try { & pi; $rc = $LASTEXITCODE } catch {
  $ex = $_.Exception
  if ($ex.PSObject.Properties['NativeErrorCode']) { $rc = $ex.NativeErrorCode }
  elseif ($ex.InnerException -and $ex.InnerException.PSObject.Properties['NativeErrorCode']) { $rc = $ex.InnerException.NativeErrorCode }
  elseif ($ex.PSObject.Properties['HResult']) { $rc = $ex.HResult }
}
Write-Output "rc=$rc"
'@ | Set-Content -LiteralPath $childProbe -Encoding ASCII
    $savedMarker = $env:COOP_TEST_MARKER
    $savedPath = $env:PATH
    $savedProbeEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $plainRc = -1
    $prefixedRc = -1
    $libsrcRc = -1
    $fullRc = -1
    $libCommon = Join-Path $root 'lib\common.ps1'
    $probeConfig = Join-Path $agent 'mcp.json'
    try {
      $env:COOP_TEST_MARKER = $probeMarker
      $plainOut = [string](& $psHost -NoProfile -ExecutionPolicy Bypass -File $childProbe plain '' '' '' '' *>&1)
      if ($plainOut -match 'rc=(-?[0-9]+)') { $plainRc = [int64]$Matches[1] }
      $env:PATH = "$pipxBinDir$([System.IO.Path]::PathSeparator)$savedPath"
      $prefixedOut = [string](& $psHost -NoProfile -ExecutionPolicy Bypass -File $childProbe plain '' '' '' '' *>&1)
      if ($prefixedOut -match 'rc=(-?[0-9]+)') { $prefixedRc = [int64]$Matches[1] }
      $env:PATH = $savedPath
      $libsrcOut = [string](& $psHost -NoProfile -ExecutionPolicy Bypass -File $childProbe libsrc $libCommon $token $root $probeConfig *>&1)
      if ($libsrcOut -match 'rc=(-?[0-9]+)') { $libsrcRc = [int64]$Matches[1] }
      $fullOut = [string](& $psHost -NoProfile -ExecutionPolicy Bypass -File $childProbe full $libCommon $token $root $probeConfig *>&1)
      if ($fullOut -match 'rc=(-?[0-9]+)') { $fullRc = [int64]$Matches[1] }
    } finally {
      $ErrorActionPreference = $savedProbeEap
      $env:PATH = $savedPath
      $env:COOP_TEST_MARKER = $savedMarker
      Remove-Item -LiteralPath $probeMarker -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host "FABRIC_BOUNDARY child-probe-plain-rc=$plainRc"
    Write-Host "FABRIC_BOUNDARY child-probe-pipxfirst-rc=$prefixedRc"
    Write-Host "FABRIC_BOUNDARY child-probe-libsrc-rc=$libsrcRc"
    Write-Host "FABRIC_BOUNDARY child-probe-full-rc=$fullRc"
  }

  $boundaryState = 'not-windows'
  if ($env:OS -eq 'Windows_NT') {
  $boundaryProbe = Join-Path $temp 'boundary-probe.mjs'
  $boundaryProbeSource = @'
import { pathToFileURL } from 'node:url';
const [helper, expected] = process.argv.slice(2);
const { azureCliCommand } = await import(pathToFileURL(helper).href);
const spec = azureCliCommand();
const commandLine = spec?.args?.[4] || '';
process.stdout.write(`spec=${Number(Boolean(spec))} fixture=${Number(commandLine.toLowerCase().includes(expected.toLowerCase()))} path=${Number(typeof process.env.PATH === 'string')} root=${Number(typeof process.env.SystemRoot === 'string')}`);
'@
  [System.IO.File]::WriteAllText($boundaryProbe, $boundaryProbeSource, [Text.Encoding]::ASCII)
  $boundaryLauncher = Join-Path $temp 'boundary-launcher.py'
  $boundaryLauncherSource = @'
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

module_path, node, probe, expected, runner, selected_python, config, marker = sys.argv[1:]
spec = importlib.util.spec_from_file_location("warehouse_mcp", module_path)
module = importlib.util.module_from_spec(spec)
sys.modules["warehouse_mcp"] = module
spec.loader.exec_module(module)
result = subprocess.run(
    [node, probe, module.REQUEST_HEADERS_HELPER, expected],
    env=module._token_helper_environment(),
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    timeout=5,
)
text = result.stdout.decode("ascii", "strict") if result.returncode == 0 and not result.stderr else ""
allowed = {"spec=0 fixture=0 path=1 root=1", "spec=1 fixture=0 path=1 root=1", "spec=1 fixture=1 path=1 root=1"}
resolution = text if text in allowed else f"probe-rc={result.returncode} probe-stdout-bytes={len(result.stdout)} probe-stderr-bytes={len(result.stderr)}"
runner_result = subprocess.run(
    [node, runner, selected_python, module_path, config],
    env=os.environ.copy(),
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    timeout=20,
)
marker_root = Path(marker)
runner_markers = [int((marker_root / name).exists()) for name in ("az-wrapper-entry", "az-helper-entry", "az-argv")]
for name in ("az-wrapper-entry", "az-helper-entry", "az-argv", "az-child-rc"):
    try:
        (marker_root / name).unlink()
    except FileNotFoundError:
        pass
code, stdout, stderr, timed_out = module._run_token_helper(
    [node, module.REQUEST_HEADERS_HELPER, "--token", module.FABRIC_RESOURCE], 10
)
print(f"{resolution} runner-code={runner_result.returncode} runner-stdout-bytes={len(runner_result.stdout)} runner-stderr-bytes={len(runner_result.stderr)} runner-wrapper={runner_markers[0]} runner-helper={runner_markers[1]} runner-az={runner_markers[2]} direct-code={code} direct-stdout-bytes={len(stdout)} direct-stderr-bytes={len(stderr)} direct-timeout={int(timed_out)}")
'@
  [System.IO.File]::WriteAllText($boundaryLauncher, $boundaryLauncherSource, [Text.Encoding]::ASCII)
  $probePython = (Get-Command python -CommandType Application -ErrorAction Stop).Source
  . (Join-Path $root 'lib\common.ps1')
  $selectedPython = Get-CoopPython
  $boundaryState = [string](& $probePython $boundaryLauncher (Join-Path $root 'lib\warehouse_mcp.py') $nodePath $boundaryProbe (Join-Path $bin 'az.cmd') (Join-Path $root 'lib\fabric_token_runner.mjs') $selectedPython (Join-Path $agent 'mcp.json') $marker)
  if ($LASTEXITCODE -ne 0 -or -not $boundaryState) { $boundaryState = 'probe-unavailable' }
  $directWrapperReached = [int](Test-Path -LiteralPath (Join-Path $marker 'az-wrapper-entry'))
  $directHelperReached = [int](Test-Path -LiteralPath (Join-Path $marker 'az-helper-entry'))
  $directAzReached = [int](Test-Path -LiteralPath (Join-Path $marker 'az-argv'))
  $boundaryState = "$boundaryState direct-wrapper=$directWrapperReached direct-helper=$directHelperReached direct-az=$directAzReached"
  foreach ($diagnosticMarker in @('az-wrapper-entry','az-helper-entry','az-argv','az-child-rc')) {
    Remove-Item -LiteralPath (Join-Path $marker $diagnosticMarker) -Force -ErrorAction SilentlyContinue
  }
  }

  $priorEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & $psHost -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'bin\coop.ps1') pi --fixture *>&1 | Out-String
  $rc = $LASTEXITCODE
  $ErrorActionPreference = $priorEap
  if ($rc -ne 0) {
    $wrapperReached = [int](Test-Path -LiteralPath (Join-Path $marker 'az-wrapper-entry'))
    $helperReached = [int](Test-Path -LiteralPath (Join-Path $marker 'az-helper-entry'))
    $azReached = [int](Test-Path -LiteralPath (Join-Path $marker 'az-argv'))
    $piReached = [int](Test-Path -LiteralPath (Join-Path $marker 'pi-entry'))
    $piTokenPresent = [int](Test-Path -LiteralPath (Join-Path $marker 'pi-token-present'))
    $piTokenMatch = [int](Test-Path -LiteralPath (Join-Path $marker 'pi-token-match'))
    $azChildRc = -1
    $azChildRcPath = Join-Path $marker 'az-child-rc'
    if (Test-Path -LiteralPath $azChildRcPath) {
      $parsedAzChildRc = 0
      if ([int]::TryParse((Get-Content -Raw -LiteralPath $azChildRcPath).Trim(), [ref]$parsedAzChildRc)) {
        $azChildRc = $parsedAzChildRc
      }
    }
    $tokenState = 'unknown'
    if ($output.Contains('token helper failed')) { $tokenState = 'runner-failed' }
    elseif ($output.Contains('token helper supervisor is unavailable')) { $tokenState = 'supervisor-unavailable' }
    elseif ($output.Contains('token helper returned invalid output')) { $tokenState = 'runner-output-invalid' }
    elseif ($output.Contains('Azure CLI is not installed or not on PATH')) { $tokenState = 'azure-cli-unavailable' }
    elseif ($output.Contains('Azure CLI could not be launched')) { $tokenState = 'token-launch-failed' }
    elseif ($output.Contains('Azure CLI token acquisition failed')) { $tokenState = 'token-command-failed' }
    elseif ($output.Contains('Azure CLI returned no usable Fabric token')) { $tokenState = 'token-output-invalid' }
    elseif ($output.Contains('Azure authentication is required')) { $tokenState = 'auth-required' }
    elseif ($output.Contains('System.Object[]') -or $output.Contains('Cannot convert value')) { $tokenState = 'token-assignment-failed' }
    elseif ($output.Contains('CommandNotFoundException') -or $output.Contains("The term 'pi' is not recognized")) { $tokenState = 'pi-resolution-failed' }
    elseif ($output.Contains('NativeCommandError') -or $output.Contains("Program 'pi") -or $output.Contains('Pi launch failed (code=')) { $tokenState = 'pi-launch-failed' }
    elseif ($output.Contains('environment variable') -and $output.Contains('too long')) { $tokenState = 'environment-limit' }
    $piLaunchCode = -1
    if ($output -match 'Pi launch failed \(code=(-?[0-9]+)\)') { $piLaunchCode = [int64]$Matches[1] }
    foreach ($boundaryField in @($boundaryState -split ' ')) { Write-Host "FABRIC_BOUNDARY $boundaryField" }
    $piChildRc = -1
    $piChildRcPath = Join-Path $marker 'pi-child-rc'
    if (Test-Path -LiteralPath $piChildRcPath) {
      $parsedPiChildRc = 0
      if ([int]::TryParse((Get-Content -Raw -LiteralPath $piChildRcPath).Trim(), [ref]$parsedPiChildRc)) {
        $piChildRc = $parsedPiChildRc
      }
    }
    Write-Host "FABRIC_BOUNDARY pi-reached=$piReached"
    Write-Host "FABRIC_BOUNDARY pi-token-present=$piTokenPresent"
    Write-Host "FABRIC_BOUNDARY pi-token-match=$piTokenMatch"
    Write-Host "FABRIC_BOUNDARY pi-child-rc=$piChildRc"
    Write-Host "FABRIC_BOUNDARY pi-launch-code=$piLaunchCode"
    Write-Host "FABRIC_BOUNDARY handoff-state=$tokenState"
    throw "token launch failed rc=$rc wrapper-reached=$wrapperReached helper-reached=$helperReached az-reached=$azReached child-rc=$azChildRc pi-reached=$piReached pi-token-present=$piTokenPresent pi-token-match=$piTokenMatch pi-child-rc=$piChildRc state=$tokenState boundary=$boundaryState"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $marker 'pi-state'))) { throw 'Pi was not launched' }
  if ($output.Contains($token)) { throw 'token leaked to process output' }
  if ((Get-Content -Raw (Join-Path $marker 'pi-argv')).Contains($token)) { throw 'token leaked to argv' }

  Remove-Item -LiteralPath (Join-Path $marker 'pi-state') -Force
  $env:COOP_TEST_AZ_MODE = 'auth'
  Set-Content -LiteralPath (Join-Path $marker 'az-mode') -Value 'auth' -NoNewline
  $env:COOP_TEST_EXPECT_TOKEN = 'absent'
  $env:COOP_FABRIC_MCP_TOKEN = 'stale-inherited-token'
  $ErrorActionPreference = 'Continue'
  $failedOutput = & $psHost -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'bin\coop.ps1') pi --fixture *>&1 | Out-String
  $failedRc = $LASTEXITCODE
  $ErrorActionPreference = $priorEap
  if ($failedRc -ne 0) { throw "fail-soft launch failed rc=$failedRc output=$failedOutput" }
  if (-not $failedOutput.Contains('Azure authentication is required')) { throw 'truthful auth warning missing' }
  if ($failedOutput.Contains($token)) { throw 'token leaked from failed launch' }
  if (-not (Test-Path -LiteralPath (Join-Path $marker 'pi-state'))) { throw 'Pi did not launch after token failure' }

  Remove-Item -LiteralPath (Join-Path $marker 'pi-state') -Force
  $helperFixture = Join-Path $temp 'python-fixture'
  New-Item -ItemType Directory -Force -Path $helperFixture | Out-Null
  @'
import os
import sys
from pathlib import Path

if (
    len(sys.argv) >= 2
    and Path(sys.argv[0]).name.lower() == "warehouse_mcp.py"
    and sys.argv[1] == "launch-token"
):
    mode = os.environ.get("COOP_TEST_HELPER_MODE", "failure")
    marker = Path(os.environ["COOP_TEST_MARKER"]) / f"helper-{mode}.reached"
    marker.write_bytes(b"executed\n")
    if mode == "success-stderr":
        tokenlike = os.environ["COOP_TEST_HELPER_TOKENLIKE"].encode("ascii")
        diagnostic = os.environ["COOP_TEST_HELPER_DIAGNOSTIC"].encode("ascii")
        os.write(1, b"token	" + tokenlike + b"	end")
        os.write(2, diagnostic + b"\n")
        os._exit(0)
    if mode == "control-token":
        os.write(1, b"token	bad\x07token	end")
        os._exit(0)
    if mode == "whitespace-stderr":
        tokenlike = os.environ["COOP_TEST_HELPER_TOKENLIKE"].encode("ascii")
        os.write(1, b"token	" + tokenlike + b"	end")
        os.write(2, b"\n")
        os._exit(0)
    diagnostic = os.environ["COOP_TEST_HELPER_DIAGNOSTIC"].encode("ascii")
    os.write(2, diagnostic + b"\n")
    os._exit(7)
'@ | Set-Content -LiteralPath (Join-Path $helperFixture 'sitecustomize.py') -Encoding UTF8
  $env:PYTHONPATH = if ($oldPythonPath) {
    "$helperFixture$([System.IO.Path]::PathSeparator)$oldPythonPath"
  } else {
    $helperFixture
  }
  if ($env:OS -eq 'Windows_NT') {
    $nativePython = @('python3', 'python') | ForEach-Object {
      Get-Command $_ -CommandType Application -ErrorAction SilentlyContinue
    } | Where-Object { $_.Source -and $_.Source -notmatch '\\WindowsApps\\' } | Select-Object -First 1
    if (-not $nativePython -or [System.IO.Path]::GetExtension($nativePython.Source) -ne '.exe') {
      throw 'Windows helper fixture requires a native Python executable'
    }
  }

  function Assert-HelperModeExecuted {
    param([string]$Mode)
    $modeMarker = Join-Path $marker "helper-$Mode.reached"
    if (-not (Test-Path -LiteralPath $modeMarker)) {
      throw "helper mode $Mode did not execute; cannot-launch is not executed-and-rejected"
    }
    if ((Get-Content -Raw -LiteralPath $modeMarker).Trim() -ne 'executed') {
      throw "helper mode $Mode execution marker is invalid"
    }
  }

  $env:COOP_TEST_HELPER_DIAGNOSTIC = $helperDiagnostic
  $env:COOP_TEST_HELPER_MODE = 'failure'
  Remove-Item -LiteralPath (Join-Path $marker 'helper-failure.reached') -Force -ErrorAction SilentlyContinue
  $env:COOP_TEST_EXPECT_TOKEN = 'absent'
  $env:COOP_FABRIC_MCP_TOKEN = 'stale-inherited-token'
  $ErrorActionPreference = 'Continue'
  $helperFailedOutput = & $psHost -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'bin\coop.ps1') pi --fixture *>&1 | Out-String
  $helperFailedRc = $LASTEXITCODE
  $ErrorActionPreference = $priorEap
  Assert-HelperModeExecuted 'failure'
  if ($helperFailedRc -ne 0) { throw "helper-process fail-soft launch failed rc=$helperFailedRc output=$helperFailedOutput" }
  if (-not $helperFailedOutput.Contains('Fabric Warehouse MCP unavailable: token helper failed')) { throw 'sanitized helper warning missing' }
  if ($helperFailedOutput.Contains($helperDiagnostic)) { throw 'untrusted helper diagnostic leaked to output' }
  if (-not (Test-Path -LiteralPath (Join-Path $marker 'pi-state'))) { throw 'Pi did not launch after helper-process failure' }

  Remove-Item -LiteralPath (Join-Path $marker 'pi-state') -Force
  $env:COOP_TEST_HELPER_MODE = 'success-stderr'
  Remove-Item -LiteralPath (Join-Path $marker 'helper-success-stderr.reached') -Force -ErrorAction SilentlyContinue
  $env:COOP_TEST_HELPER_TOKENLIKE = $helperTokenlike
  $env:COOP_FABRIC_MCP_TOKEN = 'stale-inherited-token'
  $ErrorActionPreference = 'Continue'
  $helperStderrOutput = & $psHost -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'bin\coop.ps1') pi --fixture *>&1 | Out-String
  $helperStderrRc = $LASTEXITCODE
  $ErrorActionPreference = $priorEap
  Assert-HelperModeExecuted 'success-stderr'
  if ($helperStderrRc -ne 0) { throw "helper-stderr fail-soft launch failed rc=$helperStderrRc output=$helperStderrOutput" }
  if (-not $helperStderrOutput.Contains('Fabric Warehouse MCP unavailable: token helper failed')) { throw 'helper-failure warning missing' }
  if ($helperStderrOutput.Contains($helperDiagnostic)) { throw 'successful helper stderr leaked to output' }
  if ($helperStderrOutput.Contains($helperTokenlike)) { throw 'successful helper token-like stdout leaked to output' }
  if (-not (Test-Path -LiteralPath (Join-Path $marker 'pi-state'))) { throw 'Pi did not launch after successful helper stderr' }

  foreach ($mode in @('control-token', 'whitespace-stderr')) {
    Remove-Item -LiteralPath (Join-Path $marker 'pi-state') -Force
    $env:COOP_TEST_HELPER_MODE = $mode
    Remove-Item -LiteralPath (Join-Path $marker "helper-$mode.reached") -Force -ErrorAction SilentlyContinue
    $env:COOP_FABRIC_MCP_TOKEN = 'stale-inherited-token'
    $ErrorActionPreference = 'Continue'
    $contaminatedOutput = & $psHost -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'bin\coop.ps1') pi --fixture *>&1 | Out-String
    $contaminatedRc = $LASTEXITCODE
    $ErrorActionPreference = $priorEap
    Assert-HelperModeExecuted $mode
    if ($contaminatedRc -ne 0) { throw "$mode fail-soft launch failed rc=$contaminatedRc output=$contaminatedOutput" }
    if (-not $contaminatedOutput.Contains('Fabric Warehouse MCP unavailable:')) { throw "$mode warning missing" }
    if (-not (Test-Path -LiteralPath (Join-Path $marker 'pi-state'))) { throw "Pi did not launch after $mode" }
  }

  Write-Output 'FABRIC_MCP_FIXTURE_INJECTION_REACHED'
  if ($env:COOP_TEST_FORCE_FABRIC_FIXTURE_FAILURE -eq '1') {
    throw 'forced Fabric MCP child-fixture failure'
  }
  Write-Host '  OK  PowerShell Fabric MCP token is child-only and fail-soft'
} finally {
  Remove-Item Env:COOP_FABRIC_MCP_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:COOP_TEST_HELPER_MODE -ErrorAction SilentlyContinue
  Remove-Item Env:COOP_TEST_HELPER_TOKENLIKE -ErrorAction SilentlyContinue
  Remove-Item Env:COOP_TEST_HELPER_DIAGNOSTIC -ErrorAction SilentlyContinue
  if ($null -eq $oldPythonPath) {
    Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
  } else {
    $env:PYTHONPATH = $oldPythonPath
  }
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

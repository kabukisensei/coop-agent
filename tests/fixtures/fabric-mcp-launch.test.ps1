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
    $azCmd = @'
@echo off
>"__MARKER__\az-argv" echo %*
set /p COOP_TEST_AZ_MODE=<"__MARKER__\az-mode"
if "%COOP_TEST_AZ_MODE%"=="auth" (
  >&2 echo ERROR: Please run 'az login' to setup account.
  exit /b 1
)
type "__AZ_RESPONSE__"
exit /b 0
'@
    $azCmd.Replace('__MARKER__', $marker).Replace('__AZ_RESPONSE__', $azResponse) | Set-Content -LiteralPath (Join-Path $bin 'az.cmd') -Encoding ASCII
    @'
@echo off
>"%COOP_TEST_MARKER%\pi-argv" echo %*
if "%COOP_TEST_EXPECT_TOKEN%"=="present" if not "%COOP_FABRIC_MCP_TOKEN%"=="%COOP_TEST_TOKEN%" exit /b 41
if "%COOP_TEST_EXPECT_TOKEN%"=="absent" if not "%COOP_FABRIC_MCP_TOKEN%"=="" exit /b 42
>"%COOP_TEST_MARKER%\pi-state" echo launched
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
  $env:PATH = "$bin$([System.IO.Path]::PathSeparator)$oldPath"
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

  $priorEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & $psHost -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'bin\coop.ps1') pi --fixture *>&1 | Out-String
  $rc = $LASTEXITCODE
  $ErrorActionPreference = $priorEap
  if ($rc -ne 0) {
    $azReached = [int](Test-Path -LiteralPath (Join-Path $marker 'az-argv'))
    $tokenState = 'unknown'
    if ($output.Contains('token helper failed')) { $tokenState = 'runner-failed' }
    elseif ($output.Contains('token helper supervisor is unavailable')) { $tokenState = 'supervisor-unavailable' }
    elseif ($output.Contains('token helper returned invalid output')) { $tokenState = 'runner-output-invalid' }
    elseif ($output.Contains('Azure CLI is not installed or not on PATH')) { $tokenState = 'azure-cli-unavailable' }
    elseif ($output.Contains('Azure CLI could not be launched')) { $tokenState = 'token-launch-failed' }
    elseif ($output.Contains('Azure CLI token acquisition failed')) { $tokenState = 'token-command-failed' }
    elseif ($output.Contains('Azure CLI returned no usable Fabric token')) { $tokenState = 'token-output-invalid' }
    elseif ($output.Contains('Azure authentication is required')) { $tokenState = 'auth-required' }
    throw "token launch failed rc=$rc az-reached=$azReached state=$tokenState"
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

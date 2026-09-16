$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$psHost = (Get-Process -Id $PID).Path
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("coop-fabric-token-" + [guid]::NewGuid().ToString('N'))
$bin = Join-Path $temp 'bin'
$agent = Join-Path $temp 'agent'
$marker = Join-Path $temp 'marker'
$token = 'fabric-launch-canary-7e5a3c'
$helperDiagnostic = 'untrusted-helper-diagnostic-93b75a'
$helperTokenlike = 'tokenlike-helper-value-2309'
New-Item -ItemType Directory -Force -Path $bin,$agent,$marker | Out-Null
try {
  @'
{
  "mcpServers": {
    "fabric-sqlendpoint": {
      "url": "https://api.fabric.microsoft.com/v1/mcp/dataPlane/sqlEndpoint",
      "auth": "bearer",
      "bearerTokenEnv": "COOP_FABRIC_MCP_TOKEN",
      "lifecycle": "lazy"
    }
  },
  "_coop": {"schema_version": 1, "managed_servers": ["fabric-sqlendpoint"]}
}
'@ | Set-Content -LiteralPath (Join-Path $agent 'mcp.json') -Encoding UTF8

  if ($env:OS -eq 'Windows_NT') {
    @'
@echo off
>"%COOP_TEST_MARKER%\az-argv" echo %*
if "%COOP_TEST_AZ_MODE%"=="auth" (
  >&2 echo ERROR: Please run 'az login' to setup account.
  exit /b 1
)
echo {"accessToken":"%COOP_TEST_TOKEN%"}
'@ | Set-Content -LiteralPath (Join-Path $bin 'az.cmd') -Encoding ASCII
    @'
@echo off
>"%COOP_TEST_MARKER%\pi-argv" echo %*
if "%COOP_TEST_EXPECT_TOKEN%"=="present" if not "%COOP_FABRIC_MCP_TOKEN%"=="%COOP_TEST_TOKEN%" exit /b 41
if "%COOP_TEST_EXPECT_TOKEN%"=="absent" if not "%COOP_FABRIC_MCP_TOKEN%"=="" exit /b 42
>"%COOP_TEST_MARKER%\pi-state" echo launched
exit /b 0
'@ | Set-Content -LiteralPath (Join-Path $bin 'pi.cmd') -Encoding ASCII
  } else {
    @'
#!/bin/sh
printf '%s\n' "$*" > "$COOP_TEST_MARKER/az-argv"
if [ "$COOP_TEST_AZ_MODE" = auth ]; then
  printf '%s\n' "ERROR: Please run 'az login' to setup account." >&2
  exit 1
fi
printf '{"accessToken":"%s"}\n' "$COOP_TEST_TOKEN"
'@ | Set-Content -LiteralPath (Join-Path $bin 'az') -Encoding ASCII
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

  $priorEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & $psHost -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'bin\coop.ps1') pi --fixture *>&1 | Out-String
  $rc = $LASTEXITCODE
  $ErrorActionPreference = $priorEap
  if ($rc -ne 0) { throw "token launch failed rc=$rc output=$output" }
  if (-not (Test-Path -LiteralPath (Join-Path $marker 'pi-state'))) { throw 'Pi was not launched' }
  if ($output.Contains($token)) { throw 'token leaked to process output' }
  if ((Get-Content -Raw (Join-Path $marker 'pi-argv')).Contains($token)) { throw 'token leaked to argv' }

  Remove-Item -LiteralPath (Join-Path $marker 'pi-state') -Force
  $env:COOP_TEST_AZ_MODE = 'auth'
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
  if ($env:OS -eq 'Windows_NT') {
    @'
@echo off
if "%1"=="--version" (
  echo Python 3.12.0
  exit /b 0
)
if "%COOP_TEST_HELPER_MODE%"=="success-stderr" (
  echo token	%COOP_TEST_HELPER_TOKENLIKE%	end
  >&2 echo %COOP_TEST_HELPER_DIAGNOSTIC%
  exit /b 0
)
>&2 echo %COOP_TEST_HELPER_DIAGNOSTIC%
exit /b 7
'@ | Set-Content -LiteralPath (Join-Path $bin 'python3.cmd') -Encoding ASCII
  } else {
    @'
#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\n' 'Python 3.12.0'; exit 0; fi
if [ "$COOP_TEST_HELPER_MODE" = success-stderr ]; then
  printf 'token\t%s\tend' "$COOP_TEST_HELPER_TOKENLIKE"
  printf '%s\n' "$COOP_TEST_HELPER_DIAGNOSTIC" >&2
  exit 0
fi
printf '%s\n' "$COOP_TEST_HELPER_DIAGNOSTIC" >&2
exit 7
'@ | Set-Content -LiteralPath (Join-Path $bin 'python3') -Encoding ASCII
    & chmod +x (Join-Path $bin 'python3')
    if ($LASTEXITCODE -ne 0) { throw 'could not make Python failure fixture executable' }
  }
  $env:COOP_TEST_HELPER_DIAGNOSTIC = $helperDiagnostic
  $env:COOP_TEST_EXPECT_TOKEN = 'absent'
  $env:COOP_FABRIC_MCP_TOKEN = 'stale-inherited-token'
  $ErrorActionPreference = 'Continue'
  $helperFailedOutput = & $psHost -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'bin\coop.ps1') pi --fixture *>&1 | Out-String
  $helperFailedRc = $LASTEXITCODE
  $ErrorActionPreference = $priorEap
  if ($helperFailedRc -ne 0) { throw "helper-process fail-soft launch failed rc=$helperFailedRc output=$helperFailedOutput" }
  if (-not $helperFailedOutput.Contains('Fabric Warehouse MCP unavailable: token helper failed')) { throw 'sanitized helper warning missing' }
  if ($helperFailedOutput.Contains($helperDiagnostic)) { throw 'untrusted helper diagnostic leaked to output' }
  if (-not (Test-Path -LiteralPath (Join-Path $marker 'pi-state'))) { throw 'Pi did not launch after helper-process failure' }

  Remove-Item -LiteralPath (Join-Path $marker 'pi-state') -Force
  $env:COOP_TEST_HELPER_MODE = 'success-stderr'
  $env:COOP_TEST_HELPER_TOKENLIKE = $helperTokenlike
  $env:COOP_FABRIC_MCP_TOKEN = 'stale-inherited-token'
  $ErrorActionPreference = 'Continue'
  $helperStderrOutput = & $psHost -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'bin\coop.ps1') pi --fixture *>&1 | Out-String
  $helperStderrRc = $LASTEXITCODE
  $ErrorActionPreference = $priorEap
  if ($helperStderrRc -ne 0) { throw "helper-stderr fail-soft launch failed rc=$helperStderrRc output=$helperStderrOutput" }
  if (-not $helperStderrOutput.Contains('Fabric Warehouse MCP unavailable: token helper returned invalid output')) { throw 'invalid helper-output warning missing' }
  if ($helperStderrOutput.Contains($helperDiagnostic)) { throw 'successful helper stderr leaked to output' }
  if ($helperStderrOutput.Contains($helperTokenlike)) { throw 'successful helper token-like stdout leaked to output' }
  if (-not (Test-Path -LiteralPath (Join-Path $marker 'pi-state'))) { throw 'Pi did not launch after successful helper stderr' }

  Write-Output 'FABRIC_MCP_FIXTURE_INJECTION_REACHED'
  if ($env:COOP_TEST_FORCE_FABRIC_FIXTURE_FAILURE -eq '1') {
    throw 'forced Fabric MCP child-fixture failure'
  }
  Write-Host '  OK  PowerShell Fabric MCP token is child-only and fail-soft'
} finally {
  Remove-Item Env:COOP_FABRIC_MCP_TOKEN -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

#requires -Version 5.1
# Collect a sanitized Support Center bundle: component health, versions, and
# recent events; preview in the terminal; export under the support dir with
# bounded retention. Pure Node + shell — runs when the Pi/model runtime is
# unavailable. Usage: coop support [--json] [--export PATH] [--incident]
$ErrorActionPreference = 'Stop'

$COOP_ROOT = Split-Path -Parent $PSScriptRoot
$env:COOP_ROOT = $COOP_ROOT

if ($env:COOP_BETA_ROOT -or ($env:COOP_CHANNEL -and $env:COOP_CHANNEL -ne 'stable')) {
  . (Join-Path $PSScriptRoot '../lib/common.ps1')
  Invoke-CoopOwnedProcess -FilePath $script:CoopInstallationContext.tools.node.path -ArgumentVector (@((Join-Path $COOP_ROOT 'lib/support-center-cli.mjs')) + @($args)) -TimeoutMilliseconds 120000
  exit $LASTEXITCODE
}
& node (Join-Path $COOP_ROOT 'lib\support-center-cli.mjs') @args
exit $LASTEXITCODE

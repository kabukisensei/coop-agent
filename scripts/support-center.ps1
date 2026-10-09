#requires -Version 5.1
# Collect a sanitized Support Center bundle: component health, versions, and
# recent events; preview in the terminal; export under the support dir with
# bounded retention. Pure Node + shell — runs when the Pi/model runtime is
# unavailable. Usage: coop support [--json] [--export PATH] [--incident]
$ErrorActionPreference = 'Stop'

$COOP_ROOT = Split-Path -Parent $PSScriptRoot
$env:COOP_ROOT = $COOP_ROOT

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  [Console]::Error.WriteLine('coop support needs Node.js (node was not found on PATH). Run: coop install')
  exit 1
}
& node (Join-Path $COOP_ROOT 'lib\support-center-cli.mjs') @args
exit $LASTEXITCODE

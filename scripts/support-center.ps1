#requires -Version 5.1
# Collect a sanitized Support Center bundle: component health, versions, and
# recent events; preview in the terminal; export under the support dir with
# bounded retention. Pure Node + shell — runs when the Pi/model runtime is
# unavailable. Usage: coop support [--json] [--export PATH] [--incident]
$ErrorActionPreference = 'Stop'

$COOP_ROOT = Split-Path -Parent $PSScriptRoot
$env:COOP_ROOT = $COOP_ROOT

& node (Join-Path $COOP_ROOT 'lib\support-center-cli.mjs') @args
exit $LASTEXITCODE

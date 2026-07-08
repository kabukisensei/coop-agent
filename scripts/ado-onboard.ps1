#!/usr/bin/env pwsh
#
# ado-onboard — thin launcher for scripts/ado-onboard.py (Windows/PowerShell twin of
# scripts/ado-onboard.sh). Locates Python and passes every argument straight through.
#
$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
if (Get-Command python3 -ErrorAction SilentlyContinue) { $py = 'python3' }
elseif (Get-Command python -ErrorAction SilentlyContinue) { $py = 'python' }
else { [Console]::Error.WriteLine('ado-onboard: python3 (or python) not found on PATH'); exit 127 }

& $py (Join-Path $ScriptDir 'ado-onboard.py') @args
exit $LASTEXITCODE

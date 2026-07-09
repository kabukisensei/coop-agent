#!/usr/bin/env pwsh
#
# ado-onboard — thin launcher for scripts/ado-onboard.py (Windows/PowerShell twin of
# scripts/ado-onboard.sh). Locates Python and passes every argument straight through.
#
$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot

# Shared helpers (Get-CoopPython — THE one python resolver): lib/common.ps1.
. (Join-Path $PSScriptRoot '../lib/common.ps1')

$py = Get-CoopPython
if (-not $py) { [Console]::Error.WriteLine('ado-onboard: python3 (or python) not found on PATH (a Windows Store python stub does not count)'); exit 127 }

& $py (Join-Path $ScriptDir 'ado-onboard.py') @args
exit $LASTEXITCODE

#!/usr/bin/env pwsh
#
# ado-digest — thin launcher for scripts/ado-digest.py (Windows/PowerShell twin of
# scripts/ado-digest.sh). Locates Python and passes every argument straight through.
# Runs cleanly under Task Scheduler with no TTY (lib/common.ps1 detects redirected
# stderr and emits plain, colorless lines).
#
$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot

# Shared helpers (Get-CoopPython — THE one python resolver): lib/common.ps1.
. (Join-Path $PSScriptRoot '../lib/common.ps1')

$py = Get-CoopPython
if (-not $py) { [Console]::Error.WriteLine('ado-digest: python3 (or python) not found on PATH (a Windows Store python stub does not count)'); exit 127 }

& $py (Join-Path $ScriptDir 'ado-digest.py') @args
exit $LASTEXITCODE

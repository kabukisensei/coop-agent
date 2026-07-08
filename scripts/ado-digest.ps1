#!/usr/bin/env pwsh
#
# ado-digest — thin launcher for scripts/ado-digest.py (Windows/PowerShell twin of
# scripts/ado-digest.sh). Locates Python and passes every argument straight through.
# Minimal and self-contained so it runs cleanly under Task Scheduler with no TTY.
#
$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
if (Get-Command python3 -ErrorAction SilentlyContinue) { $py = 'python3' }
elseif (Get-Command python -ErrorAction SilentlyContinue) { $py = 'python' }
else { [Console]::Error.WriteLine('ado-digest: python3 (or python) not found on PATH'); exit 127 }

& $py (Join-Path $ScriptDir 'ado-digest.py') @args
exit $LASTEXITCODE

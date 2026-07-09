#!/usr/bin/env pwsh
#
# ado-onboard — thin launcher for scripts/ado-onboard.py (Windows/PowerShell twin of
# scripts/ado-onboard.sh). Locates Python and passes every argument straight through.
#
$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot

# Pick a usable python interpreter that ACTUALLY runs — not the Windows Store
# App-Execution-Alias stub. python.org's installer never creates python3.exe, so
# on stock Windows `python3` resolves ONLY to the Store stub under
# ...\WindowsApps\: Get-Command succeeds while `--version` prints nothing.
# Prefer python3, fall back to python; $null when neither is real. (Deliberately
# duplicated inline per script — keep every copy textually identical until the
# lib/common.ps1 extraction hoists it.)
function Get-CoopPython {
  foreach ($name in @('python3', 'python')) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $c) { continue }
    if ($c.Source -and $c.Source -match '\\WindowsApps\\') { continue }
    $v = (& $name --version 2>&1)
    if ($v -match '\d+\.\d+') { return $name }
  }
  return $null
}

$py = Get-CoopPython
if (-not $py) { [Console]::Error.WriteLine('ado-onboard: python3 (or python) not found on PATH (a Windows Store python stub does not count)'); exit 127 }

& $py (Join-Path $ScriptDir 'ado-onboard.py') @args
exit $LASTEXITCODE

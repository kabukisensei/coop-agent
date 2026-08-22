#!/usr/bin/env pwsh
#
# check-context-budget.ps1 — PowerShell twin of scripts/check-context-budget.sh.
# Runs the same Python measurement script and checks the same thresholds.
#
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$coop = Join-Path (Join-Path $root 'bin') 'coop.ps1'

$GUARDRAILS_LIMIT_BYTES = 6500
$TOTAL_LIMIT_TOKENS = 7000

$py = Get-Command python3 -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command python -ErrorAction SilentlyContinue }
if (-not $py) {
  Write-Warning 'python3 not found; cannot run context-budget check'
  exit 0
}

$json = & $coop context-budget --json 2>&1 | Out-String
$err = $null
$data = $json | ConvertFrom-Json -ErrorAction Stop

$fail = 0
$grBytes = $data.categories.guardrails.bytes
if ($grBytes -gt $GUARDRAILS_LIMIT_BYTES) {
  Write-Host "DRIFT: docs/guardrails.md is $grBytes bytes (limit $GUARDRAILS_LIMIT_BYTES)"
  $fail = 1
}

$total = $data.estimated_fixed_total_tokens
if ($total -gt $TOTAL_LIMIT_TOKENS) {
  Write-Host "DRIFT: estimated fixed total is $total tokens (limit $TOTAL_LIMIT_TOKENS)"
  $fail = 1
}

if ($fail -ne 0) {
  Write-Host 'FAIL: context-budget check exceeded threshold(s)'
  exit 1
}

Write-Host "PASS: context-budget within thresholds (guardrails ${grBytes}/${GUARDRAILS_LIMIT_BYTES} bytes, fixed total ${total}/${TOTAL_LIMIT_TOKENS} tokens)"

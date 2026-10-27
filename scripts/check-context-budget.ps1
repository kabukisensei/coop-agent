#!/usr/bin/env pwsh
#
# check-context-budget.ps1 — context-budget check (lib/context-budget via scripts/context-budget.py).
# Runs the same Python measurement script and checks the same thresholds.
#
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$coop = Join-Path (Join-Path $root 'bin') 'coop.ps1'

$GUARDRAILS_LIMIT_BYTES = 6700
# 6500 -> 6700 on 2026-10-27 (team feedback: no unnecessary functions in SQL):
# one short guardrails section, with headroom for the CRLF checkout on Windows.
# 7000 -> 7200 on 2026-10-01 (master plan row SQ4): one new native tool,
# sql_impact, plus its one-line AGENTS.md mention. Its metadata is kept compact.
# 7200 -> 7300 on 2026-10-12 (master plan row SQ10): one new native tool,
# schema_compare, with its metadata kept to three short strings.
# Held at 7300 on 2026-10-20 (master plan row SQ12): the new native tool,
# sql_source, and its AGENTS.md mention were paid for by trimming AGENTS.md prose.
# 7300 -> 7350 on 2026-10-27 (team feedback): the guardrails section above; Aaron
# allowed the budget to grow for it.
$TOTAL_LIMIT_TOKENS = 7350

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

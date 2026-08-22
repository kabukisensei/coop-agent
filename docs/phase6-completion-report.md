# Phase 6 Completion Report

## Result

PASS — functionally accepted. No additional context reduction was performed in this round.

## Measurement corrections applied

1. **Prompt templates are no longer counted in `estimated_fixed_total_tokens`.** Their full bodies are on-demand inventory; only their names/references are present at startup.
2. **User profile is measured as the injected instruction** produced by `extensions/coop-profile/index.ts` (`buildInstruction`), not the raw `~/.coop/user.json` bytes.
3. **Baseline, completion docs, and CI threshold** updated to use the corrected fixed-context classification.
4. **PowerShell behavioral coverage** added for `coop.ps1 context-budget`, `coop.ps1 context-budget --json`, and `scripts/check-context-budget.ps1`.
5. **Guardrail wording** made explicit about read-only-by-default, explicit-approval permitted mutations, and non-overridable hard blocks.

## Corrected baseline (before Phase 6 reductions)

Measured with `coop context-budget` on 2026-08-22 at commit `74ba8d7`.

| Fixed category | Chars | Estimated tokens |
| --- | --- | --- |
| Guardrails (`docs/guardrails.md`) | 13,685 | ~3,422 |
| User profile instruction | 124 | ~31 |
| Project instructions (`AGENTS.md`) | 8,719 | ~2,180 |
| Skill descriptions (16 skills) | 4,730 | ~1,183 |
| Native tool metadata (4 tools) | 2,897 | ~725 |
| **Estimated fixed total** | **30,155** | **~7,539** |

On-demand inventory (not in fixed total):

| Category | Chars | Estimated tokens |
| --- | --- | --- |
| Prompt templates (13 files) | 13,776 | ~3,444 |

## Corrected final (after Phase 6 reductions)

| Fixed category | Chars | Estimated tokens |
| --- | --- | --- |
| Guardrails (`docs/guardrails.md`) | 5,106 | ~1,277 |
| User profile instruction | 124 | ~31 |
| Project instructions (`AGENTS.md`) | 8,719 | ~2,180 |
| Skill descriptions (16 skills) | 4,730 | ~1,183 |
| Native tool metadata (4 tools) | 2,897 | ~725 |
| **Estimated fixed total** | **21,576** | **~5,394** |

On-demand inventory unchanged: prompt templates 13,776 chars (~3,444 tokens).

## Reduction

- Absolute fixed tokens: ~2,145 fewer (7,539 → 5,394)
- Percentage: ~28.5% reduction in estimated fixed startup context
- Guardrails shrank from 13,685 chars to 5,106 chars (8,579 chars; ~63% smaller)

The guardrail file grew slightly from the first measured optimized value (~4,609 chars) because the explicit read-only/hard-block wording added a small amount of text. This is intentional per the acceptance criteria; no further shrinking was done.

## Files changed in this correction round

- `scripts/context-budget.py` — exclude prompts from fixed total, measure profile instruction, expose `on_demand_inventory`
- `scripts/check-context-budget.sh` and `.ps1` — corrected threshold
- `tests/context-budget.test.sh` — assert `on_demand_inventory` instead of top-level `prompts`
- `tests/run.ps1` — PowerShell coverage for `coop context-budget`, `--json`, and `check-context-budget.ps1`
- `docs/guardrails.md` — explicit read-only-by-default / approval / hard-block wording
- `docs/context-budget-baseline.md` and `docs/phase6-completion-report.md` — corrected classification and numbers

## Capabilities preserved

- No skill cuts, no tool cuts, no extension cuts, no further guardrail shrinking.
- All native tools, MCP read-only semantics, approval-gated mutations, destructive-shell confirmation, secret-file confirmation, and hard git blocks remain unchanged.

## Tests

- `bash tests/run.sh` — ✓ all tests passed
- `bash scripts/check-parity.sh` — ✓ passed
- `bash scripts/validate-resources.sh` — ✓ passed
- CI gate: `bash scripts/check-context-budget.sh` — PASS (guardrails 5,106/6,500 bytes, fixed total 5,394/7,000 tokens)
- Windows CI — observed via GitHub Actions run (see below)

## Windows CI result

Observed GitHub Actions run for the pushed commit: **all jobs green** including the PowerShell behavioral tests (`logic tests (Windows)` and `powershell parse (Windows)`).

## Recommendation

Phase 6 is functionally accepted. The measurement model is now consistent with how Pi loads prompt templates (on-demand) and profiles (injected instruction, not raw JSON). Proceed to Phase 7 only on explicit request.

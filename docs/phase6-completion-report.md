# Phase 6 Completion Report

## Result

PASS

## Baseline (before Phase 6 reductions)

Measured with `coop context-budget` on 2026-08-22 at commit `74ba8d7`.

| Category | Chars | Estimated tokens |
| --- | --- | --- |
| Guardrails (`docs/guardrails.md`) | 13,685 | ~3,422 |
| User profile (`~/.coop/user.json`) | 127 | ~32 |
| Project instructions (`AGENTS.md`) | 8,719 | ~2,180 |
| Prompt templates (13 files) | 13,776 | ~3,444 |
| Skill descriptions (16 skills) | 4,730 | ~1,183 |
| Native tool metadata (4 tools) | 2,897 | ~725 |
| **Estimated fixed total** | **43,934** | **~10,984** |

## Final (after Phase 6 reductions)

| Category | Chars | Estimated tokens |
| --- | --- | --- |
| Guardrails (`docs/guardrails.md`) | 4,609 | ~1,153 |
| User profile (`~/.coop/user.json`) | 127 | ~32 |
| Project instructions (`AGENTS.md`) | 8,719 | ~2,180 |
| Prompt templates (13 files) | 13,776 | ~3,444 |
| Skill descriptions (16 skills) | 4,730 | ~1,183 |
| Native tool metadata (4 tools) | 2,897 | ~725 |
| **Estimated fixed total** | **34,858** | **~8,715** |

## Reduction

- Absolute tokens: ~2,269 fewer fixed tokens
- Percentage: ~20.7% reduction in estimated fixed startup context
- Guardrails shrank from 13,685 chars to 4,609 chars (9,076 chars; ~66% smaller)

## Changes made

1. **Added `coop context-budget`**
   - New Python implementation: `scripts/context-budget.py`
   - Wired into `bin/coop` and `bin/coop.ps1`
   - Human-readable output and stable `--json` machine output
   - Optional `--measure` path warns and falls back to static estimates (exact provider measurement requires a future explicit-approval model call)
   - Cross-platform, standard-library only, no secrets emitted

2. **Measured baseline**
   - Created `docs/context-budget-baseline.md`
   - Captured fixed-context categories, chars, and estimated tokens before any reductions

3. **Conservatively shrank `docs/guardrails.md`**
   - Kept all non-negotiable rules intact
   - Preserved explicit references to `tests.live_data.enabled`, `/slice-next`, `/explain`, slice-approval semantics, and non-blocking progress messages
   - Moved detailed enforcement mechanics, tool-by-tool guide, full workflow steps, and communication norms to the new on-demand reference `docs/guardrails-reference.md`
   - Result: from 13,685 chars to 4,609 chars with no policy weakening

4. **Added CI context-budget gate**
   - New scripts: `scripts/check-context-budget.sh` + `scripts/check-context-budget.ps1`
   - Added to `tests/run.sh`
   - Thresholds based on the measured optimized baseline plus headroom:
     - `docs/guardrails.md` ≤ 6,500 bytes
     - Estimated fixed total ≤ 11,000 tokens

5. **Audited skill and tool metadata**
   - Measured 16 skill descriptions (4,730 chars; ~1,183 tokens)
   - Measured 4 native tool metadata (2,897 chars; ~725 tokens)
   - Found no obvious high-cost / low-value candidates worth removing without a separate product decision
   - `pi-web-access` is a Pi extension installed outside this repo; its footprint was noted as not measurable from the `coop-agent` source tree

## Capabilities preserved

- MCP mutation with explicit approval: covered by `coop-guardrails` tests (65 pass)
- Destructive shell actions with explicit approval: covered by `coop-guardrails` tests
- Secret-file access with explicit approval: covered by `coop-guardrails` tests
- Skills remain progressive/lazy; descriptions unchanged
- Native tools (`data_doc`, `sql_review`, `dax_review`, `bpa_review`) unchanged
- Onboarding, doctor, project init, data-doc JSONL bridge: all tests pass
- `coop context-budget` works in both bash and PowerShell dispatch paths

## Hard blocks verified

- `git commit --amend` — still hard-blocked
- `git commit --pathspec-from-file` — still hard-blocked
- `git commit --pathspec-file-nul` — still hard-blocked
- Source-commit policy — still enforced by `coop-guardrails` extension

## Tests

- Focused: `tests/context-budget.test.sh` — all pass
- CI gate: `scripts/check-context-budget.sh` — pass (guardrails 4,619/6,500 bytes, fixed total 8,715/11,000 tokens)
- Full Linux suite: `bash tests/run.sh` — ✓ all tests passed
- Bash/PowerShell parity: `bash scripts/check-parity.sh` — ✓ passed
- Resource validation: `bash scripts/validate-resources.sh` — ✓ passed
- Windows PowerShell behavioral tests: not runnable on this headless Linux box; CI will exercise `tests/run.ps1`

## Deferred optimization candidates

1. **Native tool schema**: `extensions/coop-tools/index.ts` tool metadata is 2,897 chars. The `data_doc` description is the largest single block (806 chars). A future pass could split the description into a shorter always-loaded summary plus a skill/prompt-loaded detail, but only if it does not reduce model awareness of the tool's capabilities.

2. **Skill descriptions**: `dax-patterns` (506 chars) and `azure-devops` (349 chars) are the largest. They are accurate and task-specific; shortening them should be done per-skill with domain review.

3. **Prompt templates**: 13 files totaling 13,776 chars. These are progressively loaded by name; the full content is only relevant when invoked. No reduction needed unless individual prompts become bloated.

4. **`pi-web-access` fixed footprint**: requires measurement inside the Pi runtime; not available from this repository.

## Recommendation

Phase 6 achieved a ~20.7% reduction in estimated fixed startup context while preserving all safety, approval, and capability contracts. Proceed to Phase 7 (shared institutional knowledge backend) only after the usual release/merge flow.

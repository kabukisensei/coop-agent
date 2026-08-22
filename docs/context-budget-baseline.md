# COOP context budget baseline

Date: 2026-08-22
COOP version: 0.22.1
Commit: 74ba8d7ee65c6d9790787d2b9e226f9dc1fed321
Measurement method: static character estimate (`ceil(chars / 4)`)
Platform: Linux (headless VPS)

> This is an **upper-bound static estimate** of prompt-visible fixed startup context.
> Pi may deduplicate or lazy-load some items. Extension implementation source is
> intentionally excluded because the model only sees tool/command metadata and
> explicitly injected messages, not the full TypeScript files.

## Baseline summary

| Category | Chars | Estimated tokens |
| --- | --- | --- |
| Guardrails (`docs/guardrails.md`) | 13,685 | ~3,422 |
| User profile (`~/.coop/user.json`) | 127 | ~32 |
| Project instructions (`AGENTS.md`) | 8,719 | ~2,180 |
| Prompt templates (13 files) | 13,776 | ~3,444 |
| Skill descriptions (16 skills) | 4,730 | ~1,183 |
| Native tool metadata (4 tools) | 2,897 | ~725 |
| **Estimated fixed total** | **43,934** | **~10,984** |

## Extensions loaded at startup

| Extension | Registered tools | Registered commands |
| --- | --- | --- |
| coop-guardrails | 0 | 1 |
| coop-powerline | 0 | 2 |
| coop-profile | 0 | 0 |
| coop-tools | 4 | 2 |

## Skill description sizes

| Skill | Description chars |
| --- | --- |
| azure-devops | 349 |
| coop-workflow | 300 |
| custom-visuals | 228 |
| daily-logger | 358 |
| data-doc-analysis | 321 |
| dax-patterns | 506 |
| dax-review | 244 |
| fabric-workspace-review | 293 |
| git-helper | 217 |
| power-bi-impact-analysis | 298 |
| power-bi-report-authoring | 334 |
| power-bi-report-review | 266 |
| report-themes | 197 |
| setup-docs | 242 |
| sql-review | 295 |
| tabular-editor-bpa | 282 |

## Notes and limitations

## After Phase 6 reductions

The optimized `docs/guardrails.md` shrank from 13,685 chars to 4,609 chars. The
resulting estimated fixed total dropped from ~10,984 tokens to ~8,715 tokens (a
~20.7% reduction). See `docs/phase6-completion-report.md` for the full report.

No other categories changed during Phase 6.

- Native tool schema chars were extracted from the metadata strings inside
  `extensions/coop-tools/index.ts` (descriptions, prompt snippets, prompt
  guidelines, parameter descriptions), not the 57,249 total file chars.
- Project instructions are the nearest `AGENTS.md`/`CLAUDE.md` from the current
  working directory. Inside the `coop-agent` repo this is the repo's own
  `AGENTS.md`.
- Exact tokenizer output is unavailable. The `ceil(chars / 4)` approximation
  is intentionally conservative.
- This baseline was captured before any Phase 6 reductions.

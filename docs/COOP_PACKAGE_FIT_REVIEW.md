# Optional package fit review

September 19, 2026. This is PK1 source research for the [Windows terminal plan](COOP_WINDOWS_TERMINAL_PLAN.md), requested alongside the separately authorized guardrail repair. No package adoption, feature implementation, B1 provisioning or Desktop work is authorized by this report.

**Recommendation:** keep the four ideas in the plan, but introduce none before Monday's presentation. Naming and focused simplification are good candidates for small Coop features. Reuse a qualified patch engine behind a narrow policy-aware integration. Prefer read-only support diagnostics over installing the complete developer-tools package on client workstations.

All work must use **GPT models through existing OpenAI subscriptions**. Preserve the user's configured subscription provider and authentication path. Do not require a separate API key, switch providers automatically or enable priority/fast-mode billing changes. Source-level API compatibility does not prove subscription authentication works; qualify that explicitly in the future isolated trial.

## Evidence and limits

Public source was fetched into E: and inspected without running package code, build scripts or installers. Versions below are the manifests at the exact reviewed source commits, not independently verified latest npm publications. Registry artifact integrity, transitive resolution and native runtime behavior remain unqualified. The preservation baseline is Pi 0.84.3 on Windows with Node 24.18.0 and pi-mcp-adapter 2.34.0; source and resolved-package drift are documented in the [B0 receipt](COOP_WINDOWS_TERMINAL_B0.md).

| Package | Source-manifest version | Reviewed immutable source | Dependency observations |
| --- | --- | --- | --- |
| `@xl0/pi-lovely-rename` | 0.1.5 | [agent-files 82b0c2f](https://github.com/xl0/agent-files/tree/82b0c2f64d4adfe7185c5eebfb62bfc2e0daee0f/pi/packages/pi-lovely-rename) | Runtime `@xl0/pi-lovely-config ^0.1.1`; Pi peers `*`; development Pi `^0.84.4` is above the baseline |
| `@xl0/pi-lovely-codex` | 0.2.3 | [pi-lovely-codex 1a72f9f](https://github.com/xl0/pi-lovely-codex/tree/1a72f9f7d4a0c455f86271c8004a5a7e2d04c4c0) | Runtime lovely-config `^0.1.0` and `typebox *`; Pi peers `*`; external Codex CLI required by patch implementation |
| `@xl0/pi-lovely-dev-tools` | 0.3.6 | [pi-lovely-dev-tools dd9a247](https://github.com/xl0/pi-lovely-dev-tools/tree/dd9a247dbe58ee1e37f8fb63cdcfec35e0a5ea42) | No declared runtime dependencies; Pi peers `*`, development Pi `^0.84.0`; substantial use of agent-session APIs |
| `pi-simplify` | 0.2.3 | [pi-extensions 86cbbbb](https://github.com/MattDevy/pi-extensions/tree/86cbbbb1d65eeca88ce2f820dd958301625e394c/packages/pi-simplify) | No declared runtime dependencies; Pi peers `>=0.74.0`, `@sinclair/typebox ^0.34.0`; Node `>=18` |

The manifests declare MIT licensing. Preserve the actual upstream license and attribution if code is reused. Broad peer ranges are not a compatibility certificate. Relevant naming and developer-tools APIs exist in installed Pi 0.84.3 declarations/exports, but extension loading, transport and lifecycle behavior were not exercised.

## Session naming

[The naming implementation](https://github.com/xl0/agent-files/blob/82b0c2f64d4adfe7185c5eebfb62bfc2e0daee0f/pi/packages/pi-lovely-rename/extensions/rename.ts) automatically names unnamed sessions after a configurable threshold (default three user turns), offers manual `/rename`, and can use a token trigger. It uses the current model's registered provider and model-registry authentication rather than requiring an explicitly hardcoded alternative model.

The prompt includes user/assistant text and serialized tool-call arguments, with a 60,000-character context cap. That is a larger information surface than a title usually needs. Another settings dependency and asynchronous session naming add maintenance even though the extension itself is small.

**Proposed choice:** first compare a minimal Coop implementation in the existing profile extension with upstream adoption. Use a short approved task description or minimized conversation summary, omit raw tool arguments and secrets, retain manual names, bound extra subscription usage, and fail quietly when naming is unavailable. Use only the current GPT subscription provider. This is a design direction, not permission to build it now.

Acceptance must cover manual names, session switching/forking while a response is pending, cancellation, offline/auth failure, repeated triggers, Unicode titles, profile isolation, and model changes. A response from an old session must never rename a different session. Measure useful titles and extra usage before enabling automatically.

## Codex apply_patch only

[The patch implementation](https://github.com/xl0/pi-lovely-codex/blob/1a72f9f7d4a0c455f86271c8004a5a7e2d04c4c0/extensions/lovely-codex/apply-patch.ts) spawns `codex --codex-run-as-apply-patch` with the patch as an argument. It reads affected files to construct before/after diffs. The full extension also changes other tools and supports GPT fast mode; those are outside the requested feature.

**Proposed choice:** evaluate a small Coop integration around a qualified patch engine. Do not adopt the whole package or create a new patch parser by default. Compare the external CLI's distribution and internal entry-point stability with a supported engine before deciding. An OpenAI subscription does not establish that an appropriate CLI binary exists on each workstation.

A custom `apply_patch` tool is not automatically covered by policy that recognizes only local `read`, `edit` and `write`. Before adoption, normalize and authorize every affected path, including rename source/destination and delete targets; preserve secret protection, backups, source permissions and audit minimization. Apply the agreed scope once, then reuse it for matching operations; expansion needs a new decision. Route execution through real Pi enforcement hooks. Do not log patch bodies or secrets.

Windows acceptance must cover executable versus `.cmd` resolution, paths with spaces, command-line size limits, CRLF/BOM/Unicode, junctions and symlinks, cancellation, large patches, partial failure and recovery. The reviewed executor accepts an abort signal parameter but does not forward it to its child process; cancellation needs explicit qualification or a fix in any adopted integration. The current argument transport also exposes patch text to process-argument inspection. A supported safer transport is preferable if available; do not assume one exists.

## Beta diagnostics and support

The package provides `/tool`, `/show-sysprompt`, `/show-context` and `/llm-stats`. Its [manual tool backend](https://github.com/xl0/pi-lovely-dev-tools/blob/dd9a247dbe58ee1e37f8fb63cdcfec35e0a5ea42/extensions/lovely-dev-tools/tool-backend.ts) creates agent-session services, loads extensions and invokes `definition.execute(...)` directly. That bypasses the normal `tool_call` hook path. Its README also documents that distinction. The absence of runtime dependencies does not remove this policy integration problem.

**Proposed choice:** add useful redacted observations to existing Coop doctor/support facilities only after a scoped design. Start with versions, resource ownership, hook registration, latency and sanitized errors. Do not make arbitrary manual tool execution a fleet diagnostic feature. Full upstream experimentation belongs in a disposable beta context until the bypass is removed or all execution passes through the same policy path.

System prompts and session context can contain client data. Support capture/export needs explicit scope, redaction and inspection, not automatic upload or background telemetry. Test duplicate extension activation, profile/auth isolation, stalled tools, log bounds, read-only operation and clean removal. A support feature is useful only if it diagnoses failures without introducing a second agent lifecycle or weakening guardrails.

## Scoped simplification

[The command](https://github.com/MattDevy/pi-extensions/blob/86cbbbb1d65eeca88ce2f820dd958301625e394c/packages/pi-simplify/src/simplify-command.ts) identifies changed files and submits a follow-up prompt into the current Pi session. It supports staged/reference selection. It therefore naturally inherits the current GPT model, but its prompt asks for improvements to be applied. Changed-line limits in a prompt are advisory, not enforced write boundaries.

**Proposed choice:** compare a small review-first Coop command/prompt with package adoption. Reuse existing approved-slice and annotation workflows: identify the change, propose worthwhile simplifications, then apply within the agreed scope without repeat approvals. Do not introduce a competing automatic cleanup stage or equate fewer lines with better maintainability.

Qualification must cover Windows filenames containing spaces (the command parser splits arguments on whitespace), renamed/new/deleted files, staged versus working-tree changes, invalid references, clean trees and untracked files. Demonstrate preserved behavior with relevant tests. Confirm the peer TypeBox family and distributed build resolve with the exact Pi version. Measure findings accepted, unnecessary edits, context usage and review effort against the existing workflow.

## Trial and decision contract

| Gate | Required evidence |
| --- | --- |
| Isolation | B1 accepted first; E: owned profile, caches and scratch repository; operational C: source/profile untouched through trial and removal |
| Supply and compatibility | Exact source and artifact hashes, license, resolved dependency graph, Pi/Node/Windows versions and API use; no unpinned wildcard promotion |
| GPT subscription access | Current OpenAI subscription login works; no separate API key or provider fallback; no unsolicited model/service-tier switch; bounded usage and offline failure |
| Policy | Real Pi hooks enforce execution; initial bounded grant, matching reuse, expansion, decline, revoke and new session; no hidden executor path |
| Data and recovery | Synthetic inputs; no secrets/client context in names or support exports; native filesystem tests, cancellation and rollback |
| Value | Compare adopt/build/defer using useful capability, maintenance burden, dependencies/configuration, reliability, usage and future extensibility |

Research is authorized now. Runtime trials require B1 isolation and authorization for the specific feature. No candidate is approved for installation or promotion by this report. TeamAI/Jev remain unstarted; the same GPT/subscription constraint applies to their later evaluation. The separately authorized G01/G02/G03 guardrail PR must remain independent from these optional features.

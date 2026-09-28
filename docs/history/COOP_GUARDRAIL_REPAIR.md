# Guardrail repair receipt — G01, G02 and G03

This records the initial repair and its historical validation limits. The final
section records subsequent live acceptance and the authorized bracket-parser
follow-up. See [PR #71](https://github.com/kabukisensei/coop-agent/pull/71) for current
commit/check status; older evidence is not validation of a later commit.

September 19, 2026. The user authorized the G01/G02 repair and subsequently added
G03 dynamic-wrapper normalization, preserving the existing changes. All three are
implemented in the isolated E: checkout. **Prepared for draft PR review; full local
acceptance remains incomplete.** Symlink and synthetic-token fixture blockers are
resolved. The broader local suite now stops at a missing C compiler prerequisite.
Publication is authorized; merge, release and operational deployment are held.

## Delivered behavior

- **G01:** Escaping enforcement/approval exceptions return a blocking result with
  fixed text. Exception messages and input payloads are not exposed. Failed grant
  confirmation cannot create a live-read grant. Optional audit/display failures
  remain best-effort.
- **G02:** Destructive-command and unverifiable/hard-blocked-commit audit records
  persist fixed classifications instead of command strings. Displaying legacy
  command-bearing records also minimizes their details; stored history is neither
  rewritten nor deleted. Raw historical audit files may still contain command text.
- **G03:** Central `mcp`, dynamic `mcp__<server>` and direct calls use common
  target/argument normalization. Dynamic wrappers bind the server through their
  registered name; payload `server` cannot override it. Both object and JSON args
  are recognized. Outer query fields cannot mask dispatched SQL, and multiple SQL
  aliases cannot acquire a grant. Remote mutation verbs remain gated, including
  remote `write` operations that are distinct from the local file tool.
  Direct MCP names beginning `mcp__` retain their own arguments when no inner-tool
  envelope exists; SQL classification and production-metadata gates remain intact.

One accepted, verified bounded SQL scope is reused across matching dynamic,
central-proxy and existing native fallback calls. The managed prefix supports
central calls without an explicit server. A larger row bound, changed trusted
client/target/environment/principal, mismatching argument target IDs, unknown
execution controls or ambiguous namespace cannot silently reuse approval.
Rejecting expansion preserves the prior grant; rejecting initial approval creates
none. Revocation, session start and shutdown clear the grant. Mutations never spend
read approval. No prompt-on-every-call workaround was introduced.

The grant remains deliberately limited to one plain SELECT with literal TOP,
within the trusted item/database and result/timeout bounds. It does not approve
arbitrary SQL grammar, exports or unverified scopes. MCP name classification remains
heuristic; this is not certification of every possible remote operation or adapter
execution surface. No live adapter transport or provider session was exercised.

## Validation

| Check | Result |
| --- | --- |
| G01/G02 red tests | Original source persisted a synthetic command canary; after audit repair, the approval-exception test still reached the inert executor until enforcement was fixed |
| G03 red test | Prior G01/G02 bundle lost the dynamic inner tool/server, reproducing the supplied evidence |
| Direct-call review regression | Initial wrapper patch misread prefixed direct SQL as ambiguous; a red test exposed it. Requiring the inner-tool envelope restores direct SQL and production-metadata classification; handler and real-runner checks pass |
| Registered-handler suite | **94 test groups passed**, including all original 86 groups and the preserved G01/G02 regressions |
| Real Pi runtime integration | **Passed with installed Pi 0.84.3**, importing its real AgentSession hook installer and ExtensionRunner; only UI, registration and inert execution fixtures are supplied |
| Real hook assertions | Initial approval and prompt count, repeat reads across dispatch shapes, rejected/accepted expansion, changed identities and IDs, revoke/new/shutdown, mutations, headless mode, synchronous/rejected approval errors, downstream hook stopping and audit canaries |
| CI wiring | `tests/guardrails-pi-runner.test.mjs` added to both existing Pi matrix scripts; matrix installers were not run locally |
| Bash syntax, paired script parity, BOM | Passed |
| PowerShell matrix script parsing | Passed locally under Windows PowerShell 5.1 and PowerShell 7 |
| Original Windows symlink blocker | **Resolved for validation:** elevated E: smoke test creates/reads a genuine file symlink; the unchanged standards SECURITY fixture and all 22 Revision 9 tests pass |
| Broader elevated `bash tests/run.sh` | **Incomplete:** passes all 94 guardrail groups, standards, fleet/Python, MCP/config/token, onboarding and knowledge configuration checks; stops in `tests/sync-knowledge.test.sh` because no C compiler is available to build its required native Windows fixture |
| Synthetic-token follow-up | **Passed:** native E: Python launcher resolves Node's inability to spawn a Bash interpreter wrapper; no production authentication code change, real token or sign-in was used |
| Whitespace and documentation references | Checked |

Local Node was 24.18.0; the broader run used existing Python 3.12.14 read-only through
an E: virtual environment created with `venv --without-pip` (no packages installed).
All generated tests/caches/evidence are on E:. Existing
runtime and esbuild binaries were read without installing/upgrading packages.
Full-suite execution used an isolated E: profile/temp environment and blocked
package operations. The user authorized one-off elevation to create fixture symlinks;
no persistent OS privilege policy or Developer Mode setting was changed, and no tests
were disabled. The initial three-minute harness budget was too short; the local
harness now allows twenty minutes and streams logs. Its first elevated continuation
also exposed Python 3.14 to a fixture needing a Fabric-compatible interpreter. Using
already-installed Python 3.12 resolved that test-environment mismatch. A native E:
`python3.exe` launcher also fixed the synthetic-token fixture: Node on Windows cannot
directly spawn the earlier Bash `python3` wrapper. No production code changed during
this follow-up. The existing fixture reports an unsupported Windows Git-Bash
web/no-Python minimal-PATH case; no new skip or weakened assertion was added.
ShellCheck was unavailable. No fresh hosted CI or live launcher acceptance is claimed.

## Monday stability and PR disposition

The user authorized preparing a PR now and deferring merge if acceptance is incomplete.
Publish as a draft and use normal hosted CI for the missing compiler/ShellCheck coverage;
do not install local prerequisites or skip native fixtures to manufacture a pass.
Require green full-suite and Pi matrix checks plus review of the proposed commit before
merge. The symlink and fake-token failures were local validation-environment problems,
not additional product fixes. No live GPT subscription or real MCP transport rehearsal
was performed, so passing offline hooks alone is insufficient for a pre-presentation rollout.

Source inspection shows Windows launch's `Invoke-CoopUpdateNudge` only fetches
remote refs and reports lag; `scripts/update.ps1` applies source with an explicit
`git pull --ff-only`. A repository merge would not itself deploy this patch, but
an operational update could pick it up. Keep the live checkout/profile and package
fleet at the accepted baseline for Monday; this task has not run update/sync/install,
changed launchers, or activated any integrations.

## Ownership and handoff

- Repair checkout: `E:\Codex\coop-guardrail-repair-20260919\repo`, based on
  `a339dff88a66a53b884e26bd903faad272f2cb21`; scoped publication is authorized.
- Backups: `.backups/guardrail-repair` preserves pre-repair files;
  `.backups/dynamic-wrapper-20260919` preserves G01/G02 before adding G03.
- Code: `extensions/coop-guardrails/index.ts`; tests:
  `tests/guardrails.test.mjs`, `tests/guardrails-pi-runner.test.mjs`; paired matrix
  scripts and affected README/guardrail/architecture/Unreleased documentation.
- Private sibling `evidence` holds `dynamic-before-fix.txt`, `guardrails-final.txt`,
  `pi-runner.txt`, `static-checks.txt`, `suite-checks.txt`, `powershell-parse.txt`
  and `guardrail-repair.patch`, plus the earlier G01/G02 red evidence. Follow-up
  evidence includes `symlink-smoke.txt`, `elevated-status.json`, `elevated-suite-run.txt`,
  `suite-elevated-180s.txt`, `suite-elevated-python314.txt` and `fabric-checks.txt`.
  The E: `work/run-elevated-tests.ps1` helper runs the isolated test harness, not Coop.
  A local PR
  description is in sibling `work/guardrail-pr.md`.
- Tests use only synthetic identifiers. Client rehearsal payloads and credentials
  were not copied into code, tests or public documentation.
- B0 work in `E:\coop` is preserved. A read-only final status check showed the live
  C: checkout clean; its accepted source remains
  `9e8248a8b34a0bd7581b1909bf4fd18f253b3350`. This is not a whole-disk identity claim.
- B1, package reconciliation, TeamAI/Jev, Desktop and operational deployment remain
  outside this repair. Existing E: caches used by stable were not altered or cleaned.

Next: satisfy hosted full-suite/CI acceptance and review before merge. Keep Monday's
operational installation unchanged; deployment remains a separate decision after an
isolated real-session rehearsal and rollback check.

## Live acceptance and bracketed-identifier follow-up

The user authorized completing live rehearsal and conditionally merging/updating
source only after acceptance. Reusing the earlier E: Azure profile with its normal
Windows authentication context succeeded without a new login or policy change.
The rejected isolated device-code flow no longer blocks that rehearsal.

Actual Pi/adapter checks passed initial approval, dynamic and central reuse,
declined expansion, retained prior grant and revocation. Bounded SQL and independent
Power BI MCP DAX returned 12 matching monthly aggregate rows; the current E: report
rendered correctly. No remote mutation or deployment was performed. These are
distinct checks: DAX and report rendering were not Pi guardrail-hook traversals.

The realistic query exposed an existing conservative restriction on bracketed
identifiers. The user authorized a focused extension before merge. Code commit
`cbda69e` now retains opaque identifier tokens for scope checks, including escaped
closing brackets, while rejecting cross-database names and preserving mutation and
batch gates. Double-quoted syntax remains per-call. The live bracketed query now
establishes one bounded grant and repeats without another prompt.

The updated 96-group guardrail suite and real Pi 0.84.3 hook integration pass,
including bracketed expansion, rejection, revocation, new-session and mutation
cases. Normal E: Coop launcher smoke, source rollback/reapply, static parsing and
parity/BOM checks pass. The elevated local full suite still stops at the existing
missing-C-compiler fixture prerequisite; hosted full-suite/Pi checks must pass
before merge. No workstation packages or permanent privilege settings changed.
The earlier native installation acceptance passed at `23fcb01`, before the parser
change, and must not be labeled as testing the later commit.

Protected C: source/profile/client hashes remain unchanged at this checkpoint.
Merge stays held until current checks and review pass; then the authorized
source-only rollout requires a fresh normal installed-launch check. No release,
package update, B1, TeamAI/Jev or Coop Desktop work is included.

# Coop Desktop architecture and implementation plan

- **Status:** Architecture proposal and implementation index
- **Prepared:** 2026-09-04
- **Implementation branch:** `feature/coop-desktop-platform`
- **Decision record:** `docs/adr/desktop-shell-and-runtime.md`

This document is the consolidated implementation authority for Coop Desktop. It
preserves the original architecture and platform addendum while removing their
duplicate roadmaps and resolving their dependency conflicts. Detailed product
requirements should be added here or linked from a work package; they must not
be maintained as a second competing sequence.

## 1. Product decision

Build Coop Desktop as a workspace-first Windows/macOS client over the existing
governed Coop and Pi runtime. Do not create a second agent engine, fork Pi,
replace the terminal product, manipulate Pi session/auth files, or duplicate
Data Doc, SQL Review, DAX Review, or BPA logic.

The product model is one Coop Core with three first-class clients:

- terminal for complete power-user operation and fallback;
- Web for lightweight localhost/browser use; and
- Desktop for native packaging, onboarding, and engineering-workbench views.

Electron is the planning default. Tauri must earn selection through the shell
spike defined by DSK-011 and the ADR.

## 2. Versioned contract model

Each concern has one owner and one schema.

| Contract | Purpose | Owner |
|---|---|---|
| Capability descriptor | Static identity, schemas, side effects, permissions, presentations, docs, health and test IDs | Coop Core registry |
| Evaluated availability | Installed/authenticated/platform/health state for the current machine and workspace | Coop runtime |
| Invocation | Versioned commands and inputs | Capability implementation |
| Execution envelope | Execution status, evidence status, verdict, typed results, diagnostics and artifact IDs | Coop Core adapter plus authoritative tool output |
| Runtime event | Progress and state changes with reconnect/correlation semantics | Coop runtime |
| Parity entry | Required clients/platforms, fallback policy and release tests | Desktop parity manifest |

The parity manifest references capability IDs. It does not copy capability
names, descriptions, input schemas, platform rules, or health logic.

### 2.1 Execution semantics

Execution, evidence, and review outcome are separate:

```json
{
  "schemaVersion": 1,
  "runId": "...",
  "capabilityId": "coop.review.sql",
  "capabilityVersion": "0.15.2",
  "executionStatus": "completed",
  "evidenceStatus": "complete",
  "verdict": "findings",
  "coverage": {},
  "results": {},
  "diagnostics": [],
  "artifacts": [{ "id": "...", "kind": "raw-tool-output" }],
  "markdownSummary": "..."
}
```

- `executionStatus`: `completed | failed | cancelled`
- `evidenceStatus`: `complete | partial | failed | not-applicable`
- `verdict`: capability-specific, with common values such as
  `pass | findings | blocked | unavailable`

Coverage is typed per capability. The original tool JSON is retained as an
artifact; clients receive an artifact ID rather than an unrestricted path.

### 2.2 Event semantics

The runtime event contract must define:

- contract version and event type;
- stable event, stream, session, command, run, and causation IDs;
- monotonic sequence and reconnect cursor;
- snapshot revision and reconciliation behavior;
- at-least-once delivery with client deduplication;
- command cancellation and terminal states;
- approval replay after reconnect;
- payload and buffer limits; and
- redacted diagnostic access to the underlying Pi event.

Unknown additive Pi events warn and remain diagnosable in production. Unknown or
changed events required by Coop fail protocol CI.

## 3. Parity scope

Parity is tested in three tiers:

| Tier | Release expectation |
|---|---|
| Required Coop Core | Native Desktop presentation or explicit approved platform limitation |
| Supported Pi RPC used by Coop | Shared runtime adapter and automated contract test |
| Arbitrary TUI-only extension | Honest terminal fallback; never counted as Desktop-native |

The current Web state must be re-derived from code and tests before populating
`config/desktop-parity.json`. The historical prose matrix is evidence for the
audit, not data to copy unchanged.

## 4. Runtime and security boundary

`coop runtime` is the supported runtime command.
It consumes `coop launch-spec --json`, appends `--mode rpc -a`, and owns process
supervision, protocol validation, capabilities, sessions, replay, leases,
workspace files, Git reads, Doctor/auth/config services, and companion-tool
adapters.

The renderer has no Node, shell, arbitrary path, credential, session-file, or
update authority. Desktop v1 accepts only built-in, allowlisted rich views;
unknown capabilities use the generic structured result renderer.

Sensitive display and diagnostics follow structured redaction. Approval cards
identify the exact operation without printing embedded credentials. Approval
timeouts and unknown methods deny by default.

## 5. State and ownership

| State | Authority |
|---|---|
| Project repositories, standards, environments and approval policy | `.coop/project.yml` |
| Data Doc configuration and resolution | `coop-data-doc.yml` and supported Data Doc protocols |
| Pi sessions, model credentials and private memory | Pi/provider-supported stores |
| Desktop layout, theme and recent workspaces | Desktop-specific user state |
| Project knowledge | Approved project repository records |
| Team-general knowledge | Separate private team repository |

One live writer may own a session or checkout. Leases require atomic acquisition,
a unique nonce, process-start identity, renewal, verified stale recovery, and
separate session/checkout scopes. An override never authorizes two confirmed
live writers.

## 6. Workspace product

Desktop is a data-engineering workbench, not a chat wrapper. Its primary areas
are Workspaces, Agent, Changes, Reviews, Lineage, Impact, Knowledge, and Health.
Mission Control shows project identity, runtime/auth health, active sessions,
Git state, review state, lineage age/completeness, and common workflows.

All themes share one information architecture and semantic component tree.
Modern Dark and Modern Light are required production themes. Retro Messenger is
implemented after the token/component architecture is stable and must not delay
runtime, evidence, Windows reliability, or accessibility gates.

## 7. Release scope decision

Windows managed VMs remain the primary production gate. Desktop 1.0 targets
simultaneous Windows and macOS general availability, with equivalent packaging,
signing, rollback, and clean-machine gates. Windows remains the lead consultant
environment and may block the entire 1.0 release even when macOS is green.

This records option 2 from the architecture review. Preview artifacts may still
be published per platform at different times, but no artifact may claim Desktop
1.0 general availability until both platform gates pass. This policy does not
authorize signing, publishing, releasing, or modifying an installed Coop.

## 8. Unified implementation sequence

### Phase A — Architecture and trust

- DSK-001: architecture decision and supersession
- CORE-001: capability registry and schema
- DSK-002: parity manifest referencing capability IDs
- DSK-003: Pi 0.84.3 protocol revalidation
- TOOL-001: atomic Data Doc lineage-cache persistence
- TOOL-002: invalid explicit SQL schema failure
- TOOL-003: correct DAX PBIR sibling discovery
- TOOL-004: DAX PBIR evidence completeness

The protocol and companion-tool fixes may proceed in parallel after their own
repository checks. No rich review UI begins until the applicable tool gate is
green.

### Phase B — Coop Core runtime

- CORE-002: structured execution envelope
- CORE-003: reconnectable runtime event stream
- DSK-004: evaluated runtime capabilities endpoint
- DSK-005: supported `coop runtime` entry point
- DOC-001: structured Doctor service
- AUTH-001: shared authentication-provider contract
- ONB-003: shared config proposal, validation, backup and atomic write

Exit: one small vertical slice can start the governed launch spec, report
capabilities, execute one read-only command, stream/reconnect, and shut down
without changing terminal or Web behavior.

CORE-002 and CORE-003 are implemented in Coop Core. Deterministic companion-tool
results now use a versioned execution envelope whose execution, evidence, and
verdict states remain independent, with opaque authenticated access to the
complete raw result. The additive domain stream provides monotonic IDs,
bounded replay, snapshot revisions, reconnect cursors, live SSE, and polling
fallback without changing the existing raw Web event contract. Runtime
capability negotiation advertises both contract versions.

DOC-001 is implemented as an additive shared Doctor contract. The established
human, fleet JSON, and publish behavior remains compatible, while
`coop doctor --service-json`, the authenticated runtime endpoint, and the typed
runtime client consume one normalized report with stable IDs, five explicit
health states, safe evidence, recommended actions, and approval-aware repair
metadata. Runtime capability negotiation registers Doctor and advertises the
report schema version. The native Health presentation remains DSK-014.

AUTH-001's provider/state contract is implemented. Bash, PowerShell, Web, and
future Desktop clients share one report for model access, client Microsoft/Azure
identity, and the distinct future Cooptimize-knowledge identity. Model detection
reads credential metadata only; Microsoft inspection retains only safe display
identity from a fixed read-only Azure CLI call. Provider states, available
actions, unlocked capabilities, diagnostics, and login methods are versioned,
and `auth.changed` is part of the shared runtime stream. Actual login/logout and
OAuth progress execution remain DSK-010 and require explicit user action.

ONB-003 is implemented as a shared proposal/validation/write boundary. It accepts
candidate content from the authoritative setup owner, validates it through the
shared project YAML parser, returns exact before/after content and digests, and
requires a second explicitly approved apply. Writes are workspace-fixed,
size-bounded, backed up using the project convention, flushed, and atomically
renamed. Concurrent edits make the proposal stale instead of being overwritten;
successful writes emit `config.changed`. The terminal `/setup-project` flow now
uses this same service instead of its former private write helper. Desktop
presentation remains DSK-014.

### Phase C — Pi and session parity

- DSK-006: supported Pi RPC adapters
- DSK-007: tree, fork and clone
- DSK-009: session/checkout leases and terminal handoff
- DSK-010: model-auth bridge over AUTH-001
- DSK-008: existing-branch navigation over Pi's public `navigateTree` extension
  API while Pi 0.84.3 lacks a direct RPC command

DSK-008 is implemented in the shared runtime and Web client. The authenticated
adapter preserves Pi's normal branch-summary and cancellation hooks and never
edits session JSONL. Desktop remains `planned` until its shell consumes the same
runtime method; a future direct Pi RPC command can replace the adapter without a
client workflow change.

DSK-009 session ownership and handoff preparation are implemented in Coop Core.
Every governed Pi client now participates in the same persisted-session lease,
including heartbeat, process identity, fail-closed conflict handling, and
verified stale recovery. The Desktop runtime exposes fixed open/clone/move launch
requests; clone restores Desktop to its original session, and move gracefully
releases Pi ownership before returning. The native terminal application launch
remains part of DSK-012, and checkout/worktree ownership remains DSK-018.

### Phase D — Discovery and shell preview

- ONB-001: environment discovery
- ONB-002: progressive project setup
- DSK-011: Electron/Tauri spike and final shell decision
- DSK-012: secure Desktop preview shell
- UX-001: workspace/Mission Control information architecture
- UX-003: clipboard and attachment reliability
- DSK-013: commands, images, models, thinking and queues
- DSK-014: onboarding and Health UI over AUTH/DOC/ONB services

ONB-001 and ONB-002 are implemented in Coop Core. Local repository discovery is
bounded to the selected workspace; Fabric workspace/item discovery uses fixed
read-only Microsoft API paths through Azure CLI, validates identifiers and item
types before execution, preserves partial pagination evidence, and never resolves
duplicate human names silently. Progressive setup reports optional skipped
sections as not configured rather than broken and maps a blocked capability to
one stable next setup operation. Bash, PowerShell, Web, and the typed runtime
client consume these shared contracts. Rich guided presentation remains DSK-014.

Conversational onboarding remains an explicit end-to-end acceptance gap. Shared
discovery commands, a setup wizard, and config proposal/write services do not yet
prove that the agent can take a natural-language environment description, discover
matching resources, ask about ambiguous names, preview the config change, apply the
approved proposal, and run Doctor. That journey must pass in both terminal and
Desktop before conversational onboarding is marked complete. It must preserve
unowned configuration, keep skipped integrations usable, and reject stale proposals.

DSK-011 is implemented and records Electron as the production-preview shell.
Both Electron and Tauri loaded the unchanged runtime-hosted SPA, exercised stub
Pi/extension events and Changes, used narrow native APIs, and cleaned up their
children. Tauri's macOS footprint was substantially smaller, but its Rust/native
build graph, platform-WebView variance, and Windows-native packaging requirement
failed the ADR's complexity gate for this Node/Chromium-oriented codebase. The
measured results and revisit trigger are in
`docs/adr/desktop-shell-spike-results.md`.

DSK-012's production-oriented preview shell is implemented under `desktop/`.
It preserves the runtime-hosted SPA while adding a distinct development identity,
native workspace selection, menus and shortcuts, completion notifications,
confirmed external links, desktop-only state, runtime restart UX, and the native
open/clone/move terminal boundary. Renderer IPC is individually named and
sender-validated. Windows resolves the installed `coop.cmd` through its trusted
PowerShell sibling without enabling a general shell. Unsigned macOS and Windows
x64 development artifacts build successfully, and the macOS package reaches the
existing Changes workflow against stub Pi without orphaning children. Interactive
native-dialog inspection on the locked Mac and actual Windows managed-VM execution
remain explicit QA/WIN gates rather than implied completion.

DSK-013's shared interaction presentation is implemented and consumed by both
Web and Desktop. Command discovery comes from Pi `get_commands` and preserves
skill/prompt/extension provenance; Desktop-native actions are supplied by the
allowlisted preload boundary. Model and thinking cycling use Pi's real RPC
commands, and the available thinking-level list comes from the active runtime.
Busy turns expose separate `steer` and `follow_up` actions, queue events remain
separated by kind, and queue processing modes remain Pi-owned. Clipboard paste,
drag/drop, and the picker accept only the runtime-published PNG/JPEG/GIF/WebP
limits, preserve ordinary code/text paste, preview every image, and allow removal
before send. Web parity is implemented for these capabilities; Desktop remains
partial until interactive macOS and Windows managed-VM journeys are recorded.

DSK-014's onboarding and Health presentation is implemented as a conservative
preview slice. One view projects the shared Doctor, auth-provider, progressive
setup, and private-profile contracts without treating optional configuration as
failure. The profile form obtains its choices and limits from the authoritative
Python onboarding owner and writes only after explicit approval. The advanced
project-contract editor reads the fixed workspace path, validates an in-memory
proposal, shows exact before/after bytes and target path, and performs a separate
approved atomic write with stale detection and backup; guided setup continues to
use `/setup-project`, and Data Doc setup continues to use its existing owner.
The fixed Pi TUI model-login bridge is available from Health. Microsoft login
execution, Doctor repair execution, the native Data Doc JSONL questionnaire, and
interactive platform evidence remain explicit gaps, so related Desktop parity
rows remain partial rather than implemented.

### Phase E — Engineering workbench

- EXT-001: service capability registration/invocation contract
- EXT-002: allowlisted rich-view contract plus generic fallback
- DSK-015: generic findings and SQL/DAX/BPA views
- DSK-016: focused Data Doc lineage explorer

EXT-001 and EXT-002 are implemented as narrow declarative contracts. The
service registry maps existing governed Pi tools to capability IDs, structured
execution envelopes, least permissions, and Doctor checks; it does not execute
arbitrary plugin code. The UI registry accepts only built-in renderer/action
identifiers and cannot carry callbacks, commands, paths, IPC methods, or native
authority. Unknown capabilities always retain the generic raw-result fallback.

DSK-015's shared SQL/DAX/BPA findings workbench is implemented for Web and is
consumed unchanged by the Desktop preview shell. It preserves deterministic
findings separately from agent-review prompts; exposes explicit evidence state,
coverage, diagnostics, filtering, grouping, source context, raw output, and
in-session fingerprint comparison; and has pinned SQL 0.15.2, DAX 0.22.0, and
BPA contract fixtures proving projection parity. Desktop remains `partial`
until the Windows managed-VM and interactive packaging journeys exercise these
views against installed companion tools.

DSK-016's focused lineage slice is implemented across Data Doc, Coop Core, Web,
and the shared Desktop renderer. Data Doc's additive `lineage.v1` response now
returns source/doc locations, trust markers, focused diagnostics and global
diagnostic coverage, the exact authored edges in the slice, their explicit
flow-normalized direction, and evidence text. The client renders only those
returned facts; it does not load or reinterpret the full graph. Legacy responses
remain available but are downgraded to partial evidence. Web parity is
implemented; Desktop remains partial pending the packaged Windows journey.

### Phase F — Workflows and knowledge

- EXT-003: resumable, approval-aware workflow contract
- DSK-017: guided impact analysis over the existing skill
- DSK-018: worktree isolation for concurrent write-capable sessions
- KNW-001: knowledge schema and scope policy
- KNW-002: disposable local index over approved Git records
- KNW-003: proposal/review/supersession UI
- UX-002: complete theme system, including Retro Messenger after core themes

EXT-003 is implemented as a versioned, declarative workflow registry plus a
runtime-owned state machine. Definitions may reference only registered
capabilities, fixed Coop Core operation IDs, and explicit approval operations;
they cannot embed commands, callbacks, paths, or renderer code. Checkpoints
carry monotonic revisions, stage attempts, evidence state, artifacts,
diagnostics, and auditable approval decisions, and can be recovered after a
client reconnect without rerunning a stage. The representative Review changes
workflow composes Git Changes, SQL Review, DAX Review, BPA, the governed agent,
and handoff preparation. Its optional write stage cannot start without a named
`workspace.write` grant, while its review-only route can complete with partial
evidence still visible. Cross-process durable checkpoint storage remains a
deliberate later contract rather than silently writing workflow state into the
project or Pi session files.

DSK-017 is implemented as a guided presentation over the existing
`power-bi-impact-analysis` skill. The UI captures the exact target, change type,
outcome, environment/deployment scope, lineage-refresh choice, and read-only live
inspection permission, then invokes the skill under `coop-workflow`. A new
advisory result tool validates the versioned `impact-analysis.v1` artifact and
publishes it through Coop Core's execution-envelope/raw-artifact boundary. Every
path and impacted object must cite observed evidence or labeled inference;
partial sources, inference-only support, and unresolved gaps prevent a complete
claim. The shared renderer exposes target, upstream/downstream and cross-artifact
paths, reports/apps/RLS/refresh/consumers, gaps, risk, alternatives, plan, and
pending approval without reimplementing lineage or impact reasoning. Web parity
is implemented; Desktop remains partial pending packaged Windows evidence.

DSK-018 is implemented at the shared runtime and guardrail boundary. Writable
ownership is keyed to the canonical checkout root and persisted outside project
and Pi session state with heartbeat, process identity, and proven-dead stale
recovery. A conflicting session must choose a Coop-managed worktree, an enforced
read-only attachment, or a separately approved concurrent-write override. Core
mints every worktree path and Git argument; create/remove operations require
explicit approval, cleanup never uses force, and dirty worktrees are preserved.
Web presents the three-way choice and cleanup action. Desktop remains partial
until the packaged Windows journey and terminal-clone choice UX are exercised.

### Phase G — Distribution and release

- REL-001: managed runtime packaging
- REL-002: signing, updater and rollback
- QA-001: complete cross-platform journey suite, depending on every capability
  used by its journeys rather than only the shell
- WIN-001: Windows managed-VM gate
- QA-002: generated parity and release gate

## 9. Dependency corrections

The following dependencies are mandatory even if a task tracker omits them:

| Package | Must also depend on |
|---|---|
| DSK-004 | CORE-001, DSK-003 |
| DSK-014 | AUTH-001, DOC-001, ONB-001, ONB-002, ONB-003, DSK-012 |
| DSK-015 | CORE-002, EXT-001, EXT-002, TOOL-002, TOOL-004, DSK-012 |
| DSK-016 | CORE-002, EXT-001, EXT-002, TOOL-001, DSK-012 |
| DSK-017 | CORE-002, EXT-003, DSK-015, DSK-016 |
| QA-001 | DSK-007, DSK-009, DSK-010, DSK-012–016, AUTH-001, DOC-001 |
| QA-002 | DSK-002, DSK-003, QA-001, WIN-001 and the selected platform GA gate |

## 10. Development isolation and rollback

- Develop in `/Users/aaronjennings/Developer/coop-agent-desktop` on
  `feature/coop-desktop-platform`.
- Keep the existing `coop-agent` checkout and normal user installation intact.
- Use a development app identity, runtime state directory, update channel,
  browser profile, test workspace, and test sessions.
- Never run development install/update/sync against the normal Coop agent state.
- Do not publish packages, create tags, change the stable channel, commit, push,
  merge, or release without explicit authorization.
- Keep work-package changes small and independently reviewable. Companion-tool
  changes use sibling repository branches.

Rollback before merge is removal of the development worktree/branch. After
release, the updater retains and can atomically reactivate the prior compatible
Desktop/runtime bundle.

## 11. Non-goals for the first preview

- Hosted or multi-user agent service
- Remote access to the local agent
- Pi fork or private SDK dependency
- Automatic source commits or pushes
- General third-party renderer code
- Central hosted knowledge service
- Multiple writers in one checkout
- Full IDE or terminal-emulator replacement
- Claiming Windows-only Power BI Desktop behavior on macOS

## 12. Release gates

A production release requires:

1. byte-equivalent governed Pi launch behavior across terminal, Web, and runtime;
2. current Pi protocol verification and zero unexplained required-event drift;
3. a generated capability/parity report;
4. exact companion-tool golden-fixture parity and visible partial evidence;
5. renderer isolation and IPC/path/navigation security tests;
6. session and checkout ownership tests, including crashes and stale recovery;
7. clipboard, attachment, accessibility, clean-machine, update and rollback tests;
8. signed artifacts and verified update metadata; and
9. unchanged passing terminal, Web, Bash and PowerShell regression gates.

## 13. Current implementation frontier

DSK-001 through DSK-011's Core-owned and shell-selection work, CORE-001 through
CORE-003, DOC-001, AUTH-001, and ONB-001 through ONB-003 are implemented on the
isolated feature branch, along with TOOL-001 through TOOL-004 in their isolated
sibling branches. Electron is selected and DSK-012's preview implementation is
present, with platform execution gates still pending. DSK-013's shared commands,
images, runtime-reported model/thinking controls, explicit steer/follow-up
queues, Pi-native HTML export, auto-compaction, auto-retry, and retry-abort
controls are implemented, with Desktop entries conservatively partial until
platform journey evidence exists. DSK-014's shared onboarding/Health, private
profile, project-contract preview/apply, and preview model-login presentation is
present, with its remaining platform/auth/repair/setup-protocol gaps kept
explicit. EXT-001 through EXT-003, DSK-015 through DSK-018, and KNW-001 through KNW-003 are implemented at
their shared Core/Web boundaries. Rich Desktop rows remain conservatively
partial until the packaged Windows journeys exercise installed tools, native
boundaries, and workspace-isolation choices. KNW-001 supplies the versioned
record schema and fail-closed scope/lifecycle policy; KNW-002 supplies the
read-only, reproducible, disposable index over configured Git-backed records.
KNW-003 adds previewed, approval-gated atomic source changes and the shared
Knowledge Hub while leaving commits/publication human-controlled. Knowledge
repository selection still uses trusted preview configuration and must move into
the progressive setup owner before GA. UX-001's workspace/Mission Control
information architecture is implemented as a shared projection over existing
Core contracts: Desktop opens it after initial replay while Web remains
chat-first, and missing/partial/not-run states remain explicit. UX-002's Modern
Dark, Modern Light, and Retro Messenger modes now share one semantic token and
component system, switch without reload, persist per user, and cannot alter
capability availability. UX-003's shared implementation now provides bounded
screenshot/image/text attachment input, length-delimited text evidence,
source-only and plain-text copy actions, deterministic TSV, platform-aware line
endings, and unmodified native selection. Automated contracts pass; the
checked-in SSMS, VS Code, Power BI, Teams, browser, and Azure DevOps matrix keeps
Windows interoperability explicitly pending until managed-VM evidence exists.
The next dependency-correct slice is managed distribution and its Windows
release gates; UX-003 is not marked production-complete before that evidence.

REL-001 is in progress. The first managed-distribution slice defines an offline,
versioned bundle schema and staging command for Coop source, Node, pinned Pi, and
the pinned Python tools. It now uses checksum-pinned relocatable CPython 3.12.14
instead of copied virtual environments, gives each Python tool an isolated
package root, generates bundle-relative launchers, and normalizes verified
internal symlinks so relocation cannot retain build-machine paths. Staging rejects
mismatched versions, missing target-applicable npm packages, external symlinks,
and overwrite attempts, and is performed on the target platform. Managed package
commands embed that explicit bundle as an Electron resource. Packaged Desktop
validates platform, architecture, jailed paths, and complete release-plan version
agreement before preferring the managed launcher; a corrupt present bundle fails
closed. Preview packages without the resource retain their existing installed-Coop
behavior. The build plan pins official Node 22.22.3 and python-build-standalone
3.12.14 archives and SHA-256 for macOS arm64/x64 and Windows x64 while deriving
every npm, extension, MCP, and Python package requirement from the release
manifest. Managed mutable state is isolated by Coop/Pi version, while exact Pi
extensions load from the immutable bundle for offline first launch. A real macOS
arm64 bundle and unsigned packaged app pass relocation, version, runtime, HTTP,
renderer-load, and clean-shutdown smoke checks. Windows clean-machine execution,
fully locked transitive dependency acquisition, signed installers, and updater/
rollback remain open REL-001/REL-002 release gates.

REL-002 is in progress. Strict versioned schemas and a shell-neutral updater
service now verify Ed25519-signed update descriptors against an app-supplied
pinned trust registry. A signed key ID is bound to an active Ed25519 public key,
validity interval, allowed channel, and separate artifact/release-note HTTPS
origins; unknown, revoked, expired, or policy-incompatible keys fail closed.
Host target, bounded descriptor validity, and exact artifact size/SHA-256 are
validated before any activation decision. The downloader refuses redirects and
content encoding, streams into an exclusive owner-only file, enforces the signed
size while streaming, fsyncs, verifies SHA-256, and removes partial failures.
Activation and rollback fail while
Coop Runtime is live,
require explicit healthy evidence bound to the exact release ID and Coop/Desktop
versions, atomically persist the active/previous pair with signing-key and artifact
digest provenance, retain one rollback version, and reject ordinary downgrade as
an update. Eight focused tests cover signature tampering, expiry/target/channel failures, artifact
tampering and symlinks, pinned-key identity/rotation policy, health gating,
live-runtime gating, atomic state, rollback, and corrupt-state/path failure.
Production public-key provisioning, hosted metadata, OS installer helpers,
signing/notarization, updater UI, and real failed-update/
clean-machine rollback exercises remain release blockers; no placeholder trust
key or unsigned fallback is accepted.

The packaged-shell trust boundary now loads update keys only from the fixed
`resources/desktop-update-trust.json` path inside the packaged application.
Development builds and packages without that file report updates as unconfigured;
a present malformed, revoked-only, symlinked, oversized, or external policy fails
closed. No environment/CWD fallback exists. Electron packaging enables embedded
ASAR integrity validation together with `OnlyLoadAppFromAsar`, disables Run-as-Node,
Node option injection, CLI inspection, and extra `file://` privileges, and keeps
the renderer sandbox controls. An actual unsigned macOS arm64 package was rebuilt
and its fuse wire inspected successfully. A cross-platform post-package verifier
now checks the actual binary fuse wire, rejects loose `app/` or `default_app.asar`
fallbacks, and revalidates the complete embedded managed-runtime manifest; the
native macOS package passes. The managed Windows/macOS workflow runs the same
verifier after both package jobs. The production public key is still
absent by design and must be provisioned before signing.

QA-002 is in progress. A checked-in release-requirements contract and
`desktop-release-gate` now produce a machine-readable report for one exact
40-character Git revision. The gate independently verifies pinned Pi/protocol
alignment, every release-gated Desktop parity row, and fresh Windows/macOS
evidence for the approved suite, journey, interoperability, distribution,
accessibility, and renderer-security requirements. Evidence is platform-scoped,
hash-attributed, bounded in age, and rejected when it belongs to another revision,
duplicates a platform, or claims an inapplicable result. The current report is
intentionally blocked by the honest parity manifest and absent clean-machine
evidence. CI evidence production and the protected release-job invocation remain
open; the report engine cannot itself authorize publishing.

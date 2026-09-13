# Desktop service and UI extension contracts

Coop Desktop extensions add capabilities and presentations without moving
domain logic into the renderer. The initial contracts are intentionally fixed,
declarative, and built-in while the platform boundary is being proven.

## Service extensions

`web/service-extensions.mjs` is the Coop Core registry for the first companion
tool adapters. Each descriptor identifies one capability, its governed Pi tool
invocation, its structured output envelope, the least permissions it needs, and
the Doctor checks that establish availability.

The registry does not execute arbitrary extension code. Pi remains the
invocation owner, and SQL Review, DAX Review, BPA, and Data Doc remain the
authoritative domain implementations. Coop Core only maps their structured
results into `execution-envelope.v1` and retains the complete original result
behind a chat-scoped opaque artifact ID.

## UI extensions

`web/public/capability-view-registry.js` accepts exactly three fields:

- `capabilityId`
- one allowlisted `rendererId`
- zero or more allowlisted action IDs

Descriptors cannot contain callbacks, paths, commands, IPC methods, or native
authority. Renderers and actions are implemented by the trusted Coop client.
Unknown capabilities always resolve to `generic-result` with access to the raw
structured artifact, so adding a tool never requires prose scraping and never
causes its result to disappear.

The first rich renderer is the generic findings workbench shared by SQL Review,
DAX Review, and BPA. It preserves deterministic findings separately from
agent-review prompts, shows evidence completeness before verdict, filters and
groups structured fields, compares stable fingerprints between runs, and links
source context only through the existing jailed file API.

## Contract rules

1. Business logic belongs to Coop Core or the authoritative companion tool.
2. A custom view is optional; the generic structured fallback is permanent.
3. Execution success and evidence completeness are independent.
4. Partial or failed evidence cannot be presented as a clean pass.
5. The original structured tool output remains inspectable.
6. Renderers never receive general shell, filesystem, session-file, credential,
   or IPC authority.
7. Capability, service-extension, envelope, and UI-view versions change through
   explicit checked-in contracts and tests.

Pinned SQL and DAX CLI captures under `tests/fixtures/findings/` prove that the
workbench preserves finding count, rule ID, severity, location, object,
fingerprint, standard reference, and the deterministic/agent-review boundary.
BPA uses the same normalized contract and its existing runner fixture.

The focused lineage renderer consumes only Data Doc's additive
`lineage.v1` response: stable node IDs, already flow-normalized upstream and
downstream lists, authored edges, explicit flow direction, edge evidence,
source/doc locations, trust markers, diagnostics, and coverage. Legacy lineage
responses remain visible but are marked partial because they lack edge evidence.
The client does not load or traverse `graph.json` itself.

## Workflow extensions

`config/workflows.json` is the first declarative workflow-extension registry.
Its versioned definition schema describes inputs, prerequisites, ordered stages,
dependencies, capability/core/approval execution kinds, permissions, named
approval operations, accepted evidence states, and completion criteria. A
descriptor cannot contain a command, callback, executable path, or renderer
code.

`web/workflow-service.mjs` owns run checkpoints and named transitions. The
runtime—not the browser—tracks the current stage, attempts, evidence rollup,
artifacts, diagnostics, approval decisions, and monotonic revision. A reconnect
reads the same checkpoint and runtime event history instead of starting work
again. A capability stage with `requiresApprovalOperation` cannot start until
that exact operation has an affirmative decision in the run; declining an
optional mutation keeps a read-only workflow usable.

The first representative workflow is `coop-workflow.review-changes`. It composes
the existing Git Changes, SQL Review, DAX Review, BPA, governed-agent, and
handoff capabilities. It does not implement Git inspection or review rules. Its
review-only route can finish without granting workspace write access, and
partial evidence remains partial in the completed checkpoint.

Runtime clients use named endpoints and methods only:

- `GET /workflows`
- `POST /workflow/start`
- `GET /workflow/run`
- `POST /workflow/transition`

Workflow start/transition events share the reconnectable Coop runtime stream.
Run checkpoints are chat-scoped and disappear with their owning runtime session;
durable cross-process persistence is intentionally deferred until its storage,
retention, and sensitivity contract is approved.

## Guided impact analysis

`power-bi-impact-analysis` remains the reasoning owner and runs under
`coop-workflow`. Desktop/Web guidance collects the exact target, change intent,
outcome, environment/scope, Data Doc refresh choice, and read-only live-evidence
permission, then sends that request to the existing skill. No impact engine or
lineage traversal is implemented in the renderer.

The skill finishes by calling the advisory `impact_analysis_result` tool. That
tool accepts only a bounded `impact-analysis.v1` object, validates source IDs and
enumerations, strips unknown structure through normalization, and emits it via
the same execution envelope and opaque raw-artifact path as other service
extensions. It performs no filesystem or external mutation.

Every path and impacted object must cite at least one Data Doc, Fabric, Power BI,
source, Microsoft Learn, or explicitly labeled agent-inference record. Partial
or failed sources, inference-only evidence, and unresolved gaps prevent a
`complete` evidence claim. The rich view keeps target, upstream, downstream,
cross-artifact paths, reports/apps/RLS/refresh/consumers, gaps, risk, safer
alternatives, proposed plan, and approval state separate. The artifact's pending
approval status is informational; only the existing Coop workflow approval gate
can authorize edits.

## Workspace isolation

`lib/workspace-isolation.mjs` is the shared checkout-ownership contract used by
Web, Desktop runtime children, and terminal guardrails. Its persisted lease key
is the canonical Git checkout root, so two sessions opened from different
subdirectories cannot evade the single-writer boundary. A live conflict exposes
only three resolutions: create a Coop-managed worktree, attach read-only, or
explicitly approve a concurrent-write override.

Read-only is enforced by the guardrail extension across Pi's built-in edit,
write, patch, Bash, and PowerShell surfaces even if ordinary discretionary
guardrails are disabled. Overrides require a separate affirmative action and are
recorded beside—not in place of—the primary lease. Stale primary ownership is
recoverable only when its heartbeat has expired and its process is proven gone.

Managed worktree paths and Git arguments are minted by Coop Core. Clients submit
only an opaque ID and a named operation; they cannot choose an executable,
command, Git option, or cleanup path. Creation and cleanup require explicit
approval. Cleanup calls ordinary `git worktree remove` without force and refuses
dirty or unverifiable worktrees, preserving user changes. Project configuration,
Pi session JSONL, and the source repository are not used as lease state stores.

## Knowledge policy

`config/knowledge-record.schema.json` and `lib/knowledge-policy.mjs` define the
shared KNW-001 contract. Private memory remains in the existing private provider
store and cannot be represented as a shared Git record. Project records stay
client-confidential in their project repository. Team records carry no project
identity, must declare no client data, and require an attributable sanitization
check before even a proposed draft enters the team repository.

Approval, rejection, deprecation, and supersession are lifecycle transitions,
not agent assertions. Status changes require an explicit human action; record ID
and scope are immutable. The complete storage, content-review, and failure policy
is documented in `docs/knowledge-policy.md`. KNW-001 validates normalized records
but performs no file write, indexing, retrieval, or publication.

KNW-002 adds `config/knowledge-index.schema.json` and the read-only
`lib/knowledge-index.mjs`. It parses a deliberately bounded Markdown/YAML subset,
validates every normalized record through KNW-001, indexes approved records only,
and exposes deterministic scope-aware search with source provenance. Invalid or
duplicate approved records remain diagnostics and downgrade completeness; the
index never silently chooses a copy. The generated model contains no absolute
machine paths or timestamp and is always disposable.

KNW-003 adds one Core-owned proposal/apply service and a shared Knowledge Hub.
Clients can list/search, request a create or lifecycle preview, and apply only an
opaque chat-scoped proposal after an explicit approval. The service mints the
canonical filename, rejects stale source bytes, writes atomically, preserves
recoverable prior bytes outside the repository, and never commits. A knowledge
repository in another checkout obtains the same cross-process writer lease used
by DSK-018; a live competing writer fails closed.

The renderer receives no source root or arbitrary filesystem method. It shows
current guidance separately from proposed/rejected/deprecated/superseded history,
keeps diagnostics and staleness visible, and never copies a private transcript
into a shared draft automatically. Supersession requires an approved replacement
with a directional back-reference.

## Workspace/Mission Control projection

UX-001 adds a presentation-only workspace overview built from the registered
Core capabilities and their current runtime evidence. It summarizes workspace
access, sessions, Git changes, Doctor/auth/setup Health, governed knowledge, and
runtime capability availability. Review and lineage state begin as `not-run`;
the projection cannot manufacture a successful run or infer completeness.

The same component is available in Web, but only the Desktop bridge causes it to
open after the first session has been replayed. That keeps `coop web` behavior
stable while making the packaged client workspace-first. Entry actions route to
existing panels or prepare plain-language governed requests; no domain behavior,
slash-command catalog, filesystem authority, or new state owner lives in the
Mission Control renderer.

## Theme presentation contract

UX-002 defines exactly three visual modes—Modern Dark, Modern Light, and Retro
Messenger—over one semantic token and component architecture. The theme ID is a
bounded user preference. Desktop persists it through a named, sender-validated
IPC operation in Desktop-owned state; Web uses its local browser preference.
Neither path writes project configuration or changes runtime capabilities.

Switching replaces only the root `data-theme` value and takes effect without a
reload. The Retro variant uses original Coop CSS treatments rather than third-
party logos or assets. Automated checks cover theme allowlisting, state
normalization, capability-invariance, semantic token coverage, WCAG AA core
contrast, reduced motion, forced colors, and the absence of theme-gated actions.

## Clipboard and attachment contract

UX-003 keeps clipboard and file handling in the shared sandbox-compatible SPA.
The renderer can read only files that a user explicitly selects, drops, or pastes;
it receives no path-based filesystem capability. Images continue through Pi's
bounded structured image contract. Supported text files are screened for likely
secret names, type, per-file size, count, aggregate size, and binary NUL bytes.

Text attachments use a versioned, length-delimited prompt suffix. Replayed user
turns are decoded only when the suffix is character-consistent with the generated
structure; malformed data stays visible as ordinary message text. Content is
consumed by its declared length, so embedded tag-shaped content cannot inject
filenames or hide part of a user prompt.

Explicit copy buttons call one plain-text writer. Code copies only source, tables
copy deterministic quoted TSV, and response copy excludes UI labels and rich
clipboard formats. Button-copy line endings are normalized for the target OS;
native selected-text copy remains untouched. The checked-in Windows
interoperability matrix distinguishes automated contract evidence from required
manual application evidence and fails the production gate until every required
row has passing evidence.

## Session lifecycle presentation contract

DSK-013 exposes session export, auto-compaction, auto-retry, and retry abort by
their supported Pi RPC commands. Retry lifecycle events remain part of the
validated protocol and are visible to both Web and Desktop. Because Pi 0.84.3
does not report the current auto-retry setting in `get_state`, the UI labels its
local choice honestly instead of presenting it as authoritative runtime state.

Web export uses Pi's safe default artifact path. Desktop export adds a native
destination chooser without widening renderer authority: the renderer supplies
only a session ID, the main process requests the runtime-owned export, validates
that the returned source is a bounded regular non-symlink HTML file, and copies
it to the user-selected HTML destination. No generic IPC method or arbitrary
renderer-provided source path is accepted.

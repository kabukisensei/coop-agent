# coop web (experimental)

A friendly **browser window** in front of the *same governed coop* the terminal
runs. Start it with:

```bash
coop web            # opens a chromeless "app" window (Ctrl+C to stop)
coop web --port 7500
```

See [`../docs/coop-web-plan.md`](../docs/coop-web-plan.md) for the full plan and
decision history.

## Supported local runtime

Web and future Desktop clients share a supported launcher rather than importing
this server by repository-relative path:

```bash
coop runtime --transport http --json --cwd /path/to/workspace
```

The process prints one readiness object after the governed Pi child and loopback
listener have started:

```json
{"type":"runtime.ready","contractVersion":1,"transport":"http","endpoint":"http://127.0.0.1:7420","oneTimeToken":"...","runtimePid":12345,"coopVersion":"0.23.1","piVersion":"0.84.3"}
```

Startup and argument failures use the corresponding `runtime.error` envelope.
Only the `http` transport is currently supported. The listener is always bound
to `127.0.0.1`; the one-time token is exchanged for the same HttpOnly session
cookie used by `coop web`. `coop web` and `coop runtime` pass through one shared
preflight/launch function, consume `coop launch-spec --json`, and rely on this
server to append the mandatory `--mode rpc -a`. Neither client reconstructs the
Pi resource arguments.

The shared [`runtime-client.mjs`](runtime-client.mjs) exposes named methods for
the supported Pi 0.84.3 command families. The HTTP `/rpc` adapter validates every
request against [`protocol.mjs`](protocol.mjs), then
[`rpc-adapter.mjs`](rpc-adapter.mjs) constructs its command field-by-field. It
supports model/thinking discovery and cycling, steering/follow-up queues,
automatic compaction/retry controls, session export/switch/fork/clone/tree reads,
and command discovery. Raw Pi responses remain on each normalized client result.
Arbitrary Pi bash commands are intentionally not exposed by this adapter.

Desktop/Core clients can consume the versioned Coop domain stream without
depending on raw Pi event shapes. `GET /runtime-events?sid=...&since=...` is the
live SSE transport; each frame uses the domain sequence as its SSE `id`.
`GET /runtime-events-poll?sid=...&since=...` provides the same bounded replay for
reconnect and restrictive local environments. Events carry stable IDs,
monotonic sequence numbers, snapshot revisions, correlation IDs where
applicable, and a pointer to the originating raw event shape. If the replay
window was evicted, `resetRequired` tells the client to reconcile from current
runtime state rather than silently skipping history.

Deterministic tool completions include a versioned execution envelope that
keeps process success separate from evidence completeness. A successful review
can therefore be `completed` while its evidence is `partial`; clients must not
render that state as a clean pass. Results, diagnostics, coverage, findings, and
artifact references are structured. The complete original result remains
available through authenticated `GET /runtime-artifact` using an opaque,
chat-scoped ID; the route never accepts or resolves a filesystem path. The
capability response advertises both domain-contract versions.

Companion tools are registered through the declarative service-extension
contract in [`service-extensions.mjs`](service-extensions.mjs). The registry
maps governed Pi tools to capability IDs, envelope output, least permissions,
and Doctor checks; it does not move SQL, DAX, BPA, or lineage logic into this
server. The matching browser-side registry accepts only built-in renderer and
action IDs. It cannot register code, commands, paths, or IPC, and every unknown
capability retains the generic raw structured-result fallback. See
[`../docs/desktop-extension-contracts.md`](../docs/desktop-extension-contracts.md).

Workflow extensions use a separate declarative registry in
`config/workflows.json`. Authenticated clients list it with `GET /workflows`,
start a chat-scoped run with `POST /workflow/start`, recover the unchanged
checkpoint with `GET /workflow/run`, and apply only fixed state-machine actions
through `POST /workflow/transition`. The runtime owns monotonic revisions,
evidence rollup, artifacts, diagnostics, and named approval grants. A
write-capable stage fails closed until its exact operation has an affirmative
approval in that run. `coop-workflow.review-changes` is the first representative
workflow and delegates all Git, SQL, DAX, BPA, and agent work to registered Coop
capabilities.

Guided impact analysis likewise preserves its existing skill owner. The Impact
entry point collects target/change/scope and explicit read-only evidence choices,
then prompts `power-bi-impact-analysis` under `coop-workflow`. The skill publishes
its bounded `impact-analysis.v1` artifact through the advisory
`impact_analysis_result` tool. Runtime normalization rejects unknown evidence
references, prevents a complete claim over partial sources or unresolved gaps,
and retains the original tool result. The shared Web/Desktop view renders
upstream/downstream paths, consumers, RLS/refresh implications, gaps, risk,
alternatives, plan, and still-pending implementation approval without scraping
the narrative response.

Parallel sessions also share Coop Core's checkout lease. The first writable
session owns the canonical checkout even when opened from a repository
subdirectory. A second writer is not started until the user chooses an isolated
managed Git worktree, read-only attachment, or an explicit concurrent-write
override. Read-only is enforced inside Pi's guardrail extension. Worktree create
and cleanup use fixed Git operations and Coop-owned paths; cleanup is never
forced and a dirty worktree is preserved. `GET /workspace/access`, the
`/chat-new` access choice, and `POST /worktree/remove` expose the typed contract
without accepting arbitrary commands or filesystem targets.

## Shared Doctor service

`coop doctor` and its existing `--json`/`--publish` formats remain compatible.
The cross-client health API is available through:

```bash
coop doctor --service-json
```

Desktop/runtime clients call authenticated `GET /doctor` for the same report.
The versioned contract in `config/doctor-report.schema.json` assigns stable check
IDs and separates `healthy`, `warning`, `error`, `unavailable`, and `skipped`.
Each check includes display-safe evidence, a recommended action, and explicit
repair metadata. The read-only health request never performs repairs; every
currently registered mutating repair is marked approval-required. A completed
check emits `doctor.changed` on the Coop domain stream so clients can reconcile
their Health view.

## Shared authentication state

`coop auth --json` and authenticated `GET /auth/providers` expose the same
versioned provider report. `CoopRuntimeClient.getAuthProviders()` is the typed
Desktop adapter, and completed reads emit `auth.changed` on the domain stream.
The report keeps three trust contexts separate: model access, the active client
Microsoft/Azure identity, and future Cooptimize shared-knowledge identity.

Model state is determined only from credential-file metadata; credential bytes
are never read. Microsoft state comes from the exact read-only Azure CLI
`account show` operation and retains only the account label, tenant ID, and
account type—never subscriptions, tokens, or connection data. Login descriptors
say whether an external browser/device or Pi terminal handoff is required. This
AUTH-001 slice does not perform login/logout; structured login execution remains
DSK-010 and still requires an explicit user action.

## Shared project configuration writes

Authenticated `GET /config/current` reads only the selected chat workspace's
fixed `.coop/project.yml` path. The runtime exposes a two-step project-contract
write service: authenticated
`POST /config/proposal` validates and previews the exact before/after content,
then `POST /config/apply` requires the opaque proposal ID plus explicit approval.
Proposals are bounded, in-memory, and scoped to one chat's fixed workspace. The
service rejects invalid or oversized YAML, detects concurrent edits by digest,
creates `.backups/project.yml.YYYYMMDD_HHMMSS.bak`, flushes the backup and new
file, and uses a same-directory atomic rename. A failed or stale apply never
overwrites the current contract. Successful writes emit `config.changed`.

This service does not generate its own reduced questionnaire. Candidate content
must come from the existing `/setup-project` owner, another authoritative setup
protocol, or an explicit advanced-user edit; Desktop only presents the proposal
and approval flow.

## Shared user profile

Authenticated `GET /profile` and the typed runtime client expose the current
private user profile plus the questionnaire contract owned by
`scripts/onboard.py`. The Health view builds its form from the owner-reported
preset choices and field limits; it does not maintain a second questionnaire or
validation implementation. `POST /profile/apply` allowlists the profile fields,
requires explicit approval, invokes that same owner, and emits a non-sensitive
`config.changed` event after its atomic write. The profile remains user state
under `~/.coop`; it is never project or team knowledge.

Persisted Pi sessions now have a shared cross-client writer lease under the
isolated Coop agent directory. Terminal, Web, and Runtime Pi processes acquire
the same atomic lease, renew it with a heartbeat, release it through Pi's normal
session lifecycle, and fail closed on conflicting or malformed ownership. A
stale lease is recovered only after its heartbeat expires **and** its recorded
process is verified absent; PID, process-start identity, interface, nonce, and
timestamps remain available for diagnostics.

Desktop clients prepare terminal transitions through the authenticated
`POST /terminal-handoff` runtime route. `open` returns a fixed `coop` launch in
the workspace. `clone` uses Pi's public clone/switch RPC operations and restores
Desktop to its original session before returning `coop --session <clone>`.
`move` invokes an authenticated bundled extension command so Pi performs
graceful session shutdown and lease release before the runtime returns
`coop --session <original>`. The response is a typed launch request—not a shell
string—and the renderer cannot select an executable or arguments. The secure
Desktop shell remains responsible for opening the OS terminal application.

Prompt, steer, and follow-up calls accept up to five PNG/JPEG/GIF/WebP image
objects using Pi's `{type, mimeType, data}` contract. Each decoded image is capped
at 4 MiB and all images at 8 MiB. Data URLs and unknown fields are not forwarded.
The SPA reads those exact limits from `/capabilities` and provides picker,
clipboard-screenshot, and drag/drop input with previews and explicit removal.
Only image clipboard items are intercepted, so SQL, DAX, YAML, JSON, and ordinary
text paste preserve their whitespace and normal browser behavior.

Supported text files can be selected or dragged into the same composer. The
client blocks likely credential/key filenames, binary content, more than five
files, files over 256 KiB, and totals over 768 KiB before sending. Accepted
content is appended to the user's prompt in a versioned, length-delimited
evidence wrapper; replay parses by declared character counts so tag-like text in
SQL or documentation cannot forge attachment metadata. The runtime's existing
message-size boundary remains authoritative, and a failed send restores both
the original composer text and every attachment.

Assistant code blocks and file previews expose an explicit plain-text copy that
contains source only—no Markdown fence, line-number gutter, or button label.
Tables copy as quoted TSV. Message copy writes the original response text as
`text/plain`, and Windows button-copy output uses CRLF line endings. Native
browser selection/copy is not intercepted, so selected text remains exactly the
user's selection. `config/clipboard-interoperability.json` is the release
evidence matrix for SSMS, VS Code, Power BI-related editors, Teams, browsers,
and Azure DevOps; its Windows rows remain pending until exercised on a managed
VM and block the Windows release gate when enabled.

The Commands palette is populated from Pi `get_commands`, retaining command
source/path metadata, plus Desktop-native actions exposed by the narrow preload
bridge. It never maintains a duplicate Pi command catalog. Model and thinking
cycle controls call their real RPC commands; thinking choices are runtime-reported.
While Pi is busy, the composer presents separate **Steer now** and **Send next**
actions, displays their queue transitions independently, and exposes Pi's
`all`/`one-at-a-time` processing modes.

## Governed knowledge

The Knowledge Hub consumes the same Coop Core contracts in Web and Desktop. Its
source of truth is approved Markdown/YAML in configured Git repositories; the
local index is deterministic and disposable. Private Pi memory is a different
trust boundary and is never listed, indexed, or copied into a proposal.

Preview configuration accepts `COOP_PROJECT_KNOWLEDGE_ROOT` together with
`COOP_PROJECT_KNOWLEDGE_ID`, and/or `COOP_TEAM_KNOWLEDGE_ROOT`. These are trusted
runtime configuration, not renderer inputs, and are an interim bridge until the
shared progressive setup owner exposes repository selection. The client receives
only opaque source IDs and relative record paths.

`GET /knowledge/catalog` and `GET /knowledge/search` are read-only. Mutation is
two-step: `POST /knowledge/preview` returns exact before/after source text and a
chat-scoped opaque proposal; `POST /knowledge/apply` requires a separate explicit
approval, rejects stale bytes, preserves an update backup outside the repository,
and leaves an uncommitted Git change. It never commits or publishes. Read-only
workspace attachments cannot apply knowledge changes, and a separately located
knowledge repository must acquire the shared DSK-018 writer lease.

## Mission Control

The shared SPA includes a workspace-first Mission Control projection over the
existing `/capabilities`, `/doctor`, `/auth/providers`, `/setup/state`,
`/workspace/access`, `/git/changes`, and `/knowledge/catalog` contracts plus the
client's current session list. It performs no domain work and owns no second
state store. Missing contracts and partial knowledge remain visible; SQL/DAX/BPA
review and lineage are labelled `not run` until authoritative evidence exists.

Coop Desktop opens Mission Control after the initial session replay. `coop web`
retains its existing chat-first startup and exposes Mission Control as an
optional toolbar action. Its workflow entry points use the existing governed
agent, review, impact, file, diff, knowledge, and Health surfaces rather than a
duplicate command or capability catalog.

## Themes

Modern Dark, Modern Light, and Retro Messenger share one DOM, component tree,
accessibility model, and capability set. `theme-system.js` allowlists the three
identifiers and changes only the document's semantic theme attribute. CSS maps
semantic surface, text, accent, typography, radius, and elevation roles to each
visual mode; no theme selector hides an action or changes workflow behavior.

Changes apply without a reload. Web keeps the bounded preference in browser
storage. Desktop reads and writes the same theme ID through one schema-validated
IPC method into Desktop-owned user state, never project configuration. Core text
and accent combinations have automated WCAG AA contrast checks, with explicit
reduced-motion and forced-colors behavior.

## The app window

`coop web` opens as a **native-feeling app window**, not a browser tab: it
launches the first Chromium-family browser it finds (Edge → Chrome → Brave →
Vivaldi/Chromium, on Windows, macOS, and Linux) in `--app` mode with a
**dedicated coop profile**. That single launch choice — no Electron, no bundle,
no build step, no dependency, just *how* the browser is invoked — gives the
whole native finish: a chromeless window, its own taskbar/dock entry, the coop
icon (from the served favicon), and complete isolation from your real browser
session and extensions. On Windows the double-click **coop** shortcut (`coop
install` creates it on the Start Menu + Desktop) launches straight into this
window.

Escape hatches (env vars): `COOP_WEB_NO_APP=1` opens the UI as an ordinary
browser tab instead of an app window; `COOP_WEB_NO_OPEN=1` starts the server but
opens nothing (paste the printed URL yourself). If no Chromium browser is found,
coop web falls back to a normal tab automatically.

## Which folder does it work in?

The agent works in a **working folder** (where it reads/writes files, finds
`coop-data-doc.yml`, etc.), shown in the **chat header** — **click it to switch
folders** (paste a path from the File Explorer address bar; the bridge restarts
the governed agent in that folder with a fresh conversation, so tools, lineage
docs, and the header all agree). Starting folder:

- `coop web` in a terminal → the folder you ran it from (`cd` there first).
- `coop web --cwd C:\path\to\repo` → an explicit folder.
- The desktop **coop** icon → your home folder by default (change the default via
  the shortcut's Properties → **Start in**).

> Note: asking the agent to `cd` in chat only moves its *shell* — coop's native
> tools (`sql_review`, `data_doc` lineage, …) keep operating in the working
> folder. Use the header folder button to actually move coop.

## How it works

```
Browser (Chromium --app)  ⇄  web/server.mjs  ⇄  pi --mode rpc -a  (the real coop)
  SPA: chat, cards           HTTP + SSE          governed via `coop launch-spec`
```

- `coop web` resolves **`coop launch-spec --json`** (the single shared launch spec)
  and hands it to `web/server.mjs`, which spawns `pi --mode rpc -a` with the exact
  same guardrails, skills, prompts, theme, extensions, and isolation env as the
  terminal — it can never drift.
- The bridge relays Pi's JSONL events to the browser over **Server-Sent Events**
  and forwards prompts + dialog answers back to Pi's stdin. Node built-ins only
  (no npm deps).
- Because `ctx.hasUI` is true in RPC mode, the on-demand **Start Here menu** and
  **guardrail confirmations** arrive as `extension_ui_request` dialogs and render
  as clickable cards — the governance you get in the terminal, with buttons.

## What the UI renders

- **Streaming chat** with markdown-lite (headings, bullet + ordered lists,
  blockquotes, GFM tables, horizontal rules, bold, italic, inline code, fenced
  code blocks, safe links). Escape-first: model output is never treated as HTML.
- **Thinking blocks** — the model's reasoning stream renders in a collapsible
  ✦ thinking lane (open while it thinks, folded once the visible answer starts),
  the same stream the TUI shows.
- **Dialog cards** for select / confirm / input / editor requests (Start Here
  menu, guardrail approvals, /setup-docs wizard), plus toast notifications
  (multi-line `notify` messages keep their line breaks).
- **Extension dock** — a slim lane above the composer where extension **status
  segments** (`setStatus`) and **widgets** (`setWidget`) render, keyed and
  order-reconstructed from replay (ANSI escape codes are stripped to plain text).
  `setTitle` updates the browser tab title, `set_editor_text` prefills the composer
  (live-only — never replayed over a draft), and any **unknown** extension-UI method
  renders a deduplicated fallback card showing the raw request with a Dismiss button
  — so nothing an extension sends is ever silently dropped. Dock state clears on new
  chat / folder switch and is bounded by the ~4000-event replay ring (a status
  segment older than the ring is lost on reconnect).
- **Structured findings workbench** for `sql_review`, `dax_review`, and
  `bpa_review` results — deterministic findings stay separate from agent-review
  prompts; evidence completeness is shown before verdict; filters cover
  severity, rule, file, object, and changed files; grouping covers severity,
  file, and rule; and in-session baselines show new, persisting, and fixed
  fingerprints. Source context loads only through the jailed file API. The
  complete original structured result remains available through the opaque raw
  artifact fallback, so schema drift degrades visibly rather than disappearing.
- **Focused Data Doc lineage workbench** for `data_doc` lineage results — three
  explicit upstream/selected/downstream lanes, searchable node identity and
  source metadata, trust markers, semantic relationships, diagnostics, and an
  evidence-path list built only from Data Doc's returned flow-normalized edges.
  Ambiguous names remain candidate choices rather than guesses. Older Data Doc
  responses without the v1 evidence fields render as partial and retain the raw
  result instead of being mistaken for proof that no dependency exists.
- **Expandable tool activity** — each tool call is a chip (⚙ running → ✓/✗ done)
  with a one-line hint (e.g. the bash command or file); click to reveal the full
  arguments and the tool's output, which streams live via `tool_execution_update`
  and settles to the final (truncated) result. A **Stop** button shows while the
  agent is streaming.
- **Per-response stats** under each assistant turn (output tokens, throughput,
  cache reads, model) from the `message_end` usage — timing is live-only, so
  replays don't invent tok/s.
- **A live status line** in the header: what coop is doing right now and for how
  long (`running sql_review… 34s`, `compacting…`), plus a **context gauge**
  (percent of the model's window in use, warming to gold/red as it fills) fed by
  `get_session_stats` after each turn and after compaction.
- **Files panel** (📁 Files) — a **read-only** browser for the working folder,
  beside the chat: a file tree, a markdown preview (rendered like chat markdown),
  line-numbered code, and a **sortable table** for `.csv` / `.tsv` / `.json`
  (array-of-objects) / `.jsonl`. Selecting a file (with **tell coop** enabled)
  quietly prepends a "you're viewing this file" note to your next prompt so
  "this file" / "here" resolve, and the chat shows a 📎 chip instead of the note.
  The bridge jails every read to the working folder (lexical **and** realpath
  checks — a `../` or an escaping symlink is refused) and never writes.
- **Changes panel** (± Changes) — a **read-only** git diff viewer for the working
  folder, with a live changed-file count on the toolbar chip. A changed-files list
  (add/modify/delete/rename, untracked marked "new") on the left; for the selected
  file, a rendered diff on the right — **unified or side-by-side**, line numbers,
  add/remove coloring, cheap intraline emphasis, and in-file search. Diffs come
  from the system `git` (working tree vs `HEAD`, or vs a **base ref** you type,
  e.g. `origin/main`); the badge refreshes after each agent turn so tool edits show
  up immediately. Caps: 500 files, 1 MB per diff, 4000 rendered rows (with a "show
  more"). In a non-git folder — or on a machine without git — it degrades to a
  clear one-line explanation instead of erroring. Like the Files panel it is a
  bridge-local read jailed to the working folder; it never writes.
- **Reconnect / tab-switch replay**: the bridge keeps a bounded history per chat
  (last ~4000 events each) and serves it via `/events-poll?sid` — a page refresh,
  dropped connection, or switching to another tab rebuilds that chat's transcript.
  The live `/events` stream carries only new frames (one multiplexed SSE connection
  for every tab, `{sid,n,ev}` envelopes; the `n` cursor dedupes a live frame against
  the replay so a switch never doubles an event). Already-answered dialog cards and
  transient toasts are not replayed. User bubbles render only from the event stream
  (single source of truth), so replays never duplicate.
- **Protocol-drift warning**: the bridge validates every pi event against a
  checked-in contract ([`protocol.mjs`](protocol.mjs)). If a Pi upgrade sends an
  event coop-web doesn't recognize (or one whose shape changed), the bridge logs
  it to the console and shows a one-time **warning toast** — chat keeps working
  (the event is still forwarded verbatim), but you get an actionable heads-up
  instead of silent blank bubbles. See *Protocol contract* below.
- **Runtime capability negotiation**: authenticated clients read
  `GET /capabilities` for the versioned Coop/Pi/tool versions, the current
  bridge RPC allowlist, platform features, conservative integration health,
  capability descriptors, and CLI/Web/Desktop implementation states. The
  response resolves Windows/macOS limitations server-side so renderers never
  infer feature availability from browser or operating-system strings.
- **Discovery-driven setup contracts**: `coop discover repositories` performs a
  bounded local Git-root scan, while `coop discover workspaces`, `items`, and
  `semantic-models` use fixed read-only Azure CLI calls to the allowlisted
  Microsoft Fabric [workspace](https://learn.microsoft.com/rest/api/fabric/core/workspaces/list-workspaces)
  and [item](https://learn.microsoft.com/rest/api/fabric/core/items/list-items)
  endpoints. The authenticated `POST /discovery` adapter exposes the same
  versioned result to Web/Desktop. Workspace IDs and item types are validated
  before process execution; pagination rebuilds URLs from opaque continuation
  tokens instead of trusting server-provided continuation URLs; ambiguous human
  names remain candidates until the user supplies workspace context. Discovery
  never runs merely because the app opened.
- **Progressive project setup**: `coop setup-state --json` and authenticated
  `GET /setup/state?sid=...&capabilityId=...` distinguish configured,
  not-configured, broken, and platform-unavailable sections. Skipping Fabric,
  Data Doc, or Tabular Editor does not make local Coop unhealthy. When a later
  capability needs a skipped section, the report returns one stable setup
  operation with CLI and Desktop entry points. Project writes remain a separate
  exact-preview/approval operation; the in-agent `/setup-project` wizard and
  runtime API both use the same digest-checked, recoverable atomic write service.
- **Workflow extensions**: `GET /workflows`, `POST /workflow/start`,
  `GET /workflow/run`, and `POST /workflow/transition` expose versioned,
  reconnectable runtime-owned workflow checkpoints. The first Review changes
  definition composes existing capabilities and requires an explicit named grant
  before any optional workspace-write stage can start.
- **Header toolbar** — **＋ New chat** (fresh session; the transcript resets),
  **🕘 History** (resume a previous conversation — grouped by **every workspace
  coop has been used in**: the current folder first, other folders as collapsible
  groups you can resume from in one click, which switches the working folder *and*
  resumes together; folders that no longer exist are shown disabled. Named sessions
  show their name, unnamed ones the first message. Resuming rebuilds the transcript
  **from the session file itself** — thinking blocks, tool calls with their
  arguments and outputs, and compaction markers, in original order (a one-line
  notice appears if the conversation has other branches; the most recent is shown).
  A **✎ Name current chat** action sets the session name via `set_session_name` so
  it's easy to find later), a
  **model picker** (type-to-filter across every configured model), a
  **🧠 thinking-level** chip (click to cycle off → minimal → low → medium → high),
  **⑂ Session tree** (Pi's complete current tree with the active leaf marked,
  existing-branch **Switch** and **Summarize + switch**, supported fork actions
  on eligible user messages, and Clone current branch; successful mutations
  reset/backfill the selected transcript while cancellation preserves it),
  **♻ Compact** (frees context; reports before/after tokens), and **📁 Files**
  (toggles the file browser). These drive pi's own RPC commands through a
  whitelisted `/rpc` relay.

  Pi 0.84.3 does not include existing-branch checkout in its RPC command union,
  even though it publicly exposes `navigateTree()` to extension command contexts.
  `POST /tree-navigate` therefore uses an authenticated, narrowly scoped bundled
  extension adapter. The adapter invokes that public API, preserves Pi's normal
  `session_before_tree` / `session_tree` summary and cancellation behavior, and
  returns a correlated structured result. The runtime suppresses the internal
  correlation status event, then resets and rehydrates replay through Pi's public
  `get_messages` RPC, preserving reasoning, tool arguments, outputs and failure
  status. This navigation path does not read or edit session JSONL; the file-based
  History resume path is described below.
- **Working-folder switcher** — clicking the folder chip lists the folders you've
  used coop in before (derived from pi's session store — the authoritative `cwd`
  from each session header, existence-checked) for one-click switching, and still
  accepts a pasted path. Switching restarts the governed agent in that folder.
- **Usage meter** — when an OpenAI/Codex model is active, the header shows the
  `pi-better-openai` subscription snapshot (percent **remaining**) with the
  provider-reported window durations. Shared extension status updates drive the
  meter and session replay; Desktop submits no background usage prompts. Missing
  values clear their bars. Hover for reset times. `coop sync` and managed staging
  apply the exact-source correction described in `../desktop/README.md`.
- **Slash commands typed in the chat box**: extension commands (`/start`,
  `/setup-docs`, `/openai-usage`) execute immediately; prompt templates
  (`/discovery`, `/impact-analysis`, …) and `/skill:<name>` expand before
  sending. Pi's built-in TUI commands (`/model`, `/new`, `/compact`) are covered
  by the toolbar instead.
- **Polling fallback**: if the SSE stream never opens (some corporate
  proxies/endpoint protection buffer or block streaming responses, even on
  loopback), the page automatically falls back to polling `/events-poll` every
  1.5s — plain finite GETs that work anywhere the page itself loads. A 15s SSE
  heartbeat also keeps healthy streams from being idled out. The server console
  logs every request (`GET /events -> 200`, …) so a stuck client is diagnosable
  at a glance; a stale window (cookie from a previous run) gets an explicit
  "session expired" message.

## Security model (localhost, single user — layered)

- Binds **127.0.0.1 only**; the `Host` header must be `localhost`/`127.0.0.1`
  (DNS-rebinding guard).
- A **per-run random token** (query → `HttpOnly` `SameSite=Strict` cookie) gates
  every route; compared timing-safe; valid until the `coop web` process exits. The
  launch URL (token included) lands in browser history and is visible in the
  local process list — fine on your own machine, one more reason this is not for
  shared hosts. No `Secure` flag because this is plain HTTP on loopback, which
  never leaves the machine.
- **Strict CSP** (`default-src 'none'`; no inline script or style — the SPA is
  served as separate files), `nosniff`, `no-referrer`. CORS is never enabled.
- POSTs additionally require the **`X-Coop-CSRF: 1`** custom header —
  cross-origin pages can't set custom headers without a CORS preflight, which is
  never granted.
- The RPC child is spawned with **`-a`** so coop's project trust — and therefore
  its guardrails and skills — load exactly as in the terminal.
- The **Changes panel** deliberately diverges from the Files panel's hidden-file
  rule: a *tracked* dotfile (e.g. `.github/workflows/ci.yml`) IS diffable, so a
  tracked, modified `.env`'s diff would be viewable — but only ever when git itself
  reports it changed, and `FILES_IGNORE` segments (`.git/`, `node_modules/`, …) are
  refused everywhere. Untracked files (incl. an untracked `.env`) still render
  through `/file`, which refuses them exactly as before.

**Not** for remote or multi-user use. Exposing this port beyond loopback would
put a bash-capable agent on the network.

## Protocol contract (when Pi is upgraded)

coop-web speaks Pi's RPC protocol, so a Pi upgrade that renames a field or adds
an event can silently break rendering. The wire contract coop-web depends on —
the commands the bridge sends, the events it consumes, the ones it deliberately
ignores, and the response-data fields the UI reads — is pinned in
[`protocol.mjs`](protocol.mjs), and a bridge-side **drift detector** validates
every pi event against it (logging to the console and showing a one-time toast on
a mismatch). When you bump Pi:

1. Read the Pi release notes / RPC changes for the new version.
2. Diff `protocol.mjs` (`COMMANDS_SENT`, `EVENTS_CONSUMED`, `EVENTS_KNOWN_IGNORED`,
   `RESPONSE_DATA`) against Pi's RPC docs **and** the installed package's type
   unions (e.g. `AssistantMessageEvent` in `pi-ai` / `pi-agent-core`
   `dist/types.d.ts`) — every contract entry must exist in the real protocol; no
   aspirational entries. (pi-vis's `src/shared/pi-protocol/` Zod schemas are a
   useful second reference — *read* them, never copy.)
3. Update the source-derived `tests/fixtures/pi-rpc-<version>.json` inventory,
   capture a read-only isolated `pi --mode rpc --no-session` smoke transcript,
   update the contract and `tests/stub-pi.mjs`, then run `bash tests/run.sh`.
   The protocol test must prove the fixture, transcript,
   `PI_PROTOCOL_VERSION`, and release manifest agree.
4. Launch `coop web` against the new Pi, exercise chat / **tool calls** / model
   picker / resume / chdir, and watch the console for `protocol drift` lines —
   each one is either a contract update or a renderer fix. (Tool calls matter:
   they exercise the `toolcall_*` assistant-message events that a text-only smoke
   test never emits.)
5. Bump the "Tested against the RPC protocol of Pi <version>" line in *Known
   limitations* below, and the verified-against version noted in the
   `protocol.mjs` header comment.
6. Bump `tested_with.pi` in `config/defaults.yml` to the newly-verified Pi version.
   Until you do, `coop update` will warn teammates and **hold at the old tested
   version** when Pi ships a newer minor (and `coop doctor` flags a machine already
   on it) — that guard is deliberate; this bump is how you release the new floor.

## Known limitations

- Replay history is bounded (~4000 events); very long sessions truncate the
  rebuilt transcript (newest events win).
- **Multiple parallel chats** via the tab strip (default 4, env `COOP_WEB_MAX_CHATS`
  clamped 1–8; set `COOP_WEB_MAX_CHATS=1` to behave like the old single-session
  coop web). Each tab is an independent governed `pi --mode rpc -a` with its own
  transcript, model, working folder, and Files/Changes view; background tabs keep
  streaming (busy pulse; unread dot when a background turn finishes) and one tab's
  agent crashing shows a crash card in that tab only — the others (and the bridge)
  keep running. The SPA renders only the active tab; switching rebuilds that tab's
  transcript from the bridge's per-chat replay (served by `/events-poll?sid`, still
  ~4000 events per chat). Writable checkouts are now cross-process leased; a
  conflicting tab offers managed-worktree, enforced read-only, or explicit
  override modes. Deferred: idle-process eviction and a crashed-chat restart
  button (close the tab / resume from History instead).
- Resuming rebuilds the transcript from the session file with full detail — thinking,
  tool arguments/outputs, and compaction markers. The `get_messages` fallback for
  oversized (>16 MiB) or corrupt files also preserves reasoning and tool evidence.
  Fork, clone and in-process branch switching use that public active-branch RPC.
  Missing tool results display an unknown state, never an inferred success.
  History asks Pi for its selected leaf using `get_entries` after the final known
  file entry, then follows parent links to that exact point. It never picks a
  branch by timestamp. Entries appended during startup are included; missing,
  ambiguous or broken chains fall back to Pi's active-branch messages. Selecting
  the empty root displays no old conversation. Other branches remain in the file.
- Image attachments are not rendered.
- The Files panel is **read-only** and preview-only: a 1 MB text cap, ~2000-entry
  / 6-level tree, and 1000-row × 60-column table clip; binary files show no
  preview. It never writes — the agent does that through its governed tools. Code
  previews are line-numbered but not syntax-highlighted (no-dependency rule).
- Tested against the RPC protocol of Pi 0.84.3. The wire contract coop-web
  depends on is pinned in [`protocol.mjs`](protocol.mjs) and the source-derived
  [`pi-rpc-0.84.3.json`](../tests/fixtures/pi-rpc-0.84.3.json) inventory; a drift
  detector warns when a pi event doesn't match it — see
  *Protocol contract* above when upgrading Pi.

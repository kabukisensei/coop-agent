# coop web (experimental)

A friendly **browser window** in front of the *same governed coop* the terminal
runs. Start it with:

```bash
coop web            # opens a chromeless "app" window (Ctrl+C to stop)
coop web --port 7500
```

See [`../docs/coop-web-plan.md`](../docs/coop-web-plan.md) for the full plan and
decision history.

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
- Because `ctx.hasUI` is true in RPC mode, coop's **Start Here menu** and
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
- **Human-readable review cards** for `sql_review` / `dax_review` results —
  findings grouped by severity with rule id, message, and `file:line`, with a
  collapsible **Raw JSON** fallback (so a tool schema change degrades gracefully
  instead of breaking).
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
  **♻ Compact** (frees context; reports before/after tokens), and **📁 Files**
  (toggles the file browser). These drive pi's own RPC commands through a
  whitelisted `/rpc` relay.
- **Working-folder switcher** — clicking the folder chip lists the folders you've
  used coop in before (derived from pi's session store — the authoritative `cwd`
  from each session header, existence-checked) for one-click switching, and still
  accepts a pasted path. Switching restarts the governed agent in that folder.
- **Usage meter** — when an OpenAI/Codex model is active, the header shows the
  `pi-better-openai` subscription snapshot (percent **remaining** in the 5-hour
  and 7-day windows) as two mini bars + text, refreshed every 2 minutes via the
  extension's `/openai-usage` command. Hover for reset times. (The extension's
  TUI footer meter doesn't cross RPC; this is the same data by another path.)
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
3. Update the contract; mirror any command/event changes in `tests/stub-pi.mjs`;
   run `bash tests/run.sh`.
4. Launch `coop web` against the new Pi, exercise chat / **tool calls** / model
   picker / resume / chdir, and watch the console for `protocol drift` lines —
   each one is either a contract update or a renderer fix. (Tool calls matter:
   they exercise the `toolcall_*` assistant-message events that a text-only smoke
   test never emits.)
5. Bump the "Tested against the RPC protocol of Pi 0.80.x" line in *Known
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
  ~4000 events per chat). Deferred: worktree isolation, idle-process eviction, and a
  crashed-chat restart button (close the tab / resume from History instead).
- Resuming rebuilds the transcript from the session file with full detail — thinking,
  tool arguments/outputs, and compaction markers; a text-only `get_messages` backfill
  remains the fallback for oversized (>16 MiB) or corrupt files. The active branch is
  picked by most-recent timestamp, so after a fork the shown branch may differ from
  Pi's (an honest "has other branches" notice appears).
- Image attachments are not rendered.
- The Files panel is **read-only** and preview-only: a 1 MB text cap, ~2000-entry
  / 6-level tree, and 1000-row × 60-column table clip; binary files show no
  preview. It never writes — the agent does that through its governed tools. Code
  previews are line-numbered but not syntax-highlighted (no-dependency rule).
- Tested against the RPC protocol of Pi 0.80.x. The wire contract coop-web
  depends on is pinned in [`protocol.mjs`](protocol.mjs) (verified against Pi
  0.80.2); a drift detector warns when a pi event doesn't match it — see
  *Protocol contract* above when upgrading Pi.

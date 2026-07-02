# coop web (experimental)

A friendly **browser window** in front of the *same governed coop* the terminal
runs. Start it with:

```bash
coop web            # opens a local page (Edge app-mode on Windows) — Ctrl+C to stop
coop web --port 7500
```

See [`../docs/coop-web-plan.md`](../docs/coop-web-plan.md) for the full plan and
decision history.

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
Browser (Edge app-mode)  ⇄  web/server.mjs  ⇄  pi --mode rpc -a  (the real coop)
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
  menu, guardrail approvals, /setup-docs wizard), plus toast notifications.
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
- **Reconnect replay**: the bridge keeps a bounded history (last ~4000 events)
  and replays it on connect — a page refresh or dropped connection rebuilds the
  transcript. Already-answered dialog cards and transient toasts are not
  replayed. User bubbles render only from the event stream (single source of
  truth), so replays never duplicate.
- **Header toolbar** — **＋ New chat** (fresh session; the transcript resets),
  **🕘 History** (resume a previous conversation in this folder — named sessions
  show their name, unnamed ones the first message; the prior transcript is
  backfilled so you continue where you left off; a **✎ Name current chat** action
  sets the session name via `set_session_name` so it's easy to find later), a
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

**Not** for remote or multi-user use. Exposing this port beyond loopback would
put a bash-capable agent on the network.

## Known limitations

- Replay history is bounded (~4000 events); very long sessions truncate the
  rebuilt transcript (newest events win).
- One conversation at a time (switch via ＋ New chat / 🕘 History). Backfilled
  transcripts show text and tool names; original thinking/streaming detail and
  tool output aren't reconstructed (they render live, then the settled text
  stands in on replay).
- Image attachments are not rendered.
- The Files panel is **read-only** and preview-only: a 1 MB text cap, ~2000-entry
  / 6-level tree, and 1000-row × 60-column table clip; binary files show no
  preview. It never writes — the agent does that through its governed tools. Code
  previews are line-numbered but not syntax-highlighted (no-dependency rule).
- Tested against the RPC protocol of Pi 0.80.x.

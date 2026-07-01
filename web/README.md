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

- **Streaming chat** with markdown-lite (headings, lists, bold, inline code,
  fenced code blocks, safe links). Escape-first: model output is never treated
  as HTML.
- **Dialog cards** for select / confirm / input / editor requests (Start Here
  menu, guardrail approvals, /setup-docs wizard), plus toast notifications.
- **Human-readable review cards** for `sql_review` / `dax_review` results —
  findings grouped by severity with rule id, message, and `file:line`, with a
  collapsible **Raw JSON** fallback (so a tool schema change degrades gracefully
  instead of breaking).
- **Tool activity chips** (⚙ running → ✓/✗ done) and a **Stop** button while the
  agent is streaming.
- **Reconnect replay**: the bridge keeps a bounded history (last ~4000 events)
  and replays it on connect — a page refresh or dropped connection rebuilds the
  transcript. Already-answered dialog cards and transient toasts are not
  replayed. User bubbles render only from the event stream (single source of
  truth), so replays never duplicate.
- **Header toolbar** — **＋ New chat** (fresh session; the transcript resets),
  **🕘 History** (resume a previous conversation in this folder — named sessions
  show their name, unnamed ones the first message; the prior transcript is
  backfilled so you continue where you left off), a
  **model picker** (type-to-filter across every configured model), a
  **🧠 thinking-level** chip (click to cycle off → minimal → low → medium → high),
  and **♻ Compact** (frees context; reports before/after tokens). These drive
  pi's own RPC commands through a whitelisted `/rpc` relay.
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
  transcripts show text and tool names; original diffs/streaming detail aren't
  reconstructed.
- Thinking blocks and image attachments are not rendered.
- Tested against the RPC protocol of Pi 0.80.x.

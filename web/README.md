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
`coop-data-doc.yml`, etc.), shown in the **chat header**:

- `coop web` in a terminal → the folder you ran it from (`cd` there first).
- `coop web --cwd C:\path\to\repo` → an explicit folder.
- The desktop **coop** icon → your home folder by default. To change it:
  right-click the shortcut → Properties → **Start in** → your project folder.

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
- One session per server process; `/new`, `/resume`, model switching, and session
  naming aren't surfaced in the UI yet.
- Thinking blocks and image attachments are not rendered.
- Tested against the RPC protocol of Pi 0.80.x.

# coop web (experimental)

A friendly **browser window** in front of the *same governed coop* the terminal
runs. Start it with:

```bash
coop web            # opens a local page (Edge app-mode on Windows) — Ctrl+C to stop
coop web --port 7500
```

This is a **phase-2 spike** — proof of the shape, not a finished product. See
[`../docs/coop-web-plan.md`](../docs/coop-web-plan.md) for the full plan.

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

## Security (spike-grade)

- Binds **127.0.0.1 only**; a **one-time token** (query → HttpOnly cookie) gates
  `/events`, `/prompt`, `/ui-response`; Host header must be localhost.
- **Not** for remote/multi-user use. A production build needs CSP/CSRF hardening,
  a human-readable review renderer, and session-history replay on reconnect.

## Known spike limitations

- Reconnecting the browser mid-session does not replay prior messages.
- Assistant text is rendered as plain text (no markdown/diff rendering yet).
- One session per server process.

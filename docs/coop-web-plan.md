# `coop web` — a friendly windowed UI (phase 2 plan)

> Status: **SPIKE BUILT** — `coop web` runs (see [`../web/`](../web/)). It spawns the
> governed `pi --mode rpc -a` via the shared launch spec, serves a localhost SPA
> over SSE, and already renders the Start Here menu + guardrail dialogs as clickable
> cards. What remains before it's a real product is the hardening/renderer work
> flagged below (CSP/CSRF, review renderer, history replay). This doc is the plan;
> `../web/README.md` documents what exists.

## Why

Phase 1 (a double‑click launcher + a guided menu) removes **entry** friction —
opening a terminal, the blank prompt. It does **not** remove **experience**
friction: scrolling diffs, JSON‑ish review dumps, keyboard‑only confirm dialogs.
For members who want something that *feels like the Claude Code desktop app*, we
need an actual rendered UI. `coop web` is the lowest‑cost way to get there.

Pi is explicitly built to be driven by another program, so **we never fork Pi** —
`coop web` drives the *same governed Pi* the terminal launches, over Pi's RPC.

## Shape (highest value per dollar)

```
 Browser (Edge app-mode window)  ⇄  coop web bridge (Node)  ⇄  pi --mode rpc  (the real coop agent)
   static SPA: chat, cards            HTTP + WebSocket             governed: guardrails, skills,
   approve/reject, review view        dumb pipe + static files     isolation, coop-tools — unchanged
```

- **Drives Pi via subprocess RPC** (`pi --mode rpc`), **not** the in‑process SDK.
  Reason: the RPC wire contract is stable, so `coop update` upgrades Pi for free;
  an in‑process SDK import would hard‑pin us to one exact Pi version.
- **The Node bridge imports none of Pi's internals.** It is a dumb pipe + static
  file server: browser ⇄ WebSocket ⇄ RPC stdio. This keeps `coop web` a genuinely
  thin layer and makes it resilient to Pi refactors.
- **Windows "it's an app" finish, for free:** launch the browser in Edge/WebView2
  **app mode** — `msedge --app=http://127.0.0.1:PORT/?token=…` — a chromeless
  window with its own taskbar entry and the coop icon. No Electron, no code
  signing, no auto‑updater. (Optional later: a thin WebView2/Tauri shell.)

## Non‑negotiables (learned from the RPC design)

These are correctness/security gates, not TODOs — a v1 without them is broken:

1. **Pass `-a` / `--approve` when spawning `pi --mode rpc`.** Non‑interactive
   modes skip the project‑trust prompt; without the trust flag Pi silently drops
   coop's guardrails and skills and runs **ungoverned while looking like it
   works.** High‑severity, invisible footgun.
2. **Use a `\n`‑only JSONL framer.** Do **not** use Node `readline` (Pi's own docs
   warn it mis‑splits on `U+2028`/`U+2029` inside JSON strings and corrupts
   messages). Split on `\n`, strip a trailing `\r`.
3. **Bind `127.0.0.1` only** + a **one‑time token → session cookie** (the
   Jupyter model) + **CSP and CSRF/DNS‑rebinding** protection. `coop web` puts a
   listening port in front of a bash‑capable, file‑editing agent; a mis‑bind
   (`0.0.0.0`), a leaked token, or an SPA XSS becomes network‑reachable RCE.
   This is permanent security hygiene, owned by us.

## Prerequisite refactor — ✅ DONE

Previously `bin/coop`'s `launch_pi()` and its `coop.ps1` twin assembled Pi's flags
by hand, separately. That's now extracted into a single builder per language
(`coop_build_pi_args` / `Build-CoopPiArgs`) consumed by both the terminal launch
**and** a new internal **`coop launch-spec [--json]`** subcommand (bash + ps1).

- `coop launch-spec` prints the resolved `pi` invocation; `coop launch-spec --json`
  emits `{"bin":"pi","args":[…],"env":{PI_CODING_AGENT_DIR, COOP_VIBES_DIR,
  COOP_SPLASH_FILE}}`.
- Verified byte‑equivalent across bash and PowerShell (guardrails + 8 skills +
  prompt‑template + theme + 3 extensions + isolation env). A `tests/run.sh` check
  guards the bash builder against drift.

**`coop web` MUST consume `coop launch-spec --json`** (append `--mode rpc -a` to
`args`, apply `env`) so it launches the exact same governed coop the terminal
does — never a third hand‑copied list.

## MVP scope (ship small, safe, governed)

1. `coop web` subcommand (+ `coop.ps1` twin): resolve the shared launch spec,
   spawn `pi --mode rpc -a`, start the local server, open Edge app‑mode with the
   token, print the URL for anyone who prefers their own browser.
2. Static SPA:
   - **Chat** with streaming assistant text (plain language, markdown).
   - **Start‑here cards** mirroring the `/start` menu (send the same first‑person
     prompts).
   - **Approve / reject cards** driven by the agent's UI/permission requests, so
     guardrails are honored with a click instead of a keyboard dialog.
   - **Human‑readable review view** for `sql_review` / `dax_review` JSON (grouped
     by severity, file:line) **with a raw‑JSON fallback** if the tool schema
     changes.
3. Security hardening from day one (item 3 above).

Explicitly **out** of the MVP: multi‑user/hosted, remote access, non‑Windows
packaging. Keep it single‑user, localhost, Windows‑first.

## Effort & risk

- **Spike:** chat + one approve card over RPC — a long weekend.
- **Safe, governed v1:** ~2–4 focused weeks (mostly the security hardening and
  the review renderer).
- **One web bundle** — no per‑OS UI matrix, no signing/notarization/auto‑update.
- **Ongoing cost:** local‑server security hygiene, and keeping the review renderer
  tracking the tool output schema (raw fallback bounds this).
- **The trap to avoid:** shipping chat‑only. If the approve/reject cards and the
  start‑here→task mapping are hidden, `coop web` strands coop's governance and
  skill workflows. Those cards are the point, not decoration.

## Decision checkpoint before building

Confirm the phase‑1 launcher + menu did **not** already remove the friction. Build
`coop web` only if members are still uncomfortable *inside* the session
(diffs/JSON/dialogs). See the friendlier‑UI plan for the crawl/walk/run path.

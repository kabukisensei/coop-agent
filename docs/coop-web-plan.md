# `coop web` — a friendly windowed UI (phase 2 plan)

> Status: **BUILT + HARDENED** — `coop web` runs (see [`../web/`](../web/)). It spawns
> the governed `pi --mode rpc -a` via the shared launch spec, serves a localhost SPA
> over SSE, renders the Start Here menu + guardrail dialogs as clickable cards, and
> now ships the production-hardening pass: strict CSP (no inline script/style),
> CSRF custom-header requirement, timing-safe token auth, DNS-rebinding guard,
> reconnect history replay, markdown-lite rendering, a human-readable
> sql_review/dax_review renderer with raw-JSON fallback, and a stub-pi integration
> test suite (`tests/webbridge.test.mjs`).
>
> A **UX-breadth pass** (borrowing shapes from the Hephaestus pi GUI, adapted to
> the no-dependency / strict-CSP / dumb-pipe constraints) then added: rendered
> thinking blocks, expandable tool activity with live `tool_execution_update`
> output, richer markdown (tables, ordered lists, blockquotes, hr, italics), a
> header context gauge + live status line + per-response stats (`get_session_stats`,
> `message_end` usage), a read-only **Files panel** (`/files` + `/file`, jailed to
> the working folder by lexical *and* realpath checks) with markdown/code/table
> previews and an opt-in "you're viewing this file" prompt attachment, recent-folder
> quick-switching (`/folders`, from session headers), `set_session_name`, and a
> `__fatal` crash card. All bridge additions are covered by the stub-pi suite.
>
> A **protocol-contract pass** then pinned the Pi RPC wire contract coop-web
> depends on in a new dependency-free module (`../web/protocol.mjs`): the commands
> the bridge sends, the events it consumes / knowingly ignores, and the
> response-data fields the UI reads, plus a bridge-side **drift detector** that
> logs to stderr and shows a one-time warning toast when a Pi upgrade sends an
> unknown or shape-changed event (the event is still forwarded verbatim — the dumb
> pipe is preserved). The same pass hardened the JSONL framer with a
> `StringDecoder` (fixing a real multi-byte-UTF-8 chunk-boundary corruption bug)
> and an oversized-line cap, added a `tests/protocol.test.mjs` unit suite, and made
> the stub-pi integration fixtures assert the contract (an end-of-suite drift-count
> assertion fails if a future change adds unexpected drift). See "Protocol contract"
> in `../web/README.md`.
>
> A **pi-vis-inspired capability pass** then added three self-contained features on
> top of that machinery (all bridge-local, no new pi RPC): a read-only **Changes
> panel** — a git diff viewer (unified + side-by-side, base-ref comparison, in-file
> search, badge refresh per turn, git-missing/non-repo degradation), jailed to the
> working folder; **grouped session history** — 🕘 History now spans every workspace
> coop has been used in, with one-click cross-folder resume and a high-fidelity,
> file-based transcript backfill (thinking, tool args/outputs, compaction markers,
> most-recent-branch heuristic) that falls back to `get_messages`; and **broader
> extension-UI bridging** — an extension dock (`setStatus`/`setWidget`), `setTitle`,
> composer prefill, multi-line notify, and a deduped fallback card for any unknown
> method. Each is covered by the stub-pi suite (plus pure-model unit tests for the
> diff parser). See the plan `docs/coop-web-pivis-plan.md` for the full design.
>
> Finally, **multiple parallel sessions** landed: a header tab strip where each tab
> is an independent governed `pi --mode rpc -a` with its own transcript, model,
> working folder, and Files/Changes view (default 4, `COOP_WEB_MAX_CHATS` 1–8).
> Background tabs keep streaming with busy/unread indicators; one tab's agent
> crashing is contained to that tab (a recorded crash card) while the bridge and the
> other tabs keep running. This was a bridge-wide refactor of the per-conversation
> state into chat objects behind one multiplexed SSE stream (`{sid,n,ev}` envelopes,
> per-chat replay via `/events-poll?sid`); it shipped in two stages — a
> behaviour-preserving Stage 1 (the existing suite passed unmodified) then the wire +
> UI change — with `COOP_WEB_MAX_CHATS=1` behaving exactly like the old single-session
> coop web. Worktree isolation and idle-eviction are deliberately deferred.
>
> Remaining gaps are narrower UX breadth, not safety — see "Known limitations" in
> `../web/README.md`.

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

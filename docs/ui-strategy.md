# UI strategy — why `coop web`, and what we learned

The friendly-UI work shipped through phase 2 (`coop web` landed in v0.5.0 and
grew through v0.8.x). This page records the strategy and the hard-won
implementation lessons so future UI work doesn't re-learn them. Companion
docs: [coop-web-plan.md](coop-web-plan.md) (the phase-2 design and
non-negotiables) and [../web/README.md](../web/README.md) (what shipped, the
security model, known limitations).

## The framing: entry friction vs experience friction

"Uncomfortable with the terminal" is two different problems:

- **Entry friction** — opening a terminal, installing, facing a blank prompt.
  Fixed cheaply by **phase 1**: the double-click launchers (`Install coop.cmd`,
  `bin/coop-desktop.ps1`, Start Menu/Desktop shortcuts created by
  `scripts/install.ps1`) plus the **Start Here menu** in
  `extensions/coop-tools` (auto-opens on first launch, `/start` anytime,
  opt out with `COOP_NO_START_MENU=1`).
- **Experience friction** — raw diffs, JSON review dumps, keyboard-only
  confirm dialogs. Only a rendered UI fixes it. That is **phase 2**:
  `coop web`, a localhost browser chat over the *same governed agent*.

## The phased path

1. **Phase 1 — launcher + Start Here menu** (shipped, v0.5.0). About 175
   lines of extension TS (commit `523eeb8`: +176/−11 in
   `extensions/coop-tools/index.ts`); zero governance risk.
2. **Enabling refactor** (shipped): one shared launch spec —
   `coop launch-spec --json`, built by `coop_build_pi_args` (bash) /
   `Build-CoopPiArgs` (ps1) — so the terminal, the PowerShell twin, and any UI
   assemble Pi's flags from a single source. `tests/run.sh` guards it against
   drift.
3. **Phase 2 — `coop web`** (shipped): `web/server.mjs` (Node builtins only)
   spawns **`pi --mode rpc -a`** as a subprocess and bridges it to a static SPA
   over HTTP + SSE. The "it's an app" feel comes free from launching the first
   Chromium-family browser found (Edge → Chrome → Brave → Vivaldi/Chromium,
   cross-platform) in app-mode (`--app=…`) with a **dedicated coop profile** —
   a chromeless window with its own taskbar/dock entry, the coop icon, and
   isolation from the user's real browser session. **Explicitly not
   Electron/Tauri**: no code signing, no bundled runtime, no Rust, and `coop
   web` dominates a native desktop shell on cost. (`COOP_WEB_NO_APP=1` falls back
   to a normal tab.)
4. **Beyond** (only on proven demand): VS Code extension or a hosted Teams
   surface. Native desktop stays off the table.

## Windows-first

The team works on Windows machines and VMs — that is the single real target
for UI/distribution work (macOS/Linux keep the terminal path). The binding
constraints are Windows realities (PowerShell execution policy, per-user
installs, PATH), not mac parity; and because the "app" is a browser window
over a locally installed CLI, there is no signing/notarization cost at all.

## Hard-won implementation lessons (do not re-learn these)

- **Drive Pi via subprocess RPC, never the in-process SDK.** The RPC wire
  contract is stable across Pi versions, so `coop update` upgrades Pi for
  free; importing the SDK would hard-pin one exact Pi version. The bridge
  imports none of Pi's internals — it is a dumb pipe + static file server.
- **The `-a` flag is mandatory** when spawning `pi --mode rpc`.
  Non-interactive modes skip the project-trust prompt; without `-a` Pi
  silently drops coop's guardrails and skills and runs ungoverned while
  looking like it works.
- **Never frame Pi's JSONL with Node `readline`** — it mis-splits on
  U+2028/U+2029 inside JSON strings and corrupts messages. Use a `\n`-only
  splitter (strip a trailing `\r`), as `web/server.mjs` does.
- **Never await a UI dialog inside a `session_start` hook outside the TUI.**
  Awaiting the Start Here dialog starved Pi's event loop in RPC mode and Pi
  exited moments after start — the bridge died and the page showed
  "reconnecting…" (the v0.5.2 bug). In RPC mode the Start Here menu is
  **fire-and-forget** (the `ctx.mode !== "tui"` branch in
  `extensions/coop-tools/index.ts`); only the TUI awaits.
- **Security hardening is table stakes, not polish** — the bridge puts a
  listening port in front of a bash-capable, file-editing agent. Shipped
  layers: bind **127.0.0.1 only** + Host-header guard (DNS rebinding), a
  per-run token exchanged for an **HttpOnly** `SameSite=Strict` cookie
  (timing-safe compare), **strict CSP** with no inline script/style, POSTs
  require the custom **`X-Coop-CSRF`** header, CORS never enabled. Details in
  [../web/README.md](../web/README.md).

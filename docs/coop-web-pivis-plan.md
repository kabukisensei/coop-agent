# coop web ⇄ pi-vis: implementation plan

**Target file:** `docs/coop-web-pivis-plan.md` in `/Users/aaronjennings/Developer/coop-agent`

This plan re-implements five pi-vis-inspired capabilities in coop web — a protocol contract with drift detection, a git diff viewer, cross-workspace session history with high-fidelity resume, broader extension-UI bridging, and multiple parallel sessions — inside coop web's existing architecture: a dependency-free Node-stdlib bridge (`web/server.mjs`) that spawns governed `pi --mode rpc -a` subprocesses, plus a vanilla-JS SPA (`web/public/`) under strict CSP. pi-vis (checked out at `/tmp/pi-vis`, MIT-licensed) is **reference-only**: its logic and UX were studied and are re-implemented here, but its code depends on Electron/React/Zod/Vite and must never be imported or copied wholesale. Each milestone section below has already been reviewed and constraint-checked; implement them as written.

---

## Read this first — rules for the implementing agent

These rules are non-negotiable. Violating any of them makes the work wrong regardless of whether it "works."

**Workflow:**

1. All work happens in `/Users/aaronjennings/Developer/coop-agent`. Before touching anything, run `git fetch origin && git status --porcelain && git pull --ff-only`. **If the working tree is dirty, STOP and report — do not proceed.**
2. **Never commit, push, tag, or release.** Working-tree changes only; Aaron reviews everything.
3. After every change, run `bash tests/run.sh` and `bash scripts/check-parity.sh`. Run `bash -n <file>` on any shell file you touch. All must pass before you move on.
4. `docs/coop-web-plan.md` and `web/README.md` must be updated to reflect shipped features as each milestone lands.

**Architecture invariants:**

5. **No runtime dependencies, no build step.** `web/server.mjs` is plain Node stdlib; `public/` is vanilla JS/CSS/HTML served statically. No npm packages (no Zod, no React, no diff libs, no highlight.js), no bundler for `web/`. (The esbuild usage in tests is for extensions only — unrelated; do not extend it to web/.)
6. **Strict CSP:** no inline script, no inline style, no eval/`new Function`. All JS in `public/*.js` files, all styles in `style.css`. Build DOM with `createElement`/`textContent`; never `innerHTML` with unescaped input.
7. **The bridge is a dumb pipe.** It never imports Pi internals or the Pi SDK. It spawns `pi --mode rpc -a` using the output of `coop launch-spec --json` (bin + args + env), appending `--mode rpc -a`. Never a hand-copied flag list. **Never drop `-a`** — the agent runs silently ungoverned otherwise.
8. **Security invariants on every new endpoint/route:** bind 127.0.0.1 only; one-time token → session cookie; CSRF custom-header requirement on state-changing requests; DNS-rebinding Host check; timing-safe token compare. File access jailed to the working folder by lexical AND realpath checks (follow the existing `/files` pattern). Field-whitelist every request body — never spread client input.
9. **JSONL framing:** split on `\n` only, strip a trailing `\r`; **NEVER Node `readline`** (U+2028/U+2029 corruption). This applies to pi stdout framing and to reading session files.
10. **Windows-first:** everything must work on Windows (path separators, msedge `--app` mode, PowerShell launch path). Any change to `bin/coop` or `scripts/*.sh` requires an identical-behavior edit to the paired `.ps1` (which must keep its UTF-8 BOM), and all bash stays bash-3.2 compatible. **This plan deliberately touches only `web/`, `tests/`, and one line of `tests/run.sh` — do not create parity burden.** If you find yourself editing `bin/coop`, `lib/`, or `scripts/`, stop and reconsider.
11. **Tests:** every bridge-side addition must be covered by the stub-pi integration suite in `tests/webbridge.test.mjs` (a fake pi speaking the RPC protocol over stdio). That suite is order-sensitive — append, don't reorder.
12. **Compatibility target:** Pi 0.80.x RPC protocol, single-user localhost.
13. You are running with multi-agent orchestration: milestones M2/M3/M4 may be parallelized across subagents **after M1 lands green**, but M5 must be done last and by a single coordinated effort (it refactors state that all other milestones touch).

---

## Milestone order and why

| Milestone | Section | Size | Depends on |
|---|---|---|---|
| **M1** | RPC protocol contract & drift detection | M | nothing — **land first** |
| **M2** | Diff viewer (unified + side-by-side) | L | M1 (registration rule only) |
| **M3** | Session history & workspace grouping | M | M1 (registration rule only) |
| **M4** | Extension UI bridging breadth | S | M1 (registration rule only) |
| **M5** | Multiple parallel sessions | L | **everything — land last** |

**Why this order:**

- **M1 first.** It fixes a live bug on main (the JSONL framer corrupts multi-byte UTF-8 split across chunk boundaries) and establishes the machinery every later milestone is checked against: the contract in `web/protocol.mjs` and the end-of-suite drift-count assertion in `tests/webbridge.test.mjs`. From M1 onward, the rule for every milestone is: **register every new command in `COMMANDS_SENT` (and `RPC_ALLOWED` if browser-reachable), every new consumed event in `EVENTS_CONSUMED`, and every new `__`-prefixed synthetic in `BRIDGE_EVENTS`** — the drift-count assertion fails the suite if you forget. Concretely: M3 registers `__replay`; M5 registers `__chats` and `__reset` and updates the `__hello` shape.
- **M2/M3/M4 are mutually independent** and can proceed in parallel after M1. They coordinate only on conventions: M2 establishes the full-pane `#main` overlay pattern and the `onAgentEnd`/`onReset` hook pattern; M4's dock state and M3's history card are self-contained.
- **M5 last.** It refactors the bridge's core per-conversation state into chat objects and changes the SSE wire format; every endpoint added by M2/M3/M4 must exist first so it can be swept into the chat object + `chatFor` plumbing during M5 Stage 1. Two cross-milestone carry-forwards to watch during M5: (a) M3's `/events-poll` stale-cursor clamp must survive the Stage 1/2 rework of that route (it becomes per-chat), and (b) M4's `extStatus`/`extWidgets`/`extUnknown` maps and `document.title` must be reset per tab switch (they already live in `resetTranscript()`, which `switchChat` calls — verify, don't assume).

---

## M1 — RPC protocol contract & drift detection

### 1. Goal & user-visible behavior

coop-web speaks Pi 0.80.x RPC from memory: nothing in the repo states which commands the bridge sends or which event shapes the SPA renders, so a Pi upgrade that renames a field fails *silently* (blank bubbles, dead tool pills). This section adds a checked-in, dependency-free protocol contract (`web/protocol.mjs`), a bridge-side drift detector that logs to stderr and shows a one-time warning toast in the browser when an unknown or shape-mismatched event arrives, and a hardened JSONL splitter (fixes a real multi-byte-UTF-8 chunk-boundary corruption bug and adds an oversized-line cap). User-visible change is minimal by design: one new toast kind and more trustworthy streaming; the payoff is that the next Pi bump fails loudly with an actionable message instead of quietly degrading.

### 2. Design

#### 2a. New module: `web/protocol.mjs` (single new file, Node stdlib only, side-effect-free)

A plain ESM module imported by `web/server.mjs` and by tests. It is NOT served to the browser (validation happens at the bridge chokepoint `handlePiLine`, which both SSE and polling clients sit behind). It exports:

**Contract data (plain objects — the machine-readable statement of the wire contract):**

- `RPC_ALLOWED` — **moved here verbatim** from `server.mjs` L184–193 (`new_session`, `get_state`, `get_available_models`, `set_model`, `set_thinking_level`, `compact`, `get_session_stats`, `set_session_name`). Living next to the contract makes whitelist/contract drift structurally impossible; `server.mjs` imports it.
- `COMMANDS_SENT` — every command the bridge ever writes to pi stdin, mapped to a field spec. Derived from actual usage in `server.mjs`: `prompt` (`{message:"string", streamingBehavior:"string?"}`), `extension_ui_response` (`{id:"string", value:"any?", confirmed:"boolean?", cancelled:"boolean?"}`), `abort` (`{}`), `get_messages` (`{}`), plus all eight `RPC_ALLOWED` types with their whitelisted fields (`set_model`: `{provider:"string", modelId:"string"}`; `set_thinking_level`: `{level:"string"}`; `compact`: `{customInstructions:"string?"}`; `set_session_name`: `{name:"string"}`; the rest `{}`). A header comment also records the launch flags contract: spawn = launch-spec `bin`/`args` + `--mode rpc -a` (+ `--session <file>` on resume) — documentation only, `spawnPi` is not changed.
- `EVENTS_CONSUMED` — every event type the bridge (`handlePiLine`) or SPA (`handle()` in `app.js`) dereferences, with a shallow field spec:
  - `agent_start`: `{}` (toggles `busy`)
  - `agent_end`: `{messages:"array?", willRetry:"boolean?"}`
  - `message_start`: `{message:"object"}` (SPA reads `message.role`, `message.content`)
  - `message_update`: `{message:"object?", assistantMessageEvent:"object?"}` — plus a subcheck: when `assistantMessageEvent` is present its `type` must be in `ASSISTANT_MESSAGE_EVENTS = ["text_start","text_delta","text_end","thinking_start","thinking_delta","thinking_end","toolcall_start","toolcall_delta","toolcall_end"]`, and `delta` must be a string on the `*_delta` types (including `toolcall_delta`, which streams partial-JSON args as a string delta). The `toolcall_*` members are load-bearing: Pi 0.80.2's `AssistantMessageEvent` union (`pi-ai` `dist/types.d.ts`) includes them, and `rpc-mode.js` forwards session events wholesale, so **every real tool call** produces `message_update` events with `assistantMessageEvent.type: "toolcall_*"`. The SPA's `message_update` handling falls through on them today (no renderer change needed); omitting them from the contract would make the drift detector fire a permanent false positive in essentially every real session.
  - `message_end`: `{message:"object?"}` (SPA reads `message.usage`, `message.role`, `message.responseModel|model`)
  - `tool_execution_start`: `{toolCallId:"string", toolName:"string", args:"any?"}`
  - `tool_execution_update`: `{toolCallId:"string", toolName:"string?", partialResult:"any?"}`
  - `tool_execution_end`: `{toolCallId:"string", toolName:"string?", result:"any?", isError:"boolean?"}`
  - `compaction_start`: `{reason:"string?"}`; `compaction_end`: `{}`
  - `extension_ui_request`: `{id:"string", method:"string"}` — plus subcheck `method` ∈ `UI_METHODS = ["select","confirm","input","editor","notify","setStatus","setWidget","setTitle","set_editor_text"]`
  - `response`: `{command:"string?", success:"boolean", id:"any?", data:"any?", error:"string?"}`
- `EVENTS_KNOWN_IGNORED` — types Pi 0.80.x emits that coop-web deliberately ignores but must not warn about: `turn_start`, `turn_end`, `queue_update`, `auto_retry_start`, `auto_retry_end`, `thinking_level_changed`, `extension_error`, `session_info_changed`. Each entry was verified to exist in the installed Pi 0.80.2 package (grep of `pi-coding-agent`/`pi-agent-core` `dist/`); the `protocol.mjs` header comment records this verification method and version so the upgrade-checklist diff step has a trustworthy baseline. (An earlier draft listed `streaming_state`; it does not exist anywhere in Pi 0.80.2 and was dropped — the contract must not contain aspirational entries.)
- `RESPONSE_DATA` — the `data` fields the SPA actually dereferences per claimed `/rpc` command (checked only when `success === true`): `get_state`: `{model:"object?", thinkingLevel:"string?"}`; `get_available_models`: `{models:"array"}`; `get_session_stats`: `{contextUsage:"object?", tokens:"object?", cost:"number?"}`; `new_session`: `{cancelled:"boolean?"}`; `get_messages`: `{messages:"array"}`; `compact`, `set_model`, `set_thinking_level`, `set_session_name`: `{}` (loose).
- `BRIDGE_EVENTS = ["__hello","__fatal","__message","__drift"]` — bridge-synthesized types (always skipped by the validator; documented so future sections don't collide). *(M3 adds `__replay`; M5 adds `__chats` and `__reset` — each milestone must extend this list as it lands.)*

**Field-spec mini-language + checkers (no Zod — ~40 lines):** a spec is `{field: kind}` where kind ∈ `"string" | "number" | "boolean" | "object" | "array" | "any"`, with a `?` suffix meaning optional. Exported functions:
- `checkShape(obj, spec) -> string[]` — returns human-readable problems (`"missing required field toolCallId"`, `"field isError: expected boolean, got string"`). Extra unknown fields are NEVER problems (Pi may add fields freely — this is drift *detection*, not enforcement).
- `checkEvent(evt) -> {kind: "ok"|"unknown"|"mismatch", problems: string[]}` — dispatches: `__`-prefixed or in `EVENTS_KNOWN_IGNORED` → ok; in `EVENTS_CONSUMED` → `checkShape` + the `message_update`/`extension_ui_request` subchecks; anything else → `unknown`.
- `checkResponseData(command, data) -> string[]` — applies `RESPONSE_DATA[command]` when defined.

**Hardened JSONL splitter** — `createJsonlSplitter(onLine, opts)` returns a `feed(chunk)` function, replacing the inline framer in `wirePi` (L129–141). Semantics (compared against pi-vis's byte-level `jsonl-stream.ts`, re-implemented, not copied):
1. **UTF-8 boundary fix (the real bug):** uses `new StringDecoder("utf8")` from `node:string_decoder` per splitter instance. Today's `chunk.toString("utf8")` yields U+FFFD replacement chars when a multi-byte character (emoji in a `text_delta`, CJK, etc.) straddles a pipe-chunk boundary, corrupting that JSON line, which `handlePiLine` then silently drops. The decoder carries partial code points across chunks.
2. **\n-only split** via `indexOf("\n")` loop — unchanged (JS string `indexOf("\n")` never matches U+2028/U+2029, so the existing framer was already safe there; a regression test now pins it — the module header repeats the "NEVER Node readline" rule).
3. **CRLF tolerance:** strip one trailing `\r` — unchanged. **Blank lines:** skipped — unchanged.
4. **O(n) partial buffering:** pending partials kept as an *array* of string segments (`pending.push(tail)`), joined only when the terminating `\n` arrives — mirrors pi-vis's `Buffer[]` trick so a huge line fed in small chunks isn't repeatedly re-concatenated.
5. **Oversized-line cap (new):** `opts.maxLineLength` default `64 * 1024 * 1024` (matches pi-vis's 64 MiB; measured in string length ≈ bytes, documented as approximate). When pending exceeds it: drop the partial, set an overflow flag so the eventual completion of that line is also discarded, and call `opts.onOversize?.(len)` once (server logs to stderr). Subsequent lines parse normally. Today the buffer is unbounded.

#### 2b. `web/server.mjs` changes (bridge — the only validation point)

- `import { RPC_ALLOWED, checkEvent, checkResponseData, createJsonlSplitter } from "./protocol.mjs";` — delete the local `RPC_ALLOWED` definition (L184–193). No other route logic changes; all security gates (`hostOk`, token/cookie, CSRF, jails) untouched.
- **`wirePi(child)`**: replace the closured `buf` framer with a per-child splitter: `const feed = createJsonlSplitter((line) => handlePiLine(line), { onOversize: (n) => console.error(...) }); child.stdout.on("data", (chunk) => { if (child !== pi) return; feed(chunk); });`. The splitter instance is created inside `wirePi`, so — exactly like today's per-child `buf` — a replaced child's partial line (or partial code point) never bleeds into the new child's stream.
- **Drift detection in `handlePiLine`** (observe-only; the dumb pipe is preserved — events are still recorded/broadcast verbatim regardless of validation result):
  - New module state: `let driftSeen = new Set();` (cap 100 entries; once full, stop reporting). Cleared in `restartPi` alongside `stderrTail` (a respawn may be a different Pi build; history resets anyway).
  - New function `noteDrift(evt, line)`: `const r = checkEvent(evt); if (r.kind === "ok") return;` dedupe key = `` `${r.kind}:${evt.type}` ``; if unseen: (1) `console.error("coop web: protocol drift — " + kind + " event '" + evt.type + "': " + problems.join("; ") + " | " + line.slice(0, 200))` (stderr is the authoritative record, per the all-console-to-stderr convention), and (2) `broadcast(JSON.stringify({ type: "__drift", eventType: evt.type, kind: r.kind, problems: r.problems.slice(0, 5) }))` — **broadcast-only, never `record()`ed** (same policy as unclaimed responses: transient, meaningless on replay; polling clients rely on stderr — acceptable for a warning).
  - Call `noteDrift(evt, line)` in `handlePiLine` after `JSON.parse`, before the `response` branch. For claimed responses (the `waiter` branch), additionally run `checkResponseData(evt.command, evt.data)` when `evt.success === true` and route any problems through the same dedupe/report path (key `` `data:${evt.command}` ``).
- Non-JSON stdout lines stay silently dropped (unchanged — Pi extensions can print noise; warning on those would be pure spam).

#### 2c. `web/public/app.js` change (SPA — one case)

Add to the `handle(evt)` switch, following the existing `__fatal` pattern:

```js
case "__drift":
  toast(`Unexpected data from the agent (${evt.eventType || "?"}) — a Pi update may have changed the protocol. Chat keeps working; check the coop web console.`, "warning");
  break;
```

`toast(message, "warning")` and `.toast.warning` styling already exist — no `style.css`, `index.html`, or `viewer.js` changes. Dedupe server-side means at most one toast per drifting event type per pi child. CSP-clean (`textContent` only).

#### 2d. Upgrade checklist (documentation)

New `web/README.md` section **"Protocol contract (when Pi is upgraded)"**, referenced from the `protocol.mjs` header comment:
1. Read the Pi release notes / RPC changes for the new version.
2. Diff `web/protocol.mjs` (`COMMANDS_SENT`, `EVENTS_CONSUMED`, `EVENTS_KNOWN_IGNORED`, `RESPONSE_DATA`) against Pi's RPC docs *and* the installed package's type unions (e.g. `AssistantMessageEvent` in `pi-ai`/`pi-agent-core` `dist/types.d.ts`) — every contract entry must exist in the real protocol; no aspirational entries. (pi-vis's `src/shared/pi-protocol/` Zod schemas are a useful second reference — *read* them, never copy.)
3. Update the contract; mirror any command/event changes in `tests/stub-pi.mjs`; run `bash tests/run.sh`.
4. Launch `coop web` against the new Pi, exercise chat / **tool calls** / model picker / resume / chdir, and watch stderr for `protocol drift` lines — each one is either a contract update or a renderer fix. (Tool calls matter: they exercise the `toolcall_*` assistant-message events that a text-only smoke test never emits.)
5. Bump the "Tested against the RPC protocol of Pi 0.80.x" line in Known limitations, and the verified-against version noted in the `protocol.mjs` header.

### 3. Files to touch

| File | Change |
|---|---|
| `web/protocol.mjs` | **NEW** (~250 lines). Contract data (`RPC_ALLOWED`, `COMMANDS_SENT`, `EVENTS_CONSUMED`, `EVENTS_KNOWN_IGNORED`, `RESPONSE_DATA`, `BRIDGE_EVENTS`, `ASSISTANT_MESSAGE_EVENTS` incl. `toolcall_*`, `UI_METHODS`), `checkShape`/`checkEvent`/`checkResponseData`, `createJsonlSplitter`. Header comment: upgrade-checklist pointer, the readline prohibition, and a "verified against Pi 0.80.2 (`pi-agent-core`/`pi-ai` dist types + rpc-mode event forwarding)" note. House style: double quotes, semicolons, 2-space indent, `--` banner comments, heavy "why" comments. |
| `web/server.mjs` | Import from `./protocol.mjs`; delete local `RPC_ALLOWED` (L184–193); swap `wirePi`'s inline framer (L129–141) for a per-child `createJsonlSplitter`; add `driftSeen` + `noteDrift()`; call it in `handlePiLine` (events + claimed-response data); clear `driftSeen` in `restartPi`. |
| `web/public/app.js` | One `case "__drift":` toast in `handle()`. |
| `tests/stub-pi.mjs` | Two changes. (1) Test escape hatch, first branch in the command dispatcher: `if (cmd.type === "prompt" && typeof cmd.message === "string" && cmd.message.startsWith("emit:")) { process.stdout.write(cmd.message.slice(5) + "\n"); continue-equivalent; }` — lets integration tests inject arbitrary raw lines through the real stdout pipe (no `agent_start`, so `busy` is untouched). (2) Extend the canned prompt reply (currently `text_start`/`text_delta`/`text_end` only, L30–32) to also stream a `toolcall_start` / `toolcall_delta` (string `delta`) / `toolcall_end` triple, so the stub exercises the real-world tool-call streaming path and the end-of-suite no-drift assertion guards it. |
| `tests/webbridge.test.mjs` | New drift/passthrough integration tests (see §4), inserted after the `/files` block, before `server.kill()` (L323) — order-dependent suite, so append-only. |
| `tests/protocol.test.mjs` | **NEW** unit suite importing `web/protocol.mjs` directly (pure module — importable without spawning anything). Same flat `t(name, ok)` style as the other suites. |
| `tests/run.sh` | One line after the webbridge step: `echo "→ protocol contract + JSONL splitter tests"` / `node "$ROOT/tests/protocol.test.mjs"`. Plain POSIX-safe bash; `tests/run.sh` has **no** `.ps1` twin and `check-parity.sh` does not cover `tests/` — zero parity burden. |
| `web/README.md` | New "Protocol contract" section with the 5-step upgrade checklist; note the drift toast under behavior; keep the "Tested against Pi 0.80.x" line and point it at `web/protocol.mjs`. |

No changes to `bin/coop`, `lib/`, `scripts/`, or any `.ps1` — the whole feature lives in `web/` + `tests/` + one `tests/run.sh` line.

### 4. Test plan

**`tests/protocol.test.mjs` (new unit suite, no server spawn):**
- Splitter: two events in one chunk; one event split across 3 chunks; **a 4-byte emoji (`"😀"`, `Buffer` split mid-code-point) across two `feed()` calls arrives intact** — this fails against the old framer's logic and pins the StringDecoder fix; CRLF line; blank lines skipped; a JSON string containing literal U+2028/U+2029 parses intact and un-split; an oversized line (use `{maxLineLength: 1024}` opt) is dropped, `onOversize` fires once, and the *next* line still parses; partial state does not leak between two splitter instances.
- `checkShape`: missing required field; wrong kind; optional absent = ok; extra unknown fields = ok.
- `checkEvent`: every stub-pi-emitted event shape → ok; each `EVENTS_KNOWN_IGNORED` type → ok; `{type:"brand_new_event"}` → unknown; `{type:"tool_execution_end"}` (no `toolCallId`) → mismatch; `__hello`/`__fatal`/`__message`/`__drift` → ok; `message_update` with `assistantMessageEvent.type:"bogus"` → mismatch; **`message_update` with `assistantMessageEvent: {type:"toolcall_delta", delta:"{\"pa"}` → ok** (pins the blocker fix — real tool-call streaming must never register as drift); `message_update` with `assistantMessageEvent: {type:"toolcall_delta", delta: 42}` → mismatch (`*_delta` string subcheck covers `toolcall_delta` too).
- Contract self-consistency: every member of `RPC_ALLOWED` has a `COMMANDS_SENT` entry; every `RESPONSE_DATA` key is in `COMMANDS_SENT`; `EVENTS_CONSUMED` ∩ `EVENTS_KNOWN_IGNORED` = ∅.

**`tests/webbridge.test.mjs` additions (via the stub `emit:` hatch + existing `post`/`readSse` helpers, fixed sleeps ~400 ms after each emit):**
1. Open `readSse`, `post("/prompt", {message: 'emit:{"type":"totally_new_event","x":1}'})` → the raw event is **forwarded verbatim** (dumb pipe intact) AND a `__drift` frame with `eventType:"totally_new_event"`, `kind:"unknown"` appears; `serverErr` contains `protocol drift`.
2. Emit the same unknown type again → no second `__drift` frame in a fresh `readSse` window and exactly one `protocol drift.*totally_new_event` match in `serverErr` (dedupe).
3. Emit `{"type":"tool_execution_end"}` → `__drift` with `kind:"mismatch"` and a `toolCallId` problem string.
4. Emit `{"type":"queue_update","steering":[],"followUp":[]}` → forwarded, **no** `__drift` (known-ignored).
5. Emit a `message_update` whose `delta` contains a literal U+2028 → the delta round-trips byte-identical through `/events-poll` (framer regression guard at the integration level).
6. `/rpc get_state` still round-trips and remains unrecorded (guards the `RPC_ALLOWED` move).
7. Final assertion before `server.kill()`, stated precisely: `(serverErr.match(/protocol drift/g) || []).length === N`, where N is the exact number of drift lines tests 1–3 deliberately provoked (unknown ×1, mismatch ×1 — dedupe collapses test 2, so N = 2 as specified; recount if the emit cases change). This proves the standard stub conversation (now including its `toolcall_*` streaming triple), resume backfill, chdir, and all canned responses add **zero** drift lines. Assert *nothing else* about `serverErr`'s contents — it legitimately also carries the startup banner/URL, per-request access-log lines from the `res.on("finish")` handler, "resuming session …", "working folder changed → …", and stub stderr; only the `protocol drift` match count is the contract signal. This is the "stub-pi fixtures assert the contract" deliverable, and it is what would have caught the `toolcall_*` omission.

**Verify commands (all must pass):** `node tests/protocol.test.mjs`, `node tests/webbridge.test.mjs`, `bash tests/run.sh`, `bash scripts/check-parity.sh`, and `bash -n tests/run.sh`.

### 5. Edge cases & failure modes

- **Dumb pipe preserved:** validation is observe-only — unknown/mismatched events are still recorded and broadcast verbatim; nothing is dropped, rewritten, or blocked. `spawnPi` and its `--mode rpc -a` construction are untouched.
- **No false positives on the protocol we claim to support:** the contract includes the full `AssistantMessageEvent` union (`text_*`, `thinking_*`, `toolcall_*`) verified against Pi 0.80.2, and the stub now streams a tool call in every canned conversation — a contract that flagged normal traffic would fail the suite's drift-count assertion.
- **Windows:** CRLF stripping unchanged; `StringDecoder` is platform-neutral; no paths, no shell, no `.ps1` parity exposure. The `__drift` toast renders identically under msedge `--app`.
- **Polling-fallback clients never see `__drift`** (broadcast-only, and `/events-poll` reads only `history`). Deliberate: recording it would replay stale warnings on every reconnect. stderr is the authoritative record; the toast is best-effort UX.
- **Toast noise bound:** dedupe key is per event type per pi child (`driftSeen`, cap 100), cleared on `restartPi` — a chdir/resume against an upgraded Pi re-warns once, which is correct.
- **Oversized line:** the offending event is lost (logged); the stream recovers on the next `\n`. Losing one >64 MiB event beats today's unbounded memory growth.
- **Extension stdout noise:** non-JSON lines stay silently ignored (unchanged) — only *parsed* JSON objects are validated, so a chatty extension can't trigger toast spam.
- **`restartPi` race:** the splitter and its StringDecoder are closured per child in `wirePi`, and the `child !== pi` generation check runs before `feed()` — a replaced child's partial line/code point can never corrupt the new child's stream (same guarantee as today's per-child `buf`).
- **Graceful degradation on a genuinely new Pi:** worst case is one stderr line + one toast per new event type; chat, tools, and replay keep working exactly as before because forwarding is unconditional.

### 6. Out of scope / deferred (do not gold-plate)

- **No deep/recursive schema validation** (no Zod re-implementation). Top-level field kinds + the two subchecks only — enough to catch renames/removals, cheap enough to run on every event.
- **No byte-level `Buffer` splitter.** `StringDecoder` + a pending-segment array gives the same correctness (U+2028/29, boundary code points, O(n)) at coop's throughput; pi-vis's `Buffer[]`-slice design is unnecessary complexity here.
- **No SPA-side validator** — the bridge chokepoint covers both transports; shipping the contract to the browser would mean a second copy or restructuring `app.js` into modules.
- **No rendering of `toolcall_*` streaming deltas in the SPA** — the contract accepts them (they're normal Pi 0.80.x traffic) but the SPA keeps ignoring them; live tool-call arg streaming is a diff-viewer/tool-pill enhancement for another section.
- **No enforcement/strict mode** (dropping or quarantining bad events) and **no env-var gate on the toast** — start default-on/deduped; if the team finds it noisy, gating behind `COOP_WEB_PROTOCOL_WARN` is a two-line follow-up.
- **No contract for session-*file* entries** (`scanSessionFile`/`recentFolders` already tolerate arbitrary shapes). M3 (session history) extends `protocol.mjs` if needed when it lands.
- **No auto-generation from pi-vis's Zod schemas** — the contract is hand-curated from coop-web's *actual usage* plus verification against the installed Pi package (pi-vis is a reference to read during upgrades, per the checklist; copying wholesale would both violate the MIT-reimplement rule and overstate what coop-web depends on).
- **No `__drift` delivery to polling clients** (see §5) and **no protocol-version negotiation** with pi (`get_state` carries no protocol version to negotiate on).
- **No commits/tags/releases** — working-tree changes only; Aaron reviews.

### 7. Estimated size & dependencies

**Size: M** — one ~250-line new module, one ~130-line new unit suite, surgical edits to `server.mjs` (framer swap + ~30 lines of drift plumbing), ~7 new integration tests plus a stub-pi tool-call streaming triple, docs.

**Dependencies: none — this section is implementable standalone and lands FIRST.** The other sections (diff-viewer, session-history, extension-ui, multi-session) each add commands/events; once this lands, their rule is: register every new command in `COMMANDS_SENT` (and `RPC_ALLOWED` if browser-reachable), every new consumed event in `EVENTS_CONSUMED`, and every new `__`-prefixed synthetic in `BRIDGE_EVENTS` — the end-of-suite drift-count assertion in `webbridge.test.mjs` will fail their PRs if they forget.

---

## M2 — Diff viewer (unified + side-by-side)

### 1. Goal & user-visible behavior

Add a read-only "Changes" view to coop web: a toolbar chip (`± Changes`, with a live changed-file count) opens a full-pane viewer over the transcript showing the working tree's git changes — a changed-files list on the left, and for the selected file a rendered diff (unified or side-by-side, line numbers, add/remove coloring, cheap intraline emphasis, in-file search) on the right. Diffs are computed by the system `git` (working tree vs `HEAD`, or vs a user-typed base ref); the badge refreshes after each agent turn so file edits made by tools are immediately visible. In a non-git folder, or on a Windows machine without git, the viewer degrades to a clear one-line explanation instead of erroring.

Everything lives in `web/` + `tests/` — no `bin/coop` / `scripts/*.sh` changes, so **no PowerShell parity burden**. No new pi RPC commands, no new bridge-synthesized events: the bridge stays a dumb pipe; git endpoints are bridge-local reads exactly like `/files`. Working-tree changes only — do NOT commit, push, tag, or release.

### 2. Design

#### 2.1 Bridge: git shell-out helper (`web/server.mjs`)

Add one helper next to `readFilePreview` (after the Files-panel section, ~L533). **Never a shell** — `spawn("git", args)` directly (already imported at L20). On Windows, `git.exe` is a real executable, so PATH resolution works without the cmd.exe wrapper `spawnPi` needs for the `.cmd` shim; do **not** reuse that wrapper.

```js
// runGit(args, {maxBytes=2_000_000, timeoutMs=15000}) -> Promise<
//   {ok:true, out:string, truncated:boolean} |
//   {ok:false, missing:true} |               // ENOENT: git not installed
//   {ok:false, code:number, err:string}>     // non-zero exit (stderr tail)
```

- `spawn("git", args, { cwd: CWD, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore","pipe","pipe"] })`. `GIT_OPTIONAL_LOCKS=0` so read commands never take the index lock while the agent works.
- Buffer stdout manually; if it exceeds `maxBytes`, kill the child, keep the partial buffer, set `truncated: true`. Keep a bounded stderr tail (1000 chars) for the error branch.
- `setTimeout(timeoutMs)` → kill + `{ok:false, code:-1, err:"timed out"}`. Clear the timer on exit. Resolve, never reject (matches the swallow-and-degrade convention).
- `child.on("error", e => …)` with `e.code === "ENOENT"` → `{ok:false, missing:true}`.

Constants (next to `FILE_TEXT_MAX`, L448): `GIT_MAX_FILES = 500`, `GIT_DIFF_MAX = 1_000_000`, `GIT_TIMEOUT_MS = 15000`.

Base-ref validation (prevents option injection even though there's no shell): `const gitRefOk = (s) => typeof s === "string" && /^[A-Za-z0-9._/~^-]{1,200}$/.test(s) && !s.startsWith("-");` Always pass `--` before pathspecs in every git invocation.

Path jail for client-supplied paths (`p`, `old` on `/git/diff`): a `jailGitPath(rel)` variant of `jailPath` (L489) — same non-string/empty/NUL rejection and **lexical** gate (`resolvePath(CWD, rel)` must equal root or start with `root + sep`); apply the **realpath** gate only when the file exists (deleted files legitimately don't — their content comes from git's object store, and git stores symlinks as link-text, so a tracked symlink cannot leak target contents through a diff). Additionally refuse any path segment in `FILES_IGNORE` (keeps `.git/`, `node_modules/` out). **Deliberate divergence from `isHidden`:** dotfiles are ALLOWED here (unlike `/file`) so tracked paths like `.github/workflows/ci.yml` are diffable; a dotfile's diff is only served if git itself reports it changed. Comment this rationale in the code and note it in `web/README.md`'s security section. (Flagged as an open question for Aaron — see appendix.)

#### 2.2 Bridge: endpoints

Both are **GET**, added in the cookie-authed GET block after the `/file` route (~L771). Read-only → no CSRF header (same as `/files`); `hostOk` + cookie auth apply automatically from the route position. All responses `baseHeaders("application/json")`, status 200 unless noted.

**`GET /git/changes?base=<ref>`** — changed-file list for the badge and the panel's left rail.

Responses (all `200` — these are states, not errors):
- `{ok:true, git:false}` — git not installed.
- `{ok:true, git:true, repo:false}` — `CWD` is not inside a git work tree.
- `{ok:false, error:"That base ref wasn't found."}` — `base` given but unresolvable (also the response for a regex-rejected ref — uniform, no oracle).
- `{ok:true, git:true, repo:true, base:"HEAD"|<ref>, noHead:boolean, files:[{path, oldPath?, status:"A"|"M"|"D"|"R", untracked:boolean}], truncated:boolean}`

Implementation sequence (each step via `runGit`):
1. `git rev-parse --is-inside-work-tree` → non-zero exit → `repo:false`; `missing` → `git:false`.
2. `git rev-parse --verify --quiet HEAD` → non-zero → `noHead = true`.
3. Resolve the diff base: no `base` param → `"HEAD"`. With `base` (regex-validated): `git merge-base <base> HEAD` → use the printed sha (GitHub-style branch diff); if merge-base fails (unrelated histories), `git rev-parse --verify --quiet <base>^{commit}` → use `<base>`; if that also fails → the bad-base error above.
4. If `noHead`: report every file as `untracked:true` (tracked-but-uncommitted via `git ls-files --cached -z` plus step 5's untracked) — the SPA renders untracked files as all-added from `/file` content, so the empty-tree sha (which differs under sha256 repos) is never needed.
5. Otherwise, changed tracked files: `git diff --relative --name-status -z -M <ref> --`. **`--relative` is load-bearing**: it limits output to the CWD subtree AND emits CWD-relative forward-slash paths — the jail and `/file` both consume them directly, and a CWD that is a subdirectory of a bigger repo never leaks paths outside the working folder.
6. Untracked: `git ls-files --others --exclude-standard -z` (already CWD-relative) → `status:"A", untracked:true`.
7. Parse the `-z` grammar: records are NUL-separated; a name-status record is `STATUS\0path\0`, except `R<score>`/`C<score>` which consume TWO path tokens (`old\0new\0` — keyed by the new path, `oldPath` set). Map statuses: first letter; `T`→`M`, `U`→`M`, `C`→`A`. Skip paths whose first segment is in `FILES_IGNORE`.
8. Sort alphabetically by `path`; cap at `GIT_MAX_FILES` with `truncated:true`.

**`GET /git/diff?p=<rel>&old=<rel>&base=<ref>`** — unified diff text for ONE tracked file.

- `p` (and `old`, when present) must pass `jailGitPath`; failure → **400** `{ok:false, error:"That diff can't be shown."}` (uniform with `/file`'s refusal).
- Base resolution identical to `/git/changes` (steps 2–3). git missing / not a repo → `{ok:false, error:"…friendly sentence…"}`.
- Run `git diff --relative --no-color -M --unified=3 <ref> -- <p> [<old>]` (include `old` as a second pathspec for renames so the R-record's old side is found). `maxBytes: GIT_DIFF_MAX`.
- Respond `{ok:true, diff:"<raw unified text>", truncated:boolean}`. The bridge does NOT parse the diff — the SPA does. Binary files: git prints `Binary files … differ`; the parser detects it client-side.
- Untracked files never hit this endpoint — the SPA renders them from the existing `/file?p=` (reusing its jail, hidden-file rule, binary sniff, and 1 MB cap). This means an untracked `.env` stays refused, exactly as today.

Register the two new SPA files in `STATIC` (L559): `"/diff.js"` and `"/diffview.js"`, type `text/javascript; charset=utf-8`.

#### 2.3 SPA: pure diff model — `web/public/diff.js` (NEW, no DOM)

A plain script that only assigns `window.coopDiffModel = { parseUnifiedDiff, pairAndEmphasize, buildSplitRows, computeMatches }`. **Zero `document`/DOM references** — this is what makes it unit-testable in Node (`globalThis.window = globalThis; await import(...)`). CSP-clean, `"use strict"`, escape rules irrelevant here (it returns data, never HTML).

**`parseUnifiedDiff(text)`** → `{binary:boolean, hunks:[{header:string, lines:[Line]}]}` where `Line = {type:"ctx"|"add"|"del", oldNo:number|null, newNo:number|null, text:string, noNewline?:true}`. State machine over `text.split("\n")`:
- Lines starting `diff --git`, `index `, `old mode`, `new mode`, `similarity index`, `rename from/to`, `--- `, `+++ ` (outside a hunk) → skipped header noise.
- `Binary files ` … ` differ` → `binary = true`.
- `/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/` → open a new hunk; seed `oldNo`/`newNo` from the two start numbers; `header` = the full `@@ …` line.
- Inside a hunk, dispatch on first char: `" "` → ctx (`oldNo++`, `newNo++`); `"-"` → del (`oldNo++`, `newNo` null); `"+"` → add (`newNo++`, `oldNo` null); `"\"` (`\ No newline at end of file`) → set `noNewline` on the previous line, emit nothing; anything else closes the hunk (tolerates trailing junk). Content = the line minus its marker char, with **one trailing `\r` stripped** (CRLF working trees).

**`pairAndEmphasize(hunks)`** — mutates lines in place, returns the hunks. Per hunk: each maximal run of consecutive `del`s immediately followed by a run of `add`s is a change block; if the block has ≤ **200** pairs, pair `del[i] ↔ add[i]` for `i < min(len)` (store the partner's index in `.pair`). For each pair compute emphasis by **common prefix/suffix trim** (the deliberate cheap alternative to a word diff — O(n), no dependency): `p` = longest common prefix length of the two texts; `s` = longest common suffix length of the remainders (guard `p + s ≤ min(lenA, lenB)`); emphasis ranges are `old:[p, lenOld−s)`, `new:[p, lenNew−s)`, stored as `.em = [start, end]` on each line. **Bail (no `.em`)** when either line > 500 chars, or `((lenOld−p−s) + (lenNew−p−s)) / (2 * max(lenOld, lenNew)) > 0.65` (whole-line rewrites read better unhighlighted — same threshold pi-vis uses).

**`buildSplitRows(hunks)`** → flat array for the side-by-side view: `{kind:"hunk", header}` per hunk boundary; ctx → `{kind:"ctx", oldNo, newNo, text}`; each del+add block → `max(dels, adds)` rows `{kind:"pair", left:Line|null, right:Line|null}` pairing `del[k]` with `add[k]`, `null` cells for the shorter side.

**`computeMatches(hunks, query)`** — case-insensitive, non-overlapping `indexOf` walk over every line's text in document order → `[{hunkIdx, lineIdx, start, end}]`. Empty query → `[]`.

#### 2.4 SPA: the panel — `web/public/diffview.js` (NEW)

An IIFE exactly on the `viewer.js` pattern: escape-first DOM (`createElement`/`textContent` only — no `innerHTML` anywhere in this file), module-level `let` state, exposes `window.coopDiff = { onAgentEnd, onReset }`.

State: `open`, `changes` (last `/git/changes` payload), `selected` (file record), `model` (parsed hunks), `viewMode` (`"unified"|"split"`, default unified), `baseRef` (`""` = HEAD), `matches`, `matchIdx`, `gen` (generation counter — every async load stamps `gen`; stale resolutions no-op), plus a 500 ms debounced single-flight guard for badge refreshes.

Behavior:
- **Toggle** (`#diffBtn` click): show/hide the `#diff` overlay (`hidden` attr + `.chip.on`, like `filesBtn`). First open → `refreshAll()`. `Escape` keydown (document-level, only when `open`) closes it.
- **`refreshAll()`**: `fetch("/git/changes" + (baseRef ? "?base=" + encodeURIComponent(baseRef) : ""))`. Dispatch on the state shape:
  - `git:false` → empty-state message: `"Git isn't installed on this machine, so coop can't show file changes. Install git and reopen this panel."` Hide the badge.
  - `repo:false` → `"This folder isn't a git repository — no changes to show."` Hide the badge.
  - `ok:false` → toast the `error` (bad base ref), reset `baseRef` to `""`, retry once vs HEAD.
  - Otherwise render the file list and update the badge to `files.length` (`"500+"` when `truncated`). Keep the previously `selected` path selected if still present; else select the first file.
- **File list** (left rail, `#diffFiles`): one row per file — colored status letter (`A` lime / `M` gold / `D` red / `R` dim), the path (`title` = full path; renames show `old → new`), `untracked` files marked `"new"`. Click → `openDiff(file)`.
- **`openDiff(file)`**: `untracked` → `fetch("/file?p=…")`; `kind:"binary"` → note; else synthesize an all-added model (one hunk, every line `add`). Tracked → `fetch("/git/diff?p=…&old=…&base=…")` → `parseUnifiedDiff` → `pairAndEmphasize`. `binary` → `"Binary file — no diff preview."`. Empty hunks → `"No text changes."` Truncated (either endpoint) → append the `files-empty`-style note `"⚠ Diff truncated for preview."`
- **Rendering** (`renderUnified` / `renderSplit`, chosen by `viewMode`): rows are divs (CSS grid columns), NOT a `<table>`. Unified row = old-number gutter, new-number gutter, code cell; split row = number+code, number+code. The `+`/`-` marker is CSS `::before` on the row class so copied text never contains markers. Code cell content built by `lineSpans(text, em, hits, curHitIdx)`: sort boundary offsets from `em`/`hits`, cut the text into segments, emit `document.createTextNode` or `<span>` with classes `dem` (emphasis), `dhit` (match), `dhit cur` (active match). Hunk boundaries render the `@@ …` header as a full-width `.drow.hunk` separator row. **Render cap: 4000 rows** per file with a `"Show N more rows"` button that re-renders uncapped (the server's 1 MB diff cap bounds the worst case).
- **Toolbar** (`#diffHead`): view toggle button (`Unified ⇄ Split` — re-render only), base-ref input (`placeholder="vs HEAD — type a ref, e.g. origin/main"`, Enter applies → `refreshAll()`), search input + `"n of m"` counter (150 ms debounced `computeMatches` on the open file; Enter / Shift+Enter cycles with wraparound; the active match's element gets `.cur` and `scrollIntoView({block:"center"})`), refresh button (⟳ → `refreshAll()` + reload selected), close button (✕).
- **`onAgentEnd()`** (wired from app.js, like `coopFiles.onAgentEnd`): panel open → `refreshAll()` + reload the selected file; closed → debounced (500 ms, single-flight) badge-only `/git/changes` fetch. Replay bursts after `__hello` therefore collapse to one fetch.
- **`onReset()`** (called on `__hello`): close the panel, clear state and badge (the folder may have changed).
- **Badge**: a `<span class="cnt">` inside `#diffBtn`; hidden when 0 / non-repo / no git.

#### 2.5 SPA wiring — `web/public/app.js`

Two one-line hooks, mirroring the existing `coopFiles` calls:
- `case "agent_end"` (L387–392): after `window.coopFiles.onAgentEnd()`, add `if (window.coopDiff) window.coopDiff.onAgentEnd();`
- `case "__hello"` (L381–384): add `if (window.coopDiff) window.coopDiff.onReset();`
- `refreshState()` (L749–761): add the same `onAgentEnd()` call next to the `coopFiles` one, so a `/chdir` repopulates the badge after 1.5 s.

#### 2.6 Markup + CSS

`web/public/index.html`:
- Toolbar (L13–20): `<button id="diffBtn" class="chip" title="File changes in this folder (git)">± Changes</button>` after `#filesBtn`.
- Inside `#main` (after the `#files` aside): `<div id="diff" hidden>` containing `#diffHead` (controls listed above, all real elements with ids), `#diffFiles`, `#diffBody`.
- Script tags after `/viewer.js`: `<script src="/diff.js"></script><script src="/diffview.js"></script>`.

`web/public/style.css` (brand tokens only; every `display:flex/grid` element with `hidden` gets the `[hidden]{display:none}` override, per the existing pattern):
- `#diff` — overlay covering the content area: `position:absolute; inset:0; background:var(--navy); display:flex; flex-direction:column; z-index:4;` (`#main` gains `position:relative`). Full width is what makes side-by-side viable; toasts (z-index 5) stay on top.
- `#diffFiles` — left rail (240 px, scrollable) + `#diffBody` (flex 1, `overflow:auto`) in a flex row; `.dfile` rows follow `.fnode` styling; status letters `.st.a/.m/.d/.r` colored lime/gold/red/dim.
- Diff rows: `.drow{display:grid; grid-template-columns:48px 48px 1fr; font:12px/1.6 ui-monospace,Consolas,monospace; white-space:pre-wrap; overflow-wrap:anywhere;}`; split variant `grid-template-columns:48px 1fr 48px 1fr`. `.dno` gutters dim, right-aligned, `user-select:none`. Coloring: `.drow.add{background:rgba(123,183,73,.13)}`, `.drow.del{background:rgba(239,65,45,.12)}`; markers `.drow.add .dcode::before{content:"+"}` / `.del …"-"` in the row color. Emphasis `.dem{background:rgba(123,183,73,.35)}` (del side `rgba(239,65,45,.35)`). Search `.dhit{outline:1px solid var(--gold)}`, `.dhit.cur{background:var(--gold); color:var(--navy)}`. `.drow.hunk` — dim, `border-top:1px solid var(--line)`.

#### 2.7 Docs

`web/README.md`: add a "Changes panel" bullet under *What the UI renders* (unified/split, base ref, search, caps: 500 files / 1 MB per diff / 4000 rendered rows, badge refresh on turn end, git-missing + non-repo degradation, and the dotfile-visibility note under the security section). `CHANGELOG.md`: one line under `## [Unreleased]`.

### 3. Files to touch

| File | Change |
|---|---|
| `web/server.mjs` | `runGit` helper, `gitRefOk`, `jailGitPath`, constants (`GIT_MAX_FILES`, `GIT_DIFF_MAX`, `GIT_TIMEOUT_MS`), `GET /git/changes` + `GET /git/diff` routes in the authed-GET block (~L771), two `STATIC` entries (L559) |
| `web/public/diff.js` | NEW — pure model: `parseUnifiedDiff`, `pairAndEmphasize`, `buildSplitRows`, `computeMatches` on `window.coopDiffModel`; no DOM |
| `web/public/diffview.js` | NEW — panel IIFE: overlay, file list, unified/split renderers, search, badge, `window.coopDiff = {onAgentEnd, onReset}` |
| `web/public/app.js` | 3 hook lines: `agent_end`, `__hello`, `refreshState()` |
| `web/public/index.html` | `#diffBtn` chip, `#diff` overlay markup, two script tags |
| `web/public/style.css` | `#diff` overlay layout, `.dfile`, `.drow` grid rows, gutters, add/del/em/hit/hunk classes, badge `.cnt` |
| `tests/webbridge.test.mjs` | git-endpoint section (temp repo fixture, states, jail) |
| `tests/diffmodel.test.mjs` | NEW — Node unit tests for the pure model |
| `tests/run.sh` | one line: `node "$ROOT/tests/diffmodel.test.mjs"` (tests/*.sh are NOT parity-gated — verified against `scripts/check-parity.sh`, which pairs only `scripts/*.sh` + `bin/coop`) |
| `web/README.md`, `CHANGELOG.md` | docs as above |

### 4. Test plan

**`tests/diffmodel.test.mjs`** (pure, no server): `globalThis.window = globalThis; await import(new URL("../web/public/diff.js", import.meta.url));` then `t(...)` assertions in the house style:
- parse a hand-written fixture diff (2 hunks, adds/dels/ctx, `\ No newline at end of file`, a rename header block, CRLF `\r` content) → correct line types, old/new numbering per `@@ -a,b +c,d @@`, `noNewline` flag, `\r` stripped;
- `Binary files a/x and b/x differ` → `binary:true`, no hunks;
- pairing: del-run+add-run pairs by index; a 201-pair block gets no `.em`;
- emphasis: `("const x = 1;", "const x = 2;")` → em range covering only the digit; identical prefix/suffix guard (`"aaa"` vs `"aa"`); >500-char and >0.65-ratio bailouts;
- `buildSplitRows`: 2 dels + 1 add → 2 pair rows, second right cell `null`; hunk separator rows present;
- `computeMatches`: case-insensitive, non-overlapping, document order, empty query → `[]`.

**`tests/webbridge.test.mjs`** — append after the existing `/files` block (order matters; the earlier `/chdir` to `workDir` still holds), before `server.kill()`:
1. Gate: `spawnSync("git", ["--version"])` in the test; if it fails, `console.log("  ~ SKIP git diff endpoint tests (git not installed)")` — the visible-skip pattern already used for symlinks (L306–311).
2. Non-repo: `workDir` has no `.git` → `GET /git/changes` → `{ok:true, git:true, repo:false}`.
3. Fixture repo: `gitDir = mkdtempSync(...)`; run (via `spawnSync`, each with `cwd: gitDir` and `-c user.email=t@t -c user.name=t` on the commit): `git init`, write `a.txt` ("one\ntwo\n") + `b.txt` + `keep/c.txt`, `git add -A`, `git commit -m x`; then modify `a.txt` ("one\nTWO!\n"), delete `b.txt`, create untracked `new.txt`. `POST /chdir {dir: gitDir}` (existing helper), wait 600 ms.
4. `/git/changes` → `repo:true`, files contain `{path:"a.txt", status:"M"}`, `{path:"b.txt", status:"D"}`, `{path:"new.txt", status:"A", untracked:true}`; sorted; `base:"HEAD"`.
5. `/git/changes?base=HEAD` → 200 ok; `/git/changes?base=--evil` and `?base=nope-such-ref` → `{ok:false}` (validation + resolution failure, same shape).
6. `/git/diff?p=a.txt` → `ok:true`, `diff` includes `@@`, `-two`, `+TWO!`. `/git/diff?p=b.txt` → deletion diff (`-` lines). `/git/diff?p=../` + `/git/diff?p=` + `/git/diff?p=.git/config` → **400**.
7. no-HEAD state: fresh `git init` dir with one written file, `/chdir` there → `noHead:true` and the file reported `untracked:true`.
8. git-missing state: spawn a **second** bridge instance (same pattern as L52–56) with `env: {...process.env, PATH: <empty temp dir>, COOP_LAUNCH_SPEC: spec, COOP_WEB_NO_OPEN: "1"}` — the stub pi still starts because `spec.bin` is the absolute `process.execPath`, but `spawn("git")` gets ENOENT → its `/git/changes` returns `{ok:true, git:false}`. Kill it.
9. Auth: `/git/changes` without cookie → 401.

**Verify:** `bash tests/run.sh` (all suites incl. the two new ones) and `bash scripts/check-parity.sh` (must still pass untouched — this feature adds no paired scripts). Manual smoke on a workstation: `coop web` in a real repo; edit a file via the agent; badge updates after the turn; unified/split/search/base-ref all behave; `coop web --cwd` into a non-repo folder shows the friendly empty state.

### 5. Edge cases & failure modes

- **Windows, git absent** → `runGit` ENOENT → `{git:false}` → panel message tells the user to install git; badge hidden; nothing throws. Tested (step 8).
- **Non-repo folder / folder switched mid-view** → `repo:false` empty state; `__hello` → `onReset()` closes the panel so a stale repo's file list never shows over a new folder.
- **CWD is a subdirectory of a repo** → `--relative` (+ `ls-files` cwd behavior) confines both paths and diff content to the working-folder subtree; nothing outside the `/files` jail is ever listed or served.
- **Fresh repo, no HEAD** → everything reported `untracked:true`, rendered as all-added file content via `/file`; avoids the empty-tree sha (which differs in sha256 repos).
- **Renames** (`-M`): `-z` record consumes two path tokens; `/git/diff` receives both `p` and `old` as pathspecs so the old side resolves.
- **Untracked `.env` / hidden files**: untracked rendering goes through `/file`, which already refuses them; ignored files never appear (`--exclude-standard`); `.git`/`node_modules` segments refused everywhere.
- **CRLF working trees**: parser strips one trailing `\r` per content line; the bridge passes diff text through JSON (HTTP body, not JSONL — no framing concern; the JSONL rule at server L129–141 is untouched).
- **Non-ASCII filenames**: `-z` output is never quote-mangled (that's why `-z` everywhere, no `core.quotepath` dependence).
- **Huge diffs**: server cap 1 MB (`truncated` flag + note), render cap 4000 rows + "show more"; 500-file cap with `"500+"` badge.
- **git hangs / repo on slow network drive**: 15 s timeout → friendly `{ok:false,error}`; `GIT_OPTIONAL_LOCKS=0` keeps reads from fighting the agent for the index lock.
- **Concurrent turns / replay bursts**: badge refresh is debounced + single-flight; per-load `gen` counter drops stale async responses (a fast file-click sequence can't interleave renders).
- **Submodule bumps** render as plain context/add/del lines (`Subproject commit …`) — fine.
- **Timing-safe token / Host / cookie**: inherited — the routes sit after the existing gates; both endpoints are read-only GETs so the CSRF header is (correctly, per existing convention) not required.

### 6. Out of scope / deferred (do not gold-plate)

- **Word-level intraline diff** — prefix/suffix trim only; a Myers word diff without jsdiff is real work for marginal gain at this diff size. The bail thresholds keep the cheap version from looking wrong.
- **Gap expansion** (pi-vis ▲/▼ reveal of collapsed context) — we render git's `--unified=3` output with hunk-separator rows; "expand 20 lines" needs full-file content on both sides and gap bookkeeping. Deferred.
- **All-files stacked scroll view, lazy IntersectionObserver loading, scroll-spy, file tree rail** — one file at a time keeps the renderer, search, and caps simple. Deferred.
- **Cross-file search / force-loading idle files** — search covers the open file only.
- **Branches dropdown** (`/git/branches`) — the base-ref text input covers the need; a picker is pure convenience. Deferred.
- **Fingerprint/staleness dot and a cheap `changesCount` endpoint** — the debounced full `name-status` scan after `agent_end` is cheap enough at coop's scale; add the cheap path only if a huge repo proves slow.
- **Split-view per-side selection containment and the <880 px auto-fallback** — copying from split view may grab both sides; acceptable quirk, note it in README. Horizontal scroll handles narrow windows.
- **Syntax highlighting inside diffs** — the Files panel already forgoes it (no-dependency rule); same call here.
- **Worktrees, watching the FS for live badges, `msg.details.diff` (tool-emitted diffs) rendering in the transcript** — separate ideas; the last one would be a natural follow-up but touches the tool-renderer path, not this panel.

### 7. Estimated size & dependencies

**L** — roughly: server.mjs +180 lines, diff.js ~220, diffview.js ~350, style.css ~70, tests ~200. **No dependency on other plan sections beyond M1's registration rule** (this section adds no new pi RPC commands or events, so the protocol contract is untouched); no session-history/extension-ui/multi-session interaction. Other sections that add SPA panels should coordinate only on the shared `#main` overlay z-index and the `onAgentEnd`/`onReset` hook pattern this section establishes.

---

## M3 — Session history & workspace grouping

### 1. Goal & user-visible behavior

The 🕘 History card currently lists only the current folder's sessions, and resuming one backfills a lossy transcript (plain text + bare tool names via `get_messages`). After this change, History shows **every** workspace coop has been used in — current folder first, other folders as collapsible groups — with session names, previews, and relative times, and lets you resume a conversation from *any* folder in one click (coop switches the working folder and resumes together). Resuming now rebuilds the transcript **from the session file itself**: thinking blocks, tool calls with arguments and outputs, and compaction markers are restored in their original order, instead of the flat text the `get_messages` backfill produces today. If the session file encodes multiple conversation branches, a one-line notice says so; a full branch tree is explicitly deferred (see §6).

### 2. Design

#### 2.1 What we verified (do not re-derive)

- Coop's isolated agent dir is `spec.env.PI_CODING_AGENT_DIR` (`~/.coop/agent`). Sessions live at `<agentDir>/sessions/--<cwd with [/\:] → ->--/*.jsonl` — `sessionsDirFor(cwd)` (server.mjs L313) already implements the encoding, and `recentFolders()` (L374) already reads the authoritative `cwd` from each dir's newest file header (the dir name is lossy).
- Session file format (confirmed against a real `~/.coop/agent/sessions/--Users-aaronjennings--/*.jsonl`): line 1 is `{"type":"session","version":3,"id","timestamp","cwd"}` — note the header **has a string `id` of its own but is never referenced as any entry's `parentId`**; the first real entry carries `parentId: null`. Every subsequent entry is `{id: 8-hex, parentId, timestamp, type, ...}`. `type:"message"` nests the body: `entry.message.role` ∈ `user|assistant|toolResult`, `entry.message.content` is a string or an ordered parts array — `{type:"text",text}`, `{type:"thinking",thinking}`, `{type:"toolCall", id, name, arguments}`; toolResult messages carry `toolCallId`, `toolName`, `isError` and text-part content. Other entry types: `session_info {name}`, `compaction {summary, firstKeptEntryId}`, `model_change`, `thinking_level_change`, `branch_summary`, `label`, `custom`, `custom_message`. **The file is a tree**: entries link via `parentId`; branches are real.
- `get_tree` / `navigate_tree` are **not** Pi RPC commands — they exist only in pi-vis's private SDK host (`/tmp/pi-vis/resources/pi-session-host/bridge.mjs`). Over `pi --mode rpc` there is no way to navigate to an arbitrary branch. This is why the tree UI is deferred (§6).
- The polling client (`switchToPolling`, app.js L678–712) advances its cursor with `since = data.next` unconditionally and detects resets only via the `epoch` field. The `/events-poll` handler (server.mjs L706–711) computes `rel = since - historyBase` with no upper bound — so a cursor carried over from a *previous* epoch (larger than the freshly reset history) slices past the end and returns `events: []` while `next` already counts everything recorded since the reset. Any backfill recorded **synchronously** inside `/resume` would therefore be permanently skipped by polling clients. §2.4 fixes this server-side.

#### 2.2 Bridge: new endpoint `GET /history` (server.mjs)

Cookie-authed GET (add after the `/folders` block, following the "Adding a GET endpoint" convention, `baseHeaders("application/json")`). Read-only; touches nothing outside `<agentDir>/sessions`. Response:

```json
{ "groups": [
  { "dir": "/abs/workspace/path", "exists": true, "current": true,
    "sessions": [ { "file": "2026-...jsonl", "mtime": 1751..., "name": "My chat", "preview": "first user msg…" } ] }
] }
```

Implementation — refactor, don't duplicate:

- **`listSessionsIn(dir)`** — extract the body of the current `/sessions` handler (L716–741: readdir `.jsonl`, mtime sort desc, cap 30, `scanSessionFile` for `{name, preview}`, skip empty shells) into a helper. The `/sessions` handler becomes `listSessionsIn(sessionsDirFor(CWD))` and its wire shape is **unchanged** (existing tests keep passing).
- **`listWorkspaceGroups(limit = 12)`** — follows the `recentFolders()` skeleton exactly: enumerate `<agentDir>/sessions` subdirs, sort by dir mtime desc, for each read the newest file's header line via the existing `readHead(path, 8*1024)` to get the true `cwd`, dedupe by cwd, cap at 12 groups. For each group call `listSessionsIn(subdirPath)`, set `exists = statSync(cwd).isDirectory()` (in a try/catch → `false`), and set `current = samePath(cwd, CWD)`. Unlike `recentFolders`, do **not** drop non-existent workspaces — return them with `exists:false` so the UI can show but disable them. Empty groups (no listable sessions) are dropped.
- **`samePath(a, b)`** — small helper next to `sessionsDirFor`: `resolvePath` both sides, compare case-insensitively when `process.platform === "win32"`. This is needed because startup `CWD` is *not* normalized (`let CWD = getArg("--cwd", process.cwd())`, L39 — a relative `--cwd`, trailing separator, or Windows case difference would defeat a naive `===` against the cwd Pi wrote into the session header). The **server** decides which group is current and marks it with `current: true`; the SPA never string-compares paths (§2.5).
- **`scanSessionFile` mtime cache** — `/history` can scan up to 12×30 files at 256 KB head-reads each; add a module-level `const sessionMetaCache = new Map(); // fullPath -> { mtimeMs, meta }` consulted/updated inside `scanSessionFile` (return cached meta when `statSync(fullPath).mtimeMs` matches; bound the Map at 500 entries by evicting the first-inserted key). This mirrors pi-vis's mtime-keyed discovery cache. `/sessions` benefits for free.

Errors degrade per house style: missing agentDir / unreadable dirs → `{groups: []}`, never a 500.

#### 2.3 Bridge: cross-workspace `/resume` (server.mjs L841–857)

Extend the POST body to `{ file, workspace? }`, field-whitelisted:

- `workspace` absent → exactly today's behavior (current folder).
- `workspace` present → must be a string; `target = resolvePath(String(body.workspace).trim())`; gate with `statSync(target).isDirectory()` in try/catch (same gate as `/chdir` L861–867). Then `dir = sessionsDirFor(target)` — the encoding is deterministic forward, so the server re-derives the session dir itself; **never** accept a client-supplied directory name. The existing basename jail stays as-is: `/^[A-Za-z0-9._-]+\.jsonl$/` + `existsSync(full)`; any refusal is the same uniform 400 (`"That conversation could not be found."` — no oracle about *why*).
- On success: `restartPi(target, ["--session", full])` — this both switches the working folder and resumes, reusing all of `restartPi`'s epoch/history/generation machinery. Log line mirrors `/chdir`'s.

#### 2.4 Bridge: file-based transcript backfill (replaces `get_messages` as the primary path)

New synthetic event type **`__replay`** (bridge-prefixed `__`, recorded **and** broadcast so both SSE replay and `/events-poll` see it — same decision as `__message`). **Register `__replay` in M1's `BRIDGE_EVENTS` in `web/protocol.mjs`.** Shapes:

```
{ type:"__replay", kind:"info",       text:"This conversation has other branches — showing the most recent." }
{ type:"__replay", kind:"compaction", summary:"<first 500 chars>" }
{ type:"__replay", role:"user",       text:"…" }
{ type:"__replay", role:"assistant",  parts:[
    { kind:"thinking", text:"…" } | { kind:"text", text:"…" } |
    { kind:"tool", name, args, output, isError } ] }
```

New functions, placed next to `backfillMessages` (L537):

- **`loadSessionTranscript(fullPath)`** → `{ lines: string[], branched: boolean } | null`. Steps:
  1. `statSync(fullPath).size > SESSION_READ_MAX (16 MiB)` → return `null` (caller falls back). Otherwise `readFileSync(fullPath, "utf8")`, split on `"\n"` only, strip one trailing `"\r"` per line, skip blanks, `JSON.parse` per line inside try/catch (bad lines skipped). **Never `node:readline`** (U+2028/U+2029 corruption — same rule as the stdout framer at L129).
  2. Build `Map<id, entry>` over entries that have a string `id` **and whose `type !== "session"`** — the header line has an `id` too, but nothing ever points at it (`parentId: null` on the first real entry), so indexing it would make the header an eternal extra "leaf" and flag *every* session, including strictly linear ones, as branched. With the header excluded: collect the set of ids referenced as some entry's `parentId`; **leaves** = indexed entries not in that set. Active leaf = the leaf with the max timestamp (`Date.parse` for strings, number as-is, unparseable → 0; ties → later file position wins). Walk `parentId` links to the root (a `null`/missing parent terminates), reverse → the active chain. `branched = leaves.length > 1` — which is now `false` for a linear session (exactly one leaf) and `true` only when a real fork exists. (Same heuristic and same documented limitation as pi-vis's `history-loader` v1: after `fork`/tree navigation the max-timestamp leaf may not be Pi's true active leaf — see §5/§7.)
  3. Pre-scan the chain's `toolResult` messages into `Map<toolCallId, {output, isError}>` (`output` = content string, or joined `{type:"text"}.text` parts, **head**-truncated to 6000 chars to match the live `tool_execution_end` cap in app.js L535).
  4. Convert the chain in order: user message → user `__replay` line; assistant message → one `__replay` line whose `parts` walk the content array in order (thinking capped at 8000 chars; toolCall parts joined with their result from step 3 — `args` passed through as-is so the SPA's `formatToolArgs` works); `compaction` entry → compaction line (do **not** trim pre-compaction turns — showing them is the point of reading the file; the marker keeps the context honest); `session_info`/`model_change`/`thinking_level_change`/`label`/`custom`/`custom_message`/`branch_summary`/unknown types → skipped in v1. Skip user/assistant lines that end up with no text and no parts.
  5. If `branched`, prepend the info line. If the chain produced zero user/assistant lines, return `null`.
- **`backfillFromFile(fullPath)`** → runs `loadSessionTranscript`; on non-null, `record()` + `broadcast()` each line (identical loop shape to `backfillMessages` L547–549) and return `true`; on `null`/throw return `false`.

`/resume` becomes: `restartPi(...)`; then `if (!backfillFromFile(full)) backfillMessages();` — the file path is available right there and the read is synchronous (no 12-attempt polling). For the **SSE** transport ordering is automatic: the `__replay` broadcasts land after `restartPi`'s fresh `__hello`. The **polling** transport needs one server-side fix (see §2.1 last bullet): a polling client's cursor from before the reset exceeds the new `historyBase + history.length`, so today's slice would return `[]` while advancing `next` past the synchronously-recorded backfill — the client would reset its transcript on the epoch bump and then *skip the entire replay*. Fix in the `/events-poll` handler: a `since` greater than `historyBase + history.length` can only be a cursor from a previous epoch (`next` never exceeds that total within an epoch), so clamp `rel` to 0 in that case — `const total = historyBase + history.length; const rel = since > total ? 0 : Math.max(0, since - historyBase);` — and the stale-cursor poll delivers the new epoch from its beginning, `__replay` lines included. (This also retroactively fixes the same latent skip for fast `get_messages` backfills and `/chdir` startup dialogs; the SSE path is untouched.) `backfillMessages` (get_messages) is **kept unchanged** as the fallback for oversized/corrupt files. `HISTORY_MAX` (4000) still bounds replay — one line per turn means even very long conversations fit, but the earliest turns of a pathological one can still evict (documented in README).

#### 2.5 SPA (app.js)

- **`case "__replay"`** in `handle(evt)` (next to `__message`, L426), using the standard `atBottom()`/`stick(was)` idiom. `kind:"info"` and `kind:"compaction"` → a `.divider` element (`textContent` only; compaction shows `♻ compacted — <summary>`). `role:"user"` → `userBubble(evt.text)` (which already strips `<coop-viewing-context>`). `role:"assistant"` → iterate `parts`: `thinking` → a **closed** `<details class="thinking">` with `summary "✦ thinking"` and the text via `textContent`; `text` → `bubble("assistant", text)` (markdown pipeline); `tool` → a closed `<details class="toolblock">` — summary `✓/✗ + name + toolHint(args)`, body `pre.tool-args` = `formatToolArgs(args)` and `pre.tool-out` = output (all existing helpers: `bubble` L100, `toolHint` L173, `formatToolArgs` L183, `userBubble` L218). All text through `textContent`/`esc()` — CSP-clean, no inline styles.
- **History card rework** (`$("#historyBtn").onclick`, L810): fetch `GET /history` instead of `/sessions`. Split groups on the server-computed `group.current` flag (**never** a client-side `dir === currentCwd` string compare — the server normalizes both sides via `samePath`, §2.2, so trailing separators / relative `--cwd` / Windows case differences can't demote the current folder to a collapsed group): the current group's sessions render exactly as today (buttons with `relTime(sess.mtime)` `.prov` badges → `POST /resume {file}`); every other group renders as a `<details class="hist-group">` whose `<summary>` is the folder path + session count, containing the same button rows but posting `/resume {file, workspace: group.dir}`. Groups with `exists:false` render their buttons `disabled` with `title = "This folder no longer exists on disk."`. Empty response → keep the current "No previous conversations…" toast. The "✎ Name current chat" / Cancel row is unchanged. On a cross-workspace resume success the transcript resets via the bridge's fresh `__hello` (which carries the new `cwd` → `setCwd`), plus the existing `setTimeout(refreshState, 1500)`.
- `post()`/`rpc()` helpers and the CSRF header are already in place; the resume fetch keeps `x-coop-csrf: 1`.

#### 2.6 style.css

Three additions using existing tokens: `.divider` (centered, `--dim`, small, subtle top/bottom margin — used by compaction/info markers), `details.hist-group` + `summary` (panel bg, `--line` border, monospace path, pointer cursor), and `button[disabled]` affordance inside `.hist-group` if not already covered. No inline styles anywhere.

#### 2.7 Docs

`web/README.md`: update the 🕘 History bullet (grouped by folder, cross-folder resume), and the "Backfilled transcripts…" limitation bullet (now: full detail restored from the session file — thinking, tool arguments/outputs, compaction markers; `get_messages` text-only backfill remains the fallback; ~4000-event replay bound unchanged; note the most-recent-branch heuristic).

### 3. Files to touch

| File | Change |
|---|---|
| `/Users/aaronjennings/Developer/coop-agent/web/server.mjs` | Extract `listSessionsIn(dir)` from the `/sessions` handler; add `sessionMetaCache` to `scanSessionFile`; add `samePath()`; add `listWorkspaceGroups()` (with `current`/`exists` flags); add `GET /history`; extend `POST /resume` with whitelisted `workspace` (dir-exists gate + server-derived `sessionsDirFor`); add `SESSION_READ_MAX`, `loadSessionTranscript()` (header excluded from leaf computation), `backfillFromFile()`; `/resume` calls file backfill with `backfillMessages()` fallback; **`/events-poll`: clamp a stale cross-epoch cursor (`since > historyBase + history.length`) to `rel = 0`**. |
| `/Users/aaronjennings/Developer/coop-agent/web/protocol.mjs` | Add `"__replay"` to `BRIDGE_EVENTS` (M1 registration rule). |
| `/Users/aaronjennings/Developer/coop-agent/web/public/app.js` | Add `case "__replay"` renderer (divider / user / assistant parts incl. thinking + tool details); rework `#historyBtn` card to consume `/history` with per-workspace groups keyed on `group.current` and `{file, workspace}` resume. |
| `/Users/aaronjennings/Developer/coop-agent/web/public/style.css` | `.divider`, `details.hist-group` (+ summary), disabled-button styling. |
| `/Users/aaronjennings/Developer/coop-agent/web/README.md` | History/replay behavior + bounds kept in sync. |
| `/Users/aaronjennings/Developer/coop-agent/tests/webbridge.test.mjs` | New fixtures + assertions (§4). |
| `/Users/aaronjennings/Developer/coop-agent/tests/stub-pi.mjs` | **No change expected** — its canned `get_messages` branch stays to exercise the fallback path. |

No `bin/coop` / `scripts/*.sh` / `.ps1` changes — web/ + tests/ only, so no parity burden (check-parity must still pass untouched).

### 4. Test plan (tests/webbridge.test.mjs — flat script, order-sensitive)

**Fixtures** (extend the existing block at L27–50; keep the `encoded` mirror of server L316):

1. Enrich `FAKE_SESSION` (current cwd's dir) into a full v3 tree that mirrors the real file shape: header line `{"type":"session","version":3,"id":<uuid>,"timestamp",cwd: process.cwd()}` with **no `parentId` key** (headers are never parented — the parser must not count it as a leaf), `session_info {name:"My old chat"}`, user entry (`id:"u1"`, `parentId:null`) whose text **stays `"hello from the past"`** — the existing `/sessions` assertion at L243 requires `preview.includes("hello from the past")` and must keep passing unmodified — assistant entry (`id:"a1", parentId:"u1"`) whose content is `[{type:"thinking",thinking:"pondering deeply"},{type:"toolCall",id:"tc1",name:"read",arguments:{path:"notes.md"}}]`, toolResult entry (`id:"t1", parentId:"a1"`, `message:{role:"toolResult", toolCallId:"tc1", content:[{type:"text",text:"tool output payload"}]}`), final assistant text entry (`id:"a2", parentId:"t1"`, text `"rich old answer"`, latest timestamp), **plus a stale branch leaf** (`id:"b1", parentId:"u1"`, older timestamp) so `branched` is true. Give every non-header entry a `parentId` key (`null` at the root) + ISO timestamps.
2. `FALLBACK_SESSION` in the same dir: valid header + `session_info` + **garbage non-JSON lines only** (no parseable turns), so `loadSessionTranscript` yields zero user/assistant lines → `backfillFromFile` returns false → the stub's canned `get_messages` ("old question"/"old answer"/`sql_review`) proves the fallback.
3. `WORK_SESSION` in a second encoded dir for `workDir` (same encoding expression) with header `cwd: workDir` (no `parentId`), a name, and one **strictly linear** user+assistant turn (`parentId:null` → chained) — the cross-workspace group *and* the linear-session control for the branch heuristic.

**Assertions** (insert after the current `/folders` block, before `/chdir`; adjust the existing `/resume` block):

- `GET /history` → 200; `groups` is an array; **exactly one group has `current === true`** and it contains `FAKE_SESSION` with `name === "My old chat"`; a second group with `dir === resolvePath(workDir)`, `current === false`, and `exists === true` contains `WORK_SESSION`. `/history` without cookie → 401.
- Existing `/resume` jail test (`../evil.jsonl` → 400) unchanged; add `POST /resume {file: FAKE_SESSION, workspace: join(ROOT,"no-such-dir")}` → 400 and `{file: FAKE_SESSION, workspace: outside}` → 400 (real dir, but no session dir derives → uniform 400).
- **Stale-cursor poll (the polling-transport regression guard):** before resuming, `GET /events-poll?since=0` and save `pre = poll.next`. `POST /resume {file: FAKE_SESSION}` → 200; then poll **with the stale pre-resume cursor** `GET /events-poll?since=${pre}` → epoch differs from the pre-resume epoch **and** `events` include the `"__replay"` lines carrying `"pondering deeply"` (thinking), `"tool output payload"` (tool result), `"rich old answer"`, and the branch `kind:"info"` line (FAKE_SESSION has a real second leaf). Also poll `since=0` and assert the same content (SSE-replay view). Neither poll waits 900 ms for get_messages — file backfill is synchronous; a short 300 ms settle is enough.
- `POST /resume {file: FALLBACK_SESSION}` → 200; after ~900 ms, poll shows `__message` lines with `"old question"`/`sql_review` (fallback path alive).
- Cross-workspace: `POST /resume {file: WORK_SESSION, workspace: workDir}` → 200; poll shows `cwd === resolvePath(workDir)` and the `WORK_SESSION` `__replay` content — **and asserts there is NO `kind:"info"` `__replay` line** (WORK_SESSION is strictly linear; one leaf ⇒ not branched — this is the false-positive guard for the header-as-leaf bug). **Order note:** run this immediately before the existing `/chdir → workDir` block — that block re-chdirs to the same target and its assertions (fresh startup dialog, `/files` against workDir) remain valid.

**Verify:** `node tests/webbridge.test.mjs` for the tight loop, then `bash tests/run.sh` and `bash scripts/check-parity.sh` (both must pass; parity is untouched but gated). Do not commit/push/tag — working tree only.

### 5. Edge cases & failure modes

- **Windows:** all fixture/session paths built with `join()`; the cwd encoding already folds `\` and `:` (server L316) and the tests mirror it, so `C:\Users\…` round-trips. Encoded dir names may contain spaces (real path segments keep them) — never regex-restrict the *subdir* name; the server derives it via `sessionsDirFor`, only the file **basename** is regex-jailed. `samePath` compares case-insensitively on win32 so the current-group flag survives `c:\` vs `C:\`. `statSync` existence gates behave identically. Reading a session file Pi has open works (Pi opens with shared read); a torn final line fails `JSON.parse` and is skipped, matching `readHead`'s tolerance.
- **Branch-pick heuristic:** the header line is excluded from the leaf computation (it has an `id` but no child ever references it — counting it would flag every linear session as branched), so `branched` fires only on a genuine second leaf. Remaining limitation: after `fork`/tree navigation, the max-timestamp leaf may differ from Pi's true active leaf, so the backfilled transcript can show a different branch than Pi continues from. Mitigation is the honest info divider; full reconciliation via `get_messages` cross-check is deferred (§6).
- **Polling clients across the resume reset:** a poll cursor minted before `restartPi` exceeds the reset `historyBase + history.length`; without the §2.4 clamp the synchronous `__replay` backfill would be silently skipped (empty transcript after resume on the polling transport). The clamp treats an over-the-end `since` as a previous-epoch cursor and replays the new epoch from 0; the guard test in §4 polls with the stale cursor on purpose.
- **Oversized / corrupt / empty files:** `> 16 MiB`, unreadable, or zero-turn parses fall back to `backfillMessages()`; if that also never answers, the existing stderr log line fires — the session still resumes, only the backfill is missing. Uniform 400s on every `/resume` refusal (no jail-vs-missing oracle).
- **Deleted workspaces:** groups render disabled (`exists:false`); `/resume` with a vanished `workspace` → 400 (dir gate), never a crashed `restartPi` into a missing cwd.
- **Replay bound:** `__replay` lines live in the same 4000-entry ring; monster sessions evict their earliest turns on reconnect-replay — unchanged contract, README documents it.
- **`/history` cost:** worst case ~12×30 head reads, amortized by the mtime cache; fired only on click, never polled.
- **Security:** every new surface is cookie-authed behind `hostOk`; `/resume` keeps CSRF + field whitelisting; all reads stay inside `<agentDir>/sessions` via server-derived paths + basename regex; nothing is ever written to the sessions dir.

### 6. Out of scope / deferred (deliberately)

- **Conversation-branch tree UI (pi-vis `components/tree/`)** — deferred. Verified: `get_tree`/`navigate_tree`/`set_label` are implemented only in pi-vis's private SDK host (`resources/pi-session-host/bridge.mjs`), not in Pi 0.80's `--mode rpc`, and the bridge is forbidden from importing the Pi SDK. We could render a read-only tree from `parentId` links, but with no RPC way to *navigate* to a branch it would be a dead-end widget. Ship the one-line "has other branches" notice now; revisit if a future Pi exposes tree commands over rpc (then: flat-node endpoint + a port of pi-vis's `flattenVisible` branch-only-indent algorithm).
- **Exposing `fork` / `switch_session` RPC** — real Pi RPC commands, but a UX built on them belongs with the (deferred) tree/multi-session work, not here.
- **Rendering `custom_message`/`branch_summary`/`label` entries, edit diffs (`details.diff`) in tool outputs, and images** in backfill — skipped in v1; the raw data survives in the file.
- **Archived/pinned sessions, worktree grouping, `lastActiveAt` sorting** (pi-vis settings-backed features) — coop-web has no settings store; mtime sorting is good enough for v1.
- **Raising `HISTORY_MAX`** for giant resumed sessions — don't; it's a memory bound shared by all features. Noted as an open question instead.
- **Live enumeration of the *current* in-flight session** in `/history` — the current conversation is already on screen; skip.

### 7. Size & dependencies

**Size: M** (~260 lines bridge, ~150 lines SPA, ~130 lines tests; no parity burden since only `web/` + `tests/` change). **Dependencies:** none blocking beyond M1. Coordinates with **M1 protocol-contract** (register `__replay` in `BRIDGE_EVENTS`, and note the `/events-poll` stale-cursor clamp as part of the polling contract) and with **M5 multi-session** (its workspace grouping should build on `listWorkspaceGroups`/`GET /history` rather than reinvent; when it reshapes `restartPi`, the `/resume` extension here rides along). Independent of M2 diff-viewer and M4 extension-ui.

---

## M4 — Extension UI bridging breadth

### 1. Goal & user-visible behavior

coop-web already renders extension dialogs (`select`/`confirm`/`input`/`editor` → `uiCard`) and `notify` toasts, but silently drops every other extension-UI method on the Pi 0.80.x RPC wire: `setStatus`, `setWidget`, `setTitle`, `set_editor_text`, and any unknown method (the dead `// setStatus/setWidget/setTitle: not rendered` branch at `app.js:548`). After this change, extension status segments and widgets render in a slim "extension dock" above the composer, `setTitle` updates the browser tab title, `set_editor_text` prefills the composer, multi-line `notify` messages (coop-guardrails emits one at `extensions/coop-guardrails/index.ts:409`) keep their line breaks, and any *unknown* method renders a deduplicated fallback card with the raw JSON and a Dismiss button — so nothing an extension sends is ever silently dropped again.

Grounding (verified in this repo): coop's three loaded extensions emit, over the RPC wire, only `notify` (all three), `confirm` (coop-guardrails, coop-tools), `input`/`select` (coop-tools). coop-powerline's `setHeader`/`setFooter`/`setWorkingMessage`/`setWorkingIndicator` are TUI **callback** APIs (they take render functions), are `typeof`-guarded in the extension, and never cross the RPC wire. So `setStatus`/`setWidget`/`setTitle`/`set_editor_text` renderers are cheap forward-compatibility for core Pi and third-party extensions in `~/.coop/agent` (e.g. pi-hermes-memory, pi-better-openai) — keep them minimal; the fallback card is the real safety net.

### 2. Design

#### 2.1 Wire inventory (complete method set, Pi 0.80.x `extension_ui_request`)

All requests are `{type:"extension_ui_request", id: string, method: string, ...}`; responses (dialogs only) are `{type:"extension_ui_response", id}` plus exactly one of `value: string` / `confirmed: boolean` / `cancelled: true`, already relayed field-whitelisted by `POST /ui-response`. This inventory matches M1's `UI_METHODS` list in `web/protocol.mjs` — the two must stay in sync (unknown methods are drift-flagged by M1 and fallback-rendered by this milestone; both behaviors are correct and complementary).

| method | fields | coop-web today | this plan |
|---|---|---|---|
| `select` | `title, options[], timeout?` | `uiCard` | unchanged |
| `confirm` | `title, message?` | `uiCard` | unchanged |
| `input` | `title, placeholder?` | `uiCard` | unchanged |
| `editor` | `title, prefill?` | `uiCard` | unchanged |
| `notify` | `message, notifyType?` | `toast()` / `maybeUsage()` | keep; CSS fix so `\n` renders as line breaks |
| `setStatus` | `statusKey, statusText?` — **absent `statusText` = delete segment** (JSON omits `undefined`) | dropped | ext dock segment, keyed |
| `setWidget` | `widgetKey, widgetLines?: string[], widgetPlacement?` — absent `widgetLines` = delete | dropped | ext dock widget, keyed; `widgetPlacement` ignored |
| `setTitle` | `title` | dropped | `document.title` |
| `set_editor_text` | `text` | dropped | composer prefill (live-only) |
| *anything else* | unknown | dropped | fallback card, deduped per method |

#### 2.2 Bridge (`web/server.mjs`) — one line + comments

The bridge already does almost everything needed: `handlePiLine` forwards `extension_ui_request` verbatim, `record()` stamps `uiId`/`uiMethod`, and `replayable()` (L215–219) skips only `notify` and answered dialogs — so `setStatus`/`setWidget`/`setTitle` events **already replay in order** on SSE reconnect (`/events`, L695–697) and are delivered/filtered identically on the polling path (`/events-poll` applies `replayable` at L709). Replaying the keyed events in order reconstructs the dock state client-side; no bridge-side state map is needed.

The single behavioral change: add to `replayable()`:

```js
if (entry.uiMethod === "set_editor_text") return false; // composer injection is live-only — replaying it would clobber the user's draft
```

Also update the comment block at L163–167 to name the new replay semantics. **No new endpoints, no `RPC_ALLOWED` change, no auth-surface change.** The unknown-method Dismiss button reuses `POST /ui-response` with `{id, cancelled: true}`; the existing handler already whitelists `cancelled` and marks `answeredUi` (L792), so a dismissed fallback card is not replayed — machinery works unmodified for unknown methods.

#### 2.3 SPA (`web/public/app.js`)

New module-level state (mirrors the existing `tools` Map pattern):

```js
const extStatus = new Map();   // statusKey -> statusText
const extWidgets = new Map();  // widgetKey -> widgetLines[]
const extUnknown = new Map();  // method -> { card, pre, count, countEl }
```

**`stripAnsi(s)`** — extensions format for a terminal; we render plain text (no ANSI colorizer in v1). Regex, applied before any `textContent` assignment in the dock:

```js
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const stripAnsi = (s) => String(s).replace(ANSI_RE, "");
```

(CSI sequences incl. SGR colors, OSC sequences with BEL or ST terminator, single-char escapes.)

**`renderExtDock()`** — rebuilds `#extDock` (new element, §2.4) from scratch each call (dock is tiny; O(n) rebuild is the simple-correct choice and is idempotent for replay bursts):
- If both maps are empty: `dock.hidden = true`, clear children, return.
- Else `dock.hidden = false`; for each `[key, text]` of `extStatus` sorted by key (stable order, pi-vis parity), a `div.ext-status` containing one `div.ext-line` per `text.split("\n")` line, `textContent = stripAnsi(line)`, `title = key`.
- Then for each `[key, lines]` of `extWidgets` sorted by key, a `div.ext-widget` with one `div.ext-line` per array element, same escaping.
- All DOM via `createElement`/`textContent` — CSP-clean, no `innerHTML`.

**Dispatcher** — replace the dead branch in `case "extension_ui_request":` (app.js:542–548) with:

```js
} else if (evt.method === "setStatus") {
  if (typeof evt.statusText === "string") extStatus.set(String(evt.statusKey), evt.statusText);
  else extStatus.delete(String(evt.statusKey));   // absent = clear (JSON omits undefined)
  renderExtDock();
} else if (evt.method === "setWidget") {
  if (Array.isArray(evt.widgetLines)) extWidgets.set(String(evt.widgetKey), evt.widgetLines.map(String));
  else extWidgets.delete(String(evt.widgetKey));
  renderExtDock();
} else if (evt.method === "setTitle") {
  document.title = evt.title ? `${evt.title} — coop` : "coop";
} else if (evt.method === "set_editor_text") {
  input.value = String(evt.text ?? "");           // live-only: bridge never replays this
  input.dispatchEvent(new Event("input"));        // reuse the existing auto-grow listener
} else {
  extFallbackCard(evt);                           // unknown method — never drop silently
}
```

**`extFallbackCard(req)`** — generic fallback, deduplicated per method so a chatty future fire-and-forget method can't spam the transcript:
- If `extUnknown.has(req.method)`: update the stored `pre.textContent = JSON.stringify(req, null, 2)`, bump `count`, set `countEl.textContent = \`seen ${count}×\``. Return (no new card).
- Else build a `.card.ext-unknown` following the `uiCard`/`reviewCard` idiom (`const was = atBottom()` … `stick(was)`): `h3` = `Extension UI: ${req.method}`; optional `p` = `req.title || req.message`; a collapsed `<details>` ("Raw request" summary + `pre` of the pretty JSON); a `.row` with a `.ghost` "Dismiss" button. Dismiss disables controls (the `done()` closure pattern), calls the existing `respond(req.id, { cancelled: true })` — safe because pi ignores responses to non-pending ids, and it unblocks the extension if the unknown method *was* a dialog — removes the card, and `extUnknown.delete(method)`. Dismissing also stops replay (bridge `answeredUi`).
- Store `{card, pre, count: 1, countEl}` in `extUnknown`.

**`resetTranscript()`** (app.js:369) additions: `extStatus.clear(); extWidgets.clear(); extUnknown.clear(); renderExtDock(); document.title = "coop";` — new session / chdir / resume starts clean; replay then reconstructs current state.

`maybeUsage` interception of `notify` is untouched and stays first in the `notify` branch.

#### 2.4 `web/public/index.html`

One new element inside `<footer>`, before `.composer`:

```html
<div id="extDock" hidden></div>
```

#### 2.5 `web/public/style.css`

Using existing tokens only:
- `#extDock` — `border-top: 1px solid var(--line); background: var(--navy2); color: var(--dim); font-family: ui-monospace,Consolas,monospace; font-size: 12px; padding: 4px 16px; max-height: 120px; overflow-y: auto;` centered to the composer's 820px column (match `.composer` max-width/margin).
- `#extDock[hidden] { display: none; }` — required per the recurring `[hidden]` override convention.
- `.ext-line { white-space: pre-wrap; }`; `.ext-widget { color: var(--ink); }` to distinguish widgets from status segments.
- `.toast { white-space: pre-line; }` — makes coop-guardrails' multi-line notify render its lines (today `textContent` collapses `\n` visually).
- `.card.ext-unknown` needs no new rules (inherits `.card`); add `.card.ext-unknown pre { overflow-x: auto; }` if not already covered.

#### 2.6 `web/README.md`

Document the extension dock (what renders there, ANSI stripped, cleared on new chat/folder switch), the fallback card, and the replay bounds caveat (state older than the ~4000-event ring is lost on reconnect).

### 3. Files to touch

| file | change |
|---|---|
| `web/server.mjs` | `replayable()`: add `set_editor_text` skip + updated comment block (L163–167, L215–219). Nothing else. |
| `web/public/app.js` | New state maps, `stripAnsi`, `renderExtDock`, `extFallbackCard`; extend the `extension_ui_request` dispatcher branch; extend `resetTranscript()`. |
| `web/public/index.html` | `#extDock` div in the footer. |
| `web/public/style.css` | Dock styles + `[hidden]` override, `.ext-line`, `.toast { white-space: pre-line }`. |
| `web/README.md` | Document the dock, fallback card, replay bounds. |
| `tests/stub-pi.mjs` | Startup emissions for `setStatus`/`setWidget`/`setTitle`/`set_editor_text`/unknown method; a `clear-status` prompt trigger. |
| `tests/webbridge.test.mjs` | New assertions (§4). |

No `bin/coop` / `scripts/*.sh` / `.ps1` changes → **zero parity burden**.

*(Note for the M1 drift-count assertion: the stub's new `holo_display` emission is an unknown `UI_METHODS` value and will register as one deduped drift line — recount the suite's final `protocol drift` N accordingly when this milestone's stub changes land.)*

### 4. Test plan

**Stub additions** (`tests/stub-pi.mjs`), after the existing startup `notify` (L14):

```js
out({ type: "extension_ui_request", id: "stub-status-1", method: "setStatus", statusKey: "stub", statusText: "stub status \x1b[32mgreen\x1b[0m" });
out({ type: "extension_ui_request", id: "stub-widget-1", method: "setWidget", widgetKey: "w1", widgetLines: ["line one", "line two"] });
out({ type: "extension_ui_request", id: "stub-title-1", method: "setTitle", title: "Stub Title" });
out({ type: "extension_ui_request", id: "stub-editor-1", method: "set_editor_text", text: "prefilled" });
out({ type: "extension_ui_request", id: "stub-mystery-1", method: "holo_display", title: "unknown method" });
```

In the `prompt` branch, before the echo: `if (cmd.message === "clear-status") out({ type: "extension_ui_request", id: "stub-status-2", method: "setStatus", statusKey: "stub" });` (no `statusText` — exercises the delete-on-absent contract end-to-end).

**Bridge assertions** (`tests/webbridge.test.mjs` — flat `t(name, ok)` style; note the existing suite tests the *bridge*, not the DOM; place these near the existing replay tests before the `/resume`–`/chdir` state-dependent sequence so ordering assumptions hold):

1. Initial SSE replay contains `setStatus`, `setWidget`, and `setTitle` requests (`events.some(e => e.method === "setStatus")` etc.) — stateful methods are replayable.
2. `set_editor_text` is **not** replayed (mirrors the existing "notify toasts are NOT replayed" test at L148).
3. Unknown method `holo_display` **is** replayed; then `post("/ui-response", { id: "stub-mystery-1", cancelled: true })`, reconnect, assert it is **no longer** replayed (fallback-card Dismiss path works with unmodified `answeredUi` machinery).
4. `GET /events-poll?since=0` includes `setStatus` but excludes `set_editor_text` and `notify` (poll path shares the filter, server.mjs:709).
5. Live delivery of the clear: `post("/prompt", { message: "clear-status" })`, `readSse(...)` window, assert a frame with `method === "setStatus"`, `statusKey === "stub"`, and **no** `statusText` property arrives.

**Verify commands** (all must pass, plus a manual smoke since app.js has no automated harness — consistent with the existing suite):

```bash
for f in bin/coop lib/common.sh scripts/*.sh tests/*.sh; do bash -n "$f"; done
bash scripts/check-parity.sh   # expect: ✓ parity check passed (nothing paired was touched)
bash tests/run.sh              # expect: ✓ all tests passed
```

Manual smoke (workstation): `coop web`, confirm dock hidden by default, toasts from coop-guardrails' `/guardrails` summary show line breaks, dialogs still answer, New chat clears the dock and resets the title.

### 5. Edge cases & failure modes

- **Delete-on-absent contract**: `statusText`/`widgetLines` set to `undefined` extension-side is *omitted* from the JSON line — the SPA must key off `typeof evt.statusText === "string"` / `Array.isArray(evt.widgetLines)`, never `"statusText" in evt` semantics alone. Malformed values (non-string text, non-array lines) coerce or delete — swallow-and-degrade per repo convention, never throw in `handle()`.
- **Replay bursts**: after `__hello`/epoch reset the client replays up to 4000 events; every dock handler is an idempotent map set/delete followed by a full rebuild, so order-correct replay reconstructs exact current state. A `setStatus` evicted from the ring (older than ~4000 events) is lost on reconnect → a stale segment silently disappears. Bounded, documented in README; the `__hello`-seeding fix is deferred (§6).
- **Polling transport**: `/events-poll` filters *all* events through `replayable()`, so polling clients never receive `notify` today and will never receive `set_editor_text` — pre-existing behavior for `notify`, and acceptable for a cosmetic prefill. Stateful methods flow normally.
- **Unknown fire-and-forget spam**: per-method dedupe means a hypothetical `setProgress` firing 10×/s updates one card's JSON instead of appending 600 cards/minute.
- **Dismissing a fire-and-forget unknown**: sends `extension_ui_response` for an id pi isn't awaiting — pi drops responses with no pending resolver; harmless, and it unblocks the extension if the method *was* dialog-like.
- **`set_editor_text` vs user draft**: applied unconditionally on live events (matches TUI semantics — the extension explicitly replaces editor text); the bridge's replay skip guarantees a page refresh can't clobber a draft.
- **ANSI**: stripped, not rendered — powerline-style truecolor sequences become plain text, never leak escape bytes into the DOM. OSC hyperlink sequences are also stripped by the regex.
- **Windows**: no platform-sensitive code (pure DOM + one bridge line); works identically under msedge `--app` and the PowerShell launch path; no path handling involved.
- **CSP**: all new DOM via `createElement`/`textContent`; the only style mutation is the existing-pattern `hidden` toggle. No inline styles, no `innerHTML` with unescaped input.
- **Security**: no new endpoints; no new fields cross `/ui-response` (Dismiss uses the already-whitelisted `cancelled`); the browser still cannot relay arbitrary RPC.

### 6. Out of scope / deferred

- **ANSI color rendering** (pi-vis's `AnsiText` span parser): deferred — no coop extension sends colored status/widgets over the wire today; a vanilla ANSI-SGR-to-span parser is ~100 lines of new attack-surface for zero current payoff. Strip-to-plain-text is honest v1.
- **`ctx.ui.custom()` panels / unified TUI** (`panel_open`/`panel_data` xterm surfaces): these are **pi-vis SessionHost events, not Pi RPC events** — they require importing Pi as an SDK, which violates the dumb-pipe rule outright. Permanently out of scope for the bridge; a raw `pi --mode rpc` process never emits them.
- **`__hello` state seeding** (bridge-side `statusSegments`/`widgets` maps included in `__hello` and poll responses to survive ring eviction): deferred — meaningful only for >4000-event sessions with reconnects, and it changes the `__hello`/poll wire shape, which the protocol-contract machinery (M1) and the multi-session envelope (M5) would own if it ever lands.
- **`widgetPlacement`** honoring and per-widget ordering beyond key sort: single dock location is enough for v1.
- **Select-dialog `timeout` countdown UI**: pi resolves the default itself on timeout; the existing `uiCard` behavior (card stays until answered/replay-filtered) is unchanged. Do not send `cancelled` on a client-side timer.
- **Toast history bell / stacked-pile visuals** (pi-vis `NotificationStack`): gold-plating; the 6s toast + the multi-line CSS fix covers coop's actual notify usage.
- **Per-session scoping of dock state**: state is module-level like all other app.js state; when M5 lands, it must move `extStatus`/`extWidgets`/`extUnknown` into its per-session reset path along with `tools`/`current`/etc. (the `resetTranscript()` additions in §2.3 already cover this if M5's `switchChat` calls `resetTranscript()` — verify during M5 Stage 1).

### 7. Estimated size & dependencies

**S** (~150 lines app.js, ~20 lines CSS/HTML, 1 line server.mjs, ~60 lines tests). No hard dependency on other sections beyond M1 (whose `UI_METHODS` already lists all methods in §2.1's table); M5 must re-scope the three new maps per session. Safe to implement in parallel with M2/M3.

---

## M5 — Multiple parallel sessions (+ optional worktree isolation)

> **Sequencing: implement this section LAST.** It refactors the bridge's core state, so every other section's endpoints must already exist (they get folded into the session objects in Stage 1). Worktree isolation is **assessed and deferred** — see "Out of scope" for the reasoning.

### 1. Goal & user-visible behavior

coop web today runs exactly one governed pi subprocess; starting a second conversation means abandoning the first. After this change the header gains a **tab strip**: each tab is an independent chat with its own governed `pi --mode rpc -a` subprocess, its own working folder, its own transcript/model/thinking level, and its own Files panel view. Background tabs keep streaming (a busy dot pulses; an unread dot appears when a background turn finishes), and one tab's agent crashing shows a crash card in that tab only — the other tabs and the bridge keep running. Concurrency is capped (default 4 chats) and the security model is unchanged: one user, one token, one cookie, everything still on 127.0.0.1.

### 2. Design

The work lands in **three stages**. Stage 1 is a pure internal refactor that must leave the wire protocol and the existing test suite byte-for-byte green. Stage 2 changes the wire protocol and ships the UI. Stage 3 (worktrees) is deferred.

#### 2.1 Stage 1 — bridge refactor: singleton → chat objects (n = 1, zero wire-protocol and test-visible change)

Stage 1 changes nothing the wire protocol or the existing test suite can observe. It does make **three deliberate crash-semantics changes** that are externally visible only when a pi child dies (a path the current suite never exercises): (a) the bridge no longer `process.exit`s when a pi child exits, (b) `child.on("error")` (spawn failure) routes to `chatDied` instead of `process.exit(1)`, and (c) `__fatal` becomes recorded/replayable instead of broadcast-only. These are the whole point of multi-chat crash containment and are specified under `chatDied` below; everything else must be behavior-identical.

All per-conversation module-level state in `web/server.mjs` moves into a **chat object**. Today that state is: `pi` (L106), `stderrTail` (L107), `busy` (L178), `history`/`historyBase`/`resetEpoch`/`answeredUi` (L168–176), `pendingRpc` (L195), and the mutable `CWD` (L39).

```js
// --- chat registry -----------------------------------------------------------
const MAX_CHATS = Math.max(1, Math.min(8, Number(process.env.COOP_WEB_MAX_CHATS) || 4));
let chatSeq = 0;
const chats = new Map(); // sid -> chat
function makeChat(cwd, extraArgs = []) {
  const chat = {
    sid: `c${++chatSeq}`,
    cwd,                    // per-chat working folder (replaces global mutable CWD)
    child: null,            // current pi child — generation-checked like today
    busy: false,
    history: [],            // ring buffer, same {line, uiId?, uiMethod?} entries
    historyBase: 0,
    resetEpoch: 0,
    answeredUi: new Set(),
    pendingRpc: new Map(),  // id -> {resolve, timer} — per chat so a restart fails only its own waiters
    stderrTail: "",
    status: "running",      // "running" | "exited"
    createdAt: Date.now(),
  };
  chat.child = spawnPi(cwd, extraArgs);
  wireChat(chat, chat.child);
  chats.set(chat.sid, chat);
  return chat;
}
```

Stage 1 also introduces the single choke point for recorded events — every site that records an event broadcasts it through this helper, never by calling `record` + `broadcast` separately:

```js
// The ONLY way to broadcast a recorded event. In Stage 1 this is pure plumbing
// (same bytes on the wire); in Stage 2 it becomes the only place that computes
// the global event number n (§2.2), so no recorded frame can ever miss its
// dedupe cursor.
function recordAndBroadcast(chat, rawLine, evt) {
  record(chat, rawLine, evt);
  broadcast(chat, rawLine); // Stage 2: broadcast(chat, rawLine, chat.historyBase + chat.history.length - 1)
}
```

Function-by-function refactor (rename + parameterize; keep the bodies and their "why" comments):

| Today | Becomes | Notes |
|---|---|---|
| `spawnPi(extraArgs)` (L62) | `spawnPi(cwd, extraArgs)` | Only change: `cwd` is a parameter instead of the global. **The arg list stays `[...spec.args, "--mode", "rpc", "-a", ...extraArgs]` — never drop `-a`.** Windows cmd.exe quoting path untouched. |
| `killPi(child)` (L95) | unchanged | Already per-child (POSIX kill / Windows `taskkill /T /F`). |
| `wirePi(child)` (L110) | `wireChat(chat, child)` | Generation check becomes `if (child !== chat.child) return;`. The per-child splitter (M1's `createJsonlSplitter`) is kept verbatim (never readline). `stderrTail` accumulates on `chat.stderrTail`. **Exit handling changes: see `chatDied` below — the bridge no longer `process.exit`s when a pi dies.** M1's `driftSeen` set becomes per-chat state cleared in `restartChat`. |
| `sendToPi(obj)` (L155) | `sendTo(chat, obj)` | Writes to `chat.child.stdin`; no-op with a console warning if `chat.status === "exited"`. |
| `handlePiLine(line)` (L245) | `handleChatLine(chat, line)` | Same logic; `pendingRpc`/`busy`/broadcast are chat-scoped. Recorded lines go through `recordAndBroadcast(chat, line, evt)`; the unclaimed-`response` live-only path keeps calling `broadcast` directly (unrecorded by design). |
| `record(line, evt)` (L197) | `record(chat, line, evt)` | Same ring-buffer + `answeredUi` eviction, on `chat.*`. `HISTORY_MAX = 4000` stays **per chat**. Callers outside `recordAndBroadcast` are forbidden. |
| `replayable(entry)` (L215) | `replayable(chat, entry)` | `answeredUi` lookup on the chat. M4's `set_editor_text` skip carries over unchanged. |
| `restartPi(newCwd, extraArgs)` (L273) | `restartChat(chat, newCwd, extraArgs)` | Same body scoped to the chat: null `chat.child` (arms generation check), `killPi(old)`, resolve `chat.pendingRpc` waiters with `null`, clear busy/history/answeredUi/stderrTail, bump `chat.resetEpoch`, respawn, set `chat.status = "running"`, then broadcast the per-chat reset (Stage 1: the existing un-enveloped `__hello`; Stage 2: `__reset`, §2.2 — unrecorded, so plain `broadcast`). |
| `rpcCall(cmd, timeoutMs)` (L295) | `rpcCall(chat, cmd, timeoutMs)` | Registers in `chat.pendingRpc`. `rpcSeq` can stay global. |
| `backfillMessages()` (L537) | `backfillMessages(chat)` | Emits `__message` lines into that chat via `recordAndBroadcast` (they are recorded, so they must carry `n` in Stage 2 like any other recorded frame). M3's `backfillFromFile`/`loadSessionTranscript` get the same chat-scoping. |
| `sessionsDirFor(CWD)` / `/resume` jail | `sessionsDirFor(chat.cwd)` | Unchanged logic. M3's `/events-poll` stale-cursor clamp becomes per-chat (`chat.historyBase + chat.history.length`) — preserve it. |
| `jailPath(rel)` (L489) / `readFilePreview(rel)` (L504) | `jailPath(root, rel)` / `readFilePreview(root, rel)` | `root = chat.cwd`. Note `readFilePreview` uses `CWD` twice — L506 via jailPath and L513 in the hidden-segment re-check — parameterize **both**. M2's `jailGitPath` and `runGit` cwd get the same treatment. |
| `shutdown()` (L1029) | loops `for (const c of chats.values()) killPi(c.child)` | Same for the `server.on("error")` EADDRINUSE exit path (L1019). |

**Crash semantics change (`chatDied`).** Today a pi exit broadcasts `__fatal` and exits the whole bridge (L115–127). With multiple chats that is wrong. New behavior, in `wireChat`'s exit handler (still generation-checked):

```js
function chatDied(chat, code) {
  chat.status = "exited";
  chat.busy = false;
  for (const [id, w] of chat.pendingRpc) { clearTimeout(w.timer); w.resolve(null); chat.pendingRpc.delete(id); }
  const line = JSON.stringify({ type: "__fatal", code: code ?? null, stderrTail: chat.stderrTail.trim().slice(-1500) });
  recordAndBroadcast(chat, line, { type: "__fatal" }); // RECORDED now (was broadcast-only), so switching to a
                                                       // crashed tab replays the crash card — and in Stage 2 the
                                                       // live frame carries n, so replay+live never doubles it.
  broadcastChats();                                    // Stage 2: tab strip shows the ✗ (no-op in Stage 1)
}
```

The bridge itself now exits only on: bad/missing `COOP_LAUNCH_SPEC`, unrecoverable port errors, signals, and `uncaughtException`/`unhandledRejection` (all existing paths, unchanged). `child.on("error")` (spawn failure) also routes to `chatDied(chat, null)` instead of `process.exit(1)` — a friendly `__fatal` card beats a vanished window, and boot-time spawn failure surfaces identically.

**Route plumbing.** Add one helper and thread it through every session-scoped route:

```js
// Resolve the target chat from ?sid= (GET) or body.sid (POST). With exactly one
// chat open, a missing sid falls back to it — Stage 1 compatibility + curl ergonomics.
function chatFor(sidRaw) {
  if (typeof sidRaw === "string" && sidRaw) return chats.get(sidRaw) || null;
  return chats.size === 1 ? chats.values().next().value : null;
}
```

`sid` values are bridge-generated (`c1`, `c2`, …) and any other non-empty string — including a client bug sending the literal string `"undefined"` — correctly gets the uniform 400 below; only a genuinely *absent* sid takes the single-chat fallback. (§2.4 keeps the SPA from ever sending `"undefined"`.)

Every existing route that touched the singleton (`/events`, `/events-poll`, `/sessions`, `/files`, `/file`, `/prompt`, `/ui-response`, `/rpc`, `/resume`, `/chdir`, `/abort`) resolves `const chat = chatFor(...)` and returns the **uniform** 400 `{ok:false, error:"That chat is no longer open."}` when null (same friendly-refusal convention as `/file`). **Every per-conversation endpoint added by M2/M3/M4 (`/git/changes`, `/git/diff`, `/history`'s `current` flag against `chat.cwd`, the extended `/resume`) gets the same `chatFor` treatment in this stage** — their state (git root = `chat.cwd`, session-dir derivation, pending dialogs) moves onto the chat object.

Boot: `makeChat(CWD)` where `CWD` is the existing `--cwd`/`process.cwd()` default (L39, now immutable — rename to `DEFAULT_CWD`).

**Stage 1 exit criterion: `bash tests/run.sh` passes with `tests/webbridge.test.mjs` unmodified** (one chat, missing-sid fallback, un-enveloped broadcasts, SSE replay-on-connect all preserved). "Unmodified tests green" is the invariant being asserted — the three intentional crash-semantics deltas above sit outside what the existing suite observes and are the only permitted behavior changes. Do not proceed to Stage 2 until it passes.

#### 2.2 Stage 2 — wire protocol: multiplexed envelope over ONE stream

One SSE connection carries all chats (per-chat streams would burn the browser's ~6-connections-per-origin HTTP/1.1 budget). Every frame becomes an **envelope built by string concatenation** — the raw pi line is embedded verbatim, never re-parsed/re-serialized:

```js
function broadcast(chat, rawLine, n) {
  // n = global event number (chat.historyBase + index) for RECORDED events; omitted otherwise.
  const frame = `data: {"sid":${JSON.stringify(chat.sid)}${n !== undefined ? `,"n":${n}` : ""},"ev":${rawLine}}\n\n`;
  for (const res of sseClients) { try { res.write(frame); } catch { sseClients.delete(res); } }
}
function broadcastGlobal(obj) { /* frame = `data: {"ev":${JSON.stringify(obj)}}\n\n`; same fan-out */ }
```

**The `n` rule is structural, not per-call-site:** in Stage 2, `recordAndBroadcast` (§2.1) becomes the only function that computes `n = chat.historyBase + chat.history.length - 1` (immediately after its `record()`), and it is the only caller of `broadcast` with an `n`. Because *every* recorded event — `handleChatLine`'s pi lines, `chatDied`'s `__fatal`, `backfillMessages`'s `__message` (and M3's `__replay`), and any future recorded synthesizer — already goes through that helper, no recorded frame can ship without its dedupe cursor. Direct `broadcast(chat, line)` (no `n`) is reserved for unrecorded, live-only frames: unclaimed `response` lines, M1's `__drift`, and `__reset`. The SPA uses `n` to dedupe live frames against a replay snapshot (§2.4); frames without `n` are always applied.

**Bridge-synthesized event types** (all `__`-prefixed per convention; register `__chats` and `__reset` in M1's `BRIDGE_EVENTS` and update the documented `__hello` shape there):

| Type | Scope | Recorded? | Shape / when |
|---|---|---|---|
| `__hello` | global | no | First SSE frame on connect: `{type:"__hello", chats:[…chatList()], maxChats:MAX_CHATS}`. **`/events` no longer replays history** — replay moves to `/events-poll?sid` (§2.4). |
| `__chats` | global | no | `{type:"__chats", chats:[…]}` whenever the list changes: chat created, closed, crashed, cwd changed. `chatList()` = `[{sid, cwd, busy, status, createdAt}]`. |
| `__reset` | per chat | no | `{type:"__reset", cwd, epoch}` — replaces the per-chat `__hello` after `new_session` success (L828–836), `/chdir`, `/resume`. Pollers detect it via `epoch` exactly as today. Unrecorded → plain `broadcast`, no `n`. |
| `__fatal` | per chat | **yes** (new) | Via `recordAndBroadcast` in `chatDied` (§2.1) — carries `n` like every recorded frame. |
| `__message` / `__replay` | per chat | yes | Unchanged (resume backfill), via `recordAndBroadcast` — carry `n`. |

**Route table (Stage 2 final).** Auth gates unchanged and mandatory on new routes: `hostOk` → cookie (`authed`) → CSRF header (`x-coop-csrf: 1`) on every POST; all responses via `baseHeaders()`; `readBody` 1 MB cap; field-whitelisted bodies (never spread).

| Route | Method | Change |
|---|---|---|
| `/events` | GET | Global `__hello` (with chats list), then live enveloped frames. No replay. `retry: 2000` + 15 s heartbeat unchanged. |
| `/events-poll` | GET | `?sid=<sid>&since=<n>` → `{next, epoch, cwd, busy, status, chats, events}` — `events` are raw un-enveloped lines for that chat (`history.slice(rel).filter(replayable)`), `chats` = full `chatList()` so polling clients also get tab state. Preserve M3's stale-cursor clamp per chat. Unknown/ambiguous sid → 400 whose body is `{ok:false, error:"That chat is no longer open.", chats: chatList()}` — the `chats` field lets polling clients recover from a stale sid (§2.4) instead of dead-ending. |
| `/chat-new` | **POST (new)** | Body `{cwd?}` (whitelisted single field). Validate cwd exactly like `/chdir` (resolve + `statSync().isDirectory()`), default `DEFAULT_CWD`. If `chats.size >= MAX_CHATS` → 400 `{ok:false, error:"You already have ${MAX_CHATS} chats open — close one first."}`. Else `makeChat(cwd)`, `broadcastChats()`, → `{ok:true, sid, cwd}`. |
| `/chat-close` | **POST (new)** | Body `{sid}`. `killPi(chat.child)`, resolve its `pendingRpc` with null, `chats.delete(sid)`, `broadcastChats()` → `{ok:true}`. Closing the last chat is allowed (SPA auto-creates, §2.4). Unknown sid → the uniform 400. |
| `/prompt`, `/ui-response`, `/rpc`, `/abort` | POST | Gain `sid` body field via `chatFor`. `/rpc new_session` success resets **that chat's** history/epoch and broadcasts its `__reset`. |
| `/resume`, `/chdir` | POST | Gain `sid`; operate via `restartChat(chat, …)`. `/chdir` additionally `broadcastChats()` (cwd changed). Session-file jail (`/^[A-Za-z0-9._-]+\.jsonl$/` + `sessionsDirFor(chat.cwd)`) and M3's `workspace` extension unchanged. |
| `/sessions`, `/files`, `/file`, `/git/changes`, `/git/diff` | GET | Gain `?sid=`; roots resolve from `chat.cwd` (jail per chat). |
| `/folders`, `/history` | GET | Unchanged shape (global, derived from the agent-dir session store); `/history`'s `current` flag is computed against the requesting chat's cwd (`?sid=`). |

#### 2.3 Lifecycle & resource limits

- **Cap:** `MAX_CHATS` (default 4, env `COOP_WEB_MAX_CHATS` clamped 1–8). Rationale: each chat is a full governed pi (an LLM-driven, bash-capable agent) — on the team's Windows work VMs more than a handful is a RAM/CPU problem and a supervision problem. The cap is the resource control for v1.
- **Idle cleanup: intentionally NOT implemented in v1.** pi-vis LRU-evicts idle subprocesses back to "cold" and lazily respawns on focus; doing that faithfully requires tracking each chat's live session file (via `get_state`) and respawning with `--session` on the next prompt without dropping queued input. That machinery is real complexity for a marginal win at n≤4 (an idle pi is an idle process — the same cost as leaving 4 terminal coops open). Deferred; see §6.
- **Crash:** per-chat `__fatal` (recorded), tab marked ✗, bridge stays up. No auto-restart in v1 — the user closes the tab or opens a new chat.
- **Shutdown:** signals/uncaught still kill **every** chat's subtree (`taskkill /T /F` per pid on Windows) before exit — never orphan a bash-capable agent.
- **Memory bound:** ≤ `MAX_CHATS × HISTORY_MAX` (4 × 4000) ring entries + one 4000-char stderr tail per chat.

#### 2.4 SPA (`web/public/`)

**Tab strip.** `index.html`: add `<nav id="tabs"></nav>` between `</header>` and `<div id="main">`. Rendered entirely by `renderTabs()` in app.js (createElement + textContent, CSP-clean): one `button.tab` per chat — label = folder basename (`chat.cwd.split(/[\\/]/).pop()`), `title` = full cwd, modifiers `.on` (active), `.crashed` (status exited); children: `span.tab-dot` (busy pulse), `span.tab-unread` (finished in background), `span.tab-close` ("✕", click → `POST /chat-close` **with that tab's sid passed explicitly** — usually not the active tab; `event.stopPropagation()`) — plus a trailing `button.tab-new` ("＋") → `POST /chat-new {cwd: activeChat.cwd}` then `switchChat(newSid)`. `style.css`: `#tabs` (thin bar, `--navy2` bg, bottom border `--line`), `.tab` (pill, `--dim` text), `.tab.on` (`--lime` text + border), `.tab-dot` (gold, `animation: pulse`), `.tab-unread` (lime dot), `.tab.crashed` (`--red` accent). When only one chat exists, the strip may stay visible (simplest) — just the one tab + ＋.

**State model.** New module-level state in app.js: `const chatsState = new Map()` (sid → `{cwd, busy, status, unread}`), `let activeSid = null`, `let switchSeq = 0`, `let switching = false`, `let pendingLive = []`. All existing per-conversation vars (`current`, `tools`, `thinkingEl`, `assistantT0`, `busySince`, `curTool`, `statusPhase`, and M4's `extStatus`/`extWidgets`/`extUnknown`) remain module-level **but now describe only the active chat** — they are wiped by `resetTranscript()` on every switch. **The SPA renders only the active chat; background transcripts are NOT kept in the DOM.** Switching rebuilds from the bridge's per-chat ring buffer (replay-on-switch) — handlers are already idempotent-per-event and replay-burst-safe (the `secs > 1` tok/s guard, `busySince` preservation), so this reuses the existing reconnect path instead of inventing per-tab DOM juggling.

**`applyChats(list)` merges, never replaces.** The server's `chatList()` entries (`{sid, cwd, busy, status, createdAt}`) do not carry the client-only `unread` flag, so `applyChats` must merge server fields into the existing `chatsState` entry for each sid (preserving `unread`), create entries for new sids (`unread: false`), and delete only entries whose sid is absent from the list. A wholesale `Map` rebuild would wipe unread dots on every `__chats` frame and every poll tick — forbidden.

**Transport & routing.** `connect()`'s `es.onmessage` and the poller both parse the envelope and call `route(frame)`:

```js
function route({ sid, n, ev }) {
  if (!sid) { // global frames
    if (ev.type === "__hello") { applyChats(ev.chats); pickInitialTab(); }
    if (ev.type === "__chats") { applyChats(ev.chats); renderTabs(); ensureActiveExists(); }
    return;
  }
  const c = chatsState.get(sid);
  if (ev.type === "agent_start" && c) { c.busy = true; renderTabs(); }
  if (ev.type === "agent_end" && c) { c.busy = false; if (sid !== activeSid) c.unread = true; renderTabs(); }
  if (ev.type === "__fatal" && c) { c.status = "exited"; renderTabs(); }
  if (sid !== activeSid) return;                    // background chats: indicators only
  if (switching) { pendingLive.push({ n, ev }); return; } // buffered during a switch fetch
  if (ev.type === "__reset") { resetTranscript(); setCwd(ev.cwd); return; }
  handle(ev);                                        // the existing dispatcher, unchanged cases
}
```

**`switchChat(sid)`** (also `pickInitialTab`'s body): bump `switchSeq` and capture it (stale async fetches no-op — same generation-counter idiom the bridge uses); set `activeSid`, `switching = true`, `pendingLive = []`; `resetTranscript()`; `setCwd(chatsState.get(sid).cwd)`; set `window.coopSid = sid` (this happens in `pickInitialTab` on the very first `__hello`, i.e. before any Files-panel fetch can carry a sid); fetch `/events-poll?sid=${sid}&since=0`; apply each returned line through `handle(JSON.parse(line))`; then apply buffered `pendingLive` entries where `n === undefined || n >= data.next` (the `n` dedupe — replay already covered anything below `next`; recorded frames always carry `n` per §2.2's structural rule, so nothing recorded can double); `switching = false`; clear the tab's `unread`; then `refreshState()` + `coopFiles.onAgentEnd()` (tree reload for the new cwd) + `coopDiff.onReset()` (M2's panel must not show a stale repo). A crashed chat's replay ends with the recorded `__fatal`, rendering the crash card naturally.

**`handle()` edits:** remove the `__hello` case (replaced by global `__hello`/per-chat `__reset` in `route`); soften the `__fatal` case — status line becomes `"this chat's agent stopped — close the tab or start a new chat"` and it is **no longer terminal** for the app (drop the implication the whole bridge died; the crash card content is unchanged).

**sid plumbing — fill-if-absent, never clobber:** `post()` and `rpc()` apply `body.sid ??= activeSid` — they set `sid` **only when the caller did not supply one**. A caller-supplied `sid` always wins; the tab strip's ✕ handler and any other per-tab affordance acting on a non-active tab pass the clicked tab's sid explicitly and must reach the wire intact (a `{...body, sid: activeSid}` spread that overwrites it would close the *active* chat instead of the clicked one — this is the regression Stage-2 test 9 guards). Callers that operate on the active chat (`send()`, `stopBtn`, `#newChat` (still "reset this tab" via `new_session`), `#historyBtn`/`/resume`, `#compactBtn`, model/think chips, the `#cwd` folder card (`/chdir` now moves only the active tab — update its copy), and `refreshCtx`/`refreshState`/`startUsagePolling`) simply omit `sid` and inherit `activeSid`. `startUsagePolling`'s 120 s `/openai-usage` prompt targets `activeSid` and skips a tick while that chat is busy or crashed. **viewer.js:** `loadTree()`/`openFile()` append `?sid=${encodeURIComponent(window.coopSid)}` (and `&sid=` on `/file?p=`) **only when `typeof window.coopSid === "string" && window.coopSid`** — never interpolate an unset value into the literal string `"undefined"` (which `chatFor` would rightly 400); before the first `__hello` the un-sid'd request still works via the single-chat fallback. The same guarded-sid rule applies to M2's `diffview.js` fetches. `attachTarget()` already uses `window.coopCwd`, which `setCwd` keeps per-tab.

**Polling fallback** (`switchToPolling`): the tick polls only `/events-poll?sid=${activeSid}&since=N`; tab indicators come from the `chats` array in every poll body (`applyChats(data.chats); renderTabs();`); per-chat `epoch` change → `resetTranscript()` as today; `switchChat` under polling just resets `since = 0`, `first = true` for the new sid. **A 400 is not a connectivity failure:** the tick must distinguish `r.status === 400` (stale/closed sid — e.g. the active chat was closed from a second window on the same token) from a network error. On 400 it parses the body, runs `applyChats(body.chats)` (the 400 body carries `chats`, §2.2 route table) then `ensureActiveExists()`, and does **not** increment the `fails` counter that leads to the terminal "coop stopped" message — the bridge is demonstrably alive, it just no longer has that chat. Only fetch-level failures count toward the existing 4-strikes terminal state. `ensureActiveExists()`: if the active sid disappears from the list, switch to the first remaining chat; if the list is empty, `POST /chat-new {}` and switch to it (the UI is never a dead end — on either transport).

#### 2.5 Security (unchanged by design)

Nothing about auth changes: one process-lifetime token, one `coop_token` cookie gates every route including `/chat-new`/`/chat-close`; CSRF header on all POSTs; `hostOk` and timing-safe compares untouched; bind stays 127.0.0.1. New per-chat attack surface is only the file jail root moving from a global to `chat.cwd` — the two-gate `jailPath` (lexical + realpath) and the hidden-segment re-check in `readFilePreview` are parameterized, not weakened, and `sid` values are bridge-generated (`c1`, `c2`, …), never attacker-controlled paths.

### 3. Files to touch

| File | Change |
|---|---|
| `web/server.mjs` | The whole of §2.1–2.3: chat registry (`makeChat`, `chatFor`, `chatList`, `broadcastChats`, `chatDied`, `recordAndBroadcast`, `MAX_CHATS`), parameterize `spawnPi`/`wireChat`/`sendTo`/`handleChatLine`/`record`/`replayable`/`restartChat`/`rpcCall`/`backfillMessages`/`jailPath`/`readFilePreview`/`sessionsDirFor` (+ M2's git helpers and M3's backfill), envelope `broadcast` + `broadcastGlobal` (`n` only via `recordAndBroadcast`), new `__hello`/`__chats`/`__reset` shapes, `/chat-new` + `/chat-close`, `sid` on all session-scoped routes, `/events` replay removal, `/events-poll` response fields + `chats`-bearing 400 body (M3 clamp preserved per chat), multi-chat `shutdown`. Update the header comment block (it documents the architecture). |
| `web/protocol.mjs` | Register `__chats`/`__reset` in `BRIDGE_EVENTS`; update documented `__hello` shape (M1 registration rule). |
| `web/public/index.html` | Add `<nav id="tabs"></nav>`. |
| `web/public/app.js` | Envelope parsing, `route()`, `chatsState`/`activeSid`/`switching`/`switchChat`/`renderTabs`/`applyChats` (merge semantics, preserve `unread`)/`ensureActiveExists`, `body.sid ??= activeSid` fill-if-absent in `post()`/`rpc()` and sid on all direct `fetch()` calls, explicit sid from the tab-close handler, poll-tick 400 recovery, `handle()` `__hello` removal + `__fatal` copy change, per-tab folder-switcher copy, `window.coopSid`. |
| `web/public/viewer.js` | `?sid=` on `/files` and `/file` fetches, guarded on `window.coopSid` being a non-empty string. |
| `web/public/diffview.js` | Same guarded `?sid=` on `/git/changes` and `/git/diff` fetches (M2 sweep). |
| `web/public/style.css` | `#tabs`, `.tab`, `.tab.on`, `.tab.crashed`, `.tab-dot` (+ pulse keyframes), `.tab-unread`, `.tab-close`, `.tab-new` using the existing brand tokens. |
| `web/README.md` | Document tabs, the 4-chat cap (`COOP_WEB_MAX_CHATS`), per-tab folders/crash behavior, and the revised replay model (replay now served per chat via `/events-poll`, still ~4000 events/chat). |
| `tests/stub-pi.mjs` | In the `prompt` branch: `if (cmd.message === "__crash__") process.exit(3);` (before emitting any events). |
| `tests/webbridge.test.mjs` | Stage-2 framing updates + new multi-chat suite (§4); the single bridge spawn gains `COOP_WEB_MAX_CHATS: "3"` in its env. |

**No `bin/coop`, `lib/`, or `scripts/` changes → no `.ps1` parity burden** (`scripts/check-parity.sh` must still pass, trivially).

### 4. Test plan

All in the existing flat-`await` style of `tests/webbridge.test.mjs` (order matters; later tests build on earlier state).

**Stage 1 gate:** run `node tests/webbridge.test.mjs` with **zero test edits** — the refactor is wrong if anything fails. (The env change below is applied only when Stage 2's test edits land.)

**Stage 2 — updates to existing assertions:** the single bridge spawned at the top of the file now gets `COOP_WEB_MAX_CHATS=3` in its env (this affects nothing earlier in the file — all pre-multi-chat tests use one chat — and gives the cap test a deterministic, cheap bound); `readSse()` returns parsed envelopes `{sid, n, ev}`; "SSE starts with `__hello`" → `events[0].ev.type === "__hello"` with a 1-element `chats` array (capture `sid1 = ev.chats[0].sid`); the SSE-replay assertions ("stub's select dialog is replayed", "answered dialog is not replayed", "notify not replayed") move to `/events-poll?sid=${sid1}&since=0` (same `replayable` filter, new transport); the prompt-echo test asserts the envelope carries `sid1` **and an integer `n`** (recorded frames always carry the cursor). Single-chat `post()` calls keep working un-sid'd via the `chatFor` fallback until the multi-chat block below opens chat 2 — from that point every call passes `sid` explicitly.

**Stage 2 — new tests (append after the existing `/files` block):**
1. `POST /chat-new` without CSRF header → 403; with CSRF `{}` → 200, new `sid2 ≠ sid1`, `cwd` = default.
2. SSE `__chats` frame observed listing both chats.
3. **Isolation:** `POST /prompt {sid: sid1, message:"one"}` and `{sid: sid2, message:"two"}`; after a 500 ms sleep, `/events-poll?sid=${sid1}&since=0` contains `polo:one` and NOT `polo:two`, and vice-versa; live SSE frames carried the right `sid` on each delta.
4. **Per-chat dialogs:** answer chat 2's startup select via `/ui-response {sid: sid2, id, value}`; chat 1's replay still contains its own un-answered dialog, chat 2's no longer does (answeredUi is per chat).
5. **Per-chat cwd:** `POST /chdir {sid: sid2, dir: workDir}` → chat 2's poll reports `cwd === workDir` and a bumped `epoch`; chat 1's `cwd`/`epoch` unchanged; `GET /files?sid=${sid2}` lists `notes.md` while `GET /files?sid=${sid1}` does not; `GET /file?sid=${sid2}&p=.env` → 400 (jail intact per chat).
6. **Ambiguity + unknown sid:** with 2 chats open, `POST /prompt {message:"x"}` (no sid) → 400; `?sid=zzz` on `/events-poll` → 400 **whose JSON body includes a `chats` array listing both open chats** (the polling-recovery contract, §2.2/§2.4).
7. **Cap:** with the bridge's `COOP_WEB_MAX_CHATS=3` (set on the single spawn, above), open `sid3` via `/chat-new` (→ 200, registry at cap), then a fourth `/chat-new` → 400 with the friendly message; `POST /chat-close {sid: sid3}` → 200 to return to the two-chat state the later tests assume.
8. **Crash containment:** `POST /prompt {sid: sid2, message:"__crash__"}`; after a sleep, the bridge process is still alive, `/events-poll?sid=${sid2}` includes a recorded `__fatal` with `code: 3` and `status:"exited"` in the body, `__chats` reflects it, and chat 1 still answers a fresh prompt (`polo:still-alive`). The live `__fatal` envelope carried an `n` (recorded frames are never n-less).
9. **Close targets the explicit sid:** `POST /chat-close {sid: sid2}` → 200; polling `sid2` → 400; `__chats` lists only chat 1; **chat 1 still answers a fresh prompt (`polo:after-close`) — guards the close-the-wrong-chat regression from §2.4's fill-if-absent rule** (an implementation that overwrote an explicit body sid with the "active"/fallback chat would have killed chat 1 here). Then `POST /chat-close` on the last chat → 200 and `/chat-new` still works after (empty registry is legal server-side).
10. **RPC scoping:** `/rpc {sid: sid1, type:"new_session"}` resets only chat 1's history (`next === 0`) and bumps only its epoch.

**Verify commands** (all must pass, working tree only — no commits):
```bash
node tests/webbridge.test.mjs
bash tests/run.sh
bash scripts/check-parity.sh
```

### 5. Edge cases & failure modes

- **Windows child reaping:** each chat's pi is a cmd.exe-wrapped grandchild; `/chat-close`, `restartChat`, and `shutdown` all go through `killPi` (`taskkill /pid … /T /F`) per chat — N chats = N taskkill invocations, same fire-and-forget pattern as today. The cmd-quoting refusal (`"`/`%` in spec args) runs per spawn, unchanged.
- **One SSE stream, always:** the envelope multiplexes all chats; never open per-chat EventSources (HTTP/1.1 connection limit would deadlock the app at ~6 tabs including the page itself).
- **Replay/live race on switch:** solved by the `n` cursor dedupe (§2.4). The rule is airtight because it is structural: recorded frames can only be broadcast by `recordAndBroadcast`, which always attaches `n`; frames without `n` (unclaimed `response` lines, `__reset`, `__drift`) are live-only by definition and always applied.
- **Crash of a background chat:** recorded `__fatal` means the crash card appears on switch, not silently lost; the tab shows ✗ immediately via the routed event.
- **Crash of the *active* chat mid-switch:** the `__fatal` is recorded, so either the replay or the buffered live frame delivers it — and because the live frame carries `n` (via `recordAndBroadcast`), the `n >= next` dedupe guarantees exactly one crash card, never two. The same argument covers backfilled `__message`/`__replay` lines landing during a switch.
- **`/chat-close` racing an in-flight `/rpc`:** the close path resolves that chat's `pendingRpc` with `null` → the HTTP handler returns its existing 504 "pi did not answer in time" instead of hanging.
- **Last chat closed / active sid vanishes (including from a second window on the same token):** `ensureActiveExists()` switches or auto-creates — on the SSE path via the `__chats` frame, on the polling path via the `chats`-bearing 400 recovery (§2.4); the composer is never orphaned on either transport.
- **Cap reached:** friendly 400, surfaced as a toast; nothing crashes.
- **Poll-fallback clients:** get tab state (`chats`), `busy`, `status`, and per-chat `epoch` in every poll body — full feature parity minus instant background-busy pulses (they update on the 1.5 s cadence). A stale-sid 400 triggers list-refresh + `ensureActiveExists()`, not the terminal failure counter.
- **stub-pi on POSIX vs Windows:** no symlinks, no shell — the concurrent-stub tests are platform-neutral; the existing symlink-escape skip logic is untouched.
- **Degradation:** with `MAX_CHATS=1` (env) the app behaves exactly like today's single-session coop web — that is also the recommended rollback lever if parallel sessions misbehave in the field.

### 6. Out of scope / deferred (be honest with Aaron about these)

- **Worktree isolation — DEFERRED, deliberately.** Assessment: pi-vis creates sibling worktrees (`git worktree add -b pi-vis-<name> <repoParent>/<repo>-worktrees/<name> <base>`, 10-min timeout, `execFile` never a shell) and — verified in its source — has **no removal path at all**: no `git worktree remove`, no branch deletion, no prune. Shipping that to coop's audience (Windows-first Power BI/data analysts, not git power users) means orphaned `<repo>-worktrees/` directories and `coop/*` branches accumulating on work VMs with nobody understanding why, plus OneDrive/Defender interactions with full duplicate checkouts. coop already has a safer, teachable isolation story: **each tab can `/chdir` to a different folder**, and the guardrails/spec-first workflow discourages two agents editing the same tree concurrently anyway. If demand materializes, a follow-up section should spec: `git worktree add` via `execFile("git", …)` with typed `git-missing`/`not-a-repo` degradation, a `coop/<adjective-noun>` branch scheme, an explicit *user-driven* cleanup UI (`git worktree remove` + branch delete with confirmation — improving on pi-vis), and a "not a git repo → plain chat" fallback. Do not gold-plate this into v1.
- **Idle process eviction / cold-resume** (pi-vis's `MAX_IDLE_PROCESSES` LRU): deferred per §2.3 — the cap bounds cost at n≤4; correct lazy-respawn needs session-file tracking and queued-command flushing we don't want to debug in v1.
- **Crashed-chat restart button**: v1 = close the tab, open a new chat (History → resume recovers the conversation). A one-click "Restart this chat" (respawn with `--session`) is a small follow-up once cold-resume exists.
- **Per-tab session names as tab labels** (`session_info_changed` → tab text): nice-to-have; v1 labels are folder basenames.
- **Background-tab toast/notification center** (pi-vis's unread panel): v1 is the unread dot only.
- **Event batching** (pi-vis's 16 ms coalescer): unnecessary at this scale — SSE writes are already per-line and cheap on loopback.

### 7. Estimated size & dependencies

**Size: L** — the largest section (bridge-wide refactor ~300–400 changed lines in `server.mjs`, ~250 new/changed in `app.js`, test suite roughly doubles). The Stage 1 / Stage 2 split is the risk control: Stage 1 must land green against the untouched test file before any protocol change.

**Dependencies:** implement **after** all other sections. Hard dependency on **M1** (register `__chats`/`__reset` in `BRIDGE_EVENTS`, update the documented `__hello` shape — adopt M1's registry rather than inventing a parallel one). Structural interaction with **M2**, **M3**, and **M4**: every per-conversation endpoint or state those sections added must be swept into the chat object + `chatFor` plumbing during Stage 1 — budget time for that sweep proportional to how many endpoints they shipped. Specifically preserve: M3's `/events-poll` stale-cursor clamp (per chat), M2's git-helper cwd/jail (per chat), M4's dock-state reset on switch.

---

## Acceptance checklist

Tick every line per milestone before calling it done. A milestone is not done with any box unchecked.

**Every milestone:**

- [ ] `bash tests/run.sh` passes (all suites, including any new ones).
- [ ] `bash scripts/check-parity.sh` passes (and no `bin/coop`/`lib/`/`scripts/` file was touched).
- [ ] `bash -n` clean on any touched shell file.
- [ ] No new runtime dependencies, no build step, no npm packages in `web/`.
- [ ] CSP holds: no inline script/style, no `innerHTML` with unescaped input, no eval.
- [ ] All new endpoints sit behind `hostOk` + cookie auth; POSTs require the CSRF header; bodies field-whitelisted; file paths jailed (lexical + realpath).
- [ ] `spawnPi`'s `--mode rpc -a` construction untouched (`-a` present).
- [ ] New commands/events/synthetics registered in `web/protocol.mjs` (`COMMANDS_SENT`/`RPC_ALLOWED`/`EVENTS_CONSUMED`/`BRIDGE_EVENTS`) — the end-of-suite drift-count assertion passes with the documented N.
- [ ] `web/README.md` and `docs/coop-web-plan.md` updated; `CHANGELOG.md` line under `## [Unreleased]` where specified.
- [ ] Nothing committed, pushed, or tagged — working tree only.

**M1 — protocol contract:**

- [ ] `tests/protocol.test.mjs` passes standalone (`node tests/protocol.test.mjs`), including the split-emoji StringDecoder test, U+2028/U+2029 round-trip, oversized-line recovery, and the `toolcall_delta` ok/mismatch pair.
- [ ] Drift is observe-only: unknown/mismatched events still forwarded verbatim (integration test 1).
- [ ] Drift-count assertion N matches exactly the provoked lines; the standard stub conversation (with its new `toolcall_*` triple) adds zero.
- [ ] `RPC_ALLOWED` moved to `protocol.mjs`; `/rpc get_state` still round-trips and stays unrecorded.
- [ ] `web/README.md` gains the 5-step upgrade checklist.

**M2 — diff viewer:**

- [ ] `tests/diffmodel.test.mjs` passes standalone; `tests/run.sh` runs it.
- [ ] All four `/git/changes` states covered by tests (git missing, non-repo, no-HEAD, normal), plus jail 400s and the no-cookie 401.
- [ ] `--relative` + `-z` + `--` used on every git invocation; `gitRefOk` rejects `-`-prefixed refs; `GIT_OPTIONAL_LOCKS=0` set.
- [ ] Windows degradation verified by the PATH-empty second-bridge test (git ENOENT → friendly state).
- [ ] Dotfile-diff divergence from `isHidden` commented in code and documented in README security section.
- [ ] Manual smoke: badge updates after an agent turn; unified/split/search/base-ref behave; non-repo folder shows the friendly empty state.

**M3 — session history:**

- [ ] Existing `/sessions` wire shape and its `"hello from the past"` preview assertion unchanged.
- [ ] `/history` groups: exactly one `current:true` (server-computed via `samePath`), `exists:false` groups returned disabled-able, 401 without cookie.
- [ ] Cross-workspace `/resume` gated (dir-exists, server-derived `sessionsDirFor`, basename regex); all refusals uniform 400.
- [ ] File backfill: `__replay` lines carry thinking / tool output / final answer; branch info line fires for the real-fork fixture and does NOT fire for the linear fixture (header-as-leaf guard).
- [ ] `/events-poll` stale-cursor clamp in place and pinned by the stale-cursor poll test.
- [ ] `FALLBACK_SESSION` proves the `get_messages` fallback still works.
- [ ] `__replay` registered in `BRIDGE_EVENTS`.

**M4 — extension UI:**

- [ ] Replay semantics: `setStatus`/`setWidget`/`setTitle` replayed; `set_editor_text` and `notify` not (both transports, tested).
- [ ] Unknown-method fallback card: replayed until dismissed; dismiss via existing `/ui-response {cancelled:true}` stops replay (tested).
- [ ] Delete-on-absent contract exercised end-to-end via the `clear-status` stub trigger.
- [ ] ANSI stripped from dock text; `.toast` multi-line CSS fix in; `#extDock[hidden]` override present.
- [ ] `resetTranscript()` clears dock state and resets `document.title`.
- [ ] Manual smoke: dock hidden by default; guardrails multi-line notify shows line breaks; dialogs still answer.

**M5 — multi-session:**

- [ ] **Stage 1 gate:** existing `tests/webbridge.test.mjs` passes with ZERO test edits before any Stage 2 work.
- [ ] `recordAndBroadcast` is the only path that records+broadcasts; in Stage 2 the only source of `n`.
- [ ] All M2/M3/M4 endpoints swept into `chatFor`/chat-object plumbing; M3's poll clamp preserved per chat.
- [ ] Stage 2 tests 1–10 pass (isolation, per-chat dialogs/cwd/jail, ambiguity 400 with `chats` body, cap at 3, crash containment with recorded n-bearing `__fatal`, explicit-sid close regression guard, RPC scoping).
- [ ] `applyChats` merges (unread preserved); `post()`/`rpc()` fill-if-absent, never clobber a caller sid; viewer/diffview sid interpolation guarded against `"undefined"`.
- [ ] Polling 400 recovery does not trip the terminal failure counter; `ensureActiveExists()` never leaves a dead-end UI.
- [ ] Shutdown kills every chat's subtree; bridge survives individual pi deaths.
- [ ] `__chats`/`__reset` registered in `BRIDGE_EVENTS`; `__hello` shape doc updated.
- [ ] `COOP_WEB_MAX_CHATS=1` behaves like today's single-session coop web (rollback lever verified).

---

## Decisions needed / open questions (for Aaron — implement the plan's stated defaults unless told otherwise)

**M1 — protocol contract:**
- Should the browser-visible `__drift` toast be default-on (as planned, deduped once per event type per pi child) or gated behind an env var like `COOP_WEB_PROTOCOL_WARN` for the Windows team? stderr logging happens either way.
- Oversized-line cap value: 64 MiB chosen to match pi-vis's jsonl-stream; a large resumed session's `get_messages` response is the biggest real line — is a lower cap (e.g. 16 MiB) preferred?
- `tests/run.sh` has no `.ps1` twin and `check-parity.sh` covers only `bin/coop`, `lib/common.sh`, `scripts/*.sh` — adding a test line there carries no parity burden; flagged in case Aaron wants `tests/run.sh` brought under parity later.
- The verified framer bug (multi-byte UTF-8 split across chunk boundaries → U+FFFD → silently dropped JSON line) exists today on main; if a hotfix is wanted independent of this feature, the StringDecoder swap is a ~5-line standalone patch.

**M2 — diff viewer:**
- Dotfile visibility policy for `/git/diff`: the plan allows dotfile diffs (so tracked `.github/...` is viewable) while keeping `FILES_IGNORE` segments and the untracked-file path (`/file`) refused — this deliberately diverges from the `/file` `isHidden` rule and means a *tracked, modified* `.env`'s diff would be viewable. Confirm, or tighten to full `isHidden` parity at the cost of `.github` diffs.
- Badge refresh trigger: `agent_end` only (debounced) vs also on `tool_execution_end` for write/edit tools — the plan picks `agent_end`-only to avoid hammering git mid-turn; revisit if users want the count to move during long turns.
- UI placement: a full-pane overlay over the transcript area (needed for side-by-side width) rather than a 360 px aside like the Files panel — slightly outside the existing "new panel = aside" convention; confirm the overlay is acceptable.
- Whether to also render pi's tool-emitted edit diffs (`result.details.diff`) in the transcript using the same renderer — natural follow-up, explicitly deferred here.

**M3 — session history:**
- Active-branch heuristic: after fork/tree navigation the max-timestamp leaf may not match Pi's true active leaf; should a later iteration cross-check the file-derived chain against a `get_messages` response and prefer Pi's answer when they diverge?
- Should `HISTORY_MAX` (4000) be raised or made adaptive now that file backfill can produce long, high-fidelity transcripts, or is eviction of the earliest turns on reconnect acceptable?
- Should the legacy `GET /sessions` endpoint eventually be folded into `GET /history` (client and tests both under our control), or kept indefinitely as the cheap current-folder path?
- If a future Pi release exposes `get_tree`/`navigate_tree` over `--mode rpc`, should the pi-vis-style branch tree (`flattenVisible` port) be prioritized, or does the multi-session work subsume it?

**M4 — extension UI:**
- Do the non-repo extensions in `~/.coop/agent` (pi-hermes-memory, pi-better-openai) emit `setStatus`/`setWidget`/`setTitle`? The agent-dir extensions folder could not be verified on the design machine; the renderers are cheap and the fallback card covers anything else, but a known concrete producer could change priorities.
- Assumed pi 0.80.x silently ignores an `extension_ui_response` whose id has no pending resolver (basis for the fallback card's Dismiss on fire-and-forget methods); consistent with pi-vis's timeout notes but not verified against pi source.
- Placement call: status segments + widgets go in one dock above the composer (pi-vis parity, handles multi-line) rather than the header "status line" — header width is already consumed by the toolbar/gauges push-right chain. Flag if header placement is a hard requirement.
- Polling-transport clients never receive `notify` events today (`replayable()` filters live events too on `/events-poll`) — a pre-existing quirk this plan extends to `set_editor_text`; worth a separate fix decision if toast delivery on the polling fallback matters.

**M5 — multi-session:**
- `MAX_CHATS` default: the plan picks 4 (env-overridable `COOP_WEB_MAX_CHATS`, clamped 1–8) sized for the team's Windows work VMs — confirm the number.
- When the last tab is closed the SPA auto-creates a fresh chat in the default cwd; the alternative is an explicit empty state with a "New chat" button — pick one during review (plan implements auto-create).
- Worktree isolation is recommended DEFERRED entirely (pi-vis ships no worktree cleanup path; coop's audience would accumulate orphaned worktrees/branches on work VMs) — confirm, rather than wanting a minimal v1 worktree mode.
- Whether the tab strip should hide itself when only one chat exists (plan keeps it always visible for simplicity/discoverability).
- *(Resolved by milestone ordering:)* the M5 envelope and `__hello`/`__chats`/`__reset` shapes are registered in M1's `BRIDGE_EVENTS` registry rather than a parallel scheme — no separate decision needed unless M1's shape changes during review.

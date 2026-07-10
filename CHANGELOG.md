# Changelog

All notable changes to coop-agent are recorded here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com); versions follow [SemVer](https://semver.org).

## [Unreleased]

## [0.13.0] — 2026-07-09

### Added

- **Zip/shared-drive installs no longer silently never update** (#20). A coop-agent
  copy without `.git` had its skills/prompts/guardrails/themes frozen forever while
  every surface said "up to date" — `coop update` logged only an info-level skip.
  Now: `coop update` **and** `coop doctor` warn loudly ("… will NEVER update") with
  the remediation (git clone + `coop install`; `~/.coop` settings carry over), on
  both platforms. And for git checkouts, a **staleness nudge**: doctor and the
  launch path quietly `git fetch` origin at most once per day (marker in the agent
  dir; 5s watchdog so offline/VPN-black-holed machines never stall) and warn
  "coop-agent is N commit(s) behind — run: coop update". Silent when offline, when
  the fetch fails, or when up to date; the launch nudge fires at most once per day
  and never blocks the launch. New shared helpers
  `coop_repo_fetch_throttled`/`coop_repo_behind_count`/`coop_update_nudge`
  (+ PowerShell twins) with an offline test suite (`tests/staleness.test.sh`).
- **`coop uninstall [--keep-tools] [--yes]`** (#21) — clean teardown for VM churn
  and offboarding (`scripts/uninstall.{sh,ps1}`). Removes the PATH
  launcher/symlink, the Windows user-PATH registry entry (ExpandString-safe, with
  the WM_SETTINGCHANGE broadcast), the Start Menu + Desktop shortcuts, coop's
  isolated agent dir, and — by default — the npm-global Pi agent plus the pipx
  venvs (coop tools + `ms-fabric-cli`). `--keep-tools` spares the tool layer for
  fast re-installs and shared machines. Confirms before acting (`--yes` to skip),
  and never touches the repo clone, work repos' `.coop/project.yml`, the rest of
  `~/.coop` (private config lives there), or the personal `~/.pi/agent`.
  `coop uninstall <source>` still removes a Pi extension — the same
  bare-vs-source split `coop install` already uses.
- **`.coop/project.yml` now drives the native tools** (#25). When the model calls
  `sql_review`/`dax_review` without explicit paths, coop-tools finds the nearest
  contract and scopes the review to its `repositories.*.local_path` entries
  (TODO placeholders and missing paths skipped with a note) instead of
  blind-scanning the cwd; explicit paths always win, no contract falls back to
  `["."]`, and the scope used is surfaced in the tool result. And
  **`coop init --seed-docs`** generates/patches `coop-data-doc.yml` from the
  contract's `repositories:` (via the new `lib/_seeddocs.py` +
  `coop-data-doc config-set --from-json`), classifying filled repos into the
  sql/powerbi slots (`sql_root` honored) so repo paths are typed once —
  confirmed before writing, declining changes nothing, on both platforms.
  New Node suite cases (contract present/absent/all-TODO) and a shimmed
  end-to-end test (`tests/seeddocs.test.sh`).
- **`coop doctor --json`** (#22) — one machine-readable JSON document on stdout
  (`{"checks":[{name,section,status,hint}…],"fail":N,"warn":N}`,
  `status ∈ ok|warn|fail`), human output suppressed, exit code unchanged — the
  cheapest fleet-health signal: run it per machine and aggregate. Implemented at
  the ok/warn/bad + section choke points on both platforms (dependency-free JSON
  on the bash side, `ConvertTo-Json` on PowerShell); `--fix --json` runs the
  fixes then emits the re-check document. The doctor flag-parity gate covers the
  new flag.

### Changed

- **The az preflight is cached for ~30 minutes** (#18) — on tenant-pinned
  projects every `coop` / `coop web` launch paid `az`'s 1–3s cold start to
  re-verify a ~60-minute Power BI token. A successful probe now stamps the
  validated tenant into `<agent-dir>/.az-ok`; within 30 minutes for the same
  tenant the probe is skipped entirely. Tenant changes and stale/missing markers
  re-probe exactly as before, failed probes clear the marker, `COOP_SKIP_AZ=1`
  is unchanged, and marker I/O is best-effort (never fails a launch). The
  preflight moved into the shared libraries (`coop_az_preflight` in
  `lib/common.sh`, `Invoke-CoopAzPreflight` in `lib/common.ps1`) with a
  shimmed-`az` test suite (`tests/azcache.test.sh`).
- **Onboarding §3.5 documents the first-launch sign-in** (#19) — the one
  interactive fork in setup now has guidance: choose the **OpenAI (Codex)**
  provider and sign in with your **Cooptimize business account** (the
  no-training-on-our-data terms attach to the business subscription; a personal
  sign-in silently voids them), one-time, stored in `~/.coop/agent` (or shared in
  from a personal `~/.pi/agent`). Cross-linked from README's Quick start and from
  doctor's "no Pi login found yet" hint on both platforms.
- **Shared PowerShell helpers extracted into `lib/common.ps1`** — the dot-sourced
  twin of `lib/common.sh` (#17). The loggers, progress engine, `Coop-Unit`,
  `Test-Have`, `Get-CoopPython` (now the ONE python resolver —
  `install.ps1`'s identical `Get-CoopRealPython` folded in), `Get-CoopPiVersion`,
  `Get-CoopPiAgentDir`, `Get-CoopYamlValue`/`Get-CoopYamlList`,
  `Get-CoopSkillName`, `Find-CoopProjectYml`, `Test-CoopMinorNewer`,
  `Coop-Confirm`, and `Invoke-CoopScript` now live in one file, dot-sourced by
  `bin/coop.ps1` and every `scripts/*.ps1` — ~600 lines of per-script duplication
  (the structural cause of the WindowsApps-stub and stream-drift bug class)
  removed. Behavior-preserving; `scripts/check-parity.sh` now gates the
  `lib/common.sh` ↔ `lib/common.ps1` pairing (and the new file's BOM), and
  CONTRIBUTING.md/AGENTS.md document the new rule: helper changes go into
  `lib/common.ps1`, never per-script inline copies.

### Fixed

- **Small install/doctor/parity fixes** (#16):
  - `coop install` no longer prints a green "Bootstrap complete" line when the
    closing doctor run failed — it now closes with a warning pointing back at the
    ✗ items (both `install.sh` and `install.ps1`); the doctor exit code still
    propagates as before.
  - `coop doctor` now warns when the found `mcp.json` still contains `TODO-`
    placeholders (`TODO-tenant-id` / `TODO-org-name` from `config/mcp.example.json`),
    mirroring the existing `project.yml` TODO check, on both platforms.
  - `bin/coop.cmd` passes `-NoLogo -NoProfile` to PowerShell like every other
    invocation in the repo, so corporate PS profiles can't slow or pollute `coop`.
  - Windows: `coop update --check` writes its version table to **stdout**
    (was stderr), so `coop update --check > versions.txt` captures it — matching
    the bash behavior.
  - `install.sh` now resolves Python via `coop_python` (accepts `python3` **or**
    `python`), so a python-only host gets pipx installed instead of silently
    skipping it while doctor reports everything fine.

## [0.12.3] — 2026-07-09

### Added

- **`docs/ci.md` — the three-gate suite CI recipe**, in both GitHub Actions and Azure
  DevOps flavors: `coop-sql-review check --strict` with SARIF uploaded to code scanning
  (GitHub) / the CodeAnalysisLogs "Scans tab" convention (ADO); `coop-dax-review check
  --strict` as an exit-code gate with HTML/Markdown report artifacts (its SARIF output
  lands in an upcoming release); and `coop-data-doc check` (freshness) + `build
  --non-interactive --strict` (strict rebuild) with the built docs published as
  artifacts. Documents the advisory-by-default / `--strict`-opt-in philosophy, the
  family exit-code contract per gate (0 clean / 1 environment / 2 findings), the
  gate-ordering rationale, `.coop/project.yml` path reuse, and `==` version pinning.
  Linked from README ("Sharing with your team") and docs/onboarding.md. (#24)
- **`coop release` now verifies the `tested_with` coop-tool pins before tagging**
  (`coop_release_check_pins` in `bin/coop`, mirrored as `Test-CoopReleasePins` in
  `bin/coop.ps1`): the three `config/defaults.yml` pins must match the sibling
  `../coop-website/versions.json` — the suite's single source of truth for released
  version strings — so `coop update --check`'s "tested" column can't drift
  releases-stale again. A mismatch aborts the release with the fix named; a missing
  sibling checkout warns and asks instead of hard-failing (`--yes` continues with a
  note, `--no-check` skips the whole gate). Documented in RELEASE.md. (refs #23)

### Changed

- **`config/defaults.yml` `tested_with` pins refreshed** to the tool versions
  released 2026-07-09 — coop-data-doc **0.30.1** (was 0.26.1), coop-sql-review
  **0.8.0** (was 0.2.3), coop-dax-review **0.11.0** (was 0.6.2) — so
  `coop update --check`'s "tested" column no longer trails the released tools by
  several versions. (refs #23)
- **README opens with a "Part of the coop suite" pointer** — the hub side of the
  suite's cross-linking: the three tools are standalone, `coop install` /
  `coop update` manage them, `docs/ci.md` gates them in CI. (refs #23)

## [0.12.2] — 2026-07-09

### Fixed

- **Windows: the PATH launcher survives accented install paths.** `coop install`
  wrote `%LOCALAPPDATA%\coop\bin\coop.cmd` with `-Encoding ASCII`, so a repo path
  like `C:\Users\José\...` became `?` inside the launcher and every `coop` run from
  PATH failed while install reported success. cmd.exe parses batch files in the
  console OEM code page, so the launcher is now written with the OEM encoding and
  the embedded path is verified to round-trip; when the path cannot survive the OEM
  code page, install warns to clone coop-agent into an ASCII-safe path.
- **Windows: `Get-CoopPython` no longer picks the Windows Store `python3` stub.**
  python.org's installer never creates `python3.exe`, so on stock Windows `python3`
  resolves only to the Store App-Execution-Alias stub under `...\WindowsApps\` —
  `Get-Command` succeeds while `--version` prints nothing. The resolvers in
  `bin/coop.ps1`, `scripts/update.ps1`, `scripts/doctor.ps1`, `scripts/sync.ps1`,
  `scripts/ado-digest.ps1`, and `scripts/ado-onboard.ps1` preferred `python3`, so
  YAML reads silently returned their defaults (disabling the tested-Pi-version
  update guard on Windows) and the ADO launchers hard-failed. All six now use the
  proven stub filter from `scripts/install.ps1` (skip `\WindowsApps\` resolutions,
  probe `--version`), kept textually identical across files pending the
  `lib/common.ps1` extraction.
- **Docs: the documented Windows install command now survives the default execution
  policy.** README and onboarding said `.\bin\coop.ps1 install`, which fails on stock
  Windows (`Restricted` policy → "running scripts is disabled on this system"). The
  documented command everywhere is now `.\bin\coop.cmd install` (the shim already
  invokes PowerShell with `-ExecutionPolicy Bypass`); the bare `.ps1` path remains as
  a footnote with the explicit
  `powershell -ExecutionPolicy Bypass -File .\bin\coop.ps1 install` fallback.

## [0.12.1] — 2026-07-08

### Changed

- **`coop sync` now backfills MCP servers that are new in the example but missing from an
  existing config.** Previously `sync` wrote `mcp.json` only on a fresh install and never
  touched an existing one, so a `coop update` never picked up MCP servers added to
  `config/mcp.example.json` in a later release. It now merges in any example server absent
  from your live config — **adding only, never overwriting** your existing entries or their
  tenant ids (`lib/_mcpmerge.py`, stdlib only). `coop doctor --fix` inherits this (it runs
  `sync`), and `coop doctor` now also reports the `azure-devops` server.

## [0.12.0] — 2026-07-08

### Added

- **Azure DevOps Boards integration** — a new `azure-devops` skill plus batch tools to
  manage Boards from coop without the web UI:
  - `scripts/ado-digest.py` — read-only, per-client watchdog digest (open / stale /
    unassigned per work item type) with identity-merged grouping, "newly stale" and
    "assigned to inactive account" flags, week-over-week deltas, Markdown/HTML output,
    and Microsoft Graph email (`--send`). Paired `.sh`/`.ps1` launchers.
  - `scripts/ado-onboard.py` — guided, read-only client discovery (org → project → team →
    area paths, state-category-based exclude proposals, duplicate-identity grouping) that
    writes only the local config. Paired `.sh`/`.ps1` launchers.
  - `scripts/ado_lib.py` — shared, dependency-free (stdlib only) auth / REST / WIQL /
    identity core, built on the REST `wiql` → `workitemsbatch` flow (not the unreliable
    `az boards query`).
  - `config/devops.clients.example.yml` — example config (placeholders only); real client
    config stays private at `~/.coop/devops/clients.yml`.
  - `config/mcp.example.json` — added the official `@azure-devops/mcp` server (read-focused
    `core work work-items search` domains) for interactive natural-language board queries.

## [0.11.0] — 2026-07-08

### Added

- **`coop update` version-ceiling + `--check`** (#13). Guards against an untested Pi
  version: a tested-version ceiling plus a `--check` dry-run so an update can't silently
  produce a pinned-agent/extension mismatch. Ported to both dispatchers.
- **coop-guardrails audit log** (#14). An append-only log of blocked/confirmed actions,
  so the guardrail layer leaves a reviewable trail.

### Fixed

- **`coop --no-launch` no longer launches the agent** (#4) — it was doing the opposite of
  its name and silently dropping following args, in both the bash and PowerShell
  dispatchers. Covered by a new `tests/update-guard.test.sh`.
- **coop-guardrails: `cd <dir> && git commit -am …` no longer bypasses the
  never-commit-source gate** (#5) — the staged check was running against the wrong repo.
- **coop web Files panel no longer keeps a stale selection / attach target** across tab
  switches and folder changes (#3).
- **coop web History previews show the user's first message**, not the raw
  `<coop-viewing-context>` wrapper (#6).
- **coop web `/resume` normalizes `DEFAULT_CWD` and compares with `samePath()`** instead
  of a naive string compare (#10).
- **coop web `/rpc` timeout is no longer a one-size 30s** (#11) — a long compaction no
  longer reports a false failure.
- **Vibes: the static duplicate hexagon is gone** — only the animated mark remains.

### Performance

- **coop web streams markdown without O(n²) re-rendering** (#7) — a text_delta no longer
  re-parses and re-renders the entire message.
- **coop web tab-switch replay no longer storms RPCs** (#8) — `get_session_stats` and the
  Files/Changes refetch fire once per switch, not once per replayed `agent_end`.

### Security

- **coop web localhost-bridge hardening** (per `docs/web-security-fix-plan.md`): an
  `ANSWERED_UI_MAX` cap on buffered answered-question payloads and the companion input
  bound (fixes A + B of the 2026-07-07 review).

### Internal

- **`check-parity.sh` gates dispatch/flag parity** (#9), not just file existence + BOM, so
  bash↔PowerShell drift is caught mechanically.
- **Node test suite (webbridge, protocol, guardrails) now runs on Windows CI** (#12) — the
  primary deployment platform previously had zero logic-test coverage.

## [0.10.0] — 2026-07-06

### Added

- **coop web — Changes panel (git diff viewer).** A read-only `± Changes` panel
  shows the working tree's git changes: a changed-files list plus a rendered
  unified/side-by-side diff (line numbers, add/remove coloring, intraline emphasis,
  in-file search, base-ref comparison). Badge refreshes after each agent turn;
  degrades gracefully when git is absent or the folder isn't a repo. Bridge-local
  git reads, jailed to the working folder — no new pi RPC.
- **coop web — grouped session history + high-fidelity resume.** 🕘 History now
  spans every workspace coop has been used in (current folder first, others as
  collapsible groups) with one-click cross-folder resume (switch + resume together).
  Resuming rebuilds the transcript from the session file itself — thinking blocks,
  tool calls with arguments/outputs, and compaction markers in order — with a
  `get_messages` text fallback for oversized/corrupt files.
- **coop web — broader extension-UI bridging.** Extension status segments and
  widgets render in a dock above the composer; `setTitle` sets the tab title,
  `set_editor_text` prefills the composer, multi-line `notify` keeps its line
  breaks, and any unknown extension-UI method renders a deduplicated fallback card
  instead of being silently dropped.
- **coop web — multiple parallel chats.** A header tab strip runs several
  independent governed `pi` subprocesses at once, each with its own transcript,
  model, working folder, and Files/Changes view (default 4, env `COOP_WEB_MAX_CHATS`
  1–8; `=1` behaves like the old single-session UI). Background tabs keep streaming
  with busy/unread indicators; a crashed tab is contained (crash card) while the
  bridge and other tabs keep running. One multiplexed SSE stream with `{sid,n,ev}`
  envelopes; per-chat replay served by `/events-poll?sid`.

### Changed

- **coop web — Pi RPC protocol contract + drift detection.** The wire contract
  coop-web depends on is now pinned in `web/protocol.mjs` with a bridge-side drift
  detector (stderr log + one-time toast on an unknown/shape-changed pi event; the
  event is still forwarded verbatim). Also hardens the JSONL framer with a
  `StringDecoder` (fixes a multi-byte-UTF-8 chunk-boundary corruption bug) and an
  oversized-line cap.

## [0.9.3] — 2026-07-03

### Security

- **Guardrails: closed the `git commit <pathspec>` bypass.** `git commit src/app.py`
  commits working-tree content straight past the index, so the staged-files-only check
  used to allow it. The hook now also diffs any explicit pathspec (and `--`-separated
  paths) against HEAD and blocks source. The destructive-git detectors (`git push
  --force`, `reset --hard`, `clean -f`) now tolerate `git -C <dir>` and interspersed
  flags, catch a `+refspec` force push, and match case-insensitively; `rm -rf`/`git
  commit` are matched case-insensitively too (macOS/Windows). Secret-file access is now
  also gated on **bash** commands (`cat .env`, `curl -F f=@.env`), not just the
  read/edit/write tools.
- **Launcher: `microsoft_skills.allow[]` no longer allows path traversal.** A hostile
  work-repo `.coop/project.yml` could name `../../../evil` and inject an arbitrary
  `SKILL.md` into the model; both `bin/coop` and `bin/coop.ps1` now validate each name.
- **`context-mode` MCP is documented honestly as sandboxed-exec (not read-only) and
  pinned** to `context-mode@1.0.162` in `config/mcp.example.json`.

### Fixed

- **Dependency-free YAML reader (`lib/_yaml.py`) no longer silently corrupts files.** A
  block list at the SAME indent as its key (the default `yq`/Kubernetes/Prettier style)
  used to parse as `null` and discard the rest of the file; multi-key list items lost
  all but the first key and leaked the rest into the parent map. Both are fixed, a BOM
  is stripped (`utf-8-sig`, for Windows-edited files), bare `null`/`~` coerce to `None`,
  block scalars no longer leak child keys, and a genuine PyYAML syntax error no longer
  falls through to the fallback parser.
- **`coop install` / `coop update` now exit non-zero when doctor reports a required item
  missing** (bash always exited 0; PowerShell propagated an incidental code) — so a
  broken install is detectable by the double-click launcher and onboarding automation.
- **Ctrl-C during install/update now actually aborts** instead of cleaning up and
  resuming the run.
- **Launch preflight guards the tree Pi actually loads** — with `COOP_NO_ISOLATE=1` it
  now targets `~/.pi/agent` and warns rather than silently mutating the personal tree.
- **Extension-realignment no longer destroys the tree on an offline reinstall** — the
  old `node_modules` is moved aside and restored if `npm install` fails (bash + PS).
- **`coop release` stages only the files it touches** (VERSION, CHANGELOG, extension
  manifests) instead of `git add -A`, so a shared working tree can't sweep stray files
  into the release commit (bash + PS).
- **A flaky `npm prefix -g` no longer bricks every `coop` command** under `set -e`.
- **Windows:** `coop web` reaps the whole `pi` process tree (`taskkill /T`) instead of
  orphaning the agent behind its `cmd.exe` wrapper; the server now has global
  `uncaughtException`/`unhandledRejection` handlers; a Windows Store `python` alias stub
  no longer reads as a real Python; the persistent-PATH write now broadcasts
  `WM_SETTINGCHANGE`; and `coop new-skill`/`new-prompt` write LF/no-BOM files.
- Vibe rotation excludes the internal crew file from the default pool (opt-in only), so
  it can't surface during a client screen-share.
- CI now enforces bash-3.2 compatibility on a macOS stock-shell job; the third-party
  release action is SHA-pinned.

## [0.9.2] — 2026-07-02

### Fixed

- **`coop web` polling fallback now clears the transcript on New Chat / folder
  switch / resume.** The reset signal (`__hello`) was broadcast to SSE clients only
  and never reached clients on the `/events-poll` fallback (used where a proxy or
  endpoint protection blocks SSE), so a new/switched/resumed session was appended
  below the old one. The server now surfaces a monotonic `epoch` in every poll
  response and the polling client resets when it changes; it also applies `cwd`
  every poll so a folder switch updates the header on that path.
- **`coop web` `GET /file` no longer serves dotfiles the Files panel hides.** The
  listing hid `.env`, `.git/`, etc., but the read path applied only the folder jail,
  so `GET /file?p=.env` returned its contents. Listing and read now share one
  `isHidden()` rule (segment-checked on the resolved path, both separators).
- **Windows: `coop web` opens its app window for Brave, Vivaldi, and Chromium.**
  `browserCandidates()` only checked Brave under `Program Files` and omitted Vivaldi/
  Chromium on Windows, so those (per-user by default) fell back to a plain tab; the
  win32 list now includes their `%LOCALAPPDATA%` and system paths, matching the docs.
- **Windows: `coop release` fails closed when its test/parity gate can't run.** On a
  host without Git Bash the PowerShell path skipped the gate but still tagged/pushed;
  it now aborts a push unless `--no-check` is passed (or `--no-push`), and surfaces
  test output on failure.

## [0.9.1] — 2026-07-02

## [0.9.0] — 2026-07-02

### Added

- **`coop web` UX-breadth pass.** The browser UI gains rendered **thinking blocks**,
  **expandable tool activity** with live `tool_execution_update` output, richer
  markdown (tables, ordered lists, blockquotes, rules, italics), a header **context
  gauge** + live status line + per-response token/throughput stats
  (`get_session_stats`, `message_end` usage), a read-only **Files panel** (tree +
  markdown/code/sortable-table preview, jailed to the working folder by lexical
  *and* realpath checks) with an opt-in "you're viewing this file" prompt
  attachment, **recent-folder** quick-switching (from session headers),
  **name-this-chat** (`set_session_name`), and a crash card when the agent exits.
  All bridge additions (`/files`, `/file`, `/folders`, two read-only/session-scoped
  RPC allow-list entries) stay behind the existing token+CSRF gates, add no
  dependencies, and are covered by the stub-pi suite (56 tests). The TUI,
  extensions, skills, and guardrails are untouched.
- **`coop web` opens as a native app window.** Instead of a browser tab, `coop
  web` now launches the first Chromium-family browser it finds (Edge → Chrome →
  Brave → Vivaldi/Chromium, on Windows/macOS/Linux) in `--app` mode with a
  **dedicated coop profile** — a chromeless window with its own taskbar/dock
  entry, the coop icon, and full isolation from the user's real browser session,
  with no Electron, bundle, or dependency. Falls back to a normal tab when no
  Chromium browser is present; `COOP_WEB_NO_APP=1` forces a tab and
  `COOP_WEB_NO_OPEN=1` opens nothing. On Windows the existing double-click **coop**
  shortcut lands straight in this window.
- **`git-helper` skill + `/pr-description` prompt.** Drafts a Conventional-Commits
  message and a structured PR description (summary, changes, lineage impact,
  standards/validation, rollback) from the current diff — so the human's commit is
  one paste. Drafts only: it never runs `git commit`/`push`/`merge`, and the
  never-commit-source guardrail is unchanged.
- **Process prompts `/spec-first`, `/annotate`, `/handoff`.** Spec-first writes a
  short approved spec (goal, constraints, data model + lineage, edge cases, test
  plan) before editing; annotate applies only Markdown-annotated review feedback;
  handoff emits a resume-cold summary (what changed, tested, files, blockers, next
  todos). The `coop-workflow` skill and `docs/guardrails.md` now name these as the
  working habits for non-trivial tasks (vertical slices, codify mistakes,
  annotations, handoff).

### Changed

- **`coop release` now gates on the full test suite + parity, not just the
  transpile.** The pre-tag check previously ran only `esbuild` over each
  `extensions/*/index.ts`; it now also runs `bash tests/run.sh` and
  `bash scripts/check-parity.sh` against the (already-clean) tree and aborts
  before tagging if either fails — so a release can no longer tag red tests or a
  broken bash/PowerShell pairing. Still bypassable with `--no-check`; mirrored in
  `bin/coop.ps1` (which runs the bash suites when `bash` is available).

## [0.8.1] — 2026-07-01

### Security / governance

- **`coop-guardrails` now covers the common `git commit` bypasses.** The
  "never commit source" block previously only inspected *staged* files, so
  `git commit -a` / `-am` (which auto-stages tracked changes at commit time) and
  `git -C <dir> commit` (global options before the subcommand) slipped through. The
  block now folds in the tracked modifications `-a` will stage and tolerates git
  global options, and runs the check against the repo the commit actually targets.
- **`coop-guardrails` now enforces MCP as read-only, best-effort.** It **confirms**
  any Fabric/Power BI/MCP tool call whose name looks like a mutation
  (create/update/delete/deploy/publish). MCP tool names vary, so this complements —
  it does not replace — Pi's tool approval and the advisory prompt; enable the
  optional `pi-permissions` extension for hard per-tool gating. Docs/README updated to
  state plainly that the Fabric MCP is read-only *by policy* (no server-side flag,
  unlike `powerbi --readonly`).
- **`agent_allowed_to_commit` is now parsed in both YAML forms.** The guardrails
  extension previously read only the flow form (`[ ... ]`), but the shipped
  `project.example.yml` uses block form (`- "…"`), so a user's custom allow-prefix was
  silently ignored (and diverged from the bash side, which reads both). It now parses
  block and flow forms, across all per-repository occurrences.

### Fixed

- **`config/mcp.example.json` no longer hardcodes a macOS PATH.** The `fabric` server
  pinned `PATH=/opt/homebrew/bin:…`, which broke the Fabric MCP on Windows (no `npx`
  on that PATH) and even hid `az`/pipx binaries on macOS. It now inherits the
  environment `coop` already prepares.
- **`coop web` no longer loads whole session files to build the history list.**
  `scanSessionFile` read the entire file despite a "bounded chunk" comment; it now
  reads a bounded head (256 KB), matching the intent and avoiding multi-MB reads
  across up to 30 sessions.
- **`coop-tools` neutralizes argument injection in review paths.** A model-supplied
  path beginning with `-` was passed straight to `coop-sql-review` / `coop-dax-review`
  as a flag; such paths are now prefixed with `./` so they stay positional.

### Changed

- **CI now runs PSScriptAnalyzer (error severity) on all `.ps1`** in addition to the
  language parse check, so PowerShell logic issues — not just syntax — are caught.
- `scripts/sync.sh` matches installed extension names with `grep -qiF` (literal),
  matching `sync.ps1`'s `[regex]::Escape` behavior.

## [0.8.0] — 2026-07-01

### Added

- **🕘 History in `coop web`** — resume a previous conversation in the current
  folder, ChatGPT-style. The picker lists this folder's sessions newest-first
  (named sessions show their `/name`; unnamed ones show their first message);
  picking one restarts the governed agent with that session and **backfills the
  transcript** (user turns, assistant replies, tool calls) so you continue where
  you left off. Bridge side: `GET /sessions` mirrors pi's session-dir encoding
  and scans headers cheaply; `POST /resume` is path-jailed to the current
  folder's session dir and restarts pi with `--session`; the active branch is
  pulled via `get_messages` and replayed as synthetic events (so refresh /
  polling clients see it too).

## [0.7.0] — 2026-07-01

### Added

- **Clickable working folder in `coop web`** — the folder shown in the chat
  header is now a button: click it, paste a path (File Explorer address-bar
  friendly), and the bridge **restarts the governed agent in that folder** with a
  fresh conversation — so tools, lineage docs, and the header always agree.
  Rejects folders that don't exist with a friendly message.

### Fixed

- **"I asked coop to `cd` but the folder at the top didn't change"** — asking the
  agent to change directories in chat only moves its *shell*; coop's native tools
  (`sql_review`, `data_doc` lineage, config detection) keep operating in the
  session's working folder, which is what the header truthfully shows. The new
  folder button is the correct way to move coop (documented in `web/README.md`).
  Internally the bridge now uses a restartable pi child (generation-checked exit,
  per-child stream buffers, fast-failing in-flight toolbar calls) so a folder
  switch can't kill the server or bleed a replaced child's output into the new
  stream.

## [0.6.0] — 2026-07-01

### Added

- **`coop web` toolbar** — the chat header gains **＋ New chat**, a **model
  picker** (type-to-filter across every configured model), a **🧠 thinking-level**
  chip (click to cycle), and **♻ Compact** (reports before/after tokens). Powered
  by a new whitelisted **`/rpc` relay** in the bridge that correlates pi's RPC
  responses to requests (claimed responses are request-scoped: never recorded in
  replay history or broadcast). Starting a new chat resets the replay buffer and
  every connected window.
- **`coop web` usage meter** — when an OpenAI/Codex model is active, the header
  shows the `pi-better-openai` subscription snapshot (percent **remaining** in
  the 5h and 7d windows) as brand-styled mini bars + text, refreshed every two
  minutes via the extension's `/openai-usage` command (its TUI footer meter
  doesn't cross RPC; this is the same data by another path). Hover for reset
  times. Usage notifications render as the meter instead of toasts.

## [0.5.2] — 2026-07-01

### Added

- **`coop web` working folder** — `coop web --cwd <dir>` runs the agent in an
  explicit folder (default: where you ran it; the desktop icon defaults to your
  home folder — change it via the shortcut's *Start in* property). The chat
  header now **shows the working folder** so you always know where coop is
  operating.
- **`coop web` request log** — the server console prints every request
  (`GET /events -> 200`, …), so a misbehaving client is diagnosable at a glance.

### Fixed

- **`coop web` died seconds after launch → "reconnecting…" and messages that
  never send** (root cause). The Start Here menu (and the data-doc offer) were
  `await`ed inside the `session_start` extension hook; in RPC mode that dialog
  can only be answered by the browser, and with `session_start` blocked nothing
  else held pi's event loop yet — **pi 0.80.2 exited cleanly (~1.3s in) before
  serving a single command**, taking the `coop web` bridge down with it. The page
  (already loaded) then showed "reconnecting…" forever, and since the UI renders
  everything from the event stream, sends looked dead too. The front door is now
  fire-and-forget outside the TUI (TUI behavior unchanged). Reproduced and
  verified fixed end-to-end in a plain folder.
- **"reconnecting…" when streaming is blocked** — on machines where streaming
  responses are buffered or blocked (corporate proxies / endpoint protection,
  even on loopback), the SSE event stream never opens. The page now **falls back
  automatically to polling** (`/events-poll`, plain finite GETs) when the stream
  doesn't open within 4s, a 15s heartbeat keeps healthy streams from being idled
  out, and a stale window (cookie from a previous `coop web` run) gets an
  explicit "session expired — close this window and start coop again" message
  instead of retrying forever.

## [0.5.1] — 2026-07-01

### Changed

- **The desktop "coop" icon now opens the chat window** (`coop web`, ChatGPT-style,
  Edge app-mode) — the experience non-terminal members asked for. A second
  **"coop (terminal)"** shortcut keeps the classic TUI one click away. The `coop web`
  server console starts minimized; closing it stops coop.

### Fixed

- **Generic/gear shortcut icon** — `themes/coop.ico` is rewritten with classic
  BMP frames (some Windows shells refuse ICOs whose small frames are PNG-encoded,
  which is what the previous file used), and shortcuts now set `IconLocation`
  with an explicit `,0` index. Re-run `coop install` to refresh the shortcuts.
- **Double-launching the coop icon no longer dies on a busy port** — `coop web`
  walks to the next free port (default port only; an explicit `--port` /
  `COOP_WEB_PORT` is still respected strictly).

## [0.5.0] — 2026-07-01

### Added

- **"Start Here" menu** — a fresh interactive session now opens with a guided menu of
  common Cooptimize tasks (document data, SQL/DAX review, impact check, Fabric review,
  work logs) instead of a blank prompt. Run **`/start`** anytime. Strictly additive:
  one keypress ("Something else — I'll type it myself") drops to the normal prompt,
  auto-open only happens on the *initial* launch (never `/new`/`/resume`/`/fork`), and
  power users can disable it for good with `COOP_NO_START_MENU=1`, the `start-menu.off`
  marker, or the in-menu "Don't show this automatically" choice.
- **Windows double-click launcher** — `coop install` now creates a **coop** shortcut on
  the Start Menu and Desktop (icon: `themes/coop.ico`, the Cooptimize logo in a spy
  fedora + mustache). It runs `bin/coop-desktop.ps1`, which finds (or first-run
  installs) coop and keeps the window open on error so the message stays readable.
- **`Install coop.cmd`** (repo root) — no-terminal first-time setup: double-click it to
  run the same `coop install` bootstrap with a friendly window and a pause at the end.
- **`coop web` (experimental)** — a friendly localhost **browser UI** over the *same
  governed* agent the terminal runs (Edge app-mode window on Windows). A Node
  built-ins-only bridge spawns `pi --mode rpc -a` from the shared launch spec and
  relays events over SSE: streaming chat with markdown-lite rendering, the Start Here
  menu and guardrail confirmations as clickable cards, human-readable
  `sql_review`/`dax_review` result cards (raw-JSON fallback), tool activity chips, a
  Stop button, and reconnect transcript replay. Hardened for its localhost scope:
  one-time token → HttpOnly SameSite=Strict cookie (timing-safe compare), strict CSP
  with no inline script/style, `X-Coop-CSRF` header on all POSTs, Host-header
  rebinding guard, 127.0.0.1 bind only. See `web/README.md`.
- **`coop launch-spec [--json]`** (internal) — prints the exact resolved `pi`
  invocation (args + env). The flag assembly that was duplicated between `bin/coop`
  and `bin/coop.ps1` is now a single builder per dispatcher
  (`coop_build_pi_args` / `Build-CoopPiArgs`) consumed by both the terminal launch and
  `coop web`, so surfaces can never drift. Guarded by a new test in `tests/run.sh`.

### Changed

- The startup data-doc setup offer is folded into the Start Here menu on initial
  launch (the menu surfaces "Document my data"); `/resume`/`/fork`/`/reload` keep the
  original offer exactly as before.

### Tests

- `tests/startmenu.test.mjs` (menu wiring + opt-out) and `tests/webbridge.test.mjs` +
  `tests/stub-pi.mjs` — 16 integration tests that drive the `coop web` bridge against
  a stub Pi (auth, CSP, CSRF, rebinding guard, SSE replay semantics, prompt
  forwarding, answered-dialog skipping).

## [0.4.1] — 2026-06-30

### Fixed

- **`coop update` no longer freezes on untracked files** — step 1's "skip the pull if the
  tree is dirty" guard used `git status --porcelain`, which **counts untracked files**. A
  single stray file in the checkout (a downloaded skill drop-in such as `skills/te-cli/`, an
  editor artifact, etc.) made every `coop update` silently skip its `git pull`, leaving the
  machine stuck on an old version indefinitely. The guard now ignores untracked files
  (`--untracked-files=no`); only **uncommitted changes to tracked files** block the
  fast-forward (and `git pull --ff-only` still fails loudly on its own if an incoming tracked
  file would overwrite an untracked one). bash + PowerShell.

## [0.4.0] — 2026-06-30

### Added

- **`coop update` progress bar** — `coop update` now shows the same animated overall
  bar + per-item braille spinner that `coop install` does (bash and PowerShell).
- **Launch-time extension skew guard** — before launching, `coop` verifies the Pi agent
  satisfies every installed extension's `@earendil-works/pi-ai` requirement. If the agent
  is too old it aborts with a clear, named message (e.g. *"Pi agent 0.79.9 is too old —
  pi-hermes-memory needs pi-ai ≥ 0.80.2 — update the Pi agent: coop update"*) instead of
  crashing deep in pi's extension loader; a merely-stale extension tree is re-aligned
  automatically. Bypass with `COOP_SKIP_EXT_CHECK=1`. (bash + PowerShell)

### Changed

- **Generalized pi-ai skew detection** (`lib/_extdeps.py`) — the "agent too old" check now
  derives the required pi-ai floor from **all** installed extensions' declared
  dependency/peer ranges (not just `pi-web-access`) and names the offending extension +
  required version. The agent-too-old result (rc 11) now takes precedence over the
  reinstall-recommended result (rc 10), since re-pinning can't fix a too-old agent. The
  helper output gained two appended fields (`required_floor`, `offending_ext`); existing
  consumers are unaffected.

### Fixed

- **`coop` could exit silently (code 11) on a too-old agent** — the new launch preflight's
  `align --check` returns a non-zero rc, which tripped `bin/coop`'s `set -euo pipefail` and
  aborted before the helpful message printed. All rc captures in `coop_launch_preflight` and
  `coop_align_ext_deps` are now errexit-safe (`|| rc=$?`).
- **`Coop-Unit` (PowerShell) falsely reported every step as failed** when `coop install` /
  `coop update` output was redirected or piped (e.g. CI, `coop update > log.txt`) — the
  non-TTY branch didn't wait for the background job before reading its result. It now waits
  (`Wait-Job`), mirroring bash `coop_unit`. Fixed in `install.ps1` and `update.ps1`.
- **"Agent too old" diagnostics** in `coop doctor` and `coop sync` now name the specific
  offending extension and the pi-ai version it needs (bash + PowerShell).

## [0.3.5] — 2026-06-29

### Fixed

- **Guardrail `git clean` force-detection** — `git clean -d -f`, `git clean -df`, and
  `git clean --force` are now caught (previously only the single fused `-fd`-style cluster
  triggered the confirmation).
- **Guardrail `rm` label** — a force-only `rm -f` is no longer mislabeled "rm -rf"; the recursive
  warning now fires only when `-r`/`-R`/`--recursive` is actually present.
- **Guardrail destructive-SQL gate** — now also prompts on `DROP PROCEDURE/INDEX/FUNCTION/TRIGGER/
  SEQUENCE`, and the `git push` force check no longer false-positives on an unrelated standalone
  `-f` later in the same shell line.
- **`Test-CoopValidName` parity** — the PowerShell validator now rejects leading-dash and dot-only
  skill/prompt names, matching bash `coop_valid_name`.
- **`coop doctor` parity** — `doctor.sh` accepts `python` as well as `python3` (matching
  `coop_python` and `doctor.ps1`); removed a stray extra MCP token from `doctor.ps1`.
- **`coop_warn` hint separator** — two-arg calls now render `message — hint` (was a plain space).

### Docs

- Corrected `tool-contract.md` `coop data-doc` artifact-search list/order (adds the default
  `data-docs/*` entries); fixed `guardrails.md` ("three" runtime rules, adds `git clean -f`);
  fixed the guardrails README commit-allow defaults, a stray `coop sql-review` artifact in
  `extending.md`, the context-mode "local server" wording, and the stale CHANGELOG note in [0.3.4].

## [0.3.4] — 2026-06-25

### Added

- **More `coop-internal` working vibes** — extra sociocracy/consent one-liners in
  `vibes/coop-internal.txt` featuring the crew (Joel, Eric, Tanner, Josh, Simar,
  April, Aaron) plus South Park / Star Wars / Star Trek / *Monty Python and the
  Holy Grail* (the "constitutional peasants" anarcho-syndicalist-commune bit)
  easter eggs. They ride along in the default rotation (which draws from every set)
  and `/coop-vibe coop-internal`; `professional.txt` stays client-safe.
- **Native lineage awareness + a `lineage` command on the `data_doc` tool** — the
  `data_doc` native tool (`extensions/coop-tools`) gained `command="lineage"`
  (`object` + optional `depth`): it returns ONE object's upstream inputs,
  downstream dependents, and relationships as JSON from the built graph, so the
  agent looks up consequences before touching a SQL object / DAX measure /
  semantic model instead of re-deriving lineage by hand (ambiguous names return
  candidates to choose from). A `before_agent_start` hook detects BUILT
  coop-data-doc outputs (`graph.json` / `manifest.json` under the configured
  output dir) and injects an **agent-visible, human-hidden** (`display: false`)
  note — once per folder — telling the agent to consult that lineage first; it is
  **silent and degrades** when no built docs are present (the docs are an aid, not
  a gate). `guardrails.md` gains the matching lineage-grounding + auto-detect /
  degrade policy.
- **`/setup-docs` skill + prompt** — a `setup-docs` skill and `/setup-docs` prompt
  cover the in-agent data-doc bootstrap (the native-dialog quick wizard in
  `extensions/coop-tools` that writes/patches `coop-data-doc.yml` and offers to
  build), including an agent-driven link-resolution step.
- **Live install progress bar** — `coop install` now shows a determinate overall
  progress bar plus an animated active-item line (`lib/common.sh`
  `coop_progress_begin`/`coop_progress_end` with a braille spinner; the
  PowerShell installer mirrors it), so a long bootstrap shows what it's doing
  instead of going quiet.

### Changed

- **Windows install adds `coop` to PATH automatically + clearer first-run
  message** — `install.ps1` links a `coop.cmd` launcher into
  `%LOCALAPPDATA%\coop\bin` and adds that dir to the persistent **user PATH**
  (idempotent), prepending it to the current process so install + doctor can call
  `coop` immediately; the closing message tells first-timers to **open a new
  terminal** when `coop` isn't on PATH yet. `install.sh` mirrors the
  new-terminal / make-it-permanent guidance.
- **Launchers resolve freshly-installed tools** — `bin/coop` and `bin/coop.ps1`
  now prepend the npm-global bin (`pi`) and the pipx bin (`fab`, `coop-*`) at
  launch (best-effort, only dirs that exist), so tools installed in the same
  session resolve without a new shell.
- **`coop doctor` (Windows) hardening** — `doctor.ps1` accepts `python` (not just
  `python3`); it extracts a version-looking token before reporting, so a stray
  REPL banner (node's "Welcome to Node.js v…"), an `Unknown command: -`, or a
  version-prefix no longer leaks into the check; and the `fabric-cicd` check
  probes the `ms-fabric-cli` pipx venv interpreter directly (via `pipx runpip`,
  falling back to the venv `python`) instead of deriving it from the non-symlink
  `fab` shim, which falsely reported "not installed" on Windows.

### Fixed

- **`coop data-doc` exit code + artifact summary (cross-repo review)** — on Windows,
  `Invoke-DataDoc` now captures the tool's `$LASTEXITCODE` and `exit`s with it after the
  summary, so a `coop-data-doc` failure is no longer masked (bash already propagated via
  `set -e`). The machine-readable-output summary now also searches the **default** output
  dir (`./data-docs`), not just legacy locations. `coop release` VERSION validation is now
  strict X.Y.Z on both platforms (a malformed `VERSION` fails cleanly instead of crashing
  mid-release in bash arithmetic). Docs: documented `coop doctor --fix` and the
  `coop release` flags (`--yes`/`--no-push`/`--no-check`) in the README/onboarding; fixed
  the `tool-contract` exit-code example (advisory exits `0`, `--strict` exits `2`); added
  `check` to the `coop sql-review`/`coop dax-review` examples in onboarding; refreshed
  `config/defaults.yml` `tested_with` tool versions (data-doc 0.26.1 / sql-review 0.2.3 /
  dax-review 0.6.2).
- **Pi extension `pi-ai` / `pi-tui` version skew (broke `pi-web-access`)** — coop's
  isolated extension tree (`~/.coop/agent/npm`) could end up with `@earendil-works/pi-ai`
  (and `pi-tui`) pinned at `pi-mcp-adapter`'s `0.74.x` while the agent ran `0.80.x`,
  so `pi-web-access` (peer `*`) resolved the stale `0.74.x` and its
  `import "@earendil-works/pi-ai/compat"` failed (`Cannot find module …/pi-ai/dist/index.js/compat`).
  `coop sync` now writes an npm **`overrides`** block pinning `pi-ai`/`pi-tui` to the
  **agent's own version** (from `pi --version` — the agent, pi-ai and pi-tui publish
  in lockstep, so it always resolves) and, when the installed tree is skewed, drops
  the lockfile and reinstalls so the override takes effect. Because `coop update`
  runs `pi update --all` (which bumps the agent) **before** sync, the skew can't
  survive an update. New cross-platform helper `lib/_extdeps.py` does the
  `package.json` surgery; `coop doctor` reports any remaining skew and
  `coop doctor --fix` re-pins + reinstalls. If the agent itself pre-dates pi-ai's
  `/compat` (< 0.80.1 — e.g. the `legacy-node20` build) while an installed
  `pi-web-access` needs it, alignment can't help: sync/doctor say so explicitly
  ("agent too old — `coop update`") instead of reporting a false-green.
  (`sync.sh`/`sync.ps1`, `doctor.sh`/`doctor.ps1`, `lib/common.sh`.)
- **Windows: `pi update --all` no longer corrupts the agent when a session is open**
  — on Windows the in-place update replaces the global agent via an atomic rename,
  which fails (leaving a half-written tree + a leftover `.pi-coding-agent-*` npm
  staging dir) if a coop/pi process has those files open. `update.ps1` now removes
  stale staging dirs first and **skips** the in-place `pi update --all` while a
  coop/pi session is detected, telling you to close it and re-run. (POSIX can
  replace open files, so `update.sh` keeps the in-place update.)

### Removed

- **Dropped the `d365-migration-review` skill + `/d365-migration-review` prompt**
  — replaced by the data-doc / lineage flow (`setup-docs` skill + `/setup-docs`
  prompt, native lineage awareness); the example project config no longer
  references it.

## [0.3.2] — 2026-06-21

### Added

- **`coop-guardrails` now guards secret files** — confirms before the agent
  reads/edits/writes a secret-looking file (`.env` [not `.env.example`], `*.pem`/`*.key`/
  `*.p12`, `id_rsa`/`id_ed25519`, `credentials`, `.npmrc`, `secrets.*`); declining
  blocks. Completes guardrail rule #7 (never expose secrets) alongside never-commit-source
  and destructive-command confirmation. (`.pub` keys and `*.example` are excluded.)
- **Skill/prompt validation** (`scripts/validate-resources.sh`, run in CI) — every
  `SKILL.md` must have `name:` + `description:` frontmatter and every prompt must be
  non-empty, so an authoring typo can't silently break loading.

## [0.3.1] — 2026-06-21

### Added

- **Automated test suite** (`tests/`) + CI coverage — the real logic now in the repo
  gets actual tests: the data-doc config writer/parser (round-trip, in-place update
  preserving rich config, quote/comment handling, dir-conflict) and `coop-guardrails`
  enforcement (drives the real `tool_call` handler: blocks source commits / declined
  destructive ops, allows docs-only/safe, honours the kill-switch). Run with
  `bash tests/run.sh`; CI runs it as a `tests` job.
- **Windows CI job** — a `windows-latest` job parses every `.ps1` with the PowerShell
  language parser, so the PowerShell mirrors are syntax-validated automatically (they
  were previously hand-written without a `pwsh` to check them).

## [0.3.0] — 2026-06-21

### Added

- **`coop-guardrails` extension** — runtime **enforcement** of Cooptimize governance
  (vs. the advisory `docs/guardrails.md` prompt). A `tool_call` hook on the agent's bash
  tool: **blocks `git commit`** when staged files include source (anything outside the
  allow-listed docs/logs/site paths, read from `.coop/project.yml`), and **confirms
  destructive commands** (`rm -rf`, `git push --force`, `git reset --hard`, `git clean
  -f`, `DROP`/`TRUNCATE`). Fail-open, feature-detected, `COOP_NO_GUARDRAILS=1` to
  disable, `/coop-guardrails` to inspect. Your own shell is never intercepted — only the
  agent's tool calls.

### Removed

- **Dropped `@aliou/pi-guardrails`** from the recommended extensions — it's pinned to the
  deprecated `@mariozechner` Pi (and was never loaded into coop's isolated dir anyway);
  `coop-guardrails` supersedes it with coop-tailored rules on the current Pi. (Lets you
  `npm uninstall -g @aliou/pi-guardrails @mariozechner/pi-coding-agent` to clean globals.)

## [0.2.1] — 2026-06-21

### Added

- **`coop release [patch|minor|major]`** — one-command release cut: bumps `VERSION` +
  the extension manifests, rolls the CHANGELOG `[Unreleased]` section into a dated
  release heading, commits, tags `vX.Y.Z`, and pushes (commit + tag). Guards on a clean
  working tree; `--yes` skips the confirm, `--no-push` stops at the local tag,
  `--no-check` skips the pre-tag transpile gate. Mirrored in `bin/coop.ps1`.
- **`coop doctor --fix`** — applies the safe remediations (`coop sync` for
  extensions/MCP/assets, `pipx install` for missing Coop tools), then re-checks.
- **Release GitHub Action** (`.github/workflows/release.yml`) — on a `v*` tag, publishes
  a GitHub Release whose body is that version's `CHANGELOG.md` section.

### Changed

- **`coop doctor` now checks the Node version** (Pi requires ≥ 22.19) and warns clearly
  instead of letting teammates hit a cryptic pi failure; flags a lingering deprecated
  `@mariozechner/pi-coding-agent` global install; and nudges a first-run **Pi login** when
  none is found. `coop release` verifies the extensions transpile before tagging.
- **Guardrails teach the new tools** — the agent is told to use `pi-web-access` (read-only
  web) and `@juicesharp/rpiv-ask-user-question` (structured questions for consent rounds);
  `coop init` now also points you to `coop data-doc setup` / `/setup-docs`.

## [0.2.0] — 2026-06-21

### Added

- **`daily-logger` skill + `/daily-log` and `/weekly-log` prompts** — make the
  workflow's "Log" step (step 10) concrete: append a structured entry (tasks done,
  source changes awaiting review, standards findings, open questions, next actions) to
  `docs/agent/logs/daily/YYYY-MM-DD.md` (path from `.coop/project.yml` →
  `logging.daily_log_path`). The log is a documentation artifact — committed with
  approval, never source.
- **Two more default Pi extensions** — `coop install` / `coop sync` now also install
  **`pi-web-access`** (web search / URL fetch / GitHub clone / PDF / video — read-only,
  complements the Microsoft Learn MCP) and **`@juicesharp/rpiv-ask-user-question`**
  (structured, typed-option questions the model can put to you — fits consent rounds).
  `context-mode` remains available as a read-only **MCP** server (not a `pi install`
  extension). Teammates can still add or remove any extension with `coop add` / `coop
  remove`, exactly like stock Pi.
- **In-agent data-doc setup** — coop now bootstraps `coop-data-doc` without leaving the
  session: a launch-time offer (when the folder has no `coop-data-doc.yml` — *Yes / Not
  now / Don't ask again*) and a **`/setup-docs`** command run a native-dialog quick wizard
  that writes/patches `coop-data-doc.yml` and offers to build. Pi runs tool subprocesses
  non-interactively (no TTY), so the tool's own questionary `setup` can't be driven from
  inside a session; the native dialogs (in `extensions/coop-tools`) fill that gap. A
  **re-run patches only the managed fields in place**, preserving anything from the full
  wizard (layers, branding, schema→model mappings, globs, dialect); "Don't ask again"
  writes a `.coop-data-doc.skip` marker. The full shell wizard (`coop data-doc setup`) is
  unchanged. The agent is also guided (guardrails + the `data-doc-analysis` skill) to
  consult the built docs for up/downstream impact before touching SQL/DAX/semantic models.
- **Pi-config isolation** — coop now runs Pi against its own agent dir
  (`~/.coop/agent`; override with `COOP_AGENT_DIR`) via the `PI_CODING_AGENT_DIR` env
  var, so only Cooptimize's curated extensions/settings/theme/MCP load — your personal
  `pi` (its extensions, themes, splash) stays untouched. Your login (auth/models) is
  shared in from `~/.pi/agent`; settings/extensions/MCP are isolated. Provisioned by
  `coop install` / `coop sync`. Disable with `COOP_NO_ISOLATE=1`.
- **Authoring scaffolders** — `coop init` / `coop new-skill` / `coop new-prompt` for
  bootstrapping a project contract, skills, and prompt templates.

### Changed

- **`coop update` now runs `pi update --all`** so it updates the Pi agent **and every
  installed extension** in one step. Pi's CLI changed so that bare `pi update` updates
  the agent only (`--extensions` = packages only, `--all` = both); coop's previous
  two-call sequence had stopped updating extensions.
- **coop renders its OWN footer + splash** via `extensions/coop-powerline` and no longer
  uses a third-party powerline footer — `pi-powerline-footer` was **dropped** (its welcome
  overlay couldn't be disabled, Nerd Font glyphs showed as `?`, and it duplicated the bar).
  The footer shows `⬢ Cooptimize · <branch>` on the left and `<model> · ctx N% · tokens ·
  $cost · <plan usage limits>` on the right, in plain text + common Unicode (no Nerd Font
  glyphs). It surfaces other extensions' status text (e.g. `pi-better-openai`'s plan usage
  limits / 5h+7d windows) via `footerData.getExtensionStatuses()`, so everything is in one
  clean bar. The splash is the truecolor block-art Cooptimize logo.
- **`fabric-cicd` is treated as a Python LIBRARY** (no CLI). coop installs it via
  `pipx inject ms-fabric-cli fabric-cicd` so `fabric_cicd` is importable in the Fabric
  CLI's environment; it's used in deployment scripts (`import fabric_cicd`, validate-only
  by default), NOT as a `fabric-cicd` command. `coop doctor` checks it's importable.
- `coop data-doc` / `coop sql-review` / `coop dax-review` now **flow straight through**
  to the underlying tool — every subcommand (`rules`, `upgrade`, the
  `coop-data-doc setup` wizard, …) and the tools' own interactive prompts (e.g.
  `coop-sql-review`'s subfolder picker) work, and the exit code propagates. The CLI no
  longer captures/summarizes review output. Interactive `coop-data-doc` setup is now
  available both in a shell (`coop data-doc setup`) and in-agent (`/setup-docs`; see
  Added). The AI agent's structured-JSON path is unchanged (native `sql_review` /
  `dax_review` tools in `extensions/coop-tools`).
- **Pi package moved to `@earendil-works/pi-coding-agent`** — the original
  `@mariozechner/pi-coding-agent` is deprecated upstream ("please use
  @earendil-works/pi-coding-agent instead going forward"). coop now installs, version-
  checks, and imports the `@earendil-works` package everywhere (`bin/coop` +
  `bin/coop.ps1`, the install/doctor scripts, `config/defaults.yml`, and the
  `coop-tools` / `coop-powerline` extensions). This raises the Node requirement to
  **22.19+** (Pi's current `engines`); teammates still on Node 20 can pin Pi's
  `legacy-node20` build. Pi's CLI flags coop relies on are unchanged.

## [0.1.0] — 2026-06-17

Initial release. **coop** is a branded Cooptimize layer on Pi — not a fork.
(Shipped on `@mariozechner/pi-coding-agent`; migrated to its successor
`@earendil-works/pi-coding-agent` — see [Unreleased].)

### Added

- **`coop` wrapper** — `bin/coop` (bash, macOS/Linux) + `bin/coop.ps1` / `bin/coop.cmd`
  (Windows). Subcommands: `doctor`, `update`, `install`/`bootstrap`, `sync`,
  `data-doc`, `sql-review`, `dax-review`, `fabric`, `version`, `help`, plus
  authoring (`init`, `new-skill`, `new-prompt`) and Pi-management aliases
  (`list`, `config`, `add`, `remove`, `pi`).
- **Cooptimize workflow** (`coop-workflow` skill) — principles-first (read-only
  first, plan-and-approve, back up, review, document, never commit source) with a
  default step sequence to adapt.
- **Governance guardrails** (`docs/guardrails.md`) appended to Pi's system prompt;
  the agent explains its choices but defers when told it's not needed.
- **Native tools** (`extensions/coop-tools`) — `sql_review`, `dax_review`, `data_doc`
  (advisory, read-only). **Branding** (`extensions/coop-powerline`) — logo splash,
  footer segment, sociocracy × D365/Fabric working vibes.
- **Standalone tools** wired via pipx: `coop-data-doc`, `coop-sql-review`,
  `coop-dax-review`, `fabric-cicd`; **Microsoft Fabric CLI** (`ms-fabric-cli`) with
  `fab`-collision detection in `doctor`.
- **Read-only MCP** (optional, fetched via `npx`): Fabric, Power BI, Microsoft Learn,
  context-mode. **Persistent memory** via pi-hermes-memory.
- **Official Microsoft skills** (`github.com/microsoft/skills`) wired **subordinate**:
  allow-listed + conflict-skipped + gitignored, fetched on demand
  (`scripts/fetch-microsoft-skills.sh`).
- Six domain skills, five prompt templates, the `cooptimize` theme, a dependency-free
  YAML reader (`lib/_yaml.py`), CI (`.github/workflows/ci.yml`), and docs
  (architecture, tool-contract, guardrails, extending, READMEs).

### Security

- Reviewed for secret exposure, command injection, and supply-chain before release;
  no secrets committed; `.gitignore` blocks credentials/venv/node_modules/caches.

# Changelog

All notable changes to coop-agent are recorded here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com); versions follow [SemVer](https://semver.org).

## [Unreleased]

### Added

- The coop window's first minutes (desktop UX review, Aaron 2026-10-03, six
  items). **Set-up card**: a fresh machine's launch notices (no model sign-in,
  `coop onboard`, `az login`) are one card on the empty screen and one banner
  line once the conversation has content, each item with its command and an
  Open in terminal button, instead of a warning toast per notice
  (`desktop/renderer/welcome.mjs`). **First-run Start menu**: the first launch on
  a profile (`COOP_FIRST_RUN`, as the terminal) opens `/start` once in the
  window too. **Approval cards**: a guardrails confirm shows the command or SQL
  as a code block, the question last, the Yes button labelled with its verb
  ("Run it", "Allow") and No as the default with the focus; the extension's
  decision and the answer it receives are unchanged
  (`desktop/renderer/dialogs.mjs`). **Question cards**: an `ask_user_question`
  (its RPC form numbers the options) shows each option's label and description
  on two lines with the header as the title, and a multi-select shows checkboxes
  plus a free-text field; the values sent back are the strings the extension
  offered. **Example prompts**: three chips on the empty screen, each a Start
  menu task in one sentence, fill the prompt. **Background notifications**: a
  Windows notification and a taskbar flash when a turn ends or coop asks a
  question while the window is not focused (Settings > Notify in the
  background; `desktop/lib/menu.mjs`). **Menu bar**: File, Edit, View, Session
  and Help, every entry one of the window's existing actions, with Theme as
  radios and View > Menu bar to hide it (Alt shows it again). Polish from the
  same review: the composer hint no longer repeats the placeholder, the `/` list
  shows a source only for extension, prompt and skill commands, the Auto-retry
  setting reflects what the window last set, and the Open folder toast says
  what the console is for. `desktop/PARITY.md` has the new rows; master plan
  revision 3.18 records the statuses and the follow-up rows D1h–D1j.

### Fixed

- `release.yml` publishes the coop window installer only after the same
  acceptance the PR job runs has passed on the exact bytes it publishes
  (#277): the tag's `installer` job now runs `desktop/scripts/verify-installer.mjs`
  (silent install, `coop.exe --doctor`, silent uninstall, profile untouched) on
  its disposable runner, keeps the report (installer SHA-256, package version,
  every step) as an artifact on success and failure, and the `release` job
  refuses to publish unless `desktop/scripts/check-installer-report.mjs` finds
  the report ok and its SHA-256 equal to the downloaded executable's. The report
  is attached to the GitHub Release beside the installer. A failed acceptance
  fails the tag run before anything is published.

- Guardrails: `git add <source> && git commit` (and `;`, newline, `git stage`,
  `git rm`, `git mv`, `add -A`, `add .`, `add -u` forms) no longer passes the
  never-commit-source gate on an empty or docs-only index. The gate now folds in
  what the earlier staging segments of the same command put into the index, and
  refuses a commit whose future index it cannot read (interactive and
  `--pathspec-from-file` staging). Compound docs-only staging and commits still
  work ([#282](https://github.com/kabukisensei/coop-agent/issues/282)).
- Guardrails: a Warehouse write on a managed **production** target no longer
  offers "Allow edits for this session" when its SQL happens not to contain the
  word "prod". The session option now depends on the environment coop's own
  managed-server config gives the Warehouse (dev or test only); production and
  unresolved targets ask for every write, and the prompt says PRODUCTION
  ([#283](https://github.com/kabukisensei/coop-agent/issues/283)).
- Native SQL (`fabric_sql_query`, `sql_impact`) runs against the project contract
  the session started with. The extension notes `.coop/project.yml` at session
  start and compares it on every call; a contract edited mid-session (by hand or
  `/setup-project`) gets `contract_changed` and connects nowhere until `/new` or a
  restart, so the executor can never reach a target the guardrails' trusted
  snapshot did not authorize
  ([#284](https://github.com/kabukisensei/coop-agent/issues/284)).
- `sql_impact` no longer presents an empty dependents list as "no dependents": a
  successful `downstream` section carries its `coverage` (this database only,
  dependents whose definitions the principal can read) and the tool text says
  "none visible" with the reasons a dependent would be missing
  ([#285](https://github.com/kabukisensei/coop-agent/issues/285)).
- `coop update` re-reads the fleet plan after the checkout moves to the new
  release, so one run converges Pi, the pipx tools and the npm tools to that
  release's pins instead of leaving them one release behind when only the
  manifest and the extension lock changed
  ([#280](https://github.com/kabukisensei/coop-agent/issues/280)).
- The coop window restarts Pi once per request: two overlapping Restart
  requests (the palette reopened during the shutdown) used to each start a
  replacement Pi, with the first running on unseen until the app quit. The main
  process now coalesces them and starts nothing for a window closed meanwhile
  (`desktop/lib/restart.mjs`,
  [#286](https://github.com/kabukisensei/coop-agent/issues/286)).
- The coop window keeps a refused draft whole: when Pi does not take a message,
  the text and every attachment chip come back (ahead of anything attached
  meanwhile, nothing doubled), and the image limits the RPC boundary enforces
  (five images, 4 MB each, 8 MB together) are checked before the draft is
  cleared, with a message that says which image to remove
  (`desktop/renderer/draft.mjs`,
  [#281](https://github.com/kabukisensei/coop-agent/issues/281)).
- Master plan register and `AGENTS.md` reconciled with the shipped tags: rows
  U1, N1, ST1, 11a, 15 and FA1 name the PR and the first tag that shipped them,
  the Phase 0 rows say which VM receipts are not recorded instead of "pending",
  and the `AGENTS.md` roadmap summary points at the register instead of
  repeating volatile statuses
  ([#278](https://github.com/kabukisensei/coop-agent/issues/278)).
- Pi's built-in `/bug` can no longer upload a report or session transcript from a
  coop session to Earendil's gateway (`radius.pi.dev`), which would have moved
  client data to a third-party service. coop launches Pi with `PI_RADIUS_GATEWAY`
  pointed at an unresolvable host, so the upload fails at once and Pi offers its
  local "Export as Zip" instead; an explicit `PI_RADIUS_GATEWAY` in the
  environment still wins. The launch-spec test checks it.
- `sql_impact` lists a view's dependents on a Fabric Warehouse. The Warehouse
  rejects `sys.dm_sql_referencing_entities`, so every trace there reported
  `downstream` as unavailable (found in the SQ live acceptance on the client's dev
  Warehouse). It now falls back to the `sys.sql_expression_dependencies` rows
  that reference the object, with the name still bound through `OBJECT_ID(?)`.

## [0.29.2] — 2026-10-02

### Added

- The coop window package (master plan D1c): an unsigned, per-user Windows
  installer of the window alone, built by electron-builder from a staged copy of
  `desktop/`, the `lib/*.mjs` modules it imports, the vibes, the splash and the
  icon, with pdf.js unpacked beside the asar and the September fuse policy
  applied (`desktop/installer/electron-builder.cjs`,
  `desktop/scripts/build-installer.mjs`). It installs under
  `%LOCALAPPDATA%\Programs\coop` without administrator rights, adds a
  **coop (window)** shortcut to the Start Menu and Desktop and an Add/Remove
  Programs entry, and keeps `~/.coop/desktop/data` on uninstall. Started from
  its shortcut, it asks for a folder, finds the terminal's `coop.cmd` the way
  `bin/coop-desktop.ps1` does and runs the new `coop desktop --app <exe>`, so
  the window gets the same launch checks, spec and Warehouse token as
  `coop desktop`; `coop.exe --doctor` prints one JSON line about the package.
  The `installer (Windows)` CI job builds the installer on every PR as the
  `coop-window-installer` artifact, installs it silently, runs `--doctor` and
  uninstalls (`desktop/scripts/verify-installer.mjs`); the release workflow
  builds it from the tag and attaches it to the GitHub Release, so teammates
  download it from the release page (`docs/install-windows.md`, step 6). Nothing else is bundled
  yet (D1d) and the package does not update itself (D1e).

## [0.29.1] — 2026-10-02

### Changed

- The window runtime's size is stated as measured on the first VM run: about
  150 MB to download and about 400 MB on disk (the install message, `README.md`
  and the master plan said "about 140 MB", which is the download alone).

### Removed

- `lib/tool-result.mjs` and `lib/knowledge-read.mjs`, `lib/knowledge-retrieve.mjs`,
  `lib/knowledge-sources.mjs`, with their four tests, which the gate lane no
  longer runs. Nothing under `bin/`, `lib/`, `scripts/`, `extensions/`,
  `skills/` or `prompts/` called them, and the TeamAI rows (K1-K3, v0.28.0)
  shipped without adopting them, so each module leaves together with the test
  that covered it ([#134](https://github.com/kabukisensei/coop-agent/issues/134)).

### Fixed

- `coop update --check` fetches from origin before it reads the release tags
  (the same fetch step 1 of `coop update` makes, warn-and-continue offline), so a
  release tagged since the clone's last fetch is reported as `would move to
  release vX.Y.Z` instead of `no newer release`. Fetching touches no file in the
  checkout, so `--check` still changes nothing.
- The install's `pipx` unit no longer fails a `coop install` whose pipx works.
  The unit (`Invoke-CoopPipxBootstrap` in `lib/common.ps1`) now uses the same
  probe as every other pipx step, so a pipx reachable only as `python -m pipx`
  (where `pip install --user pipx` puts it, off PATH) counts as present instead
  of being re-installed on every run, and its verdict is whether pipx answers
  after the step, not the job's return value alone: the installer re-checks that
  itself after the job (on Windows PowerShell 5.1 the job came back with no
  result on machines where pipx then worked, v0.23.5 through v0.29.0). A unit
  whose job dies or returns nothing now names the reason instead of printing a
  bare `! pipx`.
- The cause of that empty job: Windows PowerShell 5.1's first background job
  fails with "The Persistence Path does not exist" on a profile where
  `%LOCALAPPDATA%\Microsoft\Windows\PowerShell` does not exist yet (a fresh
  user, or an install whose profile variables point at a new folder). coop now
  creates that directory before its first job, and any install or update unit
  whose job returns nothing is run once more in-process so its real result is
  reported.

### Changed

- `coop-data-doc` pin 1.3.0 -> 1.3.1 (`config/release-manifest.json`): link
  decisions saved by coop-data-doc 1.2.0 keep working after the upgrade (the
  first rebuild no longer flags every unchanged decision, a changed source stays
  flagged until re-answered, and a stranded table-level answer is named by
  `cache_key_unmatched`). `coop sync` installs it; `coop doctor` reports an
  older copy as stale.

## [0.29.0] — 2026-10-02

### Removed

- `context-mode` is no longer part of coop. Its `ctx_execute`,
  `ctx_batch_execute` and `ctx_execute_file` tools ran shell commands the
  guardrails never checked, so `git commit`, `.env` reads and `fab rm` went
  through without the usual block or prompt, and its tool definitions added
  about 7,000 tokens to every request. `coop update` and `coop sync` now remove
  it from existing installs with `pi remove npm:context-mode`. The unused
  `mcp.context_mode` key is no longer written into new project contracts;
  existing contracts keep it harmlessly.

### Changed

- `pi-web-access` moves from 0.10.7 to 0.35.0. A fresh session now shows only
  a small `web_enable` tool, and the model loads the web tools when it needs
  them. Searches no longer open a browser review page by default. GitHub clones
  can't pop a Git Credential Manager sign-in on Windows, and a timed-out clone
  stops its whole process tree. Page fetches enforce the 5 MB limit while
  streaming, and `npm audit` on the package goes from 2 low findings to none.
  `code_search` is gone (`web_search` covers it), and `source_check` is new.

### Added

- `coop desktop [folder]` (master plan Phase 8, D1b): coop in a window. The
  same governed session as the terminal, drawn as a modern UI with four themes
  (Modern Dark, Modern Light, Retro Dark, Retro Light, switched without a
  reload): a streaming timeline with thinking, tool cards and edit diffs, the
  extension dialogs as cards (every guardrail approval, `/start`, the wizards,
  ask-user questions), `/` completion from Pi's command list, `@` file
  mentions and Tab path completion, model and thinking pickers, sessions in a
  sidebar with resume, fork, clone and a filtered session tree, `!`/`!!` shell
  commands, steering and follow-up queues, Ctrl+F search of the conversation,
  a status bar from the extensions' `setStatus`, toasts for notices and launch
  warnings, and Open in terminal on the same session for what only the terminal
  can show (model sign-in, `/trust`, `custom()` screens such as `/mcp-auth`).
  `bin/coop.ps1` runs the usual launch preflight and passes the window a launch
  spec with exactly `Build-CoopPiArgs`' arguments (`coop desktop --print-spec`
  prints it); the window runs `node <pi entry> --mode rpc <args>`, never
  `--approve`. Electron 44.5.1 is pinned in `config/release-manifest.json`
  (`desktop.electron`) with its own lockfile, `config/desktop-lock.json`
  (`node desktop/scripts/runtime-lock.mjs generate|check`), and installs on the
  first `coop desktop` into `<profile dir>/desktop/runtime` (about 140 MB with pdf.js;
  Electron's `install.js` checks the binary against the locked package's
  checksums), which also adds a "coop (window)" shortcut. `coop sync`
  refreshes the runtime where it exists, `coop doctor` reports it, and
  `coop uninstall` removes it and the shortcut. The renderer is sandboxed
  (context isolation, a strict CSP, `coop://app` files only), every RPC command
  is rebuilt field by field from an allowlist, and closing the window ends Pi
  and everything it started (taskkill /T, then any process Pi left behind).
  `desktop/PARITY.md` maps every Pi built-in command, keybinding action,
  extension command and extension UI request to what the window does.
  Tests: `tests/desktop.test.mjs` (gate: the modules, a replay of a recorded
  Pi 0.87.1 RPC session with coop's release extensions,
  `tests/fixtures/desktop-rpc.jsonl`, and the parity checklist against the
  window's lists, the recording and Pi's own command and keybinding lists),
  `tests/desktop-rpc.test.mjs` (extended: a real child process that hangs or
  crashes) and `tests/fixtures/desktop-spec.test.ps1` (`--print-spec` equals
  `launch-spec`, the runtime states). Re-record the session with
  `node desktop/scripts/record-fixture.mjs` after a Pi or extension upgrade.
- The coop window's side pane (master plan D1b2; Ctrl+\\, the pane button, the
  command palette, or a link in the conversation). **Changes**: every file
  changed since the last commit as a diff, unified or side by side, with
  search; a tool card's View in Changes opens its file. **Standards**: the
  coop-standards articles coop resolves for the folder (`lib/standards-cli.mjs
  resolve-many` and `status`, so exactly what a task is given: the wiki, the
  last copy, the copy shipped with coop or the project's override), with the
  source, its freshness, an article list and search. **Project**:
  `.coop/project.yml` as a form with `/setup-project`'s questions and checks;
  fields the guardrails read are marked, fields nothing reads are never shown,
  Review shows the YAML diff, and Save writes through the `/setup-project`
  writer (unowned fields kept, a backup written) and offers a new session.
  **Docs**: `/setup-docs` as a form that drives coop-data-doc's own wizard,
  then Build with its output streamed and the built docs readable in the pane
  (with a list of every object page and Find a page, because coop-data-doc's
  overview does not link them), the HTML portal one click away. The `/setup-project` writer and the
  `/setup-docs` driver moved from `extensions/coop-tools/index.ts` into
  `lib/project-contract.mjs` and `lib/data-doc-setup.mjs`, so the terminal and
  the window share one implementation; `tests/desktop-panes.test.mjs` checks
  that both forms write exactly what the terminal wizards write for the same
  answers. The parity checklist is unchanged.
- The coop window, second D1b2 batch (Aaron, 2026-10-02). **Attachments**:
  the paperclip, Ctrl+V and drag and drop attach up to ten files a message.
  Images go with the prompt when the model reads them (five, 4 MB each, as in
  the terminal); text files (Markdown, CSV, SQL, DAX, TMDL, YAML, JSON and the
  like, 2 MB) are referenced by path; Word, Excel, PowerPoint (`.docx`,
  `.xlsx`, `.pptx`, 25 MB) are read to Markdown by coop's own dependency-free
  readers (`desktop/lib/office.mjs`, `zip.mjs`, `xml.mjs`: paragraphs,
  headings and tables, every sheet as a table with dates and times resolved,
  slides with notes) and PDFs by pdf.js (`desktop/scripts/pdf-text.mjs`, run as
  its own node process with a 60 second limit, no rendering, no PDF
  JavaScript). Extracts are saved under the window's data folder
  (`attachments/`, pruned after seven days or one hundred files) and
  referenced by path in the prompt, so coop reads every document through its
  guarded read tool and the session log stays auditable; under the sent
  message the window shows the files as chips, not the note. `pdfjs-dist` 6.3.289
  is the runtime's second package, pinned in `config/release-manifest.json`
  (`desktop.pdfjs`) and `config/desktop-lock.json` next to Electron (the
  runtime is about 140 MB; its optional native canvas package is never
  installed: `npm ci --ignore-scripts --omit=optional`), checked by `coop
  doctor` and refreshed by `coop sync`. **Draggable panes**: the sidebar, the
  side pane and the split between the change list and its diff resize by
  dragging (or the arrow keys on the handle; double-click or Home resets), and
  the sizes are remembered. **Splash and vibes**: a new conversation shows the
  Cooptimize block logo (drawn from `extensions/coop-powerline/splash.ansi`
  as SVG, pixel-crisp in the retro themes), the wordmark, the taglines and a
  vibe from the same `vibes/*.txt` sets as the terminal; a fresh vibe shows on
  the working line and in the status bar each turn, and `/coop-vibe <set>`
  switches the window's pool with Pi's. **Concise activity**: a run of
  assistant messages with nothing else between them is drawn as one answer,
  and between two pieces of its prose the thinking and tool calls (across the
  model's messages too) fold into one line ("Read vSales.sql, ran git status, edited report.sql"; a live "Reading
  vSales.sql..." while it runs) that expands on click, opens by itself when a
  step fails, and stays open with Ctrl+O (Expand tool output); nothing is
  dropped from the session, only folded. **Readability pass**: stronger
  contrast tokens in all four themes, visible focus rings, tooltips on the pane
  tabs, change statuses and every icon button, a sticky Save/Review footer on
  the forms, and clearer composer hints. Tests: `tests/desktop-attachments.test.mjs`
  (gate: the readers over generated `.docx`, `.xlsx` and `.pptx` files, the
  PDF line builder, classification and limits, the store and pruning, the
  attachment note; with `COOP_TEST_PDFJS=<pdfjs-dist dir>` also the real
  pdf.js over a hand-written PDF), plus new cases in `tests/desktop.test.mjs` (the runtime
  lock with both pins, the activity fold) and `tests/desktop-panes.test.mjs`
  (the resizer limits).

- coop builds Fabric Apps (preview) with Microsoft's Rayfin CLI (master plan
  row FA1). The new `fabric-apps` skill scaffolds the web app, connects it to
  the client's semantic models, warehouses or lakehouses, and deploys it to the
  contract's dev workspace with a dry run first and Rayfin's telemetry off.
  The guardrails now ask before every Rayfin deploy (`rayfin up` and its
  subcommands, `rayfin secret set|delete`); the prompt names the dev workspace
  and warns when the command targets another one. Rayfin itself is not
  bundled: each app's `package.json` pins it, and Rayfin's own agent files
  (`rayfin init ai-files install`) carry the how-to.

- Windows acceptance for the `data_doc` wrapper and `/setup-docs` (master plan
  row 11a, DD4): a `datadoc-windows` job in `extended.yml` installs
  `coop-data-doc` at the manifest pin with pipx and the pinned Pi, then runs
  `tests/datadoc-live.test.mjs` from Windows PowerShell 5.1. The test drives the
  JSONL setup wizard, build, scan, check, lineage and impact through Pi's own exec
  and real pipes against a synthetic mixed estate with non-ASCII folder, file and
  object names. The extended lane of `tests/run.sh` runs it too, skipping when no
  `coop-data-doc` 1.3.0+ is installed.

### Fixed

- The `data_doc` wrapper now decodes the `\uXXXX`, `\xXX` and `\UXXXXXXXX`
  escapes `coop-data-doc` writes for every non-ASCII character in
  `coop-data-doc.yml`. Before, a non-ASCII project name, repo path or output
  folder read back garbled (`Entrep\u00f4t` became `Entrepu00f4t`), so `data_doc
  impact` matched no changed files under such a repo, a non-ASCII output folder
  looked unbuilt, and re-running `/setup-docs` saved the garbled project name.
- coop's footer wraps instead of cutting off the usage data. Since the footer
  fix in 0.26.0 it was one line clipped at the terminal edge, so in a narrower
  window (Windows Terminal at half screen, for example) the model, token and
  cost numbers and pi-better-openai's 5h/7d plan limits were lost off the
  right. It is still one line when everything fits; otherwise the left side
  keeps line 1 and the right side wraps onto right-aligned lines below,
  breaking between fields. Wide characters (CJK, emoji) in a session name now
  count as two columns, so they cannot push a line past the edge.

## [0.28.0] — 2026-10-02

### Added

- `coop teamai <status|install|init|pull|recall --query <text>>` (master plan
  Phase 7, K1: isolated CLI, read-only recall and sources). `lib/teamai.py`
  installs the manifest-pinned `teamai-cli` (`teamai` in
  `config/release-manifest.json`) with `npm install --prefix` into
  `<profile dir>/teamai/pkg` (never `-g`, never a `teamai` on `PATH`) and runs it
  with `HOME`/`USERPROFILE` redirected to `<profile dir>/teamai/home`, a disposable
  workspace, hooks and recall-quality recording disabled, inherited
  `TEAMAI_*`/`CLAUDE_*` variables dropped, no stdin and a hard timeout
  (`COOP_TEAMAI_TIMEOUT_SECONDS`). Each call prints one JSON document with
  `disabled`, `not_installed`, `not_initialized`, `ok`, `no_match`, `partial` or
  `unavailable`, a `stale` flag, and recall results capped at five with
  repository (token-redacted), revision, file, author, date and snippet
  provenance. Off by default: `coop onboard --config-only` asks for
  `knowledge.teamai` (`enabled`, `team_repo`, `provider`, `role`); `coop sync`
  installs and pulls only when enabled; `coop doctor` shows the trial's state;
  launch never touches it. The `team-knowledge` skill consults
  `coop teamai recall` only when `coop teamai status` reports `ok`, after the
  local search. The CLI's git runs under a push guard (`GIT_CONFIG_*`
  `url.no-push://.pushInsteadOf` for https, ssh and `git@` URLs), so the CLI's
  own writes to the team repository (the member registration `teamai init`
  commits to `teamai-reports`, `contribute`, `push`) cannot leave the sandbox
  while fetch and pull still work. Tests: `tests/teamai-adapter.test.py` (stub
  CLI, decoy `teamai` on `PATH` must never run, the guard blocks a push) and
  `tests/fixtures/teamai.test.ps1`.
- `coop teamai contribute --file <draft.md> [--title <text>] [--approve]` (master
  plan Phase 7, K2: reviewed contribution). The draft is swept first (GitHub,
  bearer and SAS tokens, private keys, URL credentials, credential assignments,
  SQL connection strings, a `client-confidential` or missing `sensitivity:`
  frontmatter marking) and a finding returns `refused` with the note kept local.
  The CLI runs only in `--dry-run` to name the exact `learnings/...` destination;
  the default call returns a `preview` with destination, branch and compare URL.
  `--approve`, after the person has reviewed that preview, stages the note on a
  new `coop/learning/<slug>-<stamp>` branch pushed from a disposable clone
  (`<profile dir>/teamai/stage`, removed afterwards) using the person's real git
  identity, and records it in `state.json`. The CLI's own `teamai contribute`
  (unreviewed write to the `learnings` branch) and `teamai push` (a pull request
  from inside the CLI) are never run; `GITHUB_TOKEN`/`GH_TOKEN` are no longer
  inherited by the isolated CLI. `/share-learning` carries the route for the trial
  repository; the `team-knowledge` skill points at it. Tests in
  `tests/teamai-adapter.test.py` (local bare team repo: one branch, one file, main
  untouched, five refused drafts).
- `coop teamai skills|maintenance|compare --query <text>` (master plan Phase 7,
  K3: broader knowledge lifecycle, read-only). `skills` lists the team
  repository's `skills/*/SKILL.md`; with `knowledge.teamai.skills` true (asked by
  `coop onboard --config-only`, off by default) `launch-spec` loads them through
  the subordinate team-skills slot (`Get-CoopTeamaiSkillsRoot` in
  `lib/common.ps1`: Cooptimize skills win every name or folder clash, the clone
  path comes from `<profile dir>/teamai/state.json`, the launcher never runs the
  CLI). `maintenance` reports stale learnings (`knowledge.teamai.stale_days`,
  default 180), proposals older than 90 days, malformed notes and duplicate
  titles without writing anything. `compare` runs the bundled local search and
  the isolated recall side by side on one query and reports the overlap (the
  section 8.5 evidence; the local search path stays). A failed `teamai init` is
  now remembered in `state.json` and the `not_initialized` documents, `coop sync`
  and `coop doctor` name the real next step; `coop onboard --config-only` clears
  a saved TeamAI repo or role with `-`. Tests: `tests/teamai-adapter.test.py`
  (K3 section) and `tests/fixtures/teamai.test.ps1` (launch-spec slot).
- `data_doc` command `impact`: every downstream object that changed source files
  feed, from coop-data-doc's own `impact` command (`--evidence`, so the evidence
  state comes with it). With `files` it reads the current built graph, so it
  needs no rebuild or committed docs; with `against` (a git ref) it diffs a
  rebuilt graph against that ref's committed `graph.json`. File paths reach the
  companion both as given and relative to each documented repo root. The
  `coop-workflow` skill (step 8) and `git-helper` (the PR description's
  **Lineage impact**) now call it before a change is presented.

### Changed

- Project contracts no longer carry policy fields that nothing enforced (#98):
  `coop init`, `/setup-project` and the sample contracts stop writing
  `estate.live_discovery` and `mcp.<server>.allowed_default_actions` /
  `requires_approval_actions`. The guardrails always hard-coded those rules, and
  `dev_test_rows: ask_first` contradicted dev reads running without approval.
  Guardrail behavior is unchanged. Migration: nothing reads these fields, so
  existing contracts keep working; delete them at your convenience.
  `docs/guardrails-reference.md` lists the contract fields that do change behavior.

### Fixed

- `coop doctor` checks the Power BI / Fabric npm tools against their release
  pins, not just their presence. An update from v0.24.0 left
  `@microsoft/powerbi-desktop-bridge-cli` at 0.1.2 against a pin of 1.0.0 while
  doctor showed it green; it now warns with `coop update` as the fix (a second
  `coop update` converges it). Doctor also names the retired `coop-sql-review`
  and `coop-dax-review` when an older install left them in pipx, with the
  `pipx uninstall` command. Found by the v0.27.0 update check on a client VM.
- The model now sees what `data_doc lineage`, `sql_impact`, `fabric_sql_query`
  and `bpa_review` found. Pi sends a tool's `content` text to the model and keeps
  `details` for the UI and session log only, and these tools put their results
  in `details`: the model got counts ("2 upstream, 1 downstream", "5 row(s)
  returned", "3 finding(s)") but never the object names, rows or rules. Each now
  renders them into the text (lineage and catalog items one per line, query rows
  as JSON arrays, BPA findings errors first), capped at 12,000 characters with a
  line saying how much was left out.
- `tests/run.sh` stops at once with one clear line when `pwsh` is on PATH but
  cannot start (Homebrew's formula without its .NET runtime), and the extended
  lane stops with the install command when Python has no `jsonschema`, instead
  of failing dozens of tests one by one (seen on a release check on macOS).
- `sql_impact`'s pointer to `data_doc lineage` now finds built lineage docs the
  same way the session-start note does: the nearest `coop-data-doc.yml` in this
  folder or a parent (or `COOP_DATA_DOC_CONFIG`), with `output.dir` resolved
  against the config's folder and `graph.json` present. Before, it looked only
  in the current folder, so a session opened in a subfolder of the estate never
  got the hint (`builtLineageDir` in `extensions/coop-tools`).
- `coop data-doc` summarizes the graph the run actually wrote. It asks
  `coop-data-doc show-config` which config was used (passing any `--config`)
  and reads `graph.json` from that config's output dir, so a build from a
  subfolder or with a custom output dir reports the right counts instead of
  nothing or an unrelated `manifest.json` in the current folder. Failed runs
  and subcommands that write no graph (`setup`, `check`, `lineage`) print no
  summary, and the summary reads the graph as UTF-8, so non-ASCII object names
  no longer silence it on Windows. New gate fixture
  `tests/fixtures/data-doc-summary.test.ps1`.
- Master plan: the `coop-data-doc` dependency row and row 11a now say #238 and
  #235 shipped in v0.26.0 (they still read "unreleased").

## [0.27.0] — 2026-10-01

### Added

- coop-guardrails: Power BI Desktop reload guard (S31). Before `powerbi-desktop
  reload` and before a `powerbi-report-author preview` that reloads the live
  window, coop reads `powerbi-desktop status` itself: an instance with unsaved
  changes asks first (blocked headlessly), an instance that cannot be verified is
  blocked, only a connected clean instance reloads. The rule used to be skill
  prose only; it is now enforced in code and tested against a stubbed bridge.

- First run shows the common workflows, not a wizard (master plan FR1, Phase 6).
  The first interactive `coop` launch on a machine opens the Start Here menu once
  (`bin/coop.ps1` hands coop-tools `COOP_FIRST_RUN=1` and writes
  `<profile dir>/first-run`); `/start` opens it any time and later launches go
  straight to the prompt. The menu is the plan's seven workflows: check SQL, DAX or
  a model against the standards; trace the impact of a change (`sql_impact`, then
  `data_doc lineage`); fix or edit an object on dev with approval (`/spec-first`,
  `/slice-next`); document a warehouse or semantic model; start a client project
  (`/setup-project`); write today's log or a handoff; sign in or check health
  (`coop doctor`, `az login`). While the local profile is missing, *Start a client
  project* asks the name coop calls you by and saves `user.json` with the balanced
  preset (`coop onboard` still edits the full profile).

### Changed

- A plain `coop` launch never runs the onboarding wizard any more and nothing in
  first-run setup can stop the launch (previously a missing or failed
  `scripts/onboard.py` run stopped it); an incomplete profile gets one line that
  names the menu item and `coop onboard`. `coop install` keeps its interactive
  "Personalize Coop" step. The Fabric workspace review left the `/start` menu
  (still `/fabric-architecture-review`).
### Fixed

- The Azure sign-in preflight no longer reports `Azure token check failed ...
  (not an auth error)` for a signed-in tenant on Linux and macOS. pwsh's
  `Start-Process` writes `-RedirectStandardInput` into the child's stdin only
  after the child has started, so an `az` that exited first (the fixture's fake
  az in CI, about 1 run in 100) failed that write with `Broken pipe` and
  `Invoke-CoopAz` lost the process (Rc 127). Off Windows the helper now starts
  `az` through .NET directly, closes stdin at once and drains stdout and stderr
  itself; Windows PowerShell keeps its `Start-Process` path unchanged.
- A canonical standards refresh whose `git clone` fails once is retried once
  before the source is marked degraded (a timeout is not retried), and the
  failure detail now carries git's last stderr line, so a transient clone
  failure on a loaded CI runner neither fails the live-sync test nor hides why.
- `tests/standards-lock-simple.test.mjs` (extended lane) no longer fails on macOS
  with `timed out waiting for .../serialized/A-entered`: its fixture root is now
  resolved to its real path, as the other standards tests do, because macOS keeps
  `tmpdir()` under the `/var -> /private/var` symlink that the standards
  storage-root check rejects, so the lock worker exited at once and the marker
  never appeared. The wait now also fails at once with the worker's stderr when
  the worker exits first, instead of reporting a timeout.
- The install/update busy guard (`Test-CoopPiConvergeAllowed`, issue #234) counts
  only coop/pi sessions run from the npm tree this install converges
  (`Get-CoopNpmGlobalRoots`), so an isolated install (a redirected profile on
  another drive) converges Pi in place and exits 0 while coop is open from a
  different install on the same machine. A session from the same install still
  skips the convergence with the same warning; with no npm root known, every
  session counts as before. `tests/fixtures/pi-busy-guard.test.ps1` (gate lane)
  covers both cases with fake process rows.
- `coop doctor` no longer calls the MCP set, or `powerbi-modeling-mcp`, read-only:
  the section header, the `powerbi-mcp-server` hint and the no-config hint now say
  that Fabric and Microsoft Learn are read-only while the Power BI Modeling, Azure
  DevOps and Warehouse SQL servers are approval-gated (every edit asks first). The
  `coop-workflow` and `power-bi-impact-analysis` skills and `.coop/project.example.yml`
  use the same wording (#194).

## [0.26.0] — 2026-10-01

### Added

- `sql-formatting` skill: coop lays out the T-SQL it writes, or is asked to
  reformat, in the Cooptimize style by default: the coop-standards *SQL Layout*
  article where it speaks (six-space select lists with the comma one column left
  and no space after it, five-space CTE names, `JOIN` aligned with `FROM`, `ON`
  four spaces under the join, `AND`/`OR` four under `WHERE`/`ON`, one `WHEN` per
  line, unnecessary brackets removed on a full reformat), and Aaron's SQL Prompt 11
  style for everything else (uppercase keywords, functions and types with
  object-definition casing kept, aligned aliases and comments, expanded statement
  parentheses, the 75/78-character collapse thresholds, `=` on its own line in
  assignments, DDL alignment, terminal semicolons). The style export
  (`skills/sql-formatting/sql-prompt-cooptimize-style.json`) and the format-action
  settings (`sql-prompt-layout-options.xml`) ship unchanged next to the skill, which
  states the contract, what formatting never does (no wildcard expansion,
  qualification, `AS` or alias changes; presentation only, unrelated lines
  untouched) and the six points where the export and the wiki differ (wiki wins).
  `examples/formatted.sql` is the worked example and
  `tests/sql-formatting.test.mjs` (gate lane) checks the export, the contract text
  and the example. The `coop-workflow` skill points at it from step 6.
### Removed

- Test modes and override seams (master plan S7, row 8, issue #228):
  `COOP_UPDATE_GATE_DRYRUN` and `COOP_FLEET_TEST_MODE` (install and update now
  always run through their last step), `Get-PiLatest` with
  `COOP_PI_LATEST_OVERRIDE` (`--pi-latest` still warns and means `--edge`), and
  the dead `COOP_PYPI_LATEST_OVERRIDE`. `scripts/check-bom.sh` (replaced by
  `scripts/check-bom.ps1`). The version copies in `config/defaults.yml`
  (`pi.update_all`, `pi_extensions`, `coop_extensions`, `python_tools`,
  `fabric_cli`, `npm_authoring_tools` and every `tested_with` key but `pi_min`):
  `config/release-manifest.json` is the one manifest, read by `coop doctor`,
  `coop release`, `coop init --ci` and the fleet digest.
- Dead tool helpers (master plan S6, row 8, issue #226). `extensions/coop-tools`
  lost the old local `coop-data-doc.yml` writer the JSONL wizard replaced
  (`renderMinimalConfig`, `updateConfigText`, `trailingComment`,
  `outputDirsConflict`, `withinOrEqual`, `siblingSite`, `dirExists`, the
  `DEFAULT_SQL_*`/`DEFAULT_PBI_*` glob lists and the write-only `siteDir` /
  `output.site_dir` field, which `parseExisting` no longer reports);
  `extensions/coop-guardrails` lost its unused `GIT_COMMIT_RE`, `GIT_PREFIX`,
  `segmentAround`, `parseAllowedGlobs` and `parseRepoCommitPolicy` (the
  per-repository globs are pinned through `parseRepoEntries` / `commitPolicy`
  instead); `lib/standards.mjs` lost the stale `RESOLUTION_STATES` list; and
  `coop doctor` no longer matches the never-emitted `PENDING_OWNER_PROVISIONING`
  and `invalid_preserved` standards states. `tests/datadoc.test.mjs` is replaced
  by `tests/review-scope.test.mjs` (the live reader and review-scope cases plus a
  `parseExisting` case on literal YAML).

### Changed

- `data_doc` (master plan row 11a, DD4): the wrapper finds `coop-data-doc.yml`
  the way the companion does (`COOP_DATA_DOC_CONFIG`, then the working folder
  and its ancestors, symlinks resolved) and resolves wizard path pickers and the
  output folder against that config's folder; the session-start lineage note
  needs `graph.json` and mentions object pages only when `manifest.json`
  exists; `lineage` reports the companion's evidence state and says that an
  empty result never proves zero impact (older companions report `unknown`);
  a failed scan/build or a read-only `check` no longer claims artifacts. The
  JSONL setup child runs with `PYTHONIOENCODING=utf-8`.
- `coop-data-doc` pin 1.2.0 -> 1.3.0 (`config/release-manifest.json`): the mixed-estate
  lineage release (coverage declarations, `lineage` evidence, source/output safety,
  identity collisions, UTF-8 JSONL pipes). `coop sync` installs it; `coop doctor`
  reports an older copy as stale.
- Read-only SQL on a dev target no longer asks for approval. When the guardrails
  resolve a Warehouse SQL call's bounded scope (one plain `SELECT` with a literal
  `TOP`, through the managed `fabric-sqlendpoint` proxy or the exact
  `fabric_sql_query` fallback) and the trusted managed entry or the contract's
  `sql_targets` default entry says the target is `dev`, the read runs without a
  prompt and without a session grant; the audit
  records it as `dev-read-only`. Test and production targets, unbounded or
  ambiguous SQL, generic MCP row reads and every mutation ask as before.
- Tests (S7, #228): one helper library `tests/fixtures/_common.ps1` (Ok/Ko,
  Save-Env/Restore-Env, sandbox home, shims, Python stubs, doctor rows, git and
  process helpers) dot-sourced by every fixture; `tests/run.ps1` runs
  `scripts/check-bom.ps1` first and launches the child fixtures from one
  table-driven loop with a lane column (gate / extended); `fleet-execution` and
  `home-guard` run install and update to the end under the sandbox and assert on
  the call log and the failed-step summary lines; `tests/run.sh` keeps one
  forwarder smoke for `--no-launch`. `coop release` and `scripts/release.sh`
  check the coop-tool pins of `config/release-manifest.json` against
  coop-website's `versions.json`; `docs/ci.md` shows pipeline pins as
  `==<version>` placeholders. `coop doctor`'s `fab` collision hint names the
  Python `fabric` package and `pipx ensurepath` instead of Homebrew. Docs and
  agent instructions describe one PowerShell implementation (no parity, no bash
  3.2, four companion extensions, the manifest as the one version source).

- `coop doctor` reads the Pi floor from `config/defaults.yml` `tested_with.pi_min`
  (0.79.0 only when the key is missing) instead of a hard-coded 0.79.0;
  `coop-tools`' `findProjectYml` is `lib/standards.mjs`'s `findProjectContract`;
  `parseRepoEntries` now drops a trailing `  # comment` from a block-list commit
  glob the way it already did for scalar values (the deleted `parseAllowedGlobs`
  did too);
  a new `tests/lineage.test.mjs` pins the `data_doc` tool's `lineage` branch and
  the session-start lineage note. The setup-docs prompt and skill now say the
  config is written only when the wizard emits `complete` AND exits 0 (as the
  bridge requires) and that the flow needs coop-data-doc 1.1.1+; two
  `bin/coop.ps1` comments stopped pointing at the retired bash launcher.
- Shared token/MCP checks; Doctor stays observational (master plan S4, row 8,
  issue #224). The retired `coop web` sign-in window is gone from `lib/common.ps1`
  (`Invoke-CoopAz` / `Invoke-CoopAzPreflight` lost `-NewWindow`, and
  `Start-CoopPsWindow` / `ConvertTo-CoopPsLiteral` with it); the launch preflight
  and `coop doctor` print one shared hint pair (`Get-CoopAzLoginHint` /
  `Get-CoopAzTokenHint`), and a test asserts `Test-CoopAzAuthError`'s markers equal
  the Node helper's. `lib/fabric_token_runner.mjs` is the one launch-frame
  validator: `Get-CoopFabricMcpToken` only splits the validated frame and keeps the
  state-to-message table, and the warning states live once as `WARNING_STATES` in
  `lib/warehouse_mcp.py` (a test pins the runner's enum to it). In Python,
  `managed_sqlendpoint_entry` is the one ownership rule (doctor, `launch-token`,
  `fabric_sql_query`), `ITEM_URL_RE` the one item-URL shape, `select_target` is an
  alias of `project_target`, `integration_enabled` the one integrations-flag rule
  (`lib/mcp_config.py` reuses it), and `jwt_identity` a strict shared JWT identity
  mirroring `fabric_request_headers.mjs` (`fabric_sql_query` dropped its lenient
  copy and its own `SQL_RESOURCE`). `coop doctor` resolves the client tenant once
  through `Get-CoopTenant`: the Warehouse row names it only when it is that
  resolved tenant, and the project-contract row reports a TODO `fabric.tenant_id`
  as empty and a non-GUID/non-domain value as invalid. `doctor_status` now also
  returns `config_state`, `probe_state` and `usable`, and the Warehouse row says
  `usable`, `configured (not probed)` or `probed: <state>`; the existing `state`
  values and `registered` string are unchanged.
- One install/update/sync convergence path (master plan S2, row 8, issue #222).
  `lib/common.ps1` now owns the fleet: `Get-CoopFleetPlan` is the one
  manifest-driven list (Pi, extensions, the Coop tools, the Fabric CLI, the npm
  authoring tools, Desktop Bridge on Windows only) that `coop install`, `coop
  update`, `coop sync` and `coop uninstall` read instead of their own copies;
  `Invoke-CoopPiConverge`, `Invoke-CoopPipxConverge` (one pipx runner with the
  `python -m pipx` fallback, one `pipx list` probe, a postcondition that the
  installed version equals the pin), `Invoke-CoopFabricCliConverge` (the `fab`
  identity check on top) and `Invoke-CoopNpmToolConverge` are the one probe and
  one install branch per component, run inside the `Coop-Unit` jobs through
  `$script:CoopConvergeUnit`; `Sync-CoopExtensionFleet` is the one `pi install`
  path (pins, lockfile, pi-ai/pi-tui alignment, postconditions). Behaviour that
  follows: `coop update` skips Pi and every pipx/npm tool already at its pin (an
  offline no-op, like install), converges a drifted one, and installs a missing
  one without `--force`; install no longer runs its own `pi install` or a
  `pipx upgrade` fallback, and extensions converge once, in the sync child both
  commands run (install is now 8 steps); `--edge` moves Pi and the tools to
  upstream latest while the extensions stay at their pins; an npm tool without a
  manifest pin fails in normal mode; the busy guard (`Test-CoopPiConvergeAllowed`:
  leftover `.pi-coding-agent-*` staging dirs removed, no in-place Pi convergence
  under a running session) now covers install too; `coop update --check` and
  `coop doctor` reuse the probes, and doctor's Power BI hints name the manifest
  pins. No pin changed.
- One profile root (master plan S3, row 8, issue #220). `COOP_DIR` now means one
  thing everywhere: the parent of `.coop` (profile at `$COOP_DIR/.coop`, default
  `~/.coop`). `coop support` (`lib/support-center-cli.mjs`) and `coop context-budget`
  read the profile there instead of treating `COOP_DIR` as the `.coop` folder
  itself, and the first-run gates, the `coop-profile` / `coop-powerline` profile
  readers, `coop sync`'s MCP generation, `coop doctor --publish`, `fleet-digest`,
  `ado_lib` and the standards roots honour `COOP_DIR` instead of reading the real
  home. The agent dir Pi actually loads is one chain in every language
  (`PI_CODING_AGENT_DIR` → `COOP_NO_ISOLATE` truthy `1|true|yes|on`, any case →
  `~/.pi/agent` → `COOP_AGENT_DIR` → `<profile dir>/agent`), including
  `coop onboard`'s MCP output, the guardrails audit log and the Fabric SQL
  launcher. The inline copies in `bin/coop.ps1` and the scripts go through
  `Get-CoopProfileDir` / `Get-CoopUserProfileFile` / `Get-CoopEffectiveAgentDir`
  (`lib/common.ps1`), `lib/coop_paths.py` and `lib/paths.mjs`. No new variables;
  with nothing set every path is unchanged. The acceptance harness no longer
  re-points `COOP_DIR` for the candidate's Support Center.

### Fixed

- Manual `/compact` and automatic compaction no longer time out over a WebSocket
  when Pi's Transport setting is `sse` (#236). Pi 0.87.1 builds its compaction
  request without the session's transport, so the OpenAI Codex provider fell back
  to `auto` and opened a WebSocket for the summary even after `/settings` was set
  to `sse`, failing with `WebSocket idle timeout after 300000ms` on a large
  context. `extensions/coop-tools` now answers `session_before_compact` with a
  summary it generates through Pi's own `compact()` over the configured SSE
  transport (same model, thinking level, credentials, idle timeout and retry
  policy; manual, threshold and overflow compaction alike). With any other
  transport, a model whose provider ignores `transport`, or a Pi without the
  seam, Pi's own compaction runs unchanged; a provider failure during the SSE
  summary surfaces as one `session_compact_failed` with the history intact.

- `coop sync` no longer re-injects `fabric-cicd` and `pyodbc` into the Fabric
  CLI environment on every run (#186). A library already at its manifest pin is
  left alone, so a converged sync makes no `pipx inject` call and needs no
  network; only a missing or drifted library (or `fabric-cicd` under `--edge`)
  is re-injected. When pip does fail, the warning now carries pip's last
  `ERROR:` line instead of hiding it, so a transient download failure no longer
  reads as an unexplained sync failure.

- `coop sync` from a PowerShell 7 window. `coop.cmd` starts Windows PowerShell
  5.1, which inherited pwsh's `PSModulePath` and could not load `Get-FileHash`,
  so the lockfile comparison errored, the shipped lock was skipped and sync still
  printed `✓ sync complete.` (seen on the development VM, 2026-10-01). The lock
  hashes now go through .NET (`Get-CoopFileSha256`), and `coop.cmd` clears
  `PSModulePath` so 5.1 rebuilds its own module path.
- `coop install` convergence on Windows (#213). The Pi and pipx install units run
  in a background job that sees none of the installer's variables, so a drifted
  Pi was reported `pi present — no manifest pin` and never converged, pipx tools
  installed without their `==pin`, and `--edge` never upgraded an existing Pi or
  tool. The units now receive the edge flag, package and pinned spec as
  arguments, and a Fabric CLI unit that did not converge no longer gets the
  Python runtime injected into the wrong venv.

### Removed

- The POSIX product path (master plan S1, row 7). coop is one implementation, in
  PowerShell: `bin/coop.ps1`, `lib/common.ps1` and `scripts/*.ps1`, launched by
  `bin/coop.cmd`. `lib/common.sh` and the bash lifecycle scripts (`install.sh`,
  `update.sh`, `sync.sh`, `doctor.sh`, `uninstall.sh`, `sync-knowledge.sh`,
  `support-center.sh`, `check-context-budget.sh`, `test-pi-matrix.sh`,
  `migrate-from-pi-analytics-agent.sh`, the `ado-*` and `fleet-digest` wrappers)
  are gone, and so is the bash/PowerShell parity gate (`scripts/check-parity.sh`):
  `scripts/check-bom.sh` keeps the `.ps1` UTF-8 BOM and 5.1-safety checks. The
  bash test suites that only exercised the removed scripts are gone with them;
  the behavioural coverage that still applies now drives the `.ps1` files from
  `tests/run.ps1` fixtures. macOS and Linux are development checkouts for the
  logic tests, not installations: the Mac-only troubleshooting entries (split
  Node toolchains, Homebrew `fab`) and the bash 3.2 rule are retired.

### Changed

- `bin/coop` is a Git Bash forwarder: every argument goes to `bin/coop.ps1`
  under `pwsh`, `powershell.exe` or `powershell` (exit 127 with a pointer to
  `docs/install-windows.md` when none is installed). `coop release` is the one
  maintainer command that stays in bash (`scripts/release.sh`, reached through
  `./bin/coop release`); its gate now runs `tests/run.ps1` under `pwsh` when
  available and `scripts/check-bom.sh` instead of the parity check.
- `fabric_sql_query` resolves the Fabric Python through `lib/common.ps1`
  (`Get-CoopFabricPython`) on every platform: `powershell.exe` on Windows, `pwsh`
  on a macOS or Linux development box.
- CI: the macOS bash 3.2 job is retired; the `shell` job lints only the bash dev
  tooling (forwarder, release and check scripts, test harness) and runs the BOM
  check.

### Removed

- The SQL and DAX review wrappers (master plan ST1, decided by Aaron on
  2026-09-28 and 2026-09-30: no client pipeline runs them). The in-agent
  `sql_review` / `dax_review` tools, the `coop review`, `coop sql-review` and
  `coop dax-review` commands, the `coop-sql-review` / `coop-dax-review` pipx
  installs (install, update, doctor rows, `tested_with` pins, release-manifest
  pins), the two skills, their vibe pools, the CI scaffold's SQL and DAX jobs
  (`coop init --ci` now generates only the coop-data-doc lineage-docs gate and
  needs a `coop-data-doc.yml`), and the contract template's `coop_sql_review` /
  `coop_dax_review` entries are gone. Standards are enforced while coop writes:
  every SQL, DAX or semantic-model task already receives the active
  coop-standards wiki articles, and the workflow's review step becomes a
  self-check against those same articles that names any rule the change could
  not meet. `bpa_review` (Tabular Editor BPA) stays as the deterministic model
  check. `coop uninstall` still removes the two retired venvs when an older coop
  left them behind. The two CLI repositories are archived separately.
- The reviewer-discovered bundled fallback (`bundled_fallback`). It found a
  standard by running a reviewer CLI and binding its provenance, so it leaves
  with the reviewers, together with the `.coop/reviews` accepted-generation
  store, reviewer report validation and the `verify-report` / `promote-run` /
  `accepted-run` CLI subcommands. The per-domain snapshot file keeps its role as
  the resolution's content address; its header now reads "coop standards
  snapshot" instead of "reviewer-input cache". Its replacement is the bundled
  copy below.

### Added

- A bundled copy of the coop-standards wiki (`config/standards-bundle/`: the
  active articles at their wiki paths plus `bundle.json` with the source
  revision, capture time and per-article hashes), so a first run or an offline
  machine still works to the standards. Resolution order is now project
  override, canonical, stale last-known-good, bundled copy, unavailable. A
  domain served from the copy says so (`state=bundled`, the capture date and a
  "run coop sync when online" note in the agent's context; a `coop doctor`
  warning). Maintainers refresh it before a release with
  `node lib/standards-cli.mjs bundle-update <clean clone>`; `bundle-check`
  verifies it and the gate lane runs that check.
- The workflow now states the standards rule the self-check enforces: follow
  the standards; deviate only when the user has granted an exception or coop
  states a concrete reason, and say which in the summary.

### Added

- `sql_targets:` in the project contract (master plan section 8 item 1, row SQ1):
  one entry per environment (`dev`, `test`, `prod`) with a `kind`
  (`fabric_warehouse`, `fabric_lakehouse`, `fabric_sql_database`, `azure_sql`,
  `synapse_serverless`), a `server` + `database` for the kinds coop connects to
  by host, or the Fabric ids for the kinds whose host coop discovers, and a
  `default_environment` that is dev or test, never prod. `lib/sql_targets.py`
  reads and validates it (host pattern per kind, production never default,
  placeholders tolerated, credential keys rejected); `coop doctor` shows one
  Project-contract row per entry; `/setup-project` proposes the dev entry's kind
  from the machine's client platform and writes it; `.coop/project.example.yml`
  carries the shape.

- The guardrails' live-read scope follows `sql_targets:` (master plan section 8
  item 1, row SQ3). With that section in the contract, a `fabric_sql_query` call
  resolves its bounded session scope from the trusted contract snapshot: the ready
  dev or test default entry, the contract's client and the launch identity (its
  tenant must match `fabric.tenant_id` when set). The approval prompt now names
  that entry (`azure_sql/<host>/<database>`, or the Warehouse ids) instead of the
  managed Warehouse; a Warehouse named by ids shares the managed MCP grant. A prod
  default, a placeholder, an invalid entry, a missing client or a tenant mismatch
  resolve no scope, so every such read asks; mid-session contract edits never
  change the scope.

- `sql_impact`, read-only live impact tracing (master plan section 8 item 4, row
  SQ4). For one SQL object on the contract's default dev or test target it runs
  three fixed, parameterized catalog queries (dependents via
  `sys.dm_sql_referencing_entities`, references via `sys.sql_expression_dependencies`
  with a `sys.sql_modules` text check for unresolved ones, columns via
  `INFORMATION_SCHEMA.COLUMNS`) and reports each section as `ok` or `unavailable`
  with a reason, so an empty list never means "could not look". It shares
  `fabric_sql_query`'s connection path (`lib/sql_query.py` `open_connection`), runs
  without a prompt on a resolved dev/test target, asks on production or unresolved
  targets, and rejects any field beyond `object`. The `impact-analysis` prompt and
  the `coop-workflow` skill call it before any live SQL edit, then `data_doc` lineage
  for the same object. The fixed-context budget gate moves from 7000 to 7200
  estimated tokens for the new tool's compact metadata (`scripts/check-context-budget.*`).

- Verify with data (master plan section 8 item 5, row SQ5). The `coop-workflow`
  skill's live-data section and the `/slice-next` prompt now make a SQL slice's
  checks concrete: `sql_impact` for the dependents, a row count and a bounded sample
  through `fabric_sql_query` on the default dev target before the edit, the same
  queries after it, and the difference as the passing check; writes go only to dev,
  test asks first, production is never a verify target.

- Microsoft skill mapping for SQL targets (master plan section 8 item 6, row SQ6).
  `sqldw-cli` (Fabric Warehouse and Lakehouse SQL) and `sqldb-cli` (Fabric SQL
  database) are already in the pinned v0.3.18 baseline; the tool contract and the
  extending guide now say so and state that neither covers Azure SQL Database or
  Synapse serverless, where the resolved SQL standards (in context) and the
  `coop-workflow` guidance are the authority. The
  stale "`sqldw-operations-cli` deferred" wording is gone (that name no longer
  exists upstream; its guidance lives in `sqldw-cli`).

- The SQL executor reads `sql_targets:` (master plan section 8 item 1, row SQ2).
  `lib/fabric_sql_query.py` is now `lib/sql_query.py` (the in-agent tool keeps its
  `fabric_sql_query` name and contract). With a contract `sql_targets:` section it
  connects to the ready default entry: Azure SQL, Fabric SQL database and Synapse
  serverless by the contract's host (Azure SQL with a 60 s connect timeout for
  serverless auto-resume, and `ApplicationIntent=ReadOnly` when the entry sets
  `read_scale_replicas: true`), Fabric Warehouse and Lakehouse by REST discovery
  from the contract's ids. A production entry is never selected; an unconfigured or
  invalid default returns `target_invalid` before any token is minted; results
  carry a `target` summary without the host. Without `sql_targets:` the managed
  Fabric target path is unchanged. On an install with no managed Warehouse MCP
  server the launch token helper mints the SQL audience for the contract's tenant
  when the default entry is a direct kind, so the executor has an identity to pin to.

- Install-time client platform choice (master plan section 8 item 7, row SQ7;
  Aaron, 2026-09-30). `coop install --platform fabric|azure_sql|both` (or the
  first onboarding, which now asks once) saves the answer as `client.platform` in
  `~/.coop/config`; `coop onboard --platform <value>` changes it and
  `coop doctor --fix` asks once on a machine that predates the setting. The value
  is a machine default only: on an `azure_sql` machine onboarding defaults the
  Fabric and Warehouse SQL endpoint MCP servers off, the Fabric skill baseline
  stays off unless a contract sets `fabric_skills: policy: baseline` (a `fabric:`
  section alone no longer implies it there), `coop doctor` reports a missing `fab`
  as optional instead of red, and the launch sign-in check mints the SQL audience
  (`https://database.windows.net/`) instead of the Fabric and Power BI ones.
  `/setup-project` mentions the machine's platform on its Fabric question. The
  project contract still wins per repository; guardrails, approvals and the SQL
  executor never read the install choice.

- Sessions name themselves (master plan N1, row 9b). `@xl0/pi-lovely-rename`
  **0.1.5** joins the pinned extension set: after three user turns an unnamed
  session gets a short name from the session's own model (no extra key), `/rename`
  regenerates it, `/rename settings` changes the trigger, and a manual `/name`
  always wins (the extension never renames a named session). Coop's footer now
  shows the session name next to the branch, and the footer and terminal title
  pick up a rename without a restart. The naming request sends the last 60,000
  characters of the conversation, including tool-call arguments, to the same
  provider the session already uses; the trial on the development VM decides
  whether that scope stays or a coop-owned summary-only namer replaces it.
  Settings live in `~/.coop/agent/xl0-pi-lovely-rename.json`. Verified on the
  development VM: generated names show in `coop -r`'s resume list.
- The isolated extension tree is reproducible (issue #152, master plan U1).
  `config/extensions-lock.json` is npm's lockfile for the release's pinned
  extension set, resolved with pi-ai, pi-tui and the agent peer at the manifest's
  Pi. `coop sync` copies it next to the tree's `package.json` and installs with
  `npm ci`, so two machines on the same release get the same transitive
  dependency versions instead of "latest in range" on the day each one synced,
  and a bad upstream patch release no longer reaches the fleet without a coop
  release. The lock applies only when it can hold (the manifest's Pi is
  installed and the tree declares exactly the manifest's extensions); `--edge`,
  the Pi matrix and a tree carrying a personal extension still resolve live as
  before. Packages that ship their binary and declare `gypfile: false`
  (better-sqlite3 13 under pi-hermes-memory) carry that flag in their lock entry,
  because npm builds the nodes it installs from the lock and would otherwise run
  a bare `node-gyp rebuild` (it failed on the Windows VM, which has no compiler).
  A machine where the lock still fails to install falls back to the live install
  once and remembers that lock, so sync does not retry it until a release ships a
  new one. Maintainers regenerate it with `node lib/extlock.js generate` whenever
  a pin moves; the gate lane fails when the lock and the manifest disagree.

### Fixed

- coop's own footer renders again (issue #203). `pi-better-openai` 0.1.22
  defaults to `footer.mode: "replace"`, which installs its own footer on
  `session_start` and replaces coop-powerline's `⬢ Cooptimize` bar with Pi's
  built-in one. `coop sync` (run by `coop install` and `coop update`) now keeps
  that extension's `footer.mode` at `status` in
  `~/.coop/agent/extensions/pi-better-openai.json`, which is what coop's footer
  already consumes through `footerData.getExtensionStatuses()`; a deliberate
  `off` is left alone and every other key in that file is preserved. Existing
  installs pick it up on their next `coop update` or `coop sync`.

### Changed

- Power BI authoring tools (master plan U1, section 6 rows):
  `@microsoft/powerbi-report-authoring-cli` moves from 0.1.4 to **0.4.0** and
  `@microsoft/powerbi-desktop-bridge-cli` from 0.1.2 to **1.0.0**, together,
  because 0.4.0 depends on the Bridge library at `^1.0.0`. Every CLI verb the
  `power-bi-report-authoring` and `report-themes` skills call keeps its name;
  0.4.0 adds `preview` (Desktop status, reload and screenshot through the Bridge
  library), `pack`/`unpack` for Fabric report definitions, `scaffold`, `measure`,
  `text`, bookmark validation, and `.pbip` / `datasetReference` validation (new
  `PBIR_BOOKMARK_*`, `PBIR_PBIP_*` and `PBIR_DATASET_*` codes, so a report that
  validated clean on 0.1.4 can now report errors that Desktop or Fabric would
  have raised later). Bridge 1.0.0 keeps the same six commands; a reload Desktop
  accepts but does not apply now fails with `RELOAD_REJECTED` instead of printing
  `status: ok`, and `status` reports each instance's `hasUnsavedChanges`.
  `powerbi-desktop reload` still discards unsaved Desktop edits unconditionally,
  so the skills' status-first preflight stays. `coop update` and `coop install`
  install the new pins from the manifest. VM qualification (needs Power BI
  Desktop) pending.

## [0.25.0] — 2026-10-01

### Added

- Guardrails: Fabric and Azure REST writes issued from the shell now ask for
  approval like a mutating MCP call. `az rest` with a non-GET `--method`,
  `fab api -X post|patch|put|delete`, and the Fabric CLI's mutating subcommands
  (`fab deploy`, `mkdir`, `rm`, `cp`, `mv`, `set`, `import`, `assign`,
  `unassign`, `job`, `acl`, `label`, `start`, `stop`, `ln`) confirm before they
  run and fail closed headlessly. The official Microsoft Fabric skills drive item
  create/update/deploy/delete this way, outside the MCP gate. Reads
  (`--method get`, `fab api <path>`, `fab ls`/`get`/`export`) are unchanged.

### Changed

- Standards: a prompt that says PBIX, PBIP or PBIR now reaches the Power BI File
  Types article ("Convert the Sales report PBIX to a PBIP project"), the one
  coop-standards article no realistic prompt reached before. The classifier treats
  those words as "file", the way it already reads "dim" as dimension and "proc" as
  procedure; two golden rows stop being known failures.
- Simple Fabric reads go straight to the contract target. At session start coop
  now hands the agent the Warehouse/Lakehouse ids the nearest `.coop/project.yml`
  pins (`fabric.default_workspace_id`, `fabric.default_sql_endpoint`) in a hidden
  note, and the guardrails prompt plus the `team-knowledge` skill say a one-row
  query, listing, or connection check uses those ids directly — no team-knowledge
  search, memory search, skill load, or Fabric catalog discovery first. Seen on
  0.24.0: a `TOP 1` read ran two knowledge searches, a memory search, and MCP
  discovery before the query although the contract held the ids. The approval
  prompt before Warehouse SQL is unchanged.
- Microsoft skills catalog (master plan U1, the Fabric catalog row):
  `microsoft/skills-for-fabric` moves from v0.3.10 to **v0.3.18**
  (`6c11ad58c25992e5d1435ce7cd80d217d5598a31`) and the baseline now enables the
  **full Fabric skill set** (25 skills) instead of two Warehouse skills.
  Upstream v0.3.12 merged `sqldw-authoring-cli`, `sqldw-consumption-cli` and the
  deferred `sqldw-operations-cli` into one `sqldw-cli`; v0.3.17 merged the four
  Power BI report skills into `powerbi-report-cli`. A contract that allow-lists
  the old names loads nothing for them; use the new names. `microsoft/skills`
  is re-pinned to `3495f50ae0d7b69dcb19c6922db9f80aab6cf79c` (`kql` and
  `microsoft-docs` are byte-identical to the previous pin).
  - The catalog now ships a repository's **shared reference trees** (upstream
    `common/`) beside the skills, at the path their `../../common/...` links
    expect. Before this, every pinned Fabric skill linked shared files that
    the catalog never fetched. Shared trees are pinned by content hash and
    verified like skills; a generation missing one is refused.
  - `python3 lib/microsoft_skills.py check-refs` reports relative links the
    current generation cannot satisfy; `coop sync` stores the same list in
    `fetch-state.json` and `coop doctor` shows the count. Upstream's
    `mcp-setup/` guide is deliberately left out (Coop manages MCP itself).
  - The per-skill size cap rises from 750 KB to 1.5 MB for
    `powerbi-report-cli` (88 Markdown files, ~1.04 MB); the 500 KB per-file cap
    is unchanged.
- `pi-hermes-memory` moves to **0.9.9** (master plan U1, section 6 row). On Windows,
  0.7.17 could not run its own helper process: it launched `pi` through Pi's `exec`,
  which spawns without a shell, and `pi` is only an npm `.cmd`/`.ps1` shim there. So
  memory consolidation, background review, correction save and session flush all
  failed silently with `exited with code 1: unknown error`, and once a memory file
  reached its 5,000-character limit every new save was rejected (seen on Aaron's
  client VM on 2026-09-30, all four stores full). 0.9.9 resolves `pi.cmd` and starts
  `node` with Pi's `cli.js` directly, runs those jobs in-process first, lets
  policy-only saves exceed the Markdown cap instead of failing, raises the
  consolidation timeout to 180 s, warns in the session when an automatic
  consolidation fails, and adds `/memory-pin` for rules the agent must not rewrite.
  Existing memory files are read as before (same storage root under
  `~/.coop/agent`). VM-qualified 2026-10-01.
- `@azure-devops/mcp` moves to **2.10.0** (master plan U1, section 6 row). Read-only
  check of both published packages: the same 37 tool names, the same domains (coop
  still passes `core work work-items search`), and `--authentication azcli`
  unchanged, so the generated `azure-devops` entry is the same apart from the pin.
  2.10.0 updates `@azure/identity` and `@azure/msal-node` and adds
  `@azure/msal-node-extensions` and `open` for its own interactive sign-in, which
  coop does not use. `coop sync` regenerates the entry. VM-qualified 2026-10-01
  (one work-item query through the MCP).
- `mcp-remote` is gone (master plan U1, section 6.2). It only bridged the Microsoft
  Learn MCP, and `learn.microsoft.com/api/mcp` is unauthenticated Streamable HTTP
  that `pi-mcp-adapter` speaks directly. The generated `microsoft-learn` entry is now
  `{"url": "https://learn.microsoft.com/api/mcp", "auth": false, "lifecycle": "lazy",
  "requestTimeoutMs": 60000}`, the same shape as `fabric-sqlendpoint`, and like that
  entry it is replaced wholesale on every `coop sync`, so a coop-managed entry that
  still carries the old `npx mcp-remote` command line migrates on the next sync. The
  package leaves `config/release-manifest.json` and the Microsoft skills manifest's
  dependency list; `coop doctor` and the guardrails already treated the Learn server
  by name, not by package. VM-qualified 2026-10-01 (a live tools-list through the
  adapter).
- Vibes: seven new working lines (four crew lines in `coop-internal`, three
  client-safe classics in `professional`), and a `{user}` placeholder that
  `coop-powerline` fills from the COOP profile name, else the OS login, else `Dave`.
  Tips now cover the commands added since the last pass (`/setup-project`,
  `/standards-status`, `/coop-live-read`, `/coop-approvals`, `/share-learning`,
  `/mcp-adapter`, `/export`, `/resume`, `/session`, and the pi-hermes-memory 0.9.9
  commands `/memory-insights`, `/memory-pin`, `/memory-preview-context`,
  `/memory-consolidate`, `/memory-switch-project`) and per-repo skill enablement
  via `.coop/project.yml`; the vague skill-load-conflicts tip is gone. The vibes
  test now also checks `tips.txt`, the new commands, and keeps `{user}` and
  profanity out of the client-safe tips.
- `@microsoft/fabric-mcp` moves to **1.4.0** (master plan U1, section 6 row). Checked
  offline against both binaries: in coop's `--mode namespace`, 1.4.0 lists no tools
  at all unless each namespace is named, where 1.3.0 listed its four routers by
  default. The generated `fabric` entry now passes `--namespace docs --namespace
  onelake --namespace core --namespace datafactory`, so both versions expose the same
  four routers (`docs`, `onelake`, `core`, `datafactory`) with the same commands.
  1.4.0 spells its commands in kebab-case (`docs_workloads` is now
  `docs_list-item-types`, `docs_workload-api-spec` is `docs_item-api-spec`, and the
  `onelake_*` commands use hyphens); the guardrails already classify both spellings,
  and `onelake_get-principal-access`, a read the lists had missed, now passes
  without a prompt. `coop sync` regenerates the entry. VM-qualified 2026-10-01 (a
  live `docs` and `onelake` router call).
- `@juicesharp/rpiv-ask-user-question` moves to **2.12.0** (master plan U1, section 6
  row). The tool the setup wizards call is still `ask_user_question`, with the same
  parameters and the same answer envelope, and cancelling still returns the single
  "User declined to answer questions" line. Since 1.20.0: every question ends in a
  `Type something.` free-text row (the "Chat about this" row and its `kind: "chat"`
  answer are gone); `n` adds a note to any question, or a global note on the Submit
  tab; `Ctrl+]` collapses the dialog to read the transcript (`collapseKey` in
  `~/.config/rpiv-ask-user-question/config.json`, `"off"` disables it); non-interactive
  runs drop the tool from the model's list instead of failing every call; RPC hosts get
  their native dialogs; and a dialog that fails to load reports
  `session_load_failed` / `stale_module_cache` and asks the model to fall back to chat
  rather than counting as a decline. The plan named 2.11.0; 2.12.0 (published
  2026-09-30) differs only in declaring `typebox` as a peer again, so the extension
  shares Pi's own copy. Peers unchanged, no native code. VM-qualified 2026-10-01
  (`/setup-project` and `/setup-docs` dialogs, `Esc` cancellation).
- The test gate runs unchanged on a developer Mac. Test fixture roots resolve to
  their real path, since macOS keeps the temp dir under the `/var` -> `/private/var`
  symlink that the standards storage-root check rejects, and the standards
  `doctor-lines` / `coop doctor` / Support checks run with a PATH that carries no
  installed `coop-sql-review` / `coop-dax-review`, so a machine with the reviewers
  installed no longer reports `bundled_fallback` where CI expects `unavailable`.
  Tests only; no runtime change.
- Docs: master plan revision 3.7 is a status update only. Row 9 (U1) records
  Pi 0.87.1 + `pi-mcp-adapter` 3.3.0 as done at tag v0.24.0 (VM run passed,
  Warehouse approval prompt verified live) with #175 and #176 in review as
  drafts and #170 held; row 7 records S5 merged (#161). No scope or order change.

### Fixed

- Guardrails: a Fabric or Azure DevOps write called through pi-mcp-adapter's
  **direct tools** now asks for approval like the proxied call. The adapter can
  register every server tool as `<server>_<tool>` (`directTools` on a server
  entry, which its `/mcp-adapter` panel can switch on); such a call carries no
  `{server, tool, args}` envelope, so `fabric_onelake {command:
  onelake_create-directory}` or `azure-devops_wit_work_item_write` reached the
  server with no prompt (found on the VM during the v0.25.0 acceptance run; the
  same shape on 0.24.0). The guardrail now resolves a managed server's direct
  name to its server and remote tool, so Fabric router commands, deletes and
  name-based mutations are classified the same way on both paths, and
  `coop sync` writes `directTools: false` on every managed command server (a
  user-added `true` is switched back off, as `scriptMode` is). Reads are unchanged.
- `coop doctor` no longer reports the cached standards as degraded just because the
  15-minute freshness window expired since the last launch. Doctor never refreshes,
  so on an install last launched hours ago the sync row now reads `stale @ last
  checked N min ago; standards refresh at every coop launch, or now with: coop sync`
  and the domain rows stay green as "last known good @ <revision>". A refresh that
  actually failed reads `failed` with the reason, and every last-known-good row is
  then a warning as before. `/standards-status` JSON gains `last_attempt_ms`,
  `last_attempt_ok` and `detail`.

- Machines whose only Python is 3.14 no longer get a Fabric CLI they cannot fix.
  The Python prerequisite row (install and `coop doctor`) now passes with any pipx
  that can fetch a standalone Python (1.5+, both flag spellings; it accepted only
  the 1.12+ spelling before) and counts a pipx that is installed but not on PATH
  yet, as the pipx row already did. `coop doctor --fix` builds the Fabric CLI with
  the same interpreter plan as install and update — a local Python 3.10–3.13, or
  pipx's standalone 3.12 — instead of a bare `pipx install` that inherited 3.14
  and failed, and it rebuilds an existing Fabric environment that runs 3.14
  (re-injecting `fabric-cicd`). On Windows, when pipx is too old to fetch a
  Python, the row prints the admin-free repair (`python -m pip install --user
  --upgrade pipx`) instead of a winget Python install, and
  `coop install --prereqs auto` runs it. Bash and PowerShell in parity.
- `coop_version_lt` read a two-part version `X.Y` as `X.Y.Y`, so Python 3.14.2
  counted as older than 3.14 and passed the Fabric check it should have failed
  (and 3.10.5 counted as older than 3.10). Missing parts now read as 0.
- `coop install --prereqs auto` ran a two-step fix (`a then b`) as the single
  command `ab`: the newline that split the steps was lost inside a heredoc.
- `coop doctor` no longer reports a pipx environment as "stale/corrupt" when the
  executable it resolved on PATH is not the pipx one. A `pip install` copy, another
  tool manager's shim, or a leftover launcher earlier on PATH (a teammate's
  `coop-data-doc` reported 1.1.1 while the pipx venv held 1.2.0) is now a PATH
  shadow: the row names the resolved path and both versions, and the hint says to
  remove that copy or put pipx's bin dir first on PATH. The old hint,
  `pipx install --force`, rebuilt a venv that was never wrong and could not clear
  the row. When pipx has no copy at all, the row says so and leads with the pinned
  `pipx install`. The "Standalone Coop tools" section no longer gives such a copy a
  green tick. When pipx has the venv but nothing answers on PATH, the row says
  "not on PATH" with an `ensurepath` / `reinstall` hint, and a launcher that runs
  but prints nothing is named with its path, instead of the old catch-all
  "produced no version" with a `--force` hint. Genuine metadata/CLI disagreement
  inside the pipx venv is unchanged.
- A coop installed into a redirected profile (HOME / USERPROFILE / LOCALAPPDATA /
  APPDATA pointed at a sandbox folder, as the acceptance harness and the VM
  runbooks do) no longer spills onto the real account. `coop install` wrote the
  "coop" Desktop and Start Menu shortcuts through the Windows shell folders, so a
  sandbox install rewrote the real shortcuts to point at the sandbox, and it
  appended the sandbox launcher folder to the real user PATH in the registry.
  Shortcuts now land in the redirected profile's own Desktop and Start Menu, the
  persistent user PATH is left alone (the launcher is on PATH for that run only,
  and the install says so), and `coop update` / `coop uninstall` look in the same
  folders. A normal install still uses the shell folders, so a OneDrive-redirected
  Desktop keeps working. Windows only; the bash installer never had the problem.

## [0.24.0] — 2026-09-30

### Changed

- Pi moves to **0.87.1** and `pi-mcp-adapter` to **3.3.0** (master plan U1, the
  first dependency row). They move together because adapter 2.34.0 does not
  accept pi-ai 0.87. Pi 0.99 stays out of reach: adapter 3.3.0, the newest,
  still caps pi-ai at `^0.87`.
  - Adapter 3.0 stopped reading `<agent dir>/mcp.json`, which Pi's own MCP
    support owns from 0.99. Coop now generates `~/.coop/agent/mcp-adapter.json`
    (same format).
  - `coop sync` migrates once: servers, settings and `_coop` ownership carry
    over, and the old coop-owned `mcp.json` is removed. A legacy file coop
    doesn't own is left alone, and an unreadable one never blocks generation.
  - The generated config also sets `settings.allowInstall: false`, so the agent
    can't persist new remote MCP servers.
  - Every consumer follows: `sync`, `onboard`, the launch token helper
    (`bin/coop`, `bin/coop.ps1`), the Warehouse grant resolver in the guardrails,
    `lib/fabric_sql_query.py`, doctor's config discovery, and the Pi matrix.
  - The adapter's `/mcp` command is now `/mcp-adapter`.
  - Coop still launches the adapter with `PI_MCP_CONFIG_MODE=exclusive` (#165);
    in 3.x that reads only `~/.coop/agent/mcp-adapter.json`, so a work repo's
    `.mcp.json` is never read (3.x would otherwise hold it until the project is
    trusted and each server approved).
  - `coop doctor` (both platforms) checks only that file, the one the adapter
    reads. Before, it checked the first MCP file it found, starting with the
    current folder's `.mcp.json`. It now names a work repo's `.mcp.json`,
    `.pi/mcp-adapter.json` or `.pi/mcp.json` as not used.
  - Qualified locally with `scripts/test-pi-matrix.sh 0.87.1` against real npm
    (24 passed, 0 failed; the live model turn needs credentials) and on a
    Windows VM on 2026-09-30 (`test-pi-matrix.ps1`: 20 passed, 0 failed; sync,
    doctor and the `mcp-adapter.json` migration verified; a real session showed
    the system prompt projected once per turn, a single footer working
    indicator, `/mcp-adapter` listing only coop's servers, and a Fabric read
    with no prompt). The approval-gated Warehouse read was not exercised there
    (no SQL endpoint in that sandbox).
- Docs: `docs/install-windows.md` no longer describes the **coop** icon as a chat
  window that can't show the model sign-in, or a separate **coop (terminal)** icon;
  `docs/onboarding.md`'s ground rules say MCP changes ask first instead of "read-only
  by policy" (#160 follow-up).
- The browser chat (`coop web`) is removed (master plan S5; Aaron dropped the web
  on 2026-09-30). The installable desktop app in the plan's last phase replaces it
  and uses the unchanged `coop launch-spec --json`.
  - `coop web` now prints that it was removed and starts coop in the terminal,
    so old habits and shortcuts keep working. On Windows it also restores the
    console window that the old shortcut minimized.
  - The Windows **coop** shortcut opens the terminal agent. `coop update`
    rewrites existing shortcuts and removes the separate **coop (terminal)** one.
  - Removed: `web/`, and the web bridge, protocol, diff-model, stub-pi and web
    launch tests, including the web phases of `tests/fabric-mcp-launch.test.sh`.
    The terminal launch phases are unchanged.
- Approved edits can last for the session (#156). The approval prompt for an MCP
  edit offers **Allow once**, **Allow <server> edits for this session** or
  **Decline**, so a multi-step Fabric, Power BI or Azure DevOps change asks once
  instead of on every call.
  - A session approval covers that server's later create, update, write, upload,
    publish and refresh edits until `/new`, exit, or `/coop-approvals revoke`.
  - Deletes and drops, and anything that names prod or production, still ask every
    time.
  - For the managed Warehouse, a single dev/test `INSERT`, `UPDATE`, `CREATE` or
    `ALTER` can use its session approval. `DELETE`, `DROP`, `TRUNCATE`, `MERGE`,
    `EXEC`, permission changes and batches still ask.
  - Headless runs still fail closed, `mcpScript` stays blocked, and every decision
    is audited. `/coop-approvals status` shows what is approved.
- coop can edit semantic models after approval (#159). The Power BI Modeling MCP
  now starts `--readwrite`, and the guardrail reads each call's
  `request.operation`, because the server names its tools by object
  (`measure_operations`, `table_operations`, …) rather than by verb.
  - Reads run without asking: `Get`, `List`, `ExportTMDL`, connecting, traces, and
    DAX queries (which keep the live-read rules).
  - Edits ask: `Create`, `Update`, `Rename`, `Move`, refreshes, perspective and
    hierarchy changes, `Commit`, and exports to a folder or file. Choosing
    **Allow powerbi-modeling-mcp edits for this session** covers the rest of the
    task (#156).
  - These ask every time, with no session option: every `Delete` operation,
    `ImportFromTmdlFolder` / `ImportFromBimFile` (they replace the model),
    `DeployToFabric`, unknown or missing operations, and anything naming prod or
    production. Edits name only a connection, so once a session connects the
    server to anything naming prod or production, every later model edit in that
    session asks.
  - `coop doctor` reports `started, read-write; coop asks before each edit` and no
    longer warns that a missing `--readonly` is accidental; `--readonly` stays a
    supported stricter choice.
  - Verified against the real 1.0.0 server in read-write mode: it loaded a TMDL
    folder, created and updated a measure through `request.operation`, and
    `ExportToTmdlFolder` wrote it back to the file. Aaron shipped this ahead of
    the Windows VM check (Power BI Desktop and a PBIP, and a declined edit that
    changes nothing), which follows the release.
- Power BI Modeling MCP moves from 0.5.0-beta.12 to **1.0.0** (U1), now named
  the Power BI Authoring MCP by Microsoft.
  - 1.0.0 refuses every tool until its EULA is accepted. Aaron accepted
    Microsoft's EULA for Cooptimize on 2026-09-30, so coop's generated server
    entry adds `--accept-eula`, which applies per process and persists nothing.
  - Checked against the 1.0.0 binary: `--readonly` registers its tools in
    ReadOnly mode, and `--start` alone defaults to ReadWrite. coop now runs it
    `--readwrite` behind the operation-aware guardrail above (#159).
  - Other upstream changes since beta.12:
    - a local application folder renamed with automatic migration (coop does not
      reference it)
    - durable local audit logs under
      `%LOCALAPPDATA%\Microsoft\powerbi-authoring-mcp\Logs`, kept seven days
    - `dax_query_operations` returning up to 1,000 rows by default
  - The Windows VM check follows the release (see #159 above).
- `coop update --check` shows the repository move first (#107): `repo (coop-agent)
  v0.23.5-21-gabc1234  would move to release v0.23.6`, `... no newer release`, or the
  hold, local-commits or missing-origin state with its fix. It uses the same local
  helpers as step 1 and doctor, with no fetch, so `--check` still changes nothing.
- Tests and CI run in two lanes (T1, #96). `bash tests/run.sh` and `tests/run.ps1`
  now run the gate lane by default: deterministic logic tests with no sleep, poll,
  PTY, marker file, hang fixture or network, and no fixture that touches the
  checkout. Both runners give every gate test a temp home (`HOME`, `USERPROFILE`
  and the Coop, Pi and standards locations).
  `COOP_TEST_EXTENDED=1 bash tests/run.sh` adds the extended lane (the timing and
  process fixtures); the two lanes together are the previous full suite, and no
  assertion was removed or loosened. `ci.yml` runs the gate lane on every PR and
  push to `main` (ubuntu, Windows Git Bash, Windows PowerShell 5.1) with a
  read-only token, per-job timeouts, and a newer PR push cancelling the older run,
  and ends in one `gate` job that fails unless every other job succeeded. The new
  `extended.yml` runs the extended lane nightly and on demand (Actions -> extended
  -> Run workflow, any branch). The Pi compatibility matrix moved to
  `pi-matrix.yml` and runs nightly, on demand, and on a PR that touches Pi
  alignment (`scripts/sync.*`, `lib/_extdeps.py`, `config/release-manifest.json`,
  `extensions/**`, `scripts/test-pi-matrix.*`,
  `tests/guardrails-pi-runner.test.mjs`). `coop release` (bash and PowerShell)
  runs both lanes before it tags. Duplicate checks are gone: the focused Windows
  knowledge-search job (that test runs in the Windows Git Bash gate),
  `tests/bom.test.sh`, and the BOM section of `tests/run.ps1`;
  `scripts/check-parity.sh` is the one BOM check and now also checks that
  `bin/coop.ps1` and `scripts/sync-knowledge.ps1` start with a comment line after
  the BOM. Eight test files that nothing ran are wired into the gate lane:
  `fleet-digest`, `install-pipx-path`, `missing-common-guard`, `knowledge-read`,
  `knowledge-retrieve`, `knowledge-sources`, `support-center` and `tool-result`.
  The Windows terminal-workstation acceptance run still runs `tests/run.ps1` in
  both lanes, and `tests/run.ps1` now fails instead of reporting a pass when an
  error stops it before its last section. Lanes, fixture rules and the CI
  workflows are documented in `docs/ci.md`.
- The extended lane runs every terminal-workstation acceptance test (#133). It
  used to select 8 of the file's 39 tests by name, and no lane or workflow ran
  the other 27. `tests/run.sh` now runs the whole file. Tests that need pwsh
  skip themselves without it, and the native Windows lifecycle test runs only on
  Windows. `tests/run.ps1` keeps its subset so Windows doesn't run the file twice.
  The ubuntu extended job installs `jsonschema` 4.25.1, as the Windows jobs do,
  because the file treats the receipt schema validator as mandatory.
  Running it on Windows exposed a hang: the certification Python resolver
  executed whatever file `CERT_PYTHON` named, so a document such as `README.md`
  opened with its associated app and never returned. On Windows the resolver now
  refuses anything but an `.exe` before running it, and each resolver probe in
  the test is bounded to 2 minutes and names its `CERT_PYTHON` when it overruns.
  Like its neighbours, that test now skips itself where pwsh is not installed,
  so `COOP_TEST_EXTENDED=1 bash tests/run.sh` (and `coop release`) passes on a
  maintainer machine without PowerShell 7.
- The extended test lane no longer touches your real home or this checkout (#135).
  `tests/run.sh` keeps the gate lane's temp home for the extended block, except
  `home-guard`, which checks the real home on purpose. The fixtures that run
  doctor, update or a launch (`doctor`, `inventory`, `first-run`) work on a copy
  of the tree without `.git`, so doctor's daily fetch can't reach this checkout.
  `fabric-mcp-launch` pre-writes a fresh fetch stamp, and `update-guard` and
  `review` sandbox their own home. `review` used to write the real
  `~/.coop/standards`. The runner now fails if a test changed the caller's
  `~/.coop`, `~/.azure`, or this checkout's `HEAD`, refs or `FETCH_HEAD`.

- MCP: `powerbi-mcp-server` is retired (#93). It silently ignores `--readonly` and
  exposes `refresh_dataset` (a write that triggers a dataset refresh on the client
  tenant), which coop's guardrails do not classify as a mutation, while coop
  documented it as read-only. Coop no longer generates the `powerbi` MCP entry, and the
  `powerbi-mcp-server` pin is gone from the release manifest. `@microsoft/powerbi-modeling-mcp`
  (`--start --readonly`) is the only Power BI MCP. `coop sync` removes the `powerbi`
  entry coop generated (or its old `TODO-`/`@latest` placeholder); a `powerbi` entry
  you added yourself is left in place, and `coop doctor` (both platforms) warns about
  any `powerbi-mcp-server` entry and names the reason. The bundled contracts and both
  project wizards no longer write the `mcp.powerbi` block (`readonly_flag: true`); an
  existing contract keeps it untouched. `coop onboard` no longer asks "Enable Power BI
  MCP?", no longer lists it as enabled or omitted in the review summary, and no longer
  tells you to set a tenant for it; a saved `integrations.power_bi` value is dropped
  the next time onboarding saves the config.

- `coop update` follows release tags instead of the head of `main` (H5, #78). Step 1
  fast-forwards the coop-agent checkout to the newest `vX.Y.Z` tag on `main` that is
  ahead of it and never moves a checkout backwards, so merges to `main` reach teammates
  only through a tagged release, and the tools pin to that release's manifest. rc tags
  and tags off `main` are ignored. A branch that does not track `origin/main` is a hold
  that default update leaves alone (a per-machine pin); a renamed branch that tracks
  `origin/main` still follows releases. `--edge` is unchanged as the maintainer channel
  (head of `main` plus latest upstream) and now re-attaches a detached checkout to
  `main` when that loses nothing; `coop install --edge` stays tools-only. The doctor
  repo row and the daily launch notice count against the release the update would move
  to ("N commit(s) behind release vX.Y.Z"), so a checkout ahead of the newest release
  is no longer nudged. The doctor row shows `git describe`, and step 1 and doctor name
  the states the update cannot move (hold, local commits, no `origin/main`, no `origin`
  remote) with the command that fixes each. Doctor's newer-than-manifest hints now say to pin back with
  `coop update` (maintainers: `coop update --edge`). The update that installs this
  release still runs the old updater and pulls the head of `main` once; later updates
  follow tags.

- `coop version` and `coop doctor --publish` name the commit a machine runs (#108).
  `VERSION` reads the same at a release tag and at every commit past it, so machines on
  different commits past `v0.23.5` looked identical. In a git checkout, `coop version`
  (both launchers) now prints the same `git describe` as the doctor repo row, for example
  `coop 0.23.5 (v0.23.5-21-gdf91630)`; a copy that is not a git checkout still prints
  `VERSION` alone, with no error. The `doctor --publish` snapshot adds `coop_describe`
  next to `coop_version` (empty for a non-git copy), and the fleet digest shows it in the
  Versions column (Markdown and HTML); snapshots published by older versions render as
  before. This corrects the master plan's H5 note that the version report already
  carried the SHA.

- Docs: new one-page [Install coop on Windows](docs/install-windows.md) for teammates
  (master plan H6, #79). Its steps are the installer's prerequisite checklist in the
  order and wording the installer prints, then a full clone moved to the newest
  release (v0.23.6 or later; before that tag it stays on `main`), `Install coop.cmd`,
  a new terminal and `coop`, and what the Azure and model sign-ins look like. The
  README's Windows section is now that link plus the execution-policy and new-terminal
  notes; its launcher, project-setup and zip-copy notes moved to the install table,
  Commands and Updating sections.

- Standards: the wiki's own front matter now widens the prompt classifier (#88). A
  task that names a layer the domain's articles carry (silver, gold, report) or every
  word of an article's technology (fabric warehouse) selects that domain too, so
  "fix the silver indexing on the fabric warehouse table" reaches Silver Indexing and
  Fabric Warehouse Target instead of only the empty `fabric` domain. Decided by the
  cached wiki metadata; no new regex vocabulary. Model, lakehouse-only, and non-task
  prompts classify as before.
- Standards: the legacy self-authored `manifest.json` fixture seam is gone (#83).
  `lib/standards.mjs` no longer carries the `manifest.json` branch, `validateManifest`,
  `syncCanonicalLocal`, or the `fixtureRoot`/`staleRoot` test-only options, and
  `config/standards-registry.schema.json` (which validated that fixture, not the
  registry) is deleted. The Revision 9 suite now runs against a git-backed wiki
  fixture shaped like the real `cooptimize/coop-standards` repository, refreshed into
  the generation cache the way `coop sync` does. Every boundary assertion is kept
  (hash mismatch, path escape, symlink, dirty checkout, stale/bundled/unavailable/auth
  states, immutable snapshots); the assertions that only exercised the legacy shape
  (schema validation, local-sync bad hash) are covered by the live-sync suite's fault
  and corruption cases. No runtime behavior change for the wiki reader.
- Docs: master plan revision 3.4 sharpens Phase 5 (Azure SQL breadth): the four
  non-Fabric-warehouse target kinds and their host patterns, Azure SQL serverless
  compute tier versus Synapse serverless SQL pool, the connect-timeout and
  `ApplicationIntent` rules, and the three fixed parameterized catalog queries the
  live impact tracing uses.
- Docs: master plan revision 3.3 adds the Phase 3 pre-qualification (sections 6.1
  and 6.2): Pi 0.87.1 needs no extension source change and lists the exact pin and
  fixture edits; `pi-mcp-adapter` 3.x stops reading `mcp.json`, so coop's generated
  file becomes `mcp-adapter.json`; the exact `mcp-remote` replacement entry and its
  offline proof test; `powerbi-mcp-server` is dropped now (#93).
- Docs: master plan revision 3.2. H3 rewritten to what PR #85 shipped (coop reads
  the coop-standards Obsidian wiki directly); register rows moved to `merged`/`in
  review`/`in progress`; new H2b row (#91) for tenant-pinned token minting; rules
  added against improving retired surfaces and against timing fixtures in the PR
  gate; who moves register rows after a merge.

- Standards (H3): Coop reads the `cooptimize/coop-standards` Obsidian wiki directly.
  Every Markdown article with front matter and `status: active` is a standard. Articles
  map to Coop's SQL, DAX, and semantic-model domains by their `domain`/`artifact` front
  matter, and a new wiki domain resolves without a Coop release. Tasks receive whole
  articles, chosen by layer, artifact, technology, and title against the prompt, each
  with path, SHA-256, and repo revision. A task no article matches gets the domain's
  core-layer articles (for example `layer: semantic_model`), or a list of the domain's
  articles when it has none, never whichever files sort first. A byte-order mark before
  the front matter no longer hides an article. Two articles with the same `id` (an
  Obsidian "Make a copy") are both kept and reported by `coop doctor`, `coop sync`, and
  `/standards-status` with both paths. Coop no longer reads `standards.yml`,
  `standards/*.md`, or `scripts/assemble.py` (they stay in that repo for older clients),
  so the Silver Indexing, Schema Derivation, and Schema Manager articles, which the
  assembly skipped, now reach Coop. The SQL/DAX reviewers get a reviewer-input copy of
  the domain's articles built in Coop's own storage. Cached standards from earlier
  versions are re-fetched on the next sync. `config/standards-registry.json` is the only
  copy of the registry (the duplicate in `lib/standards.mjs`, the frozen domain list, and
  the anchor-commit/archive-hash pins are gone). Project overrides accept the nested
  `standards.<domain>.path` shape alongside the scalar one, at any consistent indent,
  and `coop init`, `/setup-project`, and the bundled contracts document it in a comment
  (no active override by default). Upgrade note: a review run accepted against the
  canonical standards before this update is bound to the `standards.yml`-era cache
  (schema-1 index), which no longer verifies, so the first `coop review --compare`
  afterwards reports no previous review and becomes the new baseline. This is not
  fixed in code because the SQL/DAX reviewers are being retired from Coop (master plan
  section 7, ST1).

- Docs: adopted the ordered [Coop master plan, revision 3.0](docs/COOP_MASTER_PLAN.md).
  It keeps the Windows-terminal plan's intention and reorders execution: rollout
  hotfixes first (installer prerequisite gate, automatic Azure sign-in, project
  contract aligned with the Cooptimize standards repos), then test right-sizing,
  Windows-first simplification, dependency reconciliation, standards alignment,
  Azure SQL breadth, common-workflows first run, the minimal beta channel, and last
  an installable Electron desktop. Revision 3.1 adds release-tag updates for
  `coop update`, a one-page Windows install doc, the fresh development VM as the
  qualification machine (the beta channel becomes conditional for a seven-person
  team), `pi-lovely-codex` evaluated whole against `pi-better-openai`, and the
  agent working model. Revision 2.0 stays as the per-package reference.
  Documentation only; no runtime change.

### Fixed

- Fabric MCP creates, uploads, pipeline runs and deletes ask again (#171). coop
  runs `@microsoft/fabric-mcp` in namespace mode, where four router tools
  (`onelake`, `core`, `datafactory`, `docs`) carry the operation in a `command`
  argument. The guardrails checked only the router's name, so a call such as
  `onelake` with `command: "onelake_delete_file"` ran with no prompt (v0.23.5 too).
  - The guardrails now read `command` and check it against the pinned server's
    own command list.
  - A known write is an edit that the per-server session approval can cover.
    Deletes always ask, and so does any command coop doesn't know.
  - Reads, `learn: true` and calls without a command pass; the server only lists
    its commands for those.
  - Row reads (`datafactory_execute-query`) and downloads still ask under the
    live-read rules.
- A work repo can no longer add or redefine coop's MCP servers (#165). Without
  `PI_MCP_CONFIG_MODE=exclusive`, pi-mcp-adapter 2.34.0 also merged the current
  repo's `.mcp.json` and `.pi/mcp.json`, ancestor configs and other tools'
  imported configs, so a project entry could add a server or replace a managed
  one such as `fabric`, and its command ran the first time the model used it.
  Both launchers now set `PI_MCP_CONFIG_MODE=exclusive`, so MCP servers come only
  from `~/.coop/agent/mcp.json`, which keeps the servers you added yourself. The
  `coop launch-spec --json` env carries it too.
- Pi's optional `powershell` tool asks before every command (#166). It is off by
  default, but user or trusted-project settings or `--tools` can turn it on, and
  the guardrails' shell checks (secret files, source commits, destructive
  commands) parse bash only, so a PowerShell command ran with none of them. Each
  one now shows the command and asks, with no session approval; headless runs
  are blocked; the audit records a fixed label, never the command.
- A fresh install no longer counts Pi's empty `{}` auth.json as a model login
  (#167). Pi writes `{}` on startup, and coop treated any non-empty auth.json as
  signed in, so the installer's sign-in step could close within seconds before
  the user signed in, and `coop doctor` and the launch login handoff believed a
  login existed. Now only a stored provider credential counts, in bash (with or
  without Python), PowerShell, the sign-in watcher and `coop doctor`, which
  checks both coop's and the shared `~/.pi/agent` auth.json.
- Guardrails ask before more Fabric MCP mutations (#154). The mutation check
  matched no verb in `onelake_upload_file`, `onelake_modify_diagnostics`,
  `onelake_modify_immutability_policy` or `onelake_reset_shortcut_cache`, or in
  Fabric MCP 1.4.0's `datafactory_run-pipeline`, so those ran without approval.
  The verb list adds `upload`, `modify`, `reset`, `upsert`, `insert`, `merge`,
  `move`, `import`, `restore`, `cancel` and `assign`. Running, triggering or
  starting a pipeline, job, notebook, dataflow or Spark job also asks first. A
  plain `run`/`execute` stays out, so SQL reads keep their live-read rules and
  don't get a second prompt. `tests/guardrails.test.mjs` now pins the Fabric MCP
  1.3.0 and 1.4.0 tool inventory as must-ask and must-not-ask.
- Users only get the release's tested versions (#151):
  - `coop doctor --fix` installs `coop-data-doc`, `coop-sql-review` and
    `coop-dax-review` at their manifest pins; it used to install PyPI's latest.
    The Fabric CLI repair no longer falls back to an unpinned `ms-fabric-cli`. A
    tool with no pin fails with "run: coop update".
  - The Power BI/Fabric authoring tools install drops its `npm update -g`
    fallback, which ignored the version and moved the tool to latest. A tool with
    no manifest pin fails instead of installing unpinned.
  - Hints no longer recommend `pi-coding-agent@latest`, an unversioned
    `npm install -g @earendil-works/pi-coding-agent`, `pipx install
    ms-fabric-cli`, or `uv tool install`. They say `coop install` / `coop update`,
    or print the pinned version.
  - A new gate test keeps `@latest` and `npm update -g` out of product code, and
    checks that the manifest holds only exact versions.
- `coop sync` no longer lets npm install the newest Pi into coop's extension tree
  (#122). Several extensions declare `@earendil-works/pi-coding-agent` as a peer,
  and coop's own convergence and realignment installs let npm auto-install peers,
  so the tree got whatever npm's `latest` said. On 2026-09-29 that was 0.99.1,
  fetched 16 seconds after it was published, which failed CI with E404, far
  past the tested pin. `lib/_extdeps.py` now pins the agent peer to the running Pi's
  version in the same npm `overrides` block as pi-ai and pi-tui. It treats any
  other agent version in the tree as skew, so sync's realignment replaces it. The
  convergence helpers in both twins write that pin before their own npm install.
  `pi install` was never affected: Pi passes `--legacy-peer-deps` for its managed
  installs. The Pi matrix now fails if the tree holds an agent other than the
  runtime's version, and a new gate test covers the pin.
- bash and PowerShell agree that a git worktree is a checkout (#106). bash tested for a
  `.git` directory and PowerShell for any `.git`, so in a linked worktree (where `.git`
  is a file) bash skipped the repo update step, doctor warned that skills would never
  update, and `coop version` showed no git describe, while PowerShell moved the
  checkout. Both twins now use one rule, a `.git` directory or a `.git` file naming
  its `gitdir:`, for the repo helpers, `coop update`, doctor and the knowledge sync.
- MCP: the adapter's `mcpScript` tool can no longer bypass the guardrails. It
  runs JavaScript that calls MCP tools inside `pi-mcp-adapter`, and those calls
  never reach Pi's `tool_call` hook. So a script could run a mutating Fabric,
  Power BI or Azure DevOps action, or Warehouse DDL/DML, with no approval prompt.
  Coop's generated MCP config now sets `settings.scriptMode: false`, which keeps
  any other adapter settings a user added. The guardrail blocks `mcpScript` in
  case a project or user config turns it back on. Single MCP calls through `mcp`
  are gated as before.
- `coop doctor --json` on Windows prints one JSON document again (#90). Three hints in
  the pipx tool check (stale environment, an executable that is not the pinned one,
  a Requires-Python violation) used bash's trailing-backslash line continuation,
  which PowerShell does not have: the warning recorded `\` as its hint and the real
  hint printed to stdout on its own, before the JSON that `coop doctor --publish`
  and the fleet digest parse. `scripts/check-parity.sh` now rejects a `.ps1` line
  that ends in a backslash continuation.
- `coop doctor` on Windows PowerShell 5.1 checks each tool's Requires-Python again
  (#140). The probe passed a program containing double quotes with `-c`, which 5.1
  mangles (the #81 bug class), so doctor always reported "no Requires-Python metadata
  found" and never warned about a tool environment on a Python it does not support.
  The program now goes to Python on stdin.
- Standards lookups no longer spawn git on every prompt (#138). Each prompt verified the
  standards checkout two or three times, at five git processes each, and asked git for
  the revision about eight more times: 28 git processes per prompt in the fixture,
  roughly a second on Windows. `git rev-parse HEAD` is now remembered for as long as
  `.git/HEAD` and its ref file are byte-identical, and a successful checkout
  verification is reused while a content fingerprint of the checkout (git metadata,
  refs, index, and every file's path, mode and bytes) is unchanged. Any edit, branch
  switch, ref move or mode change verifies again from scratch. A warm prompt now
  spawns no git process, and the golden standards test dropped from 4,396 git
  processes to 16.
- `release.yml` refuses a tag that is not `v` + `VERSION` or not on `origin/main`
  (#121), before it publishes anything. `coop release` already tags only from an
  up-to-date `main` (#105); this catches a tag pushed by hand, which teammates
  would otherwise receive through `coop update` (H5).
- Guardrails ask before an MCP refresh (#119). A tool call such as `refresh_dataset`
  (still exposed by a user-owned `powerbi-mcp-server` entry) triggers a refresh on the
  client tenant, but the MCP mutation check had no refresh verb, so it ran as a read.
  `refresh`, `refresh_*` and `*_refresh` tool names now ask first like other writes.
  A read that names a refresh, such as `get_refresh_history`, also asks: the check is
  name-based and errs toward asking.
- Windows PowerShell 5.1 finds a Fabric-compatible Python without the `py` launcher
  (#81). The version probe passed `print("%d.%d" % ...)` on the command line, and
  5.1 does not escape embedded double quotes for native programs, so Python got a
  SyntaxError and every candidate except the `py` launcher was skipped. Since H1
  that failed the install prerequisite gate on such a machine. The probe now
  carries no quotes, and the resolver fixture checks it against a real interpreter
  with 5.1-style argument passing.
- `coop init --migrate-legacy` runs on stock macOS bash 3.2 (#84). Without `--apply`,
  `--yes` or `--archive` (the default dry run) it failed with `migrate_args[@]: unbound
  variable`, because bash 3.2 treats an empty array as unset under `set -u`. The
  arguments now use the same guarded expansion as the Pi launch arguments.
- `scripts/ado-onboard.py` starts without PyYAML (#120). It imported `_yaml` before
  `lib/` was on the path, so on a fresh machine (no PyYAML) it failed at startup, and
  with PyYAML it loaded PyYAML's own `_yaml` module and fell back to a regex read of
  `clients.yml`. It now loads coop's dependency-free `lib/_yaml.py` through
  `ado_lib`, like `ado-digest.py`. `tests/ado.test.sh` now runs in `tests/run.sh`
  (it ran nowhere before) and passes native paths to Windows Python.
- Standards (#88): more prompts reach the wiki articles they need. "fix the silver
  indexing on the fabric warehouse table" now gets Silver Indexing and Fabric Warehouse
  Target instead of nothing. A Fabric warehouse, Schema Manager, `dim.`/`fact.` names,
  silver and gold tables or loads, and `SELECT *` count as SQL work, and SQL context wins
  over "fact table" or "dimension table", so gold SQL work no longer pulls in the Power
  BI table articles. A prompt that also names Power BI, DAX, a semantic or tabular model,
  a dataset, a visual or a sort by keeps them. Report pages, a theme for a report ("a
  theme file for the AP aging report"), drill-through and Power BI apps get the report
  articles without DAX;
  PBIX/PBIP/PBIR prompts now reach the Power BI (semantic model) standards. "A/the ...
  measure(s)" counts as DAX only next to a Power BI word, so "preventive measures" and "a
  test that measures latency" get no DAX standards, and key names near "relationship"
  must look like the wiki's FKDueDate or PKCustomer (not pkg or PKCE). A "reporting
  model" is not the report layer. Rewrite, convert, (re)format, replace, rename, set up,
  turn on/off and fails/failed/failing now count as requests.
- Standards (#101): the wiki-layer widening from #88 stays, as a recall floor under a
  sharper classifier, and a golden set holds both to account. The floor: a request that
  names a layer the wiki's articles carry (silver, gold, report) or both words of a
  multi-word technology (fabric warehouse) gets that domain even when the classifier
  misses it, so "Review this SP for gold - it's using a cursor", "Write the bronze ->
  silver dedupe for the custtable extract", "lakehouse to warehouse: build the load for the
  customer dimension in Fabric", "Update the report theme with the client's brand colors"
  and "Add a new page to the Inventory report with a card for on-hand qty" get their SQL or
  report articles. A missed standard on real coding work costs more than extra context on
  chatter, so the floor gives way only in an explicit list of known non-coding contexts,
  and only when the prompt has no SQL, DAX, Power BI or Fabric signal (a classified domain,
  or a word such as table, view, load, dedupe, dim, measure, Power BI or Fabric): a status,
  progress, incident, expense or annual report; a report generator, button, viewer, form or
  other app-code widget; gold or silver badges, medals, sponsors, tiers or colors; README,
  website, newsletter and marketing-site wording. "Write a status report for the client",
  "Fix the bug in the report generator script", "Add a silver badge to the website header"
  and "Change the button color from silver to gold" get nothing, while "Update the status
  report in Power BI" and "Update the README with the silver dedupe steps" keep the floor.
  So do subtotals, a page added to a Power BI report and naming conventions or standards
  ("Fix the matrix subtotals on the project status report", "Add a Marketing page to the
  Sales report", "Update the README with the silver and gold naming conventions"), and a
  title-case name before "Status report" is a report, not a status document ("Add a Risks
  page to the Project Status report"; "the Weekly Status Report" is still a document).
  Everyday prompts outside that list get what the floor gave them before: "Review the
  quarterly report with the client", "Fix the Visual Studio build and report the failing
  tests", "Add the weekly report to my browser bookmarks", "Update the warehouse stock
  levels for the fabric samples" and "Fix the silver merge conflict in the gold branch"
  still get the report or SQL articles. The classifier: a Power BI report, a visual, card,
  slicer, bookmark or tooltip near "report", a report theme, a gold or silver proc, sproc,
  merge or upsert, a D365 table name after the layer word ("Fix the duplicate rows in
  silver custtable"), "Add inventdim and inventlocation to silver", a sproc or stored proc
  anywhere, and the warehouse in a Fabric workspace are recognized directly; a report card,
  Visual Studio, a merge conflict and a file name before "view" ("accounts.py views") are
  not. A bare "model" no longer counts as Power BI context, so "how the churn model did
  against the success measures" and "the business model canvas with the key measures" get
  no DAX; Power BI, DAX, PBIX/PBIP/PBIR, a semantic or tabular model, or a dataset still
  do. A fact, dimension or date table next to a model or a measure keeps the Power BI model
  and DAX even with SQL words ("Create the gold fact table for budgets and add a Budget
  Amount measure", "relate it to the GL fact in the model"); only SQL-only table work drops
  them. Neither a template placeholder ("a project charter for [Project Name] with the
  success measures"), a visual for slides or a visual merchandising role, a measure table
  with no model or other measures ("a measure table for converting recipes"), nor a web
  domain before "views" ("example.com views") reads as DAX, model or SQL work.
  Debug, tune, troubleshoot, speed up and dedupe count as requests. Three more wiki
  rules now arrive: "fix the format strings on the currency measures" gets the DAX articles
  (Power BI Measures holds the format-string rules); "relate it to the Budget Version
  dimension" gets Power BI Relationships; and "change silver.custtable.creditmax ... to
  match the gold customer dimension" gets Silver Layer (do not change a Silver type for
  downstream convenience), because an object in a layer's schema ranks that layer's
  overview articles first. "proc" and "sproc" rank Gold Stored Procedures first. The golden
  set (`tests/fixtures/standards-golden-corpus.json`, scored through
  `buildStandardsContext` against the front matter of every active wiki article at
  a00c8cc) is a regression test: 48 of 52 prompts pass (main scored 23), and the 4 known
  failures are listed with how they fail, so a fix or a regression both fail the suite
  until the list is updated. 34 holdout rows (report, gold/silver and Fabric warehouse
  wording, the fresh prompts above, and two "model ... measures" prompts that must get
  nothing) all pass; 26 negatives get no standards (main leaked 13 of them); 6 floor-chatter
  rows get exactly main's domains. A title-case report name costs some chatter: "Write the
  Project Status Report for the steering committee" gets the report articles, as on main.
  Every prompt and holdout row records the domains `main`
  selected before #101 and fails if it loses one, except golden prompts 2-4, SQL fact and
  dimension table work that deliberately drops the Power BI model main's bare "fact table"
  and "dimension table" rule added. Still missed: PBIX/PBIP and `.gitignore` prompts never
  reach Power BI File Types, "chart" does not reach Power BI Report Visuals, a gold `dim.`
  index task also gets Silver Indexing, a named model with no Power BI word ("Add a YTD
  measure to the Finance model") gets no DAX articles (as on main), and a bare "proc" with
  no layer word ("Fix the proc that loads customers") gets nothing (as on main).
- `/setup-docs` no longer saves coop-data-doc's placeholder repo paths and then fails
  the build (#102). A teammate who pressed Enter through setup in a session started
  from the desktop shortcut (which opens coop in the home folder) saved `../pbi-repo`
  into `C:\Users\<user>\coop-data-doc.yml`, which resolves to `C:\Users\pbi-repo`, and
  every later build failed. Now:
  - `/setup-docs` and `/start` > *Document the data sources I have* stop in the home
    folder without writing anything, and explain how to open coop in the project
    folder (terminal: `cd` into it, then `coop`; chat window: change the chat's
    folder).
  - At a repo-path prompt whose suggested folder doesn't exist, Enter opens *Type or
    paste the folder path*; no folder is preselected and the placeholder is no longer
    offered. Browsing starts beside the suggestion only when a real repo is there,
    otherwise in the session folder. An existing suggestion stays the Enter choice.
  - "Use it anyway?" defaults to No, in the terminal and in the chat window: the
    wizard's yes/no default is shown first (Pi's own confirm always put Yes first).
  - A setup that saves a config that can't build yet ("Saved, but not runnable yet")
    is shown as a warning naming the repo path, and coop no longer asks "Build now?".
  - A build that fails because a repo path doesn't exist offers to re-run setup or to
    open `coop-data-doc.yml` in the editor and save the fix.
  - `coop init --seed-docs` shows `coop-data-doc config-set`'s status on both
    platforms instead of discarding it, as a warning when the config is saved but not
    runnable yet.
- `coop release` can no longer push a tag that is not on `main` (#105). It fetches
  `origin` and refuses, before changing anything, unless `HEAD` is the branch `main`
  at exactly `origin/main`; a detached HEAD, another branch, or unpushed or missing
  commits each stop it with the fix. It then pushes `main` and the tag in one atomic
  push (`git push --atomic origin main vX.Y.Z`), so when origin rejects the branch (for
  example, someone merged during the gate) the tag does not land either, and the
  release exits non-zero with the retry command. Before, a failed branch push still
  pushed the tag, and `coop update`, which follows only tags on `main` since H5,
  ignored it without a warning. `--no-push` now prints the same atomic push command.
- Incremental BI patterns are chosen by the repository's `layer:` front matter (the same
  front-matter reader as the standards wiki). The old
  path keyword filter matched the clone's own folder name (`incremental-bi`), so every
  file qualified and a semantic-model task received the wiki's editing guide and Bronze
  articles instead of the Power BI refresh article.
- `coop install` checks every prerequisite before installing anything (master plan
  H1, #76). It prints one ordered table (Git, Node.js, Python 3.10–3.13, pipx,
  Azure CLI, ODBC Driver 18, Tabular Editor CLI) with ✓/✗ and the exact install
  command for each missing row, then stops and asks for a new terminal instead of
  failing several steps later. It no longer runs silent `winget`/`brew`/`apt`
  installs whose output and exit code were discarded. `--prereqs auto` runs the
  printed commands visibly, re-checks, and still asks for a new terminal;
  `--no-prereqs` reports the table and continues. `coop doctor` shows the same rows
  with the same text, so Node.js and Azure CLI are now required there too.
- Windows: `Coop-Warn` prints its "how to fix" hint (the Node and ODBC hints were
  silently dropped). The Node minimum comes from `config/release-manifest.json`
  instead of a constant in both installers. A Python found off `PATH` (Python
  install manager, winget user scope) is added to `PATH` for the rest of the
  install, so pipx no longer reports "python missing" in the same window.
- On a first install, the prerequisite stop no longer says `run: coop install` before
  the `coop` launcher exists (#112). While `coop` is not on `PATH`, the stop line, its
  `--prereqs auto` hint, and the `--prereqs auto` re-check stop name a command that
  works from the clone, with the clone's absolute path: on Windows, double-click
  `Install coop.cmd` again (or run `& "<clone>\bin\coop.cmd" install`); in bash,
  `<clone>/bin/coop install`. Once `coop` is on `PATH` the wording is unchanged.
  README, `docs/onboarding.md`, and `docs/install-windows.md` now describe the same
  stop instead of telling first-time users to run `coop install`.
- README no longer says Azure CLI is both auto-installed and not auto-installed.
- Azure sign-in happens automatically (master plan H2, #77). The launch preflight
  (`coop`, `coop web`) takes the client tenant from one chain: the project's
  `fabric.tenant_id`, else `~/.coop/config` `azure.tenant_id` saved by onboarding,
  else nothing, in which case the launch stays silent. No default tenant ships. A
  tenant must be a GUID or a domain name; `TODO` counts as unset, and any other
  placeholder (such as `TBD`) is rejected with one line. The preflight checks the
  Fabric token and then the Power BI token. When az reports that the user is not
  signed in and the launch runs in an interactive console, coop runs
  `az login --tenant <id> --allow-no-subscriptions` itself, with no question and a
  5-minute limit; Ctrl-C cancels it. A token check that times out or fails with a
  non-authentication error never opens a sign-in, and piped or scheduled launches
  never open a browser. Any failure, including a cancelled or timed-out sign-in,
  prints one line with the exact command and the launch continues. On Windows,
  `coop web` (the minimized `coop` shortcut) opens the sign-in in its own window;
  if that sign-in fails, is cancelled or times out, a small window shows the same
  line until Enter. The project contract is found the way `coop doctor` finds it,
  so both always name the same tenant. The `.az-ok` cache is unchanged (30
  minutes, tenant-stamped) but now covers both tokens, and a launch whose Fabric
  token reports `auth_required` drops it.
- `coop doctor` has an **Azure sign-in** row: signed in to tenant X, not signed in
  (with the command), check timed out or failed, or no client tenant configured
  (run `coop onboard --config-only`). It only probes: it never signs in and never
  touches `.az-ok`. `COOP_SKIP_AZ=1` skips the row and the launch sign-in.
- Windows: onboarding and `coop init` now find and run `az.cmd`, including under
  `C:\Program Files (x86)`. The Python helpers looked for a bare `az` and split
  "(x86)" paths, so tenant discovery failed and users saw "Azure sign-in did not
  complete" before a browser opened. Their sign-in also turns off Azure CLI's
  subscription picker, which waited invisibly on captured output.
- Release note: Windows users who onboarded before this fix have no saved tenant
  and should run `coop onboard --config-only` once. H2 and its follow-up H2b
  (coop's own Fabric and SQL token minting pinned to the same tenant) must ship in
  the same tagged patch release.
- Coop's own Fabric and SQL tokens are minted for the client tenant (master plan
  H2b, #91; ships in the same tag as H2). A consultant who is a guest in the client
  tenant, with their home tenant as az's default account, passed the launch sign-in
  but got `auth_required` or `identity_mismatch` from every Fabric call, because the
  mints asked az for the default account's tenant. The launch token and the doctor
  Warehouse probe now pass `--tenant <id>` from the H2 tenant chain (the project's
  `fabric.tenant_id`, else `~/.coop/config` `azure.tenant_id`; the launch token uses
  the same contract as the launch sign-in). Each Warehouse MCP request and both
  `fabric_sql_query` tokens are pinned to the launch token's tenant; a token for a
  different principal or tenant still fails closed. With no tenant configured the
  launch and doctor mints run exactly the az command they ran before. `coop doctor`
  names the tenant its Warehouse probe minted for, and the `fabric` row says that
  `@microsoft/fabric-mcp` uses az's default account because coop cannot give it a
  tenant.
- Windows: the Azure DevOps digest and ADO onboarding (`scripts/ado_lib.py`) mint
  their token through the Azure CLI resolver that `coop onboard` uses
  (`lib/azure_auth.py`), so `az.cmd` starts, including under
  `C:\Program Files (x86)`. They ran a bare `az`, which Windows cannot start. A
  client `tenant_id` that is not a GUID or a domain name is now rejected before az
  runs.
- The fleet fixtures no longer fetch or move the checkout that runs them (#104).
  `tests/fleet-execution.test.sh`, `tests/home-guard.test.sh`,
  `tests/install-python-prereq.test.sh` and its Windows twin ran the real
  `scripts/update.*` (and home-guard `scripts/doctor.sh`) from the repository root,
  so step 1 of `coop update` fetched from the checkout's `origin` and could
  fast-forward it to a newer release, and doctor made its daily fetch there. They
  now run from a plain copy of the tree with no `.git`, and each fails if the update
  it runs sees a git checkout.
- The Azure DevOps digest reports a client with no `project` before it signs in
  (#103). It minted a token with az first, so `tests/ado.test.sh` ran the
  developer's real Azure CLI and credentials, and failed on a machine without az.
  The test's missing-project case now runs with a failing `az` first on `PATH` and
  as `COOP_AZ_BIN`, and fails if az is called.

## [0.23.5] — 2026-09-22

### Fixed

- Test suite no longer leaks orphaned fixture processes: the Fabric SQL
  launcher's cancel test intentionally leaves a TERM-ignoring busy-loop stub,
  and the resolver's probe grandchild (`sh "<tmp>/Python Runtime/python3"
  -c ...`) was orphaned mid-loop on every run, spinning at 100% CPU forever
  (real incident: 7 accumulated orphans held this VPS at load ~13, which
  load-flaked three unrelated timing tests). The test now reaps anything
  under its unique fixture root in `finally`.

- sync-knowledge hang fixtures: per-command timeouts 1s → 3s (5s for the
  interrupted-clone case), and case D now polls for the fixture's sleeper
  record instead of assuming a fixed 1s scheduling head start. Under load the
  background fake git could miss the 1s window entirely — sync's own timeout
  fired first and the sleeper never got recorded (real flake: "fake git never
  spawned its sleeper descendant" in full-suite runs, while the same test
  passed standalone).

- Setup wizard (`/setup-docs` JSONL bridge): when `coop-data-doc` exits without
  a terminal event (e.g. it dies right after emitting a prompt), the bridge now
  reports `coop-data-doc closed without a terminal event` instead of a
  `setup protocol contradiction (exit 0, event none)` — a silent close is not
  a protocol contradiction. A stdin `EPIPE` on the wizard answer is likewise
  reported with the same "closed before it accepted the wizard answer" wording
  as the pre-write check, instead of a bare `write EPIPE`. Both make the
  early-close message stable regardless of which OS event ordering wins the
  race (previously load-dependent — the integration test flaked ~40% on a
  loaded box).

### Changed

- CI: the Fabric MCP launch fixture's `pi-state` marker waits now allow 30s
  (was 8s) so a cold Node spawn on a loaded runner no longer flakes `main`
  (real incident: post-merge run `35662073009` failed on the identical tree
  that passed its PR run).

- `coop` now fails fast with a clear, actionable message when the dot-sourced
  helper library (`lib/common.ps1` / `lib/common.sh`) is missing — the
  signature of antivirus/Defender quarantining it on a fresh Windows clone —
  instead of cascading "not recognized" errors from every helper call.

## [0.23.4] — 2026-09-21

- Windows install: `Add-CoopUserPaths` now resolves the pipx launcher directory
  via `sysconfig.get_path('scripts', 'nt_user')` (e.g. `%APPDATA%\Python\Python312\Scripts`)
  instead of the nonexistent `%APPDATA%\Python\Scripts`, so a fresh-user install
  can actually see the pipx it just installed — step 4/9 (Microsoft Fabric CLI)
  no longer fails with `pipx not recognized`, and the `--fetch-python` fallback
  for machines without Python 3.12/3.13 engages as designed.

- Bounded Warehouse session approvals now support bracketed SQL identifiers,
  including escaped closing brackets, while keeping cross-database targets,
  mutations, batches and unsupported quoting separately gated.

- Guardrail MCP dispatch normalization now covers dynamic `mcp__<server>` wrappers,
  preventing inner mutations from bypassing classification. Verified bounded SQL
  grants are shared with central-proxy calls without repeated prompts; changed
  targets/limits and unverified controls require fresh approval. Offline regressions
  exercise Pi's real AgentSession and ExtensionRunner hooks in both matrix scripts.

### Fixed
- Block tool calls when a guardrail enforcement check or approval dialog throws,
  without exposing exception details. Record fixed audit classifications instead
  of command text, and suppress command details when displaying legacy audit entries.
- Run BPA reviews with the current Tabular Editor CLI, including built-in
  rules when no rule file is configured, and preserve JSON findings and diagnostics.
- Accept the pinned SQL/DAX reviewers' 12-character finding fingerprints in native
  review tools while retaining full SHA-256 validation for standards provenance.
- Set the Fabric SQL fallback query timeout on the pyodbc connection before
  creating a cursor, allowing bounded reads to execute with the real driver.
- Repair Windows test fixtures for virtual-environment Python runtimes and
  executable detection under Git Bash.

## [0.23.3] — 2026-09-17

### Fixed
- Added native Windows Azure CLI shim handling for Fabric Warehouse token discovery,
  invoking `az.CMD` through `cmd.exe /d /c` with bounded, token-safe failure handling.
- Kept injected standards-message details structured-clone-safe without dropping the
  resolved domains, records, or patterns consumed by the terminal agent.
- Stopped scaffolding legacy project-local standards mappings by default and added
  bounded, archive-before-edit migration and diagnostics for deliberate cleanup.
- Replaced the Fabric Warehouse SQL endpoint's incompatible `mcp-remote` dynamic
  OAuth flow with direct Streamable HTTP bearer authentication from a launch-time,
  non-persisted Azure CLI token; failures leave Coop and other MCP integrations usable.
- Marked only the synthetic Windows Git-Bash web/no-Python minimal-PATH fixture as
  unsupported; all terminal, token-persistence, PowerShell, and remaining web checks
  continue to run. Web retirement is deferred to separate cleanup.

## [0.23.2] — 2026-09-16

### Added
- P0 Warehouse MCP and Microsoft skills catalog fixtures: bounded MCP tool
  discovery, target mismatch classification, project-policy launch filtering, and
  a deterministic vertical-slice acceptance receipt with a single SQL executor.
- Team knowledge integration:
  - Optional `knowledge` configuration block in `~/.coop/config` prompted during onboarding, supporting multiple subscribed team repositories.
  - Fail-soft sync script (`scripts/sync-knowledge.sh` / `scripts/sync-knowledge.ps1`) wired into `coop sync` and `coop update`.
  - Subordinate team skills launch slot in `bin/coop` and `bin/coop.ps1`, surfacing external repository skills under first-party precedence.
  - New `team-knowledge` skill and `before_agent_start` recall note hook.
  - New `/share-learning` prompt with desktop-compatible frontmatter and quiet friction nudge on turn settle.
- Bounded, unattended git runner for knowledge sync (`scripts/knowledge-git.py`):
  hard process-tree deadline (default 30s, `COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS`),
  no interactive credential prompts, unattended BatchMode SSH that preserves
  host-key checking, and distinct timeout reporting. Sync now treats a failed or
  timed-out `git status` as UNKNOWN state (warn + skip) instead of reading empty
  output as a clean checkout, and clones land in a unique temporary sibling that
  is moved into place only on success — an interrupted clone can never leave a
  husk at the configured destination.
- Deterministic local keyword search across team-knowledge clones
  (`scripts/search-knowledge.py`): stdlib-only, case-insensitive literal match
  over Markdown files with `.git` pruned and symlinks never followed, emitting a
  single capped JSON document per run.
- New `tips` vibe set (`vibes/tips.txt`): a curated, tips-only rotation of practical
  Coop commands and working habits with no easter eggs. Select it inside Coop with
  `/coop-vibe tips`; it also joins the default `/coop-vibe all` rotation.

### Changed
- Official Microsoft skills now document `coop sync` + pinned immutable catalog as
  the operational path. Legacy `source`/`load_dir` fields and
  `scripts/fetch-microsoft-skills.sh` are compatibility-only, and launch never
  networks for Microsoft skills.
- The `/share-learning` friction nudge now fires only on repeated tool failures
  (>= 2 distinct failed tool results, deduplicated by tool call). Automatic
  user-steer/correction/retry detection is deferred — manual `/share-learning`
  still covers corrections and discoveries. The failure tally, dedupe set, and
  once-only nudge flags reset per session so a fresh session can be nudged
  again.
- Review corrections on the team-knowledge pass (PR #49):
  - Fixed a duplicate UTF-8 BOM in `bin/coop.ps1` and `scripts/sync-knowledge.ps1`
    that made PowerShell parse the shebang line as a command; a byte-level gate
    now rejects any `.ps1` with zero or duplicate BOMs (`scripts/check-parity.sh`,
    `tests/bom.test.sh`, `tests/run.ps1`).
  - `team-knowledge` skill and `/share-learning` prompt are bound to the
    supported workflow: the skill drives `scripts/search-knowledge.py` through
    its structured statuses and cites repository identity + note path; the
    TeamAI recall/push routes are removed; the prompt requires selecting the
    intended knowledge repository before publication (PR-only).
  - `scripts/knowledge-git.py` applies ONE deadline to the complete operation —
    after the child exits, the owned process group (identity captured at spawn)
    is bounded and killed on expiry so descendants can never hold a capturing
    caller open past the deadline. SSH: env transports stay untouched,
    `core.sshCommand` is honored (BatchMode only appended to plain `ssh`;
    non-ssh custom transports are preserved with an actionable warning).
  - `scripts/search-knowledge.py` captures traversal errors: an unreadable root
    is `unavailable` and never claimed searched; an accessible root with an
    unreadable subdirectory is a marked-partial search with an explicit warning.
  - Test fixtures on Windows are compiled to a real `git.exe` (an extensionless
    shell script is invisible to `CreateProcess`), and every bounded-git test
    asserts the fixture actually ran — a missing invocation log fails the test.
- Second review corrections on the team-knowledge pass (PR #49):
  - `Get-CoopSkillName` in `lib/common.ps1` no longer crashes the PowerShell
    launcher on a one-line or unreadable team skill (`Get-Content` returns a
    scalar string for one-line files; indexing it yielded a `[System.Char]`
    with no `.Trim()`) — empty, one-line, and multiline-without-name skills
    are rejected while valid skills still load.
  - `scripts/knowledge-git.py` bounds the COMPLETE operation on Windows too:
    the child spawns suspended, is assigned to a Job Object created with
    KILL_ON_JOB_CLOSE, then resumes — orphaned descendants holding the
    inherited output handles stay owned after the parent exits, job emptiness
    is the output-completion signal, and the job is terminated on deadline
    (taskkill fallback retained when job setup is unavailable).
  - The operation deadline is established BEFORE configuration discovery: the
    `core.sshCommand` probe runs through the same owned-process mechanism with
    the remaining time; a timed-out probe fails the operation (exit 124)
    instead of silently proceeding with a guessed default transport, and a
    probe that cannot start is distinguished from a key that is not set.
  - Windows timeout fixtures compile a real `git.exe` that receives its target
    paths through the environment, spawn a real child sleeper whose PID the
    tests verify terminated, and pass a standalone smoke test before any
    timeout assertion depends on them; the extensionless shim that shadowed
    `git.exe` (WinError 216) is removed.
  - `team-knowledge` skill: zero literal matches now mean "no matches for this
    query" with a simpler-keywords retry — a literal search is not a semantic
    search — not "the team has no note on the topic".
- Team-skill launch-slot parsing in `bin/coop` / `bin/coop.ps1` now validates
  frontmatter before adding any launch argument: an external skill that cannot
  identify itself is skipped with a warning instead of being added
  half-validated, and the loader always exits cleanly under `set -e`.
- Normal Coop startup now goes directly to the prompt instead of auto-opening the
  Start Here or missing-project wizard. `/start`, `/setup-project`, and
  `/setup-docs` remain available on demand, including all discovery, partial,
  mixed-repository, and connected-estate project options.
- Data-doc setup is now fully opt-in: Coop no longer opens the lineage wizard
  during session startup or after project setup. `/setup-docs`, the `/start`
  *Document my data* action, and `coop data-doc setup` remain available anytime.
- New project contracts now separate Warehouse/Lakehouse and semantic-model
  DEV/TEST/PROD workspace mappings under `fabric.environment_names` and
  `power_bi.environment_names`. Both terminal and in-Coop setup paths generate the
  same layout; updates leave existing client contracts unchanged.

## [0.23.1] — 2026-09-02

### Fixed
- Data-doc paths prefilled from `project.yml` now use portable forward slashes on
  Windows, so `/setup-docs` receives the same relative paths on every platform.

## [0.23.0] — 2026-09-02

### Changed
- New-client setup now supports discovery, partial, mixed-repo, and fully connected
  estates. The in-Coop project wizard can start with no local repository and records
  current coverage, while Coop uses read-only dev/test metadata to fill gaps and
  approval-gates live rows plus every production read.
- The release fleet now pins `coop-data-doc` 1.2.0 across the release manifest,
  tested compatibility metadata, and copy-paste CI pipelines so install/update/sync
  converge every workstation on the progressive-estate setup protocol.
- Fresh interactive installs now finish model setup in Coop itself: the real
  `/login openai-codex` command is prepared, successful browser authentication
  returns automatically to the final doctor check, and a plain unauthenticated
  `coop` launch provides the same fallback without affecting signed-in users.
- Fresh installation now uses a short first-run path: one Microsoft-cloud choice
  replaces the individual MCP toggles, recommended integrations are applied
  automatically, and advanced choices remain in `coop onboard --config-only`.
- `logging.require_task_log: true` is now enforced as a per-turn completion
  postcondition: Coop explicitly invokes `daily-logger` after meaningful work and
  warns if a settled task changed/reviewed/validated the project without updating
  today's configured log. Read-only Q&A and explicit per-task opt-outs stay quiet.
- Project setup no longer depends on users knowing `coop init` or editing YAML:
  Coop now offers a native wizard on first launch in an unconfigured Git repo,
  exposes it from `/start` and `/setup-project`, and safely edits existing
  contracts while preserving comments, custom policies, and unknown fields.
- Coop is now the single update voice: Pi and managed-extension self-update notices
  are suppressed, `context-mode` self-upgrades are redirected to manifest-safe
  `coop update`, and the useful daily checkout-behind nudge remains unchanged.
- Coop now enables Pi's quiet-startup setting in its isolated configuration, hiding
  the raw context/skills/prompts/extensions/themes inventory without disabling any
  resources or the branded Coop header.
- Terminal tabs now use `coop - <session> - <folder>` instead of Pi's `π` title and
  reassert the Coop title after startup checks and session changes. Existing terminal
  profile icons remain controlled by the terminal; Coop shortcuts keep `coop.ico`.
- Embedded `coop-data-doc` setup now discovers nearby repository folders in a
  type-to-filter path browser and reports early wizard exits cleanly.
- `coop init` can now run Azure CLI sign-in inside the project wizard and use
  the detected tenant immediately, without requiring a separate terminal step.
- Updated the tested `context-mode` extension pin from `1.0.162` to `1.0.169`,
  eliminating its stale-version warning and incorrect Pi source-build hint.
- Shared-library convergence now bypasses a broken user-level `npm` shim and
  uses the same verified managed fallback as extension-pin convergence.
- Reworked rotating vibes into in-agent `/commands` and practical "Ask Coop" / "Try"
  prompts grounded in recurring Power BI, Fabric, SQL, and lineage work. Restored The
  Office and Office Space to the internal pool, expanded every worker's rotation, and
  removed shell-only instructions that were not useful from an active Coop session.
  The client-safe sets cover every slash command documented by `coop-website`; the
  default rotation now also includes `coop-internal`, since Coop is an internal tool.

### Fixed
- Azure onboarding now preserves and parses the tenant returned directly by
  `az login --allow-no-subscriptions`, so Fabric-only and guest tenants work even
  when `az account show` has no default subscription. Multiple tenants get an
  explicit picker, failed browser auth offers device-code recovery, success is
  confirmed in place, and project launch verifies a Power BI token for the exact
  pinned tenant before caching the sign-in.
- Windows install/update now repairs a Fabric CLI pipx environment that inherited
  Python 3.14 even when the VM has no `winget`, `py`, or `pymanager`: pipx fetches
  an isolated standalone Python 3.12, rebuilds `ms-fabric-cli`, and reinjects the
  manifest-pinned `fabric-cicd` library.

## [0.22.5] — 2026-08-25

### Fixed
- Windows Python bootstrap: install/update try the Python launcher / install
  manager (`py install 3.12`) before winget, and the Fabric Python finder
  discovers side-by-side interpreters that are not on `PATH` (Python install
  manager `%LOCALAPPDATA%\Python\bin`, winget user and machine scopes), so
  pymanager-only machines find 3.12/3.13 and reject 3.14 (#46).
- pipx ownership check: pipx 1.x on Windows lists apps with their extension
  (`fab.exe`), so every healthy tool warned "does not belong to its pipx
  environment"; the check now matches both forms (#46).
- `coop update` surfaces pip's last `ERROR` line when a `fabric-cicd` inject fails
  (for example `Requires-Python <3.14` against a 3.14 venv) instead of failing
  silently (#46).

## [0.22.4] — 2026-08-25

### Fixed
- Fresh installs now bootstrap a Fabric-compatible Python alongside an existing
  Python 3.14 instead of treating any Python as sufficient and later failing to
  install `ms-fabric-cli`.
- `coop update` now installs missing manifest-pinned pipx tools instead of
  leaving incomplete workstations broken and directing users to a second command;
  it also bootstraps a Fabric-compatible Python when needed.
- Onboarding now offers Azure CLI sign-in and automatic tenant detection before
  asking for a tenant ID, with inline Azure Portal directions as a fallback.
- Onboarding now labels this identity explicitly as the client-resource tenant;
  current Fabric and Power BI integrations reject any differently marked tenant.
  The future Cooptimize Shared Knowledge identity remains a separate sign-in and
  token domain that cannot replace the client's Azure CLI session.

## [0.22.3] — 2026-08-24

### Fixed
- Shared Pi-library skew repair now replaces only exact `pi-ai`/`pi-tui`
  packages with lifecycle scripts disabled, so a repair cannot rebuild unrelated
  native dependencies such as `context-mode`'s `better-sqlite3` on Windows.
- Windows sync now preserves complete extension package names when stripping
  the `npm:` transport prefix; scoped packages no longer become invalid names
  during exact-pin/shared-library convergence.
- Repeat syncs now leave already-exact extensions untouched, avoiding needless
  network installs while still verifying every postcondition and repairing
  shared-library skew.
- Bash update inventory now consumes complete `pipx list` output under
  `pipefail`, preventing early-match SIGPIPE from misclassifying installed tools.
- `coop install` now preserves failed install and sync steps in its final exit
  status instead of allowing a warning-only Doctor result to report bootstrap
  success for an agent that still cannot launch.
- `coop update` now returns nonzero when any Pi/tool convergence, Fabric library
  injection, or sync step fails; it still runs Doctor for diagnostics, but no
  longer converts visible `upgrade failed` warnings into a successful exit.
- Fabric CLI install/update now creates its pipx environment with an explicitly
  supported Python 3.13 or 3.12 interpreter instead of inheriting Python 3.14
  and failing `ms-fabric-cli`'s `<3.14` requirement. If neither interpreter is
  available, Coop reports the exact prerequisite instead of a generic failure.
- The optional live coop-data-doc JSONL test now skips cleanly when the binary
  is absent and imports its generated extension bundle through a Windows-safe
  file URL.
- `coop release` now updates and stages `config/release-manifest.json` alongside
  `VERSION` and extension package versions, and refuses to start from an
  inconsistent checkout. This prevents publishing a tag whose manifest still
  identifies the previous Coop release.
- First-run onboarding through plain `coop` now continues into Pi with
  "Setup complete. Starting Coop…"; an explicit `coop onboard` ends with
  "Setup complete. Run 'coop' to start." A failed onboarding now stops the
  launcher instead of continuing with a partially generated MCP configuration.

### Changed
- Promoted the tested Pi release pin from **0.80.2** to **0.84.3**. A real
  clean-room Windows run proved that the current pinned extension fleet now
  requires `pi-ai >= 0.84.3`, so retaining 0.80.2 produced the same
  update-then-launch-abort seen on workstations. Coop now installs the coherent
  0.84.3 runtime and shared-library set; legacy runtimes fail with explicit
  upgrade guidance instead of leaving a mixed, unlaunchable tree.
- Added `scripts/test-pi-matrix.{sh,ps1}`: clean-room Pi compatibility matrix
  (temporary npm prefix + temporary agent dir; never touches the workstation).
  Each run installs a coherent fleet at exact manifest versions via dependency
  specs (npm rejects same-name overrides with EOVERRIDE — dependencies are the
  deterministic mechanism), verifies shared pi-ai/pi-tui against the runtime's
  own package metadata, loads first-party extensions through the real loader,
  exercises RPC startup/get_state/clean shutdown plus a live agent turn when
  credentials permit, proves second-sync idempotency, and reproduces+repairs a
  deliberate shared-lib skew (including the observed getOAuthApiKey class of
  failure). Pi 0.84.3 passes the full production-convergence matrix on macOS;
  Windows is enforced in CI. Older Pi releases remain covered by explicit
  incompatibility/upgrade-path tests rather than being advertised as supported.
- New live test drives the real coop-data-doc setup wizard over its JSONL
  transport end-to-end (hello first, every prompt answered, exactly one
  `complete`, exit 0, valid config, JSON-only stdout); skips cleanly when the
  installed tool predates the JSONL transport.
- Approved and pinned the verified Python tool trio after clean-room
  verification on Python 3.13 (isolated pipx home): `ms-fabric-cli` 1.6.1 →
  **1.7.0**, `fabric-cicd` 1.1.0 → **1.3.0** (injected into the Fabric CLI env;
  confirmed compatible pair via `pip check`), `coop-data-doc` stays at **1.1.1**
  (full scan/build/check/lineage/config-set + JSONL setup protocol contract
  re-verified). Read-only authenticated `fab ls`/`auth status` exercised.
- `coop sync` now verifies every core extension against the manifest pin AFTER
  installation and states the exact outcome ("Already at release version X" /
  "Installed release version X" / "Updated A → B"); a successful-looking install
  that leaves the wrong version or nothing in the isolated tree is reported as a
  postcondition failure and makes sync exit non-zero. Shared pi-ai/pi-tui work
  is worded as runtime alignment, distinct from release pins.
- `coop doctor` no longer trusts `pipx list` or a package name as the executable:
  the in-venv distribution metadata (`pipx runpip <venv> show <dist>`) is the
  authoritative version, cross-checked against the CLI's own `--version`, with
  ms-fabric-cli checked via its real `fab` executable (Paramiko collision check
  retained). Metadata/CLI disagreement is classified as a stale/corrupt pipx
  environment with an exact `pipx install --force` repair; when pipx itself is
  unreadable the CLI classification says so. Doctor now also reports the Python
  interpreter INSIDE each tool's venv and flags unsupported versions (≥3.14)
  with a recreate command.
- Doctor's Python-support verdict now comes from each distribution's own installed `Requires-Python` metadata (evaluated against the venv interpreter) instead of a hardcoded version cap.
- Onboarding no longer offers toggles it cannot honor: Power BI MCP is stored
  disabled (with the reason) when no Azure tenant is configured instead of
  enabled-but-silently-omitted; Azure DevOps MCP requires a valid organization
  (short name or `https://dev.azure.com/<org>` URL) and can be backed out of.
  The tenant prompt states that Coop accesses the tenant holding the Fabric and
  Power BI resources — normally the client's Microsoft Entra tenant, the
  Cooptimize tenant only for internal work — and prints a review summary
  (tenant, enabled/omitted integrations, destination) before saving.

## [0.22.2] — 2026-08-24

### Fixed
- Fixed `coop-profile` startup against Pi's real extension API. The extension now registers
  directly with `api.on(...)` instead of reading a nonexistent nested `api.pi`, which caused
  Coop to exit immediately after onboarding with `Cannot read properties of undefined`.
- Stabilized multi-command Git enforcement, repository-scoped commit policy, and headless approvals.
- Made install/update/sync and generated MCP entries manifest-pinned; Modeling MCP starts read-only.
- Unified `/setup-docs` on the native JSONL wizard and hardened onboarding, profile, and project init.
- `coop install` now CONVERGES drifted components to the manifest without `--force`: missing →
  install exact, matching → skip, drifted → force-install exact (Pi, pipx tools, Fabric CLI).
- `coop doctor` parses generated mcp.json structurally (pretty-printed args no longer misread as
  missing `--start`); the setup bridge enforces the JSONL hello handshake and protocol version
  (1.x) before the first prompt/terminal event; governance snapshot resets on Pi session switches
  (`/new`, `/resume`, `/fork`).

### Security
- Hard-blocked `git commit --amend` and `--pathspec-from-file` / `--pathspec-file-nul` commit forms.
- Closed a bypass where quoting or splitting the command name (`"git"`, `"gi"t`) evaded all Git
  enforcement; commands merely mentioning git as an argument (`grep git README.md`) are no longer
  falsely blocked. `rm -rf` classification is segment-scoped.

### Changed
- Repository governance policy is snapshotted once per session: in-session edits to
  `.coop/project.yml` cannot weaken active guardrails, sibling repositories resolve their
  configured policies from the session contract, and `.coop/project.yml` itself is no longer
  agent-committable by default.
- `coop update` has two fleet modes: normal pins everything to the release manifest (no registry
  queries or prompts); `--edge` is the only latest/upstream mode. The tested-version gates,
  their prompts, and `--pi-latest` (deprecated alias for `--edge`) are removed.
- `coop doctor` verifies every managed extension against its exact manifest pin and requires
  BOTH `--start` and `--readonly` to report Power BI Modeling MCP healthy.
- `context-mode` has one ownership path: native Pi extension only (no duplicate MCP server).
- Onboarding reports MCP-generation failures cleanly instead of tracebacking after saving config.
- Requires `coop-data-doc` 1.1.1 (JSONL protocol v1.1: hello handshake, typed answers, atomic
  config write); the setup bridge accepts the hello event.

### Added
- `coop context-budget` command with human-readable and `--json` output to report fixed startup context sizes; optional `--measure` falls back to static estimates until an explicit-approval provider measurement path is added.
- CI context-budget gate (`scripts/check-context-budget.sh` / `.ps1`) with thresholds based on the corrected optimized baseline: `docs/guardrails.md` ≤ 6,500 bytes and estimated fixed total ≤ 7,000 tokens.

### Changed
- Shrunk always-loaded `docs/guardrails.md` from ~13.7 KB to ~4.6 KB by moving detailed enforcement mechanics, tool guide, workflow steps, and communication norms to the new on-demand `docs/guardrails-reference.md`. Policy semantics, hard blocks, approval paths, and required phrases (`tests.live_data.enabled`, non-blocking slice progress) are preserved.
- Corrected `coop context-budget` classification: prompt template bodies are now reported as on-demand inventory rather than fixed startup context, and the user profile is measured as the instruction injected by `coop-profile` instead of raw `user.json` bytes. Updated baseline docs, completion report, and CI threshold accordingly.

## [0.22.1] — 2026-08-20

### Changed
- `coop install` gains `--no-prereqs` to skip auto-installing missing system prerequisites (they are still reported).
- `coop install` now automatically installs missing system prerequisites (Git, Python 3.12, Node.js LTS, Azure CLI, and pipx) via `winget` on Windows or `brew`/`apt`/`dnf` on macOS and Linux when package managers are available, dynamically adds their installation directories to `PATH` for the remainder of the setup, and checks for the cross-platform Tabular Editor CLI (`te`).
- `coop doctor` now detects the cross-platform `te` CLI on `PATH` and in standard tool directories (`~/.local/bin`, `%LOCALAPPDATA%\Programs\te`), and `coop doctor --fix` now auto-installs `ms-fabric-cli` and injects `fabric-cicd`.
- `coop update` now applies the same tested-version gate it uses for Pi to the pipx tools (`coop-data-doc`, `coop-sql-review`, `coop-dax-review`, `ms-fabric-cli`) and to the injected `fabric-cicd` library: a release crossing the tested MINOR asks before jumping, and declining (or a non-interactive shell without `--yes`) pins that tool to its tested version instead of silently upgrading past it. `coop update --check` now also shows the latest pipx version alongside current/tested.

### Fixed
- Approved vertical slices now run continuously through backup, related edits, review, authorized Dev/test validation, restoration, and the passing check. Backup, refactor, review, and ordinary progress updates are explicitly non-blocking internal steps; repeated `continue` prompts are reserved for genuine blockers or scope/safety changes.
- `bin/coop.ps1` now preserves a single trailing subcommand argument as an array. Previously, PowerShell split `coop update --check` into individual characters, ignored the flag, and entered the real update path instead of the documented dry run; the wrapper-level regression test now proves `--check` remains read-only.
- `lib/_bpa_runner.py` now drives the cross-platform `te` CLI with its native subcommand (`te bpa run <model> -r <rules> --non-interactive`, JSON output with a text fallback) — the previous TE2-style `-A`/`-V` invocation was rejected up front and produced zero findings. Legacy Tabular Editor 2/3 resolution is removed entirely; install/doctor check for `te` only, and docs point at `te auth login`.
- `lib/common.ps1` (and the tool-directory scans in `scripts/install.ps1` / `scripts/doctor.ps1`) no longer call `Join-Path` with env vars that are unset outside Windows (`ProgramFiles(x86)`, `LOCALAPPDATA`, `ProgramFiles`), which printed a `Join-Path` error on every PowerShell run under macOS/Linux pwsh or 32-bit Windows; the dead Tabular Editor desktop directory scans were dropped (the `te` binary just sits on PATH).
- Removed the unconsumed `tools.tabular_editor_cli.command` key from `config/defaults.yml` — the BPA runner reads only `executable_path`, `enabled`, and `bpa_rules_path`.
- Added `tests/bpa-runner.test.sh`: stubs `te` and asserts the runner invokes `bpa run` with `--non-interactive`, parses the JSON findings, and never resolves `TabularEditor.exe`.
- The `tabular-editor-bpa` skill's severity table is corrected to the te CLI semantics (1=info, 2=warning, 3=error) and notes the te rule-file schema.
- `scripts/install.sh` installed brew's keg-only `python@3.12` without putting its `libexec/bin` (where the unversioned `python3` symlinks live) on `PATH`, so a fresh macOS install still reported "python not found" and skipped pipx. It now adds the keg bin dir to `PATH` and falls back to `python@3.13` (never the unversioned 3.14+ formula, which `ms-fabric-cli` rejects).
- `scripts/install.{sh,ps1}` now check the Node version right after auto-installing it — package managers often deliver Node 18/20, which is older than Pi's >= 22.19 requirement — and warn instead of printing a misleading ✓.
- `scripts/doctor.{sh,ps1}` now warn when Python is older than the coop tools' >= 3.10 requirement (e.g. the 3.9 python3 that ships with macOS Command Line Tools).
- `scripts/install.ps1` no longer crashes on 32-bit Windows, where `${env:ProgramFiles(x86)}` is unset and `Join-Path` threw.
- Docs: Azure CLI is marked *optional* again (auto-installed if missing, but coop works without it for local SQL/DAX review), matching `coop doctor`.
- `tests/workflow.test.mjs` resolved the repo root via `new URL("..", import.meta.url).pathname`, which produces a mangled doubled-drive path on Windows (`D:\D:\a\...`) and crashed the Windows logic-tests CI job. It now uses `fileURLToPath` (same convention as `tests/webbridge.test.mjs`).
- `skills/custom-visuals/SKILL.md` had an unquoted `: ` in its frontmatter description ("Power BI reports: Deneb…"), which strict YAML parsers reject — skill loading failed with "Nested mappings are not allowed in compact mappings". The description is now quoted, and `scripts/validate-resources.sh` fails the build when a plain-style description contains `: ` so this class of bug can't ship again.

## [0.22.0] — 2026-08-13

### Added
- Vertical slices are now the default workflow for multi-step tasks. The
  `coop-workflow` skill requires a failing-check → change → passing-check template
  for each slice, plus explicit assumptions, early-warning signals, and
  stop-and-ask triggers so the model teaches its reasoning as it goes. Each
  slice now defines its own test; the configured live-data command is only an
  optional default runner.
- New `/slice-next` prompt to plan the next vertical slice before editing, with
  slice-specific failing/passing checks and exact data conditions.
- New `/explain` prompt for on-demand explanation of the current plan so an
  experienced teammate can catch drift early.
- Optional live-data test hook in `.coop/project.yml`:
  `tests.live_data.enabled` runs a configured command between slices with approval
  and dev/test workspace safety.
- `tests/workflow.test.mjs` validates the slice workflow, prompt, project contract
  schema, and guardrails reference.

## [0.21.0] — 2026-08-12

### Added
- Native Power BI/Fabric authoring skills that follow Cooptimize conventions and
  use the MIT-licensed Microsoft tooling already bundled with coop:
  - `power-bi-report-authoring`
  - `power-bi-report-review`
  - `custom-visuals`
  - `report-themes`
  - `tabular-editor-bpa`

### Fixed
- `coop init --ci github|ado` works again (function ordering and rc handling).
- `coop init --ci` without a value now prints a clear error.
- `coop doctor --publish` no longer references an undefined `coop_version`.
- `scripts/doctor.ps1` now checks whether allow-listed Microsoft/Fabric
  subordinate skills have been fetched.
- `coop review` removes a stale `bpa-review.json` before running the BPA step.
- `coop update` installs Power BI/Fabric npm tools if they were never present.
- `coop uninstall` removes the `@microsoft/powerbi-*` npm tools.
- `scripts/doctor.sh` no longer probes the network for `powerbi-modeling-mcp`.

### Changed
- `powerbi-report-author` is now a required dependency (four of the five new
  Power BI skills depend on it).
- `lib/_bpa_runner.py` now uses `lib/_yaml.py` for project.yml parsing.

## [0.20.0] — 2026-08-11

### Added
- `dax-patterns` skill: SUMX + SUMMARIZE reshape-to-grain DAX pattern guidance for
  entity-level logic (exchange rates, customers-with-balances, semi-additive,
  weighted averages, thresholds, de-duplication, performance). Loads every session
  and is cross-referenced from `dax-review` fix suggestions.

### Fixed
- Fabric skills now actually load: `coop launch` (via `coop_build_pi_args`) descends
  the `_microsoft_fabric` slot and surfaces the `fabric_skills.allow[]` list, with
  the same subordination and name-validation guards as `_microsoft`.

## [0.19.0] — 2026-08-11

### Added
- Official Microsoft **Skills for Fabric** (`github.com/microsoft/skills-for-fabric`) are
  now supported as a second skill source via `fabric_skills` in `.coop/project.yml`.
  Allow-listed skills are fetched into `skills/_microsoft_fabric/` and remain
  subordinate to Cooptimize skills.
- Added 13 Fabric/Power BI authoring skills to the default allow-list:
  `check-updates`, `powerbi-report-design`, `powerbi-report-planning`,
  `powerbi-report-authoring`, `powerbi-report-management`,
  `semantic-model-authoring`, `eventhouse-cli`, `sqldw-authoring-cli`,
  `sqldw-consumption-cli`, `dataflows-cli`, `e2e-medallion-architecture`,
  `spark-authoring-cli`, `fabriciq`.
- `coop install` / `coop update` now install/refresh the npm tools these skills
  need: `@microsoft/powerbi-report-authoring-cli`,
  `@microsoft/powerbi-modeling-mcp`, and (Windows only)
  `@microsoft/powerbi-desktop-bridge-cli`.
- `coop doctor` checks for the Power BI/Fabric authoring npm tools.
- Added `powerbi-modeling-mcp` to `config/mcp.example.json`.

### Changed
- `scripts/fetch-microsoft-skills.sh` now fetches from both
  `microsoft_skills` and `fabric_skills` source blocks.
- `docs/guardrails.md` and `skills/coop-workflow/SKILL.md` explicitly require
  Microsoft authoring skills to follow the coop workflow: plan-and-approve,
  back up, review, show diff, and **never commit source**.
- `scripts/check-parity.sh` ignores `.cache/*` so fetched Microsoft skill repos
  don't fail the PowerShell BOM check.

## [0.18.3] — 2026-08-10
### Added
- Vibes: `coop-internal` expanded with The Office (US), Office Space, and The 5th Element easter eggs; `professional.txt` gained a small client-safe seasoning section from the same sources.

## [0.18.2] — 2026-08-06

## [Unreleased]
### Changed
- Vibes: restored the D365 reference in the Monty Python line — D365 (Microsoft Dynamics 365) is a general product term, not client-specific

## [0.18.1] - 2026-08-06
### Changed
- Vibes: `coop-internal` expanded with more crew in-jokes (Joel, Eric, Tanner, Josh, Simar, April, Aaron) and heavier South Park / Star Trek / Monty Python & the Holy Grail (plus Star Wars) easter eggs; the four pooled sets (data-doc, dax-review, fabric, sql-review) gained client-safe "classics" sections. `professional.txt` stays client-safe.

## [0.18.0] - 2026-07-15
### Added
- `coop review --diff [ref]`: runs the review suite over only the files changed since `ref` (default: `HEAD`) in git-tracked roots, ignoring untouched files (issue #42)

## [0.17.0] - 2026-07-15
### Added
- Fleet health digest: `coop doctor --json --publish` writes state to `fleet.publish_dir`; `scripts/fleet-digest.sh` aggregates them into an email digest via Microsoft Graph (issue #41)

## [0.16.0] - 2026-07-15
### Added
- Generate CI pipelines (`.github/workflows/coop-gates.yml` or `azure-pipelines/coop-gates.yml`) using `coop init --ci github|ado` (issue #39)

## [0.15.0] - 2026-07-15
### Added
- Wire up `coop_review_core` HTML suite summaries in `coop review --html` (#33)
- Run Tabular Editor BPA as a fourth `coop review` gate when configured in `.coop/project.yml` (#38)

## [0.14.0] - 2026-07-14

### Added

- **`coop review --compare`** — after running both linters, diff each against the previous
  run's saved report and print a new / fixed / persisting delta ("12 new, 5 fixed, 210
  unchanged", with the new/fixed findings listed). Built on coop-review-core 0.6.0's delta
  engine via the linters' new `check --diff-against`: it snapshots the prior
  `.coop/reviews/<tool>.json`, hands it to each linter, and lets the linter render the
  delta; the first run simply becomes the baseline. Advisory — never changes the exit code.
  bash + PowerShell twins. Requires coop-sql-review >= 0.12.0 / coop-dax-review >= 0.15.0
  (the `--diff-against` flag); `tested_with` is bumped to match.
- **`coop review [paths...] [--strict] [--skip-docs]`** — one command for the whole
  advisory loop: runs `coop-sql-review` **and** `coop-dax-review` over the same
  scope (explicit paths win; else the nearest `.coop/project.yml`'s
  `repositories.*.local_path` entries, resolved against the contract's repo root
  with TODO/missing paths skipped — the same contract scoping the native
  `sql_review`/`dax_review` tools use; never a blind cwd scan), saves both JSON
  reports under `.coop/reviews/` next to the contract, then rebuilds the lineage
  docs with the findings composed in
  (`coop-data-doc build --non-interactive --reviews …`). Lineage docs not set up
  (data-doc's friendly exit 1) is a hint, not a failure; a hard data-doc failure
  propagates; `--strict` flows to both linters and exits 2 when either exits
  non-zero; `--skip-docs` runs the linters only. On both platforms, with a
  shimmed offline suite (`tests/review.test.sh`). To support the scoping,
  `lib/_yaml.py list` learned `*` fan-out for dotted keys
  (`repositories.*.local_path`).

### Fixed

- **`coop review` (and every YAML-driven path) now works on Windows.** The bash
  `coop_yaml_get`/`coop_yaml_list` helpers read `lib/_yaml.py`'s stdout, and
  Python's `print()` emits CRLF on Windows, so each value arrived with a trailing
  `\r`. A `repositories.*.local_path` of `sqlrepo` became `sqlrepo\r`, failed its
  `[ -e ]` path check, and `coop review` died with "nothing to review" on every
  Windows run — the reason `tests/review.test.sh` had been red on the Windows CI
  job since the feature landed. The helpers now strip `\r` from `_yaml.py` output.
- **`coop update` no longer crashes when the npm registry can't be queried** (#26).
  On Windows PowerShell 5.1, `Get-PiLatest` passed AutomationNull (npm produced no
  stdout — offline, registry/proxy error) into `[regex]::Match`, which threw
  `ArgumentNullException` at update.ps1:92 and aborted the whole update. It now
  returns `''`, matching `update.sh`'s silent-empty contract, so the tested-version
  gate simply skips and the update proceeds.

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

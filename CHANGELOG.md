# Changelog

All notable changes to coop-agent are recorded here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com); versions follow [SemVer](https://semver.org).

## [Unreleased]

### Added

- **Schema compare from the deployment call (2026-10-23).** `/setup-project` and
  the coop window's Project pane now ask for the `prod` and `test` SQL targets
  (same kind as dev; blank = no entry yet) and the shared `schema_compare:`
  lists (schemas never compared, schemas whose changed tables are rebuilt), so
  two people no longer get two diff counts from prompt-only exclusions; a run
  whose choices differ from the project file's says so and names the keys to
  add. `sql_targets.named.<set>` declares a second engine beside the main one
  (a Lakehouse SQL endpoint beside the Warehouse) and `<env>@<set>`
  (`dev@lakehouse`) names its environments in `schema_compare` and
  `coop schema compare`; a named `prod` is production for the guardrails; the
  Project pane edits the sets (a "Named target sets" group) and the
  `schema_compare.destructive` choice, which the wizard asks for too.
  Formatting-only and column-order-only differences are labelled (and counted)
  instead of looking like real changes, and still deploy. `coop doctor` and a
  once-per-folder session note name the sections an older project file lacks
  (`sql_targets.prod`, `schema_compare`, ...) and point at `/setup-project`;
  nothing is filled in on its own. New prompts: `/schema-compare` (compare, read
  the result, promote through the governed write path) and `/runbook <name>`
  (walk a client's `.coop/runbooks/<name>.md` step by step, `(manual)` /
  `(coop)` / `(check)` steps, never reordered).

### Changed

- **Docs say what the code does (suite review 2026-10-26, pick 9).** Four
  places still called every Warehouse SQL call approval-gated; the code (and
  the rest of the docs) runs a plain read on a resolved dev/test target without
  a prompt and asks for writes, so the guardrails prompt, the README's MCP table
  and ground rules now say that. "Lineage is an aid, not a gate" now names the
  one gate it does not cover (the live catalog ask before a SQL edit, SQ8), and
  `fabric_sql_query` is described as the native bounded read (the route for
  `sql_targets:` and the fallback when the MCP cannot answer), as the workflow
  skill already used it. `docs/onboarding.md` is gone: the coop site's
  Onboarding page is the one user guide, and every link points there.
  `CHANGELOG.md` keeps the current series; 0.35.0 and earlier moved to
  `docs/history/CHANGELOG-pre-0.36.md`.

### Fixed

- **A launch runs the pinned Pi only.** The manifest pin acted in `coop install`
  and `coop update`, but a launch started whatever `pi` was first on PATH, and
  its skew repair then aligned the extension tree to that Pi's version: after a
  hand `pi update` to 1.4.0 on the dev VM, a checkout launch ran Pi 1.4.0 and
  moved the shared `~/.coop/agent` tree to 1.4.0, which the installed coop moved
  back to 1.2.0 on its next launch. The preflight now refuses a Pi that is not
  the pin, naming the pin-back command (`coop update`); a maintainer running an
  `--edge` Pi on purpose sets `COOP_ALLOW_UNPINNED_PI=1`. The window package
  was never affected: it runs its bundled Pi first on PATH.
- **A session with no launch sign-in token says so.** coop launched when the
  project file named no SQL target reported `identity_mismatch` on every native
  SQL call; it is now `launch_identity_missing`, and the tool text, `coop
  schema compare` and `/setup-project`'s closing notice say to fix the file and
  exit and start coop again (a `/new` cannot mint the token the launch skipped).

## [0.38.5] — 2026-10-26

### Fixed

- **The nightly extended CI lane is green again.** The fleet-execution fixture's
  wrong-Python case (#430) matched an escaped `coop-data-doc==1.4.2` literal that
  the 1.4.3 pin (#438) did not move; the case now reads the pin from the release
  manifest, so a pin bump cannot strand it again.
- **Enter on an unknown slash command no longer runs the closest match** (#428).
  Pi's editor applied the autocomplete list's selected item on Enter, so `/exit`
  ran the first fuzzy match (an MCP prompt on the dev VM). The list now shows
  only while the typed word starts a command name (those first, the fuzzy rest
  after them); an unknown `/word` is kept in the editor with a notice and goes
  through as text on a second Enter. `/exit` quits like `/quit`.
- **The footer shows the running coop version** (`⬢ Cooptimize v0.38.5`, with
  `dev` from a git checkout) **and the tab title stays `coop - <folder>`**
  (#429): the title is reasserted after Pi's own restores (startup, `/new`, its
  Windows package check), after every turn and tool call, and on a slow
  heartbeat in a terminal, so a child process's title (`npm config get cache`)
  no longer sticks.
- **`coop update` reinstalls a pipx tool built on another Python** (#430).
  Convergence compared versions only, so a hand `pipx install` on pipx's own
  interpreter counted as converged. Each tool's environment is now checked
  against coop's Python (the window package's bundled one, else the pipx
  default; the Fabric CLI's bootstrap interpreter for `ms-fabric-cli`): a
  mismatch is removed and installed again with `--python` (`pipx install
  --force` keeps the old interpreter). `coop doctor` shows the mismatch as a
  warning. Troubleshooting entry 7 covers it and the shared account tools a
  dev checkout's `update --edge` moves.
- **A move to coop's Python that cannot be completed keeps the working tool**
  (#441). The reinstall above removed the environment first, so an install
  that then failed (offline, an index outage, a dependency the interpreter
  cannot take) left no tool at all. The replacement is now proven first under
  a suffix (`pipx install --suffix _coopnext --python <coop's>`, its own
  environment, removed again) before the old one goes; when the probe fails
  the tool stays as it was and the unit reports `could not prepare`. Should
  the final install still fail, the tool is put back on its old interpreter.
- **The native SQL source reader no longer splits a batch at a `GO` line
  inside a string literal, a quoted name or a comment** (#442): a view holding
  a multi-line string with a line `GO` kept only its first fragment, which the
  schema compare then planned as a cut, unterminated definition. The batch
  splitter is lexical now (`sql_source.segments`); real separators, `go 2`
  and `GO;` included, still split.
- **A live column list cut at the schema compare's cap is unknown, never a
  DROP COLUMN** (#443): the reader marked the catalog partial but built every
  table from the retained prefix, so a complete target got `DROP COLUMN` for
  the columns the cap lost. Every table on such a side now compares as
  `unknown` (a snapshot taken from it stays unknown), and a source-only table
  with a cut shape is not offered as a runnable CREATE.
- **A space inside a string literal or a quoted name is a change, not
  formatting** (coop-schema-compare #20, mirrored in the native compare): the
  formatting-only label folded repeated spaces across the whole flattened
  definition, literals included, so `N'a  b'` against `N'a b'` was labelled
  cosmetic. Whitespace and comments now fold run by run, outside literals and
  quoted names only.
- **`sql_source commit` no longer pulls the working tree before sqlsc runs
  (#435).** coop still fetches and checks that the branch can fast-forward
  (before the approval and again right before the commit), but the pull itself
  is sqlsc's: `sqlsc commit` fast-forwards and records which object files came
  in, so an object a fresh clone has no sync record for is held back for
  `get-latest` instead of being committed over a teammate's pushed edit. With
  coop's own pull first, sqlsc's pull was a no-op and saw no incoming files.
  The tool's answer now names what sqlsc pulled and brought in.
- **`schema_compare` (coop's native mirror, matching coop-schema-compare's
  fixes for its #14, #15 and #16):** a repo side that was not read whole (more
  `.sql` files than the limit, an oversized or unreadable file) no longer proves
  an object or schema absent: it compares as `unknown`, the script never drops
  it and the notes name the skipped files; a Lakehouse SQL endpoint never gets a
  runnable `CREATE TABLE` or `DROP TABLE` (a new, removed or replaced table
  there is a manual note like every other table change); and an object replaced
  by another kind is dropped and recreated inside its new kind's section, in
  dependency order with the modules that use it, instead of after them. The
  separate "objects replaced by another kind" section is gone.
- **Picking the newest sol now outranks an older saved Pi default (#432).**
  Choosing the newest sol in the terminal, the window or the phone used to
  remove `coop-model.json`, so a Pi default saved before the newest-sol rule
  (`gpt-6-luna`, `coop/auto`) came back at the next start. The file now records
  "follow sol": the next start and `/new` take the newest sol and advance with
  the next release. With no coop-era choice at all, Pi's saved non-sol default
  is kept as before; launch flags and `enabledModels` still win.
- **Bundled standards refreshed to the wiki's current `main` (#434)** so first
  runs and offline machines read the October SQL comment rules (line comments
  only, no block comments) with the other changes since October 1; articles the
  wiki removed are gone from the copy. `coop release` now compares the bundle's
  revision with the wiki's branch head before tagging and stops on a stale
  bundle (`bash` and PowerShell alike; an unreachable wiki warns and asks).
- **Fleet fixture: the honest pipx stub reads a local wheel spec (#433).**
  The sourced-tool path hands pipx the release wheel's path, which the stub
  recorded as a package named after the path at 9.9.9, failing the convergence
  postcondition in CI. The stub now reads the distribution and version from the
  wheel's file name, and every fixture machine's wheel cache carries a synthetic
  wheel named after the manifest's asset with the copied manifest's hash pointed
  at it, so the wheel branch runs offline, with no token, on every platform.

### Changed

- **`dax-patterns` skill:** before writing a reusable DAX helper, coop checks
  [daxlib.org](https://daxlib.org), SQLBI's gallery of DAX user-defined function
  packages, and installs a matching package as TMDL (`functions.tmdl` or
  `function_operations` under the usual approval), naming the package and its
  license in the summary. A pointer in the skill body only: no new tool, no new
  MCP server, no fixed-context cost.
- **Tool pins:** coop-sql-source-control 1.0.6 (`GO` inside a string literal,
  quoted name or block comment is not a batch break; a file name over 255
  characters is refused before any write; conflicted files stay checked out and
  `get-latest` exits 1; an unreadable lock table refuses `commit` unless
  `--force`), coop-schema-compare 0.1.6 (the #14, #15 and #16 fixes mirrored
  above) and coop-data-doc 1.4.3 (two repositories sharing a relative path both
  survive parallel parsing; retyped objects keep their column lineage; the column
  trace unions every writer; `COOP_DATA_DOC_DISCOVERY_ROOTS` fences upward
  config discovery).

## [0.38.4] — 2026-10-23

### Changed

- **Tool pin:** coop-sql-source-control 1.0.5. `commit` and `checkin` fast-forward
  the branch onto its upstream before reading anything and stop on a detached
  HEAD, a merge in progress, unresolved conflicts or a missing git identity; a
  file a pull just brought in is held back for `get-latest`; half-merged `.sql`
  files stay out of every comparison. The SSMS add-in uses coop's `sqlsc`
  first, shows its version, drops repos whose folder is gone and asks Commit's
  question about committable changes only. coop's own pull-first before
  `sql_source commit` stays; the two agree.

## [0.38.3] — 2026-10-22

### Added

- **Schema compare choices per client and per run.** The project file's new
  optional `schema_compare:` section holds a client's defaults:
  `exclude_schemas`, `schemas`, `rebuild_tables_in` (changed tables in those
  schemas are written as `DROP TABLE IF EXISTS` + `CREATE TABLE`, even where an
  `ALTER` would do) and `destructive` (`runnable` or `commented`). A run names
  its own with the tool's `schemas`, `exclude` (added to the file's list),
  `rebuild` and `commented`, or `coop schema compare --rebuild-tables-in` and
  `--destructive`. report.md, the script header and the result say which
  choices were used and where each came from.
- **One note per object in both files.** report.md has a section per object and
  deploy.sql a note before each one: type, detected change, chosen action, the
  column changes, identity kept, data loss and reload notes, from one shared
  record, with object, statement and batch counts that agree.

### Changed

- **New sessions start on the newest sol.** In the terminal, the window and
  on the phone, a new session starts on the newest `sol` model the OpenAI
  Codex sign-in can use, so the next sol release becomes the default with no
  coop update. A model you pick (`/model`, the window's or the phone's picker,
  `coop/auto` included) is remembered and new sessions start on it; picking
  the newest sol again goes back to following releases. A non-sol default
  saved in Pi earlier is kept, and `--model` at launch still wins. Routing is
  unchanged: `coop/auto` stays opt-in.
- **Tool pin:** coop-schema-compare 0.1.5 (the same deploy script fixes in
  the standalone CLI: identity, one change record per object, runnable
  destructive statements, `--rebuild-tables-in`).
- **Destructive statements in deploy.sql are active by default** (Aaron,
  2026-10-22: the team reviews and runs the script itself), each object marked
  DESTRUCTIVE. `destructive: commented` (or `commented: true` for one run)
  writes them with `--` before every line, so removing two characters per
  line gives the statement back exactly. coop still never runs the script.
- **A rerun keeps a hand-edited deploy.sql** beside the new one as
  `deploy.edited-<time>.sql` instead of overwriting it.

### Fixed

- **The phone page is never blank.** A phone that could not reach the computer
  (Tailscale off or disconnected) and still held the page saved from an earlier
  version showed nothing at all, with no pairing form. The page now reads
  "Connecting to coop" with what to check until its script takes over, and the
  phone's saved copy answers an offline load with a "Can't reach coop" page
  instead of an empty one (cache `coop-companion-v7`).
- **Schema compare keeps identity columns.** The live read, the catalog
  snapshot and repo files now record identity columns, the script writes them
  as `bigint IDENTITY` (no seed or increment, as Fabric Warehouse takes them),
  never adds identity to another column, and an identity-only difference is a
  reported change instead of a match. A snapshot taken before this release does
  not record identity: identity is then not compared, with a note.
- **Schema compare notes stay out of saved views and procedures.** Every note
  is its own GO batch, so a deploy no longer stores coop's comments in a
  module's definition; the module's own comments stay with it.
- **Fabric Warehouse table changes use ALTER where Fabric allows it.** Adding a
  nullable column and dropping a column are written as `ALTER TABLE`; only a
  change Fabric cannot make in place (type, nullability, identity, order) gets
  a rebuild note, which now names that change instead of a blanket claim.
- **A renamed module's stale declaration is named in the notes** of both files
  when the script writes it under its catalog name.

## [0.38.2] — 2026-10-22

### Changed

- **Tool pins:** coop-sql-source-control 1.0.4 (string literals keep their
  whitespace when scripted and compared; a renamed module is scripted under its
  current name, and deploy holds back a file that still declares another),
  coop-schema-compare 0.1.4 (the bare `period` column and renamed-module fixes
  below, in the standalone CLI) and coop-data-doc 1.4.2 (warns when an sqlsc
  file's `CREATE` names another object than its file name).

### Fixed

- **An older terminal install no longer shadows the machine install.** After
  the upgrade to the machine-wide window, an account's `coop` link into an
  older `coop install` checkout kept `coop` in the terminal and that
  install's "coop" shortcuts on the old release. The account's first launch
  now removes such a link (a checkout at this version or newer is a
  developer's and stays), removes the old "coop" and "coop (window)"
  shortcuts it wrote, and points its "coop (terminal)" at the machine's coop.
  The checkout itself stays.
- **The window's first launch no longer downloads Electron.** The setup no
  longer refreshes a window runtime tree an older terminal install left in
  the profile; the package carries its own (a 150 MB download, for nothing).
- **"coop is still starting" says why.** The box shown while the first
  launch sets up the account's tools says it can take several minutes and
  that the PowerShell console on the taskbar shows each step.
- **Schema compare reads a bare `period` column.** `period bigint NULL` was
  taken for a `PERIOD FOR SYSTEM_TIME` clause and left out, so a repo-to-live
  compare proposed dropping the real column. Only the full clause is skipped
  now. A column item the reader cannot read makes that table compare as
  "compare by hand" instead of producing a drop.
- **Schema compare and renamed modules.** A view, procedure or function renamed
  with `sp_rename` keeps its old name in `sys.sql_modules`. The compare now
  reads each definition under its catalog name, so the old declared name is
  neither an `alter` nor what `deploy.sql` creates. In an sqlsc repo (a
  `sqlsc.yml` names the scripts folder), a file whose `CREATE` names another
  object than its file name is read under the file's name, with a note, rather
  than as an add of the old name and a drop of the current one.
- **`bpa_review` reads the Tabular Editor CLI 0.7 findings envelope.** TE
  0.7.1.2 prints `findings` (`code`, `ruleName`, `severity`, `object`,
  `message`) where earlier previews printed `results`; coop rejected it as an
  invalid report. Both shapes are read. The envelope's `summary` must match its
  findings, and rule errors or cut-off JSON still fail the review.

## [0.38.1] — 2026-10-21

### Changed

- **Tool pins:** coop-data-doc 1.4.1 (cached builds keep column lineage),
  coop-schema-compare 0.1.3 (the review fixes below, in the standalone CLI)
  and coop-sql-source-control 1.0.3 (its review fixes: a drop meeting an edit
  is a conflict, no migration replay when the history cannot be read, check-in
  keeps what it holds back, the deployment record inside the release
  transaction).

### Fixed

- **`sql_source script` stops when its status check fails (#414).** The status
  read that protects objects changed on both sides must exit 0 and answer
  `ok: true` with a list of changes; a failed, refused, cancelled, killed or
  unreadable status now stops with `preflight_failed` and nothing is scripted,
  where before it read as "no conflicts" and the script ran.
- **Schema compare review fixes (#415-#419), the same as coop-schema-compare
  0.1.3.** Whitespace inside a string literal or quoted name is a change again
  (#415). A module with a leading comment banner gets `CREATE OR ALTER` in
  `deploy.sql` instead of a plain `CREATE` (#416). A catalog snapshot whose
  manifest lists a missing, unreadable, out-of-folder or headerless file fails
  as `snapshot_incomplete` instead of reading as drops; the manifest's cut
  lists, unavailable reads and skipped objects come back, an object such a side
  may hold is an `unknown` change, and the result carries `complete` (#417).
  Comments and string literals no longer order modules, and a real circular
  reference goes to the manual section instead of an alphabetical guess (#418).
  `dbo`, `guest`, `sys` and `INFORMATION_SCHEMA` are never created or dropped
  (#419).

## [0.38.0] — 2026-10-21

### Added

- **coop sets SQL source control up (`sql_source init`, master plan SQ14).**
  In a client SQL repository without `sqlsc.yml`, `sql_source init` runs
  `git init` when the folder is not a repository yet, then `sqlsc init` (its dev
  target comes from the project file), after one approval; nothing is committed
  or pushed. The result names the next steps (status, script the whole dev
  database, the "baseline from dev" commit) and, when it is missing, the
  project-file line coop's commits need
  (`agent_allowed_to_commit: ["database/**"]` under `repositories.<name>`).
  `/sql-source on` and the first `sql_source status` of a session name the
  same line when it is missing.
- **Schema filters (SQ14).** `schema_compare` takes `schemas` (only these) and
  `exclude` (leave these out), applied to both sides before the diff, and
  `coop schema compare` takes `--schema` / `--exclude-schema`; `sql_source init`
  passes the same lists to `sqlsc init`, which records them in `sqlsc.yml`
  (coop-sql-source-control 1.0.2). Compare always leaves out the `sqlsc`
  schema, where SQL source control keeps its locks, unless `schemas` names it.
- **Pins:** coop-sql-source-control 1.0.1 → 1.0.2 (the schema filter, `commit`
  takes `sqlsc.yml`, `.gitattributes` and `.gitignore` along while they are new,
  text output on a cp1252 console no longer crashes; from its GitHub release,
  hash-checked) and coop-schema-compare 0.1.1 → 0.1.2 (`--schema` /
  `--exclude-schema`, from PyPI).
- **SQL source control for client SQL (`sql_source`, master plan SQ12).** coop
  now ships `coop-sqlsc` ([coop-sql-source-control](https://github.com/kabukisensei/coop-sql-source-control)
  1.0.1, pinned in the release manifest and bundled in the window package from
  its GitHub release with a hash check), switched off for every Windows
  user until `/sql-source on` inside coop (`/sql-source off`, `/sql-source` shows
  the state; remembered in `~/.coop/config`; off, the tool is not registered and
  costs no model context). Where a client SQL repository has an `sqlsc.yml`, the
  native tool drives the CLI: `status`, `diff`, `checkout`/`release` as
  `coop-agent:<user>`, `script` (dev's
  changes into the files), `get_latest` (the files onto dev; a dry run unless
  `apply=true`, which asks), `commit` (pulls the branch first, fast-forward only, then the scripted files, one
  approval per commit, only where the project file's `agent_allowed_to_commit`
  covers the sqlsc folder; never pushed; guardrails rule 4 and the `coop-workflow`
  skill name it as the one approved way to commit SQL source; it then releases
  coop's own checkouts of the committed objects, like a person's Check in) and `deploy` (one commit to dev or test; a dry run
  unless `apply=true`, which asks every time). Every database write is classified
  by the project file first: the target's real server and database must be the
  contract's dev or test entry, never protected or named like production, and
  unlabelled or conflicting counts as production, a person's. Nothing is lost
  between SSMS and the files: `script` stops on an object changed on both sides
  since the last sync and names the person's own `sqlsc` command for each side
  (coop applies neither), sqlsc keeps database-side changes out of `get_latest`,
  coop never forces, and an approved dev write that is not yet scripted is
  carried as a note into the next turn until `script` and `commit` have run.
  From the shell, `sqlsc commit`/`checkin` stay hard-blocked, `get-latest` and
  `deploy` must name `-t dev` or `-t test` and are classified the same way, and
  `unlock --force`, the edit guard and `--as` another person ask. `coop doctor`
  shows the tool's row and the switch. New `tests/sqlsc.test.mjs` (gate lane)
  and sourced-wheel tests in `tests/desktop-installer.test.mjs`.
- **coop-data-doc 1.4.0** is the pinned companion (`catalog_dependencies`,
  `config-set --from-json -`, used by the sqlsc lineage setup of row SQ13).
- **Lineage docs over a coop-sql-source-control repository** (master plan row
  SQ13). `/setup-docs` and the window's docs form point coop-data-doc at an
  sqlsc repository's scripts folder (sqlsc.yml's `folder`), from the contract's
  SQL repository or the folder coop is opened in, and on a first run check its
  object folders (Tables, Views, Stored Procedures, Functions, Triggers) and
  leave `Data/`, `Migrations/` and `Security/` unchecked. When the folder holds
  the database's own dependency list (`Dependencies.json`, from
  `sqlsc dependencies`), setup adds it to coop-data-doc's `catalog_dependencies`
  through coop-data-doc's `config-set`, so the build warns about each reference
  its parse missed; a coop-data-doc without that key is told to update instead.

- **`coop folders`**: a read-only command printing the three places coop uses
  (this machine, this client, the repository) with their real paths and what
  each holds; other rows build on it.

### Changed

- **The client folder (master plan F1; Aaron, 2026-10-20).** coop's folder
  model is three places, named the same way everywhere coop speaks: this
  machine (`%ProgramData%\coop`), this client (`%USERPROFILE%\.coop`, one
  Windows user is one client) and the repository (`<repo>\.coop`). One client
  is one folder holding all of its repositories; coop always opens in that
  client folder, finds the one project file from there and edits in whichever
  repository the task names. The record is `~/.coop/client.json`
  (`client`, `root`, `project_file`), read by the launcher
  (`Get-CoopClientRecord`, `lib/common.ps1`) and the window
  (`lib/client-folder.mjs`); it replaces `home-project.json`, which is carried
  over once at the next launch (with one line saying so) and left in place.
  One rule says where the root is (`Get-CoopClientRootFor` / `clientRootFor`,
  tested on the same fixtures): the folder the user chose, else the repository
  when the file is found above the launch folder and lists no siblings, its
  parent when it does, the launch folder when the file is in a repository
  inside it. The shortcuts open the client folder; `coop project home <folder>`
  records the folder given as the root and `coop project home` prints the
  three fields; every launch prints `Client: <client> · folder <root> ·
  project file <path>` (`Get-CoopClientLine`), and the window shows it on its
  welcome.
- **The window asks one question, once.** The project picker (the list of
  folders opened before, Browse, Forget and "open this one next time") is
  replaced by "Where is this client's code?" with one button, Choose folder...:
  the choice is recorded in `client.json` and the window opens there; a folder
  without a project file still opens, and the set-up notices offer
  `/setup-project`. File > Switch project is now File > Switch client (the
  same question, a new window on the chosen folder). The window settings'
  `projects` list and `openNextTime` are no longer read or written.

- **One install per machine (master plan F3).** The coop window installer now
  installs once for every account on the computer, under `%ProgramFiles%\coop`,
  after one administrator prompt (electron-builder `perMachine`,
  `allowElevation`; the Add/Remove Programs entry is **coop**). An older
  per-user package under `%LOCALAPPDATA%\Programs\coop` is removed by the new
  installer before it installs; every account's client under `~/.coop` is never
  touched, by install or uninstall. `scripts/machine-install.ps1` (run by the
  installer, `-Remove` by the uninstaller) writes the `coop` shim
  `%ProgramFiles%\coop\bin\coop.cmd` for every account's terminal (an
  account's own terminal install still wins), adds it to the machine PATH,
  writes the marker `resources\runtime\machine-install.json` and registers the
  "coop update" scheduled task. On a machine install the bundled first launch no
  longer writes a per-account `coop` link or shortcuts (`Test-CoopMachineInstall`
  in `lib/common.ps1`), and `coop doctor` has an install row: this machine, this
  account only, or developer clone.
- **Updates install themselves on a machine install.** The "coop update" task
  (SYSTEM, highest privileges, daily at 03:00 repeating hourly for a day, at
  logon, start when missed, only with a network, 30 minute limit) runs the new
  standalone `scripts/auto-update.ps1`: newest GitHub release, the exe whose
  SHA-256 the release's verified report names, waits while a coop from the
  package is open, `/S /allusers /D=`, state in
  `%ProgramData%\coop\update-state.json`, log in
  `%ProgramData%\coop\logs\update.log` (under 1 MB); `-DryRun` or
  `COOP_AUTO_UPDATE_DRY_RUN=1` changes nothing. Each account's next launch
  prints one line about an update that installed since its last launch, or one
  waiting (`Write-CoopUpdateLines`; the window shows it in its notices). On a
  machine install `coop update` prints "This coop updates itself (this
  machine): last checked <time>, installed <version>" and exits 0, `--check`
  lists the task's state and `--edge` is refused (exit 1). `scripts/bootstrap.ps1`
  now needs an administrator PowerShell and runs the installer with
  `/S /allusers`. The `installer (Windows)` CI job proves the per-machine
  install, the shim, PATH entry, task and the dry run, and `verify-upgrade.mjs`
  proves the per-user to per-machine upgrade; the new `machine-install`
  PowerShell fixture covers every pure part.

- **File tiers (master plan row F2, Aaron's decision of 2026-10-20).** coop's
  folder model is three fixed places, named the same way everywhere coop speaks:
  **this machine** (`%ProgramData%\coop`: the program, the standards, your name
  and preferences), **this client** (`%USERPROFILE%\.coop`, one Windows user is
  one client: sessions, memory, backups, drafts) and **the repository**
  (`<repo>\.coop`: the team's project file, client skills and prompts). No
  options; task logs stay in the repository.
  - *Standards on this machine.* The standards root is `%ProgramData%\coop\standards`
    when that folder exists and is writable (`coop sync` creates it when it can,
    without a prompt), else this client's `~/.coop/standards` as before;
    `canonical\` and `snapshots\` live under it and `COOP_STANDARDS_ROOT` still
    names the canonical checkout. New helpers in all three languages
    (`standardsLocation` / `Get-CoopStandardsLocation` / `standards_location`).
    The first launch that reads the machine copy prints one line; `coop doctor`
    names the path and the place.
  - *Backups in this client.* Backups go to `~/.coop/backups/<repository>/<path>.<timestamp>.bak`,
    never inside the repository. The launcher sets `COOP_BACKUP_DIR`; `backupDirFor`
    / `backupPathFor` in `lib/paths.mjs` put the project file's own backup there
    too (`/setup-project`, `/project-get`, the window's Project form), named
    `Backup (this client): <path>`. The contract's `backup.root` is no longer read
    (`timestamp_format` and `naming_pattern` still are); the `coop init` templates
    and the bundled `.coop/project.yml` drop it. The guardrails never ask for a
    write under this client's `backups` or `drafts` folder.
  - *Drafts in this client.* A file written for review that edits nothing in the
    repository goes to `~/.coop/drafts/<repository>/` (`COOP_DRAFTS_DIR`), named
    `Draft (this client): <path>`; the window's Changes pane lists them under
    Drafts (newest first, opened as a new file).
  - `coop doctor` gains a Folders section (this machine, this client, the
    repository, plus the standards, backups and drafts rows; a repository without
    a project file warns `/setup-project creates one`), and the window's Project
    pane shows the same rows from a new `coop:folders` RPC.
- **`coop doctor` sends a stale coop-tool pin to `coop update`.** The pipx rows
  (`coop-data-doc`, `coop-schema-compare`, the Fabric CLI) answered a version
  behind, ahead of or different from the manifest with `pipx install
  <tool>==<pin>`, while the product answer is `coop update`, which converges
  every pin at once (the Pi row already said so). The remedy now leads with
  `coop update` and keeps the pipx line in brackets for a machine without
  coop on PATH; the ownership rows (a foreign copy on PATH) keep their pipx
  hints, since a stale pin is not their problem. Found on the dev VM's pre-tag
  check of v0.37.0 (2026-10-20).

- **A launch that opens no window is never silent.** The window writes a
  launch log, `<profile>\desktop\launch.log` (this client): one line when it
  starts coop's setup console, every line that console prints with its time
  (coop's own lines are mirrored there, since the console's stdin is NUL and
  it closes at once on a failure), any PowerShell error, the console's exit
  code, and one line when that console exits with its code and whether a
  window opened. A console that exits
  without a window, with any code, now gets a message box with the console's
  last lines, the code and the log (before, a non-zero exit quit without a
  word).

- **A first launch never asks for an administrator (F3).** The ODBC Driver 18
  for SQL Server, with its VC++ runtime, is installed by the installer's own
  elevated step for every account when the machine has no Driver 18 or newer
  (`scripts/machine-install.ps1`, logged in `machine-install.log`), so the
  window's first launch in any account, a standard user's included, installs
  nothing that needs an administrator. Before, that launch raised the Windows
  administrator prompt for the driver, which a standard user's console could
  not answer: on the dev VM (2026-10-20) a second account's first launch hung
  on it for two minutes with nothing printed, then quit. If the driver is still
  missing, the first launch and `coop doctor` on a machine install say so as a
  warning naming the administrator's step (run the installer again) and go on;
  live SQL waits, everything else works. The same launch has no one at the
  console's keyboard, so it no longer reaches the profile wizard: the COOP
  profile is written with the Windows account's name and the default settings,
  the console says so with the way to change it (`coop onboard`), and the
  window's set-up card repeats it once at the next launch. A `coop install`
  at a keyboard still asks. (`onboard.py onboard --name <name> --no-sign-in`
  is what it runs: the name is the default answer, and `--no-sign-in` keeps
  that launch from starting an Azure device-code sign-in, which with no one at
  the keyboard would wait in the hidden setup console forever and keep the
  window from opening; the console says the sign-in comes later, from
  `coop onboard --config-only`.)
- **The package's tools install from a folder with a space in its path.** pip
  splits `PIP_FIND_LINKS` on whitespace, so under `C:\Program Files\coop` (the
  machine install) the wheel folder arrived as two ignored locations and every
  tool install (Fabric CLI, coop-data-doc, coop-schema-compare) failed with
  "No matching distribution"; the per-user package under `%LOCALAPPDATA%` never
  hit it. The folder now reaches pip as a `file:` URL. Found on the dev VM
  (2026-10-20) as a standard user's first launch that opened no window.
- **A first launch whose setup did not finish still opens the window** when Pi
  and Node are in place: the console and the window's set-up card say which
  tools are missing and where the lines are, and the setup runs again at the
  next launch (before, the launch stopped with no window).
- **A failed pipx install says why.** The install's "could not install
  <tool>" lines now end with pipx's or pip's error line (or its last
  line), so a standard user's first launch on a machine install names the
  path or package that failed instead of leaving it to a verbose re-run.

### Fixed

- **`coop doctor` no longer reports a working Warehouse MCP entry as
  unavailable (#409).** Its probe of `fabric-sqlendpoint` initialized with the
  2024-11-05 protocol; it now asks for 2025-06-18, as the MCP adapter does, and
  sends the negotiated `MCP-Protocol-Version` on later requests. When the probe
  still fails, the row names the first failing step (for example
  `initialize: HTTP 400` or `tools/list: JSON-RPC error -32602`), never a token
  or server text. Any 2xx answer acknowledges `notifications/initialized`, which
  gets no JSON-RPC reply.
- **A package upgrade brings every account the new tool pins (F3, B6).** The
  window's per-account setup (the first launch's install) ran once per package
  version, so a package with new pins under the same version (one build
  installed over another on the dev VM, 2026-10-20) left the account's tools at
  the old pins, and `coop update` on a machine install only reported the update
  task and changed nothing, although `coop doctor` names it as the remedy. The
  setup marker now records the package version together with a hash of its
  release manifest, so any change to the pins re-runs that account's setup at
  the next launch, and `coop update` on a machine install runs the same setup
  for the account at hand (`scripts\install.ps1 --prereqs auto`) after its one
  line about the update task. A terminal launch, which never runs that setup,
  warns "new tool pins for this coop: run coop update" while it is pending.
- **Warehouse SQL MCP reads no longer time out at a fixed 60 seconds.** The
  generated `fabric-sqlendpoint` entry pinned `requestTimeoutMs` to 60000 and
  both `coop doctor` and the guardrails refused any other value, so a longer
  read (a coop session hit it on 2026-10-20) failed and a hand edit of
  `mcp-adapter.json` was overwritten on the next launch. The timeout is now five
  minutes by default and configurable in the contract:
  `mcp.fabric_sqlendpoint.request_timeout_ms` (whole milliseconds from 1000 to
  3600000). The generator re-reads it on every `coop sync` and launch, so it
  survives regeneration; an invalid value runs on the default with a note, and
  doctor warns about it or about an entry that no longer matches the contract.
  Doctor and the guardrails accept any value in range, so an entry an earlier
  release generated with 60000 stays registered; the guardrails' read scope
  carries the entry's timeout, and a session grant covers reads up to the
  timeout it was approved for. Identity, target, production and
  mutation-approval checks are unchanged, and the native `fabric_sql_query`
  fallback keeps its own separate bound. The terminal and the window share the
  one generator, so both get it. `coop doctor` prints the timeout in force, and
  `coop sync` now shows the generator's note when it exits 0 (it was dropped
  before, so the invalid-value note never reached the console).
  Doctor's project contract rows also warn when a Warehouse target is set
  without `profile.client`, since the guardrails resolve a read scope only with
  a client (every read would ask, and a headless session is blocked).
- **`coop release` on a Mac without PowerShell 7 no longer stops at the test
  gate.** Since the guardrails change of 2026-10-07 `tests/run.sh` refuses to
  start without `pwsh` (its coop.ps1 tests cannot self-skip), so the gate died
  with "pwsh (PowerShell 7) is required" and the only way on was `--no-check`
  (v0.37.0 was cut that way). Now, when `pwsh` is missing or does not start,
  `scripts/release.sh` reads GitHub's check runs for the exact commit being
  tagged and continues only when every one is complete and green, naming CI as
  the release's test evidence; a run still in progress, a red check, no runs,
  or an unreachable GitHub still stop the release, and `--no-check` stays the
  explicit opt-out. New `tests/release-gate.test.sh` (gate lane).
- **`coop router-trial` says it was removed instead of opening a session.** An
  unknown word after `coop` goes to Pi as a message, so after the trial's
  removal (0.37.0) a scripted `coop router-trial` opened an interactive session
  and hung with no terminal (the dev VM's pre-tag check, 2026-10-20). The word
  is now a retired command, like `coop web`: one line naming the removal and
  the CHANGELOG entry, exit code 1, nothing launched. The classifier-keys
  fixture runs it and checks that no helper or dispatch to the trial remains.

## [0.37.0] — 2026-10-20

### Removed

- **`coop router-trial`, the Jev classifier trial (master plan J0).** Aaron's
  call of 2026-10-19 after the bigger trial on the dev VM: TypeSafe's Jev
  scored 100% on 200 synthetic prompts against the tightened rule's 98%, but
  the two differ only on four long briefs that Jev sends to the plan model, so
  it saves no tokens over the rule, needs a vendor key, and would need a DPA
  before any client use. The command, `lib/router-trial.mjs` and its tests are
  gone; the synthetic sets stay as fixtures for the rule's own tests
  (`tests/router-rules.test.mjs`), and `coop doctor` still warns when a
  third-party classifier key is left on a profile.

### Added

- **`coop-schema-compare` 0.1.1 is installed with coop** (master plan row SQ10,
  Aaron's ask of 2026-10-12: the schema compare for coop and for people, like
  coop-data-doc). `config/release-manifest.json` pins it under `python_tools`, so
  `coop install` and `coop update` converge it with pipx, the window package
  bundles its wheel, `coop doctor` has its rows, and the release gate checks its
  pin against the website. The native `schema_compare` tool is unchanged: it
  still runs `lib/schema_compare.py` in-process against the contract's
  `sql_targets` entries under the guardrails; the standalone command is the same
  engine for a terminal or a CI pipeline (`compare`, `snapshot`, `diff` over live
  databases, `fabric://<workspace>/<warehouse>` names, snapshot folders and repo
  folders), and either tool's snapshot folder is a side for the other.
### Changed

- **`coop/auto` picks the newest model of each family by itself.** The tiers
  were lists of exact ids (`gpt-5.6-sol` first for plan, `gpt-5.6-luna` for
  build), so a new release sat unused until someone edited the list; today's
  catalog already holds `gpt-6.1-sol` and `gpt-6-luna`. Each tier now maps to a
  family (`plan`: sol; `standard`: terra, else sol; `build`: luna, else terra)
  and resolves to the newest version the signed-in account can use, read from
  the catalog the first time a session routes and kept for the rest of that
  session, so a release never moves a running session. `/router` shows the
  version each tier resolved to and whether it was pinned; `COOP_ROUTER_MODELS`
  still pins exact ids. Aaron, 2026-10-19: "it needs to be flexible enough when
  the new version of models comes out to auto go to them".
- **`coop/auto` sends short prompts at medium thinking to the build model.**
  The dev VM's blind quality test (2026-10-19: 100 tasks, 440 sessions, two
  independent graders) scored the build model (`luna`) above the standard model
  (`terra`) on edits (5.85 against 5.17 of 6, 97% against 87% of edits passing
  the repo's tests) and level with it on lookups, at a tenth of the cost, and
  every refusal in the run (the model asked for approval and changed nothing)
  came from the standard model. The old rule started a medium-thinking edit on
  the standard model and only handed over after the first edit, so it inherited
  those refusals and most of that cost. A prompt of at most 400 characters at
  medium thinking now starts on the build model, as one at low thinking already
  did; the standard model keeps longer medium prompts, and briefs at high
  thinking stay on the plan model (the same test put `sol` well ahead of
  `terra` there).
- **`coop/auto` no longer hands a turn to the build model on the agent log
  write.** The contract asks for a daily log entry (`docs/agent/logs/daily/`)
  at the start of a turn, and that write counted as the first successful edit,
  so 3 of 40 read-only design briefs in the same test finished on the build
  model. Writes under `docs/agent/logs/` now count neither as the handoff nor
  as a failed edit.

### Fixed

- **`schema_compare`'s `deploy.sql` runs in the right order on a large release.**
  Modules were ordered per kind, so a function that reads a new view came before
  the view; two objects sharing a bare name in different schemas resolved to one
  of them; and on a Fabric Warehouse a view that selects a column the table
  rebuild adds sat in the live part of the script, where it fails until the
  person rebuilds the table. Modules are now one dependency order across kinds
  with `schema.name` resolution, and on a rebuild target anything that names a
  rebuilt column, or depends on such an object, follows the rebuild note in the
  manual section with a one-line reason. Found in a 175-change simulation over
  310 objects (Aaron's case of 2026-10-19: releases too large for Fabric's
  schema manager). A deferred module no
  longer ends with `;;` when its source definition already carries the
  semicolon (repo files do). The same fixes are in coop-schema-compare.
- **A `schema_compare` costs one tool result.** The result line now says the
  list is the whole diff and `report.md` repeats it for people, and that
  `deploy.sql` is opened only to promote, so coop stops re-reading the report
  (~700 tokens on a typical release) and the script (~2,700) after a compare
  it only had to summarize. The tool result itself is unchanged in size: about
  550 tokens for a 38-change release, capped at 12,000 characters.
- **`coop/auto` classifies the person's prompt, not coop's own note.** Pi hands
  the router its LLM-shaped messages, where the standards and team-knowledge
  note coop injects after the prompt (a custom message of a few thousand
  characters) arrives as a user message too. The router read the last user
  message, so a 27-character question went to the standard model and a
  240-character edit to the plan model, and every "standard" prompt in the dev
  VM's cost sample opened on `gpt-5.6-sol` (2026-10-19). The router now
  classifies the prompt Pi hands it in `before_agent_start`, the text the
  person typed, and falls back to the first message of the latest user turn.
- **`schema_compare` no longer lists Fabric's internal `_rsc` schema as a drop.**
  The live side read every row of `sys.schemas`, so a Warehouse's internal,
  underscore-prefixed schema that holds no user object showed up as a schema to
  drop whenever the other side was a snapshot, a repo or a Warehouse without it.
  The live side now skips such schemas the way the catalog snapshot does; an
  underscore-prefixed schema that owns a user object is still compared. Found in
  the SQ10 check on the dev Warehouse on 2026-10-19.

## [0.36.0] — 2026-10-19

### Added

- **Azure sign-in commands ask first.** A bash call to `az account get-access-token`
  (unless `--output none`), `az login`, `az logout`, `az account clear` or
  `az account set` now asks in the UI and is blocked headlessly, the same way as
  a command that prints the environment: a printed bearer token would land in the
  session transcript, and a sign-in change affects every tool on the machine.
  `az account show` and `list` pass. The Azure CLI's `service_principal_entries`
  file joins the secret-file list. Nothing coop runs itself changes: its own
  mints go through the token helper, not the agent's shell.
- **Pi's own dependency tree is pinned at install** (master plan row U3).
  `npm install -g` pins Pi alone, and Pi stopped shipping `npm-shrinkwrap.json`
  in 1.0.1, so npm resolved Pi's dependencies on the day of each install; that
  is how pi-codemode 1.2.0 broke fresh installs of the pinned Pi 1.1.0 on
  2026-10-12 while every earlier install kept working. `config/pi-lock.json`
  (`node lib/pilock.js generate`, regenerated with every Pi pin bump) is npm's
  lockfile for a one-dependency package whose dependency is the manifest's Pi.
  After Pi reaches the pin, `coop install` and `coop update` apply it
  (`node lib/pilock.js apply`: `npm ci` of the lock beside Pi, the resolved tree
  moved into Pi's `node_modules`, a marker with the lock's hash); the window
  package build applies it to the bundled prefix; `coop doctor` reports a tree
  that differs from the lock with `coop update` as the fix; the Pi matrix applies
  the lock to the Pi it installs and imports the package on the locked tree, so
  the pi-codemode break fails CI before a release. `coop update --edge` leaves
  Pi's dependencies as npm resolves them. Only the extension tree was locked
  before (`config/extensions-lock.json`).

- **`coop/auto`, a coop router over the Codex models** (master plan R1,
  opt-in). `/model coop/auto` selects a coop-owned virtual model that picks an
  OpenAI Codex model for each request by rules, never a classifier: a large
  model plans (the plan model at `high`/`xhigh` thinking or for a long prompt,
  the standard model otherwise), the first successful edit hands the rest of the
  work to the small build model, which also answers short `low` prompts and
  writes compaction summaries. A retry after a provider error, or two failed
  edits in a turn on one tier, steps the turn up one tier (build to standard,
  standard to plan), so a struggling small model hands back rather than keeps
  trying. The phase is router state on the session branch, so it follows forks and survives
  compaction. The footer shows the routed model beside the selection
  (`auto → gpt-5.6-luna`) and `/router` lists the model per tier.
  `COOP_ROUTER_MODELS` overrides a tier for a measurement run. No new vendor:
  every route lands on the `openai-codex` sign-in, and with none the request
  fails naming `/login openai-codex`. `extensions/coop-router`, loaded on Pi
  1.x; `tests/coop-router.test.mjs`.
- **`coop router-trial`, the J0 classifier trial** (master plan section 6.6,
  row 15b). Scores TypeSafe Jev and Cloudflare Clef (Pi 1.1's classifier
  providers) against the `coop/auto` routing rule on a shipped synthetic set of
  50 labelled prompts (`tests/fixtures/router-trial/prompts.jsonl`, no client
  data): accuracy per tier, agreement with the rule, errors, latency, cost and a
  verdict. Workstation only: it refuses on Windows, where every coop machine is
  a client VM, unless `--allow-windows` is passed on purpose for a machine that
  holds no client data; the keys live in that one process's environment and
  coop stores none. The
  rule itself moved to `lib/router-rules.mjs`, shared by the router extension and
  the trial. `coop doctor` now warns when a TypeSafe, Cloudflare or OpenRouter key
  or sign-in is on a profile, because client use waits on a signed DPA.

- **`schema_compare` and `coop schema compare`, the deterministic environment
  compare** (master plan row SQ10, Aaron's ask of 2026-10-12). Reads the catalog
  of two `sql_targets` entries (dev against prod by default; the committed
  catalog snapshot can be the source) over the same read-only connection path as
  `sql_impact`, and writes `.coop/schema-compare/<source>-to-<target>/report.md`,
  a sorted diff of schemas, tables and columns, views, procedures and functions,
  and `deploy.sql`, an ordered promotion script (new schemas, tables, columns,
  then functions, views and procedures as `CREATE OR ALTER` in dependency order)
  with every DROP and every change that can lose data commented out under a
  DESTRUCTIVE banner; on a Fabric Warehouse a column change is a rebuild note,
  not `ALTER TABLE`. Nothing is applied: running the script is the user's act
  through the usual write approvals. The guardrails run the compare without a
  prompt on every pair, production included (reads), audit the pair, and block
  any other input. `lib/schema_compare.py`, `tests/schema-compare.test.py`;
  the fixed-context budget moved from 7200 to 7300 tokens for the tool's
  metadata. A side can also be the repo (Aaron, 2026-10-13): `repo`,
  `repo:<name>` or `repo:<name>/<subfolder>` reads the `.sql` files of a
  contract `repositories` entry with role `sql` or `mixed` (under its
  `sql_root`) as code with no connection (`lib/sql_source.py`: a Fabric
  Warehouse Git export, a SQL database project or a hand-kept sql folder; one
  `CREATE` per `GO` batch, column types rendered as the catalog renders them,
  post-deployment scripts and `bin/` ignored and counted in the notes), so any
  pairing works: repo against repo, live against live, repo against live. A
  view, procedure or function compares with a leading comment banner,
  `OR ALTER` and a trailing `;` ignored, so a file matches the catalog's copy
  of the same object.

### Fixed

- **`coop/auto` says why a session stepped up a tier.** The R1 measurement on
  the dev VM had two sessions open on the plan model for prompts the rule
  classifies as standard, and nothing in the session said why: Pi keeps no
  record of a failed call, and the router's state only named the tier it landed
  on. The stored state now carries the model it stepped up from and the reason
  (a provider error, or two failed edits), and `/router` shows it, as in
  "planning on openai-codex/gpt-5.6-sol, stepped up from gpt-5.6-terra after a
  provider error". The next user prompt that classifies to the same tier clears
  the note, as it already cleared the failed-edit baseline.
- **The bootstrap one-liner upgrades a coop window that lives in another
  folder instead of hanging.** With a window already installed somewhere other
  than `%LOCALAPPDATA%\Programs\coop`, the silent installer sat forever on
  NSIS's "already installed" question (dev VM, 2026-10-19). `bootstrap.ps1` now
  finds the installed window through its Add/Remove entry, reports "the coop
  window is already installed in <folder>; this version goes there too", and
  hands that folder to the installer, so the upgrade lands in place; the
  already-installed and first-launch checks look there as well.
- **`coop router-trial` finds Pi 1.2.0 again.** The trial resolved the installed
  pi-coding-agent with `require.resolve`, and Pi 1.2.0's package exports carry
  only an `import` condition, so every run died with 'No "exports" main
  defined' before scoring anything (Aaron's first run on the dev VM). The entry
  now comes from Pi's own package.json (its import export, else `main`), with a
  test over every shape Pi has shipped and over the Pi installed on the machine.
- **`coop sync` links the Pi sign-in under Windows PowerShell 5.1 when Developer
  Mode is on.** 5.1's `New-Item -ItemType SymbolicLink` never asks for the
  unprivileged symlink Developer Mode allows, so it refused with "Administrator
  privilege required" even on a machine set up as the install docs say, and sync
  copied `auth.json` and `models.json` instead of linking them (a refreshed
  login then stayed behind). Sync now tries cmd's `mklink` (which does ask, as
  pwsh 7 does) before settling for the copy.
- **`coop doctor` reads a launcher's traceback.** A pipx launcher that died in a
  Python traceback had its first line quoted ("Traceback (most recent call
  last):") and was called a broken leftover launcher to delete and reinstall.
  The row now quotes the traceback's last line, the error, and when that is a
  permission error it points at the unreadable file (a config folder first made
  from an administrator window keeps the normal user out) instead of a
  reinstall that would not help. The Fabric CLI row no longer shows green with
  an empty version beside that warning.
- **coop's output is UTF-8 on a stock Windows console.** Both PowerShell editions
  wrote in the console's OEM code page, so `✓` reached the screen as `√`, `✗` and
  em-dashes as `?`, and anything reading coop's output as UTF-8 (the window, Git
  Bash, the tests) saw replacement characters. `lib/common.ps1` now switches the
  console output encoding and `$OutputEncoding` to UTF-8 when it loads.
- **`coop version` and doctor survive a Python without pipx under Windows
  PowerShell 5.1.** The `<python> -m pipx --version` probe wrote "No module named
  pipx" to stderr, which 5.1 turns into a terminating error under
  `$ErrorActionPreference = 'Stop'` even through `*> $null`; the probe now runs
  with the preference relaxed and its output discarded.
- **`scripts/check-bom.ps1` skips the window package build's staging** under
  `desktop/installer` (a gitignored snapshot plus npm's generated shims), so
  `tests/run.ps1` passes on a dev box that just built the installer.
- **`bash tests/run.sh` says when `python3` is unusable.** On a python.org
  install `python3` in Git Bash is the Store's App Execution Alias stub, and the
  suite died deep inside a test with "Python was not found"; it now stops up
  front and prints the one-line fix (a `python3.exe` beside `python.exe`, which
  the hosted CI runners have).
- **A fresh `coop install` gets a Pi that starts again: the pin moves to Pi
  1.2.0.** On 2026-10-12 `@earendil-works/pi-codemode` 1.2.0 dropped an export
  that Pi 1.1.0's codemode module imports; Pi 1.1.0 asks npm for `^1.1.0`, so a
  new install resolved 1.2.0 and every extension that imports Pi failed at
  launch with a `SyntaxError`. Installs made before that day, and the v0.35.0
  window installer, keep pi-codemode 1.1.0 and are not affected. Pi 1.2.0 ships
  with pi-codemode 1.2.0. The release manifest, the Pi matrix, the extension
  lock (`node lib/extlock.js generate`), the window's RPC fixture and the
  fixture stubs move to 1.2.0; the theme's `$schema` points at Pi's published
  `https://pi.dev/schemas/theme.schema.json`. Pi 1.2.0's compaction call and
  Codex WebSocket cache are unchanged, so both coop-tools workarounds stay;
  its `before_agent_start` now also fires for extension-triggered runs, which
  coop's two handlers already tolerate (no prompt means no standards context
  and no daily-log opt-out). Pi's own dependency tree is still resolved by npm at
  install time (Pi stopped shipping `npm-shrinkwrap.json` in 1.0.1); only the
  extension tree is locked.

- **Prerequisite rows no longer throw where `uname` is off PATH.** `coop
  install`, `coop doctor` and the coop window's first launch ask the platform
  through one helper (`Test-CoopIsMac`) that answers no instead of a
  terminating error when `uname` is not on PATH. The nightly extended lane had
  failed every day since 2026-10-04 on exactly that: the ubuntu job pins
  Python outside `/usr/bin`, so the window-package fixture's stripped PATH
  carried no `uname`.

Findings of the v0.35.0 code review:

- **Guardrails (tightened).** Git long-option abbreviations (`--amen`,
  `--har`, `--force-w`) are read as the full option; a commit on a repository
  the command cannot name (`(cd ../x && git commit)`, `git -C "$REPO"`,
  `--git-dir`, `GIT_DIR=`) asks instead of passing; `git` by path, `.exe`,
  under `nice`/`sudo`/`timeout`/`xargs`, through `bash -c`, `pwsh -Command`,
  `eval`, or a `-c alias.*=` override, and git aliases, are all seen as Git;
  `git add .` from a subfolder and `git add -f` are judged on the real paths;
  ambiguous SQL on a production or unconfirmed Warehouse takes the production
  path; `ALTER ROLE`, `CREATE USER`, `SWITCH PARTITION`, `DBCC`, `KILL` never
  ride a session approval; Azure DevOps add/link/reply/resolve/set/queue
  tools ask; the secret-file gate sees `.en''v`, `.env*`, `HEAD:.env`,
  `.git-credentials`, `gh/hosts.yml`, `.kube/config`; `\rm -rf` is `rm`;
  `az rest --meth post` is a write; printing the environment or naming the
  Fabric token variable asks. A `~` inside a `cd` or `-C` path (a Windows
  short name such as `RUNNER~1`) is literal and the target is checked; only a
  leading `~` is the shell's home.
- **Launcher.** `coop init --ci` could not run (its function was defined
  after the dispatch); `coop init --template` wrote a UTF-16 contract under
  Windows PowerShell 5.1; the daily origin fetch failed on a checkout path
  with a space, so the update nudge never saw a newer release;
  `coop uninstall <source>` called a Pi command that does not exist;
  `COOP_NO_ISOLATE=true` let the launch preflight realign the personal
  `~/.pi` tree; `coop uninstall` missed pipx tools when pipx answers only
  through `python -m pipx`; a team skill without a name printed a red error
  record every launch.
- **Native SQL helpers.** Non-ASCII names or values crashed the helpers on
  Windows (ANSI code page on a pipe) and could arrive as U+FFFD; they now
  speak UTF-8 end to end. `mcp.fabric_sqlendpoint.enabled: false` was ignored
  on machines without PyYAML; a contract with a YAML syntax error gave a
  traceback at launch; the catalog snapshot could delete a `.sql` file
  outside its folder when a committed manifest named one.
- **YAML reader.** An apostrophe inside an unquoted value (`Aaron's`) no
  longer swallows the rest of the line or a flow list; double-quoted escapes
  decode as PyYAML does. fleet-digest reads `~/.coop/config` as the JSON it is.
- **coop-tools.** The hidden lineage, Fabric-target and catalog-snapshot
  notes return after `/new`, `/resume` and `/fork`; the pre-edit lineage
  lookup is bounded (15 s) and records no "miss" when coop-data-doc failed;
  `data_doc impact` and the menu's build run beside `coop-data-doc.yml`
  (the client home repository layout); a missing coop-data-doc is reported
  as missing, not as "unsupported".
- **Project file.** Adding the first repository to a discovery-mode
  contract wrote YAML the Python readers refused; after a share whose push
  was refused, "Get the team's version" overwrote the committed edit with
  origin's older copy (it now reads as not shared); sibling and child
  repository scans follow junctions and ignore path case on Windows.
- **coop window and phone.** A yes/no whose Yes covers the rest of the
  session stays on the desk; the window attaches only files chosen in the
  picker or dropped as files; one teammate's mistyped pairing codes no
  longer lock pairing for the whole VM; team knowledge notes cannot follow
  a symlink out of the clone; Export and the phone menu fail with a message
  instead of an error; the Project pane keeps the cursor when the team
  status arrives.

### Changed

Follow-ups of the v0.35.0 code review, approved by Aaron on 2026-10-09:

- **More commands ask first.** `git branch -D` (and `-d --force`), `git stash
  drop` / `clear`, `git checkout -- <paths>` / `git checkout .`, `git restore`
  of working-tree files, `git push --delete` (and `:<branch>`), `find … -delete`
  / `-exec rm`, and `az … delete` / `purge` take the destructive-command
  approval and are blocked headlessly. Read only at the command position of a
  shell segment, so prose, quoted text and sibling commands never prompt.
- **"Never commit source" covers every commit-creating command.** `git merge`,
  `cherry-pick` and `revert` are checked against the paths the named commits
  carry (plus anything staged or added in the same command) under the same
  trusted-snapshot policy; `git am`, `commit-tree`, `--continue` / `--skip` and
  a ref the guardrail cannot list ask like an unverifiable commit, blocked
  headlessly; `--abort` / `--quit` pass.
- **`coop doctor` passes on an Azure SQL-only machine.** With
  `client.platform: azure_sql`, a missing Fabric CLI, `fabric-cicd`, Warehouse
  MCP registration and Power BI authoring tools are informational, never red;
  the managed Python runtime with pyodbc, which `sql_query` and `sql_impact`
  read Azure SQL through, is a warning with the install command when absent and
  stays red when present but broken. Fabric and `both` machines are unchanged.
- **One YAML parser.** `lib/_yaml.py` never imports PyYAML now, so a project
  file reads the same on every machine: plain `true` / `false`, `null`, integers
  and floats come back typed (YAML 1.2 core schema), quoted scalars stay text.
  `get` still prints booleans as `true` / `false` for the PowerShell callers.

### Removed

- `lib/_bpa_runner.py` and its test: no caller, and its command line had
  drifted from the live `bpa_review` tool.

---

Releases 0.35.0 and earlier: [docs/history/CHANGELOG-pre-0.36.md](docs/history/CHANGELOG-pre-0.36.md).

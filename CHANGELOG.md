# Changelog

All notable changes to coop-agent are recorded here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com); versions follow [SemVer](https://semver.org).

## [Unreleased]

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

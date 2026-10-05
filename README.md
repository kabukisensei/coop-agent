# coop — the Cooptimize terminal agent

**coop** is a branded analytics-engineering agent for Cooptimize, a worker-owned
cooperative. It is a thin **layer on top of [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)**
(`@earendil-works/pi-coding-agent`) — **not a fork**. `coop` runs `pi` against its
**own isolated agent dir** (`~/.coop/agent`) with the Cooptimize skills, prompt
templates, theme, its own splash/footer extension, and a governance system prompt,
and it shells out to the standalone Coop tool
(`coop-data-doc`) and the Microsoft Fabric CLI (`fab`). SQL and DAX standards are
applied while coop writes: the active `cooptimize/coop-standards` wiki articles go
into every SQL/DAX/semantic-model task, and coop self-checks its diff against them
before presenting a change. The stack targets Microsoft Fabric, Azure, Power BI, D365 (Finance &
Operations), T-SQL (Fabric Warehouse/Lakehouse, medallion bronze/silver/gold),
DAX, semantic models (TMDL), and data documentation.

> **Part of the coop suite.** coop-agent is the suite's hub: **`coop install`**
> sets up the standalone tool
> [coop-data-doc](https://github.com/kabukisensei/coop-data-doc) (lineage docs)
> alongside the agent, and **`coop update`** keeps everything current. It also
> works standalone (`pipx install coop-data-doc`); to run it as a CI gate, see
> [docs/ci.md](docs/ci.md). The former `coop-sql-review` / `coop-dax-review` CLIs
> were retired in ST1; their rules live in the coop-standards wiki coop writes
> against.

---

## Quick start

From a fresh clone, run the installer with its full path (it links `coop` onto your
`PATH`); after that, the bare `coop` command works:

```powershell
git clone <coop-agent-repo>; cd coop-agent
.\bin\coop.cmd install  # fresh bootstrap of the whole stack (idempotent — safe to re-run)
coop                   # launch the ready, branded Pi agent (after install + new shell)
```

> **Isolation:** `coop` runs Pi against its own agent dir (`~/.coop/agent`) via the
> `PI_CODING_AGENT_DIR` env var, so only Cooptimize's curated extensions/settings/
> theme/MCP load — your personal `pi` stays untouched. See [Isolation](#isolation)
> below.

> **Model sign-in:** a fresh interactive `coop install` finishes in a short sign-in
> screen with `/login openai-codex` prepared. Press Enter and use your
> **Cooptimize business account**. If setup ran non-interactively, the first plain
> `coop` launch prepares the same one-time sign-in automatically
> (the no-training-on-our-data terms attach to the business subscription). Details:
> [docs/onboarding.md §3.5](docs/onboarding.md#35-first-launch--sign-in-one-time).

`coop install` installs `%LOCALAPPDATA%\coop\bin\coop.cmd`, adds that directory
to the user `PATH`, and asks for a new terminal before the change appears (an
isolated install with a redirected profile keeps the launcher inside the sandbox
and leaves the user `PATH` alone). Coop is operated on Windows workstations; on a
Linux or macOS development box, `./bin/coop` forwards to `bin/coop.ps1` under
`pwsh` for the tests only (see `CONTRIBUTING.md`).

Verify everything with:

```bash
coop doctor      # checks dependencies + configuration; exits non-zero if required items are missing
```

---

## Isolation

`coop` runs Pi against its own agent dir (`~/.coop/agent`; override with
`COOP_AGENT_DIR`) via the `PI_CODING_AGENT_DIR` env var, so only Cooptimize's
curated extensions/settings/theme/MCP load — your personal `pi` (its extensions,
themes, splash) stays untouched. Your login (auth/models) is shared in from
`~/.pi/agent`; settings/extensions/MCP are isolated. Provisioned by `coop install` /
`coop sync`. Disable with `COOP_NO_ISOLATE=1` (`true`, `yes` and `on` also count).

The rest of coop's profile (`config`, `user.json`, `support/`, `standards/`) lives
next to the agent dir in `~/.coop`. `COOP_DIR` moves the whole profile: it is the
**parent** of `.coop`, so `COOP_DIR=D:\coop-profile` puts the profile at
`D:\coop-profile\.coop` and the agent dir at `D:\coop-profile\.coop\agent` unless
`COOP_AGENT_DIR` overrides it. Every coop command, script and extension reads the
same two rules (`lib/common.ps1`, `lib/coop_paths.py`, `lib/paths.mjs`).

---

## Prerequisites

`coop install` checks every prerequisite **before it installs anything**, in the
order below, and prints ✓ or ✗ for each. When a required one is missing it stops,
prints the exact command to install it, and asks you to open a new terminal and run
the install again. Until the install links `coop` onto `PATH`, that stop names the
clone's own launcher instead of `coop install` (on Windows: double-click
**Install coop.cmd** again). `coop doctor` shows the same list with the same commands.

| Order | Prerequisite | Needed | Command printed on Windows |
| --- | --- | --- | --- |
| 1 | Git | required | `winget install --id Git.Git -e` |
| 2 | Node.js 22.19 or newer (minimum read from `config/release-manifest.json`) | required | `winget install --id OpenJS.NodeJS.LTS -e` |
| 3 | Python 3.10–3.13, 3.12 recommended (the Fabric CLI cannot run on 3.14) | required | `winget install --id Python.Python.3.12 -e` |
| 4 | pipx | required | `py -3.12 -m pip install --user pipx`, then `py -3.12 -m pipx ensurepath` |
| 5 | Azure CLI (`az`) | required | `winget install --id Microsoft.AzureCLI -e` |
| 6 | ODBC Driver 18 for SQL Server | live SQL | `winget install --id Microsoft.msodbcsql.18 -e` (install also offers it after the Fabric CLI) |
| 7 | Tabular Editor CLI (`te`) | optional, BPA reviews | download from https://tabulareditor.com/product/features-and-tools/tabular-editor-cli, put `te` on `PATH`, then `te auth login` |

A machine that only has
Python 3.14 passes row 3 when its pipx can fetch a standalone Python (pipx 1.5+;
`--fetch-missing-python`, or `--fetch-python` from pipx 1.12); pipx then downloads
Python 3.12 for the Fabric CLI, and `coop install`, `coop update` and
`coop doctor --fix` all build that environment the same way. When pipx is too old
for that, the Windows row prints the admin-free repair instead of a Python install:
`python -m pip install --user --upgrade pipx`. The Windows Store Python alias does
not count as an interpreter.

- `coop install --prereqs auto` runs the printed commands for you, with their output
  visible, re-checks, and still asks you to open a new terminal.
- `coop install --no-prereqs` prints the list and continues anyway.

---

## Fresh install

### Windows

coop runs on Windows: `bin/coop.cmd` launches the PowerShell implementation
(`bin/coop.ps1`). From a clone of this repo, in PowerShell or Git Bash:

```powershell
git clone <coop-agent repo url> coop-agent
cd coop-agent
.\bin\coop.cmd install   # bootstraps pi, extensions, pipx tools, Fabric CLI, links coop onto PATH
```

From Git Bash, `./bin/coop install` forwards to the same PowerShell code.

`coop install` handles the complete bootstrap: prerequisites → Pi → Microsoft
Fabric CLI → standalone Coop tools → Power BI / Fabric authoring tools →
PATH/shortcuts → a short first-run setup → sync (the pinned Pi extensions, MCP
config, assets) and Doctor. Install, `coop update` and `coop sync` converge
through the same manifest-driven code, so a component already at its pin is left
alone. First-run setup asks only for your profile and whether to
connect to client Fabric/Power BI; Coop applies the recommended integrations. The
detailed switches remain available later with `coop onboard --config-only`.
It is idempotent; re-run it any time.

Useful flags:

- `--force` — reinstall pi tools / pipx packages even if already present
- `--no-fabric` — skip installing the Microsoft Fabric CLI (partial/diagnostic setup; a fresh machine will not pass full Doctor readiness until `fab` is installed)
- `--platform fabric|azure_sql|both` — answer the client platform question up front (the
  onboarding step asks it otherwise). The answer is saved as `client.platform` in
  `~/.coop/config`: an `azure_sql` machine defaults the Fabric MCP servers off, keeps the
  Fabric skills off unless a contract sets `fabric_skills: policy: baseline`, has `coop doctor`
  report a missing `fab` as optional rather than red, and checks the SQL token audience at
  launch instead of the Fabric one. `coop onboard --platform <value>` changes it later, and
  `coop doctor --fix` asks once on a machine that predates the setting. A repo's
  `.coop/project.yml` still wins (one teammate can serve two clients).
- `--prereqs auto` — install missing prerequisites with the printed commands, visibly, then stop and ask for a new terminal
- `--no-prereqs` — report missing prerequisites but continue anyway
- `--yes`, `-y` — assume yes for prompts

### Windows

**Teammates: follow [Install coop on Windows](docs/install-windows.md).** It is one
page: the prerequisite checklist in the order and wording the installer prints, getting
the code at the newest release, `Install coop.cmd`, and the first sign-in.

> **Why `.cmd`, not `.ps1`?** From a terminal in the clone, run
> `.\bin\coop.cmd install`. Stock Windows ships with the `Restricted` execution
> policy, under which `.\bin\coop.ps1 install` dies with *"running scripts is
> disabled on this system"*. The `.cmd` shim (and `Install coop.cmd`) bypasses the
> policy for this one invocation (nothing machine-wide changes). If you specifically
> want the bare PowerShell entry point, invoke it with an explicit bypass:
> `powershell -ExecutionPolicy Bypass -File .\bin\coop.ps1 install`

`coop install` drops a launcher at `%LOCALAPPDATA%\coop\bin\coop.cmd` and adds
`%LOCALAPPDATA%\coop\bin` to your **user `PATH` automatically**. If `coop` isn't
found yet, **open a new terminal** — the persistent PATH change only applies to
shells started after the install.

### Manual assembly

Use `coop install`. Manual assembly is unsupported because the release manifest pins the
compatible Pi, extension, npm, pipx, and MCP versions and installs them into Coop's isolated
agent directory. Bare `pi install` commands can modify your personal Pi profile and are not
equivalent to the bootstrap. See `config/release-manifest.json` when diagnosing a managed
installation.

### What `coop install` includes (turnkey)

One command (`coop install`) gets a coworker everything below. `coop doctor` then
shows anything still missing.

| Component | How it's provided |
| --- | --- |
| **Pi** | installed globally via `npm` |
| **Pi extensions** — `pi-mcp-adapter` (MCP), `pi-hermes-memory` (memory), `pi-better-openai` (plan usage limits), `pi-web-access` (web search/fetch — read-only), `@juicesharp/rpiv-ask-user-question` (structured questions), `@xl0/pi-lovely-rename` (automatic session names) | installed via `pi install` into coop's isolated agent dir (`~/.coop/agent`) |
| **Coop companion extensions** — `coop-powerline` (footer/splash/vibes), `coop-tools` (native `data_doc`/`sql_impact`/`bpa_review` + standards-in-context + workflow prompts), `coop-profile`, `coop-guardrails` (policy enforcement) | shipped in this repo, loaded at launch via `pi -e` (nothing to install) |
| **Standalone tool** — `coop-data-doc` | installed via `pipx` from PyPI |
| **`fabric-cicd`** (deployment validation) | a Python **library** (no CLI), injected into the Fabric CLI's env via `pipx inject ms-fabric-cli fabric-cicd` |
| **Microsoft Fabric CLI** (`ms-fabric-cli` → `fab`) | installed via `pipx` |
| **Power BI authoring tools** — Report Authoring CLI, Power BI Modeling MCP, and Windows-only Desktop Bridge | installed globally from manifest-pinned npm packages; Doctor requires Report Authoring and validates Modeling MCP arguments |
| **Managed MCP entries** — `fabric`, `fabric-sqlendpoint`, `powerbi-modeling-mcp`, `azure-devops`, `microsoft-learn` | generated from Coop config with release-manifest pins; npm-backed servers use `npx`. Power BI Modeling is also installed globally. `context-mode` is a native Pi extension, not MCP. |
| **Windows double-click launcher**: **coop** opens the terminal agent | created on the Start Menu and Desktop, starting in your home folder; `coop update` repairs older shortcuts. A second shortcut, **coop (window)**, appears after your first `coop desktop`. Purely additive: `coop` in any terminal is unchanged. An isolated install (`USERPROFILE` redirected at a sandbox folder) keeps its shortcuts inside that profile and leaves your user PATH alone |

**The coop window package (master plan D1c, D1d).** Every release carries an
unsigned, per-user Windows installer of the window with coop inside: the
pinned Node, Pi and extension tree (`resources\runtime`) and a snapshot of
this repository (`resources\coop`), so a teammate needs the one download and
no terminal install, Node or Pi; the first launch runs `coop install` in its
console (the prerequisite checklist, the tools, the sign-ins) and `coop sync`
seeds the extension tree from the bundle. It is the installer of the window
(`coop-window-<version>-win-x64.exe` under the release's assets; teammates
download it from the [newest release](https://github.com/kabukisensei/coop-agent/releases/latest),
see `docs/install-windows.md` step 6). CI builds the same installer on every PR
(the `coop-window-installer` artifact of the `installer (Windows)` job).
It installs under `%LOCALAPPDATA%\Programs\coop` with no administrator prompt,
adds a **coop (window)** shortcut to the Start Menu and Desktop and an Add/Remove
Programs entry, and keeps the window's data (`~/.coop/desktop/data`) on
uninstall. SmartScreen shows "unknown publisher" once (one click; signing is
D1f, optional). Its shortcut asks for a folder, then runs the bundled
`coop desktop --app <its exe>` in a console, so the window gets the same launch
checks, spec and token as `coop desktop`. The bundled coop finds its runtime by
location (`resources\runtime\coop-runtime.json` next to `resources\coop`): it
puts the bundled Node and the npm prefix holding Pi first on its `PATH`, so a
terminal `coop` installed later and the package never fight over Pi. The first
launch runs `scripts\install.ps1` in that console (Git, Python, pipx, the Azure
CLI and ODBC are still prerequisites; Node is not) and stops with the exact
lines to fix if anything is missing; `coop sync` then copies the bundled
extension tree into `~/.coop/agent` instead of downloading it. `coop doctor`
names the bundled versions on its coop window row. On a machine that already
has the terminal coop, the package shares `~/.coop` (settings, sign-ins,
sessions) and leaves the `coop` command and the "coop" shortcut with that
install (`Test-CoopForeignLauncherLink`); the two should stay at the same
release, since they share one extension lock. Without a terminal install, the
first launch writes the `coop` command and the "coop" shortcut for the package,
and uninstalling the window removes them again (`scripts/window-uninstall.ps1`,
run by the uninstaller; a terminal install's own stay). Updates with D1e; until then
install the newer exe over the old one. Build it yourself with `npm ci` in
`desktop/installer` and `node desktop/scripts/build-installer.mjs` on Windows
(it downloads the pinned Node zip, checks its SHA-256, drops the zip's
`npm.ps1` and `npx.ps1` so PowerShell's `& npm` reaches `npm.cmd`, stages Pi,
the extension tree and the repository snapshot under `desktop/installer/`, and
prunes the two npm trees of type declarations, `dist-types` folders and source
maps, which nothing runs and which held the only paths over Windows' limit;
`--stage-only` stops before electron-builder).

**Inside the window.** A fresh machine's set-up (model sign-in, `coop onboard`,
`az login`) is one card on the empty screen with an Open in terminal button per
item; the first launch opens the Start menu; approvals show the command or SQL as
code with No as the default; `ask_user_question` questions are cards; three
example prompts fill the composer; a Windows notification and taskbar flash
arrive when coop finishes or asks while the window is in the background
(Settings); and a File, Edit, View, Session and Help menu bar carries every
window action (View > Menu bar hides it, Alt shows it). `desktop/PARITY.md` maps
all of it to the terminal.

> `pi-powerline-footer` is **not** used. coop renders its own footer and splash via
> `extensions/coop-powerline` (see [Footer & splash](#footer--splash)).

**Not auto-installed (optional, external):**

- **Tabular Editor CLI (`te`)** — the cross-platform Tabular Editor CLI (no `npm`/`pip`
  package). Install it yourself, run `te auth login` once, and set
  `tools.tabular_editor_cli.executable_path` in `.coop/project.yml` if you want
  semantic-model BPA. coop works without it.
- **Azure CLI** (`az`) is a prerequisite, not something `coop install` installs:
  install it with the command in [Prerequisites](#prerequisites).

---

## Commands

Anything after `coop` that is not a known subcommand is passed straight to Pi
(e.g. `coop -c` resumes the last session; `coop @notes.md "review this"`).

| Command | Description |
| --- | --- |
| `coop` | Launch the branded Pi agent (skills, prompts, theme, guardrails, splash) |
| `coop desktop [folder]` | Open coop in a window on a folder (default: the current one): the same Pi, arguments, guardrails and approvals as `coop`, drawn as a modern UI with four themes (Modern and Retro, dark and light). The first run installs the window's runtime (Electron and pdf.js, about 150 MB to download and 400 MB on disk, pinned in the release manifest, into `~/.coop/desktop`) and adds a **coop (window)** shortcut; `coop sync` keeps it current. Anything only the terminal can show opens the same session in a terminal. A side pane (Ctrl+\\) shows the changes since the last commit, the standards coop applies together with the team knowledge clones (`cooptimize/incremental-bi` and the TeamAI team share `cooptimize/coop-team-knowledge`, one note at a time), a form for `.coop/project.yml` and the docs setup with Build; the sidebar and panes resize by dragging. The paperclip, Ctrl+V or drag and drop attach images, text files, Word, Excel, PowerPoint and PDF files (documents are read to Markdown and referenced by path, so coop reads them through its guarded read tool). The thinking and tool calls between coop's replies fold into one expandable line (Ctrl+O keeps them open); nothing leaves the session log. Master plan D1b and D1b2; the parity checklist is `desktop/PARITY.md`. `--app <exe>` opens the window in the installed **coop window package** instead of the runtime tree (the package passes it itself; see below) |
| `coop doctor [--fix] [--json] [--publish]` | Check dependencies/configuration; optionally apply safe fixes, emit JSON, or publish a fleet snapshot to `fleet.publish_dir` |
| `coop update [--check] [--edge] [--yes] [--no-fabric]` | Move coop-agent to the newest release tag (never backwards), converge tools to that release's manifest, and run Doctor. `--edge` is the maintainer channel: head of `main` plus latest upstream; `--check` fetches origin, then reports what the update would do and changes nothing; `--pi-latest` is a deprecated alias of `--edge` |
| `coop support [--json] [--incident] [--export PATH]` | Offline Support Center: sanitized diagnostics, incident timeline, preview/export, and standards status; works without Pi/model availability |
| `coop onboard [--edit|--config-only|--reset|--json]` | Configure profile and managed integrations without launching the agent |
| `coop profile [--edit|--reset|--json]` | Inspect or update the private user profile |
| `coop context-budget [--json]` | Inspect the active model/context budget |
| `coop teamai <status\|install\|init\|pull\|skills\|maintenance\|recall --query <text>\|compare --query <text>\|contribute --file <draft.md> [--title <text>] [--approve]>` | TeamAI shared-knowledge trial (master plan K1, K2, K3): the pinned `teamai-cli` isolated under `~/.coop/teamai`, explicit and bounded, one JSON document per call; `contribute` previews, and stages a review branch only with `--approve`; `skills`, `maintenance` and `compare` are read-only lifecycle views; off until `knowledge.teamai.enabled` is true |
| `coop uninstall [--keep-tools] [--yes]` | Remove the launcher/shortcuts/user-PATH entry and isolated agent dir; by default also uninstall Pi, pipx tools/Fabric CLI, Power BI Report Authoring CLI, Power BI Modeling MCP, and the Windows Desktop Bridge. `--keep-tools` preserves all managed npm/pipx tools. Never touches repo clones, work repos, the rest of `~/.coop`, or personal `~/.pi/agent` |
| `coop install [--edge] [--force] [--yes] [--prereqs auto] [--no-prereqs] [--no-fabric] [--platform fabric\|azure_sql\|both]` | Fresh-install/bootstrap (idempotent). Normal mode uses manifest pins; `--edge` deliberately takes upstream latest and is tools-only here (install never moves the repo). With a source arg, alias of `coop add` |
| `coop bootstrap` | Same bootstrap as bare `coop install` |
| `coop sync` | Ensure core Pi extensions are installed, place the governed MCP config non-destructively, refresh managed catalogs/team knowledge, and verify brand assets |
| `coop data-doc [args]` | Run `coop-data-doc` (default: `build`) and summarize outputs |
| `coop fabric [args]` | Pass through to the Microsoft Fabric CLI (`fab`) |
| `coop version` | Print `coop` + `pi` versions; a git checkout adds its `git describe` (for example `coop 0.23.5 (v0.23.5-21-gdf91630)`) |
| `coop help` | Show usage |
| **Authoring** | |
| `coop init [dir] [--seed-docs] [--template] [--ci github|ado] [--yes]` | Guided minimal project-contract wizard (default `.`); `--template` explicitly selects the full legacy template and `--seed-docs` generates/patches `coop-data-doc.yml` |
| `coop new-skill <name>` | Scaffold `skills/<name>/SKILL.md` |
| `coop new-prompt <name>` | Scaffold `prompts/<name>.md` |
| `coop release [patch\|minor\|major] [--yes] [--no-push] [--no-check]` | Cut a release — bump version, roll CHANGELOG, commit + tag, then push `main` and the tag atomically (default `patch`). Runs only on `main` at `origin/main`. Build-checks the extensions first (skip with `--no-check`); `--no-push` tags locally only; `--yes` skips the confirm |
| **Pi management (aliased under coop)** | |
| `coop list` | List installed Pi extensions (`pi list`) |
| `coop config` | Open Pi's resource TUI (`pi config`) |
| `coop add <source>` | Install a Pi extension (`pi install <source>`) |
| `coop remove <source>` | Remove a Pi extension (`pi remove <source>`) |
| `coop pi <args...>` | Raw escape hatch to `pi` |

`coop data-doc` **flows straight through** to `coop-data-doc` — every subcommand
(`check`, `upgrade`, the full `coop-data-doc setup` wizard, …) and the tool's own
interactive prompts work, and the exit code propagates. The AI agent gets
machine-readable JSON through the native `data_doc` / `bpa_review` tools (in
`extensions/coop-tools`), independent of this passthrough command — including
`data_doc`'s `lineage` command (see [Lineage-grounded edits](#lineage-grounded-edits)).
There is no `coop review` command: SQL/DAX standards are applied in the agent while
it writes, and it self-checks its diff against them before presenting a change.

The **first interactive launch** on a machine opens the **Start Here menu** of the
seven common workflows (check SQL/DAX/a model against the standards, trace the
impact of a change, fix or edit an object on dev with approval, document a
warehouse or semantic model, start a client project, write today's log or a
handoff, sign in or check health), each wired to a prompt, skill or wizard coop
already ships. Press Esc or pick *Something else* to get the plain prompt; every
later launch starts at the prompt, and **`/start`** opens the same menu any time.
A plain `coop` never runs the onboarding wizard and nothing in setup can stop the
launch: the name coop calls you by is asked by *Start a client project* while no
profile exists (or by `coop onboard`), and the client tenant lives in the project
contract. `coop install` still asks the profile and integration questions on an
interactive install.

For **`coop-data-doc` setup**, coop offers an **on-demand in-agent** path so you
don't have to drop to a shell: run **`/setup-docs`** or choose *Document a
warehouse or semantic model* from `/start` when you are ready. Coop does not launch this wizard automatically
during startup. The command runs (or re-runs) the full native `coop-data-doc`
wizard through a strict JSONL bridge; it is the same questionnaire used by
`coop data-doc setup`. Older tool versions stop with upgrade guidance rather than a reduced fallback. See
[`extensions/coop-tools/README.md`](extensions/coop-tools/README.md#data-doc-setup-setup-docs).

Project configuration has the same no-shell path: run **`/setup-project`** or
choose **Start a client project** from `/start`. The wizard creates a
missing `.coop/project.yml` or safely edits the nearest existing one, covering
client details, whatever repositories are available, Fabric/Power BI workspaces,
and Tabular Editor. A repository is not required: the wizard can start an engagement
in discovery mode, record SQL-only or Power-BI-only coverage, and add sources later.
Edits make a backup and preserve comments, custom policies, and fields the wizard
does not own. After an edit, run `/new` (or restart Coop) so the guardrails take a fresh trusted
snapshot of the contract. From a shell, `coop init` creates a new contract.

---

## ⚠️ The `fab` collision — Microsoft Fabric CLI vs. Python Fabric's `fab`

`coop install` installs **`ms-fabric-cli`**, which provides the **Microsoft Fabric
CLI** as the `fab` command. The Python package **`fabric`** (Paramiko / Invoke SSH
automation) ships a **different** `fab`. If both are present, `fab` may resolve to
the wrong one.

**`coop doctor` detects this** by checking `fab --version` for `paramiko`/`invoke`
and reports it as an error:

```
✗ fab is the WRONG tool — this 'fab' is Python Fabric (SSH automation),
  not the Microsoft Fabric CLI
```

**Fix:** uninstall the Python `fabric` package however it was installed (for
example `pipx uninstall fabric` or `pip uninstall fabric`), or put pipx's bin
directory ahead of it on `PATH` (`pipx ensurepath`, then a new terminal), and
re-verify:

```powershell
fab --version                # should be the Microsoft Fabric CLI
```

---

## Managed MCP integrations (optional)

Coop can generate five managed entries through `pi-mcp-adapter`. They are **read-only
first**, not read-only-only, and all are optional.

| Server | Provides | Enablement and policy |
| --- | --- | --- |
| `fabric` | Manifest-pinned Microsoft Fabric MCP | follows the active Azure CLI login (az's default account; coop cannot set its tenant); metadata reads by default, mutations approval-gated |
| `fabric-sqlendpoint` | Microsoft-managed Fabric SQL endpoint over direct Streamable HTTP with a launch-time Azure CLI bearer token | every call approval-gated; valid project IDs select an item-scoped endpoint; with no explicit target, global; malformed explicit targets fail closed |
| `powerbi-modeling-mcp` | Microsoft Power BI Modeling MCP with `--start --readwrite --accept-eula` | no tenant/workspace required; reads run, edits ask (an approval can cover the session), deletes, imports, deploys and production always ask |
| `azure-devops` | Manifest-pinned Azure DevOps MCP for one organization | requires enabled toggle + valid organization; mutations approval-gated |
| `microsoft-learn` | `learn.microsoft.com/api/mcp` | requires only its enabled toggle; always-current Microsoft docs |

`powerbi-mcp-server` (the former `powerbi` entry) is retired: it silently ignores
`--readonly` and exposes `refresh_dataset`, a write
([#93](https://github.com/kabukisensei/coop-agent/issues/93)). `coop sync` removes the
entry it generated; an entry you added yourself stays, and `coop doctor` warns about it.

`coop onboard` writes versioned `~/.coop/config`; `coop sync` deterministically generates
COOP-managed entries in `~/.coop/agent/mcp-adapter.json` while preserving unmarked user-owned
servers. Generated config stores no OAuth token. The Azure DevOps MCP organization lives
in `~/.coop/config`; batch digest client/project/team/recipient records live separately in
private `~/.coop/devops/clients.yml`.

**Approval boundary.** Dev/test metadata reads proceed by default. Row reads, production
access, mutation-looking MCP actions, and **every Warehouse SQL call** require explicit
approval; approval-required calls fail closed when no UI is available. Warehouse SQL is
classified as `row-data` or `ddl-dml-destructive`: one bounded `SELECT` on the resolved
**dev** target runs without a prompt, bounded reads on test/production targets still ask,
and DDL/DML, permissions, `SELECT … INTO`, and `COPY INTO` receive mutation-specific
confirmation. Audit entries record the tool/risk decision, never raw SQL or arguments.
Central `mcp` and dynamic `mcp__fabric_sqlendpoint` calls share the same verified
bounded SQL grant: approve once, then approve again only for an expanded scope.
Mutations and calls outside the verified grant remain separately gated.

**Warehouse targeting and auth.** Set machine enablement with
`integrations.fabric_sql_endpoint`; an absent canonical flag inherits the legacy Fabric
setting. A project may disable it with `mcp.fabric_sqlendpoint.enabled: false`. Complete
Warehouse IDs create an item-scoped URL; Lakehouse projects must use
`sqlEndpointProperties.id`, not the Lakehouse item ID. With no explicit target Coop uses
the global endpoint. A malformed explicit target fails closed and emits no entry. Runtime
uses a bearer token acquired from the existing Azure CLI login only for the Pi child
environment; no token is written to `mcp-adapter.json`, argv, or disk. The token is minted for
the client tenant when one is configured (the same tenant as the Azure sign-in below),
and every request and `fabric_sql_query` token is pinned to that token's tenant, so a
guest whose az default account is their home tenant still works. Doctor never initiates
login and performs only a bounded metadata initialization and `tools/list` probe; its
row names the tenant the probe minted for.

Warehouse Doctor states are exact: `registered` (target/auth/tool proof passed),
`auth_required` (no usable existing token), `tool_missing` (no compatible SQL tool),
`target_invalid` (malformed or mismatched target), and `unavailable` (missing config,
network/protocol failure, or unusable response). Other MCP checks are primarily
presence/config checks; Power BI Modeling also verifies `--start` and reports read-write or read-only mode.

**Azure sign-in.** Each launch (`coop`) checks that the Azure CLI can mint
the Fabric and Power BI tokens for the client tenant: the project's
`fabric.tenant_id`, else `~/.coop/config` `azure.tenant_id`. In an interactive console
an authentication failure opens `az login --tenant <id> --allow-no-subscriptions`
once, with no question and a 5-minute limit. Any failure prints one line with the
exact command, and the launch continues. A success is cached for 30 minutes. `coop
doctor` has a matching **Azure sign-in** row (signed in to tenant X / not signed in,
with the command / no client tenant configured). The row only probes: doctor never
signs in. `COOP_SKIP_AZ=1` skips both. Details: [docs/onboarding.md](docs/onboarding.md#azure-sign-in-at-launch).

For live estate discovery, Coop labels repo versus live evidence and reports drift. Actual
row reads ask first; production row reads require a bounded target, columns, filters, and
row limit.

> **Supply-chain note:** generated npm-backed servers use exact versions from
> `config/release-manifest.json`. Review Coop release updates before enabling them in
> locked-down environments.

---

## Azure DevOps Boards (optional)

For teams that track work in Azure DevOps Boards, coop ships an optional
integration — nothing loads or runs unless you configure it.

- **In-session** — the auto-loaded **`azure-devops`** skill
  ([`skills/azure-devops/SKILL.md`](skills/azure-devops/SKILL.md)) answers
  "what's stale/unassigned for `<team>`?", creates and updates work items
  (**confirm-first** — coop-guardrails flags any work-item write), and runs the
  weekly per-client digest. It uses the Entra-authenticated REST API, plus the
  optional read-only-first `azure-devops` MCP entry generated from `~/.coop/config`; writes require approval.
- **Batch entry points** — PowerShell launchers over a stdlib-only Python core:
  - `scripts/ado-digest.ps1` — a read-only, per-client
    watchdog digest (open / stale / unassigned) with Markdown/HTML output and
    optional Graph email (schedulable, e.g. from a Windows VM's Task Scheduler —
    see the skill).
  - `scripts/ado-onboard.ps1` — guided, read-only
    client discovery that writes only the local config.
- **Config** — the MCP organization lives in `~/.coop/config`. Batch digest/onboarding
  records (projects, teams, people, recipients, and per-client auth) live in private
  `~/.coop/devops/clients.yml`, seeded from
  [`config/devops.clients.example.yml`](config/devops.clients.example.yml). Never
  commit real client values.

Full guide, auth model, and scheduling:
[`skills/azure-devops/SKILL.md`](skills/azure-devops/SKILL.md).

---

## Workflow & guardrails

coop operates **read-only first** and **review-first**: nothing leaves its hands
without a human at Cooptimize approving it. The full governance prompt lives in
[`docs/guardrails.md`](docs/guardrails.md) and is appended to Pi's system prompt at
launch.

**Guardrails (non-negotiable):**

1. Read-only by default — prefer reading, listing, inspecting.
2. Plan before you edit — present a PLAN and get explicit approval first.
3. Back up before editing — timestamped backup of every file to be changed.
4. **Never commit source** — never commit SQL, DAX, semantic model, report,
   Python, or notebook source. Make the edit, show the diff, let a human commit.
   Only docs / logs / diagrams / glossary / site may be committed, after approval.
5. Dev/test metadata/schema/code is read-only by default; actual rows and all production access ask first.
6. No production changes without explicit, specific confirmation.
7. Managed integrations are read-only first; mutation and Warehouse SQL calls are approval-gated.
8. Never expose secrets.

**Audit trail.** Every guardrail decision the runtime `coop-guardrails` extension makes —
a blocked source commit, or a confirmed/declined destructive command, secret-file access,
live row/production read, or mutating MCP call — is appended as one JSON line to
`$PI_CODING_AGENT_DIR/guardrails-audit.jsonl` (default `~/.coop/agent/…`). Each line records
the timestamp, working folder, kind, decision, and the offending path(s) or a fixed
command classification. Command text and arguments are not persisted; the secret gate
logs only the matched path, never file contents. Enforcement exceptions, including a
throwing approval dialog, block the affected tool call with a fixed reason that excludes
exception details. Optional audit/display failures do not change an enforcement decision.
Run `/coop-guardrails` in a session to see the last ~10 decisions and the log path; the log
rolls to `.jsonl.1` past ~1 MB. It's the reviewable record of "the agent tried X; a human
said yes/no" — useful for client trust and for debugging a guardrail false positive.
Older command-bearing records are displayed without their command details. Their stored
bytes are not rewritten or deleted; existing audit files may still contain historical
command text and should not be shared as sanitized exports.

**The Cooptimize workflow** (the `coop-workflow` skill — see
[`skills/coop-workflow/SKILL.md`](skills/coop-workflow/SKILL.md)):

1. Read `.coop/project.yml` and use COOP's resolved standards task authority, including any deliberate project override.
2. Locate the repo/object and assess upstream/downstream impact; `git status` && `git pull`.
3. Read the target file(s) + look up the object's upstream/downstream via the `data_doc` tool (`command="lineage"`) before touching it; use the Microsoft Learn MCP for current docs.
4. Write a short **PLAN** and get explicit approval **before** any edit.
5. Create a timestamped backup of every file to be changed.
6. Make the smallest safe edit; T-SQL coop writes or reformats follows the `sql-formatting` skill (the Cooptimize layout).
7. Self-check: before presenting SQL, DAX, or model changes, check the diff against the same standards articles used to write them; fix what does not meet them, and deviate only on a user exception or a stated reason (plus Tabular Editor BPA / `fabric-cicd` validate where relevant).
8. Show `git diff` and summarize the change.
9. Update Markdown docs / glossary / lineage; regenerate the site if docs changed.
10. If `logging.require_task_log` is enabled, use `daily-logger` and append to the
    configured daily log before the final response.
11. Commit docs/logs/site **only with approval**; never commit source.

On non-trivial work the skill adds a few habits — vertical slices, codifying
repeated corrections, and applying review feedback as Markdown annotations — with
four prompts to drive them: **`/spec-first`** (an approved spec before editing),
**`/annotate`** (apply only annotated changes), **`/handoff`** (a resume-cold
summary), and the **`git-helper`** skill / **`/pr-description`** (draft a commit
message + PR description from the diff — drafts only, never commits).

The source of truth for repo paths, workspaces, backup/log rules, and approval policy
is `.coop/project.yml`. It may provide deliberate project standards overrides;
otherwise COOP's resolved standards task authority is authoritative. Run
**`/setup-project`** inside Coop or `coop init` in the project directory. Use
`coop init --template` only when you intentionally want the full legacy template.

Fabric projects may use two workspaces per environment. Record Warehouse/Lakehouse
DEV/TEST/PROD workspaces in `fabric.environment_names` and semantic-model
DEV/TEST/PROD workspaces in `power_bi.environment_names`; keep both default workspace
entries pointed at DEV. Coop install and update refresh the bundled template but do
not overwrite an existing client's `.coop/project.yml`.

`logging.require_task_log: true` makes that log step a completion postcondition for
meaningful project work. Coop injects the requirement every turn and warns if a
settled task made changes or ran substantive review/validation without updating
today's configured log. Ordinary read-only Q&A/status checks are excluded, and a
user can explicitly opt out for a particular task. The flag authorizes the log
append, not a commit or push.

---

## Standards resolution

Coop resolves five governed domains: SQL, DAX, semantic model, Fabric, and
documentation. Precedence is **project/client override → verified canonical generation →
stale last-known-good → bundled copy → unavailable**. The bundled copy is the wiki's
active articles as shipped with this coop release (`config/standards-bundle/`, refreshed
at every release), so a first run or an offline machine still works to the standards;
coop says when it is using it. A project override is the effective authority when
configured; Coop does not silently claim it is canonical.

Launch performs a bounded, fail-soft refresh. Each task receives an immutable standards
snapshot (one content-addressed file per domain; its hash is the resolution identity),
and the self-check reads the same snapshot so the rules coop writes to and the rules it
checks against cannot drift mid-task. Provenance or integrity failures reject a candidate rather
than partially applying it. Run **`/standards-status`** to inspect effective authority,
generation, freshness, and degraded state. `config/standards-registry.json` names the
canonical repository and branch. `coop doctor` reports without refreshing: on an install
last launched more than 15 minutes ago its sync row reads `stale @ last checked N min
ago` and the cached standards stay green as last known good; only a refresh that failed
(`failed`, with the reason) turns them into warnings. `coop sync` refreshes now.

The canonical standards are the `cooptimize/coop-standards` wiki, read the way the team
reads it: every Markdown article whose front matter has `status: active` (under `SQL/`,
`Power BI/`, `Technology/`, and any new folder). Coop does not read the repo's assembled
files for older clients (`standards.yml`, `standards/*.md`) or anything under
`deprecation/`. Articles map to Coop's domains by front matter: `domain: sql` is SQL;
`domain: powerbi` is DAX when `artifact` is `dax_expression` or `measure`, and semantic
model otherwise; any other domain keeps its own name, so a new one resolves without a Coop
release. When you write or change SQL, DAX, a model, or a report, Coop injects the domain's
general articles (layer and technology `agnostic`, such as SQL Conventions) plus the articles
whose layer, artifact, technology, or title match the task, each with its path, SHA-256, and
the repo revision. A domain with fewer than three articles (today DAX) gets all of them.

Two layers pick the domains. A keyword classifier reads the prompt. SQL wording (a Fabric
warehouse, silver or gold objects, `dim.`/`fact.` names, a sproc) outranks "fact table" or
"dimension table", so gold SQL work does not get the Power BI table articles unless the
prompt also names Power BI, DAX, a semantic or tabular model, a dataset, a visual, a sort
by, a model or a measure ("Create the gold fact table for budgets and add a Budget Amount
measure"). A bare "model" is not Power BI context for measures ("the churn model", "the
business model canvas"), and neither is a template placeholder (`[Project Name]`), a visual
for slides or a visual merchandising role; a measure table needs a model, other measures
or Power BI context, and a web domain before "views" (`example.com views`) is not SQL.
"Format strings" count as Power BI context, so "fix the format strings on the
currency measures" gets the DAX articles; "relate", "related" and "relating" match the
relationship articles; "proc" and "sproc" match Gold Stored Procedures; and a prompt that
names an object in a layer's schema (`silver.custtable`) ranks that layer's overview
articles (artifact `agnostic`, such as Silver Layer) ahead of the layer's other articles.
Report work is a Power BI report, report pages, a report theme, PBIX/PBIP/PBIR,
drill-through, a Power BI app, or a theme, visual, card, slicer, bookmark or tooltip near
"report".

Under the classifier sits a recall floor read from the wiki's own front matter: a request
that names a layer the articles carry (`silver`, `gold`, `report`) or both words of a
multi-word technology (`fabric` and `warehouse`) gets that domain even when the classifier
misses it ("Review this SP for gold", "Add a new page to the Inventory report with a
card"). A missed standard on real coding work costs more than extra context on chatter, so
the floor gives way only in a short list of known non-coding contexts, and only when the
prompt has no SQL, DAX, Power BI or Fabric signal: a status, progress, incident, expense or
annual report; a report generator, button, viewer or form in app code; gold or silver
badges, medals, sponsors, tiers or colors; README, website, newsletter and marketing-site
wording. Subtotals, a page added to a Power BI report and naming conventions count as a
signal ("Add a Marketing page to the Sales report", "Update the README with the silver and
gold naming conventions"), and a title-case report name ("the Project Status report") is a
report, not a status document. Everyday prompts outside that list that say "report",
"silver", "gold" or "fabric ... warehouse" ("Review the quarterly report with the client",
"Fix the silver merge conflict in the gold branch") still get those articles. A PBIX,
PBIP or PBIR in the prompt is a Power BI file, so those prompts reach Power BI File Types.
Still missed: "chart" does not reach Power BI
Report Visuals, a named model with no Power BI word ("Add a YTD measure to the Finance
model") gets no DAX articles, and a bare "proc" with no layer word ("Fix the proc that
loads customers") gets nothing. `tests/standards-golden.test.mjs` scores a 52-prompt golden
set, holdout rows, everyday negatives and floor-chatter rows, and fails if a row loses a
domain that `main` selected before #101, except three SQL fact and dimension table rows
that deliberately drop the Power BI model.

When no article in a selected domain matches the task, Coop injects the domain's
core-layer articles (for example `layer: semantic_model`), or only a list of the domain's
articles if it has no such layer. Two articles with the same `id` are both kept, and `coop doctor` warns with
both paths. Each domain's selected articles are also written as one content-addressed
domain snapshot in Coop's own storage, which is what the self-check reads.

A project override is one Markdown file per domain in `.coop/project.yml`
(`standards.<domain>.path`; the older `standards.<domain>: <file>` form still works).

---

## Standalone tools

coop wraps one standalone pipx tool and exposes three native LLM tools: `data_doc`,
`sql_impact` (live catalog impact trace of one SQL object on the contract's dev/test
`sql_targets` entry) and the optional, config-driven `bpa_review` (Tabular Editor BPA,
the deterministic model check). `sql_impact` and `bpa_review` are read-only;
`data_doc build` writes generated documentation. SQL and DAX standards need no tool:
they are applied while coop writes and self-checked before it presents a change.

- **`coop-data-doc`** — progressive SQL and/or Power BI documentation, lineage, and machine-readable
  output. `scan` → `graph.json`; `build` → `manifest.json` + Markdown docs + a
  portal site; `lineage <object>` → one object's upstream/downstream + relationships
  as JSON. Other verbs: `check`, `init`, `setup`, `update`, `upgrade`. coop consumes
  these natively through the `data_doc` tool (including `command="lineage"`) — see
  [Lineage-grounded edits](#lineage-grounded-edits) below.

`coop-sql-review` and `coop-dax-review` were retired in ST1 (their repos are archived);
`coop uninstall` still removes their old pipx venvs when it finds them.

Also available: **`fabric-cicd`** — a Python **library** (no CLI). coop installs it via
`pipx inject ms-fabric-cli fabric-cicd` so `fabric_cicd` is importable in the Fabric
CLI's environment; it's used in deployment scripts (`import fabric_cicd`, validate-only
by default), **not** as a `fabric-cicd` command. `coop doctor` checks it's importable.
There is also an optional, path-configured **Tabular Editor CLI** (set
`tools.tabular_editor_cli.executable_path` in `.coop/project.yml`).

---

## Lineage-grounded edits

coop uses `coop-data-doc`'s lineage **natively**, so it understands up/downstream
impact before it touches an object — without you running anything by hand:

- **Auto-detect.** When you launch `coop` in a folder that has **built**
  `coop-data-doc` outputs (`graph.json` / `manifest.json` / per-object Markdown under
  the configured output dir), `coop-tools` quietly tells the agent the docs are
  available (agent-visible, hidden from the chat) so it consults them first.
- **Look up lineage.** Before analyzing or changing any SQL object, DAX measure, or
  semantic model, the agent calls the `data_doc` tool with `command="lineage"`,
  `object="<name>"` (optionally a `depth`), which returns that object's upstream
  inputs, downstream dependents, and relationships — it reads the focused
  per-object doc rather than re-deriving lineage by hand.
- **Check what a change feeds.** Before presenting an edit to SQL, DAX or model
  source, the agent calls `data_doc` with `command="impact"` and the changed files,
  and lists every downstream object they feed (also the PR description's
  **Lineage impact**).
- **Degrade gracefully.** If the folder has **no** `coop-data-doc.yml` or no built
  graph, lineage is silent and optional — the agent proceeds without it and may
  suggest **`/setup-docs`**. The docs are an aid, not a gate.

This policy lives in [`docs/guardrails.md`](docs/guardrails.md) (lineage-grounding +
auto-detect/degrade) and the `coop-workflow` skill. To create or refresh the docs,
run **`/setup-docs`** in the agent (or `coop data-doc setup` in a shell).

---

## Official Microsoft Skills Catalog

coop can use the **official Microsoft agent skills**, but they are **subordinate to
Cooptimize skills**: yours always win. The allowed upstream paths and revisions are
pinned in [`config/microsoft-skills.json`](config/microsoft-skills.json):

- [`github.com/microsoft/skills`](https://github.com/microsoft/skills) — Azure SDK /
  AI-Foundry / KQL / Microsoft Docs skills, pinned at
  `3495f50ae0d7b69dcb19c6922db9f80aab6cf79c`.
- [`github.com/microsoft/skills-for-fabric`](https://github.com/microsoft/skills-for-fabric)
  — the full Fabric skill set from v0.3.18 (Warehouse, SQL database, Eventhouse,
  Eventstream, Activator, Spark, Dataflows, pipelines, Power BI reports and
  semantic models, OneLake governance, migrations), pinned at
  `6c11ad58c25992e5d1435ce7cd80d217d5598a31`, together with its shared `common/`
  reference tree so the skills' relative links resolve.

`coop sync` refreshes an immutable catalog under the isolated Coop/Pi agent
directory and atomically advances a last-known-good pointer. Launch resolves only
that local catalog; it never networks. A Microsoft skill is surfaced only if the
current project policy allows it and it does not conflict by folder or frontmatter
`name:` with one of ours.

```yaml
microsoft_skills:
  policy: restricted
  allow:
    - "kql"
    - "microsoft-docs"

fabric_skills:
  policy: baseline
```

Baseline enables `kql`, `microsoft-docs`, and every skill in the pinned
skills-for-fabric catalog (25 at v0.3.18, `sqldw-cli` and `eventhouse-cli` among
them) when the project contract turns them on: `fabric_skills: policy: baseline`
(what `/setup-project` writes), or no `fabric_skills:` block at all but a
`fabric:` section. Outside a repo with a `.coop/project.yml` contract, Fabric
skills stay off (`coop doctor` from your home folder reports them disabled).
On a machine installed as an Azure SQL client (`coop install --platform azure_sql`)
the `fabric:` section alone is not enough: only an explicit
`fabric_skills: policy: baseline` (or an `allow:` list) turns the Fabric skills on.
Use `policy: restricted` with an `allow:` list to load a subset. Legacy
`source` and `load_dir` fields are ignored with migration notices in
`coop doctor`.

Fabric authoring skills may edit SQL and Fabric item definitions. They remain
governed by the Cooptimize workflow: plan-and-approve before edits, back up,
review, show the diff, and **never commit source** — a human reviews and commits.

See [`skills/_microsoft/README.md`](skills/_microsoft/README.md) for details.

---

## Team knowledge (optional)

Configure approved repositories under `knowledge.repos`, then run `coop sync` (or normal
`coop update`). Sync is fail-soft: a remote outage does not prevent launch, and an existing local
Git checkout remains usable. Team skills load beneath Cooptimize's first-party skills, so
local governance wins conflicts.

At startup Coop checks configured knowledge paths and points the agent to the knowledge
skill; literal Markdown retrieval is performed on demand. It can nudge `search-knowledge`
after at least two distinct failed tool results in one session. Use **`/share-learning`** to prepare
a reviewed pull request back to the knowledge source; it never silently publishes or
commits. Experimental `knowledge.sources` v2 remains disabled by default, and semantic
retrieval is not claimed as a production runtime feature.

### TeamAI trial (K1, isolated, off by default)

`coop onboard --config-only` can enable the TeamAI shared-knowledge trial
(`knowledge.teamai`: `enabled`, `team_repo`, `provider`, `role`). When enabled,
`coop sync` installs the manifest-pinned `teamai-cli` with `npm install --prefix`
into `~/.coop/teamai/pkg` (never globally, never a `teamai` from `PATH`) and pulls
the team repository; `coop teamai init` runs once against the sandbox team repository
URL. Every call runs with `HOME`/`USERPROFILE` redirected to `~/.coop/teamai/home`,
a disposable `~/.coop/teamai/workspace` as the working directory, hooks and
recall-quality recording disabled, every inherited `TEAMAI_*`/`CLAUDE_*` variable
dropped, no stdin, a hard timeout (`COOP_TEAMAI_TIMEOUT_SECONDS`, default 60) and a
git push guard (every push URL the CLI's git sees is rewritten to `no-push://`, so the
CLI can fetch and pull but never write to the team repository):
the CLI's data home and the AI-tool settings it would inject into stay inside that
isolated root, never in your real home, the stable coop profile or another agent's
directory. Launch never touches it. `coop teamai recall --query <text>` returns at
most five results with repository, revision, file and author provenance and reports
`no_match`, `partial`, `unavailable` and a `stale` flag honestly; `coop doctor` shows
the trial's state.

Sharing a learning with the trial repository (K2) keeps the review boundary:
`/share-learning` saves the reviewed note and runs
`coop teamai contribute --file <note.md> --title "<title>"`, which sweeps the draft
(secrets, connection strings, URL credentials, a `client-confidential` or missing
`sensitivity:` marking keep it local as `refused`), asks the CLI in `--dry-run` for the
exact `learnings/...` destination and returns a `preview`. Only `--approve`, after the
person has seen that preview, stages the note on a new `coop/learning/<slug>-<stamp>`
branch pushed from a disposable clone (`~/.coop/teamai/stage`) and prints the compare
URL; the pull request is the person's. The CLI's own `teamai contribute` (a direct
write to the team repo's `learnings` branch) and `teamai push` (a pull request opened
from inside the CLI) are never run, and the default branch is never written.

The broader lifecycle (K3) stays read-only and explicit. `coop teamai skills` lists
the team repository's `skills/*/SKILL.md`; with `knowledge.teamai.skills` true
(`coop onboard --config-only`) those skills load at launch through the same
subordinate slot as the knowledge repos' skills (a Cooptimize skill with the same
name or folder wins, the clone path comes from `~/.coop/teamai/state.json`, the
launcher never runs the CLI). `coop teamai maintenance` reports stale learnings
(`knowledge.teamai.stale_days`, default 180), proposals older than 90 days,
malformed notes and duplicate titles, and changes nothing: fixes go through a pull
request on the team repository. `coop teamai compare --query <text>` runs the
bundled local search and the isolated recall side by side on one query and reports
the overlap, the evidence the plan asks for before the local search path could ever
be retired (it is not).

---

## Support Center and fleet health

`coop support [--json] [--incident] [--export PATH]` collects sanitized local diagnostics,
standards status, and a bounded incident timeline without network access or model/Pi
availability. It sanitizes before persistence, retains the newest 200 events and 10 default
bundles, and exports a bundle by default for escalation.

Set `fleet.publish_dir` in private Coop config, then run `coop doctor --publish` to write a
per-host/user JSON snapshot. Aggregate snapshots with:

```powershell
scripts\fleet-digest.ps1 --format md         # add --send or --dry-run
```

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\fleet-digest.ps1 --format md
```

The digest flags failures, warnings, and stale check-ins, shows each machine's coop version
with its `git describe` when the snapshot carries one (`coop_describe`, from a git checkout),
and can render Markdown/HTML or send through Microsoft Graph when configured.

---

## Footer & splash

coop renders its **own** footer and splash via `extensions/coop-powerline` — it does
**not** use a third-party powerline footer (`pi-powerline-footer` was removed: its
welcome overlay couldn't be disabled, Nerd Font glyphs showed as `?`, and it
duplicated the bar). The footer shows `⬢ Cooptimize · <branch>` on the left and
`<model> · ctx N% · tokens · $cost · <plan usage limits>` on the right, in plain text +
common Unicode (no Nerd Font glyphs). It surfaces other extensions' status text (e.g.
`pi-better-openai`'s plan usage limits / 5h + 7d windows) via
`footerData.getExtensionStatuses()`, so everything is in one clean bar. It is one
line when it fits; in a narrower window the right side wraps onto extra lines, so
usage is never cut off. For that to
work, `coop sync` (also run by `coop install` and `coop update`) keeps
`pi-better-openai`'s own footer in `status` mode in `~/.coop/agent/extensions/pi-better-openai.json`;
its default `replace` mode installs a second footer that wipes coop's. A deliberate
`off` is left alone. The splash is
the truecolor block-art Cooptimize logo (uniform-padded, width-robust). Coop also owns
the terminal tab title (`coop - <session> - <folder>`) so Pi's `π` branding does not
reappear after startup or a session rename. The tab icon itself belongs to the terminal
profile; Windows shortcuts use `themes/coop.ico`, while an existing PowerShell tab keeps
its configured profile icon.

---

## Persistent memory & branding

- **Persistent memory** is provided by **`pi-hermes-memory`** — durable facts,
  preferences, corrections, session search, and secret scanning. Use it for durable
  context; **never** for secrets.
- **Branding** at launch: the Cooptimize **splash** and **footer** (both rendered by
  `coop-powerline` — see [Footer & splash](#footer--splash)), rotating feature
  **tips** with a few easter eggs, and
  the **theme** (`themes/cooptimize.json`). Brand palette (sampled from the logo):
  navy `#00416B`, forest `#42783C`, olive `#82AA43`, lime `#B2D235`, red `#EF412D`.
  Coop enables Pi's quiet-startup setting so the raw context/skills/prompts/extensions
  inventory stays hidden; those resources still load normally. `coop sync` keeps this
  setting, the splash, and the vibe assets current.

---

## Updating & maintenance

```bash
coop update          # move to the newest release tag, converge to its manifest, run Doctor
coop update --check  # dry-run core tool status; changes nothing
coop update --edge   # maintainers: head of main + latest upstream, then report manifest drift
coop sync            # refresh governed MCP/catalog/team-knowledge/assets non-destructively
coop doctor          # re-check dependencies and configuration
coop support --incident  # export a sanitized escalation bundle
```

`coop update` keeps Pi, its extensions, standalone tools, and a Git-backed Coop repo
current, then runs Doctor. On Windows, a running Coop/Pi process causes the Pi update to be
skipped and returns nonzero—close every Coop/Pi window and rerun. A zip/shared-drive copy
instead of a Git clone suits only a one-time or offline install: it can update tools but
never the repo layer (skills, prompts, scripts, themes, or guardrails). Replace it with a
Git clone and rerun `.\bin\coop.cmd install`. Private `~/.coop` settings are preserved.

**Release channel.** `coop update` fast-forwards the coop-agent checkout to the newest
release tag (`vX.Y.Z` on `main`) and pins Pi, extensions, and tools to that release's
manifest. It never moves a checkout backwards: a checkout at or past the newest release
stays where it is. Merges to `main` reach teammates only when a release is tagged. Fresh
clones start on the head of `main` and join the release channel at the next tag.

**Maintainer channel.** `coop update --edge` takes the head of `main` plus the latest
upstream Pi, extensions, and tools; from a detached checkout it re-attaches to `main` when
that loses nothing. `--edge` is sticky: the release channel never moves backwards, so an
`--edge` checkout stays on unreleased `main` until a release is tagged past it, then
follows tags again on its own. To rejoin sooner while staying on `main`, first check that
`git -C <coop-agent> log refs/remotes/origin/main..refs/heads/main` prints nothing, then run
`git -C <coop-agent> reset --keep vX.Y.Z` and `coop update`. For the head of `main` with
manifest pins, run `git -C <coop-agent> pull --ff-only`, then `coop update`.

**When the repo does not move.** Step 1 of `coop update` and the Doctor repo row name the
state and the command that fixes it:

- Tracked local changes skip the move; untracked files do not.
- A branch that does not track `origin/main` is a *hold* and is left alone (a per-machine
  pin). Rejoin with `git -C <coop-agent> switch main`, then `coop update`. `--edge` pulls a
  held branch's own upstream and does nothing on a hold without one.
- Local commits that the next release does not contain block the move. Push them, or set
  them aside on a branch as Doctor shows.
- A clone with no `origin/main` (for example a single-branch clone of a tag) cannot
  follow releases: `git -C <coop-agent> remote set-branches origin '*'`, then
  `git -C <coop-agent> fetch origin`.
- A checkout with no `origin` remote (renamed or removed) cannot move: Doctor shows the
  `git remote rename` or `git remote add origin` command that restores it.
- A detached checkout (for example `git clone --branch vX.Y.Z`) follows release tags
  forward while detached. One detached at v0.23.5 or older runs an updater that cannot
  move it: run `git -C <coop-agent> checkout main`, then `coop update`.

**Fleet pinning.** `coop update` has exactly two fleet modes. **Normal** mode pins Pi,
every extension, and all tools to the exact versions in the release manifest — no registry
queries and no prompts. `--edge` is the only latest/upstream mode. Use `--check` before rollout; it reports Pi, pipx tools, and authoring npm tools,
but does not enumerate managed Pi extensions or the injected `fabric-cicd` library.

**One update voice.** Coop suppresses Pi's self-update notice so a component cannot
drift away from the tested fleet. The daily **coop-agent is N commit(s) behind release vX.Y.Z** notice
remains: it is the safe prompt to run `coop update`, which advances the whole manifest
together. It appears only when a newer release is waiting. Maintainers debugging an
upstream release can temporarily restore Pi's notice with
`COOP_SHOW_UPSTREAM_UPDATE_NOTICES=1`.

---

## Sharing with your team

> New teammate? Hand them **[docs/onboarding.md](docs/onboarding.md)** — a one-page
> clone → install → verify → use guide.
> On Windows, start them on **[docs/install-windows.md](docs/install-windows.md)**.

coop is distributed as **this Git repo**. Put it on a host your coworkers can reach
(GitHub/Azure DevOps/internal), then each teammate runs the bootstrap once:

```powershell
git clone <coop-agent-repo>; cd coop-agent
.\bin\coop.cmd install        # creates %LOCALAPPDATA%\coop\bin\coop.cmd and adds it to your user PATH; open a new terminal if coop isn't found yet
```

`coop install` is idempotent. coop is one PowerShell implementation
(`bin/coop.ps1` + `bin/coop.cmd`); from Git Bash, `./bin/coop` forwards to it.

Each teammate's machine needs the prerequisites (Node 22.19+, Python 3.10+, pipx, git —
see [Prerequisites](#prerequisites)); the installer pulls everything else from npm
and PyPI. After install, `coop doctor` tells each person exactly what (if anything)
is still missing.

Teammates get pushed changes with the next release tag: `coop update` moves coop-agent to
the newest release **and** updates Pi/extensions/tools (maintainers: `coop update --edge`).

### CI gates for your repos

The three suite tools double as CI gates: SQL review (with SARIF PR annotations),
DAX review, and the lineage-docs freshness + strict-rebuild check. Copy-paste
pipelines for **GitHub Actions and Azure DevOps** — flags, exit codes, artifact
publishing, version pinning — are in **[docs/ci.md](docs/ci.md)**.

### Making it your own / extending it

Coworkers can add their own skills, prompts, themes, and tools — see
**[docs/extending.md](docs/extending.md)**. In short: a new skill is just a
`skills/<name>/SKILL.md` file; a new prompt is a `prompts/<name>.md`; both load
automatically on the next `coop`. Commit and push; teammates get it with the next release
tag (maintainers: `coop update --edge`).

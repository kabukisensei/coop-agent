# coop — the Cooptimize terminal agent

**coop** is a branded analytics-engineering agent for Cooptimize, a worker-owned
cooperative. It is a thin **layer on top of [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)**
(`@earendil-works/pi-coding-agent`) — **not a fork**. `coop` runs `pi` against its
**own isolated agent dir** (`~/.coop/agent`) with the Cooptimize skills, prompt
templates, theme, its own splash/footer extension, and a governance system prompt,
and it shells out to the standalone Coop tools
(`coop-data-doc` / `coop-sql-review` / `coop-dax-review`) and the Microsoft Fabric
CLI (`fab`). The stack targets Microsoft Fabric, Azure, Power BI, D365 (Finance &
Operations), T-SQL (Fabric Warehouse/Lakehouse, medallion bronze/silver/gold),
DAX, semantic models (TMDL), and data documentation.

---

## Quick start

From a fresh clone, run the installer with its full path (it links `coop` onto your
`PATH`); after that, the bare `coop` command works:

```bash
git clone <coop-agent-repo> && cd coop-agent
./bin/coop install     # fresh bootstrap of the whole stack (idempotent — safe to re-run)
                       # Windows: .\bin\coop.ps1 install
coop                   # launch the branded Pi agent (after install + new shell)
```

> **Isolation:** `coop` runs Pi against its own agent dir (`~/.coop/agent`) via the
> `PI_CODING_AGENT_DIR` env var, so only Cooptimize's curated extensions/settings/
> theme/MCP load — your personal `pi` stays untouched. See [Isolation](#isolation)
> below.

`coop install` links `coop` into `~/.local/bin`. **That directory must be on your
`PATH`.** If `coop` is not found after install, add this to your shell rc
(`~/.zshrc`, `~/.bashrc`, …) and open a new shell:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

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
`coop sync`. Disable with `COOP_NO_ISOLATE=1`.

---

## Prerequisites

All platforms need:

- **Node.js 22.19+** (to install/update Pi via `npm`) — https://nodejs.org
  (Pi = `@earendil-works/pi-coding-agent` requires ≥ 22.19; teammates still on Node 20
  can pin Pi's `legacy-node20` build)
- **Python 3.10+** — https://python.org
- **pipx** (`coop install` will install it for you if `python3` is present)
- **git** — https://git-scm.com

Optional: **Azure CLI** (`az`) for Fabric / Power BI authentication.

---

## Fresh install

### macOS / Linux

`coop` ships as the bash dispatcher `bin/coop`. From a clone of this repo:

```bash
git clone <coop-agent repo url> coop-agent
cd coop-agent
./bin/coop install        # bootstraps pi, extensions, pipx tools, Fabric CLI, links coop onto PATH
```

`coop install` runs a 7-step bootstrap: prerequisites → Pi → Pi extensions →
Microsoft Fabric CLI → standalone Coop tools → link `coop` onto your `PATH` → sync
brand assets and run `coop doctor`. It is idempotent; re-run it any time.

Useful flags:

- `--force` — reinstall pi tools / pipx packages even if already present
- `--no-fabric` — skip installing the Microsoft Fabric CLI
- `--yes`, `-y` — assume yes for prompts

### Windows

On Windows, `coop` runs through the PowerShell wrapper `bin/coop.ps1` and the
`bin/coop.cmd` shim (mirrors of `bin/coop`). From a clone of this repo in
PowerShell:

```powershell
git clone <coop-agent repo url> coop-agent
cd coop-agent
.\bin\coop.ps1 install
```

`coop install` drops a launcher at `%LOCALAPPDATA%\coop\bin\coop.cmd` and adds
`%LOCALAPPDATA%\coop\bin` to your **user `PATH` automatically**. If `coop` isn't
found yet, **open a new terminal** — the persistent PATH change only applies to
shells started after the install.

### Manual install (any platform)

If you prefer to install the pieces yourself, the bootstrap is equivalent to:

```bash
# Pi itself
npm install -g @earendil-works/pi-coding-agent

# Pi extensions (into coop's isolated agent dir)
pi install npm:pi-mcp-adapter        # MCP servers (Fabric / Power BI / Microsoft Learn / context-mode)
pi install npm:pi-hermes-memory      # persistent memory + session search + secret scanning
pi install npm:pi-better-openai      # plan usage limits (5h + 7d windows), surfaced in coop's footer
pi install npm:pi-web-access         # web search / URL fetch / GitHub clone / PDF / video (read-only)
pi install npm:@juicesharp/rpiv-ask-user-question   # structured questions the model can put to you
# coop renders its own footer + splash via extensions/coop-powerline — no third-party
# powerline-footer extension is installed.

# Standalone Coop tools (via pipx)
pipx install coop-data-doc
pipx install coop-sql-review
pipx install coop-dax-review

# Microsoft Fabric CLI (see the fab collision warning below)
pipx install ms-fabric-cli

# fabric-cicd is a Python LIBRARY (no CLI) — inject it into the Fabric CLI's env
pipx inject ms-fabric-cli fabric-cicd

# Link coop onto your PATH
ln -sf "$PWD/bin/coop" "$HOME/.local/bin/coop"
```

Finish with `coop sync` (ensures the core Pi extensions are installed, places the
read-only MCP config non-destructively, and verifies the splash/theme/vibe assets)
and `coop doctor`.

### What `coop install` includes (turnkey)

One command (`coop install`) gets a coworker everything below. `coop doctor` then
shows anything still missing.

| Component | How it's provided |
| --- | --- |
| **Pi** | installed globally via `npm` |
| **Pi extensions** — `pi-mcp-adapter` (MCP), `pi-hermes-memory` (memory), `pi-better-openai` (plan usage limits), `pi-web-access` (web search/fetch — read-only), `@juicesharp/rpiv-ask-user-question` (structured questions) | installed via `pi install` into coop's isolated agent dir (`~/.coop/agent`) |
| **Coop companion extensions** — `coop-powerline` (footer/splash/vibes), `coop-tools` (native `sql_review`/`dax_review`/`data_doc` + `/setup-docs`), `coop-guardrails` (enforces never-commit-source + destructive-command confirm) | shipped in this repo, loaded at launch via `pi -e` (nothing to install) |
| **Standalone tools** — `coop-data-doc`, `coop-sql-review`, `coop-dax-review` | installed via `pipx` from PyPI |
| **`fabric-cicd`** (deployment validation) | a Python **library** (no CLI), injected into the Fabric CLI's env via `pipx inject ms-fabric-cli fabric-cicd` |
| **Microsoft Fabric CLI** (`ms-fabric-cli` → `fab`) | installed via `pipx` |
| **MCP servers** — `fabric`, `powerbi`, `microsoft-learn`, `context-mode` | **fetched on first use via `npx`** (need Node + internet); placed read-only into coop's isolated MCP config by `coop sync`. No separate install. |

> `pi-powerline-footer` is **not** used. coop renders its own footer and splash via
> `extensions/coop-powerline` (see [Footer & splash](#footer--splash)).

**Not auto-installed (optional, external):**

- **Tabular Editor CLI** — a separate Microsoft desktop/CLI app (no `npm`/`pip`
  package). Install it yourself and set `tools.tabular_editor_cli.executable_path`
  in `.coop/project.yml` if you want semantic-model BPA. coop works without it.
- **Azure CLI** (`az`) — optional, for Fabric / Power BI auth. Install from Microsoft
  if your team uses live MCP / Power BI access.

---

## Commands

Anything after `coop` that is not a known subcommand is passed straight to Pi
(e.g. `coop -c` resumes the last session; `coop @notes.md "review this"`).

| Command | Description |
| --- | --- |
| `coop` | Launch the branded Pi agent (skills, prompts, theme, guardrails, splash) |
| `coop doctor` | Check dependencies and configuration; exit non-zero if required items missing |
| `coop update` | Update Pi + Pi extensions + Coop tools + vibes/skills, then run doctor |
| `coop install` | Fresh-install / bootstrap everything (idempotent). With a source arg, alias of `coop add` |
| `coop bootstrap` | Same bootstrap as bare `coop install` |
| `coop sync` | Ensure core Pi extensions are installed, place the read-only MCP config (non-destructive), verify brand assets |
| `coop data-doc [args]` | Run `coop-data-doc` (default: `build`) and summarize outputs |
| `coop sql-review [args]` | Pass through to `coop-sql-review` (e.g. `check <paths>`, `rules`) |
| `coop dax-review [args]` | Pass through to `coop-dax-review` (e.g. `check <paths>`, `rules`) |
| `coop fabric [args]` | Pass through to the Microsoft Fabric CLI (`fab`) |
| `coop version` | Print `coop` + `pi` versions |
| `coop help` | Show usage |
| **Authoring** | |
| `coop init [dir]` | Scaffold `.coop/project.yml` into a work repo (default: `.`) |
| `coop new-skill <name>` | Scaffold `skills/<name>/SKILL.md` |
| `coop new-prompt <name>` | Scaffold `prompts/<name>.md` |
| `coop release [level]` | Cut a release — bump version, roll CHANGELOG, commit + tag + push (`patch`/`minor`/`major`, default `patch`) |
| **Pi management (aliased under coop)** | |
| `coop list` | List installed Pi extensions (`pi list`) |
| `coop config` | Open Pi's resource TUI (`pi config`) |
| `coop add <source>` | Install a Pi extension (`pi install <source>`) |
| `coop remove <source>` | Remove a Pi extension (`pi remove <source>`) |
| `coop pi <args...>` | Raw escape hatch to `pi` |

`coop data-doc` / `coop sql-review` / `coop dax-review` **flow straight through** to
the underlying tool — every subcommand (`check`, `rules`, `upgrade`, the full
`coop-data-doc setup` wizard, …) and the tools' own interactive prompts work, and
the exit code propagates. Both reviews are **advisory** — they never edit or block.
The AI agent gets machine-readable JSON through the native `sql_review` / `dax_review`
/ `data_doc` tools (in `extensions/coop-tools`), independent of these passthrough
commands — including `data_doc`'s `lineage` command (see
[Lineage-grounded edits](#lineage-grounded-edits)).

For **`coop-data-doc`'s first-run setup**, coop also offers an **in-agent** path so you
don't have to drop to a shell: when you launch `coop` in a folder with no
`coop-data-doc.yml`, it offers to set up lineage docs right there, and the
**`/setup-docs`** command runs (or re-runs) that quick wizard anytime — Pi's native
dialogs collect the essentials, write/patch `coop-data-doc.yml`, and build. The full
wizard (medallion layers, branding, schema→model mappings, per-folder globs) still
lives in the tool: run `coop data-doc setup` in a shell. See
[`extensions/coop-tools/README.md`](extensions/coop-tools/README.md#data-doc-setup-setup-docs).

---

## ⚠️ The `fab` collision — Microsoft Fabric CLI vs. Homebrew Python `fab`

`coop install` installs **`ms-fabric-cli`**, which provides the **Microsoft Fabric
CLI** as the `fab` command. A Homebrew formula named **`fabric`** ships a
**different** `fab` — a Python SSH / automation tool (Paramiko / Invoke). If both
are present, `fab` may resolve to the wrong one.

**`coop doctor` detects this** by checking `fab --version` for `paramiko`/`invoke`
and reports it as an error:

```
✗ fab is the WRONG tool — this 'fab' is Python Fabric (SSH automation),
  not the Microsoft Fabric CLI
```

**Fix:** ensure `~/.local/bin` (where pipx installs `fab`) **precedes Homebrew** on
your `PATH`, or remove the conflicting formula:

```bash
brew uninstall fabric        # or reorder PATH so ~/.local/bin comes first
fab --version                # re-verify: should be the Microsoft Fabric CLI
```

---

## MCP servers (read-only, optional)

coop preloads four MCP servers via `pi-mcp-adapter`. They are **all read-only** and
**all optional** — coop runs fine without them.

| Server | Provides | Mode |
| --- | --- | --- |
| `fabric` | `@microsoft/fabric-mcp` (AzureCliCredential) | read-only |
| `powerbi` | `powerbi-mcp-server --readonly` | read-only |
| `microsoft-learn` | `learn.microsoft.com/api/mcp` — always-current Microsoft docs | read-only |
| `context-mode` | local context server | read-only |

`coop sync` places `config/mcp.example.json` **non-destructively** into coop's
isolated agent dir (`~/.coop/agent`) — it never overwrites an existing config and
never touches your personal `pi`'s MCP. Before live Power BI work, set your tenant in
that file:

```jsonc
"powerbi": {
  "args": ["-y", "powerbi-mcp-server@latest", "--authentication", "azcli",
           "--tenant", "TODO-tenant-id", "--readonly"]
}
```

MCP servers are for `list` / `read` / `inspect` only. coop **never** calls
create/update/delete/deploy/publish MCP actions without explicit approval —
regardless of what a server is capable of.

> **Supply-chain note:** the example launches these servers with `npx -y` against
> the latest published package (e.g. `powerbi-mcp-server@latest`, `mcp-remote`),
> which fetches and runs remote code at startup with your Azure CLI credentials
> available. For locked-down environments, pin exact versions in coop's isolated MCP
> config (in `~/.coop/agent`) and review updates before enabling, or disable MCP
> entirely (coop runs fine without it).

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
5. No production changes without explicit, specific confirmation.
6. MCP is read-only.
7. Never expose secrets.

**The Cooptimize workflow** (the `coop-workflow` skill — see
[`skills/coop-workflow/SKILL.md`](skills/coop-workflow/SKILL.md)):

1. Read `.coop/project.yml` and the relevant standards.
2. Locate the repo/object and assess upstream/downstream impact; `git status` && `git pull`.
3. Read the target file(s) + look up the object's upstream/downstream via the `data_doc` tool (`command="lineage"`) before touching it; use the Microsoft Learn MCP for current docs.
4. Write a short **PLAN** and get explicit approval **before** any edit.
5. Create a timestamped backup of every file to be changed.
6. Make the smallest safe edit.
7. Run the applicable review — `sql_review` / `dax_review` (and Tabular Editor BPA / `fabric-cicd` validate where relevant).
8. Show `git diff` and summarize the change.
9. Update Markdown docs / glossary / lineage; regenerate the site if docs changed.
10. Append to the daily log.
11. Commit docs/logs/site **only with approval**; never commit source.

The single source of truth for repo paths, workspaces, standards, backup/log rules,
and the approval policy is the project contract `.coop/project.yml`. Copy
[`.coop/project.example.yml`](.coop/project.example.yml) into your work repo's
`.coop/project.yml` and replace every `TODO`.

---

## Standalone tools

coop wraps three standalone, advisory, **read-only** tools (installed via pipx;
also exposed as the native LLM tools `sql_review` / `dax_review` / `data_doc`):

- **`coop-data-doc`** — SQL + Power BI documentation, lineage, and machine-readable
  output. `scan` → `graph.json`; `build` → `manifest.json` + Markdown docs + a
  portal site; `lineage <object>` → one object's upstream/downstream + relationships
  as JSON. Other verbs: `check`, `init`, `setup`, `update`, `upgrade`. coop consumes
  these natively through the `data_doc` tool (including `command="lineage"`) — see
  [Lineage-grounded edits](#lineage-grounded-edits) below.
- **`coop-sql-review`** — advisory T-SQL standards linter.
  `coop-sql-review check <paths...> --format json [--min-severity error|warning|info] [--strict]`
- **`coop-dax-review`** — advisory DAX standards linter (same shape as sql-review).

The review tools are **advisory only**: they never edit files and never block work.

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
  inputs, downstream dependents, and relationships as JSON — it reads the focused
  per-object doc rather than re-deriving lineage by hand.
- **Degrade gracefully.** If the folder has **no** `coop-data-doc.yml` or no built
  graph, lineage is silent and optional — the agent proceeds without it and may
  suggest **`/setup-docs`**. The docs are an aid, not a gate.

This policy lives in [`docs/guardrails.md`](docs/guardrails.md) (lineage-grounding +
auto-detect/degrade) and the `coop-workflow` skill. To create or refresh the docs,
run **`/setup-docs`** in the agent (or `coop data-doc setup` in a shell).

---

## Official Microsoft skills (subordinate, opt-in)

coop can use the **official Microsoft agent skills**
([github.com/microsoft/skills](https://github.com/microsoft/skills), MIT — 175
Azure-SDK / AI-Foundry skills), but they are **subordinate to Cooptimize skills**:
yours always win. A Microsoft skill is surfaced only if it is **allow-listed** in
`microsoft_skills.allow` **and** does not conflict (by folder name or frontmatter
`name:`) with one of ours — conflicts are skipped with a warning.

```yaml
microsoft_skills:
  source: "https://github.com/microsoft/skills"
  load_dir: "skills/_microsoft"
  allow: []   # e.g. ["azure-cosmos-db-py"] — empty = none
```

Fetch the allow-listed, non-conflicting skills (they're **gitignored**, not vendored,
so this repo stays small):

```bash
scripts/fetch-microsoft-skills.sh
```

See [`skills/_microsoft/README.md`](skills/_microsoft/README.md) for details.

---

## Footer & splash

coop renders its **own** footer and splash via `extensions/coop-powerline` — it does
**not** use a third-party powerline footer (`pi-powerline-footer` was removed: its
welcome overlay couldn't be disabled, Nerd Font glyphs showed as `?`, and it
duplicated the bar). The footer shows `⬢ Cooptimize · <branch>` on the left and
`<model> · ctx N% · tokens · $cost · <plan usage limits>` on the right, in plain text +
common Unicode (no Nerd Font glyphs). It surfaces other extensions' status text (e.g.
`pi-better-openai`'s plan usage limits / 5h + 7d windows) via
`footerData.getExtensionStatuses()`, so everything is in one clean bar. The splash is
the truecolor block-art Cooptimize logo (uniform-padded, width-robust).

---

## Persistent memory & branding

- **Persistent memory** is provided by **`pi-hermes-memory`** — durable facts,
  preferences, corrections, session search, and secret scanning. Use it for durable
  context; **never** for secrets.
- **Branding** at launch: the Cooptimize **splash** and **footer** (both rendered by
  `coop-powerline` — see [Footer & splash](#footer--splash)), working **vibes**, and
  the **theme** (`themes/cooptimize.json`). Brand palette (sampled from the logo):
  navy `#00416B`, forest `#42783C`, olive `#82AA43`, lime `#B2D235`, red `#EF412D`.
  `coop sync` keeps the splash and vibe assets fresh.

---

## Updating & maintenance

```bash
coop update      # updates Pi + Pi extensions + Coop tools + vibes/skills, then runs doctor
coop sync        # re-sync vibes/powerline + place the read-only MCP config (non-destructive)
coop doctor      # re-check dependencies and configuration at any time
```

`coop update` keeps Pi, its extensions, and the standalone tools current, then runs
`coop doctor` so you immediately see anything left to fix.

---

## Sharing with your team

> New teammate? Hand them **[docs/onboarding.md](docs/onboarding.md)** — a one-page
> clone → install → verify → use guide.

coop is distributed as **this Git repo**. Put it on a host your coworkers can reach
(GitHub/Azure DevOps/internal), then each teammate runs the bootstrap once:

```bash
# macOS / Linux
git clone <coop-agent-repo> && cd coop-agent
./bin/coop install            # installs Pi, extensions, the pipx tools, ms-fabric-cli; links `coop` onto PATH

# Windows (PowerShell)
git clone <coop-agent-repo>; cd coop-agent
.\bin\coop.ps1 install        # creates %LOCALAPPDATA%\coop\bin\coop.cmd and adds it to your user PATH; open a new terminal if coop isn't found yet
```

`coop install` is idempotent and **cross-platform**:

- **macOS / Linux** — `bin/coop` (bash), tested.
- **Windows** — `bin/coop.ps1` + `bin/coop.cmd` (PowerShell). Same subcommands,
  dependency list, and `fab`-collision detection as the bash path.

Each teammate's machine needs the prerequisites (Node 22.19+, Python 3.10+, pipx, git —
see [Prerequisites](#prerequisites)); the installer pulls everything else from npm
and PyPI. After install, `coop doctor` tells each person exactly what (if anything)
is still missing.

To keep the team in sync, push changes to the repo and have everyone run
`coop update` (it `git pull`s coop-agent **and** updates Pi/extensions/tools).

### Making it your own / extending it

Coworkers can add their own skills, prompts, themes, and tools — see
**[docs/extending.md](docs/extending.md)**. In short: a new skill is just a
`skills/<name>/SKILL.md` file; a new prompt is a `prompts/<name>.md`; both load
automatically on the next `coop`. Commit, push, `coop update` — everyone has it.

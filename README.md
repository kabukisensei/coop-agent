# coop — the Cooptimize terminal agent

**coop** is a branded analytics-engineering agent for Cooptimize, a worker-owned
cooperative. It is a thin **layer on top of [Pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)**
(`@mariozechner/pi-coding-agent`) — **not a fork**. `coop` launches `pi` with the
Cooptimize skills, prompt templates, theme, splash/footer extension, and a
governance system prompt, and it shells out to the standalone Coop tools
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

## Prerequisites

All platforms need:

- **Node.js 18+** (to install/update Pi via `npm`) — https://nodejs.org
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

Then add `bin\coop.cmd`'s directory (or your linked location) to your user `PATH`
so `coop` is available from any shell.

### Manual install (any platform)

If you prefer to install the pieces yourself, the bootstrap is equivalent to:

```bash
# Pi itself
npm install -g @mariozechner/pi-coding-agent

# Pi extensions
pi install npm:pi-mcp-adapter        # MCP servers (Fabric / Power BI / Microsoft Learn / context-mode)
pi install npm:pi-hermes-memory      # persistent memory + session search + secret scanning
pi install npm:pi-powerline-footer   # branded footer / status bar

# Standalone Coop tools + Fabric deployment validation (via pipx)
pipx install coop-data-doc
pipx install coop-sql-review
pipx install coop-dax-review
pipx install fabric-cicd

# Microsoft Fabric CLI (see the fab collision warning below)
pipx install ms-fabric-cli

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
| **Pi extensions** — `pi-mcp-adapter`, `pi-hermes-memory`, `pi-powerline-footer` | installed via `pi install` |
| **Coop companion extensions** — `coop-powerline` (splash/vibes), `coop-tools` (native `sql_review`/`dax_review`/`data_doc`) | shipped in this repo, loaded at launch (nothing to install) |
| **Standalone tools** — `coop-data-doc`, `coop-sql-review`, `coop-dax-review`, `fabric-cicd` | installed via `pipx` from PyPI |
| **Microsoft Fabric CLI** (`ms-fabric-cli` → `fab`) | installed via `pipx` |
| **MCP servers** — `fabric`, `powerbi`, `microsoft-learn`, `context-mode` | **fetched on first use via `npx`** (need Node + internet); placed read-only into `~/.config/mcp/mcp.json` by `coop sync`. No separate install. |

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
| `coop sql-review [paths]` | Run `coop-sql-review`; summarize findings (`--json` for raw JSON) |
| `coop dax-review [paths]` | Run `coop-dax-review`; summarize findings (`--json` for raw JSON) |
| `coop fabric [args]` | Pass through to the Microsoft Fabric CLI (`fab`) |
| `coop version` | Print `coop` + `pi` versions |
| `coop help` | Show usage |
| **Authoring** | |
| `coop init [dir]` | Scaffold `.coop/project.yml` into a work repo (default: `.`) |
| `coop new-skill <name>` | Scaffold `skills/<name>/SKILL.md` |
| `coop new-prompt <name>` | Scaffold `prompts/<name>.md` |
| **Pi management (aliased under coop)** | |
| `coop list` | List installed Pi extensions (`pi list`) |
| `coop config` | Open Pi's resource TUI (`pi config`) |
| `coop add <source>` | Install a Pi extension (`pi install <source>`) |
| `coop remove <source>` | Remove a Pi extension (`pi remove <source>`) |
| `coop pi <args...>` | Raw escape hatch to `pi` |

The review wrappers default their target path to `repositories.fabric_dw.sql_root`
from `.coop/project.yml` when you omit paths, falling back to `.`. Both reviews are
**advisory** — they never edit or block. For the full report, run the tool directly
with `--format text`.

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

`coop sync` places `config/mcp.example.json` **non-destructively** into
`~/.config/mcp/mcp.json` (it never overwrites an existing config). Before live
Power BI work, set your tenant in that file:

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
> available. For locked-down environments, pin exact versions in
> `~/.config/mcp/mcp.json` and review updates before enabling, or disable MCP
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
3. Read the target file(s) + related docs/lineage via the `data_doc` tool; use the Microsoft Learn MCP for current docs.
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
  portal site. Other verbs: `check`, `init`, `setup`, `update`, `upgrade`.
- **`coop-sql-review`** — advisory T-SQL standards linter.
  `coop-sql-review check <paths...> --format json [--min-severity error|warning|info] [--strict]`
- **`coop-dax-review`** — advisory DAX standards linter (same shape as sql-review).

The review tools are **advisory only**: they never edit files and never block work.
Also available: **`fabric-cicd`** for Fabric deployment validation (validate-only by
default) and an optional, path-configured **Tabular Editor CLI** (set
`tools.tabular_editor_cli.executable_path` in `.coop/project.yml`).

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

## Persistent memory & branding

- **Persistent memory** is provided by **`pi-hermes-memory`** — durable facts,
  preferences, corrections, session search, and secret scanning. Use it for durable
  context; **never** for secrets.
- **Branding** at launch: the Cooptimize **splash**, powerline **footer/segments**,
  working **vibes**, and the **theme** (`themes/cooptimize.json`). Brand palette
  (sampled from the logo): navy `#00416B`, forest `#42783C`, olive `#82AA43`,
  lime `#B2D235`, red `#EF412D`. `coop sync` keeps the splash and vibe assets fresh.

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

coop is distributed as **this Git repo**. Put it on a host your coworkers can reach
(GitHub/Azure DevOps/internal), then each teammate runs the bootstrap once:

```bash
# macOS / Linux
git clone <coop-agent-repo> && cd coop-agent
./bin/coop install            # installs Pi, extensions, the pipx tools, ms-fabric-cli; links `coop` onto PATH

# Windows (PowerShell)
git clone <coop-agent-repo>; cd coop-agent
.\bin\coop.ps1 install        # creates %LOCALAPPDATA%\coop\bin\coop.cmd; add it to PATH if prompted
```

`coop install` is idempotent and **cross-platform**:

- **macOS / Linux** — `bin/coop` (bash), tested.
- **Windows** — `bin/coop.ps1` + `bin/coop.cmd` (PowerShell). Same subcommands,
  dependency list, and `fab`-collision detection as the bash path.

Each teammate's machine needs the prerequisites (Node 18+, Python 3.10+, pipx, git —
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

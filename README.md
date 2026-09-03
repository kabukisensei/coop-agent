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

> **Part of the coop suite.** coop-agent is the suite's hub: **`coop install`**
> sets up the standalone tools —
> [coop-data-doc](https://github.com/kabukisensei/coop-data-doc) (lineage docs),
> [coop-sql-review](https://github.com/kabukisensei/coop-sql-review) (T-SQL linter),
> [coop-dax-review](https://github.com/kabukisensei/coop-dax-review) (DAX/model
> linter) — alongside the agent, and **`coop update`** keeps everything current.
> Each tool also works standalone (`pipx install <tool>`); to run them as CI
> gates, see [docs/ci.md](docs/ci.md).

---

## Quick start

From a fresh clone, run the installer with its full path (it links `coop` onto your
`PATH`); after that, the bare `coop` command works:

```bash
git clone <coop-agent-repo> && cd coop-agent
./bin/coop install     # fresh bootstrap of the whole stack (idempotent — safe to re-run)
                       # Windows: .\bin\coop.cmd install
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

`coop install` automatically attempts to install missing prerequisites via `winget` (Windows) or `brew`/`apt`/`dnf` (macOS/Linux) when available (opt out with `--no-prereqs`):

- **Node.js 22.19+** (to install/update Pi via `npm`) — https://nodejs.org (auto-installed via `winget` / `brew` / `apt` if missing)
- **Python 3.10–3.13 for Microsoft Fabric CLI** — https://python.org (`coop install`
  uses a compatible system interpreter when available; otherwise pipx fetches an
  isolated standalone Python 3.12, including on Windows VMs that only have Python
  3.14 and lack `winget` / `py`)
- **pipx** (auto-installed by `coop install` via Python `pip`)
- **git** — https://git-scm.com (auto-installed via `winget` / `brew` / `apt` if missing)
- **Azure CLI** (`az`) — *optional* — https://learn.microsoft.com/cli/azure (auto-installed via `winget` / `brew` / `apt` if missing; needed only for Fabric / Power BI live authentication — local SQL/DAX review works without it)
- **Tabular Editor CLI (`te`)** — *optional* — https://tabulareditor.com/product/features-and-tools/tabular-editor-cli (cross-platform CLI that runs Best Practice Analyzer rules on semantic models; requires a Tabular Editor account during the preview — place `te` in `~/.local/bin` or your `PATH`, then run `te auth login` once)

---

## Fresh install

### macOS / Linux

`coop` ships as the bash dispatcher `bin/coop`. From a clone of this repo:

```bash
git clone <coop-agent repo url> coop-agent
cd coop-agent
./bin/coop install        # bootstraps pi, extensions, pipx tools, Fabric CLI, links coop onto PATH
```

`coop install` handles the complete bootstrap: prerequisites → Pi → extensions →
Microsoft Fabric CLI → standalone Coop tools → PATH/shortcuts → a short first-run
setup → sync and Doctor. First-run setup asks only for your profile and whether to
connect to client Fabric/Power BI; Coop applies the recommended integrations. The
detailed switches remain available later with `coop onboard --config-only`.
It is idempotent; re-run it any time.

Useful flags:

- `--force` — reinstall pi tools / pipx packages even if already present
- `--no-fabric` — skip installing the Microsoft Fabric CLI
- `--no-prereqs` — skip auto-installing missing system prerequisites (still reports them)
- `--yes`, `-y` — assume yes for prompts

### Windows

On Windows, `coop` runs through the PowerShell wrapper `bin/coop.ps1` and the
`bin/coop.cmd` shim (mirrors of `bin/coop`). From a clone of this repo in
PowerShell:

```powershell
git clone <coop-agent repo url> coop-agent
cd coop-agent
.\bin\coop.cmd install
```

> **Why `.cmd`, not `.ps1`?** Stock Windows ships with the `Restricted` execution
> policy, under which `.\bin\coop.ps1 install` dies with *"running scripts is
> disabled on this system"*. The `.cmd` shim bypasses the policy for this one
> invocation (nothing machine-wide changes). If you specifically want the bare
> PowerShell entry point, invoke it with an explicit bypass:
> `powershell -ExecutionPolicy Bypass -File .\bin\coop.ps1 install`

`coop install` drops a launcher at `%LOCALAPPDATA%\coop\bin\coop.cmd` and adds
`%LOCALAPPDATA%\coop\bin` to your **user `PATH` automatically**. If `coop` isn't
found yet, **open a new terminal** — the persistent PATH change only applies to
shells started after the install.

It also creates **two double-click launchers** on the **Start Menu and Desktop**
(Windows), so members who aren't comfortable in a terminal can open coop by
clicking an icon:

- **coop** — opens the friendly **chat window** (`coop web`: ChatGPT-style chat in
  a chromeless app window; the server console starts minimized — closing that
  minimized window stops coop).
- **coop (terminal)** — the classic terminal agent.

Both are purely additive: running `coop` in any terminal is unchanged. Coop starts
directly at the prompt without opening setup dialogs. Run **`/start`** anytime for
a menu of common tasks.

Project setup is available on demand through **`/setup-project`**, the first item
in `/start`, or `coop init` from a shell. The wizard supports discovery projects
with no local source, partial and one-sided estates, mixed repositories, and fully
connected estates. Edits make a backup and preserve comments, custom policies,
and fields the wizard does not own.

**No-terminal first-time setup (for non-technical members).** Hand them the
`coop-agent` folder (a zip or a shared drive) and have them double-click
**`Install coop.cmd`** in it. That runs the same `coop install` for them — no
terminal, no commands — and when it finishes they'll have the coop icon to
double-click. Power users keep using `.\bin\coop.cmd install` exactly as above;
`Install coop.cmd` just wraps it with a friendly window and a pause at the end.

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
| **Coop companion extensions** — `coop-powerline` (footer/splash/vibes), `coop-tools` (native `sql_review`/`dax_review`/`data_doc` + `/setup-project` + `/setup-docs`), `coop-guardrails` (enforces never-commit-source + destructive-command confirm) | shipped in this repo, loaded at launch via `pi -e` (nothing to install) |
| **Standalone tools** — `coop-data-doc`, `coop-sql-review`, `coop-dax-review` | installed via `pipx` from PyPI |
| **`fabric-cicd`** (deployment validation) | a Python **library** (no CLI), injected into the Fabric CLI's env via `pipx inject ms-fabric-cli fabric-cicd` |
| **Microsoft Fabric CLI** (`ms-fabric-cli` → `fab`) | installed via `pipx` |
| **MCP servers** — `fabric`, `powerbi`, `microsoft-learn`, `context-mode` | **fetched on first use via `npx`** (need Node + internet); placed read-only into coop's isolated MCP config by `coop sync`. No separate install. |

> `pi-powerline-footer` is **not** used. coop renders its own footer and splash via
> `extensions/coop-powerline` (see [Footer & splash](#footer--splash)).

**Not auto-installed (optional, external):**

- **Tabular Editor CLI (`te`)** — the cross-platform Tabular Editor CLI (no `npm`/`pip`
  package). Install it yourself, run `te auth login` once, and set
  `tools.tabular_editor_cli.executable_path` in `.coop/project.yml` if you want
  semantic-model BPA. coop works without it.
- **Azure CLI** (`az`) — optional, for Fabric / Power BI auth. Install from Microsoft
  if your team uses live MCP / Power BI access.

---

## Commands

Anything after `coop` that is not a known subcommand is passed straight to Pi
(e.g. `coop -c` resumes the last session; `coop @notes.md "review this"`).

| Command | Description |
| --- | --- |
| `coop` | Launch the branded Pi agent (skills, prompts, theme, guardrails, splash) |
| `coop doctor [--fix] [--json]` | Check dependencies and configuration; exit non-zero if required items missing. `--fix` auto-applies safe remediations (sync extensions/MCP/assets, pipx-install missing Coop tools), then re-checks. `--json` emits one machine-readable document on stdout (`{"checks":[{name,section,status,hint}…],"fail":N,"warn":N}`) for fleet-health digests |
| `coop update [--no-fabric]` | Update Pi + Pi extensions + Coop tools + vibes/skills, then run doctor (`--no-fabric` skips the Fabric CLI, matching `install --no-fabric`) |
| `coop uninstall [--keep-tools] [--yes]` | Remove coop from this machine (VM churn / offboarding): the PATH launcher/symlink, the Start Menu + Desktop shortcuts and user-PATH entry (Windows), and coop's isolated agent dir — plus, by default, Pi (npm) and the pipx tools. `--keep-tools` spares pi/pipx/fab for a fast re-install. Never touches the repo clone, work repos, the rest of `~/.coop`, or your personal `~/.pi/agent` |
| `coop install` | Fresh-install / bootstrap everything (idempotent). With a source arg, alias of `coop add` |
| `coop web` | Open a friendly browser UI over the same governed agent (experimental; loopback-only + one-time token — see `web/README.md`) |
| `coop bootstrap` | Same bootstrap as bare `coop install` |
| `coop sync` | Ensure core Pi extensions are installed, place the read-only MCP config (non-destructive), verify brand assets |
| `coop data-doc [args]` | Run `coop-data-doc` (default: `build`) and summarize outputs |
| `coop sql-review [args]` | Pass through to `coop-sql-review` (e.g. `check <paths>`, `rules`) |
| `coop dax-review [args]` | Pass through to `coop-dax-review` (e.g. `check <paths>`, `rules`) |
| `coop review [paths...] [--strict] [--skip-docs] [--compare] [--diff [ref]] [--html]` | Run **both** linters over one scope (explicit paths win; else the nearest `.coop/project.yml`'s `repositories.*.local_path` entries — never a blind cwd scan), save both JSON reports under `.coop/reviews/` next to the contract, then rebuild the lineage docs with the findings composed in (`coop-data-doc build --reviews …`). Docs not set up is a hint, not a failure; `--skip-docs` runs the linters only; `--strict` passes `--strict` to both linters and exits 2 if either exits non-zero. `--compare` diffs against the previous run's report. `--diff [ref]` runs the review only on files changed since `ref` (default: `HEAD`) in git-tracked roots. `--html` emits a unified HTML suite report. |
| `coop fabric [args]` | Pass through to the Microsoft Fabric CLI (`fab`) |
| `coop version` | Print `coop` + `pi` versions |
| `coop help` | Show usage |
| **Authoring** | |
| `coop init [dir]` | Scaffold `.coop/project.yml` into a work repo (default: `.`). Once `repositories:` is filled, `coop init --seed-docs` generates/patches `coop-data-doc.yml` from it (via `coop-data-doc config-set`), so repo paths are typed once |
| `coop new-skill <name>` | Scaffold `skills/<name>/SKILL.md` |
| `coop new-prompt <name>` | Scaffold `prompts/<name>.md` |
| `coop release [patch\|minor\|major] [--yes] [--no-push] [--no-check]` | Cut a release — bump version, roll CHANGELOG, commit + tag + push (default `patch`). Build-checks the extensions first (skip with `--no-check`); `--no-push` tags locally only; `--yes` skips the confirm |
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

For **`coop-data-doc` setup**, coop offers an **on-demand in-agent** path so you
don't have to drop to a shell: run **`/setup-docs`** or choose *Document my data*
from `/start` when you are ready. Coop does not launch this wizard automatically
during startup. The command runs (or re-runs) the full native `coop-data-doc`
wizard through a strict JSONL bridge; it is the same questionnaire used by
`coop data-doc setup`. Older tool versions stop with upgrade guidance rather than a reduced fallback. See
[`extensions/coop-tools/README.md`](extensions/coop-tools/README.md#data-doc-setup-setup-docs).

Project configuration has the same no-shell path: run **`/setup-project`** or
choose **Set up or edit this Coop project** from `/start`. The wizard creates a
missing `.coop/project.yml` or safely edits the nearest existing one, covering
client details, whatever repositories are available, Fabric/Power BI workspaces,
and Tabular Editor. A repository is not required: the wizard can start an engagement
in discovery mode, record SQL-only or Power-BI-only coverage, and add sources later.
After an edit, run `/new` (or restart Coop) so the guardrails take a fresh trusted
snapshot of the contract.

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
your `PATH`, or remove the conflicting formula (macOS/Homebrew; on Linux,
uninstall the Python `fabric` package however it was installed, e.g.
`pipx uninstall fabric`):

```bash
brew uninstall fabric        # or reorder PATH so ~/.local/bin comes first
fab --version                # re-verify: should be the Microsoft Fabric CLI
```

---

## MCP servers (read-only, optional)

coop generates up to six MCP server entries via `pi-mcp-adapter`. They are **read-only first** and
**all optional** — coop runs fine without them.

| Server | Provides | Mode |
| --- | --- | --- |
| `fabric` | `@microsoft/fabric-mcp` (AzureCliCredential) | read-only *by policy* † |
| `powerbi` | `powerbi-mcp-server --readonly` | read-only (server-enforced `--readonly`) |
| `powerbi-modeling-mcp` | `@microsoft/powerbi-modeling-mcp --start --readonly` | read-only (server-enforced) |
| `azure-devops` | `@azure-devops/mcp` for configured organization | read-only first; mutations approval-gated |
| `microsoft-learn` | `learn.microsoft.com/api/mcp` — always-current Microsoft docs | read-only |
| `context-mode` | `npx -y context-mode` — intent-driven search + sandboxed exec | read-only |

> † The Fabric MCP has **no** server-side read-only switch (unlike `powerbi`'s
> `--readonly`), so its read-only posture is enforced by **policy**, not by the
> server: Pi's tool-approval prompts, the advisory guardrails prompt, and
> `coop-guardrails`, which **confirms** any Fabric/Power BI/MCP tool call whose name
> looks like a mutation (create/update/delete/deploy/publish). That last check is
> best-effort (MCP tool names vary). For hard, per-tool gating, enable the optional
> `pi-permissions` extension.

`coop onboard` writes versioned `~/.coop/config`; `coop sync` deterministically
generates manifest-pinned COOP-managed entries in `~/.coop/agent/mcp.json` while
preserving custom and unmarked user-owned servers. Configure tenant and Azure DevOps
organization with `coop onboard --edit`; generated entries contain no TODOs or latest pins.

MCP servers are for `list` / `read` / `inspect` only. coop **never** calls
create/update/delete/deploy/publish MCP actions without explicit approval —
regardless of what a server is capable of.

For live estate discovery, Coop may inspect dev/test metadata, schemas, and artifact
code read-only by default. Actual row reads ask first. Production metadata and code
also ask first; production row reads require an explicitly bounded target, columns,
filters, and row limit. Results identify whether evidence came from a repo or a live
environment and flag drift between them.

> **Supply-chain note:** generated servers use exact versions from
> `config/release-manifest.json`. Review COOP release updates before enabling them in
> locked-down environments; MCP integrations remain optional.

The example MCP config also carries an optional **`azure-devops`** entry
(`@azure-devops/mcp`, read-only verbs) for teams that manage Boards — see the
section below.

---

## Azure DevOps Boards (optional)

For teams that track work in Azure DevOps Boards, coop ships an optional
integration — nothing loads or runs unless you configure it.

- **In-session** — the auto-loaded **`azure-devops`** skill
  ([`skills/azure-devops/SKILL.md`](skills/azure-devops/SKILL.md)) answers
  "what's stale/unassigned for `<team>`?", creates and updates work items
  (**confirm-first** — coop-guardrails flags any work-item write), and runs the
  weekly per-client digest. It uses the Entra-authenticated REST API, plus the
  optional read-only `azure-devops` MCP entry generated from `~/.coop/config`.
- **Batch entry points** — paired bash/PowerShell launchers over a stdlib-only
  Python core:
  - `scripts/ado-digest.sh` / `scripts/ado-digest.ps1` — a read-only, per-client
    watchdog digest (open / stale / unassigned) with Markdown/HTML output and
    optional Graph email (schedulable, e.g. from a Windows VM's Task Scheduler —
    see the skill).
  - `scripts/ado-onboard.sh` / `scripts/ado-onboard.ps1` — guided, read-only
    client discovery that writes only the local config.
- **Config** — all client identifiers (org, project, people, mailboxes) live
  **only** in the private `~/.coop/devops/clients.yml`, seeded from
  [`config/devops.clients.example.yml`](config/devops.clients.example.yml)
  (placeholders only — never commit real values to a repo).

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
7. MCP is read-only.
8. Never expose secrets.

**Audit trail.** Every guardrail decision the runtime `coop-guardrails` extension makes —
a blocked source commit, or a confirmed/declined destructive command, secret-file access,
live row/production read, or mutating MCP call — is appended as one JSON line to
`$PI_CODING_AGENT_DIR/guardrails-audit.jsonl` (default `~/.coop/agent/…`). Each line records
the timestamp, working folder, kind, decision, and the offending path(s) or a truncated
command — **never secrets or file contents** (the secret gate logs only the matched path).
Run `/coop-guardrails` in a session to see the last ~10 decisions and the log path; the log
rolls to `.jsonl.1` past ~1 MB. It's the reviewable record of "the agent tried X; a human
said yes/no" — useful for client trust and for debugging a guardrail false positive.

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
10. If `logging.require_task_log` is enabled, use `daily-logger` and append to the
    configured daily log before the final response.
11. Commit docs/logs/site **only with approval**; never commit source.

On non-trivial work the skill adds a few habits — vertical slices, codifying
repeated corrections, and applying review feedback as Markdown annotations — with
four prompts to drive them: **`/spec-first`** (an approved spec before editing),
**`/annotate`** (apply only annotated changes), **`/handoff`** (a resume-cold
summary), and the **`git-helper`** skill / **`/pr-description`** (draft a commit
message + PR description from the diff — drafts only, never commits).

The single source of truth for repo paths, workspaces, standards, backup/log rules,
and the approval policy is the project contract `.coop/project.yml`. Copy
[`.coop/project.example.yml`](.coop/project.example.yml) into your work repo's
`.coop/project.yml` and replace every `TODO`.

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

## Standalone tools

coop wraps three standalone, advisory, **read-only** tools (installed via pipx;
also exposed as the native LLM tools `sql_review` / `dax_review` / `data_doc`):

- **`coop-data-doc`** — progressive SQL and/or Power BI documentation, lineage, and machine-readable
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

coop can use the **official Microsoft agent skills**, but they are **subordinate to
Cooptimize skills**: yours always win. Two sources are supported:

- [`github.com/microsoft/skills`](https://github.com/microsoft/skills) — Azure SDK /
  AI-Foundry / KQL / Microsoft Docs skills (MIT).
- [`github.com/microsoft/skills-for-fabric`](https://github.com/microsoft/skills-for-fabric)
  — Power BI and Fabric authoring skills (PBIR, TMDL/DAX, SQL, KQL, notebooks,
  pipelines, deployment) (MIT).

A Microsoft skill is surfaced only if it is **allow-listed** in its source block
(`microsoft_skills.allow[]` or `fabric_skills.allow[]`) **and** does not conflict
(by folder name or frontmatter `name:`) with one of ours — conflicts are skipped
with a warning.

```yaml
microsoft_skills:
  source: "https://github.com/microsoft/skills"
  load_dir: "skills/_microsoft"
  allow:
    - "kql"
    - "microsoft-docs"

fabric_skills:
  source: "https://github.com/microsoft/skills-for-fabric"
  load_dir: "skills/_microsoft_fabric"
  allow:
    - "check-updates"
    - "powerbi-report-design"
    - "powerbi-report-planning"
    - "powerbi-report-authoring"
    - "powerbi-report-management"
    - "semantic-model-authoring"
    - "eventhouse-cli"
    - "sqldw-authoring-cli"
    - "sqldw-consumption-cli"
    - "dataflows-cli"
    - "e2e-medallion-architecture"
    - "spark-authoring-cli"
    - "fabriciq"
    # Add when needed:
    # - "sqldw-operations-cli"
    # - "deployment-pipelines-authoring-cli"

```

`coop install` automatically installs the npm tools these skills need
(`@microsoft/powerbi-report-authoring-cli`, `@microsoft/powerbi-modeling-mcp`, and
`@microsoft/powerbi-desktop-bridge-cli` on Windows). Remote Fabric MCP servers
(FabricIQ, Fabric Warehouse SQL endpoint) require org-specific URLs/tokens — see
`skills/_microsoft/README.md`.

Fabric authoring skills may edit PBIR, TMDL, SQL, KQL, notebooks, and Fabric item
definitions. They remain governed by the Cooptimize workflow: plan-and-approve
before edits, back up, review, show the diff, and **never commit source** — a human
reviews and commits.

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
coop update          # updates Pi + Pi extensions + Coop tools + vibes/skills, then runs doctor
coop update --check  # dry-run: show current / latest / tested versions — installs NOTHING
coop sync            # re-sync vibes/powerline + place the read-only MCP config (non-destructive)
coop doctor          # re-check dependencies and configuration at any time
```

`coop update` keeps Pi, its extensions, and the standalone tools current, then runs
`coop doctor` so you immediately see anything left to fix.

**Fleet pinning.** `coop update` has exactly two fleet modes. **Normal** mode pins Pi,
every extension, and all tools to the exact versions in the release manifest — no registry
queries and no prompts. `--edge` is the only latest/upstream mode: it takes newest upstream
across the fleet, and `coop doctor` reports any component that drifts from the manifest.
Use `coop update --check` first to see what an update *would* do before telling the team to
run it.

**One update voice.** Coop suppresses Pi and managed-extension self-update notices and
blocks `context-mode`'s `ctx_upgrade` shortcut so a component cannot drift away from the
tested fleet. The daily **coop-agent is behind** notice remains: it is the safe prompt to
run `coop update`, which advances the whole manifest together. Maintainers debugging an
upstream release can temporarily restore upstream notices and `ctx_upgrade` with
`COOP_SHOW_UPSTREAM_UPDATE_NOTICES=1`.

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
.\bin\coop.cmd install        # creates %LOCALAPPDATA%\coop\bin\coop.cmd and adds it to your user PATH; open a new terminal if coop isn't found yet
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

### CI gates for your repos

The three suite tools double as CI gates: SQL review (with SARIF PR annotations),
DAX review, and the lineage-docs freshness + strict-rebuild check. Copy-paste
pipelines for **GitHub Actions and Azure DevOps** — flags, exit codes, artifact
publishing, version pinning — are in **[docs/ci.md](docs/ci.md)**.

### Making it your own / extending it

Coworkers can add their own skills, prompts, themes, and tools — see
**[docs/extending.md](docs/extending.md)**. In short: a new skill is just a
`skills/<name>/SKILL.md` file; a new prompt is a `prompts/<name>.md`; both load
automatically on the next `coop`. Commit, push, `coop update` — everyone has it.

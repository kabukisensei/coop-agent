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

On macOS/Linux, `coop install` links `coop` into `~/.local/bin`; that directory must
be on `PATH`. On Windows it installs `%LOCALAPPDATA%\coop\bin\coop.cmd`, adds that
directory to the user `PATH`, and requires a new terminal before the change appears.
If `coop` is not found on macOS/Linux, add this to your shell rc and open a new shell:

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
- **Azure CLI** (`az`) — *optional* — https://learn.microsoft.com/cli/azure (auto-installed via `winget` / `brew` / `apt` if missing; used for Fabric, Power BI, Azure DevOps, and the Warehouse Doctor probe — local SQL/DAX review works without it)
- **Tabular Editor CLI (`te`)** — *optional* — https://tabulareditor.com/product/features-and-tools/tabular-editor-cli (cross-platform CLI that runs Best Practice Analyzer rules on semantic models; requires a Tabular Editor account during the preview — place `te` in `~/.local/bin` or your `PATH`, then run `te auth login` once)

Automatic prerequisite setup handles **missing** tools; it does not upgrade every incompatible
installation already present. If Doctor reports Node below 22.19 or Python below 3.10, upgrade
it and rerun install. The Windows Store Python alias is not treated as an interpreter.

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
- `--no-fabric` — skip installing the Microsoft Fabric CLI (partial/diagnostic setup; a fresh machine will not pass full Doctor readiness until `fab` is installed)
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

**No-terminal first-time setup (for non-technical members).** Prefer a Git clone, then
have them double-click **`Install coop.cmd`**. A zip/shared-drive copy is suitable only
for a one-time or offline install: `coop update` can update its tools but **cannot update
the Coop repo layer** (skills, prompts, scripts, themes, or guardrails). Replace such a
copy with a Git clone and rerun `.\bin\coop.cmd install`; `~/.coop` settings are preserved.

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
| **Pi extensions** — `pi-mcp-adapter` (MCP), `pi-hermes-memory` (memory), `pi-better-openai` (plan usage limits), `pi-web-access` (web search/fetch — read-only), `@juicesharp/rpiv-ask-user-question` (structured questions) | installed via `pi install` into coop's isolated agent dir (`~/.coop/agent`) |
| **Coop companion extensions** — `coop-powerline` (footer/splash/vibes), `coop-tools` (native `sql_review`/`dax_review`/`data_doc`/`bpa_review` + workflow prompts), `coop-profile`, `coop-guardrails` (policy enforcement) | shipped in this repo, loaded at launch via `pi -e` (nothing to install) |
| **Standalone tools** — `coop-data-doc`, `coop-sql-review`, `coop-dax-review` | installed via `pipx` from PyPI |
| **`fabric-cicd`** (deployment validation) | a Python **library** (no CLI), injected into the Fabric CLI's env via `pipx inject ms-fabric-cli fabric-cicd` |
| **Microsoft Fabric CLI** (`ms-fabric-cli` → `fab`) | installed via `pipx` |
| **Power BI authoring tools** — Report Authoring CLI, Power BI Modeling MCP, and Windows-only Desktop Bridge | installed globally from manifest-pinned npm packages; Doctor requires Report Authoring and validates Modeling MCP arguments |
| **Managed MCP entries** — `fabric`, `fabric-sqlendpoint`, `powerbi`, `powerbi-modeling-mcp`, `azure-devops`, `microsoft-learn` | generated from Coop config with release-manifest pins; npm-backed servers use `npx`. Power BI Modeling is also installed globally. `context-mode` is a native Pi extension, not MCP. |

> `pi-powerline-footer` is **not** used. coop renders its own footer and splash via
> `extensions/coop-powerline` (see [Footer & splash](#footer--splash)).

**Not auto-installed (optional, external):**

- **Tabular Editor CLI (`te`)** — the cross-platform Tabular Editor CLI (no `npm`/`pip`
  package). Install it yourself, run `te auth login` once, and set
  `tools.tabular_editor_cli.executable_path` in `.coop/project.yml` if you want
  semantic-model BPA. coop works without it.
- **Azure CLI** (`az`) — optional, for Fabric, Power BI, Azure DevOps, and Warehouse
  Doctor authentication. Install from Microsoft if your team uses live integrations.

---

## Commands

Anything after `coop` that is not a known subcommand is passed straight to Pi
(e.g. `coop -c` resumes the last session; `coop @notes.md "review this"`).

| Command | Description |
| --- | --- |
| `coop` | Launch the branded Pi agent (skills, prompts, theme, guardrails, splash) |
| `coop doctor [--fix] [--json] [--publish]` | Check dependencies/configuration; optionally apply safe fixes, emit JSON, or publish a fleet snapshot to `fleet.publish_dir` |
| `coop update [--check] [--edge] [--yes] [--no-fabric]` | Converge the fleet to the release manifest and run Doctor. `--check` changes nothing; `--edge` deliberately takes upstream latest; `--pi-latest` is deprecated |
| `coop support [--json] [--incident] [--export PATH]` | Offline Support Center: sanitized diagnostics, incident timeline, preview/export, and standards status; works without Pi/model availability |
| `coop onboard [--edit|--config-only|--reset|--json]` | Configure profile and managed integrations without launching the agent |
| `coop profile [--edit|--reset|--json]` | Inspect or update the private user profile |
| `coop context-budget [--json]` | Inspect the active model/context budget |
| `coop uninstall [--keep-tools] [--yes]` | Remove the launcher/shortcuts/user-PATH entry and isolated agent dir; by default also uninstall Pi, pipx tools/Fabric CLI, Power BI Report Authoring CLI, Power BI Modeling MCP, and the Windows Desktop Bridge. `--keep-tools` preserves all managed npm/pipx tools. Never touches repo clones, work repos, the rest of `~/.coop`, or personal `~/.pi/agent` |
| `coop install [--edge] [--force] [--yes] [--no-prereqs] [--no-fabric]` | Fresh-install/bootstrap (idempotent). Normal mode uses manifest pins; `--edge` deliberately takes upstream latest. With a source arg, alias of `coop add` |
| `coop web` | Open a friendly browser UI over the same governed agent (experimental; loopback-only + one-time token — see `web/README.md`) |
| `coop bootstrap` | Same bootstrap as bare `coop install` |
| `coop sync` | Ensure core Pi extensions are installed, place the governed MCP config non-destructively, refresh managed catalogs/team knowledge, and verify brand assets |
| `coop data-doc [args]` | Run `coop-data-doc` (default: `build`) and summarize outputs |
| `coop sql-review [args]` | Pass through to `coop-sql-review` (e.g. `check <paths>`, `rules`) |
| `coop dax-review [args]` | Pass through to `coop-dax-review` (e.g. `check <paths>`, `rules`) |
| `coop review [paths...] [--strict] [--skip-docs] [--compare] [--diff [ref]] [--html]` | Run **both** linters over one scope (explicit paths win; else the nearest `.coop/project.yml`'s `repositories.*.local_path` entries — never a blind cwd scan), save both JSON reports under `.coop/reviews/` next to the contract, then rebuild the lineage docs with the findings composed in (`coop-data-doc build --reviews …`). Docs not set up is a hint, not a failure; `--skip-docs` runs the linters only; `--strict` passes `--strict` to both linters and exits 2 if either exits non-zero. `--compare` diffs against the previous run's report. `--diff [ref]` runs the review only on files changed since `ref` (default: `HEAD`) in git-tracked roots. `--html` emits a unified HTML suite report. |
| `coop fabric [args]` | Pass through to the Microsoft Fabric CLI (`fab`) |
| `coop version` | Print `coop` + `pi` versions |
| `coop help` | Show usage |
| **Authoring** | |
| `coop init [dir] [--seed-docs] [--template] [--ci github|ado] [--yes]` | Guided minimal project-contract wizard (default `.`); `--template` explicitly selects the full legacy template and `--seed-docs` generates/patches `coop-data-doc.yml` |
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
the exit code propagates. Both reviews are **advisory by default** — they never edit, and findings do not change
the default exit code; usage/tool errors and `--strict` propagate nonzero status.
The AI agent gets machine-readable JSON through the four native `sql_review` / `dax_review`
/ `data_doc` / `bpa_review` tools (in `extensions/coop-tools`), independent of these passthrough
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

## Managed MCP integrations (optional)

Coop can generate six managed entries through `pi-mcp-adapter`. They are **read-only
first**, not read-only-only, and all are optional. `context-mode` is installed separately
as a native Pi extension and is deliberately excluded from generated MCP configuration.

| Server | Provides | Enablement and policy |
| --- | --- | --- |
| `fabric` | Manifest-pinned Microsoft Fabric MCP | follows the active Azure CLI login; metadata reads by default, mutations approval-gated |
| `fabric-sqlendpoint` | Microsoft-managed Fabric SQL endpoint over direct Streamable HTTP with a launch-time Azure CLI bearer token | every call approval-gated; valid project IDs select an item-scoped endpoint; with no explicit target, global; malformed explicit targets fail closed |
| `powerbi` | `powerbi-mcp-server --readonly` | requires a configured tenant; server-enforced read-only |
| `powerbi-modeling-mcp` | Microsoft Power BI Modeling MCP with `--start --readonly` | no tenant/workspace required; server-enforced read-only |
| `azure-devops` | Manifest-pinned Azure DevOps MCP for one organization | requires enabled toggle + valid organization; mutations approval-gated |
| `microsoft-learn` | `learn.microsoft.com/api/mcp` | requires only its enabled toggle; always-current Microsoft docs |

`coop onboard` writes versioned `~/.coop/config`; `coop sync` deterministically generates
COOP-managed entries in `~/.coop/agent/mcp.json` while preserving unmarked user-owned
servers. Generated config stores no OAuth token. The Azure DevOps MCP organization lives
in `~/.coop/config`; batch digest client/project/team/recipient records live separately in
private `~/.coop/devops/clients.yml`.

**Approval boundary.** Dev/test metadata reads proceed by default. Row reads, production
access, mutation-looking MCP actions, and **every Warehouse SQL call** require explicit
approval; approval-required calls fail closed when no UI is available. Warehouse SQL is
classified as `row-data` or `ddl-dml-destructive`: bounded `SELECT`-style reads still ask,
while DDL/DML, permissions, `SELECT … INTO`, and `COPY INTO` receive mutation-specific
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
environment; no token is written to `mcp.json`, argv, or disk. Doctor never initiates
login and performs only a bounded metadata initialization and `tools/list` probe.

Warehouse Doctor states are exact: `registered` (target/auth/tool proof passed),
`auth_required` (no usable existing token), `tool_missing` (no compatible SQL tool),
`target_invalid` (malformed or mismatched target), and `unavailable` (missing config,
network/protocol failure, or unusable response). Other MCP checks are primarily
presence/config checks; Power BI Modeling also verifies `--start --readonly`.

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
- **Batch entry points** — paired bash/PowerShell launchers over a stdlib-only
  Python core:
  - `scripts/ado-digest.sh` / `scripts/ado-digest.ps1` — a read-only, per-client
    watchdog digest (open / stale / unassigned) with Markdown/HTML output and
    optional Graph email (schedulable, e.g. from a Windows VM's Task Scheduler —
    see the skill).
  - `scripts/ado-onboard.sh` / `scripts/ado-onboard.ps1` — guided, read-only
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
stale last-known-good → bundled SQL/DAX fallback → unavailable**. A project override is
the effective authority when configured; Coop does not silently claim it is canonical.

Launch performs a bounded, fail-soft refresh. Each task receives an immutable standards
snapshot, and native reviewers bind to the same authority so prompt guidance and tool
results cannot drift mid-task. Provenance or integrity failures reject a candidate rather
than partially applying it. Run **`/standards-status`** to inspect effective authority,
generation, freshness, and fallback state. Canonical sources and integrity metadata live
in `config/standards-registry.json`.

---

## Standalone tools

coop wraps three standalone pipx tools and exposes four native LLM tools:
`sql_review`, `dax_review`, `data_doc`, and optional/config-driven `bpa_review`.
The review tools are read-only; `data_doc build` writes generated documentation.

- **`coop-data-doc`** — progressive SQL and/or Power BI documentation, lineage, and machine-readable
  output. `scan` → `graph.json`; `build` → `manifest.json` + Markdown docs + a
  portal site; `lineage <object>` → one object's upstream/downstream + relationships
  as JSON. Other verbs: `check`, `init`, `setup`, `update`, `upgrade`. coop consumes
  these natively through the `data_doc` tool (including `command="lineage"`) — see
  [Lineage-grounded edits](#lineage-grounded-edits) below.
- **`coop-sql-review`** — advisory T-SQL standards linter.
  `coop-sql-review check <paths...> --format json [--min-severity error|warning|info] [--strict]`
- **`coop-dax-review`** — advisory DAX standards linter (same shape as sql-review).

The review tools are **advisory by default**: they never edit files, and findings do
not change the default exit code. Usage/tool errors and `--strict` can return nonzero.

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

## Official Microsoft Skills Catalog

coop can use the **official Microsoft agent skills**, but they are **subordinate to
Cooptimize skills**: yours always win. The allowed upstream paths and revisions are
pinned in [`config/microsoft-skills.json`](config/microsoft-skills.json):

- [`github.com/microsoft/skills`](https://github.com/microsoft/skills) — Azure SDK /
  AI-Foundry / KQL / Microsoft Docs skills, pinned at
  `903dc62b1e4c833235b54db918a9a51cb6d3cc8f`.
- [`github.com/microsoft/skills-for-fabric`](https://github.com/microsoft/skills-for-fabric)
  — Fabric Warehouse authoring/consumption skills from v0.3.10, pinned at
  `28f29abf3838e13f63a38e8664042b7d9f7cd69c`.

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

Baseline enables `kql`, `microsoft-docs`, `sqldw-authoring-cli`, and
`sqldw-consumption-cli`. `sqldw-operations-cli` is recorded as deferred metadata
and is not fetched or launched by default. Legacy `source` and `load_dir` fields
are ignored with migration notices in `coop doctor`.

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

---

## Support Center and fleet health

`coop support [--json] [--incident] [--export PATH]` collects sanitized local diagnostics,
standards status, and a bounded incident timeline without network access or model/Pi
availability. It sanitizes before persistence, retains the newest 200 events and 10 default
bundles, and exports a bundle by default for escalation.

Set `fleet.publish_dir` in private Coop config, then run `coop doctor --publish` to write a
per-host/user JSON snapshot. Aggregate snapshots with:

```bash
scripts/fleet-digest.sh --format md          # add --send or --dry-run
```

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\fleet-digest.ps1 --format md
```

The digest flags failures, warnings, and stale check-ins and can render Markdown/HTML or
send through Microsoft Graph when configured.

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
coop update          # converge to the tested release manifest, then run Doctor
coop update --check  # dry-run core tool status; changes nothing
coop update --edge   # deliberately take latest upstream, then report manifest drift
coop sync            # refresh governed MCP/catalog/team-knowledge/assets non-destructively
coop doctor          # re-check dependencies and configuration
coop support --incident  # export a sanitized escalation bundle
```

`coop update` keeps Pi, its extensions, standalone tools, and a Git-backed Coop repo
current, then runs Doctor. Tracked local repo changes cause the repo pull to be skipped;
untracked files do not. On Windows, a running Coop/Pi process causes the Pi update to be
skipped and returns nonzero—close every Coop/Pi window and rerun. A zip/shared-drive copy
can update tools but never the repo layer; replace it with a Git clone and rerun
`.\bin\coop.cmd install`. Private `~/.coop` settings are preserved.

**Fleet pinning.** `coop update` has exactly two fleet modes. **Normal** mode pins Pi,
every extension, and all tools to the exact versions in the release manifest — no registry
queries and no prompts. `--edge` is the only latest/upstream mode. Use `--check` before rollout; it reports Pi, pipx tools, and authoring npm tools,
but does not enumerate managed Pi extensions or the injected `fabric-cicd` library.

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

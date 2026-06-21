# Cooptimize Agent — Architecture

`coop` is a **branded layer on top of Pi** (`@earendil-works/pi-coding-agent`). It
is **not a fork**. `bin/coop` is a thin bash dispatcher that launches `pi` with
Cooptimize skills, prompts, theme, a governance system prompt, and companion
extensions, and shells out to the standalone Coop tools and the Microsoft Fabric
CLI. Everything Cooptimize-specific lives in this repo and is layered onto a
stock Pi install — so Pi can be updated underneath `coop` without merge pain.

## Isolation

coop runs Pi against its own agent dir (`~/.coop/agent`; override with
`COOP_AGENT_DIR`) via the `PI_CODING_AGENT_DIR` env var, so only Cooptimize's
curated extensions/settings/theme/MCP load — your personal `pi` (its extensions,
themes, splash) stays untouched. Your login (auth/models) is shared in from
`~/.pi/agent`; settings/extensions/MCP are isolated. Provisioned by
`coop install`/`coop sync`. Disable with `COOP_NO_ISOLATE=1`.

## Layers

1. **`coop` (orchestrator).** `bin/coop` resolves `COOP_ROOT`, sources
   `lib/common.sh`, exports `PI_CODING_AGENT_DIR` to point Pi at coop's isolated
   agent dir (`~/.coop/agent`; see **Isolation** above), optionally runs an
   Azure / Power BI token preflight, then `exec pi …` with the branded resources
   attached. It also dispatches the
   subcommands (`doctor`, `update`, `install`/`bootstrap`, `sync`, `data-doc`,
   `sql-review`, `dax-review`, `fabric`, `version`, `help`) and aliases Pi
   management (`coop list/config/add/remove/pi`) so `coop` is the only command a
   user types. Any unknown subcommand or flag is passed straight through to `pi`.

2. **Pi (engine).** The actual coding agent: conversation loop, tool execution,
   sessions, MCP wiring, extension host. `coop` never modifies Pi; it configures
   it at launch via flags (`--append-system-prompt`, `--skill`,
   `--prompt-template`, `--theme`, `-e <extension>`).

3. **Cooptimize resources loaded into Pi at launch** (see `bin/coop` →
   `launch_pi`):
   - **Guardrails system prompt** — `docs/guardrails.md`, *appended* (not
     replacing Pi's prompt): read-only-first, plan-and-approve, never commit
     source, MCP read-only, never expose secrets.
   - **Skills** — `skills/`, including `coop-workflow` (the principles-first
     Cooptimize workflow) and a subordinate, allow-listed set of official Microsoft
     skills under `skills/_microsoft/`.
   - **Prompt templates** — `prompts/`.
   - **Theme** — `themes/cooptimize.json` (brand palette: navy `#00416B`,
     forest `#42783C`, olive `#82AA43`, lime `#B2D235`, red `#EF412D`).
   - **`coop-powerline` extension** — `extensions/coop-powerline/`: coop's OWN
     footer and splash, plus working "vibes" (`COOP_VIBES_DIR`,
     `COOP_SPLASH_FILE` are exported for it). coop does **not** use a third-party
     powerline footer (pi-powerline-footer was removed: its welcome overlay
     couldn't be disabled, Nerd Font glyphs showed as `?`, and it duplicated the
     bar). The footer shows `⬢ Cooptimize · <branch>` on the left and
     `<model> · ctx N% · tokens · $cost · <plan usage limits>` on the right, in
     plain text + common Unicode (no Nerd Font glyphs). It surfaces other
     extensions' status text (e.g. pi-better-openai's plan usage limits /
     5h+7d windows) via `footerData.getExtensionStatuses()`, so everything is in
     one clean bar. The splash is the truecolor block-art Cooptimize logo
     (uniform-padded, width-robust; `assets/splash.ansi`).
   - **`coop-tools` extension** — `extensions/coop-tools/`: registers the native
     LLM-callable tools `sql_review`, `dax_review`, `data_doc` that shell out to
     the standalone CLIs and return JSON the model reasons over; also hosts the
     in-agent `coop-data-doc` setup wizard (`/setup-docs`).
   - **`coop-guardrails` extension** — `extensions/coop-guardrails/`: **enforces**
     governance at runtime via a `tool_call` hook (blocks the agent committing
     source; confirms destructive commands). Complements the advisory
     `docs/guardrails.md` system prompt. Fail-open; `COOP_NO_GUARDRAILS=1` disables.

4. **Pi extensions installed from npm** into coop's isolated agent dir
   (`config/defaults.yml`):
   - `pi-mcp-adapter` — wires the read-only MCP servers.
   - `pi-hermes-memory` — persistent memory, session search, secret scanning.
   - `pi-better-openai` — plan usage limits (5h / 7d windows), surfaced in
     coop's own footer via `footerData.getExtensionStatuses()`.
   - `pi-web-access` — web search, URL fetch, GitHub clone, PDF/YouTube/video
     understanding (read-only; complements the Microsoft Learn MCP).
   - `@juicesharp/rpiv-ask-user-question` — lets the model put a structured,
     typed-option question to the user instead of guessing (fits consent rounds).
   - Optional: `pi-permissions` (finer per-tool permission gating). *(`@aliou/pi-guardrails`
     was dropped — pinned to the deprecated Pi and superseded by `coop-guardrails`.)*

   `pi-powerline-footer` is **not** used — coop renders its own footer/splash via
   `extensions/coop-powerline` (see layer 3).

5. **Standalone tools** (pipx, on PyPI) — invoked two ways: by the `coop`
   subcommands and by the native `coop-tools` extension, both via CLI with the
   exact contracts in [`tool-contract.md`](./tool-contract.md):
   - `coop-data-doc` — SQL + Power BI documentation and lineage.
     `scan` → `graph.json`; `build` → `manifest.json` + Markdown docs + portal.
   - `coop-sql-review` — advisory T-SQL standards linter
     (`check <paths> --format json`). Never edits or blocks.
   - `coop-dax-review` — advisory DAX standards linter (same shape).

6. **Microsoft platform tooling:**
   - **`fab`** — the Microsoft Fabric CLI (`ms-fabric-cli`). `coop fabric …` is a
     pass-through. NOTE: a Homebrew `fabric` formula ships a *different* `fab`
     (Python SSH / Paramiko) — a real `PATH` collision that `coop doctor`
     detects and warns about.
   - **`fabric-cicd`** — a Python **LIBRARY** (no CLI). coop installs it via
     `pipx inject ms-fabric-cli fabric-cicd` so `fabric_cicd` is importable in the
     Fabric CLI's environment; it's used in deployment scripts (`import
     fabric_cicd`, **validate-only by default**), NOT as a `fabric-cicd` command.
     `coop doctor` checks it's importable. Deploy is an approval-gated action.
   - **Tabular Editor CLI** — optional, path-configured (mostly Windows), not
     auto-installed; set `tools.tabular_editor_cli.executable_path` in
     `.coop/project.yml`.

7. **Read-only MCP servers** (all optional; `coop` runs without them). Preloaded
   non-destructively into coop's isolated agent dir (`~/.coop/agent/mcp.json`) by
   `coop sync` from `config/mcp.example.json`:
   - `fabric` — `@microsoft/fabric-mcp` (AzureCliCredential).
   - `powerbi` — `powerbi-mcp-server --readonly`.
   - `microsoft-learn` — `learn.microsoft.com/api/mcp` via `mcp-remote`
     (always-current Microsoft docs).
   - `context-mode` — local.

   `coop` **never** performs write/create/update/delete/deploy/publish MCP
   actions without explicit approval, regardless of server capability.

## Diagram

```mermaid
flowchart TD
    user([User]) --> coop["coop (bin/coop)\nbranded layer / orchestrator — never a fork"]

    coop -- "subcommands:\ndoctor · update · install · sync\ndata-doc · sql-review · dax-review · fabric" --> subs[[coop subcommands]]
    coop -- "exec pi --append-system-prompt --skill\n--prompt-template --theme -e …" --> pi["Pi\n@earendil-works/pi-coding-agent"]

    subgraph LAYER["Cooptimize layer (this repo)"]
      guard["guardrails.md\n(system prompt)"]
      skills["skills/\ncoop-workflow\n+ _microsoft/*"]
      prompts["prompts/"]
      theme["themes/cooptimize.json"]
      ext_pl["ext: coop-powerline\ncoop's OWN footer · splash · vibes\n(no pi-powerline-footer)"]
      ext_tools["ext: coop-tools\nsql_review · dax_review · data_doc"]
    end

    pi --> guard
    pi --> skills
    pi --> prompts
    pi --> theme
    pi --> ext_pl
    pi --> ext_tools

    subgraph PIEXT["Pi extensions (npm, into ~/.coop/agent)"]
      mcpad["pi-mcp-adapter"]
      mem["pi-hermes-memory"]
      bopenai["pi-better-openai\nplan usage limits (5h/7d)"]
    end
    pi --> PIEXT
    bopenai -. "status via getExtensionStatuses()" .-> ext_pl

    subgraph TOOLS["Standalone tools (pipx) — CLIs + the fabric-cicd library"]
      datadoc["coop-data-doc\nscan→graph.json\nbuild→manifest.json + docs + portal"]
      sqlrev["coop-sql-review\ncheck --format json (advisory)"]
      daxrev["coop-dax-review\ncheck --format json (advisory)"]
      fab["fab (Microsoft Fabric CLI)\n⚠ Homebrew 'fab' collision → doctor"]
      cicd["fabric-cicd (LIBRARY, no CLI)\npipx inject ms-fabric-cli fabric-cicd\nimport fabric_cicd · validate-only"]
      te["Tabular Editor CLI\noptional · path-configured"]
    end
    subs --> datadoc
    subs --> sqlrev
    subs --> daxrev
    subs --> fab
    ext_tools --> datadoc
    ext_tools --> sqlrev
    ext_tools --> daxrev

    subgraph MCP["Read-only MCP (optional)"]
      fmcp["fabric"]
      pmcp["powerbi --readonly"]
      lmcp["microsoft-learn"]
      cmcp["context-mode"]
    end
    mcpad --> MCP

    classDef ro fill:#eef,stroke:#00416B
    class MCP,fmcp,pmcp,lmcp,cmcp ro
```

## Governance flow

Every task that touches SQL, DAX, Fabric objects, semantic models, reports, docs,
or lineage runs through the **`coop-workflow` skill** (principles-first), enforced by the
`guardrails.md` system prompt: read context (`.coop/project.yml` + standards) →
scope and impact → read target + lineage (`data_doc`) → **PLAN + explicit
approval** → timestamped backup → smallest safe edit → review
(`sql_review` / `dax_review`, plus Tabular Editor BPA / `fabric-cicd` validate
where relevant) → diff + summarize → update docs/glossary/lineage and regenerate
the site → append to the daily log → **commit docs/logs/site only with approval;
never commit source**.

The project contract `.coop/project.yml` (copied from
`.coop/project.example.yml`) is the single source of truth for repo paths,
Fabric/Power BI workspaces, standards locations, backup/log rules,
allowed/blocked commit paths, and the approval policy.

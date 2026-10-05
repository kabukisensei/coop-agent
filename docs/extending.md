# Extending coop — custom skills, prompts, themes, and tools

coop is a thin layer over Pi, so **everything Pi can be extended with, coop can
too** — and your team's additions live in this repo, version-controlled and shared
the moment you push. Nothing here requires forking Pi or coop.

At launch, `bin/coop.ps1` loads, from this repo:

| What | Where | How it's loaded |
|------|-------|-----------------|
| Skills | `skills/<name>/SKILL.md` | each first-party folder auto-loaded, then the client's `.coop/skills/` and your `~/.coop/skills/` (section 8); Microsoft skills come from the pinned catalog launch slot |
| Prompt templates | `prompts/<name>.md` | whole folder via `--prompt-template`; the client's `.coop/prompts/` and your `~/.coop/prompts/` follow it (section 8) |
| Theme | `themes/cooptimize.json` | registered via `--theme`; a user picks it in `/settings` |
| Guardrails prompt | `docs/guardrails.md` | via `--append-system-prompt` (advisory; the `coop-guardrails` extension enforces it) |
| Companion extensions | `extensions/coop-*/` (`coop-powerline`, `coop-tools`, `coop-guardrails`, `coop-profile`) | via `pi -e` |
| Vibes | `vibes/*.txt` | read by `coop-powerline` |

So adding a capability is usually just **adding a file and committing it**.

> **Isolation:** coop runs Pi against its own agent dir (`~/.coop/agent`; override with
> `COOP_AGENT_DIR`) via the `PI_CODING_AGENT_DIR` env var, so only Cooptimize's curated
> extensions/settings/theme/MCP load — your personal `pi` stays untouched. The same
> applies to the management aliases: `coop add` and the `coop new-*` scaffolders operate
> on coop's isolated dir / this repo, not your global `~/.pi/agent`. Disable with
> `COOP_NO_ISOLATE=1`. The rest of the profile (`config`, `user.json`, `support/`,
> `standards/`) sits beside it in `~/.coop`; `COOP_DIR` is the **parent** of `.coop`
> and moves all of it (`COOP_DIR=X` → `X\.coop`, agent dir `X\.coop\agent` unless
> `COOP_AGENT_DIR` is set). An extension needing one of these paths imports
> `../../lib/paths.mjs` (`profileDir`, `configPath`, `userProfilePath`, `agentDir`)
> instead of building them from `homedir()`.

---

## 1. Add a custom skill (most common)

Fastest path — let coop scaffold it:

```bash
coop new-skill lakehouse-naming-review   # creates skills/lakehouse-naming-review/SKILL.md
```

Then edit the generated `SKILL.md`. Or do it by hand — a skill is just a folder with
a `SKILL.md`:

```bash
mkdir -p skills/lakehouse-naming-review
cat > skills/lakehouse-naming-review/SKILL.md <<'MD'
---
name: lakehouse-naming-review
description: Review Fabric Lakehouse table/column naming against Cooptimize conventions.
---

# Lakehouse Naming Review

Use this when reviewing names in a Fabric Lakehouse.

## Checklist
- bronze tables keep source names; silver uses PascalCase business entities; gold is report-friendly.
- surrogate keys end in `Key`; date keys are `yyyymmdd` ints.
- no reserved words; no spaces.

## Output
- Pass/fail by table, findings by severity, suggested renames (advisory — never auto-rename).
MD
```

That's it — next time anyone runs `coop`, the skill is available. It automatically
operates under the `coop-workflow` and the guardrails (read-only-first,
plan-and-approve, never commit source). Reference it from a prompt or just ask the
agent to "use the lakehouse-naming-review skill."

> Keep skills **advisory and read-only** to match Cooptimize governance. If a skill
> needs to run a tool, point it at the native tools (`data_doc`, `bpa_review`) or
> `fab` / `fabric-cicd` (validate-only). For SQL/DAX standards there is no tool to
> call: the active coop-standards articles are already in context, so a skill asks
> the agent to write to them and self-check its diff against them (fixing what does
> not meet them; a deviation needs a user exception or a stated reason). `bpa_review` called without explicit paths auto-scopes to the
> nearest `.coop/project.yml`'s `power_bi.semantic_models` entries — see
> [docs/tool-contract.md](tool-contract.md).

## 2. Add a prompt template (a `/slash` command)

Scaffold with `coop new-prompt <name>`, or write one by hand. Prompt templates are
Markdown with `{{placeholders}}`:

```bash
cat > prompts/sprint-review.md <<'MD'
# Sprint Review

Use the `coop-workflow` skill.

Summarize this sprint's analytics-engineering work for {{repo_or_area}}.
1. Read the daily logs under docs/agent/logs/daily.
2. Group changes by object and layer (bronze/silver/gold/model/report).
3. List validations run (standards self-check / BPA / fabric-cicd) and open risks.
4. Write a short summary to docs/agent/logs/{{sprint}}.md. Do not commit without approval.
MD
```

It shows up as a prompt/command in Pi automatically. (Daily/weekly logging already
ships — see the `daily-logger` skill and the `/daily-log` and `/weekly-log` prompts.)

## 3. Add or tweak the theme

Pi's `--theme <path>` only **registers** a theme file; it does not select it. The
active theme is the `theme` key in `~/.coop/agent/settings.json` (set from
`/settings`) or `--use-theme <name>` for one run, and coop never sets it, so new
users get Pi's automatic `dark` / `light` theme until they pick `cooptimize` in
`/settings`. To ship your own:

1. Copy `themes/cooptimize.json` and give the copy a new `name` (Pi keeps the
   first theme with a given name, and coop registers its file first, so a copy
   still called `cooptimize` is dropped).
2. Change the `vars` (brand colors live there).
3. Either load it with `coop --theme path/to/theme.json` and pick it in
   `/settings`, run `coop --theme path/to/theme.json --use-theme <name>` for a
   single session, or drop the file in `~/.coop/agent/themes/`.

Editing `themes/cooptimize.json` in place restyles the team theme for everyone who
has already selected it.

## 4. Add a native tool or UI feature (a Pi extension)

For real logic (new LLM-callable tools, footer/splash tweaks, event hooks), write a
Pi extension in TypeScript. Use the four in `extensions/` as templates
(`coop-profile`, the fourth, is a small `before_agent_start` hook that injects the
local user profile; the other three are below):

- `extensions/coop-tools/index.ts` — registers `data_doc` / `bpa_review` /
  `fabric_sql_query` with `pi.registerTool(...)`. Copy the pattern to wrap another CLI. The
  `data_doc` tool takes `command` = `scan` / `build` / `check` / `lineage` / `impact`
  (`lineage` lists one object's up/downstream + relationships, `impact` what changed
  files feed). Pi gives the model a tool's `content` text only, never `details`, so
  put what the model needs in the text. It also shows the event
  hook: `before_agent_start` — only when BUILT docs exist — injects an agent-visible,
  human-hidden (`display: false`) note so coop consults the lineage before touching
  an object. Missing docs stay silent; setup is explicitly launched with
  `/setup-docs` or the `/start` menu.
- `extensions/coop-powerline/index.ts` — coop renders its **own** footer and splash
  here (it does **not** use a third-party powerline footer; `pi-powerline-footer` was
  removed). The splash is the truecolor block-art Cooptimize logo; the footer shows
  `⬢ Cooptimize · <branch>` on the left and
  `<model> · ctx N% · tokens · $cost · <plan usage limits>` on the right,
  in plain text + common Unicode (no Nerd Font glyphs). It pulls other extensions'
  status text — e.g. pi-better-openai's plan usage limits (5h+7d windows) — into the
  one bar via `footerData.getExtensionStatuses()`. To extend the footer, surface your
  extension's own status string the same way rather than adding a second bar; to tweak
  the splash/footer rendering itself, edit this extension. It also wires rotating
  feature tips and easter eggs (`setWorkingMessage`) and the `/coop-vibe` / `/coop-splash` commands
  (`pi.registerCommand`).
- `extensions/coop-guardrails/index.ts` — runtime **enforcement** of the governance
  rules (`docs/guardrails.md` only *asks* the model; this hooks the agent's tool calls
  and blocks/confirms): never commit source outside docs/logs/site, confirm destructive
  commands (`rm -rf`, `git push --force`, `reset --hard`, `git clean -f`, `DROP`/`TRUNCATE`),
  and confirm reads/writes of secret files. Approval-required actions fail closed headlessly; disable
  with `COOP_NO_GUARDRAILS=1`. It only ever intercepts the **agent's** tool calls — your
  own shell is untouched.

To load a new companion extension, either drop it in `extensions/<name>/` and add a
`-e` line in `bin/coop.ps1`, or install a published one with
`coop add npm:<package>`. `coop add` runs `pi install` against **this user's**
isolated `~/.coop/agent` only. To ship an npm extension to the whole team, pin it
in the `extensions` object of `config/release-manifest.json` and run
`node lib/extlock.js generate`; `coop sync` / `coop update` then install it on
every machine.

Full Pi extension API reference: run `coop pi --help`, and see the bundled examples
under the Pi package's `examples/extensions/` (the patterns coop's extensions follow).

## 5. Scaffold a work repo (`coop init`)

Skills and prompts lean on the project contract — `.coop/project.yml`, the one
committed team file at the client's Git root — for repo paths, workspaces, and
standards. Scaffolding a new work repo is
two commands:

```bash
coop init                 # scaffolds .coop/project.yml (from .coop/project.example.yml)
coop init --seed-docs     # then, once repositories: is filled — generates a matching
                          # coop-data-doc.yml from the contract's repositories: paths
```

`coop init --template` copies the documented template into `<Git root>/.coop/project.yml`
(a contract found above the folder is edited, never shadowed by a second copy);
plain `coop init` runs the safe guided wizard, and `coop onboard --edit` owns global
integration/MCP settings. Verify with `coop doctor`. `coop init --seed-docs` generates/patches `coop-data-doc.yml`
from the contract's `repositories:` (via `coop-data-doc config-set`), so repo
paths are typed once.

## 6. The official-Microsoft-skills slot (subordinate)

The pinned Microsoft skills catalog is **subordinate to your skills**:

- [github.com/microsoft/skills](https://github.com/microsoft/skills)
  (Azure SDK / AI-Foundry / KQL / Microsoft Docs).
- [github.com/microsoft/skills-for-fabric](https://github.com/microsoft/skills-for-fabric)
  (the full Fabric skill set: Warehouse and SQL database, Eventhouse/KQL,
  Eventstream, Activator, Spark, Dataflows, pipelines, Power BI reports and
  semantic models, OneLake governance, migrations), shipped with its shared
  `common/` reference tree.

The catalog covers Fabric only: `sqldw-cli` is the Warehouse and Lakehouse SQL
skill and `sqldb-cli` the Fabric SQL database one. For Azure SQL Database and
Synapse serverless targets (`azure_sql`, `synapse_serverless` in `sql_targets:`)
no Microsoft skill applies; the resolved SQL standards (fed into context at
launch) and the `coop-workflow` guidance are the authority there.

A Microsoft skill loads only if the pinned manifest, current project policy, and
conflict checks all allow it. Fabric authoring skills may edit source files, but
they still fall under the coop-workflow guardrails: plan approval, backups,
review, diff summary, and human commit.

Refresh with `coop sync`; launch uses the local last-known-good catalog and never
networks. See `skills/_microsoft/README.md`.

## 7. The team-knowledge slot (subordinate)

Coop can load shared team skills and patterns from one or more external team knowledge repositories (such as `cooptimize/incremental-bi`).

Configuration lives in `~/.coop/config` under the `knowledge` block:

```json
{
  "schema_version": 1,
  "knowledge": {
    "enabled": true,
    "repos": [
      {
        "url": "https://github.com/cooptimize/incremental-bi.git",
        "local_path": "~/.coop/knowledge/incremental-bi"
      }
    ]
  }
}
```

- **Sync**: `scripts/sync-knowledge.ps1` clones missing local paths and fast-forwards clean checkouts during `coop sync` and `coop update`. Offline or unauthenticated runs fail soft (warn and continue). Dirty checkouts are preserved and never reset.
- **Skills launch slot**: If the local clone contains `skills/*/SKILL.md`, `bin/coop.ps1` appends `--skill <dir>` to the Pi launch spec. Like the Microsoft drop-in slots, this is **subordinate**: if a team skill name or frontmatter name conflicts with a first-party Cooptimize skill in `skills/`, the Cooptimize skill wins and the team skill is skipped.
- **Recall**: The `team-knowledge` skill guides the agent to query team patterns via the bundled local-search helper (`scripts/search-knowledge.py`, repository-bound, structured JSON status) before non-trivial work, and injects a hidden startup note when knowledge is available.
- **Contributing learnings**: Draft discoveries with `/share-learning`, which generates a YAML frontmatter note under the user-selected clone's `learnings/` and routes publication via a plain Git pull request. Never commit directly to main.
- **TeamAI trial (K1)**: an optional `knowledge.teamai` block (`enabled`, `team_repo`, `provider`, `role`) turns on the isolated `teamai-cli` adapter (`lib/teamai.py`, reached only through `coop teamai`, see `README.md`). It is a second read-only source for the `team-knowledge` skill, not a replacement for the local search; the skill consults it only when `coop teamai status` reports `ok`. Sharing into that repository goes through `/share-learning` and `coop teamai contribute` (preview, then `--approve` stages a `coop/learning/...` branch for a pull request); the CLI's own publish and push are never used. With `knowledge.teamai.skills` true (K3), the team repository's `skills/*/SKILL.md` load at launch through the same subordinate slot as the knowledge repos' skills (a Cooptimize skill wins any name or folder clash; `coop teamai skills` lists them); `coop teamai maintenance` and `coop teamai compare --query <text>` are read-only reports.

---

## 8. Where prompts and skills live: three tiers

A prompt or skill does not have to live in this repository. coop loads three
tiers at every launch, in this order, and a name clash resolves in the same
order: the shipped copy wins, then the client's, then yours.

| Tier | Prompts | Skills | Who sees it | Scaffold |
|------|---------|--------|-------------|----------|
| shipped | `prompts/<name>.md` (this repo) | `skills/<name>/SKILL.md` (this repo) | everyone, at the next release | `coop new-prompt <name>`, `coop new-skill <name>` |
| client | `.coop/prompts/<name>.md` beside the committed `.coop/project.yml` | `.coop/skills/<name>/SKILL.md` beside it | everyone working in that client repository (commit them with the contract) | `coop new-prompt <name> --client`, `coop new-skill <name> --client` (run inside the client repository) |
| personal | `~/.coop/prompts/<name>.md` | `~/.coop/skills/<name>/SKILL.md` | you, on this machine (`COOP_DIR` moves it with the rest of the profile) | `coop new-prompt <name> --personal`, `coop new-skill <name> --personal` |

How it works:

- `bin/coop.ps1` (`Get-CoopResourceTiers` in `lib/common.ps1`) passes one
  `--prompt-template` per tier, shipped first, and one `--skill` per skill folder
  in the same order. Pi keeps the first `/name` it loads and reports the later one
  as a collision; a skill whose folder name or frontmatter `name:` is already
  loaded by a higher tier is skipped at launch with a warning on stderr.
- The client tier exists only inside a repository with a committed contract
  (`coop init` or `/setup-project`); coop's own bundled `.coop/project.yml` never
  counts as a client. Team-knowledge skills (section 7) stay subordinate to all
  three tiers.
- `coop doctor` has a "Prompts and skills" section: one row per tier with its
  counts and folder, and a warning for every shadowed prompt or skill, naming the
  tier that won. Rename the lower copy, or delete the one you do not want.
- The `/` menu in the terminal shows Pi's own source tag for every entry; the
  tier is in `coop doctor`. The window's command palette (D1j) will show the tier
  beside each entry when it lands.

Promote a prompt or skill by moving the file up a tier: a personal prompt the
team adopts becomes a pull request against `prompts/` here; a client-specific one
is committed in the client repository's `.coop/`.

---

## Sharing changes with the team

Because skills/prompts/vibes/theme are just files in this repo, the workflow is:

1. Create the file (skill folder, prompt, etc.).
2. Test it locally with `coop`.
3. Commit and push (these are docs/config, safe to commit).
4. Teammates pick it up at the next release tag via `coop update` (maintainers:
   `coop update --edge`).

`coop update` keeps Pi, its extensions, and the standalone tools current at the same
time, so the whole team stays in sync with one command.

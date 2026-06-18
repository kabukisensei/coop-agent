# Extending coop — custom skills, prompts, themes, and tools

coop is a thin layer over Pi, so **everything Pi can be extended with, coop can
too** — and your team's additions live in this repo, version-controlled and shared
the moment you push. Nothing here requires forking Pi or coop.

At launch, `bin/coop` loads, from this repo:

| What | Where | How it's loaded |
|------|-------|-----------------|
| Skills | `skills/<name>/SKILL.md` | each folder auto-loaded (except the allow-listed `skills/_microsoft/`) |
| Prompt templates | `prompts/<name>.md` | whole folder via `--prompt-template` |
| Theme | `themes/cooptimize.json` | via `--theme` |
| Guardrails prompt | `docs/guardrails.md` | via `--append-system-prompt` |
| Companion extensions | `extensions/coop-*/` | via `pi -e` |
| Vibes | `vibes/*.txt` | read by `coop-powerline` |

So adding a capability is usually just **adding a file and committing it**.

> **Isolation:** coop runs Pi against its own agent dir (`~/.coop/agent`; override with
> `COOP_AGENT_DIR`) via the `PI_CODING_AGENT_DIR` env var, so only Cooptimize's curated
> extensions/settings/theme/MCP load — your personal `pi` stays untouched. The same
> applies to the management aliases: `coop add` and the `coop new-*` scaffolders operate
> on coop's isolated dir / this repo, not your global `~/.pi/agent`. Disable with
> `COOP_NO_ISOLATE=1`.

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
> needs to run a tool, point it at the native tools (`sql_review`, `dax_review`,
> `data_doc`) or `fab` / `fabric-cicd` (validate-only).

## 2. Add a prompt template (a `/slash` command)

Scaffold with `coop new-prompt <name>`, or write one by hand. Prompt templates are
Markdown with `{{placeholders}}`:

```bash
cat > prompts/weekly-log.md <<'MD'
# Weekly Log

Use the `coop-workflow` skill.

Summarize this week's analytics-engineering work for {{repo_or_area}}.
1. Read the daily logs under docs/agent/logs/daily.
2. Group changes by object and layer (bronze/silver/gold/model/report).
3. List validations run (sql_review / dax_review / fabric-cicd) and open risks.
4. Write docs/agent/logs/weekly/{{week}}.md. Do not commit without approval.
MD
```

It shows up as a prompt/command in Pi automatically.

## 3. Add or tweak the theme

Copy `themes/cooptimize.json`, change the `vars` (brand colors live there), and
either replace the file or load yours with `coop --theme path/to/theme.json`.

## 4. Add a native tool or UI feature (a Pi extension)

For real logic (new LLM-callable tools, footer/splash tweaks, event hooks), write a
Pi extension in TypeScript. Use the two in `extensions/` as templates:

- `extensions/coop-tools/index.ts` — registers `sql_review` / `dax_review` /
  `data_doc` with `pi.registerTool(...)`. Copy the pattern to wrap another CLI.
- `extensions/coop-powerline/index.ts` — coop renders its **own** footer and splash
  here (it does **not** use a third-party powerline footer). The splash is the
  truecolor block-art Cooptimize logo; the footer shows `⬢ Cooptimize · <branch>` on
  the left and `<model> · ctx N% · tokens · $cost · <plan usage limits>` on the right,
  in plain text + common Unicode (no Nerd Font glyphs). It pulls other extensions'
  status text — e.g. pi-better-openai's plan usage limits (5h+7d windows) — into the
  one bar via `footerData.getExtensionStatuses()`. To extend the footer, surface your
  extension's own status string the same way rather than adding a second bar; to tweak
  the splash/footer rendering itself, edit this extension. It also wires vibes
  (`setWorkingMessage`) and commands (`pi.registerCommand`).

To load a new companion extension, either drop it in `extensions/<name>/` and add a
`-e` line in `bin/coop` / `bin/coop.ps1`, or install a published one with
`coop add npm:<package>` (it persists in Pi's settings for everyone who installs).

Full Pi extension API reference: run `coop pi --help`, and see the bundled examples
under the Pi package's `examples/extensions/` (the patterns coop's extensions follow).

## 5. The official-Microsoft-skills slot (subordinate)

`skills/_microsoft/` holds the official Microsoft skills
([github.com/microsoft/skills](https://github.com/microsoft/skills)). They are
**subordinate to your skills**: a Microsoft skill loads only if it is allow-listed
in `microsoft_skills.allow[]` **and** doesn't conflict (by folder or frontmatter
name) with one of yours — on conflict, yours wins and the Microsoft one is skipped.
Fetch with `scripts/fetch-microsoft-skills.sh` (fetched skills are gitignored). See
`skills/_microsoft/README.md`.

---

## Sharing changes with the team

Because skills/prompts/vibes/theme are just files in this repo, the workflow is:

1. Create the file (skill folder, prompt, etc.).
2. `coop sql-review` / test it locally with `coop`.
3. Commit and push (these are docs/config, safe to commit).
4. Teammates run `coop update` (which `git pull`s coop-agent) and pick it up.

`coop update` keeps Pi, its extensions, and the standalone tools current at the same
time, so the whole team stays in sync with one command.

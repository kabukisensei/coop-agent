# coop-agent — agent context

This repository is **coop**, the Cooptimize terminal agent: a branded layer on top
of Pi (`@earendil-works/pi-coding-agent`). It is **not** a fork of Pi. coop runs Pi in
its own isolated agent dir (`~/.coop/agent`, via `PI_CODING_AGENT_DIR`) so only
Cooptimize's curated extensions/settings/theme/MCP load and your personal `pi` stays
untouched (disable with `COOP_NO_ISOLATE=1`). It renders its own footer and splash via
`extensions/coop-powerline` — no third-party powerline footer.

If you are an agent working in a Cooptimize work repo, you operate under the
Cooptimize guardrails and the Cooptimize workflow:

- **Guardrails:** `docs/guardrails.md` (read-only first, plan-and-approve, never
  commit source, back up before edits, never expose secrets, MCP read-only).
- **Workflow:** the `coop-workflow` skill — the Cooptimize workflow for any task.
  On non-trivial work: `/spec-first` (approved spec before editing), `/annotate`
  (apply only Markdown-annotated feedback), `/handoff` (resume-cold summary), and
  the `git-helper` skill / `/pr-description` (draft commit message + PR from the
  diff — drafts only, never commits).
- **Contract:** `.coop/project.yml` is the single source of truth (repo paths,
  Fabric/Power BI workspaces, standards, backup/log rules, approval policy). Read
  the nearest one before doing file work.

Native tools available: `sql_review`, `dax_review`, `data_doc` (advisory, read-only),
plus the Microsoft Fabric CLI (`fab` = ms-fabric-cli) and `fabric_cicd` (a validate-only
Python **library**, not a CLI — `import fabric_cicd` in deployment scripts), and
read-only Fabric / Power BI / Microsoft Learn MCP servers. Persistent memory is provided
by pi-hermes-memory.

`data_doc` wraps `coop-data-doc` with commands `scan` (default; builds the lineage
graph, read-only), `build` (also writes Markdown docs + portal, indexed by
`manifest.json`), `check` (CI staleness gate), and `lineage` (returns ONE object's
upstream/downstream + relationships as JSON from the built graph). **Lineage policy:**
BEFORE analyzing or changing any SQL object, DAX measure, or semantic model, look up
its lineage (`data_doc` with `command="lineage"`, `object="<name>"`) so you know its
up/downstream impact — don't re-derive it by hand. coop **auto-detects** built docs at
session start (a `before_agent_start` hook injects an agent-visible, human-hidden note
when they exist) and **degrades gracefully** when they're absent: lineage is an aid, not
a gate, so proceed without it and, if useful, suggest `/setup-docs`.

Official Microsoft skills (`skills/_microsoft/`) are **subordinate**: a Microsoft
skill loads only if allow-listed in `microsoft_skills.allow[]` and it does not
conflict with a Cooptimize skill — yours always win.

The in-agent `/setup-docs` command (and a `setup-docs` skill) runs a native wizard to
create or rebuild lineage docs for the current folder without leaving the session;
`coop-data-doc.yml` and the built docs are committable, source is never touched.

For setup and commands — including `coop install`'s automatic `PATH` linking
(it adds `~/.local/bin` / `%LOCALAPPDATA%\coop\bin` and prompts you to open a new
terminal) and `coop doctor`'s dependency checks — see `README.md`. For how coop calls
the standalone tools, see `docs/tool-contract.md`. To add custom skills/prompts/tools,
see `docs/extending.md`.

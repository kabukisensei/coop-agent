---
name: setup-docs
description: Native in-agent wizard to create or update coop-data-doc.yml and build the lineage docs entirely through the agent (no terminal). Uses ask-user-question for every choice and the coop-data-doc non-interactive commands (show-config, config-set, folders, set-folders, build). Read-only-first; writes the config and builds only with approval. Use on first run when a folder has no coop-data-doc.yml, or to change what's documented.
---

# Set up data docs (in-agent wizard)

## Purpose

Stand up `coop-data-doc` for a workspace **through the agent**, so a teammate's
first touch needs no terminal. The interactive terminal wizard (`coop data-doc
setup`) renders a folder checkbox with prompt_toolkit, which can't run as a
subprocess of the agent — so here the agent provides the UI via `ask-user-question`
and writes the config with coop-data-doc's non-interactive commands. The result is
identical: the same `coop-data-doc.yml`, the same build.

Run inside `coop-workflow`. Read-only-first: confirm before writing the config and
before building (consent rounds). Never commit source.

## The commands this skill drives (coop-data-doc ≥ 0.22)

- `coop-data-doc show-config [--config X]` → current config as JSON (or defaults +
  `"exists": false` when there's none). The shape `config-set` accepts.
- `coop-data-doc config-set [--config X]` ← a JSON **patch** on stdin; only the keys
  you send change, the rest are preserved; re-validated. Patch keys: `project_name`,
  `repos.{sql,powerbi}.{path,include,exclude}`, `output.{dir,site_dir}`,
  `layers.{bronze,silver,gold}.{schemas,paths}`, `schema_mappings:[{schema,model}]`,
  `ignore_schemas`, `sql_dialect`.
- `coop-data-doc folders [--config X]` → per repo: each top-level folder + a
  `documented` flag + any custom excludes. **Folders are only listed when the repo is
  cloned on disk.**
- `coop-data-doc set-folders --repo <sql|powerbi> --skip "Archive,BACKUP"` → mark the
  named folders as skipped (everything else documented), preserving custom excludes.
- `coop-data-doc init` → scaffold a starter `coop-data-doc.yml` when none exists.
- `coop-data-doc build --non-interactive` → build markdown + portal; leaves ambiguous
  cross-repo links unresolved (mapping those is the terminal/interactive path).

## Flow

1. **Inspect.** Read `.coop/project.yml` if present (it may already name the repo
   paths and standards). Run `coop-data-doc show-config` to see current values.
2. **Repo paths.** With `ask-user-question`, ask for the **SQL** and **Power BI** repo
   paths (prefill from project.yml / show-config when available). Each must be a
   **locally-cloned folder** — verify it exists; if not, ask the user to clone it (or
   give the right path) before continuing, because folder selection reads the disk.
3. **Write the base config.** If `show-config` reported `"exists": false`, run
   `coop-data-doc init` first. Then send a `config-set` patch with the repo paths
   (and project name / output dirs if the user wants non-defaults).
4. **Folder selection (per repo).** Run `coop-data-doc folders`. For each repo,
   present its `folders` as a **multi-select** with the currently-`documented` ones
   pre-checked: *"Which folders should the docs include? (uncheck to skip, e.g.
   backups/archives)."* Apply the unchecked set with
   `set-folders --repo <key> --skip "<comma-separated unchecked names>"`.
5. **Layers + mappings (optional).** Ask whether to assign medallion layers by schema
   (bronze/silver/gold) and whether any view schema feeds a specific semantic model;
   apply via `config-set` (`layers`, `schema_mappings`). Skipping is fine.
6. **Build (with approval).** Confirm, then `coop-data-doc build --non-interactive`.
   Show the portal path and the counts (objects / edges / unresolved). If there are
   **unresolved cross-repo links**, say so and offer either to resolve them in a
   terminal (`coop data-doc build`) or to come back to them.
7. **Hand off.** Point the user at the portal and note that from now on the agent will
   consult these docs for any object's lineage (see the `data_doc` guardrail / the
   `coop-data-doc lineage <object>` query).

## Guardrails

- **Read-only-first:** nothing is written until the user approves step 3 (config) and
  step 6 (build). Surface each as a clear `ask-user-question` consent round.
- **Folders need local repos:** if `folders` returns an empty list for a repo, the
  path isn't a cloned folder — fix that before picking folders (don't silently fall
  back to documenting everything).
- **Never commit source.** You may commit the generated docs/site only with approval.

## Output

A short summary: the repo paths set, which folders are documented vs skipped, any
layers/mappings configured, the build result (objects/edges/unresolved), and the
`file://…/index.html` portal link.

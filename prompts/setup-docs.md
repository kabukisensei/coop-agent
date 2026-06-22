# Set up data docs

Use the `setup-docs` skill to create or update this workspace's `coop-data-doc.yml`
and build the lineage docs **through the agent** — no terminal needed. Ask the user
at each decision point with `ask-user-question` (consent rounds), and stay read-only
until they approve writing the config / building.

Task: Set up (or update) coop-data-doc for this workspace, then build the docs.

Required steps:

1. Read `.coop/project.yml` if present (repo paths, standards). Run
   `coop-data-doc show-config` to see current settings (or sensible defaults if no
   `coop-data-doc.yml` exists yet).
2. Ask the user (`ask-user-question`) for the **SQL repo path** and **Power BI repo
   path**. Each must be a folder **cloned locally** — the folder picker can only list
   folders that are on disk. Confirm each path exists.
3. If there is no config yet, scaffold one (`coop-data-doc init`), then apply the
   repo paths with `coop-data-doc config-set` (JSON patch on stdin).
4. **Folders.** For each repo run `coop-data-doc folders` (JSON: each top-level
   folder + whether it's documented). Present a **multi-select** of those folders
   (everything pre-checked = documented) via `ask-user-question`, then apply the
   unchecked ones with `coop-data-doc set-folders --repo <sql|powerbi> --skip "A,B"`.
5. Optionally ask for **medallion layer schemas** (bronze/silver/gold) and any
   **view-schema → semantic-model** mappings; apply with `coop-data-doc config-set`.
6. With approval, **build**: `coop-data-doc build --non-interactive`. Report the
   portal path (`file://…/index.html`) and any **unresolved cross-repo links** — note
   that mapping the ambiguous ones is interactive: run `coop data-doc build` in a
   terminal, or offer to resolve them later.
7. Read-only first: confirm before writing the config and before building. Never
   commit source; you may commit generated docs/site only with approval.

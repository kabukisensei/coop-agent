# Set up data docs

Use the `setup-docs` skill to create or update this workspace's `coop-data-doc.yml`
and build the lineage docs **through the agent** — no terminal needed. The agent
launches `coop-data-doc setup --transport jsonl` and forwards each wizard prompt
through the agent UI (single-line, confirm, single-select, multi-select), sending
the answers back to the native wizard process.

Task: Set up (or update) coop-data-doc for this workspace, then build the docs.

Required steps:

1. Read `.coop/project.yml` if present (repo paths may already be configured).
   Confirm the installed `coop-data-doc` version supports `--transport jsonl`; if
   not, stop and tell the user to run `coop update`.
2. Launch `coop-data-doc setup --transport jsonl` as a subprocess. Forward each
   `prompt` event to the user through the agent UI, mapping the answer back to the
   prompt's `id` as JSONL on the process stdin.
3. Surface `notice`/`progress` events to the user. When the wizard emits
   `complete` or exits 0, the config is written.
4. With approval, **build**: `coop-data-doc build --non-interactive`. Report the
   portal path (`file://…/index.html`) and any **unresolved cross-repo links**.
5. If there are unresolved links, offer to map them **through the agent**: run
   `coop-data-doc resolve`, ask the user to pick each link's target (candidates +
   external + skip) with `ask-user-question`, pipe the decisions to
   `coop-data-doc resolve-apply`, then rebuild. Skipping is fine.
6. Read-only first: the wizard writes the config, not the agent; confirm before
   building. Never commit source; you may commit generated docs/site only with approval.

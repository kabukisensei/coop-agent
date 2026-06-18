# coop-agent — agent context

This repository is **coop**, the Cooptimize terminal agent: a branded layer on top
of Pi (`@mariozechner/pi-coding-agent`). It is **not** a fork of Pi.

If you are an agent working in a Cooptimize work repo, you operate under the
Cooptimize guardrails and the Cooptimize workflow:

- **Guardrails:** `docs/guardrails.md` (read-only first, plan-and-approve, never
  commit source, back up before edits, never expose secrets, MCP read-only).
- **Workflow:** the `coop-workflow` skill — the Cooptimize workflow for any task.
- **Contract:** `.coop/project.yml` is the single source of truth (repo paths,
  Fabric/Power BI workspaces, standards, backup/log rules, approval policy). Read
  the nearest one before doing file work.

Native tools available: `sql_review`, `dax_review`, `data_doc` (advisory, read-only),
plus the Microsoft Fabric CLI (`fab`), `fabric-cicd` (validate-only), and read-only
Fabric / Power BI / Microsoft Learn MCP servers. Persistent memory is provided by
pi-hermes-memory.

Official Microsoft skills (`skills/_microsoft/`) are **subordinate**: a Microsoft
skill loads only if allow-listed in `microsoft_skills.allow[]` and it does not
conflict with a Cooptimize skill — yours always win.

For setup and commands, see `README.md`. For how coop calls the standalone tools,
see `docs/tool-contract.md`. To add custom skills/prompts/tools, see
`docs/extending.md`.

# `_microsoft/` — official Microsoft skills (subordinate, opt-in)

This folder holds **official Microsoft agent skills**. They are wired to be
**subordinate to Cooptimize skills**: yours always win.

Two sources are configured in `.coop/project.yml`:

- [`github.com/microsoft/skills`](https://github.com/microsoft/skills) — Azure SDK
  / AI-Foundry / KQL / Microsoft Docs skills. Fetched into `skills/_microsoft/`.
- [`github.com/microsoft/skills-for-fabric`](https://github.com/microsoft/skills-for-fabric) —
  Power BI and Microsoft Fabric authoring skills (PBIR, TMDL/DAX, SQL, KQL,
  notebooks, pipelines, deployment). Fetched into `skills/_microsoft_fabric/`.

Both are fetched by `scripts/fetch-microsoft-skills.sh` into their configured
`load_dir`.

A Microsoft skill is surfaced by coop only when **all** of these are true:

1. it is **allow-listed** in its source block (`microsoft_skills.allow[]` or
   `fabric_skills.allow[]`) in `.coop/project.yml`, and
2. it does **not conflict** with a Cooptimize skill — by folder name *or* by
   frontmatter `name:`. On any conflict, coop **skips the Microsoft skill** and
   keeps ours (you'll see a `skipping Microsoft skill …` warning).

Empty `allow[]` (the default) loads **none** — matching Microsoft's own guidance to
"use skills selectively" and avoid context rot.

## Fetching

Fetched skills are **not vendored** into this repo (they're gitignored), so coop-agent
stays small and the Microsoft skills update independently. Pull the allow-listed,
non-conflicting ones with:

```bash
scripts/fetch-microsoft-skills.sh
```

It shallow-clones each source into `.cache/microsoft-skills` and
`.cache/microsoft-skills-for-fabric` (gitignored) and copies each allow-listed skill
into `skills/_microsoft/<name>/` or `skills/_microsoft_fabric/<name>/`.

## Required tooling for Fabric/Power BI authoring skills

The `skills-for-fabric` skills need extra tooling that `coop install` / `coop update`
will install automatically:

| Tool | Package | Used by |
|---|---|---|
| `powerbi-report-author` | `@microsoft/powerbi-report-authoring-cli` | `powerbi-report-authoring` — validate and edit PBIR files |
| `powerbi-desktop` | `@microsoft/powerbi-desktop-bridge-cli` | `powerbi-report-authoring` — reload Desktop, screenshots *(Windows + Power BI Desktop only)* |
| `powerbi-modeling-mcp` | `@microsoft/powerbi-modeling-mcp` | `semantic-model-authoring`, `powerbi-report-*` — edit semantic models / query metadata |

Install/update them manually if you skipped `coop install`:

```bash
npm install -g @microsoft/powerbi-report-authoring-cli @microsoft/powerbi-modeling-mcp
# Windows only, requires Power BI Desktop:
npm install -g @microsoft/powerbi-desktop-bridge-cli
```

`powerbi-modeling-mcp` is added to the example MCP config (`config/mcp.example.json`);
`coop sync` places it non-destructively into `~/.coop/agent/mcp.json`.

### Remote Fabric MCP servers

Some Fabric skills talk to **remote HTTP MCP servers** hosted by Microsoft Fabric
(rather than local packages). These cannot be auto-installed; you must add them to
your MCP config with a valid bearer token:

- **FabricIQ** — natural-language Q&A over Power BI reports (`fabriciq` skill).  
  URL: `https://api.fabric.microsoft.com/v1/mcp/fabricaihub/integrations/m365`  
  Header: `X-VARIANTS: Fabric.Routing.PowerBIDataExploration`  
  Token audience: `https://analysis.windows.net/powerbi/api`
- **Fabric Warehouse / SQL endpoint** — T-SQL execution (`sqldw-*` skills).  
  URL: provided by your organization / Microsoft Fabric tenant.

See the upstream [`mcp-setup/README.md`](https://github.com/microsoft/skills-for-fabric/tree/main/mcp-setup)
for the exact config shape. `coop doctor` will warn if the local `powerbi-report-author`
or `powerbi-modeling-mcp` tooling is missing; it does not check remote server URLs.

## Adding a Microsoft skill

1. Find the skill's folder name in the source (e.g. `kql` or `powerbi-report-authoring`).
2. Add it to the right `allow[]` block in `.coop/project.yml`
   (`microsoft_skills.allow[]` for `github.com/microsoft/skills`,
   `fabric_skills.allow[]` for `github.com/microsoft/skills-for-fabric`).
3. Run `scripts/fetch-microsoft-skills.sh`.
4. Run `coop` — it loads only allow-listed, non-conflicting skills.

## Guardrails

- Subordinate + opt-in: presence is never enough; a skill must be allow-listed and
  conflict-free to activate.
- Fabric/Power BI authoring skills may edit PBIR, TMDL, SQL, KQL, notebooks, and
  Fabric item definitions, but they still run under the Cooptimize guardrails
  (`docs/guardrails.md`) and the `coop-workflow` skill: read-only first,
  plan-and-approve before edits, back up, review, show the diff, and **never commit
  source**. A human at Cooptimize reviews and commits.
- MCP servers remain read-only by policy; any create/update/delete/deploy/publish
  action requires explicit approval.
- Only files inside `coop-agent` are managed here; the upstream Microsoft source is
  never modified.

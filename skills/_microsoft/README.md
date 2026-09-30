# Official Microsoft Skills Catalog

Official Microsoft skills are not vendored into this repository. `coop sync`
refreshes a pinned, immutable catalog under the effective Coop/Pi agent directory:

```text
catalogs/microsoft/generations/<generation>/
catalogs/microsoft/current.json
catalogs/microsoft/fetch-state.json
```

Launch reads only `current.json` and the local generation it points to. Launch does
not clone, fetch, or contact GitHub. If refresh is offline or unavailable, Coop
continues from the last-known-good catalog; if no catalog has ever been fetched, no
Microsoft skills load.

The only approved upstreams, exact commits, paths, and skill names live in
[`config/microsoft-skills.json`](../../config/microsoft-skills.json):

- `microsoft/skills` at `3495f50ae0d7b69dcb19c6922db9f80aab6cf79c`: `kql`,
  `microsoft-docs`.
- `microsoft/skills-for-fabric` v0.3.18 at
  `6c11ad58c25992e5d1435ce7cd80d217d5598a31`: all 25 `skills/*` folders
  (`sqldw-cli`, `sqldb-cli`, `eventhouse-cli`, `eventstream-cli`,
  `eventschemaset-cli`, `activator-cli`, `spark-cli`, `dataflows-cli`,
  `variable-library-cli`, `deployment-pipelines-authoring-cli`,
  `git-integration-operations-cli`, `onelake-catalog-govern-cli`,
  `azmon-mirroredcatalogs-operations-cli`, `search-consumption-cli`,
  `powerbi-report-cli`, `semantic-model-authoring`, `fabriciq`,
  `fabriciq-ontology-cli`, `project-osmos`, `e2e-fabric-cost-estimation`,
  `e2e-medallion-architecture`, `databricks-migration`, `hdinsight-migration`,
  `pipeline-migration`, `synapse-migration`), plus the shared `common/`
  reference tree they link by relative path.

Shared trees are declared under a repository's `shared` key and are published
at `<generation>/<name>` (for example `<generation>/common/COMMON-CLI.md`), so a
skill's `../../common/...` link resolves in the published layout exactly as it
does upstream. They carry the same content hash, symlink, and size checks as a
skill, and `verify_current` refuses a generation that ships a repo's skills
without its shared trees. Upstream's `mcp-setup/` guide is deliberately not
shipped: Coop registers and gates the Fabric MCP servers itself (`coop sync`).
`python3 lib/microsoft_skills.py check-refs` lists the relative links the current
generation cannot satisfy (advisory; the same list is stored in
`fetch-state.json` and counted in `coop doctor`).

## Project Policy

Project contracts select from the pinned catalog:

```yaml
microsoft_skills:
  policy: restricted
  allow:
    - "kql"
    - "microsoft-docs"

fabric_skills:
  policy: baseline
```

Policies are `baseline`, `restricted`, or `disabled`. Legacy `source` and
`load_dir` fields are ignored and reported as migration notices by `coop doctor`.
The compatibility script `scripts/fetch-microsoft-skills.sh` delegates to the same
catalog refresh path as `coop sync`; new docs and workflows should use `coop sync`.

Every Microsoft skill remains subordinate: it loads only when the current project
policy allows it and it does not conflict by folder or frontmatter `name:` with a
Cooptimize skill.

## Warehouse MCP

Fabric Warehouse SQL uses the managed direct HTTP MCP server registered as
`fabric-sqlendpoint`, distinct from the general Fabric MCP server. `coop sync`
generates a Streamable HTTP bearer entry that references
`COOP_FABRIC_MCP_TOKEN`; Coop obtains that token from the existing Azure CLI login
at launch and injects it only into the Pi child environment.

Global URL:

```text
https://api.fabric.microsoft.com/v1/mcp/dataPlane/sqlEndpoint
```

Item URL:

```text
https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/{workspaceId}/items/{itemId}/sqlEndpoint
```

Lakehouse item targets use `sqlEndpointProperties.id` for the SQL endpoint item id.
Coop does not place bearer tokens in MCP config or argv. `coop doctor` performs
bounded metadata/tool discovery and reports `registered`, `auth_required`,
`unavailable`, `tool_missing`, or `target_invalid`; it never executes SQL or starts
an interactive login. Every Warehouse SQL tool call remains approval-gated by the
guardrails.

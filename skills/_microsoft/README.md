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

- `microsoft/skills` at `903dc62b1e4c833235b54db918a9a51cb6d3cc8f`: `kql`,
  `microsoft-docs`.
- `microsoft/skills-for-fabric` v0.3.10 at
  `28f29abf3838e13f63a38e8664042b7d9f7cd69c`: `sqldw-authoring-cli`,
  `sqldw-consumption-cli`.
- `sqldw-operations-cli` is deferred metadata and is not fetched or launched by
  default.

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

Fabric Warehouse SQL uses the managed remote HTTP MCP server registered as
`fabric-sqlendpoint`, distinct from the general Fabric MCP server. `coop sync`
generates an `mcp-remote@0.1.38` entry with native OAuth:

```text
npx -y mcp-remote@0.1.38 <url> --transport http-only --silent
```

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

# <slug>-coop

The coop client home repository for **<client>**: the one place the team shares
what coop needs for this client.

| Folder or file | What it is |
| --- | --- |
| `.coop/project.yml` | the client's project file (the contract coop reads); edit it in coop's Project pane or with `/setup-project`, then "Share with the team" |
| `.coop/catalog/` | the committed dev catalog snapshot (`coop catalog snapshot`) |
| `data-docs/`, `coop-data-doc.yml` | the lineage docs coop-data-doc builds (`/setup-docs`); `.github/workflows/data-docs-check.yml` fails a push whose docs are older than the source |
| `.coop/skills/`, `.coop/prompts/` | the client's own skills and prompts |

The client's source repositories sit beside this one; the project file names
them by relative path (`../<repo>`). Open coop in this folder, or in any
repository it lists, and the project file is found.

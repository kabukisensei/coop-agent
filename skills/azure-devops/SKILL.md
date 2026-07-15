---
name: azure-devops
description: Manage Azure DevOps Boards from coop — answer "what's stale/unassigned for <team>?", create/update work items (confirm-first), and run the weekly per-client digest email. Uses the Entra-authenticated REST API (WIQL → workitemsbatch), NOT `az boards query`. All client identifiers live only in the private ~/.coop/devops/clients.yml, never in a repo.
---

# Azure DevOps

## Purpose

Give the team frictionless Azure DevOps Boards management without the web UI:

1. **Watchdog** — find work items assigned but untouched for N days (stale), and open
   items with no assignee (unassigned), scoped to a team's area path.
2. **Quick add/update** — create and update work items from natural language.
3. **Digest** — a weekly, per-client email of what's in flight, stale, and unassigned.

Read tools flow freely; **any work-item write is confirm-first** (coop-guardrails
flags the mutating tool/command). This skill is for interactive use *and* for driving
the batch tools (`scripts/ado-digest.py`, `scripts/ado-onboard.py`).

> **Confidentiality (hard rule).** Client org names, project names, people, and mailbox
> addresses live **only** in `~/.coop/devops/clients.yml`. Never write them into any
> repo file, commit, example, log committed to a repo, or test fixture — placeholders
> only. The digest *output* contains client data; it goes to stdout / email / the local
> state dir, never into a repo. See the coop confidentiality policy.

## Auth model

Entra (Azure AD), **no PAT needed for interactive use**. Mint a 1-hour bearer token
for the Azure DevOps resource and call `dev.azure.com` REST directly:

```bash
az account get-access-token \
  --resource 499b84ac-1321-427f-aa17-267ca6975798 \
  --query accessToken -o tsv
```

- The resource GUID `499b84ac-…975798` is Azure DevOps' fixed public audience id (not
  a secret). The token is accepted as `Authorization: Bearer <token>`.
- **Per-client tenants:** clients live in their own tenants. Switch with
  `az login --tenant <tenant-id>` before working a different client, or pass
  `--tenant <id>` to `az account get-access-token` if you already have an account there.
- **Headless / scheduled** runs use a per-client **PAT** (scope `vso.work`) in an env
  var `ADO_PAT_<KEY>` (uppercased client key), sent as HTTP Basic (`:<pat>` base64).
  When a client tenant allows it, prefer a **service principal** (`az login
  --service-principal` → same token flow). Config field `auth: pat | azcli | sp`.
- **Never** print, log, or persist a token/PAT. Redact `Authorization` in any debug.

## The REST two-step (do NOT use `az boards query`)

`az boards query --wiql` **silently returns empty** (exit 0, no rows) against real
projects where the same WIQL over REST returns thousands. Always use REST:

1. **WIQL → ids** — `POST {org}/{project}/_apis/wit/wiql?api-version=7.1&$top=20000`
   body `{"query": "SELECT [System.Id] FROM WorkItems WHERE …"}`. Hard error above ~20k.
2. **ids → fields** — `POST {org}/_apis/wit/workitemsbatch?api-version=7.1`
   body `{"ids": [...≤200...], "fields": [...]}`. Batch the id list at 200/call.

`scripts/ado_lib.py` already implements this (`AdoClient.wiql_ids` / `.work_items`) —
prefer calling the tools over hand-rolling REST.

`az boards work-item create` / `update` **do work fine** — only `query` is unreliable.

## WIQL patterns

Scope a team's backlog by **area path**, resolved from
`GET {org}/{project}/{team}/_apis/work/teamsettings/teamfieldvalues?api-version=7.1`
then `[System.AreaPath] UNDER '…'`. Real projects use **custom state names**
(`01-New`, `05-In UAT`, `Approved - Ready for CRP`, …) — never hardcode
`('Closed','Removed','Resolved')`; states are per-client config. Fetch valid states +
their category with `GET {org}/{project}/_apis/wit/workitemtypes/{type}/states`.

- **Stale** (assigned & untouched): `… AND [System.AssignedTo] <> '' AND
  [System.ChangedDate] < @Today - 14 AND [System.State] NOT IN (<open-excludes>)
  AND [System.State] NOT IN (<stale-excludes>)`.
- **Unassigned** (open, no owner): `… AND [System.AssignedTo] = ''`.
- **My items:** query with **all** of the current user's `ado_identities`
  (`[System.AssignedTo] IN (…)`), since a single authenticated identity misses items
  assigned to the person's other (e.g. `Ext-`) account. `@Me` alone is not enough.
- `ASOF '<date>'` for point-in-time; `@Today - N` for relative dates.

**Semantics caveat:** `System.ChangedDate` bumps on *any* edit — including a comment.
"Stale" here means **untouched** (no activity at all), not "no state progress." Say so
when you report stale items.

## Config — `~/.coop/devops/clients.yml` (private)

Schema and rules live in `config/devops.clients.example.yml` (placeholders). Key rules
the tools follow:

- **Grouping:** collapse every identity in a person's `ado_identities` to one row under
  `name` (merges guest `Ext-` and member accounts).
- **Creates/assignment:** always assign with `assign_to` (the primary identity's UPN) —
  never a display name, never a non-primary identity.
- **Primary varies per client:** at some clients the `Ext-` guest accounts are the live
  ones; at others the member accounts are. `ado-onboard` asks per person.
- **Hygiene:** items assigned to a **non-primary** identity are flagged
  ("assigned to inactive account") — they're invisible to that person's own queries.

Never overwrite an operator's real config; append with `ado-onboard --write`.

## Quick add / update (confirm-first)

Use the `az boards` write subcommands (or the MCP write tools). **These are mutations —
propose the exact command and let the guardrail confirm before running.**

```bash
az boards work-item create --org <org> --project "<project>" \
  --type "User Story" --title "<title>" \
  --assigned-to "<assign_to UPN>" --area "<area path>" --iteration "<iteration>"
az boards work-item update --org <org> --id <id> --fields "System.State=02-In Progress"
```

Always resolve `--assigned-to` from the person's `assign_to` UPN in config. For custom
fields pass `--fields "Ref.Name=value"`.

## Digest tool — `scripts/ado-digest.py`

Read-only against Azure DevOps. Config-driven, client-agnostic, stdlib-only (no
`requests`/`PyYAML` — it reuses coop's dependency-free YAML reader).

```bash
scripts/ado-digest.sh --client <key>              # dry run: prints a markdown digest
scripts/ado-digest.sh --client <key> --format html # HTML (Outlook-safe tables)
scripts/ado-digest.sh --send                       # email every enabled client via Graph
scripts/ado-digest.sh --rollup                     # + internal all-clients summary
scripts/ado-digest.sh --stale-days 21 --no-state   # override threshold; don't touch state
```

Per run it renders a summary strip (open/stale/unassigned per type, **deltas vs the last
run**), stale grouped by assignee (oldest first, 🆕 = newly stale, ⚠ inactive account),
and the unassigned backlog. Last-run counts + stale ids persist in
`~/.coop/devops/state/<key>.json` so the email stays actionable. It exits non-zero if
any client fails but continues the rest.

**Email** uses Microsoft Graph `POST /users/{sender}/sendMail` with an app-only token
from a dedicated **Cooptimize-tenant** Entra app (application permission `Mail.Send`,
**admin consent required — flag to Aaron**), restricted by an application access policy
to one shared mailbox. The secret is read from `$COOP_GRAPH_CLIENT_SECRET` (never a
file). No SMTP fallback in v1.

## Onboarding a new client — `scripts/ado-onboard.py`

Guided, **read-only** discovery (writes only the local config). Run it instead of
hand-authoring YAML, or drive it via flags:

```bash
scripts/ado-onboard.sh --key <key> --org https://dev.azure.com/<Org> \
  --project "<Project>" --team "<Team>" --auth azcli --tenant <id> --check   # compare/preview
scripts/ado-onboard.sh --key <key> … --write                                 # append + smoke test
```

It verifies auth, discovers org → project → team(s) and area paths, proposes
`open_states_exclude` (Completed+Removed categories) and `stale_states_exclude`
(Resolved category), discovers distinct assignees over ~180 days and groups duplicate
identities (fuzzy match ignoring `Ext-`), and — interactively — asks per person which
identity is **primary**, the `assign_to` UPN, and the digest `email`. `--check`
re-derives an existing client's facts to confirm discovery reproduces them (no write,
no duplicate). Natural-language trigger: "set up a new DevOps client."

## Scheduling (recommended: weekly Monday 07:00 local, `--send`)

**macOS/Linux (cron):**
```
0 7 * * 1  /path/to/coop-agent/scripts/ado-digest.sh --send >> ~/.coop/devops/digest.log 2>&1
0 8 * * 1  /path/to/coop-agent/scripts/fleet-digest.sh --send >> ~/.coop/fleet.log 2>&1
```

**Windows (Task Scheduler)** — call `scripts\ado-digest.ps1 --send` and `scripts\fleet-digest.ps1 --send` (the launcher passes flags through to Python verbatim, so use the double-dash `--send`, not `-send`). Minimal task XML:
```xml
<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><CalendarTrigger>
    <StartBoundary>2026-01-05T07:00:00</StartBoundary>
    <ScheduleByWeek><DaysOfWeek><Monday/></DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek>
  </CalendarTrigger></Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>pwsh.exe</Command>
      <Arguments>-File "C:\path\to\coop-agent\scripts\ado-digest.ps1" --send</Arguments>
    </Exec>
    <!-- Add a similar Action for scripts\fleet-digest.ps1 if scheduling the fleet digest here -->
  </Actions>
</Task>
```
The scheduled account needs an active `az login` (or the `ADO_PAT_<KEY>` env vars) and
`$COOP_GRAPH_CLIENT_SECRET`. A Windows VM Task Scheduler is the working assumption for
the long-term job.

## Power BI over Analytics OData (phase 3)

Richer trends come from the Analytics feed, one dataset **per client org** in that
client's own workspace (never mix client data):

- Feed: `https://analytics.dev.azure.com/{org}/{project}/_odata/v4.0-preview/WorkItems`
  (+ `WorkItemSnapshot` for historical trends). Auth in the service: PAT (Basic) or
  Entra; per-client credentials.
- Pages: open work by state/assignee, stale aging (days-since-change buckets),
  unassigned backlog, created-vs-closed trend, cycle time by iteration.
- Build with the semantic-model + report skills already in the toolchain and follow the
  standard Cooptimize report design gates. Optionally, Power BI **subscriptions** can
  email page snapshots per client as a complement to the digest (recipients need viewer
  access to that workspace).

## Tools used

- `scripts/ado-digest.py` (+ `.sh`/`.ps1` wrappers) — the digest workhorse (read-only ADO).
- `scripts/ado-onboard.py` (+ wrappers) — guided client onboarding (read-only ADO).
- `scripts/ado_lib.py` — shared auth/REST/WIQL/identity library (stdlib only).
- **azure-devops MCP** (`@azure-devops/mcp`, in `config/mcp.example.json`, domains
  `core work work-items search`) — interactive natural-language board queries; write
  tools are confirm-first.
- **Microsoft Learn MCP** — current Azure DevOps REST / WIQL / OData guidance.

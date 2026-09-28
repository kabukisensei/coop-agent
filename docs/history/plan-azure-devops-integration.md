# Plan: Azure DevOps integration (boards watchdog, quick-add, digest email, Power BI)

**Status:** implemented (2026-07-08) — kept as design history, not pending work. The
operational docs are the `azure-devops` skill (`skills/azure-devops/SKILL.md`) and the
script headers (`scripts/ado-digest.{sh,ps1,py}`, `scripts/ado-onboard.{sh,ps1,py}`,
`scripts/ado_lib.py`). Do not re-execute the steps below.
**Owner:** Aaron

## Goal

Give the team frictionless Azure DevOps Boards management from coop and automated
visibility, without logging into the web UI:

1. **Watchdog queries** — find (a) user stories/features assigned to someone but not
   updated in N days (default 14), and (b) open stories/features with no assignee.
2. **Quick add/update** — create and update work items from the terminal / natural
   language in coop.
3. **Weekly digest email** — per-client email to the right people showing what's
   in flight, what's stale, and what's unassigned.
4. **Power BI report** — richer trends over the Analytics OData feed (later phase).

## Verified facts (tested 2026-07-08 on a live client org — do not re-derive)

- `az` CLI 2.86.0 + `azure-devops` extension 1.0.6 installed and working on the Mac.
- **Entra auth works with no PAT** for interactive use:
  `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv`
  yields a 1-hour bearer token accepted by `dev.azure.com` REST APIs.
- Org discovery works via
  `GET https://app.vssps.visualstudio.com/_apis/profile/profiles/me` then
  `GET https://app.vssps.visualstudio.com/_apis/accounts?memberId={id}`.
- **`az boards query --wiql` silently returned empty (exit 0, no output) against a
  project where the same WIQL via REST returned 5000 items.** Build everything on
  the REST endpoints, not `az boards query`:
  - `POST {org}/{project}/_apis/wit/wiql?api-version=7.1` → work item IDs
    (add `&$top=...`; hard error above 20k results)
  - `POST {org}/_apis/wit/workitemsbatch?api-version=7.1` → fields for ≤200 IDs
    per call (batch the ID list)
- Team backlogs scope by **area path**; resolve a team's areas with
  `GET {org}/{project}/{team}/_apis/work/teamsettings/teamfieldvalues?api-version=7.1`
  and filter WIQL with `[System.AreaPath] UNDER '...'`.
- Real projects use **custom state names** (e.g. `01-New`, `02-In Progress`,
  `03-Resolved`, `05-In UAT`, `06-In Prod`, `Approved - Ready for CRP`). Hardcoded
  `('Closed','Removed','Resolved')` exclusion lists are wrong — states must be
  per-client config. Fetch valid states per work item type with
  `GET {org}/{project}/_apis/wit/workitemtypes/{type}/states?api-version=7.1`.
- The same human can appear as **two identities** (guest `Ext-First Last` and a
  member account). Digest grouping and email routing need an identity→email map.
- Work item types on the backlog of interest: `User Story` and `Feature`.

## Architecture — four deliverables

### A. Azure DevOps MCP server wired into coop (interactive, natural language)

Add Microsoft's official server (`@azure-devops/mcp`, GA, Node 20+) to
`config/mcp.example.json`:

```json
"azure-devops": {
  "command": "npx",
  "args": ["-y", "@azure-devops/mcp", "TODO-org-name"],
  "env": { "AZURE_TOKEN_CREDENTIALS": "AzureCliCredential" }
}
```

Notes for the implementer:
- The server takes the **org name** as an argument — one entry per client org the
  user works in; the real org names go in the user's local `~/.coop/agent`
  MCP config, never in this repo's example (use `TODO-org-name`).
- On the Mac, npx must resolve to the Homebrew Node toolchain
  (`/opt/homebrew/bin`), not `~/.hermes` — same pitfall as the other MCP entries.
- Work-item **write** tools (`wit_work_item_write`, comments, links) exist on this
  server. coop-guardrails already flags mutating tool names for confirmation;
  verify the create/update tools trigger the confirm prompt, and document in the
  skill that creates/updates are confirm-first. Read tools flow freely.
- Check whether the server supports a domains/read-only flag
  (see its README) and prefer enabling only `core`, `work`, `work-items`,
  `search` domains to keep the tool surface small.

### B. `azure-devops` skill + `ado-digest` script (batch, the workhorse)

**Skill** `skills/azure-devops/SKILL.md` teaching the agent:
- Auth model (Entra via `az login`, token minting command above; per-client
  tenants — `az login --tenant <id>` when switching clients).
- The REST two-step (WIQL → workitemsbatch) with the `az boards query` caveat.
- WIQL patterns: stale (`[System.ChangedDate] < @Today - N` + assigned + open
  states), unassigned, team scoping via area path, `@Me`, `ASOF`.
- The semantics caveat: `System.ChangedDate` bumps on *any* edit including
  comments; "stale" here means "untouched", not "no state progress".
- Config location and schema (`~/.coop/devops/clients.yml`, below) and the rule
  that client names/orgs/recipients live **only** there — never in repo files,
  logs committed to repos, or example configs (Cooptimize confidentiality policy).
- Quick-add/update via `az boards work-item create/update` (these subcommands
  work fine; only `az boards query` is unreliable) — with `--fields` for custom
  fields; creates/updates are confirm-first per guardrails.

**Digest tool** `scripts/ado-digest.py` (Python 3.11+, stdlib + `requests` +
`PyYAML` only), config-driven and client-agnostic:

1. Read `~/.coop/devops/clients.yml` (path overridable via `COOP_DEVOPS_CONFIG`).
2. For each enabled client: mint/obtain a token (see auth strategy), resolve team
   area paths, run three WIQL queries per configured work item type — open,
   stale, unassigned — then batch-fetch fields:
   `Id, Title, WorkItemType, AssignedTo, State, ChangedDate, IterationPath, AreaPath, Tags`.
3. Render one digest per client:
   - **Summary strip:** open / stale / unassigned counts per type, deltas vs the
     previous run (persist last-run counts in `~/.coop/devops/state/<client>.json`).
   - **Stale, grouped by assignee** (identity map applied, `Ext-`/member accounts
     merged), oldest first, each row linking to
     `{org}/{project}/_workitems/edit/{id}`.
   - **Unassigned**, oldest first.
   - **Newly stale since last run** flagged, so the email stays actionable rather
     than a repeating wall.
4. Output modes: `--format md|html`, `--send` (email), `--dry-run` (default:
   print, send nothing). HTML email must be simple table-based markup (Outlook).
5. Exit non-zero on auth/query failure per client but continue to the next client;
   summarize failures at the end.

**Email sending:** Microsoft Graph `POST /users/{sender}/sendMail` using a
dedicated Entra app registration in the **Cooptimize** tenant with application
permission `Mail.Send` (admin consent required — flag to Aaron), restricted with
an application access policy to one shared mailbox (e.g. `reports@...`). Client
secret read from env/OS keychain (`COOP_GRAPH_CLIENT_SECRET`), never from files
in a repo. Recipients come from each client's config block. Do **not** build
SMTP fallback in v1.

**Auth strategy for the digest (headless):**
- v1: per-client **PAT** (scope `vso.work`) in env vars named by config
  (e.g. `ADO_PAT_<CLIENTKEY>`), used as Basic auth password. PATs are pragmatic
  here because client orgs live in client tenants where we can't register
  service principals; note expiry dates in config comments.
- When a client tenant allows it, prefer a service principal added to their ADO
  org (`az login --service-principal` → Entra token). Config supports
  `auth: pat | azcli | sp` per client.

**Windows-first wrappers:** paired `scripts/ado-digest.sh` + `scripts/ado-digest.ps1`
(UTF-8 BOM on the .ps1, bash-3.2-safe) that locate Python and invoke the tool.
Scheduling: Windows Task Scheduler XML sample + a `launchd`/cron line in the
skill docs; recommended cadence weekly Monday 07:00 local, `--send`.

### C. Config schema — `~/.coop/devops/clients.yml` (private, never in any repo)

Ship `config/devops.clients.example.yml` in the repo with placeholder values only:

```yaml
defaults:
  stale_days: 14
  work_item_types: [User Story, Feature]
  digest_day: monday
sender:
  mailbox: reports@example.com
  tenant_id: TODO
  client_id: TODO          # Entra app with Mail.Send
clients:
  - key: clienta            # used in env var names, state files
    enabled: true
    org: https://dev.azure.com/ClientAOrg
    project: Project Name
    teams: [Team Name]      # empty = whole project
    auth: pat               # pat | azcli | sp
    tenant_id: TODO         # for azcli/sp auth
    open_states_exclude: [Closed, Removed, Resolved, Done]
    stale_states_exclude: []   # extra states that shouldn't count as stale (e.g. an "In Prod" state)
    people:                 # one entry per human; merges duplicate ADO identities
      - name: Jane Doe
        email: jane@client.com          # where digest mail about their items goes
        ado_identities: ["Jane Doe", "Ext-Jane Doe"]  # all display names seen in this org
        primary: Ext-Jane Doe           # the ACTIVE identity in this org (varies by
                                        # client — guest "Ext-" accounts are primary in
                                        # some orgs, member accounts in others)
        assign_to: jane.upn@clienttenant.com  # UPN passed to --assigned-to on creates
    recipients:
      to: [jane@client.com]
      cc: [team@cooptimize.com]
```

Rules the tools must follow:
- **Digest grouping:** group by person (any identity in `ado_identities` collapses
  to one row under `name`).
- **Creates/assignment:** always assign using `assign_to` (the primary identity's
  UPN) — never the display name, and never a non-primary identity.
- **"My work items":** query with all of the current user's `ado_identities`
  (`[System.AssignedTo] IN (...)` or one clause per identity), since "my" via the
  authenticated identity alone misses items assigned to the other account.
- **Hygiene signal:** if open items are assigned to a **non-primary** identity,
  flag them in the digest ("assigned to inactive account") — those are effectively
  invisible to the person's own queries and notifications.

The implementer seeds the real `~/.coop/devops/clients.yml` from the operator's
local notes (Aaron has pre-created it with the first client's verified values —
read it, don't overwrite it).

### C2. Client onboarding command (`ado-onboard`)

New-client setup must be a guided discovery flow, not hand-authored YAML. Add
`scripts/ado-onboard.py` (same conventions as the digest tool; also invocable
through the skill as a natural-language flow, e.g. "set up a new DevOps client"):

1. **Auth:** prompt for tenant (`az login --tenant <id>` if needed) or PAT; verify
   with the profile endpoint.
2. **Discover:** list accessible orgs (accounts API) → operator picks org →
   list projects → pick project → list teams
   (`GET {org}/_apis/projects/{project}/teams`) → pick team(s); resolve each
   team's area paths via `teamfieldvalues`.
3. **States:** fetch states per configured work item type
   (`.../workitemtypes/{type}/states`); each state carries a `category`
   (Proposed / InProgress / Resolved / Completed / Removed). Propose
   `open_states_exclude` = Completed + Removed categories and
   `stale_states_exclude` = Resolved-category states; operator confirms/adjusts.
4. **People:** query distinct `System.AssignedTo` from work items changed in the
   last ~180 days in the team areas, plus team membership. Group candidate
   duplicates by fuzzy display-name match **ignoring prefixes like `Ext-`**
   (also compare uniqueName local parts). For each person, ask the operator:
   which identity is **primary** (this varies per client — at some clients the
   guest `Ext-` accounts are the live ones), what `assign_to` UPN to use
   (default: the primary identity's uniqueName from the identity ref), and their
   digest `email`.
5. **Recipients + cadence:** prompt for to/cc lists and stale_days override.
6. **Write:** append the new client block to `~/.coop/devops/clients.yml`
   (create from the example if missing), then run the digest in `--dry-run` for
   the new client and show the result as a smoke test.

Onboarding is read-only against Azure DevOps; the only thing it writes is the
local config file.

### D. Power BI report over Analytics OData (phase 2)

- Feed: `https://analytics.dev.azure.com/{org}/{project}/_odata/v4.0-preview/WorkItems`
  (+ `WorkItemSnapshot` for trends). Auth in the Power BI service: PAT (Basic) or
  Entra; per-client credentials — one dataset per client org, kept in separate
  client workspaces so client data never mixes.
- Pages: open work by state/assignee, stale aging (days-since-change buckets),
  unassigned backlog, created-vs-closed trend, cycle time by iteration.
- Use the semantic-model and report skills already in the toolchain; follow the
  standard Cooptimize report design gates.
- Optional: Power BI **subscriptions** can email page snapshots per client as a
  complement to the digest (recipients need viewer access to that workspace).

## Phases & acceptance

**Phase 1 — skill + MCP (interactive).**
Skill file written; MCP example entry added; against a real client org (values
from the local config): natural-language "what's stale for <team>?" answers
correctly via MCP or REST; "create a user story titled X assigned to Y" produces
a confirm prompt then the item; verified item then deleted or clearly test-tagged.

**Phase 2 — digest tool + onboarding.**
`ado-digest.py --dry-run` produces a correct markdown digest for the seeded
client matching hand-run REST counts; people entries merge guest/member
identities and non-primary assignments are flagged; state files update; `--send`
delivers HTML email to a test recipient via Graph; paired .sh/.ps1 wrappers pass
a smoke run; example config committed, real config untouched and
gitignored-by-location. `ado-onboard.py` re-run against the existing client
reproduces its config block (discovery correctness check) without duplicating it.

**Phase 3 — Power BI.**
One client workspace has the report connected to the OData feed with scheduled
refresh; design-gate review passed; walkthrough note added to the skill.

**Ordering note:** Phase 1 and 2 are independent — parallelize if convenient.
Phase 3 depends only on config (Phase 2's schema) for org/project values.

## Guardrails & confidentiality (hard requirements)

- No client identifiers (org names, project names, people, mailbox addresses) in
  any repo file, commit, example config, or test fixture. Placeholders only.
  (A machine-local pre-commit sweep enforces this on the operator's machine —
  `~/.coop/hooks/confidential-sweep.sh` — but treat it as a backstop, not
  permission to be sloppy.)
- Work-item mutations are confirm-first in interactive use; the digest tool is
  read-only against Azure DevOps (it only reads work items and sends mail).
- Never print or persist tokens/PATs/secrets; redact `Authorization` headers in
  any debug logging.
- Do not commit anything — leave the working tree for Aaron's review (and sweep
  for client refs before he commits).

## Open questions for Aaron (defaults chosen; change if wrong)

1. Stale threshold 14 days, weekly Monday digest — confirm cadence.
2. Should items in late pipeline states (UAT / In Prod-style states) count as
   stale? Default here: excluded via `stale_states_exclude` per client.
3. One digest per client to client recipients + Cooptimize cc — or also an
   internal all-clients rollup to the Cooptimize team only? (Rollup is cheap to
   add; default: yes, internal rollup to cc list.)
4. Shared mailbox address for the sender, and who runs admin consent for the
   Graph app.
5. Where the scheduled job runs long-term (a Windows VM Task Scheduler is the
   working assumption).

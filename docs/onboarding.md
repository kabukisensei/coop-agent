# Onboarding — get `coop` running (~10 minutes)

`coop` is Cooptimize's terminal agent — a branded layer on Pi for our Microsoft
Fabric / Power BI / D365 / SQL / DAX work. It works **read-only first** and reviews
work **with you** before anything ships.

> coop runs in its own isolated agent dir (`~/.coop/agent`), so it stays separate from
> your personal `pi` — only Cooptimize's curated extensions/settings/theme/MCP load,
> and your own `pi` setup is untouched.

## 1. Prerequisites

`coop install` checks these first, in this order, and stops with the exact install
command for anything missing (full table: [README → Prerequisites](../README.md#prerequisites)):

1. Git
2. Node.js 22.19 or newer
3. Python 3.10–3.13 (3.12 recommended)
4. pipx
5. Azure CLI (`az`)
6. ODBC Driver 18 for SQL Server (live SQL; install offers it after the Fabric CLI)
7. Tabular Editor CLI (`te`), optional, for BPA reviews

Install the ✗ rows in order, open a new terminal, and run the command the installer
prints (on Windows, double-click **Install coop.cmd** again). Or run the
`--prereqs auto` command it prints to have coop run those commands for you.

## 2. Install

**Windows (PowerShell)**: teammates follow [Install coop on Windows](install-windows.md),
which gets the code at the newest release. The short form below starts on the head of
`main` until the next release:
```powershell
git clone <coop-agent-repo>; cd coop-agent
.\bin\coop.cmd install
```

> Use the `.cmd` shim — on stock Windows the `Restricted` execution policy blocks
> `.\bin\coop.ps1 install` with *"running scripts is disabled on this system"*.
> If you need the bare `.ps1` entry point, run it with an explicit bypass:
> `powershell -ExecutionPolicy Bypass -File .\bin\coop.ps1 install`

This installs Pi, its extensions, the Coop tools, and the Microsoft Fabric CLI, and
links `coop` onto your `PATH`. During a fresh interactive install, the short setup
asks for your name, communication preference, and whether Coop should connect to a
client Fabric/Power BI environment. Choose **yes** and finish the Azure sign-in,
usually a Microsoft sign-in window (Azure CLI falls back to a device code by itself
when it cannot open one). This
works with the standard Windows `az.cmd` install, including one under
`C:\Program Files (x86)`. Coop waits for it and detects the tenant (including
tenants without Azure subscriptions); when several tenants are signed in, you pick
the client one. If sign-in cannot complete, Coop offers a device-code retry.
Before the tenant step, Coop asks once whether this client runs on Fabric, Azure SQL,
or both (skipped when `coop install --platform <value>` already answered it). The
answer is saved as `client.platform` in `~/.coop/config` and is only a machine
default: an Azure SQL client gets the Fabric MCP servers off and the Fabric skills
off unless a repo's `.coop/project.yml` turns them on, and `coop doctor` treats a
missing Fabric CLI as optional. Change it with `coop onboard --platform <value>`.
Recommended integrations are then enabled automatically; run
`coop onboard --config-only` later for detailed choices.
As the final interactive step, Coop opens its model sign-in screen with
`/login openai-codex` already prepared. Press Enter, finish browser authentication
with your Cooptimize business account, and Coop returns to its final readiness
check automatically. Set `COOP_NO_MODEL_LOGIN=1` only for managed/non-interactive
installations that deliberately handle model credentials separately. **Open a new
shell afterward** so `coop` is found.

## 3. Verify

```bash
coop doctor
```

Green = ready; it tells you exactly what's missing. Add `--fix` (`coop doctor --fix`)
to auto-apply the safe remediations — re-sync extensions/MCP/assets and `pipx`-install
any missing Coop tools, then re-check. One known gotcha it may flag is the **`fab`
collision** — if your `fab` is Python Fabric's SSH tool instead of the Microsoft
Fabric CLI, follow doctor's one-line fix.

## 3.5 First launch — sign in (one time)

```bash
coop
```

The first interactive launch opens the **Start Here menu** of the seven common
workflows (standards check, impact trace, fix on dev with approval, document a
warehouse or model, start a client project, logs and handoffs, sign in or health).
Pick one, or press Esc for the plain prompt; `/start` opens it again any time and
later launches go straight to the prompt. The launch never runs the onboarding
wizard and nothing can stop it: with no profile yet, *Start a client project*
asks the name coop calls you by (or run `coop onboard`).

On a team VM where every client is its own Windows user, run
`coop onboard --machine` once from an elevated (Administrator) terminal: it writes
your name and communication preference to `%ProgramData%\coop\user.json`, and
every Windows user on that machine without a profile of its own starts from it
(a per-user `coop onboard` still wins, field by field). The machine file never
holds a client, tenant, workspace or contract; those stay in each client's
Windows user, and `coop doctor` says which file supplied your name.

Fresh interactive installation now performs this step at the end: Coop opens a
short sign-in-only screen with `/login openai-codex` in the editor. Press Enter,
complete the browser sign-in, and the installer resumes automatically. If the
installer could not use an interactive terminal, the first plain `coop` launch
prepares the same command instead. This choice has governance consequences:

- **Provider: OpenAI (Codex).** This is the provider Cooptimize's data-handling
  posture is built on.
- **Account: your Cooptimize business account — not a personal one.** The
  no-training-on-our-data terms attach to the **business** subscription; signing
  in with a personal account silently voids that protection. If you accidentally
  signed in with the wrong account, sign in again from inside the agent and pick
  the business account.

It's a **one-time** step. Once a credential is present, normal Coop launches do
not show or replace anything in the editor. The login is stored in coop's isolated
agent dir (`~/.coop/agent`) — and if you already use a personal `pi`, its existing login is
shared in from `~/.pi/agent` automatically (see
[README → Isolation](../README.md#isolation)), so you may not be prompted at all.
`coop doctor` shows **"Pi login present"** once it's done.

### Azure sign-in at launch

The first launch after onboarding may also open the Azure sign-in for the client
tenant, once and without a question: a browser page, or on Windows a sign-in
window. After that, a launch checks the Fabric and Power BI tokens (a success is
remembered for 30 minutes) and says nothing.

- The tenant comes from the project's `.coop/project.yml` `fabric.tenant_id`, else
  from `~/.coop/config` `azure.tenant_id` (saved by onboarding). With neither,
  launch skips Azure and `coop doctor` warns **"Azure sign-in: no client tenant
  configured"**. If you onboarded on Windows before this fix, no tenant was saved:
  run `coop onboard --config-only` once.
- Ctrl-C cancels the sign-in. If sign-in fails, is cancelled or takes longer than
  5 minutes, Coop prints one line with the exact command
  (`az login --tenant <id> --allow-no-subscriptions`) and starts anyway.
  Piped, scheduled, and other non-interactive launches never open a sign-in; they
  print the same line. A token check that times out or hits a network error never
  opens a sign-in either.
- `coop doctor` shows **"Azure sign-in: signed in to tenant <id>"**. Doctor only
  checks; it never signs in.
- Coop's own Fabric and SQL tokens (the Warehouse MCP and `fabric_sql_query`) are
  minted for the same tenant, so it does not matter that you are a guest there and
  your home tenant is az's default account. The general Fabric MCP
  (`@microsoft/fabric-mcp`) cannot be given a tenant by Coop: it uses az's default
  account, and `coop doctor` notes this on its `fabric` row.
- `COOP_SKIP_AZ=1` skips both the launch sign-in and the doctor row.

## 4. Your first client

Every client has one `.coop/project.yml`, committed in a repository the whole
team clones. One person creates it and shares it; everyone else gets it with
one click. Nobody needs to know Git for any of it.

```bash
cd /path/to/the/client/repository
coop onboard              # writes ~/.coop/user.json + versioned ~/.coop/config and managed MCP entries
coop onboard --machine    # VMs with one Windows user per client: your name and communication once per machine (elevated terminal)
coop doctor
coop                      # then /setup-project
```

**Where the file lives.** A client with one repository keeps it at that
repository's root. A client with several repositories cloned side by side gets a
small client home repository, `<client>-coop`, beside them (for example
`contoso-coop` next to `contoso-analytics` and `contoso-reports`): it holds the
project file and, later, the lineage docs, the catalog snapshot and the client's
own prompts and skills. The folder between the repositories is never used. coop
finds the file from any of the client's repositories.

**The first teammate** runs `/setup-project` (or *Start a client project* from
`/start`, or the window's Project pane). After the client's name the wizard says
where the file goes, creates the home repository when there are several
repositories (`git init` and a README; add its origin on GitHub when you are
ready) and lists every repository beside it. Saving ends with one question,
**Share with the team?**: yes, and coop commits only `.coop/project.yml` and
pushes it, even when the repository's `.gitignore` covers `.coop` (the rest of
`.coop` stays ignored). That is the only Git write coop performs on its own, always after
your yes; `/project-share` and the pane's button do the same any time.

**Everyone else** clones the client's repositories (the home repository too) and
opens coop in any of them. When the team's file is on origin and the checkout
does not have it yet, coop says so at the start of the session and
`/setup-project` or `/project-get` brings it in (a fast-forward pull when nothing
else would move, else only that file). The window's Project pane shows the same
line and a **Get the team's project file** button.

**Kept current.** Each session start compares your copy with the team's (one
fetch, at most every ten minutes): one line when the team's copy is newer
(`/project-get`), when yours has edits the team does not have (`/project-share`),
or when the team has a file you lack. Nothing is applied silently, and the
guardrails keep the file they started with until `/new`. From a shell,
`coop project status|get|share` does the same. The wizard can edit a contract
without replacing custom fields or policies. Choose discovery mode when no local source exists yet;
SQL-only, Power-BI-only, partial-folder, mixed-repository, and fully connected
projects can all be expanded later through the same wizard.

Lineage docs (`coop-data-doc`) are optional and do not block first use. Coop does
not launch their setup wizard automatically. When you want lineage-aware impact
analysis, run **`/setup-docs`** inside the agent, choose *Document a warehouse or
semantic model* from `/start`, or run `coop data-doc setup` in a shell. These paths use the same full
native questionnaire; no reduced fallback exists.

### Where the lineage docs live

The docs coop-data-doc builds belong beside the project file (master plan DR1):
in the client home repository when the client has several repositories, else in
the client's one repository.

```text
C:\work\contoso-coop\         .coop/project.yml, coop-data-doc.yml, data-docs/, data-docs-site/
C:\work\contoso-analytics\    a source repository the project file lists
C:\work\contoso-reports\      another one
```

`/setup-docs` run in any of them proposes `data-docs` in the home repository as
the output, so the build never lands in a source tree. After a setup whose output
is in that repository and it has no CI yet, coop offers `data-docs-check.yml`
(from `templates/client-home/`), which runs `coop-data-doc check` on every push.
One repository per client keeps access per client and a client's lineage out of
every other client's clone. coop writes the files; a human commits the docs
(coop shares only the project file on its own).

## 5. Use it

```bash
coop                      # launch the agent (run it inside your work repo)
```

coop follows the Cooptimize workflow: read context → plan → **ask before editing** →
back up → self-check against the standards → never commit source. You stay in control.

Handy commands:

```bash
coop data-doc                    # build lineage + Markdown docs
coop list / coop config          # manage Pi extensions
```

## Team knowledge (optional)

Coop can subscribe to team knowledge and pattern repositories (such as `cooptimize/incremental-bi`).
Enable it during `coop onboard` (or `coop onboard --config-only`):

```json
{
  "schema_version": 1,
  "knowledge": {
    "enabled": true,
    "repos": [
      {
        "url": "https://github.com/cooptimize/incremental-bi.git",
        "local_path": "~/.coop/knowledge/incremental-bi"
      }
    ]
  }
}
```

- `coop sync` and `coop update` automatically clone and fast-forward the knowledge repos.
- Skills defined in the knowledge repo under `skills/*/SKILL.md` are automatically surfaced to Coop on launch.
- Query team knowledge anytime using `team-knowledge` skill guidance — it runs the bundled `scripts/search-knowledge.py` helper against the configured clones.
- Publish session learnings and patterns via `/share-learning`, which drafts a note in `learnings/` and opens a PR for review.

## Try it — a safe first task (nothing gets changed)

**1. Make a throwaway file.**

```bash
printf 'SELECT * FROM dbo.Orders o JOIN dbo.Customer c ON o.CustomerId = c.Id;\n' > /tmp/sample.sql
#   Windows (PowerShell): Set-Content "$env:TEMP\sample.sql" 'SELECT * FROM dbo.Orders;'
```

**2. Ask the agent to check it against the standards.**

```bash
coop @/tmp/sample.sql "Check this against our SQL standards and explain what you'd change — don't edit anything yet."
```

The Cooptimize SQL standards are already in coop's context, so it checks the file
against them directly and names every rule it does not meet. It is **advisory** —
it reports and **never edits or blocks**.

Watch the loop: it reads context → checks against the standards → **proposes a plan
and asks before changing anything**. Reply "looks good" to proceed, or steer it. That
plan-and-approve loop — you always in control — is the whole point.

**3. In a real work repo, try a focused lineage read.**

> "Use `data_doc` to show the lineage for `<object>`, focused on its upstream and
> downstream — don't load the whole estate."

That's the context-saving, object-focused read in action.

## 6. Make it yours

```bash
coop new-skill <name>     # add a team skill   -> skills/<name>/SKILL.md
coop new-prompt <name>    # add a /prompt       -> prompts/<name>.md
```

Commit + push; teammates get it at the next release tag via `coop update`
(maintainers: `coop update --edge`). See
[extending.md](extending.md).

Using **Azure DevOps Boards**? coop has an optional integration — the
`azure-devops` skill plus `scripts/ado-digest.ps1` and
`scripts/ado-onboard.ps1` (all client identifiers stay in the private
`~/.coop/devops/clients.yml`). See the "Azure DevOps Boards (optional)" section
in the [README](../README.md#azure-devops-boards-optional).

## 7. Stay current

```bash
coop update               # moves coop-agent to the newest release tag and converges Pi, extensions, tools, and MCP packages to its manifest
```

## 8. Fleet health digest

For teams managing multiple machines or VMs, `coop` can aggregate its doctor status across the fleet to catch stale tool versions or broken dependencies before they cost a work session:

1. Configure `fleet.publish_dir` in `~/.coop/config` (or `config/defaults.yml`) to a shared folder (e.g., OneDrive/SharePoint synced path).
2. Have each machine run `coop doctor --json --publish` on a schedule (e.g., daily).
3. Have one machine run `scripts\fleet-digest.ps1 --send` weekly to aggregate the snapshots into an email digest via Microsoft Graph.

## Leaving a machine (VM rebuild / offboarding)

```bash
coop uninstall            # removes the launcher/PATH entry, shortcuts (Windows), and coop's agent dir
                          # + Pi and the pipx tools; add --keep-tools to spare those for a fast re-install
```

It never touches the repo clone, your work repos, or your personal `pi` setup.

## Ground rules (the agent follows these for you)

- **Read-only first** — it plans and asks before changing anything.
- **Never commits source** (SQL / DAX / models / reports) — docs/logs only, with approval.
- **MCP** (Fabric / Power BI / Microsoft Learn) reads freely; any change asks first
  (one approval can cover a server for the session; deletes and production always
  ask), and it never exposes secrets. Semantic model edits go through the Power BI
  Modeling MCP after approval. Warehouse SQL uses a separate `fabric-sqlendpoint` managed
  direct HTTP MCP server. Coop obtains a short-lived bearer from the existing Azure
  CLI login at launch (for the client tenant when one is configured), injects it
  only into the Pi child environment, never persists it, and keeps every SQL call
  approval-gated.

## Where to get help

- **[README.md](../README.md)** — full setup + commands
- **[extending.md](extending.md)** — custom skills / prompts / tools
- **[tool-contract.md](tool-contract.md)** — how the tools work
- **[ci.md](ci.md)** — run the suite's three gates in CI (GitHub Actions + Azure DevOps)
- `coop help` — the command list

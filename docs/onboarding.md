# Onboarding — get `coop` running (~10 minutes)

`coop` is Cooptimize's terminal agent — a branded layer on Pi for our Microsoft
Fabric / Power BI / D365 / SQL / DAX work. It works **read-only first** and reviews
work **with you** before anything ships.

> coop runs in its own isolated agent dir (`~/.coop/agent`), so it stays separate from
> your personal `pi` — only Cooptimize's curated extensions/settings/theme/MCP load,
> and your own `pi` setup is untouched.

## 1. Prerequisites (install once)

- **Node.js 22.19+** — https://nodejs.org
- **Python 3.10+** — https://python.org
- **git**
- **pipx** — `coop install` installs it for you if it's missing
- *Optional:* **Azure CLI** (`az`) for live Fabric / Power BI access

## 2. Install

**macOS / Linux**
```bash
git clone <coop-agent-repo> && cd coop-agent
./bin/coop install
```

**Windows (PowerShell)**
```powershell
git clone <coop-agent-repo>; cd coop-agent
.\bin\coop.cmd install
```

> Use the `.cmd` shim — on stock Windows the `Restricted` execution policy blocks
> `.\bin\coop.ps1 install` with *"running scripts is disabled on this system"*.
> If you need the bare `.ps1` entry point, run it with an explicit bypass:
> `powershell -ExecutionPolicy Bypass -File .\bin\coop.ps1 install`

This installs Pi, its extensions, the Coop tools, and the Microsoft Fabric CLI, and
links `coop` onto your `PATH`. **Open a new shell afterward** so `coop` is found.

## 3. Verify

```bash
coop doctor
```

Green = ready; it tells you exactly what's missing. Add `--fix` (`coop doctor --fix`)
to auto-apply the safe remediations — re-sync extensions/MCP/assets and `pipx`-install
any missing Coop tools, then re-check. One known gotcha it may flag is the **`fab`
collision** — if your `fab` is Homebrew's Python SSH tool instead of the Microsoft
Fabric CLI, follow doctor's one-line fix.

## 3.5 First launch — sign in (one time)

```bash
coop
```

The **first** launch prompts you to sign in to a model provider. This is the one
interactive choice in the whole setup, and it has governance consequences — pick
carefully:

- **Provider: OpenAI (Codex).** This is the provider Cooptimize's data-handling
  posture is built on.
- **Account: your Cooptimize business account — not a personal one.** The
  no-training-on-our-data terms attach to the **business** subscription; signing
  in with a personal account silently voids that protection. If you accidentally
  signed in with the wrong account, sign in again from inside the agent and pick
  the business account.

It's a **one-time** step. The login is stored in coop's isolated agent dir
(`~/.coop/agent`) — and if you already use a personal `pi`, its existing login is
shared in from `~/.pi/agent` automatically (see
[README → Isolation](../README.md#isolation)), so you may not be prompted at all.
`coop doctor` shows **"Pi login present"** once it's done.

## 4. Point it at a work repo

In each Fabric / D365 repo you work in:

```bash
cd /path/to/your/fabric-repo
coop init                 # writes .coop/project.yml
# edit .coop/project.yml — fill the TODOs (repo paths, workspaces, tenant)
coop doctor
```

The first time you launch `coop` in a repo, it offers to set up **lineage docs**
(`coop-data-doc`) so the agent understands up/downstream impact — accept it, or run
**`/setup-docs`** anytime inside the agent (a quick native wizard). For the full
wizard (medallion layers, branding, schema→model mappings), run `coop data-doc setup`
in a shell.

## 5. Use it

```bash
coop                      # launch the agent (run it inside your work repo)
```

coop follows the Cooptimize workflow: read context → plan → **ask before editing** →
back up → review with the tools → never commit source. You stay in control.

Handy commands:

```bash
coop sql-review check path/to.sql      # advisory SQL standards check
coop dax-review check path/to/model    # advisory DAX standards check
coop data-doc                          # build lineage + Markdown docs
coop list / coop config          # manage Pi extensions
```

## Try it — a safe first task (nothing gets changed)

**1. See an advisory review on a throwaway file.**

```bash
printf 'SELECT * FROM dbo.Orders o JOIN dbo.Customer c ON o.CustomerId = c.Id;\n' > /tmp/sample.sql
coop sql-review check /tmp/sample.sql
#   Windows (PowerShell): Set-Content "$env:TEMP\sample.sql" 'SELECT * FROM dbo.Orders;'; coop sql-review check "$env:TEMP\sample.sql"
```

You'll get a severity summary (errors / warnings / info). `coop sql-review` is
**advisory** — it reports against our SQL standards and **never edits or blocks**.

**2. Now work *with* the agent.**

```bash
coop @/tmp/sample.sql "Review this against our SQL standards and explain what you'd change — don't edit anything yet."
```

Watch the loop: it reads context → runs `sql_review` → **proposes a plan and asks
before changing anything**. Reply "looks good" to proceed, or steer it. That
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

Commit + push; teammates get it on their next `coop update`. See
[extending.md](extending.md).

Using **Azure DevOps Boards**? coop has an optional integration — the
`azure-devops` skill plus `scripts/ado-digest.sh|.ps1` and
`scripts/ado-onboard.sh|.ps1` (all client identifiers stay in the private
`~/.coop/devops/clients.yml`). See the "Azure DevOps Boards (optional)" section
in the [README](../README.md#azure-devops-boards-optional).

## 7. Stay current

```bash
coop update               # updates Pi + extensions + tools, pulls latest coop-agent, runs doctor
```

## Leaving a machine (VM rebuild / offboarding)

```bash
coop uninstall            # removes the launcher/PATH entry, shortcuts (Windows), and coop's agent dir
                          # + Pi and the pipx tools; add --keep-tools to spare those for a fast re-install
```

It never touches the repo clone, your work repos, or your personal `pi` setup.

## Ground rules (the agent follows these for you)

- **Read-only first** — it plans and asks before changing anything.
- **Never commits source** (SQL / DAX / models / reports) — docs/logs only, with approval.
- **MCP** (Fabric / Power BI / Microsoft Learn) is **read-only**; it never exposes secrets.

## Where to get help

- **[README.md](../README.md)** — full setup + commands
- **[extending.md](extending.md)** — custom skills / prompts / tools
- **[tool-contract.md](tool-contract.md)** — how the tools work
- **[ci.md](ci.md)** — run the suite's three gates in CI (GitHub Actions + Azure DevOps)
- `coop help` — the command list

# Onboarding — get `coop` running (~10 minutes)

`coop` is Cooptimize's terminal agent — a branded layer on Pi for our Microsoft
Fabric / Power BI / D365 / SQL / DAX work. It works **read-only first** and reviews
work **with you** before anything ships.

## 1. Prerequisites (install once)

- **Node.js 18+** — https://nodejs.org
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
.\bin\coop.ps1 install
```

This installs Pi, its extensions, the Coop tools, and the Microsoft Fabric CLI, and
links `coop` onto your `PATH`. **Open a new shell afterward** so `coop` is found.

## 3. Verify

```bash
coop doctor
```

Green = ready; it tells you exactly what's missing. One known gotcha it may flag is
the **`fab` collision** — if your `fab` is Homebrew's Python SSH tool instead of the
Microsoft Fabric CLI, follow doctor's one-line fix.

## 4. Point it at a work repo

In each Fabric / D365 repo you work in:

```bash
cd /path/to/your/fabric-repo
coop init                 # writes .coop/project.yml
# edit .coop/project.yml — fill the TODOs (repo paths, workspaces, tenant)
coop doctor
```

## 5. Use it

```bash
coop                      # launch the agent (run it inside your work repo)
```

coop follows the Cooptimize workflow: read context → plan → **ask before editing** →
back up → review with the tools → never commit source. You stay in control.

Handy commands:

```bash
coop sql-review path/to.sql      # advisory SQL standards check
coop dax-review path/to/model    # advisory DAX standards check
coop data-doc                    # build lineage + Markdown docs
coop list / coop config          # manage Pi extensions
```

## 6. Make it yours

```bash
coop new-skill <name>     # add a team skill   -> skills/<name>/SKILL.md
coop new-prompt <name>    # add a /prompt       -> prompts/<name>.md
```

Commit + push; teammates get it on their next `coop update`. See
[extending.md](extending.md).

## 7. Stay current

```bash
coop update               # updates Pi + extensions + tools, pulls latest coop-agent, runs doctor
```

## Ground rules (the agent follows these for you)

- **Read-only first** — it plans and asks before changing anything.
- **Never commits source** (SQL / DAX / models / reports) — docs/logs only, with approval.
- **MCP** (Fabric / Power BI / Microsoft Learn) is **read-only**; it never exposes secrets.

## Where to get help

- **[README.md](../README.md)** — full setup + commands
- **[extending.md](extending.md)** — custom skills / prompts / tools
- **[tool-contract.md](tool-contract.md)** — how the tools work
- `coop help` — the command list

# Install coop on Linux (personal edition)

Windows is the team platform: teammates install coop with
[Install coop on Windows](install-windows.md). Linux is a supported **personal
edition**. It runs the same coop, the same PowerShell implementation under
PowerShell 7 (`pwsh`), with the same guardrails, standards, tools and Pi pins.
The `linux` job in `.github/workflows/ci.yml` gates it on every pull request: it
runs the PowerShell suite, a real `coop install --yes`, `coop doctor`,
`coop launch-spec --json` and `coop uninstall`, and the guardrails through the
pinned Pi's own extension runner.

Tested on Ubuntu 24.04. Arch-based systems (Omarchy) work the same way with
their own package names.

## 1. One Linux user and one coop clone per client

coop keeps everything for a client in that user's home: `~/.coop` (profile,
config, backups), `~/.coop/agent` (the isolated Pi agent dir), the pipx tools in
`~/.local`, and the Azure CLI sign-in in `~/.azure`. Keep clients apart the way
the team does on Windows (one Windows user per client):

- create **one Linux user per client** and do all of that client's work signed in
  as that user;
- give each of those users **its own coop clone**: `coop update` runs git in the
  checkout, so a clone shared between users would be updated under someone
  else's session.

## 2. Install the prerequisites

coop's installer checks these first and prints the command for any that are
missing. It never runs `sudo` for you.

1. **Git, Node.js 22.19.0 or newer, Python 3.10 to 3.13 (3.12 recommended)**
   from your distribution or the projects' own packages.
2. **PowerShell 7** (`pwsh`). On Ubuntu, follow Microsoft's page "Install
   PowerShell on Ubuntu" (the `packages.microsoft.com` repository, then
   `sudo apt-get install -y powershell`). On Arch, the AUR package. Check with
   `pwsh --version`.
3. **pipx**, with its bin dir on PATH:
   ```bash
   sudo apt-get install -y pipx
   pipx ensurepath
   ```
4. **`~/.local/bin` on PATH.** `pipx ensurepath` adds it to your shell profile.
   Open a new terminal afterwards and check with `echo $PATH`. `coop install`
   links the `coop` command there.
5. **Azure CLI** (`az`), from Microsoft's "Install the Azure CLI on Linux" page.
6. **unixODBC and Microsoft ODBC Driver 18 for SQL Server**, for live SQL only
   (see section 5). They need root, so coop cannot install them. On Ubuntu, with
   Microsoft's package repository added as that page describes:
   ```bash
   sudo apt-get install -y unixodbc
   sudo ACCEPT_EULA=Y apt-get install -y msodbcsql18
   ```
   Microsoft's page: <https://learn.microsoft.com/sql/connect/odbc/linux-mac/installing-the-microsoft-odbc-driver-for-sql-server>.
   Check with `odbcinst -q -d` (it lists `ODBC Driver 18 for SQL Server`).

If an older `pi` is installed globally (for example in `/usr/bin`), remove it or
make sure the npm global bin dir that coop installs into comes first on PATH. An
old Pi earlier on PATH causes confusing doctor rows.

## 3. Install coop

Signed in as the client's Linux user:

```bash
git clone https://github.com/kabukisensei/coop-agent.git ~/coop-agent
~/coop-agent/bin/coop install
```

The banner names the platform (`[Linux]`). Step 6 links
`~/.local/bin/coop` to the clone's `bin/coop`. It never replaces a regular file
or a link to anything else there; it says so and leaves it. If `~/.local/bin`
was not on the PATH you started `coop install` from, it says that too. Then:

```bash
coop doctor
coop
```

Re-run `coop install` at any time; it is idempotent. `coop update` keeps coop,
Pi and the tools at the release's pins, as on Windows.

## 4. Tabular Editor CLI (`te`), optional

`bpa_review` uses the Tabular Editor CLI. Download the Linux build from
<https://tabulareditor.com/product/features-and-tools/tabular-editor-cli>, put
the `te` binary in `~/.local/bin` (or anywhere on PATH), make it executable
(`chmod +x`) and run `te auth login`.
After 2026-12-31 the CLI needs a Tabular Editor license. `coop doctor` finds `te`
on PATH or in `~/.local/bin`.

## 5. Live SQL

Live SQL (`sql_impact`, `sql_query`, `schema_compare` against a live database,
the Fabric SQL fallback) reads through pyodbc in the Fabric CLI's Python
environment, which needs unixODBC and ODBC Driver 18 (section 2, item 6).
Without them `coop doctor` shows one red row, "Fabric SQL fallback: pyodbc is
installed but unloadable" (or "ODBC Driver 18+ for SQL Server is missing"), and
everything else still works. Sign in with `az login` (use
`az login --use-device-code` on a machine without a browser). The usual rules
hold: dev by default, never production writes.

## 6. What is Windows-only

These stay on Windows; on Linux coop says so or leaves them out:

- the coop window app (`coop desktop`) and its installer;
- Start Menu and Desktop shortcuts, and `coop startup`;
- the Power BI Desktop bridge (the Power BI modeling MCP reaches remote or XMLA
  models only, because Power BI Desktop is Windows-only);
- the SSMS handoff ("Open in editor" for SQL);
- the per-machine install and its scheduled "coop update" task.

## 7. Remove coop

```bash
coop uninstall
```

It removes the `~/.local/bin/coop` link (only when it points at this clone's
`bin/coop`),
the isolated agent dir and, unless you pass `--keep-tools`, Pi and the pipx
tools. It never touches the clone, your work repositories or the rest of
`~/.coop`.

# Install coop on Windows

This page sets up coop on a Windows machine. Most of the time goes to downloads.
Everything runs in **Windows PowerShell**: open the Start menu, type `PowerShell`,
and open **Windows PowerShell**. Paste each command and press Enter.

<!--
Maintainers: the rows and commands in step 1 are copied from the installer's own
output (Get-CoopPrereqs in lib/common.ps1, printed by scripts/install.ps1). Change
them together. The 0.23.6 in step 2 is a floor, not the current version: it is the
first release whose `coop update` follows release tags. Before that tag exists the
line leaves the clone on main; never point teammates at an older tag.
-->

## 1. Install the prerequisites

The installer checks these seven items in this order and prints the command below
for any that are missing. Install them in the same order. winget may ask you to
accept its terms (type `Y`), and Windows may ask for permission (click **Yes**).

1. **Git**
   ```powershell
   winget install --id Git.Git -e
   ```
2. **Node.js 22.19.0 or newer**
   ```powershell
   winget install --id OpenJS.NodeJS.LTS -e
   ```
3. **Python 3.10-3.13 (3.12 recommended)**
   ```powershell
   winget install --id Python.Python.3.12 -e
   ```
   Then close PowerShell and open a new window, so the next step can find `py`.
4. **pipx**
   ```powershell
   py -3.12 -m pip install --user pipx
   py -3.12 -m pipx ensurepath
   ```
5. **Azure CLI**
   ```powershell
   winget install --id Microsoft.AzureCLI -e
   ```
6. **ODBC Driver 18 for SQL Server** (needed for live SQL)
   ```powershell
   winget install --id Microsoft.msodbcsql.18 -e
   ```
7. **Tabular Editor CLI (optional, BPA reviews)**. Skip it unless you run BPA
   reviews; the installer only warns about it. To add it later: download te from
   https://tabulareditor.com/product/features-and-tools/tabular-editor-cli, put it
   on PATH, then: `te auth login`

Close PowerShell when you are done.

## 2. Get the code

Open a new PowerShell window and paste these four lines as they are:

```powershell
cd $HOME
git clone https://github.com/kabukisensei/coop-agent.git
cd coop-agent
git checkout -q (@(git tag --merged origin/main '--sort=-v:refname') -match '^v\d+\.\d+\.\d+$' | Where-Object { [version]$_.Substring(1) -ge [version]'0.23.6' } | Select-Object -First 1)
```

This puts coop in `C:\Users\<you>\coop-agent` at the newest release, and
`coop update` moves it to each release after that. Don't add `--depth` or
`--single-branch` to the clone: a partial clone cannot follow releases.

## 3. Double-click Install coop.cmd

In the same window, run `explorer .` to open the folder, then double-click
**Install coop.cmd** (Explorer may show it as **Install coop**). Leave the window
open until it finishes.

It starts with the same checklist. With step 1 done, every row starts with ✓ (row 7
shows `!` if you skipped Tabular Editor) and then it says:

```
✓ all prerequisites present, continuing
```

If a row shows ✗ instead, the installer stops before installing anything and prints
that row's command under it, for example:

```
✗ 2. Node.js 22.19.0 or newer  (not found)
      winget install --id OpenJS.NodeJS.LTS -e
```

Close the install window, run that command in a new PowerShell window, then
double-click **Install coop.cmd** again. The installer's message says
`run: coop install`, but the `coop` command only exists once the installer gets past
this checklist, so use Install coop.cmd until then.

Partway through, it asks:

- **What should COOP call you?** Type your name.
- **How do you prefer agents to communicate?** Press Enter for the default (marked `*`).
- **Connect Coop to client Microsoft Fabric and Power BI now?** and **Sign in now so
  Coop can detect the client tenant automatically?** Press Enter for yes if you work
  in a client's Fabric or Power BI, then sign in (step 5). Answer `n` if not; you
  can run `coop onboard --config-only` later.

## 4. Open a new terminal and run coop

When the window says **All set**, press a key to close it. (If it says **Something
went wrong** instead, scroll up and do what its last lines say: fix the ✗ items, then
run `coop doctor` or `coop install` in a new PowerShell window.) Open a new PowerShell
window and run:

```powershell
coop
```

Or double-click the **coop** icon on your Desktop or in the Start Menu, which opens
coop as a chat window. The icon starts coop in your home folder. For client work,
start coop from the project folder instead, so project setup and `/setup-docs` use
that folder:

```powershell
cd <project folder>
coop
```

## 5. What the sign-ins look like

**Azure (the client's Fabric and Power BI).** After you say yes in step 3, the
installer prints `Opening Azure sign-in. Coop will wait here until it finishes…` and
a Microsoft sign-in window opens. Sign in with the account that has access to the
client. If you have more than one tenant, it asks which one owns the client's Fabric
and Power BI. After that, `coop` checks the sign-in quietly each time it starts. When
the sign-in has expired, it prints `Opening Azure sign-in for tenant <id>...` and
opens the same window once (from the desktop icon, in a window of its own). If
sign-in fails, coop starts anyway and prints the command to run:
`az login --tenant <id> --allow-no-subscriptions`.

**OpenAI (the model).** At the end of the install, a coop screen opens with
`/login openai-codex` already typed and this note:

```
Final setup: press Enter to sign in with your Cooptimize OpenAI account.
```

Press Enter and finish in your browser with your **Cooptimize business account**, not
a personal one. The installer then carries on by itself. If it could not show this
screen, your first `coop` launch does.

Next: [onboarding](onboarding.md) has a safe first task and the day-to-day commands.

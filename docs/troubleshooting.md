# Troubleshooting — maintainer runbook

The environment problems that keep coming back. Each entry is
symptom → diagnose → fix → verify. For general setup problems, run
`coop doctor --fix` first — it detects and remediates most missing pieces.

coop runs on Windows (`bin/coop.cmd` → `bin/coop.ps1`). A macOS or Linux clone
is a development checkout for the logic tests, not an installation: `coop
install`, `coop doctor` and launching `coop` are Windows workstation activities
(see `AGENTS.md`, "Platform notes").

## 1. `fab` is the wrong tool (Microsoft Fabric CLI vs Python Fabric)

**Symptom.** Fabric commands fail oddly, and `coop doctor` reports:

```
✗ fab is the WRONG tool — this 'fab' is Python Fabric (SSH automation), not the Microsoft Fabric CLI
```

**Cause.** Two packages install a `fab` command: `ms-fabric-cli` (the Microsoft
Fabric CLI coop needs, installed by `coop install` via pipx) and the Python
package `fabric` (an SSH/automation tool, installed by `pip` or `pipx`). PATH
ordering decides which one wins.

**How doctor detects it** (`scripts/doctor.ps1`): it runs `fab --version` and
looks in the first lines, case-insensitively, for `paramiko|invoke` — those
strings appear only in Python Fabric's version banner, never in the Microsoft
Fabric CLI's.

**Fix.** Remove the collision: uninstall the Python `fabric` package however it
was installed (`pipx uninstall fabric`, or `pip uninstall fabric` in the Python
that owns it), or move pipx's bin directory ahead of that Python's `Scripts`
directory on your user PATH.

**Verify.**

```powershell
fab --version    # must identify as the Microsoft Fabric CLI (no paramiko/invoke)
coop doctor      # the "Microsoft Fabric CLI" section must show ✓
```

### Fabric CLI uses Python 3.14 on Windows

**Symptom.** `coop doctor` reports that the `ms-fabric-cli` environment uses
Python 3.14, or `fabric-cicd` injection fails because it requires Python `<3.14`.

**Fix.** Run `coop doctor --fix` (or `coop install --force` / `coop update`; all
three build the Fabric environment the same way). Coop first uses a local
Python 3.13/3.12 when one exists. Otherwise it asks pipx to download a standalone
Python 3.12 for the Fabric environment (`--fetch-python=missing --python 3.12` with
pipx 1.12 or newer, `--fetch-missing-python` with pipx 1.5–1.11). This works
without `winget`, `py`, `pymanager`, an administrator account, or a system-wide
Python installation. `coop doctor --fix` also rebuilds an existing Fabric
environment that still runs Python 3.14 and re-injects `fabric-cicd`.

**Verify.** Ask pipx for its environment location rather than assuming a Windows
layout:

```powershell
$venvs = pipx environment --value PIPX_LOCAL_VENVS
& (Join-Path $venvs "ms-fabric-cli\Scripts\python.exe") --version
coop doctor
```

The first command must report Python 3.10–3.13. If Coop says pipx cannot fetch a
runtime (on Windows the Python prerequisite row prints this command as its fix),
upgrade pipx with `python -m pip install --user --upgrade pipx`, then run
`coop doctor --fix` or `coop update` again.

## 2. `coop` runs stale code (dev-clone launcher)

**Symptom.** You edit `bin/coop.ps1` / `lib/` / `scripts/` but the `coop`
command behaves as if nothing changed.

**Cause.** `coop install` writes `%LOCALAPPDATA%\coop\bin\coop.cmd`, a launcher
that calls one clone's `bin\coop.cmd` (`scripts/install.ps1`, step 6). If more
than one clone exists on the machine, the launcher may point at the other one,
so `coop` runs that clone's code — not your edits.

**Diagnose.**

```powershell
Get-Content "$env:LOCALAPPDATA\coop\bin\coop.cmd"   # which clone does it call?
```

**Fix** (from the root of your dev clone):

```powershell
.\bin\coop.cmd install     # rewrites the launcher to point at this clone
```

**Verify.**

```powershell
Get-Content "$env:LOCALAPPDATA\coop\bin\coop.cmd"   # now calls your dev clone's bin\coop.cmd
coop version                                        # matches your clone's VERSION file
```

**Never** debug "my change has no effect" without checking this first.
Invoking `.\bin\coop.cmd …` from the clone root always runs the code you are
editing. See [CONTRIBUTING.md](../CONTRIBUTING.md#testing-local-changes).

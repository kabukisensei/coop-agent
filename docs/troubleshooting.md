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

## 3. `/compact` fails with `WebSocket idle timeout after 300000ms`

**Symptom.** Manual `/compact` or automatic compaction on a large session ends
with `Error: WebSocket idle timeout after 300000ms` on an OpenAI Codex
subscription model, and setting Transport to `sse` in `/settings` changes
nothing (coop-agent #236).

**Diagnose.** Pi 0.87.1 builds its compaction request without the session's
transport setting, so the Codex provider opens a WebSocket for the summary
regardless. Check the effective setting and the coop version:

```powershell
Get-Content "$HOME\.coop\agent\settings.json" | Select-String transport
coop version
```

**Fix.** Update to a coop release that carries the `session_before_compact` hook
in `extensions/coop-tools` (CHANGELOG, #236): with `transport: "sse"` coop runs
the summary over SSE itself. Until then, keep the session, run `/handoff`, start
a new session with `/new` and paste the summary.

**Verify.** With Transport `sse`, `/compact` completes and the transcript shows
the compaction summary; no WebSocket error.

## 4. coop stops with `Failed to load extension … Cannot find module`

**Symptom.** The coop window shows "coop stopped (exit code 1)" (or the
terminal's Pi exits) with lines like
`Failed to load extension "…\.coop\agent\npm\node_modules\pi-mcp-adapter\index.ts": Cannot find module './v4/classic/external.js'`
or the same for `pi-hermes-memory` and `./store/memory-store.js`.

**Diagnose.** The isolated extension tree (`~\.coop\agent\npm`) is half
written. Two writers ran at once: typically the coop window's first launch,
which seeds the tree from the package, while a `coop sync`, `coop install` or
`coop update` ran `npm ci` in the same folder. Releases after 0.30.1 hold one
lock per agent dir so the second writer waits; a tree broken before that stays
broken, because its lock file looks complete to `coop sync`.

**Fix.** Close every coop window and let any running `coop sync` finish, then:

```powershell
Stop-Process -Name coop -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "$env:USERPROFILE\.coop\agent\npm\node_modules" -Recurse -Force
Remove-Item -LiteralPath "$env:USERPROFILE\.coop\agent\npm\package-lock.json" -Force
coop sync
```

**Verify.** `coop sync` prints one "Installed release version" or "Already at
release version" line per extension and no warning; coop (terminal or window)
starts with the extensions loaded.

## 5. `Fabric Warehouse MCP unavailable: Azure CLI is not installed or not on PATH`

**Symptom.** The launch prints that line (or `coop doctor` shows
`fabric-sqlendpoint azure_cli_unavailable`) while `az` is installed and signed
in, and Warehouse queries get a 401.

**Diagnose.** Before 0.30.2 the token helper refused a node or az inside the
working folder, and a coop started from the home folder (`C:\Users\<name>`)
counted the whole profile as inside it: the window's bundled Node or a per-user
install was refused. Check where coop was started:

```powershell
Get-Location
```

**Fix.** Start coop from the project folder, or open the window on it (pick the
project folder in the dialog, never the home folder). From 0.30.2 a folder that
contains the home is not treated as a work repo.

A second message, `managed configuration is invalid; run coop sync`, means the
other install (terminal or window) wrote the shared `mcp-adapter.json` last:
before 0.30.2 each refused the other's helper path. Run `coop sync` from the
install you are about to use, in the project folder, so the managed entry also
carries that project's Warehouse target.

**Verify.** The launch shows no Warehouse line and a `SELECT TOP 1 1` runs.


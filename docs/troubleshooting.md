# Troubleshooting — maintainer runbook

The three environment problems that keep coming back. Each entry is
symptom → diagnose → fix → verify. For general setup problems, run
`coop doctor --fix` first — it detects and remediates most missing pieces.

## 1. `coop update` updated the wrong Pi (two Node toolchains, macOS)

**Symptom.** `coop` crashes at launch with a module-resolution error inside an
extension (e.g. `Cannot find module '…/pi-ai/dist/index.js/compat'`), or the
launch preflight aborts with `Pi agent X.Y.Z is too old — <ext> needs pi-ai ≥ N`
— and running `coop update` does **not** fix it.

**Cause.** Two Node installs coexist — e.g. Homebrew under `/opt/homebrew` and
a second npm prefix (such as a `~/.hermes` tree) whose shims sit earlier on the
interactive PATH. `bin/coop` execs a bare `pi` from a non-interactive bash, so
shell aliases don't apply and `pi` resolves to the **Homebrew** binary — but
`coop update` / a bare `npm install -g` run whichever `npm` is first on PATH
and may update the **other** tree. The Pi that coop actually launches never
gets updated.

**Diagnose.**

```bash
which -a node npm pi
```

If `node`/`npm` and `pi` resolve into different prefixes (e.g. `pi` in
`/opt/homebrew/bin` but `npm` elsewhere), you have a split toolchain.

**Fix — update the tree coop actually runs** (Homebrew example):

```bash
/opt/homebrew/bin/npm install -g @earendil-works/pi-coding-agent@latest
coop sync        # re-aligns the isolated extension tree's pi-ai / pi-tui
```

**Verify.**

```bash
coop version     # the pi version line must now be current
coop             # must launch with no preflight warning
```

**Known sharp edge.** The extension-skew preflight (`coop_launch_preflight` in
`lib/common.sh`, backed by `lib/_extdeps.py`) exists exactly to catch this, but
its advice — `update the Pi agent: coop update` — is **misleading on a
split-toolchain machine**, because `coop update` may bump the wrong tree. Use
the explicit `<prefix>/npm install -g …` fix above. Open follow-up: make
`coop update` detect the npm that owns the `pi` it execs.

## 2. `fab` is the wrong tool (Microsoft Fabric CLI vs Python Fabric)

**Symptom.** Fabric commands fail oddly, and `coop doctor` reports:

```
✗ fab is the WRONG tool — this 'fab' is Python Fabric (SSH automation), not the Microsoft Fabric CLI
```

**Cause.** Two packages install a `fab` binary: `ms-fabric-cli` (the Microsoft
Fabric CLI coop needs, installed by `coop install` via pipx into
`~/.local/bin`) and the Homebrew formula `fabric` (a Python SSH/automation
tool). PATH ordering decides which one wins.

**How doctor detects it** (`scripts/doctor.sh`; mirrored in
`scripts/doctor.ps1`): it runs `fab --version` and greps the first lines
case-insensitively for `paramiko|invoke` — those strings appear only in Python
Fabric's version banner, never in the Microsoft Fabric CLI's.

**Fix.** The PATH ordering rule: `~/.local/bin` (pipx's bin dir) must precede
Homebrew's bin dir. Either reorder PATH in your shell rc, or remove the
collision entirely:

```bash
brew uninstall fabric
```

**Verify.**

```bash
fab --version    # must identify as the Microsoft Fabric CLI (no paramiko/invoke)
coop doctor      # the "Microsoft Fabric CLI" section must show ✓
```

## 3. `coop` runs stale code (dev-clone symlink)

**Symptom.** You edit `bin/coop` / `lib/` / `scripts/` but the `coop` command
behaves as if nothing changed.

**Cause.** `coop install` links `~/.local/bin/coop` → `<clone>/bin/coop`
(`scripts/install.sh`). If more than one clone exists on the machine, the
symlink may point at the other one, so `coop` runs that clone's code — not
your edits.

**Diagnose.**

```bash
ls -l ~/.local/bin/coop        # where does it actually point?
```

**Fix** (from the root of your dev clone):

```bash
ln -sf "$(pwd)/bin/coop" ~/.local/bin/coop     # or re-run: ./bin/coop install
```

**Verify.**

```bash
ls -l ~/.local/bin/coop        # now points at your dev clone's bin/coop
coop version                   # matches your clone's VERSION file
```

**Never** debug "my change has no effect" without checking this first.
Invoking `./bin/coop …` from the clone root always runs the code you are
editing. See [CONTRIBUTING.md](../CONTRIBUTING.md#testing-local-changes-on-macos).

# Contributing to coop-agent

coop-agent is a shared Cooptimize tool. Most contributions are **additive and file-based**
— a new skill, prompt, or vibe — so the bar to contribute is low. Bigger changes
(the launcher, scripts, extensions) should keep the PowerShell + governance contract:
one implementation in PowerShell, Windows PowerShell 5.1 floor (master plan S1).

## Quick contributions (skills / prompts)

Use the scaffolders — they create the right files in the right place:

```bash
coop new-skill <name>     # -> skills/<name>/SKILL.md
coop new-prompt <name>    # -> prompts/<name>.md
```

Edit, test locally with `coop`, then commit and push. Teammates pick it up at the next
release tag via `coop update` (maintainers: `coop update --edge`). See
**[docs/extending.md](docs/extending.md)** for skills, prompts, themes, and writing a Pi
extension.

Guidelines:

- Skills stay **advisory and read-only** and reference the `coop-workflow` skill.
- The official Microsoft slot (`skills/_microsoft/`) is **subordinate** — don't add a
  skill whose name collides with a Cooptimize skill.

## Changing code (wrapper / scripts / extensions)

Keep the one implementation and the contract:

- **PowerShell is the product** (master plan S1): `bin/coop.ps1`, `lib/common.ps1`
  and `scripts/*.ps1`, launched by `bin/coop.cmd` on Windows. `bin/coop` is a Git
  Bash forwarder to `coop.ps1` and carries no logic; `scripts/release.sh`,
  `scripts/validate-resources.sh` and `tests/*.sh` are bash dev tooling, and
  `scripts/check-bom.ps1` is the BOM check. Never add a bash product path or a
  `.sh` twin back.
- **Governance:** preserve read-only-first, plan-and-approve, never-commit-source,
  read-only MCP, and never expose secrets.
- **No new hard deps:** the YAML reader (`lib/_yaml.py`) is dependency-free on purpose
  (system python may lack PyYAML) and is the one parser coop uses on every machine:
  it never imports PyYAML, even when installed. Don't reintroduce a PyYAML path.

### PowerShell requirements

- **Every `.ps1` in this repo must start with a UTF-8 BOM** (`EF BB BF`).
  Windows PowerShell 5.1 reads a BOM-less `.ps1` as ANSI, so em-dashes /
  ellipses / box-drawing characters turn into mojibake. Some editors and agent
  file-write tools silently drop the BOM when rewriting a file — after any
  `.ps1` edit, run the one BOM check, `pwsh -NoProfile -File scripts/check-bom.ps1`
  (`tests/run.ps1` runs it first). It prints the exact fix command for each
  offender; the recipe it prints re-adds a missing BOM by hand:

  ```bash
  printf '\357\273\277' | cat - file.ps1 > file.ps1.bom && mv file.ps1.bom file.ps1
  ```

  The one exception is `scripts/bootstrap.ps1`, which runs as `irm <url> | iex`:
  `iex` receives a BOM as a character and fails on line 1, so that file is pure
  ASCII with no BOM, and the BOM check enforces both.

- **Target Windows PowerShell 5.1 — no PowerShell-7-only syntax.** Every real
  Windows entry point runs the built-in Windows PowerShell 5.1
  (`System32\WindowsPowerShell\v1.0\powershell.exe`): `bin/coop.cmd`, the Install
  shortcut, and the Start-Menu/Desktop shortcuts `scripts/install.ps1` creates.
  So the whole repo has a **5.1 floor**. PowerShell-7-only constructs — the
  ternary `cond ? a : b`, null-coalescing `??` / `??=`, null-conditional `?.` /
  `?[]`, and `clean { }` blocks — parse fine under `pwsh` 7 (all a Linux or macOS
  dev box has) but are a **hard parse error** under 5.1, which breaks `coop` at launch for the
  whole team. Don't use them. CI parses every `.ps1` under BOTH `pwsh` 7 and
  Windows PowerShell 5.1 (the `windows` job) so a 7-ism can't sail through green;
  when in doubt, keep to syntax that predates PowerShell 6.

- **Shared PowerShell helpers live in `lib/common.ps1`** (loggers, progress
  engine, `Test-Have`, `Get-CoopPython`, YAML readers, `Coop-Unit`, …).
  `bin/coop.ps1` and every `scripts/*.ps1` load it with
  `. (Join-Path $PSScriptRoot '../lib/common.ps1')`. A helper change goes there —
  never re-add a per-script inline copy. (Exception: `Coop-Unit` scriptblocks run
  in fresh background runspaces and see none of the library, so logic inside a
  unit stays self-contained by design.) `extensions/coop-tools` resolves the
  Fabric Python through the same library (`Get-CoopFabricPython`, via
  `powershell.exe` on Windows and `pwsh` elsewhere).
- `scripts/check-bom.ps1` is the one BOM check (the first section of
  `tests/run.ps1`, so every CI leg runs it; `coop release` and `scripts/release.sh`
  run it too). It fails on any BOM-less `.ps1` or one with a doubled BOM, when
  `bin/coop.ps1` or `scripts/sync-knowledge.ps1` does not start with a comment
  line right after the BOM, and on a bash-style `\` line continuation in a `.ps1`.

### Testing local changes

On Windows, the `coop` on your PATH is `%LOCALAPPDATA%\coop\bin\coop.cmd`, a
launcher written by `coop install` that calls one clone's `bin\coop.cmd`. If it
points at a different clone than the one you are editing, you run stale code.
Check it with `type %LOCALAPPDATA%\coop\bin\coop.cmd` (or `Get-Content`), and
re-run `.\bin\coop.cmd install` from your dev clone to repoint it. Invoking
`.\bin\coop.cmd …` from the clone root always runs the code you are editing.

On a macOS or Linux dev box, `./bin/coop …` forwards to `bin/coop.ps1` under
`pwsh`; it is a development convenience for the logic tests, not a supported way
to operate coop (see `docs/troubleshooting.md`).

## Before you open a PR

Run the same checks CI runs:

```bash
for f in bin/coop scripts/*.sh tests/*.sh; do bash -n "$f"; done     # dev-tooling shell syntax — expect: no output, exit 0
python3 lib/_yaml.py get .coop/project.yml profile.organization MISS  # yaml reader — expect: Cooptimize
pwsh -NoProfile -File scripts/check-bom.ps1                           # .ps1 BOM — expect: "✓ BOM check passed"
pwsh -NoProfile -File tests/run.ps1                                   # PowerShell suite, gate lane — expect: "✓ PowerShell behavioral tests passed (gate lane)"
bash tests/run.sh                                                     # gate lane, expect: "✓ all tests passed (gate lane)"
coop doctor                                                           # deps + config (workstation only — see note)
```

If your change bumps a pin in `config/release-manifest.json` (an extension or
Pi itself), regenerate the extension lockfile in the same PR and commit it:

```bash
node lib/extlock.js generate      # rewrites config/extensions-lock.json (needs the npm registry)
node lib/extlock.js check         # expect: "extlock: lock matches the manifest"
```

`config/extensions-lock.json` is npm's lockfile for coop's isolated extension
tree (`~/.coop/agent/npm`); `coop sync` installs the tree from it with `npm ci`,
so every machine on a release runs the same transitive dependency versions
(issue #152). `generate` installs the resolved tree once (scripts off) and copies
`gypfile: false` into the lock entry of every package that declares it: npm
builds the nodes it installs from the lock entries, and without the flag it
compiles better-sqlite3 13 from source on Windows. A machine where the lock
fails to install keeps a copy in `npm/.coop-lock-failed.json` and resolves live
until a new lock ships. The gate lane fails when the lock and the manifest
disagree.

If you are on a headless dev box without the coop stack installed (no `pi`,
pipx tools, or `fab`), **skip `coop doctor`** and say so in the PR — the five
checks above plus CI fully cover script/doc changes.

`bash tests/run.sh` runs the gate lane, the deterministic tests every PR runs.
The extended lane adds the timing and process fixtures. It is optional for a PR
unless you added or changed one of those fixtures, and `coop release` runs it
before every tag:

```bash
COOP_TEST_EXTENDED=1 bash tests/run.sh   # gate + extended lanes, expect: "✓ all tests passed (gate + extended lanes)"
```

A new timing or process fixture goes in the extended lane, and the PR says why.
The lanes, the fixture rules, and the CI workflows are described in
[docs/ci.md](docs/ci.md#coop-agents-own-ci-maintainers-gate-and-extended-lanes).

CI (`.github/workflows/ci.yml`) runs on every PR and every push to `main`. Its
jobs run `bash -n` and `shellcheck` over the bash dev tooling, JSON/YAML/skill
validation, and the esbuild transpile of the TypeScript extensions; they parse
every `.ps1` under pwsh 7 and Windows PowerShell 5.1 with PSScriptAnalyzer; and
they run the gate lane on ubuntu (`tests/run.sh`, then `tests/run.ps1` under
pwsh 7, which starts with `scripts/check-bom.ps1`), under Windows Git Bash
(`tests/run.sh`), and under Windows PowerShell 5.1 (`tests/run.ps1`). The
`gate` job passes only when every other job succeeded. The extended lane runs in
`.github/workflows/extended.yml` (nightly, or Actions -> extended -> Run workflow
on any branch), and the live Pi compatibility matrix in
`.github/workflows/pi-matrix.yml` (nightly, on demand, and on PRs that touch Pi
alignment).

## Commits & PRs

- Small, focused commits with clear messages.
- Update `CHANGELOG.md` under `## [Unreleased]` for user-visible changes.
- Update the relevant docs (`README.md`, `docs/*`) when behavior changes. A
  feature change must update the repo's own docs — `README.md` **plus** the
  relevant `docs/*.md` — **in the same commit/PR**; skipping this is how
  `docs/extending.md` went a whole release stale.
- Never commit secrets, tenant ids, tokens, `.env`, or generated artifacts (the
  `.gitignore` is set up to prevent this — keep it that way).

## Cutting a release

> **Agents:** cut a release **only** when Aaron explicitly asks for one in the
> current conversation, naming the version or bump level. A clean tree or a
> finished task is never a release trigger — see
> [RELEASE.md](RELEASE.md#when-to-release--explicit-instruction-only).

From a clean working tree on an attached `main` that equals `origin/main` (all changes
committed and pushed, `CHANGELOG.md` updated under `## [Unreleased]`; `coop release`
fetches `origin` and refuses anything else):

```bash
coop release minor        # or: patch | major  (default: patch)
```

`coop release` bumps `VERSION` + the extension manifests, rolls `[Unreleased]` into a
dated `## [X.Y.Z]` section (leaving a fresh `[Unreleased]`), commits, tags `vX.Y.Z`,
and pushes `main` and the tag in one atomic push (both land or neither does). Use
`--no-push` to stop at the local tag, `--yes` to skip the confirm. SemVer in 0.x:
**minor** for features/notable changes, **patch** for fixes.

Pushing the tag is the fleet deployment: `coop update` moves teammates to the newest
`vX.Y.Z` tag on `main` and ignores a tag that is not on `main`, which is why the tag
only travels with `main`. Rollback is a new release, never a moved or deleted tag. See
[RELEASE.md](RELEASE.md#d-coop-agent-this-repo).

coop-agent is one of six coop-\* repos. When a change spans the suite
(core → review tools → agent → website), release in the order documented in
**[RELEASE.md](RELEASE.md)**.

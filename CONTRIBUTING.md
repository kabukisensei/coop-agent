# Contributing to coop-agent

coop-agent is a shared Cooptimize tool. Most contributions are **additive and file-based**
— a new skill, prompt, or vibe — so the bar to contribute is low. Bigger changes
(the wrapper, scripts, extensions) should keep the cross-platform + governance contract.

## Quick contributions (skills / prompts)

Use the scaffolders — they create the right files in the right place:

```bash
coop new-skill <name>     # -> skills/<name>/SKILL.md
coop new-prompt <name>    # -> prompts/<name>.md
```

Edit, test locally with `coop`, then commit and push. Teammates pick it up on their
next `coop update`. See **[docs/extending.md](docs/extending.md)** for skills,
prompts, themes, and writing a Pi extension.

Guidelines:

- Skills stay **advisory and read-only** and reference the `coop-workflow` skill.
- The official Microsoft slot (`skills/_microsoft/`) is **subordinate** — don't add a
  skill whose name collides with a Cooptimize skill.

## Changing code (wrapper / scripts / extensions)

Keep parity and the contract:

- **Cross-platform:** changes to `bin/coop` should be mirrored in `bin/coop.ps1`
  (and `scripts/*.sh` ↔ `scripts/*.ps1`). The bash path is primary; the PowerShell
  path must stay equivalent (same subcommands, dependency lists, `fab`-collision
  detection).
- **Governance:** preserve read-only-first, plan-and-approve, never-commit-source,
  read-only MCP, and never expose secrets.
- **bash 3.2:** macOS ships bash 3.2 (`/bin/bash`) — guard empty-array expansions
  with `${arr[@]+"${arr[@]}"}`, brace a variable expansion that is directly
  followed by multibyte text (`"${var}…"`, not `"$var…"` — 3.2 mis-scans the
  adjacency), and avoid bash-4+ features (associative arrays, `${var,,}`,
  `mapfile`, `&>>`).
- **No new hard deps:** the YAML reader (`lib/_yaml.py`) is dependency-free on purpose
  (system python may lack PyYAML). Don't reintroduce a hard PyYAML dependency.

### PowerShell requirements

- **Every `.ps1` in this repo must start with a UTF-8 BOM** (`EF BB BF`).
  Windows PowerShell 5.1 reads a BOM-less `.ps1` as ANSI, so em-dashes /
  ellipses / box-drawing characters turn into mojibake. Some editors and agent
  file-write tools silently drop the BOM when rewriting a file — re-check after
  any edit.

  Check (the first three bytes must be `efbb bf`):

  ```bash
  head -c3 scripts/doctor.ps1 | xxd
  ```

  Re-add a missing BOM:

  ```bash
  printf '\357\273\277' | cat - file.ps1 > file.ps1.bom && mv file.ps1.bom file.ps1
  ```

- **`.ps1` files re-implement the bash helper logic inline** — they do **not**
  source `lib/common.sh`. When you change a helper in `lib/common.sh` (or logic
  in `bin/coop` / `scripts/*.sh`), port the change into the matching `.ps1` in
  the same PR.
- `scripts/check-parity.sh` (run by CI) fails on any BOM-less `.ps1` and on any
  `scripts/*.sh` without a `scripts/*.ps1` twin (and vice versa) that isn't
  allow-listed as an intentional singleton.

### Testing local changes on macOS

The `coop` command on your PATH is a symlink created by `coop install` — if it
points at a different clone than the one you're editing, you will run stale
code and your changes will appear to have no effect. Verify **before** testing:

```bash
ls -l ~/.local/bin/coop        # must point at YOUR dev clone's bin/coop
```

Fix (from the root of your dev clone):

```bash
ln -sf "$(pwd)/bin/coop" ~/.local/bin/coop    # or re-run: ./bin/coop install
```

When in doubt, invoke the clone directly — `./bin/coop …` always runs the code
you are editing. See `docs/troubleshooting.md` for the full runbook entry.

## Before you open a PR

Run the same checks CI runs:

```bash
for f in bin/coop lib/common.sh scripts/*.sh; do bash -n "$f"; done   # shell syntax
python3 lib/_yaml.py get .coop/project.yml profile.organization MISS  # yaml reader
bash tests/run.sh                                                     # logic tests (extensions + web bridge)
bash scripts/check-parity.sh                                          # bash<->ps1 pairing + .ps1 BOM
coop doctor                                                           # deps + config
```

CI (`.github/workflows/ci.yml`) additionally runs `shellcheck`, validates all
YAML/JSON, transpiles the TypeScript extensions with esbuild, and parses every
`.ps1` on a Windows runner.

## Commits & PRs

- Small, focused commits with clear messages.
- Update `CHANGELOG.md` under `## [Unreleased]` for user-visible changes.
- Update the relevant docs (`README.md`, `docs/*`) when behavior changes.
- Never commit secrets, tenant ids, tokens, `.env`, or generated artifacts (the
  `.gitignore` is set up to prevent this — keep it that way).

## Cutting a release

From a clean working tree (all changes committed, `CHANGELOG.md` updated under
`## [Unreleased]`):

```bash
coop release minor        # or: patch | major  (default: patch)
```

`coop release` bumps `VERSION` + the extension manifests, rolls `[Unreleased]` into a
dated `## [X.Y.Z]` section (leaving a fresh `[Unreleased]`), commits, tags `vX.Y.Z`,
and pushes the commit + tag. Use `--no-push` to stop at the local tag, `--yes` to skip
the confirm. SemVer in 0.x: **minor** for features/notable changes, **patch** for fixes.

coop-agent is one of six coop-\* repos. When a change spans the suite
(core → review tools → agent → website), release in the order documented in
**[RELEASE.md](RELEASE.md)**.

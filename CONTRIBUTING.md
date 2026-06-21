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
- **bash 3.2:** macOS ships bash 3.2 — guard empty-array expansions with
  `${arr[@]+"${arr[@]}"}` and avoid bashisms that need 4.x.
- **No new hard deps:** the YAML reader (`lib/_yaml.py`) is dependency-free on purpose
  (system python may lack PyYAML). Don't reintroduce a hard PyYAML dependency.

## Before you open a PR

Run the same checks CI runs:

```bash
for f in bin/coop lib/common.sh scripts/*.sh; do bash -n "$f"; done   # shell syntax
python3 lib/_yaml.py get .coop/project.yml profile.organization MISS  # yaml reader
coop doctor                                                           # deps + config
```

CI (`.github/workflows/ci.yml`) additionally runs `shellcheck`, validates all
YAML/JSON, and transpiles the TypeScript extensions with esbuild.

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

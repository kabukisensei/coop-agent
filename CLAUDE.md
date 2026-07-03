@AGENTS.md

# Maintainer notes — developing coop-agent itself

AGENTS.md (above) carries coop's runtime context for work repos **plus** the
canonical "Maintaining this repo" section — environment, platform notes,
before-work git rules, verification commands, and the release guard. Read that
first; this section adds architecture detail for working ON this repo.

## Architecture

- coop is a **branded layer over Pi** (`@earendil-works/pi-coding-agent`), not a
  fork: `bin/coop` (bash) and `bin/coop.ps1` (PowerShell twin) assemble Pi's
  launch flags from one shared builder (`coop launch-spec --json`) and exec `pi`
  against the isolated agent dir (`~/.coop/agent`).
- The companion extensions (`extensions/coop-powerline`, `coop-tools`,
  `coop-guardrails`) are **loaded at launch** via `pi -e` straight from this
  repo — nothing is built or installed for them.
- `lib/_extdeps.py` aligns the `@earendil-works/pi-ai` / `pi-tui` versions
  between the Pi agent and coop's isolated extension tree. **Drift means Pi
  won't start** — the launch preflight (`coop_launch_preflight` in
  `lib/common.sh`) guards this; never bypass it casually.
- `lib/_yaml.py` is a **dependency-free** YAML reader. Never assume PyYAML is
  installed (fresh machines lack it); never add a hard PyYAML dependency.

## Test

```bash
bash tests/run.sh              # bundles the TS extensions with esbuild, runs all Node suites
bash scripts/check-parity.sh   # bash <-> PowerShell pairing + .ps1 UTF-8 BOM gate
```

## Pointers

- `CONTRIBUTING.md` — parity rules, bash 3.2, PowerShell BOM, local-testing pitfalls
- `RELEASE.md` — cross-repo release runbook for the whole coop-* suite
- `docs/troubleshooting.md` — split Node toolchains, `fab` collision, stale `coop` symlink
- `docs/ui-strategy.md` — why `coop web` exists and the RPC lessons behind it

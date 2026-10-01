@AGENTS.md

# Maintainer notes — developing coop-agent itself

AGENTS.md (above) carries coop's runtime context for work repos **plus** the
canonical "Maintaining this repo" section — environment, platform notes,
before-work git rules, verification commands, and the release guard. Read that
first; this section adds architecture detail for working ON this repo.

## Architecture

- coop is a **branded layer over Pi** (`@earendil-works/pi-coding-agent`), not a
  fork: `bin/coop.ps1` (PowerShell; `bin/coop.cmd` and the Git Bash forwarder
  `bin/coop` call it) assembles Pi's launch flags from one shared builder
  (`coop launch-spec --json`) and execs `pi` against the isolated agent dir
  (`~/.coop/agent`). There is no bash product path (master plan S1).
- The companion extensions (`extensions/coop-powerline`, `coop-tools`,
  `coop-guardrails`) are **loaded at launch** via `pi -e` straight from this
  repo — nothing is built or installed for them.
- `lib/_extdeps.py` aligns the `@earendil-works/pi-ai` / `pi-tui` versions
  between the Pi agent and coop's isolated extension tree. **Drift means Pi
  won't start** — the launch preflight (`Invoke-CoopLaunchPreflight` in
  `bin/coop.ps1`) guards this; never bypass it casually.
- `lib/_yaml.py` is a **dependency-free** YAML reader. Never assume PyYAML is
  installed (fresh machines lack it); never add a hard PyYAML dependency.

## Test

```bash
bash tests/run.sh              # gate lane: bundles the TS extensions with esbuild, runs the deterministic suites
pwsh -NoProfile -File tests/run.ps1      # the PowerShell suite (coop's own lane), gate lane
COOP_TEST_EXTENDED=1 bash tests/run.sh   # gate + extended lanes (full suite; optional per change, `coop release` runs it)
bash scripts/check-bom.sh      # .ps1 UTF-8 BOM gate
```

Lanes and fixture rules: `docs/ci.md`, "coop-agent's own CI (maintainers): gate and extended lanes".

## Pointers

- `CONTRIBUTING.md` — PowerShell 5.1 rules, the BOM gate, local-testing pitfalls
- `RELEASE.md` — cross-repo release runbook for the whole coop-* suite
- `docs/troubleshooting.md` — `fab` collision, Fabric CLI Python, stale `coop` launcher
- `docs/history/ui-strategy.md` — why `coop web` existed and the RPC lessons behind it (history; the roadmap is `docs/COOP_MASTER_PLAN.md`)

# CI — the lineage-docs gate

The coop suite ships one CI-ready gate: the **coop-data-doc** lineage-docs check.
This page is the copy-paste recipe for running it in **GitHub Actions** and
**Azure DevOps** — same job, same flags, same exit codes on both.

Maintainers: coop-agent's own test lanes and CI checks are at the end of this page, in
[coop-agent's own CI (maintainers): gate and extended lanes](#coop-agents-own-ci-maintainers-gate-and-extended-lanes).

| Gate | Tool | Runs against | Fails the build when |
| --- | --- | --- | --- |
| lineage docs | `coop-data-doc` | the docs project (`coop-data-doc.yml`) | committed docs are stale, or the strict rebuild hits unresolved references / risky parses / corrupt files |

SQL and DAX standards are **not** a CI gate any more. The former `coop-sql-review`
and `coop-dax-review` jobs (and their SARIF upload) were retired in ST1: coop now
applies the `cooptimize/coop-standards` wiki articles while it writes SQL, DAX and
semantic-model changes and self-checks its diff against them before presenting a
change. Delete those jobs from an existing `coop-gates.yml`; the `security-events:
write` permission they needed goes with them.

> **Windows-first team, ubuntu agents.** Even if every workstation is Windows,
> run the gate on the hosted **ubuntu** images (GitHub `ubuntu-latest`, ADO
> `vmImage: ubuntu-latest`): they're the fastest queue, `pipx` is preinstalled,
> and the tool is deterministic and cross-platform — a finding on Linux is the
> same finding on Windows.

## Philosophy: advisory by default, `--strict` is the CI opt-in

`coop-data-doc build` is **advisory** — run interactively it reports and exits
`0`; it never edits source. `--strict` is the deliberate opt-in that turns the
rebuild into a gate (exit `2` when problems remain). That's why the build step
below carries `--strict` explicitly: the red build is a choice the team made in
the pipeline file, not tool behavior someone has to remember. `coop-data-doc
check` is always a gate: it exists to catch docs that drifted from the source.

## Exit codes (the family contract)

**0 = clean, 1 = environment problem, 2 = findings** (the thing the gate exists
to catch):

| Exit | `coop-data-doc check` | `coop-data-doc build --non-interactive --strict` |
| --- | --- | --- |
| `0` | docs up to date | build clean |
| `1` | environment: docs stale, or friendly error / config not found | environment: friendly error / config not found |
| `2` | unresolved references, risky parses, corrupt/undecodable files | unresolved references, risky parses, error-severity diagnostics; invalid args |

## Where it runs, and the one internal rule

- **The docs gate is location-bound.** It must run in the **docs project** — the
  checkout that holds `coop-data-doc.yml`, the committed `data-docs/` output, and
  (checked out at the configured relative paths) every repo the config
  references. Multi-repo docs projects need a multi-checkout: `actions/checkout`
  with `path:` on GitHub, multiple `checkout:` steps on ADO.
- **Inside the job, `check` runs before `build`.** `check` compares the
  *committed* docs against the source (exit `1` = someone changed SQL/model
  source without rebuilding the docs). `build` rewrites the docs in the CI
  workspace, so a `check` after it would trivially pass.

## GitHub Actions

Run `coop init --ci github` in your work repo to generate this pipeline
(`.github/workflows/coop-gates.yml`) from `lib/_ciscaffold.py`, or drop the
template in by hand. The generator needs a `coop-data-doc.yml` in the repo (set
one up with `coop data-doc setup` or `/setup-docs`); without one it writes nothing
and says so. It also reads `.coop/project.yml`, so a malformed contract fails
there.

```yaml
name: coop gates

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  data-docs:
    name: Lineage docs freshness + strict rebuild (coop-data-doc)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Pin the version — see "Pinning the tool version" below.
      - name: Install coop-data-doc
        run: pipx install coop-data-doc==<version>   # the manifest's python_tools pin

      # Freshness first: compares the COMMITTED docs against the source.
      # Exit 1 = stale (someone changed source without rebuilding the docs);
      # exit 2 = unresolved references / risky parses / corrupt files.
      # Must run BEFORE build, which rewrites the docs in this workspace.
      - name: Docs freshness gate
        run: coop-data-doc check

      # Strict rebuild: --non-interactive never prompts; --strict exits 2 on
      # unresolved references, risky parses, or error-severity diagnostics.
      - name: Build lineage docs (strict)
        run: coop-data-doc build --non-interactive --strict

      # manifest.json / graph.json are the machine-readable lineage graph;
      # data-docs-site/ is the human portal (works over file:// — download,
      # unzip, open index.html).
      - name: Upload built docs
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coop-data-docs
          path: |
            data-docs/
            data-docs-site/
```

## Azure DevOps

Run `coop init --ci ado` in your work repo to generate this pipeline
(`azure-pipelines/coop-gates.yml`), or drop the template in by hand. Same job,
same flags. PR validation on Azure Repos comes from a **branch policy** ("Build
validation" on the target branch) that runs this pipeline — not from a `pr:`
trigger.

```yaml
# coop suite gates — lineage-docs job, hosted ubuntu agents.
trigger:
  branches:
    include:
      - main

pool:
  vmImage: ubuntu-latest

stages:
  - stage: coop_gates
    displayName: coop suite gates
    jobs:
      - job: data_docs
        displayName: Lineage docs freshness + strict rebuild (coop-data-doc)
        steps:
          - checkout: self

          - script: pipx install coop-data-doc==<version>   # the manifest's python_tools pin
            displayName: Install coop-data-doc

          # Freshness first (committed docs vs source) — see the ordering note
          # above; `build` would make a later `check` trivially pass.
          - script: coop-data-doc check
            displayName: Docs freshness gate

          - script: coop-data-doc build --non-interactive --strict
            displayName: Build lineage docs (strict)

          - task: PublishPipelineArtifact@1
            condition: succeededOrFailed()
            displayName: Publish built docs (lineage graph + Markdown)
            inputs:
              targetPath: data-docs
              artifact: coop-data-docs

          - task: PublishPipelineArtifact@1
            condition: succeededOrFailed()
            displayName: Publish docs portal (open index.html)
            inputs:
              targetPath: data-docs-site
              artifact: coop-data-docs-site
```

## Paths: `coop-data-doc.yml` owns them

The docs job needs no path argument: `coop-data-doc` finds `coop-data-doc.yml`
in the working directory (or walks up, like git); point it elsewhere with
`--config PATH` or `COOP_DATA_DOC_CONFIG`. The repo paths inside that file come
from your `.coop/project.yml` `repositories:` block when you generate it with
`coop init --seed-docs`, so CI and the agent read the same trees; update both
together when the layout moves.

## Pinning the tool version

Replace the `==<version>` in this page with the coop-data-doc pin from
`config/release-manifest.json` → `python_tools` (the one manifest;
`coop init --ci github|ado` generates a pipeline with it filled in). Pinning keeps
pipelines reproducible: a new tool release can change what resolves, and an
unpinned pipeline would go red on a change nobody made. Bump the pin
deliberately (a small PR that updates the `==` version), the same way you'd bump
any other CI dependency. `pipx install 'pkg==X.Y.Z'` is the whole mechanism;
`pipx` also accepts `--pip-args` for anything fancier (extra indexes,
constraints files).

## coop-agent's own CI (maintainers): gate and extended lanes

Everything above is the pipeline you give a client repo. This section covers
testing coop-agent itself, whose test suite is split into two **lanes**. Here,
"gate" names the default lane and the one `gate` check in `ci.yml`; the
client-repo gates above are a different thing.

### The lanes

| Lane | Run it locally | Where CI runs it | What it holds |
| --- | --- | --- | --- |
| gate (default) | `bash tests/run.sh` | `.github/workflows/ci.yml` on every PR and every push to `main` | Deterministic logic tests. The same workflow also runs `bash -n` and shellcheck over the bash dev tooling, JSON, YAML and skill validation, the esbuild transpile, `tests/run.ps1` (which starts with `scripts/check-bom.ps1`), and the `.ps1` parse under pwsh 7 and Windows PowerShell 5.1 with PSScriptAnalyzer. Its `installer (Windows)` job builds the coop window package (master plan D1c) as the `coop-window-installer` artifact, installs it silently on the runner, runs `coop.exe --doctor` and uninstalls (`desktop/scripts/verify-installer.mjs`, which refuses any host but an opted-in GitHub-hosted Windows runner). |
| extended | `COOP_TEST_EXTENDED=1 bash tests/run.sh` | `.github/workflows/extended.yml`: nightly, on demand, and on a PR that changes that file | The gate lane plus the timing and process fixtures. The two lanes together are the full suite. |
| Pi matrix | `pwsh -NoProfile -File scripts/test-pi-matrix.ps1 -PiVersion <pi-version>` (needs the network; installs that Pi from npm into a temp prefix) | `.github/workflows/pi-matrix.yml`: nightly, on demand, and on a PR that touches Pi alignment | `scripts/test-pi-matrix.ps1` against the pinned Pi release on Windows. |

`COOP_TEST_EXTENDED` is the only switch. Unset or `0` runs the gate lane; `1`
runs both lanes. `tests/run.ps1` reads the same variable. Each run names its lane
when it starts and again in its last line; for `tests/run.sh` that line is
`✓ all tests passed (gate lane)` or `✓ all tests passed (gate + extended lanes)`.

Both `ci.yml` and `extended.yml` run the suite on three hosts: ubuntu
(`bash tests/run.sh`, then `tests/run.ps1` under pwsh 7), Windows Git Bash
(`bash tests/run.sh`) and Windows PowerShell 5.1
(`powershell -NoProfile -File tests\run.ps1`, the runtime `bin/coop.cmd` uses).
`extended.yml` adds a fourth Windows job, `datadoc-windows` (master plan row
11a): it installs `coop-data-doc` at the manifest pin with pipx and the pinned Pi
from npm, then runs `tests/datadoc-live.test.mjs` from Windows PowerShell 5.1 with
`COOP_TEST_DATADOC_REQUIRED=1`. That test drives `/setup-docs` and the `data_doc`
tool through Pi's own exec and real pipes against a synthetic mixed estate with
non-ASCII names. Elsewhere it runs in the extended block of `tests/run.sh` and
skips when no `coop-data-doc` 1.3.0+ is on `PATH`.
`tests/run.ps1` is coop's own lane: the product is PowerShell, so the
behavioural fixtures under `tests/fixtures/*.test.ps1` drive `bin/coop.ps1`,
`lib/common.ps1` and `scripts/*.ps1` directly. `tests/run.sh` holds the Node and
Python logic tests and the bash-harness suites; `bash` there is dev tooling.

### Which suites are in which lane

The run scripts are the list; this page does not repeat it.

- `tests/run.sh` runs the gate suites first. The extended suites are in one block
  headed `EXTENDED LANE` at the end of the file, which runs only when
  `COOP_TEST_EXTENDED=1`.
- `tests/run.ps1` marks its in-process extended sections `EXTENDED LANE` where
  they stand, and its child fixtures sit in one table with a lane column
  (`gate` / `extended`); an extended row runs only with `COOP_TEST_EXTENDED=1`.
- Some gate files keep a few extended-only cases (hang, watchdog or
  live-process cases) behind the same variable inside the file. The header of
  `tests/run.sh` names them.
- `tests/repro-tmp-contamination.sh` is a manual reproducer, not a test, and no
  lane runs it. Run it by hand with `bash tests/repro-tmp-contamination.sh`.

### Fixture rules

- A gate fixture is deterministic logic. It may not sleep, poll or wait for a
  subprocess, drive a PTY, wait on a marker file, use a hang or timeout fixture,
  depend on machine load, or reach the network.
- No fixture touches the checkout that runs the tests. A fixture that runs
  `git fetch`, `git pull`, or doctor (which fetches `origin` on a throttle) works
  on a copy of the tree without `.git` (the #104 pattern). A fixture that only
  runs doctor may instead pre-write a fresh `.coop-fetch-stamp` in its temp agent
  dir so the throttled fetch never runs (`tests/standards-rev9.test.mjs`).
- No fixture touches the real home. Point `HOME`, `USERPROFILE`, `COOP_DIR`,
  `COOP_AGENT_DIR`, `PI_CODING_AGENT_DIR` and the standards roots
  (`COOP_STANDARDS_ROOT`, `COOP_STANDARDS_STATE`, `COOP_STANDARDS_SNAPSHOT_ROOT`)
  at temp directories, so the fixture is also safe to run on its own. `COOP_DIR`
  is the parent of `.coop`: a fixture that sets `COOP_DIR=X` finds (and onboarding
  writes) the profile at `X/.coop` (`config`, `user.json`, `support/`), and the
  agent dir at `X/.coop/agent` unless `COOP_AGENT_DIR` or `PI_CODING_AGENT_DIR`
  points elsewhere (`tests/fixtures/profile-root.test.ps1`, `tests/coop-paths.test.py`,
  `tests/paths.test.mjs` prove the chain in each language). As a
  backstop, `tests/run.sh` gives every gate test a temp home: it points `HOME`
  and `USERPROFILE` at a temp directory and unsets the other variables so they
  resolve inside it. `tests/run.ps1` does the same for the processes it starts,
  with `COOP_DIR` and the agent dirs pointed at temp directories of their own.
- A Windows-only behavior gets one Windows test, not a synthetic matrix.
- A bug fix adds the one test that reproduced the bug.
- A new timing or process fixture goes in the extended lane, and its PR says why.
- Moving a test between lanes never weakens it. No assertion is skipped,
  disabled or loosened to turn a lane green.
- The repo-wide `.ps1` UTF-8 BOM check lives in one place,
  `scripts/check-bom.ps1` (the first section of `tests/run.ps1`). Do not add
  another.

### Running the extended lane

- Locally: `COOP_TEST_EXTENDED=1 bash tests/run.sh`.
- In CI: Actions -> extended -> Run workflow, on any branch.
- `coop release` runs both lanes. Its pre-tag gate (`scripts/release.sh`, and
  `bin/coop.ps1` on Windows) runs `COOP_TEST_EXTENDED=1 bash tests/run.sh`,
  `tests/run.ps1` and `scripts/check-bom.ps1`, so every release keeps the full
  suite's coverage. See `RELEASE.md`.

The Windows terminal-workstation acceptance workflow runs `tests\run.ps1` with
`COOP_TEST_EXTENDED=1`, so its behavioral-suite receipt covers both lanes.

The extended block of `tests/run.sh` keeps the gate lane's temp home (#135).
`tests/fixtures/home-guard.test.ps1` (run by `tests/run.ps1`) is the one exception: it reads the real `~/.local/bin`
and `~/.coop` on purpose, to prove the fleet paths leave them alone. The fixtures
that run doctor, update, sync or a launch (`doctor`, `inventory`,
`fleet-execution`, `first-run`) work on a copy of the tree without `.git` or
pre-write a fresh fetch stamp.

As a backstop, `tests/run.sh` records the caller's `~/.coop` and `~/.azure`
(path, size and modification time of every file) and this checkout's `HEAD`,
refs and `FETCH_HEAD` before any test runs. It fails the run if a test changed
them. Pi session transcripts and az's own logs and caches are left out, because a
coop session or `az` command running at the same time writes them. If the check
fails while one of those was running, close it and rerun.

### Pi matrix triggers

`pi-matrix.yml` runs nightly, from Actions -> pi-matrix -> Run workflow, and on a
pull request that changes any of these paths:

- `scripts/sync.ps1`
- `lib/_extdeps.py`
- `config/release-manifest.json`
- `extensions/**`
- `scripts/test-pi-matrix.*`
- `tests/guardrails-pi-runner.test.mjs`
- `.github/workflows/pi-matrix.yml`

A PR that changes how coop installs, aligns or loads Pi without touching these
paths should run the workflow by hand before it merges.

### The `gate` check

`ci.yml` ends with a job named `gate`. It needs every other `ci.yml` job, runs
even when one of them fails (`if: always()`), and passes only when every one of
them finished with `success`, so a failed, cancelled or skipped job fails it.
If `main` requires a status check, require `gate`; the job names above it can
then change without touching the rule. A new `ci.yml` job must be added to the
`gate` job's `needs:` list. `extended.yml` and `pi-matrix.yml` do not feed `gate`.

## See also

- [onboarding.md](onboarding.md) — get `coop` itself running on a workstation
- [tool-contract.md](tool-contract.md) — how the agent calls the same tool natively
- The tool's own README — every flag above is documented there:
  [coop-data-doc](https://github.com/kabukisensei/coop-data-doc)

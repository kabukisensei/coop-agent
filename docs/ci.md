# CI — the three-gate suite pipeline

The coop suite ships three CI-ready gates. This page is the copy-paste recipe for
running them in **GitHub Actions** and **Azure DevOps** — same gates, same flags,
same exit codes on both.

| Gate | Tool | Runs against | Fails the build when (`--strict`) |
| --- | --- | --- | --- |
| 1 — SQL standards | `coop-sql-review` | the SQL repo (`.sql` files) | findings at/above the severity floor, a **real syntax error**, or zero `.sql` files checked |
| 2 — DAX / model standards | `coop-dax-review` | the Power BI repo (TMDL / `.bim` models) | findings at/above the severity floor, a broken measure (`syntax_error`), or zero models checked |
| 3 — lineage docs | `coop-data-doc` | the docs project (`coop-data-doc.yml`) | committed docs are stale, or the rebuild hits unresolved references / risky parses / corrupt files |

> **Windows-first team, ubuntu agents.** Even if every workstation is Windows,
> run these gates on the hosted **ubuntu** images (GitHub `ubuntu-latest`, ADO
> `vmImage: ubuntu-latest`): they're the fastest queue, `pipx` is preinstalled,
> and the tools are deterministic and cross-platform — a finding on Linux is the
> same finding on Windows (identical line numbers, ASCII-safe output).

## Philosophy: advisory by default, `--strict` is the CI opt-in

All three tools are **advisory** — run interactively they report and always exit
`0`; they never edit or block. `--strict` is the deliberate opt-in that turns a
run into a gate (exit `2` when problems remain). That's why every review step
below carries `--strict` explicitly: the red build is a choice the team made in
the pipeline file, not tool behavior someone has to remember.

Adopting on an existing estate? Don't turn a wall of legacy findings into a
permanently red build — both review tools support a **baseline** ratchet
(`--write-baseline` once, then `--baseline` in CI surfaces only *new* findings),
inline ignores, and a `rules.yml` ignore list. See each tool's README, §
"Adopting on an existing code base".

## Exit codes per gate (the family contract)

All three tools follow the same contract: **0 = clean, 1 = environment problem,
2 = findings** (the thing the gate exists to catch). Per gate:

| Exit | `coop-sql-review check --strict` | `coop-dax-review check --strict` | `coop-data-doc check` | `coop-data-doc build --non-interactive --strict` |
| --- | --- | --- | --- | --- |
| `0` | clean at/above the floor | clean at/above the floor | docs up to date | build clean |
| `1` | environment: unwritable output file (`-o` / `--html` / `--md`) | environment: unwritable output file | environment: docs stale, or friendly error / config not found | environment: friendly error / config not found |
| `2` | findings, a real syntax error (any error-severity diagnostic), or **zero `.sql` files checked**; also CLI usage errors | findings or **zero models checked**; also CLI usage errors | unresolved references, risky parses, corrupt/undecodable files | unresolved references, risky parses, error-severity diagnostics; invalid args |

Two details worth knowing:

- **A typo'd path cannot pass as clean.** Under `--strict`, a run that checked
  zero files/models exits `2` (with a `scan_empty` diagnostic), so a renamed
  folder fails the gate instead of silently gating nothing.
- **Genuinely broken source fails the gate even with zero standards findings** —
  invalid T-SQL that would fail Fabric's import, or a DAX measure with
  unbalanced parens, surfaces as an error-severity `syntax_error` diagnostic and
  flips `--strict` to exit `2`.

## Ordering: three independent gates, one internal rule

- **The gates are independent — run them as parallel jobs.** No gate consumes
  another's output, and a DAX finding shouldn't hide a SQL syntax error, so let
  each fail on its own. If SQL and Power BI live in separate repos (the usual
  Cooptimize layout), put each review job in its own repo's pipeline.
- **Only the docs gate is location-bound.** Gates 1–2 run wherever the source
  lives; gate 3 must run in the **docs project** — the checkout that holds
  `coop-data-doc.yml`, the committed `data-docs/` output, and (checked out at
  the configured relative paths) every repo the config references. Multi-repo
  docs projects need a multi-checkout: `actions/checkout` with `path:` on
  GitHub, multiple `checkout:` steps on ADO.
- **Inside the docs job, `check` runs before `build`.** `check` compares the
  *committed* docs against the source (exit `1` = someone changed SQL/model
  source without rebuilding the docs). `build` rewrites the docs in the CI
  workspace, so a `check` after it would trivially pass.

## GitHub Actions

Drop this in `.github/workflows/coop-gates.yml`. Replace `sql/` and
`semantic-models/` with your real paths (see [Paths](#paths-reuse-coopprojectyml)),
and split the jobs across repos if SQL / Power BI / docs live apart.

```yaml
name: coop gates

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  security-events: write   # required by the SARIF upload to code scanning

jobs:
  sql-review:
    name: SQL standards (coop-sql-review)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Pin the version — see "Pinning tool versions" below.
      - name: Install coop-sql-review
        run: pipx install coop-sql-review==0.8.0

      # --strict + --min-severity warning: fail on warnings and errors; info-level
      # style suggestions stay out of the gate (drop --min-severity to include them).
      # --format sarif -o: SARIF 2.1.0 for inline PR annotations via code scanning.
      # --html / --md: extra human-readable report sinks (they compose with --format).
      # Checking Azure serverless SQL instead of Fabric DW? Add: --target azure-sql
      - name: SQL standards review
        run: >
          coop-sql-review check sql/
          --strict --min-severity warning
          --format sarif -o coop-sql-review.sarif
          --html coop-sql-review.html
          --md coop-sql-review.md

      # if: always() — the SARIF must upload precisely when the gate fails
      # (that's when you want the inline annotations).
      - name: Upload SARIF to code scanning
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: coop-sql-review.sarif

      - name: Upload review reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coop-sql-review-report
          path: |
            coop-sql-review.sarif
            coop-sql-review.html
            coop-sql-review.md

  dax-review:
    name: DAX / model standards (coop-dax-review)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install coop-dax-review
        run: pipx install coop-dax-review==0.11.0

      # coop-dax-review has no SARIF output yet (it lands in an upcoming release —
      # switch this job to the sql-review shape when it does). Until then the gate
      # is exit-code-based, with HTML/Markdown reports as build artifacts.
      - name: DAX standards review
        run: >
          coop-dax-review check semantic-models/
          --strict --min-severity warning
          --html coop-dax-review.html
          --md coop-dax-review.md

      - name: Upload review reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coop-dax-review-report
          path: |
            coop-dax-review.html
            coop-dax-review.md

  data-docs:
    name: Lineage docs freshness + strict rebuild (coop-data-doc)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install coop-data-doc
        run: pipx install coop-data-doc==0.30.1

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

Drop this in `azure-pipelines.yml`. Same three gates, same flags. PR validation
on Azure Repos comes from a **branch policy** ("Build validation" on the target
branch) that runs this pipeline — not from a `pr:` trigger.

```yaml
# coop suite gates — three independent jobs, hosted ubuntu agents.
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
      - job: sql_review
        displayName: SQL standards (coop-sql-review)
        steps:
          - checkout: self

          - script: pipx install coop-sql-review==0.8.0
            displayName: Install coop-sql-review

          # Same flags as the GitHub job. SARIF goes into a folder that is
          # published as the CodeAnalysisLogs artifact (the Scans-tab convention).
          # Checking Azure serverless SQL instead of Fabric DW? Add: --target azure-sql
          - script: |
              mkdir -p "$(Build.ArtifactStagingDirectory)/CodeAnalysisLogs" "$(Build.ArtifactStagingDirectory)/reports"
              coop-sql-review check sql/ \
                --strict --min-severity warning \
                --format sarif -o "$(Build.ArtifactStagingDirectory)/CodeAnalysisLogs/coop-sql-review.sarif" \
                --html "$(Build.ArtifactStagingDirectory)/reports/coop-sql-review.html" \
                --md "$(Build.ArtifactStagingDirectory)/reports/coop-sql-review.md"
            displayName: SQL standards review

          # The free "SARIF SAST Scans Tab" extension (Microsoft DevLabs) renders
          # every .sarif inside a BUILD artifact named exactly CodeAnalysisLogs as
          # a "Scans" tab on the run — ADO's equivalent of GitHub's code-scanning
          # annotations. It reads build artifacts, hence PublishBuildArtifacts@1
          # here (not PublishPipelineArtifact@1).
          # succeededOrFailed(): publish precisely when the gate fails.
          - task: PublishBuildArtifacts@1
            condition: succeededOrFailed()
            displayName: Publish SARIF (Scans tab)
            inputs:
              PathtoPublish: $(Build.ArtifactStagingDirectory)/CodeAnalysisLogs
              ArtifactName: CodeAnalysisLogs

          - task: PublishPipelineArtifact@1
            condition: succeededOrFailed()
            displayName: Publish review reports
            inputs:
              targetPath: $(Build.ArtifactStagingDirectory)/reports
              artifact: coop-sql-review-report

      - job: dax_review
        displayName: DAX / model standards (coop-dax-review)
        steps:
          - checkout: self

          - script: pipx install coop-dax-review==0.11.0
            displayName: Install coop-dax-review

          # No SARIF from coop-dax-review yet (it lands in an upcoming release —
          # switch this job to the sql_review shape when it does). Exit-code gate
          # + HTML/Markdown report artifacts until then.
          - script: |
              mkdir -p "$(Build.ArtifactStagingDirectory)/reports"
              coop-dax-review check semantic-models/ \
                --strict --min-severity warning \
                --html "$(Build.ArtifactStagingDirectory)/reports/coop-dax-review.html" \
                --md "$(Build.ArtifactStagingDirectory)/reports/coop-dax-review.md"
            displayName: DAX standards review

          - task: PublishPipelineArtifact@1
            condition: succeededOrFailed()
            displayName: Publish review reports
            inputs:
              targetPath: $(Build.ArtifactStagingDirectory)/reports
              artifact: coop-dax-review-report

      - job: data_docs
        displayName: Lineage docs freshness + strict rebuild (coop-data-doc)
        steps:
          - checkout: self

          - script: pipx install coop-data-doc==0.30.1
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

## Paths: reuse `.coop/project.yml`

`sql/` and `semantic-models/` above are placeholders. Your work repo's
`.coop/project.yml` `repositories:` block already names the real trees the agent
reviews — e.g. the `fabric_dw` repo's `sql_root:` and the `fabric` repo's model
folders. Use the **same values** in the pipeline so CI and the agent gate the
same code, and update both together when the layout moves.

The docs job needs no path argument at all: `coop-data-doc` finds
`coop-data-doc.yml` in the working directory (or walks up, like git); point it
elsewhere with `--config PATH` or `COOP_DATA_DOC_CONFIG`.

## Pinning tool versions

The pins in this page (`coop-sql-review==0.8.0`, `coop-dax-review==0.11.0`,
`coop-data-doc==0.30.1`) match `config/defaults.yml` → `tested_with` — the
versions coop was last verified against — at the time of writing. Pinning keeps
pipelines reproducible: a new tool release can add rules, and an unpinned
pipeline would go red on a change nobody made. Bump the pins deliberately (a
small PR that updates the `==` versions), the same way you'd bump any other CI
dependency. `pipx install 'pkg==X.Y.Z'` is the whole mechanism; `pipx` also
accepts `--pip-args` for anything fancier (extra indexes, constraints files).

## See also

- [onboarding.md](onboarding.md) — get `coop` itself running on a workstation
- [tool-contract.md](tool-contract.md) — how the agent calls the same tools natively
- The tools' own READMEs — every flag above is documented there:
  [coop-sql-review](https://github.com/kabukisensei/coop-sql-review),
  [coop-dax-review](https://github.com/kabukisensei/coop-dax-review),
  [coop-data-doc](https://github.com/kabukisensei/coop-data-doc)

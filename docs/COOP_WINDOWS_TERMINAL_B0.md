# B0 — Windows terminal baseline reconciliation

**September 19, 2026 · Review complete; B1 proposed, not authorized or implemented.**

The user explicitly started B0, requested E: working storage, and identified the C: Coop installation as live client work that must remain undisturbed. This receipt supersedes the preparation handoff's *unknown workstation baseline* entry. It does not certify the installation free of defects or authorize changes to it.

## Decision

Select **`9e8248a8b34a0bd7581b1909bf4fd18f253b3350`** as the accepted terminal source baseline to preserve and use for beta ancestry. It is the actual installed checkout, the preparation seed, and the PR #66 merge. Do not roll it back to v0.23.3, update the live checkout to today's main, or reset the experimental branch.

This is an **operational preservation baseline with explicit exceptions**, not a fully reproducible package baseline or safety approval. Two historical guardrail defects were reproduced; MCP package/cache drift also remains. These are documented below with proposed owners and acceptance gates. The [B1 proposal](COOP_WINDOWS_TERMINAL_B1_PROPOSAL.md) is the only proposed next implementation package. Guardrail repairs require separate authorization and changes.

## Source and manifest identity

**Later authorized follow-up:** G01/G02 repairs and a third confirmed dynamic MCP
wrapper classification defect (G03) are proposed in [PR #71](https://github.com/kabukisensei/coop-agent/pull/71).
That repair is separate from this historical B0 inspection; the live preservation
baseline remains unchanged. B1 is still unstarted. The [PK1 fit review](COOP_PACKAGE_FIT_REVIEW.md)
adds requested optional-package research without installation or adoption.

| Identity | Observed value |
| --- | --- |
| Repository | [kabukisensei/coop-agent](https://github.com/kabukisensei/coop-agent) |
| Live checkout | `C:\Users\quiddity\coop-agent`, branch `main`, clean tracked/untracked Git status at inspection |
| Installed/source baseline SHA | `9e8248a8b34a0bd7581b1909bf4fd18f253b3350` |
| Released comparison | `v0.23.3`, commit `969153246bdeb4d2a8d8f4aadec82df7cadacec4` |
| Release-to-baseline history | 60 commits ahead, zero behind; this is commit ancestry, not 60 independent accepted features |
| Product version | `VERSION` / manifest remain `0.23.3`; no new release identity is implied |
| Installed manifest SHA-256 | `169a806a681ee8425e701ed2dc1676b2c0fbe59f9622b093b1ba2bafa47e2dec` |
| Manifest Git blob | `5fef77da67bb7f7753f9bf7cf5547b62305a582a` |
| Fresh review clone | `E:\coop`; cloned independently, fetched, clean, fast-forward check passed before document edits |
| Main and experimental at review | Both `a339dff88a66a53b884e26bd903faad272f2cb21` |
| Main/experimental versus baseline | Only `AGENTS.md` and three preparation/plan Markdown files differ; runtime, manifest, extensions and tests are identical |
| E: manifest raw SHA-256 | `2faeaadcdf01e7c6181de05630cbba97fde6d4949fa9a753fef504a8f7e71cea`; CRLF checkout bytes differ from the installed LF file; Git blob and LF-normalized content match |

The live checkout's cached `origin/main` still reports its earlier position. Fresh remote state was read through the E: clone; no fetch, pull, checkout, configuration change or Git repair was performed in C:. The existing experimental branch already descends from the selected baseline and retains newer preparation documentation. It needs no reset or recreation.

### Reconciliation of the released tag and installed changes

| Change family | Representative commits / files | Disposition and evidence |
| --- | --- | --- |
| Session live-read grants | `425c390`, `06ea9c8`, `d918ecf`, `f832549`; `extensions/coop-guardrails/index.ts` | Preserve verified runtime scope, revocation/session reset, proxy identity and transaction-control exclusions. Current registered-handler suite passes; exception handling remains a separate defect. |
| Governed native SQL fallback | `82bc5f9`, `a424503`, `d44ec08`, `4684f70`; `lib/fabric_sql_query.py`, `extensions/coop-tools/index.ts` | Preserve explicit endpoint identity, bounded execution, rows/result contract and single intended executor. Offline fallback suite passes in B0. Prior installed constant-query evidence is retained as historical evidence only. |
| Token renewal and Windows supervision | `51a778d` through `267f36a`, process-tree fixes, subsequent native fixture/launch fixes | Preserve per-request tokens, identity checks, token containment, owned process cleanup and truthful launch failure. Hosted Windows evidence is green; B0 did not repeat real auth or process-tree experiments. |
| Supported Fabric Python/runtime convergence | `cdf8893`, `74b1eae` and later Windows fixes; shared helpers and paired lifecycle scripts | Preserve managed Python separation from the general Python interpreter, pyodbc readiness and explicit command precedence. Current installed metadata confirms the two different Python families. |
| Review results and BPA | `4684f70`, `e57e688`, `11f15b3`; tools, standards, BPA runner | Preserve native report/result contracts, built-in BPA rules and Pi failure-result propagation. Prior installed BPA evidence is retained; no model was opened in B0. |
| Manifest changes | `config/release-manifest.json` | Only adapter `2.10.0 → 2.34.0` and new `pyodbc 5.3.0` differ from the released manifest. Other observed MCP drift is not explained by this manifest delta. |
| Preparation | Baseline through `a339dff` | Documentation only. No beta installation, runtime isolation or new package qualification was delivered. |

The installed merge tree equals the tested PR head `11f15b3d8eb52f18b0517bd76ebaf6e664d78899`. GitHub API reinspection confirmed all eight jobs in [run 35466786781](https://github.com/kabukisensei/coop-agent/actions/runs/35466786781) succeeded, including Windows logic, Windows PowerShell, Pi compatibility, and macOS Bash parsing. That historical CI result does not cover the newly reproduced safety gaps.

## Workstation and resolution inventory

Paths below are safe installation paths, not credential or client payload contents. Resolution describes the inspected host and launcher code; B0 did not attach to an already-running agent to assert its inherited environment.

| Surface | Actual resolution / version |
| --- | --- |
| Windows | Windows 11 Pro x64, 25H2, build `26200.9457`; CIM identifies Windows 11 (the legacy registry ProductName still says Windows 10) |
| Shells | Windows PowerShell `5.1.26100.9444`; PowerShell `7.6.6` |
| Git Bash | `C:\Program Files\Git\bin\bash.exe`, Bash `5.3.15`; Git `2.55.0.windows.2`. Bash is not in this Codex process's PATH and requires the explicit path here. |
| Stable command | `%LOCALAPPDATA%\coop\bin\coop.cmd` forwards to `C:\Users\quiddity\coop-agent\bin\coop.cmd` and its PowerShell launcher |
| Node | `C:\Program Files\nodejs\node.exe`, `24.18.0`; exceeds manifest minimum `22.19.0` |
| npm | Program Files npm `11.16.0` wins current PATH; a second roaming npm `11.14.1` exists |
| Pi | `%APPDATA%\npm\pi.cmd` / `pi.ps1`; package `%APPDATA%\npm\node_modules\@earendil-works\pi-coding-agent`, `0.84.3`; shim falls back to PATH Node when no adjacent Node exists |
| Stable profile | `C:\Users\quiddity\.coop`; isolated Pi agent is `.coop\agent`, packages `.coop\agent\npm\node_modules` |
| General Python | `%LOCALAPPDATA%\Python\bin\python3.exe` / `python.exe`; direct runtime `%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe`, `3.14.6` |
| pipx and companions | `%APPDATA%\Python\Python314\Scripts\pipx.exe`; companion command shims under `%USERPROFILE%\.local\bin`; environments under `%USERPROFILE%\pipx\venvs` |
| Fabric Python | `%USERPROFILE%\pipx\venvs\ms-fabric-cli\Scripts\python.exe`, `3.12.14`, verified with an isolated interpreter query; distinct from general Python |
| SQL ODBC prerequisite | ODBC Driver 18, `%WINDIR%\System32\msodbcsql18.dll`, `18.6.1.1`; metadata only, no connection opened |
| TE | `%LOCALAPPDATA%\Programs\te\te.exe`, file product version `0.5.2.11639`; executable not launched |
| Azure CLI | `C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd`; exact CLI version not freshly established; no login/token/version command was invoked |

The reviewed path overrides (`COOP_ROOT`, `COOP_DIR`, `COOP_AGENT_DIR`, `PI_CODING_AGENT_DIR`, `COOP_FABRIC_PYTHON`, `PIPX_HOME`, `PIPX_BIN_DIR`, npm prefix/cache) were unset in this process and in persistent user/machine scopes. This is not an environment dump or proof of the environment inside an existing terminal session.

### Packages: pins versus installed content

| Component | Manifest | Observed installed content |
| --- | --- | --- |
| Pi / shared pi-ai / pi-tui | `0.84.3` | All `0.84.3` |
| pi-mcp-adapter | `2.34.0` | `2.34.0` in agent npm tree |
| pi-hermes-memory | `0.7.17` | `0.7.17` |
| pi-better-openai | `0.1.22` | `0.1.22`; its persisted configuration reports inactive |
| pi-web-access | `0.10.7` | `0.10.7` |
| @juicesharp/rpiv-ask-user-question | `1.20.0` | `1.20.0` |
| context-mode | `1.0.169` | Agent and located npx copy both `1.0.169` |
| coop-data-doc / coop-sql-review / coop-dax-review | `1.2.0` / `0.15.2` / `0.22.0` | Exact match, companion venvs use Python `3.14.6` |
| ms-fabric-cli / fabric-cicd / pyodbc | `1.7.0` / `1.3.0` / `5.3.0` | Exact match in managed Python `3.12.14` environment |
| Power BI report author / modeling MCP / Desktop Bridge | `0.1.4` / `0.5.0-beta.12` / `0.1.2` | Global package metadata matches; Bridge retained in inventory but not exercised |
| @microsoft/fabric-mcp | `1.3.0` | Global `1.0.0`; adapter's recorded cache path contains `1.2.0`; configured npx package is unversioned |
| @azure-devops/mcp | `2.9.0` | Not in inspected global tree; adapter cache records `2.8.1`, but package at its executable path is `2.10.0`; configured npx package is unversioned |
| mcp-remote | `0.1.38` | Adapter cache records `0.1.38`, but package at that executable path is `0.14.2`; a different npx cache contains `0.1.38` |
| powerbi-mcp-server | `0.1.0` | Global and recorded E: cache package are `0.1.0`; cached request uses `@latest` |

The adapter cache is **not authoritative inventory**. Its `npx-resolver.ts` accepts a nonexpired existing cached binary and can populate npm cache when resolution fails. For unversioned package requests, it does not establish an exact manifest version. Package metadata at the referenced executable paths disproves two recorded cache versions. No resolver or MCP server was launched to refresh this state; actual already-running process versions remain unverified.

**E: has live dependencies too.** Stable adapter cache entries reference modeling MCP and powerbi-mcp-server under `E:\Codex\coop-pr66-20260919\npm-cache`. Both paths exist and their package versions match their recorded values. Do not clean, move or reuse that directory as disposable B0/B1 storage. The modeling MCP is configured; the powerbi-mcp-server entry may be historical and was not proven active. New B0 work uses `E:\Codex\coop-b0-20260919`.

### Resources and effective loading

The launcher adds the governance prompt, four Coop extensions (`coop-powerline`, `coop-tools`, `coop-guardrails`, `coop-profile`), the `cooptimize` theme, branded splash/vibes, and these **17 first-party skills**:

`azure-devops`, `coop-workflow`, `custom-visuals`, `daily-logger`, `data-doc-analysis`, `dax-patterns`, `dax-review`, `fabric-workspace-review`, `git-helper`, `power-bi-impact-analysis`, `power-bi-report-authoring`, `power-bi-report-review`, `report-themes`, `setup-docs`, `sql-review`, `tabular-editor-bpa`, `team-knowledge`.

The **14 prompt templates** are `annotate`, `daily-log`, `discovery`, `explain`, `fabric-architecture-review`, `handoff`, `impact-analysis`, `pr-description`, `semantic-model-review`, `setup-docs`, `share-learning`, `slice-next`, `spec-first`, and `weekly-log`. Installed settings reference the six exact extension package specs in the table above, with theme `cooptimize` and quiet startup enabled.

Read-only `lib/microsoft_skills.py ... launch-dirs` against the actual project contract returned **kql, microsoft-docs, sqldw-authoring-cli, sqldw-consumption-cli**. Catalog generation is `fcd571186286d849be57a7bf5124701ba78afc3cf8632aad74d64815dab73e42`; Microsoft skills revision is `903dc62b1e4c833235b54db918a9a51cb6d3cc8f`; Fabric skills revision is `28f29abf3838e13f63a38e8664042b7d9f7cd69c` (`v0.3.10`). Nothing was refreshed. Codex's separately installed skills are not evidence of Coop's loaded skill versions.

Six MCP server entries are configured and not disabled: Azure DevOps, Context Mode, Fabric, Fabric SQL endpoint, Microsoft Learn, and Power BI modeling. Endpoint values, server arguments containing client identifiers, and credential contents were excluded from the report. Standards, knowledge, sessions, memory, auth, models, trust and audit stores exist in the stable profile. Their private contents were not collected. A complete project-local/personal/team resource precedence audit and loaded-state introspection remain SK1 work; this B0 inventory does not claim every optional resource is active.

## Capability acceptance map

| Retained workflow | Evidence and limit |
| --- | --- |
| Ordinary terminal, branding, model login | Existing readiness handoff reports real launcher greeting, 43 commands, zero greeting tool calls, clean stderr/exit. B0 confirms paths/code/settings; no fresh model call or login. |
| New/resume/fork and profiles | Retain Pi ownership and stable stores. Guardrail tests cover session governance/grant reset. Full interactive session and profile-switch workflows were not freshly exercised. |
| On-demand `/start`, project setup, data-doc setup | Present in existing code/resources. No setup wizard was run on the client project. Preserve cancellation and user-field ownership tests. |
| SQL/DAX/BPA reviews | Prior readiness evidence includes native reviewers and BPA built-in findings. B0 confirms installed distributions and offline SQL fallback tests. No client source or model was processed. |
| Documentation, lineage, standards/provenance | Retain current tools and graceful absence behavior. Prior readiness record reports canonical SQL/DAX/model standards and missing Fabric/documentation domains. Fresh source freshness/content certification was not performed. |
| Knowledge and memory | Existing optional skill/package/store retained. Prior readiness record reports optional team knowledge unavailable. No TeamAI activation, knowledge sync or publication occurred. |
| MCP/auth/live SQL | Prior record reports discovery of 56 tools and bounded constant-query success. B0 confirms configuration and detects resolution drift; no live capability recertification follows from prior connectivity. |
| Logs, support, Doctor | Retain existing commands. Prior Doctor exited 0 with nonfatal BPA-message, SQL-probe, optional knowledge/standards and jq warnings. B0 did not launch Doctor because the live profile must remain undisturbed. |
| Research and vendor Bridge | Preserve pi-web-access and the Microsoft Bridge inventory; neither is permission to start a Coop Desktop project. Bridge source-loss acceptance remains outstanding. |

The prior record is `E:\Codex\coop-pr66-20260919\outputs\readiness-handoff.md`, dated September 19. Its earlier `handoff.md` is superseded. Prior live results are historical receipts, not tests rerun by B0.

## Safety findings and test gaps

Owners below are proposed roles, not assignments made on GitHub.

| ID / priority | Revalidated finding | Gate and proposed owner |
| --- | --- | --- |
| G01 / P0 | `extensions/coop-guardrails/index.ts:1378` catches enforcement errors and returns without blocking. Through the actual registered handler, a throwing `ctx.ui.confirm` returned `undefined` for destructive Bash, secret-file read, managed MCP mutation, and governed SQL. Decline, headless and missing-confirm controls blocked all four. | Separate minimal guardrail repair; Windows/guardrails maintainer. Governed uncertainty must block, with sanitized failure reasons and executor-not-called assertions. Block beta governed/live acceptance and promotion until repaired. |
| G02 / P0 | Command-bearing audit callers at lines 1342, 1357, 1366 and 1373 retain truncated command strings. Synthetic canaries survived in audit records for destructive Bash and hard-blocked amend. Truncation is not redaction. The newer MCP audit path uses fixed labels, but that does not repair Bash paths. | Separate audit minimization repair; guardrails maintainer. Cover allowed/declined/headless/hard-block/unverifiable paths and audit tail/export. Preserve useful fixed classification without raw commands/arguments. No real credential was used. |
| I01 / P0 | Current launcher/lifecycle uses stable agent defaults, global npm discovery and shared pipx. `COOP_DIR` means parent-of-profile in onboarding/knowledge but profile-itself in context-budget/support. | B1 installation-context owner. No existing installer/updater may be used as beta setup. Test actual resolved paths, including reparse points and missing-tool fail-closed behavior. |
| I02 / P1, provisioning gate | Declared MCP pins, adapter cache labels and executable package metadata disagree. Unversioned requests and existing E: cache dependencies prevent a fully reproducible baseline. | B1 owner plus product reviewer. Select and approve exact MCP versions before provisioning; do not silently upgrade, downgrade, clear stable cache or copy stale labels. |
| S01 / source protection gate | Historical upstream Bridge reload/save source-loss report was not reproduced, and installed Bridge/Desktop combination was not exercised. | Future vendor-workflow reviewer, using disposable copies only. Outside B0/B1 implementation. Never attach beta to the stable live Power BI process. |
| T01 / test gap | Existing guardrail tests cover missing/declined approval and some sanitized MCP audit cases, but pass despite G01/G02. | Add registered-handler exception and command-canary regressions in the separately approved repairs. Ordinary chat/optional integration failure must remain usable. |
| T02 / test gap | Prior full local Bash run stopped in `tests/standards-rev9.test.mjs:211`; a separate standards review-generation run encountered symlink permissions. B0 did not rerun or repair these. | Test maintainer: safely reproduce under owned E: state before claiming a local full-suite pass. Hosted CI success is a separate result. |
| T03 / coverage gap | No beta lifecycle, actual session isolation, locked-file/reparse behavior, credential-store separation or owned-child shutdown acceptance exists yet. | B1 Windows reviewer. Native evidence is mandatory; mock lifecycle success alone is insufficient. |

Installed Pi `dist/core/extensions/runner.js:701` treats a returned `block` result as the stop signal; an undefined handler result supplies no Coop block. The B0 reproduction invoked only the registered hook. It did not execute a destructive command, read a secret file, invoke MCP/SQL, or prove an end-to-end harmful action. These are confirmed enforcement and audit defects, not evidence that client damage has occurred. Coop is not an OS sandbox against trusted same-user code.

### Tests and evidence produced in B0

| Check | Result |
| --- | --- |
| Existing `tests/guardrails.test.mjs` on the unchanged baseline runtime | **86 passed** on native Windows Node; temporary audit/contracts under E: |
| Existing `tests/fabric-sql-query.test.py` | **Passed**, offline governed fallback, Python `3.14.6`, bytecode disabled and temporary state under E: |
| Additional B0 registered-handler probe | **12/12 decline/headless/missing-confirm controls blocked; 4/4 throwing-confirm cases did not block** |
| Additional B0 audit probes | **2/2 synthetic command canaries persisted**, confirming G02 |
| Represented action execution in additional probe | **Zero**, including zero Git metadata probe calls |
| Source comparison | Runtime/test/manifest trees at E: review head equal the installed source baseline; installed merge equals tested PR head |
| Manifest/package/resource inspection | Read-only metadata and catalog resolution; no package manager installation or cache refresh |
| Full suite, real login, live services, Desktop, installer/updater | **Not run in B0**; no claim of fresh acceptance |

The existing guardrail extension was bundled with an already-present esbuild executable from E:. No npx fetch or package installation was used. Diagnostic scripts and sanitized outputs are in `E:\Codex\coop-b0-20260919\work` and `evidence`: `installed-inventory.json`, `npx-inventory.json`, `adapter-resolution.json`, `resolved-package-metadata.json`, `path-overrides.json`, `effective-catalog-skills.txt`, `safety-probe.json`, `guardrails-existing.txt`, `sql-fallback-offline.txt`, and the two `prior-ci*.json` files. These local paths are evidence locations, not new product commands.

## Change receipt and handoff

Starting and ending source HEAD for this review is `a339dff88a66a53b884e26bd903faad272f2cb21`; only uncommitted documentation changes are delivered. Runtime behavior, dependency pins, skill contents, source files and tests were not edited; no tests were removed and no code-reduction claim is made. No C: application command with launch/repair/update behavior was invoked. The client project was referenced only for the read-only catalog-policy resolution; no client source, credentials, sessions or application configuration was copied or edited.

Final read-only verification found the live checkout still clean at `9e8248a`, and the selected installed package/resource inventory unchanged from the first inventory (`preservation-check.json`). This is not a whole-disk before/after identity claim: an active user session can change its own state. These observations establish the stated scope, not quiescence of the live system. Credential-file contents were never read for this review. Network activity was limited to repository clone/fetch/pull checks and public GitHub CI metadata. No live Fabric/database/model/TeamAI/Jev call, install, upgrade, commit, push, issue change, tag, release or Desktop work occurred.

Rollback for B0 is limited to its owned E: documentation and diagnostic artifacts. Backups of existing edited documentation are under `E:\coop\.backups`; do not remove the earlier E: cache directory used by stable. Do not restore or alter anything in the C: installation as part of B0 cleanup.

Review the [B1 proposal](COOP_WINDOWS_TERMINAL_B1_PROPOSAL.md), decide the separate G01/G02 repair scope and MCP pin disposition, then explicitly authorize the next bounded task. B0 stops here.

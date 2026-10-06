# Coop master plan — ordered execution roadmap

**Document revision 3.27 · October 6, 2026** (Revision 3.27 records MC4 as accepted: the phone check on the client VM with Aaron's iPhone passed on 2026-10-06, its four defects fixed in #324 and the Home Screen icon matched to the coop tile in #325, all shipped in v0.32.0; and Aaron's answer of 2026-10-06 at 13:15 keeping MC8's thinking and tool detail on tap; section 12.4 and register rows 28 and 30. Revision 3.26 records Aaron's answers of 2026-10-06 at 03:34: the phone has four themes, Modern and Retro, each dark or light, with Modern the default and Retro drawn in the coop website's look, so MC5's separate Site themes fold into Retro; every phone option sits in a side menu like the website's, sized for phone screens; MC11 notices go ahead with no session text; the `!` shell stays desk-only. Revision 3.25 adds MC6–MC11, phone parity with the terminal: Aaron asked on 2026-10-06 at 03:25 for the phone to match the terminal; `desktop/PARITY.md` gains a Phone companion section that lists every terminal capability with its phone status, and each gap becomes a row in build order; production approvals, options that allow more than one action and the `!` shell stay desk-only as the MC1 contract decided, and terminal screens the window also hands to the terminal are listed as not on a phone; MC11 notifications wait on Aaron's word because web push goes through Apple's or Google's push service; register row 30. Revision 3.24 adds MC5, the coop website's look on the phone: Aaron asked on 2026-10-06 at 03:24 for the phone page to match the coop site; the phone gains Site dark and Site light, the retro palettes, which are already the site's colours, drawn with the site's bevels, title bars and Silkscreen pixel face, shipped with the page; register row 29. Revision 3.23 is MC1 as specified: Aaron started the row on 2026-10-06 at 02:01; the companion contract is `desktop/COMPANION.md` with its checkable rules in `desktop/lib/companion-protocol.mjs` and fixtures, section 12.4 records the defaults, and Aaron picked Tailscale for the private connection; nothing listens yet. Revision 3.22 adds the secure mobile companion roadmap, MC1–MC4 in section 12.4 and register row 28, documentation only: a phone web view of the same live desktop session on the VM. Aaron reviewed it the same evening and decided at 23:09 ("A1 B2 C2"): the phone web view is the one mobile route, so M1 Teams mobile (#275) is closed as superseded; this revision merges after the C1 project-file set; MC1 starts after the demo-feedback rows, on his explicit word, so implementation remains unstarted. Revision 3.21 records the demo feedback of October 5, 2026, section 12.3: Aaron showed the window to the team, and the feedback became four rows the plan can carry now, G1 production writes become a hard block (Aaron said in the meeting he would get it in today), C1 the committed project contract, C2 the explicit semantic-model-to-SQL mapping and Fabric layout in the contract, L1 the Microsoft tool license review, one addition to D1j (the command palette grouped by kind), the demo as a stated reason for U2 once the adapter ships, and thirteen numbered questions (the project file `demo/demo-feedback-2026-10-05.md` holds the full list); Aaron answered them the same evening, so the section also records his decisions (G1 with a hidden, human-only production-write unlock outside the repo; C1, C2 and the mapping field as proposed; the Cooptimize transfer deferred; the docs site stays on the VPS) and the rows proposed from his open answers, P1 the machine-level shared profile for the one-Windows-user-per-client VMs, DR1 one private data-docs repository per client, PR1 personal, client and shipped prompts and skills, SQ8 change-aware impact while coop edits SQL and SQ9 the committed dev catalog snapshot, all five accepted by Aaron at 20:08 the same evening (one VM is one person's, so P1's machine profile holds the name; SQ8 reshaped around intent: coop holds the lineage context and surfaces it, details only when asked, never re-running what it already has); at 20:12 he added D1m, the window icon as the default way in, opening on the right project folder so the committed contract is found; register rows 18–27; at 20:18 he set the client-isolation rule, one Windows user per client, which P1 and G1 record. Revision 3.20 added `@juicesharp/rpiv-todo` 2.12.0 to the pinned extensions, section 6 table: Aaron picked it on 2026-10-03 from the pi.dev package review as the one package worth a trial; the window rebuilds the panel from the `todo` tool results because Pi's RPC mode drops the extension's TUI widget, Alt+T collapses it in the terminal and the window, and the VM check is pending. Revision 3.19 was D1d (D1d as built: the coop window package bundles the pinned Node (the nodejs.org win-x64 zip, version and SHA-256 in the manifest's `desktop.node`), an npm prefix with the pinned Pi and the Power BI tools, the extension tree installed from `config/extensions-lock.json`, and a snapshot of this repository, as `resources\runtime` and `resources\coop` beside the asar; `lib/common.ps1` run from the snapshot finds the runtime by location, puts the bundled Node and Pi first on PATH and points npm's global prefix at the bundle, so the one implementation needs no second code path; the package's first `coop desktop` on a profile without this release's lock runs `coop install` in its console (the H1 table with its `winget` lines, the pipx tools, the Azure and model sign-ins), `coop sync` seeds the agent dir's tree from the bundle instead of `npm ci` and declares the extensions in `settings.json` as `pi install` would; doctor, update and uninstall know the package; the CI job checks the bundled Node, Pi, tools and tree at their pins and runs the snapshot's `coop version` on the bundled Pi; Git, Python, pipx, Azure CLI and ODBC stay prerequisites (11.3 item 6: no bundled Git); section 11.7; register row 16. Revision 3.18 was the desktop UX review, Aaron 2026-10-03: the six first-run fixes landed in the window (section 11.6 statuses: set-up card for sign-in, profile and Azure notices; the Start menu on the first launch; approval cards with the command as code and No as the default; question cards for `ask_user_question`; example prompts; background notifications; a menu bar), the follow-up rows D1h health pane, D1i integrated terminal pane and D1j approvals chip and skills browser added in section 11.7, D1e's update notice named as its first deliverable, and D1d no longer waits for U2: the package bundles the Pi the manifest pins today (0.87.1) and D1e re-stages it at every version, so U2 is not a gate (section 11.7). Revision 3.17 was D1c as built: the coop window package is electron-builder's NSIS per-user installer of the same `desktop/` code, staged with the `lib/*.mjs` modules it imports, the vibes, the splash and the icon into an asar (pdf.js and its reader unpacked beside it, the September fuse policy applied); it still needs the terminal coop, finds `coop.cmd` the way `bin/coop-desktop.ps1` does and asks it for the window with the new `coop desktop --app <exe>`, which hands the spec over through Electron's single-instance lock; `coop.exe --doctor` prints one JSON line; the `installer (Windows)` CI job builds, installs silently, runs `--doctor` and uninstalls on every PR; 11.3 item 2 decided as NSIS per-user; register row 16. Revision 3.16 added Pi Durable to the section 12.1 watch list: the experimental durable agent-harness library published beside Pi 1.0, watched, not scheduled; Aaron asked on 2026-10-02. Revision 3.15 was D1b2 as built: one side pane beside the timeline with four views, Changes, Standards, Project and Docs, opened from tool cards, the standards chip, setup notices, the command palette and Ctrl+\; the `/setup-project` writer and the `/setup-docs` driver moved out of `extensions/coop-tools/index.ts` into `lib/project-contract.mjs` and `lib/data-doc-setup.mjs` so the window calls the same code; the docs form shows coop-data-doc's prompts one at a time, as its wizard asks them, and the built docs open as Markdown in the pane, with a list of every object page because coop-data-doc's overview does not link them, and the HTML portal in the browser. Aaron's second D1b2 batch, same day: file attachments in the composer (images with the prompt as in the terminal; text by path; Word, Excel, PowerPoint read to Markdown by coop's own readers and PDF by pdf.js in a time-limited process, every document referenced by path so coop reads it through its guarded read tool), pdf.js pinned next to Electron as the runtime's second package, every pane draggable, the Cooptimize splash logo and the vibes in the window, the thinking and tool calls between replies folded into one expandable line with nothing removed from the session, and a readability pass over all four themes; register row 16. Revision 3.14 was D1b as built: the window runs coop's launch arguments with `--mode rpc` and no `-a`, because the recorded session shows coop's guardrails, standards and skills load without it and `-a` would only trust a work repo's own `.pi` files, which the terminal asks about first; Electron installs into its own runtime tree on the first `coop desktop`, not into the extension tree on every machine; the first `coop desktop` adds the "coop (window)" shortcut; register row 16. Revision 3.13 was D1a, the desktop decision record and salvage list: Aaron chose a rendered, modern UI with four themes over a terminal in a window, D1b is re-scoped to it with a terminal parity rule, a changes panel, a standards pane, a project form and a docs setup form go into D1b2 with a list of proposed enhancements (section 11.6), every other section 11.3 item has a recorded default, and the September desktop branches are reviewed file by file; sections 11.1–11.6 and register row 16. Revision 3.12 added an explore and research watch list, section 12.1, starting with PiG, the Go port of Pi: watched, not scheduled. Revision 3.11 scoped Phase 8 D1 into rows D1a–D1g, sections 11.1–11.4; revision 3.10 added the Pi 1.0 row U2, section 6.5; revision 3.9 added the mixed-estate documentation repair, section 8.1. Existing phase ordering and the revision 3.8 scope decisions remain.)
**Product scope: Coop Windows terminal first; an installable Electron desktop returns after the terminal is simplified.**

**Canonical repository location:** `docs/COOP_MASTER_PLAN.md`. This revision keeps the
intention of the [Windows terminal plan, revision 2.0](history/COOP_WINDOWS_TERMINAL_PLAN.md)
(Windows-first, stable and beta kept separate, bounded simplification, qualified
upgrades, TeamAI and Jev as optional experiments) and **replaces its execution
order**. Revision 2.0 stays in the tree as the detailed reference for each package
(S1–S7, U1, SK1, K1–K3, J0–J3, PK1; N1 is new in revision 3.8, section 10); where the two documents disagree on order,
scope, or the Desktop direction, this document wins.

**Authority and status:** a plan, not a receipt. Nothing here is implemented by
adopting the document. Aaron starts each phase explicitly; a merged plan is not an
execution trigger, and `agent:ready` is still added by hand. Releases follow
`RELEASE.md` and happen only when Aaron names a version.

## 1. What changed since revision 2.0

| Topic | Revision 2.0 | Revision 3.0 |
| --- | --- | --- |
| First work | B0 baseline, then B1 isolated beta channel, then everything else | **Rollout hotfixes on stable first** (installer prerequisites, Azure sign-in, project contract), then test right-sizing and simplification. B1 moves after simplification. |
| Tests | Retain and consolidate; "test reduction follows implementation reduction" | Same rule, plus an explicit cut: CI keeps a fast gate that must pass on every PR; slow process/timing fixtures move out of the PR gate or go with the surface they test. No test runs just to run. |
| Dependencies | Qualify one family at a time after B1 | Same discipline, done **right after simplification** against the drift measured on September 28 (section 6), with an explicit keep/drop list for dependencies that Windows-first no longer needs. |
| Standards | Canonical `cooptimize/coop-standards` sealed to one manifest shape | Coop **reads the format the standards repo ships** (and `cooptimize/incremental-bi`), instead of locking a copy of it. Default project contract is regenerated from that format. |
| SQL and DAX reviewers | Keep `coop-sql-review` / `coop-dax-review` as deterministic gates | Decide keep-or-retire after standards alignment (section 7). Default recommendation: retire the in-agent wrappers; keep the CLIs only where a client CI pipeline actually uses them. |
| SQL platforms | Fabric Warehouse / Lakehouse SQL endpoint only | Fabric stays. Add **Azure SQL Database and Azure SQL serverless** as first-class targets with the same guardrails. |
| Editing SQL objects | Local files plus `coop-data-doc` lineage | Power BI is source-controlled; SQL coverage varies by client. Coop **defaults to dev**, combines scoped offline lineage with **live metadata** through SQ, and verifies edits with **actual data** before and after. Missing SQL sources never imply zero impact (section 8.1). |
| First run | Onboarding wizard, then `/start` menu on demand | **Common workflows menu on first run**; the wizard becomes one entry in it. |
| Desktop | Removed; native Windows Coop 2.0 last, no Electron | **Electron desktop returns, last**, gated on a packaged installer that other users can run. The native rewrite is dropped from the roadmap. |
| TeamAI / Jev / PK1 | Early beta experiments after B1 | **Revision 3.8:** TeamAI shared knowledge (K1–K3) is a scheduled phase after the first-run work, isolated on the development VM instead of a beta channel; Jev waits for an explicit start; automatic session naming leaves PK1 and becomes its own small row (N1) right after U1; the rest of PK1 stays optional. PK1 evaluates `@xl0/pi-lovely-codex` for tool-call handling and a usage-stats owner for the footer (revision 3.5: the Codex extension shows no usage stats; section 10). |
| Update channel | `coop update` fast-forwards `main` | `coop update` moves to the **latest release tag**; `--edge` keeps head-of-main for maintainers. |
| Qualification machine | Isolated beta channel (B1) before any upgrade | The team is **seven people**. A **fresh Windows development VM** plus a second clone with `COOP_AGENT_DIR` qualifies upgrades, and a tagged release reaches all seven the same day. **Revision 3.8:** B1 is skipped; the fleet is too small to need it (Aaron, 2026-09-30). |
| Agent working model | Implicit | Section 14 sets how agents pick up work so several sessions stay coherent. |

### 1.1 Decisions on September 30, 2026 (revision 3.8)

Aaron decided these in the project thread on the evening of September 30; they
change scope, not the order of the client-facing phases (0 through 6):

- **TeamAI shared knowledge is in.** K1–K3 leave "optional experiments" and become
  Phase 7, scheduled after the first-run work (FR1) and before the desktop. The
  package detail stays in revision 2.0 section 8; isolation uses the development VM
  and a sandbox team repository, not a beta channel.
- **The beta channel (B1) is skipped.** Seven people update from release tags the
  same day; the VM qualifies upgrades. The B1 proposal in [PR 72](https://github.com/kabukisensei/coop-agent/pull/72)
  stays as documentation only.
- **Jev waits.** J0–J3 keep their revision 2.0 gates and start only when Aaron asks.
- **Automatic session naming is scheduled (N1).** Aaron asked whether the
  extension that names a session after about three turns is in the plan. It was
  only inside the optional PK1 trial; it now has its own row right after U1
  (section 10), because it does not depend on the Codex or usage-stats question.
- **Install asks Fabric or Azure SQL.** When the Azure SQL breadth work lands,
  `coop install` asks once whether the client is a Fabric or an Azure SQL client (or
  both) and the answer seeds the contract, doctor and skill defaults (section 8,
  item 7). Aaron asked for this on 2026-09-30; it rides the SQ rows, not a new phase.
- **No client pipeline runs `coop-sql-review` or `coop-dax-review`.** They predate
  the coop-standards repository the team now maintains. This closes section 15's
  open question: ST1 retires the in-agent wrappers and the bundled-fallback path,
  and archives the two CLIs rather than keeping them as optional CI gates.

## 2. Ordering principle and the "not over-engineered" rule

Order is by who is hurt when it is missing:

1. Users on the rollout are hurt today → hotfixes on stable, no refactor attached.
2. Every later change is slower while CI is heavy → right-size tests.
3. Every later change is bigger while two platforms and legacy web exist → simplify.
4. Then change what is inside: dependencies, standards, SQL breadth, first run.
5. Then shared knowledge (TeamAI), the optional PK1 trial, and the desktop. The
   beta channel is skipped and Jev waits (section 1.1).

Rules for every package, in addition to the hard gates in revision 2.0 (no source
loss, no credential leakage, no approval bypass, no accidental Fabric or database
mutation, no update overwriting user configuration):

- One PR, one purpose. No "cleanup plus upgrade plus feature".
- No new framework, registry, schema, environment variable, test mode, or
  abstraction unless it deletes more than it adds or closes a bug a user hit.
- A test is written for a boundary or a bug, not for coverage. A test that needs a
  sleep, a PTY, a marker file, or a load-dependent wait is an integration test and
  does not belong in the PR gate.
- The `.ps1` BOM and Windows PowerShell 5.1 rules in `AGENTS.md` apply; the paired
  scripts and bash 3.2 rules were retired with the bash product path (S1-S7).
- No new behavior on a surface this plan retires (`coop web`, the macOS/Linux
  product path, `mcp-remote`). A hotfix touches such a surface only to keep it
  from breaking; it does not improve it.
- Timing fixtures (sleeps, hang timers, marker polls) belong in the extended lane
  from now on, even before T1 lands. A PR that must add one says why in its body.

## 3. Phase 0 — Rollout hotfixes on stable

These are the bugs users hit in the week of September 21. Two were already fixed and
released (pipx not visible to a fresh Windows user in v0.23.4; antivirus quarantining
`lib/common` giving cascading "not recognized" errors in v0.23.5). The rest are
open. Each is a small PR against `main`, released as a patch when Aaron asks.

### H1 — Installer: check every prerequisite first, in order, and print the exact command

**Observed:** `coop install` tries a silent `winget install` for missing Git, Python
3.12, Node LTS, and Azure CLI, discards winget's output and exit code, warns, and
**continues** (`$ErrorActionPreference = 'Continue'`). On a machine without Node the
install then fails several steps later ("cannot install pi (npm missing)", every
extension "skipped", authoring tools "skipping", doctor "pi missing"). Without
Python it fails at pipx and the Fabric CLI. Four concrete defects make it worse:

- `Coop-Warn` in `lib/common.ps1` takes one parameter, so every call that passes a
  second "how to fix" argument (the Node-too-old hint, all ODBC hints) silently
  drops the hint. The bash twin prints it. Users on Windows see the problem and
  not the command.
- The Node minimum is hard-coded to 22.19.0 in both installers instead of read from
  `config/release-manifest.json`; only doctor reads the manifest.
- After a winget install the script adds a few known directories to `PATH` but not
  the Python install-manager location, so a just-installed Python is not found in
  the same window; pipx then reports "python missing".
- `README.md` says Azure CLI is auto-installed in one section and "not
  auto-installed" in another.

No test covers "Node missing" or "Python missing". The background-job units in
`install.ps1` (`$UnitPi`, `$UnitPytool`) reference variables and a helper that are
not passed into the job runspace; verify on a workstation whether those units work
at all when reached (read-only finding, not reproduced).

**Fix:** a single prerequisite stage at the top of `install.ps1` (and the bash twin
while it exists) that checks everything before installing anything, in dependency
order, and stops with a numbered checklist when a required item is missing:

| Order | Prerequisite | Why this order | Command printed when missing (Windows) |
| --- | --- | --- | --- |
| 1 | Git | clone/update of coop-agent and knowledge repos | `winget install --id Git.Git -e` |
| 2 | Node.js ≥ 22.19 (LTS) | Pi and every npm tool need it | `winget install --id OpenJS.NodeJS.LTS -e` |
| 3 | Python 3.10–3.13 (3.12 recommended) | Fabric CLI cannot run on 3.14; pipx needs a Python | `winget install --id Python.Python.3.12 -e` |
| 4 | pipx | installs coop tools and Fabric CLI; needs Python | `py -3.12 -m pip install --user pipx` then `py -3.12 -m pipx ensurepath` |
| 5 | Azure CLI | Fabric, Power BI, SQL tokens | `winget install --id Microsoft.AzureCLI -e` |
| 6 | ODBC Driver 18 for SQL Server | `pyodbc` live SQL fallback and Azure SQL | `winget install --id Microsoft.msodbcsql.18 -e` (id to confirm on a workstation) |
| 7 | Tabular Editor CLI (optional) | BPA reviews only | link plus `te auth login` |

Behavior: print the table with a ✓/✗ per row, then either "all prerequisites
present, continuing" or "install the ✗ rows above in that order, open a **new**
terminal, run `coop install` again". With `--prereqs auto` (default off until proven)
run the winget commands **visibly**, re-check, and still require the new terminal.
`coop doctor` reuses the same check list and messages, so install and doctor never
disagree. Keep `--no-prereqs`. No new framework: one function, one table.

**Acceptance:** fresh Windows VM without Node and without Python stops at the
checklist with the two commands; after running them and reopening the terminal,
`coop install` completes and `coop doctor` exits 0. Regression: a machine with every
prerequisite behaves as today.

### H2 — Azure sign-in happens automatically

**Observed:** three places can sign in, and none of them works by default on the
rollout machines.

- The launch preflight (`Invoke-CoopAzPreflight` in `lib/common.ps1`) returns
  before doing anything when
  there is no `.coop/project.yml` under the working directory **or** when
  `fabric.tenant_id` is empty or starts with `TODO`. The bundled fallback contract
  ships `TODO`, so from the desktop shortcut (home folder) or any repo without a
  contract, sign-in is never attempted. It ignores the tenant that onboarding
  already saved to `~/.coop/config` (`azure.tenant_id`).
- When the preflight does run, it checks only a Power BI token. The Fabric MCP and
  the SQL fallback mint a Fabric token (`https://api.fabric.microsoft.com`, no
  `--tenant`), so a user can pass the preflight and still see `auth_required`
  inside the session.
- The preflight asks "Run az login now?" with default **No**, and refuses outright
  on a non-interactive stdin. From a shortcut there is nobody to answer.
- Onboarding's sign-in (`lib/azure_auth.py`) runs `subprocess.run(["az", ...])`
  with no shell. On Windows the Azure CLI is `az.cmd`; `shutil.which` finds it,
  but the process call cannot start a `.cmd` without `cmd.exe`, so tenant discovery
  returns nothing and the user is told "Azure sign-in did not complete" before a
  browser ever opens. Only `fabric_request_headers.mjs` handles `az.cmd`
  correctly; the tests avoid the bug by pointing `COOP_AZ_BIN` at a `.bat`.
- `coop doctor` treats `az` as optional presence only; it never reports sign-in
  state except through the Warehouse probe.

**Fix:**
- Tenant comes from one place with a fallback chain: `.coop/project.yml`
  `fabric.tenant_id` → `~/.coop/config` `azure.tenant_id` (set once by onboarding;
  client resources only) → nothing. A `TODO` value counts as unset. *Corrected in
  H2: onboarding saves the tenant in `~/.coop/config`, not `~/.coop/user.json`.
  Aaron decided on 2026-09-28 that there is no Cooptimize default tenant: this repo
  is public and `azure.tenant_id` is reserved for client resources. With no tenant
  the launch is silent and `coop doctor` says to run `coop onboard --config-only`.*
- Preflight checks the Fabric resource token first (`https://api.fabric.microsoft.com`),
  then Power BI; either missing triggers sign-in.
- One `az` invocation helper shared by Python, PowerShell, and Node that resolves
  `az.cmd` on Windows (the `fabric_request_headers.mjs` logic, reused, not copied).
  *As built in H2: the Node helper is a hardened, token-only supervisor that cannot
  run an interactive sign-in, so each language keeps one bounded way to call `az`
  and shared tests keep them in step. The Python helper now resolves `az.cmd` the
  way the Node one does; PowerShell's `& az` already resolved it.*
- Sign-in runs `az login --tenant <id> --allow-no-subscriptions` directly (browser
  flow) and falls back to `--use-device-code` when no browser can open. No confirm
  prompt; the user asked for coop, not for a question about Azure. Token minting
  for Fabric passes the same `--tenant`. *As built in H2: `az login` falls back to
  a device code by itself, so coop adds no retry; the automatic sign-in runs only
  in an interactive console (piped and scheduled launches print the one line).
  Token minting with `--tenant` is split out as H2b (decided 2026-09-28), a
  separate PR that ships in the same tagged patch as H2.*
- On failure, launch continues with one line that names the exact command, and
  `coop doctor` gains one row: signed in to tenant X / not signed in, run this.
- Cache stays as today (`.az-ok`, 30 minutes, tenant-stamped).

**Acceptance:** fresh machine, signed-out `az`: first `coop` opens the browser sign-in
once, then the Fabric MCP tools list without `auth_required`. Signed-in machine: no
prompt, no delay beyond the cached check.

### H3 — Coop reads the coop-standards wiki directly (merged in PR 85)

**Observed (revision 3.0):** the shipped `.coop/project.yml`, the example, `coop init`,
and `/setup-project` had no `standards:` section, and `lib/standards.mjs` locked
`cooptimize/coop-standards` to one manifest shape, exactly three domains, exact file
paths, branch `main`, and an anchor commit, with the registry duplicated in code.

**What the repo actually is (found 2026-09-28 with local clones):**
`coop-standards` is an Obsidian wiki the team reads directly. Every article carries
YAML front matter (`id, title, domain, layer, artifact, technology, status`). The
`standards.yml`, `standards/*.md`, and `scripts/assemble.py` files that coop was
locked to are a compatibility shim that existed only because coop could not read
the wiki. Aaron's direction: do not change the repo's structure; change how coop
reads it, and stop depending on the assembly script.

**Done in [PR 85](https://github.com/kabukisensei/coop-agent/pull/85):**
- Coop discovers every active article by front matter (any folder, any future
  domain); it never reads the shim. Drafts, deprecations, notes without front
  matter, dot-folders, and symlinks are skipped; an empty wiki fails closed and
  keeps the last known good.
- Domains map by front matter: `domain: sql` → `sql`; `domain: powerbi` → `dax` when
  the artifact is a DAX expression or measure, else `semantic_model`; any other safe
  domain keeps its name.
- Tasks receive whole articles (general ones plus up to six ranked by layer,
  artifact, technology, and title), each with path, hash, and repo revision.
- The registry JSON is the only copy; the frozen domain list, anchor commit, and
  archive hash are gone. Project overrides accept the nested
  `standards.<domain>.path` shape. `incremental-bi` uses the same reader.
- The SQL/DAX reviewers, until ST1 retires them, are fed a content-addressed
  reviewer-input file built from the same articles, so they never contradict what
  coop just wrote.

**Verified against the real repo** at `a00c8cc`: `coop sync` refreshes, prompts
receive the expected articles, `/setup-project` round-trips. No VM needed.

**Follow-ups filed, not `agent:ready`:** #83 retire the legacy `manifest.json`
fixture seam and its schema file; #87 the standards runtime test writes the
developer's real `~/.coop/standards`; #88 the prompt classifier misses wiki SQL
topics such as "silver indexing on the fabric warehouse".

### H4 — Regression evidence for the fixes that already shipped

Keep the v0.23.4/v0.23.5 fixes in the plan so that the simplification phase does not
undo them: pipx launcher directory resolution via `sysconfig` on Windows, the clear
message when `lib/common` is missing, and the setup-bridge early-close wording.
No new work.

### H5 — `coop update` follows release tags, not the head of `main`

**Observed:** `coop update` fast-forwards the clone to the tip of `main`, so every
team machine receives every merged commit, including the ones that only exist to
fix the previous one. Releases are tagged (`v0.23.5`) but nothing consumes the tag.

**Fix:** `coop update` fetches tags and checks out the newest `v*` tag by default;
`coop update --edge` keeps today's head-of-`main` behavior for maintainers. Doctor's
staleness nudge compares against the newest tag, not the branch. The version
report carries `git describe` since #108, so support can tell which commit a machine runs.

**Acceptance:** a machine on `v0.23.5` with newer unreleased commits on `main` stays
on `v0.23.5` after `coop update`; after Aaron tags `v0.23.6` it moves there; `--edge`
moves to head. A dirty checkout still refuses, as today.

### H6 — One-page "Install coop on Windows" for teammates

**Observed:** `README.md` is the only install guide. It is long, mixes macOS and
Linux in, and contradicts itself on whether Azure CLI is auto-installed. New
teammates read it once and then ask.

**Fix:** `docs/install-windows.md`, one page, whose numbered steps are the H1
prerequisite table in the same order and wording the installer prints, followed by
"double-click `Install coop.cmd`", "open a new terminal", "run `coop`", and what
the first-run sign-in looks like. The README's Windows section links to it instead
of repeating it. Nothing in it that the installer does not also say.

**Acceptance:** a teammate on the fresh development VM installs coop from the page
alone, without asking a question. Every command on the page is copy-pasted from
the installer's own output.

## 4. Phase 1 — Right-size tests and CI

**Goal:** every PR runs a gate that finishes in a few minutes and fails only for a
real regression. Everything slower runs on demand or nightly. No test is skipped,
disabled, or quarantined to get green; a test leaves the repo only with the surface
it covers or with a named replacement.

**Observed (September 28, measured on a Linux container; CI on `main` is green at
v0.23.5):**

- `tests/` holds 95 files and 23,765 lines against 29,613 lines of product source
  (`bin`, `lib`, `scripts`, `extensions`), a 0.8 ratio before counting the 3,207-line
  Windows acceptance harness.
- A full `bash tests/run.sh` takes roughly 6.5 to 7 minutes when it passes. Over
  five minutes of that is spent in a dozen process fixtures: `sync-knowledge`
  (62 s, 56 sleeps), `inventory` (57 s), the standards generation crash test
  (40 s, eight spawned children), `fleet-execution` + `install-python-prereq`
  (47 s), `fabric-request-headers` (27 s), `webbridge` (27 s), `knowledge-git`
  (22 s), `doctor` (21 s), `review` (19 s), `home-guard` (14 s). The guardrail
  suite, the largest logic suite, runs in under one second.
- CI runs that suite three times per PR (ubuntu, Windows Git Bash, and the pwsh
  twin), plus a macOS bash 3.2 parse job, a Windows PowerShell 5.1/7 parse job with
  PSScriptAnalyzer, a Pi matrix job that installs Pi from npm, and a focused Windows
  knowledge-search job whose own comment says the full suite "legitimately remains
  red on unrelated open defects".
- Three of the last four commits on `main` are timing repairs (30-second marker
  waits, hang-fixture headroom, orphan reaping). Of the last 40 commits touching
  `tests/`, 35 are Windows fixture debugging iterations from September 18 and 19.
- On this container the suite fails deterministically at
  `fabric-mcp-launch.test.sh` phase `web-no-python-warning`, a fixture for the
  retired `coop web` path that builds a synthetic minimal `PATH`. It passes in CI.
  A test that depends on which directory `python3` lives in is not a product test.
- Ten test files are not run by anything (`ado`, `fleet-digest`,
  `install-pipx-path`, `missing-common-guard`, `knowledge-read`,
  `knowledge-retrieve`, `knowledge-sources`, `support-center`, `tool-result`,
  `repro-tmp-contamination`). The BOM is checked three separate times.

That is the "too aggressive" signal: the cost is in process fixtures and
duplicated gates, not in the logic tests users depend on.

**Split:**

| Lane | Runs when | Contents |
| --- | --- | --- |
| `gate` (required on every PR) | push and PR | syntax (`bash -n`, pwsh parse), shellcheck, parity/BOM (until retired), JSON/YAML/resource validation, esbuild transpile, and the **deterministic logic suites**: standards, guardrails, coop-tools contract, project wizard, launch-spec, `_yaml.py`, `_extdeps.py`, mcp-config, warehouse-mcp, fabric-sql-query, init wizard, doctor project. Target under five minutes on ubuntu. |
| `extended` (manual `workflow_dispatch` + nightly) | schedule | process and timing fixtures: fabric-mcp-launch, sync-knowledge hang cases, first-run PTY, fleet execution, knowledge-git process inspector, update-guard, staleness, azcache, home-guard, inventory, and the Windows-native probes. |
| `workstation acceptance` | on demand before a release | the existing `windows-terminal-workstation-acceptance.yml` and `acceptance/` receipt. |

**Delete with their surface (Phase 2):** `webbridge.test.mjs`, `protocol.test.mjs`,
`diffmodel.test.mjs`, `fabric-mcp-web-launch.test.mjs`, `stub-pi.mjs`, and the two
web phases inside `fabric-mcp-launch.test.sh` (legacy web); the macOS-specific
cases in `knowledge-git`, `inventory`, `install-python-prereq`, `coop-profile` and
the macOS bash 3.2 job once the bash product path is retired; the
update and install test modes per revision 2.0 S7 (retired in S7, issue #228).
`fleet-*` and `ado-*` fixtures stay unless Aaron retires those features.

**Wire or delete now (Phase 1):** the ten orphaned test files above either join the
gate lane (`tool-result`, `knowledge-*`, `support-center`, `missing-common-guard`,
`install-pipx-path` look like real unit tests) or are deleted; one BOM check, not
three. (Done. T1 wired them; `tool-result` and the three `knowledge-*`
modules then turned out to have no product caller and left with their tests,
[#134](https://github.com/kabukisensei/coop-agent/issues/134).)

**Rules for new tests going forward:** a fixture may not sleep or poll for a
subprocess in the gate lane; a Windows-only behavior gets one Windows test, not a
synthetic matrix; a bug fix adds the one test that reproduced it.

**Acceptance:** gate lane green on ubuntu and windows-latest in under five minutes;
extended lane documented in `docs/ci.md`; no assertion weakened; the list of tests
moved or removed recorded in the PR with the reason per file.

## 5. Phase 2 — Simplify for Windows first

Revision 2.0's S1–S7 packages, in this order and with these decisions:

1. **S1 Retire the POSIX product path.** Keep `bin/coop` only as a small Git Bash
   forwarder to `coop.ps1` (Git Bash on Windows is still a supported entry). Delete
   the bash lifecycle scripts (`install.sh`, `update.sh`, `sync.sh`, `doctor.sh`,
   `uninstall.sh`, and the digest/onboard twins) and the parity gate with them.
   Development of coop-agent itself still works on a headless Linux box for the gate
   lane; operating coop needs Windows.
2. **S5 Remove legacy web** (`web/`, `coop web`, its token wrapper, its tests). The
   Electron desktop in Phase 8 does not reuse this code; the shared launch spec
   (`coop launch-spec --json`) is what it needs and that stays.
3. **S3 One profile root.** `COOP_DIR` means two different things today; keep the
   stable defaults, add nothing new until the beta channel needs it, but make every
   reader agree.
4. **S2 / S4 / S6** as described in revision 2.0: one install/update/sync
   convergence path, shared token and MCP predicates with doctor observational, dead
   data-doc writer helpers removed after call-site proof.
5. **S7 Docs and instructions** updated in the same PRs (`AGENTS.md`,
   `CONTRIBUTING.md`, `docs/ci.md`) so agents do not reinstate parity or BOM duties
   for files that no longer exist.

**Dependencies to drop when Windows-first (confirm each before deleting):**

| Candidate | Reason | Confirm |
| --- | --- | --- |
| `mcp-remote` | only bridges Microsoft Learn; Learn is unauthenticated Streamable HTTP and the adapter speaks it directly | exact entry and proof test in section 6.2; live tools-list on the VM |
| `powerbi-mcp-server` (unscoped npm, 0.1.0) | `--readonly` silently ignored, `refresh_dataset` exposed ([#93](https://github.com/kabukisensei/coop-agent/issues/93)); superseded by `@microsoft/powerbi-modeling-mcp` 1.0.0 | drop now, ahead of Phase 2 |
| `pi-better-openai` | Aaron wants the plan-usage stats it feeds the footer, but B0 found its configuration inactive on the live install, and it has had no release since July 11. `@xl0/pi-lovely-codex` handles tool calls but shows no usage stats; `@narumitw/pi-usage` shows the Codex usage windows (section 10) | **keep** until PK1 picks the usage-stats owner on the development VM; drop only if the replacement shows the same 5h/7d usage windows in the Coop footer |
| `context-mode` | sandboxed code execution over docs; overlaps Pi's own compaction | **Dropped** (Aaron, 2026-10-02): its `ctx_execute` / `ctx_batch_execute` / `ctx_execute_file` tools ran shell commands the guardrails never checked (`git commit`, `.env` reads and `fab rm` passed unprompted), and its 11 tool schemas plus 8 skill listings cost about 7,200 tokens per request; the live measurement was not needed. `coop sync` removes it from existing installs (`Remove-CoopRetiredExtensions`). |
| Homebrew/apt/dnf prerequisite branches, `/opt/homebrew` troubleshooting | Mac-only | goes with S1 |

## 6. Phase 3 — Dependency reconciliation against the freeze

Drift measured on September 28, 2026 with read-only `npm view` and PyPI metadata,
refreshed on the evening of September 29 (revision 3.5, section 6.3). The manifest
is `config/release-manifest.json` at v0.23.5.

| Component | Pinned | Latest | Needed? | Notes |
| --- | --- | --- | --- | --- |
| `@earendil-works/pi-coding-agent` | 0.84.3 → **0.87.1** (shipped in v0.24.0, 2026-09-30) | 1.0.0 (Oct 1; 0.99.1 on Sep 29); **target stays 0.87.1 until U2** | **Done** ([#162](https://github.com/kabukisensei/coop-agent/pull/162)); 1.0 is row U2 (section 6.5) | Pre-qualified read-only on Sep 29 (section 6.1): none of the four extensions or the runner test uses a removed or changed API; the pin move is one manifest line plus fixture versions. Still Node ≥ 22.19. 0.99 is out of reach until the adapter supports it (section 6.3). |
| `pi-mcp-adapter` | 2.34.0 → **3.3.0** (shipped in v0.24.0, 2026-09-30) | 3.3.0 (Sep 29) | **Done** (same PR as Pi, [#162](https://github.com/kabukisensei/coop-agent/pull/162)) | 2.34.0's peer range excludes pi-ai 0.87, so it must move with Pi. 3.0 **stopped reading `mcp.json`** (that file now belongs to Pi's built-in MCP); coop's generated file must become `mcp-adapter.json` (section 6.2). |
| `pi-hermes-memory` | 0.7.17 | 0.9.9 | **Merged** ([#181](https://github.com/kabukisensei/coop-agent/pull/181), 2026-09-30, unreleased; VM qualification pending) | Was "Maybe" until 2026-09-30, when Aaron's `/memory-consolidate` on the client VM failed for every store (`exited with code 1: unknown error`). Cause, from the installed code: 0.7.17 launches its consolidation, background-review, correction-save and session-flush child as `pi.exec("pi", ...)`; Pi's `exec` spawns with `shell: false`, and on Windows `pi` exists only as an npm `.cmd`/`.ps1` shim, so the spawn fails and every full memory store rejects new saves. 0.9.9 resolves `pi.cmd` and launches `node` + Pi's `cli.js` directly, runs those jobs in-process first, lets policy-only writes exceed the Markdown cap, raises the consolidation timeout to 180 s, warns on failed auto-consolidation, and adds `/memory-pin` (`STANDING.md`). Peer floor Pi >= 0.80.6 (met by 0.87.1); `better-sqlite3` was already a dependency in 0.7.17. Still to check on the VM: existing `MEMORY.md`/`USER.md`/`projects-memory` content intact after `coop update`, secret scanning still blocks, `/memory-consolidate` succeeds for every target. |
| `pi-web-access` | 0.10.7 → **0.35.0** | 0.35.0 (Sep 30) | **Yes** (Aaron, 2026-10-02: keep web access) | Peers are all `*`; the bundle's Pi imports (`buildSessionContext`, `pi-ai`, `pi-ai/compat`, `pi-tui`) exist in Pi 0.87.1 and 1.0.0, so it does not wait for U2; `web_enable` needs Pi ≥ 0.86. 0.35.0, not 0.33.0: 0.34.0 raised its `undici` floor to 8.11.2 past known advisories. Windows and security changes since 0.10.7: GitHub clones run with `GIT_TERMINAL_PROMPT=0` / `GCM_INTERACTIVE=Never` and kill the whole process tree on timeout (`taskkill /T`), clone cache paths hardened (responsible disclosure), the 5 MB limit enforced while streaming, the fetch cache bounded and symlink-safe, inline `data:` URIs stripped, `@mozilla/readability` past GHSA-3p6v-hrg8-8qj7 (`npm audit`: 2 low → 0). Behavior: fresh sessions show only `web_enable` (~100 fixed tokens instead of ~1,600), searches no longer open the browser curator by default, `code_search` and the bundled `librarian` skill are gone, `source_check` is new; Windows browser-cookie reading exists but stays off unless `allowBrowserCookies` is set. VM step: one `web_search` and one `fetch_content`, and note which search provider answers on a Codex model. |
| `@juicesharp/rpiv-ask-user-question` | 1.20.0 | 2.12.0 (Sep 30) | **Merged** ([#188](https://github.com/kabukisensei/coop-agent/pull/188), 2026-09-30, unreleased; VM step pending) | major bump; the setup wizards depend on its dialogs and cancellation. The draft takes 2.12.0, not the 2.11.0 named here: 2.12.0 is 2.11.0 with `typebox` declared as a peer again, so the extension shares Pi's own copy. Read-only check of both packages: the tool is still `ask_user_question` with the same parameters and result envelope, and cancelling still returns the one decline line; gone is the "Chat about this" row (`kind: "chat"`); new are the always-appended `Type something.` row, per-question and global notes, a `Ctrl+]` collapse key (`collapseKey` in `~/.config/rpiv-ask-user-question/config.json`, `"off"` disables), native-dialog fallback in RPC hosts, removal of the tool from the model's list in non-interactive runs, and `session_load_failed` / `stale_module_cache` envelopes that tell the model to ask in chat instead of counting as a decline. Peers unchanged (`pi-coding-agent`, `pi-tui`, optional `rpiv-i18n`), no native code. VM step: `/setup-project` and `/setup-docs` dialogs, `Esc` cancellation, Windows Terminal rendering. |
| `@juicesharp/rpiv-todo` | — | **2.12.0** (Sep 30) | **Added** (Aaron, 2026-10-03, from the pi.dev package review; VM check pending) | A `todo` tool and a live task panel above the prompt, so a multi-step session shows what coop is doing. Same author, monorepo and `rpiv-config` dependency as `rpiv-ask-user-question`, so no new dependency family. The extension draws its panel as a TUI component, which Pi's RPC mode drops, so the window draws the same panel itself from the session's `todo` tool results (`desktop/renderer/todos.mjs`). Its default collapse key is Pi's tree key, so `coop sync` seeds `~/.config/rpiv-todo/config.json` with Alt+T, the key the window binds too. Adds one tool schema and eight guideline bullets (about 700 estimated tokens) to the model's tool list. |
| `pi-better-openai` | 0.1.22 | 0.1.22 | Test on the VM | a custom provider; Pi 0.86 changed how providers read the system prompt and tools, and no release since July 11. If it fails on 0.87.1, PK1 (section 10) picks the replacement for the usage stats. |
| `context-mode` | 1.0.169 → **removed** | 1.0.169 (no release since Jun 29) | **Dropped** (Aaron, 2026-10-02) | see section 5. |
| `@microsoft/powerbi-modeling-mcp` | 0.5.0-beta.12 | **1.0.0** (Sep 25) | **Yes** | first GA; read-only invocation and connection scope must be re-checked. |
| `@microsoft/powerbi-report-authoring-cli` | 0.1.4 | 0.4.0 | **Merged** ([#199](https://github.com/kabukisensei/coop-agent/pull/199), 2026-10-01, unreleased; VM step done 2026-10-01 on Power BI Desktop 2.158.1177.0: `validate`, `preview --status`, `--reload` and `--screenshot --all-pages` all pass on a disposable PBIP copy, the nested Bridge dependency resolves to the same 1.0.0 as the global one) | the report skills call it; validate output contracts. Read-only check of both published tarballs on 2026-10-01: every verb coop's `power-bi-report-authoring` and `report-themes` skills call (`validate`, `catalog list/describe`, `formatting list-objects/describe-object/describe-property/search/list-vcos`, `expr encode`, `theme encode/shade-color`, `preview-pages/-visuals/-filters/-themes`, `doctor`) still exists with the same name; 0.4.0 adds `preview` (Desktop status/reload/screenshot through the Bridge library), `pack`/`unpack` (Fabric definition payloads), `scaffold`, `measure`, `text`, bookmark, `.pbip` and `datasetReference` validation (new `PBIR_BOOKMARK_*`, `PBIR_PBIP_*`, `PBIR_DATASET_*` codes, so reports that validated clean on 0.1.4 can now report errors), and `hint`/`correction` fields in the error envelope. Its changelog still carries all of this under "Unreleased" and keeps the 0.x "minor versions may break" policy, so the exact pin matters. New runtime dependencies: `playwright`, `powerbi-client`, `@microsoft/powerbi-desktop-bridge-cli` ^1.0.0. |
| `@microsoft/powerbi-desktop-bridge-cli` | 0.1.2 | 1.0.0 | **Merged** (same PR; VM step done 2026-10-01: `status`, `reload` and `screenshot-all` pass on Desktop 2.158.1177.0, `hasUnsavedChanges` reads `false` on an untouched file and `true` after an edit, so the 2.157.627.0 false positive does not reproduce; `preview --reload` on the dirty copy discarded the edit as documented, and the skill's status preflight refusal was not exercised live; S31 is now closed by the coop-guardrails reload gate, see the Power BI qualification table below) | re-test the reload/save source-loss report (S31 in revision 2.0) on disposable PBIP files. Read-only check 2026-10-01: the six commands (`status`, `open`, `manifest`, `reload`, `screenshot`, `screenshot-all`) are unchanged; the one behavior change is that a reload Desktop accepts but does not apply now exits non-zero with `RELOAD_REJECTED` instead of printing `status: ok` with `success: false`, and `status` reports `hasUnsavedChanges` per instance. `reload` still discards unsaved edits unconditionally (the README says so); the status preflight is now enforced by coop-guardrails, not only by skill prose. |
| `@microsoft/fabric-mcp` | 1.3.0 | 1.4.0 | **Merged** ([#189](https://github.com/kabukisensei/coop-agent/pull/189), 2026-09-30, unreleased; VM step pending) | B0 found 1.0.0 installed and 1.2.0 cached; pin exactly, never `@latest`. Offline check of both Linux binaries on 2026-09-30: with coop's `--mode namespace`, 1.4.0 returns an **empty** tool list unless each namespace is named (`--namespace docs --namespace onelake --namespace core --namespace datafactory`), while 1.3.0 lists all four routers by default; with the namespaces named, both versions expose the same four routers and the same commands (1.4.0 in kebab-case, which the guardrails already accept). Tool names in `--mode all` are renamed (`docs_workloads` → `docs_list-item-types`, `docs_workload-api-spec` → `docs_item-api-spec`, `onelake_*` to kebab-case). VM step: `coop sync`, then a live `docs` and `onelake` router call. |
| `@azure-devops/mcp` | 2.9.0 | 2.10.0 | **Merged** ([#191](https://github.com/kabukisensei/coop-agent/pull/191), 2026-10-01, unreleased; VM step pending) | B0 found 2.10.0 already at the executable path. Read-only check of both published packages on 2026-09-30: the same 37 tool names, the same domain list (coop passes `core work work-items search`), and `--authentication azcli` unchanged; 2.10.0 raises `@azure/identity` and `@azure/msal-node` and adds `@azure/msal-node-extensions` and `open` for its interactive sign-in path, which coop does not use. The README's tool-rename warning refers to the consolidation before 2.9.0. VM step: `coop sync`, then one work-item query through the MCP. |
| `mcp-remote` | 0.1.38 | 0.14.3 | **Dropped** ([#190](https://github.com/kabukisensei/coop-agent/pull/190), 2026-10-01, unreleased; VM step pending) | only the Microsoft Learn entry used it; the exact replacement entry and proof test are in section 6.2. The draft generates the direct entry, replaces a managed `command`/`args` Learn entry wholesale on regeneration, and removes the package from the manifest and the skills manifest. VM step: live tools-list against learn.microsoft.com through the adapter. |
| `powerbi-mcp-server` | 0.1.0 | 0.1.0 | **Dropped** ([#116](https://github.com/kabukisensei/coop-agent/pull/116)) | `--readonly` is silently ignored and `refresh_dataset` (a write) is exposed while coop documents it as read-only: [#93](https://github.com/kabukisensei/coop-agent/issues/93). Official `@microsoft/powerbi-modeling-mcp` 1.0.0 replaces it. |
| `coop-data-doc` / `coop-sql-review` / `coop-dax-review` | 1.2.0 / 0.15.2 / 0.22.0 | 1.3.4 / retired / retired | coop-data-doc: **Merged** ([#238](https://github.com/kabukisensei/coop-agent/pull/238), 2026-10-01, shipped in v0.26.0); the 1.3.1 pin rides the DD3 upgrade PR | coop-data-doc v1.3.0 (released 2026-10-01) carries the mixed-estate lineage fixes (section 8.1, coop-data-doc #67); v1.3.1 (released 2026-10-02) keeps 1.2.0-era link decisions working after the upgrade (coop-data-doc [#68](https://github.com/kabukisensei/coop-data-doc/pull/68)); v1.3.4 (released 2026-10-06) adds `loaded_by` to `lineage` (coop-data-doc [#69](https://github.com/kabukisensei/coop-data-doc/pull/69); 1.3.2 and 1.3.3 shipped without it and are skipped); the reviewers retired with ST1 (section 7). |
| `ms-fabric-cli` / `fabric-cicd` / `pyodbc` | 1.7.0 / 1.3.0 / 5.3.0 | same | No | unchanged. |
| `microsoft/skills-for-fabric` catalog | v0.3.10 | v0.3.18 (Sep 25) | **Merged** ([#175](https://github.com/kabukisensei/coop-agent/pull/175), 2026-09-30, unreleased) | v0.3.12 merged the two pinned `sqldw-*` skills into `sqldw-cli`; v0.3.17 unified `powerbi-report-cli`; new `sqldb-cli` targets Fabric SQL database. Aaron widened the row on 2026-09-30 to the **full** skill set (Eventhouses are in use). The merged PR pins v0.3.18, enables all 25 skills as baseline, and ships the shared `common/` tree the skills link (the reference-closure prerequisite in section 6.4). |
| `microsoft/skills` (`kql`, `microsoft-docs`) | commit 903dc62 | 3495f50 (Sep 29) | Low — merged with it | `kql` and `microsoft-docs` are byte-identical between the two commits. |

Order inside the phase: Pi → adapter → ask-user-question → Microsoft npm tools →
Fabric skills catalog → the "maybe" rows. One PR per row, each with the exact
old/new versions, what changed, the tests run, and the rollback.

**Where upgrades are qualified.** Not on a teammate's stable machine. Two existing
mechanisms cover it without new code:

- The **fresh Windows development VM** (set up the week of September 28) is the
  qualification machine: install the candidate version there with the normal
  installer, run the acceptance for the package, and keep the VM's `coop doctor`
  output with the PR. Snapshot the VM after a clean install so every qualification
  starts from the same state.
- For extension, MCP, skill, and prompt changes on a machine that also runs
  stable, a **second clone plus `COOP_AGENT_DIR`** already isolates the Pi agent
  directory (extensions, settings, MCP, sessions). Pi itself is global, so a
  different Pi version needs the VM.

Upgrades reach teammates only through a tagged release (H5), so a qualified change
sitting on `main` cannot surprise anyone. The full isolated beta channel (B1) is
built only if this proves insufficient.

### 6.1 U1 Pi row: pre-qualified on September 29 (read-only)

Method: every symbol named in Pi's 0.85.0 to 0.87.1 release notes was grepped in
the four extensions, `tests/guardrails-pi-runner.test.mjs`, and the matrix scripts,
and cross-checked against Pi's 0.84.3 and 0.87.1 sources. Result:

- **No source change in `coop-guardrails`, `coop-tools`, `coop-profile`, or
  `coop-powerline`.** None uses `shouldStopAfterTurn`, `finishTurn`, assigns
  `state.messages`, switches exhaustively over session entries, emits `turn_end`,
  or hooks `user_bash`. Every `details` payload the tools return is JSON-safe
  (strings, numbers, parsed JSON, frozen plain objects). Extensions load through
  `jiti` without a type check, so the type-level changes cannot fail at runtime.
- **The runner test and matrix scripts are structurally unaffected**: the
  `ExtensionRunner` constructor, `setUIContext`, `createContext`, `emit` for
  `session_start`/`session_shutdown`, and the loader's `createExtensionRuntime` /
  `loadExtensions` have the same signatures at 0.87.1. The RPC probe's commands and
  events still exist.
- **Two things to observe on the VM, not fix in advance:** (1) `coop-tools` and
  `coop-profile` return `systemPrompt` from `before_agent_start`; on 0.86+ that is
  treated as a forced prompt projected on every turn, so the dated daily-log text
  must not spam transcript entries or defeat prompt caching; (2) the footer's
  working indicator, since 0.86 moved Pi's own spinners into the editor border.
- **What the pin PR changes:** `pi.version` in `config/release-manifest.json`;
  `pi-mcp-adapter` in the same PR (2.34.0's peer range stops at pi-ai 0.85; the
  isolated tree's plain `npm install` would fail to resolve); every fake
  `pi --version` fixture that says 0.84.3 (`tests/doctor.test.sh`,
  `tests/fixtures/sync-fake-pi.sh`, `tests/fixtures/install-python-prereq.test.ps1`,
  `tests/install-python-prereq.test.sh`, `tests/run.ps1`, the fleet, home-guard, and
  update-guard tests, the `test-pi-matrix.ps1` usage comment); CHANGELOG. `lib/_extdeps.py`
  needs no change (it aligns pi-ai/pi-tui to whatever `pi --version` reports).
- **VM run:** `bash scripts/test-pi-matrix.sh 0.87.1` and the `.ps1` twin (they
  exercise the runner test, the real loader over the four `.ts` extensions, and the
  RPC probe), then a real session on Windows for the two observations above.
- **Optional hardening, not required for the pin:** `_range_floor` in
  `lib/_extdeps.py` reads only the first triple of an OR-range, so a peer range that
  excludes the agent version passes silently; teach it the upper bound.

### 6.2 U1 adapter row and the `mcp-remote` removal: pre-qualified on September 29

- **`pi-mcp-adapter` 3.0 no longer reads `<agent dir>/mcp.json`**; that file belongs
  to Pi's built-in MCP support. Coop's generated file must be **`mcp-adapter.json`**
  in the same directory (same format; a rename). Every literal consumer changes in
  one PR: `lib/mcp_config.py` (output path), `bin/coop` and `bin/coop.ps1` (launch
  token), `scripts/sync.*`, `scripts/doctor.*` (search list), `scripts/test-pi-matrix.*`,
  `extensions/coop-guardrails/index.ts` (the managed-config read), `lib/fabric_sql_query.py`,
  `tests/fabric-mcp-launch.test.sh`, and the README, architecture, and tool-contract
  docs. `coop sync` migrates once: read the old `mcp.json` as the existing config so
  `_coop.managed_servers` ownership survives, write `mcp-adapter.json`, remove the
  old file so the adapter's startup warning stops. The adapter's `/mcp` command is
  now `/mcp-adapter`. Nothing else in the entry format changed: `url`, `auth: false`,
  `requestHeadersCommand`, `lifecycle`, `requestTimeoutMs`, and coop's private
  `_coop`/`_coop_target` keys all pass through 3.x unchanged.
- **Also in that PR:** the manifest's `pi-mcp-adapter` pin is the only copy
  (S7 removed `config/defaults.yml`'s `tested_with` versions); fix the doctor
  fixtures that assume an older one. Consider `settings.allowInstall: false` (the agent may not install
  remote servers) and the new project-trust rule for a work repo's `.mcp.json`.
- **`mcp-remote` removal, exact change:** the Microsoft Learn entry becomes
  `{"url": "https://learn.microsoft.com/api/mcp", "auth": false, "lifecycle": "lazy",
  "requestTimeoutMs": 60000}` (the endpoint is unauthenticated Streamable HTTP; the
  adapter defaults to that transport with SSE fallback and `auth: false` skips OAuth
  probing). Drop `mcp-remote` from `SERVER_PACKAGES`, the manifest, `config/microsoft-skills.json`,
  and the `defaults.yml` comments; treat a managed `microsoft-learn` entry that still
  has `command`/`args` the way `fabric-sqlendpoint` is treated (replace wholesale on
  regeneration). **Proof test, offline:** `tests/mcp-config.test.sh` asserts the exact
  Learn entry and that an old `command`/`args` entry migrates to the `url` form; the
  live tools-list against learn.microsoft.com is a VM step (the container cannot
  reach that host). Fixtures to update: `tests/microsoft-skills.test.py`,
  `tests/fleet-manifest.test.sh`, `tests/doctor.test.sh`, `tests/warehouse-mcp.test.py`.

### 6.3 Refresh on September 29, evening (revision 3.5, read-only)

Method: npm and PyPI metadata, plus a diff of the extension type declarations
(`dist/core/extensions/types.d.ts` and the event types) in the published
0.84.3, 0.87.1, and 0.99.1 tarballs, restricted to what coop's four extensions
call: 5 `pi.*` methods, 9 `ctx` and 12 `ctx.ui` members, the 9 events it handles,
and their payload and result types.

- **Pi 0.99.0 and 0.99.1 shipped on September 29**, straight after 0.87.1. They add
  `@earendil-works/pi-mcp` (Pi's built-in MCP) and `pi-codemode` as dependencies.
  Node stays ≥ 22.19.
- **Coop's surface is unchanged from 0.84.3 to 0.99.1**, except three additive
  changes: `pi.on` returns an unsubscribe function (since 0.87);
  `BeforeAgentStartEvent.systemPrompt` is readonly, and coop only reads it and
  returns a new prompt, which the runner still chains across extensions; and a
  `tool_result` handler may return `structuredContent`.
- **`pi-mcp-adapter` 3.3.0 (the newest) still declares `@earendil-works/pi-ai`
  `^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0`.** So U1's target stays 0.87.1 with
  adapter 3.3.0, and 0.99 waits until the adapter's peer range includes it. Re-read
  that range when the U1 PR is opened.
- **[#122](https://github.com/kabukisensei/coop-agent/issues/122) matters more now.**
  The newest `pi-coding-agent` that npm would auto-install as a peer is 0.99.1,
  and its own `pi-ai` 0.99.1 dependency is outside the adapter's `pi-ai` range.
- The other rows are unchanged since September 28.

### 6.4 Independent dependency research, September 29, 21:44 CDT (revision 3.6)

**Scope:** read-only registry metadata and published-package inspection against
coop-agent `94dbe767308c6334371a071b058152bd294c23c1`; no candidate installed or
executed. All 13 npm and six PyPI pins were checked at 2026-09-30 02:43 UTC.
Their latest versions still match the table above. This refresh does **not**
start U1 or qualify an upgrade on Windows.

**Runtime and resolution constraints confirmed:**
Pi 0.99.1 still requires Node >=22.19.0; adapter 3.3.0 still excludes pi-ai
0.99.x, so the proposed Pi target remains 0.87.1. `ms-fabric-cli` 1.7.0 requires
Python >=3.10,<3.14 and `fabric-cicd` 1.3.0 requires >=3.9,<3.14; Python 3.12
remains the common recommended interpreter. The Fabric CLI itself depends on
`fabric-cicd>=1.3.0`: top-level version pins do not freeze its dependency tree.
Keep the exact injected library pin and record the resolved environment at
qualification. Sources: [Pi metadata](https://registry.npmjs.org/@earendil-works/pi-coding-agent/0.99.1),
[adapter metadata](https://registry.npmjs.org/pi-mcp-adapter/3.3.0),
[Fabric CLI metadata](https://pypi.org/pypi/ms-fabric-cli/1.7.0/json),
[Fabric CI/CD metadata](https://pypi.org/pypi/fabric-cicd/1.3.0/json).

**Power BI qualification has additional gates, beyond changing version numbers:**

| Candidate | Verified upstream detail | Acceptance evidence required before adoption |
| --- | --- | --- |
| Modeling MCP 1.0.0 | The packaged changelog records mandatory EULA acceptance, a local application-folder rename/migration, durable audit logging, and increased DAX result limits between beta.12 and GA. Current upstream documentation specifies `--accepteula` / `PBI_MODELING_MCP_ACCEPT_EULA=true`; use only after explicit agreement to the EULA. | Fresh and existing-profile startup; explicit consent handling; existing connection/read-only checks; preserve bounded DAX reads rather than relying on the new 1,000-row default / 100,000-row absolute maximum. Never silently accept the EULA as part of this research or a version bump. |
| Desktop Bridge 1.0.0 | The published README explicitly says CLI `reload` and library reload methods do not check `hasUnsavedChanges`; unsaved Desktop edits can still be discarded. It also reports a false-positive dirty flag on Desktop 2.157.627.0. **Version 1.0.0 is not a source-loss fix.** | On disposable PBIP copies, test clean, genuinely dirty, and missing/invalid-status cases against the exact Desktop build. Keep the v0.3.18 skill's fail-closed status preflight; an unreliable flag is not permission to discard. VM result 2026-10-01 on Desktop 2.158.1177.0: clean and dirty flags are accurate; the dirty reload discarded the edit; the skill refusal and the closed/invalid-instance case were not exercised live. **S31 closed 2026-10-02:** coop-guardrails now runs `powerbi-desktop status` before every `powerbi-desktop reload` and every `powerbi-report-author preview` that reloads, asks on `hasUnsavedChanges: true` (blocked headlessly) and blocks an instance it cannot verify (status fails, pid missing or not connected, flag unstated); CI proves it against a stubbed bridge (`tests/guardrails.test.mjs`), which also covers the closed/invalid-instance case the VM run skipped. |
| Report Authoring CLI 0.4.0 + Bridge 1.0.0 | The published authoring manifest depends on `@microsoft/powerbi-desktop-bridge-cli: ^1.0.0`. Its Desktop preview imports that library; the global `powerbi-desktop` executable is not proof of which nested copy preview uses. | Record both the authoring package's resolved Bridge dependency and the global Bridge version. Exercise `powerbi-report-author preview` through status, reload and screenshot separately; distinguish partial capture from success. Qualify the authoring/Bridge pair together even if pin changes are separate PRs. VM result 2026-10-01: global and nested Bridge both 1.0.0; `preview --status`, `--reload` and `--screenshot --all-pages` each fully succeed (10 of 10 pages, no failures). |

Sources: published npm tarballs
([Modeling MCP 1.0.0](https://registry.npmjs.org/@microsoft/powerbi-modeling-mcp/-/powerbi-modeling-mcp-1.0.0.tgz),
[Bridge 1.0.0](https://registry.npmjs.org/@microsoft/powerbi-desktop-bridge-cli/-/powerbi-desktop-bridge-cli-1.0.0.tgz),
[Report Authoring 0.4.0](https://registry.npmjs.org/@microsoft/powerbi-report-authoring-cli/-/powerbi-report-authoring-cli-0.4.0.tgz));
[upstream EULA/setup documentation](https://github.com/microsoft/powerbi-modeling-mcp#accept-the-eula);
[versioned preview safety and partial-result contract](https://github.com/microsoft/skills-for-fabric/blob/v0.3.18/skills/powerbi-report-cli/references/authoring/preview-part-02.md).
The tarballs' manifests and documentation were read without executing package code;
these are upstream contracts, not a claim that Coop has passed them.

**Fabric catalog migration is more than an allowlist rename.**
[Release v0.3.18](https://github.com/microsoft/skills-for-fabric/releases/tag/v0.3.18)
is confirmed. Its [`skills/sqldw-cli/SKILL.md`](https://github.com/microsoft/skills-for-fabric/blob/v0.3.18/skills/sqldw-cli/SKILL.md)
combines authoring, consumption **and operations**, while Coop currently defers
`sqldw-operations-cli`. Mapping the two baseline names to `sqldw-cli` would also
surface operations guidance: retain the current policy boundary or obtain an
explicit decision before broadening it. `sqldb-cli` concerns **Fabric SQL
database**; its presence alone does not complete SQ1's Azure SQL support.

The same dispatcher links to `../../common/COMMON-CLI.md` and
`../../common/COMMON-CORE.md`. Coop's current `lib/microsoft_skills.py` copies only
each selected skill directory into the published generation. **Static finding:**
a name/hash-only catalog update would not supply those shared files at their
relative destinations. Before adopting the catalog, check reference closure in
the generated layout, supply the approved shared references with equivalent
integrity checks, and preserve Cooptimize approval and data-access rules over
upstream execution instructions. This is an implementation prerequisite for the
future catalog PR, not authorization to enable additional skills now.

### 6.5 Pi 1.0 shipped on October 1: one upgrade row, U2, and no separate 0.99 step (revision 3.10)

Aaron flagged the Pi 1.0 announcement on 2026-10-01. Checked read-only the same
evening against the published tarballs (`@earendil-works/pi-coding-agent` 0.99.2
and 1.0.0, npm metadata for `pi-ai`, `pi-tui` and `pi-mcp-adapter`); nothing was
installed on a workstation and PR [#170](https://github.com/kabukisensei/coop-agent/pull/170)
stays a held draft.

**What 1.0 is.** `@earendil-works/pi-coding-agent` 1.0.0 was published on
2026-10-01 (19:15 UTC), one day after 0.99.2. `pi-ai` and `pi-tui` 1.0.0 shipped in
lockstep, so `lib/_extdeps.py`'s alignment still resolves. Node stays >= 22.19.
The 1.0 dependencies are all `^1.0.0` (`pi-ai`, `pi-tui`, `pi-agent-core`,
`pi-codemode`, `pi-mcp`). Headline changes: the TUI is **fullscreen by default**
(`tuiMode: "regular"` keeps scrollback), codemode uses about 40% fewer prompt
tokens, `quietStartup` accepts `"header"`, MCP OAuth hardening, Radius and
Anthropic copy-code sign-in. 0.99.2 (2026-09-30) renamed built-in MCP tool and
namespace names from `-` to `_` (`mcp__my-server__x` is now `mcp__my_server__x`),
stopped the first prompt waiting on built-in MCP servers, and added `!command`
header values resolved once per connect.

**What it means for coop.**

- The extension API coop uses is **unchanged**: `dist/core/extensions/types.d.ts` is
  byte-identical between 0.99.2 and 1.0.0, so the 0.87.1 to 0.99.1 finding in
  section 6.3 (additive only) covers 1.0 too. `pi -e`, `PI_CODING_AGENT_DIR`,
  `ctx.ui.setFooter` and the `"extensions": ["-builtin:mcp"]` setting all remain.
- **The adapter blocks 1.0 the way it blocked 0.99 a day earlier.** `pi-mcp-adapter`
  4.0.0 (2026-09-30, the newest) declares `@earendil-works/pi-ai`
  `^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0 || ^0.99.0`, so Pi 1.0's `pi-ai` 1.0.0
  is outside it; its changelog has no 1.0 entry and no open issue asks for one.
  The author added 0.99 support one day after 0.99 shipped.
- **Fullscreen is the one behavior change coop must decide, not just qualify.**
  `coop-powerline` renders the footer and splash for the scrollback TUI. The
  default position is that `coop sync` writes `tuiMode: "regular"` next to
  `quietStartup` (one more entry in `lib/pi_settings.py`), and fullscreen becomes a
  later, deliberate row once the footer is seen working in it on the VM.
- The 0.99.2 `-` to `_` rename only touches Pi's built-in MCP, which coop locks off;
  the adapter's `mcp` / `mcp__<namespace>` tool shapes are unchanged in 4.0.0.
  The built-in MCP still has no per-request header hook (0.99.2's
  `"auth": { "provider": ... }` reads a token on every request, but only a Pi
  provider's `/login` token, not coop's Azure bearer helper), so the adapter-first
  answer in the 0.99 runbook (`runbooks/pi-0.99-path.md` in the project files)
  stands.

**Decision for the plan.** There is no separate 0.99 pin. Row **U2** moves Pi from
0.87.1 **straight to 1.0.x** in one PR, VM-qualified, carrying the 0.99 runbook's
steps (#170's guardrail changes for the built-in tool shape and codemode's nested
calls; pin move across the manifest, `tested_with`, the matrix workflow and the
fixture versions; `-builtin:mcp` locked by `coop sync`; doctor warns on a stray
`<agent dir>/mcp.json`; docs) plus `tuiMode: "regular"`, then `node lib/extlock.js
generate` for the lockfile. It **starts after** `pi-mcp-adapter` publishes a peer
range that includes `pi-ai` ^1.0.0 and Aaron starts it; until then coop ships 0.87.1
and #170 stays a draft. Moving coop's servers onto Pi's built-in MCP and turning
fullscreen on remain separate later rows, as before. U2 sits after U1 and N1,
before PK1, and must land before D1, because the Electron desktop packages the Pi
coop ships.

**Not urgent (Aaron, 2026-10-01: "only if it's really worth it", stability and
capability first).** For coop, 1.0 adds little capability today: the headline
features (leaner codemode, MCP OAuth, Radius, image generation) sit in parts of Pi
coop locks off or does not use, and the fullscreen default is a risk to qualify,
not a gain. 0.87.1 is qualified and running on the fleet, while 1.0 is a day old
and its adapter does not support it yet. So U2 waits for a reason as well as the
adapter: a Pi fix or feature coop actually needs, 0.87.x no longer receiving
fixes, or D1 needing a current Pi to package. It also waits for 1.0 to soak: the
first 1.0.x patch release, or a week with no regressions reported upstream.
The row's status is **watch and wait**. Until one of those holds, nothing
in the current phases moves for it.

**Simplicity and maintainability (Aaron, 2026-10-01).** Today 1.0 adds workarounds
rather than removing any: the `tuiMode` pin, the `-builtin:mcp` lock, #170's
guardrail handling of the built-in tool shape and codemode's nested calls, and a
newer adapter release to track. The upgrade that would **simplify** coop is the
one that drops the adapter: Pi's built-in MCP is first-party and versioned with
Pi, so moving coop's servers onto it removes a fast-moving third-party dependency
(three breaking majors in a week), the `mcp-adapter.json` migration and the
exclusive-mode environment. It cannot happen yet because the built-in still
resolves `headers` once per connect (no per-request hook for the Warehouse
bearer helper) and has no exclusive config source (a trusted repo's
`.pi/mcp.json` replaces global servers). The worthwhile shape of U2 is therefore
**Pi 1.x plus the adapter drop in one row**, once Pi offers a per-request header
command (or coop proves a `!command` header with reconnect on 401) and coop owns
the trust decision; a Pi pin bump alone is maintenance, not an improvement.

## 7. Phase 4 — Standards alignment and the reviewer decision

Depends on H3 having access to the two repositories.

1. **Resolver follows the repo.** Finish H3's data-driven reader. coop reads the
   coop-standards Obsidian wiki articles directly by their front matter (`domain`,
   `layer`, `artifact`, `technology`, `status`). It does not use the repo's
   `scripts/assemble.py`, `standards/*.md`, or `standards.yml`, which stay in the
   repo unchanged for the team and older clients. Keep provenance (revision, article
   path, file hash) because it is what makes a review reproducible; drop the
   anchor-commit and archive-hash equality checks that only prove the repo has not
   changed shape.
2. **Standards are what coop writes to.** Every skill and prompt that authors SQL,
   DAX, or a semantic model reads the effective standard for that domain at task
   start (this already happens through `buildStandardsContext`) and the
   `coop-workflow` slice checklist names the standard section it applied.
3. **Reviewer decision.** `coop-sql-review` and `coop-dax-review` are deterministic
   linters with their own rule sets, keyed to the standards through `--standards`.
   Once coop applies the standards while writing, the in-agent `sql_review` and
   `dax_review` tools mostly re-find what the model already knows. Recommendation:
   - retire the in-agent wrappers and the bundled-fallback resolution path (a large
     part of `lib/standards.mjs` exists only to bind reviewer provenance);
   - keep the two CLIs as **optional CI gates** (`coop init --ci`, `docs/ci.md`) only
     for clients whose pipelines run them, and re-key their rules to the new
     standards format in their own repos;
   - if no client pipeline uses them within one quarter, archive the CLIs.

   **Decided 2026-09-28 (Aaron):** the review tools leave coop. Standards are
   enforced while writing, from the wiki articles. The replacement is a short
   self-check: before presenting SQL, DAX, or model changes, coop checks its own
   diff against the same articles it used to write them and names any rule it could
   not meet. No separate rule engine. **Answered 2026-09-30 (Aaron):** no client
   pipeline runs the CLIs; they were built before the team's coop-standards
   repository existed. So ST1 retires the wrappers and archives `coop-sql-review`
   and `coop-dax-review` (their repositories and the coop-website pages that
   document them) instead of keeping them as optional CI gates. Until ST1 lands,
   the reviewers are fed from the wiki so they never contradict what coop just
   wrote.
4. **Tabular Editor BPA** stays as the deterministic model check; it is vendor-owned
   and not tied to the standards format.

## 8. Phase 5 — SQL platform breadth: Fabric plus Azure SQL, dev by default, live impact

**Observed:** live SQL works only against Fabric. The pyodbc fallback accepts only
`*.datawarehouse.fabric.microsoft.com` servers discovered through the Fabric REST
API; the managed MCP route is the Fabric SQL-endpoint data-plane URL; the target
model is Fabric workspace and item GUIDs; the environment is inferred by matching
workspace names. No code queries `sys.*` metadata; impact analysis comes only from
the `coop-data-doc` graph built from local files. Power BI docs can exist without
SQL sources; the graph cannot establish full SQL impact when SQL coverage is
partial or absent (section 8.1). SQ4 adds the existing live metadata route.

**Work, in order:**

1. **Connection targets in the contract.** Add a `sql_targets:` section to
   `.coop/project.yml` with one entry per environment and a `default_environment:
   dev`. Each entry names a `kind`, `server`, `database`, and for Fabric the
   existing workspace/item IDs. Production entries are present but never default.
   "Serverless" means two different products, and the contract names them apart:

   | `kind` | Host pattern | Notes |
   | --- | --- | --- |
   | `fabric_warehouse`, `fabric_lakehouse` | `*.datawarehouse.fabric.microsoft.com` | today's path, unchanged |
   | `fabric_sql_database` | `*.database.fabric.microsoft.com` | Fabric's OLTP SQL database item; the v0.3.18 `sqldb-cli` skill covers it |
   | `azure_sql` | `*.database.windows.net` | Azure SQL Database, including the **serverless compute tier** (same host; auto-pause means the first connection after idle can take up to a minute, so the connect timeout for this kind is 60 s, not 15) |
   | `synapse_serverless` | `*-ondemand.sql.azuresynapse.net` | Synapse serverless SQL pool: query-only over lake files and views, no DML, no persisted tables; impact tracing covers views and external objects only |

2. **Azure SQL in the fallback executor.** Extend `lib/fabric_sql_query.py` (rename
   to `sql_query.py` in the same PR) to accept the hosts above **from the contract**
   (today the server is never user-supplied; it is discovered through the Fabric
   REST API, which stays the rule for Fabric kinds). Same token audience
   (`https://database.windows.net/`), same ODBC Driver 18, same row/byte caps.
   `ApplicationIntent=ReadOnly` only for `azure_sql` targets that have read-scale
   replicas (Premium and Business Critical); elsewhere the driver ignores it, so
   the read-only guarantee stays the query filter plus `autocommit` with no
   transaction. Entra ID token authentication only: no SQL logins, no stored
   passwords, no connection strings in tool results or audit records.
3. **Guardrails unchanged in spirit, wider in vocabulary.** The bounded session grant
   (`LiveReadScope`) gains the target kind and environment from the contract instead
   of the hard-coded Fabric URL; production keeps the explicit-scope-and-approval
   rule; DDL/DML on dev still asks once per session.
4. **Live impact tracing.** A read-only `sql_impact` capability that, for one object
   on the default (dev) target, returns upstream and downstream objects, then hands
   the same object to `data_doc lineage` when built docs exist. The
   `impact-analysis` prompt and the `coop-workflow` skill call it before any edit.
   Three fixed, parameterized catalog queries, never free text (the current filter
   rejects quotes and `WITH` on purpose, and `OBJECT_ID(?)` takes the name as a
   bound parameter):
   - **Downstream (who references this object):** `sys.dm_sql_referencing_entities`
     joined to `sys.objects`, which resolves references at call time and works on
     every kind above.
   - **Upstream (what this object references):** `sys.sql_expression_dependencies`
     for the object's own referenced entities, with `sys.sql_modules` as the
     fallback text search when a dependency is unresolved (a dropped or cross-database
     reference shows as `is_ambiguous`/null there).
   - **Shape:** `INFORMATION_SCHEMA.COLUMNS` for the object's columns, so the
     before/after comparison in step 5 knows what to count.
   Fabric Warehouse and Fabric SQL database expose these catalog views; Synapse
   serverless exposes them for views and external tables only. Where a kind lacks
   a view, the capability says so in its result instead of returning an empty list,
   so "no dependents" is never confused with "could not look".
5. **Verify with data.** The slice workflow already requires a failing check before
   and a passing check after. Make it concrete for SQL: capture row counts and a
   bounded sample for the affected objects on dev before the edit, apply the edit on
   dev (after approval), re-run the same queries, and show the difference. Writes go
   only to the default dev target; test and production remain ask-first and
   explicit-approval respectively.
6. **Microsoft skill mapping.** Enable `sqldw-cli` for Fabric and evaluate `sqldb-cli`
   (Fabric SQL database, OLTP) from the v0.3.18 catalog; neither covers Azure SQL
   outside Fabric, so Coop's own `sql-review`/workflow guidance stays the authority
   for Azure SQL.
7. **Client platform choice at install time (Aaron, 2026-09-30).** `coop install`
   (and `coop doctor --fix` on an existing machine) asks once whether this client
   runs on **Fabric**, **Azure SQL**, or **both**, and stores the answer as a
   machine default in the Coop profile. `/setup-project` proposes it as the
   `sql_targets` kind for a new contract (the contract still wins per repository,
   since one teammate can serve two clients), `coop doctor` skips the Fabric CLI
   and Fabric token rows on an Azure-only machine instead of showing them red, and
   the Fabric skill baseline stays off there unless a contract turns it on.
   Nothing else branches on the answer: guardrails, approvals and the SQL executor
   read the contract, never the install choice.

**Acceptance:** on a dev Azure SQL database and on a Fabric Warehouse, the same
session traces a view's dependents, edits it with approval, and shows before/after
counts. A production target configured in the same contract is never selected
without the explicit approval path. No credential or connection string ever
appears in a tool result or audit record.

## 8.1. Mixed-estate documentation repair — DD1–DD4

**Authorized:** Aaron asked on October 1 to begin fixing `coop-data-doc` and
update this canonical plan. All Power BI code is source-controlled; SQL varies
by client, from established repositories to partial scripts to no local sources.
This is a focused companion repair lane alongside the existing SQ work, not a
second roadmap or a mandate to onboard every client's SQL estate first.

**Reverified baseline:** `coop-data-doc` main `cef94a5` (v1.2.0); Coop main
`506a12c`, reconciled through [#232](https://github.com/kabukisensei/coop-agent/pull/232), which includes S7 [#229](https://github.com/kabukisensei/coop-agent/pull/229), S6 [#227](https://github.com/kabukisensei/coop-agent/pull/227),
S4 [#225](https://github.com/kabukisensei/coop-agent/pull/225), S2
[#223](https://github.com/kabukisensei/coop-agent/pull/223) and S3
[#221](https://github.com/kabukisensei/coop-agent/pull/221). The earlier Coop static
baseline `bb80b18` is superseded. ST1 [#211](https://github.com/kabukisensei/coop-agent/pull/211)
merged on 2026-10-01 (f29bd50, after this lane started); SQ1–SQ7 remain open work, including SQ4
[#215](https://github.com/kabukisensei/coop-agent/pull/215), SQ5
[#216](https://github.com/kabukisensei/coop-agent/pull/216), and SQ6
[#217](https://github.com/kabukisensei/coop-agent/pull/217). Recheck main and those
branches before wrapper changes; do not duplicate their live SQL executor,
authentication, approvals, or standards work. Dev read policy
[#230](https://github.com/kabukisensei/coop-agent/pull/230), and SQL formatting
[#231](https://github.com/kabukisensei/coop-agent/pull/231) are also active; [#232](https://github.com/kabukisensei/coop-agent/pull/232) owns injection drift and is unrelated to DD.

**Pinned-version compatibility:** `config/release-manifest.json` still pins
`coop-data-doc` 1.2.0; no version or release changes are included here. The wrapper
accepts that version's existing JSONL setup protocol and preserves its legacy
lineage slice, labeling absent evidence **unknown** and qualifying empty results.
An exact 1.2.0 temporary install was exercised against synthetic lineage and the
wrapper. The companion fixes in draft #66 become available to normal installs
only after a separately authorized, qualified release and manifest pin update;
the wrapper cannot retroactively repair lineage produced by 1.2.0. Native Windows
workstation/pipe acceptance remains separate from Ubuntu/Windows CI unit tests.

**Architecture:** `coop-data-doc` remains offline and deterministic, using the
single existing wizard and explicit local files. SQL repositories are optional.
Clients may document only selected roots, folders, or schemas; coverage must
state that scope. A successful parse of the selected files is not proof of full
estate coverage. Live discovery and verification belong to Coop's existing SQ
integration; no new live SQL, auth, MCP server, or alternate wizard is added to
the companion.

**Evidence contract to implement:** carry declared source coverage separately
from observed scan/parse completeness. Distinguish `complete` (within an explicit
declared scope), `partial`, `missing`, and `unknown`; omitted declarations default
to `unknown`. Keep outside-estate `external` and unresolved/skipped links explicit.
Report evidence origin, source scope, resolution method and parser limitations.
An empty upstream/downstream list means no *observed* links within that evidence,
never a verified zero-impact estate when coverage is partial, unknown, missing,
opaque, or unresolved. Never generate SQL lineage by guessing from a Power BI
object name or by selecting the first candidate. Local and live evidence retain
their own scope and availability; report drift rather than silently replacing
one with the other. SQL-less builds remain useful for Power BI dependencies.

| Step | Depends on | Focus and acceptance | Current evidence/status |
| --- | --- | --- | --- |
| DD1 | authorized now | Protect source trees from output cleanup; neutralize SVG, tooltip and diagnostics injection; retain Business Intent through layer/page changes and uncertain identities; reject incomplete crawls and strict failures before graph publication | Implemented locally on isolated data-doc branch; 18 synthetic regressions and full 646-test suite pass, Ruff/format pass; real fixture HTML build passes (35 objects, 49 edges). Independent code review passed. Data-doc commit `fee3f42` on `dd1/source-output-safety`, published in draft [#66](https://github.com/kabukisensei/coop-data-doc/pull/66); not merged or released. Scoped table-layer intent migration only; unmatched authored pages retained for reconciliation. DD2 now closes strict cache deferral and file-level omission publication gaps. |
| DD2 | DD1 | Declare mixed-estate scope and completeness in the existing config/wizard; machine and human coverage/trust/provenance; Power BI-only and partial SQL builds; lineage and impact qualify empty results; semantic-definition changes seed impact; prevent incomplete evidence from pruning saved decisions | Implemented in data-doc commit `e95cee1`, published in draft #66; 656 tests, Ruff/format, synthetic HTML build and independent review pass. Optional source/repo and layer declarations default unknown; wizard, graph, index, lineage and `impact --evidence` retain scoped confidence/provenance. Strict cache writes defer until validation; file omissions reject publication; stale human decisions are retained. Not released. Coordinate atomic decision persistence with existing data-doc [#63](https://github.com/kabukisensei/coop-data-doc/issues/63); do not duplicate its implementation. |
| DD3 | DD2, migration review | Same-name models across roots and nested paths; exact report path binding; cache invalidation when source changes while target survives; preserve every partition source; SQL UNION/EXCEPT/INTERSECT and CTAS dependencies; preserve SQL multi-part source names | Implemented in data-doc `4b022f8`, published in draft #66: 16 integrity regressions, full 672 tests, Ruff/format and independent review pass. All SQL/M, composite and calculated partition dependencies are accumulated; source signatures preserve changed human decisions for explicit re-review. SQL/BIM/TMDL definition hashes seed impact. Duplicate semantic identities stop publication; exact path bindings never fall back to unrelated basenames. Scope-qualified IDs require explicit backward compatibility for existing intent and cache; emit collision/migration diagnostics first wherever identity needs user choice. Never silently merge estates or rewrite committed decisions. |
| DD4 | DD2/DD3 contract; S6 main; ST1/SQ branch reconciliation | Coop config discovery agrees with companion ancestor/environment rules and picker paths resolve against config base; wrapper claims only actual successful artifacts; lineage retains coverage/trust/provenance; UTF-8 JSONL stdin/stdout works through Windows pipes; formula-safe CSV; contract/docs alignment | Implemented and independently reviewed in draft #233 (`9437ea1`, reconciled merge `6924292`); companion `32490dc` in draft #66: wrapper follows ancestor/environment/symlink config discovery and config-base picker paths, retains scoped evidence and claims artifacts only on successful publishing commands or existing files. Companion UTF-8 bidirectional pipe and formula-safe CSV regressions pass; full data-doc suite is 674 tests with Ruff/format. Coop full gate suite and shell/BOM checks pass; standalone PowerShell gate passes with canonical macOS temporary paths. Data-doc exact-head CI passes Python 3.10–3.13 on Ubuntu and Windows; Coop exact-head CI/platform jobs are still running. Keep the existing wizard/protocol. Coordinate data-doc installation/cache docs with [#65](https://github.com/kabukisensei/coop-data-doc/issues/65). Windows acceptance remains unverified by macOS fixtures. |

**Deferred package qualification:** the original dependency finding concerns
resolved Python package versions and broad dependency ranges, not SQL object-name
qualification. No Python lockfile, exact transitive resolution, or multi-version
package qualification was implemented in DD1–DD4. These remain a separate release
reproducibility task; successful CI on the versions resolved by its run does not
qualify every version admitted by the dependency ranges. No dependency or release
pins are changed by these drafts.

**Mixed-estate acceptance matrix (synthetic fixtures, no client access):**

| Power BI coverage | SQL coverage | Required result |
| --- | --- | --- |
| Complete source-controlled models/reports | Complete within declared client scope | Separate estate identities, every partition retained, known SQL-to-model-to-report edges and qualified evidence; deterministic cold/warm/parallel output. |
| Complete | Partial roots/folders/schemas | Full available Power BI docs, known SQL links only, explicit uncovered SQL scope and unresolved sources. No full-estate impact or zero-impact conclusion. |
| Complete | Missing/no SQL repository | Existing Power BI-only wizard and build succeed; Power BI lineage remains useful; SQL source/impact unknown or explicitly external, with no invented SQL nodes or links. |
| Complete | Unknown | Unknown coverage survives a successful scan; warnings and evidence explain why absence of a link proves nothing outside the observed scope. |
| Opaque/partial model or broken source | Any | Degraded/unknown evidence and actionable diagnostics; incomplete scans do not replace the previous generation or prune human intent/cache decisions. |
| Duplicate model/object names across estates | Any | Keep scopes distinct or require a mapping choice; exact declared paths win only in their own root. Old IDs/intent/cache are preserved or explicitly migrated. |
| Available local graph plus SQ live metadata | Partial/missing SQL | SQ reports availability per section; Coop compares evidence and reports drift. Offline graph absence and unavailable live metadata never become empty verified impact. |

Run each repo's defined checks, plus security/preservation/migration regressions
and a real HTML build from synthetic fixtures. Review independently before
publication. Windows pipe encoding and PowerShell 5.1 runtime acceptance need a
Windows runner/VM; no client databases, repositories, credentials, or destructive
source operations are used. Publish tested/reviewed chunks as draft PRs (Aaron authorized October 1) so agents
can coordinate ownership. Keep unfinished work local. Merge, release and deployment
still await Aaron's separate instruction.

## 9. Phase 6 — First run shows common workflows, not a wizard

**Observed:** the first plain `coop` launch runs `scripts/onboard.py` (name,
communication preference, integrations) before Pi starts and stops the launch when
it fails; `/start` is an on-demand menu whose first item creates or edits the
project contract; `/setup-docs` and `/setup-project` are separate wizards.

**Change:** on first run (and via `/start` any time) open one menu of the workflows
consultants actually do, each mapped to the existing prompt or skill:

1. Review a SQL object or a DAX measure against the standards (the standards
   self-check that replaced `sql-review` / `dax-review` in ST1)
2. Trace impact of a change (`impact-analysis`, Phase 5 live tracing)
3. Fix or edit an object on dev with approval (`spec-first` → `slice-next`)
4. Document a warehouse or semantic model (`setup-docs`, `data_doc build`)
5. Start a client project (`/setup-project`)
6. Write today's log or a handoff (`daily-log`, `handoff`)
7. Sign in or check health (`az login`, `coop doctor`)

Onboarding questions that are still needed (name, tenant) move into item 5 or into
the first workflow that needs them; nothing blocks the launch. The menu is the
existing `/start` code in `extensions/coop-tools`, not a new UI.

## 10. Phase 7 — TeamAI shared knowledge; the beta channel is skipped

**K1–K3 TeamAI shared knowledge (scheduled, revision 3.8).** Starts after FR1 on
Aaron's explicit start, in the revision 2.0 order: **K1** isolated CLI, read-only
recall and sources; **K2** reviewed contribution and promotion; **K3** the broader
knowledge lifecycle, each deliberately enabled. Revision 2.0 section 8 is the
package detail and its gates hold unchanged: the exact TeamAI artifact installed
only in an isolated package root, a sandbox team repository and disposable
workspace, verified data-home and resource destinations, no hooks, rules, MCP
definitions or packages injected into stable coop, private Hermes memory kept
separate from shared knowledge, and the old local search/sync path removed only
after TeamAI covers its supported workflows. Isolation is the development VM (or
a separate Windows account), since there is no beta channel. Each K row is its
own PR with its own acceptance evidence.

**K1 as built (2026-10-01, in review).** The isolation is a home redirect, not a
vendor patch: `lib/teamai.py` installs the pinned `teamai-cli` with
`npm install --prefix` into `<profile dir>/teamai/pkg` and runs it with
`HOME`/`USERPROFILE` set to `<profile dir>/teamai/home`, a disposable
`<profile dir>/teamai/workspace`, `TEAMAI_HOOKS_DISABLED`, `TEAMAI_RECALL_DISABLED`,
`--dry-run` recall, no inherited `TEAMAI_*`/`CLAUDE_*` variables, no stdin, a
hard timeout and a git push guard (`pushInsteadOf=no-push://` for every push URL
the CLI's git sees; the VM run showed `teamai init` trying to register the member
on the `teamai-reports` branch), so the CLI's data home and every AI-tool
destination it would inject into land inside that root and nothing it does can
write to the team repository. `coop teamai` is the only entry
(`status|install|init|pull|recall --query`), launch never calls it, `coop sync`
converges it only when `knowledge.teamai.enabled` is true, and results are
capped at five with repository, revision, file and author provenance plus the
`no_match`/`partial`/`unavailable`/`stale` distinctions. Defaults taken: off by
default; the sandbox team repository URL is Aaron's input
(`knowledge.teamai.team_repo`); the local search and `/share-learning` stay as
they are (section 8.5 removal waits for K3); contribution is K2. Acceptance
evidence is the development VM run in `E:\coop-sandbox` (recall against a
sandbox team repository with harmless markers, real paths under the sandbox
profile, nothing under the real home).

**K2 as built (2026-10-01, in review, stacked on K1).** The CLI's own publication
does not meet section 8.3: `teamai contribute` commits straight to the team repo's
`learnings` branch and `teamai push` opens the pull request from inside the CLI.
`coop teamai contribute --file <draft.md> [--title] [--approve]` therefore runs the
CLI only in `--dry-run` (for the exact destination), sweeps the draft (secrets,
connection strings, URL credentials, `client-confidential` or missing
`sensitivity:` marking keep it local), returns a `preview`, and only `--approve`
after the person's review stages the note on a new `coop/learning/<slug>-<stamp>`
branch pushed from a disposable clone, printing the compare URL; the pull request
is the person's, the default and `learnings` branches are never written, and the
isolated CLI no longer inherits `GITHUB_TOKEN`/`GH_TOKEN`. `/share-learning` carries
the route when the user picks the trial repository. Defaults taken: a staged branch
(not a pull request) is the hand-off; a 64 KiB draft cap; branch names under
`coop/learning/`. Acceptance evidence is the VM run (K1 runbook, plus one staged
branch on the sandbox team repository with a harmless marker note).

**K3 as built (2026-10-01, in review, stacked on K2).** The broader lifecycle is
three read-only views behind the same `coop teamai` entry. `skills` lists the team
repository's `skills/*/SKILL.md`; a new `knowledge.teamai.skills` flag (off by
default, asked by `coop onboard --config-only`) lets `launch-spec` load them through
the existing subordinate team-skills slot, with the clone path read from
`state.json` so the launcher still never runs the CLI and a Cooptimize skill wins
every name or folder clash. `maintenance` reports stale learnings
(`knowledge.teamai.stale_days`, default 180), proposals older than 90 days,
malformed notes and duplicate titles and writes nothing; clean-up is a pull request
on the team repository, never an automatic prune. `compare --query` runs the bundled
local search and the isolated recall side by side and reports the overlap: that is
the section 8.5 evidence, and the local search, `coop sync` knowledge clones and
`/share-learning` all stay (nothing is removed by K3). Not adopted: the CLI's
`digest`, codebase extraction, session sharing, `recall maintenance --prune` and
multi-project mode, each a write path or a hook outside the isolation. Acceptance
evidence is the VM run (K1 runbook: `skills`, `maintenance` and `compare` against
the sandbox team repository, a launch with `knowledge.teamai.skills` true showing
the clone skill in `coop launch-spec --json` and absent from a Cooptimize clash).

**B1 is skipped (Aaron, 2026-09-30).** Revision 2.0's isolated beta channel is
the right design for a fleet too large to reach by hand. Coop's fleet is seven
people: release-tag updates (H5), the development VM as the qualification machine
(Phase 3), and a rollback that is "check out the previous tag" cover it. The B1
proposal in [PR 72](https://github.com/kabukisensei/coop-agent/pull/72) stays as
documentation; nothing from it is built unless the fleet outgrows this.

**N1 — automatic session naming (scheduled, revision 3.8).** Coop today shows a
session name in the footer and terminal title only when the user sets one with
Pi's `/name`. `@xl0/pi-lovely-rename` (0.1.5 at the September 19 review) names an
unnamed session after a configurable number of user turns (default three), keeps a
manual `/rename`, and uses the current model and provider, so it needs no separate
key. The [package-fit review](history/COOP_PACKAGE_FIT_REVIEW.md) flagged that its
naming prompt sends user and assistant text plus serialized tool-call arguments
(up to 60,000 characters), a larger surface than a title needs on client data.
Aaron scheduled it on 2026-09-30 as its own row after U1. One PR: trial the
upstream package first, pinned in `config/release-manifest.json` like every other
extension, on the development VM; build the minimal coop-owned version in
`extensions/coop-powerline` only if the upstream package misbehaves or its prompt
scope is unacceptable (then: a short summary without raw tool arguments or
secrets, manual names kept, quiet failure when naming is unavailable). Acceptance
per the review: manual names win, switching or forking a session while a naming
response is pending never renames the wrong session, cancellation, offline and
auth failure, repeated triggers, Unicode titles, profile isolation, model changes;
the footer and terminal title pick up the new name without a restart.
Read on 2026-10-01 from the published 0.1.5 source before pinning it: the naming
request goes to the session's current model and provider with the session's own
auth, so it adds no new recipient; what it adds is a second copy of the last
60,000 characters (user text, assistant text, tool names with their JSON
arguments) in one request per unnamed session. Manual names win (it only names
sessions with no name), the settings file lives in the isolated agent dir
(`~/.coop/agent/xl0-pi-lovely-rename.json`), and the extension depends only on
`@xl0/pi-lovely-config`. The VM trial decides whether that scope stays.

**Then, each only when Aaron asks, each independently revertible:**

- **PK1** package-fit trials (redacted diagnostics, scoped simplify, and
  `pi-lovely-codex`; session naming moved to N1) per the package-fit review in
  [PR 72](https://github.com/kabukisensei/coop-agent/pull/72), GPT subscription
  only. **Scope change:** evaluate `pi-lovely-codex` as a whole, not `apply_patch`
  alone, because Aaron wants the usage stats `pi-better-openai` provides and the
  Codex extension may supply them together with how tool calls are made.
  **Revision 3.5 finding (npm metadata and README, not yet run):** the package is
  `@xl0/pi-lovely-codex` (0.2.3, Sep 16; the unscoped name does not exist). Its
  README covers GPT fast mode and the Codex-style `apply_patch` tool only, with no
  usage-stat display, so it cannot be the sole owner of the 5h/7d windows.
  `@narumitw/pi-usage` (0.61.1, Sep 24, MIT, 40 releases) shows provider usage
  with Codex reset countdowns in the status line and has its own fast-mode toggle,
  so it is the candidate for the stats half. The trial therefore compares
  `pi-better-openai` + stock Pi tools against `@xl0/pi-lovely-codex` (tool calls)
  plus the stats owner that wins (`pi-better-openai` or `@narumitw/pi-usage`). All
  three toggle GPT fast mode, so the trial also names its one owner. On the
  development VM, measure: the 5h/7d usage windows reach the Coop footer;
  every tool call it makes still passes through the guardrail hooks (the fit
  review found its patch path needs every touched path authorized); cancellation
  reaches the child process; patch text is not exposed in process arguments; it
  works on the team's Codex subscription without a separate key. Whichever wins
  becomes the one owner of usage stats; the other is removed.
- **J0–J3 Jev** shadow experiments on synthetic material, advisory only. Waits
  (Aaron, 2026-09-30); its revision 2.0 gates are unchanged.

The controls in revision 2.0 sections 8 and 9 (data approval, secrets, authority,
cost caps, stop conditions) are unchanged.

## 11. Phase 8 — Electron desktop, installable on other users' machines

Revision 2.0 removed Desktop and reserved a native Windows rewrite for last. Aaron
wants the Electron desktop back, later, with one hard requirement: **another user
installs it without a terminal, Node, or Python knowledge**. That changes the
gate, not the order; it stays last.

- **Entry gate:** the terminal product is simplified (Phase 2), dependencies are
  reconciled (Phase 3), and the first-run workflows exist (Phase 6). The desktop
  reuses the shared launch spec and the same guardrails, skills, prompts, and
  profile; it must never carry a second policy implementation.
- **Reference, not merge:** the ten `feature/coop-desktop-*` and
  `desktop/candidate-2026-09-20` branches and `docs/history/ui-strategy.md` are design
  evidence. Salvage after review; do not merge wholesale.
- **Packaging is the project:** a signed Windows installer (MSIX or a Squirrel/NSIS
  package via electron-builder) that bundles Node, installs or reuses Pi in the
  coop profile, checks the same prerequisite table as H1 for Python, Azure CLI, and
  ODBC, and updates through the same channel logic as the terminal. No custom
  updater beyond what the packager provides.
- **Decision to record before starting:** a native rewrite (WinUI/WPF) is off the
  roadmap; "Coop 2.0" means this packaged Electron app.

### 11.1 D1 scoped into rows (revision 3.11, read-only, October 2, 2026)

Scoped from the tree at v0.26.0 and the old desktop branches; no app code was
written and nothing was installed. D1 stays one register row (16) worked as seven
sub-rows, D1a–D1g (plus the optional D1b2 added in revision 3.13), one issue,
one branch and one PR each, in this order. **No
sub-row starts until Aaron starts D1 explicitly** (section 14). Aaron decided on
2026-10-02 that signing is not required for done and that the other 11.3 items
are decided when the row that needs them starts, not up front. He also said the
app is **internal only**: the seven teammates, never anyone outside, and it does
not need to look official. So nothing in D1 serves a public download: no
publisher reputation, no public release repository, no store identity; a
teammate signed in to GitHub downloading an unsigned installer from the
repository's release page is an acceptable floor. Rows 7–12 and 15 accepted, and U2 landed, stay
the entry gate for the packaged rows (D1c onward): the package ships the Pi that
coop ships, so the Pi pin must be settled first (section 6.5). D1b needs only the
terminal product as it is.

**Why the last attempt stalled (read from the branches, September 7–12, 2026).**
The `desktop/candidate-2026-09-20` line built a whole platform before it had an
installer: a `coop runtime` HTTP contract and parity schemas, a managed runtime
that staged its own Node, a relocatable CPython 3.12 with per-tool hash locks and
development wheels, a custom Ed25519-signed update service with rollback, and a
renderer with workspace leases and three themes. Packaging (REL-001), signing and
updating (REL-002) were the last phase (Phase G of its plan) and became gates on
all of that at once. Its own frontier note records what stayed open: "Windows
clean-machine execution, fully locked transitive dependency acquisition, signed
installers, and updater/rollback remain open release gates", and the updater
"accepts no placeholder trust key or unsigned fallback", so without a production
certificate and a hosted key nothing could ship. Windows validation then cost
seven `feature/coop-desktop-windows-validation-*` branches of PowerShell 5.1
bootstrap and `Start-Job` diagnostics ("Defect D") because the managed runtime
launched coop through its own dispatcher instead of the shortcut path that already
worked. The lesson for D1: the window and the installer are separate deliverables,
the first one needs no installer and no certificate, and signing is the last row,
not a gate on the others. Aaron confirmed on 2026-10-02 that starting the app from
the terminal is acceptable.

**What the codebase already gives D1.**

- `coop launch-spec --json` (`Invoke-CoopLaunchSpec` in `bin/coop.ps1`) emits
  `{bin, args, env}` from the same `Build-CoopPiArgs` the terminal uses: guardrails
  system prompt, skills (first-party, Microsoft catalog, team knowledge), prompts,
  theme, the four extensions, isolation env. It was written for the desktop and
  is tested against drift. The app consumes it; it never builds Pi arguments.
- `Get-CoopPrereqs` in `lib/common.ps1` is the H1 prerequisite table (Git, Node,
  Python 3.10–3.13, pipx, Azure CLI, ODBC 18, each with its `winget` fix) that
  `coop install` and `coop doctor` share. The app shows the same rows and text.
- `config/release-manifest.json` plus `config/extensions-lock.json` define the
  exact Pi and extension tree (`npm ci`, `gypfile: false`), so a build can
  pre-install that tree offline and byte-compare it with what `coop sync` makes.
- `coop update` follows release tags only (H5); `--edge` is maintainers'. The app
  follows the same tags: through `coop update` while it is a coop command (D1b),
  through the packager's updater once it is a package (D1e).
- `bin/coop-desktop.ps1` and the Start Menu/Desktop shortcut are the current
  "double-click" path (phase 1 in `docs/history/ui-strategy.md`); D1 adds a window
  next to it and leaves the terminal install unchanged.

**Shape the rows assume (decided by Aaron, 2026-10-02; 11.3 item 1).** The window
is a rendered, modern UI in the spirit of the Codex app, PiChamber and Supernova,
with **every capability of the terminal**, and four themes: Modern Dark, Modern
Light, and Retro Dark and Retro Light in the Windows 95/98 style of the coop
website. Electron's main process spawns `pi --mode rpc` with the `{bin, args,
env}` from `coop launch-spec --json` (D1b found the trust flag
`docs/history/ui-strategy.md` required, `-a`, no longer needed: coop's policy
arrives as `-e` and `--skill` arguments and its isolated agent dir, not as
project files; revision 3.14), and the renderer draws Pi's event stream. Revision 3.11 judged
this the expensive option because every extension dialog would need a second
implementation; the D1a review found that wrong for coop. Pi's RPC extension UI
protocol (`docs/rpc-extension-ui.md` in Pi 0.87.1) carries `select`, `confirm`,
`input`, `editor`, `notify`, `setStatus`, `setWidget` and `setTitle`, and
coop's own extensions use only those for every approval prompt, the `/start`
menu, `/setup-project` and `/setup-docs`. `@juicesharp/rpiv-ask-user-question`
2.12.0 has its own RPC path (sequential `select`/`input` dialogs instead of its
tabbed overlay). So the app renders four generic dialogs once, never one per
extension, and policy stays in the extensions. What RPC does not carry is
cosmetic or rare: the coop-powerline footer and splash (`setFooter`,
`setHeader` and `setWorkingMessage` are no-ops; the app draws its own status
bar from `setStatus` and session state), `custom()` TUI components, and the
first-run model sign-in, which is TUI-only today and runs through a terminal
handoff. This shape also removes 3.11's biggest risk: no `node-pty` native
module and no `xterm.js`.

**Parity rule (Aaron, 2026-10-02: "it must maintain all the capabilities of the
terminal").** Pi's RPC commands cover prompting, steering and follow-up
queues, abort, models and thinking levels, compaction, `!` bash, session stats,
export, switch, fork, clone and tree, session names and the extension, prompt
and skill command list (`docs/rpc-commands.md`). Pi's built-in slash commands
and keybindings are TUI features, so the app maps each one itself. D1b ships a
parity table, one row per Pi built-in command, keybinding action and coop
command or flag a user reaches in a session, each mapped to an RPC command, a
rendered control, or "Open in terminal" on the same session (`/login` and
anything drawn with `custom()`). A row with no mapping fails D1b. Every
enhancement is added on top of that and never replaces a terminal path.

### 11.2 The rows

| Row | Package | Scope | Starts after | Done when |
| --- | --- | --- | --- | --- |
| D1a | Decision record and salvage review (docs only) | Record the 11.3 defaults as a plan revision (each item is confirmed by Aaron when its row starts); review the old branches and list what is salvaged (the sandboxed-renderer and Electron fuse settings in `desktop/package.json`, the NSIS block in `electron-builder-installer.cjs` (per-user, no elevation, keep app data), the `coop-launcher.mjs` PowerShell dispatcher resolution, the idea of `verify-windows-installer.mjs`) and what is not (the managed-runtime staging and lock system, bundled Python, the parity and release-evidence schemas, the `coop runtime` HTTP contract, the Ed25519 update service, the Tauri spike); choose the repo location (`desktop/` in coop-agent, recommended, so the app and coop share one tag and one CI) | D1 started by Aaron | plan revision merged with every 11.3 item answered; salvage list closed; no app code |
| D1b | `coop desktop`: the rendered window, started from the terminal product | **The first deliverable; needs no installer, no bundled runtime and no certificate.** `desktop/` holds an Electron main process that spawns `pi --mode rpc` with the `{bin,args,env}` from `coop launch-spec --json` plus `--mode rpc` (never `-a`: the window loads exactly what the terminal loads, and a work repo's `.pi` files only after a saved `/trust` decision, the way Pi treats every non-interactive mode; the app adds nothing else to args and only the profile path to env), frames Pi's JSONL with a `\n`-only splitter, and builds every RPC command field by field; the renderer is sandboxed (context isolation on, Node integration off, navigation and new windows blocked, named preload methods only) and talks to the main process over IPC, with no listening port. The renderer has terminal parity: a streaming timeline (messages, thinking, tool calls with collapsible output, file edits as diffs), a composer with slash-command completion from `get_commands`, model and thinking pickers, session list, resume and new session, the four generic extension dialogs (`select`, `confirm`, `input`, `editor`) plus `notify` toasts, `setWidget` lines and a status bar built from `setStatus` and session stats, and the four themes (Modern Dark, Modern Light, Retro Dark, Retro Light) switched without a reload; anything RPC cannot show (model sign-in, a `custom()` component) opens the same session in a terminal window, and every session has an "Open in terminal" action; the parity table (section 11.1) lives in `desktop/PARITY.md` and a test checks it against Pi's command list. `electron` is pinned in `config/release-manifest.json` (`desktop.electron`) with its own lockfile, `config/desktop-lock.json`, and installs with `npm ci --ignore-scripts` plus Electron's own `install.js` (which checks the binary against the `checksums.json` inside the locked package) into its own tree, `<profile>\desktop\runtime`, on the first `coop desktop`, so only machines that use the window download it; `coop sync` refreshes that tree where it exists and `coop uninstall` removes it; `coop desktop` (new command in `bin/coop.ps1`) runs the same preflight as `coop` and starts the window; the first `coop desktop` adds a second shortcut, "coop (window)", next to the terminal one, and `coop update` refreshes it where present. Window close ends Pi and its children cleanly; unit tests for the spec consumer, the JSONL framing, the dialog round trip and event rendering from a recorded RPC fixture run in the gate lane on `windows-latest`; `coop doctor` reports the Electron pin | D1a; Aaron starts it | on a machine with coop installed, `coop desktop` opens a governed session that matches the terminal (guardrails prompt, `/start` menu, an approval prompt, an ask-user question, a model switch, resume) in all four themes, and the parity table has no unmapped row; the spawned command equals `coop launch-spec --json` plus `--mode rpc`; VM: the first `coop desktop` installs the pin from the lock, `coop sync` keeps it current, the shortcut works, the fleet gets it through `coop update` at the next tag |
| D1b2 | Panes and richer views | Read-only panes beside the timeline, each a view over something coop already has, never a second policy path. **Asked for by Aaron (2026-10-02):** a changes panel (working-tree diff, unified or side by side, opened from any file edit in the timeline) and a standards pane (the active coop-standards articles for the current folder, read through `lib/standards-cli.mjs resolve-many` so it shows exactly what coop resolves: the wiki's `main`, last-known-good or the bundled copy, plus `.coop/project.yml` overrides; source and freshness from `standards-cli.mjs status`; rendered Markdown with search), a project form (a form for `.coop/project.yml`, section 11.6, saved through the `/setup-project` writer), and a docs setup form (`/setup-docs` as a form, written by coop-data-doc itself). **Proposed, Aaron picks** (section 11.6): lineage pane, approval cards, command palette and file mentions, status bar, session sidebar, background notifications, health pane. **Second batch, asked for by Aaron (2026-10-02):** file attachments (images, text, Word, Excel, PowerPoint, PDF; documents read to Markdown and referenced by path, pdf.js pinned as the runtime's second package), every pane draggable, the Cooptimize splash and vibes in the window, and a concise activity view (thinking and tool calls between replies folded into one expandable line, the session log untouched) | D1b | each pane opens from the timeline and a menu in all four themes and is tested from a fixture; only the two forms write, and only through the existing writers (the project form: unowned fields kept, backup written, round-trip test with `/setup-project`; the docs form: `coop-data-doc` writes `coop-data-doc.yml`, same file as `/setup-docs` for the same answers); the parity table is unchanged |
| D1c | Unsigned installer of the window alone | electron-builder NSIS **per-user** target (no administrator), Start Menu and Desktop shortcuts with `themes/coop.ico`, Add/Remove entry, silent `/S` install and uninstall, `deleteAppDataOnUninstall: false`; the package still **requires the terminal coop** (it finds `coop.ps1` the way `bin/coop-desktop.ps1` does and runs `coop install` when missing); a `windows-latest` CI job builds the unsigned installer on every PR as an artifact, installs it silently, launches to `coop doctor` and uninstalls. This row proves the exe, NSIS and CI pipeline on its own, which is where the last attempt stalled | D1b | CI job green; manual install, launch, uninstall on the "stable" VM snapshot leaves no trace outside `~/.coop` and the app folder; SmartScreen's "unknown publisher" step recorded (it is one click, not a block). **Status (revision 3.17):** built; `desktop/installer/electron-builder.cjs`, `desktop/scripts/build-installer.mjs`, `desktop/scripts/verify-installer.mjs`, `desktop/lib/bootstrap.mjs` and `coop desktop --app <exe>`; the CI job runs on every PR and the release workflow attaches the installer to each GitHub Release (Aaron, 2026-10-02: the release page is where teammates get it) after the same acceptance has passed on the release build itself, with the report attached (#277, Aaron 2026-10-03); the VM acceptance on the "stable" snapshot is open |
| D1d | Bundled runtime: no terminal, Node or Python knowledge | The build stages a pinned Node (nodejs.org zip, version and SHA-256 in the manifest), the pinned Pi and the `extensions-lock.json` tree pre-installed offline, and a snapshot of this repository (skills, prompts, extensions, `docs/guardrails.md`, standards bundle) under the app's resources; the app uses the same profile root as the terminal (S3) so the two coexist and share sessions, memory and `.coop/project.yml`; first launch runs the H1 table for Git, Python, pipx, Azure CLI and ODBC in the window, prints the exact `winget` lines (or runs them visibly, as `coop install --prereqs auto` does), then the same sync and Azure sign-in the terminal install runs; Node is never a prerequisite for the package. Python and Azure CLI stay prerequisites, not bundled (the last attempt's relocatable Python is not revived) | D1c (U2 is not a gate, section 11.7, revision 3.18; Aaron 2026-10-03: one install is next) | blank VM snapshot: install, launch, the prerequisite screen names exactly what is missing, after the printed commands `coop doctor` inside the app is all green; `npm ls --all` of the staged tree equals a clean `coop sync` tree. **Status (revision 3.19):** built; `desktop/scripts/build-installer.mjs` stages `resources\runtime` (Node, the Pi prefix, the lock tree, `coop-runtime.json`) and `resources\coop` (the snapshot), `lib/common.ps1` detects the bundle, the first `coop desktop` runs the install in its console (the window's own prerequisite screen is D1h's health pane), the CI job checks every pin, runs the bundled `coop version`, checks that PowerShell's `& npm` reaches the bundled `npm.cmd`, that every path fits Windows' limit and that the uninstaller drops the first launch's `coop` link and shortcuts; **accepted 2026-10-03 on the VM sandbox** (fresh profile: install 9.8 min, 862 MB; the first launch runs the whole checklist on the bundled Node and opens the window with its set-up card; `coop doctor` names the bundled Node and Pi, every extension seeded from the package; uninstall leaves only `~/.coop`; over an existing terminal install its `coop` link, shortcut and `~/.coop` survive install and uninstall). Known limit: an install dir longer than about 62 characters puts three AWS SDK files at the 260-character path limit, which the uninstaller then leaves behind; the per-user default stays under it for user names up to about 24 characters |
| D1e | Updates and distribution | **First deliverable: the in-app update notice** (one line in the window when the installed version is behind the newest tag, with the release page link; Aaron 2026-10-03). The installer is published as an asset of the GitHub Release `release.yml` already creates on a tag; internal only (Aaron, 2026-10-02), so teammates download it signed in and the floor is "install the new installer over the old one" (NSIS per-user upgrades in place and keeps `~/.coop`), with the app showing one line when the installed version is behind the newest tag. `electron-updater` (GitHub provider, release tags only, download in the background, install on quit) is added only if it works without putting a token in the app, which on a private repository it does not; otherwise the in-app notice plus reinstall is the row. The staged Pi and extension tree move with the app version, so no npm runs on the user's machine for an update. Works unsigned | D1d; distribution choice (11.3 item 4) | VM installs vN; vN+1 tagged; the app offers, downloads and applies it; `~/.coop` sessions, memory and project contract intact; `coop doctor` green after the update |
| D1f | Signing | Sign the installer and the app binaries on tag in `release.yml` with the certificate Aaron supplies (11.3 item 3); record the SmartScreen result and the publisher name teammates see. Last, because every earlier row works unsigned; this row removes the "unknown publisher" click, it does not gate the others | D1e; Aaron's certificate; optional, not part of row 16's done (Aaron, 2026-10-02) | a teammate downloads the release asset and Windows shows the publisher name with no SmartScreen "unknown publisher" step; `electron-updater` verifies the signed update |
| D1g | Teammate acceptance and docs | One teammate who is not Aaron installs from the package alone on a machine without coop, Node or Python, following only `docs/install-windows.md`'s new "Desktop app" section (the terminal path stays the first section, unchanged); README, architecture and coop-website pages updated; the old desktop branches deleted after Aaron confirms | D1e (signing is not required: Aaron, 2026-10-02) | the teammate reaches a governed session and runs one workflow from the `/start` menu with no help; row 16 moves to `done (tag)` when Aaron tags |

Rules that hold across every row, on top of section 2:

- The app never carries policy. Guardrails, approvals, standards, skills and the
  profile come from coop and the launch spec. A desktop-only setting, environment
  variable or schema needs the same justification as any other new abstraction
  (section 2).
- Each row ships on its own and is useful on its own: D1b is on the fleet through
  `coop update` before any installer exists; D1c is a real installer before any
  runtime is bundled; nothing waits on a certificate.
- Windows x64 only. No macOS build, no ARM build, no per-machine install.
- One Pi. The app runs the manifest's Pi pin, never a second copy for the
  terminal; a machine with both installs shares the profile root and the Pi
  the manifest names.
- CI builds the package on every PR from D1c; signing happens only on a tag Aaron
  pushed, and only from D1f.
- The VM gates acceptance, not the start of work (section 14): rows begin on green
  CI; D1b and D1c are accepted on the "stable" snapshot, D1d–D1g on "blank".

**Risks named now.** RPC mode is Pi's contract with clients, but a Pi upgrade
(U2, Pi 1.0) can change event or command shapes; D1b's recorded RPC fixture
test is the tripwire, and U2 re-records it. A third-party extension that relies
on `custom()` without an RPC fallback shows nothing in the window; D1b lists the
pinned extensions' RPC behavior and opens the session in a terminal for any gap.
The runtime's npm install downloads about 150 MB (Electron and pdf.js) and
unpacks to about 400 MB in the window's runtime tree on each machine that runs
`coop desktop`; the lockfile carries each package's integrity and Electron
carries the binary's checksums. An OV
certificate earns SmartScreen reputation over downloads rather than instantly;
D1f records what the first teammate sees.

### 11.3 Decisions only Aaron can make

Aaron, 2026-10-02: items 1 (a rendered UI) and 8 (signing is not required for
done) are decided; items 2–7 are decided "when needed", so each is asked at the start of the row that
needs it (noted per item) and the recommendation is the default until then.
Section 11.5 records the answer or default for every item (D1a, revision 3.13).

1. **Decided (Aaron, 2026-10-02): a rendered, modern UI** with all the
   terminal's capabilities and four themes (Modern Dark, Modern Light, Retro
   Dark, Retro Light in the coop website's Windows 95/98 style), not Pi's
   terminal in a window. Section 11.1 records why this is cheaper than 3.11
   assumed.
2. **(D1c)** **Installer type:** **Decided with D1c (revision 3.17): NSIS per-user
   via electron-builder**, as recommended (no administrator, works unsigned and
   with any code-signing certificate, Add/Remove entry, `electron-updater`
   support); the alternative was MSIX (Store-style identity, needs the
   certificate's subject to match the package publisher, sideloading settings on
   some machines, no unsigned path).
3. **(D1f)** **Code-signing certificate.** Not required (Aaron, 2026-10-02:
   internal only, not official); D1f exists only if Aaron later wants the
   SmartScreen click gone. Aaron owns this input and nothing before D1f waits on
   it. Options: Azure Trusted Signing (a subscription resource, signs
   from GitHub Actions with no hardware token, the recommendation), an OV
   certificate on a cloud HSM, or an EV certificate with a hardware token (instant
   SmartScreen reputation but cannot sign from CI without extra setup). To supply:
   the signing account or certificate, and a repository secret or OIDC federation
   for `release.yml`.
4. **(D1e)** **Where the package is published.** Internal only (Aaron,
   2026-10-02), so the default is the release page of `kabukisensei/coop-agent`
   itself, downloaded by a signed-in teammate, with no public copy anywhere. A
   silent in-app updater needs token-free assets; if Aaron wants one, the choice
   is a public release repository for the installer alone or the coop website's
   VPS with the generic provider. Recommendation: release page plus reinstall;
   no public assets.
5. **(D1a)** **Repository location:** `desktop/` in coop-agent (recommended: one tag, one
   CI, the package snapshots the repo it lives in) or a separate `coop-desktop`
   repository.
6. **(D1d)** **Git on the user's machine.** The standards wiki and team knowledge are git
   clones. Keep Git in the prerequisite table (one more `winget` line, the
   recommendation) or bundle a portable MinGit (about 50 MB, another pin to
   track).
7. **(D1g)** **Which teammate** does the D1g acceptance, and whether a second blank VM
   snapshot ("desktop-blank") is kept next to the existing blank and stable ones.
8. **Decided (Aaron, 2026-10-02): signing is not required.** Row 16's done-when
   is "another user installs from the package alone"; an unsigned per-user
   installer meets it with one SmartScreen click. D1g accepts on D1e; D1f follows
   only if and when a certificate exists, and never blocks the row.

### 11.4 Out of scope for D1

Side-by-side agent threads and worktrees, scheduled tasks, remote or mobile
access to a session (planned separately in section 12.4), macOS and ARM packages, a per-machine install,
bundled Python or Azure CLI, a beta or edge channel in the app, Power BI Desktop
automation beyond what the terminal already does, and any change to the terminal
product's install, update or profile layout. The old branches' managed-runtime
platform (staged Python, parity schemas, the `coop runtime` HTTP contract, the
Ed25519 update service) is not revived; the one Pi and one profile root rule from
Phase 2 holds.

### 11.5 D1a: decision record and salvage list (revision 3.13, October 2, 2026)

Docs only; no app code. D1a is the one D1 row that needs no start beyond this
record, because it writes nothing but the plan. D1b and every later row still
wait for Aaron's explicit start (section 14); on 2026-10-02 Aaron chose to land
this record only and not to start D1b yet.

**Decision record.** What Aaron has said, and the default for everything else.
Each default holds until the row named in brackets starts, when Aaron confirms
or changes it; a changed default is a plan revision in that row's PR.

| 11.3 item | Row | Answer | Source |
| --- | --- | --- | --- |
| Launch | D1b | Starting the window from the terminal product (`coop desktop`, a shortcut next to the terminal one) is fine; no installer is needed first | Aaron, 2026-10-02 |
| 8 Signing | D1f | Not required for done; D1f is optional and blocks nothing | Aaron, 2026-10-02 |
| Audience | all | Internal only: the seven teammates, nothing official, no public download, store identity or publisher reputation | Aaron, 2026-10-02 |
| 1 Window shape | D1b | A rendered, modern UI with every terminal capability (like the Codex app, PiChamber, Supernova), over `pi --mode rpc`; four themes: Modern Dark, Modern Light, Retro Dark, Retro Light (Windows 95/98, like the coop website) | Aaron, 2026-10-02 |
| Build or fork | D1b | Coop builds its own renderer and borrows UX patterns. pi-gui, PiChamber and Supernova (all MIT) embed Pi in-process through the SDK, which would add a second Pi and a second way to load coop's policy | Aaron, 2026-10-02 |
| 2 Installer type | D1c | Default: NSIS per-user via electron-builder, no administrator | recommendation |
| 3 Certificate | D1f | None; Azure Trusted Signing is the default only if Aaron later wants the SmartScreen click gone | follows item 8 |
| 4 Distribution | D1e | Default: the release page of `kabukisensei/coop-agent`, downloaded by a signed-in teammate; reinstall over the old version is the update path, with a one-line in-app notice when behind | recommendation, follows the audience |
| 5 Repository | D1a | Default: `desktop/` in coop-agent, so the app and coop share one tag, one CI and one lockfile | recommendation; Aaron may still move it before D1b writes code |
| 6 Git | D1d | Default: Git stays a prerequisite in the H1 table (one more `winget` line); no bundled MinGit | recommendation |
| 7 Acceptance | D1g | Default: Aaron names the teammate when D1g starts; a "desktop-blank" VM snapshot is kept only if D1d needs a second blank machine | recommendation |

**What the review found.** The September line was already a rendered app: the
Coop Web single-page app (vanilla JavaScript, no build step) in an Electron
shell, talking to a `coop runtime` HTTP server that wrapped `pi --mode rpc`, with
three themes (Modern Dark, Modern Light and a "Retro Messenger" variant). With
Aaron's choice of a rendered UI, its renderer pieces are now worth reading
closely; its server, contracts and managed runtime are still the part that
stalled it. Paths below are on `desktop/candidate-2026-09-20` (head `ed516b2`,
September 13) unless a branch is named; `feature/coop-desktop-windows-validation-gui`
is at `0f96d2e`. The other eight `feature/coop-desktop-*` branches add
validation fixes, diagnostics and handoff notes for the parts left behind
below, and nothing to salvage. Salvage means copying the idea or a few reviewed
lines into the new `desktop/`, never merging a branch.

**Salvage: reuse in D1b.**

- *Renderer hardening* (`desktop/src/main.mjs`): the `BrowserWindow`
  `webPreferences` block (sandbox, context isolation, no Node integration in the
  renderer or workers, web security on, no insecure content, no experimental
  features), the deny-all permission request, permission check and device
  handlers, `setWindowOpenHandler` returning deny, the `will-navigate` guard, and
  `safeExternalUrl` with a confirm dialog (http or https only, no embedded
  credentials, 2048 characters at most) for links Pi prints. This is D1b's
  "renderer sandboxed" scope, already written and reviewed once.
- *Finding coop* (`desktop/src/coop-launcher.mjs`, `resolveCoopLauncher`): PATH
  and PATHEXT lookup that skips relative PATH entries, `coop.cmd` resolved to its
  `coop.ps1`, `pwsh` then `powershell` with `-NoProfile -ExecutionPolicy Bypass
  -File`, and refusal of relative or control-character paths. D1b uses it to run
  `coop launch-spec --json`; drop the macOS and Linux branches.
- *Ending the process tree* (`desktop/src/runtime-supervisor.mjs`,
  `terminateWindowsRuntimeTree`): `taskkill /PID <pid> /T /F` from `SystemRoot`
  with a timeout, then wait for the pipes to close. D1b's "window close ends Pi
  cleanly" needs this after closing Pi's stdin, because Pi starts MCP servers
  and other children that killing Pi alone can leave running.
- *Preload shape* (`desktop/src/preload.cjs`): a frozen `contextBridge` object of
  named methods. Keep the pattern, not the methods: D1b's preload exposes only
  what the renderer needs (send a command, receive events, answer a dialog,
  read and set the theme).
- *Strict RPC commands* (`web/rpc-adapter.mjs`): renderer input is untrusted, so
  each Pi command is built field by field with allowlists (thinking levels,
  queue modes, image types and size limits) and an unknown slash command never
  becomes a prompt. Re-check the field names against Pi 0.87.1's
  `docs/rpc-commands.md`; the file was written for 0.84.3.
- *Transcript replay* (`web/transcript-replay.mjs`, `projectTranscriptMessages`):
  rebuilds a resumed session's timeline from Pi's messages, pairing tool results
  with their calls and clipping thinking and output. D1b's resume.
- *Theme system* (`web/public/theme-system.js` and the token layer of
  `web/public/style.css`): one DOM, an allowlist of theme ids, a
  `data-theme` attribute, semantic tokens for surface, text, accent, type,
  radius and elevation, WCAG AA contrast checks, reduced-motion and
  forced-colors rules. Keep the mechanism and the two Modern palettes; replace
  Retro Messenger with Retro Dark and Retro Light built from the coop website's
  `css/styles.css` tokens (the dark Win98 desktop and the `[data-theme="light"]`
  classic silver, each text token already measured against WCAG AA).
- *Model sign-in handoff* (`desktop/src/native-terminal.mjs`, the Windows
  `windowsConsoleProcess` path and `buildNativeModelLoginProcess`): opens a real
  console for the TUI-only sign-in, passing paths only through environment
  variables. D1b's handoff for sign-in and for anything `custom()` would draw;
  drop the macOS and Linux branches and the clone and move modes.

**Salvage: reuse in D1b2, D1c and D1d.**

- *Diff view* (`web/public/diff.js` and `diffview.js`): a DOM-free unified-diff
  model (pairing, intraline emphasis, split rows) and a read-only changes panel,
  unified or side by side. D1b2's changes panel; D1b's inline edit diffs can use
  the model alone.

- *Electron fuses* (`desktop/package.json`, `build.electronFuses`): run-as-node
  off, `NODE_OPTIONS` and inspect arguments off, embedded asar integrity on, load
  the app only from asar, no extra `file:` privileges. Fuses apply to a packaged
  app, so they start in D1c (D1b runs Electron from its runtime tree).
- *NSIS options* (`desktop/electron-builder-installer.cjs`): `perMachine: false`,
  `allowElevation: false`, `oneClick: false`, `deleteAppDataOnUninstall: false`,
  `runAfterFinish: false`, `themes/coop.ico` for installer and uninstaller, and
  the `Coop-Desktop-${version}-${os}-${arch}` artifact name. Drop the macOS
  `dmg` block and the managed-runtime config it extends. D1c.
- *Installer acceptance* (`desktop/scripts/verify-windows-installer.mjs`):
  `assertDisposableInstallerHost` (the mutating test runs only on a GitHub-hosted
  runner with an explicit opt-in variable), `buildNsisInvocation` (`/S
  /currentuser`, then `/D=` or `_?=` last and unquoted, as NSIS requires), the
  bounded `runOwnedCommand` and the Add/Remove registry check. Drop its
  managed-package and native-health imports. D1c's CI job.
- *Long-path uninstall* (`desktop/build/windows-uninstall.nsh` and
  `desktop/scripts/verify-nsis-long-paths.mjs` on
  `feature/coop-desktop-windows-validation-gui`): electron-builder's uninstaller
  moves the old install into a temporary folder during an upgrade, where a deep
  npm tree passes 260 characters and the upgrade fails with exit code 2. The hook
  uses extended paths and refuses junctions. Not needed for D1c's window-only
  package; D1d needs it as soon as the Pi and extension tree is staged.
- *Footprint baseline* (`docs/adr/desktop-shell-spike-results.md`): Electron
  44.2.0 measured 373 MB unpacked on Windows and about 516 MiB idle memory on
  macOS. Use it as the expectation D1c and D1d record against; the Tauri result
  in the same file is not pursued (section 11.4).

**Leave behind.** None of this is copied or revived:

- the managed runtime: `desktop/src/managed-runtime.mjs`, `managed-profile.mjs`,
  `dependency-inventory.mjs`, `development-wheels.mjs`,
  `scripts/prepare-managed-runtime.mjs`, `stage-managed-runtime.mjs`,
  `verify-managed-runtime.mjs`, `managed-runtime-build-plan.mjs`,
  `config/managed-runtime*.json` and `desktop/electron-builder-managed.cjs`
  (staged Node and relocatable Python with hash locks; D1d stages Node and the
  `extensions-lock.json` tree instead, and Python stays a prerequisite);
- the contracts and evidence: `config/desktop-parity*.json`,
  `config/desktop-release-*.json`, `config/desktop-update*.json`,
  `config/runtime-event.schema.json`, `scripts/desktop-release-gate.mjs` and
  `docs/desktop-extension-contracts.md`;
- the `coop runtime` HTTP server and its clients: `web/server.mjs`,
  `web/runtime-*.mjs`, `web/sse-writer.mjs`, the `web/*-service.mjs` modules and
  `lib/rpc-questionnaire.mjs` (on `feature/coop-desktop-windows-validation-interaction`);
  Electron IPC replaces the port, the token and the server-side services, and
  Pi's own dialog protocol replaces the questionnaire bridge;
- the renderer monolith `web/public/app.js` (190 KB, built around that HTTP
  contract and Mission Control) and the Mission Control, findings, lineage,
  knowledge and usage models: D1b writes a smaller renderer around Pi's event
  stream and reuses the pieces listed above;
- the Ed25519 update service: the twenty-two `desktop/src/update-*` files
  (JavaScript, Python and PowerShell) and their trust key and feed (D1e uses
  reinstall, or `electron-updater` only if it needs no token);
- workspace leases and selection, desktop session restoration and HTML export,
  and the terminal clone and move handoffs (`workspace-selection.mjs`,
  `session-*.mjs`, `desktop-state.mjs`, most of `native-terminal.mjs`): the window
  opens in the folder `coop desktop` was started from, and Pi's own session
  list, resume and `/export` cover the rest;
- the Windows validation diagnostics: `desktop/scripts/diagnose-windows-shell.mjs`,
  `electron-builder-windows-validation.cjs`, the "Defect D" `Start-Job` work and
  the `docs/agent/*` notes. Their cause was the managed dispatcher launching coop
  its own way; D1b runs the launch spec coop already emits and tests;
- the Tauri spike (`desktop/spikes/tauri/`), the Electron spike
  (`desktop/spikes/electron/`), the macOS targets, the `managed-desktop-smoke.yml`
  workflow, and the old pins (Electron 44.2.0, electron-builder 26.15.3): D1b pins
  the current releases in `config/release-manifest.json`.

**Branch disposal.** The branches stay until D1g, as 11.2 says. Deleting a
branch makes its commits unreachable, so before D1g deletes them it checks that
every salvaged item above landed in `desktop/` or is no longer wanted; the two
heads named above are the reference until then.

### 11.6 Proposed experience enhancements (revision 3.13)

Aaron is open to any enhancement that makes the experience better while the
window keeps every terminal capability (section 11.1, parity rule). These are
proposals for D1b2 and later; Aaron picks which ones go in. Each is read-only or
reuses an existing coop command, and none moves a decision out of the
extensions. The two forms are the only ones that write, and each writes only through
the code its wizard already uses.

| Enhancement | What the user gets | Built from |
| --- | --- | --- |
| Changes panel | Every file coop edited, as a diff, unified or side by side; click an edit in the timeline to open it (asked for) | `git diff` of the folder; the September `diff.js` model (section 11.5) |
| Standards pane | The standards coop is applying, readable and searchable while it works (asked for) | `lib/standards-cli.mjs resolve-many` and `status` |
| Docs setup form | `/setup-docs` as one panel instead of one dialog per question: the source folders, warehouse and model paths and output location for `coop-data-doc.yml`, prefilled from the existing file and `.coop/project.yml`; after saving, a Build button runs the build with progress and opens the built docs portal in a pane (asked for) | the `coop-data-doc setup --transport jsonl` wizard protocol `/setup-docs` already drives (`runJsonlSetup` in `extensions/coop-tools/index.ts`), so coop-data-doc stays the only writer of its config; the form shows the protocol's prompts as fields, a page at a time when one answer decides the next question. A coop-data-doc change to describe all questions up front is optional, not required |
| Lineage pane | Upstream and downstream of a table, view or measure named in the conversation, as a list or small graph | `data_doc` `lineage` over the built docs; hidden when no docs are built |
| Project form | `.coop/project.yml` as a form instead of a question-by-question wizard: profile, repositories (path, role, branch, commit lists), Fabric and Power BI workspaces and SQL endpoint, the dev SQL target, Tabular Editor and BPA rules, with the wizard's own validation (UUIDs, target kinds). Fields that change what the guardrails allow are marked, using the list in `docs/guardrails-reference.md` (repository paths and commit lists, `sql_targets`, `profile.client`, `fabric.tenant_id`); fields nothing reads (`estate.live_discovery`, the `mcp.*` action lists, dropped in issue #98) are never shown. Save shows the YAML diff first, then writes, and offers a new session so the guardrails load it (asked for) | the `ProjectWizardSettings` shape and `applyProjectWizardSettings`, `renderProjectWizardSettings` and `writeProjectContract` in `extensions/coop-tools/index.ts`, called through one coop entry point (exported or moved to a shared module, never copied), so unowned fields are kept and a backup is written exactly as `/setup-project` does |
| Approval cards (**done, revision 3.18**: `desktop/renderer/dialogs.mjs`) | Guardrail approvals shown as a card with the target, the environment and the exact command or SQL in a code block, instead of a plain yes/no | the `confirm` and `select` text the extension already sends; the decision stays in coop-guardrails |
| Command palette (**done**, D1b) | Ctrl+K lists every slash command, prompt and skill with its description; `@` completes file names; paste or drop images | `get_commands`, Pi's image input |
| Status bar (**done**, D1b) | Model, thinking level, context used, cost, git branch, standards freshness, and coop's status entries, in place of the powerline footer | `get_state`, `get_session_stats`, `setStatus` |
| Session sidebar (**done**, D1b; the fork tree is the `/tree` view) | Named sessions per folder, search, and the fork tree as a list | `switch_session`, `get_tree`, `fork`, `set_session_name`, auto-names from N1 |
| Background notifications (**done, revision 3.18**: `desktop/lib/menu.mjs` `notificationFor`) | A Windows notification when a long turn finishes or an approval is waiting while the window is in the background | Electron notifications on RPC events |
| Health pane (row **D1h**, section 11.7) | `coop doctor` output in the window, with the fix line for each red row | `coop doctor` |

### 11.7 Window experience follow-ups (revision 3.18)

From the desktop UX review of 2026-10-03 (`/mnt/project-files/runbooks/desktop-ux-review-2026-10-03.md`
in the project files; Aaron: "all 6", one install instead of two, the health
pane, the update notice and the integrated terminal). The six first-run items
shipped as one PR (set-up card, first-run Start menu, approval and question
cards, example prompts, background notifications, menu bar; section 11.6
statuses). What follows are rows, each started by Aaron like every other row.

| Row | Package | Scope | Starts after | Done when |
| --- | --- | --- | --- | --- |
| D1h | Health pane | `coop doctor` as a fifth side-pane view: the window runs `coop doctor` (the same `bin/coop.ps1`, read-only) and shows one row per check with its state and, for a red row, the exact fix command with a copy button and, where the fix is a terminal command, an Open in terminal button; the set-up card's items link to it. Nothing is installed or changed from the pane | the six fixes merged | the pane shows the same rows as the terminal's `coop doctor` on the VM, a missing prerequisite's fix line matches the installer's H1 table, and the fixture test replays a recorded doctor run |
| D1i | Integrated terminal pane | A terminal inside the side pane (xterm.js plus a Windows PowerShell child, both pinned in `config/desktop-lock.json` like Electron and pdf.js) that opens the terminal coop on the same session, so `/login`, `/trust`, `/mcp-auth`, `/scoped-models`, session delete and tree labels run without leaving the window; "Open in terminal" and every PARITY.md "terminal" row offer the pane first and the console as before. The pane is a plain terminal: no coop code runs in the renderer | D1h; the xterm.js pin reviewed like every dependency (section 6) | every PARITY.md "terminal" row works inside the pane on the VM in all four themes; closing the pane ends its child; the console path still works |
| D1j | Approvals chip and skills browser | A chip near the model pill showing what coop may do right now (`/coop-approvals status` and the live-read grant) with the revoke actions, and a Skills view in the side pane listing every `/skill:` and prompt from `get_commands` with its description, read-only; both borrowed from the pi-gui family (review, section "pi-gui"); the command palette groups its entries by kind, skills, prompts and tools (Aaron offered it in the demo of 2026-10-05, section 12.3) | D1h | the chip matches `/coop-approvals status` on the VM; the skills view lists what the `/` menu lists |

**D1d as built (revision 3.19).** The package is one download: beside the asar,
`resources\runtime` holds `node\` (the nodejs.org `node-v<version>-win-x64.zip`
the manifest pins in `desktop.node` by version and SHA-256, verified at build),
`npm\` (an npm global prefix with the manifest's Pi and the three Power BI
tools, installed with the bundled Node) and `extensions\` (the agent dir's
`npm` tree installed from `config/extensions-lock.json` with the same `npm ci`
`coop sync` runs, so better-sqlite3's binary matches the bundled Node), named by
`coop-runtime.json`; `resources\coop` is the tracked files of this repository
less tests, `desktop/`, the workflows, `docs/history` and the repo's dotfiles.
There is no second code path: `lib/common.ps1`, run from the snapshot, finds
the runtime folder beside it, puts the bundled Node and prefix first on PATH
and sets npm's global prefix to the bundle, so `pi`, `node`, `npm`, the Pi
entry (`Get-CoopPiEntry`, no npm call), the launch preflight, the pi-ai/pi-tui
alignment and doctor all see the package's copies. The package's `coop desktop`
opens its own `coop.exe` (no runtime tree), and the first launch on a profile
without this release's lock runs `scripts/install.ps1` in the bootstrap
console: the H1 table with its `winget` lines (Node shows as bundled), the
pipx tools and the Fabric CLI, the sync, the Azure and model sign-ins, the
doctor; a failed install keeps the window closed with the lines to act on, and
the next launch runs it again. In the sync, `Restore-CoopBundledExtensions`
copies the bundled tree into `<agent dir>\npm` when the agent dir does not
carry the lock yet and declares each extension in `settings.json` as
`pi install` would (`lib/pi_settings.py ensure-packages`), so no `pi install`
and no npm run happen on the machine; a bundle built for another lock is
ignored and `npm ci` runs as before. `coop doctor` names the package instead of
the "not a git checkout" warning, `coop update` says a newer installer moves
coop-agent, Node and Pi together, and `coop uninstall` leaves the package's Pi
and tools to Add or remove programs. The CI job proves on the runner that the
bundled `node.exe` answers with the pinned version, Pi, the tools and every
extension are at their pins with the shipped lock, and the snapshot's
`coop version` runs the bundled Pi. Decisions: the prerequisite screen is the
install's console, not a rendered page (D1h's health pane brings `coop doctor`
into the window); Git stays a prerequisite (11.3 item 6); the Power BI tools
are staged too, so an app update needs no npm. On a machine that also has the
terminal coop, the profile is shared and the package runs its own snapshot;
when the profile already carries this release's lock nothing is installed.

**D1d and U2 (revision 3.18).** D1d read "U2 landed" because the package ships
the Pi coop ships and the pin was expected to move to 1.0 first. U2 is parked
until `pi-mcp-adapter` accepts `pi-ai` 1.x (section 6.5) with no date, and Aaron
wants one install now, so D1d bundles the manifest's current pin (Pi 0.87.1 and
the `extensions-lock.json` tree, staged offline with the same `npm ci` `coop sync`
runs) and D1e re-stages the tree at every app version, which is also how U2
reaches the package later. The pin stays settled by section 6, not by D1d. The
Node zip and the Pi tree are staged the same way whether or not Pi later drops
its `npm-shrinkwrap.json` (Pi's unreleased changelog), since the lockfile coop
stages is its own. D1d's "Starts after" is now D1c alone.

## 12. Other improvements found in this review

Not requested, offered for Aaron's decision. None is scheduled.

- **Policy fields in the contract are write-only.** `estate.live_discovery`,
  `mcp.*.requires_approval_actions`, and `tests.live_data` are written by the wizards
  but no enforcement code reads them; the guardrails are hard-coded. Decision
  taken: wire them in Phase 5 step 3 (the guardrail scope reads the contract) and
  drop any field that is still unread when Phase 5 closes, so the contract never
  promises what it cannot enforce. Done 2026-10-02 (issue
  [#98](https://github.com/kabukisensei/coop-agent/issues/98)): SQ3 wired `sql_targets`;
  `estate.live_discovery` and the `mcp.*` action lists were dropped; `tests.live_data`
  stays because the workflow skill reads it.
- **`docs/tool-contract.md` drifted** from the code: the reviewer invocation omits
  `--standards`, the sample report uses `rule` where the validator requires
  `rule_id`, and the `details` shape is missing four fields. Fix in Phase 4.
- **`config/standards-registry.schema.json` validated the legacy fixture manifest**,
  not the registry it was named after. Deleted with the fixture seam in #83.
- **Open [PR 72](https://github.com/kabukisensei/coop-agent/pull/72)** (B0 receipt,
  B1 proposal, PK1 fit review) should merge as documentation once its plan-diff is
  rebased on this revision, so the B0 evidence is not lost. It removed the `y0usaf/pi-jev` rows that `main` still carries; keep
  `main`'s rows.
- **Stale branches.** Thirty-nine remote heads, many `tmp/`, `test/`, `wip/`, and
  "DO NOT MERGE" verification branches. Delete the ones whose PR is closed after
  Aaron confirms; they confuse "which branch is the beta".
- **Daily logs reference `E:` and `C:` workstation paths.** Fine as evidence, but the
  plan should not depend on a specific machine's drive letters; B1's E: proposal is
  Aaron's workstation preference, not a product path.

### 12.1 Explore and research: a watch list (revision 3.12)

Things worth knowing about that nobody has scheduled. An entry here is never a
register row: it becomes one only when its "worth adopting when" holds and Aaron
starts it. Each entry is judged on stability, capability, simplicity and
maintainability, the same lens that parked U2 (section 6.5).

**PiG, Pi in Go ([pi-in-go.dev](https://pi-in-go.dev)).** Aaron flagged it on
2026-10-02. Read the same day from its repository
([MichaelKinsy/PiG](https://github.com/MichaelKinsy/PiG), MIT); nothing was
installed.

- **What it is.** A third-party Go port of Pi, shipped as one native `pig` binary,
  that treats Pi's behavior as the contract. It pins Pi **0.87.1**, the Pi coop ships
  today, and checks its core paths against it with paired parity scenarios. First
  release 0.2.0 on 2026-09-25, newest 0.3.1 on 2026-09-30. Its README says the Pi
  maintainers do not endorse it.
- **What it offers.** Pi's TypeScript extension API runs unchanged, extensions can
  also be written in Go, Rust or Python, and the core starts fast without Node.
- **Why not now.**
  - *Stability:* Windows support is a preview (source builds only until its native
    release verification passes), the project is a week old, and its own README says
    edge cases are still hardening. Its 0.3.x changelog is still fixing
    `pi-mcp-adapter` behavior coop depends on (the `/mcp` panel, tool cards, the
    tool list the adapter reads).
  - *Simplicity:* coop's four extensions and its npm extensions (`pi-mcp-adapter`,
    `pi-hermes-memory` and the rest) are Node extensions, and PiG runs Node
    extensions in isolated Node processes. Coop would keep Node and gain a second
    runtime layer, not lose one.
  - *Maintainability:* the names differ (`pig`, `~/.pig/agent`,
    `PIG_CODING_AGENT_DIR`), so the launcher, isolation, `lib/_extdeps.py`
    alignment, doctor and the extension lock would all fork. Coop would also trail Pi
    twice (Pi's release, then PiG's port of it), which works against U2's move to
    Pi 1.0.
  - *Capability:* nothing coop needs is missing from Pi.
- **Worth adopting when all of these hold.** (1) Windows is release-supported with
  native verification. (2) PiG tracks the Pi coop ships (1.0.x once U2 lands) within
  a release or two. (3) Coop's own extension set, including `pi-mcp-adapter` with the
  Azure bearer header and the guardrails' approval prompts, passes the VM matrix
  under `pig` with no coop-side shims. (4) A concrete gain coop can name: a
  materially smaller or simpler D1d bundle, or startup time teammates notice.
  Re-check at U2 or D1d, whichever starts first; until then it stays here.

**Pi Durable (`@earendil-works/pi-durable`).** Aaron asked about it on 2026-10-02
with Pi 1.0.0. Read the same day from npm and the Pi repository
(`packages/durable`, MIT); nothing was installed.

- **What it is.** An experimental library in the Pi monorepo, internally "Pico5",
  published in lockstep with Pi since 0.87.0 and now 1.0.0. It is a crash-safe
  agent harness: every user message, model turn, tool call and compaction is
  committed to local storage (SQLite or JSONL) before it is shown, so a process that
  dies mid-turn resumes where it stopped when the storage is reopened. It brings its
  own extension model (tools, prompt sections, hooks, subagents, a task graph) and a
  state view a UI can subscribe to. Two siblings, `pi-protocol` and `pi-client`, are
  an experimental client and server split over a byte stream. Its README says the
  API changes without notice between releases.
- **Isolation.** Nothing hosted: storage is a local file, and the remote protocol
  is a transport the host runs itself. If coop ever used it, the session store would
  live under `~/.coop` on the client machine.
- **Why not now.**
  - *Simplicity and maintainability:* the `pi` CLI that coop wraps (1.0.0) does not
    use pi-durable. Coop's four extensions, `pi-mcp-adapter` and `pi-hermes-memory`
    are written against the coding agent's extension API, which is a different API.
    Adopting pi-durable means rewriting coop as its own agent on the harness, the
    fork coop has always avoided.
  - *Stability:* experimental, with no compatibility guarantees.
  - *Capability:* nothing coop needs is missing. Pi sessions already persist and
    resume, and the guardrails already hook tool calls.
- **Why watch it.** The state view, event stream, late join and crash resume are
  what a rendered desktop window wants (section 11, D1b and D1e). If the Pi
  maintainers move the CLI onto it, coop inherits it through a U2-style upgrade and
  keeps its extensions; nothing published says that is planned.
- **Worth adopting when all of these hold.** (1) It loses the experimental label.
  (2) The `pi` CLI itself runs on it, or there is a documented path for `pi -e`
  extensions. (3) `pi-mcp-adapter` and `pi-hermes-memory` work on it. (4) A concrete
  gain coop can name, such as crash-safe sessions behind the desktop window.
  Re-check at U2 or D1d, whichever starts first; until then it stays here.

### 12.2 Fabric Apps with Rayfin: row FA1 (October 2, 2026)

Aaron asked for Fabric app creation for Fabric clients and started row FA1 the same
day ("yes go for it"), then asked that coop just do it, with no per-project switch.
**Rayfin** (`@microsoft/rayfin-cli`, MIT) is Microsoft's toolchain for **Fabric
Apps**, a preview workspace item that hosts a TypeScript web app with its own Fabric
SQL database, a GraphQL API and Fabric SSO; connectors read the client's semantic
models, warehouses and lakehouse SQL endpoints in place. A tenant admin must turn on
**Fabric Apps (preview)**, and the workspace needs capacity. Rayfin ships its own
agent files per app (`rayfin init ai-files install`: `AGENTS.md`, skills under
`.agents/skills/`, which Pi loads after project trust), and it releases weekly, so
coop does not bundle or pin it. Microsoft's skills-for-fabric catalog (v0.3.18) has
no Rayfin skill yet.

- **Simplicity and maintainability:** one on-demand skill (`skills/fabric-apps`,
  about 40 always-on tokens) and one gate extension; the app's `package.json` owns
  the Rayfin version, so its churn never reaches the release manifest.
- **Stability:** the guardrails ask before every Rayfin deploy (`rayfin up` and its
  subcommands, `rayfin secret set|delete`) and name the contract's dev workspace
  (`fabric.default_workspace_id`), warning when the command targets another.
  Before FA1 those commands ran without a prompt.
- **Not in FA1:** deploys to test or prod, deleting app items, Kusto connectors
  (held upstream), the Rayfin docs MCP (coop's MCP config is exclusive; the skill
  uses `rayfin docs search` and the docs in `node_modules`).


### 12.3 Demo feedback, October 5, 2026 (revision 3.21)

Aaron demonstrated the window to Joel Leichty, Eric Frisk and two other teammates
on 2026-10-05 and brought the transcript back the same day with the instruction to
prioritize it into this plan and to ask rather than assume. Every item was checked
against `main` first; what already ships (dev reads without approval, #230; the
install-time Fabric / Azure SQL / both choice, SQ7; the Project form in the window,
D1b2; Power BI lineage by view name, #300; the D1e update notice) is not repeated
as a row. The prioritized list with the team's words and the thirteen questions is
the project file `demo/demo-feedback-2026-10-05.md`; this section carries the rows.

**Rows the plan carries now.** Each starts when Aaron says so, like every row; G1
is the one he asked for in the meeting.

| Row | Package | Scope | Starts after | Done when |
| --- | --- | --- | --- | --- |
| G1 | Never modify production | Production **writes** become a hard block in `coop-guardrails`, the same class as source commits and `--amend`: SQL DDL/DML on a target whose environment is `production` or whose text names prod, Power BI Modeling edits after a production connection, Fabric item changes and deploys to a production workspace, with no approval option and no session grant. Production **reads** keep today's rule (explicit scope plus approval, `/coop-live-read revoke` clears it) because the team wants comparisons against production. Eric and a third teammate asked for it ("it should never touch production"; "I would prefer that today"); Aaron agreed in the meeting. **Decided (Aaron, 2026-10-05 20:00): option (a), plus a hidden way to enable production writes when needed.** The unlock lives outside any repository, because the contract is a committed client file (C1): a human runs `coop unlock-prod <client> --minutes <n>` in their own terminal, never from inside a session; it writes a time-bounded grant to the profile dir (`~/.coop/prod-unlock.json`, agent-unwritable like the trusted contract snapshot), the guardrails read it at each call and fall back to today's per-call production approval while it holds, every write under it is logged in the guardrails audit with the grant id, the grant names one client and covers only a session whose contract names that client (Aaron, 20:18: coop never crosses clients without explicit approval), `/coop-approvals status` shows it, and it is absent from the `/` menu, the `/start` menu and the Start menu, documented only in `docs/guardrails-reference.md`. Nothing in the window exposes it | Aaron started it in the meeting; the unlock shape above is the default unless he changes it | the gate-lane fixtures show a production write refused with no approval path for SQL, Modeling and Fabric calls while a scoped production read still asks and proceeds; `docs/guardrails.md` rule 6 reads "never", not "without explicit confirmation", inside the context budget; the audit log records the block; with an unlock in force the same write asks and proceeds, and the unlock expires on its own |
| C1 | The committed project contract | `.coop/project.yml` is a team file committed to the client's Git root (the folder that holds the client's repos), written once and read by everyone, as Joel asked ("one person creates it and everyone else points to it") and Eric and Aaron agreed. Coop already finds the nearest contract walking up from the folder it opens in and the agent still never commits it (the human does), so the row is the product saying so: `/setup-project` and the window's Project form open the committed contract first and never write a second copy below it, propose the Git root as the location, say once that coop should be opened there, and stop treating the file as something to hide; README, the onboarding page and `docs/install-windows.md` say "commit it". Aaron's own per-project instruction that coop never commits files mentioning itself is withdrawn only when he says so. **Decided (Aaron, 2026-10-05): questions 2 and 3 both (a), clients may see the file and there is one contract at the client's Git root** | merged ([#303](https://github.com/kabukisensei/coop-agent/pull/303), 2026-10-05), unreleased; the full experience is designed in the project file `demo/c1-shared-contract-design.md` (Aaron, 2026-10-05: "a smooth user operation and experience") and **approved by Aaron on 2026-10-05 (22:43Z)**: one committed file in a repository the team clones, a client home repository `<client>-coop` for side-by-side repositories (never the parent folder; it also takes over DR1's role as the home of the lineage docs, the catalog snapshot and the client's prompts and skills), "Get the team's project file" before any create offer, a stale-copy check at session start, and "Share with the team" (the one Git write coop performs on its own: only `.coop/project.yml`, on the current branch, after a yes, audited); #303 carries the design as built, in the wizard, the window's Project pane, `coop init` and `coop project`, with the sibling lookup in every contract reader; the VM acceptance run follows the merge | on the VM, a second user opening coop at a root that holds a committed contract gets the same targets and repositories with no setup prompt; `/setup-project` below that root edits the root contract instead of creating one; docs updated |
| C2 | Explicit layout in the contract | The contract declares what coop assumes today: how semantic-model tables map to SQL objects (default `same schema and view name`, the rule #300 uses, with a per-model override) and, for Fabric clients, the layout of lakehouse, warehouse and SQL database items; `/setup-project` fills the Fabric block from the SQ7 platform answer and the `sql_targets` kinds; `data_doc lineage` and `sql_impact` read the mapping and say "declared mapping does not match" instead of "no dependents" when it fails. Joel: "I don't want the tool to assume anything"; Eric: "very explicit, this client is Fabric, it expects a layout like this". **Decided (Aaron, 2026-10-05): question 4 (a)** | merged ([#309](https://github.com/kabukisensei/coop-agent/pull/309), 2026-10-05), unreleased; VM check pending | a contract with a non-default mapping traces a view to its semantic-model table on the VM; a wrong mapping is reported as a mismatch; the Project form shows and edits both blocks |
| L1 | Microsoft tool license review (docs only) | Aaron raised it in the meeting: some bundled Microsoft tools (the Power BI Modeling MCP's EULA coop accepts with `--accept-eula`, the Fabric MCP, the Report Authoring CLI and Desktop Bridge, the Fabric CLI, fabric-cicd, the skills-for-fabric catalog) carry notice or attribution terms when used inside a product. One PR lists each tool, its license, the terms coop must honor and where the notice lives (a `NOTICE.md` and the website's privacy-security page); nothing is installed or changed | now | the list is complete for every pin in `config/release-manifest.json` and `config/microsoft-skills.json`; any term coop does not meet is an issue, not a silent fix |

**Changes to existing rows.** D1j (section 11.7) also groups the command palette
by kind, skills, prompts and tools, as Aaron offered in the meeting; U2 (section
6.5) gains a stated reason once `pi-mcp-adapter` accepts Pi 1.0: Joel asked for
pre-scripted, deterministic queries and fewer tokens, which Pi 1.0's code mode
is, and Aaron told the group "a couple of weeks" after the 1.0 hotfixes. Neither
row starts on its own.

**Already covered elsewhere, no row.** Too many permission prompts (Joel was on a
version before #230; re-ask after a week on v0.30.4). Bug reports that reach Aaron
(the "Internal bug reporting" thread holds that yes/no). The auto-update
expectation (D1e's notice and the in-place installer). Mobile is the secure phone web companion, section 12.4; Teams mobile (M1, #275) was closed as superseded on 2026-10-05. Nothing mobile is shipped on main. Release notes (the changelog page; its home follows question 10).

**Aaron's answers of 2026-10-05 20:00 and the rows proposed from them.** Questions
1–4 are decided above. The transfer of `coop-agent`, `coop-website` and
`coop-data-doc` to the Cooptimize GitHub organization (13) happens "at some point,
not now"; the URL-move change (manifest, `coop update` remote, docs, website) is
noted here and timed with a release when he does it. The docs site (10) stays as it
is, hosted on the VPS, with a domain or subdomain pointed at it later. The repo
layout standard (6) is not decided ("clients do differ"); what Aaron wants from it
is covered by C1: once he commits a client's contract, a teammate gets it with the
repository. Question 9 (Joel's "the documentation is wrong" message) could not be
identified from the transcript and waits for Joel's exact wording. The OpenAI data
processing addendum and the privacy-policy update are Aaron's and Joel's, outside
coop. The rest became proposals, each a row only when Aaron says yes:

| Row | Package | Scope | Starts after | Done when |
| --- | --- | --- | --- | --- |
| P1 | Machine-level shared profile | Aaron (5): the team's VMs have one Windows user per client, so the per-user profile `~/.coop/user.json` is in effect per client and has to be set up in every Windows user (the likely cause of "Joel" in one place and "human" in another: a Windows user with no profile). The committed contract (C1) already gives "open coop from that user and it reads only that client". What is missing is the global layer Joel asked for: the name, the communication preference and the vibes live once per machine in `%ProgramData%\coop\user.json`, read by `coop-profile`, `coop onboard` and the window's set-up card when the per-user file is missing, with the per-user file winning field by field when both exist; `coop onboard --machine` writes it (one elevation, once per VM) and `coop doctor` names which file supplied the name. Aaron, 2026-10-05 20:08: each VM is one person's, so the machine file holds that person's name too. **Accepted.** Aaron, 20:18: the team signs in and out of the Windows user tied to each client when switching work, and coop must never cross one client's data into another's without a very explicit approval or need. So the machine file carries only the person's name, communication preference and vibes, never a client, tenant, workspace, contract, memory or session; everything client-shaped (the contract, `~/.coop` sessions and memory, TeamAI state, the G1 unlock) stays in the client's Windows user, and nothing in coop reads another user's profile | merged ([#310](https://github.com/kabukisensei/coop-agent/pull/310), 2026-10-05), unreleased; VM check pending | on the VM, a new Windows user with no `~/.coop` gets the machine profile's name in its first session; a per-user file overrides it; the fixture test covers both and the missing-both case |
| DR1 | One private data-docs repository per client | Aaron (7): one giant repository with a folder per client, or one private repository per client, "open to suggestion". Proposal: **one private repository per client**, `cooptimize/<client>-data-docs`, cloned beside the client's other repositories under the client's Git root so the committed contract (C1) points at it and coop-data-doc builds into it. Why: coop-data-doc treats same-name semantic models in two folders as an identity collision and refuses an output dir inside a source root, so one repository for every client would fight both rules; access stays per client; a client's lineage never ships inside another client's clone; and the clone stays small. `/setup-docs` proposes that repository as the output when the contract names it, and `data_doc check` runs in that repository's CI. **Accepted (Aaron, 2026-10-05)**. **Reshaped by the approved C1 design (Aaron, 2026-10-05 22:43Z):** the private repository per client is the client home repository `<client>-coop`, which holds the project file, the lineage docs, the catalog snapshot (SQ9) and the client's prompts and skills (PR1), so no separate `*-data-docs` repository and no `data_docs` role; `/setup-docs` proposes the home repository's `data-docs` folder as the output from any of the client's repositories and offers the check workflow there | merged ([#311](https://github.com/kabukisensei/coop-agent/pull/311), 2026-10-05; coop-website [#38](https://github.com/kabukisensei/coop-website/pull/38) open), unreleased; VM check pending | `/setup-docs` from a source repository proposes the home repository's `data-docs` folder, the build lands there on the VM, `check` passes in its CI, and the onboarding page shows the layout |
| PR1 | Personal, client and shipped prompts and skills | Aaron (8): personal prompts and skills, client-specific ones, and standardized ones shipped in coop. Today coop loads its own `prompts/` and `skills/` from the repository, the team-knowledge repositories' skills through the subordinate slot (K3), and nothing per user or per client. Proposal: three tiers with one precedence rule, coop's shipped set wins a name clash, then the client's, then the user's: **personal** `~/.coop/prompts/*.md` and `~/.coop/skills/<name>/SKILL.md`, **client** `.coop/prompts/` and `.coop/skills/` beside the committed contract (so a client's prompts travel with its repository, C1), **shipped** in coop-agent as now. The `/` menu and the window's command palette (D1j) show the tier beside each entry; `coop doctor` lists what loaded from where; Joel's Dataverse prompts come in as files in his personal tier, and the ones the team standardizes move into coop-agent `prompts/` by PR. **Accepted (Aaron, 2026-10-05)** | merged ([#312](https://github.com/kabukisensei/coop-agent/pull/312), 2026-10-05), unreleased; VM check pending | all three tiers load on the VM, a clash resolves in the stated order with a doctor warning, and `docs/extending.md` documents the layout |
| SQ8 | Change-aware impact while coop edits SQL | Aaron (11): when writing or editing a stored procedure, coop should already hold the lineage and say what the change does downstream, "suggest additional columns to tables or views or how it impacts a measure". Today `sql_impact` returns one object's live dependents, references and columns on the default dev target, `data_doc lineage` and (#300) "Loaded by" connect a view to the Power BI tables and measures that load it, and the `coop-workflow` skill asks coop to call both before an edit, as prose. **Aaron, 2026-10-05 20:08: accepted, the intention over the mechanism.** The intention: coop knows the downstream of every object it is about to change, so what it writes fits what reads it (a column added to a procedure's output reaches the view and the measure that need it), the user hears a short line about it with the full detail only when asked, and coop never re-runs a lookup it already holds. So the row is: (1) one lineage context per session that coop fills once per object from the cheapest fresh source, the built docs and the SQ9 snapshot first and the live catalog only when the graph lacks the object or is older than the contract's age, kept for the session so a repeat edit of the same object costs no call; (2) column-level references (`sys.dm_sql_referenced_entities` with `referenced_minor_name`, and the docs' column lineage where built) so a changed or added column is matched to the views, procedures, Power BI tables and measures that use it; (3) the slice summary names each downstream object and the follow-on edit it would need in one line, and `/explain impact` (or the Changes pane) shows the detail; (4) the lookup happens before the edit without the user asking, enforced by the gate rather than by skill text, and skipped when the context already holds the object. No edit outside the slice happens on its own | merged ([#314](https://github.com/kabukisensei/coop-agent/pull/314), 2026-10-06), unreleased; SQ4 and SQ9 are the base; VM check pending | on the dev Warehouse, editing a view's column names the dependent procedure and the semantic-model measure in the summary before the edit is applied, a second edit of the same view in the session makes no new catalog call, `/explain impact` shows the detail, and a slice that would skip the lookup is stopped by the gate; gate-lane fixtures cover each |
| SQ9 | Committed dev catalog snapshot | Aaron (12): "coop should have all the context needed to help write good quality code". Joel's two asks, a schema file coop must follow when writing SQL and a periodic export of object definitions into a read-only repository folder, are one feature. Proposal: `coop catalog snapshot` (or `data_doc snapshot`, owner to be decided with coop-data-doc) reads the default dev target read-only through the SQ2 executor and writes the catalog as committable files, one per object, under the client's data-docs repository (DR1) or `.coop/catalog/<target>/`: tables and columns with types, and the definitions of views, procedures and functions. coop-data-doc treats that folder as a SQL source, so lineage and docs work for clients with no SQL source control, and the SQL-writing guidance names it as the file coop reads before writing (the "allowed tables and fields" Joel described). The snapshot refreshes on demand and when coop finds it older than a contract-set age at session start; it is never a deployment artifact and never runs against production | merged ([#313](https://github.com/kabukisensei/coop-agent/pull/313), 2026-10-06), unreleased; VM check pending | a client with no SQL repository gets `data_doc lineage` for a procedure from the snapshot alone on the VM; a stale snapshot is reported with its age; the snapshot contains no row data and no connection string |
| D1m | The icon is the front door | Aaron (2026-10-05 20:12): the window icon should be the default way people open coop, and it should open in the right folder so coop finds the committed `.coop/project.yml` (C1). Today the installed window package asks for a folder on every launch with a plain folder dialog that defaults to the last folder, and the terminal install's "coop (window)" shortcut starts in the home folder. The row: one "coop" icon (Start Menu and Desktop) opens the window; the terminal keeps a `coop` command and a "coop (terminal)" shortcut for Aaron's daily work. On launch without a folder the window shows a project picker instead of the OS dialog: the folders it has opened before that hold a `.coop/project.yml`, newest first, each with the contract's client name and the Git branch, a Browse button, and "open this one next time" so the last project opens straight away with one click to switch; a folder with no contract offers `/setup-project` and proposes the Git root (C1). The window title and the sidebar name the project. `coop desktop` from a terminal keeps opening the current folder | merged ([#316](https://github.com/kabukisensei/coop-agent/pull/316), 2026-10-05), unreleased: one "coop" icon opens the window (the window runtime's, or the package's, whose shortcut is now plain "coop") and "coop (terminal)" the terminal; the picker (`desktop/lib/projects.mjs`, `desktop/renderer/picker.html`) lists the folders opened before with the client from the project file found above them or in the client home repository beside them (C1), the branch and the team word, Browse, and "open this one next time"; File > Switch project; the title and header name the client | on the VM a teammate double-clicks the icon, picks the client project once, and every later launch opens on it and reads its committed contract without a terminal; a folder without a contract gets the setup offer; the terminal shortcut still opens the terminal |


### 12.4 Secure mobile companion (MC1–MC4; documentation authorized October 5, 2026)

**Scope and decision.** Aaron asked on 2026-10-05 to add this to the master plan and
document what needs doing (draft PR #315, 22:44; reviewed the same evening; at 23:09
he answered the review's three questions "A1 B2 C2": the phone web view is the only
mobile route and M1 Teams mobile is superseded, the plan merges after the C1 project
file set, and MC1 starts after the demo-feedback rows, on his explicit word): an installable phone-friendly web companion for iOS and Android,
mirroring the **same existing live desktop Pi session** on his running VM. The VM
and Coop window remain running. First version: ordinary chat, current status,
stop the current turn, and confirmation/select/input/editor questions, including
approval cards and questionnaires. Preserve Modern Dark, Modern Light, Retro Dark
and Retro Light with responsive layouts. This authorizes planning only; Aaron
starts each implementation row explicitly. It is not a generic remote worker
platform, a second agent, an unattended scheduler or a replacement desktop.

Keep the current individual OpenAI Codex business/premium subscription and
provider login flow on the VM; model requests and provider credentials stay there.
No phone credential replication, shared subscription entitlement assumption,
self-hosted inference dependency or new model-hosting requirement. Confirm the
actual account's permitted use before implementation; this plan grants no new
provider entitlement. Windows sign-in, UAC, browser/provider authentication and
other external/native dialogs remain full secure remote-desktop fallback.

**Current baseline and neighboring work.** `desktop/lib/pi-session.mjs` owns one
Pi process and in-memory pending commands/dialogs; `desktop/lib/rpc-commands.mjs`
validates local renderer commands and dialog responses; `desktop/renderer/dialogs.mjs`
and `desktop/renderer/styles/themes.css` provide reusable question presentation
and four theme tokens. `desktop/main.mjs` and `desktop/preload.cjs` use local
Electron IPC, not an authenticated remote API. `desktop/PARITY.md` is the behavior
reference. Reuse these contracts where suitable; do not publish the IPC surface.
The in-memory maps do not establish crash durability or replay correctness.

PR [#275](https://github.com/kabukisensei/coop-agent/pull/275) (M1, Teams mobile,
built 2026-10-03, never merged) proposed a Teams self-chat transport. Aaron decided on
2026-10-05 at 23:09 that the phone web view is the one mobile route, so M1 is
superseded and #275 is closed; its dialog race through Pi's `AbortSignal`, its answer
parsing and its security review (`m1-security-review-2026-10-03.md` in the project
files) are reference material for MC2, and its stale desktop-card limitation must
not be inherited. G1 PR
[#302](https://github.com/kabukisensei/coop-agent/pull/302) merged on 2026-10-05,
not yet released: apply the production policy actually installed on the VM and qualify
against G1 as released. All policy stays server-side; the companion cannot create
or expose G1's human-only unlock. No existing row's status is changed here.

**Required boundary.** Private network reachability and application/API
authorization are separate controls. Choose an authenticated encrypted private
transport without a public unauthenticated listener. On the VM explicitly bind
each authorized human/device to one client Windows identity and one live session;
show that identity on both screens. Pairing, expiry, logout and immediate device
revocation must be designed before access is enabled. A machine-level personal
profile is not a client/session grant. Never read another client's Windows
profile, credentials, transcript, files, memory or approvals. Changing the client
or live session invalidates old grants and pending submissions; any future
cross-client need requires explicit authorization, outside this first version.

Expose only a separately validated narrow command allowlist: read the bound
session's sanitized snapshot/status/events, submit chat, stop its current turn,
and answer a currently pending supported question. No raw bash, arbitrary RPC,
full Electron IPC, file browsing, shell launch, session creation/switching, model
login or production unlock endpoints. Validate payload types, size and rate
limits on the VM; enforce origin/CSRF protections appropriate to the chosen auth,
and audit authorization/answer/revocation outcomes without secrets. Cache no
client transcript or credentials in a service worker/offline store by default;
use secure mobile storage for the minimum revocable companion credential, never
provider tokens. Review browser storage/XSS risks in MC1. Optional future push
must be generic (for example “Coop needs your attention”), with no client data,
question text or commands in a lock-screen notification.

**Question and reconnect contract.** The VM owns session incarnation, question
identity, exact action/content, choices and expiry; the phone never extends a
lease. Approval grants cover only that exact action in that client/session,
never a general session permission inferred from a stale card. One server-side
arbiter accepts the first valid desktop/phone answer atomically and broadcasts
resolved/cancelled/expired state to every screen. Decline remains the safe default.
Reject unknown, expired, already resolved and wrong-session answers; enforce
server-owned cancellation/timeouts even while a phone sleeps. Submission IDs
and acknowledgements prevent duplicate chat, stop and answers on retry. After
reconnect, reconcile an authoritative snapshot of messages, running status and
pending questions with event sequence/gap detection before enabling submissions;
never auto-replay an uncertain answer. Pi exit, desktop restart or client/session
change invalidates prior questions. First version promises live-session reconnect,
not crash recovery or durable approvals. Unsupported extension/custom TUI/native
UI must say “continue on desktop” and preserve the pending state without guessing
an answer; Windows/auth dialogs use full remote desktop.

| Row | Work breakdown | Gate / done when |
| --- | --- | --- |
| MC1 | Specify the bounded remote contract, identity/pairing/revocation, private transport, secure storage, event/snapshot and exact-action question lifecycle; reconcile the installed/G1 production policy | Aaron explicitly starts; review the threat model and protocol before building; wrong user/device/client/session and revoked credentials are denied independently of network reachability; record transport and auth choices |
| MC2 | Add the VM adapter over the existing live PiSession with the narrow allowlist, server policy checks, atomic dialog resolution, expiry/cancellation, idempotency and reconnect reconciliation | MC1 reviewed; fixtures prove both answer-race orders, duplicates, stale/expired/cancelled dialogs, event gaps, session changes and Pi exit; desktop cards close when phone resolves; no raw RPC/IPC escape or credential exposure |
| MC3 | Build the installable responsive web companion for iOS/Android: chat, status, stop and supported questions, using existing dialog semantics and four themes | MC2 contract stable; phone browser/install tests on both OSes; readable exact commands/options, keyboard and screen-reader access, sufficient contrast and touch targets in every theme; unsupported UI gives desktop fallback |
| MC4 | Qualify on the running Windows VM and document pairing, access, revocation, recovery and remote-desktop fallback | MC2 + MC3; acceptance matrix below passes with sanitized evidence; security review and Aaron's acceptance before enabling for teammates; update operational docs only for capabilities actually shipped |
| MC5 | The coop website's look and menu on the phone: Modern and Retro, dark and light, with Retro in the site's look; every option in a side menu like the site's | Aaron asked 2026-10-06 03:24 and settled it at 03:34 (four themes, Modern the default); the site's palette, bevels, title bars and pixel face, with the font shipped in the page (nothing loads from outside the VM); touch targets of 44px or more; the window's own themes unchanged |
| MC6 | Phone parity 1: `/` commands that the window sends to Pi as typed (extension commands, prompt templates, skills) with completion from `get_commands`; steer or queue while coop works; queued messages back | `desktop/PARITY.md` Phone companion section; the desk-only list (widening grants, `!`, production) refused on the server, not only hidden |
| MC7 | Phone parity 2: model and thinking pickers, compact, session details, session name, copy | MC6; the RPC commands the window already uses, through the hub's allowlist |
| MC8 | Phone parity 3: thinking and tool detail, status line and widgets, the todo panel, conversation search, prompt jumps and history | MC7; only read-only additions (the `panel` event, `GET /api/detail` for a tapped line); thinking and tool output stay out of the stream |
| MC9 | Phone parity 4: new, resume, fork, clone and the session tree from the phone, HTML export on the VM, reload; a session the phone starts or opens keeps its access | MC8; a contract change to MC1's "access ends at every new session" recorded in `desktop/COMPANION.md`; sessions changed at the desk still end access |
| MC10 | Phone parity 5: photos and files from the phone, `@path` mentions | MC9; the window's attachment limits and readers; files land on the VM only, under the window's data folder, never in the project; a large body is read only from a paired phone |
| MC11 | Phone parity 6: a notice when coop needs you while the page is closed | Aaron said yes 2026-10-06 03:34; web push travels through Apple's or Google's push service, so the push carries no payload at all and the phone shows a fixed line; only those services' hosts are contacted |

**Agent assignment and conflict boundaries.** Implementation is **not started**.
Once Aaron explicitly starts a row, agents can work in isolated branches with
synthetic sessions and mock authentication; no real credentials, listeners,
network rules or tenant/device provisioning are required for that development.
MC1 must settle the protocol before MC2 and MC3 begin. These are prospective file
ownership boundaries, not new files or commands already available in the tree:

| Assignment | Likely ownership | Dependencies / parallelization |
| --- | --- | --- |
| MC1 protocol/security owner | Section 12.4 and reviewed protocol/identity decisions in the existing architecture docs; define shared request/event/question types and fixtures | First; obtain Aaron's review of the contract and security choices. One owner edits shared types and the master plan; other agents review without overlapping edits |
| MC2 VM adapter owner | Future mobile adapter modules and protocol fixtures; narrow changes to `desktop/main.mjs`, `desktop/lib/pi-session.mjs` and `desktop/lib/rpc-commands.mjs` only where the live-session contract requires them | After MC1; owns shared dialog arbitration and desktop integration, reusing M1's dialog-race code from #275 where it fits. No concurrent agent changes these files or guardrails for this task |
| MC3 web UI owner | Future companion UI/assets and phone tests; reuse `desktop/renderer/dialogs.mjs` and `desktop/renderer/styles/themes.css` semantics/tokens | After MC1, parallel with MC2 against a mock adapter and frozen contract. Coordinate any changes to shared desktop renderer/theme files with their current owner; do not fork policy into the UI |
| MC4 qualification/docs owner | Acceptance evidence, README, architecture and desktop parity updates; fixtures coordinated with MC2/MC3 | After integrated MC2/MC3 and approved provisioning. One owner updates the register; retain unrelated row statuses and rebase on fresh main before each focused PR |

**Provisioning gate versus build work.** Aaron/admin must select and authorize the
private access mechanism and application identity/enrollment approach, provision
any required private network/identity resources and device grants, confirm the
actual provider account's permitted use, and name a reviewer and VM acceptance
user. Agents can prepare the MC1 contract and, after its review, build MC2/MC3 with
mocks; they cannot assume those grants exist or enable real access as part of
coding. MC4 live qualification waits for approved provisioning and the identified
client Windows user/running session. This roadmap grants no permission to modify
infrastructure, security settings, production policy or provider credentials.
Resolve protocol changes through the MC1 owner, then update both consumers before
integration. Native packaging/push are not parallel first-version assignments.

**Acceptance matrix (MC4, also drives MC2 fixtures).** Verify normal chat,
stream/status, stop and each confirm/select/input/editor/questionnaire form against
the same desktop session. Suspend the phone, lose the network, reconnect with
missing events and retry an unacknowledged request: recover the authoritative
pending state without a second action. Race desktop and phone in both orders;
exactly one answer reaches Pi and both cards resolve. Reject a stale/expired
card, an altered action/option, wrong client/session/device and a revoked device
on an otherwise reachable private network. Disconnect must not count as approval.
Verify running versus disconnected versus exited states honestly. Test Pi exit,
desktop restart and Windows client-user switching invalidate access and questions.
Check all four themes, small screens, accessibility and long approval commands;
exercise unsupported extensions and external Windows/auth UI using the stated
fallback. Verify no provider credentials, cross-client content or sensitive
notifications/cache/logs leave their intended boundary, and that production
blocks cannot be bypassed from the phone under the installed policy.

**MC1 as specified (2026-10-06).** Aaron started MC1 on 2026-10-06 at 02:01
("start work on it"). The contract is `desktop/COMPANION.md`; the rules a program
can check (the seven routes, request validation, the origin rule, the device
grant with its refusal codes, question classification, the answer decision and
reconnect) are `desktop/lib/companion-protocol.mjs`, checked in the gate lane by
`tests/companion-protocol.test.mjs` against `tests/fixtures/companion/`. Nothing
listens and no setting exists until MC2 and MC3 merge. The defaults it records:
the server listens on loopback only behind a sign-in-protected private
connection, and coop's own device grant is checked on every request (paired at
the desk with a one-time code, bound to one Windows user and one client from the
trusted project file, 30 days or 7 idle, revocable at once, access off per
window until allowed and again at every new session); the phone reads, chats in
plain text (no `/` or `!`), stops, and answers questions; options that widen a
grant beyond the one action and every `PRODUCTION` approval under a G1 unlock are
desktop-only (the phone may decline them), and the phone has no route to the
unlock; first valid answer wins against the exact-action digest; reconnect
replays a gap-free tail of the same session or reloads the snapshot; nothing is
cached on the phone but the page and the theme. The private connection
is **Tailscale**: at 02:16 Aaron said "We manage our own machines so permission
is not an issue", and at 02:17 he answered "2" (Tailscale over a Microsoft dev
tunnel, which is labelled for development and capped, and the client's VPN).
`tailscale serve` publishes the loopback port inside the tailnet only, end to
end encrypted; `tailscale funnel` (public) is never used. MC2 and MC3 follow.

**MC4 as qualified (2026-10-06).** The check ran on the client VM with Aaron's
iPhone over Tailscale, from a sandbox window for a test client, following the
runbook in the project files. The loopback listener, the refusals without pairing,
pairing, chat, Stop, a guardrail card answered on either screen, the four themes,
attachments, `@` mentions, sessions from the phone, a desk session ending access,
notices with the page closed and removing a phone all passed; 3b and the notice
passed on Aaron's word. A production approval could not be raised in the sandbox
and rests on the automated tests. Four defects were fixed in #324 (tool ids with a
`|`, a stream written after it ended, "Different Windows user" shown when access was
off, and iPhone Safari zooming fields under 16px), and #325 made the Home Screen
icon the coop tile; v0.32.0 ships them, released on Aaron's 13:15 word that
it follows a passing MC4. Pairing does not turn access on; the window's **Allow phone for
this session** does, and a desk session ends it. At 13:15 Aaron kept MC8's
thinking and tool detail on tap (read only from the window when a line is tapped,
never in the stream).

**Decisions still needed at MC1.** Private transport/auth and device-enrollment
mechanism; session authorization lifetime and reconnect retention limits; supported
iOS/Android browser/install matrix; which live extension UI can be represented;
security-review owner and VM acceptance tester. Native packaging,
app stores, push and background execution remain later decisions, with no first
version requirement. No infrastructure/security settings are changed by this plan.

## 13. Ordered work register

Status values: `not started`, `issue open`, `in progress (branch)`, `in review
(PR)`, `merged`, `done (tag)`. The agent that opens a PR sets `in review` in that
PR. Merging is Aaron's act, so the **next** PR any agent opens also moves every row
whose PR has merged since to `merged`; Aaron moves rows to `done (tag)` when he
tags. A stale row is never a reason to re-do work: check the PR list first.

| Order | ID | Package | Starts after | Done when | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | H1 | Installer prerequisite gate with ordered commands; doctor reuses it | now | fresh VM acceptance in section 3 | merged ([#82](https://github.com/kabukisensei/coop-agent/pull/82), 2026-09-28), shipped by v0.24.0; issue [#76](https://github.com/kabukisensei/coop-agent/issues/76) closed; no VM receipt is recorded in this plan (evidence not recorded, needs confirmation) |
| 2 | H2 | Automatic Azure sign-in, tenant fallback chain, `az.cmd`, Fabric token check | now | signed-out machine acceptance | merged ([#89](https://github.com/kabukisensei/coop-agent/pull/89), 2026-09-28), shipped by v0.24.0; issue [#77](https://github.com/kabukisensei/coop-agent/issues/77) closed; no VM receipt is recorded in this plan |
| 2b | H2b | Coop's own Fabric/SQL token mints pass the project tenant; ships in the same tag as H2 | H2 | guest-tenant acceptance in [#91](https://github.com/kabukisensei/coop-agent/issues/91) | merged ([#109](https://github.com/kabukisensei/coop-agent/pull/109), 2026-09-29), shipped by v0.24.0; issue [#91](https://github.com/kabukisensei/coop-agent/issues/91) closed; no guest-tenant receipt is recorded in this plan |
| 3 | H5 | `coop update` follows release tags; `--edge` for head | now | tag/edge acceptance in section 3 | merged ([#110](https://github.com/kabukisensei/coop-agent/pull/110), 2026-09-29), shipped by v0.24.0; issue [#78](https://github.com/kabukisensei/coop-agent/issues/78) closed; no tag/edge VM receipt is recorded in this plan |
| 4 | H6 | One-page Windows install doc matching the H1 checklist | H1 | a teammate installs from the page alone | merged ([#113](https://github.com/kabukisensei/coop-agent/pull/113), 2026-09-29), shipped by v0.24.0; issue [#79](https://github.com/kabukisensei/coop-agent/issues/79) closed; no teammate-installs-from-the-page receipt is recorded in this plan |
| 5 | H3 | Coop reads the coop-standards wiki directly; contract override shape | local clones of both repos | `coop sync` verifies the real `coop-standards` head; new contract round-trips through `/setup-project` | merged ([#85](https://github.com/kabukisensei/coop-agent/pull/85), 2026-09-28), shipped by v0.24.0; no VM step; issue [#80](https://github.com/kabukisensei/coop-agent/issues/80) closed |
| 6 | T1 | CI gate/extended split; fixture rules | H1–H3 merged | gate under five minutes, both OS, no weakened assertion | merged ([#132](https://github.com/kabukisensei/coop-agent/pull/132), 2026-09-29) |
| 7 | S1, S5 | Retire POSIX product path and legacy web | T1 (Aaron started it on 2026-09-30: Mac, Linux and the web are dropped) | one Windows implementation, forwarder kept, tests removed with their surface | S5 merged ([#161](https://github.com/kabukisensei/coop-agent/pull/161), 2026-09-30, shipped in v0.24.0); S1 merged ([#218](https://github.com/kabukisensei/coop-agent/pull/218), 2026-10-01; shipped in v0.26.0), issue [#205](https://github.com/kabukisensei/coop-agent/issues/205) |
| 8 | S3, S2, S4, S6, S7 | Profile root, lifecycle, token/MCP, dead helpers, docs | S1/S5 | duplication removed; `AGENTS.md` and `CONTRIBUTING.md` no longer require parity/BOM | S3 #221, S2 #223, S4 #225, S6 #227 and S7 #229 merged on main by 2026-10-01 and shipped in v0.26.0; no per-package VM receipt is recorded in this plan |
| 9 | U1 | Dependency reconciliation per section 6, one row per PR, qualified on the VM | S-lane (Aaron started U1 ahead of it on 2026-09-30) | exact versions, tests, rollback per PR; keep/drop list closed | **done**: Pi 0.87.1 + `pi-mcp-adapter` 3.3.0 shipped in v0.24.0 (2026-09-30): merged in [#162](https://github.com/kabukisensei/coop-agent/pull/162), VM run passed (matrix 20/20, sync, doctor, `mcp-adapter.json` migration, console checks), Warehouse approval prompt verified live on the released build; the Pi upgrade continues as row 9c U2 straight to 1.0 (section 6.5; [#170](https://github.com/kabukisensei/coop-agent/pull/170) is a held draft). Shipped in v0.25.0 (2026-10-01): `pi-hermes-memory` 0.9.9 ([#181](https://github.com/kabukisensei/coop-agent/pull/181)), Fabric skills catalog v0.3.18 ([#175](https://github.com/kabukisensei/coop-agent/pull/175)), shell-issued Fabric REST write approvals ([#176](https://github.com/kabukisensei/coop-agent/pull/176)), `@juicesharp/rpiv-ask-user-question` 2.12.0 ([#188](https://github.com/kabukisensei/coop-agent/pull/188)), `@microsoft/fabric-mcp` 1.4.0 ([#189](https://github.com/kabukisensei/coop-agent/pull/189)), `mcp-remote` drop ([#190](https://github.com/kabukisensei/coop-agent/pull/190)), `@azure-devops/mcp` 2.10.0 ([#191](https://github.com/kabukisensei/coop-agent/pull/191)); their VM steps ran in the release-train VM run of 2026-10-01. Shipped in v0.26.0: the lockfile ([#200](https://github.com/kabukisensei/coop-agent/pull/200), closes [#152](https://github.com/kabukisensei/coop-agent/issues/152)): `config/extensions-lock.json` pins the isolated tree's transitive dependencies and `coop sync` installs it with `npm ci`; VM run passed (two clean syncs give the same `npm ls --all` output; lock entries carry `gypfile: false` so npm never compiles better-sqlite3 13 on Windows). Shipped in v0.27.0: the Power BI pair `@microsoft/powerbi-report-authoring-cli` 0.4.0 + `@microsoft/powerbi-desktop-bridge-cli` 1.0.0 ([#199](https://github.com/kabukisensei/coop-agent/pull/199); one PR because 0.4.0 depends on Bridge ^1.0.0; its Power BI Desktop VM step is recorded in the plan commit for #199). Shipped in v0.29.0: the last two open questions closed in [#264](https://github.com/kabukisensei/coop-agent/pull/264) (2026-10-02): `context-mode` dropped and removed from existing installs, `pi-web-access` 0.10.7 → 0.35.0; the keep/drop list is closed. |
| 9b | N1 | Automatic session naming after a few turns (`@xl0/pi-lovely-rename` trial first, coop-owned fallback; section 10) | U1 rows merged (Aaron scheduled it 2026-09-30) | names appear in footer and title on the VM without breaking manual `/name`; acceptance list in section 10 | merged 2026-10-01 and shipped in v0.25.0 ([#198](https://github.com/kabukisensei/coop-agent/pull/198)): upstream `@xl0/pi-lovely-rename` 0.1.5 pinned, three-turn trigger kept (Aaron, 2026-10-01); VM trial passed (generated names show in the resume list and footer, manual `/name` survives, `/rename` regenerates). Coop's own footer is replaced by Pi's on the VM ([#203](https://github.com/kabukisensei/coop-agent/issues/203), pre-existing). Coop-owned namer not needed unless long sessions name badly |
| 9c | U2 | Pi 1.0.x with a `pi-mcp-adapter` release that accepts `pi-ai` ^1.0.0; replaces the separate 0.99 step (section 6.5) | U1 + N1 merged; adapter peer range includes 1.0; 1.0 soaked (first 1.0.x patch or a week with no regressions reported); a concrete reason (a Pi fix coop needs, 0.87.x unsupported, or D1); explicit start | one PR, VM-qualified: matrix green on 1.0.x, `coop sync` locks `-builtin:mcp` and writes `tuiMode: "regular"`, doctor reports both, footer and Warehouse approval prompt verified live, lockfile regenerated | watch and wait (Aaron, 2026-10-01: little gain for coop yet; blocked on the adapter; [#170](https://github.com/kabukisensei/coop-agent/pull/170) held as a draft carries the guardrail prerequisite) |
| 10 | ST1 | Standards alignment and reviewer decision | H3 + U1 | resolver data-driven; reviewers retired from coop (decided 2026-09-28), self-check in place | merged 2026-10-01 and shipped in v0.26.0 ([#211](https://github.com/kabukisensei/coop-agent/pull/211), f29bd50): wrappers, `coop review`, reviewer-discovered fallback and CI jobs removed; self-check in the workflow with the standards rule (deviate only on a user exception or a stated reason); a bundled copy of the wiki ships in coop as the offline/first-run fallback (Aaron, 2026-10-01); CLI repos archived by Aaron |
| 11 | SQ1–SQ7 | Azure SQL targets, dev default, live impact, data verification, install-time Fabric/Azure SQL client choice (section 8 item 7) | ST1 | section 8 acceptance | merged 2026-10-01 (shipped in v0.26.0): SQ7 install-time client choice ([#208](https://github.com/kabukisensei/coop-agent/pull/208)), SQ1 `sql_targets` contract section ([#209](https://github.com/kabukisensei/coop-agent/pull/209)), SQ2 executor targets ([#212](https://github.com/kabukisensei/coop-agent/pull/212)), SQ3 guardrail scope ([#214](https://github.com/kabukisensei/coop-agent/pull/214)), SQ4 `sql_impact` ([#215](https://github.com/kabukisensei/coop-agent/pull/215)), SQ5 verify-with-data text ([#216](https://github.com/kabukisensei/coop-agent/pull/216)), SQ6 skill mapping text ([#217](https://github.com/kabukisensei/coop-agent/pull/217)); dev reads without approval ([#230](https://github.com/kabukisensei/coop-agent/pull/230)) and the `sql-formatting` skill ([#231](https://github.com/kabukisensei/coop-agent/pull/231)) followed; live acceptance (dev Azure SQL database + Fabric Warehouse) is Aaron's |
| 11a | DD1–DD4 | Mixed-estate offline documentation and Coop evidence contract (section 8.1) | DD1 authorized now; later steps follow dependencies in section 8.1 | acceptance matrix, preserved intent/cache, honest scoped impact, Windows contract verification | DD1–DD3 merged in coop-data-doc [#67](https://github.com/kabukisensei/coop-data-doc/pull/67) (supersedes draft #66) and released as v1.3.0 (2026-10-01); coop pin bump [#238](https://github.com/kabukisensei/coop-agent/pull/238) and DD4 wrapper contract [#235](https://github.com/kabukisensei/coop-agent/pull/235) (supersedes draft #233) merged 2026-10-01 and shipped in v0.26.0. Windows contract verification: the `datadoc-windows` job in `extended.yml` runs `tests/datadoc-live.test.mjs` from Windows PowerShell 5.1 against coop-data-doc 1.3.0 through Pi's exec and real pipes (non-ASCII mixed estate); it found and fixed the wrapper's YAML escape decoding. Scope-ID migration acceptance done: coop-data-doc [#68](https://github.com/kabukisensei/coop-data-doc/pull/68) (2026-10-02) rebuilds estates written by the real v1.2.0 and fixes the three legacy-decision bugs it found, released as v1.3.1; the 1.3.1 pin merged in [#266](https://github.com/kabukisensei/coop-agent/pull/266) and shipped in coop-agent v0.29.1; coop-data-doc v1.3.4 adds `loaded_by` to `lineage` ([#69](https://github.com/kabukisensei/coop-data-doc/pull/69)), pinned after v0.31.0 |
| 12 | FR1 | Common-workflows first run | SQ1 (menu items exist) | first launch shows the menu; onboarding no longer blocks | merged ([#241](https://github.com/kabukisensei/coop-agent/pull/241), 2026-10-01; shipped in v0.27.0): first interactive launch opens the seven-item `/start` menu once, the launch never runs the wizard, the name question moved into the project item |
| 13 | PK1 | `pi-lovely-codex` versus `pi-better-openai`, diagnostics, simplify (naming moved to N1) | U1 + explicit start | one owner of usage stats; adopt/build/defer recorded per candidate | not started |
| 14 | B1 | Minimal beta channel | — | — | **skipped** (Aaron, 2026-09-30: seven people update from tags; the VM qualifies upgrades) |
| 15 | K1, K2, K3 | TeamAI shared knowledge: isolated CLI and read-only recall, reviewed contribution, broader lifecycle | FR1 + explicit start; VM isolation | revision 2.0 section 8 gates, one PR per row | merged 2026-10-02 and shipped in v0.28.0: K1 ([#249](https://github.com/kabukisensei/coop-agent/pull/249)), K2 ([#250](https://github.com/kabukisensei/coop-agent/pull/250)), K3 ([#259](https://github.com/kabukisensei/coop-agent/pull/259), which landed [#251](https://github.com/kabukisensei/coop-agent/pull/251) on main); issue [#247](https://github.com/kabukisensei/coop-agent/issues/247) (K1) is still open and tracks the VM acceptance (project runbook `k1-teamai-vm-acceptance`), not implementation work |
| 15b | J0–J3 | Jev shadow experiments | explicit start | revision 2.0 gates | waiting (Aaron, 2026-09-30) |
| 16 | D1 | Electron desktop with packaged installer, worked as D1a–D1g (section 11.2) and the follow-ups D1h–D1j (section 11.7): decision record and salvage, `coop desktop` window from the terminal product (first deliverable, no installer or certificate), unsigned installer, bundled runtime, updates, signing last, teammate acceptance | 7–12 and 15 accepted; Aaron starts D1; each 11.3 item decided when its row starts (U2 is no longer a gate for D1d, section 11.7) | another user installs from the package alone (D1g); signing not required (Aaron, 2026-10-02) | D1a decision record and salvage list merged ([#255](https://github.com/kabukisensei/coop-agent/pull/255), revision 3.13, section 11.5); D1b `coop desktop` window merged ([#260](https://github.com/kabukisensei/coop-agent/pull/260), 2026-10-02), VM acceptance in `E:\coop-sandbox\d1b` pending; D1b2 side pane, attachments, draggable panes, splash and vibes, concise activity view merged ([#265](https://github.com/kabukisensei/coop-agent/pull/265), v0.29.0); D1c unsigned per-user installer built (revision 3.17; Aaron started it 2026-10-02), CI job on every PR, VM acceptance open; the six first-run fixes from the desktop UX review merged (revision 3.18; section 11.6 statuses); D1d bundled runtime built (revision 3.19; Aaron started it 2026-10-03: one install), blank-VM acceptance open; then D1e with the update notice first, D1h health pane, D1i integrated terminal pane, D1j approvals chip and skills browser (section 11.7); D1f and D1g as before |
| 17 | FA1 | Fabric Apps with Rayfin (section 12.2): `fabric-apps` skill and a Rayfin deploy gate | Aaron started it 2026-10-02 | gate tests in the gate lane; acceptance on a tenant with Fabric Apps (preview) on: scaffold the todo template, connect one semantic model, deploy to a throwaway dev workspace through the prompt, delete the item in Fabric | merged ([#263](https://github.com/kabukisensei/coop-agent/pull/263), 2026-10-02) and shipped in v0.29.0; the tenant acceptance (Fabric Apps preview on, throwaway dev workspace) is Aaron's and not yet recorded |
| 18 | G1 | Never modify production: production writes hard-blocked, scoped reads still ask, hidden human-only unlock outside the repo (section 12.3) | decided (Aaron, 2026-10-05); asked for in the demo | section 12.3 acceptance | merged ([#302](https://github.com/kabukisensei/coop-agent/pull/302), 2026-10-05), unreleased; VM check pending |
| 19 | C1 | The shared project file: one committed contract per client, the client home repository, get and share (section 12.3) | decided (Aaron, 2026-10-05); design approved 2026-10-05 | section 12.3 acceptance | merged ([#303](https://github.com/kabukisensei/coop-agent/pull/303), 2026-10-05), unreleased; VM check pending |
| 20 | C2 | Explicit semantic-model-to-SQL mapping and Fabric layout in the contract (section 12.3) | decided (Aaron, 2026-10-05) | section 12.3 acceptance | merged ([#309](https://github.com/kabukisensei/coop-agent/pull/309), 2026-10-05), unreleased; VM check pending |
| 21 | L1 | Microsoft tool license and notice review, docs only (section 12.3) | now | section 12.3 acceptance | merged ([#308](https://github.com/kabukisensei/coop-agent/pull/308), 2026-10-05; coop-website [#37](https://github.com/kabukisensei/coop-website/pull/37) open), unreleased |
| 22 | P1 | Machine-level shared profile for one-Windows-user-per-client VMs (section 12.3) | accepted (Aaron, 2026-10-05; one VM is one person's) | section 12.3 acceptance | merged ([#310](https://github.com/kabukisensei/coop-agent/pull/310), 2026-10-05), unreleased; VM check pending |
| 23 | DR1 | The lineage docs live in the client home repository beside the project file (section 12.3; reshaped onto C1) | accepted (Aaron, 2026-10-05); C1 | section 12.3 acceptance | merged ([#311](https://github.com/kabukisensei/coop-agent/pull/311), 2026-10-05; coop-website [#38](https://github.com/kabukisensei/coop-website/pull/38) open), unreleased; VM check pending |
| 24 | PR1 | Personal, client and shipped prompts and skills (section 12.3) | accepted (Aaron, 2026-10-05) | section 12.3 acceptance | merged ([#312](https://github.com/kabukisensei/coop-agent/pull/312), 2026-10-05), unreleased; VM check pending |
| 25 | SQ8 | Coop holds the lineage context while it edits SQL: column-level downstream, one line in the summary, detail on request, no repeated lookups (section 12.3) | accepted (Aaron, 2026-10-05: intention over mechanism); SQ4, SQ9 | section 12.3 acceptance | merged ([#314](https://github.com/kabukisensei/coop-agent/pull/314), 2026-10-06), unreleased; VM check pending |
| 26 | SQ9 | Committed dev catalog snapshot as a SQL source and the file coop reads before writing SQL (section 12.3) | accepted (Aaron, 2026-10-05); SQ2, DR1 | section 12.3 acceptance | merged ([#313](https://github.com/kabukisensei/coop-agent/pull/313), 2026-10-06), unreleased; VM check pending |
| 27 | D1m | The window icon is the front door: one coop icon, a project picker that remembers the client folders and opens the last one (section 12.3) | accepted (Aaron, 2026-10-05); C1 | section 12.3 acceptance | merged ([#316](https://github.com/kabukisensei/coop-agent/pull/316), 2026-10-05), unreleased; VM check pending |
| 28 | MC1–MC4 | Secure installable iOS/Android web companion for the same running desktop Pi session (section 12.4) | documentation authorized 2026-10-05; implementation requires explicit start, MC1 review then MC2/MC3 and MC4 qualification | section 12.4 acceptance matrix; private transport plus independent app/session authorization; desktop/theme parity | MC1 merged ([#319](https://github.com/kabukisensei/coop-agent/pull/319), contract `desktop/COMPANION.md`, started by Aaron 2026-10-06 02:01; private connection Tailscale, Aaron 2026-10-06 02:17); MC2 and MC3 merged ([#320](https://github.com/kabukisensei/coop-agent/pull/320): the window's loopback server, Session > Phone, and the phone page `desktop/companion/`); MC4 accepted 2026-10-06 on the client VM with Aaron's iPhone (fixes [#324](https://github.com/kabukisensei/coop-agent/pull/324), icon [#325](https://github.com/kabukisensei/coop-agent/pull/325), shipped in v0.32.0); M1 #275 closed as superseded (Aaron, 2026-10-05 23:09) |
| 29 | MC5 | The coop website's look and menu on the phone companion: Modern and Retro, dark and light (section 12.4) | asked by Aaron 2026-10-06 03:24; MC3 | section 12.4 MC5 gate | in review |
| 30 | MC6–MC11 | Phone parity with the terminal, gap by gap (`desktop/PARITY.md` Phone companion; section 12.4) | asked by Aaron 2026-10-06 03:25; MC5 | section 12.4 MC6–MC11 gates | gap list written; MC6 merged (#321); MC7 (model, thinking, compact, name, details, copy) merged (#322); MC8 (panel, tool and thinking detail on tap, kept by Aaron 13:15, Find), MC9 (new, resume, fork, clone, export, tree view, reload), MC10 (photos, files, `@` mentions) and MC11 (empty-push notices, approved by Aaron 03:34) merged (#323) and checked on the VM in MC4; all in v0.32.0 |

Phase 0 rows can each be released as a patch. Later phases are minor versions.
Rows become `agent:ready` only when Aaron says so. On September 28 he marked the
five Phase 0 issues (#76 H1, #77 H2, #78 H5, #79 H6, #80 H3); they carry the plan
text as their body. Take them lowest issue number first, one at a time; H1, H2, and
H5 all touch `lib/common.*`, so do not run them in parallel. H3 is independent and
may run alongside.

## 14. Working this plan: agents, issues, and the development VM

Several agent sessions will work this plan in the same week. These rules keep them
on the same page; they add to `AGENTS.md`, they do not replace it.

**One row, one issue, one branch, one PR.**

- Every row in section 13 that is being worked has a GitHub issue titled with its
  ID (`H1: installer prerequisite gate`), whose body is the row's section of this
  plan (Observed, Fix, Acceptance) copied in, so the issue is self-contained. Aaron
  adds `agent:ready`; nobody else does.
- An agent takes the lowest-numbered `agent:ready` row whose "Starts after" is
  satisfied, comments on the issue that it is starting, and works on a branch named
  `<id>/<short-name>` (for example `h1/prereq-gate`).
- The PR title starts with the ID. The PR body states the phase, what changed,
  what was deliberately not changed, the tests run, and the acceptance evidence
  (for Phase 0 that is the development VM run). It updates the row's Status.
- One purpose per PR. If an agent finds a second bug, it opens an issue and moves
  on. If it finds that the plan is wrong, it says so in the PR and stops rather
  than widening the change.
- No agent starts the next phase because the current one is finished. Phase starts
  are Aaron's. Releases and tags are Aaron's.

**Before starting any row, read in this order:** `AGENTS.md`, this plan's section
2 (the rules) and the row's own section, then revision 2.0 (in `docs/history/`)
only for the package detail it points to. Everything else under `docs/history/`
is read-only context, never direction.

**There is one plan.** This file is it. New planning is a new revision of this
file, never a new plan document. A Spec Kit `plan.md` under `specs/<issue>/` is an
implementation note for one issue and must point back to its row here; it is not
a roadmap.

**The development VM (week of September 28).** A fresh Windows VM is the shared
acceptance and qualification machine:

- It has nothing installed but Windows and a browser at the start. Snapshot it
  there ("blank"), then again after a clean `coop install` ("stable"), so any agent
  can reset to either.
- H1 and H6 are accepted only on the "blank" snapshot; H2 only on "stable" with
  `az` signed out; Phase 3 candidates only on a fresh install of the candidate
  version.
- Evidence from the VM (the installer's printed checklist, `coop doctor` output,
  the version report) goes into the PR. No credential values, no client data.
- The VM is not a teammate's machine and not Aaron's C: installation; nothing on
  it is precious, so acceptance may include uninstall and reinstall.
- **The VM gates acceptance, not the start of work.** Code, stubbed tests, and the
  PR for any Phase 0 row begin as soon as the row is `agent:ready`; CI's Windows
  runners prove the stubbed behavior. A PR may merge on green CI with its
  acceptance line marked "VM pending". Aaron runs the VM step before tagging the
  patch release, and the row's Status moves to `done (tag)` only then. H3 never
  needs the VM.

**Definition of done for the week:** Phase 0 rows H1, H2, H5, and H6 merged and
tagged as a patch release by Aaron, installed on the VM from the tag, and H3 either
merged or blocked only on the standards repositories.

## 15. What this review could not verify

- (Resolved 2026-09-28.) The two standards repositories were not readable from the
  cloud session; local clones were used for H3, which found the wiki layout
  described in section 3.
- No Windows workstation was available; installer and sign-in behavior is inferred
  from the scripts, the README, the v0.23.4/v0.23.5 changelog, and the B0 receipt.
- Dependency "latest" values were rechecked against npm/PyPI on September 29,
  2026 (section 6.4); no candidate was installed or run.
- (Resolved 2026-09-30.) No client CI pipeline runs `coop-sql-review` or
  `coop-dax-review`; ST1 archives the CLIs (section 7).

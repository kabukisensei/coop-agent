# Coop Desktop — Windows VM handoff

This is a development snapshot for native Windows testing, not a release.
Aaron explicitly requested committing and pushing the Desktop work so the VM can
pull a reproducible checkout. Use isolated test folders; preserve the VM's existing
Coop installation and business workspaces.

## Repositories

All four use branch `feature/coop-desktop-platform`. Clone them as siblings with
these local names. Set `core.autocrlf=false` on the clones so source hashes, shell
scripts and PowerShell BOM checks remain meaningful.

| Local folder | Repository | Companion revision |
|---|---|---|
| coop-agent-desktop | https://github.com/kabukisensei/coop-agent.git | Use the exact agent commit supplied with the handoff prompt. |
| coop-data-doc-desktop | https://github.com/kabukisensei/coop-data-doc.git | bdd0ad06b730695087978f32d1c3edd595038b8f |
| coop-sql-review-desktop | https://github.com/kabukisensei/coop-sql-review.git | 07d94a06b732f3f34085a48d60ffc637c806faa8 |
| coop-dax-review-desktop | https://github.com/kabukisensei/coop-dax-review.git | ee64071124289da877d2f570a742858da19d7d62 |

Use a fresh parent such as `$env:USERPROFILE\Developer\coop-desktop-windows-test`.
Fetch and verify the supplied revisions before creating a Windows work branch.
Never reset an existing dirty checkout to make these instructions fit.

## Read first

In the agent repository, read `AGENTS.md`, `.coop/project.yml`, `desktop/README.md`,
`COOP_DESKTOP_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md`,
`docs/agent/desktop-completion-status-2026-09-07.md`,
`config/desktop-parity.json`, and `config/desktop-release-requirements.json`.
Read each companion's `AGENTS.md` and its test configuration before working there.
The old Mac absolute paths in historical logs are evidence locations, not paths
that should be copied into Windows configuration.

The accepted UI direction is compact, ordinary controls like Codex, icon-only
copy, and the original plain Cooptimize logo in `themes/coop.ico`. Terminal is a
first-class client. Keep the shared renderer/runtime; browser retirement is
conditional on Desktop acceptance, not permission to delete `web/`.

## Baseline and known gaps

The agent's final macOS development checks passed: 42 focused update tests, full
Bash and PowerShell behavioral suites, shell syntax/parity and whitespace checks.
Companion source suites passed: data-doc 634, SQL review 670, DAX review 624; all
three lint and formatting checks passed. These are Mac results, not Windows proof.

Native Mac evidence covers managed startup, model selection, real model work in a
preview profile, session recovery, icon/copy behavior, signed update preparation,
atomic activation/rollback, runtime/native-window health checks, independent
recovery and completed-recovery retention. Production signing/feed provisioning,
real reboot/login acceptance and complete fresh-managed-profile model work remain
open. Prepared-copy cleanup at the pinned agent revision also passed a subsequent
packaged Mac helper update: healthy activation, visible success notice, Ready
workspace, removed prepared duplicate, retained and verified installed/rollback
apps and original DMG, and disarmed recovery job. Health-probe profiles remain;
this is not proof of general cache retention or Windows behavior.

Windows update preparation/replacement/recovery is still explicitly unsupported
in the current implementation. NSIS configuration alone is not a complete Windows
updater. Implement and verify the required Windows behavior; never bypass the
platform check and reuse macOS filesystem or process assumptions.

The managed preparer currently acquires published pinned Python tools. Testing
editable companion sources does not prove those changes are in a managed app.
Track both source revisions and actual packaged wheel bytes. Resolve that gap with
an explicit development packaging mechanism and regenerated inventory/evidence;
do not silently weaken pinned version, integrity or signature checks.

## Native Windows work

1. Inventory Windows version, x64/ARM64, disk space, Git, Node/npm, Python and
   PowerShell. The existing target is `win32-x64`; an ARM64 VM needs an explicit
   target decision. Use Git for Windows Bash for shell tests, not WSL as Windows
   runtime evidence. Use separate Python environments per companion and the
   development dependency pins in each `pyproject.toml`.
2. Run the full source suites, companion lint/format checks, Bash syntax/parity,
   and release/resource contract checks. Fix Windows path, quoting, case, encoding,
   process-tree, locks and lifecycle failures without skipping meaningful tests.
3. Build and inspect a real managed Windows app and NSIS installer. Commands from
   the agent repo (choose fresh absolute build paths):

   ```powershell
   npm ci --prefix desktop
   node scripts/managed-runtime-build-plan.mjs win32-x64
   node scripts/prepare-managed-runtime.mjs --target win32-x64 --work C:\CoopTestBuild\work --output C:\CoopTestBuild\managed-runtime
   node scripts/verify-managed-runtime.mjs --bundle C:\CoopTestBuild\managed-runtime --workspace C:\CoopTestBuild\workspace --agent C:\CoopTestBuild\agent
   $env:COOP_DESKTOP_MANAGED_RUNTIME_DIR = 'C:\CoopTestBuild\managed-runtime'
   npm run package:managed:win --prefix desktop
   npm run verify:managed-package --prefix desktop
   npm run package:installer:win --prefix desktop
   ```

   Create the disposable workspace before verification; the preparer's work and
   output directories must not already exist. Do not substitute the Mac bundle.
4. Exercise the installed GUI with native computer use: install/repair, workspace
   selection, model sign-in, a real file-writing/test-running task, approvals, Stop,
   steering/queueing, multiple chats, history/fork/clone, restart/crash recovery,
   files/diffs/reviews/lineage, terminal handoff and shutdown. Confirm no orphan
   runtimes or port listeners and no fallback to unrelated global credentials.
5. Test Windows clipboard interoperability with code, multiline Unicode and tables,
   attachments, file dialogs, keyboard/focus, resize/DPI and themes. Use synthetic
   files for Power BI Desktop/PBIP/PBIR integration. Record unavailable prerequisites
   explicitly instead of fabricating successful evidence.
6. Complete Windows update/recovery and retention with native interruption,
   cancellation, locked-file, failed-health and rollback checks. Preserve the last
   working installation and user data. Use temporary test signing/metadata only;
   production certificates, releases and feed publication are separate work.

## Evidence and return handoff

Keep `docs/agent/windows-validation-2026-09-07.md` and daily logs updated with exact
commands, exit codes, source/artifact hashes, OS/tool versions, screenshots and
observed native behavior. Derive the acceptance matrix from every applicable
capability and release requirement. Passing unit tests cannot close native,
installer, interoperability or production-signing requirements.

Work in a separate Windows branch such as `feature/coop-desktop-windows-validation`
so Mac work can continue without competing pushes. Return commit IDs or a binary
patch, changed-file summary, reproducible failures, evidence paths and remaining
blockers. Do not merge to main, change release versions, push tags, publish a
release, copy credentials, or alter real client data. Completion requires the
Windows development app to perform real work with applicable tests and native
journeys verified; external signing/access blockers must remain explicit.

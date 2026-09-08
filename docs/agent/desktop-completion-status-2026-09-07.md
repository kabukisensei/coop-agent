# Desktop completion status — September 7, 2026

Objective: get the app to a final working state with all tests and improvements made. This checklist tracks the whole objective; a passing local slice does not complete it.

## Authority and evidence limits

- Product/architecture: `COOP_DESKTOP_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md`, especially sections 5 and 12. Terminal remains first-class; browser retirement is deferred until Desktop acceptance per the user handoff.
- Capability completion: `config/desktop-parity.json` and its referenced capability contracts.
- Distribution/journey acceptance: `config/desktop-release-requirements.json` and `scripts/desktop-release-gate.mjs`.
- Source worktree is dirty and intentionally preserved. The release baseline used HEAD b4e824a7b01bcfd275eaf86241f3543c03b744a3 with no submitted release evidence. It is a gap inventory, not evidence for the uncommitted patch or a release approval.
- Baseline `ready` is false. Protocol manifest agreement passes; capability parity and release evidence are blocked. No parity status was promoted based only on unit tests.
- Production signing/release and native Windows acceptance remain outstanding. No commit, release, production signing or installation is implied by this work.

## Product work and observed acceptance

| Area | Current evidence | Required remaining work |
|---|---|---|
| Real agent work | Real model created files, ran four passing tests; Stop ended an in-flight tool | Full approval/retry/fork/clone and managed-runtime journeys |
| Chat recovery | Real restart restored workspace; manual History restored transcript/table and selected model | Automatic restoration and runtime/app SIGKILL recovery verified in macOS packaged preview; Windows/managed-runtime journeys remain |
| History | Pending-selection lock, retry on network failure, disabled missing folders tested | Native failure/conflict journeys across platforms |
| Toolbar identity | Stale chat/out-of-order settings replies reproduced and fixed; context statistics protected and behaviorally tested | Include in restored multi-chat journey |
| Copy/UI | Response icon verified by native copy/paste; panels/sidebar/themes visually checked on macOS | Complete accessibility/attachments/narrow-window/native interoperability matrix |
| Performance | Existing transport backpressure and replay checks | Repeatable startup/memory/long-conversation measurements and fixes |
| Distribution | Development preview uses local ad-hoc signed shell and repo runtime | Managed state migration, durable install, production signing, trusted updates and rollback |

## Architecture release invariants

Each item requires matching-scope evidence; the checks below remain incomplete until inspected and verified for final artifacts.

1. Byte-equivalent governed Pi launch behavior across terminal, Web and runtime.
2. Current real-Pi protocol verification and zero unexplained required-event drift.
3. Generated capability/parity report with all required entries complete.
4. Exact companion-tool golden-fixture parity and visible partial evidence.
5. Renderer isolation and IPC/path/navigation security tests.
6. Session/checkout ownership including crashes and stale recovery.
7. Clipboard, attachments, accessibility, clean-machine, updates and rollback.
8. Signed artifacts and verified update metadata.
9. Passing terminal/Web/Bash/PowerShell regression gates for the final state.

## Named release requirements

No formal platform evidence documents were supplied to the baseline gate. Local observations in the daily log are useful development evidence, but do not satisfy these final-artifact requirements automatically.

| Requirement | Kind | Platforms | Final evidence |
|---|---|---|---|
| suite.bash | test-suite | windows, macos | Not yet established |
| suite.powershell | test-suite | windows, macos | Not yet established |
| suite.protocol-real-pi | test-suite | windows, macos | Not yet established |
| journey.install-repair | journey | windows, macos | Not yet established |
| journey.model-sign-in | journey | windows, macos | Not yet established |
| journey.workspace-open | journey | windows, macos | Not yet established |
| journey.agent-chat | journey | windows, macos | Not yet established |
| journey.sql-dax-review | journey | windows, macos | Not yet established |
| journey.git-diff | journey | windows, macos | Not yet established |
| journey.session-fork-clone | journey | windows, macos | Not yet established |
| journey.terminal-handoff | journey | windows, macos | Not yet established |
| journey.clean-shutdown | journey | windows, macos | Not yet established |
| journey.clipboard-interoperability | manual-interoperability | windows | Not yet established |
| journey.powerbi-desktop | manual-interoperability | windows | Not yet established |
| journey.platform-limited-powerbi | manual-interoperability | macos | Not yet established |
| distribution.signed-installer | distribution | windows, macos | Not yet established |
| distribution.signed-update | distribution | windows, macos | Not yet established |
| distribution.failed-update-rollback | distribution | windows, macos | Not yet established |
| quality.accessibility | quality | windows, macos | Not yet established |
| quality.renderer-security | quality | windows, macos | Not yet established |

## Capability gate inventory

| Gate | Baseline result | Platforms |
|---|---|---|
| parity.coop.agent.chat.streaming | blocked | windows, macos |
| parity.coop.agent.tools.live-output | blocked | windows, macos |
| parity.coop.agent.thinking.display | blocked | windows, macos |
| parity.coop.agent.model.select | blocked | windows, macos |
| parity.coop.agent.model.cycle | blocked | windows, macos |
| parity.coop.agent.thinking-levels.list | blocked | windows, macos |
| parity.coop.agent.thinking-level.set-cycle | blocked | windows, macos |
| parity.coop.agent.queue.steer | blocked | windows, macos |
| parity.coop.agent.queue.follow-up | blocked | windows, macos |
| parity.coop.agent.compaction.auto | blocked | windows, macos |
| parity.coop.agent.retry.auto | blocked | windows, macos |
| parity.coop.agent.abort-retry | blocked | windows, macos |
| parity.coop.session.multiple | blocked | windows, macos |
| parity.coop.session.history | blocked | windows, macos |
| parity.coop.session.name | blocked | windows, macos |
| parity.coop.session.export | blocked | windows, macos |
| parity.coop.session.switch-path | blocked | windows, macos |
| parity.coop.session.fork | blocked | windows, macos |
| parity.coop.session.clone | blocked | windows, macos |
| parity.coop.session.tree.read | blocked | windows, macos |
| parity.coop.session.tree.checkout | blocked | windows, macos |
| parity.coop.runtime.commands.discover | blocked | windows, macos |
| parity.coop.runtime.resources | blocked | windows, macos |
| parity.coop.runtime.extension-dialogs | blocked | windows, macos |
| parity.coop.agent.prompt-images | blocked | windows, macos |
| parity.coop.workspace.files | blocked | windows, macos |
| parity.coop.workspace.user-profile | blocked | windows, macos |
| parity.coop.workspace.project-config | blocked | windows, macos |
| parity.coop.workspace.environment-discovery | blocked | windows, macos |
| parity.coop.workspace.progressive-setup | blocked | windows, macos |
| parity.coop.workspace.git-changes | blocked | windows, macos |
| parity.coop.workspace.worktree-isolation | blocked | windows, macos |
| parity.coop.session.crash-restart | blocked | windows, macos |
| parity.coop.review.sql | blocked | windows, macos |
| parity.coop.review.dax | blocked | windows, macos |
| parity.coop.lineage.explorer | blocked | windows, macos |
| parity.coop.lineage.setup | blocked | windows, macos |
| parity.coop.impact.guided | blocked | windows, macos |
| parity.coop.workflow.review-changes | blocked | windows, macos |
| parity.coop.review.bpa | blocked | windows, macos |
| parity.coop.knowledge.private-memory | blocked | windows, macos |
| parity.coop.knowledge.shared | blocked | windows, macos |
| parity.coop.runtime.doctor | blocked | windows, macos |
| parity.coop.auth.model | pass | windows, macos |
| parity.coop.auth.microsoft | blocked | windows, macos |
| parity.coop.integration.powerbi-desktop | blocked | windows |
| parity.coop.session.terminal-handoff | blocked | windows, macos |

## Automatic chat restoration acceptance

- Persist only Desktop navigation metadata: workspace, runtime-confirmed session reference, access mode and active selection. Pi continues to own session contents and credentials.
- Read session identity through supported runtime/Pi commands; resume through the existing jailed `/resume` path and preserve ownership enforcement.
- Restore multiple chats sequentially, honor runtime chat capacity, retain read-only access, and surface missing sessions/workspaces or lease conflicts without an automatic write override.
- Prevent initial empty startup state and late snapshot requests from overwriting the saved recovery set. Handle quit and unexpected runtime exit without silently losing the previous selection.
- Verify one/multiple chats, active selection, missing folder/file, conflicts, read-only attachment, empty/new chats, interrupted restore and retry in unit/integration tests and native restart journeys.

## Completion rule

Keep the goal active until every required feature, test, platform journey and distribution artifact above has direct current-state evidence. Record external blockers without relabeling missing capabilities as complete.

Implementation evidence: `desktop/src/session-restoration.mjs`, `desktop/src/main.mjs`, `tests/desktop-preview-shell.test.mjs`, and the September 7 daily log. Native development-shell restart restored two chats and their active read-only selection; missing file/folder references remained saved. This does not establish packaged or Windows acceptance.


## Packaged macOS recovery evidence

September 7 locally ad-hoc-signed artifact:
`/private/tmp/coop-desktop-restoration-20260907/mac-arm64/Coop Desktop Preview.app`.
Its 13 packaged source files match the worktree, and all eight audited Electron
fuses match the required states. Archive SHA-256:
`1cfc6660f80492aa76615135c372bd165ad5f17ddb9f5cc4374035cc07fd5597`.
The preview used the repo runtime through COOP_BIN and separate test user data;
this is not an installed managed release or production signing evidence.

- Runtime SIGKILL: native recovery prompt appeared; Restart runtime restored both
  chats, their access modes and the saved transcript.
- App SIGKILL: recorded seven associated processes before termination; none
  remained at the post-crash check. Relaunch restored both chats with the
  read-only chat selected. This observation is macOS-specific.
- Evidence logs and source/fuse manifest are under
  `/private/tmp/coop-desktop-home-20260907-state/`; daily log identifies names.
- Native Windows, managed-runtime isolation/migration, packaging/install/update
  and comprehensive accessibility/performance gates remain unproven.


## Managed profile continuity implementation

`desktop/src/managed-profile.mjs` selects a stable Desktop-owned profile using an
atomically published pointer. One legacy profile is adopted in place; multiple
profiles require explicit selection. Unit checks cover stable selection, adoption,
ambiguous selection, invalid/missing pointers and symlink rejection. This preserves
the storage path; it does not prove future Pi data-format compatibility or migrate
credentials.

A locally ad-hoc-signed managed macOS bundle launched with system-only PATH and no
installed-runtime override. Native restart revealed that Pi does not flush a newly
named empty session: the checkpoint now treats zero-message chats as new chats.
Their workspace/access can be restored; their unpersisted name is not retained.
The corrected bundle is `/private/tmp/coop-managed-profile-fixed-20260907/mac-arm64/Coop Desktop.app`.
Managed sign-in, real-model work, Windows installation, production signing and
update/rollback acceptance remain open. The earlier profile-test bundle had six
missing npm hashes; the subsequent integrity acceptance below supersedes that gap.

- Corrected managed native restart acceptance passed: named empty chat saved as
  `file: null`, relaunch with no workspace override restored one write-access chat
  in the correct folder, Ready, without Chat recovery failure. Quit completed
  cleanly. Evidence: `profile-fixed-launch.log`, `profile-fixed-restart.log`.


## npm integrity acquisition acceptance

The six Pi 0.84.3 shrinkwrapped dependencies omit hashes upstream. Preparation now
compares each exact resolved archive with all installed package files before
recording a SHA-512 checksum. It rejects file differences, extra files, unsafe
archive entries and partial updates without rewriting the lock on failure.

A disposable copy of the actual managed npm tree passed all six comparisons.
`/private/tmp/coop-managed-integrity-20260907` now contains 507 npm entries with
complete integrity, 101 Python distributions, and inventory SHA-256
`ac6a4b15d90f4f486a192bcd27653c34902dfa6fbd244a29a6f6b0a51adf578a`.
This proves checksum coverage for this acquisition, not clean-machine installation,
production signing, vulnerability clearance or future data-format compatibility.


## Managed first-run identity acceptance

`web/auth-service.mjs` now checks only the explicitly selected runtime profile.
A missing file cannot fall back to unrelated global Pi credentials; empty JSON,
unrelated providers and incomplete entries do not report successful OpenAI/Codex
sign-in. Malformed/unreadable storage produces a safe error without credential
values. The check recognizes stored Pi 0.84.3 credential shapes; it does not
validate provider acceptance or expiration by making a model request.

The locally ad-hoc-signed managed app at
`/private/tmp/coop-managed-auth-scope-app-20260907/mac-arm64/Coop Desktop.app`
launched with system-only PATH, no installed-runtime override and fresh user data.
Native Health showed model access unauthenticated, an enabled Sign in button and
profile-specific guidance, while independently retaining Microsoft account state.
The app quit cleanly. OAuth completion, API-key environment-based readiness and
a real model task from this fresh profile remain unproven.


## Model picker keyboard acceptance

The model picker now offers a focused setup action when empty, a focused retry
when loading fails, and an explicitly labeled filter. Model operations pin the
originating chat, suppress duplicate clicks and ignore stale selection results.
Focused behavioral tests cover these paths.

Native acceptance on `/private/tmp/coop-managed-picker-app-20260907/mac-arm64/Coop Desktop.app`:
opening an empty picker focused Set up model access; Enter opened Health; Escape
closed Health and returned focus to the model control; Enter reopened the picker
and refocused its setup button. App quit cleanly. The package verifier and local
ad-hoc signature verification passed. This is scoped macOS keyboard evidence,
not completion of all accessibility, Windows, or real-model setup requirements.


## Installer and post-use signature acceptance

Separate DMG/NSIS build commands now exist in `desktop/package.json`, using
`desktop/electron-builder-installer.cjs`. They retain managed runtime/fuse
configuration and never publish automatically. Windows setup preserves app data
on uninstall and does not auto-launch after completion; native Windows execution
is still required.

DMG verification exposed that Python rewrote signed cache files during runtime
use. Staging now strips Coop source bytecode caches, and both managed launchers
set PYTHONDONTWRITEBYTECODE=1. The corrected locally ad-hoc-signed app passed
codesign verification before and after native startup and Health inspection.

Accepted development DMG:
`/private/tmp/coop-installer-immutable-20260907/Coop-Desktop-0.0.1-mac-arm64.dmg`
(429127766 bytes). Disk checksum passed; mounted app signature passed; app ASAR,
runtime manifest and dependency inventory matched the tested source app; the
Applications shortcut was present and the removed source cache was absent.
The read-only volume was detached. Both full Bash/PowerShell suites passed.

This is a development installer artifact, not production signing/notarization or
an installed-app journey. Earlier `/private/tmp/coop-installer-acceptance-20260907`
artifact failed signature validation and must not be used. App icon, actual native
install/repair, Windows, and complete update/rollback wiring remain open.


## macOS development installation and relocation acceptance

Copied the accepted DMG app with `ditto` into
`/private/tmp/coop-install-journey-20260907/Applications/Coop Desktop.app`, then
ejected the source image before launch. The copied app's signature passed.
Launched with system-only PATH, no runtime/workspace override and new isolated
user data. Selected the smoke workspace through the native folder picker; the
app reached Ready and completed Health inspection (41 runtime checks).

Clean quit returned exit 0; all nine recorded descendant/app PIDs were absent at
the post-quit check. Navigation stored the workspace, one chat and profile-v1
selection. Relaunch without a workspace override restored the correct workspace
and write-access chat, Ready. A second clean quit returned exit 0. Signature
verification after both launches passed.

This proves a scoped DMG copy/eject/relocate/start/relaunch journey for a locally
ad-hoc-signed development app in a disposable Applications folder. It does not
prove production Gatekeeper/notarization, repair, Windows installation, or model
sign-in/work. No application in the real Applications folders was replaced.
Evidence: `/private/tmp/coop-desktop-home-20260907-state/install-copy-*`.
No source edits were needed, so existing passing suites were not rerun.


## Native app branding

- Reused the existing Coop/Cooptimize artwork in `themes/coop.ico`. Added
  `themes/coop.icns` using macOS native format conversion; PNG header and image
  data comparisons confirm the original 256-pixel artwork is unchanged.
- Application build configuration now specifies the macOS ICNS and Windows ICO.
  NSIS installer and uninstaller explicitly use the same Windows icon.
- Rebuilt `/private/tmp/coop-managed-branded-app-20260907/mac-arm64/Coop Desktop.app`.
  Its CFBundleIconFile resource matches the source ICNS byte-for-byte (SHA-256
  `dbad18c72cd01a9d30d2f14971016e90c75d925c6fe3951fbf0e8df6c5cba039`), and the
  build no longer emits a default Electron icon warning. Packaged verifier passed.
- Evidence: `/private/tmp/coop-desktop-home-20260907-state/icon-*`. Backup:
  `.backups/20260907_app_icon`. README updated. Full suites and branded DMG
  verification are pending at this entry. This is artwork reuse; native Windows
  installer rendering and production signing remain unverified.

- Final icon acceptance: branded DMG built at
  `/private/tmp/coop-installer-branded-20260907/Coop-Desktop-0.0.1-mac-arm64.dmg`.
  Disk checksum, mounted app signature and embedded-icon comparison passed.
  Read-only volume detached. Both full Bash/PowerShell suites passed.
  Existing native icon artwork is now integrated; Windows rendering, production
  signing, managed sign-in and update/rollback integration remain open.
  No application replacement, commit, push or release occurred.


## Update check/controller integration

Added `desktop/src/update-controller.mjs`: loads an optional fixed in-app feed,
bounds requests, denies redirects/credentials, verifies signed descriptors using
the existing pinned trust policy, handles same/older versions, deduplicates calls
and rechecks trust/expiry before verified artifact staging. Staged paths remain
in the main process. Download requests have a bounded timeout.

The native Help menu now exposes Check for Updates. It reports verified version
results or explicit unavailable state; unprovisioned builds make no update request.
Production feed/key resources are not supplied or invented. Download UI and
installer application/relaunch plus activation/rollback integration remain open.
The controller is not being counted as a complete working updater.

Eleven update-service tests pass, including actual ephemeral Ed25519 signatures,
verified downloaded bytes, tampering, limits, expiration, old versions, concurrent
checks and no-network unprovisioned behavior. Native packaged check on
`/private/tmp/coop-managed-update-check-app-20260907/mac-arm64/Coop Desktop.app`
showed the unavailable dialog, returned to a Ready workspace with one open chat,
and quit cleanly. Packaged source comparison and runtime/fuse verifier passed.


## Cancellable update download and staged recovery

- Native update results now offer Download/Later. Download has a cancellable
  native progress dialog and Dock/taskbar progress; existing sessions keep running.
  The verified result remains staged, with explicit wording that installation is
  not yet enabled. No production feed or key is provisioned.
- Added cancellation/progress to the verified download service, including complete
  handling of short filesystem writes and awaited final verification so failure
  cleanup also covers final verifier rejection. Partial files are removed.
- Only fully verified downloads get atomic `staged-update.json` metadata containing
  the exact signed bytes/signature and a confined file reference. Recovery verifies
  metadata signature/expiry/version and actual file checksum again. Corrupt or
  escaping recovery records are preserved and never accepted as installable.
- Quit cancels and awaits update cleanup, including when the runtime has already
  crashed. Added a regression for that shutdown path.
- Fifteen update-service tests pass: signed fixture download, restart recovery,
  tamper/expiry/path rejection, cancellation cleanup/retry, real native-handler
  logic with a dialog test double, and shutdown cleanup after runtime failure.
  This is synthetic signed-download evidence, not a production feed/installer test.
- Full suites/build checks are pending for the final shutdown adjustment. Evidence:
  `/private/tmp/coop-desktop-home-20260907-state/update-download-*`. Backups:
  `.backups/20260907_update_download`. README updated.
- Native installation/relaunch and activation/rollback wiring remain unfinished.
  No real update installed, release published, production signing, source commit
  or push. Goal remains active.

## Model credentials supplied through the runtime environment

- Fixed model-access readiness for a nonblank `OPENAI_API_KEY` in the actual
  child runtime environment. The HTTP route now supplies the same merged
  environment and resolved profile directory as the runtime. No key is returned
  to the renderer, diagnostics, or logs. This reports configured credentials;
  provider acceptance still requires a real model request.
- Baseline returned unauthenticated for an isolated profile with a fixture key.
  Seven focused auth-service tests now pass, including missing/blank/unrelated
  keys, profile isolation, and credential redaction. Added a bridge endpoint
  regression with a key present only in the launch spec. Full suites pending.
- Source: `web/auth-service.mjs`, `web/server.mjs`; tests:
  `tests/auth-service.test.mjs`, `tests/webbridge.test.mjs`. Backups:
  `.backups/model_environment_20260907_133357/`. Reviewed against repository
  guardrails and the bundled Pi environment-key mapping. No network model call
  or credential migration performed; the packaged app has not been rebuilt for
  this source change yet.
- Prior update-download verification is complete: final Bash and PowerShell
  suites passed. The prior final package's post-use signature check also passed.
  This supersedes the pending-test notes above. Update installation, restart,
  activation and rollback remain unfinished. No commit, push or release.

- Final validation for environment credentials: both full Bash and PowerShell
  suites passed, including the live localhost bridge endpoint regression. Bash
  syntax, paired-script parity and whitespace checks passed. Evidence:
  `/private/tmp/coop-desktop-home-20260907-state/model-env-bash.log` and
  `/private/tmp/coop-desktop-home-20260907-state/model-env-powershell.log`.
  Next: packaged fresh-profile real-model acceptance and update installation.
  The overall completion goal remains active.

## Packaged model-environment acceptance

- Restaged the current repo with the previously verified dependency bundle into
  `/private/tmp/coop-managed-model-env-20260907` and built
  `/private/tmp/coop-managed-model-env-app-20260907/mac-arm64/Coop Desktop.app`.
  The packaged auth service and server match current source byte-for-byte.
  Managed package/runtime inventory and Electron fuse verification passed.
- Two fresh isolated profiles used the actual packaged Pi/runtime with a
  system-only PATH. Without a key, the auth endpoint reported unauthenticated
  and Pi returned zero OpenAI models. With an offline fixture key, the endpoint
  reported configured credentials and Pi returned 38 OpenAI models. Neither
  profile saved credentials; neither sent a model request. This validates
  configuration/model enumeration, not provider acceptance or real coding work.
- Native launch used fresh user data and the disposable smoke workspace. The
  app reached Ready; Health showed model sign-in required and a Sign in action.
  Quit returned exit 0. Local ad-hoc signing only; production identity discovery
  disabled. No installation over the user's existing app, commit, push or release.
- Evidence: `/private/tmp/coop-desktop-home-20260907-state/model-env-stage.log`,
  `model-env-package.log`, `model-env-package-verification.json`,
  `model-env-packaged-smoke.mjs`, `model-env-packaged-smoke.log`,
  `model-env-native.log`, and `model-env-signature-after.log` in that directory.
  The preceding source slice's full Bash and PowerShell suites passed; no source
  edits in this packaging/acceptance slice. Repository workflow, guardrails and
  daily-log postcondition followed.
- Next: update installation/relaunch/rollback and actual fresh-profile model
  sign-in/task acceptance. Windows native acceptance and production distribution
  remain unproven. Overall goal stays active.

- Strict deep code-signature verification passed after native use (exit 0).

## Native macOS update candidate preparation

- Added `desktop/src/update-installer.mjs` and connected the main-process update
  controller's `prepare` operation. A verified staged/recovered download is
  required; descriptor trust and artifact hash are checked again. The helper
  verifies a private image snapshot, mounts read-only, checks app identity,
  Desktop/Coop versions, architecture, native signature and managed runtime,
  copies to a private candidate directory, rechecks it, detaches, and promotes
  the directory into the version store. It never replaces the running app.
- App traversal bounds entry count/bytes and rejects links escaping the app or
  unsupported file types. Native commands have bounded output/time, cancellation,
  and exit-aware cleanup. Failed detach preserves uncertain mount contents.
- Twenty-one update-service tests pass, including native-command failure and
  cancellation, recovery-to-preparation tampering, wrong app/runtime identity,
  bad signatures, escaping links, cancellation cleanup and detach failure.
  These injected command fixtures prove control flow; native evidence follows.
- Real macOS preparation passed using the previously accepted branded local DMG
  and an ephemeral test signing key in memory, with no feed/network access.
  Candidate: `/private/tmp/coop-update-prepare-native-20260907/local-preparation-001-S6Unno/Coop Desktop.app`.
  Mount was detached before success; no active installation replaced.
- Full PowerShell suite passed. Full Bash and candidate runtime smoke pending.
  Evidence directory: `/private/tmp/coop-desktop-home-20260907-state/`, files
  `update-prepare-focused.log`, `update-prepare-native.mjs`,
  `update-prepare-native.log`, `update-prepare-health.log`,
  `update-prepare-bash.log`, `update-prepare-powershell.log`,
  `update-prepare-parity.log`. Backups: `.backups/update_prepare_20260907_134600/`.
- Followed repository workflow/guardrails and daily logging. No commit, push,
  production signing or release. Preparation is not yet exposed as a UI action;
  installer replacement, restart, health-gated activation and rollback still
  need integration. Native Windows preparation and fresh-profile real-model
  work remain open. Goal remains active.

- Final preparation validation: both full Bash and PowerShell suites passed.
  Bash syntax, parity and whitespace checks passed. The copied candidate runtime
  started after image detach and passed the managed-runtime smoke (exit 0), then
  strict deep signature verification passed after use (exit 0). This supersedes
  pending checks above. Candidate was prepared only, not activated or installed.

## Recoverable macOS application replacement transaction

- Added `desktop/src/update-replacement.mjs`: a low-level, main/helper-process
  transaction requiring explicit stopped-runtime state, candidate validation and
  a health probe that stops before resolving. Candidate copying and validation
  precede same-filesystem renames. The original app is preserved adjacent to the
  installed app; successful transactions retain it, and failed health restores it.
- An atomically written, file-synced journal records directory device/inode
  identities. Recovery handles interruption before/after each rename, including
  a process killed during the health check. Paths are derived from the caller's
  known app location, never read from journal data. Unexpected directories,
  symlinks, malformed journals and live foreign helpers fail without overwriting
  unrelated data. This is process-interruption recovery, not power-loss proof.
- `tests/update-service.test.mjs`: 25 tests pass, including healthy replacement,
  failed health/copy/cancellation, retry, actual killed-helper recovery, both
  rename gaps and changed-destination/journal rejection. Full PowerShell passed;
  full Bash remains running. Syntax/parity and whitespace checks passed.
- Native acceptance used disposable copies of two existing locally signed
  development packages (both version 0.0.1, with different auth-service bytes).
  Forced health failure restored the original bytes/signature; retry replaced
  them with the newer source, started that installed runtime with an isolated
  profile and system-only PATH, verified its capability contract, stopped it,
  and passed post-use code-signature verification. No installed user app changed.
  Result: `/private/tmp/coop-replacement-native-20260907/Coop Desktop.app`;
  retained original: `.Coop Desktop.app.coop-update/previous.app` beside it.
- Evidence: `/private/tmp/coop-desktop-home-20260907-state/update-replace-native.mjs`,
  `update-replace-native.log`, `update-replace-focused.log`,
  `update-replace-bash.log`, `update-replace-powershell.log`,
  `update-replace-parity.log` in that directory. Backups:
  `.backups/update_replace_20260907_135802/`. Workflow/guardrails and daily
  logging followed; no commit, push, release or production signing.
- Integration remains open: a trusted external helper must connect signed
  preparation, actual Desktop/runtime shutdown, this replacement transaction,
  startup recovery and relaunch. It is not yet called from the user update UI.
  Adjacent native rollback backups differ from the old version-root-only state
  helpers; do not treat those unused helpers as already integrated. Native
  Windows and fresh-profile real-model task acceptance also remain open.
  Overall completion goal stays active.

- Final replacement validation: both full Bash and PowerShell suites passed
  (exit 0). Native forced rollback, healthy replacement and post-use signature
  checks passed. This supersedes the pending Bash note above. No Desktop update
  UI/helper/relaunch integration is claimed by this low-level transaction slice.

## Packaged update helper and Install and restart handoff

- Connected managed macOS Install and restart to `update-handoff.mjs` and a
  packaged `update-helper.mjs` over private Node IPC. The main process transfers
  only its already-pinned public trust policy and reverified signed download.
  The helper never reads replacement trust keys from user data/workspaces.
- Preparation completes before shutdown. Desktop checkpoints navigation, stops
  its runtime, and only then authorizes replacement. The helper independently
  waits for both original PIDs to exit, rechecks signature/expiry and the installed
  app identity/version, uses the replacement transaction, probes the installed
  runtime with a fresh profile, and relaunches the app. Restored failures also
  attempt to relaunch the prior signed app. No replacement occurs on cancellation.
- Managed packaging now includes the helper module dependency closure under
  Resources/update-helper. Both fixture/candidate helper copies match current
  source; package verifier passed. Development fixture version 0.0.0 is an
  isolated build override; repo version/release metadata was not bumped.
- 30 focused update tests and both final full Bash/PowerShell suites passed.
  Includes real Node IPC readiness/cancel/apply, trust serialization, late expiry,
  live-process wait rejection, native install progress logic, and checkpoint →
  runtime stop → apply ordering (failed stop cancels the helper). Syntax, parity
  and whitespace checks passed. `desktop/README.md` updated.
- Native journey uses locally ad-hoc-signed 0.0.0/0.0.1 fixture packages and an
  ephemeral public-key policy/signature; no feed/network download or production
  signing. An actual old runtime stopped and parent exited after the packaged
  helper reported ready. At this checkpoint helper PID 37063 was verified live;
  parent 36821 and runtime 36840 had completed the authorized shutdown.
  Receipt: `/private/tmp/coop-update-helper-journey-20260907/handoff.json`.
  Final helper result/relaunch still pending. Do not restart based on a stale
  receipt alone: inspect the specific helper PID and outcome file.
- Evidence: `/private/tmp/coop-desktop-home-20260907-state/update-helper-*`,
  user-data helper log/result under `/private/tmp/coop-update-helper-journey-20260907/userdata/`.
  Backups: `.backups/update_helper_20260907_141027/`. Source edits: main, controller,
  installer verifier extraction, helper/handoff modules, managed builder and
  update tests. Repository workflow/guardrails and daily logging followed.
- Remaining: full native-window health beyond the runtime probe; automatic cold
  recovery after a helper interruption; visible outcome/error reporting; native
  Windows; fresh-profile real model work; authoritative release provisioning.
  The current two-rename transaction has a recoverable missing-app gap if the
  helper dies between renames; its recovery routine needs an independently
  launchable entry point before claiming automatic interruption recovery.
  No commit, push or release. Overall goal stays active.

- Native handoff completed: helper PID 37063 exited, outcome is healthy 0.0.1,
  and LaunchServices started the updated app as PID 37468 with the intended
  user-data directory. Installed app archive version is 0.0.1; main and helper
  source match the current repo byte-for-byte. The retained previous app is under
  `/private/tmp/coop-update-helper-fixture-app-20260907/mac-arm64/.Coop Desktop.app.coop-update/previous.app`.
- Native visual verification is pending: CUA reported the Mac locked and automatic
  unlock failed. An asynchronous manual-unlock request is pending. Do not bypass
  the lock or claim a visually verified Ready window. The updated test app remains
  open for that check. This does not block independent code work on the remaining
  update/runtime requirements.

## Corrected packaging and native update outcomes

- Correction to the prior handoff evidence: a live app process plus the helper's
  runtime health probe did not prove native-window startup. The prior managed
  extraResources rule removed shared modules from app.asar, breaking main imports.
  The earlier package verifier did not check that dependency closure.
- Managed packaging now copies the helper in afterPack, retaining modules in both
  app.asar and Resources/update-helper. The stronger package verifier recursively
  checks relative static imports from main and the helper; it rejects the earlier
  broken artifact and passes the corrected build. Packaged main/helper/outcome
  modules match source byte-for-byte.
- Fixed outcome-file write failures that could prevent app relaunch. Added bounded
  one-time native success/failure dialogs after managed window load, with fixed
  copy, retry after dialog failure and preservation of newer results.
- Native acceptance with isolated user data and local ad-hoc signing: corrected
  build showed success, opened Ready workspace, showed fixed failure copy on a
  separate launch, consumed both dismissed receipts, and reopened Ready without
  repeated alerts. All three native sessions exited normally after Cmd+Q.
- Corrected app: /private/tmp/coop-update-outcome-fixed-app-20260907/mac-arm64/Coop Desktop.app.
  Profile: /private/tmp/coop-update-outcome-native-20260907/userdata.
  31 update tests and four managed-package checks passed. Final PowerShell passed;
  final Bash suite remains running at this checkpoint.
- Still open: interrupted replacement/cold recovery, full native-window health
  as part of the helper's activation decision, actual configured-feed native
  update journey with corrected packages, Windows, fresh managed-profile model
  work, and production release provisioning. Overall goal remains active.

- Final validation: both final full Bash and PowerShell suites passed (exit 0).
  Post-use strict deep signature verification also passed after all three native
  launches. Logs: /private/tmp/coop-desktop-home-20260907-state/update-outcome-*.

## Native-app update health gate

- Helper health now combines the runtime contract/version probe with a real
  packaged Electron app probe. Temporary user data prevents use of the user's
  profile. Main must receive renderer navigation startup through its trusted
  preload, complete chat get_state RPC, stop its runtime, acknowledge the random
  challenge and expected Desktop version, and exit cleanly.
- Native acceptance: the new ad-hoc-signed packaged app passed; the earlier
  broken package with missing main imports failed. Both probes completed and
  the current app retained a valid strict deep signature after use.
- 33 focused tests passed; actual child-process fixtures reject wrong challenge,
  version, crash, hang and cancellation, and verify process exit. Main ordering
  coverage rejects acknowledgement when runtime stop fails. Unix process-group
  fixtures are not represented as Windows acceptance.
- Current package: /private/tmp/coop-native-health-app-20260907/mac-arm64/Coop Desktop.app.
  Evidence: /private/tmp/coop-desktop-home-20260907-state/native-update-health-*.
  Full PowerShell, packaging, syntax and parity checks passed; final Bash status
  will be recorded below. Still open: interruption recovery, configured-feed
  native update journey, native Windows, managed real-model acceptance and
  authoritative production release provisioning. Goal remains active.

- Final native-health slice validation: full Bash and PowerShell suites passed
  (exit 0); 33 focused update tests passed after the platform guard. Package
  dependency/fuse verification, native positive/negative probes and post-use
  strict deep signature verification passed. No commit, push or release.

- Real local HTTPS acceptance passed using the public trust/feed resources
  extracted from the built old app archive: signed check reported available;
  cancellation removed the partial artifact; the complete 729270044-byte download
  verified; a new controller instance reverified the staged download after restart.
  Evidence: /private/tmp/coop-desktop-home-20260907-state/native-feed-controller.json.
- Native UI test is pending manual unlock: CUA explicitly reported the Mac locked
  and automatic unlock failed. An asynchronous unlock request is pending. Do not
  bypass the lock or count controller checks as native button acceptance.
- Old fixture main PID 31289 was confirmed running at the intended user-data path;
  its exec session is 42121. HTTPS server session 59308 remains live for the pending
  UI test (server PID/endpoint in /private/tmp/coop-native-feed-20260907/server.json).
  Signing key is in server memory; do not restart the server unless terminal state
  is confirmed because restart would require rebuilding the pinned old fixture.
- No repository source changed in this acceptance slice. Isolated build/package
  verification and strict deep signature checks passed. No commit/push/release.
  Goal remains active; interruption recovery and other independent work remain.

## Full configured-feed native update passed

- Operated Help → Check for Updates → Download → Install and restart in the
  packaged 0.0.0 fixture. Native offer showed 0.0.1 and 696 MB; download reported
  verified, preparation showed a cancellable dialog, and the old app exited 0.
- Helper PID 35248 completed replacement and both runtime/native UI health probes.
  Relaunched app PID 35995 displayed Update installed, then restored the same
  workspace with Ready status after Continue. This is native UI acceptance, not
  a controller-only or process-liveness inference.
- Authoritative disk evidence: installed CFBundleShortVersionString 0.0.1,
  retained previous.app 0.0.0, transaction phase healthy, dismissed outcome gone.
  Both installed and previous app passed post-use strict deep signature checks.
  Evidence: /private/tmp/coop-desktop-home-20260907-state/native-feed-completed.json.
- Test CA was added only to the copied fixture main via node:tls; production
  certificate validation and repo main were unchanged. The signed candidate
  remained immutable and predates the plain-logo asset request; current source
  and the separate plain-logo build retain the requested original logo.
- Closed upgraded app normally and confirmed PID gone. Stopped the exact local
  HTTPS server PID 31060; session 59308 exited 0. Removed its disposable TLS private
  key after shutdown. Ephemeral Ed25519 key disappeared with server memory.
  Do not resume these server handles; this acceptance is complete.
- No production signing, release configuration, installed user app, commit, push
  or release was changed. No source logic changed in this native acceptance slice.
  Still open: automatic interrupted-replacement recovery, native Windows,
  fresh managed-profile real-model acceptance and production release provisioning.
  Overall completion goal remains active.

## Atomic replacement and rollback verified

- New macOS transactions use native atomic directory exchange for activation and
  rollback. Bundled Python from the stable prepared release calls renamex_np with
  SWAP and NOFOLLOW_ANY; a missing/unsupported primitive cannot trigger a two-
  rename fallback. Version 2 journals handle original-app placement before and
  after backup filing, and interruption after rollback exchange. Legacy version 1
  recovery remains available for old transactions.
- Actual SIGKILL immediately after the native swap left the normal app path
  present; recovery restored the original. Native signed-app tests passed forced
  health failure/rollback and healthy activation with real native UI health.
  Installed version 0.0.1, retained previous 0.0.0; both signatures verified after
  use. This is stronger than simulated filesystem operations alone.
- 35 focused update tests passed; full PowerShell passed. Full Bash remains running
  at this checkpoint. Rebuilt package dependency checks passed, and atomic helper
  modules match source in both app.asar and helper resources. Local signing is
  being verified. Current plain-logo build: /private/tmp/coop-atomic-update-app-20260907.
- Evidence: atomic-swap-* under /private/tmp/coop-desktop-home-20260907-state/.
  Real-bundle transaction: /private/tmp/coop-atomic-swap-native-20260907.
- Automatic cold recovery still requires an independent startup/recovery entry
  point. A preserved path alone cannot repair a candidate whose main process
  cannot load. Windows and managed-profile real-model acceptance remain open.
  No commit, push or release; overall goal remains active.

- Final atomic-swap validation: full Bash and PowerShell suites passed (exit 0),
  as did 35 focused tests, package dependency checks and strict deep signature
  verification of the rebuilt plain-logo app. Native rollback/activation and
  immediate-SIGKILL recovery evidence passed. No remaining test handles are live
  from this slice; automatic cold-start recovery remains separate unfinished work.

## Independent recovery after updater crash passed

- Recovery job is now integrated before helper readiness. It retains a verified
  copy of the current app outside the replacement paths and registers a temporary
  per-user LaunchAgent. Cancellation/completed restart disarms it; an authorized
  interrupted update leaves it armed. No recovery keys come from user data.
- Native crash acceptance passed with a real LaunchAgent and real signed bundles:
  the fixture updater was SIGKILLed immediately after swapping in the known
  non-starting candidate. Without manually launching recovery, the independent
  worker restored version 0.0.0, set journal rolled-back, reopened the app with the
  failure message and reached the same Ready workspace after Continue.
- Agent label com.cooptimize.coop.desktop.recovery.004e0200-2909-400a-91f2-d02db9d722af
  removed itself, deleted its plist and marked its request finished. Recovered app
  was closed normally. Native process-cleanup checks also passed for an orphaned
  runtime group and a separate native-probe group.
- 37 focused tests and full Bash/PowerShell suites passed, with syntax/parity and
  package dependency verification. Native final signature checks are being
  completed. Main logic unchanged after those suites. Recovery-ready default
  0.0.1 build (plain logo) is building separately from the 0.0.0 crash fixture.
- Evidence: recovery-worker-* under /private/tmp/coop-desktop-home-20260907-state/.
  Actual reboot/login launch acceptance has not been performed; boot-ID handling
  is covered through controlled tests. Successful UI update with the new job
  integration, retention/pruning, Windows, fresh-profile model work and production
  release provisioning remain open. Overall goal stays active.

- Final recovery-worker validation: 37 focused tests and both full suites passed.
  Native automatic crash recovery, orphan runtime/native-probe cleanup, removal
  of the exact LaunchAgent and post-use worker/recovered-app signatures passed.
  Default 0.0.1 plain-logo package built and passed dependency/fuse verification;
  local package signature result is recorded by the final tool check.
- Follow-up hardening: prevent ordinary candidate startup while a transaction is
  pending; handle a helper crash after successful relaunch without leaving a busy
  recovery registration; prune completed diagnostic recovery copies safely.
  Physical reboot acceptance and successful native update with the newly armed
  recovery job still need evidence. No production install, commit, push or release.

## Pending startup and late recovery cleanup passed

- Ordinary startup during copying/ready/testing now defers before workspace,
  runtime or managed profile setup. Only the journal owner's direct health-probe
  child may start. The macOS auto-closing notice uses a parent window because
  unparented native dialogs ignore AbortSignal.
- Native packaged checks passed for automatic startup deferral and an authorized
  health probe in the same pending transaction. A real LaunchAgent then handled
  a simulated helper exit after rollback/relaunch: it verified the running app,
  disarmed and removed its plist while preserving the exact app PID. No duplicate
  update-result receipt or reopened window was created. Ready workspace observed
  before and after cleanup; the disposable session was closed normally.
- Evidence: recovery-notice-native-completed.json under
  /private/tmp/coop-desktop-home-20260907-state/. Plain Cooptimize logo retained.
  39 focused checks and full PowerShell passed; full Bash final result pending.
- Actual reboot/login acceptance, full successful native update with the newest
  recovery integration, retention/pruning, Windows acceptance, fresh-profile real
  model work and production provisioning remain open. No release performed.

- Final result: full Bash and PowerShell suites exited 0; 39 focused update tests,
  syntax/parity, whitespace, packaged dependency/fuse checks, and native startup /
  late recovery cleanup acceptance passed. Independent worker verified both its
  signed copy and the running app before disarming. Test GUI PID 15590 is gone
  after normal quit; the exact recovery LaunchAgent and plist are absent.

## Completed recovery storage cleanup verified

- Normal managed startup keeps the newest completed recovery bundle and removes
  older completed job directories only after confirming the saved LaunchAgent
  plist is absent, launchctl reports service-not-found, and pgrep reports no
  referencing processes. Unknown states and inspection failures preserve data.
- 41 focused tests passed, including pending/newest/busy/malformed/linked entries,
  revalidation after a state change, duplicate invocations, inspection failures
  and saved-plist protection. Native real-process and LaunchAgent lifecycle checks
  passed. Final rebuilt package passed dependency/fuse and strict deep signature
  verification; native startup removed an older completed fixture, retained the
  newest and reached the saved Ready workspace. Test app was closed normally.
- Full final PowerShell passed; final Bash is still running. Evidence prefix:
  /private/tmp/coop-desktop-home-20260907-state/recovery-retention-. Build:
  /private/tmp/coop-recovery-retention-app-20260907. Plain logo retained.
- This covers completed recovery copies. Incomplete preparation directories,
  downloaded/staged updates and adjacent transaction archives still require a
  separate retention policy. Full successful native update with current recovery
  integration, reboot/login and Windows acceptance, fresh-profile real model work
  and production provisioning remain open. No installed user app or release changed.

- Final retention validation: full Bash and PowerShell suites exited 0 after the
  saved-plist guard. All 41 focused update tests, native live/registered/saved-job
  safeguards, final packaged startup, signature/package and syntax/parity checks
  passed. Disposable GUI PID 61973 exited normally and test LaunchAgent was
  removed. No known active handles remain from this slice. Goal remains active.

## Current packaged updater successful activation passed

- Actual packaged helper/Node IPC, verified signed DMG preparation, real old
  bundled runtime shutdown, recovery LaunchAgent registration, atomic replacement,
  default runtime/native health probes and automatic reopening passed together.
  Installed app is 0.0.1; adjacent rollback app is 0.0.0. Both strict deep signatures
  passed after use. The recovery request is finished, exact service/plist absent,
  original parent/runtime/helper gone, and reopened test GUI closed normally.
- Plain Cooptimize icon byte equality passed. Native Ready workspace observed.
  This fixture initiated helper IPC directly; it does not replace the earlier
  native Help-menu/download UI acceptance. Success-dialog presentation was not
  observed in this run (receipt already consumed on first inspection).
- Evidence: /private/tmp/coop-desktop-home-20260907-state/current-update-native-completed.json
  and current-update-verification.log. No source changes since the passing 41-test,
  full Bash/PowerShell retention checks. No user installation or release changed.
- Remaining: actual reboot/login acceptance; incomplete preparation/download/archive
  retention; Windows implementation/acceptance and final capability/journey evidence;
  fresh managed-profile real model work; production feed/signing/notarization and
  release provisioning. Overall goal remains active.

## Prepared-copy cleanup packaged acceptance passed

- Verified committed source a5dc57e05c361862bcda8c5dcd1b52b95701e577 using
  disposable packaged 0.0.0 and 0.0.1 apps. Both package/resource/fuse verifiers
  passed before the update; the signed local DMG was authenticated by an ephemeral
  test descriptor. Production signing and release publication were not involved.
- Actual helper IPC prepared the candidate and armed a real recovery LaunchAgent,
  then the old runtime and fixture parent exited. Atomic activation reached healthy
  after the default runtime and native-window probes. The reopened app displayed
  “Update installed — Coop Desktop 0.0.1 is ready”; Continue opened the saved Ready
  workspace. The disposable app was then closed normally.
- The one recorded prepared release directory was removed. Installed 0.0.1 and
  adjacent rollback 0.0.0 remained and passed strict deep signature checks after
  use. The original DMG remained and passed its signed SHA-256/size check. The plain
  Cooptimize icon matched source bytes. The recovery request finished, its exact
  service and plist were absent, and parent/runtime/helper/reopened app PIDs exited.
- Evidence: /private/tmp/coop-desktop-home-20260907-state/prepared-cleanup-native-completed.json
  and prepared-cleanup-verification.log (exit 0). This validates the committed
  cleanup implementation through packaged helper IPC, not the download-menu flow.
  Existing 42 focused tests and full Bash/PowerShell suites apply to unchanged code.
- Runtime/native health profiles remain; this result does not establish general
  cache, orphan preparation, download or transaction-archive retention. Native
  Windows work, real reboot/login acceptance, fresh managed-profile model work,
  companion-source packaging and production provisioning remain open.

## Development companion wheel packaging verified

- Added scripts/build-development-wheels.py and config/development-companions.json
  to build wheels from exact committed Git archives, excluding working-tree edits.
  Explicit --pins supports later committed validation fixes. Output is fresh and
  records each companion repository, full revision, filename and SHA-256.
- prepare-managed-runtime.mjs accepts --development-wheels, authenticates private
  snapshots and passes both the exact release-version constraint and hash-bearing
  wheel URL to pip. Installed metadata/archive receipts must match before a source
  marker is written. Dependency inventory generation validates and retains that
  provenance; its schema and the packaged helper dependency closure were updated.
  Package verification reports developmentSources. Published acquisition remains
  the default. Version numbers and production release configuration are unchanged.
- Built all three pinned development wheels, installed them with the managed
  Python interpreter, and staged a fresh runtime using existing verified Node/npm/
  Python base inputs and unchanged published Fabric roots. This exercised the new
  installation/staging path, not a new download of every platform dependency.
- Packaged payloads matched all wheel code/data bytes: data-doc 47 files, SQL 54,
  DAX 61. Targeted companion tests ran under the packaged Python against packaged
  modules (76 data-doc, 13 SQL, 16 DAX passed), with copied test fixtures and no
  source checkout import fallback. Native managed startup, Ready workspace, normal
  quit, post-use strict signature and plain-logo byte equality checks passed.
- Six preparation checks and twelve managed-runtime checks passed, covering hash
  tampering, wrong pins, duplicates, unsafe provenance and mismatched install
  receipts. Full Bash and PowerShell, syntax/parity and whitespace checks passed
  with exit 0. Evidence prefix development-wheels- under
  /private/tmp/coop-desktop-home-20260907-state/. Native payload/process receipt:
  development-wheels-payload-evidence.json. Test app/runtime PIDs 22006/22040 exited.
- Updated desktop/README.md and the Windows handoff with build commands and the
  difference between development source provenance and published versions. Native
  Windows validation remains required. Full preparer acquisition on a fresh worker,
  transitive resolution reproducibility, fresh-profile model work, remaining update
  retention/reboot checks and production provisioning remain open. No release.

## Fresh-profile sign-in failure reproduced and corrected

- Native setup in the packaged development app reached Choose model / Set up model
  access / Health / Sign in. Computer Use rejected Terminal access, so Aaron
  completed the terminal step manually and reported the actual failure: the
  login-only process attempted to acquire Desktop's existing workspace write lease
  and exited before authentication. No concurrent-write override was requested.
- Native model-login launchers now attach read-only on macOS and Windows (and the
  fallback terminal path), retaining the selected managed profile. A regression
  exercises the real guardrail handlers with an active writer: login remains alive,
  workspace mutations stay blocked, and the original lease remains held afterward.
- Login-only completion now fingerprints only a complete, unexpired Codex OAuth
  record and waits for it to differ from the record present at startup. Empty,
  malformed, unrelated, expired and pre-existing credentials no longer count as a
  successful new login. Credential values are not logged. Added readiness/lifecycle
  checks and fixed native launcher assertions; the former macOS launcher assertion
  failed before the fix. 78 guardrail and 17 shell tests passed, plus login checks.
- Fresh model controls now say Choose model instead of unknown/model ellipsis and
  clear stale model tooltips. Native rebuilt UI confirmed the label and restored
  Ready workspace. The candidate runtime is an APFS clone of the verified
  development runtime with the three changed runtime source files overlaid; exact
  packaged equality of those files and native-terminal.mjs passed. Package/fuse,
  strict signature and full PowerShell checks passed; the subsequent full Bash
  run also completed with exit 0.
- Reopened the fixed packaged app using the same disposable profile, then invoked
  its Sign in action. Aaron was asked to complete the new terminal/browser flow.
  Aaron subsequently reported Succeeded; native Health confirmed authentication.
  The real-model acceptance results are recorded below. Existing user workspaces
  were not changed.
- Source changes: desktop/src/native-terminal.mjs, extensions/coop-tools/index.ts,
  web/public/app.js and index.html; tests and desktop/README.md updated. Backups:
  .backups/model_setup_20260907/. Evidence prefix model-login-lease- under
  /private/tmp/coop-desktop-home-20260907-state/. Fixed test app:
  /private/tmp/coop-model-login-lease-app-20260907/mac-arm64/Coop Desktop.app.

## Authenticated model work and availability refresh verified

- After successful native sign-in, the running Pi process retained its pre-login
  model availability snapshot. Added coop-refresh-models using the public model
  registry refresh API with network disabled. The HTTP model-list adapter checks
  command registration, awaits refresh, then reads models; older runtimes never
  receive an unknown slash command as a model prompt. Refresh failures propagate.
- Real Pi 0.84.3 SDK and actual packaged HTTP integration both verified external
  credential changes without an agent restart. The HTTP fixture used a disposable
  profile and synthetic API key, discovered 38 OpenAI models after an initially
  empty listing, and verified zero user/assistant messages through session stats.
  No model request was made by that fixture. Earlier fixture attempts failed due
  to a missing CSRF header and use of an intentionally unsupported get_messages
  HTTP command; both harness errors were corrected before the passing run.
- In the native packaged app, the authenticated GPT-5.5 session created
  name_tools.py and test_name_tools.py in the disposable workspace and ran four
  passing unittest cases. Independent execution with bundled Python also passed
  all four tests. Tests cover trimming, blank removal, case-insensitive deduplication,
  order preservation and rejection of non-string values.
- Native Stop acceptance passed on a repeated 90-second Python wait: the tool was
  visibly running, its actual process PID 12496 was observed at 14 seconds, then
  clicking Stop returned the UI to Ready, marked the tool interrupted and removed
  that process. An earlier wait completed normally and is not counted as Stop
  evidence. The authenticated test profile is retained; no credentials were copied
  or printed.
- The final code passed full Bash and PowerShell suites (both observed exit 0),
  including 78 guardrail checks, 17 shell checks, model-login lifecycle checks and
  eight RPC adapter checks. Evidence is under
  /private/tmp/coop-desktop-home-20260907-state/: model-login-refresh-bash.log,
  model-login-refresh-powershell.log, model-refresh-http-evidence.json and
  model-login-refresh-package-verification.json. Backups remain under
  .backups/model_setup_20260907/.
- Native Windows installer/runtime and sign-in acceptance remain pending. The
  native footer also displayed an inconsistent usage-window reset label during
  this run; this is recorded for follow-up and is not treated as verified quota
  information. Remaining release/provisioning and reboot/retention work is still
  open. No release, tag, version bump or production signing was performed.
- Final post-use strict signature verification passed. All five changed runtime
  sources and the native terminal module matched the tested package byte for byte;
  its icon matched the original plain Cooptimize logo. Syntax, parity and whitespace
  checks passed. Native evidence: model-native-work-evidence.json and
  model-login-final-source-equality.json in the same evidence directory.

## Provider usage window correction

- Investigation traced the native 5h label paired with a multi-day reset to pinned
  pi-better-openai 0.1.22: its parser hard-codes primary/secondary as 5h/7d and
  discards the provider's actual duration. The npm registry still reports 0.1.22
  as current. OpenAI's own client maps limit_window_seconds from each window:
  https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs .
- Added an exact-source compatibility correction in lib/openai-usage-compat.mjs,
  applied by both sync scripts and managed staging. It rejects unknown versions,
  modified input, symlinks and non-files; repeated application is idempotent.
  Managed staging changes only its fresh output copy and records original/corrected
  hashes in coop-compatibility.json; the package verifier checks that receipt.
  The dependency's original auth/fetch/model-scope owner remains in place.
- Desktop now parses variable-duration usage labels, clears absent/unknown bars,
  consumes automatic extension status/replay, clears quota state on chat switches
  and no longer sends periodic slash-command prompts. Registered the parser route.
- Five focused tests reproduce the upstream weekly-primary defect, then verify
  corrected percentages/reset labels, custom/unknown durations, missing quota,
  Spark selection, countdown aging, patch provenance/idempotence/rejection and
  meter clearing. Real upstream usage.ts is retained only as an MIT-licensed test
  fixture. Package and sync test fixtures now include that source; reconnect
  coverage verifies quota clearing before replay.
- Created a separate APFS-cloned test app at
  /private/tmp/coop-usage-windows-app-20260907/mac-arm64/Coop Desktop.app with the
  corrected dependency and renderer. Ad-hoc signing, strict verification and the
  package/fuse/compatibility verifier passed. The prior authenticated app/profile
  was preserved. Native visual acceptance is pending because Computer Use reports
  the Mac is locked; Aaron was asked to unlock it. No workaround screen access was
  attempted. Full Bash/PowerShell and isolated packaged HTTP checks are in progress.
- Backups: .backups/usage_windows_20260907/. Evidence prefix usage-windows- in
  /private/tmp/coop-desktop-home-20260907-state/. README documents the correction
  and how it differs from acquired npm archive integrity. Existing release,
  Windows and broader journey requirements remain open; no release performed.

### Usage correction acceptance results

- Aaron unlocked the Mac. Quit the original test app through its native menu and
  launched the separate corrected app with the same managed profile/workspace.
  Native accessibility and screenshot inspection confirmed a 7d header meter and
  matching 7d reset label in the footer, Ready status, preserved GPT-5.5 selection
  and restored prior conversation. No new model task was submitted for this check.
  Exact equality of eight overlaid runtime source files and the original plain
  logo passed, as did post-use strict code-signature verification. Evidence:
  usage-windows-native-evidence.json and usage-windows-package-verification.json.
- Final full Bash and PowerShell suites both completed with exit 0. ShellCheck,
  Bash/JavaScript syntax, script parity/BOM and whitespace checks passed. Logs:
  usage-windows-bash.log, usage-windows-powershell.log,
  usage-windows-shellcheck.log and usage-windows-parity.log. Earlier suite failures
  exposed incomplete staged dependency fixtures, a missing reconnect test stub and
  a runtime test whose inherited home/PATH selected a pre-existing August 21 fake
  ~/.local/bin/pi. The runtime lifecycle test now isolates HOME and pins its stub
  path. That unrelated machine-local launcher was not modified.
- An additional exploratory HTTP fixture using synthetic OAuth data did not pass:
  its NODE_OPTIONS fetch replacement loaded but did not intercept the extension's
  actual quota request, which returned 401 for the synthetic token. This fixture
  is not credited as offline integration evidence, nor as a product authentication
  failure. No real credentials were read or copied by it; no model generation was
  requested. The production acceptance evidence is the authenticated native app,
  plus the deterministic parser/formatter and staging/sync tests. Diagnostic log:
  usage-windows-http.log. A reliably intercepted HTTP fixture remains follow-up.
- The authenticated native test app remains open for use. Source is prepared for
  the already-authorized commit/push; no release, tag or version bump. Windows
  native acceptance, additional model-specific quota bucket coverage and the
  previously listed broader completion requirements remain outstanding.

## Native fork/clone acceptance and transcript replay correction

- The packaged Clone action created a new session ID with identical branch entries
  and retained the original session byte for byte. Native inspection nevertheless
  exposed a renderer regression: the RPC backfill discarded reasoning, tool args
  and results, and displayed the interrupted tool with a success mark.
- Added web/transcript-replay.mjs to project Pi's public active-branch messages into
  rich replay events. It associates tool results with tool calls, retains order,
  arguments/output/error state, and preserves existing reasoning/output limits.
  Missing results are explicitly incomplete; both file replay and the legacy
  text-event renderer now avoid claiming success without recorded evidence.
  Existing file-based History branch-selection heuristics are unchanged.
- A real bridge regression failed before the fix on the discarded aborted result
  and passed afterward. All 277 bridge checks and eight runtime-domain checks
  passed, including malformed blocks, Unicode separators, size limits and input
  immutability. Full Bash/PowerShell regression runs were started afterward.
- Built a separate APFS-cloned disposable app at
  /private/tmp/coop-session-replay-app-20260907/mac-arm64/Coop Desktop.app,
  overlaying server, renderer and projection module. Ad-hoc signing, strict
  verification and package/fuse/compatibility checks passed. The native Clone
  action now retained the thinking disclosures, failure mark, command arguments
  and Command aborted output. The fixed clone had an independent ID and every
  original entry matched exactly.
- Native Fork from the final user prompt created a third distinct session ID and
  exactly the entries preceding that prompt. The selected prompt appeared in the
  composer without being submitted. Original and fixed clone remained byte for
  byte unchanged. Cleared that disposable draft and used native History to restore
  the original session; persisted Desktop state confirmed the original file.
  No model generation or workspace file edits were needed for this acceptance.
- Evidence: session-branch-evidence.json, session-branch-original.jsonl,
  session-replay-before.log, session-replay-after.log and
  session-replay-package-verification.json under
  /private/tmp/coop-desktop-home-20260907-state/. Session fixture copies contain
  only the authorized disposable acceptance conversation, not credentials.
  Backups: .backups/session_replay_20260907/. Updated web/README.md to describe
  replay fidelity and the already-shipped usage-status behavior accurately.
- Native Windows branching and remaining named release/quality/journey requirements
  are still open. No formal final-artifact parity status was promoted from this
  development build, and no release, tag or version bump was performed.
- Final full Bash and PowerShell suites completed with observed exit 0. Syntax,
  parity/BOM and whitespace checks passed. Post-use strict signature verification,
  exact equality of the three changed runtime sources and original-logo equality
  passed. Final suite logs: session-replay-bash.log and
  session-replay-powershell.log in the evidence directory. The corrected native app
  remains open on the restored original conversation.

## History restores Pi's selected branch

- The remaining History branch-selection heuristic was reproduced with an
  abandoned branch dated in 2099 and Pi selecting the original branch. The bridge
  displayed the abandoned answer because it chose the highest timestamp.
  The regression failed before the change and passed after it.
- History now asks Pi's public get_entries RPC for its active leaf, using the last
  known file entry as the since cursor to avoid copying the whole tree. It retains
  detailed file history, incorporates entries appended during startup and follows
  parent links to Pi's selected entry. A null leaf means an empty conversation;
  unknown, duplicate, cyclic or dangling chains fall back to public active-branch
  messages. Timestamps no longer determine branch selection.
- Added selectSessionChain to web/transcript-replay.mjs, wired the asynchronous
  selection into web/server.mjs, and updated the bridge stub/fixtures and domain
  tests. All 278 focused bridge checks and nine domain checks passed. Existing
  compaction markers, thinking, tool arguments/results and output limits remain
  covered. web/README.md now describes authoritative branch selection.
- Created an isolated named session fixture beside the existing disposable test
  sessions, retaining an original selected branch and adding a future-dated
  alternate. Real Pi 0.84.3 SessionManager.open/getLeafId/getBranch verified the
  expected older selected leaf and excluded the alternate. No model generation or
  credential access was needed. Receipt: history-branch-native-evidence.json in
  /private/tmp/coop-desktop-home-20260907-state/.
- Native visual comparison is pending: Computer Use reported the Mac locked again,
  and Aaron was asked to unlock it while independent checks continued. A separate
  test app is being prepared at
  /private/tmp/coop-history-branch-app-20260907/mac-arm64/Coop Desktop.app. Full
  Bash/PowerShell suites are running. Backups: .backups/history_branch_20260907/.
  Evidence prefix history-branch- in the same evidence directory. Windows and the
  full named completion/release matrix remain open; no release performed.

- Final verification: the full Bash suite completed with observed exit 0 and
  `all tests passed`; PowerShell also completed with exit 0. Syntax, parity/BOM
  and whitespace checks passed. Logs: history-branch-bash.log,
  history-branch-powershell.log and history-branch-parity.log in the evidence folder.
- The separate corrected app was built, ad-hoc signed and passed strict signature
  and package verification (history-branch-package-verification.json). Its actual
  managed runtime passed an HTTP History acceptance check in a fresh isolated
  profile: selected leaf 869717ea matched Pi, the original answer and aborted tool
  evidence remained visible in replay, and the future-dated alternate was absent.
  Receipt: history-branch-http-evidence.json; fixture: history-branch-http.mjs;
  output: history-branch-http.log. The runtime stopped and the test exited 0.
  No credentials were copied and no model generation was requested.
- Aaron reported the Mac unlocked, but Computer Use still returned a locked-Mac
  result on the subsequent attempt. Native visual acceptance remains pending;
  no screenshot or visual pass is claimed. The previous native app remains open.
  Next: visually confirm the corrected History fixture when UI access returns,
  restore the original disposable conversation, and continue Windows acceptance.

## Runtime shutdown confirms process termination

- A real-process regression reproduced a startup leak: malformed readiness output
  caused startCoopRuntime to reject immediately after SIGTERM, leaving a runtime
  that ignored that signal alive. Startup timeout had the same cleanup path.
- desktop/src/runtime-supervisor.mjs now observes the child's close event from
  spawn onward. Failed startup waits for shutdown, escalates to SIGKILL when
  needed and preserves the original startup error after confirmed cleanup.
  An unconfirmed shutdown produces an explicit error rather than reporting success.
  Concurrent stop calls share the in-flight operation; completed calls are safe
  to repeat. Expected shutdown still suppresses the unexpected-exit callback.
- tests/desktop-preview-shell.test.mjs adds real-process malformed/timeout and
  concurrent-stop checks. The first regression failed before the implementation;
  all 19 focused shell checks passed afterward. PowerShell completed with exit 0;
  Bash regression remains running. Syntax, parity/BOM and whitespace checks passed.
- Built a separate managed app at
  /private/tmp/coop-runtime-shutdown-app-20260907/mac-arm64/Coop Desktop.app.
  Ad-hoc signing, strict deep signature and package/fuse verification passed.
  Source and helper closure both contain the corrected supervisor. Packaged managed
  runtime acceptance is running in an isolated profile without copying credentials
  or requesting model generation. Native visual checks remain pending locked UI.
- Evidence prefix: /private/tmp/coop-desktop-home-20260907-state/runtime-shutdown-.
  Before-edit backups are in .backups/runtime_shutdown_20260907_*/.
  This change confirms the owned child process closes; it does not establish
  native Windows acceptance or a general orphan-descendant/retention policy.
  Next: finish full Bash and packaged runtime checks, then commit/push under the
  existing source-sharing authorization. No release or version bump performed.

- Packaged acceptance completed with exit 0 using the shipped update-helper copy
  and bundled Node. Real runtime PID 7672 returned authenticated capabilities
  (contract 1, Pi 0.84.3), then two concurrent stop calls awaited close; both child
  and advertised runtime PIDs were verified absent. Receipt:
  runtime-shutdown-managed-evidence.json; script/log: runtime-shutdown-managed.*.
- A controlled non-exiting child check against that packaged module confirmed
  shutdown rejects after failed escalation, then retries the same child and
  resolves only after its close event. Evidence: runtime-shutdown-unconfirmed.*.
  The ASAR supervisor and helper supervisor both equal current source bytes;
  bundled Cooptimize icon equals original artwork. Native UI remains unverified.

- Final full Bash suite completed with observed exit 0 and all tests passed,
  including the two new shutdown regressions. Full PowerShell, syntax/parity/BOM,
  whitespace and post-use strict package signature checks passed. No test process
  handles remain active from this slice. The prior native test app/profile was
  left intact; the corrected package is available for the pending visual check.

## Successful health probes dispose of their temporary profiles

- The native health regression failed because successful probes left temporary
  user data behind. Added desktop/src/update-health-profile.mjs to own only the
  directory created by the current probe and verify parent/profile device and
  inode before disposal. Replaced or linked paths and cleanup errors preserve data.
  Contained symlinks are removed without deleting their external targets.
- Runtime health removes its profile only after both matching authenticated
  capabilities and confirmed runtime shutdown. Start/fetch/version/stop failures
  retain diagnostic data. Native health additionally waits for its detached probe
  process group to disappear after the matching challenge, version and clean exit.
  Unknown or still-live groups preserve the profile. No older profile sweep occurs.
- Updated update-helper.mjs and update-native-health.mjs; package helper discovery
  includes the new update-prefixed module. desktop/README.md documents the policy.
  All 45 focused update checks passed, including real native process modes,
  busy/exited process groups, runtime failure modes and directory replacement.
  Full PowerShell exited 0; syntax, parity/BOM and whitespace checks passed.
  Full Bash and rebuilt package acceptance are running.
- Test package: /private/tmp/coop-health-profiles-app-20260907/mac-arm64/Coop Desktop.app.
  Evidence prefix: /private/tmp/coop-desktop-home-20260907-state/health-profiles-.
  Backups: .backups/health_profiles_20260907_*/. Tests use isolated disposable
  profiles; no existing user profile or credentials are copied or cleaned up.
  This closes successful-probe storage cleanup, not failed-probe retention,
  preparation/download/archive pruning, Windows or final release acceptance.

- Packaged acceptance exited 0. The shipped helper's real runtime health check
  passed and removed its profile; an intentionally wrong Coop version failed and
  kept its separate diagnostic profile. The real Electron native health probe
  passed renderer/chat readiness and shutdown, then removed its temporary user data.
  Runtime PIDs 27854/28056 and native PID 28348 were absent; the native process
  group was also absent. Receipt: health-profiles-managed-evidence.json; script
  and output: health-profiles-managed.mjs/.log in the evidence directory.
- This was automated native acceptance with an isolated home/workspace, not a
  screenshot or visual check. No model generation or credential copying occurred.
  Package verification passed; the three changed modules match source in both
  app.asar and the helper closure, and original-logo byte equality passed.
  Asked for the current Windows VM acceptance result while full Bash continued.

- Final Bash suite completed with observed exit 0 and all tests passed, including
  all 45 update checks. PowerShell, syntax/parity/BOM, whitespace and post-use strict
  signature checks passed. Test processes from this slice have exited. The prior
  user-facing test app/profile remains intact. Native visual checks, Windows,
  remaining retention categories and final release provisioning remain open.

## Fresh acquisition exposed and fixed npm dependency drift

- Ran the complete target-worker preparer with fresh Node/Python archive downloads,
  a new npm cache and pip caching disabled. It finished with exit 0 and staged a
  runnable darwin-arm64 managed bundle at /private/tmp/coop-fresh-acquisition-20260907/managed-runtime.
  Authenticated runtime smoke passed. The npm inventory had 508 hashed entries,
  seven version changes and one added entry relative to the previously validated
  507-entry bundle; all 101 Python distribution entries and companion provenance
  matched. Fresh acquisition worked, but npm resolution was demonstrably floating.
- Changes were @clack/core 1.4.3 to 1.5.0, @clack/prompts 1.7.0 to 1.8.0,
  @colors/colors 1.6.0 to 1.6.1, @dabh/diagnostics 2.0.8 to 2.0.9,
  @types/node 26.4.1 to 26.5.0, typebox 1.3.27 to 1.3.28 and undici-types
  8.3.0 to 8.9.0, plus nested logform/@colors/colors 1.6.0.
- Added per-target npm locks seeded from the tested baseline, including observed
  platform-specific optional packages. scripts/managed-npm-lock.mjs validates
  release-manifest alignment, HTTPS archive hashes and safe entry paths, writes
  fresh npm inputs and reconciles installed versions/URLs/integrities against the
  frozen lock. prepare-managed-runtime now uses npm ci, completes omitted upstream
  shrinkwrap integrity by archive comparison, then rejects resolution drift.
  Completion receipts include the committed lock digest. No automatic lock refresh.
- Windows lock generation found the manifest's Power BI Desktop Bridge 0.0.1 pin
  does not exist in npm. Registry metadata and Microsoft's published package list
  show 0.1.0/0.1.1/0.1.2; corrected the dependency pin to published 0.1.2 (Node >=20,
  existing powerbi-desktop executable). Sources:
  https://www.npmjs.com/package/@microsoft/powerbi-desktop-bridge-cli
  https://github.com/microsoft/skills-for-fabric/blob/main/skills/powerbi-report-authoring/references/powerbi-desktop.md
  This changes a dependency pin, not the Coop/Desktop application version or release.
- Cross-target npm ci with lifecycle scripts disabled installed and reconciled
  507 macOS arm64, 502 macOS x64 and 503 Windows x64 package entries on this Mac.
  Windows and Intel native execution remain unverified. Eight focused preparation
  tests passed, including manifest mismatch, missing hash, unsafe URL/path, changed
  package/version/hash, missing required entries and modified input-lock rejection.
  Full Bash/PowerShell, syntax/parity and a second full fresh preparation using the
  frozen locks are running. desktop/README.md documents behavior and limits.
- Evidence prefix /private/tmp/coop-desktop-home-20260907-state/fresh-acquisition-,
  npm-lock- and locked-acquisition-. Backups: .backups/npm_resolution_20260907_*/.
  Python transitive hash/version locks, native Windows/Intel acceptance and final
  release provisioning remain open. No existing installation/profile was changed.

- The second complete fresh preparation, now using the committed npm lock, exited
  0 and exactly reproduced the previous dependency inventory, including its SHA-256
  7a17efaf710facff19073967a885c93ae0c061d32d88ad8660a17d540a945976:
  507 npm entries with complete integrity and 101 Python distributions. npm lock
  digest 183a9300951088bef0d99eb6f9181c459f0fb91bd87476386f4e1c6746a62558.
  The new bundle is /private/tmp/coop-locked-acquisition-20260907/managed-runtime.
  Authenticated managed-runtime smoke passed and shutdown completed with exit 0.
- Full Bash and PowerShell suites completed with observed exit 0. Syntax,
  parity/BOM and whitespace checks passed. The corrected published Windows bridge
  CLI also returned version 0.1.2 via its actual entrypoint on macOS; that is not
  evidence of connectivity to Power BI Desktop or native Windows execution.
- Built /private/tmp/coop-locked-acquisition-20260907/desktop/mac-arm64/Coop Desktop.app
  from the freshly acquired locked bundle. Ad-hoc signing/package verification
  and an isolated automated native startup/shutdown check are in progress.
  Native visual review and Windows acceptance remain pending; Python transitive
  resolution currently matched but is not yet protected by a committed hash lock.

- Final fresh-package acceptance passed: native PID 68145 reached renderer/chat
  readiness, exited cleanly, and its process group and temporary profile were gone.
  No credentials were copied and no model generation was requested. Receipt:
  locked-acquisition-native-evidence.json in the evidence directory. This is an
  automated native check, not visual acceptance. Package/fuse and post-use strict
  deep signature checks passed; packaged preparer modules, all target locks,
  corrected release manifest, active npm lock and original logo equal source bytes.
  All acquisition, suite, smoke, package and probe handles from this slice exited.
  The existing user-facing test app and authenticated profile remain intact.


## Python dependency locks and fresh package verification

- Added scripts/managed-python-lock.mjs and target resolutions in
  config/managed-python/{darwin-arm64,darwin-x64,win32-x64}.json. Each locks all
  101 distribution entries across the five isolated tool environments. Locks
  validate against the release manifest before acquisition. Pip requires archive
  hashes and exact requirements; post-install reconciliation rejects package,
  version, hash, URL or installed metadata drift. Authenticated companion wheels
  retain their release-version constraint and provenance hash.
- Resolutions were generated with uv 0.11.7 targeting CPython 3.12.14, constrained
  to the previously validated package versions. uv is a lock-generation tool,
  not a new runtime or preparer prerequisite. No package versions were downgraded.
- Intel macOS cannot use a cryptography 50.0.1 wheel: upstream removed Intel wheel
  support in 49.0.0. The Intel lock explicitly permits only cryptography source
  builds in the ms-fabric-cli and fabric-cicd environments. Native compilation,
  build-toolchain and build-dependency locking remain open. This is not evidence
  of reproducible or working Intel builds. Source:
  https://cryptography.io/en/49.0.0/changelog/
- The complete preparer ran with fresh archive downloads/npm cache and pip cache
  disabled, using the authenticated development companion wheels. It passed and
  exactly reproduced the tested 507-entry npm / 101-entry Python inventory:
  SHA-256 7a17efaf710facff19073967a885c93ae0c061d32d88ad8660a17d540a945976.
  Python lock SHA-256:
  6a513a3d7cd2a845f8af869bd1e38875c6b82fd79a7092697c34e45558b9f36a.
- Actual bundled pip rejected an intentionally incorrect wheel hash with exit 1
  before installing any distribution. Ten focused preparation tests, the full
  Bash and PowerShell suites, syntax/parity/BOM and whitespace checks passed.
  Windows wheels for every locked requirement downloaded successfully with
  --require-hashes and explicit win_amd64 / CPython 3.12 targeting on this Mac.
  This establishes archive availability and hashes, not native Windows execution.
- Authenticated managed-runtime smoke passed with system-only PATH and an isolated
  credential-free profile. Rebuilt the locally ad-hoc-signed development app at
  /private/tmp/coop-python-locked-acquisition-20260907/desktop/mac-arm64/Coop Desktop.app.
  Package/fuse validation passed. The built-in native health probe reached
  renderer/chat readiness; PID 780, its process group and its temporary
  profile were gone after completion. No credentials were copied or model
  generation requested. This was automated native validation, not visual review.
  Packaged preparation modules, all three Python locks, the active npm lock and
  original logo exactly match source bytes.
- Evidence: /private/tmp/coop-desktop-home-20260907-state/python-lock-* and
  python-locked-*. Backups: .backups/python_resolution_20260907_192520/.
  Native Windows/Intel acceptance, the pending visual check and other final
  release requirements remain open. Existing authenticated user profiles remain
  intact. No release, tag, application-version bump or production signing.

- Post-use strict deep signature verification passed. All acquisition, download,
  suite, smoke, package and native-probe process handles in this slice exited.


## Attachment read ordering and premature submission

- Goal: preserve attachment limits and draft contents when picker, paste or drop
  actions overlap asynchronous browser FileReader work. The prior renderer let
  separate imports check the same pre-read attachment state, and allowed Send
  before the pending image entered the outgoing message.
- Added deterministic timing tests that execute the actual composer functions
  from web/public/app.js with controlled FileReader completions. Before the fix,
  the overlapping-image regression failed: two readers started despite a one-image
  limit. This proves the stale-state race independently of the runtime's later
  request rejection.
- The shared Web/Desktop composer now snapshots picker files synchronously and
  serializes all picker, paste and drop imports. It shows Reading attachments…
  with a status role and disables Send, Steer and Follow-up while reads are pending.
  Keyboard submission keeps the draft and reports the wait. Each completed batch,
  including read failures, releases pending state; later files can still load.
- Ten content-portability tests pass, including overlapping image count limits,
  combined text byte limits, picker-list mutation, all three submit modes during
  a pending read, and recovery from failed reads. PowerShell behavioral tests,
  JavaScript/Bash syntax, parity/BOM and whitespace checks passed. The full Bash
  suite is still running at this entry; its terminal result will be recorded below.
- Made an APFS clone of the previously validated Python-locked development app,
  overlaid the corrected renderer, and ad-hoc signed the disposable copy at
  /private/tmp/coop-attachment-reads-app-20260907/mac-arm64/Coop Desktop.app.
  Package/fuse validation passed. The packaged renderer and original logo match
  source bytes. Automated native renderer/chat readiness and shutdown passed;
  PID 7570, its process group and temporary probe profile were gone. No credentials
  were copied or model generation requested. This does not establish visual or
  native Windows attachment acceptance.
- Updated desktop/README.md with the visible behavior. Backups are in
  .backups/attachment_reads_20260907_210122/. Evidence files use prefix
  /private/tmp/coop-desktop-home-20260907-state/attachment-reads-.
  Windows/Intel and remaining visual/release gates stay open. User-authenticated
  profiles and the existing interactive test app were preserved.

- The full Bash suite completed with observed exit 0, including the shared Web
  bridge and new composer timing regressions. Post-use strict deep signature
  verification passed. All suite, package, signing and native-probe handles in
  this slice have exited. No release, version bump, tag or production signing.


## Failed-send draft and attachment recovery

- Fixed the shared composer failure path in web/public/app.js. A rejected send
  previously overwrote text entered while the request was pending and truncated
  restored attachment lists. A FileReader completion could also append into an
  obsolete array after recovery replaced it, silently losing the new file.
- The renderer permits one unacknowledged submission at a time while keeping the
  next draft editable. Sending files reserve count/byte capacity until settlement.
  Failure prepends the original message to newer text and restores every admitted
  image/text file without slicing. File reads append into the current state after
  awaiting completion. A Sending status and guarded buttons explain pending work.
- Found and fixed a related acknowledgement bug: HTTP 200 can carry Pi success:
  false for steer/follow_up. The composer now requires success:true before showing
  queued confirmation; rejection uses the same draft-preserving recovery path.
  Runtime /prompt responds after dispatch rather than waiting for model generation,
  so the new pending guard does not cover the whole generation turn.
- Controlled tests execute the actual renderer composer functions. Before/after
  regressions demonstrated overwritten newer text and discarded RPC-rejected
  drafts. All 15 final content-portability tests pass, covering all submit modes,
  success preserving the next draft, duplicate prevention, pending count/byte
  reservations, and image/text reads completing after restoration. The full Bash
  and PowerShell suites completed with observed exit 0. Final JavaScript syntax,
  Bash syntax, parity/BOM and whitespace checks passed.
- Updated the disposable APFS-cloned development app at
  /private/tmp/coop-send-recovery-app-20260907/mac-arm64/Coop Desktop.app with the
  final renderer. Ad-hoc signing, package/fuse validation and post-use strict deep
  signature checks passed. Native automated renderer/chat readiness and shutdown
  passed; PID 40765, its group and its temporary health profile were gone. Packaged
  renderer and original logo equal source bytes. No credentials were copied or
  model generation requested; this does not establish visual acceptance.
- desktop/README.md documents pending-send and recovery behavior. Backups:
  .backups/send_recovery_20260907_210852/. Evidence:
  /private/tmp/coop-desktop-home-20260907-state/send-recovery-*.
- GitHub has no runs for this development branch and no existing PR. The managed
  smoke workflow is present on the branch but not registered on the default branch.
  The existing pull-request CI includes native Windows logic, PowerShell 5.1 and
  Pi compatibility checks. Prepare a draft PR for that validation; do not merge,
  release, tag, version-bump or claim Windows installer acceptance from CI alone.

- Draft PR https://github.com/kabukisensei/coop-agent/pull/48 is now open at
  f3f99451d8d7c34c5db3a0165b7c05eaefc5c941. CI run 34179489431 was observed
  in progress, including Windows logic, PowerShell and real Pi compatibility
  jobs. Results are pending; native installer/interactive VM journeys remain
  separate requirements. No merge, release or production installation occurred.


## First native Windows CI failures and corrections

- Draft PR #48 started CI run 34179489431 at f3f9945. Linux logic tests, shell/config
  lint, extension transpilation and macOS Bash 3.2 parsing passed. Windows logic
  failed in tests/project-wizard.test.mjs:152 when contract creation returned false;
  the fixture discarded the wizard's diagnostic notices. Windows PowerShell parsing
  progressed to behavioral tests and then failed in the fresh-install fixture with
  a .NET mscorlib FileLoadException. The Windows Pi compatibility job is still live.
- Found a Windows-invalid write path in web/project-config-service.mjs: syncFile
  opened newly written temporary/backup files read-only before fsync. libuv uses
  FlushFileBuffers on Windows, which requires GENERIC_WRITE. The helper now opens
  files with r+ (no truncation); POSIX directory sync retains its separate r handle.
  The wizard assertion now reports existing diagnostic notices if it fails again.
  The next native Windows run must confirm whether this resolves its wizard failure.
  Sources: https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers
  and https://github.com/libuv/libuv/blob/v1.x/src/win/fs.c (fs__sync_impl).
- Removed the fake SystemRoot assignment from
  tests/fixtures/install-python-prereq.test.ps1. That fixture's dedicated
  COOP_FABRIC_PYTHON override already forces missing-interpreter discovery; changing
  the OS root unnecessarily disrupts Windows PowerShell 5.1/.NET loading. The
  expected standalone-Python acquisition assertions remain intact and the UTF-8
  BOM is preserved. Native Windows execution of the corrected fixture is pending.
- Six local project-config service tests pass, including exact old/new content,
  backup preservation, stale proposals and failed rename recovery. Local PowerShell,
  final JavaScript/Bash syntax, PowerShell parsing and parity/BOM checks pass.
  The full local Bash suite is still running and will be recorded at completion.
- Updated an isolated development package at
  /private/tmp/coop-windows-config-app-20260907/mac-arm64/Coop Desktop.app with the
  corrected service. Package/fuse validation passed. Actual bundled Node/Python
  created and updated a disposable contract and preserved its original backup.
  Native renderer/chat readiness and shutdown passed; PID 67512, its group and
  temporary probe profile were gone. No model credentials were copied or requests
  generated. These are macOS checks, not native Windows acceptance.
- Backups: .backups/windows_config_flush_20260907_212027/. Evidence prefixes:
  /private/tmp/coop-desktop-home-20260907-state/windows-config-flush-* and
  desktop-pr48-*. The initial Windows failure logs are retained for comparison.
  The remaining Windows CI job has not been restarted or declared terminal.

- The full local Bash suite completed with observed exit 0. Post-use strict deep
  signature verification passed. All local validation/package processes for the
  corrections exited. Native Windows rerun results remain pending.


## Windows CI path and dependency-free setup corrections

- CI run 34180000805 at 49df041 completed: Linux logic, shell/config lint,
  extension transpilation, stock macOS Bash parsing and Windows Pi compatibility
  passed. The Windows wizard's nine tests and standalone-Python installer/updater
  fixture now pass, confirming the previous writable fsync/SystemRoot corrections.
  Both completed Windows Pi jobs (34179489431 and 34180000805) report 18 passed,
  zero failed and zero skipped, including installation, repeated sync and repair
  of a deliberately mismatched pi-ai dependency.
- Windows logic and the aggregating PowerShell behavioral runner exposed further
  failures. Fixed Knowledge source containment using native relative/isAbsolute
  path checks, accepting Git/filesystem case and separator differences while
  rejecting sibling paths and other drives. Added a before/after Windows-path
  regression; all ten Knowledge index tests pass locally.
- Project readiness now requires profile to be a mapping, matching proposal
  validation. A malformed flow-style profile previously appeared configured when
  the dependency-free YAML reader was used. The new test runs actual Python with
  -S and verifies a broken state without exposing config content. All seven setup
  service tests pass locally, including the before/after regression.
- Corrected test-only path expectations for startup workspaces, managed preparation,
  package paths, findings fixtures and isolated authentication. The shell-spike
  shutdown test observes close and an absent PID instead of requiring a numeric
  exit code after signal termination. The update symlink test accepts both native
  rejection diagnostics while still requiring rejection. The published usage.ts
  fixture is marked -text in .gitattributes so Windows Git cannot change its
  authenticated bytes. An actual core.autocrlf=true checkout preserves SHA-256
  e08a1c4b6de6f5ac4fbac24b8fced4608fc270b19846a4be47022cb3c0b20976.
- Full local Bash and PowerShell suites completed with observed exit 0. JavaScript,
  Python and Bash syntax, parity/BOM and whitespace checks pass. The existing CI
  workflow already collects PowerShell test failures; no duplicate collector was
  added. These changes still require the next native Windows CI run.
- Updated isolated package:
  /private/tmp/coop-windows-paths-app-20260907/mac-arm64/Coop Desktop.app.
  Package/fuse checks and source-byte comparisons pass. The original themes/coop.icns
  equals the packaged icon. Ad-hoc signing and strict verification passed before use.
  The first native probe returned healthy but retained its temporary profile;
  cleanup is best-effort and the exact cause was not captured. A diagnostic repeat
  passed readiness and cleanup: PID 17179, process group and probe profile were
  gone. Do not erase the first cleanup anomaly or treat this as visual acceptance.
  The earlier retained disposable profile remains available for investigation at
  /var/folders/3x/3kp1q26n3q19svvrm403ldp00000gn/T/coop-windows-paths-native-bPP9NY.
- Backups: .backups/windows_desktop_ci_20260907_212932/. Evidence:
  /private/tmp/coop-desktop-home-20260907-state/windows-paths-* and
  desktop-pr48-rerun-*. Native Windows installer/sign-in/clipboard/Power BI,
  Intel macOS and release gates remain open. User-authenticated profiles were
  untouched; no release, merge, tag or version bump occurred.

- Post-use strict deep signature verification also passed. All local validation,
  packaging and native-probe handles for this slice have exited.


## Native health cleanup retry and Windows canonical paths

- CI 34181018168 at dfa910d passes Linux logic, stock macOS Bash parsing,
  shell/config lint and extension transpilation. Windows now passes shell-spike
  lifecycle, all 19 preview tests, all ten managed-preparation tests, package
  verification, authentication, dependency-free setup and the byte-pinned usage
  compatibility check. Its remaining reported behavioral failures are update
  staging and both Knowledge suites. The Windows Pi matrix is still running.
- Instrumented copies of the actual native health helper reproduced the retained
  profile. On macOS, checking the recently exited Electron process group returned
  EPERM; a later check reported ESRCH. The group waiter previously returned false
  immediately for EPERM, so safe cleanup was skipped. It now retries EPERM within
  its existing one-second deadline. Only ESRCH confirms exit. Persistent permission
  errors, live groups and unexpected errors still prevent profile deletion.
- A before/after regression executes the real waiter function with controlled
  transient, persistent and unexpected errors. Final update-service checks pass
  all 46 tests, including process lifecycle, retained uncertain profiles, replaced
  directories, symlinks, activation and rollback cases.
- The remaining Windows path failures are consistent with short-name versus native
  path spelling. Knowledge now uses realpathSync.native for source and Git roots
  before the existing native-relative containment check. A short-name expansion
  regression failed before the correction and passes afterward; all ten index
  and seven Knowledge service tests pass locally. Update fixtures use native
  canonical roots, and staging checks the exact canonical grandparent instead of
  a string prefix. The next Windows run must confirm these corrections.
  API reference: https://nodejs.org/api/fs.html#fsrealpathsyncnativepath-options.
- Refreshed isolated app:
  /private/tmp/coop-health-exit-app-20260907/mac-arm64/Coop Desktop.app.
  Both app.asar and the external update-helper closure contain the corrected health
  module; the embedded ASAR integrity hash was refreshed before ad-hoc signing.
  Package/fuse verification and exact source-byte comparisons pass, including
  Knowledge and the original plain Cooptimize icon. Three consecutive native
  renderer/chat readiness, shutdown and profile-cleanup checks passed (PIDs
  29744, 30565, 31245). No model credentials were copied or generation requested.
- Final PowerShell suite and syntax/parity checks pass. The full Bash suite is
  still running; its terminal result and final fixture validation will be recorded
  before committing. This is development validation, not Windows installer or
  interactive acceptance. No release, merge, tag or version bump.
- Backups: .backups/health_exit_retry_20260907_214602/. Evidence prefixes:
  /private/tmp/coop-desktop-home-20260907-state/health-exit-*,
  knowledge-native-path-*, native-cleanup-investigation-* and desktop-pr48-third-*.

- Updated docs/agent/windows-handoff-2026-09-07.md with current Mac model-work,
  cleanup and CI evidence, retaining the native Windows and updater requirements.
  Post-use strict deep signature verification passed for the corrected package.

- The final full Bash suite completed with observed exit 0 after the last fixture
  adjustment. Final PowerShell, focused tests, syntax/parity, package verification
  and three native probes passed. All local validation handles are terminal.
  CI 34181018168 still has its Windows Pi convergence matrix running; no live
  process was restarted because of an observation timeout.


## Windows update-notice handling and native managed build CI

- CI 34181793604 at 17f07aa confirms the Windows native-path corrections: all
  ten Knowledge-index and seven Knowledge-service tests pass. Windows update
  staging, prepared-copy disposal and helper transport also passed before the
  next failure. Its aggregating PowerShell runner reports only the update-service
  file failing, at the outcome symlink assertion; tests later in that file still
  need the next run. The Pi convergence job remains live at this checkpoint.
- presentUpdateOutcome previously depended on O_NOFOLLOW, which is unavailable
  on Windows. It now lstat-checks the path before opening, matches entry/handle
  identity, rechecks after reading, and consumes only the same regular file after
  acknowledgement. It continues to show fixed copy and preserves newer results.
  A regression with O_NOFOLLOW disabled failed before and passes after, including
  an external link initially and a linked replacement while the dialog is open.
  All 47 update-service tests pass locally.
- Enabled .github/workflows/managed-desktop-smoke.yml for relevant pull-request
  changes as well as manual dispatch. Both native workers check out the exact
  three public companion commits from config/development-companions.json with no
  persisted checkout credentials. Python 3.12 builds their development wheels;
  the preparer consumes those wheels and the existing complete npm/Python locks.
  The workflow checks the staged runtime, packages the native app, checks package
  fuses/ASAR/provenance, then executes the runtime inside that package with another
  isolated profile. Explicit build/runtime receipts and inventory files are kept
  for seven days, without publishing app binaries or releases.
- Fixed the previously unexecuted target-detection command's JavaScript quoting.
  YAML parsing and every embedded Bash syntax check passed. Executing the actual
  companion-output and target steps locally yielded the three configured commits
  and darwin-arm64. Four build-plan and four package-security tests pass. Official
  action references: https://github.com/actions/setup-python and
  https://github.com/actions/upload-artifact (v7 usage and retention inputs).
- Refreshed isolated package:
  /private/tmp/coop-outcome-check-app-20260907/mac-arm64/Coop Desktop.app.
  Both the ASAR module and external helper closure equal the corrected source;
  the ASAR header hash was refreshed before ad-hoc signing. Original Cooptimize
  icon bytes are preserved. Package/fuse verification and native renderer/chat
  readiness, shutdown and profile cleanup passed (PID 75654 and group absent).
  The actual new CI embedded-runtime step was extracted and executed against this
  package locally with disposable HOME/workspace/agent folders; it exited 0 and
  runtime PID 75717 was confirmed gone. No credentials were copied or model work
  requested. These are Mac checks, not native Windows GUI acceptance.
- PowerShell behavioral suite and JavaScript/Bash syntax and parity/BOM checks
  passed. Full Bash suite is still running; record its terminal result before
  committing. desktop/README.md describes the new CI coverage and its limits.
- Backups: .backups/managed_ci_outcome_20260907_215921/. Evidence prefixes:
  /private/tmp/coop-desktop-home-20260907-state/managed-ci-*, outcome-check-*,
  outcome-no-follow-* and desktop-pr48-fourth-*. Windows installer/sign-in,
  clipboard/Power BI, full updater, Intel macOS and production release gates remain
  open. No parity row is promoted from these development checks alone.

- Full Bash suite completed with observed exit 0. Post-use strict deep signature
  verification passed. All local validation/native/package handles in this slice
  have exited. Native CI execution of the expanded workflow is still pending.


## Native Windows archive selection and update acknowledgement file release

- The first managed build CI run 34182410220 at 4671c6c completed. Native arm64
  macOS job 101923974924 passed wheel builds, exact runtime acquisition, staged
  runtime checks, app packaging, fuse/ASAR verification and packaged-runtime
  execution. Its receipt records 507 npm packages and 101 Python distributions
  with the existing npm/Python resolution hashes. The native package ran bundled
  Node 22.22.3, Python 3.12.14, Pi 0.84.3 and Coop 0.23.1. This is a clean hosted
  development build, not production signing or full interactive acceptance.
- Windows job 101923975079 checked out the three exact companion commits and built
  all three development wheels. It then failed extracting the Node ZIP because
  PATH selected Git Bash GNU tar, which interpreted D: as a remote archive host.
  The preparer now resolves SystemRoot/System32/tar.exe on Windows and rejects an
  absent/relative/invalid SystemRoot. Native Windows bsdtar supports the pinned ZIP
  and tar.gz formats; the Mac tar path is unchanged. Eleven preparer tests pass.
  Reference: https://learn.microsoft.com/en-us/windows/tar/.
- Downloaded both CI evidence artifacts (10039408923 Mac, 10039366256 Windows).
  The Windows artifact contains the successful development-wheel receipt; it does
  not contain a managed-runtime/package success receipt. Per-platform wheel hashes
  differ and are recorded independently; no cross-platform byte identity is claimed.
- CI 34182410150 Windows tests progressed past symbolic-link rejection and failed
  while a newer update result replaced the file during acknowledgement. The outcome
  reader now closes its handle before awaiting the dialog, keeping only metadata
  for the post-dialog identity check. A before/after regression uses real files and
  counts open handles while replacing the result. It proves no handle stays open
  across acknowledgement and that a newer result is preserved. All 48 update tests
  pass locally; native Windows confirmation remains pending.
- Refreshed isolated development package:
  /private/tmp/coop-windows-archive-app-20260907/mac-arm64/Coop Desktop.app.
  Updated both the ASAR and external outcome helper, plus the bundled preparer,
  refreshed the ASAR header hash and ad-hoc signature, and verified source bytes
  and the original Cooptimize icon. Package/fuse checks and native renderer/chat
  readiness, shutdown and temporary-profile cleanup passed (PID 99047 and its
  group gone). User-authenticated profiles were preserved; no model generation.
- Local PowerShell, JavaScript/Bash syntax and parity/BOM checks pass. Full Bash
  suite is still running and its terminal result will be recorded before commit.
  Backups: .backups/windows_archive_outcome_20260907_221044/. Evidence prefixes:
  /private/tmp/coop-desktop-home-20260907-state/windows-archive-*, outcome-handle-*,
  managed-ci-first-* and desktop-pr48-fifth-*. Full native Windows, updater and
  release requirements remain open; no merge, release, tag or version bump.

- Full Bash suite completed with observed exit 0, and post-use strict deep
  signature verification passed. All local validation handles are terminal.
  The older Pi job 101922199885 also completed successfully; the Pi job for
  34182410150 remains in progress at this checkpoint.


## Target-native npm dependency completion and Windows test progress

- Managed build CI 34182954735 at e70a41a passed a second fresh hosted arm64 Mac
  build. Windows successfully extracted the Node/Python archives with native tar,
  then stopped because the lock omitted @microsoft/fabric-mcp-win32-x64. Four
  Windows and four Intel Mac optional native packages were absent. Added their
  exact published versions, archive URLs and integrity hashes; every pre-existing
  lock entry and top-level pin is unchanged.
- Managed npm validation now resolves target-native optional dependencies through
  nested/root node_modules paths and requires matching locked versions plus their
  presence in the installed lock. A before/after regression covers missing locked
  or installed binaries, nested resolution, wrong versions and other platforms.
  All 12 preparer tests pass; the existing actual arm64 Mac bundle also passes
  the stricter verification with its unchanged lock and 507 installed entries.
- Fresh cross-target npm ci with lifecycle scripts disabled passed on the Mac:
  Windows 507 entries, Intel Mac 506 entries. Input locks remained unchanged.
  This proves dependency resolution only, not native postinstall or execution.
  Native Windows CI must rerun the full build. Intel native runtime acceptance
  and its Python source-build/toolchain requirements remain open.
- Regular CI 34182954792 passed Linux, shell/config, Mac Bash parsing, extension
  builds and native Windows Pi compatibility. Windows logic/PowerShell reached
  one remaining native-startup test expecting a literal POSIX path. Corrected
  the assertion to use native resolve; all 48 update tests pass locally. Older
  run 34182410150 is also terminal and its Windows Pi compatibility job passed.
- Full local Bash, PowerShell behavioral suite and Bash syntax/parity/BOM checks
  completed with observed exit 0. All local validation processes are terminal.
- Exercised actual packaged Mac Python entrypoints with isolated HOME and synthetic
  fixtures: SQL review reported SQL-NO-SELECT-STAR (one finding); DAX review
  reported DAX-BIDI-RELATIONSHIP (five findings); data-doc generated six nodes and
  five edges, including the synthetic semantic model, measure, tables and SQL
  view. All commands exited 0. No authenticated profile or business data was used.
- Backups: .backups/windows_final_path_20260907_221908/. Evidence under
  /private/tmp/coop-desktop-home-20260907-state/: npm-native-completion-metadata.json,
  npm-native-completion-ci.json, npm-native-required-{before,after}.log,
  npm-native-final-{bash,powershell,parity}.log, windows-final-path-focused.log,
  managed-tool-work-evidence.json and managed-ci-second-windows.log.
  This remains development verification; Windows interactive acceptance, updater
  implementation and all outstanding release requirements remain open.


## Packaged analysis-tool execution in managed acceptance

- Extended the managed-runtime verifier to execute the installed SQL Review, DAX
  Review and Data Doc entrypoints with bundled Python against the existing
  synthetic SQL/model fixtures. It checks exact review versions, absence of
  diagnostics, expected review rules, and actual SQL/model lineage relationships.
  Temporary home/work folders are removed, host Python/user site packages are
  excluded, no model/Microsoft credentials are inherited, and bytecode writes into
  the signed application are disabled. This checks local analysis, not live APIs.
- Regression checks reject empty/no-op findings, wrong versions, diagnostics and
  missing SQL or DAX lineage edges. All five build-plan/evidence checks pass.
- The combined verifier passed against the real disposable arm64 Mac package at
  /private/tmp/coop-windows-archive-app-20260907/mac-arm64/Coop Desktop.app:
  SQL one expected finding, DAX five findings, data-doc six nodes/five edges,
  authenticated runtime capabilities, runtime PID 36190 confirmed gone afterward.
  Post-use strict deep signature verification passed. The user's interactive
  app and authenticated profile were not changed.
- CI 34183933653 at b0ebab8 passed its third fresh hosted Mac managed build.
  Windows now completes locked acquisition and reaches real runtime verification;
  that step is still active, so Windows managed-runtime/package success is not
  claimed. CI 34183933661 Windows PowerShell and Linux/lint/extension/Mac parsing
  passed; Windows Bash and Pi jobs are still active at this checkpoint.
- PowerShell behavioral checks and Bash syntax/parity/BOM checks exited 0 locally.
  Full Bash checks remain active and their terminal result must be recorded before
  committing this slice. Backup: .backups/managed_tool_smoke_20260907_223628/.
  Evidence: /private/tmp/coop-desktop-home-20260907-state/managed-tool-smoke-native.log,
  managed-tool-full-verifier-evidence.json and managed-tool-final-*.log.

- Full Bash suite has now completed with observed exit 0; all local handles in
  this slice are terminal. Windows Bash job 101928388014 finished with a failure
  in tests/webbridge.test.mjs:1272 (independent chat cwd assertion), after passing
  all update tests. Its complete log is desktop-pr48-seventh-windows-logic.log.
  This is the next source/test investigation; it is not attributed to the new
  tool verifier, which is not yet present in that CI revision. Managed Windows
  job 101928388101 and Pi job 101928387982 remain active.


## Windows bridge fixture isolation and confirmed runtime shutdown failure

- Windows Bash CI job 101928388014 at b0ebab8 failed the separate-chat cwd
  assertion because the earlier no-Git bridge reused the main fixture's agent
  profile. Windows force termination skips its lease release, leaving the lease
  within the required 20-second stale window when chat 1 returns to that folder.
  Reproduced the exact assertion locally by changing that helper's stop to
  SIGKILL; the before run exited 1 at the same assertion.
- The independent no-Git server now has its own agent and lease storage. Its forced
  stop is retained on all platforms to cover the Windows behavior. The first
  chat-folder change now asserts the actual response status/body instead of
  silently continuing after a rejected change. All 278 focused bridge checks pass
  with observed exit 0. Production lease expiry and ownership rules are unchanged.
- PowerShell behavioral suite and Bash syntax/parity/BOM checks pass locally.
  Full Bash is still running; its terminal result must be recorded before commit.
  Backup: .backups/windows_bridge_fixture_20260907_224641/.
- Superseded managed run 34183933653 was explicitly cancelled to retrieve logs
  after Windows verification exceeded its own expected readiness/shutdown bounds.
  Mac job 101928387931 passed. The Windows log confirms runtime startup, auth,
  capability versions and PID 620 at 03:36:23Z, followed by shutdown-not-confirmed
  at 03:36:29Z. The PowerShell launcher was terminated without reaping the runtime
  descendant, leaving pipes/processes alive until CI cancellation. This is an
  actual supervisor lifecycle bug, not successful managed Windows acceptance.
  Newer managed run 34184404526 was left running; no timed-out process was restarted.
- Next runtime slice must terminate the owned Windows process tree and verify
  native shutdown/restart and orphan/lease handling. Success receipts should be
  emitted only after shutdown verification, not before the finally block. No
  Windows updater or release requirement is closed by current evidence.
- Evidence under /private/tmp/coop-desktop-home-20260907-state/:
  bridge-abrupt-{before,after}.log, bridge-fixture-final-*.log,
  managed-ci-third-windows-cancelled.log, desktop-pr48-eighth-windows-logic.log.

- Full Bash suite finished with observed exit 0. All local validation handles in
  this slice are terminal. Regular CI 34183933661 is terminal; its Windows Pi
  compatibility job 101928387982 passed. Windows job 101929741872 on the next
  revision reproduced the same bridge assertion, corroborating the fixture fix.


## Windows runtime process-tree shutdown

- Fixed Desktop supervisor shutdown on Windows to run the native
  SystemRoot/System32/taskkill.exe with the owned launcher PID and /T /F before
  waiting for child handles to close. It no longer kills the PowerShell launcher
  first and strands the runtime/Pi descendants. The executable is selected outside
  PATH, its arguments are structured, execution is bounded, and failures propagate.
  Failed spawn without a PID instead waits for its handles to close.
- Added native Windows regression coverage for a launcher with a nested runtime,
  concurrent stops and confirmed exit of both PIDs. Cross-platform checks cover
  invalid PID/root, exact native invocation and termination failure. Twenty local
  preview-shell checks pass; native Windows execution of the new case is pending.
- Managed runtime success receipts now appear only after stop completes and include
  shutdownConfirmed:true. The prior logs' pre-shutdown ok:true must not be treated
  as whole-run success.
- Refreshed isolated Mac package at
  /private/tmp/coop-runtime-tree-app-20260907/mac-arm64/Coop Desktop.app. Both ASAR
  and external update-helper supervisor copies match current source; the original
  Cooptimize logo is byte-identical. Refreshed ASAR integrity/ad-hoc signing,
  package/fuse checks, native renderer/chat readiness, process/group exit and
  temporary profile cleanup passed (PID 95147). Combined analysis/runtime verifier
  also exited 0 (runtime PID 95354), with post-shutdown receipt. Post-use strict
  deep signature verification passed. Authenticated user profiles were preserved.
- Regular CI at 9487870 now passes native Windows logic and PowerShell suites,
  confirming the bridge-fixture isolation fix. Pi job 101931529322 remains active.
- Superseded managed run 34184404526 was cancelled for diagnostic collection after
  reaching the already-confirmed shutdown hang; newer run 34185027191 was left
  active. Windows log proves bundled SQL and DAX entrypoints produced the expected
  one/five findings and Data Doc six nodes/five edges, then runtime startup/auth/
  capabilities succeeded (PID 6412). Shutdown failed, so no complete Windows
  managed-runtime/package success is claimed. Mac job 101929742193 passed.
- Forced tree termination does not establish graceful persistence or immediate
  restart/lease recovery. Those native Windows requirements remain open, along
  with installer, model login, clipboard, Power BI and updater/release acceptance.
  Reference: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill.
- PowerShell behavioral and Bash syntax/parity/BOM checks pass locally. Full Bash
  remains active and its terminal result must be recorded before commit.
  Backup: .backups/windows_runtime_tree_20260907_225528/. Evidence under
  /private/tmp/coop-desktop-home-20260907-state/: runtime-tree-*.log/json,
  managed-ci-fourth-windows-cancelled.log. No release, tag or version bump.

- Full Bash suite completed with observed exit 0. All local source, package,
  native smoke and signature validation handles are terminal. The source is ready
  for the next native Windows CI run; no native result for this change is assumed.


## Owner-controlled graceful runtime shutdown and immediate restart

- Native managed CI 34185477300 at b51b065 completed successfully on both
  Windows (job 101932838037) and arm64 Mac (101932837911). Downloaded artifacts
  10040414329 and 10040397710. Staged and packaged Windows runtime checks include
  shutdownConfirmed:true, expected SQL/DAX findings and Data Doc lineage. Package
  fuse/ASAR checks pass. Windows staged/package runtime PIDs were 8896/1688; Mac
  4995/6335. This proves managed acquisition, packaging and runtime execution,
  not NSIS installation or native Windows interactive GUI/model/Power BI journeys.
- Added a per-launch Desktop owner credential and advertised http-v1 shutdown
  protocol. Runtime shutdown requires its authenticated cookie, CSRF header and
  separate owner header. The credential is removed from inherited agent env and
  launch-spec overrides. The supervisor bounds the request/wait and retains the
  existing process-tree fallback for older/unresponsive runtimes.
- Runtime shutdown now waits for agent termination before releasing leases and
  exiting. It blocks new requests/chat starts/restarts once shutdown starts;
  unconfirmed agent termination retains ownership for recovery. Native Windows
  taskkill uses System32 and its helper result is observed during graceful stop.
- A before/after test with the actual runtime and stub Pi verifies two immediate
  writable starts, rejection of missing/wrong/previous-owner credentials, cookie
  and CSRF enforcement, no owner-credential inheritance and actual Pi exit.
  The pre-fix test failed on the absent protocol; all 21 local preview-shell tests
  now pass. A deliberately stalled HTTP endpoint falls back and reaps its runtime
  in 103 ms with a 100 ms request grace period (PID 31407).
- Managed verification now requires two immediate writable starts using the same
  agent profile and workspace; it reports success only after both stops. Refreshed
  disposable Mac app: /private/tmp/coop-graceful-runtime-app-20260907/mac-arm64/Coop
  Desktop.app. ASAR/helper supervisor and managed server match source; original
  Cooptimize icon matches. Package/fuses, native renderer/chat readiness and probe
  cleanup pass (PID/group 18369 gone). Two real bundled runtime starts passed
  (18749/19045, both confirmed gone), with expected tool results and writable
  restart receipt. Post-use strict deep signature verification passes.
- Windows regular CI 34185477333 passed its PowerShell suite but Git Bash job
  101932838249 failed the chat-crash assertion at webbridge.test.mjs:1366; this is
  separate from managed packaging success and needs investigation. Pi job
  101932838510 is still active. No all-Windows-tests claim is made.
- Local PowerShell behavioral and Bash syntax/parity/BOM checks exited 0. Full
  Bash remains active and must finish before commit. Backup:
  .backups/runtime_graceful_20260907_230355/. Evidence under
  /private/tmp/coop-desktop-home-20260907-state/: graceful-*.log/json,
  managed-ci-native-success-summary.json, managed-ci-windows-success-evidence.zip,
  managed-ci-sixth-macos-evidence.zip, desktop-pr48-tenth-windows-logic.log.
  Windows graceful restart awaits native CI on this new change. Full installer,
  reboot/login, updater, interactive and production distribution requirements
  remain open. Authenticated user profiles and real business data were preserved.

- Full Bash suite completed with observed exit 0. All local validation, native
  package, restart and signature handles are terminal. The new source is ready
  for native Windows graceful-restart validation; that result remains pending.


## Workspace restart ownership and loss handling

- Investigated the intermittent Windows chat-crash assertion. A deliberately
  delayed 750 ms stub crash reproduced the fixed-500 ms test failure. Bounded
  polling still failed, exposing stale ownership: a shared-folder override lost
  its primary owner's marker when that owner moved away, but same-folder restart
  reused the invalid lease. Restart now checks ownership and acquires a fresh
  normal writer lease when required; conflicting ownership still rejects access.
- A second regression removed only the fixture's replacement owner record. Before
  the fix, the restarted chat remained running beyond the next heartbeat (8 s
  bounded observation). Fresh and restarted chats now use the same lease factory,
  preserving the stop-on-loss callback after every workspace change.
- Bridge tests check lease reacquisition, delayed fatal code 3, surviving-chat
  replies, and stop-on-loss for replacement leases. Polls have firm deadlines;
  test timing no longer assumes process exit within half a second. Production
  files: web/server.mjs; fixtures: tests/webbridge.test.mjs, tests/stub-pi.mjs.
- Native CI 34186222160 at 7ec1b62 completed successfully on Windows and arm64 Mac.
  Downloaded artifacts 10040644947/10040634540 prove staged and packaged runtime
  shutdownConfirmed:true and immediateWritableRestart:true. Windows runtime PID
  pairs: 8616/7352 and 3920/8244; Mac pairs: 4485/4741 and 6071/6273. All four
  receipts include expected SQL/DAX findings and Data Doc graph results. This
  evidence precedes the workspace ownership changes in this slice.
- Refreshed disposable Mac package at
  /private/tmp/coop-workspace-restart-app-20260907/mac-arm64/Coop Desktop.app.
  Current managed server and original Cooptimize icon match source. Package/fuse
  checks, native renderer/chat readiness, probe-profile cleanup, and post-use deep
  strict ad-hoc signature verification pass. Native PID/group 65996 are gone.
  Real bundled runtime PIDs 65563/65709 are gone after two writable starts; actual
  SQL/DAX tools return one/five expected findings and Data Doc six nodes/five edges.
  No credentials were copied and no model generation was requested by these probes.
- PowerShell behavioral, Bash syntax/parity/BOM, Node syntax and diff whitespace
  checks pass. Full Bash remains active and its terminal result will be appended
  before commit. Earlier ownership-only full Bash passed all 279 bridge checks;
  that result does not cover the newly added loss-callback assertion.
- Backups: .backups/bridge_crash_wait_20260907_231458/ and
  .backups/workspace_lease_callback_20260907_232802/. Evidence root:
  /private/tmp/coop-desktop-home-20260907-state/; bridge-crash-*.log,
  lease-callback-*.log/json, workspace-restart-native-evidence.json and
  graceful-ci-native-summary.json. Standards: repository workflow/guardrails,
  workspace isolation and runtime ownership contracts; no business source changed.
- Full native Windows GUI, installer, sign-in/model, clipboard/Power BI, reboot,
  updater and production distribution acceptance remain open. No release gate or
  parity row is promoted from these development checks. PR #48 remains draft.
  Next: complete local regression, commit/push the authorized development fix,
  then observe exact-source Windows CI and extend native installer/GUI evidence.

- Follow-up CI observation: regular run 34186222161 at 7ec1b62 completed with
  success, including Windows Pi compatibility job 101934970552 and Windows Git
  Bash logic job 101934970643. These are terminal results for the preceding commit;
  the ownership/loss-callback changes still require their own native CI run.

- Test-order correction: the first loss-callback run proved the new assertion
  but intentionally stopped sid1 before a later compact test that still needs it.
  Cancelled that invalid run and its observed descendant processes (61409, 82679,
  82682), moved the destructive fixture assertion after all existing chat work,
  and started a fresh full suite in lease-callback-ordered-final-bash.log. This
  cancellation was due to a diagnosed fixture dependency, not an observation timeout.
- Follow-up runtime issue identified for the next slice: /rpc on an already exited
  chat still creates a waiter, while sendTo drops the command; compact can therefore
  wait its 180 s ceiling. /prompt also currently acknowledges a dropped command.
  Add explicit unavailable-chat responses and settle in-flight waiters on ownership
  loss, with renderer recovery behavior checked, before claiming complete crash UX.

- Corrected full Bash suite completed with observed exit 0, including all 280
  bridge checks, both ownership regressions, delayed crash containment and the
  existing compact success/timeout checks. All local validation and native package
  handles are terminal. The current source is ready for exact-source Windows CI.


## Prompt and command recovery after an agent exits

- Reproduced a pending compact request surviving workspace ownership loss until
  the test's 12 s request deadline, despite the chat already being exited. Before
  this fix, a new /prompt to an exited chat was also acknowledged while sendTo
  dropped it; /rpc could wait up to compact's 180 s timeout with no live agent.
- Added shared live-process/writable-stdin checks. /prompt, /rpc (including model
  refresh), /ui-response and /abort now return HTTP 503 with chat-unavailable and
  recovery guidance when the chat cannot receive a command. rpcCall avoids stale
  waiters on unavailable chats or synchronous send failures. Backpressure remains
  accepted delivery. Ownership loss clears busy state and settles pending RPCs;
  responses distinguish agent unavailability from a live agent's actual timeout.
- Dialog responses enter replay deduplication only after send acceptance. The
  renderer preserves structured RPC errors, explains stopped-chat recovery for
  compact and composer actions, and restores original text/images/text files
  alongside a newer draft. Composer/transport checks pass (17 tests), including
  prompt, steer and follow-up recovery and real RPC/compact-handler error decoding.
- The initial full suites caught an interaction with the handing-off state:
  rejecting all commands blocked Coop's internal authenticated shutdown command.
  Only the internal handoff RPC now explicitly permits that state; public command
  routes remain blocked. Focused runtime-entrypoint tests pass all 11 checks,
  including successful terminal move and confirmed Pi exit. Corrected full Bash
  is active; corrected PowerShell behavioral suite completed with exit 0.
- Refreshed disposable package:
  /private/tmp/coop-exited-chat-app-20260907/mac-arm64/Coop Desktop.app.
  Both managed server and renderer match source, and the original Cooptimize icon
  matches. Package/fuses, native renderer/chat readiness, isolated probe cleanup,
  two real writable runtime starts and post-use deep strict ad-hoc signature checks
  pass. Native PID/group 14427 and runtime PIDs 13881/14146 are gone. Bundled SQL/DAX
  return one/five expected findings; Data Doc produces six nodes/five edges.
- Previous ownership commit 1f66cae passed managed CI 34187762498 on Windows job
  101939438694 and Mac job 101939438516. Downloaded artifacts 10041156734 and
  10041150011 confirm staged/packaged immediate writable restart and actual tool
  work on both platforms. Windows runtime PID pairs: 756/2284 and 10112/1780;
  Mac: 4547/4749 and 5746/5949. Regular CI 34187762489 has passed Windows logic,
  PowerShell, Linux logic, lint and parse; Pi compatibility remains active at the
  latest observation. These CI results precede this exited-chat slice.
- Backup: .backups/exited_chat_20260907_234150/. Source/fixtures changed:
  web/server.mjs, web/public/app.js, tests/stub-pi.mjs, tests/webbridge.test.mjs,
  tests/content-portability.test.mjs. Evidence under
  /private/tmp/coop-desktop-home-20260907-state/: exited-chat-*.log/json,
  ownership-ci-*-evidence.zip and ownership-ci-native-summary.json. Standards:
  runtime lifecycle, command protocol, draft/attachment preservation and repository
  workflow. No business data, credentials or authenticated user profiles changed.
- Full native Windows GUI/installer, real sign-in/model, clipboard/Power BI,
  reboot/login, updater and production distribution acceptance remain required.
  No release/parity gate is promoted. Next: finish current full regression,
  commit/push the authorized development fix, observe exact-source native CI and
  extend Windows native application/installer acceptance.

- Corrected full Bash suite completed with observed exit 0: all 287 bridge checks
  and 17 content-portability checks pass, including pending compact settlement,
  prompt/RPC/model-list/dialog/abort rejection for an exited chat and preserved
  draft/attachment recovery. Local validation and native package handles are
  terminal. Regular CI 34187762489 for preceding commit 1f66cae also completed
  successfully, including Windows Pi compatibility job 101939438662.


## Native Electron application acceptance in managed CI

- Added desktop/scripts/verify-native-application.mjs and a managed-build CI step
  that launches the actual packaged Electron executable on Windows and macOS.
  The existing native probe mode creates a BrowserWindow, waits for trusted
  renderer startup IPC and a real selected chat, calls get_state, and stops its
  runtime before emitting a challenge/version-matched health receipt. Production
  updater/platform policy remains unchanged.
- The verifier first checks the package/fuses and reads the version from ASAR.
  It supplies a fresh workspace and disposable profile with isolated HOME,
  USERPROFILE, APPDATA, LOCALAPPDATA and temporary paths; credentials, NODE_OPTIONS
  and unrelated runner environment are not inherited. Windows PATH contains only
  system directories needed by the bundled launcher. It requests no model work.
- Success requires the matching challenge/version, zero process exit, confirmed
  main PID exit and profile removal. POSIX probe groups are also reaped/checked;
  Windows timeout cleanup uses the existing structured taskkill process-tree
  helper. Failed or unconfirmed probes retain their profiles and bounded,
  challenge-redacted stderr diagnostics. CI preserves native-application-check.json
  for success or diagnosed launch failure. This is native renderer/chat readiness,
  not visual acceptance, whole Windows descendant-tree evidence, or an installer test.
- Managed-runtime tests now cover environment isolation and real child-process
  success, wrong challenge, wrong version, nonzero exit, timeout and failed spawn;
  all 14 tests pass locally. The pre-implementation run failed because the native
  verifier did not exist. Existing production updater tests remain separate.
- Ran the new CLI against
  /private/tmp/coop-exited-chat-app-20260907/mac-arm64/Coop Desktop.app:
  rendererAndChatReady:true, runtimeShutdownReported:true, mainProcessExited:true,
  profileRemoved:true. PID/group 33911 are gone; post-use deep strict signature
  verification passes. No credentials copied or model generation requested.
- Previous commit 031f572 passed managed CI 34188459434 on Mac job 101941440595
  and Windows job 101941440651. Its regular CI 34188459477 still had Windows
  logic/Pi jobs active at the latest observation; no terminal result is inferred.
- Files: desktop/scripts/verify-native-application.mjs,
  tests/managed-runtime.test.mjs, .github/workflows/managed-desktop-smoke.yml and
  completion/daily evidence docs. Backup: .backups/native_app_ci_20260907_235440/.
  Evidence: /private/tmp/coop-desktop-home-20260907-state/native-app-ci-*.log/json.
  PowerShell behavioral and Bash syntax/parity/BOM checks pass; full Bash remains
  active and its terminal result must be recorded before commit.
- Standards: managed package trust/fuse policy, isolated profiles, runtime lifecycle
  and repository workflow. No user profile, business data, version, release or tag
  changed. The Windows native launch remains unproven until the new CI step runs.
  Full installer/install/repair, interactive sign-in/model, clipboard/Power BI,
  accessibility, reboot/login, updater and production distribution requirements
  remain open. Next: finish local suite, push the authorized development change,
  inspect native Windows launch evidence, then extend installer acceptance.

- Full Bash suite completed with observed exit 0 after midnight September 8,
  including 14 managed-runtime tests and all 287 bridge checks. All local probe,
  validation and signature handles are terminal. The native Mac package launch
  is proven; native Windows launch still awaits the new CI step on this commit.


## Windows installer acceptance and native startup diagnostics

- Added a Windows installer acceptance script and CI steps to build the unsigned
  NSIS development installer, install into a fresh path containing spaces, verify
  the installed package/fuses and native app, run bundled SQL/DAX/Data Doc and two
  writable runtime starts, deliberately remove the installed renderer, reinstall
  to restore it exactly, and uninstall. It checks registry identity/removal and
  preserves a test sentinel in the standard application-data location throughout.
  This is prepared acceptance code; native installer success is not yet proven.
- Mutation is restricted to Windows on an explicitly enabled GitHub-hosted runner;
  existing Coop registration or application data stops the test before installation.
  Child commands have bounded waits and use the shared Windows tree-termination
  helper on timeout. An unconfirmed earlier process exit skips subsequent uninstall
  cleanup. CI retains windows-installer-check.json; no installer is published as a
  production release. The dedicated temporary installation is the only damaged
  payload. NSIS /D= and _?= arguments remain last and unquoted, including spaces,
  using direct process invocation without a shell, /allusers, or /NCRC.
- Refactored package verification to share the same checks for unpacked and installed
  Windows layouts. Local managed-runtime tests pass all 16 checks, including the
  disposable-host guard and NSIS path/argument semantics. Sources checked:
  https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage and the installed
  electron-builder 26.15.3 NSIS templates (current-user, registration and uninstall).
- First native Windows Electron check at f55be14 failed in managed CI 34189063953,
  job 101943189964, after about 22 seconds. Downloaded artifact 10041631549; its
  native-application-check.json has no stderr diagnostics. The Mac job 101943189837
  passed. Regular CI 34189063924 completed successfully. Earlier 031f572 regular
  CI 34188459477 also completed successfully. Windows native startup remains open.
- Probe-mode startup previously swallowed errors. Main now emits a bounded,
  hex-token-redacted desktop.update-health-error before quitting. Native verifier
  failure receipts now include readiness, exit code/signal, main PID, stdout byte
  count and exit confirmation. Added standard Windows OS/PATHEXT values to its
  isolated environment; missing command-discovery environment was found during
  inspection, but is not yet proven to explain the native Windows failure.
- Refreshed disposable Mac app:
  /private/tmp/coop-installer-ci-app-20260908/mac-arm64/Coop Desktop.app.
  Current main in ASAR and original Cooptimize icon match source; ASAR header hash
  and ad-hoc signature refreshed. Normal native probe passes (PID/group 60998 gone,
  profile removed). A deliberately missing launcher produces the expected startup
  diagnostic, retains its failed profile, and exits (PID/group 60956 gone). Post-use
  deep strict signature verification passes. No credentials or model work involved.
- Files: desktop/scripts/verify-windows-installer.mjs,
  desktop/scripts/verify-managed-package.mjs, desktop/scripts/verify-native-application.mjs,
  desktop/src/main.mjs, tests/managed-runtime.test.mjs, managed CI workflow and docs.
  Backup: .backups/windows_installer_ci_20260908_000658/. Evidence root:
  /private/tmp/coop-desktop-home-20260907-state/; windows-installer-ci-*.log,
  installer-ci-*.log/json/txt, native-app-first-windows-*.log/json/zip.
  PowerShell behavioral and syntax/parity/BOM checks pass; full Bash is active.
- Standards: package trust/fuses, native readiness, isolated profiles, Windows
  process ownership, source review/backups and daily logging. No user profiles,
  credentials, business data, production updater policy, versions or tags changed.
  Next: complete local regression, push the authorized development slice, inspect
  the improved native Windows result, then the installer lifecycle results. Full
  interactive model/login, clipboard/Power BI, accessibility, reboot/login, updater
  and signed production distribution acceptance remain open; no parity gate promoted.

- Full Bash completed with observed exit 0 (16 managed-runtime tests and all 287
  bridge checks). Local PowerShell, syntax/parity/BOM and packaged normal/failure
  probes are terminal and passing. Final review also ensures unconfirmed native
  process exit skips installer cleanup and retains that observation in its failure
  receipt; targeted managed-runtime tests and syntax pass after that refinement.
  No actual Windows installer result is claimed before the new CI execution.

## Windows native startup environment — September 8 follow-up

- Authoritative managed CI 34190524392 at 899bdcb completed with failure. Mac
  job 101947473887 passed; Windows job 101947474052 passed packaged runtime and
  real tools but failed native Electron startup. Artifact 10042122980 now records
  `Coop Runtime did not become ready in time.` The application exited cleanly
  (PID 10164, no readiness receipt). This proves a startup timeout, not its cause.
- The packaged-runtime check used the runner environment and completed two starts
  in roughly six seconds including verification. Native probing uses an isolated
  environment whose Windows PATH selects Windows PowerShell rather than runner
  PowerShell 7. Added an explicit comparison check with the same isolated PATH,
  empty workspace, fresh profile, 20-second ready deadline, and both writable
  starts. Receipts include selected launcher and per-start elapsed milliseconds.
- The background Windows runtime launcher now passes `-NonInteractive`; desktop
  runtime startup cannot answer a shell prompt. The old launcher fails the targeted
  assertion and the revised launcher passes all 21 desktop preview checks. This
  is a bounded launcher correction; it is not yet proven to fix the CI timeout.
  Native terminal login remains interactive through its separate launcher.
- Local actual packaged-runtime comparison on Mac passed with startup times
  1033/896 ms; runtime PIDs 84715/84840 are gone, graceful shutdown and immediate
  writable restart confirmed. Real SQL/DAX/DataDoc checks passed. This used the
  existing disposable 899bdcb app resources and current verifier/launcher code;
  no claim of a rebuilt or visually checked application is made.
- Local PowerShell behavioral checks and parity/BOM passed. Full Bash suite is
  still running. Evidence: /private/tmp/coop-desktop-home-20260907-state/,
  windows-native-environment-*.log, native-environment-macos-runtime.json/log,
  windows-native-899bdcb/native-application-check.json and full Windows job log.
- Files changed: desktop/src/coop-launcher.mjs, scripts/verify-managed-runtime.mjs,
  tests/desktop-preview-shell.test.mjs, .github/workflows/managed-desktop-smoke.yml,
  completion record and this log. Backup:
  .backups/windows_native_environment_20260908_003136/.
- Standards checked: shared runtime contract, isolated state, prompt-free background
  startup, process ownership, evidence before claims, and daily logging. Continue
  under existing user authorization for development fixes/commits/pushes; no release,
  production distribution, TeamAI installation, or user-profile changes. Next:
  finish regression and inspect the new Windows comparison/native/installer results.

- Final local validation completed: full Bash exit 0 (21 desktop preview, 16
  managed-runtime and 287 web-bridge checks), PowerShell exit 0, ShellCheck and
  Bash/JS syntax exit 0, parity/BOM and whitespace checks pass. A real pwsh
  `Read-Host` invocation with `-NonInteractive` returned an error promptly under
  a 10-second bound. Invalid environment selection also fails explicitly. These
  local results do not establish Windows native startup or installer acceptance.

## Native updater requires confirmed probe exit

- Found a production health-contract defect while Windows CI was building:
  nativeApplicationHealth returned true after a matching acknowledgement and main
  exit even if waitForProbeGroupExit returned false. The new real-child regression
  failed before the change with a missing expected rejection.
- Native health now requires confirmed close and process-group exit before success.
  Unconfirmed exit raises UPDATE_HEALTH_PROCESS_EXIT_UNCONFIRMED and retains the
  profile. Timeouts/cancellation bound termination; missing close events release
  observation pipes and reject instead of leaving the helper waiting forever.
- Replacement preserves its testing journal and both application copies for that
  error, without an immediate swap. Existing helper behavior leaves the recovery
  job armed and its resources available, with no normal app relaunch. The recovery
  worker already stops probes and checks the app before restoring it.
- Focused update checks pass all 51 tests, including an actual child with uncertain
  group observation, a missing close event, preservation/later recovery of app
  copies, and helper retention without relaunch. A first new transaction assertion
  expected a generic pending status; corrected it to the actual documented testing
  journal phase. Full Bash and PowerShell checks are in progress.
- Built a separate disposable Mac app at
  /private/tmp/coop-native-health-exit-app-20260908/mac-arm64/Coop Desktop.app,
  refreshed ASAR integrity and ad-hoc signature. Real packaged runtime healthy and
  wrong-version cases passed; native app health passed; temporary successful
  profiles removed and failed profile retained. PIDs 22921/23585/23810 and native
  process group were absent. No model generation or credentials copied.
- The additional uncertain-exit package test correctly rejected success, but its
  immediate process-group absence assertion raced asynchronous process shutdown.
  That test exited with failure; a separate test now waits through the existing
  bounded group-exit observer after injecting the uncertain result. This is test
  observation correction, not evidence that the first assertion passed.
- Windows managed CI 34191322027 at 9ff9896: Mac passed; Windows job 101949812003
  failed the new isolated-environment runtime comparison with the same 20-second
  readiness timeout, before Electron launch. This rules out an Electron-only
  startup cause and keeps isolated environment/Windows PowerShell investigation
  open. The noninteractive launcher did not resolve that timeout.
- Files: desktop/src/update-native-health.mjs, desktop/src/update-replacement.mjs,
  tests/update-service.test.mjs, desktop/README.md, completion document and daily
  log. Backups: .backups/native_health_exit_20260908_003957/. Evidence under
  /private/tmp/coop-desktop-home-20260907-state/: native-health-exit-* and
  windows-native-9ff9896-job.log. Standards: process ownership, recovery-before-
  replacement, isolated profiles, no unverified success, backups and daily logging.
  Next: finish package/regression verification, commit/push the development fix,
  then trace Windows PowerShell startup under the isolated environment. No release,
  production distribution, user-profile mutation or parity promotion.

- Final validation: full Bash exit 0 (51 update checks and 287 web-bridge checks),
  PowerShell behavioral suite exit 0, Bash/JS syntax, ShellCheck, parity/BOM and
  whitespace checks pass. Packaged ASAR and helper copies of the changed native
  health/replacement modules plus the Windows launcher equal source; package/fuse
  verification and post-use deep strict signature verification pass.
- The corrected additional native package check passed: PID/group 28516 exited,
  injected unavailable exit confirmation rejected healthy status, and its profile
  was retained. Receipt native-health-exit-uncertain-managed.json explicitly records
  the injected observation. All local process/test handles for this slice are
  terminal. Windows managed CI 34191322027 is terminal failure; regular CI
  34191322025 was still running at the last authoritative observation.

## Windows shell startup diagnosis

- Latest inspected source is 5adc79c on the authorized Desktop development branch;
  worktree was clean and origin fast-forward check succeeded before this slice.
  Managed CI 34192066033 is terminal failure: Mac passed, Windows job 101951987534
  again failed the isolated-environment runtime comparison. Regular CI 34192066034
  and prior 34191322025 remained live at their last observations and were not restarted.
- Added a Windows-CI-only diagnostic runner before runtime acquisition. It runs a
  fixed in-process PowerShell command in four cases: native environment with null
  stdin or a closed pipe, and a whitelisted set of standard Windows machine fields
  with the same two input modes. It never inherits credentials, NODE_OPTIONS or the
  real user-profile paths into these probes; it does not change acceptance settings.
- Each command has a 10-second bound, bounded output, and an explicit PID-exit check.
  An unknown exit stops the matrix. Receipts record case name, duration, PID, exit
  status, error code and output byte counts; shell output and environment values are
  not logged. The workflow preserves windows-shell-diagnostics.json even on failure.
  These cases distinguish shell initialization/environment/input behavior; they do
  not by themselves establish successful Coop script dispatch or runtime readiness.
- All 19 targeted managed-runtime checks pass. New checks verify environment/profile
  separation, rejection of unconfirmed exit, exact fixed invocation, and actual
  Node child shutdown after both successful completion and timeout. Full Bash is
  running; PowerShell behavioral checks passed. Existing Windows native app and
  installer gates remain in place and unproven.
- Files: desktop/scripts/diagnose-windows-shell.mjs, tests/managed-runtime.test.mjs,
  .github/workflows/managed-desktop-smoke.yml, completion document and daily log.
  Backup: .backups/windows_shell_diagnostics_20260908_005111/. Evidence prefix:
  /private/tmp/coop-desktop-home-20260907-state/windows-shell-diagnostics-.
  Standards: bounded owned-process observation, isolated profiles, test evidence,
  backups and daily logging. Next: finish regression, push diagnostics, inspect
  the native Windows result and fix the demonstrated cause. No user profile, app
  install, release, TeamAI configuration or production distribution changed.

- Final validation: full Bash exited 0 with 19 managed-runtime and 287 bridge checks;
  PowerShell, ShellCheck, Bash/JS syntax, parity/BOM, YAML parsing and whitespace
  checks pass. Final targeted 19 checks also pass after allowing five seconds for
  a healthy Node fixture to start on loaded runners (the timeout fixture still
  uses 500 ms). Prior regular CI 34191322025 is now terminal success. Regular CI
  34192066034 remains live; its handles were not cancelled or restarted.

- The commit hook flagged the new test's literal dummy credential value as a
  possible secret. It was a verified fixture, not a credential; shortened that
  literal to `fixture` and reran all 19 targeted checks successfully. The hook
  remains enabled and no bypass was used.

## Managed launcher PATH isolation from Windows VM work

- Discovered the VM's published development branch
  feature/coop-desktop-windows-validation-e70a41a, commit
  8b9449656203a893e4d8dff983eca4a59f27114d (September 8 00:28 CDT). Its commit
  records a native full Bash/parity validation snapshot and partial GUI evidence;
  final installed-app acceptance remains incomplete. The branch has 75 changed
  files relative to e70a41a and is not merged wholesale. Other MCP, native tool,
  companion, Windows job/replacement and GUI work still requires reconciliation.
- Reviewed and adapted its managed-mode PATH guards into current bin/coop,
  bin/coop.ps1 and both common helpers. Managed startup no longer queries global
  npm prefix or prepends workstation fallback directories. Kept ordinary terminal
  PATH behavior unchanged; did not import the VM's broader fallback reordering,
  timeout increase or other runtime changes over our current implementations.
- A before-change executable regression proved managed help/startup still called
  npm prefix discovery (marker unexpectedly present). Both terminal and managed
  cases now pass: normal terminal still discovers globals, managed does not.
  Another test supplies existing fallback folders and proves common helpers retain
  PATH exactly. All 21 targeted managed-runtime tests pass; PowerShell BOM retained.
- Windows diagnostic artifact 10042858627 from c19e996 CI 34192689333 records all
  four shell cases healthy with confirmed exit: native/null-input 2111 ms, native/
  closed-pipe 195 ms, machine-fields/null-input 182 ms, machine-fields/closed-pipe
  185 ms. Thus basic PowerShell startup works without extra machine fields and
  with null stdin; this does not establish successful Coop script dispatch.
  Windows runtime still timed out later. Mac job 101953809618 passed.
- Built a new disposable package at
  /private/tmp/coop-managed-path-app-20260908/mac-arm64/Coop Desktop.app with the
  four current launch/helper scripts; signing and complete validation are running.
  Evidence root /private/tmp/coop-desktop-home-20260907-state/: managed-path-isolation-*
  and windows-shell-c19e996/windows-shell-diagnostics.json. Backup:
  .backups/managed_path_isolation_20260908_010103/.
- Files: the four paired scripts, tests/managed-runtime.test.mjs, desktop/README.md,
  completion document and daily log. Standards: managed dependency isolation,
  cross-platform parity/BOM, process-owned verification, backups and daily logging.
  Next: complete regression and packaged checks, push the fix, inspect native
  Windows readiness/installer results, then reconcile remaining VM work. No user
  profile, production release, signing policy, TeamAI setup or parity gate changed.

- Final local validation completed: full Bash exit 0 (21 managed-runtime and 287
  web-bridge checks), PowerShell, ShellCheck, Bash syntax, parity/BOM and whitespace
  checks pass. Package verification passed; all four packaged scripts equal source
  and post-use deep strict signature verification passed.
- Packaged runtime with native isolated environment passed two writable starts in
  622/615 ms; PIDs 61964/62195 are gone and graceful shutdown is confirmed. Native
  Electron probe passed renderer/chat readiness, clean exit and profile removal;
  PID/group 61332 is gone. Receipts: managed-path-isolation-runtime.json,
  managed-path-isolation-native.json and managed-path-isolation-package.json.
  This proves local Mac behavior only; Windows timeout resolution remains unproven
  until the next CI run. All local test/build handles are terminal.
- c19e996 managed CI 34192689333 is terminal failure as recorded above; regular CI
  34192689328 still has a live Windows Pi compatibility job 101953809434. Earlier
  5adc79c regular CI 34192066034 is terminal success. No live run was restarted.

## Managed extension tool invocation and packaged Pi verification

- Adapted the Windows VM managed-tool invocation fix into the current extension:
  SQL/DAX review, Data Doc scan/build/check/lineage, setup capability detection,
  and the JSONL wizard use the manifest-owned Python interpreter and entrypoint.
  Windows .cmd/.ps1 shims are no longer required by these Pi exec calls. Arguments
  remain an array and cancellation/options remain under Pi's execution API.
- Corrected the VM helper's rejection of the shipped Mac python3 symlink; only
  interpreter links resolving within the bundle are accepted. Entry scripts must
  be regular non-link files. Python -I -B -X utf8 prevents host Python injection,
  bytecode writes into signed resources, and Windows pipe encoding ambiguity.
- Before-change wizard regression fails on command-only Windows shims; the current
  resolver passes. Full Bash, PowerShell behavioral, Bash syntax, ShellCheck,
  parity/BOM and whitespace checks pass. Managed-runtime tests now total 25 on Mac
  (the POSIX file-symlink case is skipped on Windows; junction coverage remains).
- A disposable Mac package loaded the actual shipped TypeScript extension through
  bundled Pi loadExtensions, then invoked its registered tools with Pi's real exec
  implementation under an isolated, credential-free environment. Synthetic paths
  contain spaces, accented characters and ampersands. SQL Review produced the
  expected SQL-NO-SELECT-STAR finding; DAX Review produced five findings including
  DAX-BIDI-RELATIONSHIP; Data Doc produced six nodes/five edges and returned the
  silver.dim_customer lineage slice. This is local Mac package execution evidence,
  not native Windows or model-generation evidence.
- Package verification, native renderer/chat readiness, native profile cleanup,
  and process/group absence passed. Packaged helper/extension bytes match source.
  Disposable app: /private/tmp/coop-managed-tools-app-20260908/mac-arm64/Coop Desktop.app.
  Evidence: /private/tmp/coop-desktop-home-20260907-state/managed-tools-*;
  backup: .backups/managed_tool_invocation_20260908_011139/.
- Prior HEAD 1de488d regular CI 34193425232 completed successfully. Managed CI
  34193425283 completed with Mac success and Windows isolated-environment runtime
  timeout; native Windows app/installer stages were skipped. The managed PATH
  guard did not resolve that timeout. Windows startup diagnostics and remaining
  VM changes still need reconciliation. No release gate is promoted by this slice.
- Standards applied: managed dependency isolation, literal invocation, ordinary
  terminal compatibility, process-owned verification, backups and daily logging.
  TeamAI remains an assessed integration option only; no installation/configuration.

## Opt-in runtime startup stage diagnosis

- Previous slice made concrete progress: 8a74722 was committed/pushed with real
  packaged extension-tool execution and full local/native Mac checks. Its current
  managed Windows job 101960223041 failed at isolated runtime readiness again;
  the Mac and regular CI results are being followed by their original run IDs
  34194844824/34194844832. No run was restarted or timeout relaxed.
- Added paired Bash/PowerShell opt-in COOP_RUNTIME_STARTUP_TRACE stage labels at
  dispatcher entry, helper readiness, PATH readiness, prerequisites, preflight,
  launch-spec generation and server launch. Node reports module readiness and
  listening. Fixed labels use stderr only; no argument, path or environment value
  is included. The managed verifier enables tracing and prefixes stderr chunks
  with cycle/elapsed milliseconds while retaining the 20 s native deadline.
- The prior package reproduced the missing-diagnostics gap. Current regression
  coverage runs real Bash and available PowerShell, checks tracing off by default,
  verifies fixed stage-only stderr, and requires identical stdout with/without
  tracing. All 26 targeted managed-runtime checks pass locally.
- Disposable Mac package at /private/tmp/coop-startup-trace-app-20260908 passed
  two isolated writable runtime starts, exact ordered traces for both cycles,
  real synthetic tool work, native renderer/chat readiness, profile cleanup and
  process/group absence. Packaged dispatcher/server bytes match source and package
  checks plus post-use deep strict signature verification pass. Evidence root:
  /private/tmp/coop-desktop-home-20260907-state/startup-trace-*.
- Backup: .backups/runtime_startup_trace_20260908_013140/. Standards: paired scripts,
  PowerShell BOM, literal diagnostics, process-owned acceptance, backups/logging.
  Full Bash verification is still running; PowerShell behavioral, parity/BOM,
  Bash syntax and ShellCheck passed. Windows startup cause remains unproven;
  the trace adds actionable evidence for its next native CI run.
- Local runtime startup times: [621, 619] ms; runtime PIDs [9198, 9425] and native PID 8885 are absent.
- Final full Bash suite completed successfully, including 26 managed-runtime
  checks and the web bridge suite. All local handles are terminal. Prior 8a74722
  managed CI 34194844824 is terminal: Mac success, Windows isolated runtime
  failure. Regular CI 34194844832 remains in progress.

## Narrow Windows bootstrap diagnosis and MCP integration review

- Previous turn was progress: eea8a60 startup traces were committed/pushed and
  passed local/native Mac checks. Managed CI 34195451009 is now terminal: Mac
  101962049312 succeeded; Windows 101962049504 failed isolated runtime readiness.
  The failed step emitted none of Coop's first dispatcher markers. The same
  package under inherited CI environment reached server-listening at 1099 ms on
  its second cycle. Investigation therefore moves before the Coop dispatcher,
  into generated bootstrap/script loading rather than extension initialization.
- Added bootstrap entry/root-ready/dispatch markers to both generated launchers.
  Extended the Windows-only diagnostic matrix with minimal -File and -File plus
  Split-Path cases, each under native isolation and diagnostic machine fields.
  Fixed BOM scripts execute no child commands; results retain only recognized
  stderr stage labels. Every process still has a 10 s bound and confirmed-exit
  requirement before the next case. Native acceptance keeps its 20 s deadline.
- All 27 focused managed-runtime tests pass. New coverage runs generated staged
  Bash with tracing and checks unchanged stdout, exercises fixed PowerShell files
  and verifies BOM/literal file invocation, known-stage filtering and real exits.
  An additional generated Windows bootstrap ran through local PowerShell 7 with
  Unicode/spaces/ampersands, reached its synthetic inner dispatcher, emitted all
  three markers and preserved stdout. This is not Windows PowerShell 5 evidence.
- Disposable Mac package /private/tmp/coop-bootstrap-trace-app-20260908 passed
  two isolated writable starts with the complete 12-stage sequence each time,
  synthetic tool work, native renderer/chat readiness, profile cleanup and
  process/group absence. Package/fuse verification and post-use strict signature
  verification passed. Evidence: /private/tmp/coop-desktop-home-20260907-state/
  windows-bootstrap-* and windows-startup-trace-ci-{full,failure}.log.
- Independently reviewed the VM MCP correction against synthetic configs through
  the actual shipped adapter config loader. Before correction it includes the
  generic global source; afterwards that source and automatic import discovery
  are excluded. Explicit imports in the selected profile are still honored.
  With no explicit import, only owned profile and project sources remain. An
  initial assertion expecting explicit imports to be blocked failed and is saved
  in mcp-isolation-review-first-assertion.log; the review now records the actual
  distinction. MCP code has not been integrated or user configuration changed.
- Backup: .backups/windows_bootstrap_trace_20260908_014441/. Standards applied:
  paired generated launchers, PowerShell BOM, isolated bounded diagnostics,
  process-owned acceptance, backups and logging. Full Bash suite remains live;
  PowerShell behavioral, Bash syntax, ShellCheck and parity/BOM checks passed.
  8a74722 regular CI 34194844832 is now success. eea8a60 regular CI 34195450970
  still has Windows Pi compatibility job 101962049225 live. No run was restarted.
- Local startup times: [631, 601] ms; tracked PIDs [33770, 33961, 33339] are absent.
- Final full Bash verification completed successfully. The focused 27-test
  managed-runtime suite was rerun after matching the diagnostic scripts to the
  real bootstrap Stop-on-error behavior and passed. All local handles are
  terminal. Prior eea8a60 regular CI 34195450970 is now terminal success.

## Closed runtime input and repeatable packaged extension-tool acceptance

- Previous turn was progress: 3f5dedd bootstrap diagnostics were pushed and
  validated locally. Managed run 34196626176 is terminal failure: Mac job
  101965680477 succeeded; Windows 101965680709 timed out in native isolation.
  Artifact 10044265942 and windows-bootstrap-ci-failure.log show the bootstrap
  enters at 222 ms but does not complete Split-Path. Fixed -File/.NET probes pass
  in 199/186 ms; -File plus Split-Path times out around 10 s with both native and
  diagnostic machine-field environments. All diagnostic PIDs are confirmed gone.
- Changed launcher stdin from the null device to an immediately closed pipe;
  runtime clients still use HTTP. Added the missing cmdlet/closed-pipe diagnostic
  cases so native CI can test whether this addresses the observed Windows stall.
  Windows resolution remains a hypothesis until those results arrive. A real
  child regression rejects null-device stdin before the change (exit 7), then
  receives EOF through the pipe and shuts down cleanly afterwards.
- Promoted the earlier manual extension exercise into verifyManagedExtensionWork,
  called by the staged/packaged runtime verifier. It uses the actual packaged Pi
  loader and exec implementation, synthetic Unicode/space/ampersand paths, private
  temporary profile/environment, exact SQL/DAX findings, generated lineage graph
  and a focused lineage lookup. It restores caller environment and removes its
  scratch state on success/failure. A failing-loader regression checks both.
  This verifies registered tools without requesting provider/model generation;
  it does not establish full-session or Microsoft authentication acceptance.
- Built a new disposable native app at /private/tmp/coop-closed-input-app-20260908
  with the changed runtime supervisor; ASAR supervisor bytes equal source. The
  first build command hit the previously known broken Hermes npm shim, reported
  an error yet exited 0 and created no app. Retained extension-input-build.log,
  then used the explicit Homebrew Node/npm path for the successful build recorded
  in extension-input-build-actual.log. No live build was restarted.
- New app passed isolated writable startup/restart, direct and Pi-registered tool
  work (one SQL finding, five DAX findings, six lineage nodes/five edges), native
  renderer/chat readiness, profile cleanup, process/group absence, package/fuse
  inspection and post-use deep strict signature verification. Evidence root:
  /private/tmp/coop-desktop-home-20260907-state/extension-input-* and runtime-input-*.
- Read-only companion review fetched the exact VM Data Doc commit 8ed8344: its
  changes beyond our current pin normalize lineage paths and explicitly encode
  JSONL stdio as UTF-8. No companion pin or checkout was changed; reconciliation
  remains open, as do MCP integration and Windows native/installer acceptance.
- Backup: .backups/managed_extension_acceptance_20260908_015659/. Standards:
  process-owned lifecycle, isolated profile data, literal arguments, authoritative
  package/tool verification, backups and logging. PowerShell, Bash syntax,
  ShellCheck and parity/BOM passed. Full Bash verification remains live; regular
  CI 34196626126 remains live and has not been restarted.
- Local runtime startup times: [509, 508] ms; runtime/native PIDs [68865, 69048, 67544] are absent.
- Final full Bash suite passed, including 27 managed-runtime and 22 Desktop
  preview checks. Final focused build-plan/verification checks also passed after
  adding bounded synthetic-fixture failure detail. All local handles are terminal.
  Native Windows confirmation and installer acceptance remain open.


## Reviewed VM companion pins and Windows verifier environment

- Resumed authoritative dirty files from the preceding implementation turn;
  the TeamAI response was a read-only architecture assessment, not an installation
  or integration. The preceding implementation yielded wheel/test evidence that
  determined this slice. No active local or CI job was restarted.
- Development pins now use Data Doc 8ed8344b20b4c27fd8edb3e043c96f0f46b2b939
  (Windows lineage path normalization and explicit UTF-8 JSONL stdio) and DAX
  7d26424bc97c58c88a93266486b3eb110e6457c6 (native Windows unreadable-file
  regression coverage). SQL remains 07d94a06b732f3f34085a48d60ffc637c806faa8.
  Reviewed exact detached companion snapshots; active companion checkouts and
  environments were not changed. Data Doc: 635 tests; DAX: 624 tests; both lint
  and format checks passed. Wheels were built from exact Git archives and hashes
  independently rechecked against development-wheels.json.
- Corrected the registered-tool verifier's case-sensitive plain environment
  snapshot lookup: required Windows operating-system fields are now selected
  case-insensitively. The explicit allowlist continues to exclude caller model
  credentials, NODE_OPTIONS and external tool PATH. Error output retains the
  final 4000 characters so a Python exception's cause survives truncation.
  Seven focused build-plan/verifier checks pass. Native Windows confirmation
  of the fix remains required; the earlier truncated _overlapped import failure
  does not establish its full cause.
- Built /private/tmp/coop-vm-pins-package-20260908/managed-runtime and the fresh
  disposable /private/tmp/coop-vm-pins-app-20260908/mac-arm64/Coop Desktop.app.
  The builder completed before its owned output was relocated beneath the
  required managed-runtime directory name. No job was restarted. Both staged
  and packaged runtime checks passed real raw-Python and Pi-registered SQL/DAX
  findings, six lineage nodes/five edges, and focused object lookup. Staged
  startup/restart: 2353/470 ms; packaged: 473/484 ms. Runtime PIDs 85140, 85525,
  99276 and 99446 are absent. Native renderer/chat readiness passed; PID 94617
  is absent and its disposable profile was removed. Post-use deep strict ad-hoc
  signature verification passed. No visual or real-model claim is implied.
- Exercised the packaged Data Doc JsonlWizardIO with real pipes initially set to
  ASCII, then exchanged accented/Chinese prompt and path text. The UTF-8 hello,
  prompt, answer and notice roundtrip passed with LF framing. This is transport
  evidence, not a complete interactive setup acceptance journey.
- Full local Bash and PowerShell behavioral suites, Bash syntax, ShellCheck,
  JavaScript syntax and parity/BOM checks passed. Evidence is under
  /private/tmp/coop-desktop-home-20260907-state/vm-companion-*.
- c22f6f7 managed CI 34197950117 is terminal: Mac 101969814409 passed; Windows
  101969814778 failed in the new registered-tool check before packaging. Its
  fixed Split-Path probes time out with both null and closed-pipe stdin, ruling
  out stdin as the explanation for that startup stall. Regular CI 34196626126
  passed. Regular c22 CI 34197950138 is terminal failure: Windows logic job
  101969814860 timed out in the global-npm-discovery launcher fixture; its other
  six jobs passed. Preserve windows-logic-c22f6f7-failure.log for investigation.
- Fetched VM commits cf59082/5084aa7 (agent readiness and validation handoff) and
  updater component commit 8d6b0ab read-only. They are not integrated here. VM
  handoff still reports native GUI readiness failure and incomplete installed
  updater orchestration. Native Windows startup, installer/update acceptance,
  VM integration, MCP isolation and the full release checklist remain open.
- Files: config/development-companions.json, scripts/verify-managed-tool-work.mjs,
  tests/managed-runtime-build-plan.test.mjs, Desktop README and this status/log.
  Standards: exact dependency provenance, isolated profiles, literal arguments,
  authoritative process cleanup, backup and daily logging. Source backup:
  .backups/vm_companion_pins_20260908_021436/; documentation backup recorded below.
- Documentation backup: .backups/vm_pins_acceptance_20260908_022733/


## Agent readiness and toolbar recovery from VM validation

- Previous goal turn was progress: 2708b6b committed verified companion pins and
  corrected Windows verifier environment casing. CI 34199451531 is now terminal:
  Mac 101974649281 passed; Windows 101974648923 passed staged/packaged real tool
  execution, package/fuse checks and inherited-environment restart, then stalled
  at bootstrap-enter in native isolation. Artifact 10045371105 is retained under
  /private/tmp/coop-desktop-home-20260907-state/windows-2708b6b. Packaged Windows
  startup/restart was 1155/1216 ms. The earlier _overlapped import failure is no
  longer present after the environment fix. Windows native startup is unresolved.
- Ported the reviewed cf59082 agent-readiness handling into current main/renderer
  code without replacing the other VM branch changes. Fresh navigation now waits
  for a real get_state answer even when there are no saved chats. Only read-only
  startup timeouts retry (three attempts); authentication failures and runtime
  replacement stop recovery. Saved navigation retains its existing protections.
- Toolbar status reflects agent connection readiness; model/thinking controls
  refresh after a timeout. Completed replies and deferred retries cannot overwrite
  another selected chat. Extended the VM change to refresh state on polling-mode
  selection/bootstrap and to avoid unconditional ready labels after compaction or
  retry cancellation. Kept the final native health RPC as a separate single check.
- Reproduced the missing toolbar-retry behavior before the port in
  vm-readiness-before.log. Focused Desktop checks now pass (26), including fresh
  navigation waiting, timeout/replacement handling and polling selection. Full
  suites exposed an outdated isolated toolbar fixture; updated its timer/readiness
  globals and realistic success response envelope, retaining and extending stale
  reply assertions. Focused theme tests and final PowerShell suite pass. Original
  failed runs are retained; the final full Bash run remains tracked separately.
- Restaged managed assets from the already verified private dependency inputs,
  rebuilt /private/tmp/coop-readiness-app-20260908/mac-arm64/Coop Desktop.app, and
  verified its renderer, main and readiness module bytes equal source. Native
  renderer/chat readiness and profile cleanup passed; PID 5946 is absent. Post-use
  deep strict ad-hoc signature verification passed. No visual or real-model
  acceptance is claimed. Bash/JS syntax, ShellCheck and parity/BOM checks pass.
- Evidence: /private/tmp/coop-desktop-home-20260907-state/vm-readiness-*; backup:
  .backups/vm_readiness_20260908_023045/. Files: main.mjs, runtime-readiness.mjs,
  app.js, Desktop/theme tests and README. Standards: actual readiness, read-only
  retries, session/generation isolation, preserved recovery state, backups/logs.
- Next: diagnose first-cmdlet loading in isolated Windows PowerShell (stdin is
  already ruled out); complete native Windows installer/update acceptance and
  remaining VM reconciliation. Regular CI 34199451527 was last confirmed live
  in its Windows Pi compatibility job; do not restart it. Goal remains active.
- Final full Bash regression completed successfully after the fixture update.
  Both full local suites are green; all local build/test/probe handles are terminal.


## Windows first-module diagnosis

- Previous turn was progress: 12b6454 ported agent readiness and verified a rebuilt
  native Mac app. This slice targets the remaining Windows first-Split-Path stall.
- Added three child-only Windows CI cases to distinguish built-in module search,
  module-analysis file cache, and explicit management-module import. The explicit
  import disables automatic module loading, addresses the OS module manifest via
  PSHOME and reports fixed before/after import markers before Split-Path.
  Production launcher and native acceptance environment/deadlines are unchanged.
- Preserved diagnostic privacy and lifecycle contracts: no caller credentials or
  real profile paths are copied into the new cases; arguments remain literal,
  generated files use UTF-8 BOM, output retains only known markers/counts/timing,
  and uncertain process exit stops further probes. Local real-PowerShell execution
  of all fixed file scripts passes, including explicit import. Focused managed
  checks pass (28); baseline missing-case assertion and passing output are retained
  in windows-module-diagnosis-before.log and windows-module-diagnosis-after.log.
- Microsoft documents PSModulePath and the process-local NUL cache setting in
  https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_environment_variables?view=powershell-5.1.
  Those are diagnosis hypotheses, not a Windows fix or proof of root cause.
- Full local PowerShell tests, Bash/JavaScript syntax, ShellCheck and parity/BOM
  passed. Full Bash remains on its original live handle until completion. Evidence:
  /private/tmp/coop-desktop-home-20260907-state/windows-module-diagnosis-*.
  Backup: .backups/windows_module_diagnosis_20260908_024209/.
- Read-only review of VM updater 8d6b0ab confirms its metadata helper already
  limits module paths after a PowerShell 7 parent caused native signature lookup
  failure. This is supporting evidence for checking discovery paths, not proof
  that the isolated bootstrap has the same cause. Preparation components remain
  unintegrated. Fetched and reviewed 867c987 (health pipe-write completion and
  Windows taskkill/close race handling) for a subsequent compatible port.
- No new runtime package was needed: this slice changes only the CI diagnostic,
  its tests and documentation. Native Windows startup, installer/update acceptance,
  remaining VM reconciliation and the full release requirements remain open.
- Final full Bash suite passed; all local handles are terminal. Managed CI
  34200532260 is terminal: Mac 101978043788 passed, Windows 101978043603
  failed at isolated bootstrap startup. Regular CI 34200532244 remains live.


## Flush native health acknowledgement before exit

- Previous turn was progress: 0e517e5 added module-loading diagnostics. Ported the
  compatible health-write change from VM commit 867c987 into the current main
  process. Runtime shutdown still completes first; Electron now waits for the
  stdout write callback before quitting. A write error rejects the health path.
  The VM's separate taskkill/close-race change remains to be reconciled.
- Baseline regression reproduced premature quit with a pending callback. The
  updated test proves delayed completion, write-error rejection and no success
  acknowledgement after runtime-stop failure. All 51 updater service checks pass.
  Full local Bash and PowerShell suites, syntax, ShellCheck and parity/BOM passed.
- Built /private/tmp/coop-health-flush-app-20260908/mac-arm64/Coop Desktop.app from
  current main code and the previously verified runtime assets. Packaged main and
  renderer bytes equal source. Native renderer/chat/health acknowledgement,
  shutdown and temporary-profile cleanup passed; PID 62457 is absent. Post-use
  deep strict ad-hoc signature verification passed. No real-model, visual or
  Windows acceptance is inferred. All local handles are terminal.
- Evidence: /private/tmp/coop-desktop-home-20260907-state/native-health-flush-*;
  backup: .backups/native_health_flush_20260908_024901/. Files: main.mjs, updater
  tests and README. Standards: evidence-bearing health responses, no acceptance
  before shutdown, failed writes fail closed, backups and daily logging.
- Windows artifact 10046001882 from run 34201125539 is retained in
  windows-modules-0e517e5. The new explicit-management-module case passes in
  532 ms, including import-ready and split-path-ready. Built-in-only module
  search and disabled analysis cache both still time out around 10 s; all
  diagnostic processes exited. This isolates a working alternative to automatic
  command discovery. Next test: explicit trusted built-in module loading before
  the managed bootstrap's first cmdlet, then native app/installer acceptance.
  This diagnostic success alone does not establish a working Windows app.


## Explicit managed Windows module bootstrap

- Followed the native diagnostic evidence from 0e517e5: explicit management import
  completed in 532 ms while ordinary command discovery, reduced module search and
  disabled file cache all timed out. Added a fixed management/utility import
  prelude to the generated Windows launcher before any cmdlet. Import paths are
  derived only from PSHOME. Automatic loading is disabled during imports and the
  caller's policy is restored in finally; normal terminal startup is unchanged.
  Added an opt-in bootstrap-modules-ready trace marker.
- Focused managed tests pass (29). The new real-PowerShell test uses the native
  isolated environment on Windows and tests path/JSON cmdlets plus policy
  restoration. The first full PowerShell run on Mac exposed the Homebrew nested
  executable's missing .NET host location; the test now preserves only the
  non-Windows DOTNET_ROOT variants needed for that host runtime. Windows isolation
  is unchanged. Retained the original failure; final full PowerShell and full
  Bash runs passed. Syntax, parity/BOM and diff whitespace checks passed.
- Additional local actual-pipe checks preserve null, All, None and ModuleQualified
  policies and confirm process exit. Executed the actual generated Windows
  launcher with a disposable dispatcher under macOS PowerShell: BOM, module/root/
  dispatch traces, profile routing and Unicode/ampersand literal arguments pass.
  These checks prove generated-script behavior on Mac, not native Windows startup.
- Evidence: /private/tmp/coop-desktop-home-20260907-state/windows-managed-modules-*
  and windows-managed-bootstrap-generated.json. Backup:
  .backups/windows_managed_modules_20260908_025712/. Files: new
  scripts/windows-managed-modules.mjs, staging script, managed tests and README.
  Standards: trusted OS module paths, unchanged caller policy and profile
  isolation, no deadline relaxation, literal argv, backups and logging.
- All local handles are terminal. Prior regular CI runs 34201125391 and
  34200532244 are terminal success. Managed 34201125539 is terminal failure:
  Mac passed and Windows still failed before this bootstrap change. Native
  Windows acceptance of the new prelude, installer/update lifecycle and the
  remaining release requirements stay open. No release or production signing.

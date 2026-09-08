# Coop Desktop development

The Desktop shell consumes `coop runtime`; it does not build Pi arguments or own
agent behavior. DSK-011 contains measured Electron and Tauri spikes. Electron is
selected for the production-oriented preview; the comparison and revisit trigger
are recorded in `docs/adr/desktop-shell-spike-results.md`.

The renderer is sandboxed with Node integration disabled, context isolation
enabled, permissions denied by default, navigation/window creation blocked, and
individually named preload methods. The main process validates the calling frame
before opening a native directory picker, returning non-sensitive shell metadata,
showing a bounded notification, or requesting a runtime-owned terminal handoff.
The preload also supplies a fixed read-only catalog of native commands. There is
no generic IPC, shell, or filesystem bridge.

The production-oriented preview implementation is in `src/`. Development
requires an installed Coop checkout plus the Desktop dependencies:

```text
cd desktop
npm install
COOP_BIN=/absolute/path/to/coop npm start
```

`npm run package:mac` and `npm run package:win` create unpacked, unsigned development
artifacts under `desktop/dist/`. They use the distinct
`com.cooptimize.coop.desktop.preview` identity and do not install or update the
normal Coop runtime. Production signing, updating, and managed-runtime release
approval remain separate release packages.

REL-001 now has an offline, fail-closed managed-runtime staging contract. A
platform CI worker supplies a complete Node distribution, an npm prefix holding
every target-applicable exact npm pin, a checksum-pinned relocatable Python
distribution, and one isolated package root per pinned Python tool:

```text
node scripts/stage-managed-runtime.mjs \
  --output /absolute/staging/managed-runtime \
  --node-root /absolute/node-distribution \
  --npm-prefix /absolute/pi-prefix \
  --python-root /absolute/relocatable-python \
  --python-tool coop-data-doc=/absolute/python-tools/coop-data-doc \
  --python-tool coop-sql-review=/absolute/python-tools/coop-sql-review
```

The command is network-free, validates all versions against
`config/release-manifest.json`, rejects external symlinks, stages into a fresh
temporary sibling, and refuses to overwrite an existing output. Managed package
commands require an explicit absolute bundle path:

`scripts/managed-runtime-build-plan.mjs <target>` emits the exact acquisition
plan for `darwin-arm64`, `darwin-x64`, or `win32-x64`. Node 22.22.3 and
python-build-standalone CPython 3.12.14 archives are pinned by primary HTTPS URL
and SHA-256 in `config/managed-runtime-build.json`; all npm, extension, MCP, and
Python package specs are derived from the release manifest rather than duplicated
in a build script. The target-worker preparer downloads and verifies those two
archives and installs packages only into its fresh build root. npm uses `ci` with
a checked-in target resolution in `config/managed-npm/`, whose root dependencies
must match the release manifest. Preparation rejects stale pins before acquisition
and rejects added/missing required packages or changed versions, archive URLs and
integrities after installation. The completion receipt includes the lock SHA-256.
Dependency updates require an explicitly refreshed target lock and fresh target
worker validation; preparation never refreshes a lock automatically.
Python uses per-target locks in `config/managed-python/` for every tool's exact
transitive versions and allowed archive SHA-256 hashes. Pip requires these hashes;
preparation then reconciles its download report and installed distribution metadata
against the lock. Authenticated development wheels retain the release version
constraint and use their recorded source hash. The receipt includes the Python
lock digest and verified package counts. The checked-in resolutions were generated
with uv 0.11.7 for CPython 3.12.14 using the previously tested inventory as exact
constraints; uv is not required to prepare a bundle.

macOS arm64 and Windows x64 require wheels throughout. Intel macOS explicitly
allows only cryptography 50.0.1 to build from its locked source archive in the
Fabric CLI and fabric-cicd environments: upstream removed Intel macOS wheel
support in version 49. See the [cryptography changelog](https://cryptography.io/en/49.0.0/changelog/).
Native Intel compilation and its build-toolchain/build-dependency locking remain
unverified. Runtime dependency locks do not establish reproducible Intel builds.
When an upstream npm shrinkwrap omits integrity, `scripts/complete-npm-integrity.mjs` downloads the
exact resolved HTTPS archive and compares its file set and every file's bytes
against the installed package. Only a complete match adds the archive's SHA-512
to the local resolution lock; a mismatch, unsafe archive, or partial failure
leaves the lock unchanged and stops preparation. This records acquisition evidence;
it does not substitute for signing or vulnerability review. The preparer then
invokes the network-free stager:

```text
node scripts/prepare-managed-runtime.mjs \
  --target darwin-arm64 \
  --work /absolute/nonexistent/build-root \
  --output /absolute/nonexistent/managed-runtime
```

```text
COOP_DESKTOP_MANAGED_RUNTIME_DIR=/absolute/staging/managed-runtime \
  npm run package:managed:mac --prefix desktop
```

Use `package:managed:win` on a Windows x64 worker. Cross-platform staging is not
treated as execution evidence: each bundle records and enforces its actual
platform and architecture. Production signing and clean-machine verification
remain separate gates.

For development acceptance of unpublished companion fixes, build wheels from the
exact Git commits in `config/development-companions.json`. The builder reads sibling
`coop-data-doc-desktop`, `coop-sql-review-desktop`, and `coop-dax-review-desktop`
repositories and archives the pinned commits; working-tree changes are excluded.
Use a Python installation with pip and a fresh output directory whose parent exists:

```text
python scripts/build-development-wheels.py --repositories /absolute/parent --output /absolute/new-wheels
node scripts/prepare-managed-runtime.mjs --target darwin-arm64 --work /absolute/new-work --output /absolute/managed-runtime --development-wheels /absolute/new-wheels/development-wheels.json
```

On Windows use native absolute paths and `--target win32-x64`. `--pins` on the wheel
builder accepts a JSON object with the same three names and full commit IDs, allowing
validation branches to test later committed fixes. The preparer authenticates a
private wheel snapshot by SHA-256, retains each exact release-version constraint,
and checks pip's installed archive receipt before recording provenance. Staging
places each source repository, commit, wheel filename and hash in the dependency
inventory; the package verifier reports them as `developmentSources`. Builds without
the explicit development input continue using published pins. These wheels retain
existing version numbers for development compatibility and are not published
releases; record the inventory and source commits with acceptance evidence. The
build backend and transitive dependencies may resolve differently on another
worker, so record actual wheel hashes and the generated dependency inventory.

The `managed desktop smoke` workflow runs on relevant pull-request changes and
manual dispatch, on native macOS and Windows workers. It checks out the exact
companion commits, builds their development wheels, prepares the locked runtime,
and verifies both the staged runtime and the copy inside the native app. Package
verification checks the ASAR boundary, Electron fuses and dependency provenance.
Build/runtime receipts and dependency inventories are retained for seven days as
CI evidence. These jobs create unsigned development apps; they do not publish a
release or prove installer, model sign-in, clipboard or Power BI acceptance.

Native npm packages declared for the target platform must appear in the committed
lock and the installed dependency tree, even when their parent declares them as
optional. This catches missing Fabric/Power BI MCP, image-processing, clipboard
and regex binaries before a managed bundle can pass verification. Cross-target
installation with lifecycle scripts disabled is a dependency check only; the
native CI build must also execute the platform's install scripts and runtime.

The managed-runtime verifier also runs the installed SQL Review, DAX Review and
Data Doc Python entrypoints against synthetic repository fixtures. It requires
the expected findings and SQL/model lineage, using bundled Python and temporary
home/work folders. Both staged and packaged CI checks record this tool-work
evidence. This exercises local analysis; it does not require a model account or
establish live Microsoft integration acceptance.

A packaged app uses `resources/managed-runtime` when present. It validates the
bundle contract, target, jailed paths, and Coop/Pi/Node/Python version agreement
before launch. A present but invalid bundle fails closed; it never falls back to
an unrelated installed Coop. Preview packages without a bundle continue to use
the installed launcher, and `COOP_BIN` remains an explicit development override.
Managed Desktop keeps auth/settings/sessions in a durable profile under its own
Electron user-data directory. `managed-agent/active-profile.json` records the selected
profile independently of runtime versions. Fresh installs use `profile-v1`; one
legacy versioned profile is adopted in place, while multiple profiles require an
explicit selection. Invalid or missing selected profiles are preserved for recovery;
Desktop never merges or rewrites Pi data. Its launcher refuses to run without that isolation context,
and loads exact Pi extensions directly from the immutable bundle, so it never
converges or rewrites the existing terminal user's `~/.coop/agent` tree.

REL-002 has a shell-neutral signed-update foundation in
`desktop/src/update-service.mjs`. It verifies an Ed25519 signature over the exact
bounded descriptor bytes against an app-pinned key registry. The signed key ID is
constrained by status, lifetime, channel, and allowlisted artifact/notes origins;
unknown and revoked keys fail closed. The service also enforces host target and
descriptor expiry, downloads without redirects or content encoding into an
exclusive owner-only file, enforces the signed size while streaming, checks
SHA-256, and removes failed partial downloads. It refuses activation
while Coop Runtime is live, and atomically records one verified prior version for
rollback while retaining signing-key and artifact-digest provenance. Activation
and rollback both require a named healthy check result bound to the exact release.
Production trust-key provisioning, download hosting, signing and notarization
remain release-worker responsibilities. macOS helper/UI integration is described
below; the version-state foundation alone is not a complete updater.
Packaged builds load trust only from `resources/desktop-update-trust.json` inside
the application archive; development/unprovisioned builds report updates disabled,
and a malformed present policy fails startup. Packaging enables Electron's
embedded ASAR integrity validation and only-load-from-ASAR fuses while disabling
Run-as-Node, Node option injection, CLI inspection, and extra file-protocol
privileges. No placeholder update key is checked in.
`npm run verify:managed-package` inspects the produced native binary rather than
trusting configuration alone: required fuses must match, loose application
fallbacks are forbidden, and the embedded managed runtime must pass its complete
version/path manifest validation.

`scripts/desktop-release-gate.mjs` emits the QA-002 release report for an exact
Git revision. It combines protocol alignment, the checked-in parity manifest,
and fresh hash-attributed Windows/macOS evidence. `--enforce` exits non-zero for
missing, failed, skipped, stale, wrong-revision, duplicate-platform, or
platform-inapplicable evidence. The current planning branch is expected to fail
that enforcement gate until the parity and clean-machine requirements are proven.

The preview adds native workspace selection, menus/shortcuts, background
completion notifications, confirmed external links, runtime crash/restart UX,
desktop-only window/workspace state, and open/clone/move terminal handoff. The
main process obtains terminal launch descriptors directly from authenticated
Coop Runtime and resolves the installed Coop launcher to an absolute path; the
renderer cannot choose a process, command, or argument.

The runtime-hosted renderer now includes the DSK-013 interaction controls shared
with `coop web`: provenance-preserving command discovery, runtime-reported
thinking levels, native Pi model/thinking cycle actions, explicit steer/follow-up
queues and modes, and bounded screenshot/image picker, paste, and drag/drop with
pre-send previews. Picker, paste and drop operations share a serialized read
queue, so overlapping imports enforce the same count/byte limits. While files
load, the composer shows a reading status and temporarily disables Send, Steer
and Follow-up; keyboard submission preserves the draft and explains the wait.
A failed read releases the queue so later files can still be attached.
Only one send request can await acknowledgement at a time; the text field stays
editable for the next draft. In-flight files retain their attachment capacity
until the result is known. On failure, the original text returns before any newer
draft and all admitted attachments remain available, including reads that finish
after recovery. Steer and Follow-up require Pi's successful acknowledgement before
showing a queued notice; a rejected command restores the draft.
Shared session controls also use Pi's native HTML export,
auto-compaction, auto-retry, and retry-abort commands. Desktop HTML export is
saved through a named main-process operation: the renderer supplies only the
session ID, the runtime owns the source artifact, and a native dialog owns the
destination. Desktop parity remains marked partial until these journeys are
interactively verified on macOS and a representative managed Windows VM.

The shared DSK-014 Health view now combines structured Coop Doctor checks,
separate model/client-Microsoft/knowledge identity states, progressive project
setup, and the private Coop user profile. Profile fields and limits come from
the existing Python onboarding owner. The project-contract action offers an
advanced YAML editor with server-side validation, exact before/after preview,
explicit apply approval, stale-write detection, and recoverable backup; guided
setup still routes to `/setup-project`. Data Doc setup routes to its existing
owner. Model login uses the fixed native terminal bridge because Pi 0.84.3 has
no structured RPC auth flow. The sign-in helper attaches read-only to the workspace
so it can share Desktop's profile without competing for the active writer lease.
Login-only mode closes after a new, complete Codex OAuth record is saved; empty,
unrelated, expired or pre-existing credentials do not count as a new sign-in.
Opening the model picker refreshes availability through Pi's public model registry
after external sign-in, without restarting the chat or making a model request.
Older runtimes without the refresh command retain their existing listing behavior.

The pinned pi-better-openai 0.1.22 package receives the checked
`lib/openai-usage-compat.mjs` correction during `coop sync` and managed staging.
It labels quota windows using the response's `limit_window_seconds`; absent
window lengths are labelled Primary/Secondary instead of guessed. Staging
preserves the acquired npm tree and records upstream and corrected source hashes
in `coop-compatibility.json`. Package verification checks both the exact corrected
source and receipt. A changed upstream version or source requires reviewing this
correction before setup can pass. Its fetch, authentication and model-scope logic
remain owned by pi-better-openai. npm inventory integrity describes the acquired
archive; the compatibility receipt describes the subsequent local correction.
Desktop consumes the shared extension status (including session replay), clears
missing values and does not submit background `/openai-usage` prompts.

Microsoft login execution and Doctor repairs remain
disabled until their shared Core operations exist.

On Windows, a normal installed `coop.cmd` is mapped to its trusted sibling
`coop.ps1` and an absolute PowerShell executable for runtime startup. This keeps
`shell: false` and avoids project-local command hijacking. Actual Windows VM
execution remains part of the Windows release gate; cross-packaging an x64
development artifact on macOS is not that gate.

The Tauri comparison lives under `spikes/tauri/`. It uses the same runtime/SPA
path and retains no role in Coop Core. Its Rust toolchain was installed only in a
temporary directory during the spike; normal Coop users do not need Rust.


## Automatic chat recovery

The source Desktop shell remembers up to eight open-chat references, their
workspace access modes and the active selection in its own `desktop-state.json`.
The actual runtime chat limit still applies. It checkpoints runtime-confirmed
references every ten seconds and before clean shutdown; Pi continues to own all
conversation and credential content. Unnamed empty chats reopen as new empty sessions; named empty sessions retain their durable reference.

At startup Desktop restores each reference through the existing runtime create
and resume operations. It does not replay a previous concurrent-write override.
Read-only chats retain read-only workspace access. Missing folders, missing
sessions and ownership conflicts appear in a Chat recovery side panel; unresolved
references are retained for a later restart. Valid chats still reopen. If every
attempt fails, Desktop attempts a read-only fallback in the startup workspace.
If the last selected folder disappeared, another existing saved folder is used
before showing a folder picker.

During startup recovery the renderer defers input and reconnect replay. Incomplete
or stale checkpoints cannot replace saved recovery state, and a runtime restart
invalidates commands from an interrupted restoration. Runtime metadata is read
through authenticated `/chat-state` and Pi's supported `get_state` command;
restoration uses the existing `/chat-new`, `/resume` and `/chat-close` boundaries.

This behavior requires a shell built from the current `src/` directory; older
packaged shells do not gain new IPC features merely from renderer updates.
macOS development-shell multi-chat, read-only, transcript and missing-reference
journeys are verified. A current locally ad-hoc-signed packaged preview also
passed multi-chat restoration, runtime SIGKILL/restart, and desktop-process
SIGKILL/relaunch with the repo runtime. Native Windows and managed-runtime
crash journeys remain release acceptance work.


## Installer builds

Installer packaging is separate from the unpacked development commands. After
preparing a native managed runtime, run on the target operating system:

```sh
COOP_DESKTOP_MANAGED_RUNTIME_DIR=/absolute/managed-runtime npm run package:installer:mac --prefix desktop
```

On Windows, set `COOP_DESKTOP_MANAGED_RUNTIME_DIR` to the absolute staged runtime
path and run `npm run package:installer:win --prefix desktop`. The configuration
`desktop/electron-builder-installer.cjs` produces a macOS DMG with an Applications
shortcut or a Windows NSIS wizard, retaining managed runtime isolation and fuses.
The Windows installer preserves app data on uninstall and does not automatically
launch Coop after setup. Both commands use `--publish never`; packaging does not
publish a release. Output defaults to `desktop/dist-installers`.

Signing and notarization must be configured separately on the release worker.
A locally ad-hoc-signed development app inside a DMG is not a production-signed
installer. The macOS in-app update flow now connects verified download and
preparation to a separate replacement helper. Windows helper support and full
production update acceptance remain outstanding.

Managed staging strips Python bytecode caches from Coop source, and both managed
launchers set `PYTHONDONTWRITEBYTECODE=1`. This keeps normal Python imports from
rewriting signed bundle resources. Native acceptance must verify the app signature
again after runtime use, not only immediately after packaging.


## Desktop icons

Windows application and NSIS installer/uninstaller icons use `themes/coop.ico`;
macOS uses `themes/coop.icns`. Both contain only the original Cooptimize logo from
`themes/cooptimize-logo.png`, copied from the shared review-core branding asset.
The previous hat/moustache artwork is no longer used.

To regenerate, fit the source proportionally within 900 × 900 pixels on a
transparent 1024 × 1024 canvas. Export Windows ICO sizes 16, 32, 48, 64, 128 and
256; for macOS, generate an iconset with 16, 32, 128, 256 and 512 pixel entries plus
each @2x equivalent, then run `iconutil -c icns`. Preserve the original colors,
lettering and transparency. Verify the built app's `CFBundleIconFile` resource
rather than relying on Finder's icon cache.


## Update checks and staging

The native Help menu includes Check for Updates. Production builds must bundle
both `resources/desktop-update-trust.json` and `resources/desktop-update-feed.json`
inside the app archive. Missing provisioning reports updates unavailable and
makes no network request; neither resource is read from workspace or user data.

The feed object has exactly `schemaVersion` (1), `channel` (stable or beta),
`descriptorUrl` and `signatureUrl` (public HTTPS URLs). The descriptor response is
the exact signed JSON bytes; the signature response is detached Ed25519 base64
with optional surrounding whitespace. No production endpoint or key is invented
by the build. Configured owners must supply them before release.

`desktop/src/update-controller.mjs` bounds feed reads, refuses redirects, validates
target/channel/time/signature, ignores older versions, deduplicates operations and
revalidates metadata before downloading. Verified staging uses the existing
exclusive-file/hash verifier and a download timeout. Paths stay in the main
process. The native menu offers a verified download with a cancellable progress dialog
and Dock/taskbar progress. Only a fully verified file is checkpointed; restart
recovery revalidates its signed metadata and file checksum before reporting it
staged. Quit cancels and awaits update cleanup.

On managed macOS builds, Install and restart transfers the app-pinned public trust
policy and verified download over private Node IPC to a packaged helper. The
helper prepares a checked candidate before the app closes. Desktop checkpoints
navigation and stops its runtime before authorizing the helper; the helper also
waits for both process IDs to exit and rechecks trust/expiry. It checks that the
installed app still has the expected identity/version, replaces it through a
journaled transaction, runs isolated runtime and native-app health probes, and relaunches
Coop with its existing user-data directory. Failed health checks restore the prior
app. New macOS replacements use an atomic directory exchange for activation and
rollback, keeping the normal app path present. The verified Python interpreter in
the stable prepared release invokes the native swap; unsupported filesystems fail
before replacement instead of falling back to two renames. Version 2 transaction
journals recognize interruption before or after backup placement, and recovery
still reads older version 1 journals. Adjacent backup app directories and
transaction archives are preserved.

Before requesting Desktop shutdown, the helper creates a verified copy of the
current app under user data's `update-recovery` directory and registers a temporary
per-user launch agent. Its worker waits while the helper is alive. After an
interruption it checks the boot-session identity, stops owned probes, validates
and restores the prior app from the journal, and reopens it. Completion or
cancellation removes the launch-agent registration; the recovery bundle and
journal remain for inspection. After a normal managed startup, cleanup keeps the
newest completed recovery and removes older completed jobs only when their launch
agent and saved launch plist are absent and no process references their directory. Pending, malformed,
changed or linked job directories are preserved. Cleanup never removes the
adjacent rollback app or update transaction archive. Ordinary launches during a pending transaction
show a brief notice and exit before runtime setup; only the updater's direct
health-probe child may start. If the helper dies after reopening a completed
update or rollback, recovery verifies the running app and removes its registration
without reopening or stopping that app. It never reads replacement signing keys from user
data. Native acceptance of this worker is tracked in the completion checklist.

After completion, confirmed rollback/reopen, or cancellation before activation,
the helper discards its own detached prepared copy once recovery is disarmed.
It verifies that the prepared directory and its parent still have their original
filesystem identities. Unfinished activation and changed directories remain
available for recovery; cleanup failures never prevent reopening the app. The
installed app, adjacent rollback copy and original download are separate files.

Failure to save the update outcome does not prevent relaunching a healthy or
verified restored application. An uncertain rollback still requires inspection.
After the managed app loads, a one-time native dialog reports update success or
failure. It ignores arbitrary stored message text, oversized files and symbolic
links; closing the dialog consumes that result, while a failed dialog or a newer
result remains available for the next launch.

The helper code is bundled under Resources/update-helper inside the signed app.
It never loads trust-key overrides from workspace or user data. The native health
probes check the runtime contract and Coop version, then launch the packaged app
with temporary user data and require renderer startup through the preload bridge,
a working chat RPC, a matching one-time health response and clean shutdown. Probe
timeout/cancellation terminates its process group. Successful probes discard their
own temporary profiles after confirmed shutdown; native cleanup also requires the
probe process group to be gone. Failed/interrupted checks retain their profiles for
diagnosis, and replaced directories or cleanup errors preserve the stored data.
This does not sweep older profiles, update downloads or transaction archives.
Native interruption/reboot
acceptance, Windows support and production feed/signing acceptance remain tracked
release requirements.
Passing controller/helper tests does not establish a complete production updater.

## Isolated Windows development acceptance

Use `npm run package:validation:win --prefix desktop` or
`npm run package:validation:installer:win --prefix desktop` with
`COOP_DESKTOP_MANAGED_RUNTIME_DIR` set to a fresh staged Windows bundle.
These select `electron-builder-windows-validation.cjs`, application ID
`com.cooptimize.coop.desktop.windowsvalidation`, and product name
`Coop Desktop Windows Validation`. They do not create automatic desktop/start-menu
shortcuts. The packaged development marker selects a separate default user-data
directory; an explicit `--user-data-dir` can choose a disposable profile on D:.
Keep the existing Coop installation and real workspaces outside the test paths.

Build companion wheels using the committed development pins above. The Windows
branch pins include the verified Data Doc UTF-8/path fixes and DAX native sharing
lock regression. Package version pins remain unchanged; inspect the verifier's
`developmentSources` and full dependency inventory to establish actual inclusion.

Managed `coop doctor` shares the shell's bundle inspection module, copied into
the staged runtime by `stage-managed-runtime.mjs`, and probes its Node, Python and
Python tool imports. Both terminal launchers and Desktop call this managed path.
It does not inspect or repair unrelated global pipx/npm installations. Model
authentication, workspace setup and connected integrations retain their separate
shared health contracts. Managed Doctor is read-only; dependency repair belongs
to Desktop install/update, and `--fix`/`--publish` are refused in the managed path.
See `docs/agent/windows-validation-2026-09-07.md` for observed native results and
open acceptance requirements; a source or package-verifier pass is not installed
GUI acceptance.

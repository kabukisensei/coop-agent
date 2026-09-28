# B1 — isolated Windows beta implementation

Status: September 28 development checkpoint for branch review. No beta acceptance
or stable promotion yet.

The E: development candidate has been reconciled onto v0.23.5
`3c2b5a2b770e8523374139a4937e1830e278fe29` in branch
`codex/b1-isolated-windows-beta-v0235`. Aaron authorized its commit and push on
September 28 for master-plan review. B1 is recorded in
[commit `2f8d1ba`](https://github.com/kabukisensei/coop-agent/commit/2f8d1badace71c8f20e346b21ec67193a5d9635d),
with the first S2 cleanup in a separate following commit. The
[master plan checkpoint](COOP_WINDOWS_TERMINAL_PLAN.md#september-28-review-checkpoint)
is the current review handoff; dated statements below retain their historical
meaning. The separate actual-package E: rehearsal installation still uses its
synthetic source, described below; publication has not updated that installation.

The user explicitly requested `implement b1` after accepting PR #71. The source
baseline remains `cee2d7418c0357f8e4bbd23e438cf026e2e15764`. Live stable has since
advanced to v0.23.5 / `3c2b5a2b770e8523374139a4937e1830e278fe29`; see the
September 22 reconciliation below. Native beta qualification requires a fresh
comparison window and an honest accounting of concurrent drift. Earlier preservation receipts are
historical and do not certify the current live installation.
The detailed B1 proposal reviewed in the preparation work remains the scope:
one isolated Windows beta lifecycle, with no simplification, dependency upgrades,
TeamAI, Jev, Desktop implementation, or stable rollout.

The latest selected actual-package E: qualification source is
`1bb87ff70d8ce0bddf3fb1dd8936cbd3fde0c2e6` in the reconciled v0.23.5
rehearsal root. It passed first install, Doctor, real Pi startup and in-agent
SQL/DAX/data-doc dispatch. It is a synthetic local revision, not a product
commit or accepted release. The preceding `630b1479f3f3f3b26b8b0d406506c396da3ab18e`
source passed bundled-reviewer startup, update, Doctor and real Pi dispatch.
The earlier
source `5a30ce319daf2f8261784ab37e58d244dbdab7a8` passed private-home,
installer-handoff and real Pi tool dispatch. Source
`a5f6ff59abe089cab590f08d9e2257dc47fdf08a`
passed the Git-diff review
rehearsal and first in-agent companion qualification. Those checks preserved
selected beta files, not the original stable snapshot. The earlier combined-review
source `997a5faeebddfe4c0ea84980840e9d9755b4aedc` passed its resumed qualification.
The earlier guided-lineage source also passed its canonical real-terminal wizard.
The initial-recovery rehearsal root remains at `95b162ffee336848975aeee5dc892cf340ebda13`.
It is a synthetic local revision, not a product commit or stable deployment.
The remaining acceptance work below still applies.

## Approved package decision

The user separately approved installing the exact resolved MCP inventory into new
E: beta-owned roots: Fabric MCP 1.2.0, Azure DevOps MCP 2.10.0, mcp-remote 0.14.2.
All other package versions retain the baseline pins. The beta manifest uses the
existing release-manifest schema. Stable's release manifest and caches are not
modified. Historical adapter cache labels are not executable version evidence.

## Implementation and acceptance plan

1. Add one validated installation-context record and a single meaning for
   `COOP_PROFILE_ROOT` (the profile directory itself). Reject absolute-path,
   ownership, overlap, link/reparse, identity and missing-tool errors before any
   lifecycle write. Keep stable defaults and precedence unchanged.
2. Route the existing launcher and lifecycle scripts through that context. Use
   explicit private npm/pipx/cache destinations and exact selected executables;
   never fall back to stable/global packages, sessions or credentials. No copied
   beta installer, permanent framework, or account-wide HOME change.
3. Supply beta install, launch, sync, observational Doctor, explicit-build update,
   failure recovery, rollback and removal. Preserve beta user data by default and
   unknown configuration fields. Keep a recoverable prior beta build and package
   state. Refuse dirty or unknown source state.
4. Prove root attacks, poisoned PATH, missing executables, spaces/Unicode, argument
   forwarding, exit codes, active stable sessions, failure/timeout/locked files,
   child shutdown and rollback through focused and native Windows tests. Retain
   paired Bash/PowerShell, BOM, full-suite and guardrail regression obligations.
5. Record exact source/manifest/package identity, native evidence, preservation
   comparisons, residual gaps and operating instructions. Do not mark B1 complete
   using mocks alone. Commits, PR publication, releases, beta sign-in and live
   service calls require their corresponding authorization.

## First slice

The baseline has no validated installation-context API and profile readers disagree
about whether COOP_DIR is a home or profile root. New focused tests first establish
those missing behaviors. The initial change introduces context validation and
explicit profile-root precedence, with stable behavior covered by regression cases.
Any stable-root write, link escape or fallback invalidates the slice. Backups and
test artifacts stay under the owned E: task directory. Rollback of development is
limited to owned files; never restore active stable or client state automatically.

## Evidence ledger

Passed in development fixtures: pure context/ownership/root/junction tests;
Python, Bash and PowerShell explicit-profile precedence; actual MCP generator
profile selection and beta refusal; exact-build code update/rollback with unknown
user fields preserved; removal refusal before mutation when a nested junction is
present. Native PowerShell 5.1 and 7 tests preserve Unicode paths, empty/literal
arguments and exit codes, reap descendants at completion/deadline, and preserve
an unrelated running process. The Node argument bridge and actual Git Bash entry
also preserve the tested vector. Active-session exclusion, forced-entry cleanup,
public recovery after source relocation, actual `.cmd` entry and malformed
bootstrap refusal now pass in synthetic native fixtures.

At the initial comparison, all 1,715 selected stable/client file hashes matched
the private pre-B1 inventory. Only equality/counts are public. The operational
source was then `cee2d7418c0357f8e4bbd23e438cf026e2e15764`; a later
read-only check found its external update to v0.23.5, as recorded above. No
B1 deployment to C: occurred.

The static Bash syntax, paired-script and PowerShell BOM checks pass. The full
local suite previously reached the existing Windows file-symlink permission error
in `tests/standards-rev9.test.mjs`; later compiler/native fixture requirements also
remain to be resolved. This is not a full-suite or native lifecycle acceptance.

## Candidate interfaces — not yet accepted for operational use

The existing installer accepts `coop install --beta-plan REQUEST.json` in this
working change. A first install request must name an empty absolute root, a clean local
source checkout at an exact accepted-descendant build SHA, and existing absolute
`node`, general `python`, `fabricPython`, and `git` tools. The installer records
the selected npm CLI and executable hashes. It must refuse before provisioning
if that source is dirty, its manifest differs, a root overlaps protected state,
or a selected executable is missing. No machine prerequisites or PATH entries
are installed or changed.

If first source preparation is interrupted, repeat that exact approved request
through the reviewed external source's installer. A complete ownership record is
required. Incomplete source/bootstrap directories are preserved under unique
`retained-installs` paths before preparation retries under the beta operation lock.
Unknown application state, changed identity or an incomplete ownership record is
refused for inspection. A completed bootstrap is hash-verified before proceeding
to initial package sync; retry never overwrites its existing helpers.

Generated `bin/coop-beta.cmd` and `bin/coop-beta.ps1` entries belong to the new
root. Candidate commands are `doctor`, `sync`,
`update --build SHA --source CHECKOUT`, `update --rollback`, and `uninstall`.
Launch is limited to owned beta workspaces; normal stable defaults are unchanged.
Update accepts the same manifest/package set only. It keeps the immediate previous
independent source clone and automatically retains older copies under
`retained-sources`. A rollback also retains the departing source; it does not
delete earlier code copies to make room for another transition.
Removal preserves the profile, credentials, sessions, caches and root receipt.
After completed removal, running the reviewed E: source's installer with the same
`install --beta-plan REQUEST.json` restores that exact recorded build and package
selection into the preserved profile. A different build, manifest or tool identity
requires a separate reviewed path; reinstall does not silently migrate them.

These interfaces need complete native provisioning/recovery qualification before
operational use. Isolated E: rehearsal betas exist, but there is no accepted B1
build yet. Product changes remain uncommitted; public examples deliberately
contain no fabricated accepted SHA.

## Observed third-party boundaries

The approved versions were inspected read-only in the stable package inventory:

- `pi-hermes-memory` resolves its agent store from `PI_CODING_AGENT_DIR`.
- `pi-better-openai` resolves provider auth/config from its explicit Pi agent
  directory. Further native asset/resource checks are still pending.
- `pi-web-access` 0.10.7 reads personal `~/.pi/web-search.json`, browser cookies,
  and defaults some output to the account Downloads directory. It is installed
  but disabled in the candidate beta settings pending qualification.
- `context-mode` 1.0.169 contains a post-install repair routine for other products'
  home-directory configuration. It is disabled pending storage qualification.
- Fabric CLI 1.7.0 creates `~/.config/fab` during module import and has account-wide
  log paths. Its private package and Fabric Python dependencies can be inventoried,
  but beta must expose no `fab` launcher or invoke its CLI until isolated.

Candidate npm provisioning suppresses package install scripts. No implicit native
rebuild, browser download, provider sign-in or MCP service call is permitted.
Missing native capabilities are an explicit qualification gap, not a reason to
run a package's installer against the account. Beta MCP config is empty/exclusive;
the shared generator refuses beta regeneration rather than introducing global
`npx` commands. This is incomplete MCP/live-workflow coverage.

## Remaining acceptance work

- Complete command-scope qualification. In-agent SQL/DAX/data-doc tools now have
  real Pi dispatch evidence for the selected synthetic source; remaining Pi
  management paths need exact-executable, argument, output and process-ownership
  evidence. Combined review has scoped actual-package coverage for reports,
  comparisons, HTML and documentation composition; Git-diff qualification is in
  progress. Optional Tabular Editor execution remains held. Standalone SQL/DAX
  reviewers, beta init, seed-docs, guided lineage, Support
  Center and profile/context commands also have the evidence recorded below.
  Remaining held data-doc/reviewer options must be resolved or explicitly
  dispositioned without describing them as qualified capabilities.
- Reconcile final-artifact coverage after the latest process-helper edit. Exact
  package installation, native resource loading, offline CLI startup, repeated
  actual-package update/rollback and an earlier actual-package removal/reinstall
  have evidence below. These receipts identify different synthetic revisions;
  they do not constitute acceptance of a final product revision.
- Retain regression/guardrail verification and explicitly disposition the host's
  file-symlink permission and later compiler prerequisites without weakening tests.
  The full suite remains ungreen; partial passes are not a replacement.
- Finish enabled companion-tool/vendor side-effect qualification. Integrations
  without scoped state evidence remain disabled and are incomplete coverage.
- Record final source/manifest/resource hashes, owned commands/stores and authored
  line counts; provide the operator receipt and accurate rollback instructions.

B1 remains in progress. Stable rollout, publication, package upgrades, optional
package adoption, TeamAI, Jev, and Desktop remain outside this authorization.

The current addition has eight runtime helper files: `lib/installation-context.mjs`,
`lib/beta-lifecycle.mjs`, `lib/beta-entry.mjs`, `lib/owned-process.ps1`,
`lib/beta_paths.py`, `lib/beta_data_doc.py`, `lib/beta_review.py` and
`lib/review-suite.ps1` (the existing Windows review function moved out of the
dispatcher and shared by stable and beta, rather than copied).
They provide context validation, lifecycle/recovery, native argument/process
ownership, shared Python workspace paths and pinned companion preflight. There is
no separate copied beta installer. These are working counts, not a code-reduction
claim. A generated
per-file diff/hash inventory is retained at
`E:/Codex/coop-b1-20260919/evidence/change-inventory.json`; refresh it after further
edits before final review.

## September 20 native package checkpoint

The first public installer run used a synthetic local acceptance build, not a
committed/published B1 product revision. Exact npm packages installed under the
owned E: fixture. pipx then failed writing its shared-library `.pth` path because
Windows' legacy default encoding cannot represent the `Ω` in the root name.
No install scripts, source builds, credential imports or live-service calls ran.

The repair selects Python UTF-8 mode explicitly with `-X utf8` alongside `-I -B`;
`PYTHONUTF8=1` also reaches package-manager child processes. This preserves real
HOME/USERPROFILE and does not reconfigure shared Python. The native regression
reproduces the default-encoding `.pth` write using the actual selected interpreter.
The fresh E: fixture completed the fixed public installer with all approved
package versions. Public Doctor and version commands passed; no auth/model files
were imported or created. Public rollback of the failed installation also passed.

After the failed install, all 1,715 selected stable/client file hashes and 131,638
monitored vendor-state filesystem entries matched their pre-test inventories.
The broader comparison uses metadata without reading credential contents. Private
receipts remain outside the repository. C: state has not been restored or edited.

### Installed dependency alignment follow-up

The independent `_extdeps.py align <agent> 0.84.3 --check` returned 10 after the
first successful package install: npm left `pi-ai` nested, so the required
root-level dependency was absent even though the six extension versions matched.
B1 now declares `pi-ai` and `pi-tui` as direct extension-tree dependencies at the
unchanged Pi version 0.84.3 and inventories those roots in Doctor. A regression
proves nested metadata cannot satisfy the root dependency check. A clean synthetic
fixture update, real package sync, public Doctor, independent alignment and
real Pi hook checks all succeeded.

All 96 guardrail unit cases passed. The real installed Pi 0.84.3 `AgentSession`
and `ExtensionRunner` hooks also passed the offline synthetic approval tests.
These tests do not call a model provider or remote executor. The latest full suite
again stopped at `tests/standards-rev9.test.mjs:250` with Windows `EPERM` while
creating its file-symlink fixture. No assertion was weakened and no workstation
permission or Developer Mode setting was changed. B1 cannot claim a green suite.

Package rollback traversal now checks ancestors once and each descendant once,
rather than re-walking every ancestor for every file. Nested link/reparse refusal
still passes. This reduces repeated filesystem work without skipping descendants.

### Receipt locations and immediate remaining work

Owned development root: `E:\Codex\coop-b1-20260919\repo`. Product source remains
uncommitted at the accepted stable ancestry. Synthetic native fixture
`edca4871898c92b76d503047af726996a8d40cb2` is test evidence only, not a publishable
or accepted B1 product revision. Its installed root is
`E:\Codex\coop-b1-20260919\rehearsal\Beta Ω UTF8 with spaces`.

Safe receipts under the task's `evidence` directory include
`native-alignment-lifecycle.json`, `native-aligned-installed-guardrails.json`,
`native-installed-metadata.json`, `guardrail-unit-checks.txt`, `suite-checks.txt`,
`preservation-latest.json` and `vendor-preservation.json`. The metadata receipt
predates the alignment update; consult the lifecycle receipt for the newer fixture
identity. Preserve the original failed-install and rollback evidence.

Remaining launch qualification explicitly includes raw `coop pi`, `init`,
review/support tool dispatch, arbitrary resource/session arguments, and project
or user configuration selecting outside resources. Inspect `pi-better-openai` pet
resources (which can read the personal Codex home), image destinations and all
auto-loaded extensions before any real agent launch. No beta agent/provider
session has been started in the real package fixture. Approved package presence
alone does not qualify these paths. Additional repeated lifecycle/locked-file and
remove/reinstall cases, native resource loading and full-suite disposition remain.

### Launch qualification progress

In the working source, beta `coop pi` now uses the branded governed launch path
and preflight; stable retains its raw Pi alias. User arguments are checked before
Pi startup: workspace and attachment paths must stay under beta workspaces,
explicit session paths/directories under the beta agent sessions directory, and
model/provider overrides must select GPT through `openai-codex`. New resource,
API-key, raw management and unqualified flags are refused before execution.
Unknown flags do not silently become new resource-loading behavior.

Pi's personal `.agents/skills` discovery and ancestor instructions were verified
in the installed 0.84.3 source. Preflight now refuses existing external user or
ancestor resource roots, linked/external Git metadata and unqualified project
resource/provider/session overrides. Beta child processes now use the owned
profile as HOME and do not import external resources. Owned paths are still
checked for junction/reparse escapes.

Beta explicitly disables Pi automatic package/catalog convergence and version
checks (`PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`) and automatic model-login priming.
This does not authenticate a provider or qualify live model/service calls.
Focused launch-input/resource tests and the native public alias, argv/exit,
active-session exclusion and shutdown tests pass, including the resource-root
checks. The full suite again reached the existing Windows file-symlink EPERM.
The launch changes are installed in a synthetic E: fixture; no B1 product build
has been committed, published or accepted.

### Actual-package launch and resource evidence

Synthetic fixture `62437d9aa1eb94cd672a383dd7806146fcb9629b` now runs in the same
owned E: actual-package root. The earlier previous-source fixture was verified
clean and retained under `evidence/retained-source-before-launch`; it was not
deleted. This manual preservation supports the test progression only; repeated
public update/rollback ergonomics remain open.

`native-launch-qualification.json` records successful public launch preview and
refusal of an outside working directory, C: session directory and non-OpenAI
provider. These checks did not start an agent or create provider credentials.

`native-resources-r3.json` records the real Pi `DefaultResourceLoader`: four
first-party extensions plus MCP adapter, Hermes memory, Better OpenAI and the
ask-user-question extension loaded with zero extension errors. Web access and
context-mode were absent. The offline harness blocked network and child-process
APIs and guarded filesystem access, recording zero blocked attempts in the final
run and 13 writes within beta. This is loader evidence, not full interactive,
provider, tool execution, or vendor-native capability acceptance. Its first two
receipts contain harness false positives for Windows extended-length E: paths;
the third normalized those paths and retained all earlier evidence.

The installed root has not been used for live client work or provider sign-in.
Full CLI session startup, command-specific `init`/review/support routing,
launch-spec executable reporting, live-independent native capability coverage,
repeated update/rollback/remove/reinstall and locked-file recovery remain open.
The helper and native tests intentionally use synthetic fixtures and cannot
substitute for these remaining acceptance cases.

### Exact launch preview and CLI startup

Beta `launch-spec` and `--no-launch` now both run launch preflight. JSON output
contains the selected absolute Node executable, the Pi entry declared by private
package metadata, and the validated scoped environment. It excludes inherited
credentials and the transient parent-process ID. Stable's preview contract is
unchanged. Beta JSON escapes non-ASCII characters so PowerShell 5.1's legacy
output codepage cannot corrupt paths. Native tests check exact Unicode path
round trips, environment identity, secret exclusion and outside-workspace refusal.

The real fixture preview exposed the old encoding defect before startup: its
`Ω` path was corrupted. The corrected synthetic build is
`847d8bc362f87d267fe2aeec1260f59fa623ce94`. `native-preview-r2-qualification.json`
records the exact metadata-selected executable and profile equality, successful
preview and scope refusals. Earlier preview receipts remain evidence of the gap;
status zero alone did not establish a correct machine-readable preview.

`native-cli-startup-r2.json` records successful startup through the actual bundled
Pi executable with `--help --no-session`, the governed arguments from the preview,
and no prompt or provider sign-in. The probe ran under the beta Job Object and
filesystem/network/process instrumentation. It exited zero, recorded no blocked
attempts and 23 beta-owned writes. Pi created an empty `auth.json` and a local
`models-store.json`; neither is imported from stable. The beta ownership lock was
released. This proves offline CLI initialization, not interactive screen behavior,
a live provider session, native tool execution or all lifecycle acceptance.

The first CLI probe stopped before importing Pi because the older preview's
profile path failed exact equality. Another preview assertion incorrectly assumed
`dist/cli.js`; the verified package entry is `dist/bundle/cli.js`. The corrected
probe derives that entry from package metadata. No production source revision or
public PR has been created from these synthetic test commits.

Remaining core lifecycle work includes actual-package qualification of the latest
update/recovery changes and remaining interruption cases. Actual-package removal
and preserved-profile reinstallation have now passed as recorded below. Core standalone command scope
coverage remains open. The full-suite Windows symlink permission failure still
prevents a green overall regression claim.

### Removal recovery and locked-file diagnosis

The working remover now deletes runtime/packages before source and leaves the
small recovery entry in `bin`. `lib/owned-process.ps1` holds the existing Windows
Job Object implementation; stable callers do not load it. Recovery commands take
the same process/operation ownership as other lifecycle calls. The current layout
validates four bootstrap/shim files against `bin/recovery.json` and three helper
files per build under `recovery/<build>/receipt.json`. This prevents accidental
mixed or modified recovery files; it is not a hostile same-user security boundary.

A removal journal records the installation identity and source-file hashes before
deletion. An interrupted retry refuses new or changed source files. Successful
removal preserves the beta profile, including auth/settings/session data, and
writes `.coop-beta-removed.json`. Doctor reports `removal-incomplete` or `removed`
with a nonzero health exit, and a repeated successful uninstall is idempotent.
Matching leftover journal cleanup is retryable; new application files after a
completed removal cause refusal rather than deletion.

The locked-file test uncovered a reproducible process abort with the selected
Node 24.18.0: `fs.rmSync` returned process status `3221226505` and no diagnostic
when a fixture file was held without delete sharing. `fs.unlinkSync` on the same
locked fixture returned catchable `EBUSY`. The evidence receipt is
`E:/Codex/coop-b1-20260919/evidence/native-locked-removal-diagnosis.json`.
Checked unlink/rmdir traversal replaces recursive rmSync in beta lifecycle
deletion; no Node upgrade or workstation permission change is involved.

The public shim also casts decoded arguments to a string array so a single
`doctor` or `uninstall` command and multi-argument invocations dispatch correctly
under PowerShell 5.1. Native locked-file/retry, changed-source refusal, recovery
after source removal, removed-state Doctor, idempotence, tampered-helper refusal
and exact auth/settings preservation now pass. The same run passed the existing
PS 5.1/7, Git Bash, literal argument, active-session exclusion and owned-child
cleanup tests. `node work/checks.mjs suite` then stopped at the unchanged
`tests/standards-rev9.test.mjs:250` Windows file-symlink `EPERM`; no full-suite pass
is claimed. `node work/checks.mjs static` passed Bash syntax, parity and BOM checks.
The older installed actual-package fixture has its original recovery
helpers, so its earlier successes do not qualify this new removal implementation.
The subsequent reinstall slice below is implemented in the working tree and its
actual-package public lifecycle rehearsal has passed.

Latest preservation checks remain unchanged: 1,715 selected stable/client/config
hashes and 131,638 vendor filesystem entries. No product commit, push, PR or stable
deployment was made. All removal probes used owned E: fixtures and no service calls.

### Preserved-profile reinstall

`install --beta-plan` now recognizes an owned, deliberately removed beta root.
It requires the same build, paths, tools and manifest and preserves the original
protection set. The source checkout may be at another clean location only after
the normal overlap and exact-revision checks. An arbitrary nonempty directory,
active installation, incomplete removal, changed executable or changed package
selection is not a reinstall target.

Reinstall journals source staging in `reinstall-source`, then promotes that clean
clone. The verified recovery entry and all profile data stay in place. Doctor
reports `reinstall-incomplete` during interruption. A retry can finish a complete
staged clone; `coop-beta update --rollback` retains incomplete/changed staging
under a unique `retained-reinstalls` directory and restores the removed state.
It does not delete failed staging or any user history. Public installer package
sync runs only after source recovery has completed.

Focused lifecycle tests pass for successful same-build source reinstall, dirty
candidate refusal before mutation, interrupted-clone retention, resuming clean
staging and byte-preserved profile/recovery files. These unit fixtures do not
prove package reinstallation. A fresh actual-package rehearsal completed at
`E:/Codex/coop-b1-20260919/rehearsal/Beta Ω reinstall with spaces`, using synthetic
fixture commit `358bcbf0724b38d0b59fea317f20a954f50fce15`. This is not a product
commit or accepted B1 release.

`evidence/native-package-install-reinstall.json` records successful public install
with all approved package versions. `evidence/native-removal-reinstall.json`
records the subsequent public commands:

- Doctor passed source/package identity before removal.
- A real file held without delete sharing produced a truthful uninstall error;
  Doctor reported `removal-incomplete` and the profile stayed unchanged.
- After releasing only the test-owned lock holder, uninstall retry completed in
  319 seconds. Runtime, source and extension packages were absent; Doctor reported
  `removed`, and another uninstall succeeded idempotently.
- The same public install plan restored the source/packages in 269 seconds.
  Doctor passed with the same build and manifest. Three synthetic profile files
  (auth, settings with an unknown field, and user data) plus the recovery receipt
  remained byte-identical. The operation lock was released.

`evidence/native-reinstall-identity-refusal.json` records a changed Python-tool
selection rejected before package provisioning, with all five checked identity,
profile and recovery files unchanged. No sign-in, credential import, model call
or service call occurred. Public package downloads used the private E: roots.
The final preservation comparison still shows zero changes among 1,715 selected
stable/client/config files and 131,638 C: vendor-state entries.

The full regression rerun includes the new reinstall tests and again stops at
the unchanged Revision 9 file-symlink `EPERM`. A supplemental E: harness leaves
production tests unchanged and starts after the already-passed B1 cases and that
blocked file. It passed 29 `standards-live-sync` checks, including process-death
recovery, before that test's own file-symlink case failed with `EPERM` at line 252.
`evidence/remaining-checks.txt` is partial evidence only. Neither the host's
symlink permissions nor the test assertions were changed, and this is not a
green full-suite result.

### Repeatable source updates and interruption recovery

The working update implementation now journals before cloning. It validates the
current source and the previous source/identity before mutation, retains an older
previous clone under a unique `retained-sources` path, and makes the departing
active source the immediate rollback target. Dirty or unexpected source and
receipt state cause refusal. Package selection and profile data do not change.

Rollback now journals its own transition and resumes after either source rename
or the build receipt write. Interrupted update recovery restores both the prior
active source and its preexisting rollback target. Incomplete candidate clones
are retained without deleting any files they may contain. Completed rollback
retains its departing source and leaves another update/rollback cycle possible.
Older retained copies and their context sidecars remain for inspection; uninstall
preserves these archives along with user data and the recovery entry.

Doctor recognizes a valid pending source transition and reports
`update-incomplete` with a nonzero health exit even when the normal source directory
is temporarily absent. It does not attempt to repair the transition itself.

Repeated update/rollback cases and all ten interruption states passed in the
full-suite rerun. Five states (0, 3, 5, 7 and 9) ran Doctor and rollback through the
generated Windows entry, including source absence and interrupted rollback.
These fixtures cover pre-clone interruption,
older-copy retention, both source renames, receipt changes, and interruption during
rollback; they assert the active build, earlier rollback target, retained candidate
files and preserved profile history. Actual-package update qualification and the
recovery-entry compatibility review remain open. The existing actual-package
reinstall fixture is an earlier synthetic build, not evidence of these new changes.
The suite then stopped at the unchanged standards file-symlink `EPERM`. Static
syntax/parity/BOM checks passed. Stable/client and vendor preservation checks
again report zero changes across 1,715 selected files and 131,638 vendor entries.

### Recovery code follows the selected build

The bootstrap now selects immutable, hash-verified helper files under
`recovery/<exact-build>`. A completed update uses that build's lifecycle and
process-ownership code; completed rollback selects the restored build's helpers.
An in-progress transition records `recoveryBuild`, so recovery continues using the
implementation that created its journal even after the selected source SHA changes.
Missing or changed selected helpers cause refusal; no older helper fallback occurs.

Update stages the candidate helper files, checks their bytes against the source
commit, loads the copied module graph, and runs the candidate's own receipt and
bootstrap validators before selecting the new source. Existing staged versions
must pass the same self-validation on retry. This catches missing relative modules
and incompatible recovery receipts before switching away from the working build.
Rollback verifies its target's recovery files before modifying source state.
Bootstrap files, profile data and older helper versions remain intact.

The synthetic Windows tests now prove that changed helper code actually executes
after update, that a pending transition uses its creator's version, and that rollback
restores the old implementation. Tampered helpers, a missing rollback-target receipt,
an unpackaged import and an incompatible receipt protocol (including retry) are
rejected. The repeated transition, removal/reinstall and ten interruption cases
also passed. The full suite then stopped at the unchanged file-symlink `EPERM`;
static syntax/parity/BOM checks passed.

A fresh actual-package fixture with this layout was provisioned at
`E:/Codex/coop-b1-20260919/rehearsal/Beta Ω versioned with spaces`, source
`0b66de995ee1a9357d05917dc8dc49a9110e1887`. Prepared synthetic update revisions
`5236cfb28d2cdd3c7987b2f72d3b564bdc057fcd` and
`76fde3ec758b0c2c82b6893654ecd1b13103e109` add only a Doctor diagnostic property
while retaining all actual package/identity checks. Their public update/rollback
qualification passed. Older pre-acceptance E: fixtures keep their earlier
bootstrap layout and remain preserved; they are not evidence for this new layout.

The native sequence was original → next → third → rollback to next → original
→ rollback to next → original. Doctor passed after every transition and its
diagnostic property proved that the selected version's helper code executed.
Exact npm metadata/version and Python version inventories remained unchanged;
four checked profile/bootstrap files stayed byte-identical. The operation lock
and transaction journal were absent after every completed step, and no manual
source archiving was needed. Final selected source is the original `0b66de9`
fixture. Evidence: `E:/Codex/coop-b1-20260919/evidence/native-versioned-updates.json`.
No model calls, service calls or credential imports occurred. Subsequent
preservation checks found zero changes in all 1,715 stable/client files and
131,638 vendor entries.

The same actual-package fixture also passed extension alignment and the real Pi
0.84.3 `AgentSession.beforeToolCall` / `ExtensionRunner` regression harness with
offline synthetic inputs. Receipt:
`E:/Codex/coop-b1-20260919/evidence/native-versioned-installed-guardrails.json`.
This closes the hook/package check for that fixture without provider sign-in.

### Initial destination ownership

A native source-install probe reproduced a fresh-install failure for an existing
empty destination: the process owner's temporary lock made the destination
nonempty before its exclusive ownership claim. The process helper now takes the
lifecycle lock only after the installation identity exists. First installation
continues to use the exclusive `.coop-beta.json` creation; foreign files and
lock-shaped files are never ignored or deleted. Existing installations retain
their operation lock.

The same native source-install probe passed after the fix, without package
provisioning. Before/after receipts are
`E:/Codex/coop-b1-20260919/evidence/empty-install-before-native.json` and
`E:/Codex/coop-b1-20260919/evidence/empty-install-after-native.json`.
PS 5.1/7 regression cases passed for absent and empty roots, preserved foreign
files and locks, and duplicate ownership claims. All B1 tests, including the ten
source-interruption states, passed in the full-suite run. The suite then exited 1
at the unchanged file-symlink `EPERM` in `tests/standards-rev9.test.mjs:250`.
Static syntax/parity/BOM checks passed. The versioned actual-package fixture
predates this process-helper edit; it remains evidence for the update sequence,
not a final accepted product build.

### Standalone Support Center ownership

Beta Support Center now runs under the existing Windows process owner using the
selected Node executable. Its Bash script forwards through the native beta entry.
Stable entry behavior remains unchanged. Beta argument/path validation precedes
diagnostic collection and event-log writes; invalid, repeated or incomplete
options cause refusal. Launch from an owned `workspaces` directory. Explicit
exports may target a new file under that workspace tree or under
`profile/support/bundles`; existing files are not overwritten. Linked paths and
external project/knowledge roots are refused. Retention only considers generated
bundle filenames, preserving unrelated files in the bundles directory.

Node/Git diagnostic probes, build identity and standards Git operations use the
selected executables. Reviewer discovery uses the private pipx executables, with
no PATH fallback. Missing reviewers remain an honest unavailable result. Stable
standards callers retain their existing default executable resolution. The
Support Center retains its sanitized events, exports and standards reporting.

`tests/beta-support.test.mjs` passed owned export, overwrite/outside-path refusal,
junction/foreign-knowledge refusal, sanitized-event/export canaries, retention,
poisoned PATH/CWD tools and project-standard Git provenance. Native PS 5.1, PS 7,
Node bridge and Git Bash entries passed. All 14 existing stable Support Center
tests passed. Static syntax/parity/BOM checks passed. The full suite passed the
B1 cases and then stopped at the unchanged `standards-rev9.test.mjs:250` file
symlink `EPERM`. The final malformed-config error change subsequently passed the
focused support suite: its real CLI returns a generic error without echoing the
config secret canary or writing a support event.

The actual-package root `E:/Codex/coop-b1-20260919/rehearsal/Beta Ω versioned with spaces`
was updated through its public entry to synthetic source
`8e86bd767e32e3ab299139443cc32082222a6129` (superseding the initial support
fixture `85ecdb87ad5b63ac4047e467ddf9f9532ff222b0`). Doctor passed. A real support export
passed with SQL and DAX `bundled_fallback` provenance from the installed reviewers;
synthetic secret canaries were removed from both the event log and export.
Outside-destination and overwrite attempts returned failure before modifying the
event log. Four checked config/auth/settings/bootstrap files and exact npm package
inventory stayed unchanged. No model/service calls or credential import occurred.
Final receipt: `E:/Codex/coop-b1-20260919/evidence/native-support-r3.json`.
The preceding r2 harness stopped on its own precondition before replacing an
existing beta config for a canary. That config was preserved; the malformed-config
case instead runs in the disposable test fixture. This was a protective test
refusal, not a successful malformed-config test on the installed profile.
The fixture includes the previous empty-destination process-helper fix. It remains
a local qualification revision, not a committed product change or stable rollout.
Final post-rehearsal preservation checks found zero changes in all 1,715 selected
stable/client files and 131,638 vendor entries.

### Standalone profile and context-budget ownership

Beta `profile` and `context-budget` now enter the validated lifecycle runner and
execute the selected Python with `-I -B -X utf8` under the existing Windows process
owner. Stdin, Unicode output and exit status are preserved. Stable dispatch stays
unchanged; Git Bash forwards beta commands to the native entry as before.

Both commands require an owned workspace. Unknown/conflicting options, linked
profile files, missing selected tools and unowned project-instruction paths are
refused. Context-budget source resources must remain inside the selected source.
Beta profile editing preserves unknown top-level and communication fields;
malformed profiles are refused before editing with a content-free error. Both
readers accept Windows UTF-8 BOM profiles. Reset affects only `profile/user.json`;
it does not reset auth, model settings, MCP configuration or integration config.
`context-budget --measure --yes` retains the existing truthful unavailable message
and static estimate, with no provider measurement or sign-in.

`tests/beta-profile.test.mjs` passed reading, editing, unknown-field preservation,
Unicode, BOM consistency, reset/missing/EOF behavior, poisoned Python/Azure PATH,
missing selected Python, junction/config/option/cwd refusal, and a clean selected
source configured with an external budget resource. The native entry checks cover
PS 5.1, PS 7, Node bridge and Git Bash. Existing onboarding and context-budget
regressions passed. Static syntax/parity/BOM checks passed. The full suite passed every B1 case, then stopped at the known host file-symlink EPERM in standards-rev9.test.mjs:250.

The actual-package beta updated through its public entry to synthetic revision
`991bf7a1c21e5eaf46f0f50f4654b9bb2f967941` and passed Doctor. A newly seeded synthetic
BOM profile was read, edited with Unicode input, measured and reset. Unknown
fields survived the edit, conflicting options refused before writing, and the
profile ended absent as it was before the rehearsal. Five checked config/auth/
settings/MCP/bootstrap files and npm package inventory stayed unchanged. No model
or service calls or credential imports occurred. Receipt:
`E:/Codex/coop-b1-20260919/evidence/native-profile.json`.
Stable/client preservation again found zero changes; all 131,638 vendor metadata
entries also remained unchanged.

### First-install interruption recovery

`evidence/initial-interruption.json` records a real public installer stopped after
its complete exclusive ownership claim but before source/bootstrap creation. The
same request failed on retry because the installer incorrectly required the
missing recovery receipt. No packages had been provisioned. That partial root and
its logs remain preserved separately.

The candidate now separates exclusive identity claim from leased source work.
An existing identity is read-only validated during claim; the following source
operation takes the existing Windows lock, including competing initial installers.
Only first-install roots without packages, removal/transaction state or unknown
top-level entries can resume. Partial source, bin and recovery directories are
fully checked for links and retained under `retained-installs/<unique-id>` before
retrying. Interrupted retention can itself retry without overwriting an earlier
copy. User profile, cache and workspace files stay in place. Complete bootstrap
receipts require hash validation; malformed ownership records are never rebuilt.

`tests/beta-initial-install.test.mjs` exercises these phases, user-file preservation,
changed identity, unknown/application state, malformed records and links. Native
PS 5.1/7 tests force-stop the owned installer during source preparation, reject a
competing owner, and retry through the public command with inert fixture sync.
All cases passed in the full suite, including absent/empty destination acceptance
and foreign-lock refusal. Every remaining B1 group also passed, including all ten
source-recovery phases. The full-run harness reached its 20-minute deadline during
standards testing; the surviving standards test then logged the same known
file-symlink EPERM at `tests/standards-rev9.test.mjs:250`. The formal harness result
is ETIMEDOUT, not a green suite. Earlier full attempts also stopped on that EPERM.
The final test fixture now creates its own accepted ancestor/descendant pair so
shallow CI checkouts need no product history. Ancestry checks remain enabled;
the separate native rehearsal used the real accepted product ancestry. This
test-only portability revision passed its focused rerun through PS 5.1 and PS 7.
The seven context/lifecycle/launcher/manifest files match the actual rehearsal's
source after line-ending normalization. Static syntax, script parity, BOM and
diff-whitespace checks passed. No product commit or stable deployment occurred.

A separate actual-package rehearsal selected synthetic source
`95b162ffee336848975aeee5dc892cf340ebda13` at
`E:/Codex/coop-b1-20260919/rehearsal/Beta Ω initial recovery with spaces`. Its public
installer was stopped before bootstrap creation; same-plan retry has completed
source recovery, approved-pin provisioning and observational Doctor. Every
inventoried npm package matches its exact selected version; Doctor also checks
the pinned Python inventory. The synthetic profile file survived. No transaction
or operation lock remained. There were no credential imports, model calls or
service calls. This qualifies first-install retry for this source, not all B1
commands or final acceptance. Receipt:
`E:/Codex/coop-b1-20260919/evidence/native-initial-recovery.json`.
Post-rehearsal preservation checks found zero changes in all 1,715 selected
stable/client files and 131,638 vendor metadata entries.

### Owned project initialization

Beta `init` now uses the lifecycle runner and its existing Windows process owner.
Its target, ancestor contracts/Git metadata and generated destinations must stay
inside owned workspaces. Existing files, linked/junction paths, ambiguous Windows
paths, conflicting modes, external cwd/targets and missing selected tools are
refused. The beta environment supplies the selected Git path through `COOP_GIT`;
Python runs with the established isolated UTF-8 flags. Stable dispatch is unchanged.

The existing template and wizard remain the implementations. Template writes are
exclusive. The beta wizard validates repository paths entered interactively, does
not create an EOF/cancelled project, and uses manual tenant text without Azure
discovery or sign-in. Tabular Editor discovery is not launched. Standalone
`--seed-docs` and the subsequent guided-lineage integration are recorded below.

CI scaffolding is limited to owned destinations and will not overwrite existing
CI files. Invalid beta project paths produce content-free diagnostics. Legacy
migration reuses the existing bounded implementation: dry-run/decline remain
immutable, approved application archives the original contract, and unknown
fields survive. The new checks do not replace that migration's own validation.

The focused `tests/beta-init.test.mjs` run passed template and guided Unicode,
no-overwrite, EOF, external interactive paths, option refusal, GitHub/ADO CI,
content-free invalid-input errors, migration dry-run/decline/apply/idempotence,
archive preservation, junction/missing-tool refusal, poisoned PATH and native
PS 5.1/7, Node and Git Bash entry cases. An initial Windows missing-directory
discovery error was reproduced and fixed before acceptance. The final file-target
and ambiguous-path cases passed in the completed full run, as did every B1 group.
The suite then exited 1 at `tests/standards-rev9.test.mjs:250` because this Windows
host refused file-symlink creation (EPERM). Receipt: `evidence/suite-init-checks.txt`
in the E: task root. Existing stable wizard/CI, static syntax/parity/BOM and diff
checks passed. This was not a complete passing suite.

Actual-package synthetic revision `547a5e9a858d65d8c22c8eeb8f9d282665e864b3` passed
public update, Doctor and 13 init rehearsal steps in the existing versioned E:
root. It created only synthetic owned projects, refused overwrite/outside paths,
preserved migration originals, and made no model/service calls or credential
imports. Five profile/auth/settings/MCP/bootstrap file hashes and the npm inventory
were unchanged. Receipt: `E:/Codex/coop-b1-20260919/evidence/native-init.json`.
Post-rehearsal preservation found zero changes across all 1,715 selected
stable/client files and 131,638 vendor metadata entries. No product commit or
deployment occurred.

Read-only inspection of the private coop-data-doc 1.2.0 implementation confirms
that it discovers configuration through an environment override or parent folders,
and its wizard accepts repository/output paths. Companion qualification must bind
those inputs explicitly before enabling beta lineage setup. The installed package
was inspected without changing or invoking it during this check.

### Bounded data-doc command preflight

A read-only synthetic probe confirmed that the old public beta entry accepted a
configuration outside its beta root, while preserving the external canary.
`evidence/companion-scope-before.json` records that result. The installed CLI
contracts for data-doc 1.2.0, SQL review 0.15.2 and DAX review 0.22.0 are recorded
in `evidence/companion-cli-contracts.json`; no vendor code was changed.

Beta `data-doc` now selects its private Python through the context/lifecycle
runner and existing Windows process owner. It verifies the pinned version and
preflights a copy of the vendor parser with inert conversions, so Click cannot
open/truncate a File argument before scope validation. The original vendor CLI
then executes. Configuration discovery stops at owned workspaces. Config-contained
repositories, globs, outputs, review files and branding paths, explicit config/
log/output arguments, nested links and the generated MkDocs config are checked.
Output directories cannot contain the configuration or a source root. Invalid
input produces a content-free error. Stable data-doc dispatch is unchanged.

The extracted shared Python path helper also serves beta init. It now checks
original Windows spellings before normalization (which otherwise strips trailing
dots/spaces) and checks uncollapsed ancestors so junction/../target cannot hide
a junction. The renderer's Python child receives PYTHONSAFEPATH=1 to prevent a
workspace mkdocs.py import; the package and canonical CLI remain unchanged.

Six focused tests with many subcases passed, including actual pinned-package
show-config/status/scan/build/check/export/findings, HTML generation with a
poisoned mkdocs.py, external arguments and config paths, content-free errors,
bounded parent discovery, ambiguous Windows paths and nested junctions. The
existing stable wizard/CI tests and focused beta init passed after extraction.
Static syntax, parity, BOM and diff checks passed.

Synthetic source 5edb4af passed 17 native public-entry steps: source update,
Doctor, commands, external cwd/config/log/output refusal, nested-junction refusal
and preservation of eight profile/canary hashes plus the package inventory.
Receipt: `evidence/native-data-doc.json`. Source 5191300 adds the HTML-child
import guard and generated-config check; its 18-step native follow-up passed,
including HTML output with a poisoned workspace mkdocs.py and unchanged eight
profile/canary hashes plus package inventory (`evidence/native-data-doc-r2.json`).
That full suite passed every B1 group, including the six focused data-doc tests,
then exited 1 at the same standards file-symlink EPERM
(`evidence/suite-data-doc-checks.txt`). It predates the authoring changes below
and is not blanket acceptance. Post-follow-up comparison found zero changes
in all 1,715 selected stable/client files and 131,638 vendor entries.

At this checkpoint, remaining work included canonical setup/config editing
(implemented in the following slice), seed-docs and guided lineage;
SQL/DAX and composite review dispatch; native extension/Pi management paths;
Git-backed impact and server execution. This step explicitly refuses those
unqualified data-doc operations rather than marking them complete. It is not an
OS sandbox against arbitrary hostile code, and it does not qualify every enabled
vendor side effect. No product commit, publication, stable deployment, package
change, credential import or model/live-service call occurred.

### Canonical data-doc authoring and incremental input

Beta data-doc now permits setup and config-set through the existing pinned CLI.
The adapter validates raw path answers before the canonical wizard lists/scans
repositories, and validates the package-rendered candidate before scanning or
writing. It retains the package's questionnaire and patch rules. Rendered output
collisions and unsafe globs/paths fail before configuration replacement. Existing
configuration bytes are backed up under the owned project's .backups/coop-data-doc
folder only at the final write boundary; read-only wizard scans and cancellations
create no backups. A changed original or existing setup .tmp file is preserved
and refused. Unsupported existing schema fields are refused without rewriting.

Seven focused tests passed against the installed 1.2.0 package, covering valid
patch/new config, discovery-mode and SQL-scanning canonical questionnaires, byte
backups, EOF, outside repo/output/globs, concurrent edits, pending temp files and
unknown-field preservation through refusal. These are direct-package tests; native
public-entry validation found a separate process-owner defect rather than being
assumed equivalent.

The first native authoring run stopped on an incorrect harness expectation:
ClickException returns 1 for a rejected config patch, not 2. The patch was safely
refused; its original was unchanged. The corrected run then timed out at the first
JSONL prompt: its incremental answer was not delivered. Both receipts/logs were
retained. A small independent Windows probe confirmed that the old stdin
CopyToAsync loop buffers short answers on PowerShell 5.1; PowerShell 7 succeeds.
Direct stdin inheritance succeeds on both shells, including Unicode and exit 7.
Receipt: `evidence/owned-interactive-input-probe-r2.json`. An earlier malformed
probe child is retained as a harness failure, not product evidence.

The owner now inherits stdin directly, removing the copy/EOF loop. Raw stdout and
stderr forwarding, native process ownership and deadlines remain in place. The
native regression sends two Unicode answers before closing stdin, then checks
EOF and exit 29 through PS 5.1/7. The complete focused native process/removal
regression passed, including ownership, literal arguments, lock/deadline, child
shutdown and retained recovery. Static syntax, script parity and BOM checks pass.
The 0eed57a public authoring rehearsal passed all 13 steps, including canonical
SQL scanning, a subsequent build, byte backups, EOF and scope/concurrent-edit
refusals. Six profile/canary hashes and package inventory were unchanged. Receipt:
`evidence/native-data-doc-setup-r3.json`. No model or service calls occurred.

A full suite completed with exit 1 in `evidence/suite-data-doc-setup-checks.txt`.
Every B1 group passed, including all seven data-doc tests; the suite stopped at
the known file-symlink EPERM in `tests/standards-rev9.test.mjs:250`. Its
early groups started before the stdin fix; the final helper and interactive
regression require their focused results as well as final-artifact reconciliation.
This is not a final passing-suite claim. Seed-docs/guided init lineage, other
companion and native extension paths, remaining vendor effects and final regression
coverage remain incomplete. No source publication, package change or stable
deployment occurred.

Post-authoring-rehearsal preservation comparisons completed with zero changes in
all 1,715 selected stable/client files and 131,638 vendor entries.

### Standalone lineage seeding and hardlink aliases

A synthetic E: probe confirmed that a hardlinked configuration could pass the
previous path checks: config-set modified both the owned pathname and an outside
synthetic alias. The probe touched no client or stable data. Receipt:
`evidence/data-doc-hardlink-before.json`. The shared Python workspace validator now
rejects regular files with additional hardlink aliases before reads or writes.
This covers its init/data-doc callers; it is not a claim that every JavaScript
writer or enabled extension has completed hardlink qualification.

Beta `init --seed-docs` now reuses the existing repository-role classifier and
private data-doc config-set command. It validates the contract and selected
repository/sql-root paths before producing the patch. Confirmation applies the
bounded patch; decline and EOF leave the configuration unchanged. Explicit
`--yes`/`-y` authorizes that operation without another prompt. The canonical
config-set writer preserves metadata and saves original bytes before replacement.
Unknown/TODO-only source roles, outside paths and hardlinked contracts/configs are
refused. The project contract remains unchanged.

All nine focused data-doc tests passed, including actual-package alias refusal
and seed classification, along with focused beta init and existing stable
seed/wizard regressions. Static syntax, parity and BOM checks passed. Actual
synthetic source `a42c13af335bad031baad950a99683511d45f80b` passed 15 public-entry
checks: update/Doctor, confirmation/decline/EOF, metadata preservation, build,
outside/TODO refusal, both hardlink routes and preservation. Six profile/canary
hashes, both aliases, the project contract and package inventory were unchanged.
Receipt: `evidence/native-seed-docs.json`. Post-rehearsal comparisons found zero
changes in all 1,715 stable/client files and 131,638 vendor entries.

The full suite started for this revision completed with exit 1 in
`evidence/suite-seed-docs-checks.txt`. All B1 groups passed; standards-rev9 again
stopped at its file-symlink EPERM.
Its early groups preceded the JavaScript hardlink repair below, so it is not a
final-artifact run. There is no passing full-suite claim. Guided init lineage, other companion/native
extension paths and the remaining acceptance items are still open. No package
change, credential import, model/service call, product commit or stable deployment
occurred.

### JavaScript hardlink ownership checks

A separate synthetic public-entry probe confirmed that Support Center's JavaScript
event-log rewrite also changed an outside hardlink alias. Both names belonged to
the disposable E: test fixture; no stable or client file was involved. Receipt:
`evidence/support-hardlink-before.json`.

The shared JavaScript ownership validator now refuses hardlinked owned files.
The recursive validator checks nested files, installation-record loading checks
the record itself, and selected profile entrypoints use the ownership check.
Selected shared executables remain read-only references and may have aliases;
they are not claimed as beta-owned files. This closes the demonstrated log rewrite
route without changing stable Support Center behavior.

Focused ownership and Support Center tests passed. They exercise direct and public
Windows refusal, unchanged event-log aliases, linked installation records and
read-only shared-tool selection. Static syntax/parity/BOM checks passed. Focused
lifecycle tests also passed update/rollback, recovery-version selection, reinstall
and removal boundaries. The actual-package follow-up at synthetic source
`8325cfadc46ebaf5806120763b0dd159a5b56daa` passed all six checks: update, Doctor,
public support alias refusal, lineage seed, show-config and preservation. Six
profile/canary hashes, support event bytes and package inventory were unchanged.
Receipt: `evidence/native-js-hardlinks.json`. Fresh preservation comparisons found
zero changes in 1,715 stable/client files and 131,638 vendor entries. Remaining B1
acceptance and full-suite gaps still apply.

### Guided lineage and real console attachment

Guided beta init now receives a validated private data-doc vector from the
lifecycle context and offers the existing lineage step when that companion is
present. Inherited command overrides are discarded. A minimal installation without
the companion can still create a project contract, with lineage unavailability
reported explicitly. The existing seed classifier and canonical config-set/setup
questionnaire remain authoritative; their path checks and backups still apply.
Beta seed/setup failure or cancellation returns its status with the new contract
retained. Stable wizard behavior is unchanged.

Ten focused data-doc tests, beta init and the existing stable seed/wizard tests
passed. They include command-vector handoff, isolated helper flags, short-circuit
on failure, missing-companion behavior and inherited-command poisoning. Native
source `144b96c087e0efcad0933e62c56c6e3e09a7a415` passed update/Doctor, decline and
EOF, but its real-terminal run exposed invisible prompts. The owned test was
stopped; its descendants and operation lock were gone, and no contract was created.
That failure is retained in `evidence/native-guided-lineage.json`.

The Windows process owner's unconditional CreateNoWindow detached terminal
callers. It now requests no window only when all three standard handles are
redirected, retaining the caller's console otherwise. The new
`tests/beta-console.test.mjs` must run in a real Windows terminal: it checks that
the owner and child share console membership, all three handles are terminal
handles, and the child exit code survives. The old owner fails this regression;
the repaired owner passes on PowerShell 5.1 and 7. Receipts:
`evidence/native-console-before.json` and `evidence/native-console.json`.
Static syntax/parity/BOM and pipe-based native ownership tests passed, including
Unicode incremental input, EOF, locks, deadlines, shutdown and removal/recovery.
The actual-package guided follow-up at `e243eebb6a89f71696b41b534a1aded8f1fb807a`
also passed: update/Doctor, decline/EOF, canonical real-terminal SQL setup,
show-config, backup creation and a subsequent documentation build. The chosen
SQL path and Unicode title matched the terminal input. Six profile/canary hashes
and package inventory were unchanged, with zero model/service calls. Receipt:
`evidence/native-guided-lineage-r2.json`. That full-suite attempt ended with exit
127 in `evidence/suite-guided-lineage-checks.txt`: the agent edited the test list
while Bash was reading it, invalidating the run. It is neither a product failure
nor a passing suite. The replacement is recorded separately below.
Post-rehearsal preservation completed with zero changes in all 1,715 selected
stable/client files and 131,638 vendor metadata entries.
Remaining companion/native-extension qualification and other B1 acceptance gates
are still open; these results do not establish full B1 acceptance.

### Standalone SQL/DAX review scope

A synthetic probe showed that both raw private reviewers accepted source and
report paths outside the beta workspace. Only disposable E: fixtures were used;
no client data was read or changed. Receipt: `evidence/review-scope-before.json`.
The beta entry now runs the original pinned reviewer through `lib/beta_review.py`
using its selected private Python, isolated imports and the lifecycle environment.
Stable entry behavior remains unchanged.

The adapter validates input trees, discovered configuration, supplementary DAX
report/VPAX inputs and output destinations before use. Linked or hardlinked paths,
outside configuration, report/input collisions and project control-file outputs
are refused. Existing reports receive byte-preserving backups. The original
package parser, rules and report formats remain authoritative. No-argument help,
rules, explanations, SQL comparisons, DAX diffs and local HTML remain available.
Git-selected scope, ignore editing and browser launch still await qualification;
package upgrades remain outside the authorized version scope.

Four actual-package regression tests passed, including the adjacent DAX Report
junction route. Native source `316fb205f4c0a63281b4072634129fc1a778c9bb` passed all
16 public-entry checks: update/Doctor; both reports, overwrite backups and outside
refusals; PowerShell 5.1, PowerShell 7 and Git Bash; and hardlink refusal. Six
profile/canary hashes, source bytes and package inventory were unchanged. Receipt:
`evidence/native-review-scope.json`. Fresh preservation checks found zero changes
in all 1,715 monitored stable/client files and 131,638 vendor entries.

The replacement full suite ended with exit 1 in
`evidence/suite-review-scope-checks.txt`: all B1 groups passed, then
`tests/standards-rev9.test.mjs:250` failed to create a file symlink (EPERM).
The combined `coop review` path and in-agent companion tools are not yet covered
by this standalone qualification. Final-source rehearsal, the existing full-suite
gaps and the remaining B1 acceptance work are still open. No model/service calls,
credential import, product commit, publication or stable deployment occurred.

Further diagnostics retained outside the product tree:

- `evidence/composite-review-scope-before.json` and
  `evidence/composite-review-ps7-before.json`: both public combined-review probes
  failed with exit 2 on Unicode standards-path corruption, with no accepted
  reports and unchanged synthetic input. Scope and process isolation remain
  unqualified; this failure must not be mistaken for deliberate scope refusal.
- `evidence/standards-junction-candidate.txt`: an isolated test candidate passed
  all 22 Revision 9 standards tests using a real Windows ancestor junction escape
  and checking that it resolves to the outside synthetic file. The product test
  is unchanged. This candidate does not qualify direct Windows file symlinks;
  other standards tests still require those privileges.
- `evidence/downstream-candidate-checks.txt`: a separate downstream diagnostic
  run uses that candidate while preserving the main suite's fixed test files.
  It ended with exit 1 at `tests/standards-live-sync.test.mjs:252`, another direct
  file-symlink EPERM. It is not a full-suite run or a replacement for its acceptance
  requirement. No product tests or Windows privilege settings were changed.

### Combined review, Unicode and accepted-report provenance

The existing Windows review function now lives in `lib/review-suite.ps1`; stable
loads it lazily and beta runs it under the existing lifecycle job and lease.
Before reading project scope or producing reports, beta checks owned working and
configuration trees, exact private companion executables, resolved source paths
and the project review directory. Existing review artifacts are backed up before
replacement. Comparisons reuse immutable accepted reports without deleting them.
The original parser, standards resolver, report promotion, suite rendering and
data-doc composition remain authoritative.

Reviewers accept a verified content-addressed standards snapshot as a read-only
input. An adjacent profile rules.yml cannot silently become project configuration.
Only the derived internal temporary report names may be written under
`.coop/reviews`; the standalone entry cannot use this exception to replace the
accepted-generation pointer or other control files. Inherited suite overrides are
removed by the lifecycle environment.

ASCII JSON preserves Unicode between Node and Windows PowerShell 5.1. The review
child selects UTF-8 for its own native text pipeline; workstation settings are
unchanged. The first repaired native run reached both reviewers, but report
promotion exposed a second Windows defect: its final check compared report and
binding path strings literally, while initial provenance binding already compared
resolved paths. Final acceptance now uses that same lexical/physical/hash check.
Tests prove that forward-slash paths are accepted and a different file containing
identical bytes is rejected without changing the last accepted generation.

Five pinned-package review tests, ten data-doc regressions, the focused combined
scope/provenance test, existing Bash review regressions, Windows 5.1/7 help and
invalid-option smoke tests, and static/parity/BOM checks passed. Native source
`0bd20b4ef128537b4f5307f564956b910a6944da` retains the provenance failure in
`evidence/native-review-suite.json`. Source
`997a5faeebddfe4c0ea84980840e9d9755b4aedc` then passed update/Doctor, help and HTML.
The harness initially read bundled provenance outside the beta package context;
the actual scoped verifier confirmed acceptance. That harness correction is
documented by `evidence/native-review-suite-r2.json` and
`evidence/native-review-suite-r2-continuation.json`, not attributed to the product.
The continuation passed all 12 steps, including comparison, strict exit status,
outside refusal, PowerShell 5.1/7, Git Bash, docs composition, junction/hardlink
refusal and preservation. Nine source/profile/canary hashes and package inventory
were unchanged. No model or service calls occurred.

### Git-selected combined review

The beta `review --diff` path now selects changed and untracked files through the
recorded Git executable. It verifies local repository ownership, rejects linked
metadata, alternate object stores and external configuration includes, resolves a
commit reference before diffing, disables external diff/textconv and filesystem
monitor execution, and checks every returned path. Invalid references fail before
report writes; only a genuinely non-Git input retains the existing full-root
fallback. Deleted files are omitted, subdirectory scope stays bounded, and an
empty selection creates no reports.

Focused tests pass for these cases, including real local Git fixtures, Unicode
paths, unchanged files, invalid refs and metadata redirects. Native qualification
of `714aa8077d2771d1c744e6c1d65c1176bfd1540f` passed all nine recorded steps in
`evidence/native-review-diff.json`: empty/changed selection, invalid-reference and
configuration-redirect refusals, PowerShell 5.1/7 comparisons, update/Doctor and
unchanged selected beta files/package inventory. Standalone package `--changed`, ignore editing,
browser launch, optional BPA and in-agent tools remain separate qualification work.
These results do not establish full B1 acceptance or authorize stable deployment.

### September 22 stable drift: read-only investigation

The user requested read-only investigation after the original preservation guard
detected a different live source. Local Git records a `pull --ff-only` fast-forward
at 2026-09-22 09:19:59 -05:00 from the original B1 baseline to
`3c2b5a2b770e8523374139a4937e1830e278fe29` (v0.23.5). The live source tree is clean.
The intervening commits include Windows pipx installation, missing-library launch
diagnostics, Fabric MCP launch reliability and test fixes. The release manifest
changes only `coop_version`; this does not prove every installed package version.

PowerShell history contains `coop update` near its end. The existing updater
performs the recorded Git command and then package convergence. This supports
that update route, but the history has no per-command timestamps and does not
identify the operator. The related task "Fix coop-agent presentation bug"
documents the separately approved September 19 update, not this September 22
operation. No definitive provenance or new baseline approval was established.

Compared with the original snapshot, the observation found changes in 15
previously tracked stable files, 23 client files, one selected agent configuration
file, and 66,192 vendor metadata entries. Metadata changes are not proof of changed
content, package upgrades or damage. No client contents, credentials or raw
configuration were included in the public receipt. No causal attribution is made.

Evidence remains on E: in `evidence/preservation-drift-20260922.json` and
`evidence/stable-update-investigation-20260922.md`. The original snapshots remain
unchanged. The failed source guard did not refresh `preservation-latest.json`, so
its old successful result is stale. No fresh before snapshot exists for the
resumed September 22 native tests; their selected beta-file checks cannot fill
that gap. The investigation changed no live files, ran no live updater/Doctor,
and performed no restore, package operation, launch or service call. Further
native qualification was held until a fresh observation was captured. The next
window and its limits follow; B1 implementation and acceptance are incomplete.

### In-agent companion tool routing

`extensions/coop-tools/index.ts` now sends beta `sql_review`, `dax_review`,
`data_doc`, the lineage setup bridge and its follow-up build through the selected
Node and beta lifecycle. The lifecycle validates the recorded source, owned
workspace, exact private companion Python and pinned package before execution.
Stable tool dispatch remains unchanged. In beta, the Tabular Editor BPA and Fabric
SQL fallback tools refuse before launching an executable or connection; their
qualification remains open.

`tests/beta-agent-tools.test.mjs` covers dispatch vectors, incomplete context
refusal, stable dispatch, immutable standards binding after `before_agent_start`,
and early refusal of unqualified tools. The existing standards, BPA, data-doc,
setup bridge and Fabric SQL tests pass in an E: harness. Syntax, parity and BOM
checks pass. These focused tests do not substitute for a real Pi ExtensionRunner
rehearsal.

Synthetic E: source `a5f6ff59abe089cab590f08d9e2257dc47fdf08a` was selected
successfully. The first native harness then failed a raw-byte source comparison
because the clean fixture normalizes line endings; normalized source text matches
the working code. Its failed receipt remains `evidence/native-agent-tools.json`.
The separate `evidence/native-agent-tools-continuation.json` records actual
data-doc scan success, pinned SQL/DAX companion exit 0, outside-path refusal,
early BPA/SQL-fallback refusal, and unchanged selected beta files and package
inventory. The direct harness omitted Pi's `before_agent_start` standards
binding, so its reviewer results were rejected for missing trusted provenance.
It does not prove that in-agent review results are accepted in a real session.
The focused hook test accepts matching synthetic provenance. An E:-only
qualification then loaded the selected extension through Pi 0.84.3's real loader
and ExtensionRunner, ran `before_agent_start`, and dispatched the registered
`data_doc`, `sql_review` and `dax_review` tools. All three returned exit 0; SQL
and DAX reports were accepted with trusted standards provenance. The same runner
confirmed early `beta_unqualified` refusal for BPA and Fabric SQL fallback.
`evidence/pi-agent-tools-runner.json` records the eight steps and zero model or
service calls. This qualifies those in-agent paths for the selected synthetic
source, but not a live provider session or final B1 artifact.

A fresh read-only C: snapshot was taken before that E: run and compared afterward
in `evidence/preservation-agent-tools-20260922.json`. The live source commit and
status stayed unchanged. Four client files changed and client Git status changed;
23 personal Pi/Coop metadata entries also changed. No monitored stable source or
selected agent configuration file changed. The observation cannot attribute
those changes to the beta or concurrent user activity. C: preservation for this
window is inconclusive, and further native beta runs are held. No client
contents, credential values or private filenames were copied into the public
receipt. No model/service calls, package installs or stable deployment were made
by this qualification.

The required post-change full suite ran from the isolated E: harness and exited 1
in `evidence/suite-review-suite-checks.txt`. All B1 groups reached before the
standards tests passed, including native installer, lifecycle, source recovery,
data-doc, reviewer and combined-review tests. `tests/standards-rev9.test.mjs:250`
then failed at Windows file-symlink creation with `EPERM`. This host lacks the
needed symlink permission for that case; later tests were not run by this suite.
The direct file-symlink assertion remains intact. No machine policy, privilege,
test expectation or package was changed to make the suite appear green.

### Private beta home and AppData

Review of the child environment found that it still inherited `HOME`,
`USERPROFILE`, `APPDATA` and `LOCALAPPDATA` from the account. An installed vendor
tool could therefore discover or write personal state despite the separate Coop
agent directory. The B1 child now receives all four paths under its owned E:
profile, with matching Windows home drive/path values. The account's environment
and stable installation are not changed. The installation record continues to
protect the real user home captured at planning; validation allows the beta child
to use its own profile as home. Pi's external-resource refusal now inspects that
private home during beta launch.

The context, lifecycle, profile/context, native PowerShell 5.1/7 and Git Bash,
Support Center, in-agent tool, syntax/parity/BOM checks passed after this change.
A clean E: synthetic source `871eae6164955f985d0aafc64a96e33040a361c2`
was selected through the public beta updater; Doctor passed, selected profile
hashes and package inventory stayed unchanged. Pi 0.84.3's real loader and
ExtensionRunner then accepted data-doc, SQL and DAX dispatch using the private
home; held BPA/Fabric SQL tools still refused. Receipts:
`evidence/native-home-update.json` and `evidence/pi-agent-tools-runner-home.json`.
No model or service calls, package upgrade, stable deployment or account-wide
environment change occurred.

The fresh read-only C: before/after window in
`evidence/preservation-private-home-20260922.json` observed the same v0.23.5
source commit/status, unchanged client Git status and zero changed monitored file
hashes. It also observed 24 personal/vendor metadata changes, so full C:
preservation remains inconclusive and cannot be attributed to beta or concurrent
activity. A subsequent category-only check saw additional client activity after
that window. No contents or private filenames are in the public receipt.

The host's current user token lacks `SeCreateSymbolicLinkPrivilege`; direct
Windows file-symlink creation still fails with `EPERM`. Neither Developer Mode nor
privilege policy was changed. The full-suite blocker remains open.

The first full-suite run after private-home routing stopped earlier in the
initial-install test: the public installer plans under the original home, then
revalidates after entering its private child profile. Planning initially treated
that private profile as a protected outside home. The handoff now carries the
original home only during installation planning, permits only the exact derived
beta profile as the child's home, and retains the original path in the claimed
record. The focused native interrupted-install/retry test passed with an explicit
assertion that the original home remains protected. A direct PowerShell 5.1/7
probe confirmed newly launched beta shells resolve automatic `$HOME` to the E:
profile. PowerShell's automatic `$HOME` is read-only and does not follow an
in-process environment switch in the installer; that remaining install stage
uses explicit beta paths, and its Node children receive the E: environment.
The initial post-change full run stopped at that installer test. It is not
evidence that the follow-up passed the full suite.

Clean synthetic source `5a30ce319daf2f8261784ab37e58d244dbdab7a8` then
passed public E: beta update and Doctor with unchanged package inventory and
selected profile hashes. The actual Pi 0.84.3 loader/runner passed the same
eight in-agent steps under the private profile. Receipts:
`evidence/native-home-v2-update.json` and
`evidence/pi-agent-tools-runner-home-v2.json`. The fresh read-only C: window in
`evidence/preservation-private-home-v2-20260922.json` observed zero changed
monitored file hashes or Git statuses and 21 vendor metadata changes. It is
again inconclusive for full C: preservation. No causal attribution is made.

The post-handoff full suite passed initial install, beta init, data-doc/reviewer,
combined/Git-selected review, native shell/process, repeated lifecycle and all
ten source-recovery phases. It then exited 1 at the unchanged Windows file
symlink `EPERM` in `tests/standards-rev9.test.mjs:250`; later tests, including
the new in-agent test, were not reached by that full invocation. Focused in-agent
and existing extension regressions passed separately. Receipt:
`evidence/suite-review-suite-checks.txt`. No assertion or host privilege was
changed.

For the same selected source, the real Pi `DefaultResourceLoader` loaded eight
E:-owned extensions with zero extension errors and zero blocked external
read/write, network or child-process attempts in the offline instrumented run;
108 writes stayed inside beta. Public launch preview selected the exact private
Pi executable and refused an outside working directory, external session path
and non-OpenAI provider. The first preview harness incorrectly required
`auth.json` to be absent in a reused beta profile; its four public checks had
already passed, and the corrected receipt keeps that prior failure distinct.
The offline owned-process CLI `--help --no-session` then exited 0 with zero
blocked attempts and 22 beta-owned writes, without a prompt or provider sign-in.
Receipts: `evidence/native-resources-final.json`,
`evidence/native-preview-final-r2-qualification.json`, and
`evidence/native-cli-startup-final.json`. These checks do not qualify a live
provider, service integration or every vendor-native capability.

### Offline standards startup qualification

Calling the full installed Pi `before_agent_start` hook on source `5a30ce3`
exposed three automatic child-process attempts: a canonical standards Git clone
and two bundled reviewer CLI probes. The E: offline harness blocked them; that
failed receipt remains at `evidence/native-runner-final-r2.json`. Beta startup
initially used existing local standards only: no automatic refresh, bundled
reviewer probe or project Git revision probe. Stable kept its previous
standards behavior. Explicit standards synchronization remains a separate
operation. If a previously synchronized local canonical generation needs Git
verification, beta uses the executable recorded in its installation context.
That initial beta-only choice left ordinary SQL/DAX review without its bundled
standards when a project had no override; it was not accepted as the final
behavior.

A clean E: synthetic source `4d3c4e8` was selected through the public updater.
Doctor passed with package inventory and four selected profile hashes unchanged
(`evidence/native-offline-standards-update.json`). The real Pi 0.84.3 loader
loaded eight E:-owned extensions; `ExtensionRunner.emitBeforeAgentStart` then
returned one startup message with zero hook errors, zero blocked external
read/write, child-process or network attempts, and 21 beta-owned writes.
Receipt: `evidence/native-runner-offline-standards.json`. A focused regression
now runs beta startup without project standards while intercepting child-process
APIs. At that checkpoint it passed with zero attempts, before bundled fallback
was restored through exact selected beta companions. These
checks make no model or service call and do not qualify a live provider.

The matching read-only C: comparison observed unchanged live v0.23.5 source,
source/client Git statuses and 2,128 monitored file hashes. Eighteen vendor
metadata entries changed during the window; full C: preservation is therefore
inconclusive, without causal attribution. Only equality and counts are in
`evidence/preservation-offline-standards-20260922.json`.

The required post-change full suite again exited 1 at the unchanged Windows
file-symlink `EPERM` in `tests/standards-rev9.test.mjs:250`. Every preceding B1
group passed, including all ten source-recovery phases and the first twelve
standards cases; later tests did not run in that invocation. Receipt:
`evidence/suite-review-suite-checks.txt`. Separate downstream runs reached two
more direct file-symlink `EPERM` cases in
`standards-review-generations.test.mjs` and `microsoft-skills.test.py`.
`sync-knowledge.test.sh` and the Windows owned-kill diagnostic probe need a C
compiler absent from this test PATH. An initial Fabric MCP fixture failure was
the E: harness's extensionless Python shim; using the installed native Python
made that fixture pass (`evidence/fabric-native-checks.txt`). Terminal
acceptance initially selected a Python without `jsonschema`; using the existing
native Python with that module passed seven named non-file-symlink cases
(`evidence/terminal-safe-checks.txt`). Its file-symlink authorization case
remains unrun. The continuation through web bridge, BPA, protocol, diff and
support passed (`evidence/downstream-v7-checks.txt`), as did the earlier
downstream slices up to their stated stops. None is a green full-suite result.
No test assertion, workstation privilege or package set was changed.

### Bundled SQL/DAX standards retained without automatic remote sync

Beta startup still suppresses the canonical network refresh. For projects with
no local standards, it now invokes only the recorded beta Node/lifecycle and
private SQL/DAX reviewer executables. Reviewer discovery is checked against the
package's real report contract. The round-trip `--standards` check uses a
content-addressed copy under the E: beta profile, because beta correctly
rejects a raw package path as an explicit input. The probe runs in the owned
E: beta workspace; no client path or account-wide temporary directory is used.
Stable's reviewer resolution remains unchanged.

Synthetic source `070e8cf` proved discovery, but each round-trip returned 1;
the failed receipt is `evidence/native-runner-bundled-review.json`. Source
`630b1479` then passed public update/Doctor with unchanged package inventory
and selected profile hashes (`evidence/native-bundled-snapshot-update.json`).
Its real Pi 0.84.3 startup loaded eight extensions with zero hook errors and
zero blocked network, external-file or unexpected child attempts. Four exact
reviewer probes (discovery and round-trip for SQL and DAX) exited 0; the SQL
startup message contained the bundled fallback. Actual `sql_review` and
`dax_review` calls, plus data-doc, succeeded in a synthetic E: project with no
project standards. Receipts: `evidence/native-runner-bundled-snapshot.json` and
`evidence/pi-agent-bundled-snapshot-checks.txt`. No model or service call was
made. The focused in-agent regression also passes with exact child selection.

The matching read-only C: window observed unchanged v0.23.5 source, source and
client Git statuses, and 2,045 monitored file hashes. Thirty-two vendor
metadata entries changed during the nine-minute window; full C: preservation
remains inconclusive and no cause is assigned. Receipt:
`evidence/preservation-bundled-review-20260923.json`. Static Bash/parity/BOM
checks passed. The required full-suite rerun against this final code exited 1
at the unchanged Windows file-symlink `EPERM` in
`tests/standards-rev9.test.mjs:250`. Every preceding B1 group, all ten source
recovery phases and twelve standards cases passed; later tests were not reached
by that invocation. Receipt: `evidence/suite-review-suite-checks.txt`. The
operator-facing decision, exact selected identity and outstanding acceptance
limits are in `evidence/B1_OPERATOR_RECEIPT_20260923.md`. B1 is not accepted
or promoted.

### Reconciliation onto current main (September 23)

The original B1 working tree at `cee2d7418c0357f8e4bbd23e438cf026e2e15764`
was preserved. Its patch and 27 new files were overlaid into a separate E:
worktree at `3c2b5a2b770e8523374139a4937e1830e278fe29` (v0.23.5).
The only textual conflicts were `bin/coop` and `bin/coop.ps1`. Both retain the
newer stable missing-helper diagnostics and forward beta before stable profile
creation. The newer pipx-path, setup-bridge and test changes also remain.
The beta manifest's `coop_version` label was aligned to 0.23.5; its package
versions remain unchanged, including the approved Fabric MCP 1.2.0,
Azure DevOps MCP 2.10.0 and mcp-remote 0.14.2 pins. The manifest SHA-256 is
`a57501dda1d29c3135b7ee60bcf96580775f46efb1dbab1385b485444a95d9ac`.

Static Bash syntax, paired-script parity and PowerShell BOM checks passed.
Focused missing-helper, pipx-path, beta launch-input and native initial-install
checks passed. The required full suite ran twice on the reconciled checkout,
including after the manifest label change. Both runs passed every B1 group,
all ten source-recovery phases and twelve standards cases, then stopped at the
unchanged Windows file-symlink `EPERM` in `tests/standards-rev9.test.mjs:250`.
The final suite receipt is outside the product tree at
`E:/Codex/coop-b1-20260919/reconcile/evidence/final/suite-review-suite-checks.txt`.
No C: deployment, product commit, or push occurred. A new E: beta root at
`E:/Codex/coop-b1-20260919/rehearsal/Beta 0.23.5 reconciled` was provisioned
from clean synthetic source `1bb87ff70d8ce0bddf3fb1dd8936cbd3fde0c2e6`.
All 54 changed product/config/test files matched that source after line-ending
normalization. The installed manifest hash is
`470aa4962168345d038c046bb9808a292d73754491dad803e0284bc02543c5fa`.
Public first install and independent Doctor passed with 16 matching private npm
packages and the approved MCP pins; four selected profile hashes remained
unchanged through Doctor. Real Pi 0.84.3 loaded eight E:-owned extensions and
ran its startup hook with zero errors or blocked attempts. Four exact SQL/DAX
reviewer probes exited 0; actual in-agent data-doc, SQL and DAX dispatch passed
on synthetic E: files without a model or service call. Receipts are under
`E:/Codex/coop-b1-20260919/reconcile/evidence/`.

The matching read-only C: comparison found unchanged v0.23.5 source, source and
client Git statuses, and zero changed among 2,046 monitored file hashes.
Sixty-four vendor metadata entries changed during the original window; a later
read-only categorization counted 69 changes across `.coop`, `.pi` and `.azure`
over the extended window. No cause is assigned, so full C: preservation remains
inconclusive. The new E: beta is for isolated development rehearsal, not client
work. Current-source actual-package update/rollback/removal and live sign-in
remain unqualified. The full suite also needs a Windows test host with
file-symlink privilege, plus the recorded compiler prerequisite for later tests.

The [S1/S2 current-source assessment](COOP_WINDOWS_TERMINAL_S1_S2_ASSESSMENT.md)
was initially a read-only planning slice. On September 24 Aaron allowed the
first bounded S2 cleanup to proceed on this machine as E:-only development and
testing despite the open B1 gates. This does not close those gates or authorize
package changes, client beta use or stable promotion.

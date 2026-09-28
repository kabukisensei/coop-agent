# S1/S2 current-source assessment — September 23, 2026

**Status:** September 28 review checkpoint. The first bounded S2 change was
implemented September 24 as E:-only development/testing and is recorded separately
from B1 for review under Aaron's September 28 commit/push authorization.
No S1 change has started.
[B1 acceptance remains open](COOP_WINDOWS_TERMINAL_B1_IMPLEMENTATION.md).
The separate E: beta may be used for synthetic/offline development rehearsal,
but not client work or promotion to the live C: installation.

## Source and decision

This assessment inspected the reconciled, uncommitted E: branch
`codex/b1-isolated-windows-beta-v0235`, based on v0.23.5 `main` at
`3c2b5a2b770e8523374139a4937e1830e278fe29`. The original B1 working
tree remains preserved. No C: file or installation was changed for this review.

The first simplification implementation is a **small S2 lifecycle slice**,
rather than the broad S1 platform retirement. In
`scripts/update.ps1`, the Power BI/Fabric npm-tool updater probes each package
with `npm ls -g`, then runs the same pinned `npm install -g $spec` command in
both the installed and missing branches. `scripts/update.sh` has the same
redundant decision. Removing those two probes and branches is a bounded
mechanical candidate: one pinned install per spec, the existing result count
and messages, and no change to versions or ownership. It needs its own PR and
native Windows evidence before acceptance.

Do not fold the whole lifecycle into one framework. `scripts/install.ps1` has
a different non-force fallback to `npm update`; `scripts/sync.ps1` verifies
exact extension pins and aligns Pi libraries after convergence. Those behaviors
are not equivalent to the update branch and should remain until individually
mapped. Stable and beta already route through an explicit installation context;
the S2 slice must preserve both routes and the approved beta manifest pins.

## S1 inventory and retirement gate

The current E: candidate contains `bin/coop`, `lib/common.sh`, and 16
`scripts/*.sh` files: **18 files totaling 258,007 bytes**. This is a gross
inventory, not a deletion target: it includes parity/test tooling, migration,
knowledge and other scripts with potentially distinct consumers. The older
plan's 12-file/208,868-byte count is historical and cannot certify a current
saving. The product Bash dispatcher, common library and lifecycle have Windows
PowerShell counterparts, but `scripts/check-parity.sh`, `AGENTS.md` and CI
still require their pairing and PowerShell BOMs. Retiring a Bash file before
porting any unique Windows/Git Bash assertions and updating those obligations
would break the current contract. S1 needs a call-site/test map and a separate
approved retirement package after B1.

## Proposed S2 acceptance boundary

1. Develop on the reconciled E: branch under Aaron's September 24 exception.
   Formal acceptance still needs B1's full-suite and isolated-beta lifecycle
   gaps closed or explicitly dispositioned. Keep the change separate from
   dependency upgrades, optional packages and S1 deletion.
2. Remove only the redundant installed/missing npm probe and identical branches
   in the paired update scripts. Preserve pinned spec selection, `--edge`
   behavior, failure exit, user-facing result counts and refusal when npm is
   unavailable. Ensure no install is attempted in `update --check`.
3. Verify command sequencing for missing, matching and wrong-version tools,
   npm failure, `--edge`, and check-only mode. Run Bash syntax, parity/BOM, the
   full suite and a native Windows updater rehearsal in an owned E: fixture.
   Compare exact package inventory and owned-file hashes before and after.
4. Report deleted lines and external probes against added lines; accept the
   slice only if it removes real complexity without a new long-lived helper or
   a change to stable/beta configuration ownership.

The optional-package compatibility review is a separate PK1 decision. It
does not authorize installing `pi-lovely-rename`, `pi-lovely-codex`,
`pi-lovely-dev-tools` or `pi-simplify` as part of S2. Trials require their own
compatibility, subscription-authentication and guardrail evidence.

## Pause and resume handoff

**Assessment result:** retain S1 as a later, separately approved retirement
package. The redundant npm presence checks in paired update scripts are the
first S2 change. On September 24 Aaron explicitly allowed this E: development
slice to proceed with the B1 formal gates still open. It is not an accepted
client/stable build or a package-version decision.

The reconciled B1 and S2 development changes are the September 28 review checkpoint
on `codex/b1-isolated-windows-beta-v0235`, worked in
`E:/Codex/coop-b1-20260919/reconcile/repo`. The original B1 worktree at
`E:/Codex/coop-b1-20260919/repo` and its evidence remain intact. The
operator-facing [B1 implementation record](COOP_WINDOWS_TERMINAL_B1_IMPLEMENTATION.md)
and `E:/Codex/coop-b1-20260919/reconcile/RECONCILIATION_RECEIPT_20260923.md`
give the exact beta identity and test receipts. Check ownership and status when
resuming; do not clean, reset, stash or pull over another agent's dirty worktree.

Before client or stable promotion, resolve the B1 acceptance gaps: a Windows
test host permitted to create
file symlinks and able to run the later compiler-dependent cases; current-source
actual-package update/rollback/removal rehearsal in owned E: roots; and a
conclusive C: preservation comparison or a documented disposition of the
unattributed vendor metadata drift. The earlier full-suite run is partial, not
green. The existing E: beta is limited to synthetic/offline development; do not
use it for client work, sign in, call live services, or promote it to stable from
this handoff. Keep the paired S2 patch independently reviewable and do not
combine it with package changes. The September 23 assessment itself made no
commits or pushes; September 28 publication was separately authorized.

## September 28 publication checks

B1 is commit `2f8d1badace71c8f20e346b21ec67193a5d9635d`; the following commit
contains the paired S2 patch and this current-status handoff. Fresh Bash syntax,
PowerShell parsing/BOM, parity, update-guard and fleet-manifest checks passed.
Test home, temporary paths and npm cache stayed under
`E:/Codex/coop-b1-20260919/reconcile/evidence/publish-20260928/` with package
commands stubbed and npm offline. The prior full-suite attempts below are still
partial; they were not relabeled green or repeated for this publication.
The installed E: beta and operational C: installation were not updated.

## September 24 E: development result

The first bounded S2 patch is present only in the uncommitted E: branch.
`scripts/update.ps1` and `scripts/update.sh` each call the same pinned
`npm install -g` once per spec, without the former `npm ls -g` probe and
identical installed/missing branches. The paired diff removes a net 12 lines
and one external probe per tool on each platform; it adds no product helper
and changes no version pin. The changed updater path was not executed against
workstation packages. B1 code and the original worktree remain preserved.

Bash syntax passed for all 50 product/test shell files. PowerShell parsing,
the UTF-8 BOM, paired-script parity, `update-guard` and `fleet-manifest`
checks passed. All test homes, temporary output and npm caches were directed
to E:. The first full-suite attempt passed all B1 groups and ten recovery
phases, then stopped at extension bundling because offline esbuild was absent
from the E: npm cache. An existing esbuild 0.28.2 binary was copied read-only
from the C: npm cache into an E: test-only shim; its SHA-256 matched the source,
and a separate E: probe bundled all four extensions.

The second full-suite attempt again passed all B1 groups and ten recovery
phases, bundled extensions, then stopped at `tests/standards-rev9.test.mjs:211`:
the inherited PATH exposed live reviewer binaries, so an absence assertion
found a bundled fallback. A direct rerun of that standards file with a fresh
E: HOME and a PATH excluding those binaries passed through STD-10 and stopped
at the previously recorded Windows file-symlink `EPERM` on line 250. The
direct rerun verifies the environment explanation, but it is not a green full
suite. The receipts are under
`E:/Codex/coop-b1-20260919/reconcile/evidence/s2-dev-20260924/`.

One direct-test harness attempt used PowerShell's read-only `$HOME` variable
name, so its intended E: HOME override failed. It was stopped and excluded
from verification; no installer, updater or package command was invoked.
The validated rerun used a distinct variable and checked its E: paths and
restricted PATH before execution. The S2 patch remains development-only,
uncommitted and unpromoted. Formal B1 and S2 acceptance still need the
recorded native suite and lifecycle gaps resolved or explicitly dispositioned.
A final read-only Git check found the live C: source still at
`3c2b5a2b770e8523374139a4937e1830e278fe29` with no tracked staged or
unstaged diff; this is not a fresh full vendor/client preservation receipt.
The installed E: beta remains on its prior synthetic source and was not
updated with this S2 patch.

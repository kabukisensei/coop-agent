# Windows updater implementation — work in progress

Checkout: `coop-agent-windows-updates`, branch
`feature/coop-desktop-windows-validation-updates`, based on
`8b9449656203a893e4d8dff983eca4a59f27114d`.

The existing native directory replacement engine is not a complete updater.
Preparation, independent recovery, startup exclusion, helper transport, native
signature checks and installed update/rollback still need integration and proof.

## Preparation boundary

`desktop/src/update-windows-archive.py` extracts a ZIP into a new directory using
the bundled Python standard library. It validates all names before creating the
destination, rejects Windows path aliases and collisions, links/reparse entries,
special files and encrypted entries, and bounds file count and expanded bytes.
Extraction never launches candidate code. Existing destination data is preserved.

`desktop/src/update-windows-prepare.mjs` verifies the signed descriptor, copies
the downloaded artifact into a private preparation directory and verifies that
snapshot before extraction. It validates the native application before promotion
and returns a disposer that checks directory identities before deletion. Failed
or cancelled preparation removes only the owned staging directory. The original
download and existing version-store data are retained. The desktop update UI and
detached helper do not yet call this preparation path.

`desktop/src/update-windows-application.mjs` now checks a candidate's PE headers
without executing it, obtains Authenticode status and version metadata through
the fixed `update-windows-metadata.ps1` OS helper, and checks the managed runtime
against the signed descriptor. It requires a valid native signature, production
product name and matching version/architecture; unsigned validation packages are
rejected. The helper restricts its child-process module path to Windows
PowerShell's OS modules, because a PowerShell 7 parent otherwise caused native
signature lookup to fail. No certificate store or persistent environment is
changed. Preparation invokes this validator; replacement integration is pending.

NSIS remains the initial installer. Running an NSIS installer to prepare a
candidate could invoke its registered uninstaller and affect the current app.
The proposed update path instead needs a separate ZIP artifact alongside NSIS;
artifact production and release-gate changes remain pending.

## Native evidence

On Windows with Python 3.12, `python -B tests/windows-update-archive.test.py`
passed five test groups, covering real Unicode file extraction, traversal/device
paths, case collisions, file/directory conflicts, links/reparse attributes, bounds
and existing-destination preservation. `node tests/windows-update-archive.test.mjs`
also passed. Both script runners include this wrapper. Paired-script/BOM parity
passed. Full suites and integrated installed-app update tests remain pending.

`node tests/windows-update-application.test.mjs` passes six Windows groups,
including actual OS metadata lookup with an intentionally incompatible inherited
module path. `node tests/windows-update-prepare.test.mjs` passes four Windows
groups, including a real ZIP, an Ed25519-signed descriptor created for the test,
native unsigned-candidate rejection, cleanup and preservation. Existing update
service checks pass all 45 cases. A separate probe against `latest-app-v4` confirms
its real executable is x64, fails an ARM64 request and is rejected by the native
production signature/identity policy. These are component checks, not an installed
update or rollback acceptance result.

No production installation, user data, certificate store, release feed, release
version or version tag was changed. Preparation was committed and pushed as
`8d6b0ab542f3100812372182ad6a4b7d49cd6541` after full native Bash, Windows
PowerShell 5.1 and PowerShell 7 suites passed. The preparation patch is also
included in integrated agent commit `cc6d4808a9cb1703beaff5998c9faa7b655b44d5`.
The integrated Windows Job Object native health probe passed on the real packaged
application in 17103 ms. Candidate preparation and health success still do not
establish full installed update/rollback or independent recovery acceptance.

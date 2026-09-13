# Terminal workstation P0 acceptance — candidate `295693a`

This gate applies only to Terminal candidate
`295693a3eb08e9988594971d87bc4de751e6b551`. Its source baseline is v0.23.1 at
`d60300780b565aabf15b172b2bc32abad12b9ca6`. The workflow/harness SHA is a
third, dynamic identity and is recorded separately in every receipt.

Automated evidence is necessary but **cannot** prove authentication, a real model
response, or interactive workstation usability. It always writes
`terminal_workstation_ready: false`. A completed disposable-VM operator receipt
is mandatory before any readiness decision.

## Automated native-Windows evidence

Manually dispatch **Windows Terminal workstation acceptance** from the exact
harness revision to be assessed. Do not pass a branch or candidate input: the
workflow checks out the two immutable product SHAs itself. It runs only on a
GitHub-hosted `windows-latest` runner with `contents: read`, does not persist Git
credentials, and receives no product/provider secret.

The harness refuses pre-existing owned roots, creates separate profile, agent,
npm, pipx, local-app-data, and evidence roots, and then uses the product's real
PowerShell surfaces:

1. v0.23.1 source `scripts/install.ps1 --yes --no-prereqs`;
2. supported onboarding and `coop init --template` against non-secret fixtures;
3. baseline Doctor and Support;
4. candidate `scripts/install.ps1 --yes --no-prereqs` over the same profile;
5. candidate Doctor, Support, launch-spec, data-doc command, and manifest pins;
6. same-candidate reinstall;
7. v0.23.1 source install as rollback.

Profile files and a representative Git repository are hashed before and after
each transition. An unrelated npm-root sentinel must survive. Both product
checkouts must remain clean. A planted synthetic credential canary exercises
Support redaction and must not occur in uploaded evidence. Every process is
bounded; any unproved prerequisite, command failure, identity mismatch, dirty
checkout, state drift, or canary hit produces a non-ready fail-closed receipt.

The v0.23.1 release has no historical installer asset. Evidence must call this a
**source installation baseline**, not a historical installer.

## Mandatory disposable-VM operator gate

Never run this on Aaron's working installation. Required isolation is a Windows
VM that is disposable, snapshot-capable, and has no writable host profile or
shared repository. If that VM is unavailable, record `BLOCKED`; do not replace
it with local testing.

### Prepare

1. Power off the VM and take snapshot `pre-coop-terminal-295693a`.
2. Start it and clone the candidate into an ASCII-safe disposable path.
3. Verify before installation:

```powershell
git -C C:\coop-candidate-295693a rev-parse HEAD
if ((git -C C:\coop-candidate-295693a rev-parse HEAD) -ne "295693a3eb08e9988594971d87bc4de751e6b551") { throw "unexpected candidate SHA" }
$env:COOP_DIR = "C:\coop-p0-profile"
cd C:\coop-candidate-295693a
.\scripts\install.ps1 --yes
if ($LASTEXITCODE -ne 0) { throw "candidate install failed: $LASTEXITCODE" }
.\scripts\doctor.ps1
if ($LASTEXITCODE -ne 0) { throw "Doctor failed: $LASTEXITCODE" }
```

Use a fresh candidate install if the automated receipt did not prove one. Do not
copy an existing Coop profile into the VM.

### Human journeys

Record one status and a short **redacted observation** for every row. A command
exit code alone is not evidence for an interactive behavior.

| Receipt id | Required observation |
|---|---|
| `fresh-candidate-install` | Fresh candidate installation and Doctor complete in the clean VM. |
| `real-provider-auth` | Complete provider sign-in without recording credentials; `coop auth --json` reports the intended provider/model identity state. Redact account identifiers and tokens. |
| `real-model-response` | A new terminal session returns a coherent response from the selected real model. Record model label and behavior, not prompt contents that contain client data. |
| `copied-repo-workflow` | In a realistic **copied** engineering/data repo: inspect, ask, make one bounded approved edit, inspect the diff, run a relevant SQL/DAX/data-doc tool or skill, and request review. Preserve a redacted diff summary. |
| `decline-no-partial-write` | Decline a proposed edit and verify byte/hash/status evidence shows no partial write. |
| `stop-and-continue` | Stop/interrupt an in-flight request; the same session remains usable for a subsequent request. |
| `reopen-resume` | Close and reopen Coop, list the prior session, resume it, and continue successfully. |
| `teamai-failure-isolation` | With TeamAI missing, offline, or pending approval, the integration reports that state truthfully while core terminal use remains available. Do not install or fake an adapter. |
| `rollback-instructions` | Verify the documented v0.23.1 source rollback commands and expected manifest pins without claiming that file deletion is recovery. |
| `snapshot-recovery` | Copy redacted evidence off-VM, power off, revert `pre-coop-terminal-295693a`, and verify the candidate footprint is gone. |

For rollback verification, use the same profile without wiping it:

```powershell
git clone --branch v0.23.1 https://github.com/kabukisensei/coop-agent.git C:\coop-v0231-source
if ((git -C C:\coop-v0231-source rev-parse HEAD) -ne "d60300780b565aabf15b172b2bc32abad12b9ca6") { throw "unexpected baseline SHA" }
cd C:\coop-v0231-source
.\scripts\install.ps1 --yes
if ($LASTEXITCODE -ne 0) { throw "baseline source rollback failed: $LASTEXITCODE" }
.\scripts\doctor.ps1
if ($LASTEXITCODE -ne 0) { throw "rollback Doctor failed: $LASTEXITCODE" }
```

Snapshot revert—not uninstall or recursive deletion—is the recovery procedure.

## Complete and validate the operator receipt

1. Copy the automated JSON receipt to `terminal-workstation-operator.json`.
2. Keep its exact candidate, baseline, and harness SHAs.
3. Change `execution.layer` to `DISPOSABLE_VM_OPERATOR`; set VM start/finish
   timestamps and the disposable VM evidence root.
4. For each existing `operator_evidence` entry, set the observed status. Add at
   least one evidence object with:
   - `kind`: `OPERATOR_OBSERVATION`
   - a concise redacted `observed` value
   - `command`: the command used, or `human interaction`
   - `exit_code`: the observed integer or `null` for interaction-only evidence
   - `identity`: `operator`
   - `path`: redacted evidence path or empty string
   - `sha256`: evidence hash or empty string
5. Leave `terminal_workstation_ready` false for any `FAIL`, `BLOCKED`,
   `INCONCLUSIVE`, `NOT_REACHED`, `NOT_AVAILABLE`, `CAPABILITY_SKIP`, or
   `BETA_LIMITATION`. Set it true only when every required automated claim and
   all ten human claims are `PASS`.
6. Validate from the harness checkout:

```powershell
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\acceptance\windows-terminal-workstation.ps1 `
  -Mode ValidateReceipt -ReceiptPath C:\evidence\terminal-workstation-operator.json
if ($LASTEXITCODE -ne 0) { throw "operator receipt is invalid" }
```

Never paste credentials, access tokens, cookies, authorization headers, tenant
secrets, raw provider responses containing client data, or unredacted auth JSON
into notes, commands, logs, screenshots, or receipts. A checklist or template
existing is not acceptance; only completed, validated observations count.

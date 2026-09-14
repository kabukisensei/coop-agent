# Terminal workstation P0 acceptance — runtime-bound candidate

This gate binds at runtime to the immutable candidate SHA authorized by the GitHub
event. Its source baseline is v0.23.1 at
`d60300780b565aabf15b172b2bc32abad12b9ca6`. The verified candidate SHA and its
Support build fingerprint are recorded in every receipt and artifact name.

Automated evidence is necessary but **cannot** prove authentication, a real model
response, or interactive workstation usability. It always writes
`terminal_workstation_ready: false`. A completed disposable-VM operator receipt
is mandatory before any readiness decision. At this harness revision, native
Windows Job Object execution and every interactive disposable-VM journey remain
pending; the cross-platform tests below are not substitutes for either gate.

## Automated native-Windows evidence

Before merge, the workflow runs automatically only for a same-repository pull
request into `main` whose head branch is exactly
`integration/presentation-2026-09-20`; every other pull-request head leaves
the native job skipped. `workflow_dispatch` requires an explicit full lowercase
40-hex candidate SHA. The PR route uses `pull_request.head.sha`; both routes check
out that immutable SHA directly and compare `git rev-parse HEAD` before any install
or harness work. Synthetic merge refs and payload-provided candidate identities are
not accepted.
It runs only on a GitHub-hosted `windows-latest` runner with `contents: read`,
does not persist Git credentials, receives no product/provider secret, and uses
no write-capable event.

The harness refuses pre-existing owned roots and creates disposable profile,
npm, pipx, local-app-data, and evidence roots. Its effective agent directory is
the product layout `$COOP_DIR/.coop/agent`; `COOP_AGENT_DIR` points to that exact
directory, so onboarding, install, Doctor, and launch-spec exercise and hash the
same MCP state. It then uses the product's real PowerShell surfaces:

1. v0.23.1 source `scripts/install.ps1 --yes --no-prereqs`;
2. supported onboarding and `coop init --template` against non-secret fixtures;
3. baseline Doctor and Support;
4. candidate `scripts/install.ps1 --yes --no-prereqs` over the same profile;
5. candidate Doctor, Support, launch-spec, data-doc command, and manifest pins;
6. same-candidate reinstall;
7. v0.23.1 source install as rollback.

A ready receipt contains exactly one passing instance of every required automated
claim—no aliases or substitutes:

- `identity-and-isolation`
- `baseline-source-install`
- `candidate-upgrade-preservation`
- `candidate-health-and-tools`
- `same-candidate-reinstall`
- `baseline-rollback-preservation`
- `sanitized-read-only-evidence`

Profile files and a representative Git repository are hashed before and after
each transition. An unrelated npm-root sentinel must survive. Both product
checkouts must remain clean. A planted synthetic credential canary exercises
Support redaction and must not occur in uploaded evidence. Every process is
bounded; any unproved prerequisite, command failure, identity mismatch, dirty
checkout, state drift, or canary hit produces a non-ready fail-closed receipt.
The canary is initialized before fallible prechecks. Finalization scans every
retained artifact on success and failure; unscannable or leaking evidence is
deleted from upload eligibility while a separately located controlled receipt is
retained. Every bounded payload runs through `scripts/knowledge-git.py` with its Git
transport probe bypassed by a child-only noninteractive environment. On Windows,
the helper creates the child suspended, assigns it to a KILL_ON_JOB_CLOSE Job
Object, and only then resumes it; descendants inherit membership and remain owned
after the immediate parent exits. On POSIX, the equivalent ownership unit is a
new process group. The helper preserves the child status and does not return
success until the ownership unit is positively verified empty. A failed Job
membership query, Job close, or other ownership uncertainty returns `126`; timeout
remains `124`. Either hard failure suppresses the upload marker and removes the
evidence directory. Bounded stdin is opened directly by the helper, and payload argv
is transferred as UTF-8 JSON rather than a shell command, preserving Unicode paths,
metacharacters, spaces, and empty arguments. There is no PID snapshot, parent-only
fallback, or `.cmd` serialization.

The workflow runs fixed, test-only ownership fault seams for Job creation,
assignment, resume, membership query, termination, and close before the acceptance
run. Creation/assignment/resume faults must terminate the still-suspended child
without executing it; query/close uncertainty must override payload success; and a
termination fault on a live descendant must remain a hard timeout. It also probes
Unicode stdin and difficult argument vectors through both the helper and wrapper.

Candidate Support must report the exact build fingerprint computed at runtime by
the production `fingerprintBuild` contract from the candidate checkout's `VERSION`
and verified full SHA. The receipt records both the expected and observed fingerprint;
no committed hard-coded candidate fingerprint is authoritative.
For both candidate and rollback, the complete proof is derived from that
checkout's own `config/release-manifest.json`: checkout VERSION proves
`coop_version`; npm inventory plus Doctor prove the Pi package/version; Doctor
proves every extension and Python pin (including `ms-fabric-cli` and the injected
`fabric-cicd` library); npm inventory proves every npm-tool pin; and each
COOP-managed MCP entry must contain exactly one manifest-pinned package spec.
Manifest MCP packages not enabled in the generated `_coop.managed_servers` list
are recorded as `NOT_MANAGED` and are explicitly non-applicable—not claimed as
installed or healthy. Warning-only Doctor output never establishes convergence.

The v0.23.1 release has no historical installer asset. Evidence must call this a
**source installation baseline**, not a historical installer.

## Mandatory disposable-VM operator gate

Never run this on Aaron's working installation. Required isolation is a Windows
VM that is disposable, snapshot-capable, and has no writable host profile or
shared repository. If that VM is unavailable, record `BLOCKED`; do not replace
it with local testing.

### Prepare

1. Power off the VM and take snapshot `pre-coop-terminal-candidate`.
2. Start it and clone the candidate into a disposable path. Include at least one
   non-ASCII path segment in the operator exercise; ASCII-only paths do not verify
   the harness's Unicode contract.
3. Verify before installation:

```powershell
$CandidateSha = '<full lowercase 40-hex event-authorized candidate SHA>'
git -C C:\coop-candidate rev-parse HEAD
if ((git -C C:\coop-candidate rev-parse HEAD) -cne $CandidateSha) { throw "unexpected candidate SHA" }
$env:COOP_DIR = "C:\coop-p0-profile"
cd C:\coop-candidate
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
| `warehouse-mcp-live-acceptance` | With an authorized test identity and approved Warehouse/Lakehouse target, `coop doctor` validates the item target and discovers `executeSQL`, `execute_query`, or a documented server-prefixed spelling through `tools/list`. Config-only `registered`, `auth_required`, `unavailable`, `tool_missing`, and `target_invalid` are not passes. Do not run SQL or retain tokens, target names, SQL, arguments, or rows in evidence. |
| `snapshot-recovery` | Copy redacted evidence off-VM, power off, revert `pre-coop-terminal-candidate`, and verify the candidate footprint is gone. |

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
2. Keep `candidate.expected_sha` and `baseline.expected_sha` unchanged. Keep the
   observed identity fields exactly as emitted; `observed_sha`/`observed_version`
   remain `null` when the automated run never observed that checkout. Never copy
   an expected SHA into an unobserved field. Keep the harness `observed_sha` and
   `observed_version` unchanged.
3. Change `execution.layer` to `DISPOSABLE_VM_OPERATOR`; set VM start/finish
   timestamps and the disposable VM evidence root.
4. For each existing `operator_evidence` entry, set the observed status. Add at
   least one evidence object with:
   - `kind`: `OPERATOR_OBSERVATION`
   - a concise redacted `observed` value
   - `command`: the command used, or `human interaction`
   - `exit_code`: an integer for every `COMMAND`; an observed integer or `null`
     for non-command interaction evidence
   - `identity`: `operator`
   - `path`: redacted evidence path or empty string
   - `sha256`: evidence hash or empty string
5. Leave `terminal_workstation_ready` false for any `FAIL`, `BLOCKED`,
   `INCONCLUSIVE`, `NOT_REACHED`, `NOT_AVAILABLE`, `CAPABILITY_SKIP`, or
   `BETA_LIMITATION`. Set it true only when every required automated claim and
   all eleven human claims are `PASS`. The Warehouse MCP claim is a certification
   blocker until live authentication, target validation, and tool discovery pass;
   deterministic mocked tests are not a substitute for tenant/user permissions or
   live Fabric service behavior.
6. Validate from the harness checkout:

```powershell
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\acceptance\windows-terminal-workstation.ps1 `
  -Mode ValidateReceipt -ReceiptPath C:\evidence\terminal-workstation-operator.json `
  -ExpectedHarnessSha $CandidateSha -ExpectedCandidateSha $CandidateSha `
  -ExpectedCandidateBuild '<runtime-computed build fingerprint>'
if ($LASTEXITCODE -ne 0) { throw "operator receipt is invalid" }

# CI also validates this same receipt against the committed Draft 2020-12 schema
# with pinned ajv-cli 5.0.0 + ajv-formats 3.0.1; neither validator may be skipped.
```

Never paste credentials, access tokens, cookies, authorization headers, tenant
secrets, raw provider responses containing client data, or unredacted auth JSON
into notes, commands, logs, screenshots, or receipts. A checklist or template
existing is not acceptance; only completed, validated observations count.
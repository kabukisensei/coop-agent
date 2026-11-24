---
name: verify-coop-agent
description: "Drive the coop CLI and installer from this coop-agent checkout the way a person does: version, help, doctor, extension launch, and coop update release selection. Use when changing the launcher, update, doctor, or extensions, or when a green test run is not enough to prove the CLI."
---

# Verify coop-agent

Prove coop by installing this checkout into a disposable profile and running the real `coop` commands. The harness does not call the test suite and does not import the PowerShell library in-process. It ends with `RESULT: PASS` or `RESULT: FAIL`.

Use it before merging a change to `bin/coop.ps1`, `scripts/install.ps1`, `scripts/update.ps1`, `scripts/doctor.ps1`, or the companion extensions under `extensions/coop-*`. A green `bash tests/run.sh` does not replace it.

`coop` is the product: a branded layer on Pi. People install it, run `coop help` and `coop version`, run `coop doctor`, and run `coop update`. The window (`coop desktop`) is a second surface. This harness does not open it.

## Prerequisites

From the repo root, on a machine that can develop coop (Linux, macOS, or Git Bash):

- `bash`, `git`, `tar`, `python3`, and `pwsh` (PowerShell 7) on `PATH`
- no model API key, no Pi install, and no network

The harness refuses to start when `HOME` is missing. It does not read or write the real `HOME`, the real `~/.coop`, or this checkout's git state. Tool convergence during `coop install` is pointed away from package indexes (`PIP_NO_INDEX=1`, `npm_config_offline=true`, npm removed from `PATH`, `COOP_PIPX_BIN` set to a path that is not there). `COOP_SKIP_AZ=1`, `COOP_NO_ONBOARD=1`, `COOP_NO_MODEL_LOGIN=1`, and `COOP_SKIP_UPDATE_CHECK=1` are set so doctor and install do not sign in or call GitHub.

## How to run

```sh
bash scripts/verify.sh
```

That is the run to quote. Partial runs, from the same root:

```sh
bash scripts/verify.sh launch
bash scripts/verify.sh doctor
bash scripts/verify.sh drive
bash scripts/verify.sh cleanup
```

`launch` installs and keeps the temp profile. `doctor` and `drive` use that profile. `cleanup` deletes it. One checkout has one instance (`.cache/verify/instance.env`). A second `launch`, or a full run, deletes the previous temp profile first.

## How to read the output

Stdout is the summary. The last line is the verdict. Stop there and quote the summary.

```text
RESULT: PASS
```

or

```text
RESULT: FAIL
```

`PASS` means every line above it that ends in `: pass` did, `home: unchanged` is present, `work_removed: yes` is present on a full run, and the evidence directory still holds `summary.txt` and `launcher.cmd`. `desktop: not-run` is expected on this harness and is not a failure. `FAIL:` lines name the check that broke. `doctor: pass (exit N)` and `install: pass (... exit N)` record the process exit code. `N` is often non-zero: a machine without Pi fails doctor's required rows, and install cannot download Pi while indexes are disabled. Those exit codes are not the proof. The proof is the text and the files named below.

Do not report `desktop: not-run` as covered by `coop launch-spec`.

## Launch

```sh
bash scripts/verify.sh launch
```

Ready is a summary that contains `install: pass` and `work_removed: no`. The temp profile is `$WORK/home` with `USERPROFILE`, `LOCALAPPDATA`, and `APPDATA` under it. `coop install --no-fabric --no-prereqs --yes` runs from an overlay of this checkout on a local git clone, through `bin/coop` (the Git Bash forwarder). The installer writes `%LOCALAPPDATA%\coop\bin\coop.cmd` as `@echo off` plus `call "<clone>\bin\coop.cmd" %*`, the same shim `scripts/install.ps1` writes, and its log says `linked`. On Linux the `.cmd` file is the artifact; later commands go through `bin/coop`, which is what that shim calls.

There is no long-lived server. Each later command is a new `bin/coop` process in that profile.

## Doctor

Read-only. The full run does this itself. A partial run:

```sh
bash scripts/verify.sh doctor
```

Healthy enough to keep driving:

```text
doctor: pass (exit N)
```

Doctor's report must name `coop doctor`, the fixture version `v0.42.0`, `brand splash present`, and `behind release v0.42.1`. It must not name `v1.0.19` or `v2.0.0` as the release it would move to. That is the same release rule as `coop update`. A report that is only "pi missing" is not this proof.

## Drive

```sh
bash scripts/verify.sh drive
```

The full run drives every offline feature. One feature does not cover the others. Commands:

```sh
coop version
coop help
coop doctor
coop launch-spec --json
coop update --check
```

`coop launch-spec --json` is how coop loads extensions: the `args` array is what it would pass to `pi`, including each `-e` directory. The harness checks those paths and that each one's `index.ts` (the `main` in `package.json`) is on disk. It does not start Pi, because `pi` opens a session.

`coop update --check` is the release selection a person reads before an update. It fetches the local `origin` and prints the move. It must not change `HEAD`. A full `coop update` without `--check` then installs tools from the network; this harness does not run that.

The feature map is the source for which entry points exist. Read `.cursor/skills/verify-coop-agent/features/README.md` before a partial drive.

## Evidence

A full run writes `<repo>/.cache/verify/evidence/<UTC timestamp>/`. `.cache/` is gitignored. Cleanup must not delete this directory.

| File | What it proves |
| --- | --- |
| `summary.txt` | The stdout block, including `RESULT:` |
| `launcher.cmd` | The installer's `coop.cmd` shim |
| `version.out`, `help.out`, `doctor.out` | The CLI text, with `.err` and `.rc` beside each |
| `launch-spec.out` | The JSON Pi launch spec |
| `update-from-0420.out`, `update-from-1019.out` | `coop update --check` from the matching tag and from the mismatched tag |
| `tags.txt`, `version-v1.0.19.txt`, `version-v0.42.1.txt` | The local tags and the `VERSION` file at two of them |
| `install-checkout.ps1`, `install-checkout-head.txt` | The Windows install doc's checkout line and the commit it landed on |

A proof is the command, its exit code, and the side effect. For install, the side effect is `coop.cmd`. For `coop update --check`, the side effect is the sentence `would move to release v0.42.1` and an unchanged `HEAD`. For the install doc line, the side effect is `HEAD` on `v0.42.1`.

## Cleanup

```sh
bash scripts/verify.sh cleanup
```

The full run cleans up by itself. Cleanup deletes the temp profile and `.cache/verify/instance.env` only when the work path is `/tmp/coop-verify-work.*`. It does not delete the evidence directory, this checkout, or the real `HOME`. Never `pkill` `pwsh` or `git`.

After cleanup, `launcher.cmd` and `summary.txt` must still be under the evidence path. A cleanup that removes them is a failed run. The summary says `work_removed: yes` when the temp profile is gone.

## Helpers

The helper is the script. It is executable.

```sh
bash scripts/verify.sh
bash scripts/verify.sh help
```

## Feature map

The release rule (merged PR #579): a strict `vX.Y.Z` tag counts only when it is merged into `origin/main` and `VERSION` at that commit, with whitespace removed, equals `X.Y.Z`. A higher tag whose `VERSION` disagrees, and a tag with no `VERSION` file, are skipped. `coop update` never moves backwards. `docs/install-windows.md` step 2 uses the same rule.

The harness builds that history on a local origin, with this checkout's files as the programs under test: `v0.42.0` (`VERSION` `0.42.0`), `v1.0.19` (`VERSION` still `0.42.0`), `v0.42.1` (`VERSION` `0.42.1`), and `v2.0.0` (no `VERSION` file). From `v0.42.0` and from `v1.0.19` the next release is `v0.42.1`.

| Flow | What the harness runs | What a pass proves |
| --- | --- | --- |
| Install | `coop install --no-fabric --no-prereqs --yes` | `%LOCALAPPDATA%\coop\bin\coop.cmd` calls this clone's `bin/coop.cmd` |
| Version | `coop version` | `coop 0.42.0 (v0.42.0)` and a `pi` line |
| Help | `coop help` | Names `doctor`, `update`, `install`, `version`, and `desktop`; exit 0 |
| Doctor | `coop doctor` | Splash is present and the repo is behind `v0.42.1`, not the skipped tags |
| Extensions | `coop launch-spec --json` | Each companion extension is an `-e` path whose `index.ts` exists |
| Update | `coop update --check` | Would move to `v0.42.1`; `HEAD` unchanged; mismatch and missing `VERSION` skipped |
| Install checkout | the step 2 line in `docs/install-windows.md` | A clone at `v0.42.0` checks out `v0.42.1` |
| Desktop | not run | Needs a display; `coop desktop` installs Electron on first use |

- [Install](features/install.md)
- [Version and help](features/cli-surface.md)
- [Doctor](features/doctor.md)
- [Extensions](features/extensions.md)
- [Update a release](features/update-release.md)
- [Desktop](features/desktop.md)

## Result

Run `bash scripts/verify.sh` from the repo root. The last line of its stdout is the verdict.

When the CLI changes, update this map and re-run. `/maintain-verification-skill` is the upkeep loop. Do not change the product to make a verification run pass.

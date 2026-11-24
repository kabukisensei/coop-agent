# Doctor

`coop doctor` checks the dependencies and the configuration of this coop and prints one report. Warnings do not, by themselves, fail the process. A missing required dependency does.

## Sub-features

- `doctor-identity` names the coop version in the report header.
- `doctor-splash` checks that the brand splash file is in the checkout.
- `doctor-release` names the release `coop update` would move to, using the same tag rule as update.

## How to get to it (user POV)

- Run `coop doctor`.
- Run `coop doctor --json` for one JSON document. The harness uses the human report.
- `coop doctor --fix` changes the machine. The harness does not pass `--fix`.

## Driving it with scripts/verify.sh

Preconditions:

- The disposable clone is at `v0.42.0`, and the local origin also has `v0.42.1` (matching `VERSION`), `v1.0.19` (`VERSION` `0.42.0`), and `v2.0.0` (no `VERSION` file).
- `COOP_SKIP_AZ=1` so doctor does not call Azure.

- **Report.** Run `coop doctor`. Record its exit code. Do not require 0.
- **Proof.** The combined stdout and stderr contain `coop doctor`, `v0.42.0`, `brand splash present`, and `behind release v0.42.1`. They do not contain `behind release v1.0.19` or `behind release v2.0.0`. The evidence files are `doctor.out`, `doctor.err`, and `doctor.rc`.

## Gotchas

- On a machine without Pi, doctor exits non-zero. That exit is the missing-tool rows, not a failed release check. Read the release sentence.
- Doctor refreshes `origin` at most once a day, against this clone's local origin. A fetch of `github.com` means the clone was not the disposable one.
- `--fix` installs and syncs. Do not pass it from this harness.

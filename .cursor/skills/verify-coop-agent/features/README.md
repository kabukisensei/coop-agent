# coop-agent verification map

This directory is the maintained source for verifying coop's user-facing CLI. Read it before driving a single feature. The harness is `bash scripts/verify.sh`.

## Baseline preconditions

- Run from the coop-agent repo root.
- `bash`, `git`, `tar`, `python3`, and `pwsh` are on `PATH`.
- The full run creates a disposable profile under `/tmp/coop-verify-work.*` and points `HOME`, `USERPROFILE`, `LOCALAPPDATA`, and `APPDATA` at it.
- Package indexes are disabled. No model API key is passed to `coop`.
- The git history under test is a local origin, not `github.com`. This checkout's files are copied onto that clone, excluding `.git`, so the commands are this tree's.
- Never point the harness at the real `HOME` or at this checkout's `.git`.

## Driving conventions

- Prefer `bash scripts/verify.sh` over typing the commands yourself.
- `launch`, then `doctor`, then `drive`, then `cleanup` is the partial sequence. `doctor` and `drive` reset the disposable clone to `v0.42.0` before they assert.
- Quote the summary. Its last line is `RESULT: PASS` or `RESULT: FAIL`.
- `desktop: not-run` is not a pass of the window.
- Evidence stays in `.cache/verify/evidence/<UTC timestamp>/` after cleanup.

## Proof and skip reporting

- Capture the command, the exit code, and the side effect (the launcher file, the report text, or `HEAD`).
- A non-zero `coop doctor` or `coop install` exit is recorded and is not, by itself, a failure. The asserted text and files are the proof.
- Report a path this harness cannot reach with the command that was not run and the missing prerequisite.
- Do not report a skipped entry point as verified through a different command.

## Feature entry contract

Each feature file starts with an H1 and one paragraph, then four H2 sections: `Sub-features`, `How to get to it (user POV)`, `Driving it with scripts/verify.sh`, and `Gotchas`.

## Features

- [Install](./install.md) covers `coop install` writing the `coop.cmd` shim into the temp profile.
- [Version and help](./cli-surface.md) covers `coop version` and `coop help`.
- [Doctor](./doctor.md) covers `coop doctor` on the disposable checkout.
- [Extensions](./extensions.md) covers the extensions `coop launch-spec` loads.
- [Update a release](./update-release.md) covers `coop update --check` and the install doc's checkout line. A tag counts only when its `VERSION` matches.
- [Desktop](./desktop.md) covers `coop desktop`. This harness does not launch the window.

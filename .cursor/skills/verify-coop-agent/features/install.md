# Install

`coop install` puts the `coop` command on the account's PATH by writing a `coop.cmd` shim that forwards to this checkout's `bin\coop.cmd`.

## Sub-features

- `install-link` writes `%LOCALAPPDATA%\coop\bin\coop.cmd` and logs that it linked.
- `install-idempotent` leaves an existing matching shim in place (`already linked`).

## How to get to it (user POV)

- Run `coop install` from a terminal after the prerequisites are present.
- On Windows, double-click `Install coop.cmd` in the clone. It runs the same script.
- `coop install --no-fabric` skips the Microsoft Fabric CLI. `--no-prereqs` prints missing prerequisites and continues. `--yes` accepts prompts.

## Driving it with scripts/verify.sh

Preconditions:

- `bash scripts/verify.sh launch` (or the full run) has created the temp profile.
- `PIP_NO_INDEX`, `npm_config_offline`, a PATH without npm, and a missing `COOP_PIPX_BIN` are set, so Pi and the Python tools are not downloaded.

- **Link coop.** Run `coop install --no-fabric --no-prereqs --yes` through `<clone>/bin/coop`. The process may exit non-zero because the tool steps cannot reach a package index. Stderr contains `linked` (or `already linked` on a second install into the same profile).
- **Proof.** `%LOCALAPPDATA%\coop\bin\coop.cmd` exists. Its text is `@echo off` followed by `call "<clone>/bin/coop.cmd" %*`. A copy is `launcher.cmd` in the evidence directory. The real `HOME` is unchanged.

## Gotchas

- Exit 0 is not the proof. Offline, the pipx, Pi, and sync steps fail and the installer still writes the shim before those failures fail the process.
- The shim is a Windows `cmd` file. On Linux the harness asserts the file, then drives `bin/coop`, which is the program the shim calls.
- A profile whose `HOME` is the real account can rewrite the user PATH. The harness sets `HOME` only for the `coop` process.

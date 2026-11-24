# Version and help

`coop version` prints the coop version, and the checkout's `git describe` when this is a git checkout. `coop help` lists the commands a person can run.

## Sub-features

- `version-file` prints `coop` plus the `VERSION` file.
- `version-describe` appends the tag `git describe` resolves, in parentheses.
- `version-pi` prints the installed `pi` version, or `pi   (not installed)`.
- `help-commands` names `doctor`, `update`, `install`, `version`, and `desktop`.

## How to get to it (user POV)

- Run `coop version`, `coop --version`, or `coop -V`.
- Run `coop help`, `coop --help`, or `coop -h`.

## Driving it with scripts/verify.sh

Preconditions:

- The disposable clone is a git checkout at tag `v0.42.0`, whose `VERSION` file is `0.42.0`.
- `bin/coop` is this checkout's forwarder, overlaid onto that clone.

- **Version.** Run `coop version`. Exit 0. Stdout contains `coop 0.42.0 (v0.42.0)`. Stdout contains `pi   (not installed)` when `pi` is not on `PATH`, otherwise a `pi` line.
- **Help.** Run `coop help`. Exit 0. Stdout contains `coop doctor`, `coop update`, `coop install`, `coop version`, and `coop desktop`.
- **Proof.** `version.out` and `help.out` in the evidence directory are those streams. The clone's `HEAD` is still `v0.42.0`.

## Gotchas

- `VERSION` at a tag and at every commit after that tag can read the same. The parenthetical `git describe` is what tells a checkout at the tag from a checkout past it. The harness asserts both.
- Help is the command list, not a launch. A word `coop` does not know can open Pi. Do not send an unknown word as the version check.

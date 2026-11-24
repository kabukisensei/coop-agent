# Update a release

`coop update` moves this checkout to the newest release tag and then converges tools. `coop update --check` fetches `origin` and prints that move without changing the checkout. A tag is a release only when its name is `vX.Y.Z` and `VERSION` at that commit is `X.Y.Z`.

## Sub-features

- `update-check-next` from `v0.42.0` reports `v0.42.1` and leaves `HEAD` there.
- `update-check-mismatch` from the stray `v1.0.19` commit also reports `v0.42.1`.
- `update-skip-missing` ignores `v2.0.0`, which has no `VERSION` file.
- `install-checkout` runs the step 2 line in `docs/install-windows.md` and lands on `v0.42.1`.

## How to get to it (user POV)

- Run `coop update --check` to see the move. Nothing is installed.
- Run `coop update` to fast-forward to that tag and converge tools. It never moves backwards.
- On a new Windows clone, `docs/install-windows.md` step 2 checks out the same tag the update would choose.

## Driving it with scripts/verify.sh

Preconditions:

- The local origin's `main` contains, in order: tag `v0.42.0` with `VERSION` `0.42.0`, tag `v1.0.19` with `VERSION` `0.42.0`, tag `v0.42.1` with `VERSION` `0.42.1`, and tag `v2.0.0` with no `VERSION` file.
- `origin` is that local bare repo. The clone tracks `origin/main`.
- `VERSION` at `v1.0.19` is the mismatch from merged PR #579. A tag counts only when `VERSION`, with whitespace removed, equals the tag number, and the tag is merged into `origin/main`.

- **From the older release.** Reset to `v0.42.0`. Run `coop update --check`. Exit 0. The output contains `would move to release v0.42.1` and does not contain `would move to release v1.0.19` or `would move to release v2.0.0`. `git rev-parse HEAD` is unchanged.
- **From the mismatched tag.** Reset to `v1.0.19`. Run `coop update --check` again. The same sentence names `v0.42.1`. `HEAD` is still the `v1.0.19` commit.
- **Install checkout.** On a second clone of the same origin, reset to `v0.42.0`, then run the `git checkout` line from `docs/install-windows.md` that filters `git tag --merged origin/main`. `HEAD` is the `v0.42.1` commit.
- **Proof.** `update-from-0420.out`, `update-from-1019.out`, `tags.txt`, `version-v1.0.19.txt` (`0.42.0`), `version-v0.42.1.txt` (`0.42.1`), and `install-checkout-head.txt`.

## Gotchas

- `--check` fetches. The proof that it changed nothing is `HEAD` before and after, not the flag's name.
- `coop update` without `--check` installs Pi and the tools. This harness does not run it. Do not point a real update at this checkout.
- Sorting tags by version number alone selects `v2.0.0` or `v1.0.19`. The `VERSION` comparison is the rule under test. Do not delete those tags to make the run pass.

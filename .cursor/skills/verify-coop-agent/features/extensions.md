# Extensions

coop loads its companion extensions by passing each directory to Pi as `-e`. `coop launch-spec --json` prints that argument list and the brand environment. It does not start Pi.

## Sub-features

- `ext-powerline` loads `extensions/coop-powerline`.
- `ext-tools` loads `extensions/coop-tools`.
- `ext-guardrails` loads `extensions/coop-guardrails`.
- `ext-profile` loads `extensions/coop-profile`.
- `ext-pi1` loads `extensions/coop-codemode` and `extensions/coop-router` when the installed Pi is 1.x or newer.

## How to get to it (user POV)

- Run `coop` to launch Pi with those extensions. That opens a session.
- Run `coop launch-spec` to print the `pi` command. `coop launch-spec --json` prints `{"bin","args","env"}`.
- `coop dev list` asks an installed Pi which extensions it has loaded. It needs Pi.

## Driving it with scripts/verify.sh

Preconditions:

- The overlay clone contains this checkout's `extensions/` tree.
- Pi may be absent. The four companions above are still listed. Codemode and the router are listed only when `pi --version` is 1.x or newer.

- **Spec.** Run `coop launch-spec --json`. Exit 0. Stdout is one JSON object whose `bin` is `pi`.
- **Proof.** For each extension this machine's Pi implies, `args` contains `-e` and a path ending in `extensions/<name>`, and `<name>/index.ts` exists. `env.COOP_VIBES_DIR` and `env.COOP_SPLASH_FILE` exist on disk. The evidence file is `launch-spec.out`.

## Gotchas

- Launch-spec is the load list, not a running session. Do not treat it as a pass of `coop desktop` or of a Pi conversation.
- A work repo's `.pi/settings.json` cannot add these flags back. The harness reads the spec coop builds, not a settings file.
- `pi` on `PATH` changes the expected set. The summary names the Pi version or `pi not installed`.

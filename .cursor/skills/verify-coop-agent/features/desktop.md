# Desktop

`coop desktop` opens coop in a window on a folder. The first run installs the Electron runtime. The window uses the same Pi launch spec as the terminal.

## Sub-features

- `desktop-open` opens the window on a folder (default: the current directory).
- `desktop-spec` prints the launch spec and starts nothing (`coop desktop --print-spec`).
- `desktop-app` opens an already installed window executable (`coop desktop --app <exe>`).

## How to get to it (user POV)

- Run `coop desktop` or `coop desktop <folder>`.
- The **coop** shortcut on the Start Menu and Desktop opens the window once the runtime is installed. **coop (terminal)** stays the terminal.
- `Install coop.cmd` does not open the window. `coop desktop` does.

## Driving it with scripts/verify.sh

Preconditions:

- A display, and permission to install Electron into the temp profile (`~/.coop/desktop`, about 400 MB).
- This offline harness has neither. It does not download Electron and it does not start a window.

- **Not run.** The full run prints `desktop: not-run (coop desktop installs Electron and opens a window; this run has no display)`. That line is not a pass.
- **Reach it when the precondition is true.** Run `coop desktop --print-spec` in the temp profile and record the JSON. Then run `coop desktop <folder>` and record that a window opened on that folder. The installer acceptance scripts `desktop/scripts/verify-launch.mjs`, `desktop/scripts/verify-installer.mjs`, and `desktop/scripts/verify-upgrade.mjs` are the Windows package checks. This harness does not invoke them.

## Gotchas

- `coop launch-spec` is the terminal's Pi argument list. It does not open the window. Do not record it as a desktop pass.
- The first `coop desktop` runs `coop install` when the profile has no extension tree. That install downloads tools. Do not point it at the real `HOME`.
- CI's installer job on Windows is the build that installs, doctors, and uninstalls the window package. A Linux `RESULT: PASS` does not include that job.

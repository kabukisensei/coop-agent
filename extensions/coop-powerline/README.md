# coop-powerline

Cooptimize's OWN footer, splash, and rotating feature discovery tips for Pi. coop-powerline
renders its own bar via `ctx.ui.setFooter` and its own splash via
`ctx.ui.setHeader` — it does **not** use a third-party powerline footer.
(`pi-powerline-footer` was removed: its welcome overlay couldn't be disabled,
its Nerd Font glyphs showed up as `?`, and it duplicated the bar.) Everything it
touches is feature-detected and wrapped in `try/catch`, so it can never crash Pi.

It is loaded the way any Pi extension is, via `pi -e`:

```sh
pi -e extensions/coop-powerline
```

`bin/coop.ps1` does this for you when you launch the branded agent (`coop`), and
also exports the two env vars below.

## What it adds

### Footer (`ctx.ui.setFooter`)

coop-powerline renders its own footer in plain text + common Unicode (no
Nerd Font glyphs):

- **left** — `⬢ Cooptimize v0.38.5 · <session> · <branch>` (the honeycomb in
  navy, `Cooptimize` in lime, the running coop version dimmed (`COOP_VERSION`
  from `bin/coop.ps1`, else the `VERSION` file; ` dev` marks a git checkout),
  the session name when one is set by `/name` or the automatic naming
  extension, the current git branch dimmed);
- **right** — `<model> · ctx N% · tokens · $cost · <plan usage limits>`: the
  active model id, the context-window usage percent, token totals
  (`input>output`), and the running cost — all read from the session, so it
  works for any provider.

It also surfaces **other extensions' status text** via
`footerData.getExtensionStatuses()` — for example pi-better-openai's plan usage
limits / 5h+7d windows — appending them to the right side, so everything ends up
in one clean bar instead of a duplicate one. When everything fits it is one
line; in a narrower window the left side keeps the first line and the right side
wraps onto right-aligned lines below it (between fields, never mid-number), so
the usage data is never cut off. It re-renders on branch changes,
session renames and between turns so the numbers stay current.

### Startup splash (`ctx.ui.setHeader`)

On `session_start` (UI sessions only) it installs a header via
`ctx.ui.setHeader`. The header renders:

- the truecolor block-art Cooptimize logo from `assets/splash.ansi`, padded by a
  single uniform left margin so the concentric arcs stay aligned (width-robust:
  it falls back to the wordmark alone when the terminal is too narrow for the
  block art),
- the `COOPTIMIZE` wordmark in a navy → forest → olive → lime gradient,
- the taglines `worker-owned analytics engineering` and
  `Microsoft Fabric · Power BI · D365 · SQL · DAX`,
- a fresh working vibe or feature tip.

### Working vibes & feature tips

While the agent is thinking, `ctx.ui.setWorkingMessage` shows a rotating
feature discovery tip teaching a tool, command, or workflow (e.g. *"Type /start anytime
to open the Start Here menu of common tasks."*), alongside a small set of quiet easter eggs.
A new tip is picked on `session_start` and again on every `turn_start`, so the line stays fresh.

Vibes are loaded from the **vibes directory** (see `COOP_VIBES_DIR`): each
`*.txt` file is a "set", one tip per line; blank lines and `#` comments are
ignored. If no vibe files are found, a small built-in fallback set of client-safe tips is used.
A line may contain `{user}`; when shown it becomes the COOP profile name
(`~/.coop/user.json`, the file `coop-profile` reads), else the OS login name, else
`Dave`. Keep the placeholder to easter-egg lines so tips stay literal.

### Honeycomb working indicator

Via `ctx.ui.setWorkingIndicator`, the spinner is replaced with a honeycomb
(`⬢`) cycling through the Cooptimize palette — navy, forest, olive, lime, red —
at 140 ms per frame.

### Terminal tab title

Via `ctx.ui.setTitle`, the tab reads `coop - <folder>` or
`coop - <session> - <folder>` instead of Pi's `π` title. Pi restores its own
title after binding the extensions (startup and every `/new`) and after its
Windows package check, and a child console process a tool runs (`npm config get
cache`) leaves its own title behind when it exits, so the extension reasserts
the title on a short schedule after `session_start`, at every turn and tool
boundary, and on a 15-second heartbeat while a terminal is attached (the window
owns its own title). Terminal tab icons are owned by the terminal profile; the
Coop Windows shortcuts use `themes/coop.ico`, while an already-open PowerShell
profile keeps its configured icon.

### Slash-command safety

Pi's editor applies the autocomplete list's selected item when Enter is pressed
on `/word` and submits it, so a mistyped or unknown command ran the list's
closest fuzzy match (`/exit` once ran an MCP prompt). The extension wraps Pi's
autocomplete provider: the list shows only while `word` is the start of a
command name (those first, the fuzzy rest after them), so Enter never applies a
fuzzy pick; an unknown `/word` shows no list, is held in the editor with a
notice instead of going to the model, and goes through as text when sent again.
The command names are Pi's own (built-ins, prompt templates, extension commands,
skills). In the coop window Pi's RPC mode has no autocomplete provider, so the
hook stays passive there.

## Commands

- **`/coop-vibe [set|all]`** — pick a vibe set, or show a fresh vibe.
  - `/coop-vibe` shows a new vibe from the current set.
  - `/coop-vibe <name>` switches to the set `<name>.txt` (warns if unknown).
  - `/coop-vibe all` draws from every set, including `coop-internal` (the default rotation).
- **`/coop-splash`** — re-show the splash header (handy after the screen
  scrolls or clears).
- **`/exit`** — quit coop, the same as Pi's `/quit` (people type it).

## Environment variables

All are set by `bin/coop.ps1`; set them yourself if you load the extension directly.

| Variable | Purpose | Default |
| --- | --- | --- |
| `COOP_VERSION` | The running coop version shown in the footer. | the `VERSION` file at the repo root |
| `COOP_VIBES_DIR` | Directory of `*.txt` vibe sets. | `<repo>/vibes` |
| `COOP_SPLASH_FILE` | Path to the splash ANSI art. | `assets/splash.ansi` (next to `index.ts`) |

## Brand palette

Sampled from the logo: navy `#00416B`, forest `#42783C`, olive `#82AA43`,
lime `#B2D235`, red `#EF412D`.

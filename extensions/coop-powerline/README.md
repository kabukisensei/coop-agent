# coop-powerline

Cooptimize's OWN footer, splash, and working vibes for Pi. coop-powerline
renders its own bar via `ctx.ui.setFooter` and its own splash via
`ctx.ui.setHeader` — it does **not** use a third-party powerline footer.
(`pi-powerline-footer` was removed: its welcome overlay couldn't be disabled,
its Nerd Font glyphs showed up as `?`, and it duplicated the bar.) Everything it
touches is feature-detected and wrapped in `try/catch`, so it can never crash Pi.

It is loaded the way any Pi extension is, via `pi -e`:

```sh
pi -e extensions/coop-powerline
```

`bin/coop` does this for you when you launch the branded agent (`coop`), and
also exports the two env vars below.

## What it adds

### Footer (`ctx.ui.setFooter`)

coop-powerline renders its own single footer in plain text + common Unicode (no
Nerd Font glyphs):

- **left** — `⬢ Cooptimize · <branch>` (the honeycomb in navy, `Cooptimize` in
  lime, the current git branch dimmed);
- **right** — `<model> · ctx N% · tokens · $cost · <plan usage limits>`: the
  active model id, the context-window usage percent, token totals
  (`input>output`), and the running cost — all read from the session, so it
  works for any provider.

It also surfaces **other extensions' status text** via
`footerData.getExtensionStatuses()` — for example pi-better-openai's plan usage
limits / 5h+7d windows — appending them to the right side, so everything ends up
in one clean bar instead of a duplicate one. The whole line is clipped to the
terminal width so it never overflows, and it re-renders on branch changes and
between turns so the numbers stay current.

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
- a fresh working vibe.

### Working vibes

While the agent is thinking, `ctx.ui.setWorkingMessage` shows a rotating
"working vibe" — sociocracy / democratic-workplace lines riffing on the
D365 + Microsoft Fabric analytics stack (e.g. *"Forming a consent round on the
bronze layer…"*). A new vibe is picked on `session_start` and again on every
`turn_start`, so the line stays fresh.

Vibes are loaded from the **vibes directory** (see `COOP_VIBES_DIR`): each
`*.txt` file is a "set", one vibe per line; blank lines and `#` comments are
ignored. If no vibe files are found, a small built-in fallback set is used.

### Honeycomb working indicator

Via `ctx.ui.setWorkingIndicator`, the spinner is replaced with a honeycomb
(`⬢`) cycling through the Cooptimize palette — navy, forest, olive, lime, red —
at 140 ms per frame.

## Commands

- **`/coop-vibe [set|all]`** — pick a vibe set, or show a fresh vibe.
  - `/coop-vibe` shows a new vibe from the current set.
  - `/coop-vibe <name>` switches to the set `<name>.txt` (warns if unknown).
  - `/coop-vibe all` draws from every set.
- **`/coop-splash`** — re-show the splash header (handy after the screen
  scrolls or clears).

## Environment variables

Both are set by `bin/coop`; set them yourself if you load the extension directly.

| Variable | Purpose | Default |
| --- | --- | --- |
| `COOP_VIBES_DIR` | Directory of `*.txt` vibe sets. | `<repo>/vibes` |
| `COOP_SPLASH_FILE` | Path to the splash ANSI art. | `assets/splash.ansi` (next to `index.ts`) |

## Brand palette

Sampled from the logo: navy `#00416B`, forest `#42783C`, olive `#82AA43`,
lime `#B2D235`, red `#EF412D`.

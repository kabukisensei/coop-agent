# coop-powerline

Cooptimize branding for Pi. A small **companion** extension — not a fork of
`pi-powerline-footer`. It feature-detects everything it touches and wraps each
hook in `try/catch`, so it can never crash Pi.

It is loaded the way any Pi extension is, via `pi -e`:

```sh
pi -e extensions/coop-powerline
```

`bin/coop` does this for you when you launch the branded agent (`coop`), and
also exports the two env vars below.

## What it adds

### Startup splash (header)

On `session_start` (UI sessions only) it installs a header via
`ctx.ui.setHeader`. The header renders, centered to the terminal width:

- the color logo from `assets/splash.ansi` (an ANSI-art render of the
  Cooptimize mark),
- the `COOPTIMIZE` wordmark in a navy → forest → olive → lime gradient,
- the taglines `worker-owned analytics engineering` and
  `Microsoft Fabric · Power BI · D365 · SQL · DAX · semantic models`,
- a fresh working vibe.

### Footer segment (status)

It registers a branded status entry with `ctx.ui.setStatus("coop", …)` —
a navy honeycomb plus `Cooptimize` in lime. This is surfaced by
`pi-powerline-footer` as a footer segment; coop-powerline only contributes the
entry, it does not render the footer itself.

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

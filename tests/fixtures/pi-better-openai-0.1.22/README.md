# Pinned upstream usage fixture

`usage.ts` is the unmodified usage module from the npm package
`pi-better-openai@0.1.22`, maintained at
https://github.com/mattleong/pi-better-openai . Its MIT license is retained here.

The regression test reproduces the upstream fixed-window label error before
applying Coop's exact-source correction. This fixture is not shipped as the
production replacement; `lib/openai-usage-compat.mjs` transforms the installed
pinned source and rejects unexpected upstream changes.

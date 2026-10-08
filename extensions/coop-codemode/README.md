# coop-codemode

Pi's own codemode, configured for coop. Loaded only on Pi 1.x (`bin/coop.ps1`).

- Script calls to outside models (`models.classify`, `models.generateImages`) are
  off: they use the session's sign-ins and pass no tool hook, so the guardrails
  could not see them.
- The mode is fixed to `on`: the usual tools stay declared, and a work repo's
  `codemode.mode` setting cannot hide them behind scripts.

Registering the `codemode` tool replaces Pi's built-in codemode. Every call a
script makes runs through Pi's tool pipeline, so `coop-guardrails` checks it
like a direct call, and it blocks any codemode that is not this one. See
`docs/guardrails-reference.md`, "Codemode scripts".

## Files

- `index.ts` — extension entry point.
- `package.json` — extension manifest.

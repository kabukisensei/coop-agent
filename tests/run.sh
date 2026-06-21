#!/usr/bin/env bash
#
# coop test suite — bundle the TypeScript extensions (exactly as Pi loads them) to a
# temp dir, then run the Node logic tests against them. Run locally with `bash
# tests/run.sh`; CI runs the same. No network beyond the one-time esbuild fetch.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

bundle() {
  local ext="$1"; shift
  npx -y esbuild "$ROOT/extensions/$ext/index.ts" \
    --bundle --format=esm --platform=node --packages=external "$@" --outfile="$TMP/$ext.mjs" >/dev/null 2>&1
}

echo "→ bundling extensions for test…"
# coop-tools imports `typebox` (Pi provides it at runtime) — stub it for the test build.
bundle coop-tools --alias:typebox="$ROOT/tests/typebox-stub.mjs"
bundle coop-guardrails

echo "→ data-doc config tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/datadoc.test.mjs"
echo "→ coop-guardrails enforcement tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/guardrails.test.mjs"

echo "✓ all tests passed"

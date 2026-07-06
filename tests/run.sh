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
echo "→ start-here menu tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/startmenu.test.mjs"

echo "→ launch-spec (shared launch builder) test"
SPEC="$(bash "$ROOT/bin/coop" launch-spec)"
for needle in "docs/guardrails.md" "--prompt-template" "themes/cooptimize.json" \
              "extensions/coop-powerline" "extensions/coop-tools" "extensions/coop-guardrails"; do
  case "$SPEC" in
    *"$needle"*) ;;
    *) echo "  ✗ launch-spec missing: $needle"; exit 1 ;;
  esac
done
echo "  ✓ launch-spec resolves guardrails, prompts, theme, and all 3 extensions"

echo "→ coop web bridge tests (stub pi — auth, CSRF, SSE replay, forwarding)"
node "$ROOT/tests/webbridge.test.mjs"

echo "→ protocol contract + JSONL splitter tests"
node "$ROOT/tests/protocol.test.mjs"

echo "→ diff model (unified + side-by-side parsing) tests"
node "$ROOT/tests/diffmodel.test.mjs"

echo "✓ all tests passed"

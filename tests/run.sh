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

echo "→ --no-launch dry-run (must NOT start pi; prints the spec)"
# --no-launch is a dry-run: it runs the preflights (no-op without pi) and prints the
# resolved launch spec, then exits 0 — the opposite of its old behavior (it launched).
NL_RC=0
NL_OUT="$(bash "$ROOT/bin/coop" --no-launch)" || NL_RC=$?
[ "$NL_RC" -eq 0 ] || { echo "  ✗ coop --no-launch exited $NL_RC (expected 0)"; exit 1; }
case "$NL_OUT" in
  *"docs/guardrails.md"*) ;;
  *) echo "  ✗ coop --no-launch did not print the launch spec (no docs/guardrails.md)"; exit 1 ;;
esac
# --json delegates to the launch-spec JSON path.
case "$(bash "$ROOT/bin/coop" --no-launch --json)" in
  *'"bin"'*'"args"'*) ;;
  *) echo "  ✗ coop --no-launch --json did not emit the JSON spec"; exit 1 ;;
esac
echo "  ✓ --no-launch prints the spec and exits 0 (no pi launched)"

echo "→ coop update tested-Pi-version guard (--check, gate decision)"
bash "$ROOT/tests/update-guard.test.sh"

echo "→ coop web bridge tests (stub pi — auth, CSRF, SSE replay, forwarding)"
node "$ROOT/tests/webbridge.test.mjs"

echo "→ protocol contract + JSONL splitter tests"
node "$ROOT/tests/protocol.test.mjs"

echo "→ diff model (unified + side-by-side parsing) tests"
node "$ROOT/tests/diffmodel.test.mjs"

echo "✓ all tests passed"

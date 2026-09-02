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
bundle coop-profile
bundle coop-powerline

echo "→ data-doc config tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/datadoc.test.mjs"
echo "→ coop-guardrails enforcement tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/guardrails.test.mjs"
echo "→ start-here menu tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/startmenu.test.mjs"
echo "→ in-Coop project contract wizard tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/project-wizard.test.mjs"
echo "→ contract-driven daily log default tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/daily-log-default.test.mjs"

echo "→ setup-docs JSONL bridge (renderPrompt / askCheckbox) tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/setupbridge.test.mjs"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/setupbridge-integration.test.mjs"
echo "→ live JSONL happy-path vs the installed coop-data-doc"
COOP_TEST_DATADOC_REQUIRED="${COOP_TEST_DATADOC_REQUIRED:-0}" COOP_TEST_DIST="$TMP" node "$ROOT/tests/jsonl-live.test.mjs"

echo "→ workflow slice tests"
node "$ROOT/tests/workflow.test.mjs"

echo "→ coop-profile tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/coop-profile.test.mjs"

echo "→ isolated Pi settings tests"
python3 "$ROOT/tests/pi-settings.test.py"

echo "→ Coop terminal-title branding tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/powerline.test.mjs"

echo "→ vibes & feature-discovery tips contract tests"
node "$ROOT/tests/vibes.test.mjs"

echo "→ launch-spec (shared launch builder) test"
SPEC="$(bash "$ROOT/bin/coop" launch-spec)"
for needle in "docs/guardrails.md" "--prompt-template" "themes/cooptimize.json" \
              "extensions/coop-powerline" "extensions/coop-tools" "extensions/coop-guardrails" "extensions/coop-profile"; do
  case "$SPEC" in
    *"$needle"*) ;;
    *) echo "  ✗ launch-spec missing: $needle"; exit 1 ;;
  esac
done
echo "  ✓ launch-spec resolves guardrails, prompts, theme, and all 4 extensions"

echo "→ --no-launch dry-run (must NOT start pi; prints the spec)"
# --no-launch is a dry-run: it runs the preflights (no-op without pi) and prints the
# resolved launch spec, then exits 0 — the opposite of its old behavior (it launched).
# Keep its repair-capable preflight away from the developer's real ~/.coop tree.
LAUNCH_AGENT="$TMP/launch-agent"; LAUNCH_COOP="$TMP/launch-coop"
mkdir -p "$LAUNCH_AGENT" "$LAUNCH_COOP"
NL_RC=0
NL_OUT="$(COOP_AGENT_DIR="$LAUNCH_AGENT" PI_CODING_AGENT_DIR="$LAUNCH_AGENT" COOP_DIR="$LAUNCH_COOP" COOP_NO_ONBOARD=1 bash "$ROOT/bin/coop" --no-launch)" || NL_RC=$?
[ "$NL_RC" -eq 0 ] || { echo "  ✗ coop --no-launch exited $NL_RC (expected 0)"; exit 1; }
case "$NL_OUT" in
  *"docs/guardrails.md"*) ;;
  *) echo "  ✗ coop --no-launch did not print the launch spec (no docs/guardrails.md)"; exit 1 ;;
esac
# --json delegates to the launch-spec JSON path.
JSON_SPEC="$(COOP_AGENT_DIR="$LAUNCH_AGENT" PI_CODING_AGENT_DIR="$LAUNCH_AGENT" COOP_DIR="$LAUNCH_COOP" COOP_NO_ONBOARD=1 bash "$ROOT/bin/coop" --no-launch --json)"
case "$JSON_SPEC" in
  *'"bin"'*'"args"'*) ;;
  *) echo "  ✗ coop --no-launch --json did not emit the JSON spec"; exit 1 ;;
esac
JSON_SPEC="$JSON_SPEC" node -e 'const s=JSON.parse(process.env.JSON_SPEC); if(s.env.PI_SKIP_VERSION_CHECK!=="1") process.exit(1)'
echo "  ✓ --no-launch prints the spec and exits 0 (no pi launched)"

echo "→ coop update tested-Pi-version guard (--check, gate decision)"
bash "$ROOT/tests/update-guard.test.sh"
bash "$ROOT/tests/fleet-manifest.test.sh"
echo "→ release transaction tests"
bash "$ROOT/tests/release.test.sh"
bash "$ROOT/tests/fleet-execution.test.sh"
bash "$ROOT/tests/install-python-prereq.test.sh"
echo "→ fabric-compatible Python discovery (side-by-side, off-PATH)"
bash "$ROOT/tests/fixtures/fabric-python-finder.test.sh"
bash "$ROOT/tests/mcp-config.test.sh"
bash "$ROOT/tests/onboard.test.sh"
echo "→ truthful inventory (doctor pipx probes / sync postconditions)"
bash "$ROOT/tests/inventory.test.sh"
echo "→ first-run continuation through plain coop (pty-driven)"
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*) echo "  – Python pty/termios is unavailable on native Windows; covered by macOS PTY + Windows launcher tests" ;;
  *) bash "$ROOT/tests/first-run.test.sh" ;;
esac
echo "→ home-guard (fleet paths must not mutate the real home)"
bash "$ROOT/tests/home-guard.test.sh"
bash "$ROOT/tests/context-budget.test.sh"
bash "$ROOT/scripts/check-context-budget.sh"

echo "→ repo staleness nudge (throttled fetch + behind-count) tests"
bash "$ROOT/tests/staleness.test.sh"

echo "→ az-preflight cache (.az-ok TTL + tenant stamp) tests"
bash "$ROOT/tests/azcache.test.sh"

echo "→ coop init wizard tests"
bash "$ROOT/tests/init-wizard.test.sh"
"$(command -v python3 2>/dev/null || command -v python)" "$ROOT/tests/init-wizard-windows-paths.test.py"

echo "→ coop init --seed-docs (contract → coop-data-doc.yml) tests"
bash "$ROOT/tests/seeddocs.test.sh"

echo "→ coop init --ci (CI pipeline scaffolding) tests"
bash "$ROOT/tests/ciscaffold.test.sh"

echo "→ coop review (composite linters + docs compose) tests"
bash "$ROOT/tests/review.test.sh"

echo "→ doctor project contract validation tests"
bash "$ROOT/tests/doctor-project.test.sh"

echo "→ doctor MCP mode reporting tests"
bash "$ROOT/tests/doctor.test.sh"

echo "→ coop web bridge tests (stub pi — auth, CSRF, SSE replay, forwarding)"
node "$ROOT/tests/webbridge.test.mjs"

echo "→ BPA runner resolution tests (te bpa run; TE2 must never be invoked)"
bash "$ROOT/tests/bpa-runner.test.sh"

echo "→ protocol contract + JSONL splitter tests"
node "$ROOT/tests/protocol.test.mjs"

echo "→ diff model (unified + side-by-side parsing) tests"
node "$ROOT/tests/diffmodel.test.mjs"

echo "✓ all tests passed"

#!/usr/bin/env bash
#
# Deterministic reproducer for the shared-temporary-root contamination tracked as
# r8-test-hygiene (and the r4 AC6 sandbox blocker).
#
# Mechanism: the wizard resolves a fixture's project root by walking UP the
# filesystem (findProjectYml / findGitRoot). Sandbox session scaffolding seeds a
# foreign, read-only `.git` at the TMPDIR root; a repository-free discovery
# fixture then misresolves its project root to the tmp root and writes
# `.coop/project.yml` there — poisoning every later fixture. This script seeds
# exactly that marker into a synthetic, disposable TMPDIR and runs the wizard
# tests against a bundled coop-tools, exactly as tests/run.sh builds it.
#
#   Pre-r8  : the discovery test FAILS (ENOENT) and the tmp root is contaminated.
#   Post-r8 : the walk-up-dependent wizard tests SKIP explicitly (foreign marker
#             named), all other assertions run, tmp root stays clean, exit 0.
#
# Usage: bash tests/repro-tmp-contamination.sh [repo-dir]   (default: repo root)
# The script deletes only directories it created under its own mktemp work dir.
set -uo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
TMPROOT="$WORK/tmp-root"
DIST="$WORK/dist"
mkdir -p "$TMPROOT" "$DIST"

# Foreign sandbox scaffolding: read-only .git at the tmp root.
mkdir "$TMPROOT/.git"
chmod 0555 "$TMPROOT/.git" 2>/dev/null || true

echo "→ bundling coop-tools (same invocation as tests/run.sh)"
npx -y esbuild "$ROOT/extensions/coop-tools/index.ts" \
  --bundle --format=esm --platform=node --packages=external \
  --alias:typebox="$ROOT/tests/typebox-stub.mjs" \
  --outfile="$DIST/coop-tools.mjs" >/dev/null 2>&1 || {
  echo "bundle failed (is esbuild available?)"; exit 2; }

echo "→ running tests/project-wizard.test.mjs with contaminated TMPDIR=$TMPROOT"
env TMPDIR="$TMPROOT" COOP_TEST_DIST="$DIST" node "$ROOT/tests/project-wizard.test.mjs"
RC=$?

echo "→ contamination check"
if [ -e "$TMPROOT/.coop/project.yml" ]; then
  echo "CONTAMINATION: contract written into shared tmp root: $TMPROOT/.coop/project.yml"
else
  echo "ok: no project configuration written into the shared tmp root"
fi
echo "repro suite rc=$RC"
exit "$RC"

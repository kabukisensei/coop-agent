#!/usr/bin/env bash
#
# coop test suite — bundle the TypeScript extensions (exactly as Pi loads them) to a
# temp dir, then run the Node logic tests against them. No network beyond the
# one-time esbuild fetch.
#
# Two lanes (#96; rules in docs/ci.md, "coop-agent's own CI (maintainers)"):
#   gate lane      `bash tests/run.sh` (the default; every PR runs it). Deterministic
#                  logic only: no sleep, poll, PTY, marker file, hang/timeout fixture
#                  or network, and no fixture touches this checkout. Every gate test
#                  runs with a temp home (see "Gate-lane home" below).
#   extended lane  `COOP_TEST_EXTENDED=1 bash tests/run.sh` runs the gate lane AND the
#                  extended block at the end of this file (timing, process, PTY and
#                  host-dependent fixtures). Nightly CI, Actions -> extended -> Run
#                  workflow, and `coop release` run it.
# A few gate files also carry extended-only cases guarded by COOP_TEST_EXTENDED
# inside the file (azcache, knowledge-git, warehouse-mcp, onboard,
# standards-live-sync, and tests/fixtures/azcache.test.ps1, which tests/run.ps1
# runs). They are invoked once, in the gate section.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
export COOP_ROOT="$ROOT"
# Launches sign in to Azure automatically (H2). No test may reach a runner's or a
# developer's real Azure CLI; the sign-in fixtures opt back in with a fake az.
export COOP_SKIP_AZ=1
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Lane selection. Only COOP_TEST_EXTENDED=1 selects the extended lane; normalize the
# variable so every child test sees the same lane this runner does.
if [ "${COOP_TEST_EXTENDED:-0}" = "1" ]; then
  export COOP_TEST_EXTENDED=1
  LANE="gate + extended lanes"
  echo "→ lanes: gate + extended (COOP_TEST_EXTENDED=1). Gate lane only: bash tests/run.sh"
else
  unset COOP_TEST_EXTENDED
  LANE="gate lane"
  echo "→ lane: gate (default). Add the extended lane with: COOP_TEST_EXTENDED=1 bash tests/run.sh"
fi

# coop is PowerShell (master plan S1): the forwarder smoke, the Fabric SQL
# launcher and every test that drives bin/coop.ps1 or lib/common.ps1 need pwsh.
if ! command -v pwsh >/dev/null 2>&1; then
  echo "✗ pwsh (PowerShell 7) is required to run the suite: install it, or put it on PATH" >&2
  exit 1
fi
# A pwsh that is on PATH but cannot start (Homebrew's formula without its .NET
# runtime) would otherwise fail dozens of tests one by one with the same message.
if ! PWSH_PROBE="$(pwsh -NoLogo -NoProfile -Command 'exit 0' 2>&1)"; then
  echo "✗ pwsh is on PATH but does not start, so the suite cannot run. Its error:" >&2
  printf '%s\n' "$PWSH_PROBE" | head -n 3 >&2
  echo "  Fix pwsh first (on macOS: brew reinstall dotnet powershell, or brew install --cask powershell), then re-run." >&2
  exit 1
fi

bundle() {
  local ext="$1"; shift
  npx -y esbuild "$ROOT/extensions/$ext/index.ts" \
    --bundle --format=esm --platform=node --packages=external "$@" --outfile="$TMP/$ext.mjs" >/dev/null 2>&1
}

# ============================================================================
# GATE LANE (always runs)
# ============================================================================

echo "→ bundling extensions for test…"
# coop-tools imports `typebox` (Pi provides it at runtime) — stub it for the test build.
bundle coop-tools --alias:typebox="$ROOT/tests/typebox-stub.mjs"
bundle coop-guardrails
bundle coop-profile
bundle coop-powerline

# Gate-lane home (#96 fixture rules). Every gate test below gets a fresh temp home:
# HOME and USERPROFILE point at it (native Windows node and python find the home
# through USERPROFILE, so it gets the Windows spelling under Git Bash), and the
# Coop, Pi and standards location overrides are unset so they resolve inside it,
# as they do on a CI runner. It starts after the bundling above so npx keeps its
# real cache. The extended block at the end restores the caller's values.
CALLER_HOME_ENV="$TMP/caller-home-env.sh"
: > "$CALLER_HOME_ENV"
for var in HOME USERPROFILE COOP_DIR COOP_AGENT_DIR PI_CODING_AGENT_DIR \
           COOP_STANDARDS_ROOT COOP_STANDARDS_STATE COOP_STANDARDS_SNAPSHOT_ROOT; do
  declare -p "$var" >> "$CALLER_HOME_ENV" 2>/dev/null || echo "unset $var" >> "$CALLER_HOME_ENV"
done
# Real-home and checkout guard (#135). Record the caller's ~/.coop and ~/.azure
# and this checkout's HEAD, refs and FETCH_HEAD before any test runs; the end of
# this file fails the run if a test changed them. Pi session transcripts and az's
# own logs and caches are left out: a coop session or `az` running at the same
# time writes them, and no test may.
GUARD_PY="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
GUARD_HOME="$HOME"
guard_snapshot() { # <out-file>
  local home="$GUARD_HOME" root="$ROOT"
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) home="$(cygpath -m "$home")"; root="$(cygpath -m "$root")" ;;
  esac
  {
    "$GUARD_PY" - "$home" "$root" <<'PY'
import os, sys
home, root = sys.argv[1], sys.argv[2]
skip = {os.path.join(".coop", "agent", "sessions"),
        os.path.join(".azure", "commands"), os.path.join(".azure", "logs"),
        os.path.join(".azure", "telemetry")}
skip_names = ("az.sess", "versionCheck.json", "msal_token_cache", "msal_http_cache")
for top in (".coop", ".azure"):
    for d, dirs, files in os.walk(os.path.join(home, top)):
        rel = os.path.relpath(d, home)
        dirs[:] = sorted(x for x in dirs if os.path.join(rel, x) not in skip)
        for name in sorted(files):
            if name.startswith(skip_names):
                continue
            path = os.path.join(d, name)
            try:
                st = os.lstat(path)
            except OSError:
                continue
            print("home", os.path.relpath(path, home).replace(os.sep, "/"), st.st_size, st.st_mtime_ns)
        for name in dirs:
            print("home", os.path.relpath(os.path.join(d, name), home).replace(os.sep, "/") + "/")
fetch_head = os.path.join(root, ".git", "FETCH_HEAD")
if os.path.isfile(fetch_head):
    print("checkout FETCH_HEAD", os.stat(fetch_head).st_mtime_ns)
PY
    if [ -e "$ROOT/.git" ] && command -v git >/dev/null 2>&1; then
      printf 'checkout HEAD %s\n' "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)"
      git -C "$ROOT" for-each-ref --format='checkout ref %(refname) %(objectname)' 2>/dev/null
    fi
  } > "$1"
}
guard_snapshot "$TMP/guard.before"

GATE_HOME="$TMP/home"
mkdir -p "$GATE_HOME"
HOME="$GATE_HOME"; USERPROFILE="$GATE_HOME"
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*)
    USERPROFILE="$(cygpath -w "$GATE_HOME")"
    # Windows PowerShell expands its known folders from USERPROFILE; Receive-Job
    # fails when AppData\Local is missing.
    mkdir -p "$GATE_HOME/AppData/Local/Microsoft/Windows/PowerShell" "$GATE_HOME/AppData/Roaming" ;;
esac
export HOME USERPROFILE
unset COOP_DIR COOP_AGENT_DIR PI_CODING_AGENT_DIR \
      COOP_STANDARDS_ROOT COOP_STANDARDS_STATE COOP_STANDARDS_SNAPSHOT_ROOT

echo "→ Revision 9 standards registry/resolver and automatic application tests"
node "$ROOT/tests/standards-rev9.test.mjs"
node "$ROOT/tests/standards-live-sync.test.mjs"
node "$ROOT/tests/standards-golden.test.mjs"
node "$ROOT/tests/standards-bundle.test.mjs"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/standards-runtime.test.mjs"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/bpa-review.test.mjs"

echo "→ data-doc config reader and contract review-scope tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/review-scope.test.mjs"
echo "→ coop-guardrails enforcement tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/guardrails.test.mjs"
echo "→ start-here menu tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/startmenu.test.mjs"
echo "→ in-Coop project contract wizard tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/project-wizard.test.mjs"
echo "→ contract-driven daily log default tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/daily-log-default.test.mjs"
echo "→ team knowledge recall note tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/team-knowledge-recall.test.mjs"
echo "→ contract-driven Fabric target note tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/fabric-target-note.test.mjs"
echo "→ committed catalog snapshot note and status (SQ9)"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/catalog-snapshot-note.test.mjs"
echo "→ share-learning prompt and friction nudge tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/share-learning.test.mjs"
echo "→ learning-nudge runtime (registered handler) tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/learning-nudge-runtime.test.mjs"

echo "→ setup-docs JSONL bridge (renderPrompt / askCheckbox) tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/setupbridge.test.mjs"
echo "→ data_doc lineage branch and session lineage note tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/lineage.test.mjs"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/setupbridge-integration.test.mjs"

echo "→ workflow slice tests"
node "$ROOT/tests/workflow.test.mjs"
echo "→ sql-formatting skill tests"
node "$ROOT/tests/sql-formatting.test.mjs"

echo "→ compaction over the configured transport (#236) tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/compaction-transport.test.mjs"

echo "→ coop-profile tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/coop-profile.test.mjs"

echo "→ isolated Pi settings tests"
python3 "$ROOT/tests/pi-settings.test.py"

echo "→ Coop terminal-title branding tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/powerline.test.mjs"

echo "→ vibes & feature-discovery tips contract tests"
node "$ROOT/tests/vibes.test.mjs"

echo "→ Git Bash forwarder: bin/coop forwards to coop.ps1 (launch-spec) and release.sh"
# bin/coop carries no logic (master plan S1): it execs pwsh/powershell on
# bin/coop.ps1. Driving launch-spec through it proves the forwarder and the
# shared launch builder together; tests/run.ps1 covers coop.ps1 directly.
# coop.ps1 prints Windows paths under Git Bash; compare with one separator.
SPEC="$(bash "$ROOT/bin/coop" launch-spec | tr '\\' '/')"
for needle in "docs/guardrails.md" "--prompt-template" "themes/cooptimize.json" \
              "extensions/coop-powerline" "extensions/coop-tools" "extensions/coop-guardrails" "extensions/coop-profile"; do
  case "$SPEC" in
    *"$needle"*) ;;
    *) echo "  ✗ launch-spec missing: $needle"; exit 1 ;;
  esac
done
echo "  ✓ launch-spec resolves guardrails, prompts, theme, and all 4 extensions (through the forwarder)"
REL_OUT="$(bash "$ROOT/bin/coop" release --help 2>&1)" || { echo "  ✗ bin/coop release --help failed: $REL_OUT"; exit 1; }
case "$REL_OUT" in
  *"coop release"*) echo "  ✓ bin/coop release forwards to scripts/release.sh" ;;
  *) echo "  ✗ bin/coop release did not reach scripts/release.sh: $REL_OUT"; exit 1 ;;
esac
FWD_TMP="$TMP/fwd-missing"; mkdir -p "$FWD_TMP/bin" "$FWD_TMP/scripts"; cp "$ROOT/bin/coop" "$FWD_TMP/bin/coop"
FWD_RC=0; FWD_OUT="$(bash "$FWD_TMP/bin/coop" version 2>&1)" || FWD_RC=$?
if [ "$FWD_RC" -ne 0 ] && case "$FWD_OUT" in *"coop.ps1 is missing"*) true ;; *) false ;; esac; then
  echo "  ✓ the forwarder fails clearly when bin/coop.ps1 is missing"
else
  echo "  ✗ forwarder with a missing coop.ps1: rc=$FWD_RC out=$FWD_OUT"; exit 1
fi

echo "→ bin/coop forwards --no-launch to coop.ps1 (one smoke; tests/run.ps1 owns the spec)"
# The forwarder is only a Git Bash shim: one dry-run through it proves the hand-off
# to bin/coop.ps1. What the spec contains (--json, PI_SKIP_VERSION_CHECK,
# PI_MCP_CONFIG_MODE=exclusive) is tests/run.ps1 section 2. Keep the
# repair-capable preflight away from the developer's real ~/.coop tree.
LAUNCH_AGENT="$TMP/launch-agent"; LAUNCH_COOP="$TMP/launch-coop"
mkdir -p "$LAUNCH_AGENT" "$LAUNCH_COOP"
NL_RC=0
NL_OUT="$(COOP_AGENT_DIR="$LAUNCH_AGENT" PI_CODING_AGENT_DIR="$LAUNCH_AGENT" COOP_DIR="$LAUNCH_COOP" COOP_NO_ONBOARD=1 bash "$ROOT/bin/coop" --no-launch | tr '\\' '/')" || NL_RC=$?
[ "$NL_RC" -eq 0 ] || { echo "  ✗ coop --no-launch exited $NL_RC (expected 0)"; exit 1; }
case "$NL_OUT" in
  *"docs/guardrails.md"*) echo "  ✓ the forwarder reaches coop.ps1 --no-launch (spec printed, exit 0)" ;;
  *) echo "  ✗ coop --no-launch did not print the launch spec (no docs/guardrails.md)"; exit 1 ;;
esac

echo "→ fleet health digest rendering (HTML/Markdown escaping, UTF-8 output)"
bash "$ROOT/tests/fleet-digest.test.sh"
echo "→ pipx launcher PATH resolution (install.ps1)"
bash "$ROOT/tests/install-pipx-path.test.sh"
echo "→ entrypoints guard a missing helper library / forwarder target"
bash "$ROOT/tests/missing-common-guard.test.sh"
echo "→ user paths install and recommend only the release's pinned versions (#151)"
bash "$ROOT/tests/pins.test.sh"
echo "→ extension tree pins the agent peer to the agent's version (#122)"
bash "$ROOT/tests/extdeps-agent-pin.test.sh"
echo "→ extension lockfile pins the tree's transitive dependencies (#152)"
bash "$ROOT/tests/extensions-lock.test.sh"
bash "$ROOT/tests/mcp-config.test.sh"
python3 "$ROOT/tests/warehouse-mcp.test.py"
python3 "$ROOT/tests/sql-query.test.py"
python3 "$ROOT/tests/sql-impact.test.py"
echo "→ committed dev catalog snapshot (SQ9: one file per object, manifest, staleness, never production)"
python3 "$ROOT/tests/catalog-snapshot.test.py"
echo "→ sql_targets contract section (SQ1: kinds, host patterns, production never default)"
python3 "$ROOT/tests/sql-targets.test.py"
python3 "$ROOT/tests/microsoft-skills.test.py"
echo "→ one profile root: COOP_DIR is the parent of .coop; one agent-dir chain (S3, #220)"
python3 "$ROOT/tests/coop-paths.test.py"
python3 "$ROOT/tests/p0-vertical-slice.test.py"
bash "$ROOT/tests/onboard.test.sh"
echo "→ Azure CLI resolution and sign-in helpers (onboarding, coop init)"
"$(command -v python3 2>/dev/null || command -v python)" "$ROOT/tests/azure-auth.test.py"
echo "→ team knowledge config block + readers tests"
bash "$ROOT/tests/knowledge-config.test.sh"
echo "→ TeamAI isolated adapter (K1: states, isolation, provenance, bounds)"
python3 "$ROOT/tests/teamai-adapter.test.py"
echo "→ knowledge-git ownership lifecycle unit tests"
python3 "$ROOT/tests/knowledge-git.test.py"
echo "→ team knowledge local recall helper tests"
bash "$ROOT/tests/search-knowledge.test.sh"
echo "→ ResumeThread previous-suspend-count contract (Defect A)"
COOP_KG_PATH="$ROOT/scripts/knowledge-git.py" python3 - <<'PY'
import importlib.util
import os
spec = importlib.util.spec_from_file_location("kg", os.environ["COOP_KG_PATH"])
kg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kg)
cases = [
    (0xFFFFFFFF, False, "failure_sentinel"),
    (1, True, None),
    (0, False, "already_running"),
    (2, False, "still_suspended:2"),
]
for prev, ok, detail in cases:
    got_ok, got_code = kg._win_resume_verdict(prev)
    assert got_ok is ok, (prev, got_ok, ok)
    got_detail = got_code[1] if got_code else None
    assert got_detail == detail, (prev, got_detail, detail)
print("  OK  resume verdict: failure sentinel / expected prev=1 / already-running / still-suspended")
PY

echo "→ coop init wizard tests"
bash "$ROOT/tests/init-wizard.test.sh"
"$(command -v python3 2>/dev/null || command -v python)" "$ROOT/tests/init-wizard-windows-paths.test.py"
echo "→ bounded legacy project diagnostics and migration tests"
"$(command -v python3 2>/dev/null || command -v python)" "$ROOT/tests/project-health.test.py"

echo "→ coop init --seed-docs (contract → coop-data-doc.yml) tests"
bash "$ROOT/tests/seeddocs.test.sh"

echo "→ coop init --ci (CI pipeline scaffolding) tests"
bash "$ROOT/tests/ciscaffold.test.sh"

echo "→ BPA runner resolution tests (te bpa run; TE2 must never be invoked)"
bash "$ROOT/tests/bpa-runner.test.sh"

echo "→ Azure DevOps tooling tests (offline; az must never run)"
bash "$ROOT/tests/ado.test.sh"

echo "→ support command and Support Center contract tests"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/support-command.test.mjs"
node "$ROOT/tests/support-center.test.mjs"
echo "→ one profile root in Node (lib/paths.mjs and the bundled extensions)"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/paths.test.mjs"
echo "→ coop window (D1b): its modules, the recorded Pi RPC session, terminal parity"
node "$ROOT/tests/desktop.test.mjs"
node "$ROOT/desktop/scripts/runtime-lock.mjs" check
echo "→ coop window side pane (D1b2): changes, standards, project form, docs setup"
COOP_TEST_DIST="$TMP" node "$ROOT/tests/desktop-panes.test.mjs"
echo "→ coop window attachments (D1b2): Office and PDF text, the splash and the vibes"
node "$ROOT/tests/desktop-attachments.test.mjs"
echo "→ coop window package (D1c): the package bootstrap, electron-builder config, stage and installer acceptance"
node "$ROOT/tests/desktop-installer.test.mjs"

# ============================================================================
# EXTENDED LANE (only with COOP_TEST_EXTENDED=1)
# Timing, process, PTY, network-adjacent and host-dependent fixtures: fixed sleeps,
# polls and watchdogs, hang children, marker files, real processes and the Windows
# native probe. Nightly CI, `Actions -> extended -> Run workflow` and `coop release`
# run this block. A new timing fixture goes here, and its PR says why.
# ============================================================================
if [ "${COOP_TEST_EXTENDED:-0}" = "1" ]; then
  echo "→ extended lane"
  # The extended fixtures keep the gate lane's temp home (#135);
  # tests/fixtures/home-guard.test.ps1 (run by tests/run.ps1) is the one that
  # checks the real home on purpose.

  echo "→ standards lock (simple lock; waitFor polls and a fixed sleep)"
  node "$ROOT/tests/standards-lock-simple.test.mjs"

  echo "→ final model-login handoff tests"
  COOP_TEST_DIST="$TMP" node "$ROOT/tests/model-login.test.mjs"

  echo "→ live JSONL happy-path vs the installed coop-data-doc"
  COOP_TEST_DATADOC_REQUIRED="${COOP_TEST_DATADOC_REQUIRED:-0}" COOP_TEST_DIST="$TMP" node "$ROOT/tests/jsonl-live.test.mjs"

  echo "→ live data_doc + /setup-docs acceptance vs the installed coop-data-doc (non-ASCII mixed estate)"
  COOP_TEST_DATADOC_REQUIRED="${COOP_TEST_DATADOC_REQUIRED:-0}" COOP_TEST_DIST="$TMP" node "$ROOT/tests/datadoc-live.test.mjs"


  echo "→ Fabric request headers and SQL launcher (MCP launch phases: tests/fixtures/fabric-mcp-launch.test.ps1 in run.ps1)"
  node "$ROOT/tests/fabric-request-headers.test.mjs"
  COOP_TEST_DIST="$TMP" node "$ROOT/tests/fabric-sql-launcher.test.mjs"

  echo "→ coop window: Pi as a real process (dialogs, hang, crash, leftover children)"
  node "$ROOT/tests/desktop-rpc.test.mjs"

  echo "→ windows owned-kill native evidence probe (Defect A diagnostics)"
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) pwsh -NoProfile -File "$ROOT/tests/fixtures/win-ownership-probe.ps1" ;;
    *) echo "  – Windows-only probe; skipped on POSIX (covered by the Windows CI legs)" ;;
  esac



  # The whole file (#133): tests that need pwsh skip themselves without it.
  # tests/run.ps1 keeps its reparse subset, so Windows does not run the file
  # twice per lane.
  # "native Windows lifecycle faults" needs the candidate and baseline checkouts
  # that only the Windows terminal-workstation acceptance workflow creates; that
  # workflow runs it (its "lifecycle" selection). Every other test runs here.
  echo "→ terminal-workstation acceptance harness tests (all but the workflow-only lifecycle test)"
  # These tests validate evidence against the committed JSON schema, and python
  # jsonschema is mandatory for them (#133); say so once instead of a traceback per test.
  # CI names its interpreter in CERT_PYTHON and the test checks that one itself.
  if [ -z "${CERT_PYTHON:-}" ]; then
    TW_PY=python3; command -v python3 >/dev/null 2>&1 || TW_PY=python
    if ! "$TW_PY" -c 'import jsonschema' >/dev/null 2>&1; then
      echo "✗ the extended lane needs the Python jsonschema module ($TW_PY has none): $TW_PY -m pip install --user jsonschema==4.25.1 (CI's pin), or point CERT_PYTHON at a Python that has it, then re-run" >&2
      exit 1
    fi
  fi
  node --test --test-skip-pattern "native Windows lifecycle faults" "$ROOT/tests/terminal-workstation-acceptance.test.mjs"
fi

# The real home and this checkout are as they were before the run (#135).
guard_snapshot "$TMP/guard.after"
if ! cmp -s "$TMP/guard.before" "$TMP/guard.after"; then
  echo "✗ a test changed the real home (~/.coop, ~/.azure) or this checkout's refs:"
  diff "$TMP/guard.before" "$TMP/guard.after" | sed -n '1,40p'
  echo "  (a coop session or az command running at the same time can also cause this; rerun with them closed)"
  exit 1
fi
echo "  ✓ the real ~/.coop, ~/.azure and this checkout's refs are unchanged"

echo "✓ all tests passed ($LANE)"

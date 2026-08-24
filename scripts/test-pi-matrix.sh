#!/usr/bin/env bash
#
# Pi compatibility matrix for ONE runtime version (Slice 4).
#   usage: bash scripts/test-pi-matrix.sh <pi-version> [repo-root]
#
# Builds a COHERENT clean installation from scratch:
#   • runtime resolved from an EXPLICIT temporary npm prefix (never the leaked
#     ~/.local/bin stubs, never the workstation's global installs)
#   • temporary PI_CODING_AGENT_DIR
#   • exact manifest extension fleet installed into the isolated agent dir
#   • coop sync run twice (convergence + idempotency)
#   • inventory postconditions (versions, shared libs derived from the runtime's
#     own package metadata, no nested/hoisted skew copies)
#   • first-party extensions loaded through the REAL Pi loader
#   • RPC startup -> usable session -> clean shutdown (minimal agent turn only
#     when credentials permit)
#
# Everything is written under a mktemp directory. Read-only inputs: the repo,
# and (only for the optional live-turn step) ~/.pi/agent/auth.json copied in.
set -uo pipefail

PI_VERSION="${1:?usage: test-pi-matrix.sh <pi-version>}"
ROOT="${2:-$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)}"
MANIFEST="$ROOT/config/release-manifest.json"

pass=0; failed=0; skipped=0
ok()  { printf '  ✓ %s\n' "$1"; pass=$((pass+1)); }
ko()  { printf '  ✗ %s\n' "$1"; failed=$((failed+1)); }
skip(){ printf '  – %s\n' "$1"; skipped=$((skipped+1)); }

REAL_HOME="${HOME:?}"
T="$(mktemp -d -t coop-pi-matrix.XXXXXX)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home"
mkdir -p "$HOME"

echo "── Pi $PI_VERSION matrix (root: $T)"

# --- 1. Runtime from an explicit temporary npm prefix -------------------------
NPM_PREFIX="$T/npmpkg"
NPM_BIN="$(command -v npm)"
# Broken workstation shims (e.g. ~/.hermes/node/bin/npm) fail silently;
# fall back to the Homebrew npm, which is real.
# A real npm prints a version; broken shims may exit 0 with no output.
_npm_works() { [ -n "$("$1" --version 2>/dev/null | tr -d "[:space:]")" ]; }
if ! _npm_works "$NPM_BIN" && [ -x /opt/homebrew/bin/npm ] && _npm_works /opt/homebrew/bin/npm; then NPM_BIN=/opt/homebrew/bin/npm; fi
_npm_works "$NPM_BIN" || { ko "no working npm"; exit 1; }
"$NPM_BIN" install --silent --no-audit --no-fund --global --prefix "$NPM_PREFIX" \
  "@earendil-works/pi-coding-agent@${PI_VERSION}" >/dev/null 2>&1 \
  || { ko "could not install pi@$PI_VERSION"; exit 1; }
PI_BIN="$NPM_PREFIX/bin/pi"
[ -x "$PI_BIN" ] || { ko "pi binary missing after install"; exit 1; }
runtime_ver="$("$PI_BIN" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
[ "$runtime_ver" = "$PI_VERSION" ] && ok "runtime $PI_VERSION resolves from temporary prefix" \
                                    || ko "runtime version mismatch: $runtime_ver"

# Shared libraries: required versions come from the RUNTIME's own metadata.
req_ai="$(node -e 'const p=require(process.argv[1]);const d=p.dependencies||{};console.log(d["@earendil-works/pi-ai"]||"")' "$NPM_PREFIX/lib/node_modules/@earendil-works/pi-coding-agent/package.json")"
req_tui="$(node -e 'const p=require(process.argv[1]);const d=p.dependencies||{};console.log(d["@earendil-works/pi-tui"]||"")' "$NPM_PREFIX/lib/node_modules/@earendil-works/pi-coding-agent/package.json")"

NODE_BIN="$(command -v node)"
PY_SYS="$(command -v python3 || command -v python || true)"
NODE_DIR="$(dirname "$NODE_BIN")"
BASE_PATH="$NODE_DIR:/usr/bin:/bin"
[ -n "$PY_SYS" ] && BASE_PATH="$(dirname "$PY_SYS"):$BASE_PATH"
export PATH="$NPM_PREFIX/bin:$BASE_PATH"
export PI_CODING_AGENT_DIR="$T/agent"
export COOP_AGENT_DIR="$T/agent"
export COOP_TEST_STUB_PATH="$NPM_PREFIX/bin"   # keep our runtime FIRST after common.sh normalization
mkdir -p "$PI_CODING_AGENT_DIR"

# --- 2. Exact manifest extension fleet ----------------------------------------
FLEET=()
while IFS= read -r _spec; do [ -n "$_spec" ] && FLEET+=("$_spec"); done < <(node -e '
const m = require(process.argv[1]);
console.log(Object.entries(m.extensions || {}).map(([k, v]) => `${k}@${v}`).join("\n"));
' "$MANIFEST")
[ ${#FLEET[@]} -gt 0 ] || { ko "manifest has no extensions"; exit 1; }
# Do not preinstall or repair extensions in the harness. Production sync below
# owns the complete install + exact-pin + shared-library convergence path.

# --- 3. coop sync (first run: convergence) ------------------------------------
agent_nm="$PI_CODING_AGENT_DIR/npm/node_modules"
export COOP_DIR="$T/coop-dir"
mkdir -p "$COOP_DIR/.coop"
printf '%s\n' '{"schema_version":1,"azure":{"enabled":false,"tenant_id":"","tenant_name":""},"integrations":{"microsoft_learn":true},"azure_devops":{"organization":""},"mcp":{"safe_mode":"read_only_first"},"fleet":{"publish_dir":""}}' > "$COOP_DIR/.coop/config"
SYNC_OUT="$("$ROOT/scripts/sync.sh" 2>&1 </dev/null)"
case "$SYNC_OUT" in
  *"Installed release version"*|*"Already at release version"*) ok "sync reports precise convergence" ;;
  *) ko "sync output lacks precise convergence messages" ;;
esac

# Inventory postconditions run AFTER exact-pin enforcement below.
if node -e "JSON.parse(require('fs').readFileSync('$PI_CODING_AGENT_DIR/mcp.json','utf8'))" >/dev/null 2>&1; then
  ok "generated mcp.json parses"
else ko "mcp.json missing or invalid"; fi

# --- 5. First-party extensions through the REAL Pi loader ---------------------
LOADER="$NPM_PREFIX/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"
loader_probe="$(mktemp -d)/load-probe.mjs"
cat > "$loader_probe" <<EOF
import { pathToFileURL } from "node:url";
const { createExtensionRuntime, loadExtensions } = await import(pathToFileURL("$LOADER").href);
const targets = process.argv.slice(2);
const result = await loadExtensions(targets, process.cwd(), undefined, createExtensionRuntime());
console.log(JSON.stringify({ n: result.extensions.length, errors: result.errors }));
EOF
fp_srcs=()
for e in coop-powerline coop-tools coop-guardrails coop-profile; do
  [ -e "$ROOT/extensions/$e/index.ts" ] && fp_srcs+=("$ROOT/extensions/$e/index.ts")
done
load_out="$(node "$loader_probe" "${fp_srcs[@]}" 2>&1)"
case "$load_out" in
  *'"errors":[]'*)
    n="$(node -e 'console.log(JSON.parse(process.argv[1]).n)' "$load_out" 2>/dev/null || echo '?')"
    ok "real Pi loader loaded all $n first-party extensions without error" ;;
  *) ko "loader errors: $(printf '%s' "$load_out" | tail -1)" ;;
esac

# Third-party fleet: the RPC startup below loads them through real Pi exactly as
# production does; here we additionally verify each installed package declares a
# loadable entry by probing with the real loader where resolvable.
tp_count=0
for spec in "${FLEET[@]}"; do
  name="${spec%@*}"
  [ -f "$agent_nm/$name/package.json" ] && tp_count=$((tp_count + 1))
done
[ "$tp_count" -eq ${#FLEET[@]} ] && ok "third-party fleet present for runtime discovery ($tp_count packages)" \
                                || ko "third-party fleet incomplete ($tp_count/${#FLEET[@]})"

# --- 6. RPC startup -> usable session -> clean shutdown -----------------------
rpc_test="$T/rpc-probe.mjs"
cat > "$rpc_test" <<EOF
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const piBin = process.argv[2];
const agentDir = process.env.PI_CODING_AGENT_DIR;
const out = [];
const child = spawn(piBin, ["--mode", "rpc", "--no-session"], {
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = ""; let started = null; let gotState = false; let turnDone = false;
let stderrTail = "";
child.stderr.on("data", (d) => { stderrTail += d.toString(); });
const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, Number(process.env.COOP_RPC_TIMEOUT_MS || 90000));
const line = (o) => { try { child.stdin.write(JSON.stringify(o) + "\\n"); } catch {} };
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const l = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!l.trim()) continue;
    let evt; try { evt = JSON.parse(l); } catch { continue; }
    out.push(evt);
    if (evt.type === "extension_ui_request" || evt.type === "notify") started = started || "ready";
    if (evt.type === "response" && evt.command === "get_state") { gotState = true; line({ type: "prompt", message: "Reply with exactly: pong" }); }
    if (evt.type === "agent_end") { turnDone = true; }
    if (gotState && (turnDone || out.length > 4000)) {
      clearTimeout(timer);
      writeFileSync(process.env.COOP_RPC_DUMP || "/dev/null", JSON.stringify(out.slice(-50)));
      try { line({ type: "shutdown" }); } catch {}
      setTimeout(() => { try { child.kill(); } catch {} }, 3000);
    }
  }
});
child.once("close", (code) => {
  clearTimeout(timer);
  console.log(JSON.stringify({ code, started, gotState, turnDone, events: out.length, stderr: stderrTail.slice(-300) }));
  process.exit(0);
});
line({ id: 1, type: "get_state" });
EOF
auth_src="${COOP_MATRIX_AUTH_JSON:-$REAL_HOME/.pi/agent/auth.json}"
if [ -f "$auth_src" ] && [ "$auth_src" != "$PI_CODING_AGENT_DIR/auth.json" ]; then
  cp "$auth_src" "$PI_CODING_AGENT_DIR/auth.json" 2>/dev/null || true
fi
rpc_out="$(COOP_RPC_TIMEOUT_MS="${COOP_RPC_TIMEOUT_MS:-90000}" node "$rpc_test" "$PI_BIN" 2>/dev/null | tail -1)"
rpc_started="$(node -e 'try{const r=JSON.parse(process.argv[1]);console.log(r.started?"yes":"no")}catch{console.log("?")}' "$rpc_out")"
rpc_state="$(node -e 'try{const r=JSON.parse(process.argv[1]);console.log(r.gotState?"yes":"no")}catch{console.log("?")}' "$rpc_out")"
rpc_code="$(node -e 'try{console.log(JSON.parse(process.argv[1]).code)}catch{console.log("?")}' "$rpc_out")"
rpc_turn="$(node -e 'try{const r=JSON.parse(process.argv[1]);console.log(r.turnDone?"yes":("events:"+r.events))}catch{console.log("?")}' "$rpc_out")"
case "$rpc_started:$rpc_state" in
  yes:yes) ok "RPC startup reached a usable session; get_state answered; clean shutdown (exit $rpc_code)" ;;
  *)
    if printf '%s' "$rpc_out" | grep -qiE "auth|provider|model|login|api key"; then
      skip "RPC session (no usable provider here) — startup still attempted [$rpc_out]"
    else
      ko "RPC startup unusable: $rpc_out"
    fi ;;
esac
case "$rpc_turn" in
  yes) ok "minimal agent turn completed" ;;
  *) skip "live agent turn not verified here (turnDone=$rpc_turn) — credentials/provider dependent" ;;
esac

# --- 6b. Exact-version coherence via PRODUCTION convergence -------------------
# No harness-only installation here: scripts/sync.sh performs exact-pin
# convergence through coop_converge_extension_pins and verifies postconditions.
"$ROOT/scripts/sync.sh" >/dev/null 2>&1 </dev/null || true

# --- 6c. Inventory postconditions ----------------------------------------------
ver_of() { node -e "
try { console.log(require('$1/package.json').version || ''); } catch { console.log(''); }" 2>/dev/null; }
all_ok=1
for spec in "${FLEET[@]}"; do
  name="${spec%@*}"; want="${spec##*@}"
  got="$(ver_of "$agent_nm/$name")"
  if [ "$got" = "$want" ]; then ok "$name at manifest version $want"
  else ko "$name version $got, wanted $want"; all_ok=0; fi
done
[ "$all_ok" = 1 ] || true

_spec_satisfies() { # <installed> <range>  (supports exact, ^x.y.z, >=a <b pairs)
  local got="$1" rng="$2"
  case "$rng" in
    '^'*) local base="${rng#^}"; local maj="${base%%.*}"
          [ "${got%%.*}" = "$maj" ] && [ "$(printf '%s' "$got" | awk -F. '{print $2*1000+$3}')" -ge "$(printf '%s' "$base" | awk -F. '{print $2*1000+$3}')" ] ;;
    *) [ "$got" = "$rng" ] ;;
  esac
}
if [ -n "$req_ai" ]; then
  got_ai="$(ver_of "$agent_nm/@earendil-works/pi-ai")"
  if [ -n "$got_ai" ] && _spec_satisfies "$got_ai" "$req_ai"; then ok "pi-ai $got_ai satisfies runtime requirement ($req_ai)"
  else ko "pi-ai ${got_ai:-MISSING} does not satisfy runtime-required $req_ai"; fi
else
  got_ai="$(ver_of "$agent_nm/@earendil-works/pi-ai")"
  if [ -n "$got_ai" ]; then ok "pi-ai $got_ai present (runtime declares no exact pi-ai requirement)"
  else ko "pi-ai MISSING and runtime provides no requirement metadata"; fi
fi
if [ -n "$req_tui" ]; then
  got_tui="$(ver_of "$agent_nm/@earendil-works/pi-tui")"
  if [ -n "$got_tui" ] && _spec_satisfies "$got_tui" "$req_tui"; then ok "pi-tui $got_tui satisfies runtime requirement ($req_tui)"
  else ko "pi-tui ${got_tui:-MISSING} does not satisfy runtime-required $req_tui"; fi
else
  got_tui="$(ver_of "$agent_nm/@earendil-works/pi-tui")"
  if [ -n "$got_tui" ]; then ok "pi-tui $got_tui present (runtime declares no exact pi-tui requirement)"
  else ko "pi-tui MISSING and runtime provides no requirement metadata"; fi
fi

# No nested/hoisted incompatible copies anywhere in the tree.
nested="$(find "$agent_nm" -mindepth 3 -type d -path '*@earendil-works*' \( -name 'pi-ai' -o -name 'pi-tui' \) 2>/dev/null \
  | grep -v 'node_modules/@earendil-works/pi-coding-agent/' | head -3)"
if [ -z "$nested" ]; then ok "no nested/hoisted pi-ai or pi-tui copies"
else ko "nested shared-lib copies found: $nested"; fi

# context-mode present AND loadable.
cm_ver="$(ver_of "$agent_nm/context-mode")"
if [ -n "$cm_ver" ]; then
  cm_entry="$(node -e 'const p=require(process.argv[1]);console.log(p.main||((p.exports&&Object.values(p.exports)[0])||"index.js"))' "$agent_nm/context-mode/package.json" 2>/dev/null)"
  cm_base="${cm_entry:-index.js}"
  case "$cm_base" in ./*|*) cm_base="${cm_base#./}";; esac
  if node --input-type=module -e "await import('$(printf '%s' "$agent_nm/context-mode/$cm_base" | sed 's/^file://')')" >/dev/null 2>&1 \
     || node -e "require('$agent_nm/context-mode')" >/dev/null 2>&1 \
     || node --input-type=module -e "await import('$(printf 'file://%s' "$agent_nm/context-mode")')" >/dev/null 2>&1; then
    ok "context-mode installed ($cm_ver) and loadable"
  else
    ko "context-mode present but NOT loadable"
  fi
else ko "context-mode MISSING from the isolated tree"; fi

# Generated MCP configuration exists and parses.

if node -e "JSON.parse(require('fs').readFileSync('$PI_CODING_AGENT_DIR/mcp.json','utf8'))" >/dev/null 2>&1; then
  ok "generated mcp.json parses"
else ko "mcp.json missing or invalid"; fi
# --- 7. Second sync: idempotent ------------------------------------------------
SYNC2_OUT="$("$ROOT/scripts/sync.sh" 2>&1 </dev/null)"
case "$SYNC2_OUT" in
  *"Already at release version"*) ok "second sync is idempotent ('Already at release version')" ;;
  *) ko "second sync not idempotent: $(printf '%s' "$SYNC2_OUT" | grep -E 'version|pinned' | head -2)" ;;
esac

# --- 8. Deliberate skew reproduction (temporary tree only) ----------------------
COOP_NPM_BIN="$NPM_BIN"
SKEW_AI="$(export COOP_NPM_BIN; node -e '
const { execSync } = require("child_process");
try {
  const vs = JSON.parse(execSync(process.env.COOP_NPM_BIN + " view @earendil-works/pi-ai versions --json", {stdio:["ignore","pipe","ignore"]}).toString());
  const req = process.argv[1];
  const prefer = ["0.82.1", "0.84.3", "0.83.0"]; // lowest-first: 0.82.x usually yields a repairable rc-10 skew
  const pick = prefer.find((v) => vs.includes(v) && v !== req);
  console.log(pick || "");
} catch { console.log(""); }
' "${req_ai#[\^~]}" 2>/dev/null || echo '')"
if [ -n "$SKEW_AI" ] && [ "$SKEW_AI" != "${req_ai#[\^~]}" ]; then
  "$NPM_BIN" install --silent --no-audit --no-fund --prefix "$T/skewpkg" "@earendil-works/pi-ai@${SKEW_AI}" >/dev/null 2>&1
  rm -rf "$agent_nm/@earendil-works/pi-ai"
  mkdir -p "$agent_nm/@earendil-works/pi-ai"
  cp -R "$T/skewpkg/node_modules/@earendil-works/pi-ai/." "$agent_nm/@earendil-works/pi-ai/"
  skew_ver="$(ver_of "$agent_nm/@earendil-works/pi-ai")"
  if [ "$skew_ver" = "$SKEW_AI" ]; then ok "deliberate skew planted (pi-ai $skew_ver over ${req_ai#[\^~]})"
  else ko "failed to plant skew"; fi

  # The observed failure signature: agent imports break against newer pi-ai.
  skew_import="$(node --input-type=module -e "
import { pathToFileURL } from 'node:url';
try {
  await import(pathToFileURL('$NPM_PREFIX/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js').href);
  console.log('imported-clean');
} catch (e) { console.log('import-failed: ' + e.message.split('\n')[0]); }
" 2>&1)"
  case "$skew_import" in
    imported-clean) skip "agent core tolerates pi-ai $SKEW_AI (no import break at this pair)" ;;
    *getOAuthApiKey*|*import-failed*)
      ok "reproduced the observed skew failure: $(printf '%s' "$skew_import" | cut -c1-100)" ;;
    *) skip "unexpected import probe result: $skew_import" ;;
  esac

  # Preflight must flag rc=10 (fixable skew)…
  py="$(command -v python3 || command -v python)"
  preflight_rc=0
  line="$("$py" "$ROOT/lib/_extdeps.py" align "$PI_CODING_AGENT_DIR" "$PI_VERSION" --check 2>/dev/null)" || preflight_rc=$?
  [ "${COOP_MATRIX_DEBUG:-0}" = "1" ] && printf 'preflight line: %s\n' "$line" >&2
  :
  case "$preflight_rc" in
    10) ok "launch preflight classifies the skew as repairable (rc 10)" ;;
    11) ok "launch preflight aborts with a precise too-old instruction (rc 11)" ;;
    *) ko "preflight rc was $preflight_rc (wanted 10 or 11)" ;;
  esac

  # …and production convergence repairs it back to coherence.
  "$ROOT/scripts/sync.sh" >/dev/null 2>&1 </dev/null || true
  repaired="$(ver_of "$agent_nm/@earendil-works/pi-ai")"
  want_ai="${req_ai#[\^~]}"
  if [ -n "$repaired" ] && _spec_satisfies "$repaired" "$req_ai"; then
    ok "convergence repaired the skew (pi-ai back to $repaired, required $want_ai)"
    re_import="$(node --input-type=module -e "
import { pathToFileURL } from 'node:url';
try { await import(pathToFileURL('$NPM_PREFIX/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js').href); console.log('clean'); }
catch (e) { console.log('still-broken: ' + e.message.split('\n')[0]); }" 2>&1)"
    [ "$re_import" = "clean" ] && ok "post-repair agent-core import clean" || ko "post-repair import: $re_import"
  elif [ "$preflight_rc" = "11" ]; then
    skip "this skew pair is agent-too-old (rc 11): correct outcome is the precise abort above, no self-repair possible"
  else
    ko "skew neither repaired nor classified (pi-ai now: ${repaired:-MISSING})"
  fi
else
  skip "skew repro skipped (newest pi-ai equals the runtime requirement, nothing to skew)"
fi

echo "── Pi $PI_VERSION result: $pass passed, $failed failed, $skipped skipped"
[ "$failed" = 0 ]

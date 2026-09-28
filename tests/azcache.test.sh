#!/usr/bin/env bash
#
# Azure sign-in preflight (lib/common.sh coop_az_preflight, master plan H2) against
# the shared fake az (tests/fixtures/fake-az.mjs): the tenant chain, the Fabric then
# Power BI token check, the ~30-min tenant-stamped .az-ok cache, the automatic
# bounded sign-in, and the one-line failures. The PowerShell twin runs the same
# cases in tests/fixtures/azcache.test.ps1. Offline: no sleeps, no PTY, and the
# real Azure CLI, HOME and ~/.coop are never touched.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf '  ✗ %s\n' "$1"; exit 1; }
pass() { printf '  ✓ %s\n' "$1"; }

NODE="$(command -v node)" || fail "node is required for the fake az"
mkdir -p "$TMP/bin" "$TMP/home" "$TMP/coop/.coop" "$TMP/proj/.coop" "$TMP/nocontract"
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE" "$ROOT/tests/fixtures/fake-az.mjs" > "$TMP/bin/az"
chmod +x "$TMP/bin/az"

export COOP_ROOT="$ROOT"
export HOME="$TMP/home" COOP_DIR="$TMP/coop" USERPROFILE="$TMP/home"
export COOP_AGENT_DIR="$TMP/agent"
export COOP_TEST_AZ_STATE="$TMP/az"
# common.sh normalizes PATH (Homebrew, /usr/local); the stub path is re-prepended
# after that, so the fake always wins over a real az.
export COOP_TEST_STUB_PATH="$TMP/bin"
PATH="$TMP/bin:$PATH"
unset PI_CODING_AGENT_DIR COOP_NO_ISOLATE COOP_SKIP_AZ COOP_ASSUME_YES 2>/dev/null || true
NO_COLOR=1; export NO_COLOR
# shellcheck source=../lib/common.sh
. "$ROOT/lib/common.sh"
[ "$(command -v az)" = "$TMP/bin/az" ] || fail "fixture must resolve the fake az (got $(command -v az))"

T1=11111111-1111-4111-8111-111111111111
T2=22222222-2222-4222-8222-222222222222
FABRIC=https://api.fabric.microsoft.com
PBI=https://analysis.windows.net/powerbi/api
MARKER="$TMP/agent/.az-ok"

az_reset() {  # az_reset [token lines...]: fresh fake-az state
  rm -rf "$TMP/az"; mkdir -p "$TMP/az"; : > "$TMP/az/argv.log"
  local line
  for line in "$@"; do printf '%s\n' "$line" >> "$TMP/az/tokens"; done
}
count()  { local n; n="$(grep -c "$1" "$TMP/az/argv.log" 2>/dev/null)" || true; printf '%s' "${n:-0}"; }
calls()  { count .; }
probes() { count '^account get-access-token '; }
logins() { count '^login '; }
project() { printf 'fabric:\n  tenant_id: %s\n' "$1" > "$TMP/proj/.coop/project.yml"; }
config()  { printf '\357\273\277%s' "$1" > "$TMP/coop/.coop/config"; }   # with a BOM, like Windows editors
warn_lines() { printf '%s\n' "$1" | grep -c '^! ' || true; }
probe_line() { printf 'account get-access-token --tenant %s --resource %s --output none' "$1" "$2"; }

cd "$TMP/proj"

# 1. Signed in: Fabric then Power BI, no sign-in, no output, marker holds the tenant.
project "$T1"; az_reset "$T1 *"
out="$(coop_az_preflight 2>&1 </dev/null)"
[ "$(probes)" = "2" ] || fail "signed-in check should probe twice (got $(probes))"
[ "$(sed -n 1p "$TMP/az/argv.log")" = "$(probe_line "$T1" "$FABRIC")" ] || fail "first probe must be the Fabric token (got $(sed -n 1p "$TMP/az/argv.log"))"
[ "$(sed -n 2p "$TMP/az/argv.log")" = "$(probe_line "$T1" "$PBI")" ] || fail "second probe must be the Power BI token"
[ "$(logins)" = "0" ] || fail "a signed-in machine must not sign in"
[ -z "$out" ] || fail "a signed-in check must print nothing (got: $out)"
[ "$(cat "$MARKER")" = "$T1" ] || fail "marker should hold the verified tenant"
pass "signed in: Fabric then Power BI probe with --output none, marker stamped, silent"

# 2. Second launch within the TTL: no az call at all.
az_reset "$T1 *"
coop_az_preflight </dev/null
[ "$(calls)" = "0" ] || fail "cached preflight must not invoke az (got $(calls))"
pass "second preflight within 30 min performs no az invocation"

# 3. A tenant change invalidates the cache.
project "$T2"; az_reset "$T2 *"
coop_az_preflight </dev/null
[ "$(probes)" = "2" ] || fail "tenant change should re-probe (got $(probes))"
[ "$(cat "$MARKER")" = "$T2" ] || fail "marker should refresh to the new tenant"
pass "tenant change re-runs the check and re-stamps"

# 4. A marker older than the TTL re-probes.
az_reset "$T2 *"
touch -t 202001010000 "$MARKER"
coop_az_preflight </dev/null
[ "$(probes)" = "2" ] || fail "stale marker should re-probe (got $(probes))"
pass "stale marker (past the TTL) re-runs the check"

# 5. COOP_SKIP_AZ=1 skips everything, cache or not.
rm -f "$MARKER"; az_reset
out="$(COOP_SKIP_AZ=1 coop_az_preflight 2>&1 </dev/null)"
[ "$(calls)" = "0" ] && [ -z "$out" ] || fail "COOP_SKIP_AZ=1 must skip the check (got $(calls) calls)"
pass "COOP_SKIP_AZ=1 skips everything"

# 6. Signed out, non-interactive: one probe, never a sign-in, one line, rc 0.
az_reset
rc=0; out="$(coop_az_preflight 2>&1 </dev/null)" || rc=$?
[ "$rc" = "0" ] || fail "a failed check must not fail the launch (rc=$rc)"
[ "$(probes)" = "1" ] && [ "$(logins)" = "0" ] || fail "non-interactive: 1 probe, 0 logins (got $(probes)/$(logins))"
[ ! -f "$MARKER" ] || fail "a failed check must not leave a marker"
[ "$(warn_lines "$out")" = "1" ] && [ "$(printf '%s\n' "$out" | grep -c .)" = "1" ] || fail "expected exactly one line (got: $out)"
case "$out" in
  *"not signed in to tenant $T2"*"az login --tenant $T2 --allow-no-subscriptions"*) ;;
  *) fail "signed-out line must name the sign-in command (got: $out)" ;;
esac
case "$out" in *"[y/N]"*|*refusing*) fail "no prompt and no refusal (got: $out)" ;; esac
pass "signed out, non-interactive: one probe, no sign-in, one line naming az login"

# 7. Fabric token missing (Power BI present), interactive: one automatic sign-in.
az_reset "$T2 $PBI"
out="$(COOP_ASSUME_YES=1 coop_az_preflight 2>&1 </dev/null)"
[ "$(logins)" = "1" ] || fail "a missing Fabric token must sign in once (got $(logins))"
[ "$(grep '^login ' "$TMP/az/argv.log")" = "login --tenant $T2 --allow-no-subscriptions --output none LXV2=off" ] \
  || fail "sign-in argv/env mismatch: $(grep '^login ' "$TMP/az/argv.log")"
[ "$(probes)" = "3" ] || fail "sign-in must re-check both tokens (got $(probes) probes)"
[ "$(cat "$MARKER")" = "$T2" ] || fail "a verified sign-in stamps the marker"
case "$out" in *"Signed in to Azure for tenant $T2"*) ;; *) fail "sign-in success should be reported (got: $out)" ;; esac
case "$out" in *"[y/N]"*) fail "automatic sign-in must not ask (got: $out)" ;; esac
pass "missing Fabric token: one automatic sign-in (LXV2=off), both tokens re-checked, marker stamped"

# 8. Power BI token missing (Fabric present): either token missing signs in.
rm -f "$MARKER"; az_reset "$T2 $FABRIC"
COOP_ASSUME_YES=1 coop_az_preflight </dev/null 2>/dev/null
[ "$(logins)" = "1" ] && [ "$(probes)" = "4" ] || fail "missing Power BI token: 1 login, 4 probes (got $(logins)/$(probes))"
pass "missing Power BI token also signs in"

# 9. Sign-in fails: exactly one attempt, one line, no marker, rc 0.
rm -f "$MARKER"; az_reset; printf '1' > "$TMP/az/login-rc"
rc=0; out="$(COOP_ASSUME_YES=1 coop_az_preflight 2>&1 </dev/null)" || rc=$?
[ "$rc" = "0" ] || fail "a failed sign-in must not fail the launch (rc=$rc)"
[ "$(logins)" = "1" ] && [ "$(probes)" = "1" ] || fail "failed sign-in: 1 login, no retry, no re-probe (got $(logins)/$(probes))"
[ ! -f "$MARKER" ] || fail "a failed sign-in must not leave a marker"
[ "$(warn_lines "$out")" = "1" ] || fail "expected exactly one warning line (got: $out)"
case "$out" in
  *"not verified"*"az login --tenant $T2 --allow-no-subscriptions"*) ;;
  *) fail "failed sign-in line must name the command (got: $out)" ;;
esac
pass "failed sign-in: one attempt, one line naming az login, launch continues"

# 10. Timeout (the watchdog's kill, rc>128 -> 124): never a sign-in.
az_reset; printf 'term' > "$TMP/az/mode"
out="$(COOP_ASSUME_YES=1 coop_az_preflight 2>&1 </dev/null)"
[ "$(probes)" = "1" ] && [ "$(logins)" = "0" ] || fail "timeout: 1 probe, 0 logins (got $(probes)/$(logins))"
[ ! -f "$MARKER" ] || fail "a timed-out check must not leave a marker"
[ "$(warn_lines "$out")" = "1" ] || fail "expected exactly one timeout line (got: $out)"
case "$out" in
  *"timed out for tenant $T2 (network or VPN?)"*"az account get-access-token --tenant $T2 --resource $FABRIC"*) ;;
  *) fail "timeout line mismatch (got: $out)" ;;
esac
pass "timed-out check: no sign-in, one line naming the token command"

# 11. A non-authentication failure never opens a sign-in or says "not signed in".
az_reset; printf 'error' > "$TMP/az/mode"
out="$(COOP_ASSUME_YES=1 coop_az_preflight 2>&1 </dev/null)"
[ "$(probes)" = "1" ] && [ "$(logins)" = "0" ] || fail "non-auth error: 1 probe, 0 logins (got $(probes)/$(logins))"
[ "$(warn_lines "$out")" = "1" ] || fail "expected exactly one line (got: $out)"
case "$out" in *"not signed in"*|*"az login"*) fail "a non-auth failure must not blame sign-in (got: $out)" ;; esac
case "$out" in *"(not an auth error)"*) ;; *) fail "non-auth line mismatch (got: $out)" ;; esac
pass "non-auth failure: no sign-in, 'not an auth error' line"

# 12. Tenant chain from the shell (cwd without a contract / TODO contracts).
cd "$TMP/nocontract"
config '{"schema_version":1,"azure":{"purpose":"client_resources","tenant_id":"tenant-ccc.example"}}'
az_reset "tenant-ccc.example *"; rm -f "$MARKER"
coop_az_preflight </dev/null
[ "$(sed -n 1p "$TMP/az/argv.log")" = "$(probe_line tenant-ccc.example "$FABRIC")" ] || fail "no contract: the config tenant must be used"
cd "$TMP/proj"
for placeholder in '"TODO: tenant id"' 'todo'; do
  project "$placeholder"; az_reset "tenant-ccc.example *"; rm -f "$MARKER"
  coop_az_preflight </dev/null
  [ "$(sed -n 1p "$TMP/az/argv.log")" = "$(probe_line tenant-ccc.example "$FABRIC")" ] || fail "contract $placeholder must fall through to the config tenant"
done
config '{"schema_version":1,"azure":{"purpose":"internal","tenant_id":"tenant-ccc.example"}}'
rm -f "$MARKER"; az_reset; out="$(coop_az_preflight 2>&1 </dev/null)"
[ "$(calls)" = "0" ] && [ -z "$out" ] || fail "purpose internal: no az call and no output (got $(calls): $out)"
rm -f "$TMP/coop/.coop/config" "$MARKER"
az_reset; out="$(coop_az_preflight 2>&1 </dev/null)"
[ "$(calls)" = "0" ] && [ -z "$out" ] || fail "no tenant anywhere: silent (got $(calls): $out)"
pass "tenant chain: contract -> ~/.coop/config (BOM, client resources only) -> silent"

# 13. Injection boundary: an invalid contract tenant stops the chain; no az call.
config '{"schema_version":1,"azure":{"tenant_id":"tenant-ccc.example"}}'
for bad in 'x&calc' 'TBD'; do
  project "$bad"; az_reset
  out="$(COOP_ASSUME_YES=1 coop_az_preflight 2>&1 </dev/null)"
  [ "$(calls)" = "0" ] || fail "invalid tenant $bad must not reach az (got $(calls))"
  [ "$(warn_lines "$out")" = "1" ] || fail "expected one line for $bad (got: $out)"
  case "$out" in *"not a GUID or domain name"*) ;; *) fail "invalid tenant line mismatch (got: $out)" ;; esac
  case "$out" in *tenant-ccc*|*"$bad"*) fail "neither the config tenant nor the rejected value may appear (got: $out)" ;; esac
done
pass "invalid contract tenant (x&calc, TBD): no az call, config tenant not used, one line"

# 14. The auth markers match the Fabric token helper's list.
markers="$(grep -o '\["az login", [^]]*\]' "$ROOT/lib/fabric_request_headers.mjs" | tr -d '[]"' | tr ',' '\n' | sed 's/^ *//')"
[ "$(printf '%s\n' "$markers" | grep -c .)" -ge 10 ] || fail "could not read the helper's auth markers"
while IFS= read -r m; do
  grep -qF -- "$m" "$ROOT/lib/common.sh" || fail "lib/common.sh is missing auth marker: $m"
  grep -qF -- "'$m'" "$ROOT/lib/common.ps1" || fail "lib/common.ps1 is missing auth marker: $m"
done <<EOF
$markers
EOF
pass "bash and PowerShell auth markers match lib/fabric_request_headers.mjs"

printf '  %s\n' "az sign-in preflight tests passed"

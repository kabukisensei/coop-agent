#!/usr/bin/env bash
#
# az-preflight cache (lib/common.sh coop_az_preflight): a shimmed `az` counts
# invocations, proving the ~30-min tenant-stamped cache skips the probe, and that
# tenant changes / stale markers / COOP_SKIP_AZ behave per the contract. Offline.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf '  ✗ %s\n' "$1"; exit 1; }
pass() { printf '  ✓ %s\n' "$1"; }

# az shim: logs every get-access-token probe; exit code driven by a control file.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/az" <<EOF
#!/bin/sh
echo "\$*" >> "$TMP/az.log"
exit "\$(cat "$TMP/az.rc" 2>/dev/null || echo 0)"
EOF
chmod +x "$TMP/bin/az"
printf '0' > "$TMP/az.rc"
PATH="$TMP/bin:$PATH"

probes() { grep -c 'get-access-token' "$TMP/az.log" 2>/dev/null || printf '0'; }

# A "work repo" with a pinned tenant, and a sandboxed agent dir for the marker.
mkdir -p "$TMP/proj/.coop"
printf 'fabric:\n  tenant_id: tenant-aaa\n' > "$TMP/proj/.coop/project.yml"
export COOP_ROOT="$ROOT"                       # real repo: lib/_yaml.py lives here
export COOP_AGENT_DIR="$TMP/agent"
unset PI_CODING_AGENT_DIR COOP_NO_ISOLATE COOP_SKIP_AZ 2>/dev/null || true
NO_COLOR=1; export NO_COLOR
# shellcheck source=../lib/common.sh
. "$ROOT/lib/common.sh"
cd "$TMP/proj"

# 1. First launch probes az once and stamps the marker with the tenant.
coop_az_preflight
[ "$(probes)" = "1" ] || fail "first preflight should probe az once (got $(probes))"
[ "$(cat "$TMP/agent/.az-ok")" = "tenant-aaa" ] || fail "marker should hold the validated tenant"
pass "first preflight probes az and stamps .az-ok with the tenant"

# 2. Second launch within the TTL: NO az invocation at all.
coop_az_preflight
[ "$(probes)" = "1" ] || fail "cached preflight must not invoke az (got $(probes))"
pass "second preflight within 30 min performs no az invocation"

# 3. Tenant change in project.yml invalidates the cache.
printf 'fabric:\n  tenant_id: tenant-bbb\n' > "$TMP/proj/.coop/project.yml"
coop_az_preflight
[ "$(probes)" = "2" ] || fail "tenant change should re-probe (got $(probes))"
[ "$(cat "$TMP/agent/.az-ok")" = "tenant-bbb" ] || fail "marker should refresh to the new tenant"
pass "tenant change re-runs the probe and re-stamps"

# 4. A marker older than the TTL re-probes.
touch -t 202001010000 "$TMP/agent/.az-ok"
coop_az_preflight
[ "$(probes)" = "3" ] || fail "stale marker should re-probe (got $(probes))"
pass "stale marker (past the TTL) re-runs the probe"

# 5. COOP_SKIP_AZ=1 skips everything, cache or not.
rm -f "$TMP/agent/.az-ok"
COOP_SKIP_AZ=1 coop_az_preflight
[ "$(probes)" = "3" ] || fail "COOP_SKIP_AZ=1 must skip the probe (got $(probes))"
pass "COOP_SKIP_AZ=1 still skips everything"

# 6. A failed probe warns as before, clears the marker, and doesn't stamp.
printf '1' > "$TMP/az.rc"
out="$(coop_az_preflight 2>&1 </dev/null)" || fail "a failed probe must not fail the launch"
[ "$(probes)" = "4" ] || fail "failed probe should still have probed (got $(probes))"
[ ! -f "$TMP/agent/.az-ok" ] || fail "failed probe must not leave a marker"
case "$out" in
  *"token missing or expired"*) pass "failed probe warns exactly as before (no marker left)" ;;
  *) fail "failed probe should warn about the missing token (got: $out)" ;;
esac

printf '  %s\n' "az-preflight cache tests passed"

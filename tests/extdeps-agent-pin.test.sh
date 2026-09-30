#!/usr/bin/env bash
# lib/_extdeps.py pins the agent package, not only pi-ai and pi-tui (#122).
# Several extensions declare @earendil-works/pi-coding-agent as a peer, and
# coop's own npm installs auto-install peers: unpinned, npm fetched the newest
# agent into the isolated tree seconds after upstream published it. The
# override pins that peer to the agent's version, and a tree holding any other
# agent version counts as skewed so the realignment reinstall replaces it.
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
PY="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

# tree <dir> <override-json> <name@version>...: a fake isolated extension tree.
tree() {
  local dir="$1" overrides="$2" spec name ver
  shift 2
  mkdir -p "$dir/npm/node_modules"
  printf '{"name":"pi-extensions","private":true,"dependencies":{},"overrides":%s}\n' "$overrides" > "$dir/npm/package.json"
  for spec in "$@"; do
    name="${spec%@*}"; ver="${spec##*@}"
    mkdir -p "$dir/npm/node_modules/$name"
    printf '{"name":"%s","version":"%s"}\n' "$name" "$ver" > "$dir/npm/node_modules/$name/package.json"
  done
}
agent_override() {
  "$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["overrides"].get("@earendil-works/pi-coding-agent", ""))' "$1/npm/package.json"
}
libs="@earendil-works/pi-ai@0.84.3 @earendil-works/pi-tui@0.84.3"

# shellcheck disable=SC2086  # $libs is a deliberate word list
tree "$TMP/fresh" '{}' $libs
rc=0; "$PY" "$ROOT/lib/_extdeps.py" align "$TMP/fresh" 0.84.3 >/dev/null || rc=$?
[ "$(agent_override "$TMP/fresh")" = "0.84.3" ] && ok "align writes an override pinning the agent peer to the agent's version" \
  || ko "align did not pin @earendil-works/pi-coding-agent (got '$(agent_override "$TMP/fresh")')"
[ "$rc" -eq 0 ] && ok "a tree without the agent peer is aligned" || ko "a tree without the agent peer returned rc $rc"

# shellcheck disable=SC2086
tree "$TMP/stale" '{"@earendil-works/pi-ai":"0.84.3","@earendil-works/pi-tui":"0.84.3"}' $libs "@earendil-works/pi-coding-agent@0.99.1"
rc=0; "$PY" "$ROOT/lib/_extdeps.py" align "$TMP/stale" 0.84.3 --check >/dev/null || rc=$?
[ "$rc" -eq 10 ] && ok "a newer agent peer in the tree is skew (rc 10), so sync reinstalls" \
  || ko "a pi-coding-agent 0.99.1 peer under agent 0.84.3 returned rc $rc, not 10"
[ -z "$(agent_override "$TMP/stale")" ] && ok "--check never writes the override" || ko "--check wrote package.json"

# shellcheck disable=SC2086
tree "$TMP/pinned" '{"@earendil-works/pi-ai":"0.84.3","@earendil-works/pi-tui":"0.84.3","@earendil-works/pi-coding-agent":"0.84.3"}' $libs "@earendil-works/pi-coding-agent@0.84.3"
rc=0; "$PY" "$ROOT/lib/_extdeps.py" align "$TMP/pinned" 0.84.3 --check >/dev/null || rc=$?
[ "$rc" -eq 0 ] && ok "an agent peer at the agent's version is aligned" || ko "a pinned agent peer returned rc $rc"

# The convergence helpers write the pin before their own npm install (both twins).
grep -q '_extdeps.py" align "$agent_dir" "$pi_ver"' "$ROOT/lib/common.sh" \
  && ok "coop_converge_extension_pins pins peers before its npm install" \
  || ko "lib/common.sh convergence no longer pins peers before npm install"
grep -q "_extdeps.py') align \$AgentDir \$piVer" "$ROOT/lib/common.ps1" \
  && ok "Sync-CoopExtensionPins pins peers before its npm install" \
  || ko "lib/common.ps1 convergence no longer pins peers before npm install"

if [ "$fail" -ne 0 ]; then echo "  ✗ extdeps agent-pin tests FAILED"; exit 1; fi
echo "  extdeps agent-pin tests passed"

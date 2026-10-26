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

# The convergence helper writes the pin before its own npm install.
grep -q "_extdeps.py') align \$AgentDir \$piVer" "$ROOT/lib/common.ps1" \
  && ok "Sync-CoopExtensionPins pins peers before its npm install" \
  || ko "lib/common.ps1 convergence no longer pins peers before npm install"

# Exit codes and the report line (moved here from the ci.yml `shell` job, suite
# review 2026-10-26). NB: under `set -e` capture the intentionally non-zero exit
# codes with `|| rc=$?` (a list context, exempt from set -e).
rc=0; "$PY" "$ROOT/lib/_extdeps.py" align "$TMP/no-such-dir" 0.0.0 --check >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 2 ] && ok "no extension tree -> exit 2 (nothing to do)" || ko "a missing tree returned rc $rc, not 2"
rc=0; "$PY" "$ROOT/lib/_extdeps.py" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] && ok "bad usage -> exit 3" || ko "bad usage returned rc $rc, not 3"

# write + report on a fixture: overrides written, skew reported (exit 10)
d="$TMP/skew"; mkdir -p "$d/npm/node_modules/@earendil-works/pi-ai" "$d/npm/node_modules/@earendil-works/pi-tui"
printf '{"version":"0.74.2"}' > "$d/npm/node_modules/@earendil-works/pi-ai/package.json"
printf '{"version":"0.74.2"}' > "$d/npm/node_modules/@earendil-works/pi-tui/package.json"
printf '{"name":"pi-extensions","dependencies":{}}' > "$d/npm/package.json"
rc=0; out="$("$PY" "$ROOT/lib/_extdeps.py" align "$d" 0.80.2)" || rc=$?
[ "$rc" -eq 10 ] && ok "a tree behind the agent is skew (rc 10)" || ko "a 0.74.2 tree under agent 0.80.2 returned rc $rc, not 10"
# 8-field line: tree_ai tree_tui ovr_ai ovr_tui changed aligned required_floor offending_ext
# (last two are "-" here: nothing imposes a pi-ai floor, so the agent is not "too old")
[ "$out" = "0.74.2 0.74.2 0.80.2 0.80.2 1 0 - -" ] && ok "the report line names tree, override, changed and aligned" || ko "unexpected report line: '$out'"
"$PY" -c 'import json,sys; o=json.load(open(sys.argv[1]))["overrides"]; assert o["@earendil-works/pi-ai"]=="0.80.2" and o["@earendil-works/pi-tui"]=="0.80.2"' "$d/npm/package.json" \
  && ok "align writes the pi-ai and pi-tui overrides" || ko "align did not write the pi-ai/pi-tui overrides"

# agent too old for an installed extension -> exit 11, names the offending ext + floor
e="$TMP/floor"; mkdir -p "$e/npm/node_modules/@earendil-works/pi-ai" "$e/npm/node_modules/@earendil-works/pi-tui" "$e/npm/node_modules/@earendil-works/pi-coding-agent" "$e/npm/node_modules/pi-hermes-memory"
printf '{"version":"0.80.2"}' > "$e/npm/node_modules/@earendil-works/pi-ai/package.json"
printf '{"version":"0.80.2"}' > "$e/npm/node_modules/@earendil-works/pi-tui/package.json"
printf '{"name":"pi-hermes-memory","dependencies":{"@earendil-works/pi-ai":"^0.99.0"}}' > "$e/npm/node_modules/pi-hermes-memory/package.json"
# npm can auto-install a newer peer host at the top level. It is not an
# extension and must not override the direct extension's requirement.
printf '{"name":"@earendil-works/pi-coding-agent","dependencies":{"@earendil-works/pi-ai":"^0.99.1"}}' > "$e/npm/node_modules/@earendil-works/pi-coding-agent/package.json"
printf '{"name":"pi-extensions","dependencies":{"pi-hermes-memory":"0.0.0"}}' > "$e/npm/package.json"
rc=0; out="$("$PY" "$ROOT/lib/_extdeps.py" align "$e" 0.80.2 --check)" || rc=$?
[ "$rc" -eq 11 ] && ok "an extension needing a newer pi-ai than the agent -> exit 11" || ko "the floor case returned rc $rc, not 11"
[ "$out" = "0.80.2 0.80.2 - - 0 1 0.99.0 pi-hermes-memory" ] && ok "the report line names the floor and the offending extension" || ko "unexpected floor report line: '$out'"

if [ "$fail" -ne 0 ]; then echo "  ✗ extdeps agent-pin tests FAILED"; exit 1; fi
echo "  extdeps agent-pin tests passed"

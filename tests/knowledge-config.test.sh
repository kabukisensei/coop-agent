#!/usr/bin/env bash
#
# Tests for the ~/.coop/config "knowledge" block: onboarding writes it, the
# lib/common.sh readers parse it (COOP_DIR override — never the real $HOME).
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
PY="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
[ -z "$PY" ] && { echo "python3 required"; exit 1; }

fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export COOP_AZ_BIN=/nonexistent/az

# --- onboarding writes the knowledge block (and preserves it on re-run) -------
D1="$TMP/onboard"; mkdir -p "$D1"
printf 'n\nn\nn\nn\nn\ny\n' | HOME="$D1" COOP_DIR="$D1" \
  "$PY" "$ROOT/scripts/onboard.py" onboard --config-only >/dev/null 2>&1
if [ -f "$D1/.coop/config" ] && "$PY" - "$D1/.coop/config" <<'PYEOF'
import json, sys
c = json.load(open(sys.argv[1]))
k = c["knowledge"]
assert k["enabled"] is True, k
r = k["repos"]
assert isinstance(r, list) and len(r) == 1, r
assert r[0]["url"] == "https://github.com/cooptimize/incremental-bi.git", r
assert r[0]["local_path"] == "~/.coop/knowledge/incremental-bi", r
assert c["schema_version"] == 1 and "integrations" in c, c
PYEOF
then ok "onboarding writes an enabled knowledge block with the default repo"
else ko "onboarding did not write the expected knowledge block"; fi

# Declining keeps knowledge disabled, with no repos invented.
D2="$TMP/declined"; mkdir -p "$D2"
printf 'n\nn\nn\nn\nn\nn\n' | HOME="$D2" COOP_DIR="$D2" \
  "$PY" "$ROOT/scripts/onboard.py" onboard --config-only >/dev/null 2>&1
"$PY" - "$D2/.coop/config" <<'PYEOF'
import json, sys
k = json.load(open(sys.argv[1]))["knowledge"]
assert k["enabled"] is False and k["repos"] == [], k
PYEOF
[ "$?" -eq 0 ] && ok "declining writes knowledge disabled" || ko "declined knowledge block wrong"

# Re-running with blank answers preserves the existing knowledge block verbatim.
printf 'n\nn\nn\nn\nn\n\n' | HOME="$D1" COOP_DIR="$D1" \
  "$PY" "$ROOT/scripts/onboard.py" onboard --config-only >/dev/null 2>&1
"$PY" - "$D1/.coop/config" <<'PYEOF'
import json, sys
k = json.load(open(sys.argv[1]))["knowledge"]
assert k["enabled"] is True and len(k["repos"]) == 1, k
assert k["repos"][0]["url"] == "https://github.com/cooptimize/incremental-bi.git", k
PYEOF
[ "$?" -eq 0 ] && ok "re-running onboarding preserves the knowledge block" || ko "re-run clobbered the knowledge block"

# --- readers (lib/common.sh) ---------------------------------------------------
CFG="$TMP/readers"; mkdir -p "$CFG/.coop"
cat > "$CFG/.coop/config" <<JSON
{"schema_version":1,
 "knowledge":{"enabled":true,"repos":[
   {"url":"https://github.com/cooptimize/incremental-bi.git","local_path":"~/.coop/knowledge/incremental-bi"},
   {"url":"https://example.invalid/team/kb-two.git","local_path":"$CFG/kb-two"}]}}
JSON
out="$(HOME="$TMP/home" COOP_DIR="$CFG" COOP_ROOT="$ROOT" bash -c '
  . "$COOP_ROOT/lib/common.sh"
  coop_knowledge_enabled || exit 1
  coop_knowledge_repos
')"
rc=$?
[ "$rc" -eq 0 ] && ok "coop_knowledge_enabled true for enabled config" || ko "coop_knowledge_enabled rejected enabled config"
line1="$(printf '%s\n' "$out" | sed -n '1p')"
line2="$(printf '%s\n' "$out" | sed -n '2p')"
lines="$(printf '%s\n' "$out" | grep -c '')"
[ "$lines" = "2" ] && ok "reader emits one line per repo" || ko "expected 2 repo lines, got $lines: $out"
case "$line1" in
  "https://github.com/cooptimize/incremental-bi.git	$TMP/home/.coop/knowledge/incremental-bi")
    ok "reader expands ~ in local_path" ;;
  *) ko "line 1 wrong (tilde expansion?): [$line1]" ;;
esac
case "$line2" in
  "https://example.invalid/team/kb-two.git	$CFG/kb-two")
    ok "reader emits url<TAB>local_path for repo 2" ;;
  *) ko "line 2 wrong: [$line2]" ;;
esac

# Missing knowledge key -> empty output, exit 0 (clean no-op).
CFG2="$TMP/none"; mkdir -p "$CFG2/.coop"
printf '%s\n' '{"schema_version":1,"integrations":{}}' > "$CFG2/.coop/config"
out="$(HOME="$TMP/home" COOP_DIR="$CFG2" COOP_ROOT="$ROOT" bash -c '
  . "$COOP_ROOT/lib/common.sh"
  if coop_knowledge_enabled; then echo ENABLED; fi
  coop_knowledge_repos
')"
rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "missing knowledge key is a clean no-op" || ko "missing key: rc=$rc out=[$out]"

# Disabled flag -> empty output, exit 0.
CFG3="$TMP/disabled"; mkdir -p "$CFG3/.coop"
printf '%s\n' '{"schema_version":1,"knowledge":{"enabled":false,"repos":[{"url":"u","local_path":"/tmp/x"}]}}' > "$CFG3/.coop/config"
out="$(HOME="$TMP/home" COOP_DIR="$CFG3" COOP_ROOT="$ROOT" bash -c '
  . "$COOP_ROOT/lib/common.sh"
  coop_knowledge_repos
')"
rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "disabled knowledge is a clean no-op" || ko "disabled: rc=$rc out=[$out]"

# No config file at all -> clean no-op.
out="$(HOME="$TMP/home" COOP_DIR="$TMP/nonexistent" COOP_ROOT="$ROOT" bash -c '
  . "$COOP_ROOT/lib/common.sh"
  coop_knowledge_repos
')"
rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "absent config file is a clean no-op" || ko "absent config: rc=$rc out=[$out]"

exit $fail

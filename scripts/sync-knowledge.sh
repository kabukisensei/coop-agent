#!/usr/bin/env bash
#
# Sync the configured team knowledge repos (~/.coop/config "knowledge" block).
#
# For each repo when knowledge.enabled:
#   - local_path missing          -> git clone <url> <local_path>
#   - existing clean git checkout -> git -C <local_path> pull --ff-only
#   - dirty checkout              -> warn + skip (never reset/clean)
#   - unreachable remote          -> warn + continue (fail soft — offline must
#                                    never break `coop`)
#
# Always exits 0 for sync problems; team knowledge is an aid, not a gate.
#
# Usage: scripts/sync-knowledge.sh
#
set -uo pipefail

COOP_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
export COOP_ROOT
# shellcheck source=../lib/common.sh
. "$COOP_ROOT/lib/common.sh"

if ! coop_knowledge_enabled; then
  coop_info "team knowledge sync is disabled — enable it with: coop onboard --config-only"
  exit 0
fi
have git || { coop_warn "git is required to sync team knowledge — skipping"; exit 0; }

synced=0
# Feed the loop with a here-doc (not a pipe) so `synced` survives in this shell.
while IFS="$(printf '\t')" read -r url path; do
  [ -n "$url" ] && [ -n "$path" ] || continue
  if [ -d "$path/.git" ]; then
    if [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]; then
      coop_warn "knowledge repo is dirty — skipping (never resetting your changes): $path"
      continue
    fi
    if git -C "$path" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=15 pull --ff-only >/dev/null 2>&1; then
      coop_ok "updated $(basename "$path")"
      synced=$((synced+1))
    else
      coop_warn "could not fast-forward $path (offline or diverged) — keeping the existing checkout"
    fi
  elif [ -e "$path" ]; then
    coop_warn "$path exists but is not a git checkout — skipping"
  else
    mkdir -p "$(dirname "$path")" 2>/dev/null || true
    if git clone -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=15 "$url" "$path" >/dev/null 2>&1; then
      coop_ok "cloned $(basename "$path") -> $path"
      synced=$((synced+1))
    else
      rm -rf "$path" 2>/dev/null || true   # a failed clone can leave a husk dir
      coop_warn "clone failed (offline or no access): $url"
    fi
  fi
done <<EOF
$(coop_knowledge_repos)
EOF

coop_ok "team knowledge sync complete ($synced repo(s) current)"
exit 0

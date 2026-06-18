#!/usr/bin/env bash
#
# coop sync — refresh Cooptimize brand assets and runtime wiring (non-destructive):
#   • make bin/coop + scripts executable
#   • ensure the core Pi extensions are installed (MCP / memory / powerline)
#   • place the read-only MCP config (fabric / powerbi / microsoft-learn / context-mode)
#     into ~/.config/mcp/mcp.json IF you don't already have one (never clobbers)
#   • verify splash / theme / vibes are present
#
set -uo pipefail

COOP_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
export COOP_ROOT
# shellcheck source=../lib/common.sh
. "$COOP_ROOT/lib/common.sh"

CORE_EXTENSIONS=( pi-mcp-adapter pi-hermes-memory pi-powerline-footer )

coop_head "coop sync (v${COOP_VERSION})"

# --- 1. Executability --------------------------------------------------------
chmod +x "$COOP_ROOT/bin/coop" "$COOP_ROOT"/scripts/*.sh 2>/dev/null || true
coop_ok "bin/coop and scripts are executable"

# --- 2. Core Pi extensions (idempotent) --------------------------------------
if have pi; then
  pilist="$(pi list 2>/dev/null || true)"
  for ext in "${CORE_EXTENSIONS[@]}"; do
    if printf '%s' "$pilist" | grep -qi "$ext"; then
      coop_ok "$ext present"
    else
      coop_info "installing $ext…"
      pi install "npm:$ext" >/dev/null 2>&1 && coop_ok "$ext installed" || coop_warn "could not install $ext"
    fi
  done
else
  coop_warn "pi not installed — skipping extension sync (run: coop install)"
fi

# --- 3. MCP config (read-only) — non-destructive -----------------------------
MCP_SRC="$COOP_ROOT/config/mcp.example.json"
MCP_DST="$HOME/.config/mcp/mcp.json"
if [ -f "$MCP_SRC" ]; then
  if [ -f "$MCP_DST" ]; then
    coop_ok "MCP config already exists: $MCP_DST"
    if ! grep -qiE 'learn\.microsoft\.com|microsoft-learn' "$MCP_DST" 2>/dev/null; then
      coop_warn "Microsoft Learn MCP not in your config."
      coop_say  "      Merge the 'microsoft-learn' server from: $MCP_SRC"
    fi
  else
    mkdir -p "$(dirname "$MCP_DST")"
    cp "$MCP_SRC" "$MCP_DST" && coop_ok "wrote read-only MCP config -> $MCP_DST"
    coop_warn "Edit $MCP_DST and set your tenant id where marked TODO."
  fi
else
  coop_warn "config/mcp.example.json missing — cannot sync MCP servers"
fi

# --- 4. Brand assets ---------------------------------------------------------
coop_head "Brand assets"
[ -f "$COOP_ROOT/extensions/coop-powerline/assets/splash.ansi" ] && coop_ok "splash present" || coop_warn "splash.ansi missing (regenerate from the logo)"
[ -f "$COOP_ROOT/themes/cooptimize.json" ] && coop_ok "theme present" || coop_warn "themes/cooptimize.json missing"
vibe_count="$(find "$COOP_ROOT/vibes" -name '*.txt' 2>/dev/null | wc -l | tr -d ' ')"
[ "${vibe_count:-0}" -gt 0 ] && coop_ok "$vibe_count vibe file(s) present" || coop_warn "no vibe files found in vibes/"

coop_ok "sync complete."

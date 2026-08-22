#!/usr/bin/env bash
#
# coop sync — provision coop's ISOLATED Pi agent dir + brand assets (non-destructive):
#   • make bin/coop + scripts executable
#   • create coop's own Pi agent dir (~/.coop/agent) so coop's extensions/settings
#     never mix with your personal `pi`; share credentials (auth/models) from it
#   • install the core Pi extensions INTO that isolated dir (MCP / memory / powerline)
#   • place the read-only MCP config (fabric / powerbi / microsoft-learn / context-mode)
#     into the isolated dir if absent (never clobbers)
#   • verify splash / theme / vibes are present
#
set -uo pipefail

COOP_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
export COOP_ROOT
# shellcheck source=../lib/common.sh
. "$COOP_ROOT/lib/common.sh"

CORE_EXTENSIONS=( pi-mcp-adapter pi-hermes-memory pi-better-openai pi-web-access @juicesharp/rpiv-ask-user-question context-mode )
PI_AGENT="$(coop_pi_agent_dir)"
GLOBAL_AGENT="$(coop_global_pi_agent_dir)"

coop_head "coop sync (v${COOP_VERSION})"

# --- 1. Executability --------------------------------------------------------
chmod +x "$COOP_ROOT/bin/coop" "$COOP_ROOT"/scripts/*.sh 2>/dev/null || true
coop_ok "bin/coop and scripts are executable"

# --- 2. Isolated Pi agent dir + shared credentials ---------------------------
coop_head "Isolated Pi agent dir"
mkdir -p "$PI_AGENT"
chmod 700 "$PI_AGENT" 2>/dev/null || true   # holds the auth.json login link
coop_ok "coop Pi agent dir: $PI_AGENT"
# Share login/model config from your personal pi so coop doesn't need a separate
# login — but keep settings/extensions/themes isolated. Only symlink if absent.
for f in auth.json models.json; do
  if [ ! -e "$PI_AGENT/$f" ] && [ -f "$GLOBAL_AGENT/$f" ]; then
    ln -sf "$GLOBAL_AGENT/$f" "$PI_AGENT/$f" && coop_ok "shared $f from your personal pi (login/models)"
  fi
done

# --- 3. Core Pi extensions — installed INTO the isolated dir (idempotent) -----
if have pi; then
  for ext in "${CORE_EXTENSIONS[@]}"; do
    ext_spec="$(coop_manifest_extension_spec "$ext")"
    if [ -z "$ext_spec" ]; then coop_warn "manifest pin missing for $ext"; continue; fi
    coop_info "converging $ext to the release pin…"
    PI_CODING_AGENT_DIR="$PI_AGENT" pi install "$ext_spec" >/dev/null 2>&1 \
      && coop_ok "$ext pinned (isolated)" || coop_warn "could not pin $ext"
  done
  # Align the extension tree's @earendil-works/pi-ai + pi-tui to the agent's own
  # version so they share one pi-ai/pi-tui (else pi-web-access's 0.80 `/compat`
  # import breaks against pi-mcp-adapter's hoisted 0.74.x). Idempotent.
  coop_align_ext_deps
else
  coop_warn "pi not installed — skipping extension sync (run: coop install)"
fi

# --- 4. MCP config — manifest-pinned, ownership-aware, non-destructive --------
MCP_DST="$PI_AGENT/mcp.json"
_mcp_py="$(coop_python 2>/dev/null || true)"
if [ -n "$_mcp_py" ] && "$_mcp_py" "$COOP_ROOT/lib/mcp_config.py" --output "$MCP_DST"; then
  coop_ok "generated manifest-pinned MCP config -> $MCP_DST"
else
  coop_warn "could not generate MCP config" "run: coop onboard --edit, then coop sync"
fi

# --- 5. Brand assets ---------------------------------------------------------
coop_head "Brand assets"
[ -f "$COOP_ROOT/extensions/coop-powerline/assets/splash.ansi" ] && coop_ok "splash present" || coop_warn "splash.ansi missing (regenerate from the logo)"
[ -f "$COOP_ROOT/themes/cooptimize.json" ] && coop_ok "theme present" || coop_warn "themes/cooptimize.json missing"
vibe_count="$(find "$COOP_ROOT/vibes" -name '*.txt' 2>/dev/null | wc -l | tr -d ' ')"
[ "${vibe_count:-0}" -gt 0 ] && coop_ok "$vibe_count vibe file(s) present" || coop_warn "no vibe files found in vibes/"

coop_ok "sync complete."

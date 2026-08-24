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
# `pi install` exiting 0 proves nothing on its own: a successful-looking install
# can still leave the wrong version or nothing at all in the tree. After the
# install loop, dependency specs are converged to EXACT manifest versions
# (coop_converge_extension_pins — the same helper the compatibility matrix uses)
# and every extension is verified; any postcondition failure makes sync exit
# non-zero.
SYNC_FAILURES=0
FLEET_SPECS=()
FLEET_NAMES=()
FLEET_PINS=()
PREVERS=()

if have pi; then
  coop_info "Coop keeps its extensions in $PI_AGENT and pins the versions tested"
  coop_info "together with this Coop release. Your personal Pi extensions are unchanged."
  for ext in "${CORE_EXTENSIONS[@]}"; do
    ext_spec="$(coop_manifest_extension_spec "$ext")"
    if [ -z "$ext_spec" ]; then coop_warn "manifest pin missing for $ext"; SYNC_FAILURES=$((SYNC_FAILURES + 1)); continue; fi
    FLEET_SPECS+=("${ext_spec#npm:}")
    FLEET_NAMES+=("$ext")
    ext_pin="${ext_spec##*@}"
    FLEET_PINS+=("$ext_pin")
    PREVERS+=("$(coop_ext_installed_version "$PI_AGENT" "$ext")")
    coop_info "Ensuring isolated $ext is version ${ext_pin}…"
    if ! PI_CODING_AGENT_DIR="$PI_AGENT" pi install "$ext_spec" >/dev/null 2>&1; then
      coop_warn "could not install $ext (pin $ext_pin)"
      SYNC_FAILURES=$((SYNC_FAILURES + 1))
    fi
  done

  # Runtime alignment of shared libraries first (distinct from release pins),
  # because it also reinstalls the tree; exact-pin enforcement runs after so the
  # final state is what was tested.
  _pi_runtime="$(coop_pi_version 2>/dev/null || true)"
  [ -n "$_pi_runtime" ] && coop_info "Aligning shared Pi libraries with the installed Pi runtime ${_pi_runtime}…"
  coop_align_ext_deps

  # Production exact-pin convergence: rewrite recorded ^-ranges to manifest
  # versions and reinstall, so what ships is what was tested.
  if [ ${#FLEET_SPECS[@]} -gt 0 ]; then
    if ! coop_converge_extension_pins "$PI_AGENT" "${FLEET_SPECS[@]}"; then
      coop_warn "could not enforce exact extension pins in $PI_AGENT/npm" "run: coop sync"
      SYNC_FAILURES=$((SYNC_FAILURES + 1))
    fi
  fi

  # Postcondition verification over every required extension.
  for i in "${!FLEET_NAMES[@]}"; do
    ext="${FLEET_NAMES[$i]}"; ext_pin="${FLEET_PINS[$i]}"; pre="${PREVERS[$i]}"
    post_ver="$(coop_ext_installed_version "$PI_AGENT" "$ext")"
    if [ -z "$post_ver" ]; then
      coop_warn "postcondition failed: pi install reported success, but $ext is MISSING from the isolated tree (wanted $ext_pin)" \
        "run: coop sync   (or inspect $(printf '%s/npm/node_modules' "$PI_AGENT"))"
      SYNC_FAILURES=$((SYNC_FAILURES + 1))
      continue
    fi
    if [ "$post_ver" != "$ext_pin" ]; then
      coop_warn "postcondition failed: pi install reported success, but $ext is version $post_ver, not the pinned $ext_pin" \
        "run: coop sync"
      SYNC_FAILURES=$((SYNC_FAILURES + 1))
      continue
    fi
    case "$pre" in
      "")        coop_ok "Installed release version $ext_pin ($ext)" ;;
      "$ext_pin") coop_ok "Already at release version $ext_pin ($ext)" ;;
      *)
        if coop_version_lt "$ext_pin" "$pre"; then
          coop_ok "Downgraded untested $pre → release version $ext_pin ($ext)"
        else
          coop_ok "Updated $pre → $ext_pin ($ext)"
        fi
        ;;
    esac
  done
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

if [ "$SYNC_FAILURES" -gt 0 ]; then
  coop_warn "sync finished WITH $SYNC_FAILURES failure(s) — see above" "re-run: coop sync"
  exit 1
fi

coop_ok "sync complete."

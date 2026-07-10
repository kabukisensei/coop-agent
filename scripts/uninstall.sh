#!/usr/bin/env bash
#
# coop uninstall — clean teardown of coop's footprint on this machine (VM churn,
# offboarding). Inverse of scripts/install.sh.
#
# Removes (default): the ~/.local/bin/coop PATH symlink, coop's isolated Pi agent
# dir (~/.coop/agent — extensions, settings, MCP config, session state), and the
# tool layer: the npm-global Pi agent plus the pipx venvs (coop-data-doc /
# coop-sql-review / coop-dax-review / ms-fabric-cli).
#
# NEVER touches: this repo clone, any work repo's .coop/project.yml, the rest of
# ~/.coop (private config dirs live there), or your personal ~/.pi/agent (and its
# login — coop only ever symlinked/copied it in).
#
#   Flags:
#     --keep-tools   Keep pi + the pipx tools installed (fast re-install later;
#                    right for shared machines) — remove only coop's own footprint
#     --yes, -y      Assume yes for the confirmation
#
set -uo pipefail

COOP_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
export COOP_ROOT
# shellcheck source=../lib/common.sh
. "$COOP_ROOT/lib/common.sh"

KEEP_TOOLS=0
for a in "$@"; do
  case "$a" in
    '') ;;
    --keep-tools) KEEP_TOOLS=1 ;;
    --yes|-y) export COOP_ASSUME_YES=1 ;;
    -h|--help)
      printf 'Usage: coop uninstall [--keep-tools] [--yes]\n  --keep-tools  keep pi + the pipx tools (remove only coop'\''s own footprint)\n  --yes, -y     assume yes for the confirmation\n' >&2
      exit 0 ;;
    *) coop_warn "uninstall: ignoring unknown flag '$a'" ;;
  esac
done

PI_NPM_PACKAGE="@earendil-works/pi-coding-agent"
PY_TOOLS="coop-data-doc coop-sql-review coop-dax-review ms-fabric-cli"

coop_head "coop uninstall (v${COOP_VERSION})"
scope="the coop PATH symlink + coop's isolated agent dir ($(coop_pi_agent_dir))"
[ "$KEEP_TOOLS" = 0 ] && scope="$scope + Pi (npm global) + the pipx tools (coop-*, ms-fabric-cli)"
coop_info "will remove: $scope"
coop_info "never touched: this repo clone, work repos' .coop/project.yml, the rest of ~/.coop, your personal ~/.pi/agent"
if ! coop_confirm "Remove coop from this machine?"; then
  coop_info "uninstall cancelled — nothing changed."
  exit 1
fi

# --- 1. The `coop` PATH symlink (inverse of install.sh step 6) ----------------
LOCALBIN="$HOME/.local/bin"
if [ -L "$LOCALBIN/coop" ]; then
  rm -f "$LOCALBIN/coop" 2>/dev/null && coop_ok "removed $LOCALBIN/coop" || coop_warn "could not remove $LOCALBIN/coop"
elif [ -e "$LOCALBIN/coop" ]; then
  coop_warn "$LOCALBIN/coop exists but is not a symlink — left in place (not coop's)"
else
  coop_info "no $LOCALBIN/coop symlink (already gone)"
fi

# --- 2. The isolated Pi agent dir ---------------------------------------------
# ONLY the agent dir — the rest of ~/.coop can hold private, non-coop-agent config.
AGENT_DIR="$(coop_pi_agent_dir)"
case "$AGENT_DIR" in
  ''|/|"$HOME") coop_warn "suspicious agent dir '$AGENT_DIR' — not removing" ;;
  *)
    if [ -d "$AGENT_DIR" ]; then
      rm -rf "$AGENT_DIR" 2>/dev/null && coop_ok "removed $AGENT_DIR (extensions, settings, MCP config, session state)" \
        || coop_warn "could not fully remove $AGENT_DIR — check permissions"
    else
      coop_info "no agent dir at $AGENT_DIR (already gone)"
    fi ;;
esac

# --- 3. The tool layer (skipped with --keep-tools) ------------------------------
if [ "$KEEP_TOOLS" = 1 ]; then
  coop_info "kept pi + the pipx tools (--keep-tools)"
else
  if have npm && npm ls -g --depth=0 2>/dev/null | grep -q "$PI_NPM_PACKAGE"; then
    npm uninstall -g "$PI_NPM_PACKAGE" >/dev/null 2>&1 \
      && coop_ok "removed pi ($PI_NPM_PACKAGE)" \
      || coop_warn "could not npm-uninstall pi — remove by hand: npm uninstall -g $PI_NPM_PACKAGE"
  else
    coop_info "pi not installed via npm globally (nothing to remove)"
  fi
  if have pipx; then
    for pkg in $PY_TOOLS; do
      if pipx list 2>/dev/null | grep -q "package $pkg "; then
        pipx uninstall "$pkg" >/dev/null 2>&1 \
          && coop_ok "removed $pkg (pipx)" \
          || coop_warn "could not pipx-uninstall $pkg — remove by hand: pipx uninstall $pkg"
      fi
    done
  else
    coop_info "pipx not found — no pipx tools to remove"
  fi
fi

echo >&2
coop_ok "uninstall complete."
coop_info "re-install any time from a coop-agent clone:  ./bin/coop install"
exit 0

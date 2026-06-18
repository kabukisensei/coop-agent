#!/usr/bin/env bash
#
# coop update — keep the whole Cooptimize stack current:
#   1. Pull the latest coop-agent (skills / prompts / vibes / theme)
#   2. Update Pi itself and every installed Pi extension
#   3. Upgrade the Coop tools and the Microsoft Fabric CLI (pipx)
#   4. Re-sync vibes and the powerline extension
#   5. Run doctor
#
set -uo pipefail

COOP_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
export COOP_ROOT
# shellcheck source=../lib/common.sh
. "$COOP_ROOT/lib/common.sh"

PY_TOOLS=( coop-data-doc coop-sql-review coop-dax-review ms-fabric-cli )

# Update coop's ISOLATED Pi agent dir (not the user's personal pi).
export PI_CODING_AGENT_DIR="$(coop_pi_agent_dir)"

coop_head "coop update (v${COOP_VERSION})"

# --- 1. Update coop-agent itself ---------------------------------------------
coop_head "1/5  coop-agent repository"
if [ -d "$COOP_ROOT/.git" ] && have git; then
  if git -C "$COOP_ROOT" remote get-url origin >/dev/null 2>&1; then
    if [ -n "$(git -C "$COOP_ROOT" status --porcelain 2>/dev/null)" ]; then
      coop_warn "local changes present in coop-agent — skipping 'git pull' (commit/stash first)."
    else
      coop_info "git pull --ff-only"
      git -C "$COOP_ROOT" pull --ff-only >/dev/null 2>&1 && coop_ok "coop-agent updated" || coop_warn "git pull failed (continuing)"
    fi
  else
    coop_info "no 'origin' remote configured — skipping repo update"
  fi
else
  coop_info "not a git checkout — skipping repo update"
fi

# --- 2. Update Pi + extensions ----------------------------------------------
coop_head "2/5  Pi and extensions"
if have pi; then
  coop_info "pi update pi   (the agent itself)"
  pi update pi >/dev/null 2>&1 && coop_ok "pi updated ($(pi --version 2>/dev/null || echo '?'))" || coop_warn "pi self-update failed"
  coop_info "pi update      (installed extensions)"
  pi update >/dev/null 2>&1 && coop_ok "extensions updated" || coop_warn "extension update failed"
else
  coop_warn "pi not installed — run: coop install"
fi

# --- 3. Upgrade pipx tools ---------------------------------------------------
coop_head "3/5  Coop tools + Fabric CLI (pipx)"
if have pipx; then
  for pkg in "${PY_TOOLS[@]}"; do
    if pipx list 2>/dev/null | grep -q "package $pkg "; then
      pipx upgrade "$pkg" >/dev/null 2>&1 && coop_ok "$pkg" || coop_warn "upgrade failed: $pkg"
    else
      coop_warn "$pkg not installed — run: coop install"
    fi
  done
  # fabric-cicd is a library injected into the Fabric CLI env — refresh it there.
  if pipx list 2>/dev/null | grep -q "package ms-fabric-cli "; then
    pipx inject ms-fabric-cli fabric-cicd --force >/dev/null 2>&1 && coop_ok "fabric-cicd (library) refreshed" || true
  fi
else
  coop_warn "pipx not installed — run: coop install"
fi

# --- 4. Sync vibes / skills / prompts / extension ----------------------------
coop_head "4/5  Sync brand assets"
"$COOP_ROOT/scripts/sync.sh" || coop_warn "sync reported issues"

# --- 5. Doctor ---------------------------------------------------------------
coop_head "5/5  Doctor"
"$COOP_ROOT/scripts/doctor.sh" || true

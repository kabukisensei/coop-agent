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
PI_CODING_AGENT_DIR="$(coop_pi_agent_dir)"; export PI_CODING_AGENT_DIR

# Overall-bar denominator: the update ITEMS we will attempt (pi update + each
# pipx tool). Steps 1/4/5 (git pull / sync / doctor) sit outside the bar, exactly
# as the install bar covers only its install items.
PROG_TOTAL=$(( 1 + ${#PY_TOOLS[@]} ))

# --- Per-item units ----------------------------------------------------------
# Each prints its final status message to stdout and returns 0 (✓) or non-zero (!).
# coop_unit runs these in the background, animates the active-item line, then ticks
# the overall bar — same contract as the install units.
_unit_pi_update() {
  have pi || { printf 'pi not installed — run: coop install'; return 1; }
  # `pi update --all` updates the agent AND every installed extension. (Bare
  # `pi update` updates pi ONLY; `--extensions` updates packages only.)
  if pi update --all >/dev/null 2>&1; then
    printf 'pi + extensions updated (%s)' "$(pi --version 2>/dev/null || echo '?')"; return 0
  fi
  printf 'pi update --all failed (try: pi update --all)'; return 1
}

_unit_pytool_upgrade() {  # $1 = package
  local pkg="$1"
  have pipx || { printf 'skipping %s (pipx missing) — run: coop install' "$pkg"; return 1; }
  if ! pipx list 2>/dev/null | grep -q "package $pkg "; then
    printf '%s not installed — run: coop install' "$pkg"; return 1
  fi
  if pipx upgrade "$pkg" >/dev/null 2>&1; then printf '%s' "$pkg"; return 0; fi
  printf 'upgrade failed: %s' "$pkg"; return 1
}

coop_head "coop update (v${COOP_VERSION})"

# --- 1. Update coop-agent itself ---------------------------------------------
coop_head "1/5  coop-agent repository"
if [ -d "$COOP_ROOT/.git" ] && have git; then
  if git -C "$COOP_ROOT" remote get-url origin >/dev/null 2>&1; then
    # Only uncommitted changes to TRACKED files can block a fast-forward pull; untracked
    # files (stray skills, downloaded drop-ins) are harmless and must NOT freeze updates
    # — `--untracked-files=no` excludes them. (git pull --ff-only still fails loudly on
    # its own if an incoming tracked file would actually overwrite an untracked one.)
    if [ -n "$(git -C "$COOP_ROOT" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
      coop_warn "uncommitted changes to tracked files in coop-agent — skipping 'git pull' (commit/stash first)."
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

# Pin the overall bar to the bottom for the update phase (steps 2–3); restore the
# cursor even on Ctrl-C. (coop_progress_end is idempotent, so the EXIT trap is a
# safe no-op once we've ended it explicitly after step 3.)
coop_progress_begin "$PROG_TOTAL"
trap 'coop_progress_end; _coop_unit_cleanup' EXIT INT TERM

# --- 2. Update Pi + extensions ----------------------------------------------
# (Windows guards this step against running sessions + leftover staging dirs in
# update.ps1; POSIX can replace open files, so no such guard is needed here.)
coop_head "2/5  Pi and extensions"
coop_unit "pi update --all   (the agent + all installed extensions)" _unit_pi_update

# --- 3. Upgrade pipx tools ---------------------------------------------------
coop_head "3/5  Coop tools + Fabric CLI (pipx)"
for pkg in "${PY_TOOLS[@]}"; do
  coop_unit "$pkg" _unit_pytool_upgrade "$pkg"
done

# Done with the update items — finalize the bar (leaves a permanent 100% line).
coop_progress_end

# fabric-cicd is a library injected into the Fabric CLI env — refresh it there.
if have pipx && pipx list 2>/dev/null | grep -q "package ms-fabric-cli "; then
  pipx inject ms-fabric-cli fabric-cicd --force >/dev/null 2>&1 && coop_ok "fabric-cicd (library) refreshed" || true
fi

# --- 4. Sync vibes / skills / prompts / extension ----------------------------
# sync also re-pins the extension tree's pi-ai/pi-tui to the (possibly just-updated)
# agent version, so the skew can't survive an update. Runs AFTER step 2 by design.
coop_head "4/5  Sync brand assets"
"$COOP_ROOT/scripts/sync.sh" || coop_warn "sync reported issues"

# --- 5. Doctor ---------------------------------------------------------------
coop_head "5/5  Doctor"
"$COOP_ROOT/scripts/doctor.sh" || true

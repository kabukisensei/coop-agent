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

NO_FABRIC=0
CHECK=0        # --check: dry-run — report current/latest/tested, change nothing
PI_LATEST=0    # --pi-latest: skip the tested-version gate and take latest Pi
for a in "$@"; do
  case "$a" in
    '') ;;
    --no-fabric) NO_FABRIC=1 ;;
    --yes|-y) export COOP_ASSUME_YES=1 ;;
    --check) CHECK=1 ;;
    --pi-latest) PI_LATEST=1 ;;
    *) coop_warn "update: ignoring unknown flag '$a'" ;;
  esac
done

# The Coop tools to upgrade. Fabric CLI is included unless --no-fabric (matching
# `coop install --no-fabric`), so a fabric-less machine doesn't report a perpetual
# failed item on every update.
PY_TOOLS=( coop-data-doc coop-sql-review coop-dax-review )
[ "$NO_FABRIC" = 0 ] && PY_TOOLS+=( ms-fabric-cli )

# Update coop's ISOLATED Pi agent dir (not the user's personal pi).
PI_CODING_AGENT_DIR="$(coop_pi_agent_dir)"; export PI_CODING_AGENT_DIR

# --- Tested-version guard ------------------------------------------------------
# coop's one real incident (#1) was a version-compat break: `coop update` jumped Pi to a
# new minor whose extension API coop's extensions weren't verified against. Guard the
# jump at the tested ceiling (config/defaults.yml tested_with.pi). PI_INSTALL_TARGET, when
# set, tells _unit_pi_update to PIN Pi to that version (extensions still update) instead
# of `pi update --all`.
PI_TESTED="$(coop_yaml_get "$COOP_ROOT/config/defaults.yml" tested_with.pi "")"
PI_INSTALL_TARGET=""
PI_PKG="@earendil-works/pi-coding-agent"

# Latest published Pi version. COOP_PI_LATEST_OVERRIDE short-circuits the registry query
# (tests set it; real runs hit npm). Echoes "" when it can't be determined.
_pi_latest() {
  if [ -n "${COOP_PI_LATEST_OVERRIDE:-}" ]; then printf '%s' "$COOP_PI_LATEST_OVERRIDE"; return 0; fi
  have npm || return 0
  npm view "$PI_PKG" version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

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
  if [ -n "$PI_INSTALL_TARGET" ]; then
    # The tested-version gate was declined: PIN Pi to the tested version (don't jump to an
    # untested minor), then still refresh extensions so those stay current.
    if have npm && npm install -g "$PI_PKG@$PI_INSTALL_TARGET" >/dev/null 2>&1; then
      pi update --extensions >/dev/null 2>&1 || true
      printf 'pinned pi to tested %s + extensions updated' "$PI_INSTALL_TARGET"; return 0
    fi
    printf 'failed to pin pi to %s (try: npm install -g %s@%s)' "$PI_INSTALL_TARGET" "$PI_PKG" "$PI_INSTALL_TARGET"; return 1
  fi
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

# --- coop update --check (dry-run: report versions, change NOTHING) ----------
if [ "$CHECK" = "1" ]; then
  coop_head "coop update --check (dry-run — nothing is installed)"
  pi_cur="$(coop_pi_version)"; [ -n "$pi_cur" ] || pi_cur="not installed"
  pi_lat="$(_pi_latest)"; [ -n "$pi_lat" ] || pi_lat="?"
  printf '  %-24s current %-13s latest %-13s tested %s\n' "pi ($PI_PKG)" "$pi_cur" "$pi_lat" "${PI_TESTED:-?}"
  if [ -n "$PI_TESTED" ] && coop_minor_newer "$pi_lat" "$PI_TESTED"; then
    coop_warn "latest Pi ($pi_lat) is a newer MINOR than tested ($PI_TESTED) — 'coop update' will ask before jumping (skip with --pi-latest, or decline to stay on the tested version)."
  fi
  for pkg in "${PY_TOOLS[@]}"; do
    key="$(printf '%s' "$pkg" | tr '-' '_')"
    tv="$(coop_yaml_get "$COOP_ROOT/config/defaults.yml" "tested_with.$key" "-")"
    cur="$(pipx list 2>/dev/null | grep -E "package $pkg " | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
    [ -n "$cur" ] || cur="not installed"
    printf '  %-24s current %-13s %-20s tested %s\n' "$pkg" "$cur" "" "$tv"
  done
  exit 0
fi

coop_head "coop update (v${COOP_VERSION})"

# Tested-version gate: if latest Pi crosses the tested MINOR and the user didn't pass
# --pi-latest, ask before jumping. Declining (or a non-interactive shell without --yes)
# pins Pi to the tested version instead — extensions still update. Runs before the bar so
# the decision is made before any install starts.
if have pi && [ -n "$PI_TESTED" ] && [ "$PI_LATEST" != "1" ]; then
  pi_lat="$(_pi_latest)"
  if [ -n "$pi_lat" ] && coop_minor_newer "$pi_lat" "$PI_TESTED"; then
    coop_warn "Pi $pi_lat is newer than coop's tested version ($PI_TESTED). New Pi minors have broken coop's extensions before (0.74 → 0.80)."
    if coop_confirm "Jump to the untested Pi $pi_lat anyway?"; then
      coop_info "Updating to the latest Pi $pi_lat (untested with this coop build)."
    else
      PI_INSTALL_TARGET="$PI_TESTED"
      coop_info "Staying on the tested Pi $PI_TESTED (extensions will still update). Re-run with --pi-latest to take $pi_lat."
    fi
  fi
fi

# Test seam: print the resolved gate decision and stop BEFORE any install or side effect.
if [ "${COOP_UPDATE_GATE_DRYRUN:-0}" = "1" ]; then
  if [ -n "$PI_INSTALL_TARGET" ]; then printf 'GATE pin:%s\n' "$PI_INSTALL_TARGET"; else printf 'GATE all\n'; fi
  exit 0
fi

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
  # A zip/shared-drive copy: Pi + pipx tools above still update, but the repo layer
  # (skills/prompts/guardrails/themes/scripts) is frozen forever — say so loudly.
  coop_warn "this coop-agent is not a git checkout — skills/prompts/guardrails will NEVER update" "fix: git clone the repo, then run ./bin/coop install from the clone (your ~/.coop settings carry over)"
fi

# Pin the overall bar to the bottom for the update phase (steps 2–3); restore the
# cursor even on Ctrl-C. (coop_progress_end is idempotent, so the EXIT trap is a
# safe no-op once we've ended it explicitly after step 3.)
coop_progress_begin "$PROG_TOTAL"
# EXIT restores the cursor + reaps the unit; INT/TERM ALSO exit (a bare trap would
# clean up but then let the script resume on Ctrl-C).
trap 'coop_progress_end; _coop_unit_cleanup' EXIT
trap 'coop_progress_end; _coop_unit_cleanup; exit 130' INT TERM

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
# Propagate doctor's verdict as the update's exit code (see install.sh) so a broken
# update is detectable by scripted callers; the steps above stay warn-and-continue.
coop_head "5/5  Doctor"
"$COOP_ROOT/scripts/doctor.sh"; DOCTOR_RC=$?
exit "$DOCTOR_RC"

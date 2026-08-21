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
EDGE=0         # --edge: take latest upstream instead of the release manifest
PI_LATEST=0    # --pi-latest: skip the tested-version gate and take latest Pi
for a in "$@"; do
  case "$a" in
    '') ;;
    --no-fabric) NO_FABRIC=1 ;;
    --yes|-y) export COOP_ASSUME_YES=1 ;;
    --check) CHECK=1 ;;
    --pi-latest) PI_LATEST=1 ;;
    --edge) EDGE=1 ;;
    *) coop_warn "update: ignoring unknown flag '$a'" ;;
  esac
done

# The Coop tools to upgrade. Fabric CLI is included unless --no-fabric (matching
# `coop install --no-fabric`), so a fabric-less machine doesn't report a perpetual
# failed item on every update.
PY_TOOLS=( coop-data-doc coop-sql-review coop-dax-review )
[ "$NO_FABRIC" = 0 ] && PY_TOOLS+=( ms-fabric-cli )
# Microsoft Fabric/Power BI authoring CLI packages (npm) — kept current by update.
PBIH_NPM_TOOLS=( @microsoft/powerbi-report-authoring-cli @microsoft/powerbi-modeling-mcp )
case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|CYGWIN*|MSYS*|Windows*|windows*) PBIH_NPM_TOOLS+=( @microsoft/powerbi-desktop-bridge-cli ) ;;
esac

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

# Latest published version of a pipx/PyPI tool (coop-data-doc, ms-fabric-cli, …).
# COOP_PYPI_LATEST_OVERRIDE short-circuits the registry query (tests set it; real
# runs query PyPI). Echoes "" when it can't be determined — a hiccup never trips
# the gate. Uses coop_python (pipx implies a python is present).
_pypi_latest() {
  local pkg="$1" py
  if [ -n "${COOP_PYPI_LATEST_OVERRIDE:-}" ]; then printf '%s' "$COOP_PYPI_LATEST_OVERRIDE"; return 0; fi
  py="$(coop_python)" || return 0
  "$py" - "$pkg" 2>/dev/null <<'PYEOF'
import json, sys, urllib.request
try:
    info = json.load(urllib.request.urlopen(
        "https://pypi.org/pypi/%s/json" % sys.argv[1], timeout=15))
    print(info["info"]["version"])
except Exception:
    pass
PYEOF
}

# Overall-bar denominator: the update ITEMS we will attempt (pi update + each
# pipx tool + Power BI/Fabric authoring npm tools). Steps 1/4/5 (git pull /
# sync / doctor) sit outside the bar, exactly as the install bar covers only
# its install items.
PROG_TOTAL=$(( 1 + ${#PY_TOOLS[@]} + 1 ))

# --- Per-item units ----------------------------------------------------------
# Each prints its final status message to stdout and returns 0 (✓) or non-zero (!).
# coop_unit runs these in the background, animates the active-item line, then ticks
# the overall bar — same contract as the install units.
_unit_pi_update() {
  have pi || { printf 'pi not installed — run: coop install'; return 1; }
  if [ "$EDGE" = 1 ]; then
    if pi update --all >/dev/null 2>&1; then
      printf 'pi + extensions updated (edge) (%s)' "$(pi --version 2>/dev/null || echo '?')"; return 0
    fi
    printf 'pi update --all failed (try: pi update --all)'; return 1
  fi
  # Default (reproducible): pin Pi to the release manifest, then refresh extensions.
  local pi_target
  pi_target="$(coop_manifest_get pi.version)"
  if [ -z "$pi_target" ]; then pi_target="$PI_INSTALL_TARGET"; fi
  if [ -n "$pi_target" ]; then
    if have npm && npm install -g "$PI_PKG@$pi_target" >/dev/null 2>&1; then
      pi update --extensions >/dev/null 2>&1 || true
      printf 'pinned pi to tested %s + extensions updated' "$pi_target"; return 0
    fi
    printf 'failed to pin pi to %s (try: npm install -g %s@%s)' "$pi_target" "$PI_PKG" "$pi_target"; return 1
  fi
  # No manifest pin and no gate decision: fall back to `pi update --all`.
  if pi update --all >/dev/null 2>&1; then
    printf 'pi + extensions updated (%s)' "$(pi --version 2>/dev/null || echo '?')"; return 0
  fi
  printf 'pi update --all failed (try: pi update --all)'; return 1
}

_unit_pytool_upgrade() {  # $1 = package
  local pkg="$1" pin=""
  if [ "$EDGE" != 1 ]; then
    pin="$(coop_manifest_get "python_tools.$pkg")"
  fi
  have pipx || { printf 'skipping %s (pipx missing) — run: coop install' "$pkg"; return 1; }
  if ! pipx list 2>/dev/null | grep -q "package $pkg "; then
    printf '%s not installed — run: coop install' "$pkg"; return 1
  fi
  if [ -n "$pin" ]; then
    if pipx install --force "$pkg==$pin" >/dev/null 2>&1; then printf 'pinned %s to tested %s' "$pkg" "$pin"; return 0; fi
    printf 'failed to pin %s to %s (try: pipx install --force %s==%s)' "$pkg" "$pin" "$pkg" "$pin"; return 1
  fi
  if pipx upgrade "$pkg" >/dev/null 2>&1; then printf '%s' "$pkg"; return 0; fi
  printf 'upgrade failed: %s' "$pkg"; return 1
}

_unit_pbih_tools_upgrade() {
  have npm || { printf 'skipping Power BI/Fabric authoring tools (npm missing)'; return 1; }
  local pkg ok=0 fail=0 spec
  for pkg in "${PBIH_NPM_TOOLS[@]}"; do
    spec="$pkg"
    if [ "$EDGE" != 1 ]; then
      local ver
      ver="$(coop_manifest_get "npm_tools.$pkg")"
      [ -n "$ver" ] && spec="${pkg}@${ver}"
    fi
    if npm ls -g --depth=0 "$pkg" >/dev/null 2>&1; then
      npm install -g "$spec" >/dev/null 2>&1 && ok=$((ok+1)) || fail=$((fail+1))
    else
      # Never installed (machine predates these tools) — install rather than fail.
      npm install -g "$spec" >/dev/null 2>&1 && ok=$((ok+1)) || fail=$((fail+1))
    fi
  done
  if [ "$fail" -eq 0 ]; then printf '%d Power BI/Fabric authoring tool(s) updated' "$ok"; return 0; fi
  printf '%d updated, %d failed' "$ok" "$fail"; return 1
}

# --- coop update --check (dry-run: report versions, change NOTHING) ----------
if [ "$CHECK" = "1" ]; then
  coop_head "coop update --check (dry-run — nothing is installed)"
  pi_cur="$(coop_pi_version)"; [ -n "$pi_cur" ] || pi_cur="not installed"
  pi_exp="$(coop_manifest_get pi.version)"; [ -n "$pi_exp" ] || pi_exp="?"
  printf '  %-32s current %-13s expected %-13s status %s\n' "pi ($PI_PKG)" "$pi_cur" "$pi_exp" "$(coop_manifest_status "$pi_cur" "$pi_exp")"
  for pkg in "${PY_TOOLS[@]}"; do
    tv="$(coop_manifest_get "python_tools.$pkg")"; [ -n "$tv" ] || tv="?"
    cur="$(pipx list 2>/dev/null | grep -E "package $pkg " | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
    [ -n "$cur" ] || cur="not installed"
    printf '  %-32s current %-13s expected %-13s status %s\n' "$pkg" "$cur" "$tv" "$(coop_manifest_status "$cur" "$tv")"
  done
  for pkg in "${PBIH_NPM_TOOLS[@]}"; do
    tv="$(coop_manifest_get "npm_tools.$pkg")"; [ -n "$tv" ] || tv="?"
    cur="$(npm ls -g --depth=0 "$pkg" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[^ ]*' | head -1)"
    [ -n "$cur" ] || cur="not installed"
    printf '  %-32s current %-13s expected %-13s status %s\n' "$pkg" "$cur" "$tv" "$(coop_manifest_status "$cur" "$tv")"
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

# --- Tested-version gate, pipx tools + fabric-cicd ------------------------------
# Same rule as Pi, for the pipx tools we upgrade and the fabric-cicd library we
# inject: a release crossing the tested MINOR asks first; declining (or a
# non-interactive shell without --yes) pins that tool to its tested version. The
# pins land in PY_PIN ("pkg=ver" pairs) and FCC_PIN for the refresh step below.
PY_PIN=''
for pkg in "${PY_TOOLS[@]}"; do
  key="$(printf '%s' "$pkg" | tr '-' '_')"
  tested="$(coop_yaml_get "$COOP_ROOT/config/defaults.yml" "tested_with.$key" "")"
  [ -n "$tested" ] || continue
  lat="$(_pypi_latest "$pkg")"
  if [ -n "$lat" ] && coop_minor_newer "$lat" "$tested"; then
    coop_warn "$pkg $lat is newer than coop's tested version ($tested)."
    if coop_confirm "Jump to the untested $pkg $lat anyway?"; then
      coop_info "Updating to the latest $pkg $lat (untested with this coop build)."
    else
      PY_PIN="$PY_PIN $pkg=$tested"
      coop_info "Staying on the tested $pkg $tested. Re-run with --yes to take $lat."
    fi
  fi
done
FCC_PIN=''
if have pipx && pipx list 2>/dev/null | grep -q "package ms-fabric-cli "; then
  fcc_tested="$(coop_yaml_get "$COOP_ROOT/config/defaults.yml" tested_with.fabric_cicd "")"
  if [ -n "$fcc_tested" ]; then
    fcc_lat="$(_pypi_latest fabric-cicd)"
    if [ -n "$fcc_lat" ] && coop_minor_newer "$fcc_lat" "$fcc_tested"; then
      coop_warn "fabric-cicd $fcc_lat is newer than coop's tested version ($fcc_tested)."
      if coop_confirm "Jump to the untested fabric-cicd $fcc_lat anyway?"; then
        coop_info "Updating to the latest fabric-cicd $fcc_lat (untested with this coop build)."
      else
        FCC_PIN="$fcc_tested"
        coop_info "Staying on the tested fabric-cicd $fcc_tested."
      fi
    fi
  fi
fi

# Test seam: print the resolved gate decision and stop BEFORE any install or side effect.
if [ "${COOP_UPDATE_GATE_DRYRUN:-}" = "1" ]; then
  if [ "$EDGE" = "1" ]; then
    echo "GATE all"
    exit 0
  fi
  pins="$PI_INSTALL_TARGET"
  for p in $PY_PIN; do pins="${pins:+$pins,}$p"; done
  [ -n "$FCC_PIN" ] && pins="${pins:+$pins,}fabric-cicd=$FCC_PIN"
  if [ -n "$pins" ]; then printf 'GATE pin:%s\n' "$pins"; else printf 'GATE all\n'; fi
  exit 0
fi

# --- 1. Update coop-agent itself ---------------------------------------------
coop_head "1/6  coop-agent repository"
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
coop_head "2/6  Pi and extensions"
coop_unit "pi update --all   (the agent + all installed extensions)" _unit_pi_update

# --- 3. Upgrade pipx tools ---------------------------------------------------
coop_head "3/6  Coop tools + Fabric CLI (pipx)"
for pkg in "${PY_TOOLS[@]}"; do
  pin=''
  for p in $PY_PIN; do case "$p" in "$pkg="*) pin="${p#*=}" ;; esac; done
  coop_unit "$pkg" _unit_pytool_upgrade "$pkg" "$pin"
done

# --- 4. Upgrade Microsoft Fabric / Power BI authoring tools (npm) ------------
coop_head "4/6  Fabric / Power BI authoring tools"
coop_unit "Power BI/Fabric authoring tools" _unit_pbih_tools_upgrade
hash -r 2>/dev/null || true

# Done with the update items — finalize the bar (leaves a permanent 100% line).
coop_progress_end

# fabric-cicd is a library injected into the Fabric CLI env — refresh it there (or
# pin it to the tested version when the update gate declined a jump).
if have pipx && pipx list 2>/dev/null | grep -q "package ms-fabric-cli "; then
  if [ -n "$FCC_PIN" ]; then
    pipx inject ms-fabric-cli "fabric-cicd==$FCC_PIN" --force >/dev/null 2>&1 && coop_ok "fabric-cicd (library) pinned to tested $FCC_PIN" || true
  else
    pipx inject ms-fabric-cli fabric-cicd --force >/dev/null 2>&1 && coop_ok "fabric-cicd (library) refreshed" || true
  fi
fi

# --- 5. Sync vibes / skills / prompts / extension ----------------------------
# sync also re-pins the extension tree's pi-ai/pi-tui to the (possibly just-updated)
# agent version, so the skew can't survive an update. Runs AFTER step 2 by design.
coop_head "5/6  Sync brand assets"
"$COOP_ROOT/scripts/sync.sh" || coop_warn "sync reported issues"

# --- 6. Doctor ---------------------------------------------------------------
# Propagate doctor's verdict as the update's exit code (see install.sh) so a broken
# update is detectable by scripted callers; the steps above stay warn-and-continue.
coop_head "6/6  Doctor"
"$COOP_ROOT/scripts/doctor.sh"; DOCTOR_RC=$?
exit "$DOCTOR_RC"

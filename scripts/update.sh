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
for a in "$@"; do
  case "$a" in
    '') ;;
    --no-fabric) NO_FABRIC=1 ;;
    --yes|-y) export COOP_ASSUME_YES=1 ;;
    --check) CHECK=1 ;;
    --pi-latest) coop_warn "--pi-latest is deprecated — use --edge (normal update always pins to the release manifest)"; EDGE=1 ;;
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

# --- Fleet mode -----------------------------------------------------------------
# Exactly two modes: NORMAL pins Pi + every extension/tool to the release manifest
# (no registry queries, no prompts); --edge takes latest upstream across the fleet.
# The old tested-version gates (--pi-latest / "Jump to the untested …?" prompts) are
# gone: they queried latest versions merely to ask about them, and normal update
# resolved back to manifest pins anyway.
PI_PKG="@earendil-works/pi-coding-agent"

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
  # Default (reproducible): pin Pi and install every exact manifest extension spec.
  local pi_target ext spec failed=0
  pi_target="$(coop_manifest_get pi.version)"
  if [ -n "$pi_target" ]; then
    if have npm && npm install -g "$PI_PKG@$pi_target" >/dev/null 2>&1; then
      for ext in $(coop_manifest_keys extensions); do
        spec="$(coop_manifest_extension_spec "$ext")"
        [ -n "$spec" ] && pi install "$spec" >/dev/null 2>&1 || failed=1
      done
      [ "$failed" = 0 ] && { printf 'pinned pi and extensions to release manifest'; return 0; }
      printf 'pi pinned but one or more manifest extensions failed'; return 1
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
  local pkg="$1" pin="" fabric_py=""
  if [ "$EDGE" != 1 ]; then
    pin="$(coop_manifest_get "python_tools.$pkg")"
  fi
  have pipx || { printf 'skipping %s (pipx missing) — run: coop install' "$pkg"; return 1; }
  # Do not use grep -q under pipefail: it can close the pipe after an early
  # match, SIGPIPE pipx, and turn a real installed package into a false miss.
  local installed=0
  pipx list 2>/dev/null | grep "package $pkg " >/dev/null && installed=1
  if [ "$pkg" = "ms-fabric-cli" ]; then
    fabric_py="$(coop_fabric_python)" || {
      printf 'ms-fabric-cli needs Python 3.12 or 3.13 — install one, then re-run: coop update'
      return 1
    }
  fi
  if [ -n "$pin" ]; then
    if [ -n "$fabric_py" ]; then
      if pipx install --force --python "$fabric_py" "$pkg==$pin" >/dev/null 2>&1; then printf 'pinned %s to tested %s (Python %s)' "$pkg" "$pin" "$fabric_py"; return 0; fi
      printf 'failed to pin %s to %s (try: pipx install --force --python "%s" %s==%s)' "$pkg" "$pin" "$fabric_py" "$pkg" "$pin"; return 1
    fi
    if pipx install --force "$pkg==$pin" >/dev/null 2>&1; then printf 'pinned %s to tested %s' "$pkg" "$pin"; return 0; fi
    printf 'failed to pin %s to %s (try: pipx install --force %s==%s)' "$pkg" "$pin" "$pkg" "$pin"; return 1
  fi
  if [ "$installed" = 0 ]; then
    if pipx install "$pkg" >/dev/null 2>&1; then printf 'installed missing %s' "$pkg"; return 0; fi
    printf 'failed to install missing %s' "$pkg"; return 1
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

# Test seam: print the resolved fleet-mode decision and stop BEFORE any install or
# side effect. Normal mode pins everything to the release manifest; --edge takes latest.
if [ "${COOP_UPDATE_GATE_DRYRUN:-}" = "1" ]; then
  if [ "$EDGE" = "1" ]; then
    echo "GATE all"
    exit 0
  fi
  pi_pin="$(coop_manifest_get pi.version)"
  if [ -n "$pi_pin" ]; then printf 'GATE pin:%s\n' "$pi_pin"; else printf 'GATE all\n'; fi
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
UPDATE_FAILURES=0
# EXIT restores the cursor + reaps the unit; INT/TERM ALSO exit (a bare trap would
# clean up but then let the script resume on Ctrl-C).
trap 'coop_progress_end; _coop_unit_cleanup' EXIT
trap 'coop_progress_end; _coop_unit_cleanup; exit 130' INT TERM

# `coop update` is also the repair path for an incomplete workstation. If the
# Fabric CLI cannot run under the default Python (notably Python 3.14), add a
# supported side-by-side interpreter before converging the pipx fleet.
if ! coop_fabric_python >/dev/null 2>&1; then
  if [ "$(uname -s 2>/dev/null)" = "Darwin" ] && have brew; then
    coop_info "Microsoft Fabric CLI needs Python 3.10–3.13; installing Python 3.12…"
    brew install python@3.12 >/dev/null 2>&1 || true
    _fabric_lib="$(brew --prefix python@3.12 2>/dev/null)/libexec/bin"
    [ -d "$_fabric_lib" ] && PATH="$_fabric_lib:$PATH"
    unset _fabric_lib
  elif have apt-get; then
    coop_info "Microsoft Fabric CLI needs Python 3.10–3.13; installing a compatible Python…"
    (sudo apt-get update -y && (sudo apt-get install -y python3.13 python3.13-venv || sudo apt-get install -y python3.12 python3.12-venv)) >/dev/null 2>&1 \
      || (apt-get install -y python3.13 python3.13-venv || apt-get install -y python3.12 python3.12-venv) >/dev/null 2>&1 || true
  elif have dnf; then
    coop_info "Microsoft Fabric CLI needs Python 3.10–3.13; installing a compatible Python…"
    (sudo dnf install -y python3.13 || sudo dnf install -y python3.12) >/dev/null 2>&1 \
      || (dnf install -y python3.13 || dnf install -y python3.12) >/dev/null 2>&1 || true
  fi
  hash -r 2>/dev/null || true
fi

# --- 2. Update Pi + extensions ----------------------------------------------
# (Windows guards this step against running sessions + leftover staging dirs in
# update.ps1; POSIX can replace open files, so no such guard is needed here.)
coop_head "2/6  Pi and extensions"
coop_unit "pi update --all   (the agent + all installed extensions)" _unit_pi_update \
  || UPDATE_FAILURES=$((UPDATE_FAILURES + 1))

# --- 3. Upgrade pipx tools ---------------------------------------------------
coop_head "3/6  Coop tools + Fabric CLI (pipx)"
for pkg in "${PY_TOOLS[@]}"; do
  # _unit_pytool_upgrade pins from the release manifest in normal mode; --edge takes latest.
  coop_unit "$pkg" _unit_pytool_upgrade "$pkg" \
    || UPDATE_FAILURES=$((UPDATE_FAILURES + 1))
done

# --- 4. Upgrade Microsoft Fabric / Power BI authoring tools (npm) ------------
coop_head "4/6  Fabric / Power BI authoring tools"
coop_unit "Power BI/Fabric authoring tools" _unit_pbih_tools_upgrade \
  || UPDATE_FAILURES=$((UPDATE_FAILURES + 1))
hash -r 2>/dev/null || true

# Done with the update items — finalize the bar (leaves a permanent 100% line).
coop_progress_end

# fabric-cicd is a library injected into the Fabric CLI env. Normal mode always
# uses the manifest pin; edge mode alone may take latest.
FCC_PIN=''
if [ "$EDGE" != 1 ]; then FCC_PIN="$(coop_manifest_object_get python_tools fabric-cicd)"; fi
if have pipx && pipx list 2>/dev/null | grep "package ms-fabric-cli " >/dev/null; then
  if [ -n "$FCC_PIN" ]; then
    if pipx inject ms-fabric-cli "fabric-cicd==$FCC_PIN" --force >/dev/null 2>&1; then
      coop_ok "fabric-cicd (library) pinned to tested $FCC_PIN"
    else
      coop_warn "failed to pin fabric-cicd to $FCC_PIN in the ms-fabric-cli environment"
      UPDATE_FAILURES=$((UPDATE_FAILURES + 1))
    fi
  else
    if pipx inject ms-fabric-cli fabric-cicd --force >/dev/null 2>&1; then
      coop_ok "fabric-cicd (library) refreshed"
    else
      coop_warn "failed to refresh fabric-cicd in the ms-fabric-cli environment"
      UPDATE_FAILURES=$((UPDATE_FAILURES + 1))
    fi
  fi
fi
[ "${COOP_FLEET_TEST_MODE:-0}" = 1 ] && { [ "$UPDATE_FAILURES" -eq 0 ]; exit $?; }

# --- 5. Sync vibes / skills / prompts / extension ----------------------------
# sync also re-pins the extension tree's pi-ai/pi-tui to the (possibly just-updated)
# agent version, so the skew can't survive an update. Runs AFTER step 2 by design.
coop_head "5/6  Sync brand assets"
if ! "$COOP_ROOT/scripts/sync.sh"; then
  coop_warn "sync reported issues"
  UPDATE_FAILURES=$((UPDATE_FAILURES + 1))
fi

# --- 6. Doctor ---------------------------------------------------------------
# Propagate doctor's verdict as the update's exit code (see install.sh) so a broken
# update is detectable by scripted callers; the steps above stay warn-and-continue.
coop_head "6/6  Doctor"
"$COOP_ROOT/scripts/doctor.sh"; DOCTOR_RC=$?
if [ "$DOCTOR_RC" -ne 0 ] || [ "$UPDATE_FAILURES" -ne 0 ]; then
  [ "$UPDATE_FAILURES" -gt 0 ] && coop_warn "update finished with $UPDATE_FAILURES failed convergence step(s) — see warnings above"
  exit 1
fi
exit 0

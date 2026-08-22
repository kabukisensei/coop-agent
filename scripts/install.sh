#!/usr/bin/env bash
#
# coop install / bootstrap — set up the whole Cooptimize stack on a fresh machine.
# Idempotent: safe to re-run. Non-fatal where it can be (warns and keeps going),
# so `coop doctor` can report whatever is still missing at the end.
#
#   Flags:
#     --force        Reinstall pi tools / pipx packages even if already present
#     --no-fabric    Skip installing the Microsoft Fabric CLI (ms-fabric-cli)
#     --no-prereqs   Skip auto-installing missing system prerequisites
#     --yes, -y      Assume yes for prompts
#
set -uo pipefail

COOP_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
export COOP_ROOT
# shellcheck source=../lib/common.sh
. "$COOP_ROOT/lib/common.sh"

FORCE=0; NO_FABRIC=0; NO_PREREQS=0; EDGE=0
for a in "$@"; do
  case "$a" in
    '') ;;                                            # ignore blank args (launchers can pass one)
    --force) FORCE=1 ;;
    --no-fabric) NO_FABRIC=1 ;;
    --no-prereqs) NO_PREREQS=1 ;;
    --edge) EDGE=1 ;;
    --yes|-y) export COOP_ASSUME_YES=1 ;;
    *) coop_warn "install: ignoring unknown flag '$a'" ;;
  esac
done

# --- What we install (release manifest is the single source of truth) ----------
PI_NPM_PACKAGE="$(coop_manifest_get pi.package || echo "@earendil-works/pi-coding-agent")"
PI_TARGET_VERSION="$(coop_manifest_get pi.version)"
PI_EXTENSIONS=(
  "npm:pi-mcp-adapter"        # MCP servers (Fabric / Power BI / Microsoft Learn / context-mode)
  "npm:pi-hermes-memory"      # persistent memory + session search + secret scanning
  "npm:pi-better-openai"      # plan usage limits (5h/7d) — shown in coop's footer
  "npm:pi-web-access"         # web search / URL fetch / GitHub clone / PDF / video (read-only)
  "npm:@juicesharp/rpiv-ask-user-question"  # structured questions the model can ask (consent rounds)
  "npm:context-mode"        # context compaction MCP/extension
)
PY_TOOLS=( coop-data-doc coop-sql-review coop-dax-review )
FABRIC_PKG="ms-fabric-cli"
# Microsoft Fabric/Power BI authoring CLI packages (npm). powerbi-desktop-bridge
# requires Power BI Desktop on Windows, so it is installed only there.
PBIH_NPM_TOOLS=( @microsoft/powerbi-report-authoring-cli @microsoft/powerbi-modeling-mcp )
OS="$(uname -s 2>/dev/null || echo unknown)"
case "$OS" in
  MINGW*|CYGWIN*|MSYS*|Windows*|windows*) PBIH_NPM_TOOLS+=( @microsoft/powerbi-desktop-bridge-cli ) ;;
esac

# Install/operate against coop's ISOLATED Pi agent dir so nothing mixes with the
# user's personal `pi`. Every `pi` call below (and the sync/doctor it runs) inherits it.
PI_CODING_AGENT_DIR="$(coop_pi_agent_dir)"; export PI_CODING_AGENT_DIR
mkdir -p "$PI_CODING_AGENT_DIR"

# Overall-bar denominator: the install ITEMS we will attempt (pipx + pi + each
# extension + each coop tool + Power BI/Fabric authoring tools, plus Fabric unless --no-fabric).
PROG_TOTAL=$(( 2 + ${#PI_EXTENSIONS[@]} + ${#PY_TOOLS[@]} + 1 ))
[ "$NO_FABRIC" = 0 ] && PROG_TOTAL=$(( PROG_TOTAL + 1 ))

# --- Per-item units ----------------------------------------------------------
# Each prints its final status message to stdout and returns 0 (✓) or non-zero (!).
# coop_unit runs these in the background, animates the active-item line, then ticks
# the overall bar. They run in a subshell, so they see the vars above but cannot
# mutate the parent's command hash — callers run `hash -r` after install units.
_unit_pipx() {
  if have pipx; then printf 'pipx present'; return 0; fi
  # coop_python accepts `python3` OR `python` (mirror of doctor.sh + install.ps1's
  # resolver) — a python-only host must still get pipx installed.
  local py
  if py="$(coop_python)"; then
    if "$py" -m pip install --user pipx >/dev/null 2>&1 && "$py" -m pipx ensurepath >/dev/null 2>&1; then
      printf 'pipx installed (open a new shell for PATH changes)'; return 0
    fi
    printf 'could not install pipx automatically — see https://pipx.pypa.io'; return 1
  fi
  printf 'skipping pipx (python missing)'; return 1
}

_unit_pi() {
  local spec="$PI_NPM_PACKAGE"
  if [ "$EDGE" != 1 ] && [ -n "$PI_TARGET_VERSION" ]; then spec="${PI_NPM_PACKAGE}@${PI_TARGET_VERSION}"; fi
  if have pi; then
    local cur
    cur="$(pi --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
    # Convergence: missing -> install exact; == manifest -> skip;
    # != manifest -> force-install exact; --force -> reinstall exact.
    if [ "$FORCE" = 0 ] && [ -n "$cur" ]; then
      if [ "$EDGE" = 1 ]; then
        # Edge means upstream/latest for EXISTING installs too.
        if have npm && npm install -g "$PI_NPM_PACKAGE" >/dev/null 2>&1; then
          printf 'pi updated to latest (%s)' "$(pi --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo '?')"
          return 0
        fi
        printf 'failed to update pi to latest (npm install -g %s)' "$PI_NPM_PACKAGE"; return 1
      fi
      if [ "${PI_TARGET_VERSION:-}" != "" ] && [ "$cur" = "$PI_TARGET_VERSION" ]; then
        printf 'pi %s matches manifest' "$cur"; return 0
      fi
      if [ -n "${PI_TARGET_VERSION:-}" ]; then
        if have npm && npm install -g "$spec" >/dev/null 2>&1; then
          printf 'pi converged %s -> %s' "${cur:-?}" "$PI_TARGET_VERSION"; return 0
        fi
        printf 'failed to converge pi to %s (try: npm install -g %s)' "$spec" "$spec"; return 1
      fi
      printf 'pi present (%s) — no manifest pin' "$cur"; return 0
    fi
  fi
  if have npm; then
    if npm install -g "$spec" >/dev/null 2>&1; then printf 'pi installed (%s)' "$spec"; return 0; fi
    printf 'npm install of pi failed — try: npm install -g %s' "$spec"; return 1
  fi
  printf 'cannot install pi (npm missing) — install Node.js, then re-run: coop install'; return 1
}

_unit_ext() {  # $1 = extension spec
  local ext="$1" pkg="${1#npm:}" spec pinned
  spec="$ext"
  if [ "$EDGE" != 1 ]; then
    pinned="$(coop_manifest_extension_spec "$pkg")"
    [ -n "$pinned" ] && spec="$pinned"
  fi
  have pi || { printf 'skipped %s (pi not installed)' "$spec"; return 1; }
  if pi install "$spec" >/dev/null 2>&1; then printf '%s' "$spec"; return 0; fi
  printf 'could not install %s (continuing)' "$spec"; return 1
}

# Installed version of a pipx-managed package, or "" when absent/unknown.
_pipx_installed_version() {
  local pkg="$1"
  have pipx || return 0
  pipx list 2>/dev/null | grep -iE "package ${pkg} " | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

_unit_fabric() {
  have pipx || { printf 'skipping Fabric CLI (pipx missing)'; return 1; }
  local target="$FABRIC_PKG"
  if [ "$EDGE" != 1 ]; then
    local ver
    ver="$(coop_manifest_get "python_tools.$FABRIC_PKG")"
    [ -n "$ver" ] && target="${FABRIC_PKG}==${ver}"
  fi
  # Convergence: skip only when the installed version matches the pin.
  if [ "$FORCE" = 0 ]; then
    local cur=""; cur="$(_pipx_installed_version "$FABRIC_PKG")"
    if [ -n "$cur" ]; then
      if [ "$EDGE" = 1 ]; then
        # Edge means upstream/latest for EXISTING installs too.
        pipx upgrade "$FABRIC_PKG" >/dev/null 2>&1 || true
      elif [ -n "${ver:-}" ] && [ "$cur" != "$ver" ]; then
        if ! pipx install --force "$target" >/dev/null 2>&1; then
          printf 'failed to converge %s to %s' "$FABRIC_PKG" "$ver"; return 1
        fi
        coop_info "converged $FABRIC_PKG $cur -> $ver"
      fi
    else
      pipx install "$target" >/dev/null 2>&1 || true
    fi
  else
    pipx install --force "$target" >/dev/null 2>&1 || { printf 'failed to reinstall %s (%s)' "$FABRIC_PKG" "$target"; return 1; }
  fi
  # fabric-cicd is a Python LIBRARY (no CLI), used for deploy validation — inject it
  # into the Fabric CLI's env so it's importable alongside `fab`. (doctor verifies it.)
  local fcc="fabric-cicd"
  if [ "$EDGE" != 1 ]; then
    local fcc_ver
    fcc_ver="$(coop_manifest_object_get python_tools fabric-cicd)"
    [ -n "$fcc_ver" ] && fcc="fabric-cicd==${fcc_ver}"
  fi
  pipx inject "$FABRIC_PKG" "$fcc" >/dev/null 2>&1 || true
  hash -r 2>/dev/null || true
  # A failed convergence must not read as success just because an OLD fab binary
  # is still on PATH — verify the installed version actually matches the pin.
  if [ "$EDGE" != 1 ] && [ -n "${ver:-}" ]; then
    local now=""; now="$(_pipx_installed_version "$FABRIC_PKG")"
    if [ "$now" != "$ver" ]; then
      printf 'Fabric CLI remains at %s; expected %s' "${now:-none}" "$ver"; return 1
    fi
  fi
  if have fab; then
    if fab --version 2>&1 | grep -qiE 'paramiko|invoke'; then
      printf "'fab' is Python Fabric (SSH), not Microsoft Fabric CLI — put the pipx bin dir first on PATH, then: fab --version"; return 1
    fi
    printf 'Microsoft Fabric CLI ready (%s)' "$(fab --version 2>/dev/null | head -1)"; return 0
  fi
  printf "ms-fabric-cli installed but 'fab' not on PATH yet — open a new shell (pipx ensurepath)"; return 1
}

_unit_pytool() {  # $1 = package
  local pkg="$1"
  local target="$pkg"
  if [ "$EDGE" != 1 ]; then
    local ver
    ver="$(coop_manifest_get "python_tools.$pkg")"
    [ -n "$ver" ] && target="${pkg}==${ver}"
  fi
  have pipx || { printf 'skipping %s (pipx missing)' "$pkg"; return 1; }
  local installed="" ; installed="$(_pipx_installed_version "$pkg")"
  local expected="" ; [ "$EDGE" != 1 ] && expected="$(coop_manifest_get "python_tools.$pkg")"
  # Convergence: skip only when the installed version matches the manifest pin.
  if [ "$FORCE" = 0 ] && [ -n "$installed" ]; then
    if [ "$EDGE" = 1 ]; then
      # Edge means upstream/latest for EXISTING installs too.
      if pipx upgrade "$pkg" >/dev/null 2>&1; then
        printf '%s updated to latest (%s)' "$pkg" "$(_pipx_installed_version "$pkg" || echo '?')"
        return 0
      fi
      printf 'failed to upgrade %s to latest' "$pkg"; return 1
    fi
    if [ -z "$expected" ]; then printf '%s present (%s) — no manifest pin' "$pkg" "$installed"; return 0; fi
    if [ "$installed" = "$expected" ]; then printf '%s %s matches manifest' "$pkg" "$installed"; return 0; fi
    if pipx install --force "$target" >/dev/null 2>&1; then
      printf '%s converged %s -> %s' "$pkg" "$installed" "$expected"; return 0
    fi
    printf 'failed to converge %s to %s' "$pkg" "$expected"; return 1
  fi
  if [ "$FORCE" = 1 ]; then
    if pipx install --force "$target" >/dev/null 2>&1; then printf '%s (installed)' "$pkg"; return 0; fi
    printf 'failed: %s' "$pkg"; return 1
  fi
  if pipx install "$target" >/dev/null 2>&1; then printf '%s (installed)' "$pkg"; return 0; fi
  printf 'could not install %s' "$pkg"; return 1
}

_unit_pbih_tools() {
  have npm || { printf 'skipping Power BI/Fabric authoring tools (npm missing)'; return 1; }
  local pkg ok=0 fail=0 spec
  for pkg in "${PBIH_NPM_TOOLS[@]}"; do
    spec="$pkg"
    if [ "$EDGE" != 1 ]; then
      local key="$pkg"
      local ver
      ver="$(coop_manifest_get "npm_tools.$key")"
      [ -n "$ver" ] && spec="${pkg}@${ver}"
    fi
    if [ "$FORCE" = 1 ]; then
      npm install -g "$spec" >/dev/null 2>&1 && ok=$((ok+1)) || fail=$((fail+1))
    else
      if npm install -g "$spec" >/dev/null 2>&1; then ok=$((ok+1))
      elif npm update -g "$spec" >/dev/null 2>&1; then ok=$((ok+1))
      else fail=$((fail+1)); fi
    fi
  done
  if [ "$fail" -eq 0 ]; then printf '%d Power BI/Fabric authoring tool(s) ready' "$ok"; return 0; fi
  printf '%d installed, %d failed' "$ok" "$fail"; return 1
}

coop_head "Cooptimize agent bootstrap (v${COOP_VERSION})  [$OS]"

# Pin the overall bar to the bottom for the install phase; restore the cursor even
# on Ctrl-C. (coop_progress_end is idempotent, so the EXIT trap is a safe no-op
# once we've ended it explicitly after step 5.)
coop_progress_begin "$PROG_TOTAL"
# EXIT restores the cursor + reaps the unit; INT/TERM ALSO exit (a bare trap would
# clean up but then let the script resume and keep mutating the machine on Ctrl-C).
trap 'coop_progress_end; _coop_unit_cleanup' EXIT
trap 'coop_progress_end; _coop_unit_cleanup; exit 130' INT TERM

# --- 1. Prerequisites (auto-install missing tools if package manager is available)
coop_head "1/8  Prerequisites"

# Git
if [ "$NO_PREREQS" != 1 ] && ! have git; then
  if [ "$(uname -s 2>/dev/null)" = "Darwin" ] && have brew; then
    coop_info "installing git via brew…"
    brew install git >/dev/null 2>&1 || true
  elif have apt-get; then
    coop_info "installing git via apt…"
    (sudo apt-get update -y && sudo apt-get install -y git) >/dev/null 2>&1 || apt-get install -y git >/dev/null 2>&1 || true
  elif have dnf; then
    coop_info "installing git via dnf…"
    (sudo dnf install -y git) >/dev/null 2>&1 || dnf install -y git >/dev/null 2>&1 || true
  fi
fi
have git && coop_ok "git present ($(git --version 2>/dev/null | head -1))" || coop_warn "git not found — install Git (mac: 'xcode-select --install' or 'brew install git'; linux: your package manager)."

# Python
if [ "$NO_PREREQS" != 1 ] && ! coop_python >/dev/null; then
  if [ "$(uname -s 2>/dev/null)" = "Darwin" ] && have brew; then
    coop_info "installing python via brew…"
    # python@3.12/@3.13 are keg-only — brew does NOT link `python3`, and the
    # unversioned symlinks live in <keg>/libexec/bin, so add that dir to PATH.
    # (Not the unversioned `python` formula: it is 3.14+, which ms-fabric-cli rejects.)
    for _pyc in python@3.12 python@3.13; do
      brew install "$_pyc" >/dev/null 2>&1 || true
      _pylib="$(brew --prefix "$_pyc" 2>/dev/null)/libexec/bin"
      if [ -d "$_pylib" ]; then
        case ":$PATH:" in *":$_pylib:"*) : ;; *) PATH="$_pylib:$PATH" ;; esac
        break
      fi
    done
    unset _pyc _pylib
  elif have apt-get; then
    coop_info "installing python via apt…"
    (sudo apt-get update -y && sudo apt-get install -y python3 python3-pip python3-venv) >/dev/null 2>&1 || apt-get install -y python3 python3-pip python3-venv >/dev/null 2>&1 || true
  elif have dnf; then
    coop_info "installing python via dnf…"
    (sudo dnf install -y python3 python3-pip) >/dev/null 2>&1 || dnf install -y python3 python3-pip >/dev/null 2>&1 || true
  fi
  [ -d "/opt/homebrew/bin" ] && case ":$PATH:" in *":/opt/homebrew/bin:"*) : ;; *) PATH="/opt/homebrew/bin:$PATH" ;; esac
  hash -r 2>/dev/null || true
fi
if _py="$(coop_python)"; then
  coop_ok "python present ($("$_py" --version 2>&1))"
else
  coop_warn "python not found — install Python 3.10+ (mac: 'brew install python'; linux: 'apt install python3')."
fi

# Node.js
if [ "$NO_PREREQS" != 1 ] && ! have node; then
  if [ "$(uname -s 2>/dev/null)" = "Darwin" ] && have brew; then
    coop_info "installing node via brew…"
    brew install node >/dev/null 2>&1 || true
  elif have apt-get; then
    coop_info "installing nodejs via apt…"
    (sudo apt-get update -y && sudo apt-get install -y nodejs npm) >/dev/null 2>&1 || apt-get install -y nodejs npm >/dev/null 2>&1 || true
  elif have dnf; then
    coop_info "installing nodejs via dnf…"
    (sudo dnf install -y nodejs npm) >/dev/null 2>&1 || dnf install -y nodejs npm >/dev/null 2>&1 || true
  fi
  [ -d "/opt/homebrew/bin" ] && case ":$PATH:" in *":/opt/homebrew/bin:"*) : ;; *) PATH="/opt/homebrew/bin:$PATH" ;; esac
  hash -r 2>/dev/null || true
fi
if have node; then
  coop_ok "node present ($(node --version 2>/dev/null || echo '?'))"
  _nodev="$(node --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  if [ -n "$_nodev" ] && coop_version_lt "$_nodev" "22.19.0"; then
    coop_warn "Node $_nodev is older than Pi's requirement (>= 22.19)" "upgrade Node, or pin Pi's legacy build: npm i -g @earendil-works/pi-coding-agent@legacy-node20"
  fi
  unset _nodev
else
  coop_warn "node not found — install Node.js 22.19+ from https://nodejs.org (needed to install/update pi)."
fi

# Azure CLI (az)
if [ "$NO_PREREQS" != 1 ] && ! have az; then
  if [ "$(uname -s 2>/dev/null)" = "Darwin" ] && have brew; then
    coop_info "installing azure-cli via brew…"
    brew install azure-cli >/dev/null 2>&1 || true
  elif have apt-get; then
    coop_info "installing azure-cli via apt…"
    (curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash) >/dev/null 2>&1 || (sudo apt-get update -y && sudo apt-get install -y azure-cli) >/dev/null 2>&1 || true
  elif have dnf; then
    coop_info "installing azure-cli via dnf…"
    (sudo dnf install -y azure-cli) >/dev/null 2>&1 || dnf install -y azure-cli >/dev/null 2>&1 || true
  fi
  [ -d "/opt/homebrew/bin" ] && case ":$PATH:" in *":/opt/homebrew/bin:"*) : ;; *) PATH="/opt/homebrew/bin:$PATH" ;; esac
  hash -r 2>/dev/null || true
fi
have az && coop_ok "az present ($(az --version 2>/dev/null | head -1))" || coop_warn "az not found — install Azure CLI from https://learn.microsoft.com/cli/azure (needed for Fabric/Power BI live auth)."

# Tabular Editor CLI (te — cross-platform; BPA reviews run through `te bpa run`)
if have te; then
  coop_ok "te present ($(te --version 2>/dev/null | head -1))"
else
  coop_warn "Tabular Editor CLI (te) not found (optional; BPA reviews need it — download from https://tabulareditor.com/product/features-and-tools/tabular-editor-cli, place in ~/.local/bin or on PATH, then run: te auth login)."
fi

coop_unit "pipx" _unit_pipx
# Make a just-installed pipx (and the bins pipx will drop tools into) visible to
# the REST of this run, so steps 4/5 don't fail "pipx missing" until a new shell.
if _py="$(coop_python)"; then _ub="$("$_py" -m site --user-base 2>/dev/null)"; [ -n "${_ub:-}" ] && PATH="$_ub/bin:$PATH"; unset _ub; fi; unset _py
PATH="$HOME/.local/bin:$PATH"   # pipx default PIPX_BIN_DIR (fab, coop-* land here)
hash -r 2>/dev/null || true

# --- 2. Pi itself ------------------------------------------------------------
coop_head "2/8  Pi (@earendil-works/pi-coding-agent)"
coop_unit "pi (@earendil-works/pi-coding-agent)" _unit_pi
# Make a just-npm-installed `pi` visible to step 3 in the same run (npm's global
# bin dir is often not yet on PATH right after install).
if have npm; then _np="$(npm prefix -g 2>/dev/null)"; [ -n "${_np:-}" ] && PATH="$_np/bin:$PATH"; unset _np; fi
hash -r 2>/dev/null || true

# --- 3. Pi extensions (MCP / memory / usage / web / ask-user) ----------------
coop_head "3/8  Pi extensions"
for ext in "${PI_EXTENSIONS[@]}"; do
  coop_unit "$ext" _unit_ext "$ext"
done

# --- 4. Microsoft Fabric CLI -------------------------------------------------
coop_head "4/8  Microsoft Fabric CLI (fab)"
if [ "$NO_FABRIC" = 1 ]; then
  coop_warn "skipped (--no-fabric)"
else
  coop_unit "Microsoft Fabric CLI" _unit_fabric; hash -r 2>/dev/null || true
fi

# --- 5. Standalone Coop tools ------------------------------------------------
coop_head "5/8  Coop tools (coop-data-doc / coop-sql-review / coop-dax-review)"
for pkg in "${PY_TOOLS[@]}"; do
  coop_unit "$pkg" _unit_pytool "$pkg"
done

# --- 6. Microsoft Fabric / Power BI authoring tools (npm) --------------------
coop_head "6/8  Fabric / Power BI authoring tools"
coop_unit "Power BI/Fabric authoring tools" _unit_pbih_tools
hash -r 2>/dev/null || true

# Done with the install items — finalize the bar (leaves a permanent 100% line).
coop_progress_end
[ "${COOP_FLEET_TEST_MODE:-0}" = 1 ] && exit 0

# --- 7. Put `coop` on PATH ---------------------------------------------------
coop_head "7/8  Link 'coop' onto your PATH"
LOCALBIN="$HOME/.local/bin"
mkdir -p "$LOCALBIN"
chmod +x "$COOP_ROOT/bin/coop" "$COOP_ROOT"/scripts/*.sh 2>/dev/null || true
# If a REAL file (not a symlink) already sits there, back it up before ln -sf would
# clobber it with no trace.
if [ -e "$LOCALBIN/coop" ] && [ ! -L "$LOCALBIN/coop" ]; then
  mv "$LOCALBIN/coop" "$LOCALBIN/coop.bak.$$" 2>/dev/null \
    && coop_warn "backed up an existing non-symlink $LOCALBIN/coop to coop.bak.$$"
fi
if [ ! -e "$LOCALBIN/coop" ] || [ "$(readlink "$LOCALBIN/coop" 2>/dev/null)" != "$COOP_ROOT/bin/coop" ]; then
  if ln -sf "$COOP_ROOT/bin/coop" "$LOCALBIN/coop"; then coop_ok "linked $LOCALBIN/coop -> bin/coop"; else coop_warn "could not link $LOCALBIN/coop" "check permissions on $LOCALBIN"; fi
else
  coop_ok "coop already linked"
fi
COOP_ON_PATH=1
case ":$PATH:" in
  *":$LOCALBIN:"*) : ;;
  *) COOP_ON_PATH=0 ;;
esac

# --- 8. First-run onboarding ---------------------------------------------------
# If this is an interactive install and there's no local profile yet, ask the user
# for their name and communication preference before the first real session.
if [ -t 0 ] && [ "${COOP_NO_ONBOARD:-0}" != "1" ]; then
  coop_maybe_onboard || coop_warn "onboarding could not complete; run: coop onboard"
fi

# --- 9. Sync brand assets + doctor --------------------------------------------
coop_head "9/9  Sync assets and run doctor"
"$COOP_ROOT/scripts/sync.sh" || coop_warn "sync reported issues"
echo >&2
# Propagate doctor's verdict as the install's exit code, so a genuinely broken
# install (a required dep still missing) is detectable by whatever ran `coop install`
# (onboarding automation, the double-click launcher's wrapper). Steps above stay
# warn-and-continue; this is the one authoritative "is it usable?" signal.
"$COOP_ROOT/scripts/doctor.sh"; DOCTOR_RC=$?

echo >&2
# Close on doctor's verdict: a green "complete" line after a failed doctor would
# bury the real state — on failure, point back at the ✗ items instead.
if [ "$DOCTOR_RC" -ne 0 ]; then
  coop_warn "Bootstrap finished, but doctor reported problems — fix the ✗ items above, then re-run: coop doctor"
elif [ "${COOP_ON_PATH:-1}" = 1 ]; then
  coop_ok "Bootstrap complete. Start the agent with:  coop"
else
  coop_ok "Bootstrap complete — but '$LOCALBIN' isn't on this shell's PATH yet."
fi
if [ "${COOP_ON_PATH:-1}" != 1 ]; then
  coop_say "      • open a NEW terminal, then run:  coop"
  coop_say "      • or use it in THIS shell right now:  $LOCALBIN/coop"
  coop_say "      • to make it permanent, add to ~/.zshrc (or ~/.bashrc):  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi
exit "$DOCTOR_RC"

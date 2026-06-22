#!/usr/bin/env bash
#
# coop install / bootstrap — set up the whole Cooptimize stack on a fresh machine.
# Idempotent: safe to re-run. Non-fatal where it can be (warns and keeps going),
# so `coop doctor` can report whatever is still missing at the end.
#
#   Flags:
#     --force        Reinstall pi tools / pipx packages even if already present
#     --no-fabric    Skip installing the Microsoft Fabric CLI (ms-fabric-cli)
#     --yes, -y      Assume yes for prompts
#
set -uo pipefail

COOP_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
export COOP_ROOT
# shellcheck source=../lib/common.sh
. "$COOP_ROOT/lib/common.sh"

FORCE=0; NO_FABRIC=0
for a in "$@"; do
  case "$a" in
    '') ;;                                            # ignore blank args (launchers can pass one)
    --force) FORCE=1 ;;
    --no-fabric) NO_FABRIC=1 ;;
    --yes|-y) export COOP_ASSUME_YES=1 ;;
    *) coop_warn "install: ignoring unknown flag '$a'" ;;
  esac
done

# --- What we install (keep in sync with config/defaults.yml) ------------------
PI_NPM_PACKAGE="@earendil-works/pi-coding-agent"
PI_EXTENSIONS=(
  "npm:pi-mcp-adapter"        # MCP servers (Fabric / Power BI / Microsoft Learn / context-mode)
  "npm:pi-hermes-memory"      # persistent memory + session search + secret scanning
  "npm:pi-better-openai"      # plan usage limits (5h/7d) — shown in coop's footer
  "npm:pi-web-access"         # web search / URL fetch / GitHub clone / PDF / video (read-only)
  "npm:@juicesharp/rpiv-ask-user-question"  # structured questions the model can ask (consent rounds)
)
PY_TOOLS=( coop-data-doc coop-sql-review coop-dax-review )
FABRIC_PKG="ms-fabric-cli"

# Install/operate against coop's ISOLATED Pi agent dir so nothing mixes with the
# user's personal `pi`. Every `pi` call below (and the sync/doctor it runs) inherits it.
PI_CODING_AGENT_DIR="$(coop_pi_agent_dir)"; export PI_CODING_AGENT_DIR
mkdir -p "$PI_CODING_AGENT_DIR"

OS="$(uname -s 2>/dev/null || echo unknown)"

# Overall-bar denominator: the install ITEMS we will attempt (pipx + pi + each
# extension + each coop tool, plus Fabric unless --no-fabric).
PROG_TOTAL=$(( 2 + ${#PI_EXTENSIONS[@]} + ${#PY_TOOLS[@]} ))
[ "$NO_FABRIC" = 0 ] && PROG_TOTAL=$(( PROG_TOTAL + 1 ))

# --- Per-item units ----------------------------------------------------------
# Each prints its final status message to stdout and returns 0 (✓) or non-zero (!).
# coop_unit runs these in the background, animates the active-item line, then ticks
# the overall bar. They run in a subshell, so they see the vars above but cannot
# mutate the parent's command hash — callers run `hash -r` after install units.
_unit_pipx() {
  if have pipx; then printf 'pipx present'; return 0; fi
  if have python3; then
    if python3 -m pip install --user pipx >/dev/null 2>&1 && python3 -m pipx ensurepath >/dev/null 2>&1; then
      printf 'pipx installed (open a new shell for PATH changes)'; return 0
    fi
    printf 'could not install pipx automatically — see https://pipx.pypa.io'; return 1
  fi
  printf 'skipping pipx (python3 missing)'; return 1
}

_unit_pi() {
  if have pi && [ "$FORCE" = 0 ]; then printf 'pi present (%s)' "$(pi --version 2>/dev/null || echo '?')"; return 0; fi
  if have npm; then
    if npm install -g "$PI_NPM_PACKAGE" >/dev/null 2>&1; then printf 'pi installed'; return 0; fi
    printf 'npm install of pi failed — try: npm install -g %s' "$PI_NPM_PACKAGE"; return 1
  fi
  printf 'cannot install pi (npm missing) — install Node.js, then re-run: coop install'; return 1
}

_unit_ext() {  # $1 = extension spec
  local ext="$1"
  have pi || { printf 'skipped %s (pi not installed)' "$ext"; return 1; }
  if pi install "$ext" >/dev/null 2>&1; then printf '%s' "$ext"; return 0; fi
  printf 'could not install %s (continuing)' "$ext"; return 1
}

_unit_fabric() {
  have pipx || { printf 'skipping Fabric CLI (pipx missing)'; return 1; }
  if [ "$FORCE" = 1 ]; then pipx install --force "$FABRIC_PKG" >/dev/null 2>&1 || true
  else pipx install "$FABRIC_PKG" >/dev/null 2>&1 || pipx upgrade "$FABRIC_PKG" >/dev/null 2>&1 || true
  fi
  # fabric-cicd is a Python LIBRARY (no CLI), used for deploy validation — inject it
  # into the Fabric CLI's env so it's importable alongside `fab`. (doctor verifies it.)
  pipx inject "$FABRIC_PKG" fabric-cicd >/dev/null 2>&1 || true
  hash -r 2>/dev/null || true
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
  have pipx || { printf 'skipping %s (pipx missing)' "$pkg"; return 1; }
  if [ "$FORCE" = 1 ]; then
    if pipx install --force "$pkg" >/dev/null 2>&1; then printf '%s' "$pkg"; return 0; fi
    printf 'failed: %s' "$pkg"; return 1
  fi
  if pipx install "$pkg" >/dev/null 2>&1; then printf '%s (installed)' "$pkg"; return 0; fi
  if pipx upgrade "$pkg" >/dev/null 2>&1; then printf '%s (up to date)' "$pkg"; return 0; fi
  printf 'could not install %s' "$pkg"; return 1
}

coop_head "Cooptimize agent bootstrap (v${COOP_VERSION})  [$OS]"

# Pin the overall bar to the bottom for the install phase; restore the cursor even
# on Ctrl-C. (coop_progress_end is idempotent, so the EXIT trap is a safe no-op
# once we've ended it explicitly after step 5.)
coop_progress_begin "$PROG_TOTAL"
trap 'coop_progress_end; _coop_unit_cleanup' EXIT INT TERM

# --- 1. Prerequisites (warn-and-continue; these usually need a package manager)
coop_head "1/7  Prerequisites"
have git     || coop_warn "git not found — install Git (mac: 'xcode-select --install' or 'brew install git'; linux: your package manager)."
have python3 || coop_warn "python3 not found — install Python 3.10+ (mac: 'brew install python'; linux: 'apt install python3')."
have node    || coop_warn "node not found — install Node.js 22.19+ from https://nodejs.org (needed to install/update pi)."
coop_unit "pipx" _unit_pipx
# Make a just-installed pipx (and the bins pipx will drop tools into) visible to
# the REST of this run, so steps 4/5 don't fail "pipx missing" until a new shell.
if have python3; then _ub="$(python3 -m site --user-base 2>/dev/null)"; [ -n "${_ub:-}" ] && PATH="$_ub/bin:$PATH"; unset _ub; fi
PATH="$HOME/.local/bin:$PATH"   # pipx default PIPX_BIN_DIR (fab, coop-* land here)
hash -r 2>/dev/null || true

# --- 2. Pi itself ------------------------------------------------------------
coop_head "2/7  Pi (@earendil-works/pi-coding-agent)"
coop_unit "pi (@earendil-works/pi-coding-agent)" _unit_pi
# Make a just-npm-installed `pi` visible to step 3 in the same run (npm's global
# bin dir is often not yet on PATH right after install).
if have npm; then _np="$(npm prefix -g 2>/dev/null)"; [ -n "${_np:-}" ] && PATH="$_np/bin:$PATH"; unset _np; fi
hash -r 2>/dev/null || true

# --- 3. Pi extensions (MCP / memory / usage / web / ask-user) ----------------
coop_head "3/7  Pi extensions"
for ext in "${PI_EXTENSIONS[@]}"; do
  coop_unit "$ext" _unit_ext "$ext"
done

# --- 4. Microsoft Fabric CLI -------------------------------------------------
coop_head "4/7  Microsoft Fabric CLI (fab)"
if [ "$NO_FABRIC" = 1 ]; then
  coop_warn "skipped (--no-fabric)"
else
  coop_unit "Microsoft Fabric CLI" _unit_fabric; hash -r 2>/dev/null || true
fi

# --- 5. Standalone Coop tools ------------------------------------------------
coop_head "5/7  Coop tools (coop-data-doc / coop-sql-review / coop-dax-review)"
for pkg in "${PY_TOOLS[@]}"; do
  coop_unit "$pkg" _unit_pytool "$pkg"
done

# Done with the install items — finalize the bar (leaves a permanent 100% line).
coop_progress_end

# --- 6. Put `coop` on PATH ---------------------------------------------------
coop_head "6/7  Link 'coop' onto your PATH"
LOCALBIN="$HOME/.local/bin"
mkdir -p "$LOCALBIN"
chmod +x "$COOP_ROOT/bin/coop" "$COOP_ROOT"/scripts/*.sh 2>/dev/null || true
if [ ! -e "$LOCALBIN/coop" ] || [ "$(readlink "$LOCALBIN/coop" 2>/dev/null)" != "$COOP_ROOT/bin/coop" ]; then
  ln -sf "$COOP_ROOT/bin/coop" "$LOCALBIN/coop" && coop_ok "linked $LOCALBIN/coop -> bin/coop"
else
  coop_ok "coop already linked"
fi
case ":$PATH:" in
  *":$LOCALBIN:"*) : ;;
  *) coop_warn "$LOCALBIN is not on your PATH. Add to your shell rc:  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

# --- 7. Sync brand assets + doctor ------------------------------------------
coop_head "7/7  Sync assets and run doctor"
"$COOP_ROOT/scripts/sync.sh" || coop_warn "sync reported issues"
echo >&2
"$COOP_ROOT/scripts/doctor.sh" || true

echo >&2
coop_ok "Bootstrap complete. Start the agent with:  coop"

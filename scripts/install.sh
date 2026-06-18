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
    --force) FORCE=1 ;;
    --no-fabric) NO_FABRIC=1 ;;
    --yes|-y) export COOP_ASSUME_YES=1 ;;
    *) coop_warn "install: ignoring unknown flag '$a'" ;;
  esac
done

# --- What we install (keep in sync with config/defaults.yml) ------------------
PI_NPM_PACKAGE="@mariozechner/pi-coding-agent"
PI_EXTENSIONS=(
  "npm:pi-mcp-adapter"        # MCP servers (Fabric / Power BI / Microsoft Learn / context-mode)
  "npm:pi-hermes-memory"      # persistent memory + session search + secret scanning
  "npm:pi-powerline-footer"   # branded footer / status bar
)
PY_TOOLS=( coop-data-doc coop-sql-review coop-dax-review )
FABRIC_PKG="ms-fabric-cli"

# Install/operate against coop's ISOLATED Pi agent dir so nothing mixes with the
# user's personal `pi`. Every `pi` call below (and the sync/doctor it runs) inherits it.
export PI_CODING_AGENT_DIR="$(coop_pi_agent_dir)"
mkdir -p "$PI_CODING_AGENT_DIR"

OS="$(uname -s 2>/dev/null || echo unknown)"

coop_head "Cooptimize agent bootstrap (v${COOP_VERSION})  [$OS]"

# --- 1. Prerequisites (warn-and-continue; these usually need a package manager)
coop_head "1/7  Prerequisites"
have git     || coop_warn "git not found — install Git (mac: 'xcode-select --install' or 'brew install git'; linux: your package manager)."
have python3 || coop_warn "python3 not found — install Python 3.10+ (mac: 'brew install python'; linux: 'apt install python3')."
have node    || coop_warn "node not found — install Node.js 18+ from https://nodejs.org (needed to install/update pi)."

# pipx: we can usually install this ourselves.
if ! have pipx; then
  if have python3; then
    coop_info "Installing pipx (python3 -m pip install --user pipx)…"
    python3 -m pip install --user pipx >/dev/null 2>&1 && python3 -m pipx ensurepath >/dev/null 2>&1 \
      && coop_ok "pipx installed (you may need to open a new shell for PATH changes)" \
      || coop_warn "could not install pipx automatically — see https://pipx.pypa.io"
    hash -r 2>/dev/null || true
  else
    coop_warn "skipping pipx (python3 missing)"
  fi
else
  coop_ok "pipx present"
fi

# --- 2. Pi itself ------------------------------------------------------------
coop_head "2/7  Pi (@mariozechner/pi-coding-agent)"
if have pi && [ "$FORCE" = 0 ]; then
  coop_ok "pi present ($(pi --version 2>/dev/null || echo '?'))"
elif have npm; then
  coop_info "Installing pi globally via npm…"
  npm install -g "$PI_NPM_PACKAGE" >/dev/null 2>&1 \
    && coop_ok "pi installed" || coop_warn "npm install of pi failed — try: npm install -g $PI_NPM_PACKAGE"
  hash -r 2>/dev/null || true
else
  coop_warn "cannot install pi (npm missing). Install Node.js, then re-run 'coop install'."
fi

# --- 3. Pi extensions (branded powerline footer) -----------------------------
coop_head "3/7  Pi extensions"
if have pi; then
  for ext in "${PI_EXTENSIONS[@]}"; do
    coop_info "pi install $ext"
    pi install "$ext" >/dev/null 2>&1 && coop_ok "$ext" || coop_warn "could not install $ext (continuing)"
  done
else
  coop_warn "skipping extensions (pi not installed)"
fi

# --- 4. Microsoft Fabric CLI -------------------------------------------------
coop_head "4/7  Microsoft Fabric CLI (fab)"
if [ "$NO_FABRIC" = 1 ]; then
  coop_warn "skipped (--no-fabric)"
elif have pipx; then
  if [ "$FORCE" = 1 ]; then pipx install --force "$FABRIC_PKG" >/dev/null 2>&1 || true
  else pipx install "$FABRIC_PKG" >/dev/null 2>&1 || pipx upgrade "$FABRIC_PKG" >/dev/null 2>&1 || true
  fi
  # fabric-cicd is a Python LIBRARY (no CLI), used for deploy validation — inject it
  # into the Fabric CLI's environment so it's importable alongside `fab`.
  pipx inject "$FABRIC_PKG" fabric-cicd >/dev/null 2>&1 \
    && coop_ok "fabric-cicd (library) added to the Fabric CLI env" \
    || coop_warn "could not add fabric-cicd (optional; pipx inject $FABRIC_PKG fabric-cicd)"
  hash -r 2>/dev/null || true
  if have fab; then
    if fab --version 2>&1 | grep -qiE 'paramiko|invoke'; then
      coop_warn "'fab' resolves to Python Fabric (SSH), not the Microsoft Fabric CLI."
      coop_say  "      Put the pipx bin dir ahead of any other 'fab' on PATH (or remove it). Then re-check: fab --version"
    else
      coop_ok "Microsoft Fabric CLI ready ($(fab --version 2>/dev/null | head -1))"
    fi
  else
    coop_warn "ms-fabric-cli installed but 'fab' not on PATH yet — open a new shell (pipx ensurepath)."
  fi
else
  coop_warn "skipping Fabric CLI (pipx missing)"
fi

# --- 5. Standalone Coop tools ------------------------------------------------
coop_head "5/7  Coop tools (coop-data-doc / coop-sql-review / coop-dax-review)"
if have pipx; then
  for pkg in "${PY_TOOLS[@]}"; do
    if [ "$FORCE" = 1 ]; then
      pipx install --force "$pkg" >/dev/null 2>&1 && coop_ok "$pkg" || coop_warn "failed: $pkg"
    else
      pipx install "$pkg" >/dev/null 2>&1 && coop_ok "$pkg (installed)" \
        || { pipx upgrade "$pkg" >/dev/null 2>&1 && coop_ok "$pkg (up to date)" || coop_warn "could not install $pkg"; }
    fi
  done
else
  coop_warn "skipping Coop tools (pipx missing)"
fi

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

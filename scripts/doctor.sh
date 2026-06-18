#!/usr/bin/env bash
#
# coop doctor — verify the Cooptimize agent's dependencies and configuration.
# Exit 0 when all REQUIRED dependencies are present (warnings are non-fatal);
# exit 1 when something required is missing.
#
set -uo pipefail

COOP_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
export COOP_ROOT
# shellcheck source=../lib/common.sh
. "$COOP_ROOT/lib/common.sh"

FAIL=0   # required missing -> non-zero exit
WARN=0

ok()   { coop_ok   "$1"; }
warn() { coop_warn "$1 ${2:+— $2}"; WARN=$((WARN+1)); }
bad()  { coop_err  "$1 ${2:+— $2}"; FAIL=$((FAIL+1)); }

# check <cmd> <required|optional> <fix-hint> [version-cmd]
check() {
  local bin="$1" need="$2" hint="$3" vcmd="${4:-}" ver=""
  if have "$bin"; then
    if [ -n "$vcmd" ]; then ver="$($vcmd 2>/dev/null | head -1)"; fi
    ok "$bin${ver:+  ($ver)}"
  else
    if [ "$need" = required ]; then bad "$bin missing" "$hint"; else warn "$bin missing" "$hint"; fi
  fi
}

coop_head "coop doctor — Cooptimize agent v${COOP_VERSION}"

coop_head "Core"
check pi      required "npm install -g @mariozechner/pi-coding-agent   (or: coop bootstrap)" "pi --version"
check git     required "install Git from https://git-scm.com" "git --version"
check node    optional "needed to install/update pi: https://nodejs.org" "node --version"
check npm     optional "ships with Node.js" "npm --version"
check python3 required "install Python 3.10+ from https://python.org" "python3 --version"
check pipx    required "python3 -m pip install --user pipx && python3 -m pipx ensurepath" "pipx --version"

# Minimum Pi version — the extension API used by coop-powerline / coop-tools.
if have pi; then
  piv="$(pi --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  minv="0.79.0"
  if [ -n "$piv" ] && [ "$(printf '%s\n%s\n' "$minv" "$piv" | sort -V | head -1)" != "$minv" ]; then
    warn "pi $piv is older than the tested minimum ($minv)" "coop update"
  fi
fi

coop_head "Microsoft Fabric CLI"
if have fab; then
  fabver="$(fab --version 2>&1 | head -3 | tr '\n' ' ')"
  if printf '%s' "$fabver" | grep -qiE 'paramiko|invoke'; then
    bad "fab is the WRONG tool" "this 'fab' is Python Fabric (SSH automation), not the Microsoft Fabric CLI"
    coop_say "      Fix: pipx install ms-fabric-cli   and ensure ~/.local/bin precedes Homebrew on PATH"
    coop_say "           (or: brew uninstall fabric). Verify with: fab --version"
  else
    ok "fab — Microsoft Fabric CLI  ($(fab --version 2>/dev/null | head -1))"
  fi
else
  bad "fab missing" "pipx install ms-fabric-cli"
fi

coop_head "Standalone Coop tools (pipx)"
check coop-data-doc   required "pipx install coop-data-doc"   "coop-data-doc --version"
check coop-sql-review required "pipx install coop-sql-review" "coop-sql-review --version"
check coop-dax-review required "pipx install coop-dax-review" "coop-dax-review --version"

coop_head "Fabric / semantic-model tooling"
check fabric-cicd optional "pipx install fabric-cicd  (Fabric deployment validation)" "fabric-cicd --version"
# Tabular Editor CLI is path-configured and mostly Windows; check the project's path if set.
te_path="$(coop_yaml_get "$(coop_find_project_yml)" "tools.tabular_editor_cli.executable_path" "")"
case "$te_path" in
  ""|TODO*) if have TabularEditor.exe; then ok "Tabular Editor CLI on PATH"; else warn "Tabular Editor CLI not configured" "set tools.tabular_editor_cli.executable_path in .coop/project.yml (optional)"; fi ;;
  *) [ -x "$te_path" ] || [ -f "$te_path" ] && ok "Tabular Editor CLI: $te_path" || warn "Tabular Editor CLI path not found: $te_path" ;;
esac

coop_head "Pi extensions"
if have pi; then
  pilist="$(pi list 2>/dev/null || true)"
  for ext in "pi-mcp-adapter:MCP servers" "pi-hermes-memory:persistent memory" "pi-powerline-footer:branded footer"; do
    name="${ext%%:*}"; desc="${ext##*:}"
    if printf '%s' "$pilist" | grep -qi "$name"; then ok "$name ($desc)"; else warn "$name not installed ($desc)" "coop add npm:$name"; fi
  done
else
  warn "cannot check extensions" "pi not installed"
fi

coop_head "MCP servers (read-only, optional)"
mcp_found=""
for f in "$PWD/.mcp.json" "$PWD/.pi/mcp.json" "$HOME/.config/mcp/mcp.json" "$HOME/.pi/agent/mcp.json" "$HOME/.pi/mcp-config/mcp.json"; do
  [ -f "$f" ] && { mcp_found="$f"; break; }
done
if [ -n "$mcp_found" ]; then
  ok "MCP config: $mcp_found"
  for s in fabric powerbi microsoft-learn learn context-mode; do
    grep -qi "\"$s\"" "$mcp_found" 2>/dev/null && ok "  • $s server configured" || true
  done
  grep -qiE 'learn\.microsoft\.com|microsoft-learn' "$mcp_found" 2>/dev/null || warn "  Microsoft Learn MCP not configured" "coop sync   (adds it read-only)"
else
  warn "no MCP config found" "coop sync   (writes a read-only fabric/powerbi/learn config)"
fi

coop_head "Optional"
check az optional "Azure CLI for Fabric/Power BI auth: https://learn.microsoft.com/cli/azure"
check jq optional "nice-to-have for JSON in your own scripts (coop uses python3)"

coop_head "Project contract"
proj="$(coop_find_project_yml)"
if [ -n "$proj" ]; then
  ok ".coop/project.yml found: $proj"
  todo="$(grep -c 'TODO' "$proj" 2>/dev/null)" || todo=0   # grep -c exits 1 on zero matches; count is already on stdout
  [ "${todo:-0}" -gt 0 ] && warn "$todo TODO placeholder(s) remain in project.yml" "edit it before live Fabric/Power BI work"
else
  warn "no .coop/project.yml found" "copy $COOP_ROOT/.coop/project.example.yml to your repo's .coop/project.yml"
fi

coop_head "Powerline / splash assets"
[ -f "$COOP_ROOT/extensions/coop-powerline/assets/splash.ansi" ] && ok "brand splash present" || warn "splash.ansi missing" "run: coop sync"
[ -f "$COOP_ROOT/themes/cooptimize.json" ] && ok "Cooptimize theme present" || warn "theme missing"

echo >&2
if [ "$FAIL" -gt 0 ]; then
  coop_err "doctor: $FAIL required item(s) missing, $WARN warning(s). Run: coop install"
  exit 1
else
  coop_ok "doctor: all required dependencies present${WARN:+, $WARN warning(s)}."
  exit 0
fi

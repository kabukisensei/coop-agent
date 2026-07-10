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

# Check coop's ISOLATED Pi agent dir (where coop's extensions/MCP live), not the
# user's personal ~/.pi/agent.
PI_CODING_AGENT_DIR="$(coop_pi_agent_dir)"; export PI_CODING_AGENT_DIR

FAIL=0   # required missing -> non-zero exit
WARN=0
FIX=0    # --fix: auto-apply the safe remediations at the end
JSON=0   # --json: one machine-readable document on stdout (fleet health digests)
for _a in "$@"; do
  case "$_a" in
    --fix) FIX=1 ;;
    --json) JSON=1 ;;
    -h|--help)
      printf 'Usage: coop doctor [--fix] [--json]\n  --fix   apply safe remediations (sync extensions/MCP/assets, install missing Coop tools), then re-check\n  --json  suppress the human report and emit one JSON document on stdout: {"checks":[{name,section,status,hint}...],"fail":N,"warn":N}\n' >&2
      exit 0 ;;
  esac
done

# --json plumbing: EVERY check funnels through ok/warn/bad below (and every header
# through section), so machine-readable output is a choke-point change. Records go
# to a temp file as status<US>section<US>name<US>hint (US = 0x1f, which can never
# appear in a message); the summary at the bottom emits the JSON document.
DOCTOR_SECTION=""
DOCTOR_JSON_TMP=""
if [ "$JSON" = 1 ]; then
  DOCTOR_JSON_TMP="$(mktemp)"
  trap 'rm -f "$DOCTOR_JSON_TMP"' EXIT
fi
_rec() {  # status name hint
  [ "$JSON" = 1 ] || return 0
  printf '%s\037%s\037%s\037%s\n' "$1" "$DOCTOR_SECTION" "$2" "${3:-}" >> "$DOCTOR_JSON_TMP"
}
ok()   { _rec ok "$1" ""; [ "$JSON" = 1 ] || coop_ok "$1"; }
warn() { _rec warn "$1" "${2:-}"; [ "$JSON" = 1 ] || coop_warn "$1 ${2:+— $2}"; WARN=$((WARN+1)); }
bad()  { _rec fail "$1" "${2:-}"; [ "$JSON" = 1 ] || coop_err "$1 ${2:+— $2}"; FAIL=$((FAIL+1)); }
section() { DOCTOR_SECTION="$1"; [ "$JSON" = 1 ] || coop_head "$1"; }

# check <cmd> <required|optional> <fix-hint> [version-cmd]
check() {
  local bin="$1" need="$2" hint="$3" vcmd="${4:-}" ver=""
  if have "$bin"; then
    # Extract just a version token, so a REPL banner / error line / wrapper noise
    # never shows up as the "version" (keeps parity with doctor.ps1).
    if [ -n "$vcmd" ]; then ver="$($vcmd 2>/dev/null | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1)"; fi
    ok "$bin${ver:+  ($ver)}"
  else
    if [ "$need" = required ]; then bad "$bin missing" "$hint"; else warn "$bin missing" "$hint"; fi
  fi
}

section "coop doctor — Cooptimize agent v${COOP_VERSION}"

section "Core"
check pi      required "npm install -g @earendil-works/pi-coding-agent   (or: coop bootstrap)" "pi --version"
check git     required "install Git from https://git-scm.com" "git --version"
check node    optional "needed to install/update pi: https://nodejs.org" "node --version"
check npm     optional "ships with Node.js" "npm --version"
# Python: accept `python3` OR `python` (mirror coop_python / doctor.ps1) — a host with
# only `python` on PATH satisfies every coop feature that shells out to Python.
if have python3; then _pybin=python3; elif have python; then _pybin=python; else _pybin=""; fi
if [ -n "$_pybin" ]; then
  _pyver="$("$_pybin" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1)"
  ok "python${_pyver:+  ($_pyver)}"
else
  bad "python missing" "install Python 3.10+ from https://python.org"
fi
unset _pybin _pyver
check pipx    required "python3 -m pip install --user pipx && python3 -m pipx ensurepath" "pipx --version"

# Minimum Pi version — the extension API used by coop-powerline / coop-tools.
if have pi; then
  piv="$(pi --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  minv="0.79.0"
  if [ -n "$piv" ] && [ "$(printf '%s\n%s\n' "$minv" "$piv" | sort -V | head -1)" != "$minv" ]; then
    warn "pi $piv is older than the tested minimum ($minv)" "coop update"
  fi
  # Ceiling: warn (never fail) when the installed Pi is a newer MINOR than coop's tested
  # version — new Pi minors have broken coop's extensions before. `coop update` gates this
  # jump; doctor just flags a machine that already crossed it.
  tested_pi="$(coop_yaml_get "$COOP_ROOT/config/defaults.yml" tested_with.pi "")"
  if [ -n "$piv" ] && [ -n "$tested_pi" ] && coop_minor_newer "$piv" "$tested_pi"; then
    warn "pi $piv is newer than coop's tested version ($tested_pi)" "if extensions misbehave, pin back: npm i -g @earendil-works/pi-coding-agent@$tested_pi"
  fi
fi

# Pi (latest, @earendil-works) requires Node >= 22.19. Presence is checked above; the
# VERSION check here saves a teammate on Node 18/20 from a cryptic pi failure.
if have node; then
  nodev="$(node --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  nodemin="22.19.0"
  if [ -n "$nodev" ] && [ "$(printf '%s\n%s\n' "$nodemin" "$nodev" | sort -V | head -1)" != "$nodemin" ]; then
    warn "Node $nodev is older than Pi's requirement (>= 22.19)" "upgrade Node, or pin Pi's legacy build: npm i -g @earendil-works/pi-coding-agent@legacy-node20"
  fi
fi

# Lingering deprecated Pi package — coop migrated to @earendil-works. Detect the
# DIRECT top-level global install (pipe through grep so npm ls's exit code, which is
# non-zero on an invalid tree, doesn't matter).
if have npm && npm ls -g --depth=0 2>/dev/null | grep -q '@mariozechner/pi-coding-agent'; then
  warn "deprecated Pi package still installed globally (@mariozechner/pi-coding-agent; Pi is now @earendil-works)" "remove if unused: npm uninstall -g @mariozechner/pi-coding-agent  (skip if an extension still depends on it)"
fi

# First-run login: coop shares Pi auth in from ~/.pi/agent. A brand-new teammate has none.
if have pi; then
  gdir="$(coop_global_pi_agent_dir 2>/dev/null || true)"
  if [ -s "$PI_CODING_AGENT_DIR/auth.json" ] || { [ -n "$gdir" ] && [ -s "$gdir/auth.json" ]; }; then
    ok "Pi login present"
  else
    warn "no Pi login found yet" "your first 'coop' run will prompt you to sign in — see docs/onboarding.md §3.5 (OpenAI/Codex provider, Cooptimize BUSINESS account)"
  fi
fi

section "Microsoft Fabric CLI"
if have fab; then
  fabver="$(fab --version 2>&1 | head -3 | tr '\n' ' ')"
  if printf '%s' "$fabver" | grep -qiE 'paramiko|invoke'; then
    bad "fab is the WRONG tool" "this 'fab' is Python Fabric (SSH automation), not the Microsoft Fabric CLI"
    if [ "$JSON" = 0 ]; then
      coop_say "      Fix: pipx install ms-fabric-cli   and ensure ~/.local/bin precedes Homebrew on PATH"
      coop_say "           (or: brew uninstall fabric). Verify with: fab --version"
    fi
  else
    ok "fab — Microsoft Fabric CLI  ($(fab --version 2>/dev/null | head -1))"
  fi
else
  bad "fab missing" "pipx install ms-fabric-cli"
fi

section "Standalone Coop tools (pipx)"
check coop-data-doc   required "pipx install coop-data-doc"   "coop-data-doc --version"
check coop-sql-review required "pipx install coop-sql-review" "coop-sql-review --version"
check coop-dax-review required "pipx install coop-dax-review" "coop-dax-review --version"

section "Fabric / semantic-model tooling"
# fabric-cicd is a Python LIBRARY (no CLI) — check it's importable in the Fabric CLI's env.
if have fab; then
  has_cicd=0
  # Primary: run pip inside the ms-fabric-cli venv via pipx — OS-agnostic, no need to
  # locate the venv interpreter (the shim isn't always a symlink, e.g. on Windows).
  if have pipx && pipx runpip ms-fabric-cli show fabric-cicd >/dev/null 2>&1; then
    has_cicd=1
  else
    fabbin="$(command -v fab)"
    # Fallback: resolve the shim transitively (handles multi-hop symlinks; readlink -f
    # isn't portable on macOS) and probe the interpreter next to it.
    fabreal="$("$(coop_python)" -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$fabbin" 2>/dev/null || echo "$fabbin")"
    fabpy="$(dirname "$fabreal")/python"
    if [ -x "$fabpy" ] && "$fabpy" -c "import fabric_cicd" >/dev/null 2>&1; then has_cicd=1; fi
  fi
  if [ "$has_cicd" = 1 ]; then
    ok "fabric-cicd (library, in the Fabric CLI env)"
  else
    warn "fabric-cicd not installed" "pipx inject ms-fabric-cli fabric-cicd  (or: uv tool install ms-fabric-cli --with fabric-cicd)"
  fi
else
  warn "fabric-cicd: install the Microsoft Fabric CLI first" "coop install"
fi
# Tabular Editor CLI is path-configured and mostly Windows; check the project's path if set.
te_path="$(coop_yaml_get "$(coop_find_project_yml)" "tools.tabular_editor_cli.executable_path" "")"
case "$te_path" in
  ""|TODO*) if have TabularEditor.exe; then ok "Tabular Editor CLI on PATH"; else warn "Tabular Editor CLI not configured" "set tools.tabular_editor_cli.executable_path in .coop/project.yml (optional)"; fi ;;
  *) if [ -x "$te_path" ] || [ -f "$te_path" ]; then ok "Tabular Editor CLI: $te_path"; else warn "Tabular Editor CLI path not found: $te_path"; fi ;;
esac

section "Pi extensions"
if have pi; then
  pilist="$(pi list 2>/dev/null || true)"
  for ext in "pi-mcp-adapter:MCP servers" "pi-hermes-memory:persistent memory"; do
    name="${ext%%:*}"; desc="${ext##*:}"
    if printf '%s' "$pilist" | grep -qi "$name"; then ok "$name ($desc)"; else warn "$name not installed ($desc)" "coop add npm:$name"; fi
  done
  # pi-ai / pi-tui must match the agent — coop's extensions load INTO it and share one
  # copy. A skew (e.g. tree 0.74.x vs agent 0.80.x) breaks pi-web-access's /compat import.
  ext_ver="$(coop_pi_version)"; ext_py="$(coop_python 2>/dev/null || true)"
  if [ -n "$ext_ver" ] && [ -n "$ext_py" ]; then
    ext_line="$("$ext_py" "$COOP_ROOT/lib/_extdeps.py" align "$PI_CODING_AGENT_DIR" "$ext_ver" --check 2>/dev/null)"; ext_rc=$?
    read -r ext_tree_ai ext_tree_tui _ _ _ _ ext_req ext_ext <<< "$ext_line"
    if [ "$ext_rc" = 0 ]; then
      ok "extension pi-ai / pi-tui aligned to pi $ext_ver"
    elif [ "$ext_rc" = 10 ]; then
      warn "extension pi-ai/pi-tui skew (tree ${ext_tree_ai}/${ext_tree_tui} vs agent $ext_ver)" "coop doctor --fix   (re-pins + reinstalls; close any running coop session first)"
    elif [ "$ext_rc" = 11 ]; then
      if [ -n "$ext_ext" ] && [ "$ext_ext" != "-" ]; then ext_need="$ext_ext needs pi-ai ≥ $ext_req"; else ext_need="an installed extension needs a newer pi-ai"; fi
      warn "Pi agent $ext_ver is too old — $ext_need" "update the Pi agent: coop update   (or move off the legacy-node20 build)"
    fi
    # ext_rc=2 (no extension tree yet) / other → silent
  fi
else
  warn "cannot check extensions" "pi not installed"
fi

section "MCP servers (read-only, optional)"
mcp_found=""
for f in "$PI_CODING_AGENT_DIR/mcp.json" "$PWD/.mcp.json" "$PWD/.pi/mcp.json" "$HOME/.config/mcp/mcp.json" "$HOME/.pi/mcp-config/mcp.json"; do
  [ -f "$f" ] && { mcp_found="$f"; break; }
done
if [ -n "$mcp_found" ]; then
  ok "MCP config: $mcp_found"
  for s in fabric powerbi azure-devops microsoft-learn context-mode; do
    grep -qi "\"$s\"" "$mcp_found" 2>/dev/null && ok "  • $s server configured" || true
  done
  grep -qiE 'learn\.microsoft\.com|microsoft-learn' "$mcp_found" 2>/dev/null || warn "  Microsoft Learn MCP not configured" "coop sync   (adds it read-only)"
  # A synced mcp.json still carries TODO-tenant-id / TODO-org-name seeds (from
  # config/mcp.example.json) until the user fills them in — mirror the project.yml
  # TODO check so a placeholder config never reads as fully green.
  mcp_todo="$(grep -c 'TODO-' "$mcp_found" 2>/dev/null)" || mcp_todo=0
  [ "${mcp_todo:-0}" -gt 0 ] && warn "$mcp_todo TODO placeholder(s) remain in mcp.json" "set your tenant/org before live Power BI / Azure DevOps work"
else
  warn "no MCP config found" "coop sync   (writes a read-only fabric/powerbi/learn config)"
fi

section "Optional"
check az optional "Azure CLI for Fabric/Power BI auth: https://learn.microsoft.com/cli/azure"
check jq optional "nice-to-have for JSON in your own scripts (coop uses python3)"

section "Project contract"
proj="$(coop_find_project_yml)"
if [ -n "$proj" ]; then
  ok ".coop/project.yml found: $proj"
  todo="$(grep -c 'TODO' "$proj" 2>/dev/null)" || todo=0   # grep -c exits 1 on zero matches; count is already on stdout
  [ "${todo:-0}" -gt 0 ] && warn "$todo TODO placeholder(s) remain in project.yml" "edit it before live Fabric/Power BI work"
else
  warn "no .coop/project.yml found" "copy $COOP_ROOT/.coop/project.example.yml to your repo's .coop/project.yml"
fi

section "coop-agent repository"
if [ -d "$COOP_ROOT/.git" ] && have git; then
  # Staleness nudge: refresh origin at most once/day (5s watchdog; silent offline),
  # then count against the last-fetched origin/main — local + instant.
  coop_repo_fetch_throttled || true
  behind="$(coop_repo_behind_count)"
  if [ "${behind:-0}" -gt 0 ]; then
    warn "coop-agent is $behind commit(s) behind" "run: coop update"
  else
    ok "coop-agent is a git checkout (updates via: coop update)"
  fi
else
  # A zip/shared-drive copy: everything above still updates, but the repo layer
  # (skills/prompts/guardrails/themes/scripts) is frozen at whatever the zip held.
  warn "this coop-agent is not a git checkout — skills/prompts/guardrails will NEVER update" "fix: git clone the repo, then run ./bin/coop install from the clone (your ~/.coop settings carry over)"
fi

section "Powerline / splash assets"
[ -f "$COOP_ROOT/extensions/coop-powerline/assets/splash.ansi" ] && ok "brand splash present" || warn "splash.ansi missing" "run: coop sync"
[ -f "$COOP_ROOT/themes/cooptimize.json" ] && ok "Cooptimize theme present" || warn "theme missing"

if [ "$FIX" = 1 ] && { [ "$FAIL" -gt 0 ] || [ "$WARN" -gt 0 ]; }; then
  section "Applying fixes (--fix)"
  if [ -f "$COOP_ROOT/scripts/sync.sh" ]; then
    "$COOP_ROOT/scripts/sync.sh" >/dev/null 2>&1 && coop_ok "synced extensions / MCP / assets" || coop_warn "sync had issues (run: coop sync)"
  fi
  for t in coop-data-doc coop-sql-review coop-dax-review; do
    if ! have "$t"; then
      coop_info "pipx install $t"
      pipx install "$t" >/dev/null 2>&1 && coop_ok "$t installed" || coop_warn "could not install $t (run: pipx install $t)"
    fi
  done
  coop_info "Re-checking… (system deps like node/python/pipx + the Fabric CLI install manually — see hints above)"
  echo >&2
  # Propagate --json so the re-check emits the (final) machine-readable document.
  # exec skips EXIT traps, so drop the pre-fix records explicitly first.
  if [ "$JSON" = 1 ]; then
    rm -f "$DOCTOR_JSON_TMP"
    exec "$COOP_ROOT/scripts/doctor.sh" --json
  fi
  exec "$COOP_ROOT/scripts/doctor.sh"
fi

# --json: one JSON document on stdout (everything human went nowhere; the fix-branch
# action log above stays on stderr). Dependency-free: drop any C0 control character
# a probed tool leaked into a message (e.g. `fab --version` ends in \r), then
# escaping \ and " is sufficient.
if [ "$JSON" = 1 ]; then
  _json_esc() { printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
  _us="$(printf '\037')"
  _out='{"checks":['
  _first=1
  while IFS="$_us" read -r _st _sec _nm _ht; do
    [ -n "$_st" ] || continue
    [ "$_first" = 1 ] && _first=0 || _out="$_out,"
    _out="$_out{\"name\":\"$(_json_esc "$_nm")\",\"section\":\"$(_json_esc "$_sec")\",\"status\":\"$_st\",\"hint\":\"$(_json_esc "$_ht")\"}"
  done < "$DOCTOR_JSON_TMP"
  _out="$_out],\"fail\":$FAIL,\"warn\":$WARN}"
  printf '%s\n' "$_out"
  [ "$FAIL" -gt 0 ] && exit 1
  exit 0
fi

echo >&2
fixhint=""
[ "$FIX" = 0 ] && fixhint="   (or auto-fix what's safe: coop doctor --fix)"
if [ "$FAIL" -gt 0 ]; then
  coop_err "doctor: $FAIL required item(s) missing, $WARN warning(s). Run: coop install$fixhint"
  exit 1
else
  # WARN is a numeric string ("0"), which is non-empty — so `${WARN:+…}` always
  # expanded, printing ", 0 warning(s)". Gate on the value instead.
  wsuf=""; [ "$WARN" -gt 0 ] && wsuf=", $WARN warning(s)"
  coop_ok "doctor: all required dependencies present${wsuf}."
  exit 0
fi

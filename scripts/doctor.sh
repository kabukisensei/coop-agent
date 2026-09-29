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
PUBLISH=0
for _a in "$@"; do
  case "$_a" in
    --fix) FIX=1 ;;
    --json) JSON=1 ;;
    --publish) PUBLISH=1; JSON=1 ;;
    -h|--help)
      printf 'Usage: coop doctor [--fix] [--json] [--publish]\n  --fix      apply safe remediations (sync extensions/MCP/assets, install missing Coop tools), then re-check\n  --json     suppress the human report and emit one JSON document on stdout: {"checks":[{name,section,status,hint}...],"fail":N,"warn":N}\n  --publish  augment the --json payload with machine identity (hostname/user/versions/timestamp) and write to fleet.publish_dir (from ~/.coop/config or defaults.yml) instead of stdout\n' >&2
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

# Prerequisites: the SAME ordered table and text `coop install` prints and stops
# on (coop_prereq_rows in lib/common.sh), so install and doctor never disagree.
section "Prerequisites"
_us="$(printf '\037')"
while IFS="$_us" read -r _o _n _req _ok _det _fix; do
  _line="$_o. $_n${_det:+  ($_det)}"
  if [ "$_ok" = 1 ]; then ok "$_line"; elif [ "$_req" = 1 ]; then bad "$_line" "$_fix"; else warn "$_line" "$_fix"; fi
done <<EOF_PREREQS
$(coop_prereq_rows)
EOF_PREREQS
unset _us _o _n _req _ok _det _fix _line

section "Core"
check pi      required "npm install -g @earendil-works/pi-coding-agent   (or: coop bootstrap)" "pi --version"
check npm     optional "ships with Node.js" "npm --version"

# Minimum Pi version — the extension API used by coop-powerline / coop-tools.
if have pi; then
  piv="$(pi --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  minv="0.79.0"
  if [ -n "$piv" ] && coop_version_lt "$piv" "$minv"; then
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

# Release manifest: the single source of truth for the exact versions that ship
# together with this coop build. Doctor reports drift so a teammate can pin back
# with `coop update`; maintainers take head of main + latest with `coop update --edge`.
section "Release manifest"
pi_expected="$(coop_manifest_get pi.version)"
if [ -n "$pi_expected" ]; then
  if have pi; then
    piv="$(pi --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
    status="$(coop_manifest_status "${piv:-}" "$pi_expected")"
    case "$status" in
      ok) ok "pi $piv matches manifest ($pi_expected)" ;;
      missing) warn "pi version unknown" "coop update" ;;
      older) warn "pi $piv is older than manifest ($pi_expected)" "coop update" ;;
      newer-than-tested) warn "pi $piv is newer than manifest ($pi_expected)" "pin back: coop update   (maintainers: coop update --edge)" ;;
      wrong-version) warn "pi $piv differs from manifest ($pi_expected)" "coop update" ;;
    esac
  else
    warn "pi not installed" "coop install"
  fi
fi

# Truthful inventory per distribution. The in-venv metadata is authoritative;
# the CLI-reported version cross-checks it; `pipx list` is never trusted (stale
# caches, or shadowed stubs, can claim anything). Each distribution maps to its
# real executable — ms-fabric-cli installs `fab`, not an `ms-fabric-cli` binary.
check_pipx_dist() { # <dist> <exe>
  local dist="$1" exe="$2"
  local expected meta cli pyver status repair cicd_pin
  expected="$(coop_manifest_get "python_tools.$dist")"
  [ -z "$expected" ] && return 0
  repair="pipx install --force $dist==$expected"
  meta="$(coop_venv_dist_version "$dist" "$dist")"
  if have "$exe"; then
    cli="$($exe --version 2>&1 | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1)"
  else
    cli=""
  fi
  # Python interpreter INSIDE this tool's venv — not the system default python.
  pyver="$(coop_venv_python_version "$dist")"

  if [ -z "$meta" ] && [ -z "$cli" ]; then
    warn "$dist not installed (manifest: $expected)" "pipx install $dist==$expected"
    return 0
  fi
  if [ -n "$meta" ] && [ -n "$cli" ] && [ "$meta" != "$cli" ]; then
    bad "$dist pipx environment is stale/corrupt: metadata says $meta but $exe reports ${cli:-nothing}" \
      "$repair   (metadata/CLI disagreement; recreate the environment)"
    return 0
  fi
  if [ -z "$cli" ]; then
    # Stop here: without a CLI answer there is nothing trustworthy to compare,
    # and falling through would let metadata alone claim a match.
    warn "$dist metadata present ($meta) but $exe produced no version" "$repair"
    return 0
  fi
  # Executable ownership: an unrelated binary that happens to answer --version
  # must never be correlated with this distribution's pipx metadata.
  if [ "$(coop_exe_pipx_venv "$exe")" != "$dist" ]; then
    warn "$dist skipped: resolved $exe does not belong to its pipx environment" \
      "reinstall so the pinned $exe is first on PATH: $repair"
    return 0
  fi
  if [ -z "$meta" ]; then
    # Metadata unreadable (missing/broken/shadowed pipx): classify by the CLI's
    # own report, but say so — the two sources are supposed to agree.
    status="$(coop_manifest_status "$cli" "$expected")"
    case "$status" in
      ok) ok "$dist $cli matches manifest ($expected) (CLI-reported; pipx metadata unreadable)" ;;
      *) warn "$dist $cli differs from manifest per $exe (pipx metadata unreadable)" "$repair   (also check that pipx itself works)" ;;
    esac
  else
    status="$(coop_manifest_status "$meta" "$expected")"
    case "$status" in
      ok) ok "$dist $meta matches manifest ($expected)" ;;
      missing) warn "$dist not installed or version unknown (manifest: $expected)" "pipx install $dist==$expected" ;;
      older) warn "$dist $meta is older than manifest ($expected)" "pipx install $dist==$expected" ;;
      newer-than-tested) warn "$dist $meta is newer than manifest ($expected)" "pipx install $dist==$expected" ;;
      wrong-version) warn "$dist $meta differs from manifest ($expected)" "pipx install $dist==$expected" ;;
    esac
  fi
  # Report the tool's own interpreter and judge support by THAT distribution's
  # installed Requires-Python metadata — never a hardcoded cap.
  if [ -z "$pyver" ]; then
    warn "$dist environment Python could not be determined" "$repair --python 3.12"
    return 0
  fi
  rp="$(coop_venv_requires_python "$dist" "$dist")"
  if [ -z "$rp" ]; then
    ok "$dist environment uses Python $pyver (no Requires-Python metadata found)"
    return 0
  fi
  if coop_python_matches_spec "$pyver" "$rp"; then
    ok "$dist environment uses Python $pyver (requires-python: $rp)"
  else
    cicd_pin=""
    # Only the Fabric CLI env carries the injected fabric-cicd library.
    [ "$dist" = "ms-fabric-cli" ] && cicd_pin="$(coop_manifest_get python_tools.fabric-cicd)"
    warn "$dist environment uses Python $pyver — violates its own requires-python '$rp'" \
      "$repair --python 3.12   (or --python 3.13)${cicd_pin:+, then: pipx inject $dist fabric-cicd==$cicd_pin}"
  fi
}
for pair in "coop-data-doc coop-data-doc" "coop-sql-review coop-sql-review" \
            "coop-dax-review coop-dax-review" "ms-fabric-cli fab"; do
  # shellcheck disable=SC2086  # deliberate word splitting into two args
  check_pipx_dist $pair
done

# The Node minimum (manifest node.min) is prerequisite row 2 above.

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

# Azure sign-in for the client tenant (H2). Probe only: doctor never signs in and
# never touches the launch cache (.az-ok). Same tenant chain and token check as
# the launch (coop_tenant / coop_az_tokens_ok). A missing az is prerequisite row 5.
if [ "${COOP_SKIP_AZ:-0}" != "1" ] && have az; then
  _az_trc=0
  _az_t="$(coop_tenant)" || _az_trc=$?
  if [ "$_az_trc" -eq 2 ]; then
    warn "Azure sign-in: tenant id is not a GUID or domain name" "fix fabric.tenant_id in .coop/project.yml or run: coop onboard --config-only"
  elif [ -z "$_az_t" ]; then
    warn "Azure sign-in: no client tenant configured" "run: coop onboard --config-only"
  else
    _az_rc=0
    coop_az_tokens_ok "$_az_t" || _az_rc=$?
    case "$_az_rc" in
      0) ok "Azure sign-in: signed in to tenant $_az_t" ;;
      124) warn "Azure sign-in: check timed out for tenant $_az_t" "run: az account get-access-token --tenant $_az_t --resource https://api.fabric.microsoft.com" ;;
      1) warn "Azure sign-in: not signed in to tenant $_az_t" "run: az login --tenant $_az_t --allow-no-subscriptions" ;;
      *) warn "Azure sign-in: token check failed for tenant $_az_t (not an auth error)" "run: az account get-access-token --tenant $_az_t --resource https://api.fabric.microsoft.com" ;;
    esac
  fi
  unset _az_trc _az_t _az_rc
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

# Power BI / Fabric authoring npm tools. powerbi-report-author backs coop's own
# power-bi-* skills AND the skills-for-fabric skills, so it is required; the rest
# stay optional. powerbi-desktop-bridge is only useful on Windows with Desktop.
check powerbi-report-author required "npm install -g @microsoft/powerbi-report-authoring-cli" "powerbi-report-author --version"
check powerbi-modeling-mcp optional "npm install -g @microsoft/powerbi-modeling-mcp"
if [ "$(uname -s 2>/dev/null || echo unknown)" = "Windows" ] || [ "$(uname -s 2>/dev/null || echo unknown)" = "MINGW" ] || [ "$(uname -s 2>/dev/null || echo unknown)" = "MSYS" ]; then
  check powerbi-desktop optional "npm install -g @microsoft/powerbi-desktop-bridge-cli (Windows + Power BI Desktop only)" "powerbi-desktop --version"
else
  ok "powerbi-desktop (Desktop Bridge) — Windows only, not applicable here"
fi

# fabric-cicd is a Python LIBRARY (no CLI) living inside the Fabric CLI's env;
# it is manifest-pinned like any other tool, just verified differently.
if have fab; then
  cicd_expected="$(coop_manifest_get python_tools.fabric-cicd)"
  cicd_meta="$(coop_venv_dist_version ms-fabric-cli fabric-cicd)"
  has_cicd=0
  if [ -n "$cicd_meta" ]; then
    has_cicd=1
  else
    # Metadata unavailable: fall back to resolving the shim transitively and
    # importing directly with the venv's own interpreter (handles multi-hop
    # symlinks; readlink -f isn't portable on macOS).
    fabbin="$(command -v fab)"
    fabreal="$("$(coop_python)" -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$fabbin" 2>/dev/null || echo "$fabbin")"
    fabpy="$(dirname "$fabreal")/python"
    if [ -x "$fabpy" ] && "$fabpy" -c "import fabric_cicd" >/dev/null 2>&1; then has_cicd=1; fi
  fi
  if [ "$has_cicd" = 1 ]; then
    if [ -n "$cicd_expected" ] && [ -n "$cicd_meta" ] && [ "$cicd_meta" != "$cicd_expected" ]; then
      warn "fabric-cicd $cicd_meta differs from manifest ($cicd_expected)" \
        "pipx inject ms-fabric-cli fabric-cicd==$cicd_expected"
    else
      ok "fabric-cicd${cicd_meta:+ $cicd_meta} (library, in the Fabric CLI env)"
    fi
  else
    warn "fabric-cicd not installed" "pipx inject ms-fabric-cli fabric-cicd${cicd_expected:+==$cicd_expected}  (or: uv tool install ms-fabric-cli --with fabric-cicd)"
  fi
else
  warn "fabric-cicd: install the Microsoft Fabric CLI first" "coop install"
fi

# The pyodbc fallback is a required installed capability: use the exact runtime
# selected for execution and require both the exact pin and Driver 18+ visibility.
sql_runtime="$(coop_fabric_sql_runtime_status 2>/dev/null)" || true
case "$sql_runtime" in
  ready*) ok "Fabric SQL fallback ready (pyodbc $(printf '%s' "$sql_runtime" | cut -f2), ODBC Driver $(printf '%s' "$sql_runtime" | cut -f3))" ;;
  pyodbc_missing) bad "Fabric SQL fallback: pyodbc missing from selected runtime" "coop sync" ;;
  pyodbc_wrong*) bad "Fabric SQL fallback: pyodbc $(printf '%s' "$sql_runtime" | cut -f2) differs from manifest ($(coop_manifest_get python_tools.pyodbc))" "coop sync" ;;
  pyodbc_unloadable) bad "Fabric SQL fallback: pyodbc is installed but unloadable" "coop sync; repair the ms-fabric-cli environment if it persists" ;;
  driver_missing*) bad "Fabric SQL fallback: ODBC Driver 18+ for SQL Server is missing" "Windows: coop install --yes; otherwise install Microsoft ODBC Driver 18, then run: coop doctor" ;;
  *) bad "Fabric SQL fallback: selected Fabric Python runtime is unavailable" "coop install" ;;
esac

# Tabular Editor CLI (te — cross-platform; BPA reviews run through `te bpa run`)
proj_yml="$(coop_find_project_yml)"
if ! coop_tool_enabled "$proj_yml" "tabular_editor_cli"; then
  ok "Tabular Editor CLI disabled in project.yml"
else
  te_path="$(coop_yaml_get "$proj_yml" "tools.tabular_editor_cli.executable_path" "")"
  te_rules="$(coop_yaml_get "$proj_yml" "tools.tabular_editor_cli.bpa_rules_path" "")"
  case "$te_path" in
    "")
      if have te; then
        ok "te — Tabular Editor CLI  ($(te --version 2>/dev/null | head -1))"
      else
        warn "Tabular Editor CLI (te) not found (optional)" "download 'te' from https://tabulareditor.com/product/features-and-tools/tabular-editor-cli (requires a Tabular Editor account during the preview), place in ~/.local/bin or on PATH, then run: te auth login"
      fi ;;
    TODO*)
      warn "Tabular Editor CLI executable_path not configured" "set tools.tabular_editor_cli.executable_path in .coop/project.yml" ;;
    *) if [ -x "$te_path" ] || [ -f "$te_path" ]; then ok "Tabular Editor CLI: $te_path"; else warn "Tabular Editor CLI path not found: $te_path"; fi ;;
  esac
  case "$te_rules" in
    ""|TODO*) warn "Tabular Editor BPA rules not configured" "set tools.tabular_editor_cli.bpa_rules_path in .coop/project.yml (optional)" ;;
    *) if [ -n "$proj_yml" ] && [ -f "$(dirname "$proj_yml")/../$te_rules" ] || [ -f "$te_rules" ]; then ok "Tabular Editor BPA Rules: $te_rules"; else warn "Tabular Editor BPA rules not found: $te_rules"; fi ;;
  esac
fi

section "Pi extensions"
if have pi; then
  pilist="$(pi list 2>/dev/null || true)"
  # Every MANAGED extension is checked against its exact release-manifest pin —
  # presence alone let a drifted fleet read as healthy.
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    exp="$(coop_manifest_get "extensions.$name")"
    if ! printf '%s' "$pilist" | grep -qi "$name"; then
      warn "$name not installed" "coop sync   (installs the pinned extension fleet)"
      continue
    fi
    if [ -z "$exp" ]; then ok "$name installed (no manifest pin)"; continue; fi
    # Count only real package specs: the install path beneath each spec also
    # contains the extension name (and often a version), so matching any line
    # made one installed version read as several.
    cur=""; cur_count=0
    while IFS= read -r v; do
      [ -n "$v" ] || continue
      cur="$v"; cur_count=$((cur_count + 1))
    done <<EOF
$(coop_pi_extension_versions "$pilist" "$name")
EOF
    if [ "$cur_count" -gt 1 ]; then warn "$name installed at several versions (manifest: $exp)" "coop sync   (pins the extension fleet)"; continue; fi
    status="$(coop_manifest_status "${cur:-}" "$exp")"
    case "$status" in
      ok) ok "$name $cur matches manifest ($exp)" ;;
      missing) warn "$name installed but version unknown (manifest: $exp)" "coop sync   (pins the extension fleet)" ;;
      older|wrong-version) warn "$name ${cur:-?} differs from manifest ($exp)" "coop sync   (pins the extension fleet)" ;;
      newer-than-tested) warn "$name $cur is newer than manifest ($exp)" "coop sync   (pins back); maintainers: coop update --edge" ;;
    esac
  done <<EOF
$(coop_manifest_keys extensions)
EOF
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
for f in "$PWD/.mcp.json" "$PWD/.pi/mcp.json" "$PI_CODING_AGENT_DIR/mcp.json" "$HOME/.config/mcp/mcp.json" "$HOME/.pi/mcp-config/mcp.json"; do
  [ -f "$f" ] && { mcp_found="$f"; break; }
done
if [ -n "$mcp_found" ]; then
  ok "MCP config: $mcp_found"
  for s in fabric powerbi-modeling-mcp azure-devops microsoft-learn; do
    if grep -qi "\"$s\"" "$mcp_found" 2>/dev/null; then
      if [ "$s" = "powerbi-modeling-mcp" ]; then
        # Health requires BOTH flags: --start (the server must actually launch)
        # and --readonly (COOP treats MCP as read-only). Anything less is not a
        # healthy configuration. Generated mcp.json is pretty-printed, so parse
        # the JSON structurally — line greps would only ever see '"args": ['.
        _doc_py="$(coop_python 2>/dev/null || true)"
        modeling_args=""
        if [ -n "$_doc_py" ]; then
          modeling_args="$($_doc_py - "$mcp_found" <<'PYEOF'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8-sig") as fh:
        data = json.load(fh)
    entry = (data.get("mcpServers") or {}).get("powerbi-modeling-mcp") or {}
    print(json.dumps(entry.get("args", [])))
except Exception:
    pass
PYEOF
)"
        fi
        has_start=no
        has_ro=no
        case "$modeling_args" in *'"--start"'*) has_start=yes ;; esac
        case "$modeling_args" in *'"--read-only"'*|*'"--readonly"'*) has_ro=yes ;; esac
        if [ "$has_start" = yes ] && [ "$has_ro" = yes ]; then
          ok "  • $s configured (started, read-only)"
        elif [ -z "$modeling_args" ] && [ -z "$_doc_py" ]; then
          warn "  • $s present but cannot inspect args (python missing)" "install Python 3 so coop doctor can verify --start/--readonly"
        elif [ "$has_start" != yes ]; then
          warn "  • Power BI Modeling MCP missing --start" "add --start so the server launches; keep --readonly"
        elif [ "$has_ro" != yes ]; then
          warn "  • Power BI Modeling MCP missing --readonly — it would run READ-WRITE" "change args to --readonly before any client work"
        fi
      elif [ "$s" = "fabric" ]; then
        # @microsoft/fabric-mcp signs in through az's default account; coop can
        # pin only its own token mints to the client tenant (H2b).
        ok "  • $s server configured (uses az's default account; coop cannot pin its tenant)"
      else
        ok "  • $s server configured"
      fi
    fi
  done
  # powerbi-mcp-server ignores --readonly and exposes refresh_dataset, a write
  # (#93). coop no longer generates it and never removes a user-owned entry, so
  # doctor names the risk instead of reporting the server as configured.
  if grep -qi 'powerbi-mcp-server' "$mcp_found" 2>/dev/null; then
    warn "  • powerbi-mcp-server is not read-only: it ignores --readonly and exposes refresh_dataset, a write (coop-agent#93)" "remove that entry from $mcp_found; coop's read-only Power BI MCP is powerbi-modeling-mcp"
  fi
  grep -qiE 'learn\.microsoft\.com|microsoft-learn' "$mcp_found" 2>/dev/null || warn "  Microsoft Learn MCP not configured" "coop sync   (adds it read-only)"
  # Legacy/unmanaged placeholder configs remain actionable; generated COOP entries never contain TODOs.
  mcp_todo="$(grep -c 'TODO-' "$mcp_found" 2>/dev/null)" || mcp_todo=0
  [ "${mcp_todo:-0}" -gt 0 ] && warn "$mcp_todo TODO placeholder(s) remain in mcp.json" "set your tenant/org before live Power BI / Azure DevOps work"
  _sql_py="$(coop_python 2>/dev/null || true)"
  if [ -n "$_sql_py" ]; then
    _sql_project="$(coop_find_project_yml)"
    _sql_cmd=( "$_sql_py" "$COOP_ROOT/lib/warehouse_mcp.py" doctor-json "$mcp_found" )
    if [ -n "$_sql_project" ]; then _sql_cmd=( "${_sql_cmd[@]}" --project "$_sql_project" ); fi
    _sql_cmd=( "${_sql_cmd[@]}" --probe )
    _sql_doctor="$("${_sql_cmd[@]}" 2>/dev/null || true)"
    _sql_state="$(printf '%s' "$_sql_doctor" | "$_sql_py" -c 'import json,sys; print((json.load(sys.stdin) if not sys.stdin.isatty() else {}).get("state","unavailable"))' 2>/dev/null || printf unavailable)"
    _sql_scope="$(printf '%s' "$_sql_doctor" | "$_sql_py" -c 'import json,sys; d=json.load(sys.stdin); print((d.get("target") or {}).get("scope","unknown"))' 2>/dev/null || printf unknown)"
    # The tenant the probe minted for (H2b); empty means az's default account.
    _sql_tenant="$(printf '%s' "$_sql_doctor" | "$_sql_py" -c 'import json,sys; t=json.load(sys.stdin).get("tenant",""); print(t if isinstance(t,str) else "")' 2>/dev/null | tr -d '\r')" || _sql_tenant=''
    case "$_sql_tenant" in *[!A-Za-z0-9.-]*) _sql_tenant='' ;; esac
    _sql_for="${_sql_scope} target${_sql_tenant:+, tenant $_sql_tenant}"
    case "$_sql_state" in
      registered) ok "  • fabric-sqlendpoint registered (${_sql_for}; direct HTTP, Azure CLI bearer token)" ;;
      auth_required) warn "  • fabric-sqlendpoint auth_required (${_sql_for})" "sign in with Azure CLI/tenant access; doctor never triggers login" ;;
      azure_cli_unavailable) warn "  • fabric-sqlendpoint azure_cli_unavailable (${_sql_for})" "install/repair Azure CLI and ensure az is on PATH; this is not an authentication diagnosis" ;;
      token_launch_failed) warn "  • fabric-sqlendpoint token_launch_failed (${_sql_for})" "Azure CLI was found but could not be launched; this is not an authentication diagnosis" ;;
      token_timeout) warn "  • fabric-sqlendpoint token_timeout (${_sql_for})" "Azure CLI token command exceeded the bounded timeout; retry after checking Azure CLI responsiveness" ;;
      token_command_failed) warn "  • fabric-sqlendpoint token_command_failed (${_sql_for})" "Azure CLI launched but token acquisition failed; run: az account get-access-token --resource https://api.fabric.microsoft.com --output json${_sql_tenant:+ --tenant $_sql_tenant}" ;;
      token_output_invalid) warn "  • fabric-sqlendpoint token_output_invalid (${_sql_for})" "Azure CLI returned no usable accessToken JSON; verify the Fabric token command output" ;;
      tool_missing) warn "  • fabric-sqlendpoint tool_missing (${_sql_for})" "managed MCP did not advertise executeSQL/execute_query" ;;
      target_invalid) warn "  • fabric-sqlendpoint target_invalid" "run: coop sync after fixing fabric.default_sql_endpoint / registered URL" ;;
      unavailable) warn "  • fabric-sqlendpoint unavailable" "run: coop sync; if already configured, retry when network/auth is available" ;;
      *) warn "  • fabric-sqlendpoint $_sql_state" "run: coop sync" ;;
    esac
  else
    warn "  fabric-sqlendpoint status unavailable" "Python is required"
  fi
else
  warn "no MCP config found" "coop sync   (writes a read-only fabric/powerbi/learn config)"
fi

section "Microsoft skills catalog"
_cat_py="$(coop_python 2>/dev/null || true)"
if [ -n "$_cat_py" ]; then
  while IFS="$(printf '\t')" read -r _kind _name _state _revision _count _target _detail; do
    [ -n "$_name" ] || continue
    _catalog_detail="${_detail:+ details $_detail}"
    case "$_state" in
      current) ok "$_name: current${_revision:+ @ $_revision} (${_count:-0} skill(s); target ${_target:-unknown})${_catalog_detail}" ;;
      stale_LKG) warn "$_name: stale_LKG${_revision:+ @ $_revision} (target ${_target:-unknown})${_catalog_detail}" "offline or fetch failed; launch continues from LKG" ;;
      unavailable|tampered|never_fetched) warn "$_name: $_state${_catalog_detail}" "run: coop sync" ;;
      *) warn "$_name: $_state${_catalog_detail}" "run: coop sync" ;;
    esac
  done <<EOF
$("$_cat_py" "$COOP_ROOT/lib/microsoft_skills.py" doctor-lines 2>/dev/null)
EOF
else
  warn "Microsoft skills catalog status unavailable" "Python is required"
fi

section "Standards"
if have node; then
  while IFS="$(printf '\t')" read -r _kind _name _state _detail; do
    [ -n "$_name" ] || continue
    case "$_state" in
      *unavailable*|*auth_required*|*dirty_preserved*|*invalid_preserved*|*stale_last_known_good*|wiki_warning|PENDING_OWNER_PROVISIONING) warn "$_kind $_name: $_state" "${_detail:-standards remain fail-soft}" ;;
      *) ok "$_kind $_name: $_state${_detail:+ @ $_detail}" ;;
    esac
  done <<EOF
$(node "$COOP_ROOT/lib/standards-cli.mjs" doctor-lines "" "$PWD" 2>/dev/null)
EOF
else
  warn "standards status unavailable" "Node is required to discover and verify any SQL/DAX bundled fallback"
fi

section "Optional"
check jq optional "nice-to-have for JSON in your own scripts (coop uses python3)"

section "Project contract"
proj="$(coop_find_project_yml)"
if [ -n "$proj" ]; then
  ok ".coop/project.yml found: $proj"

  # Feature-aware validation: only flag missing values for enabled features instead of
  # counting raw TODO substrings.
  _org="$(coop_yaml_get "$proj" "profile.organization" "")"
  _branch="$(coop_yaml_get "$proj" "profile.default_branch" "")"
  _estate_mode="$(coop_yaml_get "$proj" "estate.mode" "")"
  _repo_name_count="$(coop_yaml_list "$proj" "repositories.*.local_path" | grep -c .)"
  [ -z "$_org" ] && warn "profile.organization is empty" "set it in .coop/project.yml"
  [ -z "$_branch" ] && warn "profile.default_branch is empty" "set it in .coop/project.yml"
  if [ "${_repo_name_count:-0}" -eq 0 ] && [ "$_estate_mode" != "discovery" ]; then
    warn "no repositories configured" "run /setup-project in Coop, or set estate.mode: discovery"
  fi

  if coop_tool_enabled "$proj" "fabric_cli" || coop_tool_enabled "$proj" "fabric_cicd"; then
    _tenant="$(coop_yaml_get "$proj" "fabric.tenant_id" "")"
    [ -z "$_tenant" ] && warn "Fabric tools enabled but fabric.tenant_id is empty" "set it in .coop/project.yml"
  fi

  if coop_tool_enabled "$proj" "tabular_editor_cli"; then
    _te_path="$(coop_yaml_get "$proj" "tools.tabular_editor_cli.executable_path" "")"
    case "$_te_path" in ""|TODO*) warn "Tabular Editor enabled but executable_path not set" "set tools.tabular_editor_cli.executable_path in .coop/project.yml" ;; esac
  fi

  ok "Microsoft skills project policy is covered by the pinned catalog doctor section"

  # Read-only bounded legacy-project diagnostics. The shared Python helper is
  # also used by the PowerShell doctor and explicit migration command.
  _health_py="$(coop_python 2>/dev/null || true)"
  if [ -n "$_health_py" ]; then
    _health_lines="$("$_health_py" "$COOP_ROOT/lib/project_health.py" doctor-lines "$(dirname "$(dirname "$proj")")" --skills-dir "$COOP_ROOT/skills")"
    while IFS="$(printf '\t')" read -r _health_code _health_name _health_hint; do
      [ -n "$_health_code" ] || continue
      warn "$_health_code: $_health_name" "$_health_hint"
    done <<EOF
$_health_lines
EOF
  fi
else
  warn "no .coop/project.yml found" "copy $COOP_ROOT/.coop/project.example.yml to your repo's .coop/project.yml"
fi

section "coop-agent repository"
if [ -d "$COOP_ROOT/.git" ] && have git; then
  # Staleness nudge: refresh origin at most once/day (5s watchdog; silent offline),
  # then compare against the release `coop update` would move to — local + instant.
  # A checkout the update cannot move (hold, diverged, no origin/main) is named.
  # The row itself is decided by coop_repo_doctor_row (tests/update-follow.test.sh).
  coop_repo_fetch_throttled || true
  repo_row="$(coop_repo_doctor_row)"
  repo_level=""; repo_msg=""; repo_hint=""
  { IFS= read -r repo_level || true; IFS= read -r repo_msg || true; IFS= read -r repo_hint || true; } <<EOF
$repo_row
EOF
  if [ "$repo_level" = ok ]; then ok "$repo_msg"; else warn "$repo_msg" "$repo_hint"; fi
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
  repair_failed=0
  if [ -f "$COOP_ROOT/scripts/sync.sh" ]; then
    "$COOP_ROOT/scripts/sync.sh" >/dev/null 2>&1 && coop_ok "synced extensions / MCP / assets" || coop_warn "sync had issues (run: coop sync)"
  fi
  if have pipx; then
    if ! have fab; then
      fabric_spec="$(coop_manifest_python_spec ms-fabric-cli)"
      [ -n "$fabric_spec" ] || fabric_spec=ms-fabric-cli
      coop_info "pipx install $fabric_spec"
      if pipx install "$fabric_spec" >/dev/null 2>&1 \
          && coop_converge_fabric_python_packages \
          && coop_ensure_fabric_odbc_driver 1; then
        coop_ok "managed Fabric runtime installed"
      else
        coop_warn "could not install the managed Fabric runtime" "run: coop install"
        repair_failed=1
      fi
    fi
    for t in coop-data-doc coop-sql-review coop-dax-review; do
      if ! have "$t"; then
        coop_info "pipx install $t"
        pipx install "$t" >/dev/null 2>&1 && coop_ok "$t installed" || coop_warn "could not install $t (run: pipx install $t)"
      fi
    done
  fi
  [ "$repair_failed" -eq 0 ] || exit 1
  coop_info "Re-checking… (system deps like node/python/pipx + the Fabric CLI install manually — see hints above)"
  echo >&2
  # Propagate --json/--publish so the re-check emits the machine-readable document.
  # exec skips EXIT traps, so drop the pre-fix records explicitly first.
  if [ "$JSON" = 1 ]; then
    rm -f "$DOCTOR_JSON_TMP"
    if [ "$PUBLISH" = 1 ]; then
      exec "$COOP_ROOT/scripts/doctor.sh" --publish
    else
      exec "$COOP_ROOT/scripts/doctor.sh" --json
    fi
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
  _out="$_out],\"fail\":$FAIL,\"warn\":$WARN"

  if [ "$PUBLISH" = 1 ]; then
    _host="$(hostname 2>/dev/null || echo "unknown")"
    _user="${USER:-${USERNAME:-unknown}}"
    _coop_v="$COOP_VERSION"
    # VERSION reads the same at a tag and at every commit past it, so the snapshot
    # also carries the checkout's git describe ('' for a non-git copy).
    _coop_d="$(coop_repo_describe)"
    _pi_v="$(coop_pi_version || echo "none")"
    _ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    _out="$_out,\"hostname\":\"$(_json_esc "$_host")\",\"user\":\"$(_json_esc "$_user")\",\"coop_version\":\"$(_json_esc "$_coop_v")\",\"coop_describe\":\"$(_json_esc "$_coop_d")\",\"pi_version\":\"$(_json_esc "$_pi_v")\",\"timestamp\":\"$_ts\"}"
    
    # Resolve publish_dir from config or defaults
    _pub_dir=""
    if _py="$(coop_python)"; then
      _pub_dir="$("$_py" -c "
import os, sys
sys.path.insert(0, os.path.join('$COOP_ROOT', 'lib'))
import _yaml
d = _yaml.load(os.path.expanduser('~/.coop/config')) if os.path.exists(os.path.expanduser('~/.coop/config')) else {}
p = _yaml.dig(d, 'fleet.publish_dir')
if not p:
    d = _yaml.load(os.path.join('$COOP_ROOT', 'config/defaults.yml'))
    p = _yaml.dig(d, 'fleet.publish_dir')
print(p or '')
" 2>/dev/null)"
    fi
    
    if [ -n "$_pub_dir" ]; then
      if [ ! -d "$_pub_dir" ]; then
        mkdir -p "$_pub_dir" 2>/dev/null || true
      fi
      if [ -d "$_pub_dir" ]; then
        _dest="$_pub_dir/${_host}_${_user}.json"
        printf '%s\n' "$_out" > "$_dest"
        coop_ok "Published fleet health to $_dest" >&2
      else
        coop_err "fleet.publish_dir '$_pub_dir' is not a valid directory" >&2
      fi
    else
      coop_err "fleet.publish_dir not configured in ~/.coop/config or config/defaults.yml" >&2
    fi
  else
    _out="$_out}"
    printf '%s\n' "$_out"
  fi

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

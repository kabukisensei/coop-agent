# shellcheck shell=bash
# shellcheck disable=SC2034  # shared color/var library: many vars are used by sourcing scripts, not here
# coop-agent shared shell library.
# Sourced by bin/coop and scripts/*.sh. Defines helpers only; never calls `set -e`
# (that is the caller's job) and never `exit`s except via coop_die().

# --- Resolve COOP_ROOT (the directory that contains bin/, lib/, scripts/) -----
# Callers may set COOP_ROOT before sourcing. If unset, derive it from this file's
# own location (lib/common.sh -> repo root is one level up).
if [ -z "${COOP_ROOT:-}" ]; then
  _coop_src="${BASH_SOURCE[0]}"
  while [ -h "$_coop_src" ]; do
    _coop_dir="$(cd -P "$(dirname "$_coop_src")" >/dev/null 2>&1 && pwd)"
    _coop_src="$(readlink "$_coop_src")"
    case "$_coop_src" in /*) ;; *) _coop_src="$_coop_dir/$_coop_src" ;; esac
  done
  _coop_lib_dir="$(cd -P "$(dirname "$_coop_src")" >/dev/null 2>&1 && pwd)"
  COOP_ROOT="$(cd -P "$_coop_lib_dir/.." >/dev/null 2>&1 && pwd)"
  unset _coop_src _coop_dir _coop_lib_dir
fi
export COOP_ROOT

COOP_VERSION="$(cat "$COOP_ROOT/VERSION" 2>/dev/null || echo "0.0.0")"
export COOP_VERSION

# Release manifest: single source of truth for exact versions installed together.
COOP_RELEASE_MANIFEST="${COOP_RELEASE_MANIFEST:-$COOP_ROOT/config/release-manifest.json}"
export COOP_RELEASE_MANIFEST

# Read a dotted path from the release manifest JSON. Usage: coop_manifest_get pi.version
# Falls back to an empty string if the key is missing or JSON is invalid.
# Requires node (install/update already require it); doctor silently returns "" if node is missing.
coop_manifest_get() {
  local key="$1"
  [ -f "$COOP_RELEASE_MANIFEST" ] || return 0
  have node || return 0
  node -e "
const fs = require('fs');
const m = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const parts = process.argv[2].split('.');
let v = m;
for (const p of parts) { if (v == null || typeof v !== 'object') process.exit(0); v = v[p]; }
if (v !== undefined) console.log(String(v));
" "$COOP_RELEASE_MANIFEST" "$key" 2>/dev/null
}

# Read a literal object key (package names may contain dots, slashes, @, or hyphens).
coop_manifest_object_get() {
  local object="$1" key="$2"
  [ -f "$COOP_RELEASE_MANIFEST" ] || return 0
  have node || return 0
  COOP_MANIFEST_OBJECT="$object" COOP_MANIFEST_KEY="$key" node -e '
const m=require(process.argv[1]); const o=m[process.env.COOP_MANIFEST_OBJECT];
if (o && Object.prototype.hasOwnProperty.call(o, process.env.COOP_MANIFEST_KEY)) console.log(String(o[process.env.COOP_MANIFEST_KEY]));
' "$COOP_RELEASE_MANIFEST" 2>/dev/null
}
coop_manifest_extension_spec() { local p="$1" v; v="$(coop_manifest_object_get extensions "$p")"; [ -n "$v" ] && printf 'npm:%s@%s' "$p" "$v"; }
coop_manifest_python_spec() { local p="$1" v; v="$(coop_manifest_object_get python_tools "$p")"; [ -n "$v" ] && printf '%s==%s' "$p" "$v"; }
coop_manifest_npm_tool_spec() { local p="$1" v; v="$(coop_manifest_object_get npm_tools "$p")"; [ -n "$v" ] && printf '%s@%s' "$p" "$v"; }
coop_manifest_mcp_spec() { local p="$1" v; v="$(coop_manifest_object_get mcp_servers "$p")"; [ -n "$v" ] && printf '%s@%s' "$p" "$v"; }

# Every installed version `pi list` reports for one managed extension, one per
# line. Only real package specs count: an extension's *install path* also
# contains its name (and often a version), and counting those lines made an
# installed version read as ambiguous. Also exact-matches the name so
# `pi-mcp-adapter-tools` can never be mistaken for `pi-mcp-adapter`.
# Usage: coop_pi_extension_versions "$pilist" pi-mcp-adapter
coop_pi_extension_versions() {
  local pilist="$1" name="$2" esc core identifier prerelease build semver
  [ -n "$name" ] || return 0
  esc="$(printf '%s' "$name" | sed 's/[][\.^$*+?(){}|]/\\&/g')"
  core='(0|[1-9][0-9]*)'
  identifier='(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
  prerelease="-${identifier}(\.${identifier})*"
  build='\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*'
  semver="${core}\.${core}\.${core}(${prerelease})?(${build})?"
  printf '%s\n' "$pilist" \
    | sed -e 's/\r$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^npm://' \
    | grep -E "^${esc}@${semver}$" \
    | sed -e 's/.*@//' \
    | sort -u
}

# Echo the keys of an object in the manifest (one per line), or nothing on missing/invalid.
# Usage: coop_manifest_keys extensions
coop_manifest_keys() {
  local key="$1"
  [ -f "$COOP_RELEASE_MANIFEST" ] || return 0
  have node || return 0
  node -e "
const fs = require('fs');
const m = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const parts = process.argv[2].split('.');
let v = m;
for (const p of parts) { if (v == null || typeof v !== 'object') process.exit(0); v = v[p]; }
if (v && typeof v === 'object' && !Array.isArray(v)) console.log(Object.keys(v).join('\n'));
" "$COOP_RELEASE_MANIFEST" "$key" 2>/dev/null
}

# --- pipx inventory probes (truthful tool inventory) --------------------------
# `pipx list` output is NEVER authoritative: its cache can be stale and (as seen
# on real workstations) the command can even be shadowed by stubs. The source of
# truth is distribution metadata read INSIDE each venv via `pipx runpip`.

# Root of pipx's venv tree. COOP_PIPX_HOME exists so tests can point this at
# fixtures without touching the workstation.
coop_pipx_venvs_dir() {
  # Same resolution order as lib/common.ps1: env hooks, then the selected
  # pipx binary's own answer, then documented platform/legacy defaults
  # (modern Windows uses LOCALAPPDATA\\pipx\\pipx; legacy Windows ~/pipx).
  if [ -n "${COOP_PIPX_HOME:-}" ]; then printf '%s/venvs' "$COOP_PIPX_HOME"; return 0; fi
  if [ -n "${PIPX_HOME:-}" ]; then printf '%s/venvs' "$PIPX_HOME"; return 0; fi
  # PIPX_LOCAL_VENVS is ALREADY the complete venvs directory - never append
  # another "venvs" (that produced .../venvs/venvs and broke every probe).
  # COOP_PIPX_BIN pins the binary so PATH shadows/stubs cannot lie to us.
  local pcmd v
  pcmd="$(coop_pipx_cmd)"
  if [ -n "$pcmd" ] && have "$pcmd"; then
    v="$("$pcmd" environment --value PIPX_LOCAL_VENVS 2>/dev/null | head -1)"
    [ -n "$v" ] && { printf '%s' "$v"; return 0; }
  fi
  local c
  for c in "$HOME/.local/pipx" "$HOME/pipx" \
           "${LOCALAPPDATA:-}/pipx/pipx"; do
    [ -n "$c" ] && [ -d "$c" ] && { printf '%s/venvs' "$c"; return 0; }
  done
  printf '%s/venvs' "${HOME:-}/.local/pipx"
}

# The pipx command used for inventory probes. COOP_PIPX_BIN lets callers pin an
# exact binary — useful when PATH carries shadows/stubs, and in tests.
coop_pipx_cmd() {
  printf '%s' "${COOP_PIPX_BIN:-pipx}"
}

# Installed version of a pipx-managed distribution from in-venv metadata.
# $1 = venv name, $2 = distribution name. Empty + rc 1 when unavailable.
coop_venv_dist_version() {
  local pipx; pipx="$(coop_pipx_cmd)"
  [ -n "$pipx" ] || return 1
  local out
  out="$("$pipx" runpip "$1" show "$2" 2>/dev/null)" || return 1
  printf '%s\n' "$out" | sed -n 's/^Version: //p' | head -1
}

# Python version inside a pipx venv, resolved directly — uv-backed pipx has no
# `runpip --version`. Prints e.g. 3.13.13; nothing when unresolvable.
coop_venv_python_path() { # <venv-name>
  local base py
  base="$(coop_pipx_venvs_dir)/$1"
  for py in "$base/bin/python" "$base/bin/python3" "$base/Scripts/python.exe"; do
    [ -f "$py" ] && { printf '%s' "$py"; return 0; }
  done
  return 1
}

coop_venv_python_version() { # <venv-name>
  local py
  py="$(coop_venv_python_path "$1")" || return 1
  "$py" -c 'import platform;print(platform.python_version())' 2>/dev/null
}

# Resolve a bootstrap interpreter supported by ms-fabric-cli (<3.14, >=3.10).
# This is only for creating/rebuilding the pipx environment. Live Fabric Python
# always comes from that environment unless COOP_FABRIC_PYTHON explicitly selects
# an operator-managed runtime.
# Last ERROR line of captured pip output, trimmed — for actionable warnings.
coop_pip_error_tail() { # <captured output>
  local reason="" line
  while IFS= read -r line; do
    case "$line" in *ERROR:*) reason="${line#"${line%%[![:space:]]*}"}" ;; esac
  done <<PIPERR
$1
PIPERR
  [ -n "$reason" ] || return 0
  if [ "${#reason}" -gt 160 ]; then reason="${reason:0:157}..."; fi
  printf '%s' "$reason"
}

coop_fabric_bootstrap_python() {
  local c v pycmd
  for c in python3.13 python3.12; do
    command -v "$c" >/dev/null 2>&1 || continue
    v="$("$c" -c 'import sys;print("%d.%d" % sys.version_info[:2])' 2>/dev/null)"
    case "$v" in 3.10|3.11|3.12|3.13) command -v "$c"; return 0 ;; esac
  done
  # Windows' Python launcher can locate versioned interpreters even when their
  # directories are not on PATH. Return the real executable for pipx --python.
  if command -v py >/dev/null 2>&1; then
    for v in 3.13 3.12; do
      pycmd="$(py -"$v" -c 'import sys;print(sys.executable)' 2>/dev/null | head -1)"
      [ -n "$pycmd" ] && { printf '%s' "$pycmd"; return 0; }
    done
  fi
  # Side-by-side interpreters that are NOT on PATH (Git Bash on Windows):
  #   Python install manager: %LOCALAPPDATA%\Python\bin\python3.1x.exe
  #   winget user-scope:      %LOCALAPPDATA%\Programs\Python\Python31x\python.exe
  if [ -n "${LOCALAPPDATA:-}" ]; then
    for c in "python3.13.exe" "python3.12.exe" "Programs/Python/Python313/python.exe" "Programs/Python/Python312/python.exe"; do
      pycmd="$LOCALAPPDATA/Python/bin/$c"
      case "$c" in Programs/*) pycmd="$LOCALAPPDATA/$c" ;; esac
      [ -f "$pycmd" ] || continue
      v="$("$pycmd" -c 'import sys;print("%d.%d" % sys.version_info[:2])' 2>/dev/null)"
      case "$v" in 3.10|3.11|3.12|3.13) printf '%s' "$pycmd"; return 0 ;; esac
    done
  fi
  for c in python3 python; do
    command -v "$c" >/dev/null 2>&1 || continue
    v="$($c -c 'import sys;print("%d.%d" % sys.version_info[:2])' 2>/dev/null)"
    case "$v" in 3.10|3.11|3.12|3.13) command -v "$c"; return 0 ;; esac
  done
  return 1
}

# The `pipx install` flag that makes pipx download a standalone Python when the
# requested version is not installed: pipx 1.12+ spells it --fetch-python=missing,
# pipx 1.5-1.11 --fetch-missing-python (still accepted by newer pipx as a
# deprecated alias, so the current spelling is tried first). Prints nothing and
# returns 1 when this pipx cannot fetch a Python (pipx < 1.5, or no pipx).
# Optional args are the pipx invocation to probe (e.g. python3 -m pipx for a pipx
# that is installed but not on PATH yet); default: coop_pipx_cmd.
coop_pipx_fetch_python_flag() { # [pipx-cmd [args...]]
  local help
  [ $# -gt 0 ] || set -- "$(coop_pipx_cmd)"
  command -v "$1" >/dev/null 2>&1 || return 1
  help="$("$@" install --help 2>&1)" || true
  case "$help" in
    *--fetch-python*) printf '%s' '--fetch-python=missing'; return 0 ;;
    *--fetch-missing-python*) printf '%s' '--fetch-missing-python'; return 0 ;;
  esac
  return 1
}

# How the Fabric CLI's pipx environment gets a supported interpreter, as one
# tab-separated line "<python><TAB><fetch-flag>": a local 3.10-3.13 interpreter
# (fetch-flag empty), or "3.12" plus the flag from coop_pipx_fetch_python_flag when
# only pipx's standalone download can supply one. Prints nothing and returns 1
# when neither is possible — then prerequisite row 3 (coop_prereq_rows) says what
# to install. Shared by install, update and `coop doctor --fix`, so every path
# builds the environment the same way:
#   pipx install [--force] ${fetch:+"$fetch"} --python "$py" ms-fabric-cli==<pin>
coop_fabric_pipx_plan() {
  local py flag=''
  py="$(coop_fabric_bootstrap_python 2>/dev/null)" || py=''
  if [ -z "$py" ]; then
    flag="$(coop_pipx_fetch_python_flag 2>/dev/null)" || return 1
    py='3.12'
  fi
  printf '%s\t%s' "$py" "$flag"
}

# Exact Python runtime for live Fabric SQL. The managed ms-fabric-cli pipx
# environment is the default; an explicit override is operator-managed and is
# validated here but never changed by Coop.
coop_fabric_python() {
  local py
  if [ -n "${COOP_FABRIC_PYTHON:-}" ]; then
    py="$COOP_FABRIC_PYTHON"
    case "$py" in /*|[A-Za-z]:[\\/]*) ;; *) return 1 ;; esac
  else
    py="$(coop_venv_python_path ms-fabric-cli)" || return 1
  fi
  [ -f "$py" ] && [ -x "$py" ] || return 1
  "$py" -c 'import sys; raise SystemExit(0 if sys.executable else 1)' >/dev/null 2>&1 || return 1
  printf '%s' "$py"
}

# Verify the selected runtime's exact pyodbc metadata/import and Driver 18+.
# Stable tab-separated state is consumed by install/update/sync and Doctor.
coop_fabric_sql_runtime_status() {
  local py pin
  py="$(coop_fabric_python)" || { printf 'runtime_missing'; return 1; }
  pin="$(coop_manifest_get python_tools.pyodbc)"
  "$py" -c 'import importlib.metadata as m,re,sys
pin=sys.argv[1]
try:
 v=m.version("pyodbc")
except Exception:
 print("pyodbc_missing"); raise SystemExit(2)
if v != pin:
 print("pyodbc_wrong\t"+v); raise SystemExit(3)
try:
 import pyodbc
except Exception:
 print("pyodbc_unloadable"); raise SystemExit(4)
majors=[int(x.group(1)) for d in pyodbc.drivers() for x in [re.fullmatch(r"ODBC Driver ([0-9]+) for SQL Server",d)] if x]
if not majors or max(majors) < 18:
 print("driver_missing\t"+v); raise SystemExit(5)
print("ready\t"+v+"\t"+str(max(majors)))' "$pin" 2>/dev/null
}

# Converge libraries into the managed runtime, or only verify an explicit
# operator-managed override. Failed injection and failed postchecks are real failures.
coop_converge_fabric_python_packages() { # [edge:0|1]
  local edge="${1:-0}" pipx pin pkg spec out py
  if [ -z "${COOP_FABRIC_PYTHON:-}" ]; then
    pipx="$(coop_pipx_cmd)"
    for pkg in fabric-cicd pyodbc; do
      pin="$(coop_manifest_get "python_tools.$pkg")"
      [ -n "$pin" ] || return 1
      spec="$pkg==$pin"
      if [ "$edge" = 1 ] && [ "$pkg" = fabric-cicd ]; then spec="$pkg"; fi
      out="$("$pipx" inject ms-fabric-cli "$spec" --force 2>&1)" || {
        coop_warn "failed to install $spec in the ms-fabric-cli environment" "$(coop_pip_error_tail "$out")"
        return 1
      }
    done
  fi
  py="$(coop_fabric_python)" || return 1
  pin="$(coop_manifest_get python_tools.pyodbc)"
  "$py" -c 'import importlib.metadata as m,sys; import pyodbc; raise SystemExit(0 if m.version("pyodbc")==sys.argv[1] else 1)' "$pin" >/dev/null 2>&1
}

coop_ensure_fabric_odbc_driver() { # <allow-prereqs:0|1>
  local status root_ps allow_ps='$false'
  [ "$1" = 1 ] && allow_ps='$true'
  status="$(coop_fabric_sql_runtime_status 2>/dev/null)" && return 0
  case "$status" in driver_missing*) ;; *) return 1 ;; esac
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*)
      root_ps="$COOP_ROOT"
      if command -v cygpath >/dev/null 2>&1; then root_ps="$(cygpath -w "$COOP_ROOT")"; fi
      COOP_ROOT="$root_ps" powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ". (Join-Path \$env:COOP_ROOT 'lib\\common.ps1'); if (Ensure-CoopFabricOdbcDriver $allow_ps) { exit 0 } else { exit 1 }"
      ;;
    *)
      coop_warn "ODBC Driver 18+ for SQL Server is missing" "install Microsoft ODBC Driver 18 for SQL Server, then run: coop doctor"
      return 0
      ;;
  esac
}

# The installed distribution's own Requires-Python metadata, read from inside
# its venv. Empty when absent/unreadable. The probe program carries a marker so
# fixture interpreters can recognise it in tests.
coop_venv_requires_python() { # <venv-name> <distribution>
  local py out
  py="$(coop_venv_python_path "$1")" || return 1
  out="$("$py" -c '# coop-requires-python-probe
import sys
from importlib.metadata import metadata
print(metadata(sys.argv[1]).get("Requires-Python") or "")' "$2" 2>/dev/null)" || return 1
  printf '%s' "$out"
}

# Evaluate <pyver> against a PEP 440 Requires-Python specifier subset:
# comma-separated <, <=, >, >=, ==, != tokens (optionally "X.Y.*" wildcards).
# Anything unparseable counts as MATCHING — never warn on uncertainty.
_coop_vkey() { # <version> -> comparable integer (major*1e6+minor*1e3+patch)
  local v="${1#v}" p1 p2 p3
  v="${v%%[^0-9.]*}"
  IFS=. read -r p1 p2 p3 <<<"$v"
  printf '%d' "$(( ${p1:-0} * 1000000 + ${p2:-0} * 1000 + ${p3:-0} ))"
}
coop_python_matches_spec() { # <pyver> <spec>
  local py="$1" spec="${2:-}"
  [ -z "$spec" ] && return 0
  local key_want key_py tok op want wild parts scale mod_w mod_p i
  key_py="$(_coop_vkey "$py")"
  local oldIFS=$IFS
  IFS=','
  set -- $spec
  IFS=$oldIFS
  for tok in "$@"; do
    tok="${tok#"${tok%%[![:space:]]*}"}"; tok="${tok%"${tok##*[![:space:]]}"}"
    [ -z "$tok" ] && continue
    # Unparseable syntax ('~=', exotic markers) counts as matching: never warn on uncertainty.
    if [[ "$tok" == '~='* ]]; then return 0; fi
    if [[ "$tok" != *[0-9]* || "$tok" == *[\\\`\"]* ]]; then return 0; fi
    op=''
    case "$tok" in
      '=='*) op='=='; want="${tok#==}" ;;
      '!='*) op='!='; want="${tok#!=}" ;;
      '>='*) op='>='; want="${tok#>=}" ;;
      '<='*) op='<='; want="${tok#<=}" ;;
      '>'*) op='>'; want="${tok#>}" ;;
      '<'*) op='<'; want="${tok#<}" ;;
      *) return 0 ;;
    esac
    wild=''
    case "$want" in
      *'.*'|"*") wild=1; want="${want%\*}"; want="${want%.}" ;;
    esac
    want="${want#v}"
    if [[ -z "$want" || "$want" == *[!0-9.]* ]]; then return 0; fi
    key_want="$(_coop_vkey "$want")"
    if [ -n "$wild" ]; then
      parts="$(awk -F. '{print NF}' <<<"$want")"
      scale=1
      for (( i = 3; i > parts; i-- )); do scale=$(( scale * 1000 )); done
      mod_w=$(( key_want / scale )); mod_p=$(( key_py / scale ))
      if [ "$op" = '==' ] && [ "$mod_p" -ne "$mod_w" ]; then return 1; fi
      if [ "$op" = '!=' ] && [ "$mod_p" -eq "$mod_w" ]; then return 1; fi
      continue
    fi
    case "$op" in
      '<')  [ "$key_py" -lt "$key_want" ] || return 1 ;;
      '<='*) [ "$key_py" -le "$key_want" ] || return 1 ;;
      '>')  [ "$key_py" -gt "$key_want" ] || return 1 ;;
      '>='*) [ "$key_py" -ge "$key_want" ] || return 1 ;;
      '==') [ "$key_py" -eq "$key_want" ] || return 1 ;;
      '!=') [ "$key_py" -ne "$key_want" ] || return 1 ;;
    esac
  done
  return 0
}

# Which pipx venv does <command> resolve to? Echoes the venv name, or fails when
# the executable is absent or outside pipx's tree. Checks both the resolved path
# (venv bin dirs) and the interpreter shebang (console scripts on macOS are plain
# files whose first line points at the venv python).
coop_exe_pipx_venv() { # <command>
  local p head vdir norm real_vdir tgt
  p="$(command -v "$1" 2>/dev/null)" || return 1
  [ -n "$p" ] || return 1
  # Follow symlinks so shims dropped in ~/.local/bin resolve to their target.
  if [ -L "$p" ]; then
    tgt="$(readlink "$p")"
    case "$tgt" in
      /*) p="$tgt" ;;
      *) p="$(dirname "$p")/$tgt" ;;
    esac
  fi
  vdir="$(coop_pipx_venvs_dir)"
  # macOS resolves /var -> /private/var etc.: compare against BOTH the raw and
  # the physically-resolved prefix so neither environment lies to us.
  real_vdir="$vdir"
  [ -d "$vdir" ] && real_vdir="$(cd "$vdir" && pwd -P)"
  norm="$(cd "$(dirname "$p")" && pwd -P)/$(basename "$p")"
  case "$norm" in
    "$vdir"/*) printf '%s' "${norm#"$vdir"/}" | cut -d/ -f1; return 0 ;;
    "$real_vdir"/*) printf '%s' "${norm#"$real_vdir"/}" | cut -d/ -f1; return 0 ;;
  esac
  head="$(head -c 512 "$p" 2>/dev/null || true)"
  case "$head" in
    "$vdir"/*|"$real_vdir"/*)
      local rest="${head#*/venvs/}"
      printf '%s' "$rest" | cut -d/ -f1
      return 0
      ;;
  esac
  return 1
}

# Select an npm launcher that actually executes. Some workstation shims return
# success with no version/output, which otherwise makes extension convergence a
# silent no-op. COOP_NPM_FALLBACK is a test/managed-install override; Homebrew is
# the common real launcher behind a broken user-level shim on macOS.
coop_working_npm() {
  local cand v
  cand="$(command -v npm 2>/dev/null || true)"
  if [ -n "$cand" ]; then
    if v="$("$cand" --version 2>/dev/null)"; then
      v="$(printf '%s' "$v" | tr -d '[:space:]')"
      if [ -n "$v" ]; then printf '%s\n' "$cand"; return 0; fi
    fi
  fi
  for cand in "${COOP_NPM_FALLBACK:-}" /opt/homebrew/bin/npm; do
    [ -n "$cand" ] && [ -x "$cand" ] || continue
    if v="$("$cand" --version 2>/dev/null)"; then
      v="$(printf '%s' "$v" | tr -d '[:space:]')"
      if [ -n "$v" ]; then printf '%s\n' "$cand"; return 0; fi
    fi
  done
  return 1
}

# Converge the isolated tree's recorded extension dependencies to EXACT
# versions and reinstall. `pi install` records ^-ranges, so fresh trees would
# otherwise materialize at latest-in-range; exact dependency specs make
# "converged to the release pin" deterministic. This is PRODUCTION convergence:
# scripts/test-pi-matrix.* rely on this same path, never their own.
coop_converge_extension_pins() { # <agent-dir> <name@ver>...
  local agent_dir="$1"; shift
  # Fast path: already-at-pin trees are coherent without touching npm.
  local need=0 spec nm want got
  for spec in "$@"; do
    nm="${spec%@*}"; want="${spec##*@}"
    got="$(coop_ext_installed_version "$agent_dir" "$nm")"
    [ "$got" != "$want" ] && need=1
  done
  # `pi install` already lands every extension at its exact pin, so the fast
  # path alone would never reach the lockfile (seen on the VM, #152): a tree
  # whose package-lock.json is not the shipped lock still needs the npm ci.
  local pi_ver
  pi_ver="$(coop_pi_version 2>/dev/null || true)"
  if [ "$need" != 1 ] && coop_extensions_lock_pending "$agent_dir" "$pi_ver"; then need=1; fi
  [ "$need" = 1 ] || return 0
  have node || return 1
  local npm_bin
  npm_bin="$(coop_working_npm)" || return 1
  local pj="$agent_dir/npm/package.json"
  if [ ! -f "$pj" ]; then
    mkdir -p "$agent_dir/npm"
    printf '{\n  "name": "pi-extensions",\n  "private": true\n}\n' > "$pj"
  fi
  node "$COOP_ROOT/lib/pins.js" "$agent_dir" "$@" || return 1
  # This npm install auto-installs peers. Pin the agent peer (and pi-ai/pi-tui) to
  # the running Pi first (#122); unpinned, npm fetched the newest agent into the
  # tree seconds after upstream published it. Best-effort, like the alignment.
  local py
  if [ -n "$pi_ver" ] && py="$(coop_python)"; then
    "$py" "$COOP_ROOT/lib/_extdeps.py" align "$agent_dir" "$pi_ver" >/dev/null 2>&1 || true
  fi
  # Reproducible path (#152): the release ships npm's lockfile for this exact
  # extension set, so `npm ci` installs the same transitive versions on every
  # machine. Falls back to a plain install when the lock cannot apply.
  if coop_apply_extensions_lock "$agent_dir" "$npm_bin" "$pi_ver"; then return 0; fi
( cd "$agent_dir/npm" && "$npm_bin" install --silent --no-audit --no-fund >/dev/null 2>&1 ) || return 1
}

# Install the isolated tree from the release lockfile (config/extensions-lock.json,
# generated by `node lib/extlock.js generate`; issue #152). Applies only when the
# lock can hold: the installed Pi is the manifest's Pi (the lock resolves pi-ai /
# pi-tui / the agent peer to that version, so an --edge or matrix Pi needs a live
# resolution) and the tree's package.json declares exactly the lock's root
# dependencies (`npm ci` refuses anything else). Returns 0 when the tree was
# installed from the lock; 1 when the lock does not apply (caller resolves live)
# or `npm ci` failed (the caller's install then repairs the tree). Mirror of
# Install-CoopExtensionsLock. Lifecycle scripts run as they do for a plain
# install (better-sqlite3, context-mode and sharp build or fetch their binaries).
# True (0) when the shipped lock applies to this install (lock present, installed
# Pi is the manifest's Pi) but the tree does not carry it yet: no
# package-lock.json beside the tree's package.json, or one that differs from
# config/extensions-lock.json. Mirror of Test-CoopExtensionsLockPending.
coop_extensions_lock_pending() { # <agent-dir> <installed-pi-version>
  local lock="$COOP_ROOT/config/extensions-lock.json" want
  [ -f "$lock" ] || return 1
  want="$(coop_manifest_get pi.version)"
  [ -n "$want" ] && [ "$2" = "$want" ] || return 1
  [ -f "$1/npm/package-lock.json" ] || return 0
  cmp -s "$lock" "$1/npm/package-lock.json" && return 1
  return 0
}

coop_apply_extensions_lock() { # <agent-dir> <npm-bin> <installed-pi-version>
  local agent_dir="$1" npm_bin="$2" pi_ver="$3"
  local lock="$COOP_ROOT/config/extensions-lock.json" want
  [ -f "$lock" ] || return 1
  have node || return 1
  want="$(coop_manifest_get pi.version)"
  [ -n "$want" ] && [ "$pi_ver" = "$want" ] || return 1
  node "$COOP_ROOT/lib/extlock.js" matches "$agent_dir" "$lock" >/dev/null 2>&1 || return 1
  cp "$lock" "$agent_dir/npm/package-lock.json" 2>/dev/null || return 1
  if ( cd "$agent_dir/npm" && "$npm_bin" ci --no-audit --no-fund >/dev/null 2>&1 ); then
    return 0
  fi
  rm -f "$agent_dir/npm/package-lock.json" 2>/dev/null || true
  return 1
}

# Version of an installed Pi extension inside an isolated agent dir, read from
# its package.json. Empty when absent or unreadable — callers treat that as a
# failed postcondition, never as success.
coop_ext_installed_version() { # <agent-dir> <extension-name>
  local f="$1/npm/node_modules/$2/package.json"
  [ -f "$f" ] || return 0
  have node || return 0
  node -e "
const fs = require('fs');
try {
  const v = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')).version;
  if (typeof v === 'string' && v) console.log(v);
} catch {}
" "$f" 2>/dev/null
}

# Compare installed version against expected. Echo one of: ok missing older newer-than-tested wrong-version not-applicable
# $1 = installed (may be empty), $2 = expected (may be empty), $3 = optional name (for logging)
coop_manifest_status() {
  local installed="$1" expected="$2"
  if [ -z "$installed" ]; then echo "missing"; return; fi
  if [ -z "$expected" ]; then echo "not-applicable"; return; fi
  if [ "$installed" = "$expected" ]; then echo "ok"; return; fi
  # Normalize for comparison: strip leading 'v' if present.
  local i="${installed#v}" e="${expected#v}"
  if coop_version_lt "$i" "$e"; then echo "older"; return; fi
  if coop_minor_newer "$i" "$e"; then echo "newer-than-tested"; return; fi
  # Same major.minor but different patch, or any other mismatch.
  echo "wrong-version"
}

# Ensure user tool bins (pipx, Homebrew, standard local bins) are on PATH in-process
[ -d "$HOME/.local/bin" ] && case ":$PATH:" in *":$HOME/.local/bin:"*) : ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac
[ -n "${COOP_TEST_STUB_PATH:-}" ] || [ ! -d "/opt/homebrew/bin" ] || case ":$PATH:" in *":/opt/homebrew/bin:"*) : ;; *) PATH="/opt/homebrew/bin:$PATH" ;; esac
[ -n "${COOP_TEST_STUB_PATH:-}" ] || [ ! -d "/usr/local/bin" ] || case ":$PATH:" in *":/usr/local/bin:"*) : ;; *) PATH="/usr/local/bin:$PATH" ;; esac
# Offline fleet tests explicitly re-prepend their stub bin after workstation PATH normalization.
[ -n "${COOP_TEST_STUB_PATH:-}" ] && PATH="$COOP_TEST_STUB_PATH:$PATH"

# --- Colors (respect NO_COLOR and non-TTY) -----------------------------------
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  # Cooptimize brand palette (256-ish approximations of the truecolor brand).
  COOP_NAVY=$'\033[38;2;0;65;107m'
  COOP_FOREST=$'\033[38;2;66;120;60m'
  COOP_OLIVE=$'\033[38;2;130;170;67m'
  COOP_LIME=$'\033[38;2;178;210;53m'
  COOP_RED=$'\033[38;2;239;65;45m'
  COOP_BOLD=$'\033[1m'
  COOP_DIM=$'\033[2m'
  COOP_RST=$'\033[0m'
else
  COOP_NAVY=''; COOP_FOREST=''; COOP_OLIVE=''; COOP_LIME=''; COOP_RED=''
  COOP_BOLD=''; COOP_DIM=''; COOP_RST=''
fi

# --- Logging -----------------------------------------------------------------
# All log lines go to stderr. When a progress live-region is active on a TTY,
# _coop_emit lifts the pinned bar/spinner, prints the line above it, then redraws
# the region — so ordinary logs scroll normally while the bar stays pinned to the
# bottom. When no region is active (the common case — doctor/sync/update/etc.) it
# is a plain printf and behaves exactly as before.
_coop_emit() {
  if [ "${COOP_PROG_ACTIVE:-0}" = 1 ] && _coop_prog_tty; then
    _coop_prog_lift
    printf '%s\n' "$1" >&2
    _coop_prog_draw
  else
    printf '%s\n' "$1" >&2
  fi
}
coop_say()  { _coop_emit "$*"; }
coop_info() { _coop_emit "$(printf '%s•%s %s' "$COOP_LIME"   "$COOP_RST" "$*")"; }
coop_ok()   { _coop_emit "$(printf '%s✓%s %s' "$COOP_FOREST" "$COOP_RST" "$*")"; }
coop_warn() { _coop_emit "$(printf '%s!%s %s' "$COOP_OLIVE"  "$COOP_RST" "$1${2:+ — $2}")"; }
coop_err()  { _coop_emit "$(printf '%s✗%s %s' "$COOP_RED"    "$COOP_RST" "$*")"; }
coop_die()  { coop_err "$*"; exit 1; }
coop_head() { _coop_emit "$(printf '\n%s%s%s%s' "$COOP_BOLD" "$COOP_NAVY" "$*" "$COOP_RST")"; }

# --- Progress: one determinate "overall" bar + an animated active-item line ---
# Built for installers where each item (npm/pipx/pi install) takes a while and its
# own % is unknowable. The bar is determinate at the ITEM level (we know the total
# up front); the active item shows a braille spinner + elapsed seconds so it is
# obviously alive. Animates only on a TTY (respects NO_COLOR / dumb term); anywhere
# else it degrades to plain "• starting…" / "✓ done" lines so CI logs still move.
COOP_PROG_ACTIVE=0
COOP_PROG_TOTAL=0
COOP_PROG_DONE=0
COOP_PROG_W=22
COOP_PROG_COLS=80
COOP_PROG_SPINLINE=''
COOP_SPIN_FRAMES=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)

_coop_prog_tty() { [ -t 2 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ] && [ "${COOP_PROG_COLS:-80}" -ge 24 ]; }

# Render the overall bar (no newline). Filled cells lime, empty dim. Never byte-
# slices the multibyte block glyphs — it builds whole-cell strings instead.
_coop_prog_bar() {
  local total="$COOP_PROG_TOTAL" done="$COOP_PROG_DONE" w="$COOP_PROG_W" i on='' off=''
  [ "$total" -gt 0 ] || total=1
  [ "$done" -le "$total" ] || done="$total"
  local fill=$(( done * w / total )) pct=$(( done * 100 / total ))
  for (( i=0; i<fill; i++ )); do on+='█'; done
  for (( i=fill; i<w;    i++ )); do off+='░'; done
  printf '  [%s%s%s%s%s] %d/%d  %d%%' "$COOP_LIME" "$on" "$COOP_DIM" "$off" "$COOP_RST" "$done" "$total" "$pct"
}

# Render the active-item line (no newline). Label is char-safe to truncate (ASCII
# package names); kept short so the 2-line region never wraps and breaks the math.
_coop_prog_spin() {
  local g="$1" label="$2" el="$3" max
  max=$(( COOP_PROG_COLS - 14 )); [ "$max" -lt 8 ] && max=8; [ "$max" -gt 48 ] && max=48
  [ "${#label}" -le "$max" ] || label="${label:0:max-1}…"
  printf '  %s%s%s %s %s(%ds)%s' "$COOP_LIME" "$g" "$COOP_RST" "$label" "$COOP_DIM" "$el" "$COOP_RST"
}

# Draw the 2-line region (bar + active item) at the cursor, parking the cursor back
# at the start of the bar line so the next lift/draw lines up. Relative moves only,
# so terminal scrolling at the bottom edge stays correct.
_coop_prog_draw() {
  _coop_prog_tty || return 0
  printf '\r\033[2K%s\n' "$(_coop_prog_bar)" >&2   # bar line
  printf '\033[2K%s'     "$COOP_PROG_SPINLINE" >&2  # active-item line
  printf '\033[1A\r'                            >&2  # back up to bar line, col 0
}

# Erase the 2-line region, leaving the cursor at the (now empty) bar line, col 0.
_coop_prog_lift() {
  _coop_prog_tty || return 0
  printf '\r\033[2K' >&2     # clear bar line
  printf '\n\033[2K' >&2     # down to active-item line, clear it
  printf '\033[1A\r' >&2     # back up to bar line, col 0
}

coop_progress_begin() {
  COOP_PROG_TOTAL="${1:-0}"; COOP_PROG_DONE=0; COOP_PROG_SPINLINE=''; COOP_PROG_ACTIVE=1
  # Read the controlling terminal's width directly (</dev/tty) so a redirected
  # stdout/stderr doesn't fool us into the 80 fallback.
  COOP_PROG_COLS="$( { tput cols </dev/tty; } 2>/dev/null || printf '%s' "${COLUMNS:-80}" )"
  case "$COOP_PROG_COLS" in ''|*[!0-9]*) COOP_PROG_COLS=80 ;; esac
  # Clamp the bar so the whole bar line ("  [" + W + "]  N/N  NN%") stays on one
  # row — otherwise it wraps and the single-row \033[1A cursor math corrupts.
  # (_coop_prog_tty also refuses to animate below 24 cols.)
  COOP_PROG_W=22
  [ "$COOP_PROG_COLS" -lt 38 ] && COOP_PROG_W=$(( COOP_PROG_COLS - 16 ))
  [ "$COOP_PROG_W" -lt 6 ] && COOP_PROG_W=6
  if _coop_prog_tty; then printf '\033[?25l' >&2; _coop_prog_draw; fi   # hide cursor, draw 0%
}

coop_progress_end() {
  if [ "${COOP_PROG_ACTIVE:-0}" = 1 ] && _coop_prog_tty; then
    _coop_prog_lift
    COOP_PROG_SPINLINE=''
    printf '%s\n'      "$(_coop_prog_bar)" >&2    # leave a permanent completed bar
    printf '\033[?25h'                     >&2    # restore cursor
  fi
  COOP_PROG_ACTIVE=0
}

# Tear down an in-flight unit's background work + temp file. The installer wires
# this into its INT/TERM/EXIT trap so Ctrl-C doesn't leave an orphaned install
# (best-effort: kills the unit subshell; an already-spawned npm/pipx child may
# still finish, but re-running install is idempotent).
COOP_UNIT_PID=''
COOP_UNIT_TMP=''
_coop_unit_cleanup() {
  [ -n "${COOP_UNIT_PID:-}" ] && kill "$COOP_UNIT_PID" 2>/dev/null
  [ -n "${COOP_UNIT_TMP:-}" ] && rm -f "$COOP_UNIT_TMP" 2>/dev/null
  COOP_UNIT_PID=''; COOP_UNIT_TMP=''
}

# coop_unit "<label>" <fn> [args…]
#   Runs `<fn args>` in the background; its stdout becomes the permanent result
#   message, its exit status decides ✓ (0) vs ! (non-zero). While it runs, the
#   active-item line animates under the overall bar; on completion the bar advances
#   by one. Returns the unit's exit status. The work runs in a subshell so it sees
#   the caller's functions/vars but only its stdout + status flow back.
coop_unit() {
  local label="$1"; shift
  local tmp; tmp="$(mktemp 2>/dev/null || printf '%s' "${TMPDIR:-/tmp}/coop.$$.$RANDOM")"
  ( "$@" >"$tmp" 2>/dev/null ) &
  local pid=$!
  COOP_UNIT_PID="$pid"; COOP_UNIT_TMP="$tmp"     # so the trap can reap us on Ctrl-C
  if _coop_prog_tty && [ "${COOP_PROG_ACTIVE:-0}" = 1 ]; then
    local start=$SECONDS n=${#COOP_SPIN_FRAMES[@]} i=0 el
    while kill -0 "$pid" 2>/dev/null; do
      el=$(( SECONDS - start ))
      COOP_PROG_SPINLINE="$(_coop_prog_spin "${COOP_SPIN_FRAMES[i % n]}" "$label" "$el")"
      _coop_prog_draw
      i=$(( i + 1 ))
      sleep 0.12
    done
  else
    coop_info "${label}…"         # non-TTY: at least show the slow step started
                                  # (braces required: bash 3.2 mis-scans $var+multibyte)
  fi
  wait "$pid"; local st=$?
  local msg; msg="$(cat "$tmp" 2>/dev/null)"; rm -f "$tmp" 2>/dev/null
  COOP_UNIT_PID=''; COOP_UNIT_TMP=''             # unit finished — nothing to reap
  [ -n "$msg" ] || msg="$label"
  COOP_PROG_DONE=$(( COOP_PROG_DONE + 1 ))
  COOP_PROG_SPINLINE=''
  if [ "$st" -eq 0 ]; then coop_ok "$msg"; else coop_warn "$msg"; fi
  return "$st"
}

# --- Small utilities ---------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

# coop runs Pi against an ISOLATED agent dir so coop's extensions/settings/theme
# never mix with the user's personal `pi` (~/.pi/agent). Override with COOP_AGENT_DIR.
coop_pi_agent_dir() { printf '%s' "${COOP_AGENT_DIR:-$HOME/.coop/agent}"; }

# The user's *global* Pi agent dir (used to share credentials into coop's isolated dir).
coop_global_pi_agent_dir() { printf '%s' "$HOME/.pi/agent"; }

# The agent dir Pi will ACTUALLY load, so the launch preflight guards the right tree.
# bin/coop exports PI_CODING_AGENT_DIR only when isolation is on; with COOP_NO_ISOLATE=1
# Pi falls back to ~/.pi/agent. Using the isolated dir unconditionally would guard (and
# reinstall into) a tree Pi isn't even using.
coop_effective_agent_dir() {
  if [ -n "${PI_CODING_AGENT_DIR:-}" ]; then printf '%s' "$PI_CODING_AGENT_DIR"; return 0; fi
  if [ "${COOP_NO_ISOLATE:-0}" = "1" ]; then coop_global_pi_agent_dir; else coop_pi_agent_dir; fi
}

# True when Pi has a stored provider credential in the agent tree Coop will
# actually load. Environment-only credentials intentionally do not count: this
# helper gates the one-time interactive /login handoff requested by onboarding.
# Pi writes an empty `{}` auth.json on startup, so a non-empty file is not proof
# of a login (#167): at least one provider entry must be an object.
coop_pi_login_present() {
  coop_auth_has_credential "$(coop_effective_agent_dir)/auth.json"
}

# True when the given auth.json holds a stored provider credential (#167). Pi
# writes `{}` on startup, so a non-empty file alone is not a login.
coop_auth_has_credential() {
  local auth="$1" py
  [ -s "$auth" ] || return 1
  if py="$(coop_python 2>/dev/null)" && [ -n "$py" ]; then
    "$py" - "$auth" <<'PY' >/dev/null 2>&1
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8-sig") as fh:
        data = json.load(fh)
except Exception:
    sys.exit(1)
ok = isinstance(data, dict) and any(isinstance(v, dict) and v for v in data.values())
sys.exit(0 if ok else 1)
PY
    return $?
  fi
  # No Python: a provider key whose value is an object ("name": {).
  grep -Eq '"[^"]+"[[:space:]]*:[[:space:]]*\{' "$auth"
}

# Pick a usable python interpreter (for YAML/JSON parsing). Prefer python3.
coop_python() {
  if have python3; then echo python3
  elif have python; then echo python
  else return 1
  fi
}

# The Pi agent's own semver, e.g. "0.80.2" (from `pi --version`). Echoes "" if unknown.
coop_pi_version() {
  have pi || return 0
  pi --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

# True (0) if version $1's MAJOR.MINOR is strictly newer than $2's (patch ignored). Used
# to gate `coop update` at the tested-Pi ceiling (a new MINOR is where Pi's extension API
# has broken before, e.g. 0.74→0.80) and to warn in doctor. Empty/non-numeric input is
# treated as "not newer" (return 1), so a parse hiccup never trips the gate.
coop_minor_newer() {
  local a="$1" b="$2" amaj amin bmaj bmin
  amaj="${a%%.*}"; amin="${a#*.}"; amin="${amin%%.*}"
  bmaj="${b%%.*}"; bmin="${b#*.}"; bmin="${bmin%%.*}"
  case "$amaj.$amin.$bmaj.$bmin" in *[!0-9.]*|*..*|.*|*.) return 1 ;; esac
  if [ "$amaj" -gt "$bmaj" ]; then return 0; fi
  if [ "$amaj" -eq "$bmaj" ] && [ "$amin" -gt "$bmin" ]; then return 0; fi
  return 1
}

# True (0) if version $1 is strictly less than version $2. Missing components are
# treated as 0 ("3.12" -> "3.12.0"). Empty / non-numeric input returns 1 (not less).
# Avoids GNU sort -V, which is absent on macOS/BSD.
coop_version_lt() {
  local a="$1" b="$2"
  local a1 a2 a3 b1 b2 b3
  # `${v#*.}` leaves a dot-less remainder unchanged, so a two-part "3.14" once read
  # as 3.14.14 (and 3.14.2 counted as older than 3.14): split on dots explicitly,
  # with a missing part reading as 0.
  a1="${a%%.*}"; a="${a#*.}"; [ "$a" = "$a1" ] && a=''; a2="${a%%.*}"; a="${a#*.}"; [ "$a" = "$a2" ] && a=''; a3="${a%%.*}"
  b1="${b%%.*}"; b="${b#*.}"; [ "$b" = "$b1" ] && b=''; b2="${b%%.*}"; b="${b#*.}"; [ "$b" = "$b2" ] && b=''; b3="${b%%.*}"
  a1="${a1:-0}"; a2="${a2:-0}"; a3="${a3:-0}"
  b1="${b1:-0}"; b2="${b2:-0}"; b3="${b3:-0}"
  case "$a1.$a2.$a3.$b1.$b2.$b3" in *[!0-9.]*) return 1 ;; esac
  [ "$a1" -lt "$b1" ] && return 0
  [ "$a1" -gt "$b1" ] && return 1
  [ "$a2" -lt "$b2" ] && return 0
  [ "$a2" -gt "$b2" ] && return 1
  [ "$a3" -lt "$b3" ] && return 0
  return 1
}

# Is Microsoft ODBC Driver 18+ for SQL Server registered? (mirror of Test-CoopOdbcDriver18)
coop_odbc_driver18() {
  local names n
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) names="$(reg query 'HKLM\SOFTWARE\ODBC\ODBCINST.INI\ODBC Drivers' 2>/dev/null)" ;;
    *) have odbcinst || return 1; names="$(odbcinst -q -d 2>/dev/null)" ;;
  esac
  for n in $(printf '%s\n' "$names" | sed -n 's/.*ODBC Driver \([0-9][0-9]*\) for SQL Server.*/\1/p'); do
    [ "$n" -ge 18 ] && return 0
  done
  return 1
}

# --- Prerequisite gate: ONE ordered table shared by install and doctor ----------
# Prints one row per line in dependency order, fields separated by 0x1f:
#   order  name  required(1/0)  ok(1/0)  detail  fix
# fix is the exact command to print; ' then ' separates two steps. Install stops
# when a required row is not ok; doctor reports the same rows with the same text.
# Usage: coop_prereq_rows [no-fabric:0|1]   (mirror of Get-CoopPrereqs)
_coop_ver() { "$1" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1; }
coop_prereq_rows() {
  local no_fabric="${1:-0}" us fgit fnode fpy fpipx fpipxup faz fodbc
  local ok det v min fab_py gen_py gen_v gen_ok p pipx_det pipx_via fetch
  fpipxup=0
  us="$(printf '\037')"
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*)
      fgit='winget install --id Git.Git -e'; fnode='winget install --id OpenJS.NodeJS.LTS -e'
      fpy='winget install --id Python.Python.3.12 -e'
      fpipx='py -3.12 -m pip install --user pipx then py -3.12 -m pipx ensurepath'; fpipxup=1
      faz='winget install --id Microsoft.AzureCLI -e'; fodbc='winget install --id Microsoft.msodbcsql.18 -e' ;;
    Darwin)
      fgit='xcode-select --install'; fnode='brew install node'; fpy='brew install python@3.12'
      fpipx='brew install pipx then pipx ensurepath'; faz='brew install azure-cli'
      fodbc='brew tap microsoft/mssql-release https://github.com/Microsoft/homebrew-mssql-release then brew install msodbcsql18' ;;
    *)
      fgit='sudo apt-get install -y git'; fnode='see https://nodejs.org/en/download'
      fpy='sudo apt-get install -y python3.12 python3.12-venv'
      fpipx='sudo apt-get install -y pipx then pipx ensurepath'
      faz='curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash'
      fodbc='see https://learn.microsoft.com/sql/connect/odbc/linux-mac/installing-the-microsoft-odbc-driver-for-sql-server' ;;
  esac
  _row() { printf '%s%s%s%s%s%s%s%s%s%s%s\n' "$1" "$us" "$2" "$us" "$3" "$us" "$4" "$us" "$5" "$us" "$6"; }

  if have git; then _row 1 Git 1 1 "$(_coop_ver git)" "$fgit"; else _row 1 Git 1 0 'not found' "$fgit"; fi

  min=''; have node && min="$(coop_manifest_get node.min)"; min="${min:-22.19.0}"
  ok=0; det='not found'
  if have node; then
    v="$(_coop_ver node)"
    if [ -n "$v" ] && ! coop_version_lt "$v" "$min"; then ok=1; det="$v"; else det="${v:-unknown version} is older than $min"; fi
  fi
  _row 2 "Node.js $min or newer" 1 "$ok" "$det" "$fnode"

  # The Fabric CLI cannot run on 3.14, so it needs 3.10-3.13. A pipx that can
  # fetch a standalone Python (1.5+, coop_pipx_fetch_python_flag) supplies its own
  # 3.12 for the Fabric CLI, so 3.14 plus that pipx also passes. pipx counts here
  # exactly as row 4 counts it: on PATH, or reachable as `<python> -m pipx`.
  ok=0; det='not found'; fab_py=''; gen_v=''; gen_ok=0; pipx_det=''; pipx_via=''; fetch=''
  [ "$no_fabric" = 1 ] || fab_py="$(coop_fabric_bootstrap_python 2>/dev/null)" || fab_py=''
  gen_py="$(coop_python 2>/dev/null)" || gen_py=''
  [ -n "$gen_py" ] && gen_v="$(_coop_ver "$gen_py")"
  [ -n "$gen_v" ] && ! coop_version_lt "$gen_v" 3.10 && gen_ok=1
  if have pipx; then pipx_det="$(_coop_ver pipx)"; pipx_via='pipx'
  else
    for p in "$fab_py" "$gen_py"; do
      [ -n "$p" ] || continue
      if "$p" -m pipx --version >/dev/null 2>&1; then pipx_det="via $p -m pipx"; pipx_via="$p -m pipx"; break; fi
    done
  fi
  # A general Python that is itself 3.10-3.13 is Fabric-compatible even when the
  # Fabric resolver's probe misses it (#81). pipx is probed only when it is the
  # deciding factor (a 3.14+ Python and nothing older), so the row stays cheap.
  # shellcheck disable=SC2086  # pipx_via is a command line by design
  if [ -n "$fab_py" ]; then ok=1; det="$(_coop_ver "$fab_py")"
  elif [ "$gen_ok" = 1 ] && { [ "$no_fabric" = 1 ] || coop_version_lt "$gen_v" 3.14; }; then ok=1; det="$gen_v"
  elif [ "$gen_ok" = 1 ] && [ -n "$pipx_via" ] && fetch="$(coop_pipx_fetch_python_flag $pipx_via 2>/dev/null)" && [ -n "$fetch" ]; then
    ok=1; det="$gen_v; pipx fetches 3.12 for the Fabric CLI"
  elif [ "$gen_ok" = 1 ]; then
    det="$gen_v only; the Fabric CLI needs 3.10-3.13"
    # Windows: a pipx that is present but too old to fetch a Python is repaired
    # without winget or an administrator — upgrading pipx (1.12+) lets it download
    # a standalone 3.12 for the Fabric CLI. Elsewhere the package manager's Python
    # stays the fix (pip --user is refused on Debian-family Pythons, PEP 668).
    if [ -n "$pipx_via" ] && [ "$fpipxup" = 1 ]; then fpy="$gen_py -m pip install --user --upgrade pipx then $gen_py -m pipx ensurepath"; fi
  elif [ -n "$gen_v" ]; then det="$gen_v is older than 3.10"
  fi
  _row 3 'Python 3.10-3.13 (3.12 recommended)' 1 "$ok" "$det" "$fpy"

  if [ -n "$pipx_via" ]; then _row 4 pipx 1 1 "$pipx_det" "$fpipx"; else _row 4 pipx 1 0 'not found' "$fpipx"; fi

  if have az; then _row 5 'Azure CLI' 1 1 '' "$faz"; else _row 5 'Azure CLI' 1 0 'not found' "$faz"; fi

  # Not blocking here: install offers ODBC with its license prompt after the
  # Fabric CLI, and doctor checks that the Fabric runtime can load it.
  if coop_odbc_driver18; then _row 6 'ODBC Driver 18 for SQL Server' 0 1 '' "$fodbc"
  else _row 6 'ODBC Driver 18 for SQL Server' 0 0 'not found; needed for live SQL' "$fodbc"; fi

  if have te; then ok=1; det=''; else ok=0; det='not found'; fi
  _row 7 'Tabular Editor CLI (optional, BPA reviews)' 0 "$ok" "$det" \
    'download te from https://tabulareditor.com/product/features-and-tools/tabular-editor-cli, put it on PATH, then: te auth login'
  unset -f _row
}

# --- Azure sign-in preflight (non-fatal) ---------------------------------------
# Before a launch, make sure the Azure CLI can mint the Fabric token, then the
# Power BI token, for the client tenant. The tenant comes from one chain
# (coop_tenant): the project contract's fabric.tenant_id, else ~/.coop/config
# azure.tenant_id (client resources only), else nothing, and then the launch is
# silent and `coop doctor` says what to set. Skipped entirely when
# COOP_SKIP_AZ=1.
#
# When az reports an authentication failure and the launch runs in an
# interactive console (stdin and stderr are terminals, or COOP_ASSUME_YES=1),
# coop runs `az login --tenant <id>` itself: no question, bounded to 5 minutes,
# and Ctrl-C cancels it. A timeout or a non-authentication error never opens a
# sign-in. Any failure prints ONE line naming the command to run, and the
# launch continues.
#
# Cached: a verified check stamps the tenant id into <agent-dir>/.az-ok. Tokens
# live ~60 minutes and `az` cold-starts in ~1-3s, so within 30 minutes of a
# success for the SAME tenant no az call is made. A failed check (or a stale,
# missing or mismatched marker) re-checks; marker I/O is best-effort and never
# fails the launch.

# Resolve the client Azure tenant (mirror of Get-CoopTenant). The chain and its
# rules live in one place, `lib/warehouse_mcp.py tenant`. Prints the tenant and
# returns 0; returns 1 when none is set and 2 when the value is not a GUID or a
# domain name (a rejected value is never printed). The contract is the one
# coop_find_project_yml finds, the same one `coop doctor` shows.
coop_tenant() {
  local py t rc=0 proj
  py="$(coop_python)" || return 1
  proj="$(coop_find_project_yml)"
  t="$("$py" "$COOP_ROOT/lib/warehouse_mcp.py" tenant --project="$proj" 2>/dev/null)" || rc=$?
  # tr -d '\r': Python's print() emits CRLF on Windows.
  t="$(printf '%s' "$t" | tr -d '\r')"
  case "$rc" in 0|1|2) ;; *) rc=1 ;; esac
  if [ "$rc" -ne 0 ]; then t=''; fi
  # Defence in depth: the value goes into az argv and the cache marker.
  case "$t" in *[!A-Za-z0-9.-]*) t=''; rc=2 ;; esac
  if [ "$rc" -eq 0 ] && [ -z "$t" ]; then rc=1; fi
  printf '%s' "$t"
  return "$rc"
}

# Run `az <args>` with a hard time limit of <secs> (mirror of Invoke-CoopAz).
# Returns az's exit code, or 124 when az was stopped (the watchdog fired, or any
# code above 128). az runs in the FOREGROUND so Ctrl-C still reaches it, and it
# sees AZURE_CORE_LOGIN_EXPERIENCE_V2=off so `az login` never waits on its
# subscription picker. The watchdog is fully redirected, so it can never hold a
# caller's $(...) pipe open; it kills az and the Python child of the az wrapper
# script: taskkill /T under Git Bash (no pkill/pgrep there), else the children
# pgrep or ps lists. Callers set az's stdout/stderr. bash 3.2-safe; no timeout(1).
# Usage: coop_az_run <secs> <az args...>
coop_az_run() {
  local secs="$1" dir wpid rc=0
  shift
  dir="$(mktemp -d 2>/dev/null)" || return 1
  (
    s=''
    trap 'kill "$s" 2>/dev/null; exit 0' TERM
    sleep "$secs" &
    s=$!
    wait "$s" || true
    p="$(cat "$dir/pid" 2>/dev/null)" || p=''
    if [ -n "$p" ]; then
      # taskkill /F leaves exit code 1, not a signal code: record the stop.
      : > "$dir/stopped"
      w="$(cat "/proc/$p/winpid" 2>/dev/null)" || w=''
      if [ -z "$w" ] || ! taskkill //PID "$w" //T //F; then
        # List az's children, then signal az and them in ONE kill: az first, so a
        # wrapper can't print its own "Terminated" notice, and no TERM trap can
        # run between the two and leave the child (python) running.
        kids="$(pgrep -P "$p")" \
          || kids="$(ps -A -o pid= -o ppid= | awk -v p="$p" '$2 == p { print $1 }')"
        # shellcheck disable=SC2086  # deliberate word splitting of the pid list
        kill "$p" $kids || true
      fi
      kill "$p" || true
    fi
  ) >/dev/null 2>&1 &
  wpid=$!
  # The group's own stderr is /dev/null, so a watchdog kill adds no bash
  # "Terminated" job notice; az's stderr still reaches the caller through fd 3.
  { AZURE_CORE_LOGIN_EXPERIENCE_V2=off sh -c 'printf "%s" "$$" > "$0" && exec az "$@"' \
      "$dir/pid" "$@" </dev/null 2>&3 3>&-; } 3>&2 2>/dev/null || rc=$?
  kill "$wpid" 2>/dev/null || true
  wait "$wpid" 2>/dev/null || true
  if [ -f "$dir/stopped" ] || [ "$rc" -gt 128 ]; then rc=124; fi
  rm -rf "$dir"
  return "$rc"
}

# True when az's stderr reports an authentication failure (a sign-in is needed).
# The same markers as lib/fabric_request_headers.mjs, so the launch, doctor and
# the Fabric token helper agree on what "not signed in" means.
coop_az_auth_error() {
  local lc
  lc="$(printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
  case "$lc" in
    *"az login"*|*"not logged in"*|*"login required"*|*"authentication required"*) return 0 ;;
    *interaction_required*|*interactionrequired*|*invalid_grant*) return 0 ;;
    *aadsts50058*|*aadsts50076*|*aadsts50078*|*aadsts50079*|*aadsts50158*) return 0 ;;
  esac
  return 1
}

# Check that az can mint the Fabric token, then the Power BI token, for tenant
# $1 (mirror of Get-CoopAzTokenRc). 15 seconds each; --output none keeps tokens
# out of coop's pipes, and az's stderr is only classified, never shown or kept.
# Stops at the first failure. Returns 0 when both mint, 1 when az reports an
# authentication failure, 2 for any other failure, 124 on timeout.
coop_az_tokens_ok() {
  local r rc err
  for r in https://api.fabric.microsoft.com https://analysis.windows.net/powerbi/api; do
    rc=0
    err="$(coop_az_run 15 account get-access-token --tenant "$1" --resource "$r" --output none 2>&1 >/dev/null)" || rc=$?
    if [ "$rc" -eq 0 ]; then continue; fi
    if [ "$rc" -eq 124 ]; then return 124; fi
    if coop_az_auth_error "$err"; then return 1; fi
    return 2
  done
  return 0
}

coop_az_preflight() {
  if [ "${COOP_SKIP_AZ:-0}" = "1" ]; then return 0; fi
  have az || return 0
  local tenant trc=0 marker rc=0 tried=0 int_trap
  tenant="$(coop_tenant)" || trc=$?
  if [ "$trc" -eq 2 ]; then
    coop_warn "Azure tenant id is not a GUID or domain name; skipping Azure sign-in." \
      "fix fabric.tenant_id in .coop/project.yml or run: coop onboard --config-only"
    return 0
  fi
  [ -n "$tenant" ] || return 0
  marker="$(coop_effective_agent_dir)/.az-ok"
  # find -mmin -30: marker modified <30 min ago (BSD + GNU; no stat(1) flag games).
  if [ -n "$(find "$marker" -mmin -30 2>/dev/null)" ] \
     && [ "$(cat "$marker" 2>/dev/null)" = "$tenant" ]; then
    return 0
  fi
  coop_az_tokens_ok "$tenant" || rc=$?
  if [ "$rc" -eq 1 ] && { { [ -t 0 ] && [ -t 2 ]; } || [ "${COOP_ASSUME_YES:-0}" = "1" ]; }; then
    tried=1
    coop_info "Opening Azure sign-in for tenant $tenant..."
    # Ctrl-C reaches az and cancels the sign-in; this trap keeps it from also
    # ending the launch, so a cancel reads as a failed sign-in below.
    int_trap="$(trap -p INT)"
    trap ':' INT
    rc=0
    coop_az_run 300 login --tenant "$tenant" --allow-no-subscriptions --output none >/dev/null || rc=$?
    if [ -n "$int_trap" ]; then eval "$int_trap"; else trap - INT; fi
    # A zero login exit is not enough: tenant-only and conditional-access flows
    # can finish without the tokens coop needs, so check both again.
    if [ "$rc" -eq 0 ]; then coop_az_tokens_ok "$tenant" || rc=$?; fi
  fi
  if [ "$rc" -eq 0 ]; then
    { mkdir -p "$(coop_effective_agent_dir)" && printf '%s' "$tenant" > "$marker"; } 2>/dev/null || true
    if [ "$tried" -eq 1 ]; then coop_ok "Signed in to Azure for tenant $tenant."; fi
    return 0
  fi
  rm -f "$marker" 2>/dev/null || true
  if [ "$tried" -eq 1 ]; then
    coop_warn "Azure sign-in for tenant $tenant is not verified; continuing." \
      "run: az login --tenant $tenant --allow-no-subscriptions"
  elif [ "$rc" -eq 124 ]; then
    coop_warn "Azure token check timed out for tenant $tenant (network or VPN?); continuing." \
      "run: az account get-access-token --tenant $tenant --resource https://api.fabric.microsoft.com"
  elif [ "$rc" -eq 1 ]; then
    coop_warn "Azure: not signed in to tenant $tenant; continuing." \
      "run: az login --tenant $tenant --allow-no-subscriptions"
  else
    coop_warn "Azure token check failed for tenant $tenant (not an auth error); continuing." \
      "run: az account get-access-token --tenant $tenant --resource https://api.fabric.microsoft.com"
  fi
  return 0
}

# --- Repo staleness (fleet drift) ---------------------------------------------
# coop-agent updates arrive when `coop update` fast-forwards the checkout to the
# newest release tag (H5; --edge: head of main); a zip/shared-drive copy (no .git)
# silently never updates, and even a git checkout has no signal between updates.
# These helpers power step 1 of `coop update` and the doctor / launch nudge.

# Is <dir> a git checkout: a clone (.git directory) or a linked worktree or
# submodule (.git file naming its gitdir). Both twins use this one rule (#106), so
# bash and PowerShell agree on a worktree; a plain copy is not a checkout. No git
# process is started.
coop_is_git_checkout() {
  local g="$1/.git" first=""
  [ -d "$g" ] && return 0
  [ -f "$g" ] || return 1
  IFS= read -r first < "$g" 2>/dev/null || true
  case "$first" in "gitdir: "?*) return 0 ;; esac
  return 1
}

# Quietly refresh origin — at most once per day (marker mtime in the effective
# agent dir) and under a 5s watchdog, so an offline or VPN-black-holed fetch can
# never stall doctor or a launch. Stamps BEFORE fetching, so an offline machine
# pays the watchdog at most once a day. Returns 0 when THIS call attempted the
# (daily) fetch; 1 when throttled or not applicable (non-git copy / no git / no
# origin remote). Best-effort: a failed fetch is silent by design.
coop_repo_fetch_throttled() {
  have git || return 1
  coop_is_git_checkout "$COOP_ROOT" || return 1
  git -C "$COOP_ROOT" remote get-url origin >/dev/null 2>&1 || return 1
  local agent_dir marker fpid wpid
  agent_dir="$(coop_effective_agent_dir)"
  marker="$agent_dir/.coop-fetch-stamp"
  # POSIX find prints the marker only when it was modified <24h ago (no stat(1)
  # portability games — BSD and GNU stat disagree on flags).
  [ -n "$(find "$marker" -mtime -1 2>/dev/null)" ] && return 1
  mkdir -p "$agent_dir" 2>/dev/null || true
  touch "$marker" 2>/dev/null || true
  ( GIT_TERMINAL_PROMPT=0 git -C "$COOP_ROOT" fetch --quiet origin >/dev/null 2>&1 ) &
  fpid=$!
  ( sleep 5; kill "$fpid" 2>/dev/null ) >/dev/null 2>&1 &
  wpid=$!
  wait "$fpid" 2>/dev/null || true
  kill "$wpid" 2>/dev/null || true
  wait "$wpid" 2>/dev/null || true
  return 0
}

# Print how many commits HEAD is behind the release `coop update` would move it to
# (coop_repo_next_release) — purely local and instant (last-fetched refs; no
# network). Prints 0 when there is no newer release, this is not a git checkout,
# git is missing, or the count is unknowable, so a checkout that is ahead,
# diverged or held is never told to run an update that would not move it.
coop_repo_behind_count() {
  local n="" tag
  tag="$(coop_repo_next_release)"
  if [ -n "$tag" ]; then
    n="$(git -C "$COOP_ROOT" rev-list --count "HEAD..refs/tags/$tag" 2>/dev/null || true)"
  fi
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  printf '%s' "$n"
}

# Launch-time staleness nudge: at most once per day (it fires only when this call
# performed the daily fetch), warn when a newer release is waiting for this
# checkout. Never blocks or fails the launch; silent offline / non-git / current.
# Stranded checkouts stay quiet here; step 1 and doctor name them.
coop_update_nudge() {
  local behind tag
  coop_repo_fetch_throttled || return 0
  tag="$(coop_repo_next_release)"
  [ -n "$tag" ] || return 0
  behind="$(coop_repo_behind_count)"
  [ "$behind" -gt 0 ] && coop_warn "coop-agent is $behind commit(s) behind release $tag — run: coop update"
  return 0
}

# The checked-out branch name; '' when HEAD is detached. Strips refs/heads/ from
# the full ref, not --short: a tag named like the branch (a stray 'main' tag,
# which every fetch auto-follows) turns --short into 'heads/main'.
_coop_repo_branch() {
  local ref
  ref="$(git -C "$COOP_ROOT" symbolic-ref -q HEAD 2>/dev/null || true)"
  case "$ref" in refs/heads/?*) printf '%s' "${ref#refs/heads/}" ;; esac
  return 0
}

# True when HEAD follows release tags: a detached HEAD, or a branch whose upstream
# is origin/main (main, or a renamed branch that tracks it). Any other branch,
# including one with no upstream, is a "hold" that default `coop update` leaves alone.
_coop_repo_follows_releases() {
  local branch
  branch="$(_coop_repo_branch)"
  [ -n "$branch" ] || return 0
  [ "$(git -C "$COOP_ROOT" config --get "branch.$branch.remote" 2>/dev/null || true)" = origin ] || return 1
  [ "$(git -C "$COOP_ROOT" config --get "branch.$branch.merge" 2>/dev/null || true)" = refs/heads/main ]
}

# Print the newest strict vX.Y.Z tag merged into the last-fetched origin/main,
# with any extra for-each-ref filters passed as arguments (e.g. --contains HEAD).
# rc tags, tags off main and junk output are skipped. lstrip=2, not :short, so a
# branch named like a tag cannot turn 'v1.2.3' into 'tags/v1.2.3' and hide it.
_coop_repo_newest_release() {
  local out t n
  out="$(git -C "$COOP_ROOT" for-each-ref "$@" --merged refs/remotes/origin/main \
    --sort=-v:refname --format='%(refname:lstrip=2)' 'refs/tags/v[0-9]*' 2>/dev/null || true)"
  while IFS= read -r t; do
    n="${t#v}"
    [ "$n" != "$t" ] || continue
    case "$n" in
      ''|*[!0-9.]*|.*|*.|*..*|*.*.*.*) ;;
      *.*.*) printf '%s' "$t"; return 0 ;;
    esac
  done <<EOF
$out
EOF
  return 0
}

# The release `coop update` would move this checkout to: the newest strict vX.Y.Z
# tag that is merged into the last-fetched origin/main AND contains HEAD, unless
# HEAD is already on it. Read-only and local (no network). Prints '' for a non-git
# copy, missing git, a hold branch, or when no newer release exists, so a checkout
# that is ahead of the newest release, diverged or shallow is never moved backwards.
coop_repo_next_release() {
  local tag
  have git && coop_is_git_checkout "$COOP_ROOT" || return 0
  _coop_repo_follows_releases || return 0
  tag="$(_coop_repo_newest_release --contains HEAD)"
  [ -n "$tag" ] || return 0
  [ "$(git -C "$COOP_ROOT" rev-list -n 1 "refs/tags/$tag" 2>/dev/null || true)" \
    = "$(git -C "$COOP_ROOT" rev-parse HEAD 2>/dev/null || true)" ] && return 0
  printf '%s' "$tag"
}

# `git describe` of the checkout against release tags (v0.23.5-21-gdf91630; rc
# tags and tags not shaped vX.Y.Z, such as v1 or v0.10.0.1, are skipped; a bare
# short SHA when no release is reachable) for the doctor row and step 1. No
# --dirty, so the index is never touched. Prints '' for a non-git copy or
# unexpected output.
coop_repo_describe() {
  local d=""
  if have git && coop_is_git_checkout "$COOP_ROOT"; then
    d="$(git -C "$COOP_ROOT" describe --tags --match 'v[0-9]*.[0-9]*.[0-9]*' \
      --exclude '*-*' --exclude 'v*.*.*.*' --always 2>/dev/null || true)"
  fi
  case "$d" in
    v[0-9]*|[0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
    *) d="" ;;
  esac
  case "$d" in *[!0-9A-Za-z.-]*) d="" ;; esac
  printf '%s' "$d"
}

# The remote a missing origin was renamed to, or '' when that is not certain:
# the checked-out branch's remote, unless a different remote points at the
# canonical repo; else the one remote that points at the canonical repo. Never
# the first name `git remote` lists: it is sorted, so a fork added next to a
# renamed origin would come first.
_coop_repo_origin_candidate() {
  local root="$COOP_ROOT" branch br="" br_canon=0 canon="" n=0 r url remotes
  branch="$(_coop_repo_branch)"
  if [ -n "$branch" ]; then
    br="$(git -C "$root" config --get "branch.$branch.remote" 2>/dev/null || true)"
    # '.' (a local upstream) or a remote that no longer exists is no candidate.
    if [ -n "$br" ] && ! git -C "$root" remote get-url "$br" >/dev/null 2>&1; then br=""; fi
  fi
  remotes="$(git -C "$root" remote 2>/dev/null || true)"
  while IFS= read -r r; do
    [ -n "$r" ] || continue
    url="$(git -C "$root" remote get-url "$r" 2>/dev/null || true)"
    case "$url" in
      *[/:]kabukisensei/coop-agent|*[/:]kabukisensei/coop-agent/|*[/:]kabukisensei/coop-agent.git|*[/:]kabukisensei/coop-agent.git/)
        n=$((n+1)); canon="$r"
        if [ "$r" = "$br" ]; then br_canon=1; fi
        ;;
    esac
  done <<EOF
$remotes
EOF
  if [ -n "$br" ]; then
    if [ "$n" = 0 ] || [ "$br_canon" = 1 ]; then printf '%s' "$br"; fi
  elif [ "$n" = 1 ]; then
    printf '%s' "$canon"
  fi
  return 0
}

# Name a state in which `coop update` cannot move this checkout, as two lines:
# what is wrong, then the command that fixes it. Prints nothing when the checkout
# follows releases normally. Local only (no network). Step 1 and doctor use it so
# a stranded machine is never silent; the launch nudge stays quiet.
coop_repo_stranded() {
  local root="$COOP_ROOT" branch tag remote sha
  have git && coop_is_git_checkout "$root" || return 0
  if ! git -C "$root" remote get-url origin >/dev/null 2>&1; then
    # Renamed (origin -> upstream) or removed: name it before it reads as a hold.
    # Suggest a rename only for a certain candidate; otherwise add the canonical one.
    remote="$(_coop_repo_origin_candidate)"
    printf 'coop-agent has no origin remote, so coop update cannot move it\n'
    if [ -n "$remote" ]; then
      printf 'fix: git -C "%s" remote rename %s origin\n' "$root" "$remote"
    else
      printf 'fix: git -C "%s" remote add origin https://github.com/kabukisensei/coop-agent.git && git -C "%s" fetch origin\n' "$root" "$root"
    fi
    return 0
  fi
  if ! _coop_repo_follows_releases; then
    branch="$(_coop_repo_branch)"
    printf "coop-agent is held on branch '%s' (it does not track origin/main); coop update leaves it alone\n" "$branch"
    if [ "$branch" = main ]; then
      printf 'to follow releases again: git -C "%s" branch --set-upstream-to=origin/main main\n' "$root"
    else
      printf 'to follow releases again: git -C "%s" switch main\n' "$root"
    fi
    return 0
  fi
  if ! git -C "$root" rev-parse -q --verify refs/remotes/origin/main >/dev/null 2>&1; then
    printf 'coop-agent has no origin/main to follow (for example a single-branch clone of a tag)\n'
    printf "fix: git -C \"%s\" remote set-branches origin '*' && git -C \"%s\" fetch origin\n" "$root" "$root"
    return 0
  fi
  tag="$(_coop_repo_newest_release)"
  if [ -n "$tag" ] && [ -z "$(coop_repo_next_release)" ] \
     && ! git -C "$root" merge-base --is-ancestor "refs/tags/$tag" HEAD >/dev/null 2>&1; then
    # Name the aside branch after HEAD so a leftover from an earlier rejoin never
    # collides; && stops before the reset if the branch cannot be made.
    sha="$(git -C "$root" rev-parse --short HEAD 2>/dev/null || true)"
    case "$sha" in ''|*[!0-9a-f]*) sha="" ;; esac
    printf 'coop-agent has commits that release %s does not contain, so coop update cannot move it (push them, or set them aside)\n' "$tag"
    printf 'set them aside and rejoin: git -C "%s" branch my-work%s && git -C "%s" reset --keep %s\n' "$root" "${sha:+-$sha}" "$root" "$tag"
  fi
  return 0
}

# coop_warn the coop_repo_stranded state. Returns 1 when there is none.
_coop_repo_warn_stranded() {
  local s msg="" hint=""
  s="$(coop_repo_stranded)"
  [ -n "$s" ] || return 1
  { IFS= read -r msg || true; IFS= read -r hint || true; } <<EOF
$s
EOF
  coop_warn "$msg" "$hint"
  return 0
}

# The doctor's "coop-agent repository" row for a git checkout, as three lines:
# the level (ok or warn), the message, then the hint ('' for ok). Local only (no
# network; doctor refreshes origin first). A newer release to move to comes
# first; else a stranded state is named with its fix; else the checkout is ok.
coop_repo_doctor_row() {
  local next behind stranded at
  next="$(coop_repo_next_release)"
  behind="$(coop_repo_behind_count)"
  if [ -n "$next" ] && [ "${behind:-0}" -gt 0 ]; then
    printf 'warn\ncoop-agent is %s commit(s) behind release %s\nrun: coop update\n' "$behind" "$next"
    return 0
  fi
  stranded="$(coop_repo_stranded)"
  if [ -n "$stranded" ]; then
    printf 'warn\n%s\n' "$stranded"
    return 0
  fi
  at="$(coop_repo_describe)"
  printf 'ok\ncoop-agent %s (follows release tags via: coop update)\n\n' "${at:-git checkout}"
}

# The repo line of `coop update --check` (#107), as two lines: what step 1 would do
# to this checkout, then a hint ('' when none). Local only, no fetch, so it answers
# from the releases already fetched and --check still changes nothing.
coop_repo_check_line() {
  local at next stranded
  if ! have git || ! coop_is_git_checkout "$COOP_ROOT"; then
    printf 'not a git checkout: coop update never moves it\n\n'
    return 0
  fi
  at="$(coop_repo_describe)"; [ -n "$at" ] || at="checkout"
  next="$(coop_repo_next_release)"
  if [ -n "$next" ]; then
    printf '%s  would move to release %s\n\n' "$at" "$next"
    return 0
  fi
  stranded="$(coop_repo_stranded)"
  if [ -n "$stranded" ]; then
    printf '%s\n' "$stranded"
    return 0
  fi
  printf '%s  no newer release\n\n' "$at"
}

# Step 1 of `coop update`: move the coop-agent checkout. Arg 1 is EDGE (0/1).
# Default: fast-forward to coop_repo_next_release, never backwards, never a tag
# checkout or reset. --edge: head of main, via today's `git pull --ff-only` on a
# branch, or a guarded re-attach of a detached HEAD to main. Tracked-file changes
# skip the move; a hold branch is not fetched or moved. Warn-and-continue: never
# touches the update's failure count and always returns 0.
coop_repo_follow_release() {
  local edge="${1:-0}" root="$COOP_ROOT" branch before tag err line=""
  if [ -n "$(git -C "$root" status --porcelain --untracked-files=no 2>/dev/null || true)" ]; then
    coop_warn "uncommitted changes to tracked files in coop-agent — skipping the coop-agent move (commit/stash first)."
    return 0
  fi
  before="$(coop_repo_describe)"; [ -n "$before" ] || before="checkout"
  branch="$(_coop_repo_branch)"
  if [ "$edge" = 1 ] && [ -n "$branch" ]; then
    # A branch with no upstream (e.g. a hold made from a tag) has nothing to pull.
    if [ -z "$(git -C "$root" config --get "branch.$branch.merge" 2>/dev/null || true)" ]; then
      _coop_repo_warn_stranded || true
      return 0
    fi
    coop_info "git pull --ff-only (--edge: head of $branch)"
    if GIT_TERMINAL_PROMPT=0 git -C "$root" pull --ff-only >/dev/null 2>&1; then
      coop_ok "coop-agent moved from $before to head of $branch ($(coop_repo_describe))"
    else
      coop_warn "git pull failed (continuing)" "see: git -C \"$root\" status"
    fi
    return 0
  fi
  if ! _coop_repo_follows_releases; then
    _coop_repo_warn_stranded || true
    return 0
  fi
  if ! err="$(GIT_TERMINAL_PROMPT=0 git -C "$root" fetch --quiet origin 2>&1 >/dev/null)"; then
    IFS= read -r line <<<"$err" || true
    coop_warn "could not fetch from origin — using the releases already on this machine" "git: ${line:-fetch failed}"
  fi
  if [ "$edge" = 1 ]; then
    # Detached HEAD: re-attach to main only when that is forward-only and loses
    # nothing — HEAD and any existing local main must both be ancestors of
    # origin/main. Never a plain `git checkout main` (a stale local main would
    # move HEAD backwards and strand the machine if the pull then failed).
    if ! git -C "$root" rev-parse -q --verify refs/remotes/origin/main >/dev/null 2>&1; then
      _coop_repo_warn_stranded || true
    elif ! git -C "$root" merge-base --is-ancestor HEAD refs/remotes/origin/main >/dev/null 2>&1; then
      coop_warn "--edge: this detached coop-agent has commits that are not on origin/main — staying at $before" \
        "see: git -C \"$root\" log --oneline origin/main..HEAD"
    elif git -C "$root" rev-parse -q --verify refs/heads/main >/dev/null 2>&1 \
         && ! git -C "$root" merge-base --is-ancestor refs/heads/main refs/remotes/origin/main >/dev/null 2>&1; then
      coop_warn "--edge: local branch main has commits that are not on origin/main — staying at $before" \
        "see: git -C \"$root\" log --oneline refs/remotes/origin/main..refs/heads/main"
    elif git -C "$root" checkout -q -B main --track refs/remotes/origin/main >/dev/null 2>&1; then
      coop_ok "coop-agent moved from $before to head of main ($(coop_repo_describe))"
    else
      coop_warn "could not switch coop-agent to main (continuing)" "see: git -C \"$root\" status"
    fi
    return 0
  fi
  tag="$(coop_repo_next_release)"
  if [ -n "$tag" ]; then
    # merge --ff-only, never checkout: git itself refuses anything that is not a
    # fast-forward, or that would overwrite an untracked file.
    if git -C "$root" merge --ff-only --quiet "refs/tags/$tag" >/dev/null 2>&1; then
      coop_ok "coop-agent moved from $before to release $tag"
    else
      coop_warn "could not fast-forward coop-agent to $tag (continuing)" "see: git -C \"$root\" status"
    fi
    return 0
  fi
  _coop_repo_warn_stranded \
    || coop_ok "coop-agent $before: no newer release to move to (--edge follows main)"
  return 0
}

# Warn that the agent itself is too old to satisfy an installed extension's pi-ai
# requirement. Args: <agent-version> [required-floor] [offending-ext] (the last two
# come from _extdeps.py fields 7/8; "-" or empty falls back to a generic message).
_coop_ext_too_old() {  # version [required] [ext]
  local ver="$1" req="${2:-}" ext="${3:-}" need
  if [ -n "$req" ] && [ "$req" != "-" ] && [ -n "$ext" ] && [ "$ext" != "-" ]; then
    need="$ext needs pi-ai ≥ $req"
  else
    need="an installed extension needs a newer pi-ai"
  fi
  coop_warn "Pi agent $ver is too old — $need" "update the Pi agent: coop update   (or move off the legacy-node20 build)"
}

# Align coop's ISOLATED extension tree's @earendil-works/pi-ai + pi-tui to the Pi
# agent's OWN version. coop's extensions load INTO the running agent, so they must
# share one pi-ai/pi-tui with it; a stale lockfile otherwise keeps pi-ai pinned at
# pi-mcp-adapter's 0.74.x and pi-web-access (peer `*`) resolves against it, breaking
# its 0.80 `/compat` import. We write an npm `overrides` pin into
# <agentdir>/npm/package.json (via lib/_extdeps.py); when the installed tree doesn't
# already match, we drop the lockfile so npm re-resolves against the overrides and
# reinstall. Best-effort; never fatal. See lib/_extdeps.py for the full rationale.
coop_align_ext_deps() {
  have pi || return 0
  local py; py="$(coop_python)" || return 0
  local agent_dir npm_dir ver line rc tree_ai
  agent_dir="$(coop_effective_agent_dir)"
  npm_dir="$agent_dir/npm"
  [ -f "$npm_dir/package.json" ] || return 0     # no extension tree yet — nothing to align
  ver="$(coop_pi_version || true)"
  [ -n "$ver" ] || return 0                       # can't determine the agent version

  # Write/refresh the overrides pin and learn the tree's state (branch on the exit
  # code, so an unexpected helper failure is a clean no-op rather than a reinstall).
  # `|| rc=$?` (not `; rc=$?`) keeps this safe when called under a caller's `set -e`
  # (e.g. coop_launch_preflight runs under bin/coop's set -euo pipefail).
  local req ext
  rc=0
  line="$("$py" "$COOP_ROOT/lib/_extdeps.py" align "$agent_dir" "$ver" 2>/dev/null)" || rc=$?
  read -r tree_ai _ _ _ _ _ req ext <<EOF
$line
EOF
  case "$rc" in
    0)  coop_ok "extension pi-ai / pi-tui aligned to pi $ver"; return 0 ;;
    11) _coop_ext_too_old "$ver" "$req" "$ext"; return 0 ;;
    10) ;;                                          # skewed — reconcile below
    *)  return 0 ;;                                 # 2 (nothing) or unexpected — no-op
  esac

  local npm_bin
  if ! npm_bin="$(coop_working_npm)"; then
    coop_warn "extension pi-ai/pi-tui need realignment to pi $ver but npm is missing" "install Node.js, then: coop sync"
    return 0
  fi
  # Skewed: replace ONLY the two shared libraries. Removing npm's root and hidden
  # lock inventories prevents a manually damaged tree from being credited as the
  # locked version. --ignore-scripts guarantees this repair cannot rebuild an
  # unrelated native dependency such as context-mode's better-sqlite3.
  coop_info "aligning extension pi-ai / pi-tui to the agent ($ver; tree has ${tree_ai:-?})…"
  local scope="$npm_dir/node_modules/@earendil-works"
  local ai="$scope/pi-ai" tui="$scope/pi-tui" bak="$npm_dir/.coop-extdeps-backup"
  rm -rf "$bak" 2>/dev/null || true; mkdir -p "$bak"
  [ -d "$ai" ] && mv "$ai" "$bak/pi-ai" 2>/dev/null || true
  [ -d "$tui" ] && mv "$tui" "$bak/pi-tui" 2>/dev/null || true
  rm -f "$npm_dir/package-lock.json" "$npm_dir/node_modules/.package-lock.json" 2>/dev/null || true
  if ( cd "$npm_dir" && "$npm_bin" install --no-save --ignore-scripts --no-audit --no-fund \
      "@earendil-works/pi-ai@$ver" "@earendil-works/pi-tui@$ver" >/dev/null 2>&1 ); then
    rm -rf "$bak" 2>/dev/null || true
  else
    rm -rf "$ai" "$tui" 2>/dev/null || true; mkdir -p "$scope"
    [ -d "$bak/pi-ai" ] && mv "$bak/pi-ai" "$ai" 2>/dev/null || true
    [ -d "$bak/pi-tui" ] && mv "$bak/pi-tui" "$tui" 2>/dev/null || true
    rm -rf "$bak" 2>/dev/null || true
    coop_warn "extension realignment reinstall failed — restored the previous shared libraries" "check your network, then: coop doctor --fix"
  fi
  # Re-check AND re-parse the fields (not just the rc): if the install surfaces a
  # too-old agent (rc 11), the final message must name the fresh offending ext/floor.
  rc=0
  line="$("$py" "$COOP_ROOT/lib/_extdeps.py" align "$agent_dir" "$ver" --check 2>/dev/null)" || rc=$?
  read -r tree_ai _ _ _ _ _ req ext <<EOF
$line
EOF
  case "$rc" in
    0)  coop_ok "extension pi-ai / pi-tui aligned to $ver" ;;
    11) _coop_ext_too_old "$ver" "$req" "$ext" ;;
    *)  coop_warn "could not fully align extension pi-ai/pi-tui to $ver" "close any running coop session, then: coop doctor --fix" ;;
  esac
}

# Launch-time skew guard: refuse to exec pi into a known-broken extension load.
# Read-only and fast (one python call). If the Pi agent is too old for an installed
# extension (rc 11), aligning the tree can't help — abort with clear instructions
# instead of letting pi crash deep in its loader. If the tree is merely skewed but
# fixable (rc 10), silently re-align, then continue. Aligned / no tree / no python /
# unknown rc are all no-ops. Bypass entirely with COOP_SKIP_EXT_CHECK=1.
coop_launch_preflight() {
  [ "${COOP_SKIP_EXT_CHECK:-0}" = "1" ] && return 0
  have pi || return 0
  local py; py="$(coop_python)" || return 0
  local agent_dir ver line rc tree_ai req ext
  agent_dir="$(coop_effective_agent_dir)"    # the dir Pi will actually load (honors COOP_NO_ISOLATE)
  [ -f "$agent_dir/npm/package.json" ] || return 0   # no extension tree — nothing to guard
  ver="$(coop_pi_version || true)"; [ -n "$ver" ] || return 0
  # Capture rc WITHOUT tripping the caller's `set -e`: bin/coop runs `set -euo
  # pipefail`, and a bare `line=$(...); rc=$?` would let a non-zero align (rc 10/11)
  # abort coop SILENTLY here — before we branch to the helpful message. Keeping the
  # assignment as the left side of `|| rc=$?` makes the list exit 0, so set -e holds.
  rc=0
  line="$("$py" "$COOP_ROOT/lib/_extdeps.py" align "$agent_dir" "$ver" --check 2>/dev/null)" || rc=$?
  read -r tree_ai _ _ _ _ _ req ext <<EOF
$line
EOF
  case "$rc" in
    11) _coop_ext_too_old "$ver" "$req" "$ext"
        coop_die "launch aborted — update the Pi agent above, then re-run: coop   (bypass once with COOP_SKIP_EXT_CHECK=1)" ;;
    10) if [ "${COOP_NO_ISOLATE:-0}" = "1" ]; then
          # Isolation off → Pi is loading the user's personal ~/.pi/agent. Don't silently
          # mutate the personal tree at launch; tell them how to align it deliberately.
          coop_warn "your Pi extension tree needs realignment to pi $ver (isolation is off)" "align it deliberately: coop doctor --fix   (or unset COOP_NO_ISOLATE to use coop's isolated tree)"
        else
          coop_align_ext_deps   # fixable tree skew in coop's OWN dir — re-pin + reinstall, then launch
        fi ;;
  esac
  return 0
}

# Read a dotted scalar key from a YAML file. Usage: coop_yaml_get FILE a.b.c [default]
# Uses lib/_yaml.py (PyYAML when available, else a dependency-free fallback parser).
coop_yaml_get() {
  local file="$1" key="$2" default="${3:-}"
  local py; py="$(coop_python)" || { printf '%s' "$default"; return 0; }
  [ -f "$file" ] || { printf '%s' "$default"; return 0; }
  # tr -d '\r': Python's print() emits CRLF on Windows, so without this the value
  # carries a trailing \r that breaks path/scalar comparisons in Git Bash.
  local out; out="$("$py" "$COOP_ROOT/lib/_yaml.py" get "$file" "$key" "$default" 2>/dev/null | tr -d '\r')"
  [ -n "$out" ] && printf '%s' "$out" || printf '%s' "$default"
}

# Read a dotted key that is a YAML list of scalars, printing one item per line.
# Usage: coop_yaml_list FILE a.b.c   (empty output if missing/not-a-list)
coop_yaml_list() {
  local file="$1" key="$2"
  local py; py="$(coop_python)" || return 0
  [ -f "$file" ] || return 0
  # tr -d '\r': strip the CRLF Python's print() adds on Windows, so each list item
  # read by the caller's `while read` loop is a clean path (no trailing \r).
  "$py" "$COOP_ROOT/lib/_yaml.py" list "$file" "$key" 2>/dev/null | tr -d '\r' || true
}

# --- Team knowledge config (~/.coop/config "knowledge" block) -----------------
# The fleet config JSON (schema_version 1, written by scripts/onboard.py) carries
# an OPTIONAL "knowledge" block: { "enabled": bool, "repos": [{url, local_path}] }.
# Absent/disabled/unreadable is a clean no-op everywhere. COOP_DIR overrides the
# parent of .coop (same convention as onboard.py and the test suite).
coop_config_file() { printf '%s' "${COOP_DIR:-$HOME}/.coop/config"; }

# True (0) when knowledge.enabled is truthy in the fleet config.
coop_knowledge_enabled() {
  local f py
  f="$(coop_config_file)"
  [ -f "$f" ] || return 1
  py="$(coop_python)" || return 1
  [ "$("$py" - "$f" <<'PY' 2>/dev/null
import json, sys
try:
    c = json.load(open(sys.argv[1], encoding="utf-8-sig"))
    k = c.get("knowledge") or {}
    print("1" if isinstance(k, dict) and k.get("enabled") else "")
except Exception:
    pass
PY
)" = "1" ]
}

# Print one "url<TAB>local_path" line per configured knowledge repo (only when
# knowledge.enabled), expanding a leading ~ in local_path. Empty output + exit 0
# when disabled/absent/malformed.
coop_knowledge_repos() {
  coop_knowledge_enabled || return 0
  local py; py="$(coop_python)" || return 0
  "$py" - "$(coop_config_file)" <<'PY' 2>/dev/null | tr -d '\r'
import json, os, sys
try:
    c = json.load(open(sys.argv[1], encoding="utf-8-sig"))
    repos = (c.get("knowledge") or {}).get("repos") or []
    if not isinstance(repos, list):
        repos = []
    home = (os.environ.get("HOME") or os.environ.get("USERPROFILE") or os.path.expanduser("~")).rstrip("/\\")
    for r in repos:
        if not isinstance(r, dict):
            continue
        url = str(r.get("url", "")).strip()
        raw = str(r.get("local_path", "")).strip()
        if raw == "~":
            path = home
        elif raw.startswith("~/") or raw.startswith("~\\"):
            path = home + "/" + raw[2:].replace("\\", "/")
        else:
            path = os.path.expanduser(raw)
        if url and path:
            print(url + "\t" + path)
except Exception:
    pass
PY
}

# Extract the YAML frontmatter `name:` from a SKILL.md (first match). Echoes "" if none.
coop_skill_name() {
  local file="$1"
  [ -f "$file" ] || return 0
  awk '
    NR==1 && $0!~/^---/ { exit }       # no frontmatter
    /^---/ { d++; if (d==2) exit; next }
    d==1 && /^[[:space:]]*name:/ {
      sub(/^[[:space:]]*name:[[:space:]]*/, ""); gsub(/^["'\'']|["'\'']$/, ""); print; exit
    }
  ' "$file"
}

# Test whether a tool is enabled in .coop/project.yml. Returns 0 (enabled) when the
# key is absent or set to true/yes/1; returns 1 (disabled) only for explicit false/0/no.
# Falls back to enabled if no project.yml exists, preserving previous doctor behavior.
coop_tool_enabled() {
  local proj="$1" key="$2"
  local v
  v="$(coop_yaml_get "$proj" "tools.${key}.enabled" "")"
  case "$v" in
    [fF]alse|0|[nN]o|[nN]ope) return 1 ;;
    *) return 0 ;;
  esac
}

# Locate the active project contract: nearest .coop/project.yml walking up from
# $PWD, else the bundled one at $COOP_ROOT/.coop/project.yml. Echoes a path or "".
# $1 is an optional start dir (defaults to $PWD); every caller currently omits it,
# which is fine — the default is the intended API, not a bug.
# shellcheck disable=SC2120  # optional positional arg; callers may omit it
coop_find_project_yml() {
  local dir="${1:-$PWD}"
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ -f "$dir/.coop/project.yml" ]; then printf '%s' "$dir/.coop/project.yml"; return 0; fi
    dir="$(dirname "$dir")"
  done
  if [ -f "$COOP_ROOT/.coop/project.yml" ]; then printf '%s' "$COOP_ROOT/.coop/project.yml"; return 0; fi
  printf ''
}

# Confirm a potentially-destructive action unless --yes / COOP_ASSUME_YES is set.
# Check whether the local COOP user profile is missing.
coop_user_profile_missing() {
  [ ! -f "${HOME:-}/.coop/user.json" ]
}

coop_onboarding_missing() {
  [ ! -f "${HOME:-}/.coop/user.json" ] || [ ! -f "${HOME:-}/.coop/config" ]
}

# First-run onboarding: run when either the profile or integration config is missing.
# Returns 0 if onboarding ran (or was skipped because non-interactive), non-zero
# if the wizard itself failed. Safe to call before launching pi.
coop_maybe_onboard() {
  if ! coop_onboarding_missing; then return 0; fi
  if [ ! -t 0 ]; then
    coop_warn "COOP onboarding is incomplete (user.json or config missing). Run: coop onboard"
    return 0
  fi
  if [ "${COOP_NO_ONBOARD:-0}" = "1" ]; then return 0; fi
  if ! have python3; then
    coop_warn "python3 required for onboarding. Run: coop onboard once python is available."
    return 0
  fi
  coop_info "First run: let's set up your COOP profile."
  "$COOP_ROOT/scripts/onboard.py" onboard || return $?
}

# Confirm a potentially-destructive action unless --yes / COOP_ASSUME_YES is set.
coop_confirm() {
  local prompt="${1:-Proceed?}"
  if [ "${COOP_ASSUME_YES:-0}" = "1" ]; then return 0; fi
  if [ ! -t 0 ]; then coop_warn "Non-interactive shell; refusing without --yes."; return 1; fi
  printf '%s%s%s [y/N] ' "$COOP_OLIVE" "$prompt" "$COOP_RST" >&2
  local ans; read -r ans
  case "$ans" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

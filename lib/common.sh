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
coop_say()  { printf '%s\n' "$*" >&2; }
coop_info() { printf '%s%s%s %s\n' "$COOP_LIME" "•" "$COOP_RST" "$*" >&2; }
coop_ok()   { printf '%s%s%s %s\n' "$COOP_FOREST" "✓" "$COOP_RST" "$*" >&2; }
coop_warn() { printf '%s%s%s %s\n' "$COOP_OLIVE" "!" "$COOP_RST" "$*" >&2; }
coop_err()  { printf '%s%s%s %s\n' "$COOP_RED" "✗" "$COOP_RST" "$*" >&2; }
coop_die()  { coop_err "$*"; exit 1; }
coop_head() { printf '\n%s%s%s%s\n' "$COOP_BOLD" "$COOP_NAVY" "$*" "$COOP_RST" >&2; }

# --- Small utilities ---------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

# coop runs Pi against an ISOLATED agent dir so coop's extensions/settings/theme
# never mix with the user's personal `pi` (~/.pi/agent). Override with COOP_AGENT_DIR.
coop_pi_agent_dir() { printf '%s' "${COOP_AGENT_DIR:-$HOME/.coop/agent}"; }

# The user's *global* Pi agent dir (used to share credentials into coop's isolated dir).
coop_global_pi_agent_dir() { printf '%s' "$HOME/.pi/agent"; }

# Pick a usable python interpreter (for YAML/JSON parsing). Prefer python3.
coop_python() {
  if have python3; then echo python3
  elif have python; then echo python
  else return 1
  fi
}

# Read a dotted scalar key from a YAML file. Usage: coop_yaml_get FILE a.b.c [default]
# Uses lib/_yaml.py (PyYAML when available, else a dependency-free fallback parser).
coop_yaml_get() {
  local file="$1" key="$2" default="${3:-}"
  local py; py="$(coop_python)" || { printf '%s' "$default"; return 0; }
  [ -f "$file" ] || { printf '%s' "$default"; return 0; }
  local out; out="$("$py" "$COOP_ROOT/lib/_yaml.py" get "$file" "$key" "$default" 2>/dev/null)"
  [ -n "$out" ] && printf '%s' "$out" || printf '%s' "$default"
}

# Read a dotted key that is a YAML list of scalars, printing one item per line.
# Usage: coop_yaml_list FILE a.b.c   (empty output if missing/not-a-list)
coop_yaml_list() {
  local file="$1" key="$2"
  local py; py="$(coop_python)" || return 0
  [ -f "$file" ] || return 0
  "$py" "$COOP_ROOT/lib/_yaml.py" list "$file" "$key" 2>/dev/null || true
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

# Locate the active project contract: nearest .coop/project.yml walking up from
# $PWD, else the bundled one at $COOP_ROOT/.coop/project.yml. Echoes a path or "".
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
coop_confirm() {
  local prompt="${1:-Proceed?}"
  if [ "${COOP_ASSUME_YES:-0}" = "1" ]; then return 0; fi
  if [ ! -t 0 ]; then coop_warn "Non-interactive shell; refusing without --yes."; return 1; fi
  printf '%s%s%s [y/N] ' "$COOP_OLIVE" "$prompt" "$COOP_RST" >&2
  local ans; read -r ans
  case "$ans" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

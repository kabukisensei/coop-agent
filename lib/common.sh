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

  if ! have npm; then
    coop_warn "extension pi-ai/pi-tui need realignment to pi $ver but npm is missing" "install Node.js, then: coop sync"
    return 0
  fi
  # Skewed: drop the lockfile (the thing pinning the stale hoist) so npm re-resolves
  # against the overrides, then reinstall.
  coop_info "aligning extension pi-ai / pi-tui to the agent ($ver; tree has ${tree_ai:-?})…"
  rm -f "$npm_dir/package-lock.json" 2>/dev/null || true
  ( cd "$npm_dir" && npm install >/dev/null 2>&1 ) || true
  # Re-check AND re-parse the fields (not just the rc): if the reinstall surfaces a
  # too-old agent (rc 11), the final message must name the fresh offending ext/floor.
  # `|| rc=$?` keeps the rc capture safe under a caller's `set -e`.
  rc=0
  line="$("$py" "$COOP_ROOT/lib/_extdeps.py" align "$agent_dir" "$ver" --check 2>/dev/null)" || rc=$?
  read -r tree_ai _ _ _ _ _ req ext <<EOF
$line
EOF
  if [ "$rc" = 10 ]; then
    # A stale node_modules can keep the old hoist — rebuild it clean as a last resort,
    # but PRESERVE the existing tree: move it aside, reinstall, and restore it if the
    # reinstall fails (offline / registry down / proxy). Deleting first would leave
    # coop with NO extensions — strictly worse than a skewed-but-working tree.
    local nm="$npm_dir/node_modules" bak="$npm_dir/node_modules.coopbak"
    if [ -d "$nm" ]; then rm -rf "$bak" 2>/dev/null || true; mv "$nm" "$bak" 2>/dev/null || true; fi
    if ( cd "$npm_dir" && npm install >/dev/null 2>&1 ); then
      rm -rf "$bak" 2>/dev/null || true
    elif [ -d "$bak" ]; then
      rm -rf "$nm" 2>/dev/null || true; mv "$bak" "$nm" 2>/dev/null || true
      coop_warn "extension realignment reinstall failed — restored the previous tree" "check your network, then: coop doctor --fix"
    fi
    rc=0
    line="$("$py" "$COOP_ROOT/lib/_extdeps.py" align "$agent_dir" "$ver" --check 2>/dev/null)" || rc=$?
    read -r tree_ai _ _ _ _ _ req ext <<EOF
$line
EOF
  fi
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

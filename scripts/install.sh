#!/usr/bin/env bash
#
# coop install / bootstrap — set up the whole Cooptimize stack on a fresh machine.
# Idempotent: safe to re-run. Non-fatal where it can be (warns and keeps going),
# so `coop doctor` can report whatever is still missing at the end.
#
#   Flags:
#     --force        Reinstall pi tools / pipx packages even if already present
#     --no-fabric    Skip installing the Microsoft Fabric CLI (ms-fabric-cli)
#     --no-prereqs   Report missing prerequisites but continue anyway
#     --prereqs auto Install missing prerequisites visibly, then stop and ask
#                    for a new terminal
#     --yes, -y      Assume yes for prompts
#
set -uo pipefail

COOP_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
export COOP_ROOT
# shellcheck source=../lib/common.sh
. "$COOP_ROOT/lib/common.sh"

FORCE=0; NO_FABRIC=0; NO_PREREQS=0; EDGE=0; PREREQS_AUTO=0
INSTALL_FAILURES=0
_prereqs_arg=0; _platform_arg=0
# --platform <fabric|azure_sql|both> answers the client platform question (master
# plan section 8 item 7) without a prompt: onboarding reads COOP_CLIENT_PLATFORM,
# and step 8 saves it even when onboarding does not run (non-interactive install).
coop_install_platform() { # <value>
  case "$1" in
    fabric|azure_sql|both) export COOP_CLIENT_PLATFORM="$1" ;;
    *) coop_warn "install: --platform takes one value: fabric, azure_sql or both (got '$1')" ;;
  esac
}
for a in "$@"; do
  if [ "$_prereqs_arg" = 1 ]; then
    _prereqs_arg=0
    if [ "$a" = auto ]; then PREREQS_AUTO=1; else coop_warn "install: --prereqs takes one value: auto"; fi
    continue
  fi
  if [ "$_platform_arg" = 1 ]; then
    _platform_arg=0
    coop_install_platform "$a"
    continue
  fi
  case "$a" in
    '') ;;                                            # ignore blank args (launchers can pass one)
    --force) FORCE=1 ;;
    --no-fabric) NO_FABRIC=1 ;;
    --no-prereqs) NO_PREREQS=1 ;;
    --prereqs=auto) PREREQS_AUTO=1 ;;
    --prereqs) _prereqs_arg=1 ;;
    --platform=*) coop_install_platform "${a#--platform=}" ;;
    --platform) _platform_arg=1 ;;
    --edge) EDGE=1 ;;
    --yes|-y) export COOP_ASSUME_YES=1 ;;
    *) coop_warn "install: ignoring unknown flag '$a'" ;;
  esac
done
[ "$_prereqs_arg" = 1 ] && coop_warn "install: --prereqs takes one value: auto"
[ "$_platform_arg" = 1 ] && coop_warn "install: --platform takes one value: fabric, azure_sql or both"
unset _prereqs_arg _platform_arg

# --- What we install (release manifest is the single source of truth) ----------
PI_NPM_PACKAGE="$(coop_manifest_get pi.package || echo "@earendil-works/pi-coding-agent")"
PI_TARGET_VERSION="$(coop_manifest_get pi.version)"
PI_EXTENSIONS=(
  "npm:pi-mcp-adapter"        # MCP servers (Fabric / Power BI / Microsoft Learn / context-mode)
  "npm:pi-hermes-memory"      # persistent memory + session search + secret scanning
  "npm:pi-better-openai"      # plan usage limits (5h/7d) — shown in coop's footer
  "npm:pi-web-access"         # web search / URL fetch / GitHub clone / PDF / video (read-only)
  "npm:@juicesharp/rpiv-ask-user-question"  # structured questions the model can ask (consent rounds)
  "npm:@xl0/pi-lovely-rename"  # names an unnamed session after a few turns (+ /rename); master plan N1
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
  local target="$FABRIC_PKG" fabric_py="" fabric_fetch="" fabric_plan=""
  # A local 3.10-3.13, or pipx's standalone 3.12 (coop_fabric_pipx_plan, shared
  # with update and doctor --fix).
  if ! fabric_plan="$(coop_fabric_pipx_plan)"; then
    printf 'Microsoft Fabric CLI needs Python 3.12 or 3.13 — upgrade pipx or install Python 3.12, then re-run: coop install'
    return 1
  fi
  IFS="$(printf '\t')" read -r fabric_py fabric_fetch <<EOF_PLAN
$fabric_plan
EOF_PLAN
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
        # Reinstall explicitly so an existing unsupported 3.14 venv is repaired.
        pipx install --force ${fabric_fetch:+"$fabric_fetch"} --python "$fabric_py" "$target" >/dev/null 2>&1 || true
      elif [ -n "${ver:-}" ] && [ "$cur" != "$ver" ]; then
        if ! pipx install --force ${fabric_fetch:+"$fabric_fetch"} --python "$fabric_py" "$target" >/dev/null 2>&1; then
          printf 'failed to converge %s to %s' "$FABRIC_PKG" "$ver"; return 1
        fi
        coop_info "converged $FABRIC_PKG $cur -> $ver"
      elif [ -n "$fabric_fetch" ]; then
        # The package pin may already match while its old venv still uses 3.14.
        pipx install --force "$fabric_fetch" --python "$fabric_py" "$target" >/dev/null 2>&1 \
          || { printf 'failed to rebuild %s with standalone Python %s' "$FABRIC_PKG" "$fabric_py"; return 1; }
      fi
    else
      pipx install ${fabric_fetch:+"$fabric_fetch"} --python "$fabric_py" "$target" >/dev/null 2>&1 || true
    fi
  else
    pipx install --force ${fabric_fetch:+"$fabric_fetch"} --python "$fabric_py" "$target" >/dev/null 2>&1 || { printf 'failed to reinstall %s (%s)' "$FABRIC_PKG" "$target"; return 1; }
  fi
  # Runtime libraries live in the Fabric CLI environment; exact pins and import
  # are verified with the same interpreter the fallback will execute.
  if ! coop_converge_fabric_python_packages "$EDGE"; then
    printf 'failed to converge Fabric Python runtime (fabric-cicd + pyodbc)'; return 1
  fi
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
      # Only the release's pinned version is installed. A tool with no pin fails
      # rather than falling back to npm's latest, and there is no `npm update -g`
      # fallback: it ignores the version and moves the tool to latest.
      local ver
      ver="$(coop_manifest_get "npm_tools.$pkg")"
      if [ -z "$ver" ]; then fail=$((fail+1)); continue; fi
      spec="${pkg}@${ver}"
    fi
    npm install -g "$spec" >/dev/null 2>&1 && ok=$((ok+1)) || fail=$((fail+1))
  done
  if [ "$fail" -eq 0 ]; then printf '%d Power BI/Fabric authoring tool(s) ready' "$ok"; return 0; fi
  printf '%d installed, %d failed' "$ok" "$fail"; return 1
}

# --- Prerequisite gate (plan H1) ----------------------------------------------
# Print the prerequisite table; sets PREREQ_MISSING to the missing REQUIRED rows.
_show_prereqs() {
  local us o n req ok det fix step line
  us="$(printf '\037')"
  PREREQ_MISSING=0
  while IFS="$us" read -r o n req ok det fix; do
    line="$o. $n${det:+  ($det)}"
    if [ "$ok" = 1 ]; then coop_ok "$line"; continue; fi
    if [ "$req" = 1 ]; then coop_err "$line"; PREREQ_MISSING=$((PREREQ_MISSING + 1)); else coop_warn "$line"; fi
    printf '%s\n' "$fix" | sed 's/ then /\
/g' | while IFS= read -r step; do coop_say "      $step"; done
  done <<EOF_PREREQS
$(coop_prereq_rows "$NO_FABRIC")
EOF_PREREQS
}

# --prereqs auto: run each missing REQUIRED row's printed command, in table order,
# with its output and exit code visible. Optional rows are never auto-installed.
_install_prereqs() {
  local us o n req ok det fix step steps rc
  us="$(printf '\037')"
  # Rows and steps are read on fds 3/4 so each command keeps the terminal as
  # stdin (sudo, brew, and winget may prompt).
  while IFS="$us" read -r o n req ok det fix <&3; do
    [ "$ok" = 1 ] || [ "$req" != 1 ] && continue
    case "$fix" in see\ *) continue ;; esac
    # Split " then " into one step per line OUTSIDE the heredoc: inside one, the
    # backslash-newline in sed's replacement is a line continuation and vanishes,
    # which used to run "a then b" as the single command "ab".
    steps="$(printf '%s\n' "$fix" | sed 's/ then /\
/g')"
    while IFS= read -r step <&4; do
      coop_info "running: $step"
      rc=0; sh -c "$step" || rc=$?
      if [ "$rc" -ne 0 ]; then coop_warn "exited with code $rc" "run it yourself: $step"; break; fi
    done 4<<EOF_STEPS
$steps
EOF_STEPS
  done 3<<EOF_PREREQS
$(coop_prereq_rows "$NO_FABRIC")
EOF_PREREQS
  if [ -z "${COOP_TEST_STUB_PATH:-}" ] && [ -d "/opt/homebrew/bin" ]; then
    case ":$PATH:" in *":/opt/homebrew/bin:"*) : ;; *) PATH="/opt/homebrew/bin:$PATH" ;; esac
  fi
  hash -r 2>/dev/null || true
}

coop_head "Cooptimize agent bootstrap (v${COOP_VERSION})  [$OS]"

# Check every prerequisite before installing anything. A missing required row
# stops here with the exact command, instead of failing several steps later.
coop_head "1/9  Prerequisites"
_show_prereqs
# The command that re-runs this install. A first install stops here, before step 7
# links `coop` onto PATH, so until then name the clone's own launcher (#112).
# Checked before --prereqs auto can widen PATH.
INSTALL_CMD='coop install'
have coop || INSTALL_CMD="$(printf '%q' "$COOP_ROOT/bin/coop") install"
if [ "$PREREQ_MISSING" -gt 0 ] && [ "$PREREQS_AUTO" = 1 ] && [ "$NO_PREREQS" != 1 ]; then
  _install_prereqs
  coop_head "Prerequisites (re-checked)"
  _show_prereqs
  [ "$PREREQ_MISSING" -gt 0 ] && coop_err "$PREREQ_MISSING required prerequisite(s) still missing — install the ✗ rows above in that order."
  coop_warn "Open a NEW terminal so the new tools are on PATH, then run: $INSTALL_CMD"
  exit 1
fi
if [ "$PREREQ_MISSING" -gt 0 ]; then
  if [ "$NO_PREREQS" = 1 ]; then
    coop_warn "$PREREQ_MISSING required prerequisite(s) missing (--no-prereqs: continuing anyway)"
  else
    coop_err "$PREREQ_MISSING required prerequisite(s) missing. Install the ✗ rows above in that order, open a NEW terminal, then run: $INSTALL_CMD"
    coop_say "      (or let coop run those commands for you: $INSTALL_CMD --prereqs auto)"
    exit 1
  fi
else
  coop_ok "all prerequisites present, continuing"
fi
# A Python found off PATH (Git Bash: install manager, winget user scope) must be
# visible to the pipx and Fabric steps in this same run.
if [ "$NO_FABRIC" != 1 ] && _gate_py="$(coop_fabric_bootstrap_python 2>/dev/null)"; then
  case "$_gate_py" in
    */*) _gate_dir="$(dirname "$_gate_py")"
         case ":$PATH:" in *":$_gate_dir:"*) : ;; *) PATH="$_gate_dir:$PATH" ;; esac ;;
  esac
  unset _gate_dir
fi
unset _gate_py

# Pin the overall bar to the bottom for the install phase; restore the cursor even
# on Ctrl-C. (coop_progress_end is idempotent, so the EXIT trap is a safe no-op
# once we've ended it explicitly after step 5.)
coop_progress_begin "$PROG_TOTAL"
# EXIT restores the cursor + reaps the unit; INT/TERM ALSO exit (a bare trap would
# clean up but then let the script resume and keep mutating the machine on Ctrl-C).
trap 'coop_progress_end; _coop_unit_cleanup' EXIT
trap 'coop_progress_end; _coop_unit_cleanup; exit 130' INT TERM

coop_unit "pipx" _unit_pipx || INSTALL_FAILURES=$((INSTALL_FAILURES + 1))
# Make a just-installed pipx (and the bins pipx will drop tools into) visible to
# the REST of this run, so steps 4/5 don't fail "pipx missing" until a new shell.
if _py="$(coop_python)"; then _ub="$("$_py" -m site --user-base 2>/dev/null)"; [ -n "${_ub:-}" ] && PATH="$_ub/bin:$PATH"; unset _ub; fi; unset _py
PATH="$HOME/.local/bin:$PATH"   # pipx default PIPX_BIN_DIR (fab, coop-* land here)
hash -r 2>/dev/null || true

# --- 2. Pi itself ------------------------------------------------------------
coop_head "2/9  Pi (@earendil-works/pi-coding-agent)"
coop_unit "pi (@earendil-works/pi-coding-agent)" _unit_pi || INSTALL_FAILURES=$((INSTALL_FAILURES + 1))
# Make a just-npm-installed `pi` visible to step 3 in the same run (npm's global
# bin dir is often not yet on PATH right after install).
if have npm; then _np="$(npm prefix -g 2>/dev/null)"; [ -n "${_np:-}" ] && PATH="$_np/bin:$PATH"; unset _np; fi
hash -r 2>/dev/null || true

# --- 3. Pi extensions (MCP / memory / usage / web / ask-user) ----------------
coop_head "3/9  Pi extensions"
for ext in "${PI_EXTENSIONS[@]}"; do
  coop_unit "$ext" _unit_ext "$ext" || INSTALL_FAILURES=$((INSTALL_FAILURES + 1))
done

# --- 4. Microsoft Fabric CLI -------------------------------------------------
coop_head "4/9  Microsoft Fabric CLI (fab)"
if [ "$NO_FABRIC" = 1 ]; then
  coop_warn "skipped (--no-fabric)"
else
  coop_unit "Microsoft Fabric CLI" _unit_fabric || INSTALL_FAILURES=$((INSTALL_FAILURES + 1))
  if ! coop_ensure_fabric_odbc_driver "$((1 - NO_PREREQS))"; then
    coop_warn "Fabric SQL fallback is not ready" "install ODBC Driver 18+, then run: coop doctor"
    INSTALL_FAILURES=$((INSTALL_FAILURES + 1))
  fi
  hash -r 2>/dev/null || true
fi

# --- 5. Standalone Coop tools ------------------------------------------------
coop_head "5/9  Coop tools (coop-data-doc / coop-sql-review / coop-dax-review)"
for pkg in "${PY_TOOLS[@]}"; do
  coop_unit "$pkg" _unit_pytool "$pkg" || INSTALL_FAILURES=$((INSTALL_FAILURES + 1))
done

# --- 6. Microsoft Fabric / Power BI authoring tools (npm) --------------------
coop_head "6/9  Fabric / Power BI authoring tools"
coop_unit "Power BI/Fabric authoring tools" _unit_pbih_tools || INSTALL_FAILURES=$((INSTALL_FAILURES + 1))
hash -r 2>/dev/null || true

# Done with the install items — finalize the bar (leaves a permanent 100% line).
coop_progress_end
[ "${COOP_FLEET_TEST_MODE:-0}" = 1 ] && { [ "$INSTALL_FAILURES" -eq 0 ]; exit; }

# --- 7. Put `coop` on PATH ---------------------------------------------------
coop_head "7/9  Link 'coop' onto your PATH"
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
  coop_head "8/9  Personalize Coop"
  coop_maybe_onboard || coop_warn "onboarding could not complete; run: coop onboard"
fi
# --platform is kept even when onboarding did not run (non-interactive or
# COOP_NO_ONBOARD): the first interactive launch then skips that question.
if [ -n "${COOP_CLIENT_PLATFORM:-}" ] && [ "$(coop_client_platform)" != "$COOP_CLIENT_PLATFORM" ]; then
  _plat_py="$(coop_python 2>/dev/null || true)"
  if [ -n "$_plat_py" ] && "$_plat_py" "$COOP_ROOT/scripts/onboard.py" platform --set "$COOP_CLIENT_PLATFORM" >/dev/null; then
    coop_ok "client platform saved: $COOP_CLIENT_PLATFORM"
  else
    coop_warn "could not save the client platform; run: coop onboard --platform $COOP_CLIENT_PLATFORM"
  fi
  unset _plat_py
fi

# --- 9. Sync, model sign-in, and doctor ---------------------------------------
coop_head "9/9  Sync assets, sign in, and run doctor"
# Fabric was converged (or explicitly skipped) above; avoid a second injection/prompt.
if ! COOP_SKIP_FABRIC_SYNC=1 "$COOP_ROOT/scripts/sync.sh"; then
  coop_warn "sync reported issues"
  INSTALL_FAILURES=$((INSTALL_FAILURES + 1))
fi

# Finish a fresh interactive setup inside the real Pi /login UI. coop-tools
# primes the built-in command and, in login-only mode, returns here as soon as Pi
# persists the credential. Non-interactive automation and explicit opt-outs keep
# the previous behavior and receive doctor's normal login hint instead.
if [ "$INSTALL_FAILURES" -eq 0 ] && [ -t 0 ] && [ -t 1 ] \
  && [ "${COOP_NO_MODEL_LOGIN:-0}" != "1" ] \
  && ! coop_pi_login_present; then
  coop_head "Final setup  Sign in to the model"
  coop_say "Press Enter on the prepared /login command, then complete the browser sign-in"
  coop_say "with your Cooptimize OpenAI account. Coop will return here automatically."
  COOP_PRIME_MODEL_LOGIN=1 COOP_LOGIN_ONLY=1 "$COOP_ROOT/bin/coop"
  LOGIN_RC=$?
  if coop_pi_login_present; then
    coop_ok "model sign-in saved — Coop is ready"
  else
    coop_warn "model sign-in did not finish" "run: coop   (the /login command will be ready)"
    [ "$LOGIN_RC" -ne 0 ] && coop_warn "the sign-in session exited with code $LOGIN_RC"
    INSTALL_FAILURES=$((INSTALL_FAILURES + 1))
  fi
fi

echo >&2
# Propagate doctor's verdict as the install's exit code, so a genuinely broken
# install (a required dep still missing) is detectable by whatever ran `coop install`
# (onboarding automation, the double-click launcher's wrapper). Steps above stay
# warn-and-continue; this is the one authoritative "is it usable?" signal.
"$COOP_ROOT/scripts/doctor.sh"; DOCTOR_RC=$?

echo >&2
# Close on doctor's verdict: a green "complete" line after a failed doctor would
# bury the real state — on failure, point back at the ✗ items instead.
INSTALL_RC=0
[ "$DOCTOR_RC" -ne 0 ] && INSTALL_RC=1
[ "$INSTALL_FAILURES" -gt 0 ] && INSTALL_RC=1
if [ "$INSTALL_RC" -ne 0 ]; then
  [ "$INSTALL_FAILURES" -gt 0 ] && coop_warn "$INSTALL_FAILURES install/sync step(s) failed — review the ! items above"
  if [ "$DOCTOR_RC" -ne 0 ]; then
    coop_warn "Bootstrap finished, but doctor reported problems — fix the ✗ items above, then re-run: coop doctor"
  else
    coop_warn "Bootstrap is incomplete — fix the failed steps above, then re-run: coop install"
  fi
elif [ "${COOP_ON_PATH:-1}" = 1 ]; then
  coop_ok "Bootstrap complete. Coop is ready — start it with:  coop"
else
  coop_ok "Bootstrap complete — but '$LOCALBIN' isn't on this shell's PATH yet."
fi
if [ "${COOP_ON_PATH:-1}" != 1 ]; then
  coop_say "      • open a NEW terminal, then run:  coop"
  coop_say "      • or use it in THIS shell right now:  $LOCALBIN/coop"
  coop_say "      • to make it permanent, add to ~/.zshrc (or ~/.bashrc):  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi
exit "$INSTALL_RC"

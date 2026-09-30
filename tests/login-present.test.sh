#!/usr/bin/env bash
# #167: Pi writes an empty `{}` auth.json on startup, so "the file is non-empty"
# is not proof of a model login. coop_pi_login_present (bash) and
# Test-CoopPiLoginPresent (PowerShell, when pwsh is available) must agree that
# only a stored provider credential counts, with or without Python; so must the
# by-path helpers coop doctor uses.
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
AGENT="$TMP/agent"; mkdir -p "$AGENT"
# Native Windows pwsh needs Windows paths when this runs under Git Bash.
AGENT_NATIVE="$AGENT"; ROOT_NATIVE="$ROOT"
if command -v cygpath >/dev/null 2>&1; then AGENT_NATIVE="$(cygpath -w "$AGENT")"; ROOT_NATIVE="$(cygpath -w "$ROOT")"; fi

bash_present() { # <with-python: 1|0>
  if [ "$1" = "1" ]; then
    env -u COOP_NO_ISOLATE COOP_AGENT_DIR="$AGENT" PI_CODING_AGENT_DIR="$AGENT" COOP_ROOT="$ROOT" bash -c '. "$COOP_ROOT/lib/common.sh"; coop_pi_login_present'
  else
    # No Python: coop_python finds none, so the grep fallback decides. (Stripping
    # PATH instead breaks on Windows, where Git Bash tools need their DLL folder.)
    env -u COOP_NO_ISOLATE COOP_AGENT_DIR="$AGENT" PI_CODING_AGENT_DIR="$AGENT" COOP_ROOT="$ROOT" bash -c '. "$COOP_ROOT/lib/common.sh"; coop_python() { return 1; }; coop_pi_login_present'
  fi
}
ps_present() {
  env -u COOP_NO_ISOLATE COOP_AGENT_DIR="$AGENT_NATIVE" PI_CODING_AGENT_DIR="$AGENT_NATIVE" pwsh -NoLogo -NoProfile -Command ". '$ROOT_NATIVE/lib/common.ps1'; if (Test-CoopPiLoginPresent) { exit 0 } else { exit 1 }" >/dev/null 2>&1
}
check() { # <label> <expected 0|1>
  local label="$1" want="$2" got
  bash_present 1; got=$?; [ "$got" = "$want" ] && ok "bash (python): $label" || ko "bash (python): $label (got $got, want $want)"
  bash_present 0; got=$?; [ "$got" = "$want" ] && ok "bash (no python): $label" || ko "bash (no python): $label (got $got, want $want)"
  if command -v pwsh >/dev/null 2>&1; then
    ps_present; got=$?; [ "$got" = "$want" ] && ok "PowerShell: $label" || ko "PowerShell: $label (got $got, want $want)"
  fi
}

check "no auth.json is not a login" 1
: > "$AGENT/auth.json";               check "an empty auth.json is not a login" 1
printf '{}' > "$AGENT/auth.json";     check "Pi's startup {} is not a login" 1
printf '{\n}\n' > "$AGENT/auth.json"; check "a pretty-printed {} is not a login" 1
printf 'not json' > "$AGENT/auth.json"; check "a corrupt auth.json is not a login" 1
printf '{\n  "openai-codex": {\n    "type": "oauth",\n    "access": "x"\n  }\n}\n' > "$AGENT/auth.json"
check "a stored openai-codex credential is a login" 0
printf '\xef\xbb\xbf{"openai":{"type":"oauth"}}' > "$AGENT/auth.json"
check "a BOM-prefixed credential is a login" 0
# coop doctor checks coop's auth.json and the shared ~/.pi/agent one with the same
# helper, by path (the #167 fix first missed doctor).
OTHER="$TMP/other"; mkdir -p "$OTHER"
OTHER_NATIVE="$OTHER"; command -v cygpath >/dev/null 2>&1 && OTHER_NATIVE="$(cygpath -w "$OTHER")"
path_check() { # <label> <expected 0|1>
  local label="$1" want="$2" got
  COOP_ROOT="$ROOT" bash -c '. "$COOP_ROOT/lib/common.sh"; coop_auth_has_credential "$1"' _ "$OTHER/auth.json"; got=$?
  [ "$got" = "$want" ] && ok "bash, by path: $label" || ko "bash, by path: $label (got $got, want $want)"
  if command -v pwsh >/dev/null 2>&1; then
    pwsh -NoLogo -NoProfile -Command ". '$ROOT_NATIVE/lib/common.ps1'; if (Test-CoopAuthHasCredential '$OTHER_NATIVE/auth.json') { exit 0 } else { exit 1 }" >/dev/null 2>&1; got=$?
    [ "$got" = "$want" ] && ok "PowerShell, by path: $label" || ko "PowerShell, by path: $label (got $got, want $want)"
  fi
}
path_check "a missing file is not a login" 1
printf '{}' > "$OTHER/auth.json"; path_check "Pi's startup {} is not a login" 1
printf '{"openai-codex":{"type":"oauth","access":"x"}}' > "$OTHER/auth.json"; path_check "a stored credential is a login" 0
for f in "$ROOT/scripts/doctor.sh" "$ROOT/scripts/doctor.ps1"; do
  case "$f" in
    *.sh) helper=coop_auth_has_credential; old='[ -s "$PI_CODING_AGENT_DIR/auth.json" ]' ;;
    *)    helper=Test-CoopAuthHasCredential; old='(Test-Path -LiteralPath $authA' ;;
  esac
  uses=$(( $(grep -oF "$helper" "$f" | wc -l) ))
  if [ "$uses" -ge 2 ] && ! grep -qF "$old" "$f"; then
    ok "$(basename "$f") checks both auth.json files for a stored credential"
  else
    ko "$(basename "$f") must use $helper for both auth.json files"
  fi
done
command -v pwsh >/dev/null 2>&1 || ok "pwsh not installed: PowerShell cases skipped"

[ "$fail" -eq 0 ] && echo "  login-present tests passed" || { echo "  ✗ login-present tests FAILED"; exit 1; }

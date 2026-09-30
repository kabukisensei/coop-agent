#!/usr/bin/env bash
# #167: Pi writes an empty `{}` auth.json on startup, so "the file is non-empty"
# is not proof of a model login. coop_pi_login_present (bash) and
# Test-CoopPiLoginPresent (PowerShell, when pwsh is available) must agree that
# only a stored provider credential counts, with or without Python.
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
AGENT="$TMP/agent"; mkdir -p "$AGENT"
NOPY="$TMP/nopy"; mkdir -p "$NOPY"
for t in grep dirname cat; do ln -s "$(command -v "$t")" "$NOPY/$t" 2>/dev/null; done
# Native Windows pwsh needs Windows paths when this runs under Git Bash.
AGENT_NATIVE="$AGENT"; ROOT_NATIVE="$ROOT"
if command -v cygpath >/dev/null 2>&1; then AGENT_NATIVE="$(cygpath -w "$AGENT")"; ROOT_NATIVE="$(cygpath -w "$ROOT")"; fi

bash_present() { # <with-python: 1|0>
  if [ "$1" = "1" ]; then
    env -u COOP_NO_ISOLATE COOP_AGENT_DIR="$AGENT" PI_CODING_AGENT_DIR="$AGENT" COOP_ROOT="$ROOT" bash -c '. "$COOP_ROOT/lib/common.sh"; coop_pi_login_present'
  else
    env -u COOP_NO_ISOLATE COOP_AGENT_DIR="$AGENT" PI_CODING_AGENT_DIR="$AGENT" COOP_ROOT="$ROOT" PATH="$NOPY" "$BASH" -c '. "$COOP_ROOT/lib/common.sh"; coop_pi_login_present'
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
command -v pwsh >/dev/null 2>&1 || ok "pwsh not installed: PowerShell cases skipped"

[ "$fail" -eq 0 ] && echo "  login-present tests passed" || { echo "  ✗ login-present tests FAILED"; exit 1; }

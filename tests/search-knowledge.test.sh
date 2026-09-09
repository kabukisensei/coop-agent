#!/usr/bin/env bash
#
# Tests for scripts/search-knowledge.py — configured-clone local keyword search.
#
# Covers the review contract:
#   - configured roots A and B are searched; an UNCONFIGURED root C that also
#     contains the marker is NEVER returned
#   - disabled / absent / malformed config and invalid repository entries
#   - duplicate roots, paths containing spaces, tilde expansion when HOME and
#     COOP_DIR differ
#   - relative local_path skipped; missing A with valid B still returns B
#   - zero matches ("ok") vs unavailable search vs unreadable file vs CLI
#     misuse (exit 2)
#   - symlink escape blocked; literal shell/regex metacharacters; per-repo
#     truncation without starving the second repository
#   - TeamAI presence/configuration cannot change which roots are searched
#     (fake teamai fixtures that write a sentinel if invoked; no sentinel may
#     appear and results must be identical)
#
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
HELPER="$ROOT/scripts/search-knowledge.py"
fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

PY="$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)"
[ -n "$PY" ] || { echo "FATAL: python3 required"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CFG="$TMP/coopcfg"
HOME_FAKE="$TMP/home"
A="$TMP/knowledge/repo a"          # path with a space
B="$TMP/knowledge/repo-b"
C="$TMP/knowledge/unconfigured"    # contains the marker but is NOT configured
mkdir -p "$CFG/.coop" "$HOME_FAKE" "$A" "$B" "$C"

MARKER="xzqunique_marker_7731"
echo "alpha note mentions $MARKER here" > "$A/note-one.md"
echo "beta note mentions $MARKER too"   > "$B/note-two.md"
echo "rogue note mentions $MARKER"      > "$C/rogue.md"

run_helper() { # env: COOP_DIR, HOME, PATH ; args passed through
  COOP_DIR="$CFG" HOME="$HOME_FAKE" "$PY" "$HELPER" "$@" 2>"$TMP/stderr.txt"
}

jget() { # <json-file> <python-expr-with-d>
  "$PY" -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"
}

write_cfg() { printf '%s\n' "$1" > "$CFG/.coop/config"; }

write_cfg "{\"schema_version\":1,\"knowledge\":{\"enabled\":true,\"repos\":[
  {\"url\":\"https://example.com/a.git\",\"local_path\":\"$A\"},
  {\"url\":\"https://example.com/b.git\",\"local_path\":\"$B\"}]}}"

# --- A and B searched, C never returned ---------------------------------------
out="$(run_helper --query "$MARKER")"; rc=$?
echo "$out" > "$TMP/out.json"
[ "$rc" -eq 0 ] && ok "exit 0 on successful search" || ko "exit $rc: $out"
[ "$(jget "$TMP/out.json" "d['status']")" = "ok" ] && ok "status ok when roots searched" || ko "status: $out"
[ "$(jget "$TMP/out.json" "len(d['searched_roots'])")" = "2" ] && ok "both configured roots searched" || ko "searched_roots: $out"
roots="$(jget "$TMP/out.json" "sorted(d['searched_roots'])")"
case "$roots" in *"repo a"*"repo-b"*) ok "searched roots include path with space + repo-b" ;; *) ko "roots: $roots" ;; esac
if jget "$TMP/out.json" "any('$C' in (m['root'] + '/' + m['path']) or 'rogue' in m['path'] for m in d['matches'])" | grep -q True; then
  ko "UNCONFIGURED root C leaked into matches"
else
  ok "unconfigured root C is never returned"
fi
[ "$(jget "$TMP/out.json" "len(d['matches'])")" = "2" ] && ok "one match per configured repo" || ko "matches: $out"
jget "$TMP/out.json" "all(m['path'].endswith('.md') and m['line']>=1 and len(m['snippet'])<=240 for m in d['matches'])" | grep -q True \
  && ok "matches carry relative path, line number, capped snippet" || ko "match shape: $out"

# --- citations contain root identity + relative path --------------------------
rel="$(jget "$TMP/out.json" "d['matches'][0]['root'] + '/' + d['matches'][0]['path']")"
case "$rel" in "$TMP"*) ok "citation root identity + relative path" ;; *) ko "citation root: $rel" ;; esac

# --- case-insensitive literal substring ---------------------------------------
out="$(run_helper --query "xzqunique")"; echo "$out" > "$TMP/out.json"
[ "$(jget "$TMP/out.json" "len(d['matches'])")" = "2" ] && ok "case-insensitive substring match" || ko "case: $out"

# --- zero matches is status ok, not an error ----------------------------------
out="$(run_helper --query "definitely_not_present_anywhere_99887")"; echo "$out" > "$TMP/out.json"
[ "$(jget "$TMP/out.json" "d['status']")" = "ok" ] && [ "$(jget "$TMP/out.json" "len(d['matches'])")" = "0" ] \
  && ok "zero matches is status ok with empty matches" || ko "zero-match: $out"

# --- disabled config -----------------------------------------------------------
write_cfg "{\"schema_version\":1,\"knowledge\":{\"enabled\":false,\"repos\":[{\"url\":\"u\",\"local_path\":\"$A\"}]}}"
out="$(run_helper --query "$MARKER")"; echo "$out" > "$TMP/out.json"
[ "$(jget "$TMP/out.json" "d['status']")" = "disabled" ] && [ "$(jget "$TMP/out.json" "len(d['matches'])")" = "0" ] \
  && ok "disabled config -> status disabled, exit 0" || ko "disabled: $out"

# --- absent knowledge block ----------------------------------------------------
write_cfg "{\"schema_version\":1}"
out="$(run_helper --query "$MARKER")"; echo "$out" > "$TMP/out.json"
[ "$(jget "$TMP/out.json" "d['status']")" = "disabled" ] && ok "absent knowledge block -> status disabled" || ko "absent: $out"

# --- malformed config JSON -----------------------------------------------------
write_cfg "{not json"
out="$(run_helper --query "$MARKER")"; echo "$out" > "$TMP/out.json"
[ "$(jget "$TMP/out.json" "d['status']")" = "invalid_config" ] && ok "malformed config -> status invalid_config" || ko "malformed: $out"

# --- truthy non-boolean enabled -------------------------------------------------
write_cfg "{\"knowledge\":{\"enabled\":\"true\",\"repos\":[]}}"
out="$(run_helper --query "$MARKER")"; echo "$out" > "$TMP/out.json"
[ "$(jget "$TMP/out.json" "d['status']")" = "invalid_config" ] && ok "string enabled -> invalid_config" || ko "string enabled: $out"

# --- repos not a list -----------------------------------------------------------
write_cfg "{\"knowledge\":{\"enabled\":true,\"repos\":\"oops\"}}"
out="$(run_helper --query "$MARKER")"; echo "$out" > "$TMP/out.json"
[ "$(jget "$TMP/out.json" "d['status']")" = "invalid_config" ] && ok "repos not a list -> invalid_config" || ko "repos type: $out"

# --- invalid repo entries: non-dict, no local_path, relative path ---------------
write_cfg "{\"knowledge\":{\"enabled\":true,\"repos\":[
  \"not-an-object\",
  {\"url\":\"https://example.com/x.git\"},
  {\"url\":\"https://example.com/rel.git\",\"local_path\":\"relative/path\"}]}}"
out="$(run_helper --query "$MARKER")"; echo "$out" > "$TMP/out.json"
[ "$(jget "$TMP/out.json" "d['status']")" = "unavailable" ] && ok "no valid roots -> status unavailable" || ko "unavailable: $out"
[ "$(jget "$TMP/out.json" "len(d['warnings'])")" = "3" ] && ok "three invalid entries each produce a warning" || ko "warnings: $out"

# --- missing A with valid B still returns B's matches ---------------------------
write_cfg "{\"knowledge\":{\"enabled\":true,\"repos\":[
  {\"url\":\"https://example.com/missing.git\",\"local_path\":\"$TMP/knowledge/absent\"},
  {\"url\":\"https://example.com/b.git\",\"local_path\":\"$B\"}]}}"
out="$(run_helper --query "$MARKER")"; echo "$out" > "$TMP/out.json"
[ "$(jget "$TMP/out.json" "d['status']")" = "ok" ] && [ "$(jget "$TMP/out.json" "len(d['matches'])")" = "1" ] \
  && ok "missing A skipped with warning; B still searched" || ko "missing-A: $out"
jget "$TMP/out.json" "any('absent' in w for w in d['warnings'])" | grep -q True \
  && ok "missing root named in warnings" || ko "missing-root warning: $out"

# --- duplicate roots are deduplicated -------------------------------------------
write_cfg "{\"knowledge\":{\"enabled\":true,\"repos\":[
  {\"url\":\"https://example.com/a.git\",\"local_path\":\"$A\"},
  {\"url\":\"https://example.com/a-dup.git\",\"local_path\":\"$A/\"}]}}"
out="$(run_helper --query "$MARKER")"; echo "$out" > "$TMP/out.json"
[ "$(jget "$TMP/out.json" "len(d['searched_roots'])")" = "1" ] && [ "$(jget "$TMP/out.json" "len(d['matches'])")" = "1" ] \
  && ok "duplicate roots deduplicated" || ko "dedupe: $out"

# --- tilde expansion against HOME even when COOP_DIR points elsewhere ------------
mkdir -p "$HOME_FAKE/tilde-kb"
echo "tilde note $MARKER" > "$HOME_FAKE/tilde-kb/til.md"
write_cfg "{\"knowledge\":{\"enabled\":true,\"repos\":[{\"url\":\"u\",\"local_path\":\"~/tilde-kb\"}]}}"
out="$(run_helper --query "$MARKER")"; echo "$out" > "$TMP/out.json"
[ "$(jget "$TMP/out.json" "len(d['matches'])")" = "1" ] && ok "tilde expands against HOME, not COOP_DIR" || ko "tilde: $out"

# --- backslash tilde form ---------------------------------------------------------
write_cfg "{\"knowledge\":{\"enabled\":true,\"repos\":[{\"url\":\"u\",\"local_path\":\"~\\\\tilde-kb\"}]}}"
out="$(run_helper --query "$MARKER")"; echo "$out" > "$TMP/out.json"
[ "$(jget "$TMP/out.json" "len(d['matches'])")" = "1" ] && ok "~\\\\ tilde form expands too" || ko "backslash tilde: $out"

# --- unreadable file is a warning, never a claimed match --------------------------
mkdir -p "$TMP/kb-unreadable"
echo "unreadable $MARKER" > "$TMP/kb-unreadable/secret.md"
chmod 000 "$TMP/kb-unreadable/secret.md"
write_cfg "{\"knowledge\":{\"enabled\":true,\"repos\":[{\"url\":\"u\",\"local_path\":\"$TMP/kb-unreadable\"}]}}"
out="$(run_helper --query "$MARKER")"; echo "$out" > "$TMP/out.json"
chmod 644 "$TMP/kb-unreadable/secret.md"
if [ "$(id -u)" = "0" ]; then
  echo "  – running as root: chmod 000 is ineffective; skipping unreadable-file assertion"
else
  jget "$TMP/out.json" "any('unreadable file' in w for w in d['warnings'])" | grep -q True \
    && ok "unreadable file warned, not claimed searched" || ko "unreadable: $out"
fi

# --- symlink escape blocked --------------------------------------------------------
mkdir -p "$TMP/kb-link/outside"
echo "outside secret $MARKER" > "$TMP/kb-link/outside/out.md"
mkdir -p "$TMP/kb-link/inside"
ln -s "$TMP/kb-link/outside" "$TMP/kb-link/inside/escape-link"
echo "inside note fine" > "$TMP/kb-link/inside/in.md"
write_cfg "{\"knowledge\":{\"enabled\":true,\"repos\":[{\"url\":\"u\",\"local_path\":\"$TMP/kb-link/inside\"}]}}"
out="$(run_helper --query "$MARKER")"; echo "$out" > "$TMP/out.json"
[ "$(jget "$TMP/out.json" "len(d['matches'])")" = "0" ] && ok "symlinked directory cannot escape the root" || ko "symlink escape: $out"

# --- literal metacharacters, not regex/shell --------------------------------------
write_cfg "{\"knowledge\":{\"enabled\":true,\"repos\":[{\"url\":\"u\",\"local_path\":\"$A\"}]}}"
echo 'grep (a|b)* $MARKER.* [ok]? "quoted" here' > "$A/meta.md"
out="$(run_helper --query '(a|b)* $MARKER.* [ok]?')"; echo "$out" > "$TMP/out.json"
[ "$(jget "$TMP/out.json" "len(d['matches'])")" = "1" ] && ok "shell/regex metacharacters matched literally" || ko "meta: $out"

# --- per-repo truncation without starving the second repo --------------------------
mkdir -p "$TMP/kb-many-a" "$TMP/kb-many-b"
i=1; while [ "$i" -le 25 ]; do echo "line $i has $MARKER" >> "$TMP/kb-many-a/many.md"; i=$((i+1)); done
echo "single $MARKER in b" > "$TMP/kb-many-b/b.md"
write_cfg "{\"knowledge\":{\"enabled\":true,\"repos\":[
  {\"url\":\"u\",\"local_path\":\"$TMP/kb-many-a\"},
  {\"url\":\"u\",\"local_path\":\"$TMP/kb-many-b\"}]}}"
out="$(run_helper --query "$MARKER")"; echo "$out" > "$TMP/out.json"
[ "$(jget "$TMP/out.json" "d['per_repo']['$TMP/kb-many-a']['truncated']")" = "True" ] \
  && [ "$(jget "$TMP/out.json" "d['per_repo']['$TMP/kb-many-a']['total']")" = "25" ] \
  && ok "repo A truncated at 10 with total recorded" || ko "truncation: $out"
[ "$(jget "$TMP/out.json" "d['per_repo']['$TMP/kb-many-b']['matches']")" = "1" ] \
  && ok "second repository still searched despite A's truncation" || ko "starved B: $out"

# --- empty query is invalid usage (exit 2) -----------------------------------------
run_helper --query "   " > /dev/null 2>"$TMP/err.txt"; rc=$?
[ "$rc" -eq 2 ] && ok "empty query exits 2" || ko "empty query rc=$rc"
run_helper > /dev/null 2>"$TMP/err.txt"; rc=$?
[ "$rc" -eq 2 ] && ok "missing --query exits 2" || ko "missing query rc=$rc"

# --- helper never touches an unconfigured ~/.coop/knowledge fallback --------------
mkdir -p "$HOME_FAKE/.coop/knowledge"
echo "fallback $MARKER" > "$HOME_FAKE/.coop/knowledge/fallback.md"
write_cfg "{\"knowledge\":{\"enabled\":true,\"repos\":[]}}"
out="$(run_helper --query "$MARKER")"; echo "$out" > "$TMP/out.json"
[ "$(jget "$TMP/out.json" "len(d['matches'])")" = "0" ] && ok "no fallback scan of ~/.coop/knowledge" || ko "fallback leak: $out"

# --- TeamAI cannot change which roots are searched --------------------------------
make_teamai() { # <dir> ; writes a fake teamai that records invocation via sentinel
  mkdir -p "$1"
  cat > "$1/teamai" <<EOF
#!/bin/sh
echo invoked > "$1/sentinel"
echo "fake teamai output that must be ignored"
EOF
  chmod +x "$1/teamai"
}
write_cfg "{\"knowledge\":{\"enabled\":true,\"repos\":[
  {\"url\":\"u\",\"local_path\":\"$A\"},
  {\"url\":\"u\",\"local_path\":\"$B\"}]}}"

# (a) no TeamAI on PATH
out1="$(run_helper --query "$MARKER")"
# (b) fake uninitialized TeamAI on PATH
FAKE1="$TMP/fake1"; make_teamai "$FAKE1"
out2="$(PATH="$FAKE1:$PATH" run_helper --query "$MARKER")"
# (c) fake differently-configured TeamAI on PATH
FAKE2="$TMP/fake2"; make_teamai "$FAKE2"
out3="$(PATH="$FAKE2:$PATH" run_helper --query "$MARKER")"

[ "$out1" = "$out2" ] && [ "$out1" = "$out3" ] \
  && ok "results identical with no teamai / fake teamai / differently-configured teamai" \
  || ko "teamai changed results"
[ ! -e "$FAKE1/sentinel" ] && [ ! -e "$FAKE2/sentinel" ] \
  && ok "helper never invokes TeamAI (no sentinel)" || ko "teamai was invoked!"

# ==============================================================================
# Unreadable roots vs unreadable subdirectories (review finding 6): an
# inaccessible ROOT must be reported unavailable — never "searched ok with zero
# matches" — while an accessible root with an inaccessible SUBDIRECTORY is a
# partial search with an explicit warning. chmod 000 blocks the owner too, so
# these run unprivileged; when the suite runs as root the helper is dropped to
# nobody via setpriv. (Permission bits are POSIX semantics — skipped on Windows.)
# ==============================================================================
UNAME_S="$(uname -s 2>/dev/null || echo unknown)"
case "$UNAME_S" in
  MINGW*|CYGWIN*|MSYS*) LOW_PRIV=skip ;;
  *)
    if [ "$(id -u)" = "0" ]; then
      if command -v setpriv >/dev/null 2>&1; then LOW_PRIV=setpriv; else LOW_PRIV=skip; fi
    else
      LOW_PRIV=direct
    fi
    ;;
esac

run_helper_low() { # run the helper unprivileged so chmod 000 is real
  if [ "$LOW_PRIV" = "setpriv" ]; then
    COOP_DIR="$CFG" HOME="$HOME_FAKE" setpriv --reuid=65534 --regid=65534 --clear-groups \
      "$PY" "$HELPER" "$@" 2>"$TMP/stderr-low.txt"
  else
    run_helper "$@"
  fi
}

if [ "$LOW_PRIV" != "skip" ]; then
  # Let the unprivileged helper traverse the fixture tree and read the config.
  chmod 755 "$TMP" "$CFG" "$CFG/.coop" "$HOME_FAKE" 2>/dev/null || true
  chmod 644 "$CFG/.coop/config" 2>/dev/null || true

  # --- unreadable ROOT: unavailable, never claimed searched --------------------
  mkdir -p "$TMP/kb-root-blocked"
  echo "hidden $MARKER" > "$TMP/kb-root-blocked/hidden.md"
  chmod 000 "$TMP/kb-root-blocked"
  write_cfg "{\"knowledge\":{\"enabled\":true,\"repos\":[{\"url\":\"u\",\"local_path\":\"$TMP/kb-root-blocked\"}]}}"
  out="$(run_helper_low --query "$MARKER")"; echo "$out" > "$TMP/out.json"
  chmod 755 "$TMP/kb-root-blocked"   # restore so cleanup can descend
  [ "$(jget "$TMP/out.json" "d['status']")" = "unavailable" ] \
    && ok "unreadable root -> status unavailable, not ok" || ko "unreadable-root status: $out"
  [ "$(jget "$TMP/out.json" "len(d['searched_roots'])")" = "0" ] \
    && ok "unreadable root is never listed as searched" || ko "searched_roots: $out"
  [ "$(jget "$TMP/out.json" "len(d['per_repo'])")" = "0" ] \
    && ok "unreadable root has no per_repo entry" || ko "per_repo: $out"
  jget "$TMP/out.json" "any('kb-root-blocked' in w for w in d['warnings'])" | grep -q True \
    && ok "unreadable root named in warnings" || ko "root warning: $out"

  # --- unreadable SUBDIRECTORY: partial search, distinguished from root --------
  mkdir -p "$TMP/kb-subdir-blocked/open" "$TMP/kb-subdir-blocked/sealed"
  echo "visible $MARKER" > "$TMP/kb-subdir-blocked/open/vis.md"
  echo "sealed $MARKER" > "$TMP/kb-subdir-blocked/sealed/secret.md"
  chmod 000 "$TMP/kb-subdir-blocked/sealed"
  write_cfg "{\"knowledge\":{\"enabled\":true,\"repos\":[{\"url\":\"u\",\"local_path\":\"$TMP/kb-subdir-blocked\"}]}}"
  out="$(run_helper_low --query "$MARKER")"; echo "$out" > "$TMP/out.json"
  chmod 755 "$TMP/kb-subdir-blocked/sealed"   # restore so cleanup can descend
  [ "$(jget "$TMP/out.json" "d['status']")" = "ok" ] \
    && ok "accessible root with sealed subdir still searches" || ko "subdir status: $out"
  [ "$(jget "$TMP/out.json" "len(d['searched_roots'])")" = "1" ] \
    && ok "root with sealed subdir IS listed as searched" || ko "searched_roots: $out"
  jget "$TMP/out.json" "any('unreadable subdirectory skipped' in w and 'sealed' in w for w in d['warnings'])" | grep -q True \
    && ok "sealed subdirectory named in warnings" || ko "subdir warning: $out"
  jget "$TMP/out.json" "any(m['path'].endswith('sealed/secret.md') for m in d['matches'])" | grep -q True \
    && ko "sealed subdirectory leaked a match" \
    || ok "sealed subdirectory contributes no matches"
  jget "$TMP/out.json" "d['per_repo'].get('$TMP/kb-subdir-blocked',{}).get('partial')" | grep -q True \
    && ok "per_repo marks the search partial" || ko "partial flag: $out"
else
  echo "  – POSIX permissions unavailable (root without setpriv, or Windows): skipping unreadable-root/subdir assertions"
fi

exit $fail

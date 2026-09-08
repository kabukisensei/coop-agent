#!/usr/bin/env bash
#
# Tests for scripts/sync-knowledge.sh against a LOCAL bare-repo fixture (no
# network): clone on first run, fast-forward on the second, dirty checkouts are
# warned + skipped (never reset), disabled flag is a no-op, bogus URLs warn and
# still exit 0.
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

REMOTE="$TMP/remote.git"
WORK="$TMP/work"
CLONE="$TMP/kb/incremental-bi"
CFG="$TMP/cfg"

git init --bare -b main -q "$REMOTE" 2>/dev/null || { git init --bare -q "$REMOTE" && git -C "$REMOTE" symbolic-ref HEAD refs/heads/main; }
git clone -q "$REMOTE" "$WORK" 2>/dev/null
git -C "$WORK" checkout -B main 2>/dev/null || true
git -C "$WORK" config user.email test@example.com
git -C "$WORK" config user.name "Test"
printf 'one\n' > "$WORK/note.md"
git -C "$WORK" add note.md
git -C "$WORK" commit -qm "first"
git -C "$WORK" push -q -u origin main

write_config() { # <enabled> <url> <path>
  mkdir -p "$CFG/.coop"
  cat > "$CFG/.coop/config" <<JSON
{"schema_version":1,"knowledge":{"enabled":$1,"repos":[{"url":"$2","local_path":"$3"}]}}
JSON
}

run_sync() { # extra env: COOP_DIR
  HOME="$TMP/home" COOP_DIR="$1" bash "$ROOT/scripts/sync-knowledge.sh" 2>&1
}

# --- first run clones ----------------------------------------------------------
write_config true "$REMOTE" "$CLONE"
out="$(run_sync "$CFG")"; rc=$?
[ "$rc" -eq 0 ] && [ -f "$CLONE/note.md" ] && ok "first run clones the repo" || ko "clone failed: rc=$rc out=$out"

# --- second run fast-forwards a new commit ------------------------------------
printf 'two\n' >> "$WORK/note.md"
git -C "$WORK" commit -qam "second"
git -C "$WORK" push -q 2>/dev/null
out="$(run_sync "$CFG")"; rc=$?
content="$(cat "$CLONE/note.md" 2>/dev/null)"
[ "$rc" -eq 0 ] && [ "$content" = "$(printf 'one\ntwo')" ] && ok "second run fast-forwards the new commit" || ko "ff failed: rc=$rc content=[$content] out=$out"

# --- dirty managed checkout: warn, skip, leave changes -------------------------
printf 'local edit\n' >> "$CLONE/note.md"
out="$(run_sync "$CFG")"; rc=$?
case "$out" in
  *"dirty"*"skip"*) ok "dirty checkout warns and skips" ;;
  *) ko "no dirty warning: $out" ;;
esac
grep -q "local edit" "$CLONE/note.md" && ok "dirty checkout left untouched" || ko "dirty checkout was modified"
[ "$rc" -eq 0 ] && ok "dirty checkout still exits 0" || ko "dirty checkout exit $rc"

# --- disabled flag is a no-op --------------------------------------------------
CFG2="$TMP/cfg2"
write_raw_config() { mkdir -p "$1/.coop"; printf '%s\n' "$2" > "$1/.coop/config"; }
write_raw_config "$CFG2" '{"schema_version":1,"knowledge":{"enabled":false,"repos":[{"url":"'"$REMOTE"'","local_path":"'"$TMP/kb2/x"'"}]}}'
out="$(run_sync "$CFG2")"; rc=$?
[ "$rc" -eq 0 ] && [ ! -e "$TMP/kb2/x" ] && ok "disabled flag is a no-op (nothing cloned)" || ko "disabled: rc=$rc out=$out"

# --- bogus URL warns and exits 0 ------------------------------------------------
CFG3="$TMP/cfg3"
write_raw_config "$CFG3" '{"schema_version":1,"knowledge":{"enabled":true,"repos":[{"url":"file:///nonexistent/nowhere.git","local_path":"'"$TMP/kb3/x"'"}]}}'
out="$(run_sync "$CFG3")"; rc=$?
[ "$rc" -eq 0 ] || ko "bogus URL exited $rc"
case "$out" in
  *"clone failed"*) ok "bogus URL warns + exits 0" ;;
  *) ko "bogus URL gave no warning: $out" ;;
esac
[ ! -e "$TMP/kb3/x" ] && ok "failed clone leaves no husk directory" || ko "husk dir left behind"

# --- missing knowledge key is a clean no-op -------------------------------------
CFG4="$TMP/cfg4"
write_raw_config "$CFG4" '{"schema_version":1,"integrations":{}}'
out="$(run_sync "$CFG4")"; rc=$?
[ "$rc" -eq 0 ] && ok "absent knowledge key exits 0" || ko "absent key exit $rc"

exit $fail

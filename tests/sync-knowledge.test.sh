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
git -C "$WORK" config core.autocrlf false
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
content="$(cat "$CLONE/note.md" 2>/dev/null | tr -d '\r')"
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

# ==============================================================================
# Bounded-git regression (review finding 3): git, credential helpers, askpass,
# and SSH descendants can never wait indefinitely. A fake `git` records its
# argv, spawns a sleeping descendant, and hangs past a 1s test deadline.
# ==============================================================================

FAKEBIN="$TMP/fakebin"
SLEEPERFILE="$TMP/sleeper.pid"
FAKELOG="$TMP/fake-git.log"
PROBEOUT="$TMP/probe-env.txt"
REALGIT="$(command -v git)"
PY="$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)"
mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/git" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$FAKELOG"
if [ -n "\$PROBEENV" ]; then
  env | grep -E '^(GIT_TERMINAL_PROMPT|GCM_INTERACTIVE|GIT_ASKPASS|SSH_ASKPASS|GIT_SSH|GIT_SSH_COMMAND)=' > "$PROBEOUT" || true
fi
hang() {
  sleep 30 &
  echo \$! > "$SLEEPERFILE"
  wait
  exit 0
}
# Dispatch by SUBCOMMAND first, then by repo marker, so e.g. a status probe on
# the pull-hang repo passes through while its pull hangs.
case "\$*" in
  *"status --porcelain"*)
    case "\$*" in *hanghere-status*) hang ;; esac
    ;;
  *" pull "*)
    case "\$*" in *hanghere-pull*) hang ;; esac
    ;;
  "clone "*|*" clone "*)
    case "\$*" in *hanghere*) hang ;; esac
    ;;
esac
exec "$REALGIT" "\$@"
EOF
chmod +x "$FAKEBIN/git"

run_sync_bounded() { # <cfg> — 60s independent outer deadline so a regression cannot hang CI
  HOME="$TMP/home" COOP_DIR="$1" COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS=1 PATH="$FAKEBIN:$PATH" \
    bash "$ROOT/scripts/sync-knowledge.sh" > "$TMP/bounded.out" 2>&1 &
  local pid=$!
  local deadline=$((SECONDS+60))
  while kill -0 "$pid" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    OUTER_TIMED_OUT=1
  else
    wait "$pid"; BOUNDED_RC=$?
    OUTER_TIMED_OUT=0
  fi
}
assert_sleeper_dead() {
  if [ -f "$SLEEPERFILE" ]; then
    sleep 2   # allow the killed group to be reaped
    if kill -0 "$(cat "$SLEEPERFILE")" 2>/dev/null; then
      ko "sleeper descendant survived the timeout"
    else
      ok "sleeper descendant terminated with the owned tree"
    fi
    rm -f "$SLEEPERFILE"
  else
    ko "fake git never spawned its sleeper descendant"
  fi
}

# --- A. clone hang: bounded, warned, second healthy repo still processed --------
CFG5="$TMP/cfg5"
write_raw_config "$CFG5" '{"schema_version":1,"knowledge":{"enabled":true,"repos":[
  {"url":"https://example.invalid/hanghere-clone.git","local_path":"'"$TMP/kbh/hanghere-clone"'"},
  {"url":"'"$REMOTE"'","local_path":"'"$CLONE-bounded"'"}]}}'
rm -f "$FAKELOG"
run_sync_bounded "$CFG5"
[ "$OUTER_TIMED_OUT" = "0" ] && ok "A: sync completed inside the outer deadline" || ko "A: sync hung past the outer deadline"
[ "$BOUNDED_RC" -eq 0 ] && ok "A: timed-out clone still fails soft (exit 0)" || ko "A: exit $BOUNDED_RC"
grep -q "timed out" "$TMP/bounded.out" && ok "A: timeout warning surfaced" || ko "A: no timeout warning: $(cat "$TMP/bounded.out")"
[ -f "$CLONE-bounded/note.md" ] && ok "A: second healthy repo cloned in the same run" || ko "A: healthy repo missing"
assert_sleeper_dead
ls -d "$TMP/kbh"/.coop-knowledge-clone-* 2>/dev/null | grep . && ko "A: owned temp clone left behind" || ok "A: owned temp clone cleaned up"

# --- B. status-probe hang: unknown state, NEVER pulls ---------------------------
CFG6="$TMP/cfg6"
git clone -q "$REMOTE" "$TMP/kbh2/hanghere-status" 2>/dev/null
write_raw_config "$CFG6" '{"schema_version":1,"knowledge":{"enabled":true,"repos":[
  {"url":"'"$REMOTE"'","local_path":"'"$TMP/kbh2/hanghere-status"'"}]}}'
rm -f "$FAKELOG" "$SLEEPERFILE"
run_sync_bounded "$CFG6"
grep -q "state unknown" "$TMP/bounded.out" && ok "B: unknown-state warning on status timeout" || ko "B: no unknown-state warning: $(cat "$TMP/bounded.out")"
[ "$BOUNDED_RC" -eq 0 ] && ok "B: fails soft (exit 0)" || ko "B: exit $BOUNDED_RC"
grep "hanghere-status" "$FAKELOG" | grep -q "status --porcelain" && ok "B: status probe invoked" || ko "B: status probe missing from log"
if grep "hanghere-status" "$FAKELOG" | grep -q "pull"; then
  ko "B: pull was invoked despite the failed status probe"
else
  ok "B: failed status probe never pulls"
fi
assert_sleeper_dead

# --- C. pull hang: bounded, warned, checkout preserved ---------------------------
CFG7="$TMP/cfg7"
git clone -q "$REMOTE" "$TMP/kbh3/hanghere-pull" 2>/dev/null
write_raw_config "$CFG7" '{"schema_version":1,"knowledge":{"enabled":true,"repos":[
  {"url":"'"$REMOTE"'","local_path":"'"$TMP/kbh3/hanghere-pull"'"}]}}'
rm -f "$FAKELOG" "$SLEEPERFILE"
run_sync_bounded "$CFG7"
grep -q "timed out" "$TMP/bounded.out" && ok "C: pull timeout warned" || ko "C: no pull timeout warning: $(cat "$TMP/bounded.out")"
[ -f "$TMP/kbh3/hanghere-pull/note.md" ] && ok "C: existing checkout preserved" || ko "C: checkout damaged"
assert_sleeper_dead

# --- D. interrupted clone cleanup cannot delete an existing destination ----------
CFG8="$TMP/cfg8"
DEST8="$TMP/kbh4/hanghere-dest"
mkdir -p "$(dirname "$DEST8")"
write_raw_config "$CFG8" '{"schema_version":1,"knowledge":{"enabled":true,"repos":[
  {"url":"https://example.invalid/hanghere-dest.git","local_path":"'"$DEST8"'"}]}}'
rm -f "$FAKELOG" "$SLEEPERFILE"
# Pre-create the destination DURING the hanging clone (sync runs in background).
HOME="$TMP/home" COOP_DIR="$CFG8" COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS=1 PATH="$FAKEBIN:$PATH" \
  bash "$ROOT/scripts/sync-knowledge.sh" > "$TMP/bounded.out" 2>&1 &
pid8=$!
sleep 1   # let the clone start hanging first (1s deadline vs 30s fake sleep)
mkdir -p "$DEST8" && echo "user data" > "$DEST8/keep.txt"
deadline8=$((SECONDS+60))
while kill -0 "$pid8" 2>/dev/null && [ "$SECONDS" -lt "$deadline8" ]; do sleep 1; done
if kill -0 "$pid8" 2>/dev/null; then kill -9 "$pid8" 2>/dev/null; wait "$pid8" 2>/dev/null; ko "D: sync hung past outer deadline"; else wait "$pid8"; fi
grep -q "user data" "$DEST8/keep.txt" 2>/dev/null && ok "D: existing destination survived interrupted clone" || ko "D: destination was deleted"
assert_sleeper_dead

# --- E. child-only unattended env; nothing leaks into the parent ------------------
CFG9="$TMP/cfg9"
git clone -q "$REMOTE" "$TMP/kbh5/envprobe" 2>/dev/null
write_raw_config "$CFG9" '{"schema_version":1,"knowledge":{"enabled":true,"repos":[
  {"url":"'"$REMOTE"'","local_path":"'"$TMP/kbh5/envprobe"'"}]}}'
rm -f "$PROBEOUT"
PROBEENV=1 HOME="$TMP/home" COOP_DIR="$CFG9" COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS=1 PATH="$FAKEBIN:$PATH" \
  bash "$ROOT/scripts/sync-knowledge.sh" >/dev/null 2>&1
grep -q "^GIT_TERMINAL_PROMPT=0$" "$PROBEOUT" && ok "E: child GIT_TERMINAL_PROMPT=0" || ko "E: GIT_TERMINAL_PROMPT not bounded: $(cat "$PROBEOUT" 2>/dev/null)"
grep -q "^GCM_INTERACTIVE=never$" "$PROBEOUT" && ok "E: child GCM_INTERACTIVE=never" || ko "E: GCM_INTERACTIVE not bounded"
if grep -q "^GIT_SSH" "$PROBEOUT" 2>/dev/null; then
  # A custom GIT_SSH/GIT_SSH_COMMAND is preserved untouched (never replaced);
  # otherwise the runner must have injected unattended batch SSH.
  grep -q "^GIT_SSH_COMMAND=ssh -o BatchMode=yes$" "$PROBEOUT" \
    && ok "E: unattended batch SSH preserving host-key checking" \
    || ko "E: SSH not unattended: $(cat "$PROBEOUT")"
else
  ko "E: no SSH configuration visible in child env"
fi
[ -z "${GIT_TERMINAL_PROMPT:-}" ] && [ -z "${GCM_INTERACTIVE:-}" ] && ok "E: overrides do not leak into the parent shell"

# --- F. no watchdog survives; normal + nonzero exits remain meaningful ------------
if pgrep -f "knowledge-git.py" >/dev/null 2>&1; then
  ko "F: knowledge-git.py still running after sync"
else
  ok "F: no watchdog/leftover runner after sync"
fi
"$PY" "$ROOT/scripts/knowledge-git.py" --timeout-seconds 1 -- "$REALGIT" --version >/dev/null 2>&1
[ "$?" -eq 0 ] && ok "F: runner passes through a normal exit" || ko "F: normal exit not passed through"
"$PY" "$ROOT/scripts/knowledge-git.py" -- /nonexistent/git-binary-xyz status >/dev/null 2>&1
rc=$?
[ "$rc" -eq 127 ] && ok "F: cannot-start maps to 127" || ko "F: cannot-start rc=$rc (want 127)"
"$PY" "$ROOT/scripts/knowledge-git.py" >/dev/null 2>&1
rc=$?
[ "$rc" -eq 2 ] && ok "F: malformed usage maps to 2" || ko "F: usage rc=$rc (want 2)"

exit $fail

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

# Windows detection. On Git Bash, Python's subprocess (CreateProcess) resolves
# `git` via the native PATH/PATHEXT — an extensionless shell script is INVISIBLE
# to it (review finding: the timeout fixtures never executed on Windows, so no
# heartbeat/invocation-log/env-probe files ever appeared). The fixture must
# therefore be a real PE binary on Windows, compiled here from a small C shim.
# A missing compiler or an unwritten fixture log is a LOUD test failure, never
# a silent pass.
case "$(uname -s 2>/dev/null || echo unknown)" in
  MINGW*|CYGWIN*|MSYS*) WIN=1 ;;
  *) WIN=0 ;;
esac

# Env values consumed by the NATIVE (Windows) fixture must be Windows paths;
# the POSIX fixture keeps the POSIX forms.
winpath() { if [ "$WIN" = "1" ]; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
FAKELOG_ENV="$(winpath "$FAKELOG")"
PROBEOUT_ENV="$(winpath "$PROBEOUT")"
SLEEPERFILE_ENV="$(winpath "$SLEEPERFILE")"
if [ "$WIN" = "1" ]; then
  REALGIT_UNIX="$REALGIT"
  case "$REALGIT_UNIX" in
    *.exe) : ;;
    *) [ -f "$REALGIT_UNIX.exe" ] && REALGIT_UNIX="$REALGIT_UNIX.exe" ;;
  esac
  REALGIT_ENV="$(cygpath -w "$REALGIT_UNIX")"
else
  REALGIT_ENV="$REALGIT"
fi
# The C fixture reads its target paths from the ENVIRONMENT at runtime (it
# cannot see values baked into a bash heredoc), so export them for every
# bounded invocation. On POSIX the shell fixture has these values baked in and
# ignores the environment — the exports are simply unused there.
export FAKELOG="$FAKELOG_ENV"
export PROBEOUT="$PROBEOUT_ENV"
export REALGIT="$REALGIT_ENV"
export SLEEPERFILE="$SLEEPERFILE_ENV"
if [ "$WIN" = "1" ]; then
  cat > "$TMP/fake-git.c" <<'CEOF'
/* Test fixture: a fake `git` the Windows subprocess launcher actually
 * executes (a real PE binary). Mirrors the POSIX shell fixture contract:
 * log argv (FAKELOG), optionally dump GIT_* env (PROBEENV/PROBEOUT),
 * hang/orphan past the deadline for marker repos — spawning a REAL child
 * process whose PID is recorded in SLEEPERFILE so the tests can demand
 * evidence it existed and was terminated — and delegate everything else to
 * the real git (REALGIT).
 *
 * Orphan mode: the parent exits FIRST while the child keeps the inherited
 * stdout pipe open, so a capturing caller stays blocked until the runner
 * kills the owned tree. Exercised on Windows via the Job Object ownership in
 * knowledge-git.py (parent-exits-first was the gap the taskkill fallback
 * could not cover). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <process.h>
#include <windows.h>

static void logargv(int argc, char **argv) {
    const char *fakelog = getenv("FAKELOG");
    if (!fakelog) return;
    FILE *f = fopen(fakelog, "a");
    if (!f) return;
    for (int i = 1; i < argc; i++) fprintf(f, "%s%s", i > 1 ? " " : "", argv[i]);
    fputc('\n', f);
    fclose(f);
}

static void probeenv(void) {
    const char *probe = getenv("PROBEENV");
    if (!probe || probe[0] != '1') return;
    const char *out = getenv("PROBEOUT");
    FILE *f = out ? fopen(out, "a") : NULL;
    if (!f) return;
    const char *names[] = {"GIT_TERMINAL_PROMPT","GCM_INTERACTIVE","GIT_ASKPASS",
                           "SSH_ASKPASS","GIT_SSH","GIT_SSH_COMMAND", NULL};
    for (int i = 0; names[i]; i++) {
        const char *v = getenv(names[i]);
        if (v) fprintf(f, "%s=%s\n", names[i], v);
    }
    fclose(f);
}

/* Spawn a real child that outlives (orphan) or accompanies (hang) this
 * process, recording its PID. Candidate sleep programs in priority order;
 * every Git for Windows ships usr\bin\sleep.exe. */
static intptr_t spawn_sleeper(void) {
    static const char *git_sleep = "C:\\Program Files\\Git\\usr\\bin\\sleep.exe";
    const char *argv_sleep[] = {"sleep", "30", NULL};
    intptr_t kid = _spawnvp(_P_NOWAIT, "sleep", argv_sleep);
    if (kid != -1) return kid;
    kid = _spawnv(_P_NOWAIT, git_sleep, argv_sleep);
    if (kid != -1) return kid;
    return -1;
}

static int record_sleeper(intptr_t kid) {
    const char *sl = getenv("SLEEPERFILE");
    if (!sl || kid == -1) return 3;
    FILE *f = fopen(sl, "w");
    if (!f) return 3;
    fprintf(f, "%ld", (long)kid);
    fclose(f);
    return 0;
}

int main(int argc, char **argv) {
    logargv(argc, argv);
    probeenv();
    char buf[4096] = {0};
    for (int i = 1; i < argc; i++) {
        strncat(buf, argv[i], sizeof(buf) - strlen(buf) - 2);
        strncat(buf, " ", sizeof(buf) - strlen(buf) - 1);
    }
    int orphan = 0, hang = 0;
    if (strstr(buf, "probehang") && strstr(buf, "config --get")) orphan = 1;
    if (strstr(buf, "hanghere-orphan") && strstr(buf, "status --porcelain")) orphan = 1;
    if (!orphan) {
        if (strstr(buf, "status --porcelain") && strstr(buf, "hanghere-status")) hang = 1;
        if (strstr(buf, " pull ") && strstr(buf, "hanghere-pull")) hang = 1;
        if (strstr(buf, "clone") && strstr(buf, "hanghere")) hang = 1;
    }
    if (orphan) {
        intptr_t kid = spawn_sleeper();
        int rc = record_sleeper(kid);
        if (rc != 0) return rc;
        return 0;  /* parent exits FIRST; child holds the inherited stdout */
    }
    if (hang) {
        intptr_t kid = spawn_sleeper();
        int rc = record_sleeper(kid);
        if (rc != 0) return rc;
        Sleep(30000);
        return 0;
    }
    const char *realgit = getenv("REALGIT");
    if (!realgit) return 127;
    return _spawnv(_P_WAIT, realgit, (const char * const *)argv);
}
CEOF
  CC=""
  for cand in gcc cc clang /c/mingw64/bin/gcc.exe \
              "/c/ProgramData/chocolatey/lib/mingw/tools/install/mingw64/bin/gcc.exe"; do
    if command -v "$cand" >/dev/null 2>&1; then CC="$cand"; break; fi
  done
  if [ -z "$CC" ]; then
    ko "no C compiler found to build the Windows git fixture (fixture must execute)"
    exit 1
  fi
  if ! "$CC" -O1 -o "$FAKEBIN/git.exe" "$TMP/fake-git.c" 2>"$TMP/cc.err"; then
    ko "compiling the Windows git fixture failed: $(cat "$TMP/cc.err")"
    exit 1
  fi
  # Standalone smoke gate: the executable must RUN and DELEGATE before any
  # timeout assertion depends on it. (An incompatible binary surfaces here as
  # a loud failure instead of a silent "fixture never ran" downstream.)
  rm -f "$FAKELOG"
  if ! "$FAKEBIN/git.exe" --version > /dev/null 2>&1; then
    ko "compiled git fixture did not execute standalone (executable-compatibility error)"
    exit 1
  fi
  if ! grep -q -- "--version" "$FAKELOG" 2>/dev/null; then
    ko "compiled git fixture ran but wrote no invocation log"
    exit 1
  fi
  ok "win fixture smoke: executable runs, argv logged, real git delegated"
  rm -f "$FAKELOG"
  # NOTE: no extensionless shim in $FAKEBIN. Native CreateProcess resolves the
  # exact name "git" BEFORE appending .exe, so a POSIX sh script here shadows
  # git.exe with a non-PE file and every spawn dies with WinError 216. Bash-side
  # `have git` finds the real git later in PATH — nothing else needs a shim.
else
cat > "$FAKEBIN/git" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$FAKELOG_ENV"
if [ -n "\$PROBEENV" ]; then
  env | grep -E '^(GIT_TERMINAL_PROMPT|GCM_INTERACTIVE|GIT_ASKPASS|SSH_ASKPASS|GIT_SSH|GIT_SSH_COMMAND)=' > "$PROBEOUT_ENV" || true
fi
orphan() {
  # Parent exits FIRST; the child keeps the inherited stdout open, so a
  # capturing caller (a Bash command substitution) stays blocked until it dies.
  sleep 30 &
  echo \$! > "$SLEEPERFILE_ENV"
  exit 0
}
hang() {
  sleep 30 &
  echo \$! > "$SLEEPERFILE_ENV"
  wait
  exit 0
}
# Dispatch by SUBCOMMAND first, then by repo marker, so e.g. a status probe on
# the pull-hang repo passes through while its pull hangs.
case "\$*" in
  *probehang*"config --get"*)
    orphan ;;  # the SSH-config probe's parent exits FIRST; child holds stdout
  *hanghere-orphan*)
    case "\$*" in *"status --porcelain"*) orphan ;; esac
    ;;
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
exec "$REALGIT_ENV" "\$@"
EOF
chmod +x "$FAKEBIN/git"
fi

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
[ -s "$FAKELOG" ] && ok "A: fixture executed (invocation log written)" || ko "A: fixture never ran — missing invocation log"
[ "$OUTER_TIMED_OUT" = "0" ] && ok "A: sync completed inside the outer deadline" || ko "A: sync hung past the outer deadline"
[ "$BOUNDED_RC" -eq 0 ] && ok "A: timed-out clone still fails soft (exit 0)" || ko "A: exit $BOUNDED_RC"
grep -q "timed out" "$TMP/bounded.out" && ok "A: timeout warning surfaced" || ko "A: no timeout warning: $(cat "$TMP/bounded.out")"
[ -f "$CLONE-bounded/note.md" ] && ok "A: second healthy repo cloned in the same run" || ko "A: healthy repo missing"
assert_sleeper_dead
husk_found=0
for d in "$TMP/kbh"/.coop-knowledge-clone-*; do
  [ -e "$d" ] && { husk_found=1; break; }
done
[ "$husk_found" -eq 1 ] && ko "A: owned temp clone left behind" || ok "A: owned temp clone cleaned up"

# --- B. status-probe hang: unknown state, NEVER pulls ---------------------------
CFG6="$TMP/cfg6"
git clone -q "$REMOTE" "$TMP/kbh2/hanghere-status" 2>/dev/null
write_raw_config "$CFG6" '{"schema_version":1,"knowledge":{"enabled":true,"repos":[
  {"url":"'"$REMOTE"'","local_path":"'"$TMP/kbh2/hanghere-status"'"}]}}'
rm -f "$FAKELOG" "$SLEEPERFILE"
run_sync_bounded "$CFG6"
[ -s "$FAKELOG" ] && ok "B: fixture executed (invocation log written)" || ko "B: fixture never ran — missing invocation log"
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
[ -s "$FAKELOG" ] && ok "C: fixture executed (invocation log written)" || ko "C: fixture never ran — missing invocation log"
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
[ -s "$PROBEOUT" ] && ok "E: fixture executed (environment probe written)" || ko "E: fixture never ran — missing environment probe"
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

# ==============================================================================
# SSH transport respect (review finding 4): the runner must honor the EFFECTIVE
# SSH configuration — env transports untouched, core.sshCommand preserved
# (BatchMode only ever appended to a plain `ssh`), non-ssh custom transports
# skipped with an actionable warning.
# ==============================================================================

# --- G1. environment-configured SSH command is never replaced -------------------
rm -f "$PROBEOUT"
GIT_SSH_COMMAND='custom-ssh-wrapper -x' PROBEENV=1 PATH="$FAKEBIN:$PATH" \
  COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS=5 "$PY" "$ROOT/scripts/knowledge-git.py" \
  -- git -C "$TMP/kbh5/envprobe" status --porcelain >/dev/null 2>&1
grep -q "^GIT_SSH_COMMAND=custom-ssh-wrapper -x$" "$PROBEOUT" \
  && ok "G1: env GIT_SSH_COMMAND preserved untouched" \
  || ko "G1: env transport replaced: $(cat "$PROBEOUT" 2>/dev/null)"

# --- G2. git-configured core.sshCommand (plain ssh) gains BatchMode -------------
git -C "$TMP/kbh5/envprobe" config core.sshCommand "ssh -i /tmp/identity_file"
rm -f "$PROBEOUT"
PROBEENV=1 PATH="$FAKEBIN:$PATH" COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS=5 \
  "$PY" "$ROOT/scripts/knowledge-git.py" -- git -C "$TMP/kbh5/envprobe" status --porcelain \
  >/dev/null 2>&1
grep -q "^GIT_SSH_COMMAND=ssh -i /tmp/identity_file -o BatchMode=yes$" "$PROBEOUT" \
  && ok "G2: core.sshCommand (ssh) kept as the transport, made unattended" \
  || ko "G2: configured transport not honored: $(cat "$PROBEOUT" 2>/dev/null)"
git -C "$TMP/kbh5/envprobe" config --unset core.sshCommand

# --- G3. non-ssh custom transport: skipped with an actionable warning -----------
git -C "$TMP/kbh5/envprobe" config core.sshCommand "/tmp/corp-ssh-wrapper"
rm -f "$PROBEOUT" "$TMP/g3.err"
PROBEENV=1 PATH="$FAKEBIN:$PATH" COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS=5 \
  "$PY" "$ROOT/scripts/knowledge-git.py" -- git -C "$TMP/kbh5/envprobe" status --porcelain \
  >/dev/null 2>"$TMP/g3.err"
if grep -q "^GIT_SSH" "$PROBEOUT" 2>/dev/null; then
  ko "G3: non-ssh custom transport was replaced: $(cat "$PROBEOUT")"
else
  ok "G3: non-ssh custom transport preserved (no env override)"
fi
grep -q "custom SSH transport preserved" "$TMP/g3.err" \
  && ok "G3: actionable warning emitted" || ko "G3: no warning: $(cat "$TMP/g3.err")"
git -C "$TMP/kbh5/envprobe" config --unset core.sshCommand

# ==============================================================================
# Orphaned-descendant deadline (review finding 3): the child exits FIRST while
# its descendant keeps the inherited stdout open. The runner must bound the
# COMPLETE operation — the caller's capture must not block past the deadline —
# and kill the owned process group (identity captured at spawn) on expiry.
# (Process groups are POSIX semantics; Windows keeps the taskkill /T contract
# while the spawned root lives, so this section is POSIX-only.)
# ==============================================================================
if [ "$WIN" != "1" ]; then
  CFG10="$TMP/cfg10"
  git clone -q "$REMOTE" "$TMP/kbh6/hanghere-orphan" 2>/dev/null
  write_raw_config "$CFG10" '{"schema_version":1,"knowledge":{"enabled":true,"repos":[
    {"url":"'"$REMOTE"'","local_path":"'"$TMP/kbh6/hanghere-orphan"'"}]}}'

  # Direct runner, through the SAME $(...) capture pattern sync uses.
  rm -f "$FAKELOG" "$SLEEPERFILE"
  start=$SECONDS
  orphan_out="$(PATH="$FAKEBIN:$PATH" COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS=1 \
    "$PY" "$ROOT/scripts/knowledge-git.py" -- git -C "$TMP/kbh6/hanghere-orphan" \
    status --porcelain 2>"$TMP/orphan.err")"; orphan_rc=$?
  orphan_elapsed=$((SECONDS-start))
  [ -z "$orphan_out" ] && ok "H: captured status output is empty (orphan printed nothing)" || ko "H: unexpected output: $orphan_out"
[ "$orphan_rc" -eq 124 ] && ok "H: parent-exits-first still bounded (rc=124)" || ko "H: rc=$orphan_rc (want 124)"
  [ "$orphan_elapsed" -lt 10 ] \
    && ok "H: capture returned within the deadline (${orphan_elapsed}s, not the child's 30s)" \
    || ko "H: capture blocked ${orphan_elapsed}s past the deadline"
  grep -q "descendants" "$TMP/orphan.err" \
    && ok "H: actionable stderr message" || ko "H: no message: $(cat "$TMP/orphan.err")"
  assert_sleeper_dead

  # End-to-end through sync: unknown state, never pull, never blocks.
  rm -f "$FAKELOG" "$SLEEPERFILE"
  run_sync_bounded "$CFG10"
  [ "$OUTER_TIMED_OUT" = "0" ] && ok "H: sync completes inside the outer deadline" || ko "H: sync blocked by the orphaned descendant"
  grep -q "state unknown" "$TMP/bounded.out" \
    && ok "H: sync reports unknown state (empty output never read as clean)" \
    || ko "H: no unknown-state warning: $(cat "$TMP/bounded.out")"
  if grep "hanghere-orphan" "$FAKELOG" 2>/dev/null | grep -q "pull"; then
    ko "H: pull invoked despite the unknown state"
  else
    ok "H: failed status probe never pulls"
  fi
  assert_sleeper_dead
else
  echo "  – POSIX-only: orphaned-descendant process-group semantics not testable on Windows"
fi

# ==============================================================================
# Probe deadline (review finding 2b): the core.sshCommand probe is PART OF the
# operation. It runs under the SAME deadline and owned-process mechanism with
# the time remaining. A probe whose parent exits while its descendant holds
# stdout must fail the whole operation (rc 124) within the deadline, leave no
# surviving child, and must NOT silently proceed with a guessed default
# transport. (The Windows twin of this case lives in
# tests/fixtures/sync-knowledge-timeout.test.ps1 via the C fixture's
# probehang mode.)
# ==============================================================================
git init -q "$TMP/kbh7/probehang"
rm -f "$FAKELOG" "$SLEEPERFILE"
start=$SECONDS
PATH="$FAKEBIN:$PATH" COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS=1 \
  "$PY" "$ROOT/scripts/knowledge-git.py" -- git -C "$TMP/kbh7/probehang" \
  status --porcelain > "$TMP/probe-orphan.out" 2> "$TMP/probe-orphan.err"; prc=$?
pelapsed=$((SECONDS-start))
[ "$prc" -eq 124 ] && ok "I: probe orphan bounded (rc=124)" || ko "I: rc=$prc (want 124)"
[ "$pelapsed" -lt 10 ] \
  && ok "I: returned within the deadline (${pelapsed}s, not the probe's own 5s + the child's 30s)" \
  || ko "I: blocked ${pelapsed}s past the deadline"
grep -q "configuration probe exceeded" "$TMP/probe-orphan.err" \
  && ok "I: actionable probe-timeout message" || ko "I: no message: $(cat "$TMP/probe-orphan.err")"
if grep -q "status --porcelain" "$FAKELOG" 2>/dev/null; then
  ko "I: main command ran despite the timed-out probe"
else
  ok "I: operation aborted before the main command (no guessed transport)"
fi
assert_sleeper_dead

exit $fail

#!/usr/bin/env bash
#
# Drive this coop-agent checkout the way a person does: install it into a
# disposable HOME, then run the real CLI. Offline. No model API keys, and no
# package index. The last line of stdout is RESULT: PASS or RESULT: FAIL.
#
#   bash scripts/verify.sh            full run (launch, doctor, drive, cleanup)
#   bash scripts/verify.sh launch     install into a temp profile and keep it
#   bash scripts/verify.sh doctor     coop doctor against that profile
#   bash scripts/verify.sh drive      version, help, extensions, coop update
#   bash scripts/verify.sh cleanup    remove the temp profile; keep evidence
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
MODE="${1:-all}"
FAIL=0
DONE=0
CLEANED=0
KEEP_WORK=0
REAL_HOME="${HOME:-}"
WORK=""
CLONE=""
CLEAN=""
ORIGIN=""
SEED=""
EVIDENCE=""
SANDBOX_HOME=""
LOCAL_APP=""
ROAMING=""
STATE="$ROOT/.cache/verify/instance.env"

say() {
  printf '%s\n' "$*" | tee -a "$EVIDENCE/summary.txt"
}

fail() {
  FAIL=1
  say "FAIL: $*"
}

STEP_AT=0
step_begin() { STEP_AT=$FAIL; }
step_end() {
  local name="$1"
  local detail="${2:-}"
  if [[ "$FAIL" -eq "$STEP_AT" ]]; then
    if [[ -n "$detail" ]]; then
      say "$name: pass ($detail)"
    else
      say "$name: pass"
    fi
  else
    say "$name: fail"
  fi
}

on_exit() {
  if [[ "$DONE" -eq 1 ]]; then
    return 0
  fi
  DONE=1
  if [[ "$KEEP_WORK" -eq 0 ]]; then
    remove_work || true
  fi
  if [[ -n "$EVIDENCE" && -d "$EVIDENCE" ]]; then
    printf '%s\n' "RESULT: FAIL" | tee -a "$EVIDENCE/summary.txt"
  else
    printf '%s\n' "RESULT: FAIL"
  fi
}
trap on_exit EXIT

remove_work() {
  if [[ "$CLEANED" -eq 1 ]]; then
    return 0
  fi
  CLEANED=1
  if [[ -n "$WORK" && "$WORK" == /tmp/coop-verify-work.* && -d "$WORK" ]]; then
    rm -rf "$WORK"
  fi
  rm -f "$STATE"
}

home_fingerprint() {
  python3 - "$1" <<'PY'
import hashlib, os, sys
home = sys.argv[1]
h = hashlib.sha256()
def add(rel, deep):
    p = os.path.join(home, rel)
    if not os.path.lexists(p):
        h.update(("absent\t%s\n" % rel).encode())
        return
    st = os.lstat(p)
    h.update(("top\t%s\t%s\t%s\n" % (rel, st.st_size, st.st_mtime_ns)).encode())
    if not deep or not os.path.isdir(p) or os.path.islink(p):
        return
    for dirpath, dirs, files in os.walk(p):
        dirs.sort()
        for name in sorted(files):
            fp = os.path.join(dirpath, name)
            try:
                st = os.lstat(fp)
            except OSError:
                continue
            relp = os.path.relpath(fp, home)
            h.update(("%s\t%s\t%s\n" % (relp, st.st_size, st.st_mtime_ns)).encode())
for rel, deep in (
    (".coop", True),
    (".gitconfig", False),
    (".config/git", True),
    (".config/powershell", True),
    (".local/share/powershell", True),
    ("Desktop", False),
):
    add(rel, deep)
sys.stdout.write(h.hexdigest())
PY
}

git_sandbox() {
  env \
    HOME="$SANDBOX_HOME" \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL="$SANDBOX_HOME/empty.gitconfig" \
    GIT_TERMINAL_PROMPT=0 \
    git "$@"
}

write_state() {
  mkdir -p "$(dirname "$STATE")"
  {
    printf 'WORK\t%s\n' "$WORK"
    printf 'CLONE\t%s\n' "$CLONE"
    printf 'CLEAN\t%s\n' "$CLEAN"
    printf 'ORIGIN\t%s\n' "$ORIGIN"
    printf 'EVIDENCE\t%s\n' "$EVIDENCE"
    printf 'SANDBOX_HOME\t%s\n' "$SANDBOX_HOME"
    printf 'LOCAL_APP\t%s\n' "$LOCAL_APP"
    printf 'ROAMING\t%s\n' "$ROAMING"
  } > "$STATE"
}

load_state() {
  if [[ ! -f "$STATE" ]]; then
    printf '%s\n' "no verification instance — run: bash scripts/verify.sh launch" >&2
    return 1
  fi
  local key value
  while IFS=$'\t' read -r key value; do
    case "$key" in
      WORK) WORK=$value ;;
      CLONE) CLONE=$value ;;
      CLEAN) CLEAN=$value ;;
      ORIGIN) ORIGIN=$value ;;
      EVIDENCE) EVIDENCE=$value ;;
      SANDBOX_HOME) SANDBOX_HOME=$value ;;
      LOCAL_APP) LOCAL_APP=$value ;;
      ROAMING) ROAMING=$value ;;
    esac
  done < "$STATE"
  if [[ -z "$WORK" || -z "$CLONE" || -z "$EVIDENCE" || ! -d "$CLONE" ]]; then
    printf '%s\n' "verification instance is incomplete ($STATE)" >&2
    return 1
  fi
  mkdir -p "$EVIDENCE"
}

# name seconds path-mode coop-args...
# path-mode "install" hides npm and pipx so the installer cannot reach an index.
run_coop() {
  local name="$1"
  local seconds="$2"
  local path_mode="$3"
  shift 3
  local use_path="$PATH"
  local rc
  if [[ "$path_mode" == "install" ]]; then
    use_path="/usr/local/bin:/usr/bin:/bin"
  fi
  set +e
  (
    cd "$CLONE" || exit 1
    exec timeout "$seconds" env \
      -u OPENAI_API_KEY \
      -u ANTHROPIC_API_KEY \
      -u AZURE_OPENAI_API_KEY \
      -u OPENROUTER_API_KEY \
      -u CLOUDFLARE_API_KEY \
      -u CLOUDFLARE_ACCOUNT_ID \
      -u TYPESAFE_API_KEY \
      -u GH_TOKEN \
      -u GITHUB_TOKEN \
      -u COOP_SQLSC_TOKEN \
      -u NPM_TOKEN \
      -u NODE_AUTH_TOKEN \
      HOME="$SANDBOX_HOME" \
      USERPROFILE="$SANDBOX_HOME" \
      LOCALAPPDATA="$LOCAL_APP" \
      APPDATA="$ROAMING" \
      XDG_CONFIG_HOME="$SANDBOX_HOME/.config" \
      XDG_DATA_HOME="$SANDBOX_HOME/.local/share" \
      XDG_CACHE_HOME="$SANDBOX_HOME/.cache" \
      PYTHONUSERBASE="$SANDBOX_HOME/pyuser" \
      PIP_NO_INDEX=1 \
      PIP_DISABLE_PIP_VERSION_CHECK=1 \
      npm_config_offline=true \
      COOP_SKIP_AZ=1 \
      COOP_NO_ONBOARD=1 \
      COOP_NO_MODEL_LOGIN=1 \
      COOP_SKIP_UPDATE_CHECK=1 \
      COOP_PIPX_BIN="$SANDBOX_HOME/no-such-pipx" \
      GIT_TERMINAL_PROMPT=0 \
      GIT_CONFIG_NOSYSTEM=1 \
      GIT_CONFIG_GLOBAL="$SANDBOX_HOME/empty.gitconfig" \
      NO_COLOR=1 \
      PATH="$use_path" \
      "$CLONE/bin/coop" "$@"
  ) >"$EVIDENCE/$name.out" 2>"$EVIDENCE/$name.err"
  rc=$?
  set -e
  printf '%s\n' "$rc" >"$EVIDENCE/$name.rc"
}

assert_rc() {
  local name="$1"
  local want="$2"
  local got
  got=$(tr -d '[:space:]' < "$EVIDENCE/$name.rc")
  if [[ "$got" != "$want" ]]; then
    fail "$name: exit $got, expected $want"
    return 0
  fi
}

# Needle in stdout or stderr.
assert_text() {
  local name="$1"
  local needle="$2"
  if grep -F "$needle" "$EVIDENCE/$name.out" >/dev/null 2>&1; then
    return 0
  fi
  if grep -F "$needle" "$EVIDENCE/$name.err" >/dev/null 2>&1; then
    return 0
  fi
  fail "$name: output does not contain: $needle"
}

assert_absent() {
  local name="$1"
  local needle="$2"
  if grep -F "$needle" "$EVIDENCE/$name.out" >/dev/null 2>&1; then
    fail "$name: output contains: $needle"
  fi
  if grep -F "$needle" "$EVIDENCE/$name.err" >/dev/null 2>&1; then
    fail "$name: output contains: $needle"
  fi
}

at_tag() {
  git_sandbox -C "$CLONE" reset -q --hard "$1"
}

build_fixture() {
  ORIGIN="$WORK/origin.git"
  SEED="$WORK/seed"
  CLONE="$WORK/clone"
  CLEAN="$WORK/install-checkout"
  : > "$SANDBOX_HOME/empty.gitconfig"
  git_sandbox init -q --bare "$ORIGIN"
  git_sandbox -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
  git_sandbox init -q "$SEED"
  git_sandbox -C "$SEED" symbolic-ref HEAD refs/heads/main
  git_sandbox -C "$SEED" config user.name coop-verify
  git_sandbox -C "$SEED" config user.email coop-verify@example.com
  git_sandbox -C "$SEED" config commit.gpgsign false

  printf '%s\n' '0.42.0' > "$SEED/VERSION"
  printf '%s\n' 'v0.42.0' > "$SEED/README"
  git_sandbox -C "$SEED" add VERSION README
  git_sandbox -C "$SEED" commit -q -m 'v0.42.0'
  git_sandbox -C "$SEED" tag -a v0.42.0 -m v0.42.0

  printf '%s\n' '0.42.0' > "$SEED/VERSION"
  printf '%s\n' 'stray' > "$SEED/README"
  git_sandbox -C "$SEED" add VERSION README
  git_sandbox -C "$SEED" commit -q -m 'stray VERSION stays 0.42.0'
  git_sandbox -C "$SEED" tag v1.0.19

  printf '%s\n' '0.42.1' > "$SEED/VERSION"
  printf '%s\n' 'v0.42.1' > "$SEED/README"
  git_sandbox -C "$SEED" add VERSION README
  git_sandbox -C "$SEED" commit -q -m 'v0.42.1'
  git_sandbox -C "$SEED" tag -a v0.42.1 -m v0.42.1

  git_sandbox -C "$SEED" rm -q VERSION
  printf '%s\n' 'no VERSION file' > "$SEED/README"
  git_sandbox -C "$SEED" add README
  git_sandbox -C "$SEED" commit -q -m 'v2.0.0 has no VERSION'
  git_sandbox -C "$SEED" tag -a v2.0.0 -m v2.0.0

  git_sandbox -C "$SEED" push -q "$ORIGIN" main --tags
  git_sandbox clone -q "$ORIGIN" "$CLONE"
  tar -C "$ROOT" --exclude .git --exclude .cache -cf - . | tar -C "$CLONE" -xf -
  chmod +x "$CLONE/bin/coop"
  at_tag v0.42.0
  git_sandbox -C "$ORIGIN" tag -l > "$EVIDENCE/tags.txt"
  git_sandbox -C "$ORIGIN" show 'v1.0.19:VERSION' > "$EVIDENCE/version-v1.0.19.txt"
  git_sandbox -C "$ORIGIN" show 'v0.42.1:VERSION' > "$EVIDENCE/version-v0.42.1.txt"
  if git_sandbox -C "$ORIGIN" show 'v2.0.0:VERSION' >"$EVIDENCE/version-v2.0.0.txt" 2>"$EVIDENCE/version-v2.0.0.err"; then
    fail "v2.0.0 has a VERSION file; the skip case needs it absent"
  fi
}

prepare_dirs() {
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  WORK="$(mktemp -d /tmp/coop-verify-work.XXXXXX)"
  EVIDENCE="$ROOT/.cache/verify/evidence/$stamp"
  SANDBOX_HOME="$WORK/home"
  LOCAL_APP="$SANDBOX_HOME/AppData/Local"
  ROAMING="$SANDBOX_HOME/AppData/Roaming"
  mkdir -p "$EVIDENCE" "$SANDBOX_HOME/.config" "$LOCAL_APP" "$ROAMING" "$SANDBOX_HOME/pyuser"
  : > "$EVIDENCE/summary.txt"
  say "evidence: $EVIDENCE"
  say "work: $WORK"
}

check_launcher() {
  local launcher rc py
  step_begin
  launcher="$LOCAL_APP/coop/bin/coop.cmd"
  if [[ ! -f "$launcher" ]]; then
    fail "installer did not write $launcher"
    step_end install
    return 0
  fi
  cp "$launcher" "$EVIDENCE/launcher.cmd"
  set +e
  LAUNCHER="$launcher" CLONE="$CLONE" EVIDENCE="$EVIDENCE" python3 - <<'PY'
import os, pathlib, sys
text = pathlib.Path(os.environ["LAUNCHER"]).read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n").decode("utf-8", "replace")
pathlib.Path(os.environ["EVIDENCE"], "launcher.txt").write_text(text, encoding="utf-8")
call = 'call "' + os.environ["CLONE"] + '/bin/coop.cmd" %*'
if not text.startswith("@echo off\n") or call not in text:
    sys.stderr.write(text)
    sys.exit(1)
PY
  py=$?
  set -e
  if [[ "$py" -ne 0 ]]; then
    fail "launcher is not the installer's coop.cmd shim"
  fi
  if ! grep -F "linked " "$EVIDENCE/install.err" >/dev/null 2>&1 && ! grep -F "already linked" "$EVIDENCE/install.err" >/dev/null 2>&1; then
    fail "install output did not report the coop.cmd link"
  fi
  rc=$(tr -d '[:space:]' < "$EVIDENCE/install.rc")
  if [[ "$rc" -eq 124 ]]; then
    fail "coop install timed out"
  fi
  step_end install "launcher linked; coop install exit $rc; package indexes disabled"
}

drive_version() {
  step_begin
  at_tag v0.42.0
  run_coop version 60 full version
  assert_rc version 0
  assert_text version "coop 0.42.0 (v0.42.0)"
  if command -v pi >/dev/null 2>&1; then
    assert_text version "pi"
  else
    assert_text version "pi   (not installed)"
  fi
  step_end version
}

drive_help() {
  step_begin
  run_coop help 60 full help
  assert_rc help 0
  assert_text help "coop doctor"
  assert_text help "coop update"
  assert_text help "coop install"
  assert_text help "coop version"
  assert_text help "coop desktop"
  step_end help
}

drive_doctor() {
  local rc
  step_begin
  at_tag v0.42.0
  run_coop doctor 180 full doctor
  rc=$(tr -d '[:space:]' < "$EVIDENCE/doctor.rc")
  if [[ "$rc" -eq 124 ]]; then
    fail "coop doctor timed out"
    step_end doctor
    return 0
  fi
  assert_text doctor "coop doctor"
  assert_text doctor "v0.42.0"
  assert_text doctor "brand splash present"
  assert_text doctor "behind release v0.42.1"
  assert_absent doctor "behind release v1.0.19"
  assert_absent doctor "behind release v2.0.0"
  step_end doctor "exit $rc"
}

drive_extensions() {
  local pi_note py
  step_begin
  run_coop launch-spec 60 full launch-spec --json
  assert_rc launch-spec 0
  set +e
  pi_note=$(EVIDENCE="$EVIDENCE" CLONE="$CLONE" python3 - <<'PY'
import json, os, pathlib, sys
evidence = pathlib.Path(os.environ["EVIDENCE"])
raw = (evidence / "launch-spec.out").read_text(encoding="utf-8", errors="replace")
line = ""
for candidate in raw.splitlines():
    if candidate.startswith("{"):
        line = candidate
        break
if not line:
    sys.stdout.write("launch-spec stdout has no JSON object")
    sys.exit(1)
spec = json.loads(line)
args = spec.get("args") or []
exts = []
for i, arg in enumerate(args):
    if arg == "-e" and i + 1 < len(args):
        exts.append(args[i + 1])
need = ["coop-powerline", "coop-tools", "coop-guardrails", "coop-profile"]
pi = os.environ.get("COOP_VERIFY_PI", "")
if pi[:1].isdigit() and int(pi.split(".", 1)[0]) >= 1:
    need += ["coop-codemode", "coop-router"]
missing = []
for name in need:
    match = [p for p in exts if p.replace("\\", "/").rstrip("/").endswith("extensions/" + name)]
    if len(match) != 1:
        missing.append(name + " not in -e list")
        continue
    entry = pathlib.Path(match[0]) / "index.ts"
    if not entry.is_file():
        missing.append(name + " index.ts missing")
env = spec.get("env") or {}
for key in ("COOP_VIBES_DIR", "COOP_SPLASH_FILE"):
    path = env.get(key, "")
    if not path or not os.path.exists(path):
        missing.append(key + " missing")
if spec.get("bin") != "pi":
    missing.append("bin is not pi")
if missing:
    sys.stdout.write("; ".join(missing))
    sys.exit(1)
note = "pi " + pi if pi else "pi not installed"
sys.stdout.write(note + "; loaded " + ", ".join(need))
PY
  )
  py=$?
  set -e
  if [[ "$py" -ne 0 ]]; then
    fail "extensions: ${pi_note:-launch-spec check failed}"
  fi
  step_end extensions "$pi_note"
}

drive_update() {
  local before after from_stray landed want rc
  step_begin
  at_tag v0.42.0
  before=$(git_sandbox -C "$CLONE" rev-parse HEAD)
  run_coop update-from-0420 90 full update --check
  assert_rc update-from-0420 0
  assert_text update-from-0420 "would move to release v0.42.1"
  assert_absent update-from-0420 "would move to release v1.0.19"
  assert_absent update-from-0420 "would move to release v2.0.0"
  after=$(git_sandbox -C "$CLONE" rev-parse HEAD)
  if [[ "$before" != "$after" ]]; then
    fail "coop update --check moved HEAD"
  fi

  at_tag v1.0.19
  run_coop update-from-1019 90 full update --check
  assert_rc update-from-1019 0
  assert_text update-from-1019 "would move to release v0.42.1"
  assert_absent update-from-1019 "would move to release v1.0.19"
  assert_absent update-from-1019 "would move to release v2.0.0"
  from_stray=$(git_sandbox -C "$CLONE" rev-parse HEAD)
  if [[ "$from_stray" != "$(git_sandbox -C "$CLONE" rev-parse 'v1.0.19^{commit}')" ]]; then
    fail "checkout left the v1.0.19 commit during --check"
  fi
  step_end update "v0.42.0 and v1.0.19 would move to v0.42.1; v1.0.19 VERSION 0.42.0 skipped; v2.0.0 has no VERSION and is skipped"

  step_begin
  rm -rf "$CLEAN"
  git_sandbox clone -q "$ORIGIN" "$CLEAN"
  git_sandbox -C "$CLEAN" reset -q --hard v0.42.0
  EVIDENCE="$EVIDENCE" ROOT="$ROOT" WORK="$WORK" python3 - <<'PY'
import os, pathlib
root = pathlib.Path(os.environ["ROOT"])
line = ""
for raw in (root / "docs/install-windows.md").read_text(encoding="utf-8").splitlines():
    if "git tag --merged" in raw and "git checkout" in raw:
        line = raw.strip()
        break
if not line:
    raise SystemExit("docs/install-windows.md checkout line is missing")
dest = pathlib.Path(os.environ["WORK"]) / "install-checkout.ps1"
dest.write_text("Set-Location -LiteralPath $env:COOP_VERIFY_CHECKOUT\n" + line + "\n", encoding="utf-8")
(pathlib.Path(os.environ["EVIDENCE"]) / "install-checkout.ps1").write_text(dest.read_text(encoding="utf-8"), encoding="utf-8")
PY
  set +e
  env \
    HOME="$SANDBOX_HOME" \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL="$SANDBOX_HOME/empty.gitconfig" \
    GIT_TERMINAL_PROMPT=0 \
    COOP_VERIFY_CHECKOUT="$CLEAN" \
    pwsh -NoLogo -NoProfile -File "$WORK/install-checkout.ps1" \
    >"$EVIDENCE/install-checkout.out" 2>"$EVIDENCE/install-checkout.err"
  rc=$?
  set -e
  printf '%s\n' "$rc" >"$EVIDENCE/install-checkout.rc"
  if [[ "$rc" -ne 0 ]]; then
    fail "install checkout line exit $rc"
  fi
  want=$(git_sandbox -C "$CLEAN" rev-parse 'v0.42.1^{commit}')
  landed=$(git_sandbox -C "$CLEAN" rev-parse HEAD)
  printf '%s\n' "$landed" >"$EVIDENCE/install-checkout-head.txt"
  if [[ "$landed" != "$want" ]]; then
    fail "install checkout landed on $(git_sandbox -C "$CLEAN" describe --tags --exact-match HEAD 2>/dev/null || printf '%s' "$landed"), expected v0.42.1"
  fi
  step_end install-checkout "landed on v0.42.1"
}

pi_major_env() {
  local raw
  COOP_VERIFY_PI=""
  if ! command -v pi >/dev/null 2>&1; then
    export COOP_VERIFY_PI=""
    return 0
  fi
  raw=$(pi --version 2>/dev/null | head -n 1 || true)
  COOP_VERIFY_PI=$(printf '%s\n' "$raw" | sed -n 's/.*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1)
  export COOP_VERIFY_PI
}

finish() {
  local result rc home_after
  if [[ -n "${HOME_BEFORE:-}" && -n "$REAL_HOME" ]]; then
    home_after="$(home_fingerprint "$REAL_HOME")"
    if [[ "$HOME_BEFORE" != "$home_after" ]]; then
      fail "real HOME changed ($REAL_HOME)"
      say "home: changed"
    else
      say "home: unchanged"
    fi
  fi
  if [[ -n "${REPO_HEAD:-}" ]]; then
    if [[ "$(git -C "$ROOT" rev-parse HEAD)" != "$REPO_HEAD" ]]; then
      fail "this checkout's HEAD changed"
    fi
    if [[ "$(git -C "$ROOT" status --porcelain)" != "$REPO_STATUS" ]]; then
      fail "this checkout's worktree changed"
    fi
  fi
  if [[ "$KEEP_WORK" -eq 0 ]]; then
    remove_work
    if [[ -n "$WORK" && -d "$WORK" ]]; then
      fail "work directory still exists: $WORK"
      say "work_removed: no"
    else
      say "work_removed: yes"
    fi
  else
    say "work_removed: no"
  fi
  if [[ -z "$EVIDENCE" || ! -f "$EVIDENCE/summary.txt" ]]; then
    printf '%s\n' "RESULT: FAIL"
    DONE=1
    exit 1
  fi
  if [[ "$FAIL" -eq 0 ]]; then
    result="PASS"
    rc=0
  else
    result="FAIL"
    rc=1
  fi
  say "RESULT: $result"
  DONE=1
  exit "$rc"
}

usage() {
  cat <<'EOF'
usage: bash scripts/verify.sh [all|launch|doctor|drive|cleanup|help]

  all       install into a temp profile, drive the CLI, clean up (default)
  launch    install and keep the temp profile
  doctor    coop doctor against the launched profile
  drive     version, help, launch-spec, coop update --check
  cleanup   delete the temp profile and keep the evidence directory
EOF
}

case "$MODE" in
  all|launch|doctor|drive|cleanup|help) ;;
  *)
    usage >&2
    DONE=1
    exit 2
    ;;
esac

if [[ "$MODE" == "help" ]]; then
  usage
  DONE=1
  exit 0
fi

if [[ -z "$REAL_HOME" || ! -d "$REAL_HOME" ]]; then
  printf '%s\n' "HOME is not a directory; refusing to run" >&2
  exit 1
fi

for tool in git python3 pwsh tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf '%s\n' "missing $tool" >&2
    exit 1
  fi
done

REPO_HEAD="$(git -C "$ROOT" rev-parse HEAD)"
REPO_STATUS="$(git -C "$ROOT" status --porcelain)"
HOME_BEFORE="$(home_fingerprint "$REAL_HOME")"

if [[ "$MODE" == "cleanup" ]]; then
  load_state || exit 1
  say "evidence: $EVIDENCE"
  finish
fi

if [[ "$MODE" == "doctor" || "$MODE" == "drive" ]]; then
  load_state || exit 1
  KEEP_WORK=1
else
  if [[ -f "$STATE" ]]; then
    load_state || true
    remove_work || true
    CLEANED=0
    WORK=""
  fi
  prepare_dirs
  build_fixture
  write_state
  run_coop install 240 install install --no-fabric --no-prereqs --yes
  check_launcher
  if [[ "$MODE" == "launch" ]]; then
    KEEP_WORK=1
    write_state
    finish
  fi
fi

pi_major_env
if [[ "$MODE" == "doctor" ]]; then
  drive_doctor
  finish
fi

drive_version
drive_help
drive_doctor
drive_extensions
drive_update
say "desktop: not-run (coop desktop installs Electron and opens a window; this run has no display)"

if [[ "$MODE" == "drive" ]]; then
  KEEP_WORK=1
fi
finish

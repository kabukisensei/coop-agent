#!/usr/bin/env bash
# Release transaction regression: VERSION, release manifest, extension package
# versions, commit, and tag must all describe the same release, and the tag may
# only reach origin together with main (#105). Runs entirely in disposable git
# repositories; every "origin" is a local bare repo, so nothing leaves this machine.
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Hermetic git: no user or system config, a fixed identity.
mkdir -p "$TMP/home"
HOME="$TMP/home"
GIT_CONFIG_NOSYSTEM=1
GIT_AUTHOR_NAME='Coop Release Test' GIT_AUTHOR_EMAIL='coop-release-test@example.invalid'
GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export HOME GIT_CONFIG_NOSYSTEM GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL

fail=0
ok() { printf '  ✓ %s\n' "$1"; }
ko() { printf '  ✗ %s\n' "$1"; fail=1; }

# A coop checkout on main with a bare origin at <dir>.git, main == origin/main.
make_fixture() { # <dir>
  local d="$1" f
  mkdir -p "$d/bin" "$d/lib" "$d/config" "$d/extensions"
  cp "$ROOT/bin/coop" "$d/bin/coop"
  cp "$ROOT/lib/common.sh" "$d/lib/common.sh"
  cp "$ROOT/lib/_yaml.py" "$d/lib/_yaml.py"
  cp "$ROOT/VERSION" "$ROOT/CHANGELOG.md" "$d/"
  cp "$ROOT/config/release-manifest.json" "$d/config/release-manifest.json"
  for f in "$ROOT"/extensions/*/package.json; do
    mkdir -p "$d/extensions/$(basename "$(dirname "$f")")"
    cp "$f" "$d/extensions/$(basename "$(dirname "$f")")/package.json"
  done
  git -C "$d" init -q
  git -C "$d" symbolic-ref HEAD refs/heads/main
  git -C "$d" add .
  git -C "$d" commit -q -m fixture
  git init -q --bare "$d.git"
  git -C "$d.git" symbolic-ref HEAD refs/heads/main
  git -C "$d" remote add origin "$d.git"
  git -C "$d" push -q -u origin main
}

release() { # <dir> [args...]: run the fixture's own bin/coop release
  local d="$1"; shift
  bash "$d/bin/coop" release "$@" 2>&1
}

cur="$(tr -d '[:space:]' < "$ROOT/VERSION")"
IFS=. read -r ma mi pa <<EOF
$cur
EOF
next="$ma.$mi.$((pa + 1))"

echo "→ coop release keeps every version authority in one transaction"
fixture="$TMP/happy"
make_fixture "$fixture"
out="$(release "$fixture" patch --yes --no-push --no-check)"
rc=$?
[ "$rc" -eq 0 ] && ok "fixture release exits zero" || ko "fixture release failed (rc=$rc): $out"

python_bin="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
if "$python_bin" - "$fixture" "$next" <<'PY'
import json, pathlib, sys
root, expected = pathlib.Path(sys.argv[1]), sys.argv[2]
assert root.joinpath("VERSION").read_text().strip() == expected
assert json.loads(root.joinpath("config/release-manifest.json").read_text())["coop_version"] == expected
for package in root.glob("extensions/*/package.json"):
    assert json.loads(package.read_text())["version"] == expected, package
PY
then
  ok "VERSION, release manifest, and extension manifests share $next"
else
  ko "released version authorities diverged"
fi
git -C "$fixture" rev-parse "v$next" >/dev/null 2>&1 \
  && ok "release tag v$next exists" || ko "release tag v$next missing"
[ -z "$(git -C "$fixture" status --porcelain)" ] \
  && ok "release commit includes every generated change" || ko "release left uncommitted files"
[ -z "$(git -C "$fixture.git" tag -l)" ] \
  && ok "--no-push leaves origin untouched" || ko "--no-push pushed a tag"

echo "→ coop release rejects a pre-existing manifest/VERSION mismatch"
bad="$TMP/mismatch"
make_fixture "$bad"
"$python_bin" - "$bad/config/release-manifest.json" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1]); data = json.loads(p.read_text())
data["coop_version"] = "0.0.0"
p.write_text(json.dumps(data, indent=2) + "\n")
PY
git -C "$bad" add config/release-manifest.json
git -C "$bad" commit -q -m mismatch
git -C "$bad" push -q origin main
bad_out="$(release "$bad" patch --yes --no-push --no-check)"
bad_rc=$?
[ "$bad_rc" -ne 0 ] && ok "mismatched release is rejected" || ko "mismatched release unexpectedly succeeded"
case "$bad_out" in
  *"does not match VERSION"*) ok "rejection identifies the inconsistent manifest" ;;
  *) ko "mismatch rejection lacks actionable explanation: $bad_out" ;;
esac

echo "→ coop release pushes main and the tag together (#105)"
pushed="$TMP/pushed"
make_fixture "$pushed"
out="$(release "$pushed" patch --yes --no-check)"
rc=$?
[ "$rc" -eq 0 ] && ok "pushed release exits zero" || ko "pushed release failed (rc=$rc): $out"
[ "$(git -C "$pushed.git" rev-parse -q --verify refs/heads/main)" = "$(git -C "$pushed" rev-parse HEAD)" ] \
  && ok "origin main is the release commit" || ko "origin main is not the release commit: $out"
git -C "$pushed.git" merge-base --is-ancestor "v$next" refs/heads/main 2>/dev/null \
  && ok "origin tag v$next is on origin main" || ko "origin tag v$next missing or off main: $out"

echo "→ a rejected branch push pushes no tag (#105)"
rejected="$TMP/rejected"
make_fixture "$rejected"
before="$(git -C "$rejected.git" rev-parse refs/heads/main)"
# origin refuses every update to main, as a protected branch or a lost race would.
cat > "$rejected.git/hooks/update" <<'EOF'
#!/bin/sh
[ "$1" = refs/heads/main ] && { echo "main is protected" >&2; exit 1; }
exit 0
EOF
chmod +x "$rejected.git/hooks/update"
out="$(release "$rejected" patch --yes --no-check)"
rc=$?
[ "$rc" -ne 0 ] && ok "rejected push fails the release" || ko "rejected push still exits zero: $out"
[ -z "$(git -C "$rejected.git" tag -l)" ] \
  && ok "origin has no tag after the rejected branch push" || ko "tag reached origin without main: $(git -C "$rejected.git" tag -l)"
[ "$(git -C "$rejected.git" rev-parse refs/heads/main)" = "$before" ] \
  && ok "origin main is unchanged" || ko "origin main moved despite the rejection"
case "$out" in
  *"git push --atomic origin main v$next"*) ok "failure names the atomic retry" ;;
  *) ko "failure lacks the retry command: $out" ;;
esac

# Each refusal must happen before the release changes anything, here or on origin.
refused() { # <dir> <label> <expected message fragment>
  local d="$1" label="$2" want="$3" head0 out rc
  head0="$(git -C "$d" rev-parse HEAD)"
  out="$(release "$d" patch --yes --no-check)"
  rc=$?
  [ "$rc" -ne 0 ] && ok "$label: refused" || ko "$label: release was not refused: $out"
  case "$out" in
    *"$want"*) ok "$label: names the fix" ;;
    *) ko "$label: message lacks '$want': $out" ;;
  esac
  if [ "$(git -C "$d" rev-parse HEAD)" = "$head0" ] && [ -z "$(git -C "$d" status --porcelain)" ] \
     && ! git -C "$d" rev-parse -q --verify "refs/tags/v$next" >/dev/null \
     && [ "$(tr -d '[:space:]' < "$d/VERSION")" = "$cur" ] && [ -z "$(git -C "$d.git" tag -l)" ]; then
    ok "$label: nothing changed locally or on origin"
  else
    ko "$label: the refused release still changed something"
  fi
}

echo "→ coop release refuses a detached HEAD, another branch, or main != origin/main (#105)"
detached="$TMP/detached"
make_fixture "$detached"
git -C "$detached" checkout -q --detach
refused "$detached" "detached HEAD" "HEAD is detached"

branch="$TMP/branch"
make_fixture "$branch"
git -C "$branch" checkout -q -b topic
refused "$branch" "branch topic" "on branch 'topic'"

behind="$TMP/behind"
make_fixture "$behind"
# Someone else merges to origin/main after this clone last fetched.
git clone -q "$behind.git" "$TMP/behind-other"
git -C "$TMP/behind-other" commit -q --allow-empty -m "merged elsewhere"
git -C "$TMP/behind-other" push -q origin main
refused "$behind" "main behind origin/main" "0 ahead, 1 behind"

ahead="$TMP/ahead"
make_fixture "$ahead"
git -C "$ahead" commit -q --allow-empty -m "local only"
refused "$ahead" "main ahead of origin/main" "1 ahead, 0 behind"

exit "$fail"

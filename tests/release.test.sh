#!/usr/bin/env bash
# Release transaction regression: VERSION, release manifest, extension package
# versions, commit, and tag must all describe the same release. Runs entirely in
# a disposable git repository and never pushes.
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
ok() { printf '  ✓ %s\n' "$1"; }
ko() { printf '  ✗ %s\n' "$1"; fail=1; }

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
  git -C "$d" config user.name 'Coop Release Test'
  git -C "$d" config user.email 'coop-release-test@example.invalid'
  git -C "$d" add .
  git -C "$d" commit -q -m fixture
}

echo "→ coop release keeps every version authority in one transaction"
fixture="$TMP/happy"
make_fixture "$fixture"
cur="$(tr -d '[:space:]' < "$fixture/VERSION")"
IFS=. read -r ma mi pa <<EOF
$cur
EOF
next="$ma.$mi.$((pa + 1))"

out="$(HOME="$TMP/home" bash "$fixture/bin/coop" release patch --yes --no-push --no-check 2>&1)"
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

echo "→ coop release rejects a pre-existing manifest/VERSION mismatch"
bad="$TMP/mismatch"
make_fixture "$bad"
python_bin="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
"$python_bin" - "$bad/config/release-manifest.json" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1]); data = json.loads(p.read_text())
data["coop_version"] = "0.0.0"
p.write_text(json.dumps(data, indent=2) + "\n")
PY
git -C "$bad" add config/release-manifest.json
git -C "$bad" commit -q -m mismatch
bad_out="$(HOME="$TMP/home" bash "$bad/bin/coop" release patch --yes --no-push --no-check 2>&1)"
bad_rc=$?
[ "$bad_rc" -ne 0 ] && ok "mismatched release is rejected" || ko "mismatched release unexpectedly succeeded"
case "$bad_out" in
  *"does not match VERSION"*) ok "rejection identifies the inconsistent manifest" ;;
  *) ko "mismatch rejection lacks actionable explanation: $bad_out" ;;
esac

exit "$fail"

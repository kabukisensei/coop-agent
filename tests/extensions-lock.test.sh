#!/usr/bin/env bash
# config/extensions-lock.json pins the isolated extension tree's TRANSITIVE
# dependencies (issue #152). The lock must agree with config/release-manifest.json
# (a pin bump without `node lib/extlock.js generate` fails here), and `coop sync`
# applies it only when it can hold: manifest Pi installed and a tree whose
# package.json declares exactly the lock's root dependencies. Structural half
# (lock JSON vs manifest, `extlock.js matches`); the helper behaviour lives in
# tests/fixtures/extensions-lock.test.ps1. Offline; the lock is read, never resolved.
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
PY="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }
LOCK="$ROOT/config/extensions-lock.json"
MANIFEST="$ROOT/config/release-manifest.json"

[ -f "$LOCK" ] && ok "config/extensions-lock.json ships with the release" || ko "config/extensions-lock.json is missing"

# 1. The committed lock agrees with the manifest: every extension at its pin,
#    nothing extra, and pi-ai / pi-tui / the agent peer at the manifest's Pi.
if node "$ROOT/lib/extlock.js" check "$MANIFEST" "$LOCK" >/dev/null 2>&1; then
  ok "lock root, extension versions and shared Pi libraries match the manifest"
else
  ko "lock drifted from the manifest: $(node "$ROOT/lib/extlock.js" check "$MANIFEST" "$LOCK" 2>&1 | head -3 | tr '\n' ' ')"
fi

# 1b. Packages that ship their binary and declare `gypfile: false` carry that
#     flag in their lock entry (lib/extlock.js generate); npm builds nodes from
#     the lock entries, and without the flag `npm ci` ran `node-gyp rebuild` for
#     the nested better-sqlite3 and failed on the Windows VM (2026-10-01).
if "$PY" - "$LOCK" <<'PYGYP'
import json, sys
p = json.load(open(sys.argv[1]))["packages"]
nested = [k for k, v in p.items() if k.endswith("/node_modules/better-sqlite3") and v.get("version", "").startswith("13.")]
sys.exit(0 if nested and all(p[k].get("gypfile") is False for k in nested) else 1)
PYGYP
then ok "lock entries for better-sqlite3 13 carry gypfile: false (no node-gyp rebuild from the lock)"
else ko "the nested better-sqlite3 13 lock entry lacks gypfile: false (regenerate with node lib/extlock.js generate)"; fi

# 2. A bumped pin without a regenerated lock fails the check (this is the gate).
"$PY" - "$MANIFEST" "$TMP/bumped.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
name = sorted(m["extensions"])[0]
m["extensions"][name] = "99.99.99"
json.dump(m, open(sys.argv[2], "w"))
PY
if node "$ROOT/lib/extlock.js" check "$TMP/bumped.json" "$LOCK" >/dev/null 2>&1; then
  ko "a manifest pin bump without a regenerated lock passed the check"
else
  ok "a manifest pin bump without a regenerated lock fails the check"
fi
"$PY" - "$MANIFEST" "$TMP/newpi.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
m["pi"]["version"] = "0.0.1"
json.dump(m, open(sys.argv[2], "w"))
PY
if node "$ROOT/lib/extlock.js" check "$TMP/newpi.json" "$LOCK" >/dev/null 2>&1; then
  ko "a Pi bump without a regenerated lock passed the check"
else
  ok "a Pi bump without a regenerated lock fails the check (the lock resolves pi-ai/pi-tui to the manifest's Pi)"
fi

# 3. `matches`: the tree's package.json must declare exactly the lock's root.
pi_ver="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["pi"]["version"])' "$MANIFEST")"
mk_tree() { # <dir> <extra-deps-json-fragment> <override-version>
  mkdir -p "$1/npm"
  "$PY" - "$MANIFEST" "$1/npm/package.json" "$2" "$3" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
deps = dict(m["extensions"]); deps.update(json.loads(sys.argv[3]))
v = sys.argv[4]
json.dump({"name": "pi-extensions", "private": True, "dependencies": deps,
           "overrides": {"@earendil-works/pi-ai": v, "@earendil-works/pi-tui": v, "@earendil-works/pi-coding-agent": v}},
          open(sys.argv[2], "w"), indent=2)
PY
}
mk_tree "$TMP/exact" '{}' "$pi_ver"
node "$ROOT/lib/extlock.js" matches "$TMP/exact" "$LOCK" >/dev/null 2>&1 \
  && ok "a tree declaring exactly the manifest pins can take the lock" || ko "an exact tree was refused: $(node "$ROOT/lib/extlock.js" matches "$TMP/exact" "$LOCK" 2>&1 | head -2 | tr '\n' ' ')"
mk_tree "$TMP/extra" '{"some-personal-extension":"1.0.0"}' "$pi_ver"
node "$ROOT/lib/extlock.js" matches "$TMP/extra" "$LOCK" >/dev/null 2>&1 \
  && ko "a tree with an extra extension took the lock (npm ci would refuse it)" || ok "a tree with an extra extension falls back to a live resolution"
mk_tree "$TMP/otherpi" '{}' "0.0.1"
node "$ROOT/lib/extlock.js" matches "$TMP/otherpi" "$LOCK" >/dev/null 2>&1 \
  && ko "a tree overriding pi-ai to another version took the lock" || ok "a tree pinned to another Pi falls back to a live resolution"

# 4. The convergence helper consults the lock before its live npm install, and
#    the lock path is the one that runs `npm ci`.
grep -q 'Install-CoopExtensionsLock -AgentDir $AgentDir -Npm $npm -PiVersion $piVer' "$ROOT/lib/common.ps1" \
  && grep -q '& $Npm ci --no-audit --no-fund' "$ROOT/lib/common.ps1" \
  && ! grep -q 'Get-FileHash -' "$ROOT/lib/common.ps1" \
  && ok "Sync-CoopExtensionPins installs from the lock (npm ci) before a live resolution" \
  || ko "lib/common.ps1 convergence no longer tries the lockfile first"

# 5-7. The behavioural half (the lock applied through the real helpers with a
#      stub npm: exact tree -> npm ci, unholdable tree -> live install, failed
#      lock remembered) runs in PowerShell: tests/fixtures/extensions-lock.test.ps1.

if [ "$fail" -ne 0 ]; then echo "  ✗ extensions-lock tests FAILED"; exit 1; fi
echo "  extensions-lock tests passed"

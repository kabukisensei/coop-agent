#!/usr/bin/env bash
# config/extensions-lock.json pins the isolated extension tree's TRANSITIVE
# dependencies (issue #152). The lock must agree with config/release-manifest.json
# (a pin bump without `node lib/extlock.js generate` fails here), and `coop sync`
# applies it only when it can hold: manifest Pi installed and a tree whose
# package.json declares exactly the lock's root dependencies. Offline; the lock
# is read, never resolved.
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

# 4. The convergence twins consult the lock before their live npm install, and
#    the lock path is the one that runs `npm ci`.
grep -q 'coop_apply_extensions_lock "$agent_dir" "$npm_bin" "$pi_ver"' "$ROOT/lib/common.sh" \
  && grep -q '"$npm_bin" ci --no-audit --no-fund' "$ROOT/lib/common.sh" \
  && ok "coop_converge_extension_pins installs from the lock (npm ci) before a live resolution" \
  || ko "lib/common.sh convergence no longer tries the lockfile first"
grep -q 'Install-CoopExtensionsLock -AgentDir $AgentDir -Npm $npm -PiVersion $piVer' "$ROOT/lib/common.ps1" \
  && grep -q '& $Npm ci --no-audit --no-fund' "$ROOT/lib/common.ps1" \
  && ! grep -q 'Get-FileHash -' "$ROOT/lib/common.ps1" \
  && ok "Sync-CoopExtensionPins installs from the lock (npm ci) before a live resolution" \
  || ko "lib/common.ps1 convergence no longer tries the lockfile first"

# 5. End to end through the bash helper with a stub npm: an exact tree on the
#    manifest Pi gets the lock copied beside package.json and `npm ci`; a tree
#    with an extra extension gets a plain `npm install` and no lock.
STUB="$TMP/stub"; mkdir -p "$STUB"
cat > "$STUB/npm" <<EOF
#!/bin/sh
[ "\$1" = "--version" ] && { echo 10.9.0; exit 0; }
echo "NPM \$*" >> "$TMP/npm.log"; exit 0
EOF
chmod +x "$STUB/npm"
run_helper() { # <agent-dir>
  (
    export COOP_ROOT="$ROOT" PATH="$STUB:$PATH"
    # shellcheck disable=SC1091
    . "$ROOT/lib/common.sh"
    coop_apply_extensions_lock "$1" "$STUB/npm" "$pi_ver"
  )
}
: > "$TMP/npm.log"
if run_helper "$TMP/exact" && [ -f "$TMP/exact/npm/package-lock.json" ] && grep -q '^NPM ci ' "$TMP/npm.log"; then
  ok "sync copies the lock next to package.json and runs npm ci on an exact tree"
else
  ko "lock path did not run npm ci on an exact tree ($(cat "$TMP/npm.log" 2>/dev/null | tr '\n' ' '))"
fi
cmp -s "$LOCK" "$TMP/exact/npm/package-lock.json" && ok "the tree's package-lock.json is byte-identical to the shipped lock" || ko "the copied lock differs from config/extensions-lock.json"
: > "$TMP/npm.log"
if run_helper "$TMP/extra"; then
  ko "lock path claimed success on a tree the lock cannot hold"
else
  [ ! -f "$TMP/extra/npm/package-lock.json" ] && ! grep -q '^NPM ci ' "$TMP/npm.log" \
    && ok "a tree the lock cannot hold gets no lock and no npm ci (caller resolves live)" \
    || ko "lock path touched a tree it cannot hold"
fi
: > "$TMP/npm.log"
if run_helper_other=$(cd "$TMP" && COOP_ROOT="$ROOT" PATH="$STUB:$PATH" bash -c '. "$0/lib/common.sh"; coop_apply_extensions_lock "$1" "$2" 0.0.1' "$ROOT" "$TMP/exact" "$STUB/npm" 2>&1); then
  ko "lock applied although the installed Pi is not the manifest's Pi ($run_helper_other)"
else
  ok "an installed Pi other than the manifest's (edge, matrix) skips the lock"
fi

# 6. The convergence fast path must still reach the lock (VM finding, 2026-10-01):
#    `pi install` lands every extension at its exact pin and records caret
#    ranges, so a tree that is "already at pin" but carries no lock gets pins.js
#    (exact specs) and then npm ci; a tree that already carries the shipped lock
#    is left alone.
mk_installed() { # <dir>: exact-pin node_modules, caret-range package.json (what pi install leaves)
  mkdir -p "$1/npm/node_modules"
  "$PY" - "$MANIFEST" "$1/npm" <<'PY2'
import json, os, sys
m = json.load(open(sys.argv[1])); root = sys.argv[2]
json.dump({"name": "pi-extensions", "private": True,
           "dependencies": {k: "^" + v for k, v in m["extensions"].items()}}, open(os.path.join(root, "package.json"), "w"), indent=2)
for name, ver in m["extensions"].items():
    d = os.path.join(root, "node_modules", *name.split("/")); os.makedirs(d, exist_ok=True)
    json.dump({"name": name, "version": ver}, open(os.path.join(d, "package.json"), "w"))
PY2
}
specs="$("$PY" -c 'import json,sys; m=json.load(open(sys.argv[1])); print(" ".join(f"{k}@{v}" for k,v in m["extensions"].items()))' "$MANIFEST")"
cat > "$STUB/pi" <<EOF
#!/bin/sh
[ "\$1" = "--version" ] && { echo "pi $pi_ver"; exit 0; }
exit 0
EOF
chmod +x "$STUB/pi"
run_converge() { # <agent-dir>
  (
    export COOP_ROOT="$ROOT" PATH="$STUB:$PATH"
    # shellcheck disable=SC1091
    . "$ROOT/lib/common.sh"
    # shellcheck disable=SC2086  # $specs is a deliberate word list
    coop_converge_extension_pins "$1" $specs
  )
}
mk_installed "$TMP/installed"
: > "$TMP/npm.log"
if run_converge "$TMP/installed" && grep -q '^NPM ci ' "$TMP/npm.log" && cmp -s "$LOCK" "$TMP/installed/npm/package-lock.json"; then
  ok "an already-at-pin tree without the lock still gets exact pins and npm ci"
else
  ko "fast path skipped the lock on an already-at-pin tree ($(tr '\n' ' ' < "$TMP/npm.log"))"
fi
"$PY" -c 'import json,sys; d=json.load(open(sys.argv[1]))["dependencies"]; sys.exit(0 if all(not v.startswith("^") for v in d.values()) else 1)' "$TMP/installed/npm/package.json" \
  && ok "pins.js rewrote the caret ranges pi install records to exact pins before npm ci" || ko "package.json still carries caret ranges"
: > "$TMP/npm.log"
if run_converge "$TMP/installed" && [ ! -s "$TMP/npm.log" ]; then
  ok "a tree that already carries the shipped lock is left alone (idempotent, offline)"
else
  ko "a locked tree was reinstalled ($(tr '\n' ' ' < "$TMP/npm.log"))"
fi

# 7. A machine where the lock cannot install (VM, 2026-10-01: `npm ci` compiled
#    better-sqlite3 13 from source and failed) falls back to the live install
#    ONCE and remembers that lock: the next sync neither tears the tree down nor
#    retries npm ci until a different lock ships.
FAILSTUB="$TMP/failstub"; mkdir -p "$FAILSTUB"
cat > "$FAILSTUB/npm" <<EOF
#!/bin/sh
[ "\$1" = "--version" ] && { echo 10.9.0; exit 0; }
echo "NPM \$*" >> "$TMP/npm.log"
[ "\$1" = "ci" ] && exit 1
exit 0
EOF
chmod +x "$FAILSTUB/npm"; cp "$STUB/pi" "$FAILSTUB/pi"
run_converge_failing() { # <agent-dir>
  (
    export COOP_ROOT="$ROOT" PATH="$FAILSTUB:$PATH"
    # shellcheck disable=SC1091
    . "$ROOT/lib/common.sh"
    # shellcheck disable=SC2086
    coop_converge_extension_pins "$1" $specs
  )
}
mk_installed "$TMP/nolock"
: > "$TMP/npm.log"
if run_converge_failing "$TMP/nolock" && grep -q '^NPM ci ' "$TMP/npm.log" && grep -q '^NPM install ' "$TMP/npm.log" \
   && [ ! -f "$TMP/nolock/npm/package-lock.json" ] && cmp -s "$LOCK" "$TMP/nolock/npm/.coop-lock-failed.json"; then
  ok "a failed npm ci falls back to the live install, drops the copied lock and records the failed lock"
else
  ko "failed-lock fallback misbehaved ($(tr '\n' ' ' < "$TMP/npm.log"); lock=$([ -f "$TMP/nolock/npm/package-lock.json" ] && echo present || echo absent))"
fi
: > "$TMP/npm.log"
if run_converge_failing "$TMP/nolock" && [ ! -s "$TMP/npm.log" ]; then
  ok "the next sync does not retry a lock this machine already failed to install (no npm call)"
else
  ko "a known-failed lock was retried ($(tr '\n' ' ' < "$TMP/npm.log"))"
fi
rm -rf "$TMP/nolock/npm/node_modules"
: > "$TMP/npm.log"
if run_converge_failing "$TMP/nolock" && ! grep -q '^NPM ci ' "$TMP/npm.log" && grep -q '^NPM install ' "$TMP/npm.log"; then
  ok "a wiped tree with a known-failed lock goes straight to the live install (VM step 5)"
else
  ko "a wiped tree retried a known-failed lock ($(tr '\n' ' ' < "$TMP/npm.log"))"
fi
mk_installed "$TMP/nolock"
printf '{"stale": true}\n' > "$TMP/nolock/npm/.coop-lock-failed.json"
: > "$TMP/npm.log"
if run_converge_failing "$TMP/nolock" && grep -q '^NPM ci ' "$TMP/npm.log"; then
  ok "a different (new) lock is tried again after an earlier failure"
else
  ko "a new lock was not retried after an earlier failure ($(tr '\n' ' ' < "$TMP/npm.log"))"
fi
printf '{"stale": true}\n' > "$TMP/nolock/npm/.coop-lock-failed.json"
: > "$TMP/npm.log"
if run_converge "$TMP/nolock" && grep -q '^NPM ci ' "$TMP/npm.log" && [ ! -f "$TMP/nolock/npm/.coop-lock-failed.json" ] \
   && cmp -s "$LOCK" "$TMP/nolock/npm/package-lock.json"; then
  ok "a lock that installs clears the failed-lock record"
else
  ko "a successful lock install left the failed-lock record ($(tr '\n' ' ' < "$TMP/npm.log"))"
fi

if [ "$fail" -ne 0 ]; then echo "  ✗ extensions-lock tests FAILED"; exit 1; fi
echo "  extensions-lock tests passed"

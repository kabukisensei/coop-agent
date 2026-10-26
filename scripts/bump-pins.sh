#!/usr/bin/env bash
#
# bump-pins.sh — move the coop tool pins in config/release-manifest.json to the
# newest release of each sibling repository (dev tooling, like release.sh).
#
# Usage:  bash scripts/bump-pins.sh [--check] [tool=version ...]
#   no arguments   read each tool's newest v* tag from GitHub (or the sibling
#                  clone's tags when GitHub is unreachable) and write it
#   tool=version   pin that tool to that version instead (coop-data-doc=1.4.4)
#   --check        print what would change and exit 0 (1 when something would)
#
# The manifest is the only place a Python tool pin is written (tests/pins.test.sh
# fails a bump that leaves a stale `<tool>==<old>` literal elsewhere; the
# fixtures, NOTICE.md and the client-home CI template read the manifest). For a
# tool in python_tool_sources (a GitHub release wheel, not PyPI) the script also
# sets the tag, the asset name and the asset's sha256, downloaded from the
# release. It prints the CHANGELOG line to paste under [Unreleased]; it commits
# nothing.
#
# Dependencies: bash, python3 (no PyYAML; it reads PyPI and GitHub over https),
# curl (or `gh` when installed), sha256sum or shasum.

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/config/release-manifest.json"
CHECK=0
PINS=()
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    *=*) PINS+=("$arg") ;;
    *) echo "usage: bash scripts/bump-pins.sh [--check] [tool=version ...]" >&2; exit 2 ;;
  esac
done

TOOLS="coop-data-doc coop-schema-compare coop-sql-source-control"

newest_pypi() { # newest_pypi <package> -> X.Y.Z from PyPI's release list (empty when unreachable)
  python3 - "$1" <<'PY' 2>/dev/null || true
import json, re, sys, urllib.request
with urllib.request.urlopen("https://pypi.org/pypi/" + sys.argv[1] + "/json", timeout=20) as r:
    releases = json.load(r)["releases"]
def key(v):
    return tuple(int(x) for x in v.split("."))
final = [v for v in releases if re.fullmatch(r"\d+\.\d+\.\d+", v) and releases[v]]
print(max(final, key=key) if final else "")
PY
}

newest_tag() { # newest_tag <repo> -> X.Y.Z (empty when unknown)
  local repo="kabukisensei/$1" out=""
  # A PyPI tool's newest version is on PyPI (a GitHub Release may lag or be missing);
  # a GitHub-release wheel (python_tool_sources) is newest on GitHub.
  if ! python3 -c 'import json,sys; sys.exit(0 if sys.argv[2] in json.load(open(sys.argv[1])).get("python_tool_sources", {}) else 1)' "$MANIFEST" "$1"; then
    out="$(newest_pypi "$1")"
  fi
  if [ -z "$out" ] && command -v gh >/dev/null 2>&1; then
    out="$(gh api "repos/$repo/releases/latest" --jq .tag_name 2>/dev/null || true)"
  fi
  if [ -z "$out" ]; then
    out="$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" 2>/dev/null | sed -n 's/^ *"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
  fi
  if [ -z "$out" ] && [ -d "$ROOT/../$1/.git" ]; then
    out="$(git -C "$ROOT/../$1" tag --list 'v*' --sort=-v:refname | head -n 1)"
  fi
  printf '%s' "${out#v}"
}

asset_sha256() { # asset_sha256 <repo> <tag> <asset> -> sha256 (empty when not downloadable)
  local repo="kabukisensei/$1" tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/bump-pins.XXXXXX")"
  if command -v gh >/dev/null 2>&1 && gh release download "$2" --repo "$repo" --pattern "$3" --output "$tmp" --clobber >/dev/null 2>&1; then :
  elif ! curl -fsSL -o "$tmp" "https://github.com/$repo/releases/download/$2/$3" 2>/dev/null; then rm -f "$tmp"; return 0; fi
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$tmp" | cut -d' ' -f1; else shasum -a 256 "$tmp" | cut -d' ' -f1; fi
  rm -f "$tmp"
}

# --- resolve the wanted version per tool --------------------------------------
WANT=""
for tool in $TOOLS; do
  v=""
  for p in ${PINS[@]+"${PINS[@]}"}; do [ "${p%%=*}" = "$tool" ] && v="${p#*=}"; done
  [ -n "$v" ] || v="$(newest_tag "$tool")"
  if ! printf '%s' "$v" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "$tool: no release found (give it as $tool=X.Y.Z)" >&2; exit 1
  fi
  WANT="$WANT $tool=$v"
done

# --- apply (python3, stdlib only; keeps the manifest's 2-space layout) ---------
python3 - "$MANIFEST" "$CHECK" $WANT <<'PY'
import json, sys, subprocess
path, check, pins = sys.argv[1], sys.argv[2] == "1", dict(p.split("=", 1) for p in sys.argv[3:])
with open(path, encoding="utf-8") as f:
    m = json.load(f)
changed = []
for tool, new in pins.items():
    old = m["python_tools"].get(tool)
    if old == new:
        continue
    changed.append((tool, old, new))
    m["python_tools"][tool] = new
    src = m.get("python_tool_sources", {}).get(tool)
    if src is not None:
        src["tag"] = "v" + new
        src["asset"] = tool.replace("-", "_") + "-" + new + "-py3-none-any.whl"
        src["sha256"] = ""
if not changed:
    print("pins already current: " + ", ".join(f"{t} {v}" for t, v in pins.items()))
    sys.exit(0)
for tool, old, new in changed:
    print(f"{tool}: {old} -> {new}")
if check:
    sys.exit(1)
with open(path, "w", encoding="utf-8", newline="\n") as f:
    json.dump(m, f, indent=2, ensure_ascii=False)
    f.write("\n")
line = ", ".join(f"{t} {n}" for t, _, n in changed)
print("CHANGELOG: - **New tool pins:** " + line + ".")
print("NEEDSHA " + " ".join(t for t, _, _ in changed if t in m.get("python_tool_sources", {})))
PY
rc=$?
[ "$CHECK" = 1 ] && exit $rc

# --- the GitHub-release wheel's sha256 ----------------------------------------
needsha="$(python3 - "$MANIFEST" <<'PY'
import json, sys
m = json.load(open(sys.argv[1], encoding="utf-8"))
print(" ".join(t for t, s in m.get("python_tool_sources", {}).items() if not s.get("sha256")))
PY
)"
for tool in $needsha; do
  tag="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["python_tool_sources"][sys.argv[2]]["tag"])' "$MANIFEST" "$tool")"
  asset="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["python_tool_sources"][sys.argv[2]]["asset"])' "$MANIFEST" "$tool")"
  sha="$(asset_sha256 "$tool" "$tag" "$asset")"
  if [ -z "$sha" ]; then
    echo "$tool: could not download $asset from the $tag release to hash it; set python_tool_sources.$tool.sha256 by hand" >&2
    exit 1
  fi
  python3 - "$MANIFEST" "$tool" "$sha" <<'PY'
import json, sys
path, tool, sha = sys.argv[1:]
m = json.load(open(path, encoding="utf-8"))
m["python_tool_sources"][tool]["sha256"] = sha
with open(path, "w", encoding="utf-8", newline="\n") as f:
    json.dump(m, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
  echo "$tool: sha256 $sha"
done

bash "$ROOT/tests/pins.test.sh" >/dev/null && echo "pins.test.sh: ok" || { echo "pins.test.sh failed: a stale literal is left somewhere (run it to see)"; exit 1; }
echo "done; add the CHANGELOG line under [Unreleased], then commit"

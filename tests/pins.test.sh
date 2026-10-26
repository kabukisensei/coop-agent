#!/usr/bin/env bash
# Users only ever get the release's tested versions. Outside `--edge`, every
# install or repair coop runs names the pin from config/release-manifest.json,
# and no hint tells a user to install `@latest`.
set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
fail=0
ok()  { printf '  ✓ %s\n' "$1"; }
ko()  { printf '  ✗ %s\n' "$1"; fail=1; }

# No @latest in product code. lib/mcp_config.py only detects the @latest
# placeholders older releases wrote, to migrate them away.
hits="$(grep -rn -I '@latest' "$ROOT/bin" "$ROOT/lib" "$ROOT/scripts" "$ROOT/extensions" "$ROOT/config" 2>/dev/null \
  | grep -v '/lib/mcp_config.py:' | grep -v '/node_modules/' || true)"
[ -z "$hits" ] && ok "no @latest in bin/, lib/, scripts/, extensions/ or config/" || ko "@latest found: $hits"

# `npm update -g <pkg>@<ver>` ignores the version and moves the tool to latest,
# so no product script runs it (comments may name it).
hits="$(grep -rn -I 'npm update -g' "$ROOT/bin" "$ROOT/lib" "$ROOT/scripts" 2>/dev/null | grep -vE ':[0-9]+:[[:space:]]*#' || true)"
[ -z "$hits" ] && ok "no product script runs npm update -g" || ko "npm update -g found: $hits"

# doctor --fix repairs the coop tools and the Fabric CLI through the same
# convergence unit install and update run, with the fleet plan's pins; it runs
# no pipx install of its own.
grep -q 'Invoke-CoopPipxConverge -Package $tool.Name -Pin $tool.Pin' "$ROOT/scripts/doctor.ps1" \
  && grep -q 'Invoke-CoopPipxConverge -Package $fixPlan.Fabric.Name -Pin $fixPlan.Fabric.Pin' "$ROOT/scripts/doctor.ps1" \
  && ok "doctor.ps1 --fix converges coop tools and the Fabric CLI at their manifest pins" \
  || ko "doctor.ps1 --fix does not run the pinned convergence unit for every tool"
if grep -E '^[^#]*& pipx install' "$ROOT/scripts/doctor.ps1" >/dev/null; then
  ko "doctor --fix runs its own pipx install beside the convergence unit"
else
  ok "doctor --fix runs no pipx install of its own"
fi

# Every install/repair pin the scripts read exists in the manifest.
PY="$(command -v python3 2>/dev/null || command -v python 2>/dev/null)"
if "$PY" - "$ROOT/config/release-manifest.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
need = {"python_tools": ["ms-fabric-cli", "coop-data-doc", "coop-schema-compare", "coop-sql-source-control", "fabric-cicd", "pyodbc"]}
missing = [f"{k}.{p}" for k, ps in need.items() for p in ps if not m.get(k, {}).get(p)]
assert m.get("pi", {}).get("version"), "pi.version"
assert not missing, missing
for section in ("extensions", "npm_tools", "mcp_servers", "python_tools"):
    for name, ver in m.get(section, {}).items():
        assert isinstance(ver, str) and ver[:1].isdigit() and not any(c in ver for c in "^~*<> "), f"{section}.{name}={ver!r} is not an exact version"
# A tool that is not on PyPI (SQ12) names its release asset, hash and token variable, at the pin.
for name, src in m.get("python_tool_sources", {}).items():
    pin = m["python_tools"][name]
    assert src["asset"].startswith(name.replace("-", "_") + "-" + pin + "-") and src["asset"].endswith(".whl"), f"python_tool_sources.{name}.asset is not the {pin} wheel"
    assert len(src["sha256"]) == 64 and src["tag"] == "v" + pin and src["token_env"], f"python_tool_sources.{name} is incomplete"
PY
then ok "the manifest pins Pi and every tool doctor --fix repairs, all to exact versions"
else ko "the manifest is missing a pin or holds a range"; fi


# --- The manifest is the only place a Python tool pin is written (suite review
# pick 2). A pin bump that leaves `<tool>==<old>` anywhere else (a fixture, a
# doc, a template) fails here, on the bump PR, instead of in the nightly lane.
manifest="$ROOT/config/release-manifest.json"
report="$(python3 - "$manifest" <<'PY'
import json, re, sys
m = json.load(open(sys.argv[1], encoding="utf-8"))
for name, pin in m["python_tools"].items():
    # ERE: the pin with each dot optionally regex-escaped (fixtures write `1\.4\.3` in patterns)
    print("PIN", name, pin, pin.replace(".", r"\\?\."))
for name, spec in m.get("python_tool_sources", {}).items():
    pin = m["python_tools"].get(name, "")
    ok = spec.get("tag") == "v" + pin and ("-" + pin + "-") in spec.get("asset", "")
    print("SOURCE", name, "ok" if ok else "stale")
PY
)"
# python on Windows prints CRLF; a trailing CR would end up inside the pin regex
report="$(printf '%s' "$report" | tr -d '\r')"
[ -n "$report" ] || ko "could not read python_tools from config/release-manifest.json"
stale=""
while read -r kind name _ pinre; do
  [ "$kind" = "PIN" ] || continue
  hits="$(git -C "$ROOT" ls-files -z \
    | grep -zvE '^(CHANGELOG\.md|docs/history/|docs/COOP_MASTER_PLAN\.md|docs/agent/|config/release-manifest\.json|tests/pins\.test\.sh)' \
    | xargs -0 grep -nE -I "${name}==[0-9]+(\\\\?\\.[0-9]+){2}" -- 2>/dev/null \
    | grep -vE "${name}==${pinre}([^0-9]|$)" || true)"
  [ -z "$hits" ] || stale="$stale
$hits"
done <<< "$report"
[ -z "$stale" ] && ok "every <tool>==<version> literal names the manifest pin (fixtures, docs, templates)" || ko "stale pin literal(s); bump them with the manifest:$stale"
if printf '%s\n' "$report" | grep -q '^SOURCE .* stale$'; then
  ko "python_tool_sources tag/asset do not name the python_tools pin: $(printf '%s\n' "$report" | grep '^SOURCE .* stale$' | tr '\n' ' ')"
else
  ok "python_tool_sources tag and asset name the python_tools pin"
fi
grep -q 'coop-data-doc==<version>' "$ROOT/templates/client-home/github-workflow-data-docs-check.yml" \
  && ok "the client-home CI template carries the <version> placeholder (rendered from the manifest at copy time)" \
  || ko "templates/client-home/github-workflow-data-docs-check.yml must carry coop-data-doc==<version>, not a literal pin"

if [ "$fail" -ne 0 ]; then echo "  ✗ pin tests FAILED"; exit 1; fi
echo "  pin tests passed"

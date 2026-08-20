#!/usr/bin/env bash
#
# fleet-digest tests: regression for _render_html NameError, HTML escaping,
# and markdown formatting.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf '  ✗ %s\n' "$1"; exit 1; }
pass() { printf '  ✓ %s\n' "$1"; }

PUBDIR="$TMP/published"
mkdir -p "$PUBDIR"

NOW="2026-08-20T12:00:00+00:00"

# Snapshot with values that previously crashed HTML rendering and that contain
# HTML/MD metacharacters to exercise escaping.
cat > "$PUBDIR/host1.json" <<JSON
{
  "hostname": "host1<script>alert(1)</script>",
  "user": "alice|admin",
  "timestamp": "$NOW",
  "fail": 1,
  "warn": 1,
  "coop_version": "0.5.0",
  "pi_version": "0.80.2",
  "checks": [
    {"name": "disk <90%", "status": "fail"},
    {"name": "coop-data-doc (0.32.0)", "status": "warn"}
  ]
}
JSON

# Minimal config pointing at the sandbox publish dir.
cat > "$TMP/coopconfig" <<YAML
fleet:
  publish_dir: $PUBDIR
YAML

PY="$ROOT/scripts/fleet-digest.py"

# 1. HTML format must run without NameError and must escape injected HTML.
html_out="$(python3 "$PY" --config "$TMP/coopconfig" --format html 2>/dev/null)" || fail "HTML render crashed"
case "$html_out" in
  *"<script>alert(1)</script>"*) fail "HTML hostname not escaped" ;;
  *"&lt;script&gt;alert(1)&lt;/script&gt;"*) : ;;
  *) fail "expected escaped hostname in HTML output" ;;
esac
case "$html_out" in
  *"disk &lt;90%"*) : ;;
  *) fail "expected escaped '<' in check name" ;;
esac
pass "HTML render escapes hostname and check names"

# 2. The HTML version cell must render the tool mismatch.
case "$html_out" in
  *"coop-data-doc 0.32.0"*) : ;;
  *) fail "expected tool mismatch detail in HTML output" ;;
esac
pass "HTML render includes tool mismatch details"

# 3. Markdown format must not contain literal <br> tags inside the table.
md_out="$(python3 "$PY" --config "$TMP/coopconfig" --format md 2>/dev/null)" || fail "Markdown render crashed"
case "$md_out" in
  *"<br>"*) fail "markdown output contains literal <br>" ;;
esac
pass "Markdown output has no literal <br>"

# 4. Markdown table pipe characters in cell values must be escaped.
case "$md_out" in
  *"alice\\|admin"*) : ;;
  *) fail "expected escaped pipe in user cell";;
esac
pass "Markdown escapes pipe characters in cell values"

# 5. Empty machine list must produce valid HTML without crash.
mkdir -p "$TMP/empty"
cat > "$TMP/coopconfig-empty" <<YAML
fleet:
  publish_dir: $TMP/empty
YAML
html_empty="$(python3 "$PY" --config "$TMP/coopconfig-empty" --format html 2>/dev/null)" || fail "HTML render crashed on empty list"
case "$html_empty" in
  *"Fleet Health Digest"*) : ;;
  *) fail "expected digest heading in empty HTML output" ;;
esac
pass "HTML render handles empty machine list"

printf '  %s\n' "fleet-digest tests passed"

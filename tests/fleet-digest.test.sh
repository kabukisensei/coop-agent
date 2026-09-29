#!/usr/bin/env bash
#
# fleet-digest tests: regression for _render_html NameError, HTML escaping,
# markdown formatting, and the coop version cell with and without the
# coop_describe field (#108).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# The publish_dir lines below are read by native Windows Python under Git Bash,
# which cannot resolve a POSIX /tmp path inside a file (MSYS converts argv, not
# file contents), so the configs get the mixed C:/... spelling there.
TMP_NATIVE="$(cygpath -m "$TMP" 2>/dev/null || printf '%s' "$TMP")"

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

# #108: a git checkout publishes coop_describe; a non-git copy publishes it
# empty; host1 above is an older payload without the field.
cat > "$PUBDIR/host2.json" <<JSON
{"hostname": "host2", "user": "bob", "timestamp": "$NOW", "fail": 0, "warn": 0,
 "coop_version": "0.23.5", "coop_describe": "v0.23.5-21-gdf91630", "pi_version": "0.80.2", "checks": []}
JSON
cat > "$PUBDIR/host3.json" <<JSON
{"hostname": "host3", "user": "carol", "timestamp": "$NOW", "fail": 0, "warn": 0,
 "coop_version": "0.23.6", "coop_describe": "", "pi_version": "0.80.2", "checks": []}
JSON

# Minimal config pointing at the sandbox publish dir.
cat > "$TMP/coopconfig" <<YAML
fleet:
  publish_dir: $TMP_NATIVE/published
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

# 4b. coop_describe (#108) shows next to coop_version when present; a payload
#     without it, or with it empty, shows coop_version alone.
for want in "coop 0.23.5 (v0.23.5-21-gdf91630), pi" "coop 0.5.0, pi" "coop 0.23.6, pi"; do
  case "$md_out" in *"$want"*) ;; *) fail "markdown versions cell must read '$want'" ;; esac
done
for want in "coop 0.23.5 (v0.23.5-21-gdf91630)<br>pi" "coop 0.5.0<br>pi" "coop 0.23.6<br>pi"; do
  case "$html_out" in *"$want"*) ;; *) fail "HTML versions cell must read '$want'" ;; esac
done
pass "coop_describe renders when present; older and non-git payloads show coop_version alone"

# 5. Empty machine list must produce valid HTML without crash.
mkdir -p "$TMP/empty"
cat > "$TMP/coopconfig-empty" <<YAML
fleet:
  publish_dir: $TMP_NATIVE/empty
YAML
html_empty="$(python3 "$PY" --config "$TMP/coopconfig-empty" --format html 2>/dev/null)" || fail "HTML render crashed on empty list"
case "$html_empty" in
  *"Fleet Health Digest"*) : ;;
  *) fail "expected digest heading in empty HTML output" ;;
esac
pass "HTML render handles empty machine list"

# 6. Redirected output on Windows (a file, a pipe, Task Scheduler) gets the ANSI
#    code page, which has no ⚠. The digest must still write, as UTF-8.
for fmt in md html; do
  out="$(PYTHONIOENCODING=cp1252 python3 "$PY" --config "$TMP/coopconfig" --format "$fmt")" \
    || fail "the $fmt digest crashed on a cp1252 stdout (Windows redirected output)"
  case "$out" in *"⚠"*) ;; *) fail "the $fmt digest must keep its ⚠ marks, written as UTF-8" ;; esac
done
pass "md and html digests write UTF-8 when stdout's code page has no ⚠"

printf '  %s\n' "fleet-digest tests passed"

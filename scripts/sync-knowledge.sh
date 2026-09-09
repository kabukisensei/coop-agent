#!/usr/bin/env bash
#
# Sync the configured team knowledge repos (~/.coop/config "knowledge" block).
#
# For each repo when knowledge.enabled:
#   - local_path missing          -> git clone <url> <local_path>
#   - existing clean git checkout -> git -C <local_path> pull --ff-only
#   - dirty checkout              -> warn + skip (never reset/clean)
#   - unreachable remote          -> warn + continue (fail soft — offline must
#                                    never break `coop`)
#
# Every git operation runs through scripts/knowledge-git.py: a hard process-tree
# deadline (default 30s, override with COOP_KNOWLEDGE_GIT_TIMEOUT_SECONDS), no
# interactive prompts, unattended batch SSH that preserves host-key checking.
# A failed or timed-out `git status` means UNKNOWN state: warn and skip — empty
# output is never read as proof of a clean checkout. Clones land in a unique
# temporary sibling and are moved into place only on success, only when the
# destination is still absent; interrupted-clone cleanup removes ONLY the owned
# temporary directory, never the configured destination. Warnings name the path
# or repo label, never authenticated URLs or credential-helper output.
#
# Always exits 0 for sync problems; team knowledge is an aid, not a gate.
#
# Usage: scripts/sync-knowledge.sh
#
set -uo pipefail

COOP_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
export COOP_ROOT
# shellcheck source=../lib/common.sh
. "$COOP_ROOT/lib/common.sh"

if ! coop_knowledge_enabled; then
  coop_info "team knowledge sync is disabled — enable it with: coop onboard --config-only"
  exit 0
fi
have git || { coop_warn "git is required to sync team knowledge — skipping"; exit 0; }

# The bounded runner needs Python. Without it we skip the sync entirely rather
# than fall back to unbounded Git — an offline/auth hang must never block `coop`.
py="$(coop_python)" || { coop_warn "python is required for bounded knowledge sync — skipping"; exit 0; }
KGIT() { "$py" "$COOP_ROOT/scripts/knowledge-git.py" -- git "$@"; }

ERR_TMP="$(mktemp -d)"
trap 'rm -rf "$ERR_TMP"' EXIT

# Classify the runner result in $errfile: timeout is reported distinctly.
warn_for_rc() { # <rc> <timed-out-message> <other-message>
  case "$1" in
    124) coop_warn "$2" ;;
    *)   if grep -q "timed out" "$errfile" 2>/dev/null; then coop_warn "$2"; else coop_warn "$3"; fi ;;
  esac
}

synced=0
# Feed the loop with a here-doc (not a pipe) so `synced` survives in this shell.
while IFS="$(printf '\t')" read -r url path; do
  [ -n "$url" ] && [ -n "$path" ] || continue
  errfile="$ERR_TMP/err-$$-$synced"
  if [ -d "$path/.git" ]; then
    # State probe: a failed or timed-out status means UNKNOWN — never pull.
    status_out="$(KGIT -C "$path" status --porcelain 2>"$errfile")"; rc=$?
    if [ "$rc" -ne 0 ]; then
      warn_for_rc "$rc" \
        "knowledge repo state unknown (status timed out) — skipping: $path" \
        "knowledge repo state unknown (status failed) — skipping: $path"
      continue
    fi
    if [ -n "$status_out" ]; then
      coop_warn "knowledge repo is dirty — skipping (never resetting your changes): $path"
      continue
    fi
    if KGIT -C "$path" pull --ff-only >/dev/null 2>"$errfile"; then
      coop_ok "updated $(basename "$path")"
      synced=$((synced+1))
    else
      rc=$?
      warn_for_rc "$rc" \
        "could not fast-forward $path — timed out; keeping the existing checkout" \
        "could not fast-forward $path (offline or diverged) — keeping the existing checkout"
    fi
  elif [ -e "$path" ]; then
    coop_warn "$path exists but is not a git checkout — skipping"
  else
    # Clone into a unique temporary SIBLING owned by this operation; move it
    # into place only on success and only if the destination is still absent.
    parent="$(dirname "$path")"
    mkdir -p "$parent" 2>/dev/null || true
    tmp="$parent/.coop-knowledge-clone-$$-$RANDOM"
    if KGIT clone "$url" "$tmp" >/dev/null 2>"$errfile"; then
      if [ ! -e "$path" ]; then
        if mv "$tmp" "$path" 2>/dev/null; then
          coop_ok "cloned $(basename "$path") -> $path"
          synced=$((synced+1))
        else
          rm -rf "$tmp" 2>/dev/null || true
          coop_warn "could not move cloned repo into place — removed the owned temp clone"
        fi
      else
        rm -rf "$tmp" 2>/dev/null || true
        coop_warn "destination appeared during clone — keeping the existing $path"
      fi
    else
      rc=$?
      rm -rf "$tmp" 2>/dev/null || true   # owned temp only, never the destination
      warn_for_rc "$rc" \
        "clone timed out and was terminated — continuing" \
        "clone failed (offline or no access)"
    fi
  fi
  rm -f "$errfile" 2>/dev/null || true
done <<EOF
$(coop_knowledge_repos)
EOF

coop_ok "team knowledge sync complete ($synced repo(s) current)"
exit 0

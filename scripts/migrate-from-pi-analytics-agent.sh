#!/usr/bin/env bash
#
# coop migrate — port an existing pi-analytics-agent setup into coop-agent.
#
# Reads a pi-analytics-agent checkout (its agent-config.yml + standards + docs)
# and helps you produce a .coop/project.yml for a target repo. NON-DESTRUCTIVE:
# it only ever writes into the target's .coop/ and copies standards docs; it
# never edits or commits source files, and it asks before overwriting.
#
#   Usage:
#     scripts/migrate-from-pi-analytics-agent.sh <pi-analytics-agent-dir> [target-repo-dir]
#
set -uo pipefail

COOP_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
export COOP_ROOT
# shellcheck source=../lib/common.sh
. "$COOP_ROOT/lib/common.sh"

SRC="${1:-}"
DST="${2:-$PWD}"
[ -n "$SRC" ] || coop_die "Usage: migrate-from-pi-analytics-agent.sh <pi-analytics-agent-dir> [target-repo-dir]"
[ -d "$SRC" ] || coop_die "Source not found: $SRC"

coop_head "Migrate pi-analytics-agent -> coop-agent"
coop_info "Source: $SRC"
coop_info "Target: $DST"

mkdir -p "$DST/.coop"

# 1. project.yml — seed from coop's example; flag the old config for hand-port.
OLD_CFG=""
for c in "$SRC/config/agent-config.yml" "$SRC/config/agent-config.template.yml" "$SRC/config/agent-config.example.yml"; do
  [ -f "$c" ] && { OLD_CFG="$c"; break; }
done
if [ -f "$DST/.coop/project.yml" ]; then
  coop_warn ".coop/project.yml already exists — leaving it untouched."
else
  cp "$COOP_ROOT/.coop/project.example.yml" "$DST/.coop/project.yml"
  coop_ok "Created .coop/project.yml from the Cooptimize template."
fi
if [ -n "$OLD_CFG" ]; then
  cp "$OLD_CFG" "$DST/.coop/agent-config.legacy.yml"
  coop_ok "Copied your old config to .coop/agent-config.legacy.yml for reference."
  coop_warn "Hand-port repo paths, workspaces, and tool paths from the legacy file into .coop/project.yml."
fi

# 2. Standards docs — copy if present (these are docs, safe to bring along).
if [ -d "$SRC/docs/standards" ]; then
  mkdir -p "$DST/docs/standards"
  for f in "$SRC"/docs/standards/*.md; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    if [ -f "$DST/docs/standards/$base" ]; then
      coop_warn "exists, skipping: docs/standards/$base"
    else
      cp "$f" "$DST/docs/standards/$base" && coop_ok "standards: $base"
    fi
  done
fi

# 3. Remind about the workflow change.
coop_head "Next steps"
cat >&2 <<EOF
  1. Edit ${DST}/.coop/project.yml (fill TODOs: repo paths, Fabric/Power BI workspaces, tenant).
  2. Run: coop doctor
  3. The 18-step pi-analytics workflow is now the 11-step 'coop-workflow' skill;
     documentation reads are handled by the coop-data-doc tool.
  4. Start the agent in your repo with: coop
EOF
coop_ok "Migration scaffold complete (no source files were changed)."

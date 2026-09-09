---
name: team-knowledge
description: "Search and apply Cooptimize team knowledge before non-trivial BI, Fabric, incremental-load, or data-pipeline work. Covers vault patterns across Bronze, Silver, Gold, Cross-Cutting, Decisions, and learnings."
---

# Team Knowledge

## Purpose

Consult Cooptimize shared knowledge and patterns before designing or implementing BI, Fabric, or data warehouse solutions. Always cite the repository identity and note path consulted.

## When to search

Search team knowledge:
- Before non-trivial BI, Fabric, incremental load, or pipeline changes.
- When choosing partition, watermark, or refresh strategies.
- When resolving architectural decisions or reconciling conflicting data patterns.
- When the user asks about team conventions or shared BI patterns.

## How to search

Team knowledge is searched ONLY through the bundled local-search helper.
`teamai` is never part of the workflow — do not invoke it, and never treat its
presence, absence, or configuration as changing how knowledge is found.

1. **Resolve the helper and interpreter.** `COOP_ROOT` is exported by the
   coop launcher and contains `bin/`, `scripts/`, `skills/`. The helper is
   `$COOP_ROOT/scripts/search-knowledge.py`. Use the discovered Python
   interpreter — the first of `python3`, `python`, or `py -3` that runs.
2. **Run the search** (search every configured repository in one call):
   ```bash
   python3 "$COOP_ROOT/scripts/search-knowledge.py" --query "<topic>"
   ```
   PowerShell: `py -3 "$env:COOP_ROOT\scripts\search-knowledge.py" --query "<topic>"`
3. **Handle the structured JSON status on stdout** — never guess:
   - `ok` — read each matched note at `<root>/<path>` before citing it, then
     answer with the repository identity plus the note path
     (e.g., `incremental-bi — Gold/Fact Patterns/Fact Partition Rebuild.md`).
     Zero matches under `ok` genuinely means the team knowledge has no note
     on the topic — say so explicitly; it never means "search failed".
   - `unavailable` — the configured clones are missing or unreadable. Run
     `coop sync` (or `coop update`) to fetch them, retry the search once,
     then proceed without knowledge if still unavailable. Never present
     `unavailable` as "the team has no relevant knowledge".
   - `disabled` — knowledge is not configured for this machine; proceed
     without it.
   - `invalid_config` — surface the warning from the `warnings` array to the
     user and proceed without knowledge.
   - Exit code `2` means the invocation itself was malformed (fix your
     command); exit code `1` means the helper failed. Neither is ever a
     successful search.
4. **Respect `warnings` and `truncated`** — a searched root with a `partial`
   flag (or subdirectory warnings) had inaccessible subdirectories; say the
   search was partial rather than exhaustive.

## Vault layer guide

The repository organizes patterns by layer:

- **Bronze**: Source extraction (CDC, change feeds, partition full loads).
- **Silver**: Conforming, cleansing, and deduplication (incremental with hard deletes).
- **Gold**: Dimensional models (fact partition rebuilds, open/settled rebuilds, dimension incremental).
- **Cross-Cutting**: Shared contracts (watermark strategies, ForceUpdate contracts, partition keys).
- **Decisions**: Architectural decision records and constraints (e.g. why modifiedDateTime cannot be trusted).
- **Semantic Model**: Tabular and Direct Lake modeling patterns.
- **Snapshots**: Periodic state and balance snapshotting.
- **learnings/**: Dated, tagged session discoveries and field solutions.

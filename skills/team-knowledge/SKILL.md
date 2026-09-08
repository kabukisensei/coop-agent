---
name: team-knowledge
description: "Search and apply Cooptimize team knowledge before non-trivial BI, Fabric, incremental-load, or data-pipeline work. Covers vault patterns across Bronze, Silver, Gold, Cross-Cutting, Decisions, and learnings."
---

# Team Knowledge

## Purpose

Consult Cooptimize shared knowledge and patterns before designing or implementing BI, Fabric, or data warehouse solutions. Always cite the note path consulted.

## When to search

Search team knowledge:
- Before non-trivial BI, Fabric, incremental load, or pipeline changes.
- When choosing partition, watermark, or refresh strategies.
- When resolving architectural decisions or reconciling conflicting data patterns.
- When the user asks about team conventions or shared BI patterns.

## How to search

1. **If `teamai` is available on PATH**, use BM25 semantic recall:
   ```bash
   teamai recall "<topic or search query>"
   ```
2. **Fallback: search the local clones directly**:
   Read configured local paths in `~/.coop/config` (`knowledge.repos[*].local_path`, typically `~/.coop/knowledge/incremental-bi`). If multiple repos are configured, search across each configured repo path:
   ```bash
   rg -i "<topic>" ~/.coop/knowledge/incremental-bi ~/.coop/knowledge/<other-repo>
   ```
   Or across all clones under the knowledge directory:
   ```bash
   rg -i "<topic>" ~/.coop/knowledge/
   ```
3. **Always cite the note path** used in your response (e.g., `Gold/Fact Patterns/Fact Partition Rebuild.md`).

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

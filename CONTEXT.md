# Standards authority glossary

- **formal_standard** — An approved normative standard for one domain. The synchronized Cooptimize canonical standard is the inherited default; project/client standards and approved overrides may supersede it for a run.
- **approved_pattern** — A reviewed implementation pattern that may inform work when applicable but is not normative. `cooptimize/incremental-bi` remains in this class.
- **team_knowledge** — Approved shared learning governed through TeamAI. `cooptimize/coop-team-knowledge` remains in this class and is not a formal standard.
- **project_local** — A project/client-specific standard or exception. It has the highest resolution precedence and existing v0.23.1 paths remain valid.
- **effective standard** — The one exact file selected for a domain and passed to both the COOP agent context and the deterministic reviewer for that run.
- **canonical standard** — The domain file from the synchronized Cooptimize formal-standards repository. The preferred remote is not provisioned; real synchronization state is `PENDING_OWNER_PROVISIONING`.
- **bundled fallback** — The packaged reviewer standard used offline or when no higher-precedence standard can safely resolve.
- **stale last-known-good** — A previously verified canonical file retained when refresh is unavailable; it must retain its source revision and hash and be reported as stale.

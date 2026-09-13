# Coop knowledge scope and governance policy

Status: KNW-001 contract

Coop has three deliberately separate knowledge classes. Pi/provider-supported
private memory holds personal preferences and private session recall. Project
knowledge is client-confidential and stays in the applicable project repository.
Team-general knowledge lives in a separate private team repository only after
client details have been removed and an attributable sanitization check has been
recorded. Private memory is never a Git-backed knowledge record.

## Authoritative record contract

`config/knowledge-record.schema.json` defines the versioned normalized record.
The source-of-truth representation is Markdown with equivalent YAML frontmatter
and the required body sections; KNW-002 will parse it into this contract. An
index is always derived and disposable.

Every record carries provenance, scope, sensitivity, lifecycle state, confidence,
creation identity/time, review identity/time, sanitization identity/time, project
ownership fields, and directional supersession fields. The required body sections
are Context, Problem, Why it happens, Approved pattern, Anti-pattern, Detection
method, Example, Exceptions, and Sources.

The Core validator in `lib/knowledge-policy.mjs` is authoritative for semantic
rules JSON Schema cannot express:

- Project records are `client-confidential`, declare client data present, and
  identify the project. They are never written to the team repository.
- Team records are `internal`, declare no client data, carry no organization or
  project identifier, and require a named sanitization reviewer and timestamp
  before even a proposed draft can be stored there.
- Approved, deprecated, and superseded states require review provenance.
- An agent may propose a record, but lifecycle changes require an explicit human
  action. Scope and record identity cannot be changed during a transition.
- Supersession is directional and the retired record identifies its replacement.
- Unknown fields and records over 128 KiB fail closed.

The `clientData` field is a governance assertion, not an automated claim that
free text is safe. The sanitization reviewer remains accountable for checking
names, resource identifiers, source extracts, credentials, connection details,
incident references, screenshots, and any other client-identifying context.

## Storage boundaries

Project knowledge belongs in an approved knowledge folder inside that project's
private source repository. Team-general knowledge belongs in a separately
configured private team repository. Neither location is Desktop state, Pi session
state, or `~/.coop` private memory.

KNW-001 does not authorize writes or publication. KNW-002 reads only configured,
Git-backed folders and builds a deterministic, disposable local index through
`lib/knowledge-index.mjs`. It skips non-approved records; malformed, scope-mixed,
or duplicate approved records make evidence partial/failed and cannot be silently
selected. Symlinks and hidden control folders are not followed. Search results
retain record ID, scope, source repository ID, and relative source path.

The index contains no absolute source roots or generation timestamp, so identical
records and source IDs reproduce identical bytes across machines. It may be
discarded and rebuilt at any time; source Markdown remains authoritative. KNW-003
must use a previewed source
change and explicit human action for propose, approve, reject, deprecate, or
supersede operations; normal human Git review/commit remains authoritative.

KNW-003 implements that source-change boundary in `lib/knowledge-service.mjs`.
Creation always starts as `proposed`. Every create or lifecycle action returns an
exact before/after Markdown preview and opaque proposal ID without writing. A
separate explicit approval applies the proposal only if source bytes still match;
updates preserve the prior bytes outside the repository, use an atomic replace,
and leave a normal uncommitted Git change. Coop never commits or publishes it.

The shared Knowledge Hub shows source/scope/sensitivity/status/confidence,
provenance, drafts/history, diagnostics, and review staleness. Only approved
records can be inserted into a session, and the prompt cites record ID and source
path. Approval, rejection, deprecation, and supersession collect a human reviewer.
Supersession additionally requires an existing approved replacement with a
back-reference. No session text or private memory is prefilled into a proposal.

The preview runtime accepts fixed source descriptors from trusted process
configuration (`COOP_PROJECT_KNOWLEDGE_ROOT` plus its project ID, and/or
`COOP_TEAM_KNOWLEDGE_ROOT`). The renderer sees opaque source IDs and relative
record paths only. A governed setup owner for these locations remains required
before Desktop GA; environment configuration is not the final onboarding UX.

## Failure behavior

Missing provenance, ambiguous scope, unsanitized team content, mixed review
metadata, unsupported lifecycle transitions, and attempted scope promotion fail
closed with a structured validation error. A rejected or superseded record stays
visible for audit but is not current guidance. Conflicting approved guidance must
remain visible until a human resolves it; the index may not silently choose one.

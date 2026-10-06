# /explain

Use the `coop-workflow` skill.

Explain the current plan, slice, or decision as if teaching an experienced
teammate who needs to spot problems early. Do not make new edits.

Cover:

- **What we are trying to do** — and why this slice is the next one.
- **Key assumptions** — and why they are reasonable.
- **What would make this approach wrong** — the earliest warning signs.
- **Alternatives considered** — and why this one was picked.
- **Risks or trade-offs** — that should be watched.
- **Stop-and-ask triggers** — conditions where I should pause.

`/explain impact`: explain the downstream of each SQL object in the current slice
(the session's lineage context, which coop filled before the edit) and the
follow-on edit each dependent would need. For the raw detail without a model turn,
the user can run `/impact [schema.name]`.

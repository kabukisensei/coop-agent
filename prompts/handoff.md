# /handoff

Use the `coop-workflow` skill.

Summarize this session as a **handoff** for the next person or session. Output
these sections, drawn from what actually happened (do not invent):

- **What changed** — objects/files touched and the intent behind each.
- **Reviewed / tested** — `sql_review` / `dax_review` / BPA / `fabric-cicd`
  validate results and any tests run, with pass/fail.
- **Files modified** — the concrete list (source prepared for review vs.
  docs/logs already committed).
- **Open issues / blockers** — anything unresolved or awaiting a decision.
- **Next 3–5 todos** — the smallest next steps to pick this up cold.

Keep it read-only: report the state, don't make new edits. Never commit source;
never include secrets.

# /handoff

Use the `coop-workflow` skill.

Summarize this session as a **handoff** for the next person or session. Output
these sections, drawn from what actually happened (do not invent):

- **What changed** — objects/files touched and the intent behind each.
- **Self-checked / tested** — the standards self-check (rules met, rules you could
  not meet), BPA / `fabric-cicd` validate results and any tests run, with pass/fail.
- **Files modified** — the concrete list (source prepared for review vs.
  docs/logs already committed).
- **Open issues / blockers** — anything unresolved or awaiting a decision.
- **Next 3–5 todos** — the smallest next steps to pick this up cold.

Keep it read-only: report the state, don't make new edits. Never commit source;
never include secrets.

**DevOps update (optional).** When the session worked a DevOps story or feature, end
by offering to post the handoff's outcome as a `[Coop update v1]` comment on it, in
the shape the `azure-devops` skill gives (prefix line, one client-readable sentence,
up to 5 bullets; no SQL, code, paths, secrets or another client's name). Show the
exact comment and post it only on the person's yes; FocusTime's status report reads
it. This comment is the one write `/handoff` may make.

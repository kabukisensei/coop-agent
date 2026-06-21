# /daily-log

Use the `daily-logger` skill.

Append this session's work to **today's** daily log. Use the path from
`.coop/project.yml` → `logging.daily_log_path` (default
`docs/agent/logs/daily/YYYY-MM-DD.md`, where `YYYY-MM-DD` is today's date). Create the
file from the daily-logger template if it doesn't exist; otherwise **append** a new
task block — never overwrite earlier entries.

Capture from this session:

- **Tasks completed** — repo, object/file, summary, docs updated.
- **Source changes prepared for review** (NOT committed) — file, summary, and the
  human action needed.
- **Documentation / logs / site committed** (with approval) — commit + summary.
- **Standards / quality findings** — from `sql_review` / `dax_review` (cite
  file:line + severity), Tabular Editor BPA, or `fabric-cicd` validate.
- **Open questions** and **next suggested actions**.

Commit **only** the log (a `docs:`-style commit) and **only** if the contract allows it
and the user approves. Never commit source. Never write secrets into the log.

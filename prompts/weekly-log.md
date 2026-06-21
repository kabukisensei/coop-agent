# /weekly-log

Use the `daily-logger` skill.

Create or update the **weekly** progress log for the current week. Use the path from
`.coop/project.yml` → `logging.weekly_log_path` (default
`docs/agent/logs/weekly/YYYY-Www.md`), rolling up this week's daily logs
(`docs/agent/logs/daily/*.md`) plus any documentation changes from the week.

Include:

- **Executive summary**
- **Daily highlights**
- **Objects changed** — and their docs / lineage updates
- **Standards / quality issues found** (`sql_review` / `dax_review`, BPA, validate)
- **Risks and open questions**
- **Recommendations for next week**

Commit **only** the weekly log and related documentation (a `docs:`-style commit), and
**only** with approval. Never commit source.

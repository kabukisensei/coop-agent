# Schema compare and promotion

Compare two schemas with the `schema_compare` tool and walk the user through
promoting the differences, nothing applied by the compare itself.

Task: run the compare the user asked for, read the result, and help promote it.

Required steps:

1. Settle the sides before calling the tool. The source is the environment the
   changes were made in (the project file's default dev/test entry unless the user
   names one); the target is where they go (`prod` by default). A side is `dev`,
   `test`, `prod`, `<env>@<set>` for a `sql_targets.named` set (for example
   `dev@lakehouse`), `snapshot` or `repo[:<name>]`. If a side is not a ready
   entry, the tool says `target_invalid`: offer `/setup-project` (or the Project
   pane) to add it, then `/new`; do not guess ids.
2. Call `schema_compare` with the project file's defaults. Add `exclude`,
   `schemas` or `rebuild` only when the user asks for this run. When the result's
   notes say this run's choices differ from the project file's, tell the user
   once and offer to make them the client's defaults in `schema_compare:` of
   `.coop/project.yml` (via `/setup-project` or the Project pane), so everyone
   on the team gets the same differences.
3. Report from the tool result alone: the counts (adds, alters, drops,
   destructive, and how many are formatting or column-order only), then the
   change list the result carries. Do not read `report.md` (it repeats the list
   for people). Call out every destructive change and every rebuilt table (the
   new table is empty: a full load follows). Cosmetic changes still deploy, so
   the two sides end up identical; say so when the user asks whether to skip them.
4. Promoting is the user's call. Open `deploy.sql` only when they want to
   promote; then run it against the target through the governed write path, one
   statement at a time in the script's order, stopping at the first failure. A
   production target needs the production go-ahead and asks per statement; never
   work around that. Never edit `deploy.sql` to skip a statement silently: say
   which statement and why.
5. After the run, offer the follow-ups the result named (a full load for
   rebuilt tables, a model refresh when a view a model loads changed), and a
   second compare to prove the sides match (expect zero differences, or only the
   ones the user chose to leave).

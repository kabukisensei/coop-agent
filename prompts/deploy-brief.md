# Deployment brief

Write the page a reviewer reads before a deployment: what is going out, in plain
English, with the standards check, the downstream impact, who changed what and the
destructive list. Nothing is deployed by this prompt.

Usage: `/deploy-brief` after a `schema_compare` run in this session (the compare's
change list is the input); `/deploy-brief <ref>..<ref>` for a git range of the SQL
repository (for example `main..release/2026-11` or `v1.4..HEAD`); `/deploy-brief`
alone with neither runs the project file's default compare first (`/schema-compare`).

Required steps:

1. Collect the changes. From a compare: the result's change list (object, kind,
   change, action, destructive, cosmetic). From a git range: `git log --format='%h %an %ad %s%n%(trailers)' --date=short <range> -- <scripts folder>`
   and `git diff --stat <range> -- <scripts folder>` (read-only; never pull, never
   check out), one entry per object file. Leave out cosmetic-only changes from the
   prose but count them.
2. For every changed object, read its current text (the repo file, or `sql_source
   diff` where the repo has an `sqlsc.yml`) and write one plain-English paragraph:
   what it does, what the change does, why a reader should care. Group by schema,
   tables first, then views, functions, procedures. No SQL in the prose; a column or
   object name in backticks is enough.
3. Standards: self-check every changed SQL object against the standards articles in
   context, the same check you run before presenting your own SQL. List every rule
   an object does not meet, by object and rule, or say "meets the standards" for the
   set. Never rewrite the object here.
4. Impact: `data_doc` with `command="impact"` for the changed files (or
   `command="lineage"` per object when the docs are built but impact is not
   available): the models, reports and SQL objects downstream. No docs: say so in one
   line and go on (`/setup-docs` builds them); do not trace live for a brief.
5. Who changed what: from `git log` over the range, or `git log -1 --format='%an %ad %s%n%(trailers)' --date=short -- <file>`
   per changed file after a compare: author, date, message, and the `Prepared-by:`
   trailer when coop prepared it. In an sqlsc repo, `sqlsc history -t <target>` for
   the last release to that target. Report what the history says; never guess an author.
6. Destructive and manual steps: copy the compare's DESTRUCTIVE entries, rebuilt
   tables (empty after the deploy, a full load follows) and manual steps, each as one
   line with the object. From a git range with no compare, list every `DROP`,
   dropped column and type change the diff shows.
7. Write `deploy-brief.md` next to the compare output (`.coop/schema-compare/<run>/`),
   or `deploy-brief-<range>.md` under the project's docs home for a git range, in
   this order: a three-line summary (objects changed, destructive count, standards
   deviations count), Changes by schema, Standards, Downstream impact, Who changed
   what, Destructive and manual steps, Not covered (what the brief could not read).
   Show the user the path and the summary. The brief is a document for a person to
   read before they deploy; promoting stays `/schema-compare` step 4.

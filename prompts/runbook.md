# Run a client runbook

Walk one of this client's runbooks, step by step, with the user.

Usage: `/runbook <name>` runs `.coop/runbooks/<name>.md` (beside the committed
`.coop/project.yml`); `/runbook` alone lists the runbooks the client has.

Required steps:

1. Find the runbook. Read `.coop/runbooks/<name>.md` from the folder that holds
   the project file (or the client home repository beside this one). No such
   file: list the `.md` files in that folder and stop. No folder: say the client
   has no runbooks yet and that one is a numbered Markdown list of steps, each
   marked `(manual)`, `(coop)` or `(check)`, committed under `.coop/runbooks/`.
2. Show the plan first: the runbook's title, its steps in order with their
   markers, and which `(coop)` steps will touch which targets (from the project
   file's `sql_targets`). Wait for the user's go before the first step.
3. Walk the steps in the file's order, never skipping or reordering one. A
   `(manual)` step is the user's: state it, wait until they say it is done. A
   `(check)` step: say what to confirm and wait for the answer; a "no" stops the
   runbook. A `(coop)` step: do it with the tools it names (`schema_compare`,
   `fabric_sql_query`, `sql_source`, `data_doc`, the Fabric CLI), under the usual
   guardrails: production writes keep the production go-ahead and per-statement
   approval, dev writes keep their approvals. Report each step's result in one
   or two lines before moving on.
4. A failed step stops the runbook. Say what failed, what already ran, and what
   is left; do not continue past it on your own.
5. At the end, summarize: each step with done / skipped by the user / failed,
   anything the runbook says to verify afterwards, and anything the steps
   showed the runbook itself should change (offer the edit as a diff; the user
   commits it).

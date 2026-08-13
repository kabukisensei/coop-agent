# /slice-next

Use the `coop-workflow` skill.

Plan the next vertical slice for this task. Do not edit anything yet.

State:

- **Goal** — one sentence.
- **Failing check before** — the slice-specific test, SQL/DAX query, measure, linter,
  or review that demonstrates the current problem. Run it before the change to capture a baseline.
- **Smallest safe change** — the exact file(s) and lines.
- **Passing check after** — the same slice-specific test/query/measure/review that will
  prove the fix. State the exact data condition or output that changes.
- **Why this slice now** — dependency order, blast radius, rollback safety.
- **Assumptions I’m making** — data shape, repo state, or behavior this slice relies on.
- **What would prove this slice wrong** — the earliest signal the approach is off.
- **What I’ll watch** — concrete checks to spot drift before the final test.
- **Stop-and-ask triggers** — conditions where I will pause instead of continuing.
- **Live-data test** — if `.coop/project.yml` has `tests.live_data.enabled: true`,
  the specific query/measure/command, workspace, and whether approval is required.

Wait for my approval before making the edit.

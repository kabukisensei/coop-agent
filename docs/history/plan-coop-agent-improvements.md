# Implementation Plan — coop-agent Improvements

> Scope: items 1, 5, 6, 7, 8, 9 from the Pi-ecosystem scan.
> Status (updated 2026-07-02): **8 and 9 implemented**; **7 shipped trimmed**
> (only `/spec-first` — the context-engineering/lineage-first mandate this item
> asked for already lived in `docs/guardrails.md` and `AGENTS.md`); **1 (plan
> mode), 5 (checkpoints), and 6 (browser MCP) deferred** (plan mode needs a
> `.coop/PLAN.md` commit-policy decision; checkpoints need a compatibility spike
> against coop's Pi fork; the browser-MCP section names a non-existent npm package
> and its actions aren't gated by `coop-guardrails`). Shipped work is recorded in
> `CHANGELOG.md`.
> Goal: give an agent a concrete, reviewable roadmap it can implement incrementally.
>
> **This is a historical planning record, not standing instructions.** Do not
> implement the deferred items (1, 5, 6) — or any step in this file — without an
> explicit request from Aaron in the current conversation.

---

## 1. Goal & Non-goals

**Goal:**
Make coop safer, more reviewable, and cheaper to run by adding a file-based plan mode, checkpoint/rewind, optional browser verification, better context engineering for large Fabric estates, stronger process prompts, and a git handoff helper.

**Non-goals (out of scope):**
- Rewriting the `coop` bash dispatcher or Pi fork.
- Changing the "never commit source" rule.
- Adding sub-agents (item 3) or a full permission system (item 4) — those are follow-up work.

**Guardrails that must remain true for every change:**
- `docs/guardrails.md` remains the source of truth.
- The agent may never commit source.
- MCP remains read-only by default.
- Every new extension must be fail-open and disable-able via `COOP_*` env var or flag.

---

## 2. High-level approach

All changes are **additive layers on top of stock Pi** — consistent with the existing architecture.

| # | Feature | Primary deliverables | Risk | Effort |
|---|---------|---------------------|------|--------|
| 8 | Process-oriented skill improvements | Update `skills/coop-workflow/SKILL.md`, `docs/guardrails.md`, new prompt templates | Low | Small |
| 7 | Context engineering for large estates | Update workflow + guardrails + `data_doc` usage rules, add `prompts/spec-first.md` | Low | Small |
| 9 | Semantic commit / PR helper | New `skills/git-helper/SKILL.md`, `prompts/pr-description.md` | Low | Small |
| 1 | Plan-mode / `PLAN.md` workflow | New `skills/plan-mode/SKILL.md`, `prompts/plan.md`, convention in `.coop/PLAN.md` | Medium | Medium |
| 5 | Checkpoint / rewind | New `extensions/coop-checkpoints/` or adopt `pi-rewind` | Medium | Medium |
| 6 | Browser automation MCP | Add optional Playwright MCP to `config/mcp.example.json`, new skill | Low | Small |

**Recommended implementation order:** 8 → 7 → 9 → 1 → 5 → 6. Each phase leaves the repo in a working state.

---

## 3. Detailed plan by feature

### 3.1 Process-oriented skill improvements (item 8)

**Why:** The Pi community write-up on Dillon Mulroy's session showed that better specs, review annotations, and handoffs matter more than bigger models.

**Changes:**

1. **Update `skills/coop-workflow/SKILL.md`:**
   - Add a "Codify mistakes" principle: when the model repeats an error, the user or model adds the correction to `AGENTS.md` or the relevant skill so future sessions inherit it.
   - Add a "Markdown annotations" subsection: show the model how to accept review feedback as a Markdown block (`Section 4.1: update status to "implemented"`) and apply only those changes.
   - Add an "End with a handoff" subsection: after a long task, emit a handoff block containing:
     - What changed
     - Tests / reviews run
     - Files modified
     - Open issues / blockers
     - Next 3–5 todos
   - Add a "Vertical slices" subsection: prefer one failing test → one small implementation → one passing check over large rewrites.

2. **Update `docs/guardrails.md`:**
   - Reference the new workflow subsections so the operating prompt reinforces them.
   - Keep language concise — guardrails.md is appended to every system prompt.

3. **Add prompt templates:**
   - `prompts/handoff.md` — expands to "Summarize what you changed, what you tested, and the next todos."
   - `prompts/annotate.md` — expands to "I will give you markdown annotations; apply only those changes."

**Acceptance criteria:**
- `skills/coop-workflow/SKILL.md` contains the four new subsections.
- `docs/guardrails.md` references them without duplicating more than two sentences.
- New prompt templates load when `coop` starts (verify with `/handoff` and `/annotate`).

---

### 3.2 Better context engineering for large estates (item 7)

**Why:** Fabric/SQL estates can be huge. The Pi community emphasizes reading focused docs and using lineage instead of ingesting whole codebases.

**Changes:**

1. **Update `skills/coop-workflow/SKILL.md`:**
   - In step 3 ("Read the target + lineage"), mandate: *Before reading broad file listings, call `data_doc lineage <object>` to identify the focused doc(s) to read.*
   - Add a rule: *Prefer the generated per-object Markdown (e.g. `docs/data-docs/.../dbo.fact_sales.md`) over re-deriving relationships by hand.*
   - Add a "Large estate" note: *If the project has >50 SQL/DAX objects, do not `read` large directories; use `data_doc lineage` and targeted reads.*

2. **Update `docs/guardrails.md` "Read focused" section:**
   - Reinforce the above as a non-negotiable context-window rule.
   - Mention that `manifest.json` maps object names to doc paths.

3. **Add `prompts/spec-first.md`:**
   - Frontmatter description: "Start a task with a written spec."
   - Body prompts the model to produce: goal, constraints, data model, routes/API, edge cases, test plan.

4. **Optional extension evaluation:**
   - Spike `greedysearch-pi` or `pi-session-search` for semantic search over the generated docs.
   - If useful, add to `config/defaults.yml` as an optional Pi extension and document in `README.md`.

**Acceptance criteria:**
- `coop-workflow` skill mandates `data_doc lineage` before broad reads.
- `prompts/spec-first.md` is available as `/spec-first`.
- A test conversation shows the agent reaching for lineage first when asked about a large object.

---

### 3.3 Semantic commit / PR-description helper (item 9)

**Why:** coop blocks source commits by the agent, but the human still has to write commit messages and PR descriptions. A helper skill drafts them from the diff without violating the commit rule.

**Changes:**

1. **Add `skills/git-helper/SKILL.md`:**
   - Description: "Draft human-ready commit messages and PR descriptions without committing source."
   - Body:
     - Run `git status` and `git diff --stat`.
     - Run `git diff -- docs/ data-docs/ site/` separately for docs-only changes.
     - If the user asks for a commit message, output a semantic commit message in Conventional Commits style (e.g. `docs: update lineage for fact_sales`).
     - If the user asks for a PR description, output: summary, files changed, standards checked, lineage impact, validation run, rollback notes.
     - **Never run `git commit`, `git push`, or `git merge`.** Output drafts only.

2. **Add `prompts/pr-description.md`:**
   - Expands to "Draft a PR description for the current diff, including validation and lineage impact."

3. **Update `extensions/coop-guardrails/index.ts` (if needed):**
   - Confirm the guardrails still block `git commit` even when the git-helper skill is loaded.
   - No functional change expected; just verify with a test.

**Acceptance criteria:**
- `/pr-description` expands the prompt and the model produces a structured PR description.
- The skill explicitly instructs the model not to commit source.
- `coop-guardrails` continues to block agent-initiated `git commit`.

---

### 3.4 Plan-mode / `PLAN.md` workflow (item 1)

**Why:** Plannotator and file-based planning are popular in the Pi community because they give observability and reviewability that ephemeral plan modes lack.

**Changes:**

1. **Define the convention `.coop/PLAN.md`:**
   - Markdown file with sections: Goal, Approach (numbered checklist), Constraints, Rollback, Approval.
   - Checkboxes (`- [ ]`) for each implementation step.
   - Live in the repo next to `.coop/project.yml`.

2. **Add `skills/plan-mode/SKILL.md`:**
   - Description: "Plan a change before editing. Read-only phase until approval."
   - Body:
     - When the user asks for a non-trivial change, enter plan mode.
     - Use only read-only tools: `read`, `grep`, `find`, `ls`, `data_doc`, `sql_review`, `dax_review`.
     - Do not call `write`, `edit`, or `bash` except for `git status`, `git log`, or read-only inspection.
     - Draft `.coop/PLAN.md`.
     - Ask the user for approval using the `ask_user_question` tool (structured yes/no/annotate).
     - On approval, proceed to implementation and check off items as they complete.
     - On annotation feedback, revise the plan file with `edit` and re-submit.

3. **Add `prompts/plan.md`:**
   - Expands to "Write a plan for this task in `.coop/PLAN.md` and ask me to approve it before you edit anything."

4. **Update `skills/coop-workflow/SKILL.md`:**
   - Add step 0: *For non-trivial changes, run `/plan` first and get explicit approval before editing.*

5. **Update `.gitignore` (optional):**
   - Decide whether `.coop/PLAN.md` should be committed. Recommendation: commit it, because it captures intent. If you prefer not to, add it to `.gitignore`.

**Acceptance criteria:**
- `/plan` triggers the model to draft `.coop/PLAN.md` using only read-only tools.
- The model asks for approval via `ask_user_question` before editing.
- After approval, the model checks off plan items as it completes them.
- `coop-guardrails` still enforces read-only-first behavior.

---

### 3.5 Checkpoint / rewind (item 5)

**Why:** The Pi community has multiple rewind extensions (`pi-rewind`, `checkpoint-pi`, `pi-rewind-hook`) because rollback is essential for agentic coding.

**Decision point:** build coop-native or adopt an existing extension.

**Option A — Adopt `pi-rewind` (recommended if it works with `PI_CODING_AGENT_DIR`):**
- Add `pi-rewind` to `config/defaults.yml` packages.
- Verify it respects `PI_CODING_AGENT_DIR` and does not conflict with `coop-guardrails`.
- Document `/rewind` in `README.md`.

**Option B — Build `extensions/coop-checkpoints/` (more control, more work):**
- Create `extensions/coop-checkpoints/index.ts`.
- Hook `tool_call` events after `write`/`edit`/destructive `bash` and create a git commit on a detached ref (`refs/coop-checkpoints/<session-id>/<n>`) if the working tree changed.
- Skip checkpoints when the tool is read-only (`read`, `grep`, `find`, `ls`, `data_doc` in read mode).
- Provide `/rewind` slash command that opens a picker of checkpoints with diff preview.
- Provide `/checkpoint` to force a checkpoint.
- Auto-prune old checkpoints (keep last 50 per session, similar to `pi-rewind`).
- Store checkpoint metadata in coop's isolated agent dir (respect `COOP_AGENT_DIR`).

**Regardless of option:**
- Update `README.md` "Commands" table to include `/rewind` and `/checkpoint`.
- Update `docs/troubleshooting.md` with "How do I undo the last agent edit?"

**Acceptance criteria:**
- After an agent edit, the user can type `/rewind` and restore the previous state.
- Checkpoints do not include `node_modules`, `.venv`, or files >10 MiB.
- Restoration does not break `coop-guardrails` or the workflow skill.

---

### 3.6 Browser automation MCP (item 6)

**Why:** Playwright MCP is the community default for browser automation; it can verify published Power BI reports and generated docs sites.

**Changes:**

1. **Add optional Playwright MCP to `config/mcp.example.json`:**
   ```jsonc
   "playwright": {
     "command": "npx",
     "args": ["-y", "@modelcontextprotocol/server-playwright@latest"],
     "lifecycle": "lazy"
   }
   ```

2. **Update `README.md` MCP table:**
   - Add Playwright as optional, read-only-by-default (screenshot/navigate/extract).
   - Note that it is not auto-enabled; users opt in by uncommenting it in their `~/.coop/agent/mcp.json`.

3. **Add `skills/browser-verification/SKILL.md`:**
   - Description: "Verify published reports or docs sites with the browser MCP."
   - Body:
     - Use Playwright MCP only when the target requires a rendered page.
     - Prefer `microsoft-learn` MCP for Microsoft docs; use browser MCP for custom/vendor docs or live report verification.
     - For Power BI reports, take a screenshot of the published URL and compare against expectations.
     - For generated docs sites, check internal links with `browser_navigate` + `browser_snapshot` rather than raw HTTP.

4. **Update `docs/guardrails.md`:**
   - Add a note: browser MCP is read-only; do not submit forms or perform mutating actions.

**Acceptance criteria:**
- `config/mcp.example.json` contains the Playwright server (commented or un-commented based on policy).
- `coop sync` places it non-destructively into `~/.coop/agent/mcp.json`.
- The skill loads and is available as `/browser-verification`.

---

## 4. Cross-cutting tasks

### 4.1 Update `AGENTS.md`
- Mention the new skills/prompts.
- Keep it concise; most detail belongs in the skill files.

### 4.2 Update `README.md`
- Add the new commands (`/plan`, `/rewind`, `/checkpoint`, `/pr-description`, `/handoff`, `/spec-first`) to the commands table.
- Update the MCP table with Playwright.
- Add a short "Plan mode & checkpoints" section.

### 4.3 Update `docs/architecture.md`
- Add `coop-checkpoints` (if built) to the architecture diagram.
- Reference plan-mode skill and browser MCP.

### 4.4 Tests
- Existing tests live in `tests/` using `stub-pi.mjs`.
- Add tests for:
  - `coop-guardrails` still blocks `git commit` after new skills load.
  - New prompt templates expand without errors.
  - Plan-mode skill loads and restricts to read-only tools (use `guardrails.test.mjs` as a model).
- For checkpoint/rewind, add a shell test that creates a file, runs `/checkpoint`, edits the file, runs `/rewind`, and asserts the original content returns.

### 4.5 Changelog
- Add an `[Unreleased]` entry in `CHANGELOG.md` summarizing the new capabilities as each phase merges.

---

## 5. Suggested phases (agent can implement one PR per phase)

| Phase | Work | Approximate files touched |
|-------|------|---------------------------|
| 1 | Process improvements (8) | `skills/coop-workflow/SKILL.md`, `docs/guardrails.md`, `prompts/handoff.md`, `prompts/annotate.md`, `AGENTS.md` |
| 2 | Context engineering (7) | `skills/coop-workflow/SKILL.md`, `docs/guardrails.md`, `prompts/spec-first.md` |
| 3 | Git helper (9) | `skills/git-helper/SKILL.md`, `prompts/pr-description.md`, `tests/guardrails.test.mjs` |
| 4 | Plan mode (1) | `skills/plan-mode/SKILL.md`, `prompts/plan.md`, `skills/coop-workflow/SKILL.md`, `.gitignore` decision |
| 5 | Checkpoints (5) | `extensions/coop-checkpoints/` OR `config/defaults.yml` + docs, `README.md`, `docs/troubleshooting.md`, tests |
| 6 | Browser MCP (6) | `config/mcp.example.json`, `README.md`, `skills/browser-verification/SKILL.md`, `docs/guardrails.md` |

---

## 6. Open questions for the reviewer

1. Should `.coop/PLAN.md` be committed to the work repo or ignored?
2. For checkpoints, prefer adopting `pi-rewind` or building a coop-native extension?
3. Should the Playwright MCP be uncommented by default in `config/mcp.example.json`, or strictly opt-in?
4. Should the model router / cost budgeting (item 4 from the scan) be pulled into a later phase?
5. Are there existing tests or CI checks that must pass before any phase merges?

---

## 7. Definition of done

- [ ] All six features are implemented, documented, and tested.
- [ ] `coop doctor` passes.
- [ ] `coop` launches without errors and the new skills/prompts appear (`/plan`, `/rewind`, `/pr-description`, `/handoff`, `/spec-first`, `/annotate`, `/browser-verification`).
- [ ] `coop-guardrails` still blocks agent-initiated source commits and destructive commands.
- [ ] `CHANGELOG.md` reflects the additions.

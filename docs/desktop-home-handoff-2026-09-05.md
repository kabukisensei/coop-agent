# Coop Desktop — home/laptop handoff

Prepared September 5, 2026. Status: development branch, not release-ready.

## Where the work lives

- Agent: `/Users/aaronjennings/Developer/coop-agent-desktop`
- Branch: `feature/coop-desktop-platform`
- Companion worktrees: `coop-data-doc-desktop`, `coop-sql-review-desktop`,
  `coop-dax-review-desktop`, beside the agent worktree.
- Full package plan: `COOP_DESKTOP_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md`.
- Daily evidence/history: `docs/agent/logs/daily/2026-09-05.md`.

Changes are uncommitted and include many new files. Preserve this worktree; do
not reset, clean, stash, merge, or install it over existing Coop. The installed
terminal experience and original checkouts have not been modified by this work.
No commit, push, release, or signing operation has been authorized or performed.

## What changed in the offline follow-up

1. Desktop workspace selection now performs `/chdir` through the authenticated
   shell/runtime boundary. It saves the runtime-confirmed path only after success.
   Cancel/rejection retain the previous workspace. Shell restart and close now
   use the accepted workspace rather than the initial project.
2. Saved window bounds are fitted to connected display work areas so a removed
   monitor does not leave the title bar off-screen.
3. Stop and workspace-conflict danger buttons use a dedicated theme text token.
   Contrast checks now include danger buttons in all three themes.

Source files in this slice:

- `desktop/src/workspace-selection.mjs` (new)
- `desktop/src/main.mjs`
- `desktop/src/preload.cjs`
- `desktop/src/desktop-state.mjs`
- `web/public/app.js`
- `web/public/style.css`
- `tests/desktop-preview-shell.test.mjs`
- `tests/theme-system.test.mjs`

Before-edit copies are under `.backups/20260905-offline-review/`. These backups
cover this slice, not every earlier change in the branch. Do not restore them
over subsequent work without reviewing the diff.

## Tested

- Desktop preview shell: 11 tests pass, including successful/cancelled/rejected
  workspace selection and monitor-removal window restoration.
- Themes: 5 tests pass, including selected semantic text colors and danger-button
  contrast. These are code checks, not a full visual/accessibility audit.
- PowerShell behavioral suite passes on macOS after these edits.
- Bash/PowerShell parity and UTF-8 BOM checks pass; diff whitespace checks pass.
- Full Bash regression passes after these edits, including 272 Web bridge tests
  and 44 protocol contract tests.
- Earlier inventory-bearing macOS runtime smoke passed startup, authenticated
  capabilities/version checks, and clean shutdown. That bundle predates this
  offline UI slice and does not prove the new UI behavior.

The release gate still reports 46 unfinished required capability rows out of 47.
Many have implementations and unit tests, but lack complete platform/journey
evidence. A green unit suite does not mean Desktop 1.0 is complete.

## Architecture/performance follow-up

- Added `web/sse-writer.mjs`: both event streams now stop writing to a response
  while it signals backpressure, flush queued frames in order on drain, and
  disconnect a client whose outstanding frame bytes exceed 32 MiB. Other clients
  and Pi continue independently. Heartbeats and initial replay use the same writer.
- `tests/runtime-domain.test.mjs` now covers ordered drain, queued plus socket
  byte accounting, UTF-8 size, disconnection and independent healthy clients.
  Focused runtime-domain checks pass (7 tests). Full Bash regression and PowerShell
  behavioral suites pass on macOS; native Windows and saturation stress evidence
  remain outstanding.
- Reconnect now explicitly replays the current renderer session without changing
  the selected chat, using existing live/replay deduplication. A VM test verifies
  missed approval replay. Domain SSE resumes from the newer valid query/header
  cursor rather than treating an absent query as an overriding zero.
- This is a per-client transport limit, not a total runtime memory bound. Event
  replay, artifacts, transcript DOM and tool processes still need separate budgets.
  Very large replay/reconnect under sustained saturation needs a real stress test.
- Next offline performance work: byte-budget retained events/artifacts, cache and
  asynchronously build knowledge/history indexes, then incrementally render long
  responses and virtualize old transcript entries. Preserve approval state and
  raw artifact access during any eviction policy changes.
- Next architecture work: extract shared runtime services and renderer modules
  from the large server/app files. Retire only the browser client after Desktop
  acceptance; avoid a framework rewrite as a performance shortcut.
- Add repeatable cold/warm startup, idle/active memory, four-session, large-diff,
  large-lineage, long-transcript, reconnect and shutdown benchmarks. Measure on
  representative Windows VMs and macOS before setting release budgets. Earlier
  shell-spike figures are not measurements of the current managed app.

## Themes and UI direction

Modern Light, Modern Dark, and Retro Messenger already share the same components
and capability model. Retro uses messenger-era fonts, surfaces, and beveled
controls. It needs an actual visual review before deciding how strongly to lean
into the AIM/ICQ-era feel; no proprietary logos/assets are required.

Prioritize a visible client/environment label, active session and authentication
state, pending approvals, a searchable command palette, and reviews/lineage beside
chat. Preserve readable code, clean copying, keyboard operation, and identical
workflow semantics in every theme. Optional sounds should default off.

The user no longer needs the browser product after Desktop is complete. Retire
the browser client only after Desktop acceptance; retain and relocate its shared
renderer/runtime code rather than deleting `web/`, which Desktop currently uses.
Terminal remains a first-class client with tested capability parity.

## Installation today

Preview development requires an existing compatible Coop installation and local
Electron development dependencies. Package scripts currently produce unpacked
unsigned applications (`dir` targets), not a Windows installer or macOS DMG.

Managed packaging can include pinned Node/Pi, isolated Python companion tools,
and Coop resources. The newly verified bundle is currently at
`/private/tmp/coop-managed-rel001-inventory-check/managed-runtime`. Temporary build
directories may disappear; they are not durable installation artifacts.

Managed Desktop uses its own agent directory. Signed installers, notarization,
production update keys/hosting, real installer activation/rollback, and clean
Windows installation remain unfinished. Do not install this branch for clients.
Existing `desktop/dist*` binaries are stale relative to this handoff's source;
rebuild before testing the fixes in a packaged application.

## Open issues and blockers

- Mac locked: screenshots and interactive Desktop tests could not run.
- Managed agent storage is version-specific with no supported migration yet.
  Credentials/settings/history continuity across upgrades must be solved and
  tested without directly manipulating Pi credential or session files.
- Full conversational onboarding remains incomplete in terminal and Desktop:
  description → authorized discovery → ambiguity selection → config preview →
  approved atomic write → Doctor. Existing services alone do not prove this flow.
- Six of 507 npm inventory entries lack integrity hashes. Inventory is explicit
  about the gap; full reproducible dependency acquisition is not established.
- Native Windows clean/managed VM evidence, signed installation, updater UI,
  accessibility and clipboard interoperability remain release gates.
- Latest hardened packaged GUI startup has not been established; an earlier
  launch exited 137. A successful headless runtime smoke does not resolve that.

## Next five steps when home

1. Unlock the Mac. Rebuild/start the current preview in isolated test state,
   first with stub Pi. If the packaged process exits, collect its exit/log
   evidence before moving to feature checks.
2. Capture Light, Dark and Retro screens: Mission Control, conversation, tools,
   approval, diff, findings, lineage, settings. Check 100%/150% zoom, keyboard
   focus, long paths, empty/error states and reduced motion.
3. Switch from workspace A to B; cancel another switch; try a rejected switch;
   close/reopen and crash/restart. Confirm the accepted workspace is restored.
   Repeat with multiple sessions, since changing a session cwd is not the same
   as moving every session to a new workspace.
4. Paste a screenshot, remove it, paste SQL/DAX preserving whitespace, copy a code
   block, and test fork/clone/terminal handoff in a disposable workspace. Use
   real login only through supported provider UI with the user present.
5. Resolve migration/onboarding gaps, rebuild managed packages, and run native
   Windows/macOS acceptance and rollback journeys. Only then review release
   parity and prepare a merge/release proposal for explicit approval.

No visual sign-off or production-ready claim has been made. No unattended
reminder or future background run has been scheduled.

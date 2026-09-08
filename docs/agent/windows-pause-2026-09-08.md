# Windows validation pause — 2026-09-08

User requested a stable checkpoint and pause to conserve usage. Native acceptance remains incomplete.

This checkpoint combines Windows Git worktree path fixes, updater owner PID/creation identity, restricted helper environment, and regression corrections. The implementation snapshot before this note was tree `d82d45b240ce00c3666f2a4cc4beb6a96cd83b63`, based on `7ffc38fd1f86086910a918d23f0dfb4277072fa6`.

Focused verification passed: workspace isolation (11), web bridge (286), native long-path reproduction, Windows helper environment (48 assertions in the earlier focused suite), owner identity/replacement checks, platform parity/BOM and whitespace. The combined full Git Bash run was intentionally interrupted at the user's pause request; PowerShell 5.1 and 7 had not started. This is a partially verified development checkpoint, not a completed acceptance build.

The guarded automatic commit/push process and test driver were stopped explicitly before making this checkpoint. Do not resume those old scripts: their exact-parent/tree guards and exclusive log paths describe the interrupted run. Start a new numbered full-suite run when resuming.

Installed isolated candidate remains source `7ffc38fd1f86086910a918d23f0dfb4277072fa6`, at `D:\CoopDesktopWindowsValidation-20260907\interaction-installed-v1`. Its three source suites, managed analysis checks, NSIS upgrade and installed startup/shutdown probe passed. Installer SHA256: `79B163BBD08D22595EB82D9E78CB2EDB59A196E90BD8FEFA6C0D518620ED866E` (367003052 bytes).

Actual GUI passed model work, Approve/Decline/custom Unicode/Dismiss, Stop of exact parent and child processes, subsequent Python tests, history restoration and a second read-only chat. Creating an isolated writable worktree failed in that installed version; the fix in this checkpoint requires a new package and GUI retest.

Resume with full source checks, then a fresh isolated managed build and installer. Remaining native journeys include worktrees/multiple writable chats, governed writing, queue/steering, crash recovery, final reviews/clipboard/attachments, terminal handoff, synthetic Power BI end-to-end, accessibility/DPI, multi-chat shutdown, installer repair/uninstall, and full Windows update orchestration/recovery/rollback. Owner identity and environment changes alone do not complete updates.

VM evidence and the 74-item acceptance ledger are under `C:\Users\quiddity\Documents\Codex\2026-09-07\goal-get-coop-desktop-working-and\outputs`. Read `windows-pause-2026-09-08.md` there first for the final commit and local state. Keep the existing validation profile in place; do not copy credentials or repeat sign-in unnecessarily. Original Coop and business workspaces remain outside the authorized test scope. No release, main merge or version tags are authorized.

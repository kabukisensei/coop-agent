# Windows managed-worktree validation

The installed validation app did not open a second chat after selecting Create
isolated worktree. A disposable native repository reproduced the failure in
`createManagedWorktree`. Its generated checkout root was 257 characters long:
Git exited 128 with `Filename too long`; enabling `core.longpaths` alone still
exited 128 with `$GIT_DIR too big`.

Windows now omits the redundant 64-character repository bucket from new managed
checkout paths. Opaque worktree IDs already have agent-wide unique records. The
same native fixture now creates, inspects and removes a 192-character checkout.
Existing records retain their paths and the same bounded cleanup validation.
macOS keeps its existing directory layout.

Workspace Git operations also pass `-c core.longpaths=true` on Windows to support
nested tracked files. This changes neither repository nor global Git settings.
The native regression uses a real UUID, a long profile path, and a tracked Unicode
file whose checked-out path exceeds 260 characters. It checks content, worktree
inspection, clean removal and preservation of the fixture's original Git setting.
`node tests/workspace-isolation.test.mjs` passed all 11 checks on Windows.

A separate full-suite failure exposed a timing assumption in the multi-chat SSE
test. Its 1600-ms observation included chat creation and an arbitrary initial
sleep. The test now establishes the subscription before triggering creation,
retains frames emitted during creation, then observes delivery for the same
1600 ms. It requires a real notification containing both chat IDs, rather than
selecting the first possibly older notification. Full-suite and installed-app
evidence must be recorded separately; this source change does not establish
that the already installed artifact contains the fix.

# ADR: Coop Desktop shell and shared runtime

- **Status:** Accepted; Electron selected by DSK-011 spike
- **Date:** 2026-09-04
- **Decision owners:** Coop maintainers
- **Supersedes:** The native-desktop exclusion recorded in `docs/ui-strategy.md`

## Context

Coop already has a governed Pi launch path, a terminal client, a localhost Web
client, deterministic review tools, project contracts, setup protocols, and
guardrails. A Desktop client can reduce entry and workflow friction, but it must
not become a second agent implementation or a second source of domain truth.

The previous UI strategy deliberately stopped at `coop web` to avoid the cost of
native packaging. That decision was appropriate for the earlier product stage.
The product direction now requires signed distribution, native onboarding,
session and workflow views, richer review and lineage views, and a managed path
for consultants who should not need terminal setup knowledge.

## Decision

### One engine, three first-class clients

The terminal, Web, and Desktop clients consume the same governed Coop Core and
Pi runtime.

- The terminal remains the complete power-user experience and permanent escape
  hatch.
- `coop web` remains the lightweight localhost/browser client.
- Coop Desktop adds native lifecycle, packaging, onboarding, and richer
  engineering-workbench presentation.

No capability's business logic may originate only in Desktop, Web, or terminal
presentation code. Client-specific code may format, visualize, and collect
inputs for a capability whose implementation and contracts live in Coop Core or
an authoritative companion tool.

### Supported runtime boundary

Coop exposes the supported, shell-neutral `coop runtime` entry point. Web and
Desktop start this installed command rather than addressing a repository file.

The runtime will:

- consume `coop launch-spec --json` rather than copy or reconstruct Pi arguments;
- start Pi in RPC mode with `-a` so project trust and governed resources load;
- supervise Pi processes and clean them up on shutdown;
- validate and normalize the checked-in Pi protocol while retaining redacted raw
  diagnostics;
- expose versioned commands, results, capability availability, health, and
  reconnectable events;
- own session leases, replay, workspace file access, and Git-read services; and
- adapt authoritative SQL Review, DAX Review, BPA, and Data Doc contracts without
  reimplementing their analysis.

HTTP/SSE remains the Web transport. The Desktop spike will select one private
Desktop transport, but both adapters must use the same runtime services and
domain schemas. The Electron renderer must never talk directly to Pi, the shell,
or arbitrary filesystem paths.

### Shell selection

Electron is selected for the production-oriented Desktop preview because the
existing bridge is Node-based, the UI is browser-compatible, and one Chromium
renderer reduces Windows/macOS variance. Tauri remains a viable future
alternative, but its measured footprint advantages did not offset its Rust/native
build graph, platform-WebView variance, and Windows-native packaging needs for
this codebase. The measurements and complete rationale are recorded in
`docs/adr/desktop-shell-spike-results.md`.

The final choice is made only after both spikes can:

1. launch the exact governed launch specification;
2. host the existing SPA without changing its behavior;
3. stream a stub-Pi response and render an extension confirmation;
4. choose a workspace through a native folder dialog;
5. render the existing Changes view;
6. shut down every child process cleanly;
7. demonstrate a narrow, allowlisted renderer API; and
8. produce unsigned Windows and macOS development packages with recorded startup,
   memory, build, and maintenance measurements.

The spike applied the rule above and selected Electron. Shell-neutral runtime and
renderer contracts remain mandatory so this decision can be revisited without
rewriting Coop Core.

### Renderer authority

The renderer is treated as untrusted presentation code.

- No Node integration, general shell bridge, or unrestricted filesystem API.
- Context isolation and renderer sandboxing are mandatory.
- IPC methods are individually named, schema-validated, and sender-validated.
- Navigation, new windows, external links, and local paths are denied by default
  and opened only through allowlisted operations.
- Third-party tool output always has a generic structured renderer. Desktop v1
  does not execute third-party renderer JavaScript.
- Approval views redact secret-bearing arguments while retaining an auditable
  operation identity. Timeouts and unknown approval methods fail closed.

### State ownership

- Project and governance state remains in `.coop/project.yml`.
- Data Doc owns `coop-data-doc.yml` and its setup and resolution protocols.
- Pi and existing providers own sessions, model credentials, and private memory.
- Desktop-only window, layout, theme, and recent-workspace state lives under a
  Desktop-specific user directory and never enters project contracts.
- Team and project knowledge remains separate from private memory and requires
  explicit human review before promotion.

Desktop, Web, and terminal must not write one Pi session concurrently. Desktop
must not read, edit, or synthesize Pi session JSONL or credential files to create
missing behavior.

This invariant is implemented by the bundled Coop extension, which participates
in Pi's public session lifecycle in every client. Atomic directory acquisition,
nonce ownership, heartbeats, process identity, and conservative stale recovery
live below the presentation layer. Explicit session switches are preflighted;
startup races fail closed. Terminal `open`, `clone`, and `move` are prepared by
the runtime as fixed `coop` launch requests. A move uses Pi's graceful shutdown
path and does not authorize the native shell until the session lease is released.
The OS-specific terminal launch remains a Desktop-shell responsibility.

### Parity definition

Parity is divided into three explicit tiers:

1. **Required Coop Core parity:** every supported Coop capability must have a
   tested Desktop presentation or an approved, visible platform limitation.
2. **Supported Pi RPC parity:** supported Pi RPC operations used by Coop must be
   exposed through the shared runtime and tested.
3. **TUI-only extension behavior:** arbitrary third-party TUI-only extensions may
   retain a terminal fallback and are not described as Desktop-native.

A machine-readable parity manifest references capability IDs and test IDs. It
does not duplicate capability definitions. Marketing and release jobs consume
the generated parity report.

### Development and rollout isolation

Desktop development begins in `coop-agent` under the dedicated
`feature/coop-desktop-platform` worktree/branch. Development must not alter the
normal `coop` or `coop web` startup path unless a work package explicitly changes
and tests that behavior.

Development builds use a distinct application identity, state directory, update
channel, and test session/workspace data. No Desktop work authorizes a commit,
push, release tag, package publication, stable-channel update, or production
access.

Companion-tool correctness fixes are developed and verified in their own
repositories and may be released independently. Desktop consumes their public,
versioned contracts.

## Invariants

The following are release-blocking:

1. CLI remains first class and behaviorally intact.
2. Pi is not forked or imported as a private in-process implementation.
3. Pi launch arguments come only from the shared launch-spec builder.
4. `-a` remains present for every governed RPC launch.
5. Session JSONL and credential files are never manipulated directly.
6. Deterministic review and lineage logic remains in its source tool.
7. Partial evidence cannot be presented as a clean pass.
8. Renderer authority remains narrow and allowlisted.
9. Session and checkout ownership prevent concurrent writers.
10. Existing Web, Bash, and PowerShell gates remain green.

## Consequences

### Positive

- Coop behavior converges across clients instead of being copied.
- Desktop can evolve without weakening or replacing the terminal product.
- Tool results remain reproducible against their CLI fixtures.
- Shell choice can be revisited without replacing Coop Core.
- Development and release rollback remain straightforward.

### Costs

- The runtime, schemas, leases, and capability registry must be stabilized before
  substantial Desktop presentation work.
- Native packaging, signing, updates, and Windows/macOS validation become owned
  operational responsibilities.
- Pi upgrades require explicit protocol revalidation.

## Rejected alternatives

- **A second Desktop agent engine:** rejected because governance and behavior
  would diverge.
- **Forking Pi:** rejected because it creates an unnecessary merge and security
  burden.
- **Copying `web/server.mjs` into a Desktop repository:** rejected because it
  duplicates runtime ownership.
- **Direct session-file or auth-file manipulation:** rejected because it bypasses
  supported lifecycle and integrity semantics.
- **Implementing SQL/DAX/lineage rules in the renderer:** rejected because it
  creates conflicting sources of truth.
- **Treating terminal handoff as core Desktop parity:** rejected for Coop-owned
  capabilities; terminal fallback is limited to declared TUI-only behavior and
  platform limitations.

## References

- `docs/architecture.md`
- `docs/ui-strategy.md`
- `docs/coop-web-plan.md`
- `docs/coop-web-pivis-plan.md`
- `docs/tool-contract.md`
- `docs/guardrails.md`
- `web/README.md`
- `config/release-manifest.json`

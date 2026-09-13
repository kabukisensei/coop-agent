# Coop Desktop shell spike results

- **Date:** 2026-09-04
- **Work package:** DSK-011
- **Decision:** Electron for the production-oriented Desktop preview
- **Revisit trigger:** managed distribution evidence shows Electron's footprint is a material adoption blocker, or Tauri can remove its second build/runtime-supervision stack without losing Windows/macOS parity

## Scope and method

Both spikes host the existing Coop Web SPA and start only the supported command:

```text
coop runtime --transport http --json --port 0 --cwd <workspace>
```

Neither shell builds Pi arguments, imports Pi, or accesses session/auth files.
Each shell validates the versioned `runtime.ready` event, requires an HTTP
endpoint on `127.0.0.1`, passes the one-time token to the existing SPA, restricts
navigation to the selected runtime origin, and owns cleanup of its runtime child.

The same development harness launched each packaged macOS app against the real
Coop Runtime/Web bridge and checked-in stub Pi. Readiness was the existing SPA's
successful request for `/git/changes`, after its initial RPC calls and extension
events. The measurements below are single-sample architecture-spike observations,
not performance guarantees.

## Results

| Measure | Electron 44.2.0 | Tauri CLI 2.11.2 / crate 2.11.x |
|---|---:|---:|
| macOS app bundle | 291 MB | 12 MB |
| Windows x64 unpacked development bundle | 373 MB | Not cross-produced from macOS; requires a Windows/native build runner |
| Aggregate idle RSS on macOS | 528,048 KiB (~516 MiB) | 211,808 KiB (~207 MiB) |
| Launch to existing Changes request | 1,154 ms | 1,390 ms |
| Shell implementation | 186 lines JavaScript across main/preload/supervisor | 179 lines Rust plus Cargo/Tauri configuration |
| Direct package-manager surface | Electron + electron-builder (284 audited npm packages) | Tauri CLI plus 489 locked Rust packages and `rfd` |
| Local build cache observed | 101 MB `node_modules` | 14 MB `node_modules`, 1.5 GB Cargo target, and 630 MB temporary Rust/Cargo toolchain/cache |
| Existing SPA and stub-Pi stream | Passed | Passed |
| Changes view request | Passed | Passed |
| Extension UI events | Passed | Passed |
| Clean child shutdown | Passed | Passed |

The native folder-picker methods are implemented and constrained in both spikes.
The host Mac was locked during the run, so interactive dialog and screenshot
inspection remain manual verification items. This does not change the runtime,
packaging, or process-cleanup measurements.

## Security boundaries demonstrated

Electron uses a sandboxed renderer with Node integration disabled, context
isolation enabled, permission requests denied, new windows/webviews denied,
same-origin navigation, exact frame/origin validation, and only two named preload
methods. It does not expose a generic IPC invoke, shell, or filesystem bridge.

Tauri registers only `choose_workspace` and `shell_info`, uses no shell plugin or
general filesystem permission, limits its remote capability to loopback, validates
the runtime origin/token, applies a 20-second and 64-KiB ready-handshake bound, and
kills/reaps the runtime on handshake failure or application exit.

Both are spike implementations. Signing, updater trust, external-link policy,
schema validation for every production native method, Windows job-object cleanup,
and production CSP/fuse/capability hardening remain DSK-012/REL work.

## Decision rationale

Tauri clearly wins package size and idle memory. It also introduces a Rust
toolchain, a large native dependency graph, a second language implementation of
the shell/runtime handshake, platform-WebView variation, and a Windows-native
packaging requirement. Those costs are material in this Node-based runtime and
browser-based UI codebase.

Electron reached both macOS and Windows x64 development packages from the current
host, reuses the existing JavaScript runtime concepts directly, and provides one
Chromium behavior to validate across Windows and macOS. Its startup result was
also slightly faster in this sample. Under the ADR's rule that Tauri must achieve
parity without introducing more complexity than it removes, Tauri did not clear
the selection gate.

Electron is therefore selected for the Desktop preview. The renderer remains a
web client of shell-neutral Coop Runtime contracts, so this choice does not make
Electron part of Coop Core and can be revisited later.

## Reproduction

```text
cd desktop/spikes/electron
npm install
npm run package:mac
npm run package:win

cd ../tauri
npm install
npm run build:mac

node scripts/measure-desktop-shell-spike.mjs electron
node scripts/measure-desktop-shell-spike.mjs tauri
node --test tests/desktop-shell-spike.test.mjs
```

Rust was installed into a temporary path for the spike and was not added to the
user's shell profile or normal Coop installation.

The initial Electron packaging pin produced a 12-item advisory report in
build-time dependencies. Both the retained spike and production-preview package
were moved to electron-builder 26.15.3; `npm audit` then reported zero known
vulnerabilities. The packaged renderer has no production npm dependencies.

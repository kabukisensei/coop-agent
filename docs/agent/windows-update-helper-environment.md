# Windows update helper environment

The private update handoff now supplies native Windows system and profile paths
instead of the macOS-only search path. Environment keys are read without case
sensitivity. The helper receives a fixed OS search path and command interpreter,
and launches with `windowsHide: true`. Provider credentials, `NODE_OPTIONS`, and
the caller's arbitrary executable search path are not inherited. macOS keeps its
existing restricted environment.

`node tests/update-service.test.mjs` covers missing/relative system roots,
case-insensitive locations, exclusion of execution overrides, unchanged macOS
behavior, and real Node IPC preparation, cancellation and apply. On Windows, the
real child also executes system PowerShell and confirms an explicit synthetic
environment sentinel was not inherited. All 48 focused checks passed on the
native Windows VM on 2026-09-08.

This is a helper-launch component fix. It does not enable the complete Windows
updater. The application still needs an externally staged trusted helper/runtime
to avoid locking the installed payload, Windows orchestration and startup gates,
independent recovery scheduling, retention, and actual signed development update
and rollback acceptance. Full source suites and installed update acceptance must
be recorded separately from this focused result.

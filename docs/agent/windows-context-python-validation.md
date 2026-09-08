# Managed context Python execution

Windows context-mode 1.0.169 probes Python with a quoted command. With only
`python/bin` on PATH, the managed `.cmd` shim fails that probe. Ordinary unquoted
shell execution may still work, so it does not demonstrate context-tool health.

Windows staging now puts `python/runtime` before `python/bin`. The native
`python.exe` is available to both runtime discovery and direct process spawning.
The terminal launchers retain the command shims; macOS executable paths are
unchanged.

`scripts/verify-managed-runtime.mjs` also runs
`scripts/verify-managed-context-work.mjs`. This calls the bundled context-mode
file executor with a synthetic numbers file, checks its computed total, and
asserts that Python reports the bundled executable. The check uses a disposable
home and only the managed executable directories plus operating-system tools.
It runs without model credentials and is included in existing managed CI checks.

The native VM reproduced failure with the old installed bundle's PATH and
success with the additional runtime directory. Installed GUI retesting after
restaging and packaging is still required; this check alone is not GUI acceptance.

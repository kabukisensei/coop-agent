// Test-only stub for the `typebox` module that Pi provides at runtime. coop-tools
// builds its tool-parameter schemas at module load (Type.Object/Union/...); the tests
// only exercise the pure data-doc helpers, so every Type.* call just needs to not
// throw. Aliased in via esbuild --alias:typebox=… by tests/run.sh.
const noop = () => ({});
export const Type = new Proxy({}, { get: () => noop });

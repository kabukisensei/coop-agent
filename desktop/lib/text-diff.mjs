// The line diff now lives in lib/text-diff.mjs, shared with the change history
// (lib/action-history.mjs, CW2); the window keeps importing it from here.
export { unifiedDiff } from "../../lib/text-diff.mjs";

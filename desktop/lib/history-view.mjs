// Change history (FEATURES-DESIGN CW2) for the Changes pane's History view:
// this repository's recorded changes and one change's diff, read-only, from the
// store lib/action-history.mjs keeps under <profile dir>/history. Nothing here
// writes; Restore in the pane only fills the prompt with /history restore <id>.
import { entryDiff, findEntry, readEntries, storeFor } from "../../lib/action-history.mjs";

export const HISTORY_ROWS = 200;
const OFF = "Change history is off for this client (Settings, Features).";

/** True only when the window's feature view says Change history is on. */
export function historyOnIn(view) {
  return Boolean(view) && view.ok !== false && Array.isArray(view.features) && view.features.some((f) => f && f.key === "history" && f.on === true);
}

/** The rows for the repository holding `dir`: { success, data: { repoRoot, entries } }. */
export function historyRows(dir, { on, env = process.env, limit = HISTORY_ROWS } = {}) {
  if (!on) return { success: false, error: OFF };
  const { repoRoot, store } = storeFor(dir, env);
  const entries = readEntries(store, { limit }).map(({ id, ts, session, tool, target, approval, result, kind, excluded, before }) =>
    ({ id, ts, session, tool, target, approval, result, kind, excluded: excluded || "", created: before === "absent" }));
  return { success: true, data: { repoRoot, entries } };
}

/** One change's diff: { success, data: { diff } } or { success, data: { error } } for a change with none. */
export function historyDiff(dir, id, { on, env = process.env } = {}) {
  if (!on) return { success: false, error: OFF };
  const { store } = storeFor(dir, env);
  const entry = findEntry(store, id);
  if (!entry) return { success: false, error: "that change is not in this repository's history; refresh it" };
  if (entry.kind !== "file") return { success: true, data: { error: "Not a file edit (a live change or a command), so there is no diff here and it is not restorable here." } };
  if (entry.excluded) return { success: true, data: { error: `Its content was not kept (${entry.excluded}), so there is no diff to show.` } };
  const diff = entryDiff(store, entry);
  if (diff === null) return { success: true, data: { error: "Its stored content is gone (removed by the cleanup?)." } };
  return { success: true, data: { diff } };
}

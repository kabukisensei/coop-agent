// Persist only the workspace accepted by the runtime, never a picker candidate.
export async function selectRuntimeWorkspace({ sid, choose, change, accept }) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(sid || "")) throw new Error("Invalid workspace session.");
  const dir = await choose();
  if (!dir) return null;
  const result = await change({ dir, sid });
  if (typeof result?.cwd !== "string" || !result.cwd) throw new Error("Runtime did not confirm the workspace.");
  await accept(result.cwd);
  return result.cwd;
}

import { inspectMacReplacement } from "./update-replacement.mjs";

export async function canStartMacApplication({ appPath, probe = false, parentPid = process.ppid, inspect = inspectMacReplacement } = {}) {
  const state = await inspect({ appPath });
  if (!["copying", "ready", "testing"].includes(state.status)) return true;
  // Only the updater's direct native-health child may start while activation is
  // pending. Merely setting the probe environment variable does not bypass this.
  return probe === true && parentPid === state.ownerPid;
}

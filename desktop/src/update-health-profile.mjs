import { lstat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

// Only discard the directory created by this invocation. Never sweep profiles
// left by failed/interrupted checks, or follow a replaced parent/profile path.
export async function createHealthProfile(versionRoot, kind) {
  if (!["runtime", "native"].includes(kind)) throw new Error("Unknown health profile kind.");
  const parent = await lstat(versionRoot);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Health profile root must be a directory.");
  const path = await mkdtemp(join(versionRoot, kind === "native" ? ".native-health-" : ".health-"));
  const original = await lstat(path);
  return { path, async discard() {
    try {
      const currentParent = await lstat(versionRoot), current = await lstat(path);
      if (currentParent.dev !== parent.dev || currentParent.ino !== parent.ino || currentParent.isSymbolicLink() ||
          current.dev !== original.dev || current.ino !== original.ino || current.isSymbolicLink()) return false;
      await rm(path, { recursive: true });
      return true;
    } catch { return false; } // Cleanup must never change the health result.
  } };
}

export async function waitForProbeGroupExit(pid, { timeoutMs = 1000 } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { process.kill(-pid, 0); }
    catch (error) {
      if (error.code === "ESRCH") return true;
      // An exiting macOS Electron group can briefly reject signal 0. EPERM
      // still means unconfirmed exit: retry within the same bounded deadline.
      if (error.code !== "EPERM") return false;
    }
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

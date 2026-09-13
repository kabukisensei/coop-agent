import { lstat, readdir, rm } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readRecoveryRecord, recoveryPaths } from "./update-recovery-worker.mjs";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const runs = new Map();
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function recoveryJobIsIdle(paths, { uid = process.getuid?.(), run = spawnSync } = {}) {
  if (!Number.isSafeInteger(uid)) return false;
  // A saved plist could launch the worker at the next login even if unloaded now.
  try { lstatSync(paths.plist); return false; } catch (error) { if (error.code !== "ENOENT") return false; }
  const service = run("/bin/launchctl", ["print", `gui/${uid}/${paths.label}`], { stdio: "ignore", timeout: 3000 });
  // launchctl's explicit service-not-found status; errors are not proof of idle.
  if (service.error || service.status !== 113) return false;
  const processes = run("/usr/bin/pgrep", ["-f", escapeRegex(paths.root)], { stdio: "ignore", timeout: 3000 });
  return !processes.error && processes.status === 1;
}

async function prune({ userData, home, isIdle }) {
  const parent = join(userData, "update-recovery");
  const removed = [];
  let parentStat;
  try { parentStat = await lstat(parent); } catch (error) { if (error.code === "ENOENT") return { removed }; throw error; }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return { removed };
  const completed = [];
  for (const name of await readdir(parent)) {
    if (!UUID.test(name)) continue;
    const root = join(parent, name), requestPath = join(root, "request.json");
    try {
      const stat = await lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const record = await readRecoveryRecord(requestPath);
      if (record.userData !== userData || record.phase !== "finished") continue;
      const paths = recoveryPaths(requestPath, record, home);
      const receipt = await lstat(requestPath);
      completed.push({ paths, stat, receipt, record: JSON.stringify(record) });
    } catch { /* Unknown or incomplete state remains available for recovery. */ }
  }
  completed.sort((a, b) => b.receipt.mtimeMs - a.receipt.mtimeMs || a.paths.root.localeCompare(b.paths.root));
  // Keep the most recent completed recovery for diagnosis. Pending jobs never
  // enter this list, and running/registered jobs are retained independently.
  for (const item of completed.slice(1)) {
    try {
      if (!await isIdle(item.paths)) continue;
      const currentParent = await lstat(parent), current = await lstat(item.paths.root);
      if (currentParent.dev !== parentStat.dev || currentParent.ino !== parentStat.ino ||
          current.dev !== item.stat.dev || current.ino !== item.stat.ino || current.isSymbolicLink()) continue;
      if (JSON.stringify(await readRecoveryRecord(item.paths.requestPath)) !== item.record) continue;
      // rm removes contained symlinks themselves, never their external targets.
      await rm(item.paths.root, { recursive: true });
      removed.push(item.paths.root);
    } catch { /* Cleanup is best effort; never turn it into a startup failure. */ }
  }
  return { removed };
}

export function pruneCompletedRecoveryJobs({ userData, home = homedir(), platform = process.platform, isIdle = recoveryJobIsIdle } = {}) {
  if (platform !== "darwin") return Promise.resolve({ removed: [] });
  if (typeof userData !== "string" || !isAbsolute(userData) || resolve(userData) !== userData || /[\0\r\n]/.test(userData)) return Promise.reject(new Error("Recovery cleanup path is invalid."));
  if (runs.has(userData)) return runs.get(userData);
  const promise = prune({ userData, home, isIdle }).finally(() => runs.delete(userData));
  runs.set(userData, promise);
  return promise;
}

import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { runUpdateCommand } from "./update-installer.mjs";

const busy = new Set();
const phases = new Set(["copying", "ready", "testing", "healthy", "rolled-back"]);
function fail(message) { throw new Error(message); }
async function identity(path) {
  try {
    const stat = await lstat(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Update application directory is invalid.");
    return { device: String(stat.dev), inode: String(stat.ino) };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function equal(left, right) { return !!left && !!right && left.device === right.device && left.inode === right.inode; }
async function pathsFor(appPath, platform, runtimeStopped) {
  if (platform !== "darwin") fail("Application replacement is not available on this platform.");
  if (runtimeStopped !== true) fail("Stop the Desktop app and its runtime before replacing it.");
  if (typeof appPath !== "string" || !isAbsolute(appPath) || resolve(appPath) !== appPath || !appPath.endsWith(".app") || /[\0\r\n]/.test(appPath)) fail("Installed application path is invalid.");
  const parent = await realpath(dirname(appPath));
  const app = join(parent, basename(appPath));
  const root = join(parent, `.${basename(appPath)}.coop-update`);
  return { app, root, journal: join(root, "transaction.json"), candidate: join(root, "candidate.app"), previous: join(root, "previous.app"), failed: join(root, "failed.app") };
}
async function save(path, record) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(record) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp, path);
}
async function load(paths) {
  if (!await identity(paths.root)) return null;
  const stat = await lstat(paths.journal);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) fail("Update transaction journal is invalid.");
  const record = JSON.parse(await readFile(paths.journal, "utf8"));
  if (!record || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["candidate", "original", "ownerPid", "phase", "schemaVersion"]) || ![1, 2].includes(record.schemaVersion) || !phases.has(record.phase) || !Number.isSafeInteger(record.ownerPid) || record.ownerPid < 1) fail("Update transaction journal is invalid.");
  const valid = value => value && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["device", "inode"]) && /^\d+$/.test(value.device) && /^\d+$/.test(value.inode);
  if (!valid(record.original) || (record.candidate === null ? record.phase !== "copying" && record.phase !== "rolled-back" : !valid(record.candidate))) fail("Update transaction identities are invalid.");
  return record;
}

// Read-only classification for startup and recovery registration cleanup. This
// does not authorize replacement or claim that a retained backup is healthy.
export async function inspectMacReplacement({ appPath, platform = process.platform } = {}) {
  const paths = await pathsFor(appPath, platform, true);
  const record = await load(paths);
  return record ? { status: record.phase, ownerPid: record.ownerPid } : { status: "none" };
}
function assertOwnerStopped(record) {
  if (record.ownerPid === process.pid || ["healthy", "rolled-back"].includes(record.phase)) return;
  try { process.kill(record.ownerPid, 0); }
  catch (error) { if (error.code === "ESRCH") return; throw error; }
  fail("Another update helper is still running.");
}
async function recover(paths, swap, ownerBootChanged = false) {
  const record = await load(paths);
  if (!record) return { status: "none" };
  if (!ownerBootChanged) assertOwnerStopped(record);
  const current = await identity(paths.app), previous = await identity(paths.previous);
  if (record.phase === "healthy") {
    if (!equal(current, record.candidate) || !equal(previous, record.original)) fail("Completed update directories changed; preserving them for inspection.");
    return { status: "healthy", appPath: paths.app, previousPath: paths.previous };
  }
  if (record.schemaVersion === 2) {
    const candidate = await identity(paths.candidate);
    if (equal(current, record.original)) {
      // Includes a crash after rollback's swap, before filing the failed app.
      for (const [path, value] of [[paths.previous, previous], [paths.candidate, candidate]]) {
        if (!value) continue;
        if (record.candidate && equal(value, record.candidate)) {
          if (await identity(paths.failed)) fail("Failed application directory changed; preserving the transaction.");
          await rename(path, paths.failed);
        } else if (path === paths.previous || record.candidate) fail("Update directories changed; preserving the transaction.");
      }
    } else {
      if (!equal(current, record.candidate)) fail("Installed application changed; preserving the transaction.");
      const originals = [[paths.previous, previous], [paths.candidate, candidate]].filter(([, value]) => equal(value, record.original));
      if (originals.length !== 1 || await identity(paths.failed)) fail("Previous application is unavailable or changed; preserving the transaction.");
      if (typeof swap !== "function") fail("Atomic application recovery requires a swap implementation.");
      await swap(paths.app, originals[0][0]);
      await rename(originals[0][0], paths.failed);
    }
    await save(paths.journal, { ...record, phase: "rolled-back" });
    return { status: "rolled-back", appPath: paths.app };
  }
  if (equal(current, record.original)) {
    if (previous) fail("Original update directory is duplicated or changed.");
  } else {
    if (!equal(previous, record.original)) fail("Previous application is unavailable; preserving the transaction.");
    if (current) {
      if (!equal(current, record.candidate) || await identity(paths.failed)) fail("Installed application changed; refusing to overwrite it.");
      await rename(paths.app, paths.failed);
    }
    await rename(paths.previous, paths.app);
  }
  await save(paths.journal, { ...record, phase: "rolled-back" });
  return { status: "rolled-back", appPath: paths.app };
}
async function exclusive(paths, operation) {
  if (busy.has(paths.app)) fail("Another update transaction is in progress.");
  busy.add(paths.app);
  try { return await operation(); } finally { busy.delete(paths.app); }
}

// Paths come from the host's known application location, never from journal data.
export async function recoverMacReplacement({ appPath, platform = process.platform, runtimeStopped = false, swap, ownerBootChanged = false } = {}) {
  const paths = await pathsFor(appPath, platform, runtimeStopped);
  return exclusive(paths, () => recover(paths, swap, ownerBootChanged));
}

// Low-level helper transaction. The caller must supply trust-bound candidate
// validation and a health check that resolves only after its probe has stopped.
// Shutdown/relaunch orchestration belongs to the Desktop update helper, not UI.
export async function replaceMacApplication({ appPath, candidatePath, validateCandidate, checkHealth,
  platform = process.platform, runtimeStopped = false, execute = runUpdateCommand, signal, swap } = {}) {
  if (typeof validateCandidate !== "function" || typeof checkHealth !== "function") fail("Update candidate validation and health checks are required.");
  if (typeof swap !== "function") fail("Atomic application replacement requires a swap implementation.");
  const paths = await pathsFor(appPath, platform, runtimeStopped);
  return exclusive(paths, async () => {
    signal?.throwIfAborted();
    const prior = await recover(paths, swap);
    if (prior.status !== "none") await rename(paths.root, `${paths.root}.archive-${randomUUID()}`);
    const original = await identity(paths.app);
    if (!original) fail("Installed application is missing.");
    if (!isAbsolute(candidatePath) || !await identity(candidatePath) || equal(original, await identity(candidatePath))) fail("Update candidate directory is invalid.");
    await validateCandidate(candidatePath);
    await mkdir(paths.root, { mode: 0o700 });
    let record = { schemaVersion: 2, phase: "copying", ownerPid: process.pid, original, candidate: null };
    await save(paths.journal, record);
    try {
      await execute("/usr/bin/ditto", [candidatePath, paths.candidate], { signal });
      await validateCandidate(paths.candidate);
      signal?.throwIfAborted();
      if (!equal(await identity(paths.app), original)) fail("Installed application changed during update preparation.");
      record = { ...record, phase: "ready", candidate: await identity(paths.candidate) };
      if (!record.candidate) fail("Copied update candidate is missing.");
      await save(paths.journal, record);
      // The normal app path remains present. After the exchange, candidate holds
      // the original; recovery recognizes either location until backup is filed.
      await swap(paths.app, paths.candidate, { signal });
      await rename(paths.candidate, paths.previous);
      record = { ...record, phase: "testing" };
      await save(paths.journal, record);
      if (await checkHealth(paths.app, { signal }) !== true) fail("Updated application failed its health check.");
      signal?.throwIfAborted();
      if (!equal(await identity(paths.app), record.candidate) || !equal(await identity(paths.previous), original)) fail("Application directories changed during health verification.");
      await save(paths.journal, { ...record, phase: "healthy" });
      return { status: "healthy", appPath: paths.app, previousPath: paths.previous };
    } catch (error) {
      if (error.code === "UPDATE_HEALTH_PROCESS_EXIT_UNCONFIRMED") throw error;
      try { await recover(paths, swap); }
      catch (recoveryError) { throw new AggregateError([error, recoveryError], "Update failed and recovery requires inspection; all application directories were preserved."); }
      throw new Error("Update failed; the previous application is restored.", { cause: error });
    }
  });
}

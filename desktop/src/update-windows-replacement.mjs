import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const active = new Set();
const phases = new Set(["copying", "ready", "testing", "healthy", "rolled-back"]);
const same = (a, b) => !!a && !!b && a.device === b.device && a.inode === b.inode;
const inside = (root, path) => { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
async function identity(path) {
  try {
    const stat = await lstat(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Update directory must be a real directory.");
    return { device: String(stat.dev), inode: String(stat.ino) };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function pathsFor(appPath, platform, runtimeStopped) {
  if (platform !== "win32" || runtimeStopped !== true) throw new Error("Windows replacement requires the application and runtime to be stopped.");
  if (typeof appPath !== "string" || !isAbsolute(appPath) || resolve(appPath) !== appPath || !basename(appPath) || /[\0\r\n]/.test(appPath)) throw new Error("Installed application path is invalid.");
  const parent = await realpath(dirname(appPath));
  const app = join(parent, basename(appPath));
  const root = join(parent, `.${basename(appPath)}.coop-update`);
  return { app, root, journal: join(root, "transaction.json"), candidate: join(root, "candidate"), previous: join(root, "previous"), failed: join(root, "failed") };
}
async function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  // Windows cannot replace an open journal. Every reader also closes before returning.
  await rename(temporary, path);
}
async function load(paths) {
  if (!await identity(paths.root)) return null;
  const file = await open(paths.journal, "r");
  let record;
  try {
    const stat = await file.stat();
    const entry = await lstat(paths.journal);
    if (!stat.isFile() || entry.isSymbolicLink() || stat.size > 8192 || stat.ino !== entry.ino || stat.dev !== entry.dev) throw new Error("Update journal is invalid.");
    record = JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
  const keys = value => JSON.stringify(Object.keys(value).sort());
  const validIdentity = value => value && keys(value) === '["device","inode"]' && /^\d+$/.test(value.device) && /^\d+$/.test(value.inode);
  if (!record || keys(record) !== '["candidate","original","ownerPid","phase","schemaVersion"]' || record.schemaVersion !== 1
    || !phases.has(record.phase) || !Number.isSafeInteger(record.ownerPid) || record.ownerPid < 1 || !validIdentity(record.original)
    || (record.candidate === null ? !["copying", "rolled-back"].includes(record.phase) : !validIdentity(record.candidate))) throw new Error("Update journal contract is invalid.");
  return record;
}
function requireStoppedOwner(record) {
  if (record.ownerPid === process.pid || ["healthy", "rolled-back"].includes(record.phase)) return;
  try { process.kill(record.ownerPid, 0); }
  catch (error) { if (error.code === "ESRCH") return; throw error; }
  throw new Error("Another update helper is still running.");
}
async function recover(paths) {
  const record = await load(paths);
  if (!record) return { status: "none" };
  requireStoppedOwner(record);
  const current = await identity(paths.app), previous = await identity(paths.previous);
  if (record.phase === "healthy") {
    if (!same(current, record.candidate) || !same(previous, record.original)) throw new Error("Completed update directories changed; preserving the transaction.");
    return { status: "healthy", appPath: paths.app, previousPath: paths.previous };
  }
  if (same(current, record.original)) {
    if (previous) throw new Error("Original application is duplicated or changed.");
  } else {
    if (!same(previous, record.original)) throw new Error("Previous application is unavailable; preserving all directories.");
    if (current) {
      if (!same(current, record.candidate) || await identity(paths.failed)) throw new Error("Installed application changed; refusing to overwrite it.");
      await rename(paths.app, paths.failed);
    }
    await rename(paths.previous, paths.app);
  }
  await save(paths.journal, { ...record, phase: "rolled-back" });
  return { status: "rolled-back", appPath: paths.app };
}
async function exclusive(paths, operation) {
  const key = paths.app.toLowerCase();
  if (active.has(key)) throw new Error("Another update transaction is in progress.");
  active.add(key);
  try { return await operation(); } finally { active.delete(key); }
}
async function copyCandidate(source, destination, signal) {
  let files = 0, bytes = 0;
  async function visit(from, to) {
    signal?.throwIfAborted();
    const stat = await lstat(from);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error("Windows update candidates cannot contain reparse points or special files.");
    if (++files > 250000 || (bytes += stat.isFile() ? stat.size : 0) > 16 * 1024 ** 3) throw new Error("Windows update candidate exceeds its size limit.");
    if (stat.isDirectory()) {
      await mkdir(to);
      for (const name of await readdir(from)) await visit(join(from, name), join(to, name));
    } else await copyFile(from, to, 1 /* COPYFILE_EXCL */);
  }
  await visit(source, destination);
}

export async function inspectWindowsReplacement({ appPath, platform = process.platform } = {}) {
  const record = await load(await pathsFor(appPath, platform, true));
  return record ? { status: record.phase, ownerPid: record.ownerPid } : { status: "none" };
}
export async function recoverWindowsReplacement({ appPath, platform = process.platform, runtimeStopped = false } = {}) {
  const paths = await pathsFor(appPath, platform, runtimeStopped);
  return exclusive(paths, () => recover(paths));
}

// The detached Windows helper must arm independent recovery BEFORE calling this.
// NTFS lacks a directory exchange operation: the durable ready journal covers the
// gap between the two renames, and every failure retains the previous application.
export async function replaceWindowsApplication({ appPath, candidatePath, validateCandidate, checkHealth,
  platform = process.platform, runtimeStopped = false, signal } = {}) {
  if (typeof validateCandidate !== "function" || typeof checkHealth !== "function") throw new Error("Trusted candidate validation and a stopped native health probe are required.");
  const paths = await pathsFor(appPath, platform, runtimeStopped);
  return exclusive(paths, async () => {
    signal?.throwIfAborted();
    const prior = await recover(paths);
    if (prior.status !== "none") await rename(paths.root, `${paths.root}.archive-${randomUUID()}`);
    const original = await identity(paths.app);
    if (!original || !isAbsolute(candidatePath) || !await identity(candidatePath) || same(original, await identity(candidatePath))) throw new Error("Update application or candidate is invalid.");
    candidatePath = await realpath(candidatePath);
    if (inside(candidatePath, paths.app) || inside(paths.app, candidatePath) || inside(candidatePath, paths.root)) throw new Error("Update candidate overlaps the installed application or transaction directory.");
    await validateCandidate(candidatePath);
    await mkdir(paths.root);
    let record = { schemaVersion: 1, phase: "copying", ownerPid: process.pid, original, candidate: null };
    await save(paths.journal, record);
    try {
      await copyCandidate(candidatePath, paths.candidate, signal);
      await validateCandidate(paths.candidate);
      signal?.throwIfAborted();
      if (!same(await identity(paths.app), original)) throw new Error("Installed application changed during preparation.");
      record = { ...record, phase: "ready", candidate: await identity(paths.candidate) };
      await save(paths.journal, record);
      await rename(paths.app, paths.previous);
      await rename(paths.candidate, paths.app);
      record = { ...record, phase: "testing" };
      await save(paths.journal, record);
      if (await checkHealth(paths.app, { signal }) !== true) throw new Error("Updated application failed its health check.");
      signal?.throwIfAborted();
      if (!same(await identity(paths.app), record.candidate) || !same(await identity(paths.previous), original)) throw new Error("Application directories changed during health verification.");
      await save(paths.journal, { ...record, phase: "healthy" });
      return { status: "healthy", appPath: paths.app, previousPath: paths.previous };
    } catch (error) {
      // A timed-out probe may still hold files or execute the candidate. Leave
      // the journal and both app identities intact for the independent worker,
      // which confirms probe shutdown before it attempts directory replacement.
      if (error?.code === "UPDATE_HEALTH_PROCESS_EXIT_UNCONFIRMED") throw error;
      try { await recover(paths); }
      catch (recoveryError) { throw new AggregateError([error, recoveryError], "Update failed and recovery requires inspection; all application directories were preserved."); }
      throw new Error("Update failed; the previous application is restored.", { cause: error });
    }
  });
}

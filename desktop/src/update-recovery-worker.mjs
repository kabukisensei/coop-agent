import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectMacReplacement, recoverMacReplacement } from "./update-replacement.mjs";
import { swapMacDirectories } from "./update-swap.mjs";
import { inspectManagedRuntime } from "./managed-runtime.mjs";
import { runUpdateCommand } from "./update-installer.mjs";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const fields = ["appPath", "bootId", "currentVersion", "helperPid", "parentPid", "phase", "runtimePid", "schemaVersion", "targetVersion", "userData", "versionRoot"];
export function recoveryPaths(requestPath, record, home = homedir()) {
  if (!record || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(fields) || record.schemaVersion !== 1 || !["watching", "finished"].includes(record.phase)) throw new Error("Recovery record is invalid.");
  for (const key of ["appPath", "userData", "versionRoot"]) if (typeof record[key] !== "string" || !isAbsolute(record[key]) || resolve(record[key]) !== record[key] || /[\0\r\n]/.test(record[key])) throw new Error("Recovery path is invalid.");
  for (const key of ["helperPid", "parentPid", "runtimePid"]) if (!Number.isSafeInteger(record[key]) || record[key] < 1) throw new Error("Recovery process identity is invalid.");
  if (!UUID.test(record.bootId) || !VERSION.test(record.currentVersion) || !VERSION.test(record.targetVersion) || !record.appPath.endsWith(".app")) throw new Error("Recovery identity is invalid.");
  const id = basename(dirname(requestPath));
  const root = join(record.userData, "update-recovery", id);
  if (!UUID.test(id) || requestPath !== join(root, "request.json")) throw new Error("Recovery record is outside its owned directory.");
  const label = `com.cooptimize.coop.desktop.recovery.${id}`;
  return { root, requestPath, label, workerApp: join(root, "Recovery.app"), plist: join(home, "Library", "LaunchAgents", `${label}.plist`) };
}

export async function readRecoveryRecord(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 8192) throw new Error("Recovery record is not a bounded file.");
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 8192) throw new Error("Recovery record is too large.");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await handle.close(); }
}

export async function saveRecoveryRecord(path, record) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(record) + "\n"); await file.sync(); }
  finally { await file.close(); }
  await rename(temp, path);
}

export async function disarmRecoveryWorker(paths, record, { execute = runUpdateCommand, uid = process.getuid() } = {}) {
  await saveRecoveryRecord(paths.requestPath, { ...record, phase: "finished" });
  try { await unlink(paths.plist); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await execute("/bin/launchctl", ["bootout", `gui/${uid}/${paths.label}`]);
}

function live(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
export function bootSessionId() { return execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" }).trim(); }
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function pidsFor(pattern) {
  try { return execFileSync("/usr/bin/pgrep", ["-f", pattern], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean).map(Number); }
  catch (error) { if (error.status === 1) return []; throw new Error("Recovery could not inspect app processes."); }
}
function processGroup(pid) {
  try { return Number(execFileSync("/bin/ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" }).trim()); }
  catch { return null; }
}

export async function stopRecoveryProbes(record, { sameBoot }) {
  if (!sameBoot) return;
  const groups = new Set();
  const ownGroup = processGroup(process.pid);
  const direct = new Set();
  const executable = `${escapeRegex(record.appPath)}/Contents/`;
  // A same-boot orphan in the helper's process group belongs to its runtime
  // probe. Native UI probes have their own group and a unique temporary profile.
  for (const pid of pidsFor(`^${executable}`)) {
    if (pid === record.runtimePid) direct.add(pid);
    if (processGroup(pid) === record.helperPid && record.helperPid !== ownGroup) groups.add(record.helperPid);
  }
  for (const pid of pidsFor(`^${executable}.*--user-data-dir=${escapeRegex(record.versionRoot)}/\\.native-health-`)) {
    const group = processGroup(pid);
    if (group > 1 && group !== ownGroup && group !== process.pid) groups.add(group);
  }
  const signalGroup = (group, signal) => {
    try { process.kill(-group, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  for (const group of groups) signalGroup(group, "SIGTERM");
  for (const pid of direct) { try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
  if (groups.size || direct.size) await new Promise(resolve => setTimeout(resolve, 1000));
  for (const group of groups) signalGroup(group, "SIGKILL");
  for (const pid of direct) { try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
  // Never exchange an app while another normal app or surviving probe uses it.
  const deadline = Date.now() + 5000;
  while (pidsFor(`^${executable}`).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
}

export async function runRecoveryWorker({ requestPath, home = homedir(), execute = runUpdateCommand,
  bootId = bootSessionId(), alive = live, stopProbes = stopRecoveryProbes,
  appRunning = record => pidsFor(`^${escapeRegex(record.appPath)}/Contents/`).length > 0,
  recover = recoverMacReplacement, disarm = disarmRecoveryWorker, inspectRuntime = inspectManagedRuntime,
  inspectTransaction = inspectMacReplacement } = {}) {
  const record = await readRecoveryRecord(requestPath);
  const paths = recoveryPaths(requestPath, record, home);
  if (record.phase === "finished") { await disarm(paths, record, { execute }); return "finished"; }
  const sameBoot = record.bootId.toLowerCase() === bootId.toLowerCase();
  if (sameBoot && alive(record.helperPid)) return "waiting";
  if (sameBoot && alive(record.parentPid)) { await disarm(paths, record, { execute }); return "cancelled"; }
  await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", paths.workerApp]);
  const workerInfo = JSON.parse(await execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(paths.workerApp, "Contents", "Info.plist")]));
  if (workerInfo.CFBundleIdentifier !== "com.cooptimize.coop.desktop" || workerInfo.CFBundleShortVersionString !== record.currentVersion) throw new Error("Recovery worker identity changed.");
  async function verifyApp(expectedVersion) {
    await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", record.appPath]);
    const info = JSON.parse(await execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(record.appPath, "Contents", "Info.plist")]));
    if (info.CFBundleIdentifier !== "com.cooptimize.coop.desktop" || info.CFBundleShortVersionString !== expectedVersion) throw new Error("Recovered app identity changed.");
  }
  const transaction = await inspectTransaction({ appPath: record.appPath });
  if (["healthy", "rolled-back"].includes(transaction.status) && appRunning(record)) {
    // The helper may have died after reopening the app but before disarming us.
    // Keep that working instance and consume only our completed registration.
    await verifyApp(transaction.status === "healthy" ? record.targetVersion : record.currentVersion);
    await disarm(paths, record, { execute });
    return transaction.status;
  }
  await stopProbes(record, { sameBoot });
  if (appRunning(record)) return "busy";
  const runtime = inspectRuntime(join(paths.workerApp, "Contents", "Resources", "managed-runtime"));
  const result = await recover({ appPath: record.appPath, runtimeStopped: true, ownerBootChanged: !sameBoot,
    swap: (left, right) => swapMacDirectories(left, right, { pythonPath: runtime.python }) });
  const expectedVersion = result.status === "healthy" ? record.targetVersion : record.currentVersion;
  await verifyApp(expectedVersion);
  try { await saveRecoveryRecord(join(record.userData, "update-result.json"), result.status === "healthy" ? { status: "healthy", version: expectedVersion } : { status: "failed" }); }
  catch { /* Outcome reporting must not prevent reopening the verified app. */ }
  await execute("/usr/bin/open", ["-n", record.appPath, "--args", `--user-data-dir=${record.userData}`]);
  await disarm(paths, record, { execute });
  return result.status;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.platform !== "darwin" || process.argv.length !== 4 || process.argv[2] !== "--recover") process.exitCode = 1;
  else runRecoveryWorker({ requestPath: process.argv[3] }).catch(() => {
    process.stderr.write("Coop update recovery could not finish; its retained state needs another check.\n"); process.exitCode = 1;
  });
}

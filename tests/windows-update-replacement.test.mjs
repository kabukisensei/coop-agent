import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectWindowsReplacement, recoverWindowsReplacement, replaceWindowsApplication } from "../desktop/src/update-windows-replacement.mjs";

const root = await mkdtemp(join(tmpdir(), "coop-windows-replacement-"));
const platform = "win32";
async function fixture(name) {
  const directory = join(root, name), appPath = join(directory, "Coop Desktop"), candidatePath = join(directory, "download");
  await mkdir(appPath, { recursive: true }); await mkdir(candidatePath);
  await writeFile(join(appPath, "version"), "old"); await writeFile(join(candidatePath, "version"), "new");
  return { appPath, candidatePath, platform, runtimeStopped: true,
    validateCandidate: async path => assert.equal(await readFile(join(path, "version"), "utf8"), "new"), checkHealth: async () => true };
}
async function version(path) { return readFile(join(path, "version"), "utf8"); }

const healthy = await fixture("healthy");
const result = await replaceWindowsApplication(healthy);
assert.equal(result.status, "healthy"); assert.equal(await version(healthy.appPath), "new"); assert.equal(await version(result.previousPath), "old");
assert.equal((await recoverWindowsReplacement(healthy)).status, "healthy");
console.log("PASS: successful replacement retains the exact previous application and is recoverable");

const failed = await fixture("failed-health");
await assert.rejects(replaceWindowsApplication({ ...failed, checkHealth: async () => false }), /previous application is restored/);
assert.equal(await version(failed.appPath), "old"); assert.equal((await inspectWindowsReplacement(failed)).status, "rolled-back");
assert.equal((await recoverWindowsReplacement(failed)).status, "rolled-back");
console.log("PASS: failed native-health result restores the prior application; recovery is idempotent");

const cancelled = await fixture("cancelled"), abort = new AbortController();
await assert.rejects(replaceWindowsApplication({ ...cancelled, signal: abort.signal, checkHealth: async () => { abort.abort(); return true; } }), /previous application is restored/);
assert.equal(await version(cancelled.appPath), "old");
console.log("PASS: cancellation during health rolls back before declaring success");

const tampered = await fixture("tampered");
await assert.rejects(replaceWindowsApplication({ ...tampered, checkHealth: async app => {
  await rename(app, app + "-quarantined"); await mkdir(app); await writeFile(join(app, "version"), "unrelated"); return false;
} }), /all application directories were preserved/);
assert.equal(await version(tampered.appPath), "unrelated");
assert.equal(await version(join(root, "tampered", ".Coop Desktop.coop-update", "previous")), "old");
console.log("PASS: changed directory identity prevents overwriting unrelated content");

const interrupted = await fixture("helper-crash");
const moduleUrl = pathToFileURL(resolve("desktop/src/update-windows-replacement.mjs")).href;
const worker = spawn(process.execPath, ["--input-type=module", "-e", `
  import {replaceWindowsApplication} from ${JSON.stringify(moduleUrl)};
  await replaceWindowsApplication({...JSON.parse(process.argv[1]), validateCandidate:async()=>{}, checkHealth:async()=>process.exit(77)});
`, JSON.stringify(interrupted)], { windowsHide: true, stdio: "ignore" });
assert.equal((await once(worker, "close"))[0], 77);
assert.equal((await inspectWindowsReplacement(interrupted)).status, "testing");
assert.equal((await recoverWindowsReplacement(interrupted)).status, "rolled-back");
assert.equal(await version(interrupted.appPath), "old");
console.log("PASS: actual helper process death after replacement restores the prior application");

// Reproduce the NTFS crash gap: journal is durable, old app has moved, and the
// candidate has not yet taken its place. Identities come from the real transaction.
const gap = await fixture("rename-gap");
await assert.rejects(replaceWindowsApplication({ ...gap, checkHealth: async () => false }), /previous application is restored/);
const transaction = join(root, "rename-gap", ".Coop Desktop.coop-update");
const journal = JSON.parse(await readFile(join(transaction, "transaction.json"), "utf8"));
await rename(gap.appPath, join(transaction, "previous"));
await rename(join(transaction, "failed"), join(transaction, "candidate"));
await writeFile(join(transaction, "transaction.json"), JSON.stringify({ ...journal, phase: "ready" }));
assert.equal((await recoverWindowsReplacement(gap)).status, "rolled-back");
assert.equal(await version(gap.appPath), "old");
console.log("PASS: recovery closes the gap between the two NTFS directory renames");

const linked = await fixture("reparse-point"), outside = join(root, "outside");
await mkdir(outside); await writeFile(join(outside, "keep"), "untouched");
await symlink(outside, join(linked.candidatePath, "escape"), process.platform === "win32" ? "junction" : "dir");
await assert.rejects(replaceWindowsApplication(linked), /previous application is restored/);
assert.equal(await version(linked.appPath), "old"); assert.equal(await readFile(join(outside, "keep"), "utf8"), "untouched");
console.log("PASS: real reparse points cannot copy unrelated content into a candidate");

const ancestor = await fixture("overlapping-paths");
await assert.rejects(replaceWindowsApplication({ ...ancestor, candidatePath: join(root, "overlapping-paths") }), /candidate overlaps/);
assert.equal(await version(ancestor.appPath), "old");
console.log("PASS: ancestor candidates cannot recurse into the application or transaction");

const overlap = await fixture("overlap");
let release, entered;
const waiting = new Promise(resolve => { release = resolve; }), enteredHealth = new Promise(resolve => { entered = resolve; });
const first = replaceWindowsApplication({ ...overlap, checkHealth: async () => { entered(); await waiting; return true; } });
await enteredHealth;
await assert.rejects(replaceWindowsApplication(overlap), /transaction is in progress/);
release(); await first;
console.log("PASS: overlapping updates cannot replace the same application");

if (process.platform === "win32") {
  const locked = await fixture("locked-directory");
  const python = spawn(process.env.COOP_TEST_PYTHON || "python", ["-u", "-c", `
import ctypes, sys
k=ctypes.WinDLL('kernel32',use_last_error=True)
k.CreateFileW.argtypes=[ctypes.c_wchar_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p]
k.CreateFileW.restype=ctypes.c_void_p
h=k.CreateFileW(sys.argv[1],0x80000000,3,None,3,0x02000000,None)
if h == ctypes.c_void_p(-1).value: raise ctypes.WinError(ctypes.get_last_error())
try:
 print('locked',flush=True)
 sys.stdin.readline()
finally:
 k.CloseHandle.argtypes=[ctypes.c_void_p]
 k.CloseHandle(h)
`, locked.appPath], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; python.stderr.on("data", data => { stderr += data; });
  const ready = await Promise.race([once(python.stdout, "data").then(([data]) => String(data)), once(python, "close").then(() => { throw new Error(`Lock helper failed: ${stderr}`); })]);
  assert.match(ready, /locked/);
  try {
    await assert.rejects(replaceWindowsApplication(locked), /previous application is restored/);
    assert.equal(await version(locked.appPath), "old");
  } finally { python.stdin.end("release\n"); await once(python, "close"); }
  assert.equal((await replaceWindowsApplication(locked)).status, "healthy");
  console.log("PASS: real Windows directory lock preserves the old app; retry succeeds after handle release");
}
console.log(`Windows replacement evidence retained at ${root}`);

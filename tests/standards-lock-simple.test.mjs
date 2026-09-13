import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "coop-standards-lock-simple-"));
const moduleUrl = new URL("../lib/standards.mjs", import.meta.url).href;
const worker = join(tmp, "worker.mjs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (path, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { readFileSync(path); return; } catch { await delay(10); }
  }
  throw new Error(`timed out waiting for ${path}`);
};
const run = (root, role, env = {}) => spawn(process.execPath, [worker, root, role], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
const exited = (child) => new Promise((resolve) => {
  let stdout = "", stderr = "";
  child.stdout.on("data", (x) => { stdout += x; }); child.stderr.on("data", (x) => { stderr += x; });
  child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
});
const makeLock = (root, ownerText) => {
  const lock = join(root, ".probe.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), ownerText);
  return lock;
};

writeFileSync(worker, `import {appendFileSync,existsSync,mkdirSync,readFileSync,renameSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {__testWithStorageLock} from ${JSON.stringify(moduleUrl)};
const [root,role]=process.argv.slice(2), sleep=(ms)=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms), wait=(p)=>{while(!existsSync(p))sleep(5)};
try {
  __testWithStorageLock(root,"probe",{lockTimeoutMs:Number(process.env.TIMEOUT||3000),lockFault:(step,{lock})=>{
    if(process.env.REPLACE_AT===step){mkdirSync(lock);writeFileSync(join(lock,"owner.json"),JSON.stringify({schema_version:1,pid:process.pid,acquired_ms:Date.now(),token:"d".repeat(32)})+"\\n");}
  }},()=>{
    const marker=join(root,"critical");
    try{writeFileSync(marker,role,{flag:"wx"});}catch{appendFileSync(join(root,"overlap"),role+"\\n");throw new Error("overlapping critical section");}
    writeFileSync(join(root,role+"-entered"),"1"); appendFileSync(join(root,"events"),role+":enter\\n");
    if(process.env.REPLACE_ON_EXIT==="1"){
      const lock=join(root,".probe.lock"), moved=join(root,".probe.lock.original"); renameSync(lock,moved); mkdirSync(lock);
      writeFileSync(join(lock,"owner.json"),JSON.stringify({schema_version:1,pid:process.pid,acquired_ms:Date.now(),token:"b".repeat(32)})+"\\n");
    }
    if(process.env.HOLD_FILE)wait(join(root,process.env.HOLD_FILE));
    rmSync(marker,{force:true}); appendFileSync(join(root,"events"),role+":exit\\n");
  });
} catch(error) { process.stderr.write(error.message+"\\n"); process.exitCode=2; }
`);

let count = 0;
const test = async (name, fn) => { await fn(); count++; console.log(`  ✓ ${name}`); };
try {
  await test("concurrent refresh-style work is serialized without overlap", async () => {
    const root = join(tmp, "serialized"); mkdirSync(root);
    const a = run(root, "A", { HOLD_FILE: "release-A" }); const aDone = exited(a); await waitFor(join(root, "A-entered"));
    const b = run(root, "B", { TIMEOUT: "3000" }); const bDone = exited(b);
    await delay(150); assert.equal(readdirSync(root).includes("B-entered"), false, "B entered while A held the lock");
    writeFileSync(join(root, "release-A"), "1");
    assert.equal((await aDone).code, 0); assert.equal((await bDone).code, 0);
    assert.equal(readFileSync(join(root, "events"), "utf8"), "A:enter\nA:exit\nB:enter\nB:exit\n");
    assert.equal(readdirSync(root).includes("overlap"), false);
  });

  await test("live, unknown, and abandoned lock ownership is never stolen", async () => {
    const owners = [
      ["live", JSON.stringify({ schema_version: 1, pid: process.pid, acquired_ms: Date.now(), token: "a".repeat(32) }) + "\n"],
      ["unknown", "{}\n"],
      ["abandoned", JSON.stringify({ schema_version: 1, pid: 999_999, acquired_ms: 0, token: "c".repeat(32) }) + "\n"],
    ];
    for (const [name, bytes] of owners) {
      const root = join(tmp, name); mkdirSync(root); const lock = makeLock(root, bytes); const before = statSync(lock);
      const result = spawnSync(process.execPath, [worker, root, name], { env: { ...process.env, TIMEOUT: "100" }, encoding: "utf8" });
      assert.equal(result.status, 2, `${name}: ${result.stderr}`); assert.match(result.stderr, /automatic recovery is disabled/);
      const after = statSync(lock); assert.equal(after.ino, before.ino, `${name} lock inode changed`); assert.equal(readFileSync(join(lock, "owner.json"), "utf8"), bytes);
      assert.equal(readdirSync(root).some((entry) => /recovery|recovered/.test(entry)), false);
    }
  });

  await test("unlock removes only the caller's exact lock", async () => {
    const root = join(tmp, "unlock"); mkdirSync(root);
    const result = spawnSync(process.execPath, [worker, root, "unlock"], { env: { ...process.env, REPLACE_ON_EXIT: "1" }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const replacement = JSON.parse(readFileSync(join(root, ".probe.lock", "owner.json")));
    assert.equal(replacement.token, "b".repeat(32));
    assert.equal(readFileSync(join(root, ".probe.lock.original", "owner.json"), "utf8").includes("\"token\""), true);
  });

  for (const seam of ["unlock:owner-observed", "unlock:before-delete"]) await test(`replacement at ${seam} survives claimed-lock deletion`, async () => {
    const root = join(tmp, seam.replaceAll(":", "-")); mkdirSync(root);
    const result = spawnSync(process.execPath, [worker, root, seam], { env: { ...process.env, REPLACE_AT: seam }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const replacement = JSON.parse(readFileSync(join(root, ".probe.lock", "owner.json")));
    assert.equal(replacement.token, "d".repeat(32));
    assert.equal(readdirSync(root).some((entry) => entry.startsWith(".probe.lock.release-")), false);
    const contender = spawnSync(process.execPath, [worker, root, `${seam}-contender`], { env: { ...process.env, TIMEOUT: "100" }, encoding: "utf8" });
    assert.equal(contender.status, 2); assert.match(contender.stderr, /automatic recovery is disabled/);
    assert.equal(readdirSync(root).includes(`${seam}-contender-entered`), false);
  });

  console.log(`standards conservative lock: ${count} tests passed`);
} finally { rmSync(tmp, { recursive: true, force: true }); }

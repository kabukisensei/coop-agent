import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWindowsUpdate } from "../desktop/src/update-windows-prepare.mjs";

const root = await mkdtemp(join(tmpdir(), "coop-windows-prepare-"));
const artifactPath = join(root, "download.zip"), versionRoot = join(root, "versions");
const payload = Buffer.from("signed archive fixture");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const now = Date.parse("2026-09-08T00:00:00Z");
const descriptor = { schemaVersion: 1, keyId: "fixture", releaseId: "windows-test", channel: "stable", desktopVersion: "1.2.3",
  coopVersion: "0.23.1", protocolVersion: 1, target: { platform: "win32", arch: "x64" }, issuedAt: "2026-09-07T00:00:00Z",
  expiresAt: "2026-09-10T00:00:00Z", artifact: { url: "https://updates.example.test/app.zip", sha256: createHash("sha256").update(payload).digest("hex"), size: payload.length },
  notesUrl: "https://updates.example.test/notes" };
const manifestBytes = Buffer.from(JSON.stringify(descriptor));
const base = { manifestBytes, signature: sign(null, manifestBytes, privateKey).toString("base64"), artifactPath, versionRoot,
  python: join(root, "trusted-python.exe"), platform: "win32", arch: "x64", now,
  trustStore: { schemaVersion: 1, keys: [{ keyId: "fixture", algorithm: "ed25519", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    status: "active", channels: ["stable"], artifactOrigins: ["https://updates.example.test"], notesOrigins: ["https://updates.example.test"],
    validFrom: "2026-01-01T00:00:00Z", validUntil: "2027-01-01T00:00:00Z" }] } };
let count = 0;
async function check(name, fn) { await fn(); count++; console.log(`  ✓ ${name}`); }
async function extract(command, args) {
  assert.equal(command, base.python); assert.deepEqual(args.slice(0, 2), ["-I", "-B"]);
  assert.notEqual(args[3], artifactPath); assert.deepEqual(await readFile(args[3]), payload);
  await mkdir(args[4]); await writeFile(join(args[4], "Coop Desktop.exe"), "fixture");
}
try {
  await writeFile(artifactPath, payload);
  await check("signed private snapshot is validated before promotion and can be discarded once", async () => {
    let verified = false;
    const prepared = await prepareWindowsUpdate({ ...base, execute: extract, verifyApplication: async (path, actual) => {
      assert.equal(await readFile(join(path, "Coop Desktop.exe"), "utf8"), "fixture"); assert.equal(actual.releaseId, descriptor.releaseId); verified = true;
    } });
    assert.equal(verified, true); assert.equal(await readFile(join(prepared.installPath, "Coop Desktop.exe"), "utf8"), "fixture");
    assert.equal(await prepared.discard(), true); assert.equal(await prepared.discard(), false); assert.deepEqual(await readdir(versionRoot), []);
    assert.deepEqual(await readFile(artifactPath), payload);
  });
  await check("altered descriptor and changed artifact never reach extraction", async () => {
    const execute = async () => assert.fail("untrusted bytes reached extraction");
    await assert.rejects(prepareWindowsUpdate({ ...base, manifestBytes: Buffer.from(JSON.stringify({ ...descriptor, desktopVersion: "9.9.9" })), execute }));
    await writeFile(artifactPath, "changed"); await assert.rejects(prepareWindowsUpdate({ ...base, execute }));
    assert.deepEqual(await readdir(versionRoot), []); await writeFile(artifactPath, payload);
  });
  await check("extraction failure, native rejection and cancellation clean only owned staging", async () => {
    await writeFile(join(versionRoot, "keep.txt"), "unrelated version data");
    await assert.rejects(prepareWindowsUpdate({ ...base, execute: async () => { throw new Error("bad zip"); } }), /bad zip/);
    await assert.rejects(prepareWindowsUpdate({ ...base, execute: extract, verifyApplication: async () => { throw new Error("unsigned"); } }), /unsigned/);
    const controller = new AbortController();
    await assert.rejects(prepareWindowsUpdate({ ...base, signal: controller.signal, execute: extract,
      verifyApplication: async () => controller.abort(new Error("cancelled")) }), /cancelled/);
    assert.deepEqual(await readdir(versionRoot), ["keep.txt"]); assert.equal(await readFile(join(versionRoot, "keep.txt"), "utf8"), "unrelated version data");
  });
  if (process.platform === "win32") await check("real ZIP extraction and native signature rejection preserve the original artifact", async () => {
    const locate = spawnSync(process.env.PYTHON || "python", ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8", windowsHide: true });
    assert.equal(locate.status, 0, locate.stderr);
    const python = locate.stdout.trim(), bytes = Buffer.alloc(512);
    bytes.write("MZ"); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x8664, 68);
    bytes.writeUInt16LE(240, 84); bytes.writeUInt16LE(2, 86); bytes.writeUInt16LE(0x20b, 88);
    await writeFile(join(root, "Coop Desktop.exe"), bytes);
    const zip = spawnSync(python, ["-I", "-m", "zipfile", "-c", "native.zip", "Coop Desktop.exe"], { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(zip.status, 0, zip.stderr);
    const artifactPath = join(root, "native.zip"), archive = await readFile(artifactPath);
    const actual = { ...descriptor, artifact: { ...descriptor.artifact, size: archive.length, sha256: createHash("sha256").update(archive).digest("hex") } };
    const manifestBytes = Buffer.from(JSON.stringify(actual));
    await assert.rejects(prepareWindowsUpdate({ ...base, artifactPath, python, manifestBytes,
      signature: sign(null, manifestBytes, privateKey).toString("base64") }), /signature, identity or version/);
    assert.deepEqual(await readFile(artifactPath), archive); assert.deepEqual(await readdir(versionRoot), ["keep.txt"]);
  });
  console.log(`  Windows update preparation tests passed (${count} groups).`);
} finally { await rm(root, { recursive: true, force: true }); }

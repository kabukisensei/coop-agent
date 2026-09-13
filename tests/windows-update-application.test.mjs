import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyWindowsExecutable, verifyWindowsUpdateApplication } from "../desktop/src/update-windows-application.mjs";

const root = await mkdtemp(join(tmpdir(), "coop-windows-identity-"));
const path = join(root, "Coop Desktop.exe");
const descriptor = { target: { platform: "win32", arch: "x64" }, desktopVersion: "1.2.3", coopVersion: "0.23.1" };
const validMetadata = { signatureStatus: "Valid", productName: "Coop Desktop", fileVersion: "1.2.3" };
const originalRoot = process.env.SystemRoot;
if (!originalRoot) process.env.SystemRoot = root;
function fixture(machine = 0x8664) {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ"); bytes.writeUInt32LE(64, 60);
  bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(machine, 68);
  bytes.writeUInt16LE(240, 84); bytes.writeUInt16LE(2, 86); bytes.writeUInt16LE(0x20b, 88);
  return bytes;
}
let count = 0;
async function check(name, fn) { await fn(); count++; console.log(`  ✓ ${name}`); }
try {
  await check("PE machine matches x64 and arm64 without executing candidate code", async () => {
    await writeFile(path, fixture()); await verifyWindowsExecutable(path, "x64");
    await assert.rejects(verifyWindowsExecutable(path, "arm64"), /architecture/);
    await writeFile(path, fixture(0xaa64)); await verifyWindowsExecutable(path, "arm64");
  });
  await check("malformed headers, offsets, optional headers and DLL images are rejected", async () => {
    const mutations = [b => b.fill(0, 0, 2), b => b.writeUInt32LE(0xffffffff, 60), b => b.fill(0, 64, 68),
      b => b.writeUInt16LE(0x10b, 88), b => b.writeUInt16LE(0x2002, 86), b => b.writeUInt16LE(0, 86),
      b => b.writeUInt16LE(0xffff, 84), b => b.writeUInt16LE(2, 84)];
    for (const mutate of mutations) { const bytes = fixture(); mutate(bytes); await writeFile(path, bytes); await assert.rejects(verifyWindowsExecutable(path, "x64")); }
    await writeFile(path, Buffer.alloc(63)); await assert.rejects(verifyWindowsExecutable(path, "x64"), /truncated/);
  });
  await check("native metadata and managed runtime must match the signed descriptor", async () => {
    await writeFile(path, fixture());
    const execute = async (command, args, options) => {
      assert.equal(args.at(-1), path); assert.equal(args.includes("-Command"), false);
      assert.match(command, /powershell\.exe$/); assert.equal(options.signal, undefined);
      return JSON.stringify(validMetadata);
    };
    await verifyWindowsUpdateApplication(root, descriptor, { platform: "win32", arch: "x64", execute,
      inspectRuntime: () => ({ versions: { coop: descriptor.coopVersion } }) });
    for (const metadata of [{ ...validMetadata, signatureStatus: "NotSigned" }, { ...validMetadata, signatureStatus: "HashMismatch" },
      { ...validMetadata, productName: "Other App" }, { ...validMetadata, fileVersion: "1.2.4" }]) {
      await assert.rejects(verifyWindowsUpdateApplication(root, descriptor, { platform: "win32", arch: "x64",
        execute: async () => JSON.stringify(metadata), inspectRuntime: () => assert.fail("invalid candidate reached runtime inspection") }), /signature, identity or version/);
    }
    await assert.rejects(verifyWindowsUpdateApplication(root, descriptor, { platform: "win32", arch: "x64", execute,
      inspectRuntime: () => ({ versions: { coop: "0.1.0" } }) }), /runtime version/);
  });
  await check("changed executable, wrong host and cancellation cannot pass verification", async () => {
    await writeFile(path, fixture());
    await assert.rejects(verifyWindowsUpdateApplication(root, descriptor, { platform: "win32", arch: "x64",
      execute: async () => { await writeFile(path, Buffer.alloc(1024)); return JSON.stringify(validMetadata); } }), /changed during/);
    await assert.rejects(verifyWindowsUpdateApplication(root, descriptor, { platform: "darwin", arch: "x64" }), /target/);
    await assert.rejects(verifyWindowsUpdateApplication(root, descriptor, { platform: "win32", arch: "x64", signal: AbortSignal.abort(new Error("cancelled")) }), /cancelled/);
  });
  await check("native metadata helper retains the Windows PowerShell BOM", async () => {
    const source = await readFile(new URL("../desktop/src/update-windows-metadata.ps1", import.meta.url));
    assert.deepEqual([...source.subarray(0, 3)], [239, 187, 191]);
  });
  if (process.platform === "win32") await check("native OS metadata lookup works despite an inherited incompatible module path", async () => {
    await writeFile(path, fixture());
    const previousModules = process.env.PSModulePath;
    process.env.PSModulePath = root;
    try {
      await assert.rejects(verifyWindowsUpdateApplication(root, descriptor, { platform: "win32", arch: "x64" }), /signature, identity or version/);
    } finally {
      if (previousModules === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = previousModules;
    }
  });
  console.log(`  Windows update application tests passed (${count} groups).`);
} finally {
  if (originalRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = originalRoot;
  await rm(root, { recursive: true, force: true });
}

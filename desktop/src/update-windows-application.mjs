import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectManagedRuntime } from "./managed-runtime.mjs";
import { runUpdateCommand } from "./update-installer.mjs";

// Inspect PE headers as data. Never launch a downloaded executable to discover
// its version or architecture.
export async function verifyWindowsExecutable(path, arch) {
  const machine = { x64: 0x8664, arm64: 0xaa64 }[arch];
  if (!machine) throw new Error("Windows update architecture is unsupported.");
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Windows update executable must be a regular file.");
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size < 90) throw new Error("Windows update executable changed or is truncated.");
    const dos = Buffer.alloc(64);
    if ((await handle.read(dos, 0, dos.length, 0)).bytesRead !== dos.length || dos.toString("ascii", 0, 2) !== "MZ") throw new Error("Windows update executable has an invalid DOS header.");
    const offset = dos.readUInt32LE(60);
    if (offset < 64 || offset > stat.size - 26) throw new Error("Windows update executable has an invalid PE offset.");
    const pe = Buffer.alloc(26);
    if ((await handle.read(pe, 0, pe.length, offset)).bytesRead !== pe.length || pe.readUInt32LE(0) !== 0x4550) throw new Error("Windows update executable has an invalid PE header.");
    const optionalBytes = pe.readUInt16LE(20), flags = pe.readUInt16LE(22);
    if (pe.readUInt16LE(4) !== machine || pe.readUInt16LE(24) !== 0x20b || !(flags & 2) || (flags & 0x2000)
      || optionalBytes < 112 || offset + 24 + optionalBytes > stat.size) throw new Error("Windows update executable architecture or type is invalid.");
  } finally { await handle.close(); }
}

export async function verifyWindowsUpdateApplication(app, descriptor, {
  signal, execute = runUpdateCommand, inspectRuntime = inspectManagedRuntime,
  platform = process.platform, arch = process.arch,
} = {}) {
  if (platform !== "win32" || descriptor?.target?.platform !== platform || descriptor.target.arch !== arch) throw new Error("Windows update target does not match this host.");
  signal?.throwIfAborted();
  if (!isAbsolute(app)) throw new Error("Windows update application path must be absolute.");
  const entry = await lstat(app);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Windows update application must be a real directory.");
  const root = await realpath(app), executable = join(root, "Coop Desktop.exe");
  await verifyWindowsExecutable(executable, arch);
  const before = await lstat(executable);
  // Use the OS PowerShell, a fixed script and positional arguments. Candidate
  // paths are never interpolated into shell code. Signature policy is not
  // relaxed for validation packages; those need separate development evidence.
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("Windows system directory is unavailable.");
  const metadata = JSON.parse(await execute(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(dirname(fileURLToPath(import.meta.url)), "update-windows-metadata.ps1"), executable], { signal }));
  const after = await lstat(executable);
  if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Windows update executable changed during verification.");
  if (metadata.signatureStatus !== "Valid" || metadata.productName !== "Coop Desktop" || metadata.fileVersion !== descriptor.desktopVersion) throw new Error("Windows update signature, identity or version does not match its signed descriptor.");
  const runtime = inspectRuntime(join(root, "resources", "managed-runtime"), { platform, arch });
  if (runtime.versions.coop !== descriptor.coopVersion) throw new Error("Windows update runtime version does not match its signed descriptor.");
  signal?.throwIfAborted();
}

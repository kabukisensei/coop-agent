import { copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runUpdateCommand } from "./update-installer.mjs";
import { verifySignedUpdateDescriptor, verifyUpdateArtifact } from "./update-service.mjs";
import { verifyWindowsUpdateApplication } from "./update-windows-application.mjs";

async function identity(path) {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Windows preparation directory is not a real directory.");
  return { device: stat.dev, inode: stat.ino };
}
const same = (left, right) => left.device === right.device && left.inode === right.inode;

// Main-process-only: authenticate a private archive snapshot, extract as data,
// then validate the native application. The current installation is untouched.
export async function prepareWindowsUpdate({ manifestBytes, signature, trustStore, artifactPath, versionRoot, python,
  channel = "stable", arch = process.arch, platform = process.platform, now = Date.now(), signal,
  execute = runUpdateCommand, verifyApplication = verifyWindowsUpdateApplication } = {}) {
  if (platform !== "win32") throw new Error("Windows preparation requires a Windows host.");
  const descriptor = verifySignedUpdateDescriptor({ manifestBytes, signature, trustStore, channel, arch, platform, now });
  signal?.throwIfAborted();
  if (!isAbsolute(versionRoot) || !isAbsolute(python)) throw new Error("Windows update store and trusted Python must be absolute paths.");
  await mkdir(versionRoot, { recursive: true, mode: 0o700 });
  await identity(versionRoot);
  const root = await realpath(versionRoot), parent = await identity(root);
  const staging = await mkdtemp(join(root, ".preparing-")), owned = await identity(staging);
  let location = staging, promoted = false, discarded = false;
  const discard = async () => {
    if (discarded) return false;
    // Both paths are absolute descendants created above. If either directory
    // has been replaced, retain it for inspection instead of deleting it.
    if (!same(await identity(root), parent) || !same(await identity(location), owned)) throw new Error("Prepared Windows update directory changed; preserving it.");
    await rm(location, { recursive: true });
    discarded = true;
    return true;
  };
  try {
    const archive = join(staging, "artifact.zip"), candidate = join(staging, "application");
    await verifyUpdateArtifact(artifactPath, descriptor);
    signal?.throwIfAborted();
    await copyFile(artifactPath, archive, 1 /* COPYFILE_EXCL */);
    await verifyUpdateArtifact(archive, descriptor);
    signal?.throwIfAborted();
    // python must come from the active trusted bundle, never from the candidate.
    await execute(python, ["-I", "-B", join(dirname(fileURLToPath(import.meta.url)), "update-windows-archive.py"), archive, candidate], { signal });
    await verifyApplication(candidate, descriptor, { signal, platform, arch });
    signal?.throwIfAborted();
    await rm(archive);
    const destination = join(root, `${descriptor.releaseId}-${staging.split(".preparing-").pop()}`);
    if (!same(await identity(root), parent) || !same(await identity(staging), owned)) throw new Error("Windows preparation directory changed before promotion.");
    await rename(staging, destination);
    location = destination;
    promoted = true;
    return Object.freeze({ descriptor, installPath: join(destination, "application"), discard });
  } finally {
    if (!promoted) await discard();
  }
}

import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { inspectManagedRuntime } from "./managed-runtime.mjs";
import { verifySignedUpdateDescriptor, verifyUpdateArtifact } from "./update-service.mjs";

// Wait for process exit before cleaning up paths it might still be using.
export function runUpdateCommand(command, args, { signal } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let output = "", failure, killTimer;
    const stop = error => {
      failure ||= error;
      child.kill();
      killTimer ||= setTimeout(() => child.kill("SIGKILL"), 3000);
    };
    const abort = () => stop(new Error("Update preparation cancelled."));
    const timer = setTimeout(() => stop(new Error("Update preparation command timed out.")), 180000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", chunk => {
      if (failure) return;
      if (Buffer.byteLength(output) + chunk.length > 1024 * 1024) stop(new Error("Update preparation command output exceeded its limit."));
      else output += chunk.toString("utf8");
    });
    child.on("error", () => { failure ||= new Error("Update preparation command could not start."); });
    child.on("close", code => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", abort);
      if (failure || code !== 0) reject(failure || new Error("Update preparation command failed."));
      else resolve(output);
    });
  });
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function checkAppTree(app, signal) {
  if (!(await lstat(app)).isDirectory() || (await lstat(app)).isSymbolicLink()) throw new Error("Update application is not a directory.");
  const root = await realpath(app), pending = [root];
  let files = 0, bytes = 0;
  while (pending.length) {
    signal?.throwIfAborted();
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (++files > 250000 || (bytes += stat.size) > 16 * 1024 ** 3) throw new Error("Update application exceeds its extraction limit.");
      if (stat.isSymbolicLink()) {
        if (!inside(root, await realpath(path))) throw new Error("Update application contains an escaping symbolic link.");
      } else if (stat.isDirectory()) pending.push(path);
      else if (!stat.isFile()) throw new Error("Update application contains an unsupported file type.");
    }
  }
}

// Main-process-only preparation. The signed descriptor authorizes the bytes;
// native verification checks that those bytes contain the expected app/runtime.
// No candidate code is executed and no active installation is replaced here.
export async function prepareMacUpdate({ manifestBytes, signature, trustStore, artifactPath, versionRoot,
  channel = "stable", arch = process.arch, platform = process.platform, now = Date.now(), signal,
  execute = runUpdateCommand, inspectRuntime = inspectManagedRuntime } = {}) {
  if (platform !== "darwin") throw new Error("Native update preparation is not available on this platform.");
  const descriptor = verifySignedUpdateDescriptor({ manifestBytes, signature, trustStore, channel, arch, platform, now });
  signal?.throwIfAborted();
  if (!isAbsolute(versionRoot)) throw new Error("Update version store must be absolute.");
  await mkdir(versionRoot, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(versionRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Update version store is invalid.");
  const root = await realpath(versionRoot);
  const staging = await mkdtemp(join(root, ".preparing-"));
  const image = join(staging, "artifact.dmg"), mount = join(staging, "mount");
  let detachNeeded = false, detached = false, promoted = false;
  try {
    // Verify a private snapshot, closing the gap between hash checking and mount.
    await verifyUpdateArtifact(artifactPath, descriptor);
    signal?.throwIfAborted();
    await copyFile(artifactPath, image);
    await verifyUpdateArtifact(image, descriptor);
    signal?.throwIfAborted();
    await mkdir(mount);
    detachNeeded = true;
    await execute("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, image], { signal });
    const sourceApp = join(mount, "Coop Desktop.app");
    await checkAppTree(sourceApp, signal);
    await verifyMacUpdateApplication(sourceApp, descriptor, { signal, execute, inspectRuntime, platform, arch });
    const candidate = join(staging, "Coop Desktop.app");
    await execute("/usr/bin/ditto", [sourceApp, candidate], { signal });
    await checkAppTree(candidate, signal);
    await verifyMacUpdateApplication(candidate, descriptor, { signal, execute, inspectRuntime, platform, arch });
    // Detach even after cancellation; never recursively remove a mounted image.
    await execute("/usr/bin/hdiutil", ["detach", mount]);
    detached = true;
    signal?.throwIfAborted();
    await rm(image); await rm(mount, { recursive: true });
    const destination = join(root, `${descriptor.releaseId}-${staging.split(".preparing-").pop()}`);
    await rename(staging, destination);
    promoted = true;
    const owned = await lstat(destination), parent = await lstat(root);
    let discarded = false;
    return Object.freeze({ descriptor, installPath: join(destination, "Coop Desktop.app"),
      // Only the caller that prepared this detached copy receives its disposer.
      // A changed directory is retained rather than deleting someone else's data.
      discard: async () => {
        if (discarded) return false;
        const current = await lstat(destination), currentParent = await lstat(root);
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino ||
            !currentParent.isDirectory() || currentParent.isSymbolicLink() || currentParent.dev !== parent.dev || currentParent.ino !== parent.ino) throw new Error("Prepared update directory changed; preserving it.");
        await rm(destination, { recursive: true });
        discarded = true;
        return true;
      },
    });
  } finally {
    if (detachNeeded && !detached) {
      try { await execute("/usr/bin/hdiutil", ["detach", mount]); detached = true; }
      catch { /* Preserve uncertain mount state rather than deleting through it. */ }
    }
    if (!promoted && (!detachNeeded || detached)) await rm(staging, { recursive: true, force: true });
  }
}

export async function verifyMacUpdateApplication(app, descriptor, { signal, execute = runUpdateCommand, inspectRuntime = inspectManagedRuntime, platform = process.platform, arch = process.arch } = {}) {
      await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { signal });
      const plist = JSON.parse(await execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(app, "Contents", "Info.plist")], { signal }));
      if (plist.CFBundleIdentifier !== "com.cooptimize.coop.desktop" || plist.CFBundleShortVersionString !== descriptor.desktopVersion || plist.CFBundleExecutable !== "Coop Desktop") throw new Error("Update application identity or version does not match its signed descriptor.");
      await execute("/usr/bin/lipo", ["-verify_arch", arch, join(app, "Contents", "MacOS", "Coop Desktop")], { signal });
      const runtime = inspectRuntime(join(app, "Contents", "Resources", "managed-runtime"), { platform, arch });
      if (runtime.versions.coop !== descriptor.coopVersion) throw new Error("Update runtime version does not match its signed descriptor.");
}

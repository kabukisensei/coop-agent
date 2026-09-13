import { prepareMacUpdate } from "./update-installer.mjs";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { compareVersions, downloadUpdateArtifact, verifySignedUpdateDescriptor, verifyUpdateArtifact } from "./update-service.mjs";

export function validateUpdateFeed(value) {
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["channel", "descriptorUrl", "schemaVersion", "signatureUrl"])) throw new Error("Update feed fields are invalid.");
  if (value.schemaVersion !== 1 || !["stable", "beta"].includes(value.channel)) throw new Error("Update feed contract is invalid.");
  for (const name of ["descriptorUrl", "signatureUrl"]) {
    const url = new URL(value[name]);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Update feed requires public HTTPS URLs.");
  }
  return Object.freeze({ ...value });
}

export function loadPackagedUpdateFeed({ packaged, appPath }) {
  if (!packaged) return null;
  if (!isAbsolute(appPath)) throw new Error("Update feed root is invalid.");
  const root = realpathSync(appPath);
  const path = join(root, "resources", "desktop-update-feed.json");
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  const rel = relative(root, realpathSync(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Packaged update feed escapes its app.");
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("Packaged update feed is invalid.");
  return validateUpdateFeed(JSON.parse(readFileSync(path, "utf8")));
}

async function readResponse(fetchImpl, url, limit, signal) {
  const response = await fetchImpl(url, { redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
  if (response.status !== 200 || !response.body || (response.url && response.url !== url)) throw new Error("Update feed could not be fetched.");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    size += chunk.length;
    if (size > limit) throw new Error("Update feed response exceeds its size limit.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createUpdateController({ feed, trustStore, currentVersion, downloadDir, platform = process.platform, arch = process.arch, now = Date.now, fetchImpl = globalThis.fetch }) {
  if (feed) feed = validateUpdateFeed(feed);
  let state = Object.freeze({ status: feed && trustStore ? "idle" : "unavailable" });
  let pending = null, signed = null, staged = null;
  const publish = (status, extra = {}) => (state = Object.freeze({ status, ...extra }));
  const verified = () => verifySignedUpdateDescriptor({ ...signed, trustStore, platform, arch, channel: feed.channel, now: now() });
  const stagePath = () => join(downloadDir, "staged-update.json");
  function assertDownloadRoot() {
    if (!isAbsolute(downloadDir) || !lstatSync(downloadDir).isDirectory() || lstatSync(downloadDir).isSymbolicLink()) throw new Error("Update download directory is invalid.");
  }
  function checkpoint(artifact) {
    const temporary = `${stagePath()}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, file: basename(artifact.path), manifest: signed.manifestBytes.toString("base64"), signature: signed.signature }) + "\n", { flag: "wx", mode: 0o600 });
      renameSync(temporary, stagePath());
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  function run(kind, operation) {
    if (pending) return pending.kind === kind ? pending.promise : Promise.reject(new Error("Another update operation is in progress."));
    const abort = new AbortController();
    const promise = Promise.resolve().then(() => { abort.signal.throwIfAborted(); return operation(abort.signal); }).catch(error => {
      publish(abort.signal.aborted ? "cancelled" : "error", { message: abort.signal.aborted ? "Update operation cancelled." : error.message });
      throw error;
    }).finally(() => { pending = null; });
    pending = { kind, promise, abort };
    return promise;
  }
  return Object.freeze({
    status: () => state,
    cancel: () => pending?.abort.abort(),
    wait: () => pending?.promise.catch(() => {}) || Promise.resolve(),
    recover: () => run("recover", async signal => {
      if (!feed || !trustStore) return publish("unavailable");
      if (!downloadDir || !existsSync(stagePath())) return null;
      assertDownloadRoot();
      const stat = lstatSync(stagePath());
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error("Saved update metadata is invalid.");
      const value = JSON.parse(readFileSync(stagePath(), "utf8"));
      if (value?.schemaVersion !== 1 || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["file", "manifest", "schemaVersion", "signature"]) || typeof value.manifest !== "string") throw new Error("Saved update metadata is invalid.");
      const manifestBytes = Buffer.from(value.manifest, "base64");
      if (manifestBytes.toString("base64") !== value.manifest) throw new Error("Saved update metadata is invalid.");
      signed = { manifestBytes, signature: value.signature };
      const descriptor = verified();
      if (typeof value.file !== "string" || !value.file.startsWith(`.${descriptor.releaseId}-`) || !/^\.[A-Za-z0-9._-]+-[a-f0-9]{24}\.download$/.test(value.file)) throw new Error("Saved update file reference is invalid.");
      if (compareVersions(descriptor.desktopVersion, currentVersion) <= 0) return null;
      const artifact = await verifyUpdateArtifact(join(downloadDir, value.file), descriptor);
      signal.throwIfAborted();
      staged = { descriptor, artifact };
      return publish("staged", { version: descriptor.desktopVersion, size: artifact.size });
    }),
    check: () => run("check", async signal => {
      if (!feed || !trustStore) return publish("unavailable");
      signed = null;
      staged = null;
      publish("checking");
      const [manifestBytes, signatureBytes] = await Promise.all([
        readResponse(fetchImpl, feed.descriptorUrl, 64 * 1024, signal),
        readResponse(fetchImpl, feed.signatureUrl, 256, signal),
      ]);
      signed = { manifestBytes, signature: signatureBytes.toString("utf8").trim() };
      const descriptor = verified();
      if (compareVersions(descriptor.desktopVersion, currentVersion) <= 0) {
        signed = null;
        return publish("current", { version: currentVersion });
      }
      return publish("available", { version: descriptor.desktopVersion, size: descriptor.artifact.size, notesUrl: descriptor.notesUrl });
    }),
    installationRequest: () => run("handoff", async signal => {
      if (state.status !== "staged" || !staged || !signed) throw new Error("Recover or download an update before installing it.");
      const descriptor = verified();
      const artifact = await verifyUpdateArtifact(staged.artifact.path, descriptor);
      signal.throwIfAborted();
      const fields = ["keyId", "algorithm", "publicKeyPem", "status", "channels", "artifactOrigins", "notesOrigins", "validFrom", "validUntil"];
      return { manifest: signed.manifestBytes.toString("base64"), signature: signed.signature, artifactPath: artifact.path,
        channel: feed.channel, trustStore: { schemaVersion: 1, keys: trustStore.keys.map(key => Object.fromEntries(fields.map(field => [field, key[field]]))) } };
    }),
    prepare: ({ versionRoot } = {}) => run("prepare", async signal => {
      if (state.status !== "staged" || !staged || !signed) throw new Error("Recover or download a verified update before preparing it.");
      publish("preparing", { version: staged.descriptor.desktopVersion });
      const prepared = await prepareMacUpdate({ ...signed, trustStore, artifactPath: staged.artifact.path,
        versionRoot, platform, arch, channel: feed.channel, now: now(), signal });
      publish("prepared", { version: prepared.descriptor.desktopVersion });
      return prepared; // Private main-process path; activation is a separate step.
    }),
    download: ({ onProgress } = {}) => run("download", async signal => {
      if (state.status !== "available" || !signed) throw new Error("Check for an available update before downloading.");
      const descriptor = verified(); // Trust and expiration must still hold at download time.
      if (!isAbsolute(downloadDir)) throw new Error("Update download directory is invalid.");
      mkdirSync(downloadDir, { recursive: true, mode: 0o700 });
      assertDownloadRoot();
      publish("downloading", { version: descriptor.desktopVersion });
      const artifact = await downloadUpdateArtifact({ descriptor, downloadDir, onProgress,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)]), fetchImpl,
      });
      try { signal.throwIfAborted(); checkpoint(artifact); }
      catch (error) { unlinkSync(artifact.path); throw error; }
      staged = { descriptor, artifact };
      publish("staged", { version: descriptor.desktopVersion, size: artifact.size });
      // Kept in the main process; callers must never forward filesystem handles
      // or paths to a renderer as general filesystem capabilities.
      return Object.freeze({ descriptor, artifact });
    }),
  });
}

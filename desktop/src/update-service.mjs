import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HASH = /^[0-9a-f]{64}$/;
const CHANNELS = new Set(["stable", "beta"]);
const PLATFORMS = new Set(["darwin", "win32"]);
const ARCHES = new Set(["arm64", "x64"]);
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_DESCRIPTOR_LIFETIME_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_TRUST_KEYS = 8;

function fail(message) { throw new Error(message); }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) fail(`${label} fields are invalid.`);
}
function version(value, label) { if (typeof value !== "string" || !VERSION.test(value)) fail(`${label} is invalid.`); return value; }
function httpsUrl(value, label) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) fail(`${label} is invalid.`);
    return parsed.href;
  } catch { fail(`${label} is invalid.`); }
}
function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
function timestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) fail(`${label} is invalid.`);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail(`${label} is invalid.`);
  return time;
}
export function compareVersions(left, right) {
  const parse = (value) => {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/);
    return { core: match.slice(1, 4).map(Number), suffix: match[4] || "" };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  if (a.suffix === b.suffix) return 0;
  if (!a.suffix) return 1;
  if (!b.suffix) return -1;
  return a.suffix.localeCompare(b.suffix, "en", { numeric: true });
}
function healthyEvidence(value, target) {
  exactKeys(value, ["state", "evidenceId", "releaseId", "desktopVersion", "coopVersion"], "Update health evidence");
  if (value.state !== "healthy" || !RELEASE_ID.test(value.evidenceId || "")) fail("Update activation requires a healthy verified check.");
  if (value.releaseId !== target.releaseId || value.desktopVersion !== target.desktopVersion || value.coopVersion !== target.coopVersion) fail("Update health evidence does not match the release being activated.");
  return value.evidenceId;
}

function originList(value, label) {
  if (!Array.isArray(value) || value.length < 1 || new Set(value).size !== value.length) fail(`${label} is invalid.`);
  return value.map((entry) => {
    const normalized = httpsUrl(entry, label);
    const parsed = new URL(normalized);
    if (parsed.href !== `${parsed.origin}/`) fail(`${label} must contain HTTPS origins only.`);
    return parsed.origin;
  });
}

const validatedTrustStores = new WeakSet();

export function validateUpdateTrustStore(value) {
  if (validatedTrustStores.has(value)) return value;
  exactKeys(value, ["schemaVersion", "keys"], "Update trust store");
  if (value.schemaVersion !== 1 || !Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > MAX_TRUST_KEYS) fail("Update trust store contract is incompatible.");
  const seen = new Set();
  const keys = value.keys.map((entry) => {
    exactKeys(entry, ["keyId", "algorithm", "publicKeyPem", "status", "channels", "artifactOrigins", "notesOrigins", "validFrom", "validUntil"], "Update trust key");
    if (!RELEASE_ID.test(entry.keyId || "") || seen.has(entry.keyId)) fail("Update trust key ID is invalid or duplicated.");
    seen.add(entry.keyId);
    if (entry.algorithm !== "ed25519" || !new Set(["active", "revoked"]).has(entry.status)) fail(`Update trust key ${entry.keyId} policy is invalid.`);
    if (!Array.isArray(entry.channels) || entry.channels.length < 1 || new Set(entry.channels).size !== entry.channels.length || entry.channels.some((channel) => !CHANNELS.has(channel))) fail(`Update trust key ${entry.keyId} channels are invalid.`);
    const validFrom = timestamp(entry.validFrom, `Update trust key ${entry.keyId} validFrom`);
    const validUntil = timestamp(entry.validUntil, `Update trust key ${entry.keyId} validUntil`);
    if (validUntil <= validFrom) fail(`Update trust key ${entry.keyId} lifetime is invalid.`);
    let publicKey;
    try {
      publicKey = createPublicKey(entry.publicKeyPem);
      if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") fail(`Update trust key ${entry.keyId} is not Ed25519.`);
    } catch (error) {
      if (error.message?.startsWith("Update trust key")) throw error;
      fail(`Update trust key ${entry.keyId} is invalid.`);
    }
    return Object.freeze({
      ...entry,
      channels: Object.freeze([...entry.channels]),
      artifactOrigins: Object.freeze(originList(entry.artifactOrigins, `Update trust key ${entry.keyId} artifact origins`)),
      notesOrigins: Object.freeze(originList(entry.notesOrigins, `Update trust key ${entry.keyId} notes origins`)),
      publicKey,
      validFromMs: validFrom,
      validUntilMs: validUntil,
    });
  });
  const validated = Object.freeze({ schemaVersion: 1, keys: Object.freeze(keys) });
  validatedTrustStores.add(validated);
  return validated;
}

export function validateUpdateDescriptor(value, { platform = process.platform, arch = process.arch, channel = "stable", now = Date.now() } = {}) {
  exactKeys(value, ["schemaVersion", "keyId", "releaseId", "channel", "desktopVersion", "coopVersion", "protocolVersion", "target", "issuedAt", "expiresAt", "artifact", "notesUrl"], "Update descriptor");
  if (value.schemaVersion !== 1 || value.protocolVersion !== 1) fail("Update descriptor contract is incompatible.");
  if (!RELEASE_ID.test(value.keyId || "")) fail("Update key ID is invalid.");
  if (!RELEASE_ID.test(value.releaseId || "")) fail("Update release ID is invalid.");
  if (!CHANNELS.has(value.channel) || !CHANNELS.has(channel)) fail("Update channel is invalid.");
  if (channel === "stable" && value.channel !== "stable") fail("Beta updates are not accepted on the stable channel.");
  version(value.desktopVersion, "Desktop version");
  version(value.coopVersion, "Coop version");
  exactKeys(value.target, ["platform", "arch"], "Update target");
  if (!PLATFORMS.has(value.target.platform) || !ARCHES.has(value.target.arch) || value.target.platform !== platform || value.target.arch !== arch) fail("Update target does not match this Desktop host.");
  const issuedAt = timestamp(value.issuedAt, "Update issuedAt");
  const expiresAt = timestamp(value.expiresAt, "Update expiresAt");
  if (issuedAt > now + 5 * 60 * 1000) fail("Update descriptor was issued in the future.");
  if (expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_DESCRIPTOR_LIFETIME_MS) fail("Update descriptor is expired or has an invalid lifetime.");
  exactKeys(value.artifact, ["url", "sha256", "size"], "Update artifact");
  httpsUrl(value.artifact.url, "Update artifact URL");
  httpsUrl(value.notesUrl, "Update notes URL");
  if (!HASH.test(value.artifact.sha256 || "") || !Number.isSafeInteger(value.artifact.size) || value.artifact.size < 1 || value.artifact.size > MAX_ARTIFACT_BYTES) fail("Update artifact metadata is invalid.");
  const descriptor = structuredClone(value);
  Object.freeze(descriptor.target);
  Object.freeze(descriptor.artifact);
  return Object.freeze(descriptor);
}

export function verifySignedUpdateDescriptor({ manifestBytes, signature, trustStore, ...expected } = {}) {
  const bytes = Buffer.isBuffer(manifestBytes) ? manifestBytes : Buffer.from(manifestBytes || "", "utf8");
  if (!bytes.length || bytes.length > MAX_DESCRIPTOR_BYTES) fail("Update descriptor size is invalid.");
  if (typeof signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) fail("Update signature is invalid.");
  const signatureBytes = Buffer.from(signature, "base64");
  if (signatureBytes.length !== 64 || signatureBytes.toString("base64") !== signature) fail("Update signature is invalid.");
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { fail("Update descriptor JSON is invalid."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !RELEASE_ID.test(parsed.keyId || "")) fail("Update descriptor key ID is invalid.");
  const validatedTrustStore = validateUpdateTrustStore(trustStore);
  const policy = validatedTrustStore.keys.find((entry) => entry.keyId === parsed.keyId);
  if (!policy) fail("Update descriptor signing key is not trusted.");
  if (policy.status !== "active") fail("Update descriptor signing key is revoked.");
  let signatureTrusted = false;
  try { signatureTrusted = verify(null, bytes, policy.publicKey, signatureBytes); } catch { signatureTrusted = false; }
  if (!signatureTrusted) fail("Update signature verification failed.");
  const descriptor = validateUpdateDescriptor(parsed, expected);
  const issuedAt = Date.parse(descriptor.issuedAt);
  if (issuedAt < policy.validFromMs || issuedAt >= policy.validUntilMs) fail("Update descriptor was signed outside the trusted key lifetime.");
  if (!policy.channels.includes(descriptor.channel)) fail("Update signing key is not authorized for this channel.");
  if (!policy.artifactOrigins.includes(new URL(descriptor.artifact.url).origin) || !policy.notesOrigins.includes(new URL(descriptor.notesUrl).origin)) fail("Update descriptor URL origin is not authorized by the signing key policy.");
  return descriptor;
}

export async function verifyUpdateArtifact(path, descriptor) {
  if (typeof path !== "string" || !isAbsolute(path) || /[\0\r\n]/.test(path)) fail("Downloaded update path is invalid.");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== descriptor.artifact.size) fail("Downloaded update artifact metadata does not match the signed descriptor.");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < stat.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (!bytesRead) fail("Downloaded update artifact ended while being verified.");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const actual = hash.digest("hex");
    if (actual !== descriptor.artifact.sha256) fail("Downloaded update artifact checksum does not match the signed descriptor.");
    const current = lstatSync(path);
    if (!current.isFile() || current.isSymbolicLink() || current.size !== stat.size || current.dev !== stat.dev || current.ino !== stat.ino) fail("Downloaded update artifact path changed during verification.");
    return Object.freeze({ ok: true, path: realpathSync(path), sha256: actual, size: stat.size, device: stat.dev, inode: stat.ino, modifiedMs: stat.mtimeMs });
  } catch (error) {
    if (error.message?.startsWith("Downloaded update artifact")) throw error;
    fail("Downloaded update artifact metadata could not be verified.");
  } finally {
    await handle?.close();
  }
}

export async function downloadUpdateArtifact({ descriptor, downloadDir, fetchImpl = globalThis.fetch, signal, onProgress } = {}) {
  if (!descriptor?.artifact || !RELEASE_ID.test(descriptor.releaseId || "")) fail("A verified update descriptor is required for download.");
  if (typeof fetchImpl !== "function" || typeof downloadDir !== "string" || !isAbsolute(downloadDir)) fail("Update download configuration is invalid.");
  let root;
  try {
    root = realpathSync(downloadDir);
    if (!lstatSync(root).isDirectory()) fail("Update download directory is invalid.");
  } catch (error) {
    if (error.message === "Update download directory is invalid.") throw error;
    fail("Update download directory is invalid.");
  }
  const path = join(root, `.${descriptor.releaseId}-${randomBytes(12).toString("hex")}.download`);
  let handle;
  try {
    signal?.throwIfAborted();
    handle = await open(path, "wx", 0o600);
    const response = await fetchImpl(descriptor.artifact.url, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "accept-encoding": "identity" },
      signal,
    });
    if (!response || response.status !== 200 || !response.body) fail(`Update download failed (${response?.status || "no response"}).`);
    if (response.url && response.url !== descriptor.artifact.url) fail("Update download URL changed unexpectedly.");
    const encoding = response.headers?.get?.("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") fail("Compressed update transport is not accepted.");
    const contentLength = response.headers?.get?.("content-length");
    if (contentLength !== null && contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) !== descriptor.artifact.size)) fail("Update download length does not match the signed descriptor.");
    const hash = createHash("sha256");
    let size = 0;
    for await (const value of response.body) {
      signal?.throwIfAborted();
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > descriptor.artifact.size) fail("Update download exceeded the signed size.");
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) fail("Update download could not be written completely.");
        offset += bytesWritten;
      }
      onProgress?.({ received: size, total: descriptor.artifact.size });
    }
    if (size !== descriptor.artifact.size || hash.digest("hex") !== descriptor.artifact.sha256) fail("Update download does not match the signed artifact metadata.");
    await handle.sync();
    await handle.close();
    handle = null;
    const verified = await verifyUpdateArtifact(path, descriptor);
    signal?.throwIfAborted();
    return verified;
  } catch (error) {
    try { await handle?.close(); } catch { /* best-effort cleanup */ }
    try { unlinkSync(path); } catch { /* absent or already cleaned */ }
    throw error;
  }
}

function validateInstalled(value, versionRoot, label) {
  if (value === null) return null;
  exactKeys(value, ["releaseId", "desktopVersion", "coopVersion", "keyId", "artifactSha256", "installPath", "activatedAt", "healthEvidenceId"], label);
  if (!RELEASE_ID.test(value.releaseId || "") || !VERSION.test(value.desktopVersion || "") || !VERSION.test(value.coopVersion || "") || !RELEASE_ID.test(value.keyId || "") || !HASH.test(value.artifactSha256 || "") || typeof value.healthEvidenceId !== "string" || !RELEASE_ID.test(value.healthEvidenceId)) fail(`${label} is invalid.`);
  timestamp(value.activatedAt, `${label} activatedAt`);
  if (!isAbsolute(value.installPath)) fail(`${label} install path escapes the version store.`);
  let installed;
  try { installed = realpathSync(value.installPath); } catch { fail(`${label} install path is unavailable.`); }
  if (!inside(versionRoot, installed) || !lstatSync(installed).isDirectory()) fail(`${label} install path escapes the version store.`);
  return Object.freeze({ ...value, installPath: installed });
}

export function loadUpdateState(path, { versionRoot, defaultChannel = "stable" } = {}) {
  if (!isAbsolute(path) || !isAbsolute(versionRoot) || !CHANNELS.has(defaultChannel)) fail("Update state paths or channel are invalid.");
  let root;
  try { root = realpathSync(versionRoot); } catch { fail("Update version store is unavailable."); }
  if (!existsSync(path)) return Object.freeze({ schemaVersion: 1, channel: defaultChannel, active: null, previous: null });
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { fail("Update state is unreadable or invalid."); }
  exactKeys(value, ["schemaVersion", "channel", "active", "previous"], "Update state");
  if (value.schemaVersion !== 1 || !CHANNELS.has(value.channel)) fail("Update state contract is incompatible.");
  return Object.freeze({ schemaVersion: 1, channel: value.channel, active: validateInstalled(value.active, root, "Active update"), previous: validateInstalled(value.previous, root, "Previous update") });
}

export function planUpdateActivation({ state, descriptor, installPath, versionRoot, runtimeActive = false } = {}) {
  if (runtimeActive) fail("A live Coop Runtime must stop before update activation.");
  const root = realpathSync(versionRoot);
  const installed = realpathSync(installPath);
  if (!inside(root, installed) || !lstatSync(installed).isDirectory()) fail("Update install path is outside the version store.");
  if (state.channel === "stable" && descriptor.channel !== "stable") fail("Beta updates are not accepted on the stable channel.");
  if (state.active?.releaseId === descriptor.releaseId) return Object.freeze({ kind: "already-active", from: state.active, to: state.active });
  if (state.active && compareVersions(descriptor.desktopVersion, state.active.desktopVersion) <= 0) fail("Update activation cannot downgrade or replace the active Desktop version; use verified rollback.");
  return Object.freeze({ kind: "activate", from: state.active, to: Object.freeze({ releaseId: descriptor.releaseId, desktopVersion: descriptor.desktopVersion, coopVersion: descriptor.coopVersion, keyId: descriptor.keyId, artifactSha256: descriptor.artifact.sha256, installPath: installed }) });
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* absent or already renamed */ }
    throw error;
  }
}

export function recordHealthyActivation(path, { state, plan, health, runtimeActive = false, now = new Date().toISOString() } = {}) {
  if (runtimeActive) fail("A live Coop Runtime must stop before update activation.");
  if (plan.kind === "already-active") return state;
  if (plan.kind !== "activate") fail("A healthy activation requires a valid activation plan.");
  const healthEvidenceId = healthyEvidence(health, plan.to);
  timestamp(now, "Activation timestamp");
  const active = Object.freeze({ ...plan.to, activatedAt: now, healthEvidenceId });
  const next = Object.freeze({ schemaVersion: 1, channel: state.channel, active, previous: state.active });
  atomicWrite(path, next);
  return next;
}

export function rollbackToPrevious(path, { state, runtimeActive = false, health, now = new Date().toISOString() } = {}) {
  if (runtimeActive) fail("A live Coop Runtime must stop before rollback.");
  if (!state.previous) fail("No verified rollback version is available.");
  const healthEvidenceId = healthyEvidence(health, state.previous);
  timestamp(now, "Rollback timestamp");
  const restored = Object.freeze({ ...state.previous, activatedAt: now, healthEvidenceId });
  const next = Object.freeze({ schemaVersion: 1, channel: state.channel, active: restored, previous: state.active });
  atomicWrite(path, next);
  return next;
}

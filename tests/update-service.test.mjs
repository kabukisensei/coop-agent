import { createHealthProfile, waitForProbeGroupExit } from "../desktop/src/update-health-profile.mjs";
import { canStartMacApplication } from "../desktop/src/update-startup.mjs";
import { pruneCompletedRecoveryJobs, recoveryJobIsIdle } from "../desktop/src/update-recovery-retention.mjs";
import { createMacRecoveryJob, recoveryJobPlist } from "../desktop/src/update-recovery-job.mjs";
import { recoveryPaths, runRecoveryWorker, readRecoveryRecord } from "../desktop/src/update-recovery-worker.mjs";
import { swapMacDirectories } from "../desktop/src/update-swap.mjs";
import { nativeApplicationHealth } from "../desktop/src/update-native-health.mjs";
import { presentUpdateOutcome } from "../desktop/src/update-outcome.mjs";
import { launchUpdateHelper } from "../desktop/src/update-handoff.mjs";
import { runtimeHealth, runUpdateHelper, validateHelperRequest, waitForStoppedProcesses } from "../desktop/src/update-helper.mjs";
import { replaceMacApplication, recoverMacReplacement, inspectMacReplacement } from "../desktop/src/update-replacement.mjs";
import { spawn, spawnSync } from "node:child_process";
import { prepareMacUpdate, runUpdateCommand } from "../desktop/src/update-installer.mjs";
import vm from "node:vm";
import { createUpdateController, loadPackagedUpdateFeed, validateUpdateFeed } from "../desktop/src/update-controller.mjs";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { cpSync, existsSync, realpathSync, renameSync, statSync, rmSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  downloadUpdateArtifact,
  loadUpdateState,
  planUpdateActivation,
  recordHealthyActivation,
  rollbackToPrevious,
  validateUpdateDescriptor,
  validateUpdateTrustStore,
  verifySignedUpdateDescriptor,
  verifyUpdateArtifact,
} from "../desktop/src/update-service.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = JSON.parse(readFileSync(join(ROOT, "config", "desktop-update.schema.json"), "utf8"));
const STATE_SCHEMA = JSON.parse(readFileSync(join(ROOT, "config", "desktop-update-state.schema.json"), "utf8"));
const TRUST_SCHEMA = JSON.parse(readFileSync(join(ROOT, "config", "desktop-update-trust.schema.json"), "utf8"));
const NOW = Date.parse("2026-09-05T14:00:00.000Z");
let count = 0;
async function test(name, fn) { await fn(); count += 1; console.log(`  ✓ ${name}`); }

function descriptor(overrides = {}) {
  return {
    schemaVersion: 1,
    keyId: "coop-desktop-release-2026-01",
    releaseId: "desktop-1.0.1-darwin-arm64",
    channel: "stable",
    desktopVersion: "1.0.1",
    coopVersion: "0.23.1",
    protocolVersion: 1,
    target: { platform: "darwin", arch: "arm64" },
    issuedAt: "2026-09-05T13:00:00.000Z",
    expiresAt: "2026-09-12T13:00:00.000Z",
    artifact: { url: "https://updates.example.test/coop-desktop-1.0.1.pkg", sha256: "a".repeat(64), size: 10 },
    notesUrl: "https://updates.example.test/releases/1.0.1",
    ...overrides,
  };
}

function trustStore(publicKey, overrides = {}) {
  return {
    schemaVersion: 1,
    keys: [{
      keyId: "coop-desktop-release-2026-01",
      algorithm: "ed25519",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
      status: "active",
      channels: ["stable", "beta"],
      artifactOrigins: ["https://updates.example.test"],
      notesOrigins: ["https://updates.example.test"],
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2027-01-01T00:00:00.000Z",
      ...overrides,
    }],
  };
}

function healthy(target, evidenceId) {
  return {
    state: "healthy",
    evidenceId,
    releaseId: target.releaseId,
    desktopVersion: target.desktopVersion,
    coopVersion: target.coopVersion,
  };
}

await test("checked-in update and activation-state schemas are strict and versioned", () => {
  assert.equal(SCHEMA.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(STATE_SCHEMA.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(TRUST_SCHEMA.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(SCHEMA.additionalProperties, false);
  assert.equal(STATE_SCHEMA.additionalProperties, false);
  assert.equal(TRUST_SCHEMA.additionalProperties, false);
  assert.deepEqual(SCHEMA.properties.channel.enum, ["stable", "beta"]);
});

await test("only an app-pinned active Ed25519 key can authenticate the exact descriptor bytes", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const bytes = Buffer.from(`${JSON.stringify(descriptor())}\n`);
  const signature = sign(null, bytes, privateKey).toString("base64");
  const trust = trustStore(publicKey);
  assert.equal(validateUpdateTrustStore(trust).keys[0].keyId, "coop-desktop-release-2026-01");
  const verified = verifySignedUpdateDescriptor({ manifestBytes: bytes, signature, trustStore: trust, platform: "darwin", arch: "arm64", now: NOW });
  assert.equal(verified.releaseId, "desktop-1.0.1-darwin-arm64");
  const tampered = Buffer.from(bytes.toString("utf8").replace("1.0.1", "1.0.2"));
  assert.throws(() => verifySignedUpdateDescriptor({ manifestBytes: tampered, signature, trustStore: trust, platform: "darwin", arch: "arm64", now: NOW }), /signature verification failed/);
  assert.throws(() => verifySignedUpdateDescriptor({ manifestBytes: bytes, signature: "bad", trustStore: trust, platform: "darwin", arch: "arm64", now: NOW }), /signature/);
  const { publicKey: unrelatedKey } = generateKeyPairSync("ed25519");
  assert.throws(() => verifySignedUpdateDescriptor({ manifestBytes: bytes, signature, trustStore: trustStore(unrelatedKey), platform: "darwin", arch: "arm64", now: NOW }), /signature verification failed/);
  assert.throws(() => verifySignedUpdateDescriptor({ manifestBytes: bytes, signature, trustStore: trustStore(publicKey, { status: "revoked" }), platform: "darwin", arch: "arm64", now: NOW }), /revoked/);
});

await test("signing-key policy constrains key lifetime, channel, and signed URL origins", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signed = (value) => {
    const manifestBytes = Buffer.from(`${JSON.stringify(value)}\n`);
    return { manifestBytes, signature: sign(null, manifestBytes, privateKey).toString("base64") };
  };
  const invoke = (value, trust = trustStore(publicKey)) => verifySignedUpdateDescriptor({ ...signed(value), trustStore: trust, platform: "darwin", arch: "arm64", channel: "beta", now: NOW });
  assert.throws(() => invoke(descriptor({ artifact: { ...descriptor().artifact, url: "https://mirror.example.test/app.pkg" } })), /origin/);
  assert.throws(() => invoke(descriptor({ channel: "beta" }), trustStore(publicKey, { channels: ["stable"] })), /not authorized for this channel/);
  assert.throws(() => invoke(descriptor(), trustStore(publicKey, { validFrom: "2026-09-05T13:00:01.000Z" })), /outside the trusted key lifetime/);
  assert.throws(() => invoke(descriptor({ keyId: "unknown-key" })), /not trusted/);
});

await test("channel, target, expiry, URL credentials, and unknown descriptor fields fail closed", () => {
  assert.throws(() => validateUpdateDescriptor(descriptor({ channel: "beta" }), { platform: "darwin", arch: "arm64", channel: "stable", now: NOW }), /Beta updates/);
  assert.throws(() => validateUpdateDescriptor(descriptor(), { platform: "win32", arch: "x64", now: NOW }), /target/);
  assert.throws(() => validateUpdateDescriptor(descriptor({ expiresAt: "2026-09-05T13:59:59.000Z" }), { platform: "darwin", arch: "arm64", now: NOW }), /expired/);
  assert.throws(() => validateUpdateDescriptor(descriptor({ notesUrl: "https://user:secret@example.test/notes" }), { platform: "darwin", arch: "arm64", now: NOW }), /notes URL/);
  assert.throws(() => validateUpdateDescriptor({ ...descriptor(), surprise: true }, { platform: "darwin", arch: "arm64", now: NOW }), /fields/);
});

await test("downloaded artifacts require exact signed size/hash and cannot be symlinks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-update-artifact-"));
  const artifact = join(dir, "desktop.pkg");
  const bytes = Buffer.from("package-v1");
  writeFileSync(artifact, bytes);
  const valid = validateUpdateDescriptor(descriptor({ artifact: { ...descriptor().artifact, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } }), { platform: "darwin", arch: "arm64", now: NOW });
  assert.equal((await verifyUpdateArtifact(artifact, valid)).ok, true);
  writeFileSync(artifact, "tampered");
  await assert.rejects(() => verifyUpdateArtifact(artifact, valid), /metadata|checksum/);
  const target = join(dir, "target.pkg");
  writeFileSync(target, bytes);
  const link = join(dir, "link.pkg");
  symlinkSync(target, link);
  await assert.rejects(() => verifyUpdateArtifact(link, valid), /metadata/);
});

await test("artifact download is direct, bounded, exclusive, verified, and cleans failed partials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-update-download-"));
  const bytes = Buffer.from("signed-package");
  const valid = validateUpdateDescriptor(descriptor({ artifact: { ...descriptor().artifact, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } }), { platform: "darwin", arch: "arm64", now: NOW });
  const fetchCalls = [];
  const downloaded = await downloadUpdateArtifact({
    descriptor: valid,
    downloadDir: dir,
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
    },
  });
  assert.equal(readFileSync(downloaded.path).toString(), bytes.toString());
  assert.equal(fetchCalls[0].url, valid.artifact.url);
  assert.equal(fetchCalls[0].options.redirect, "error");
  assert.equal(fetchCalls[0].options.headers["accept-encoding"], "identity");

  const before = new Set(readdirSync(dir));
  await assert.rejects(() => downloadUpdateArtifact({
    descriptor: valid,
    downloadDir: dir,
    fetchImpl: async () => new Response(Buffer.concat([bytes, Buffer.from("tamper")]), { status: 200 }),
  }), /exceeded|does not match/);
  assert.deepEqual(new Set(readdirSync(dir)), before);
  await assert.rejects(() => downloadUpdateArtifact({
    descriptor: valid,
    downloadDir: dir,
    fetchImpl: async () => ({ status: 200, url: "https://redirect.example.test/app.pkg", headers: new Headers(), body: new Response(bytes).body }),
  }), /URL changed/);
  assert.deepEqual(new Set(readdirSync(dir)), before);
});

await test("activation is runtime-stopped, upgrade-only, health-gated, atomic, and keeps one rollback", () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-update-state-"));
  const versions = join(dir, "versions");
  const v100 = join(versions, "1.0.0");
  const v101 = join(versions, "1.0.1");
  mkdirSync(v100, { recursive: true });
  mkdirSync(v101, { recursive: true });
  const statePath = join(dir, "active.json");
  let state = loadUpdateState(statePath, { versionRoot: versions });
  const firstDescriptor = descriptor({ releaseId: "desktop-1.0.0", desktopVersion: "1.0.0" });
  const firstPlan = planUpdateActivation({ state, descriptor: firstDescriptor, installPath: v100, versionRoot: versions });
  assert.throws(() => recordHealthyActivation(statePath, { state, plan: firstPlan, health: { ...healthy(firstPlan.to, "doctor-100"), state: "warning" } }), /healthy/);
  assert.throws(() => recordHealthyActivation(statePath, { state, plan: firstPlan, health: healthy({ ...firstPlan.to, releaseId: "wrong-release" }, "doctor-wrong") }), /does not match/);
  assert.throws(() => recordHealthyActivation(statePath, { state, plan: firstPlan, health: healthy(firstPlan.to, "doctor-live"), runtimeActive: true }), /must stop/);
  state = recordHealthyActivation(statePath, { state, plan: firstPlan, health: healthy(firstPlan.to, "doctor-100"), now: "2026-09-05T14:01:00.000Z" });
  assert.equal(loadUpdateState(statePath, { versionRoot: versions }).active.desktopVersion, "1.0.0");
  assert.equal(state.active.keyId, firstDescriptor.keyId);
  assert.equal(state.active.artifactSha256, firstDescriptor.artifact.sha256);
  const nextDescriptor = descriptor();
  assert.throws(() => planUpdateActivation({ state, descriptor: nextDescriptor, installPath: v101, versionRoot: versions, runtimeActive: true }), /must stop/);
  const nextPlan = planUpdateActivation({ state, descriptor: nextDescriptor, installPath: v101, versionRoot: versions });
  state = recordHealthyActivation(statePath, { state, plan: nextPlan, health: healthy(nextPlan.to, "doctor-101"), now: "2026-09-05T14:02:00.000Z" });
  assert.equal(state.active.desktopVersion, "1.0.1");
  assert.equal(state.previous.desktopVersion, "1.0.0");
  assert.throws(() => planUpdateActivation({ state, descriptor: firstDescriptor, installPath: v100, versionRoot: versions }), /cannot downgrade/);
  state = rollbackToPrevious(statePath, { state, health: healthy(state.previous, "doctor-rollback-100"), now: "2026-09-05T14:03:00.000Z" });
  assert.equal(state.active.desktopVersion, "1.0.0");
  assert.equal(state.previous.desktopVersion, "1.0.1");
});

await test("corrupt activation state and paths outside the version store never recover silently", () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-update-corrupt-"));
  const versions = join(dir, "versions");
  mkdirSync(versions);
  const statePath = join(dir, "active.json");
  writeFileSync(statePath, "not-json");
  assert.throws(() => loadUpdateState(statePath, { versionRoot: versions }), /unreadable/);
  const outside = join(dir, "outside");
  mkdirSync(outside);
  const state = { schemaVersion: 1, channel: "stable", active: null, previous: null };
  assert.throws(() => planUpdateActivation({ state, descriptor: descriptor(), installPath: outside, versionRoot: versions }), /outside/);
});

await test("update feed is packaged-only, bounded and rejects unsafe configuration", async () => {
  const base = mkdtempSync(join(tmpdir(), "coop-feed-"));
  assert.equal(loadPackagedUpdateFeed({ packaged: false, appPath: base }), null);
  assert.equal(loadPackagedUpdateFeed({ packaged: true, appPath: base }), null);
  mkdirSync(join(base, "resources"));
  const feed = { schemaVersion: 1, channel: "stable", descriptorUrl: "https://updates.example.test/latest.json", signatureUrl: "https://updates.example.test/latest.sig" };
  writeFileSync(join(base, "resources/desktop-update-feed.json"), JSON.stringify(feed));
  assert.deepEqual(loadPackagedUpdateFeed({ packaged: true, appPath: base }), feed);
  assert.throws(() => validateUpdateFeed({ ...feed, descriptorUrl: "http://updates.example.test/latest.json" }), /HTTPS/);
  assert.throws(() => validateUpdateFeed({ ...feed, extra: true }), /fields/);
  let requests = 0;
  const unconfigured = createUpdateController({ currentVersion: "1.0.0", fetchImpl: () => { requests++; } });
  assert.equal((await unconfigured.check()).status, "unavailable");
  assert.equal(requests, 0);
});

await test("controller checks a signed update once and stages only verified bytes", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const data = Buffer.from("installer fixture");
  const manifestBytes = Buffer.from(JSON.stringify(descriptor({ artifact: { url: "https://updates.example.test/update.dmg", sha256: createHash("sha256").update(data).digest("hex"), size: data.length } })));
  const signature = sign(null, manifestBytes, privateKey).toString("base64");
  const feed = { schemaVersion: 1, channel: "stable", descriptorUrl: "https://updates.example.test/latest.json", signatureUrl: "https://updates.example.test/latest.sig" };
  const requests = [];
  const controller = createUpdateController({ feed, trustStore: trustStore(publicKey), currentVersion: "1.0.0", platform: "darwin", arch: "arm64", now: () => NOW,
    downloadDir: join(mkdtempSync(join(tmpdir(), "coop-controller-")), "downloads"),
    fetchImpl: async (url, options) => {
      requests.push(url);
      assert.equal(options.redirect, "error");
      assert.equal(options.credentials, "omit");
      return new Response(url === feed.descriptorUrl ? manifestBytes : url === feed.signatureUrl ? signature : data);
    },
  });
  const first = controller.check(), second = controller.check();
  assert.equal(first, second, "concurrent checks share one request pair");
  assert.equal((await first).status, "available");
  assert.equal(requests.length, 2);
  const result = await controller.download();
  assert.equal(readFileSync(result.artifact.path).toString(), data.toString());
  assert.equal(controller.status().status, "staged");
  assert.doesNotMatch(JSON.stringify(controller.status()), /download|path|privateKey/);
});

await test("controller rejects tampering, oversized feeds and expiration before downloading", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const bytes = Buffer.from(JSON.stringify(descriptor()));
  const signature = sign(null, bytes, privateKey).toString("base64");
  const feed = { schemaVersion: 1, channel: "stable", descriptorUrl: "https://updates.example.test/latest.json", signatureUrl: "https://updates.example.test/latest.sig" };
  let time = NOW, mode = "valid", artifactRequests = 0;
  const options = { feed, trustStore: trustStore(publicKey), currentVersion: "1.0.0", platform: "darwin", arch: "arm64", now: () => time,
    fetchImpl: async url => {
      if (url === feed.signatureUrl) return new Response(signature);
      if (url === feed.descriptorUrl) return new Response(mode === "oversize" ? Buffer.alloc(65537) : mode === "tamper" ? Buffer.from(bytes.toString().replace("1.0.1", "9.0.1")) : bytes);
      artifactRequests++; throw new Error("unexpected download");
    },
  };
  const controller = createUpdateController(options);
  mode = "tamper"; await assert.rejects(controller.check, /signature/);
  mode = "oversize"; await assert.rejects(controller.check, /size limit/);
  mode = "valid"; await controller.check();
  time = Date.parse("2026-09-13T00:00:00Z");
  await assert.rejects(controller.download, /expired/);
  assert.equal(artifactRequests, 0);
  time = NOW;
  const current = createUpdateController({ ...options, currentVersion: "2.0.0" });
  assert.equal((await current.check()).status, "current");
  await assert.rejects(current.download, /Check for an available update/);
});

function controllerFixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const data = Buffer.from("download recovery fixture");
  const bytes = Buffer.from(JSON.stringify(descriptor({ artifact: { url: "https://updates.example.test/update.dmg", sha256: createHash("sha256").update(data).digest("hex"), size: data.length } })));
  const signature = sign(null, bytes, privateKey).toString("base64");
  const feed = { schemaVersion: 1, channel: "stable", descriptorUrl: "https://updates.example.test/latest.json", signatureUrl: "https://updates.example.test/latest.sig" };
  const options = { feed, trustStore: trustStore(publicKey), currentVersion: "1.0.0", platform: "darwin", arch: "arm64", now: () => NOW,
    downloadDir: join(mkdtempSync(join(tmpdir(), "coop-recover-download-")), "downloads"),
    fetchImpl: async url => new Response(url === feed.descriptorUrl ? bytes : url === feed.signatureUrl ? signature : data),
  };
  return { options, data, controller: createUpdateController(options) };
}

await test("staged updates survive restart only after signature and artifact revalidation", async () => {
  const { controller, options } = controllerFixture();
  await controller.check();
  const { artifact } = await controller.download();
  const restored = createUpdateController({ ...options, fetchImpl: () => { throw new Error("Recovery must not fetch"); } });
  assert.equal((await restored.recover()).status, "staged");
  const pointer = join(options.downloadDir, "staged-update.json");
  const original = readFileSync(pointer, "utf8");
  const escaped = JSON.parse(original); escaped.file = "../../outside";
  writeFileSync(pointer, JSON.stringify(escaped));
  await assert.rejects(restored.recover, /file reference/);
  writeFileSync(pointer, original);
  writeFileSync(artifact.path, Buffer.alloc(artifact.size, 0x61));
  await assert.rejects(restored.recover, /artifact/);
  assert.equal(readFileSync(pointer, "utf8"), original, "failed recovery must preserve its evidence");
  const expired = createUpdateController({ ...options, now: () => Date.parse("2026-09-13T00:00:00Z") });
  await assert.rejects(expired.recover, /expired/);
});

await test("cancelled downloads report progress and leave no partial or staged files", async () => {
  const { controller, options } = controllerFixture();
  await controller.check();
  const progress = [];
  await assert.rejects(() => controller.download({ onProgress: value => { progress.push(value); controller.cancel(); } }), /abort/i);
  await controller.wait();
  assert.ok(progress.length > 0);
  assert.equal(controller.status().status, "cancelled");
  assert.deepEqual(readdirSync(options.downloadDir), []);
  await controller.check();
  await controller.download();
  assert.equal(controller.status().status, "staged", "a cancelled download can be retried");
});

await test("native download flow closes progress, resets the dock indicator and preserves the session", async () => {
  const { controller } = controllerFixture();
  const messages = [], progress = [];
  const source = readFileSync(join(ROOT, "desktop/src/main.mjs"), "utf8");
  const start = source.indexOf("async function downloadUpdateWithProgress()");
  const ctx = vm.createContext({ AbortController, updateController: controller, updateDialogActive: false, quitting: false, runtimeSource: "preview",
    mainWindow: { isDestroyed: () => false, setProgressBar: value => progress.push(value) },
    dialog: { showMessageBox: async (_window, options) => {
      messages.push(options.message);
      if (options.signal) return new Promise(resolve => options.signal.addEventListener("abort", () => resolve({ response: 0 }), { once: true }));
      return { response: 0 };
    } },
  });
  vm.runInContext(source.slice(start, source.indexOf("function installMenu()", start)), ctx);
  await ctx.checkForUpdates();
  assert.equal(controller.status().status, "staged");
  assert.ok(messages.some(message => message.includes("Downloading")));
  assert.ok(messages.some(message => message.includes("downloaded and verified")));
  assert.ok(progress.some(value => value > 0));
  assert.equal(progress.at(-1), -1);
  assert.equal(ctx.updateDialogActive, false);
  const cancelled = controllerFixture();
  ctx.updateController = cancelled.controller;
  ctx.dialog.showMessageBox = async () => ({ response: 0 });
  await ctx.checkForUpdates();
  assert.equal(cancelled.controller.status().status, "cancelled");
  assert.equal(progress.at(-1), -1);
  assert.equal(ctx.updateDialogActive, false);
});

await test("quit awaits update cleanup even after the runtime has crashed", async () => {
  const source = readFileSync(join(ROOT, "desktop/src/main.mjs"), "utf8");
  const calls = [];
  let handler, exited;
  const done = new Promise(resolve => { exited = resolve; });
  const ctx = vm.createContext({
    updateHandoff: null, updateInstallRequested: false,
    app: { on: (_name, callback) => { handler = callback; }, exit: code => { calls.push(`exit:${code}`); exited(); } },
    updateController: { cancel: () => calls.push("cancel"), wait: async () => { calls.push("cleanup"); } },
    runtime: null, quitting: false, navigationBusy: false, checkpointTimer: null, mainWindow: null,
    clearInterval: () => {}, checkpointNavigation: async () => {},
  });
  vm.runInContext(source.slice(source.indexOf('app.on("before-quit"')), ctx);
  handler({ preventDefault: () => calls.push("prevent") });
  await done;
  assert.deepEqual(calls, ["cancel", "prevent", "cleanup", "exit:0"]);
});


function preparationFixture() {
  const root = mkdtempSync(join(tmpdir(), "coop-update-preparation-"));
  const artifactPath = join(root, "download");
  const bytes = Buffer.from("signed fixture image");
  writeFileSync(artifactPath, bytes);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const value = descriptor({ artifact: { url: "https://updates.example.test/update.dmg", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } });
  const manifestBytes = Buffer.from(JSON.stringify(value));
  const calls = [];
  let mount, mode = "valid";
  const abort = new AbortController();
  const options = { manifestBytes, signature: sign(null, manifestBytes, privateKey).toString("base64"), trustStore: trustStore(publicKey),
    artifactPath, versionRoot: join(root, "versions"), platform: "darwin", arch: "arm64", now: NOW, signal: abort.signal,
    inspectRuntime: () => ({ versions: { coop: mode === "runtime" ? "0.0.1" : value.coopVersion } }),
    execute: async (command, args, { signal } = {}) => {
      signal?.throwIfAborted(); calls.push([command, ...args]);
      if (command.endsWith("hdiutil") && args[0] === "attach") {
        mount = args[args.indexOf("-mountpoint") + 1];
        const app = join(mount, "Coop Desktop.app");
        mkdirSync(join(app, "Contents"), { recursive: true });
        writeFileSync(join(app, "Contents", "Info.plist"), "fixture");
        if (mode === "symlink") symlinkSync(artifactPath, join(app, "outside"));
      }
      if (command.endsWith("hdiutil") && args[0] === "detach") {
        if (mode === "detach") throw new Error("fixture detach failure");
        rmSync(join(mount, "Coop Desktop.app"), { recursive: true, force: true });
      }
      if (command.endsWith("codesign") && mode === "signature") throw new Error("fixture native signature failure");
      if (command.endsWith("plutil")) return JSON.stringify({ CFBundleIdentifier: mode === "identity" ? "other.app" : "com.cooptimize.coop.desktop", CFBundleShortVersionString: value.desktopVersion, CFBundleExecutable: "Coop Desktop" });
      if (command.endsWith("ditto")) {
        cpSync(args[0], args[1], { recursive: true });
        if (mode === "cancel") { abort.abort(); abort.signal.throwIfAborted(); }
      }
      return "";
    },
  };
  return { root, calls, options, mode: value => { mode = value; } };
}

await test("signed macOS update preparation verifies before copy and promotes only after detach", async () => {
  const f = preparationFixture();
  try {
    const prepared = await prepareMacUpdate(f.options);
    assert.ok(existsSync(prepared.installPath));
    assert.equal(prepared.descriptor.desktopVersion, "1.0.1");
    assert.ok(prepared.installPath.startsWith(realpathSync(f.options.versionRoot)));
    assert.equal(f.calls.filter(call => call[0].endsWith("codesign")).length, 2);
    assert.equal(f.calls.at(-1)[1], "detach");
    assert.equal(readdirSync(f.options.versionRoot).length, 1);
    assert.deepEqual(readdirSync(dirname(prepared.installPath)), ["Coop Desktop.app"]);
    assert.ok(existsSync(f.options.artifactPath), "the original verified download is retained");
    assert.equal(await prepared.discard(), true);
    assert.equal(existsSync(prepared.installPath), false);
    assert.ok(existsSync(f.options.artifactPath));
    assert.equal(await prepared.discard(), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

await test("prepared copy disposal refuses replaced directories and parent links", async () => {
  for (const mode of ["directory", "parent"]) {
    const f = preparationFixture();
    try {
      const prepared = await prepareMacUpdate(f.options);
      if (mode === "directory") {
        renameSync(dirname(prepared.installPath), dirname(prepared.installPath) + "-saved");
        mkdirSync(dirname(prepared.installPath));writeFileSync(join(dirname(prepared.installPath), "keep"), "replacement");
      } else {
        renameSync(f.options.versionRoot, f.options.versionRoot + "-saved");
        symlinkSync(f.options.versionRoot + "-saved", f.options.versionRoot, "dir");
      }
      await assert.rejects(prepared.discard(), /changed/);
      assert.ok(existsSync(dirname(prepared.installPath)));
      assert.ok(existsSync(f.options.artifactPath));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

await test("bad app identity, runtime, signature, links and cancellation never promote a candidate", async () => {
  for (const mode of ["identity", "runtime", "signature", "symlink", "cancel"]) {
    const f = preparationFixture(); f.mode(mode);
    try {
      await assert.rejects(prepareMacUpdate(f.options));
      assert.deepEqual(readdirSync(f.options.versionRoot), [], mode);
      assert.equal(f.calls.at(-1)[1], "detach", mode);
      assert.ok(existsSync(f.options.artifactPath));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

await test("tampered download is rejected before mounting and uncertain detach preserves the mount", async () => {
  const f = preparationFixture();
  try {
    writeFileSync(f.options.artifactPath, "x".repeat(20));
    await assert.rejects(prepareMacUpdate(f.options), /checksum|metadata/);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(readdirSync(f.options.versionRoot), []);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
  const held = preparationFixture(); held.mode("detach");
  try {
    await assert.rejects(prepareMacUpdate(held.options), /detach/);
    const directories = readdirSync(held.options.versionRoot);
    assert.equal(directories.length, 1);
    assert.ok(directories[0].startsWith(".preparing-"));
    assert.ok(existsSync(join(held.options.versionRoot, directories[0], "mount", "Coop Desktop.app")));
  } finally { rmSync(held.root, { recursive: true, force: true }); }
});

await test("preparation rejects untrusted metadata and unsupported hosts before filesystem writes", async () => {
  const f = preparationFixture();
  try {
    await assert.rejects(prepareMacUpdate({ ...f.options, platform: "win32" }), /not available/);
    await assert.rejects(prepareMacUpdate({ ...f.options, signature: "bad" }), /signature/);
    assert.equal(existsSync(f.options.versionRoot), false);
    assert.equal(f.calls.length, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

await test("controller rechecks recovered bytes before installation preparation", async () => {
  const { options, controller, data } = controllerFixture();
  await controller.check();
  const downloaded = await controller.download();
  const restored = createUpdateController(options);
  await restored.recover();
  writeFileSync(downloaded.artifact.path, Buffer.alloc(data.length, 120));
  const versionRoot = join(dirname(options.downloadDir), "versions");
  await assert.rejects(restored.prepare({ versionRoot }), /checksum/);
  assert.equal(restored.status().status, "error");
  assert.deepEqual(readdirSync(versionRoot), []);
});

await test("native command runner propagates failure and waits for cancelled process exit", async () => {
  await assert.rejects(runUpdateCommand(process.execPath, ["-e", "process.exit(2)"]), /failed/);
  const abort = new AbortController();
  const pending = runUpdateCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, /cancelled/);
});


function fixtureSwap(left, right) {
  const temp = `${left}.swap-test`;
  renameSync(left, temp); renameSync(right, left); renameSync(temp, right);
}

function replacementFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coop-replacement-")));
  const appPath = join(root, "Coop Desktop.app"), candidatePath = join(root, "downloaded.app");
  for (const [path, value] of [[appPath, "old"], [candidatePath, "new"]]) {
    mkdirSync(path); writeFileSync(join(path, "marker"), value);
  }
  const read = path => readFileSync(join(path, "marker"), "utf8");
  const options = { appPath, candidatePath, platform: "darwin", runtimeStopped: true, swap: fixtureSwap,
    execute: async (_command, args) => cpSync(args[0], args[1], { recursive: true }),
    validateCandidate: async path => assert.equal(read(path), "new"), checkHealth: async () => true };
  return { root, read, options, transaction: join(root, ".Coop Desktop.app.coop-update") };
}

await test("replacement preserves the previous app and commits only after a healthy stopped probe", async () => {
  const f = replacementFixture();
  try {
    let probes = 0;
    const result = await replaceMacApplication({ ...f.options, checkHealth: async path => { probes++; return f.read(path) === "new"; } });
    assert.equal(probes, 1);
    assert.equal(result.status, "healthy");
    assert.equal(f.read(f.options.appPath), "new");
    assert.equal(f.read(result.previousPath), "old");
    assert.equal((await recoverMacReplacement(f.options)).status, "healthy");
    await assert.rejects(replaceMacApplication({ ...f.options, runtimeStopped: false }), /Stop/);
    assert.equal(f.read(f.options.appPath), "new");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

await test("failed health, rejected copy and cancellation restore the original without deleting either app", async () => {
  for (const mode of ["health", "copy", "cancel"]) {
    const f = replacementFixture();
    const abort = new AbortController();
    try {
      await assert.rejects(replaceMacApplication({ ...f.options, signal: abort.signal,
        execute: async (command, args) => {
          await f.options.execute(command, args);
          if (mode === "copy") writeFileSync(join(args[1], "marker"), "corrupt");
          if (mode === "cancel") abort.abort();
        }, checkHealth: async () => mode !== "health" }), /previous application is restored/);
      assert.equal(f.read(f.options.appPath), "old");
      assert.equal(f.read(f.options.candidatePath), "new");
      assert.equal((await recoverMacReplacement(f.options)).status, "rolled-back");
      const retry = await replaceMacApplication(f.options);
      assert.equal(retry.status, "healthy", "a rolled-back transaction can be retried");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

await test("a killed update helper recovers the original application on the next run", async () => {
  const f = replacementFixture();
  try {
    const moduleUrl = new URL("../desktop/src/update-replacement.mjs", import.meta.url).href;
    const code = `import {replaceMacApplication} from ${JSON.stringify(moduleUrl)};
      import {cpSync,renameSync} from 'node:fs';
      const fixtureSwap=${fixtureSwap.toString()};
      await replaceMacApplication({appPath:${JSON.stringify(f.options.appPath)},candidatePath:${JSON.stringify(f.options.candidatePath)},platform:'darwin',runtimeStopped:true,swap:fixtureSwap,
        validateCandidate:async()=>{},execute:async(_cmd,args)=>cpSync(args[0],args[1],{recursive:true}),
        checkHealth:async()=>process.kill(process.pid,'SIGKILL')});`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 10000 });
    assert.notEqual(child.status, 0);
    assert.equal(f.read(f.options.appPath), "new");
    assert.equal((await recoverMacReplacement(f.options)).status, "rolled-back");
    assert.equal(f.read(f.options.appPath), "old");
    assert.equal(f.read(join(f.transaction, "failed.app")), "new");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

await test("recovery handles both rename gaps and refuses changed destinations or escaping journals", async () => {
  for (const mode of ["old-moved", "new-moved", "changed", "journal"]) {
    const f = replacementFixture();
    try {
      mkdirSync(f.transaction);
      const candidate = join(f.transaction, "candidate.app"); cpSync(f.options.candidatePath, candidate, { recursive: true });
      const id = path => { const stat = statSync(path, { bigint: true }); return { device: String(stat.dev), inode: String(stat.ino) }; };
      const record = { schemaVersion: 1, phase: "ready", ownerPid: process.pid, original: id(f.options.appPath), candidate: id(candidate) };
      renameSync(f.options.appPath, join(f.transaction, "previous.app"));
      if (mode !== "old-moved") renameSync(candidate, f.options.appPath);
      if (mode === "changed") {
        renameSync(f.options.appPath, join(f.root, "moved-away.app"));
        mkdirSync(f.options.appPath); writeFileSync(join(f.options.appPath, "marker"), "unrelated");
      }
      if (mode === "journal") record.appPath = "/outside.app";
      writeFileSync(join(f.transaction, "transaction.json"), JSON.stringify(record));
      if (["changed", "journal"].includes(mode)) {
        await assert.rejects(recoverMacReplacement(f.options), /changed|journal/);
        assert.ok(existsSync(join(f.transaction, "previous.app")));
      } else {
        assert.equal((await recoverMacReplacement(f.options)).status, "rolled-back");
        assert.equal(f.read(f.options.appPath), "old");
      }
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});


await test("helper handoff preserves signed trust policy and waits for authorization and stopped processes", async () => {
  const { options, controller } = controllerFixture();
  await controller.check(); await controller.download();
  const payload = await controller.installationRequest();
  validateUpdateTrustStore(payload.trustStore);
  const root = dirname(options.downloadDir);
  const request = { ...payload, type: "prepare", parentPid: 123, runtimePid: 456, currentVersion: "1.0.0",
    appPath: join(root, "Coop Desktop.app"), userData: root, versionRoot: join(root, "versions"), workspace: root };
  const calls = [];
  const lifecycle = [];
  const args = { createRecovery: async () => { lifecycle.push("armed"); return { disarm: async () => lifecycle.push("disarmed") }; }, request, parentPid: 123, now: () => NOW, platform: "darwin", arch: "arm64", signal: new AbortController().signal,
    prepare: async () => { calls.push("prepare"); return { installPath: join(root, "candidate.app"), discard: async () => lifecycle.push("discarded") }; },
    notify: value => calls.push(value.type), authorize: async () => calls.push("authorize"),
    waitStopped: async pids => { assert.deepEqual(pids, [123, 456]); calls.push("stopped"); },
    replace: async value => { calls.push("replace"); assert.equal(await value.checkHealth(value.appPath, { signal: args.signal }), true); return { status: "healthy" }; },
    health: async () => { calls.push("health"); return true; },
    execute: async command => { calls.push(command); if (command === "/usr/bin/plutil") return JSON.stringify({ CFBundleIdentifier: "com.cooptimize.coop.desktop", CFBundleShortVersionString: "1.0.0" }); } };
  assert.equal((await runUpdateHelper(args)).status, "healthy");
  assert.deepEqual(lifecycle, ["armed", "disarmed", "discarded"]);
  assert.deepEqual(calls, ["/usr/bin/codesign", "/usr/bin/plutil", "prepare", "ready", "authorize", "stopped", "replace", "health", "/usr/bin/open"]);
  // An unwritable result path must not strand either the new or restored app.
  const unavailableResult = { ...request, userData: join(root, "missing-parent", "userdata") };
  calls.length = 0;
  assert.equal((await runUpdateHelper({ ...args, request: unavailableResult })).status, "healthy");
  assert.deepEqual(calls.slice(-2), ["outcome-unavailable", "/usr/bin/open"]);
  calls.length = 0;
  const restoredError = new Error("Update failed; the previous application is restored.");
  await assert.rejects(runUpdateHelper({ ...args, request: unavailableResult,
    replace: async () => { throw restoredError; } }), error => error === restoredError);
  assert.deepEqual(calls.slice(-3), ["outcome-unavailable", "/usr/bin/codesign", "/usr/bin/open"]);
  calls.length = 0;
  await assert.rejects(runUpdateHelper({ ...args, request: unavailableResult,
    replace: async () => { throw new Error("Recovery requires inspection."); } }), /inspection/);
  assert.ok(!calls.includes("/usr/bin/open"));
  calls.length = 0;
  await assert.rejects(runUpdateHelper({ ...args, request: { ...request, signature: "bad" } }), /signature/);
  assert.deepEqual(calls, []);
  let time = NOW;
  await assert.rejects(runUpdateHelper({ ...args, now: () => time, authorize: async () => { time = NOW + 9 * 86400000; } }), /expired/);
  assert.ok(!calls.includes("replace"));
  assert.equal(lifecycle.at(-1), "armed", "authorized interruption retains recovery job");
  await assert.rejects(runUpdateHelper({ ...args, authorize: async () => { throw new Error("cancelled"); } }), /cancelled/);
  assert.deepEqual(lifecycle.slice(-2), ["disarmed", "discarded"], "cancelled preparation removes recovery job before discarding its copy");
  await assert.rejects(runUpdateHelper({ ...args, createRecovery: async () => { throw new Error("registration failed"); } }), /registration failed/);
  assert.equal(lifecycle.at(-1), "discarded", "unused preparation is discarded when registration fails");
  lifecycle.length = 0;
  await assert.rejects(runUpdateHelper({ ...args, createRecovery: async () => ({ disarm: async () => { throw new Error("disarm failed"); } }) }), /disarm failed/);
  assert.deepEqual(lifecycle, [], "uncertain disarm retains prepared recovery resources");
  assert.equal((await runUpdateHelper({ ...args, prepare: async () => ({ installPath: join(root, "candidate.app"), discard: async () => { throw new Error("disk busy"); } }) })).status, "healthy", "cleanup failure must not fail a healthy update");
  assert.throws(() => validateHelperRequest({ ...request, parentPid: 999 }, 123), /ownership/);
  assert.throws(() => validateHelperRequest({ ...request, extra: true }, 123), /invalid/);
});

await test("helper refuses live processes and honours cancellation while waiting for shutdown", async () => {
  await assert.rejects(waitForStoppedProcesses([123], { timeoutMs: 0, alive: () => true }), /still running/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(waitForStoppedProcesses([123], { signal: abort.signal, alive: () => false }), /abort/i);
  await waitForStoppedProcesses([123], { alive: () => false });
});

await test("private helper transport completes preparation, cancellation and apply over real Node IPC", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coop-helper-ipc-")));
  try {
    const helperPath = join(root, "fixture.mjs");
    writeFileSync(helperPath, `import {writeFileSync} from 'node:fs';
      let root;process.on('message',value=>{
        if(value.type==='prepare'){root=value.userData;process.send({type:'ready'});}
        else {writeFileSync(root+'/receipt',value.type);process.disconnect();}
      });`);
    const options = { nodePath: process.execPath, helperPath, request: { userData: root }, logPath: join(root, "helper.log"), timeoutMs: 5000 };
    const cancelled = launchUpdateHelper(options);
    await cancelled.prepared; await cancelled.cancel();
    assert.equal(readFileSync(join(root, "receipt"), "utf8"), "cancel");
    const apply = launchUpdateHelper(options);
    await apply.prepared; await apply.apply();
    assert.equal(await apply.completion, 0);
    assert.equal(readFileSync(join(root, "receipt"), "utf8"), "apply");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test("native install preparation requests shutdown only after helper readiness and supports cancellation", async () => {
  const source = readFileSync(join(ROOT, "desktop/src/main.mjs"), "utf8");
  const begin = source.indexOf("async function installUpdateWithProgress()");
  let quit = 0, request, cancelReject;
  const helper = { prepared: Promise.resolve(), cancel: async () => {}, apply: async () => {} };
  const ctx = vm.createContext({ AbortController, join, resolve, dirname,
    updateController: { installationRequest: async () => ({ manifest: "fixture" }) },
    runtime: { ready: { runtimePid: 22 } }, workspace: "/workspace", updateHandoff: null,
    updateInstallRequested: false, quitting: false,
    app: { getPath: () => "/userdata", getVersion: () => "1.0.0", quit: () => { quit++; } },
    process: { resourcesPath: "/app/Contents/Resources", execPath: "/app/Coop Desktop.app/Contents/MacOS/Coop Desktop", pid: 11 },
    inspectManagedRuntime: () => ({ node: "/trusted/node" }),
    launchUpdateHelper: args => { request = args; return helper; },
    mainWindow: { isDestroyed: () => false, setProgressBar: () => {} },
    dialog: { showMessageBox: (_window, options) => new Promise(resolve => options.signal.addEventListener("abort", () => resolve({ response: 0 }), { once: true })) } });
  vm.runInContext(source.slice(begin, source.indexOf("async function checkForUpdates()", begin)), ctx);
  await ctx.installUpdateWithProgress();
  assert.equal(quit, 1); assert.equal(ctx.updateInstallRequested, true);
  assert.equal(request.nodePath, "/trusted/node"); assert.equal(request.request.runtimePid, 22);
  ctx.updateInstallRequested = false;
  helper.prepared = new Promise((_resolve, reject) => { cancelReject = reject; });
  helper.cancel = async () => { cancelReject(new Error("cancelled")); };
  ctx.dialog.showMessageBox = async () => ({ response: 0 });
  await ctx.installUpdateWithProgress();
  assert.equal(quit, 1); assert.equal(ctx.updateHandoff, null);
});

await test("Desktop authorizes replacement only after checkpoint and successful runtime shutdown", async () => {
  const source = readFileSync(join(ROOT, "desktop/src/main.mjs"), "utf8");
  for (const stopFails of [false, true]) {
    const calls = []; let handler, finish;
    const done = new Promise(resolve => { finish = resolve; });
    const ctx = vm.createContext({
      app: { on: (_event, fn) => { handler = fn; }, exit: () => finish() },
      updateController: { cancel: () => {}, wait: async () => {} },
      updateInstallRequested: true,
      updateHandoff: { apply: async () => calls.push("apply"), cancel: async () => calls.push("cancel") },
      runtime: { stop: async () => { calls.push("stop"); if (stopFails) throw new Error("fixture stop failed"); } },
      quitting: false, navigationBusy: false, checkpointTimer: null, mainWindow: null,
      clearInterval: () => {}, checkpointNavigation: async () => calls.push("checkpoint"),
    });
    vm.runInContext(source.slice(source.indexOf('app.on("before-quit"')), ctx);
    handler({ preventDefault: () => {} }); await done;
    assert.deepEqual(calls, stopFails ? ["checkpoint", "stop", "cancel"] : ["checkpoint", "stop", "apply"]);
  }
});

await test("update results display fixed copy once and preserve unread or newer outcomes", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-update-outcome-"));
  const path = join(root, "update-result.json");
  let shown = [];
  const args = { userData: root, currentVersion: "1.2.3", show: async options => { shown.push(options); } };
  try {
    assert.equal(await presentUpdateOutcome(args), false);
    for (const content of ["{", "x".repeat(4097), JSON.stringify({ status: "healthy", version: "9.9.9" })]) {
      writeFileSync(path, content);
      assert.equal(await presentUpdateOutcome(args), false);
      assert.ok(existsSync(path));
    }
    assert.equal(shown.length, 0);
    writeFileSync(path, JSON.stringify({ status: "healthy", version: "1.2.3" }));
    assert.equal(await presentUpdateOutcome(args), true);
    assert.equal(shown[0].message, "Update installed");
    assert.equal(existsSync(path), false);
    assert.equal(await presentUpdateOutcome(args), false);
    writeFileSync(path, JSON.stringify({ status: "failed", message: "UNTRUSTED PATH OR SECRET" }));
    assert.equal(await presentUpdateOutcome({ ...args, show: async () => { throw new Error("window closed"); } }), false);
    assert.ok(existsSync(path));
    assert.equal(await presentUpdateOutcome(args), true);
    assert.ok(!JSON.stringify(shown).includes("UNTRUSTED"));
    const target = join(root, "external.json");
    writeFileSync(target, JSON.stringify({ status: "failed" }));
    symlinkSync(target, path);
    assert.equal(await presentUpdateOutcome(args), false);
    assert.ok(existsSync(target));
    rmSync(path);
    writeFileSync(path, JSON.stringify({ status: "failed" }));
    assert.equal(await presentUpdateOutcome({ ...args, show: async () => {
      assert.equal(await presentUpdateOutcome(args), false);
      const next = join(root, "next.json");
      writeFileSync(next, JSON.stringify({ status: "healthy", version: "1.2.3" }));
      renameSync(next, path);
    } }), true);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).status, "healthy");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test("runtime health removes only a successful profile after confirmed shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-runtime-health-cleanup-"));
  try {
    for (const mode of ["healthy", "mismatch", "stop-failure", "start-failure", "fetch-failure"]) {
      let path, stopped = false;
      const options = { start: async ({ env }) => {
        path = env.COOP_DESKTOP_AGENT_DIR;
        assert.ok(existsSync(path));
        if (mode === "start-failure") throw new Error("start failed");
        return { ready: { endpoint: "http://127.0.0.1", oneTimeToken: "fixture" }, stop: async () => {
          assert.ok(existsSync(path), "profile stays present until stop finishes");
          if (mode === "stop-failure") throw new Error("stop failed");
          stopped = true;
        } };
      }, fetchImpl: async url => {
        if (mode === "fetch-failure") throw new Error("fetch failed");
        return { ok: true, headers: new Headers({ "set-cookie": "fixture=1" }), json: async () => ({ contractVersion: 1, versions: { coop: mode === "mismatch" ? "0.0.0" : "1.2.3" } }) };
      } };
      const result = runtimeHealth(root, { versionRoot: root, workspace: root }, { protocolVersion: 1, coopVersion: "1.2.3" }, new AbortController().signal, options);
      if (mode.endsWith("failure")) await assert.rejects(result, /failed/);
      else assert.equal(await result, mode === "healthy");
      assert.equal(existsSync(path), mode !== "healthy");
      if (mode === "healthy") assert.equal(stopped, true);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test("health cleanup preserves replaced directories and external symlink targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-health-owned-"));
  try {
    const external = join(root, "external"); mkdirSync(external); writeFileSync(join(external, "keep"), "keep");
    const profile = await createHealthProfile(root, "runtime");
    symlinkSync(external, join(profile.path, "link"), process.platform === "win32" ? "junction" : "dir");
    assert.equal(await profile.discard(), true); assert.ok(existsSync(join(external, "keep")));
    assert.equal(await profile.discard(), false);
    const replaced = await createHealthProfile(root, "native");
    renameSync(replaced.path, replaced.path + "-original"); mkdirSync(replaced.path);
    assert.equal(await replaced.discard(), false); assert.ok(existsSync(replaced.path));
    const linked = await createHealthProfile(root, "native");
    renameSync(linked.path, linked.path + "-original"); symlinkSync(external, linked.path, process.platform === "win32" ? "junction" : "dir");
    assert.equal(await linked.discard(), false); assert.ok(existsSync(join(external, "keep")));
    const parent = join(root, "parent"); mkdirSync(parent);
    const moved = await createHealthProfile(parent, "runtime");
    renameSync(parent, parent + "-original"); mkdirSync(parent);
    assert.equal(await moved.discard(), false);
    assert.equal(await waitForProbeGroupExit(undefined), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

if (process.platform !== "win32") await test("health cleanup waits for a live probe process group to disappear", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const closed = new Promise(resolve => child.once("close", resolve));
  try {
    assert.equal(await waitForProbeGroupExit(child.pid, { timeoutMs: 50 }), false);
  } finally { child.kill("SIGKILL"); await closed; }
  assert.equal(await waitForProbeGroupExit(child.pid), true);
});

if (process.platform !== "win32") await test("native health requires its challenge, matching version and clean process exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-native-health-"));
  const request = { versionRoot: root, workspace: root };
  const descriptor = { desktopVersion: "1.2.3" };
  try {
    for (const mode of ["healthy", "wrong-version", "wrong-token", "crash", "hang", "cancel"]) {
      let pid, profile;
      const abort = new AbortController();
      const spawnImpl = (_command, args, options) => {
        assert.ok(args[0].startsWith("--user-data-dir="));
        profile = args[0].slice("--user-data-dir=".length);
        assert.equal(options.env.OPENAI_API_KEY, undefined);
        const code = `const mode=${JSON.stringify(mode)};
          if(mode==='hang'||mode==='cancel')setInterval(()=>{},1000);
          else { console.log(JSON.stringify({type:'desktop.update-health',token:mode==='wrong-token'?'wrong':process.env.COOP_DESKTOP_UPDATE_PROBE,version:mode==='wrong-version'?'9.9.9':'1.2.3'})); process.exitCode=mode==='crash'?1:0; }`;
        const child = spawn(process.execPath, ["-e", code], options); pid = child.pid;
        if (mode === "cancel") setTimeout(() => abort.abort(), 30);
        return child;
      };
      const probe = nativeApplicationHealth(root, request, descriptor, abort.signal, { spawnImpl, timeoutMs: mode === "hang" ? 200 : 5000 });
      if (mode === "cancel") await assert.rejects(probe, /abort/i);
      else assert.equal(await probe, mode === "healthy", mode);
      assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
      assert.equal(existsSync(profile), mode !== "healthy", "only successful native health profiles should be removed");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test("native main health acknowledgement follows renderer readiness and runtime shutdown", async () => {
  const source = readFileSync(join(ROOT, "desktop/src/main.mjs"), "utf8");
  const begin = source.indexOf("  if (updateProbeToken) {", source.indexOf("async function createWindow()"));
  const end = source.indexOf("  if (managedResourcePresent", begin);
  const calls = [];
  const ctx = vm.createContext({ updateProbeToken: "fixture", navigationReady: true, quitting: false, activeChatSid: "chat",
    runtimeRpc: async () => calls.push("rpc"), runtime: { stop: async () => calls.push("stop") },
    process: { stdout: { write: value => { assert.equal(JSON.parse(value).token, "fixture"); calls.push("ack"); } } },
    app: { quit: () => calls.push("quit"), getVersion: () => "1.2.3" }, Date, setTimeout });
  await vm.runInContext(`(async () => {${source.slice(begin, end)}})()`, ctx);
  assert.deepEqual(calls, ["rpc", "stop", "ack", "quit"]);
  calls.length = 0; ctx.runtime.stop = async () => { throw new Error("stop failed"); };
  await assert.rejects(vm.runInContext(`(async () => {${source.slice(begin, end)}})()`, ctx), /stop failed/);
  assert.deepEqual(calls, ["rpc"]);
});

await test("atomic replacement recovers interruptions around activation and rollback without removing the app", async () => {
  for (const mode of ["before-swap", "after-swap", "rollback-swap"]) {
    const f = replacementFixture();
    let swaps = 0;
    try {
      await assert.rejects(replaceMacApplication({ ...f.options, checkHealth: async () => false,
        swap: async (left, right) => {
          swaps++;
          assert.ok(existsSync(f.options.appPath));
          if (mode === "before-swap" && swaps === 1) throw new Error("interrupted before swap");
          fixtureSwap(left, right);
          assert.ok(existsSync(f.options.appPath));
          if ((mode === "after-swap" && swaps === 1) || (mode === "rollback-swap" && swaps === 2)) throw new Error("interrupted after swap");
        } }));
      assert.ok(existsSync(f.options.appPath));
      assert.equal((await recoverMacReplacement(f.options)).status, "rolled-back");
      assert.equal(f.read(f.options.appPath), "old");
      assert.equal(JSON.parse(readFileSync(join(f.transaction, "transaction.json"))).schemaVersion, 2);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

if (process.platform === "darwin") await test("Darwin directory exchange uses the native atomic syscall and refuses symlinks", async () => {
  const python = spawnSync("python3", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" });
  assert.equal(python.status, 0);
  const f = replacementFixture();
  try {
    await swapMacDirectories(f.options.appPath, f.options.candidatePath, { pythonPath: python.stdout.trim() });
    assert.equal(f.read(f.options.appPath), "new");
    assert.equal(f.read(f.options.candidatePath), "old");
    const link = join(f.root, "link.app");symlinkSync(f.options.appPath, link);
    await assert.rejects(swapMacDirectories(link, f.options.candidatePath, { pythonPath: python.stdout.trim() }));
    assert.equal(f.read(f.options.appPath), "new");
    await assert.rejects(swapMacDirectories(f.options.appPath, f.options.candidatePath, { pythonPath: python.stdout.trim(), platform: "win32" }), /macOS/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

await test("independent recovery job is registered only after a verified stable app copy", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coop-recovery-job-")));
  const calls = [];
  const request = { appPath: join(root, "Coop Desktop.app"), userData: join(root, "data"), versionRoot: join(root, "versions"), currentVersion: "1.0.0", parentPid: 10, runtimePid: 20 };
  const options = { request, targetVersion: "1.0.1", helperPid: 30, home: join(root, "home & space"), uid: 501,
    bootId: "11111111-1111-1111-1111-111111111111", platform: "darwin",
    inspectRuntime: path => ({ node: join(path, "node"), python: join(path, "python") }),
    execute: async (command, args) => {
      calls.push([command, ...args]);
      if (command === "/usr/bin/ditto") { const dir = join(args[1], "Contents", "Resources", "update-helper");mkdirSync(dir, { recursive: true });writeFileSync(join(dir, "update-recovery-worker.mjs"), "fixture"); }
      if (command === "/usr/bin/plutil") return JSON.stringify({ CFBundleIdentifier: "com.cooptimize.coop.desktop", CFBundleShortVersionString: "1.0.0" });
    } };
  try {
    const job = await createMacRecoveryJob(options);
    assert.equal(calls.at(-1)[1], "bootstrap");
    assert.ok(job.paths.workerApp.startsWith(join(request.userData, "update-recovery")));
    assert.equal((await readRecoveryRecord(job.paths.requestPath)).helperPid, 30);
    const plist = readFileSync(job.paths.plist, "utf8");
    assert.ok(plist.includes("StartInterval"));assert.ok(!plist.includes("privateKey"));
    assert.ok(recoveryJobPlist({ paths: { ...job.paths, workerApp: "/a & b.app" }, node: "/node", uid: 501 }).includes("&amp;"));
    await job.disarm();
    assert.equal(existsSync(job.paths.plist), false);
    assert.equal((await readRecoveryRecord(job.paths.requestPath)).phase, "finished");
    assert.equal(calls.at(-1)[1], "bootout");
    calls.length = 0;
    await assert.rejects(createMacRecoveryJob({ ...options, execute: async (command, args, extra) => {
      if (command === "/bin/launchctl" && args[0] === "bootstrap") throw new Error("bootstrap failed");
      return options.execute(command, args, extra);
    } }), /bootstrap failed/);
    assert.equal(calls.at(-1)[1], "bootout");
    await assert.rejects(createMacRecoveryJob({ ...options, platform: "win32" }), /macOS/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test("recovery waits for live owners, survives a reboot and only reopens a verified app", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coop-recovery-worker-")));
  const id = "22222222-2222-2222-2222-222222222222";
  const requestPath = join(root, "update-recovery", id, "request.json");
  mkdirSync(dirname(requestPath), { recursive: true });
  const record = { schemaVersion: 1, phase: "watching", appPath: join(root, "Coop Desktop.app"), userData: root, versionRoot: join(root, "versions"), currentVersion: "1.0.0", targetVersion: "1.0.1", helperPid: 10, parentPid: 20, runtimePid: 30, bootId: "11111111-1111-1111-1111-111111111111" };
  const calls = [];
  const options = { requestPath, home: root, bootId: record.bootId, alive: () => false, appRunning: () => false, inspectTransaction: async () => ({ status: "none" }),
    stopProbes: async (_record, state) => calls.push(["stop", state.sameBoot]),
    inspectRuntime: () => ({ python: "/verified/python" }),
    recover: async args => { calls.push(["recover", args.ownerBootChanged]);return { status: "rolled-back" }; },
    disarm: async () => calls.push(["disarm"]),
    execute: async (command, args) => { calls.push([command]);if (command === "/usr/bin/plutil") return JSON.stringify({ CFBundleIdentifier: "com.cooptimize.coop.desktop", CFBundleShortVersionString: "1.0.0" }); } };
  try {
    writeFileSync(requestPath, JSON.stringify(record));
    assert.equal(await runRecoveryWorker({ ...options, alive: pid => pid === 10 }), "waiting");assert.deepEqual(calls, []);
    assert.equal(await runRecoveryWorker({ ...options, alive: pid => pid === 20 }), "cancelled");assert.deepEqual(calls, [["disarm"]]);calls.length = 0;
    assert.equal(await runRecoveryWorker(options), "rolled-back");
    assert.ok(calls.find(call => call[0] === "/usr/bin/open"));assert.deepEqual(calls.at(-1), ["disarm"]);
    assert.equal(JSON.parse(readFileSync(join(root, "update-result.json"))).status, "failed");calls.length = 0;
    assert.equal(await runRecoveryWorker({ ...options, bootId: id, alive: () => { throw new Error("Old boot PID must not be consulted"); } }), "rolled-back");
    assert.ok(calls.find(call => call[0] === "recover" && call[1] === true));calls.length = 0;
    assert.equal(await runRecoveryWorker({ ...options, appRunning: () => true }), "busy");assert.ok(!calls.find(call => call[0] === "recover"));calls.length = 0;
    await assert.rejects(runRecoveryWorker({ ...options, execute: async () => { throw new Error("signature failed"); } }), /signature failed/);
    assert.ok(!calls.find(call => call[0] === "/usr/bin/open"));
    calls.length = 0;
    assert.equal(await runRecoveryWorker({ ...options, appRunning: () => true, inspectTransaction: async () => ({ status: "rolled-back" }) }), "rolled-back");
    assert.deepEqual(calls.at(-1), ["disarm"]);
    assert.ok(!calls.find(call => ["stop", "recover", "/usr/bin/open"].includes(call[0])));
    calls.length = 0;
    const runningHealthy = { ...options, appRunning: () => true, inspectTransaction: async () => ({ status: "healthy" }) };
    await assert.rejects(runRecoveryWorker(runningHealthy), /identity changed/);
    assert.ok(!calls.find(call => call[0] === "disarm"));calls.length = 0;
    assert.equal(await runRecoveryWorker({ ...runningHealthy, execute: async (command, args) => {
      if (command === "/usr/bin/plutil") return JSON.stringify({ CFBundleIdentifier: "com.cooptimize.coop.desktop", CFBundleShortVersionString: args.at(-1) === join(record.appPath, "Contents", "Info.plist") ? "1.0.1" : "1.0.0" });
      return options.execute(command, args);
    } }), "healthy");
    assert.deepEqual(calls.at(-1), ["disarm"]);
    assert.ok(!calls.find(call => ["stop", "recover", "/usr/bin/open"].includes(call[0])));
    assert.throws(() => recoveryPaths(requestPath, { ...record, workerApp: "/outside.app" }, root), /invalid/);
    assert.throws(() => recoveryPaths(join(root, "request.json"), record, root), /outside/);
    writeFileSync(requestPath, "x".repeat(8193));await assert.rejects(readRecoveryRecord(requestPath), /bounded/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test("pending app startup is reserved for the updater's direct health probe", async () => {
  const f = replacementFixture();
  try {
    assert.equal((await inspectMacReplacement(f.options)).status, "none");
    const inspect = () => inspectMacReplacement(f.options);
    assert.equal(await canStartMacApplication({ appPath: f.options.appPath, inspect }), true);
    mkdirSync(f.transaction);
    const id = path => { const s = statSync(path, { bigint: true });return { device: String(s.dev), inode: String(s.ino) }; };
    const record = { schemaVersion: 2, phase: "ready", ownerPid: 123, original: id(f.options.appPath), candidate: id(f.options.candidatePath) };
    const journal = join(f.transaction, "transaction.json");writeFileSync(journal, JSON.stringify(record));
    const before = readFileSync(journal, "utf8");
    for (const [probe, parentPid, allowed] of [[false, 123, false], [true, 999, false], [true, 123, true]]) {
      assert.equal(await canStartMacApplication({ appPath: f.options.appPath, inspect, probe, parentPid }), allowed);
    }
    assert.equal(readFileSync(journal, "utf8"), before, "inspection must not rewrite the transaction");
    for (const phase of ["healthy", "rolled-back"]) {
      writeFileSync(journal, JSON.stringify({ ...record, phase }));
      assert.equal(await canStartMacApplication({ appPath: f.options.appPath, inspect }), true);
    }
    writeFileSync(journal, "{}");await assert.rejects(canStartMacApplication({ appPath: f.options.appPath, inspect }), /journal/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

await test("native startup deferral exits before runtime setup and its notice closes automatically", async () => {
  const source = readFileSync(join(ROOT, "desktop/src/main.mjs"), "utf8");
  const begin = source.indexOf("async function createWindow()"), end = source.indexOf('  statePath = join(app.getPath', begin);
  let quit = 0, dialogs = 0, destroyed = 0;
  class NoticeWindow { destroy() { destroyed++; } }
  const ctx = vm.createContext({ managedResourcePresent: true, updateProbeToken: null, resolve, dirname, AbortController,
    process: { platform: "darwin", execPath: "/fixture/Coop Desktop.app/Contents/MacOS/Coop Desktop", ppid: 123 },
    canStartMacApplication: async args => { assert.equal(args.appPath, "/fixture/Coop Desktop.app");return false; },
    setTimeout: callback => { queueMicrotask(callback);return 1; }, clearTimeout: () => {},
    BrowserWindow: NoticeWindow,
    dialog: { showMessageBox: (parent, options) => { assert.ok(parent instanceof NoticeWindow, "macOS cancellation requires a parent window");dialogs++;return new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true })); } },
    app: { quit: () => { quit++; } },
  });
  vm.runInContext(source.slice(begin, end) + 'throw new Error("runtime setup reached");}', ctx);
  await ctx.createWindow();assert.equal(quit, 1);assert.equal(dialogs, 1);assert.equal(destroyed, 1);
  ctx.updateProbeToken = "probe";await ctx.createWindow();assert.equal(quit, 2);assert.equal(dialogs, 1);
  ctx.canStartMacApplication = async () => true;
  await assert.rejects(ctx.createWindow(), /runtime setup reached/);
});

await test("recovery retention removes only older completed idle jobs and preserves external data", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coop-retention-")));
  const parent = join(root, "update-recovery");mkdirSync(parent);
  function job(n, phase = "finished") {
    const id = `11111111-1111-1111-1111-${String(n).padStart(12, "0")}`, dir = join(parent, id);
    mkdirSync(dir);mkdirSync(join(dir, "Recovery.app"));
    const record = { schemaVersion: 1, phase, appPath: join(root, "Coop Desktop.app"), userData: root,
      versionRoot: join(root, "versions"), currentVersion: "1.0.0", targetVersion: "1.0.1", helperPid: 10,
      parentPid: 11, runtimePid: 12, bootId: "11111111-1111-1111-1111-111111111111" };
    writeFileSync(join(dir, "request.json"), JSON.stringify(record));utimesSync(join(dir, "request.json"), n, n);
    return dir;
  }
  try {
    const old = job(1), busy = job(2), changing = job(3), newest = job(4), pending = job(5, "watching"), malformed = job(6);
    writeFileSync(join(malformed, "request.json"), "{}");
    const outside = join(root, "keep.txt");writeFileSync(outside, "retained");symlinkSync(outside, join(old, "outside-link"));
    const linked = join(parent, "22222222-2222-2222-2222-222222222222");symlinkSync(newest, linked, "dir");
    const options = { userData: root, home: root, platform: "darwin", isIdle: async paths => {
      if (paths.root === busy) return false;
      if (paths.root === changing) {
        const file = paths.requestPath, r = JSON.parse(readFileSync(file));r.phase = "watching";writeFileSync(file, JSON.stringify(r));
      }
      return true;
    } };
    const first = pruneCompletedRecoveryJobs(options);
    assert.equal(pruneCompletedRecoveryJobs(options), first, "concurrent startup calls share cleanup");
    assert.deepEqual((await first).removed, [old]);
    for (const dir of [busy, changing, newest, pending, malformed, linked]) assert.ok(existsSync(dir));
    assert.equal(readFileSync(outside, "utf8"), "retained");
    assert.deepEqual(await pruneCompletedRecoveryJobs({ ...options, platform: "win32" }), { removed: [] });
    renameSync(parent, parent + "-saved");symlinkSync(parent + "-saved", parent, "dir");
    assert.deepEqual(await pruneCompletedRecoveryJobs(options), { removed: [] });
    assert.ok(existsSync(busy));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test("recovery cleanup requires explicit absence of both service and worker processes", async () => {
  const paths = { label: "fixture", root: "/fixture/recovery (one)", plist: "/fixture/absent-recovery.plist" };
  const run = (service, processes, error) => (command, args) => {
    if (command === "/bin/launchctl") { assert.deepEqual(args, ["print", "gui/501/fixture"]);return { status: service, error }; }
    assert.equal(args[1], "/fixture/recovery \\(one\\)");return { status: processes, error };
  };
  assert.equal(recoveryJobIsIdle(paths, { uid: 501, run: run(113, 1) }), true);
  assert.equal(recoveryJobIsIdle({ ...paths, plist: fileURLToPath(import.meta.url) }, { uid: 501,
    run: () => { throw new Error("A saved job must be preserved before inspecting processes"); } }), false);
  for (const [service, processes, error] of [[0, 1], [1, 1], [113, 0], [113, 2], [113, 1, new Error("unavailable")]]) {
    assert.equal(recoveryJobIsIdle(paths, { uid: 501, run: run(service, processes, error) }), false);
  }
});

console.log(`desktop update service: ${count} tests passed`);

import { createReparseLink as symlinkSync } from "./fixtures/reparse-link.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPackagedUpdateTrust, updateTrustSummary } from "../desktop/src/update-trust.mjs";
import { verifySignedUpdateDescriptor } from "../desktop/src/update-service.mjs";

let count = 0;
async function test(name, fn) { await fn(); count += 1; console.log(`  ✓ ${name}`); }
function trustStore(overrides = {}) {
  const { publicKey } = generateKeyPairSync("ed25519");
  return {
    schemaVersion: 1,
    keys: [{
      keyId: "coop-release-2026-01",
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

await test("development and unprovisioned packages report updates unavailable without fallback", () => {
  const appPath = mkdtempSync(join(tmpdir(), "coop-update-trust-empty-"));
  try {
    assert.deepEqual(updateTrustSummary(loadPackagedUpdateTrust({ packaged: false, appPath })), { configured: false, reason: "development-build", activeKeyIds: [] });
    assert.deepEqual(updateTrustSummary(loadPackagedUpdateTrust({ packaged: true, appPath })), { configured: false, reason: "not-provisioned", activeKeyIds: [] });
  } finally {
    rmSync(appPath, { recursive: true, force: true });
  }
});

await test("a valid policy loads only from the fixed signed-app resource path", () => {
  const appPath = mkdtempSync(join(tmpdir(), "coop-update-trust-valid-"));
  try {
    const resources = join(appPath, "resources");
    mkdirSync(resources);
    writeFileSync(join(resources, "desktop-update-trust.json"), `${JSON.stringify(trustStore())}\n`, { mode: 0o600 });
    const loaded = loadPackagedUpdateTrust({ packaged: true, appPath });
    assert.equal(loaded.configured, true);
    assert.deepEqual(loaded.activeKeyIds, ["coop-release-2026-01"]);
    assert.equal(loaded.trustStore.keys[0].publicKey.asymmetricKeyType, "ed25519");
  } finally {
    rmSync(appPath, { recursive: true, force: true });
  }
});

await test("loaded trust verifies signed updates and verified artifact metadata is immutable", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const appPath = mkdtempSync(join(tmpdir(), "coop-update-trust-roundtrip-"));
  try {
    mkdirSync(join(appPath, "resources"));
    writeFileSync(join(appPath, "resources", "desktop-update-trust.json"), JSON.stringify(trustStore({ publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) })));
    const loaded = loadPackagedUpdateTrust({ packaged: true, appPath });
    const manifestBytes = Buffer.from(JSON.stringify({
      schemaVersion: 1, keyId: "coop-release-2026-01", releaseId: "desktop-1.0.1", channel: "stable",
      desktopVersion: "1.0.1", coopVersion: "0.23.1", protocolVersion: 1,
      target: { platform: "darwin", arch: "arm64" },
      issuedAt: "2026-09-05T00:00:00.000Z", expiresAt: "2026-09-06T00:00:00.000Z",
      artifact: { url: "https://updates.example.test/app.zip", sha256: "a".repeat(64), size: 123 },
      notesUrl: "https://updates.example.test/notes",
    }));
    const args = { manifestBytes, signature: sign(null, manifestBytes, privateKey).toString("base64"), trustStore: loaded.trustStore, platform: "darwin", arch: "arm64", now: Date.parse("2026-09-05T01:00:00.000Z") };
    const verified = verifySignedUpdateDescriptor(args);
    assert.equal(verified.releaseId, "desktop-1.0.1");
    assert.throws(() => { verified.artifact.url = "https://other.example.test/app.zip"; }, TypeError);
    assert.throws(() => verifySignedUpdateDescriptor({ ...args, trustStore: structuredClone(loaded.trustStore) }), /fields are invalid/);
  } finally {
    rmSync(appPath, { recursive: true, force: true });
  }
});

await test("a present malformed or revoked-only policy fails closed", () => {
  const malformedRoot = mkdtempSync(join(tmpdir(), "coop-update-trust-malformed-"));
  try {
    mkdirSync(join(malformedRoot, "resources"));
    writeFileSync(join(malformedRoot, "resources", "desktop-update-trust.json"), "not-json");
    assert.throws(() => loadPackagedUpdateTrust({ packaged: true, appPath: malformedRoot }), /invalid JSON/);
  } finally {
    rmSync(malformedRoot, { recursive: true, force: true });
  }

  const revokedRoot = mkdtempSync(join(tmpdir(), "coop-update-trust-revoked-"));
  try {
    mkdirSync(join(revokedRoot, "resources"));
    writeFileSync(join(revokedRoot, "resources", "desktop-update-trust.json"), JSON.stringify(trustStore({ status: "revoked" })));
    assert.throws(() => loadPackagedUpdateTrust({ packaged: true, appPath: revokedRoot }), /no active key/);
  } finally {
    rmSync(revokedRoot, { recursive: true, force: true });
  }
});

let symlinkCreated = false;
const linkRoot = mkdtempSync(join(tmpdir(), "coop-update-trust-link-"));
const linkPath = join(linkRoot, "resources", "desktop-update-trust.json");
const outside = join(linkRoot, "outside.json");
const targetBytes = Buffer.from(`${JSON.stringify(trustStore())}\n`);
try {
  mkdirSync(join(linkRoot, "resources"));
  writeFileSync(outside, targetBytes);
  try {
    symlinkSync(outside, linkPath, "file");
    symlinkCreated = true;
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES" && error.code !== "ENOTSUP") throw error;
    console.log("  – a symlinked or external policy fails closed: skipped (host lacks file symlink capability)");
  }
  if (symlinkCreated) {
    await test("a symlinked or external policy fails closed", () => {
      let policy = null;
      assert.throws(() => {
        policy = loadPackagedUpdateTrust({ packaged: true, appPath: linkRoot });
      }, /bounded in-app file/);
      assert.equal(policy, null);
      assert.ok(existsSync(outside));
      assert.deepEqual(readFileSync(outside), targetBytes);
    });
  }
} finally {
  try {
    if (symlinkCreated && existsSync(linkPath)) {
      try {
        const st = lstatSync(linkPath);
        if (st.isSymbolicLink()) unlinkSync(linkPath);
      } catch {
        rmSync(linkPath, { force: true });
      }
    }
  } finally {
    rmSync(linkRoot, { recursive: true, force: true });
  }
}

console.log(`desktop update trust: ${count} tests passed`);

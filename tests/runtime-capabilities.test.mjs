import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  RUNTIME_CAPABILITIES_CONTRACT_VERSION,
  buildRuntimeCapabilities,
  commandAvailable,
  normalizePlatform,
} from "../web/runtime-capabilities.mjs";
import { COMMANDS_SENT, PI_PROTOCOL_VERSION, RPC_ALLOWED } from "../web/protocol.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const manifest = readJson("config/release-manifest.json");
const registry = readJson("config/capabilities.json");
const parity = readJson("config/desktop-parity.json");
const workflowRegistry = readJson("config/workflows.json");

let count = 0;
function test(name, fn) {
  fn();
  count++;
  console.log(`  ✓ ${name}`);
}

const availableIntegrations = Object.fromEntries(
  [...new Set(registry.capabilities.flatMap((capability) => capability.integrations))].map((id) => [
    id,
    { state: "available", installed: true, authenticated: null, reason: null },
  ]),
);

const build = (platform, integrations = availableIntegrations) =>
  buildRuntimeCapabilities({
    manifest,
    registry,
    parity,
    piProtocolVersion: PI_PROTOCOL_VERSION,
    bridgeCommands: RPC_ALLOWED,
    protocolCommands: Object.keys(COMMANDS_SENT),
    workflowRegistry,
    platform,
    integrations,
  });

test("normalizes Node platform names", () => {
  assert.equal(normalizePlatform("win32"), "windows");
  assert.equal(normalizePlatform("darwin"), "macos");
  assert.equal(normalizePlatform("linux"), "linux");
});

test("returns release-manifest and protocol versions", () => {
  const result = build("darwin");
  assert.equal(result.contractVersion, RUNTIME_CAPABILITIES_CONTRACT_VERSION);
  assert.deepEqual(result.contracts, { executionEnvelope: 1, authProviders: 1, doctorReport: 1, projectConfigProposal: 1, environmentDiscovery: 1, projectSetupState: 1, userProfile: 1, runtimeEvent: 1, serviceExtension: 1, workflowDefinition: 1, workflowRun: 1, impactAnalysis: 1, workspaceAccess: 1, managedWorktree: 1, knowledgeRecord: 1, knowledgeIndex: 1, knowledgeService: 1 });
  assert.equal(result.versions.coop, manifest.coop_version);
  assert.equal(result.versions.pi, manifest.pi.version);
  assert.equal(result.versions.piProtocol, PI_PROTOCOL_VERSION);
  assert.deepEqual(result.rpc.commands, [...RPC_ALLOWED].sort());
  assert.deepEqual(result.rpc.protocolCommands, Object.keys(COMMANDS_SENT).sort());
  assert.equal(result.rpc.existingBranchCheckout, true);
  assert.equal(result.rpc.existingBranchCheckoutProvider, "coop-extension");
  assert.deepEqual(result.limits.promptImages, {
    mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
    maxImages: 5,
    maxImageBytes: 4 * 1024 * 1024,
    maxTotalImageBytes: 8 * 1024 * 1024,
  });
  assert.equal(result.extensions.service.find((item) => item.id === "coop-sql-review")?.invocation.name, "sql_review");
  assert.equal(result.extensions.workflow.find((item) => item.id === "coop-workflow.review-changes")?.capabilityId, "coop.workflow.review-changes");
});

test("Windows exposes an available Power BI Desktop bridge from capability data", () => {
  const result = build("win32");
  const capability = result.capabilities.find((item) => item.id === "coop.integration.powerbi-desktop");
  assert.equal(result.platform.os, "windows");
  assert.equal(result.platform.powerBiDesktopBridge, true);
  assert.equal(capability.runtime.state, "available");
  assert.equal(capability.runtime.platformSupported, true);
});

test("macOS marks Power BI Desktop unavailable without client OS inference", () => {
  const result = build("darwin");
  const capability = result.capabilities.find((item) => item.id === "coop.integration.powerbi-desktop");
  assert.equal(result.platform.os, "macos");
  assert.equal(result.platform.powerBiDesktopBridge, false);
  assert.equal(capability.runtime.state, "unavailable");
  assert.deepEqual(capability.runtime.reasonCodes, ["platform-unsupported"]);
});

test("missing integrations disable only affected capabilities with an explicit reason", () => {
  const integrations = structuredClone(availableIntegrations);
  integrations["coop-sql-review"] = {
    state: "unavailable",
    installed: false,
    authenticated: null,
    reason: "coop-sql-review was not found on PATH.",
  };
  const result = build("darwin", integrations);
  const sql = result.capabilities.find((item) => item.id === "coop.review.sql");
  const dax = result.capabilities.find((item) => item.id === "coop.review.dax");
  assert.equal(sql.runtime.available, false);
  assert.deepEqual(sql.runtime.unavailableIntegrations, ["coop-sql-review"]);
  assert.equal(dax.runtime.available, true);
});

test("client implementation states come from the parity manifest", () => {
  const result = build("darwin");
  const treeCheckout = result.capabilities.find((item) => item.id === "coop.session.tree.checkout");
  assert.equal(treeCheckout.clients.terminal, "implemented");
  assert.equal(treeCheckout.clients.web, "implemented");
  assert.equal(treeCheckout.clients.desktop, "planned");
  assert.equal(treeCheckout.clients.fallback, null);
});

test("renderer contains no operating-system capability inference", () => {
  const renderer = readFileSync(join(ROOT, "web", "public", "app.js"), "utf8");
  assert.doesNotMatch(renderer, /process\.platform|navigator\.(?:platform|userAgent)/);
});

test("command detection follows Windows PATHEXT and path syntax", () => {
  const existing = new Set(["C:\\Tools\\widget.CMD"]);
  assert.equal(
    commandAvailable("widget", {
      platform: "win32",
      env: { PATH: "C:\\Tools", PATHEXT: ".EXE;.CMD" },
      exists: (path) => existing.has(path),
    }),
    true,
  );
});

console.log(`runtime capabilities: ${count} tests passed`);

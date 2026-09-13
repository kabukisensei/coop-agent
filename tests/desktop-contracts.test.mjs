import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
  const path = resolve(ROOT, relativePath);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${relativePath} is not valid JSON: ${error.message}`);
  }
}

function exactKeys(value, expected, label) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} fields changed without a schema update`);
}

function nonEmptyString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.length > 0, `${label} must not be empty`);
}

function uniqueStringArray(value, label, { allowEmpty = true, allowed = null } = {}) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  if (!allowEmpty) assert.ok(value.length > 0, `${label} must not be empty`);
  assert.equal(new Set(value).size, value.length, `${label} contains duplicates`);
  for (const [index, item] of value.entries()) {
    nonEmptyString(item, `${label}[${index}]`);
    if (allowed) assert.ok(allowed.has(item), `${label}[${index}] has unsupported value ${item}`);
  }
}

const capabilitySchema = readJson("config/capabilities.schema.json");
const paritySchema = readJson("config/desktop-parity.schema.json");
const registry = readJson("config/capabilities.json");
const parity = readJson("config/desktop-parity.json");

const capabilityFields = [
  "id", "name", "description", "version", "category", "inputs", "outputs",
  "streamedEvents", "sideEffects", "permissions", "integrations", "availability",
  "approval", "presentations", "documentation", "healthChecks", "testIds",
];
const parityFields = [
  "capabilityId", "terminalSource", "piCommand", "terminalState", "webState",
  "desktopState", "requiredPlatforms", "fallback", "testIds", "releaseGate",
];
const capabilityCategories = new Set([
  "agent", "session", "workspace", "review", "lineage", "impact", "workflow", "knowledge",
  "auth", "integration", "runtime",
]);
const sideEffects = new Set([
  "none", "process-control", "session-write", "workspace-read", "workspace-write", "user-config-write",
  "external-read", "external-write", "credential-state",
]);
const platforms = new Set(["windows", "macos", "linux"]);
const requiredPlatforms = new Set(["windows", "macos"]);
const presentationKinds = new Set(["native", "generic", "fallback", "unavailable"]);
const approvalModes = new Set(["never", "when-mutating", "always"]);
const terminalStates = new Set(["implemented", "partial", "not-applicable"]);
const webStates = new Set(["implemented", "partial", "missing", "not-applicable"]);
const desktopStates = new Set(["planned", "implemented", "partial", "blocked", "not-applicable"]);
const fallbackKinds = new Set(["terminal", "platform-limited", "deferred"]);

const expectedCapabilityIds = new Set([
  "coop.agent.chat.streaming",
  "coop.agent.tools.live-output",
  "coop.agent.thinking.display",
  "coop.agent.model.select",
  "coop.agent.model.cycle",
  "coop.agent.thinking-levels.list",
  "coop.agent.thinking-level.set-cycle",
  "coop.agent.queue.steer",
  "coop.agent.queue.follow-up",
  "coop.agent.compaction.auto",
  "coop.agent.retry.auto",
  "coop.agent.abort-retry",
  "coop.session.multiple",
  "coop.session.history",
  "coop.session.name",
  "coop.session.export",
  "coop.session.switch-path",
  "coop.session.fork",
  "coop.session.clone",
  "coop.session.tree.read",
  "coop.session.tree.checkout",
  "coop.runtime.commands.discover",
  "coop.runtime.resources",
  "coop.runtime.extension-dialogs",
  "coop.agent.prompt-images",
  "coop.workspace.files",
  "coop.workspace.user-profile",
  "coop.workspace.project-config",
  "coop.workspace.environment-discovery",
  "coop.workspace.progressive-setup",
  "coop.workspace.git-changes",
  "coop.workspace.worktree-isolation",
  "coop.session.crash-restart",
  "coop.review.sql",
  "coop.review.dax",
  "coop.lineage.explorer",
  "coop.lineage.setup",
  "coop.impact.guided",
  "coop.workflow.review-changes",
  "coop.review.bpa",
  "coop.knowledge.private-memory",
  "coop.knowledge.shared",
  "coop.runtime.doctor",
  "coop.auth.model",
  "coop.auth.microsoft",
  "coop.integration.powerbi-desktop",
  "coop.session.terminal-handoff",
]);

// Keep the checked-in schemas coupled to the dependency-free validator used in CI.
assert.equal(capabilitySchema.$schema, "https://json-schema.org/draft/2020-12/schema");
assert.equal(paritySchema.$schema, "https://json-schema.org/draft/2020-12/schema");
assert.deepEqual(capabilitySchema.$defs.capability.required, capabilityFields);
assert.deepEqual(paritySchema.$defs.entry.required, parityFields);
assert.deepEqual(new Set(capabilitySchema.$defs.capability.properties.category.enum), capabilityCategories);
assert.deepEqual(new Set(capabilitySchema.$defs.capability.properties.sideEffects.items.enum), sideEffects);
assert.deepEqual(new Set(paritySchema.$defs.entry.properties.desktopState.enum), desktopStates);

exactKeys(registry, ["schemaVersion", "capabilities"], "capability registry");
assert.equal(registry.schemaVersion, 1, "unsupported capability registry schemaVersion");
assert.ok(Array.isArray(registry.capabilities) && registry.capabilities.length > 0, "capability registry is empty");

const capabilitiesById = new Map();
const capabilityTestIds = new Map();
for (const capability of registry.capabilities) {
  const label = `capability ${capability.id ?? "<missing>"}`;
  exactKeys(capability, capabilityFields, label);
  assert.match(capability.id, /^coop\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/, `${label} has an invalid id`);
  assert.ok(!capabilitiesById.has(capability.id), `duplicate capability id ${capability.id}`);
  nonEmptyString(capability.name, `${label}.name`);
  nonEmptyString(capability.description, `${label}.description`);
  assert.match(capability.version, /^\d+\.\d+\.\d+$/, `${label}.version must be semver`);
  assert.ok(capabilityCategories.has(capability.category), `${label}.category is invalid`);
  assert.ok(capability.inputs && typeof capability.inputs === "object" && !Array.isArray(capability.inputs), `${label}.inputs must be an object`);
  assert.ok(capability.outputs && typeof capability.outputs === "object" && !Array.isArray(capability.outputs), `${label}.outputs must be an object`);
  uniqueStringArray(capability.streamedEvents, `${label}.streamedEvents`);
  uniqueStringArray(capability.sideEffects, `${label}.sideEffects`, { allowEmpty: false, allowed: sideEffects });
  assert.ok(!(capability.sideEffects.includes("none") && capability.sideEffects.length > 1), `${label}.sideEffects cannot combine none with another effect`);
  uniqueStringArray(capability.permissions, `${label}.permissions`);
  uniqueStringArray(capability.integrations, `${label}.integrations`);

  exactKeys(capability.availability, ["platforms", "limitations"], `${label}.availability`);
  uniqueStringArray(capability.availability.platforms, `${label}.availability.platforms`, { allowEmpty: false, allowed: platforms });
  uniqueStringArray(capability.availability.limitations, `${label}.availability.limitations`);

  exactKeys(capability.approval, ["mode", "operations"], `${label}.approval`);
  assert.ok(approvalModes.has(capability.approval.mode), `${label}.approval.mode is invalid`);
  uniqueStringArray(capability.approval.operations, `${label}.approval.operations`);
  if (capability.approval.mode === "never") {
    assert.equal(capability.approval.operations.length, 0, `${label} has approval operations but mode is never`);
  } else {
    assert.ok(capability.approval.operations.length > 0, `${label} requires approval but defines no operations`);
  }

  exactKeys(capability.presentations, ["cli", "web", "desktop"], `${label}.presentations`);
  for (const surface of ["cli", "web", "desktop"]) {
    const presentation = capability.presentations[surface];
    exactKeys(presentation, ["kind", "entrypoint"], `${label}.presentations.${surface}`);
    assert.ok(presentationKinds.has(presentation.kind), `${label}.presentations.${surface}.kind is invalid`);
    assert.ok(presentation.entrypoint === null || (typeof presentation.entrypoint === "string" && presentation.entrypoint.length > 0), `${label}.presentations.${surface}.entrypoint is invalid`);
    if (presentation.kind === "unavailable") {
      assert.equal(presentation.entrypoint, null, `${label}.presentations.${surface} must not expose an unavailable entrypoint`);
    }
  }

  uniqueStringArray(capability.documentation, `${label}.documentation`, { allowEmpty: false });
  for (const path of capability.documentation) {
    assert.ok(existsSync(resolve(ROOT, path)), `${label} references missing documentation ${path}`);
  }
  uniqueStringArray(capability.healthChecks, `${label}.healthChecks`, { allowEmpty: false });
  uniqueStringArray(capability.testIds, `${label}.testIds`, { allowEmpty: false });

  capabilitiesById.set(capability.id, capability);
  capabilityTestIds.set(capability.id, new Set(capability.testIds));
}

assert.deepEqual(new Set(capabilitiesById.keys()), expectedCapabilityIds, "capability registry does not match the approved Desktop parity baseline");

exactKeys(parity, ["schemaVersion", "capabilityRegistry", "entries"], "Desktop parity manifest");
assert.equal(parity.schemaVersion, 1, "unsupported Desktop parity schemaVersion");
assert.equal(parity.capabilityRegistry, "config/capabilities.json");
assert.ok(Array.isArray(parity.entries) && parity.entries.length > 0, "Desktop parity manifest is empty");

const parityByCapability = new Map();
for (const entry of parity.entries) {
  const label = `parity entry ${entry.capabilityId ?? "<missing>"}`;
  exactKeys(entry, parityFields, label);
  assert.ok(capabilitiesById.has(entry.capabilityId), `${label} references an unknown capability`);
  assert.ok(!parityByCapability.has(entry.capabilityId), `duplicate parity entry ${entry.capabilityId}`);
  nonEmptyString(entry.terminalSource, `${label}.terminalSource`);
  assert.ok(entry.piCommand === null || (typeof entry.piCommand === "string" && entry.piCommand.length > 0), `${label}.piCommand is invalid`);
  assert.ok(terminalStates.has(entry.terminalState), `${label}.terminalState is invalid`);
  assert.ok(webStates.has(entry.webState), `${label}.webState is invalid`);
  assert.ok(desktopStates.has(entry.desktopState), `${label}.desktopState is invalid`);
  uniqueStringArray(entry.requiredPlatforms, `${label}.requiredPlatforms`, { allowEmpty: false, allowed: requiredPlatforms });
  for (const platform of entry.requiredPlatforms) {
    assert.ok(capabilitiesById.get(entry.capabilityId).availability.platforms.includes(platform), `${label} requires ${platform} but its capability is unavailable there`);
  }
  if (entry.fallback !== null) {
    exactKeys(entry.fallback, ["kind", "description", "approved"], `${label}.fallback`);
    assert.ok(fallbackKinds.has(entry.fallback.kind), `${label}.fallback.kind is invalid`);
    nonEmptyString(entry.fallback.description, `${label}.fallback.description`);
    assert.equal(typeof entry.fallback.approved, "boolean", `${label}.fallback.approved must be boolean`);
  }
  uniqueStringArray(entry.testIds, `${label}.testIds`, { allowEmpty: false });
  assert.deepEqual(new Set(entry.testIds), capabilityTestIds.get(entry.capabilityId), `${label}.testIds must match the capability registry`);
  assert.equal(typeof entry.releaseGate, "boolean", `${label}.releaseGate must be boolean`);
  parityByCapability.set(entry.capabilityId, entry);
}

assert.deepEqual(new Set(parityByCapability.keys()), expectedCapabilityIds, "Desktop parity manifest must contain exactly one row per approved capability");
assert.equal(parityByCapability.get("coop.session.export").piCommand, "export_html", "Pi session export must use its real RPC command");
assert.equal(parityByCapability.get("coop.session.tree.checkout").piCommand, null, "existing-branch checkout must not invent an unsupported Pi RPC command");
assert.equal(parityByCapability.get("coop.session.tree.checkout").webState, "implemented", "Coop Web must expose the supported extension-backed branch navigation flow");
assert.equal(parityByCapability.get("coop.session.tree.checkout").fallback, null, "implemented existing-branch checkout must not retain a terminal fallback claim");
assert.deepEqual(parityByCapability.get("coop.integration.powerbi-desktop").requiredPlatforms, ["windows"], "Power BI Desktop bridge must remain Windows-only");

const releaseBlockers = parity.entries.filter((entry) =>
  entry.releaseGate
  && entry.desktopState !== "implemented"
  && entry.desktopState !== "not-applicable"
  && entry.fallback?.approved !== true
);

if (process.env.COOP_DESKTOP_RELEASE_GATE === "1") {
  assert.deepEqual(releaseBlockers, [], `Desktop release blocked by: ${releaseBlockers.map((entry) => entry.capabilityId).join(", ")}`);
} else {
  assert.ok(releaseBlockers.length > 0, "planning manifest should not claim Desktop is release-ready");
  assert.ok(releaseBlockers.some((entry) => entry.capabilityId === "coop.session.tree.checkout"), "Desktop branch checkout remains unfinished until the Desktop shell consumes the shared runtime adapter");
}

console.log(`  ✓ ${registry.capabilities.length} capability descriptors and ${parity.entries.length} parity rows validated`);
console.log(`  ✓ release gate currently reports ${releaseBlockers.length} unfinished required capabilities`);

import assert from "node:assert/strict";
import "../web/public/workspace-health-model.js";

const { build, overall } = globalThis.CoopWorkspaceHealth;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

test("health priority never hides errors behind healthy checks", () => {
  assert.equal(overall([{ state: "healthy" }, { state: "unavailable" }, { state: "error" }]), "error");
  assert.equal(overall([{ state: "configured" }, { state: "unauthenticated" }]), "unauthenticated");
});

test("projects Doctor, auth trust contexts, and progressive setup without secrets", () => {
  const model = build({
    doctor: { checkedAt: "2026-09-04T12:00:00Z", checks: [{ id: "doctor.core.pi", summary: "Pi ready", state: "healthy", recommendedAction: null, repair: null }] },
    auth: { checkedAt: "2026-09-04T12:01:00Z", providers: [
      { id: "microsoft.client", name: "Client Microsoft", trustContext: "client-microsoft", state: "authenticated", account: { label: "consultant@example.com", tenantId: "tenant-1" }, actions: ["reauthenticate"], login: { method: "browser-device-code", available: true }, diagnostics: [] },
      { id: "knowledge.cooptimize", name: "Knowledge", trustContext: "cooptimize-knowledge", state: "unavailable", account: null, actions: [], login: { method: "none", available: false }, diagnostics: [{ message: "Not configured" }] },
    ] },
    setup: { sections: [{ id: "data-doc", label: "Lineage", summary: "Optional and not configured", state: "not-configured", selected: false, setupOperationId: "data-doc.configure" }] },
    profile: { state: "configured", profile: { name: "Aaron", communication: { preset: "balanced" } }, questionnaire: { schema_version: 1 } },
  });
  assert.equal(model.checkedAt, "2026-09-04T12:01:00Z");
  assert.deepEqual(model.sections.map((section) => section.id), ["workspace", "identity", "doctor"]);
  assert.equal(model.sections[1].items[0].trustContext, "client-microsoft");
  assert.equal(model.sections[1].items[1].trustContext, "cooptimize-knowledge");
  assert.equal(JSON.stringify(model).includes("accessToken"), false);
  assert.deepEqual(model.sections[0].items[0].action, { kind: "profile" });
  assert.equal(model.sections[0].items[0].detail, "Aaron · balanced");
  assert.deepEqual(model.sections[0].items[1].action, { kind: "setup", operationId: "data-doc.configure" });
});

test("model login action is available only when the provider contract allows it", () => {
  const model = build({ auth: { providers: [{ id: "model.openai-codex", name: "Model", trustContext: "model", state: "unauthenticated", account: null, actions: ["login"], login: { method: "pi-terminal", available: true }, diagnostics: [] }] } });
  assert.deepEqual(model.sections[1].items[0].action, { kind: "auth", providerId: "model.openai-codex", method: "pi-terminal", available: true, reauthenticate: false });
});

console.log(`workspace health model: ${passed} tests passed`);

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertFabricDiscoveryUrl, discoverFabricItems, discoverFabricWorkspaces, discoverLocalRepositories, resolveDiscoveryCandidate } from "../web/environment-discovery.mjs";

let count = 0;
async function test(name, fn) { await fn(); count++; console.log(`  ✓ ${name}`); }

await test("local discovery is bounded to the selected workspace and direct Git roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "coop-discovery-"));
  mkdirSync(join(root, "repo-a", ".git"), { recursive: true });
  mkdirSync(join(root, "repo-b", ".git"), { recursive: true });
  mkdirSync(join(root, "ordinary"));
  const report = await discoverLocalRepositories({ workspace: root, requestId: "local-1" });
  assert.equal(report.status, "complete");
  assert.deepEqual(report.candidates.map((candidate) => candidate.displayName).sort(), ["repo-a", "repo-b"]);
  assert.ok(report.candidates.every((candidate) => candidate.metadata.localPath.startsWith(report.scope.workspacePath)));
});

await test("workspace discovery follows opaque continuation tokens without trusting continuation URIs", async () => {
  const seen = [];
  const report = await discoverFabricWorkspaces({ requestId: "ws-1", requestJson: async (url) => {
    seen.push(url);
    if (seen.length === 1) return { value: [{ id: "11111111-1111-4111-8111-111111111111", displayName: "QE Dev", type: "Workspace" }], continuationToken: "next token" };
    return { value: [{ id: "22222222-2222-4222-8222-222222222222", displayName: "QE Prod", type: "Workspace" }] };
  } });
  assert.equal(report.status, "complete");
  assert.equal(report.coverage.pages, 2);
  assert.equal(report.candidates.length, 2);
  assert.match(seen[1], /^https:\/\/api\.fabric\.microsoft\.com\/v1\/workspaces\?/);
  assert.ok(seen[1].includes("continuationToken=next+token"));
});

await test("semantic model discovery uses recognizable names scoped to an exact workspace", async () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const report = await discoverFabricItems({ workspaceId, workspaceName: "QE Dev", kind: "semantic-models", requestId: "sm-1", requestJson: async (url) => {
    assert.ok(url.includes("type=SemanticModel"));
    return { value: [
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", displayName: "Finance Model", type: "SemanticModel" },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", displayName: "Sales Model", type: "SemanticModel" },
    ] };
  } });
  const selection = resolveDiscoveryCandidate(report.candidates, { resourceType: "SemanticModel", displayName: "finance model", workspaceId });
  assert.equal(selection.state, "resolved");
  assert.equal(selection.candidate.displayName, "Finance Model");
  assert.equal(selection.candidate.workspaceName, "QE Dev");
});

await test("duplicate human names remain ambiguous until workspace context disambiguates them", async () => {
  const candidates = [
    { candidateId: "1", resourceType: "SemanticModel", resourceId: "1", displayName: "Sales", workspaceId: "dev", workspaceName: "Dev", metadata: {} },
    { candidateId: "2", resourceType: "SemanticModel", resourceId: "2", displayName: "Sales", workspaceId: "prod", workspaceName: "Prod", metadata: {} },
  ];
  assert.equal(resolveDiscoveryCandidate(candidates, { resourceType: "SemanticModel", displayName: "Sales" }).state, "ambiguous");
  assert.equal(resolveDiscoveryCandidate(candidates, { resourceType: "SemanticModel", displayName: "Sales", workspaceId: "dev" }).candidate.resourceId, "1");
});

await test("Fabric reads reject untrusted origins, paths, item types, and workspace IDs before execution", async () => {
  assert.throws(() => assertFabricDiscoveryUrl("https://example.com/v1/workspaces"), /allowlisted/);
  assert.throws(() => assertFabricDiscoveryUrl("https://api.fabric.microsoft.com/v1/admin/workspaces"), /allowlisted/);
  let called = false;
  await assert.rejects(() => discoverFabricItems({ workspaceId: "not-a-guid", requestJson: async () => { called = true; } }), /valid Fabric workspace ID/);
  await assert.rejects(() => discoverFabricItems({ workspaceId: "11111111-1111-4111-8111-111111111111", itemTypes: ["DeleteEverything"], requestJson: async () => { called = true; } }), /Unsupported Fabric item type/);
  assert.equal(called, false);
});

await test("provider failures are structured without leaking command stderr", async () => {
  const report = await discoverFabricWorkspaces({ requestId: "fail-1", requestJson: async () => { throw new Error("secret-token-value"); } });
  assert.equal(report.status, "failed");
  assert.equal(JSON.stringify(report).includes("secret-token-value"), false);
});

await test("a later-page failure preserves candidates and reports partial evidence", async () => {
  let page = 0;
  const report = await discoverFabricWorkspaces({ requestId: "partial-1", requestJson: async () => {
    page += 1;
    if (page === 1) return { value: [{ id: "11111111-1111-4111-8111-111111111111", displayName: "QE Dev", type: "Workspace" }], continuationToken: "next" };
    throw new Error("later page failed");
  } });
  assert.equal(report.status, "partial");
  assert.equal(report.coverage.complete, false);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.diagnostics[0].code, "discovery-incomplete");
});

await test("checked-in schema pins read-only status and ambiguity-safe candidate fields", async () => {
  const schema = JSON.parse(readFileSync(new URL("../config/environment-discovery.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.equal(schema.properties.readOnly.const, true);
  assert.ok(schema.properties.status.enum.includes("partial"));
  assert.ok(schema.properties.candidates.items.required.includes("workspaceName"));
});

console.log(`environment discovery: ${count} tests passed`);

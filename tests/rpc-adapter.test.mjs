import assert from "node:assert/strict";
import { buildPromptCommand, buildRpcCommand, sanitizeImages } from "../web/rpc-adapter.mjs";
import { CoopRuntimeClient, RuntimeClientError } from "../web/runtime-client.mjs";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

await test("prompt images are copied field-by-field and busy prompts steer", () => {
  const image = { type: "image", mimeType: "image/png", data: Buffer.from("png").toString("base64"), ignored: "no" };
  assert.deepEqual(buildPromptCommand({ message: "look", images: [image], ignored: "no" }, { busy: true }), {
    ok: true,
    command: {
      type: "prompt",
      message: "look",
      images: [{ type: "image", mimeType: "image/png", data: image.data }],
      streamingBehavior: "steer",
    },
  });
});

await test("image validation rejects data URLs, unknown MIME types, count, and decoded size", () => {
  assert.equal(sanitizeImages([{ type: "image", mimeType: "image/png", data: "data:image/png;base64,AAAA" }]).ok, false);
  assert.equal(sanitizeImages([{ type: "image", mimeType: "image/svg+xml", data: "AAAA" }]).ok, false);
  assert.equal(sanitizeImages(Array.from({ length: 6 }, () => ({ type: "image", mimeType: "image/png", data: "AAAA" }))).ok, false);
  assert.equal(sanitizeImages([{ type: "image", mimeType: "image/png", data: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") }]).ok, false);
});

await test("model, thinking, queue, automation, and session commands use exact Pi fields", () => {
  assert.deepEqual(buildRpcCommand({ type: "set_model", provider: " openai ", modelId: " gpt-test ", extra: true }).command,
    { type: "set_model", provider: "openai", modelId: "gpt-test" });
  assert.deepEqual(buildRpcCommand({ type: "set_thinking_level", level: "xhigh" }).command,
    { type: "set_thinking_level", level: "xhigh" });
  assert.deepEqual(buildRpcCommand({ type: "set_follow_up_mode", mode: "one-at-a-time" }).command,
    { type: "set_follow_up_mode", mode: "one-at-a-time" });
  assert.deepEqual(buildRpcCommand({ type: "set_auto_retry", enabled: false }).command,
    { type: "set_auto_retry", enabled: false });
  assert.deepEqual(buildRpcCommand({ type: "get_entries", since: "u1" }).command,
    { type: "get_entries", since: "u1" });
});

await test("invalid enums and non-boolean settings fail before reaching Pi", () => {
  assert.equal(buildRpcCommand({ type: "set_thinking_level", level: "ultra" }).ok, false);
  assert.equal(buildRpcCommand({ type: "set_steering_mode", mode: "sometimes" }).ok, false);
  assert.equal(buildRpcCommand({ type: "set_auto_compaction", enabled: "yes" }).ok, false);
});

await test("session switching is resolver-jailed and export paths require a native save flow", () => {
  assert.equal(buildRpcCommand({ type: "switch_session", sessionPath: "/outside/x.jsonl" }).ok, false);
  assert.deepEqual(
    buildRpcCommand({ type: "switch_session", sessionPath: "/safe/x.jsonl" }, { resolveSessionPath: (p) => p.startsWith("/safe/") ? p : null }).command,
    { type: "switch_session", sessionPath: "/safe/x.jsonl" },
  );
  assert.equal(buildRpcCommand({ type: "export_html", outputPath: "/tmp/out.html" }).ok, false);
  assert.deepEqual(buildRpcCommand({ type: "export_html" }).command, { type: "export_html" });
});

await test("runtime client sends named RPC methods and preserves the raw response", async () => {
  const calls = [];
  const client = new CoopRuntimeClient({
    baseUrl: "http://127.0.0.1:7420/",
    sid: "c7",
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });
      return { ok: true, status: 200, json: async () => ({ id: "r1", type: "response", command: calls.at(-1).body?.type, success: true, data: { leafId: "a1" } }) };
    },
  });
  const result = await client.getTree();
  assert.equal(calls[0].url, "http://127.0.0.1:7420/rpc");
  assert.deepEqual(calls[0].body, { type: "get_tree", sid: "c7" });
  assert.equal(result.command, "get_tree");
  assert.equal(result.data.leafId, "a1");
  assert.equal(result.raw.id, "r1");
  await client.followUp("next", { images: [] });
  assert.deepEqual(calls[1].body, { type: "follow_up", message: "next", images: [], sid: "c7" });
  const navigation = await client.navigateTree("b1", { summarize: true });
  assert.equal(calls[2].url, "http://127.0.0.1:7420/tree-navigate");
  assert.deepEqual(calls[2].body, { entryId: "b1", summarize: true, sid: "c7" });
  assert.equal(navigation.command, "navigate_tree");
  assert.equal(navigation.raw.success, true);
  await client.terminalHandoff("clone");
  assert.equal(calls[3].url, "http://127.0.0.1:7420/terminal-handoff");
  assert.deepEqual(calls[3].body, { mode: "clone", sid: "c7" });
  await client.getRuntimeEvents(12);
  assert.equal(calls[4].url, "http://127.0.0.1:7420/runtime-events-poll?since=12&sid=c7");
  await client.getRuntimeArtifact("c7:artifact:t1");
  assert.equal(calls[5].url, "http://127.0.0.1:7420/runtime-artifact?id=c7%3Aartifact%3At1&sid=c7");
  await client.getDoctor();
  assert.equal(calls[6].url, "http://127.0.0.1:7420/doctor?sid=c7");
  await client.getAuthProviders();
  assert.equal(calls[7].url, "http://127.0.0.1:7420/auth/providers?sid=c7");
  await client.getUserProfile();
  assert.equal(calls[8].url, "http://127.0.0.1:7420/profile?sid=c7");
  await client.applyUserProfile({ name: "Aaron", communication: { preset: "balanced" } });
  assert.deepEqual(calls[9].body, { profile: { name: "Aaron", communication: { preset: "balanced" } }, approved: true, sid: "c7" });
  await client.discoverEnvironment("semantic-models", { workspaceId: "11111111-1111-4111-8111-111111111111" });
  assert.deepEqual(calls[10].body, { kind: "semantic-models", workspaceId: "11111111-1111-4111-8111-111111111111", sid: "c7" });
  await client.getProjectSetupState("coop.impact.guided");
  assert.equal(calls[11].url, "http://127.0.0.1:7420/setup/state?capabilityId=coop.impact.guided&sid=c7");
  await client.getProjectConfig();
  assert.equal(calls[12].url, "http://127.0.0.1:7420/config/current?sid=c7");
  await client.proposeProjectConfig("profile: {}\n");
  assert.deepEqual(calls[13].body, { candidate: "profile: {}\n", sid: "c7" });
  await client.applyProjectConfig("proposal-1");
  assert.deepEqual(calls[14].body, { proposalId: "proposal-1", approved: true, sid: "c7" });
  await client.listWorkflows();
  assert.equal(calls[15].url, "http://127.0.0.1:7420/workflows?sid=c7");
  await client.startWorkflow("coop-workflow.review-changes", { changedFilesOnly: true });
  assert.deepEqual(calls[16].body, { workflowId: "coop-workflow.review-changes", input: { changedFilesOnly: true }, sid: "c7" });
  await client.getWorkflowRun("workflow-1");
  assert.equal(calls[17].url, "http://127.0.0.1:7420/workflow/run?runId=workflow-1&sid=c7");
  await client.transitionWorkflow("workflow-1", "resolve-approval", { approved: true });
  assert.deepEqual(calls[18].body, { runId: "workflow-1", operation: "resolve-approval", approved: true, sid: "c7" });
  await client.getKnowledgeCatalog();
  assert.equal(calls[19].url, "http://127.0.0.1:7420/knowledge/catalog?sid=c7");
  await client.searchKnowledge("join keys", "team");
  assert.equal(calls[20].url, "http://127.0.0.1:7420/knowledge/search?q=join+keys&scope=team&sid=c7");
  await client.previewKnowledgeCreate("team.general", { id: "knowledge.test.001" });
  assert.deepEqual(calls[21].body, { action: "create", sourceId: "team.general", record: { id: "knowledge.test.001" }, sid: "c7" });
  await client.previewKnowledgeTransition("team.general", "knowledge.test.001", { id: "knowledge.test.001", status: "approved" });
  assert.deepEqual(calls[22].body, { action: "transition", sourceId: "team.general", recordId: "knowledge.test.001", record: { id: "knowledge.test.001", status: "approved" }, sid: "c7" });
  await client.applyKnowledgeProposal("knowledge-proposal-1");
  assert.deepEqual(calls[23].body, { proposalId: "knowledge-proposal-1", approved: true, sid: "c7" });
});

await test("runtime client turns HTTP failures into typed errors", async () => {
  const client = new CoopRuntimeClient({ fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid queue mode" }) }) });
  await assert.rejects(() => client.setSteeringMode("bad"), (error) =>
    error instanceof RuntimeClientError && error.status === 400 && error.message === "invalid queue mode");
});

console.log(`RPC adapter/client: ${passed} tests passed`);

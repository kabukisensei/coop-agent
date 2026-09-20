// Offline integration with an explicitly supplied, already installed Pi runtime.
// No provider session, network tool, credential lookup or package install is used.
// Usage: node tests/guardrails-pi-runner.test.mjs /absolute/path/to/pi-coding-agent
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const piRoot = process.argv[2];
assert.ok(piRoot && isAbsolute(piRoot), "supply the installed Pi package root explicitly");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "coop-guardrails-runner-"));
const agentDir = join(scratch, "agent");
mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.COOP_AGENT_DIR = agentDir;
process.env.COOP_ROOT = root;
process.env.JITI_FS_CACHE = join(scratch, "jiti");
const require = createRequire(join(piRoot, "package.json"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { fsCache: join(scratch, "jiti") });
const { default: guardrails } = await jiti.import(join(root, "extensions/coop-guardrails/index.ts"));
const { ExtensionRunner } = await import(pathToFileURL(join(piRoot, "dist/core/extensions/runner.js")).href);
const { AgentSession } = await import(pathToFileURL(join(piRoot, "dist/core/agent-session.js")).href);
const version = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version;

const tenant = "11111111-1111-4111-8111-111111111111";
const workspace = "22222222-2222-4222-8222-222222222222";
const item = "33333333-3333-4333-8333-333333333333";
const other = "44444444-4444-4444-8444-444444444444";
function token(principal = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") {
  return [JSON.stringify({ alg: "none" }), JSON.stringify({ tid: tenant, oid: principal }), "synthetic-only"]
    .map((s) => Buffer.from(s).toString("base64url")).join(".");
}
function config(overrides = {}) {
  const target = { scope: "item", client: "Contoso", tenant_id: tenant, environment: "production",
    workspace_id: workspace, item_id: item, item_name: "TestWarehouse", ...overrides };
  const url = `https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/${target.workspace_id}/items/${target.item_id}/sqlEndpoint`;
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({
    _coop: { managed_servers: ["fabric-sqlendpoint"] },
    mcpServers: { "fabric-sqlendpoint": { url, auth: false, lifecycle: "lazy", requestTimeoutMs: 60000,
      requestHeadersCommand: { command: "node", args: [join(root, "lib/fabric_request_headers.mjs"), url], timeoutMs: 10000 },
      _coop_target: target } },
  }));
}
config(); process.env.COOP_FABRIC_MCP_TOKEN = token();
const read = (limit = 25, extra = {}) => ({ toolName: "mcp__fabric_sqlendpoint",
  input: { tool: "fabric-sqlendpoint_execute_query", args: { workspaceId: workspace, itemId: item,
    query: `SELECT TOP (${limit}) customer_id FROM dbo.Customer`, ...extra } } });
let prompts = 0, answer = false, downstream = 0, executions = 0;
const messages = [];
const ui = { confirm: (_title, message) => { prompts++; messages.push(message); return typeof answer === "function" ? answer() : Promise.resolve(answer); },
  notify: () => {}, setStatus: () => {} };
const handlers = new Map(), commands = new Map();
guardrails({
  on: (name, handler) => handlers.set(name, [...(handlers.get(name) || []), handler]),
  registerCommand: (name, command) => commands.set(name, command),
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
});
const runner = new ExtensionRunner([
  { path: "coop-guardrails", handlers },
  { path: "downstream-sentinel", handlers: new Map([["tool_call", [async () => { downstream++; }]]]) },
], {}, scratch, {}, {});
runner.setUIContext(ui);
// Install Pi's actual AgentSession hook on an inert host; no session constructor
// or live tools are involved. Do not replace runner.emitToolCall/createContext.
const host = { agent: {}, _extensionRunner: runner };
AgentSession.prototype._installAgentToolHooks.call(host);
const dispatch = async (event, expectedBlock) => {
  const before = downstream;
  const result = await host.agent.beforeToolCall({ toolCall: { id: "offline", name: event.toolName }, args: event.input });
  assert.equal(!!result?.block, expectedBlock);
  assert.equal(downstream - before, expectedBlock ? 0 : 1, "real runner stops downstream hooks on block");
  if (!result?.block) executions++; // inert executor only
  return result;
};
const fresh = async () => { await runner.emit({ type: "session_start", reason: "new" }); prompts = 0; };
await fresh(); answer = true;
await dispatch(read(), false);
assert.equal(prompts, 1, "initial approval establishes the bounded grant");
for (const value of ["Contoso", tenant, workspace, item, "production", "25", "60000 ms"]) assert.ok(messages.at(-1).includes(value));
answer = false;
await dispatch(read(10), false);
await dispatch({ ...read(), input: { ...read().input, args: JSON.stringify(read().input.args) } }, false);
await dispatch({ toolName: "mcp", input: { server: "fabric-sqlendpoint", tool: "execute_query", args: JSON.stringify(read().input.args) } }, false);
await dispatch({ toolName: "mcp", input: { tool: "fabric-sqlendpoint_execute_query", args: read().input.args } }, false);
await dispatch({ toolName: "fabric_sql_query", input: { query: read(10).input.args.query, maximum_rows: 10 } }, false);
assert.equal(prompts, 1, "matching calls across dispatch surfaces do not prompt again");
await dispatch(read(50), true);
await dispatch(read(), false);
assert.equal(prompts, 2, "rejected expansion preserves the original grant");
answer = true; await dispatch(read(50), false);
answer = false; await dispatch(read(40), false);
assert.equal(prompts, 3, "approved expansion is reusable");
for (const extra of [{ itemId: other }, { workspaceId: other }, { timeoutMs: 120000 }, { database: "Other" }]) await dispatch(read(10, extra), true);
for (const change of [{ item_id: other }, { client: "OtherClient" }, { environment: "test" }]) {
  config(change); await dispatch(read(), true);
}
config(); process.env.COOP_FABRIC_MCP_TOKEN = token("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
await dispatch(read(), true); process.env.COOP_FABRIC_MCP_TOKEN = token();
const mutations = [read(1, { query: "DELETE FROM dbo.Customer" }),
  { toolName: "mcp__fabric", input: { tool: "fabric_create_item", args: {} } },
  { toolName: "mcp__azure_devops", input: { tool: "create_work_item", args: {} } },
  { toolName: "mcp__custom", input: { tool: "write", args: {} } }];
const beforeMutations = executions;
for (const event of mutations) await dispatch(event, true);
assert.equal(executions, beforeMutations, "no mutation reaches even the inert executor");
await commands.get("coop-live-read").handler("revoke", runner.createContext());
await dispatch(read(), true);
await dispatch(read(), true); // rejected initial requests never make a grant
answer = true; await dispatch(read(), false);
await fresh(); answer = false; await dispatch(read(), true);
assert.equal(prompts, 1, "new session requires initial approval");
answer = true; await dispatch(read(), false);
await runner.emit({ type: "session_shutdown", reason: "switch" });
answer = false; await dispatch(read(), true);
for (const fail of [() => { throw new Error("SYNTHETIC_APPROVAL_SECRET"); }, () => Promise.reject(new Error("SYNTHETIC_APPROVAL_SECRET"))]) {
  await fresh(); answer = fail;
  for (const event of [read(), ...mutations, { toolName: "bash", input: { command: "rm -rf SYNTHETIC_COMMAND_SECRET" } }]) {
    const result = await dispatch(event, true);
    assert.ok(!JSON.stringify(result).includes("SYNTHETIC_"));
  }
  answer = false; await dispatch(read(), true);
}
runner.setUIContext(undefined);
for (const event of [read(), ...mutations]) await dispatch(event, true);
runner.setUIContext(ui); answer = true;
await dispatch({ toolName: "bash", input: { command: "rm -rf SYNTHETIC_COMMAND_SECRET" } }, false);
await dispatch({ toolName: "read", input: { path: "README.md" } }, false);
await dispatch({ toolName: "mcp__fabric", input: { tool: "fabric_list_workspaces", args: {} } }, false);
const audit = readFileSync(join(agentDir, "guardrails-audit.jsonl"), "utf8");
for (const secret of ["SYNTHETIC_COMMAND_SECRET", "SYNTHETIC_APPROVAL_SECRET", "SELECT TOP", "dbo.Customer"]) assert.ok(!audit.includes(secret));
console.log(`Pi ${version}: real AgentSession beforeToolCall + ExtensionRunner integration passed (offline, synthetic fixtures).`);

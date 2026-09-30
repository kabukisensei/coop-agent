// Offline integration with an explicitly supplied, already installed Pi runtime.
// No provider session, network tool, credential lookup or package install is used.
// Usage: node tests/guardrails-pi-runner.test.mjs /absolute/path/to/pi-coding-agent
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
// Pi 0.99 moved the hook body into _beforeToolCall, which codemode's nested calls
// share (with their parent call's id).
const nestedHook = typeof AgentSession.prototype._beforeToolCall === "function";
if (nestedHook) host._beforeToolCall = AgentSession.prototype._beforeToolCall;
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
// Real Pi hooks must share the same bounded grant for bracketed SQL on both paths.
const bracketed = "SELECT TOP (12) [Calendar Month Date], SUM([Accounting Amount]) AS [Revenue] FROM [finance].[Ledger Transactions] GROUP BY [Calendar Month Date]";
await fresh(); answer = true;
await dispatch(read(12, { query: bracketed }), false);
assert.equal(prompts, 1);
assert.ok(messages.at(-1).includes("Approve this exact bounded scope for this session?"));
answer = false;
await dispatch(read(12, { query: bracketed }), false);
await dispatch({ toolName: "mcp", input: { server: "fabric-sqlendpoint", tool: "execute_query", args: read(12, { query: bracketed }).input.args } }, false);
assert.equal(prompts, 1, "bracketed dynamic and central reads reuse initial approval");
await dispatch(read(13, { query: bracketed.replace("(12)", "(13)") }), true);
await dispatch(read(12, { query: bracketed }), false);
assert.equal(prompts, 2, "rejected bracketed expansion retains the prior grant");
for (const query of [
  "SELECT TOP (5) * FROM [OtherDatabase].[dbo].[Secret]",
  "SELECT TOP (5) * FROM [OtherDatabase]..[Secret]",
  "SELECT TOP (5) [Name] INTO [dbo].[NewTable] FROM [dbo].[Customer]",
  "SELECT TOP (5) [Name]; DELETE FROM [dbo].[Customer]",
  "SELECT TOP (5) [unterminated",
]) await dispatch(read(5, { query }), true);
await commands.get("coop-live-read").handler("revoke", runner.createContext());
await dispatch(read(12, { query: bracketed }), true);
answer = true; await dispatch(read(12, { query: bracketed }), false);
await fresh(); answer = false; await dispatch(read(12, { query: bracketed }), true);
// Restore the original grant fixture for the remaining lifecycle cases.
await fresh(); answer = true; await dispatch(read(), false); answer = false;
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
  { toolName: "mcp__custom", input: { tool: "write", args: {} } },
  // Pi 0.99's built-in MCP shape: a `tool` field is an argument, never the operation.
  { toolName: "mcp__fabric__delete_item", input: { tool: "list_items" } },
  { toolName: "mcp__powerbi-modeling-mcp__measure_operations", input: { request: { operation: "Create" } } },
  // Fabric MCP's namespace routers carry the operation in `command` (#171), in the
  // adapter's shapes and in Pi 0.99's built-in shape.
  { toolName: "mcp", input: { server: "fabric", tool: "onelake", args: { intent: "x", command: "onelake_delete_file", parameters: {} } } },
  { toolName: "mcp__fabric", input: { tool: "core", args: { intent: "x", command: "core_create-item", parameters: {} } } },
  { toolName: "mcp__fabric__onelake", input: { intent: "x", command: "onelake_delete_file", parameters: {} } }];
const beforeMutations = executions;
for (const event of mutations) await dispatch(event, true);
assert.equal(executions, beforeMutations, "no mutation reaches even the inert executor");
await dispatch({ toolName: "mcp__fabric__get_schema", input: { environment: "production" } }, true);
await dispatch({ toolName: "mcp__fabric__executeSQL", input: { sql: "DELETE FROM dbo.Customer" } }, true);
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
if (nestedHook) {
  // Calls a codemode script makes at once: one approval dialog at a time, in order.
  await fresh();
  let open = 0, maxOpen = 0;
  answer = () => { open++; maxOpen = Math.max(maxOpen, open); return new Promise((done) => setTimeout(() => { open--; done(true); }, 20)); };
  const nested = [
    { toolName: "mcp__fabric__delete_item", input: {} },
    { toolName: "mcp__powerbi-modeling-mcp__measure_operations", input: { request: { operation: "Delete" } } },
    { toolName: "mcp__fabric__onelake_delete-file", input: {} },
  ];
  const results = await Promise.all(nested.map((event, i) =>
    host._beforeToolCall({ toolCall: { id: `script/${i}`, name: event.toolName }, args: event.input }, "script")));
  assert.deepEqual(results.map((r) => !!r?.block), [false, false, false]);
  assert.equal(prompts, 3, "each delete asks");
  assert.equal(maxOpen, 1, "never two dialogs at once");
  answer = true;
}
const audit = readFileSync(join(agentDir, "guardrails-audit.jsonl"), "utf8");
for (const secret of ["SYNTHETIC_COMMAND_SECRET", "SYNTHETIC_APPROVAL_SECRET", "SELECT TOP", "dbo.Customer"]) assert.ok(!audit.includes(secret));

// Pi 0.99+: its built-in MCP registers each server tool as `mcp__<server>__<tool>`.
// Start a real session with Pi's built-in extensions, a local stdio MCP server and
// coop's guardrails, and check what Pi's registry reports and what coop asks.
const builtinIndex = join(piRoot, "dist/extensions/index.js");
let builtinMcp = false;
if (existsSync(builtinIndex)) {
  const { builtInExtensions } = await import(pathToFileURL(builtinIndex).href);
  builtinMcp = Array.isArray(builtInExtensions) && builtInExtensions.some((ext) => ext?.name === "mcp");
  if (builtinMcp) {
    const pi = await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
    // Pi's MCP reads <PI_CODING_AGENT_DIR>/mcp.json, which is this test's agent dir.
    const mcpAgentDir = agentDir, cwd = mkdtempSync(join(scratch, "builtin-mcp-"));
    const server = { command: process.execPath, args: [join(root, "tests/fixtures/fake-mcp-server.mjs")] };
    writeFileSync(join(mcpAgentDir, "mcp.json"), JSON.stringify({ mcpServers: { "powerbi-modeling-mcp": server, other_server: server } }));
    const settingsManager = pi.SettingsManager.create(cwd, mcpAgentDir);
    const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir: mcpAgentDir, settingsManager,
      additionalExtensionPaths: [join(root, "extensions/coop-guardrails/index.ts")], extensionFactories: builtInExtensions,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await resourceLoader.reload();
    const { session } = await pi.createAgentSession({ cwd, agentDir: mcpAgentDir, settingsManager, resourceLoader, sessionManager: pi.SessionManager.inMemory() });
    const asked = [];
    const uiContext = new Proxy({
      confirm: async (_title, message) => { asked.push(String(message)); return false; },
      select: async (title, options) => { asked.push(String(title)); return options[options.length - 1]; },
    }, { get: (target, key) => (key in target ? target[key] : () => undefined) });
    await session.bindExtensions({ uiContext });
    let tools = [];
    for (let i = 0; i < 100 && tools.length < 6; i++) {
      await new Promise((done) => setTimeout(done, 100));
      tools = session.getAllTools().filter((info) => info.name.startsWith("mcp__"));
    }
    const lookup = tools.find((info) => info.name === "mcp__powerbi-modeling-mcp__lookup");
    assert.equal(tools.length, 6, "both servers' tools are registered");
    assert.ok(tools.every((info) => info.sourceInfo?.path === "builtin:mcp"), "Pi reports its built-in MCP as the source");
    assert.equal(lookup?.namespace?.name, "mcp__powerbi-modeling-mcp");
    assert.equal(lookup?.annotations?.destructiveHint, true);
    const blocks = async (name, args) => (await session._beforeToolCall({ toolCall: { id: name, name }, args }))?.block === true;
    assert.equal(await blocks("mcp__powerbi-modeling-mcp__measure_operations", { request: { operation: "List" } }), false, "a model read passes");
    assert.equal(asked.length, 0);
    assert.equal(await blocks("mcp__powerbi-modeling-mcp__measure_operations", { request: { operation: "Create" } }), true, "a model edit asks");
    assert.equal(await blocks("mcp__other_server__delete_item", { tool: "list_items", id: "1" }), true, "a `tool` argument cannot relabel a delete");
    assert.match(asked.at(-1), /other_server\/delete_item/);
    assert.equal(await blocks("mcp__powerbi-modeling-mcp__lookup", {}), true, "a tool its server marks destructive asks");
    assert.equal(asked.length, 3);
    await session._extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
}
console.log(`Pi ${version}: real AgentSession beforeToolCall + ExtensionRunner integration passed${builtinMcp ? ", with its built-in MCP" : ""} (offline, synthetic fixtures).`);

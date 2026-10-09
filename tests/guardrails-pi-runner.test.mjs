// Offline integration with an explicitly supplied, already installed Pi runtime.
// No provider session, network tool, credential lookup or package install is used.
// Usage: node tests/guardrails-pi-runner.test.mjs /absolute/path/to/pi-coding-agent
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
const { default: guardrails, PROD_UNLOCK_FILE } = await jiti.import(join(root, "extensions/coop-guardrails/index.ts"));
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
  writeFileSync(join(agentDir, "mcp-adapter.json"), JSON.stringify({
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
// Reading needs no approval on any environment, production included (Aaron,
// 2026-10-07): the managed target here is production and no read prompts.
await fresh(); answer = false;
await dispatch(read(), false);
await dispatch(read(10), false);
await dispatch({ ...read(), input: { ...read().input, args: JSON.stringify(read().input.args) } }, false);
await dispatch({ toolName: "mcp", input: { server: "fabric-sqlendpoint", tool: "execute_query", args: JSON.stringify(read().input.args) } }, false);
await dispatch({ toolName: "mcp", input: { tool: "fabric-sqlendpoint_execute_query", args: read().input.args } }, false);
await dispatch({ toolName: "fabric_sql_query", input: { query: read(10).input.args.query, maximum_rows: 10 } }, false);
await dispatch(read(500, { query: "SELECT customer_id FROM dbo.Customer" }), false);
const bracketed = "SELECT TOP (12) [Calendar Month Date], SUM([Accounting Amount]) AS [Revenue] FROM [finance].[Ledger Transactions] GROUP BY [Calendar Month Date]";
await dispatch(read(12, { query: bracketed }), false);
await dispatch({ toolName: "mcp", input: { server: "fabric-sqlendpoint", tool: "execute_query", args: read(12, { query: bracketed }).input.args } }, false);
assert.equal(prompts, 0, "reads across dispatch surfaces never prompt");
// Cross-database, mutating and malformed SQL still ask (declined here).
for (const query of [
  "SELECT TOP (5) * FROM [OtherDatabase].[dbo].[Secret]",
  "SELECT TOP (5) * FROM [OtherDatabase]..[Secret]",
  "SELECT TOP (5) [Name] INTO [dbo].[NewTable] FROM [dbo].[Customer]",
  "SELECT TOP (5) [Name]; DELETE FROM [dbo].[Customer]",
  "SELECT TOP (5) [unterminated",
]) await dispatch(read(5, { query }), true);
// A target or identity coop cannot resolve asks.
for (const extra of [{ itemId: other }, { workspaceId: other }, { timeoutMs: 120000 }, { database: "Other" }]) await dispatch(read(10, extra), true);
config({ client: "TODO client" }); await dispatch(read(), true);
config({ item_id: other }); await dispatch(read(), true); config(); // the call names the old item
const foreignTenant = [JSON.stringify({ alg: "none" }), JSON.stringify({ tid: other, oid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }), "synthetic-only"]
  .map((s) => Buffer.from(s).toString("base64url")).join(".");
process.env.COOP_FABRIC_MCP_TOKEN = foreignTenant;
await dispatch(read(), true); process.env.COOP_FABRIC_MCP_TOKEN = token();
// Another resolved environment or principal reads too: there is no grant to match.
for (const change of [{ environment: "test" }, { environment: "" }]) { config(change); await dispatch(read(), false); }
config(); process.env.COOP_FABRIC_MCP_TOKEN = token("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
await dispatch(read(), false); process.env.COOP_FABRIC_MCP_TOKEN = token();
// A row read coop cannot classify asks.
const askRead = { toolName: "mcp", input: { server: "fabric", tool: "query_lakehouse_rows", args: {} } };
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
await dispatch({ toolName: "mcp__fabric__get_schema", input: { environment: "production" } }, false);
await dispatch({ toolName: "mcp__fabric__executeSQL", input: { sql: "DELETE FROM dbo.Customer" } }, true);
await commands.get("coop-live-read").handler("revoke", runner.createContext());
await dispatch(read(), false);
await runner.emit({ type: "session_shutdown", reason: "switch" });
await dispatch(read(), false);
for (const fail of [() => { throw new Error("SYNTHETIC_APPROVAL_SECRET"); }, () => Promise.reject(new Error("SYNTHETIC_APPROVAL_SECRET"))]) {
  await fresh(); answer = fail;
  for (const event of [askRead, ...mutations, { toolName: "bash", input: { command: "rm -rf SYNTHETIC_COMMAND_SECRET" } }]) {
    const result = await dispatch(event, true);
    assert.ok(!JSON.stringify(result).includes("SYNTHETIC_"));
  }
  answer = false; await dispatch(askRead, true);
}
runner.setUIContext(undefined);
for (const event of [askRead, ...mutations]) await dispatch(event, true);
await dispatch(read(), false); // a read needs no UI
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
    // Pi 0.99.2+ spells `-` as `_` in these names; earlier 0.99 kept `-`.
    const named = (server, tool) => tools.find((info) => info.name === `mcp__${server}__${tool}`)?.name
      ?? `mcp__${server.replace(/-/g, "_")}__${tool}`;
    const lookup = tools.find((info) => info.name === named("powerbi-modeling-mcp", "lookup"));
    assert.equal(tools.length, 6, "both servers' tools are registered");
    assert.ok(tools.every((info) => info.sourceInfo?.path === "builtin:mcp"), "Pi reports its built-in MCP as the source");
    assert.equal(lookup?.namespace?.name, named("powerbi-modeling-mcp", "lookup").replace(/__lookup$/, ""));
    assert.equal(lookup?.annotations?.destructiveHint, true);
    const blocks = async (name, args) => (await session._beforeToolCall({ toolCall: { id: name, name }, args }))?.block === true;
    assert.equal(await blocks(named("powerbi-modeling-mcp", "measure_operations"), { request: { operation: "List" } }), false, "a model read passes");
    assert.equal(asked.length, 0);
    assert.equal(await blocks(named("powerbi-modeling-mcp", "measure_operations"), { request: { operation: "Create" } }), true, "a model edit asks");
    assert.equal(await blocks("mcp__other_server__delete_item", { tool: "list_items", id: "1" }), true, "a `tool` argument cannot relabel a delete");
    assert.match(asked.at(-1), /other_server\/delete_item/);
    assert.equal(await blocks(named("powerbi-modeling-mcp", "lookup"), {}), true, "a tool its server marks destructive asks");
    assert.equal(asked.length, 3);
    await session._extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
}

// Pi 1.x codemode (master plan U2 step 3): a real session with Pi's built-in
// extensions (MCP left out), coop's codemode and coop's guardrails, and a faux
// model that sends one codemode script. Every call the script makes must reach
// the guardrails like a direct call, and coop's codemode must replace Pi's even
// when a work repo turns the built-in one back on.
let codemode = false;
const piIndex = join(piRoot, "dist/index.js");
const fauxIndex = [join(piRoot, "node_modules/@earendil-works/pi-ai/dist/index.js"), join(piRoot, "../pi-ai/dist/index.js")].find((p) => existsSync(p));
if (existsSync(builtinIndex) && fauxIndex) {
  const pi = await import(pathToFileURL(piIndex).href);
  const ai = await import(pathToFileURL(fauxIndex).href);
  codemode = typeof pi.createCodemodeExtension === "function" && typeof ai.createFauxCore === "function";
  if (codemode) {
    const { builtInExtensions } = await import(pathToFileURL(builtinIndex).href);
    const cwd = mkdtempSync(join(scratch, "codemode-"));
    mkdirSync(join(cwd, ".pi"));
    // A work repo that turns Pi's codemode on and asks for scripts only.
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: ["+builtin:codemode"], codemode: { mode: "only" } }));
    config(); process.env.COOP_FABRIC_MCP_TOKEN = token();
    const settingsManager = pi.SettingsManager.create(cwd, agentDir);
    const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager,
      additionalExtensionPaths: [join(root, "extensions/coop-codemode"), join(root, "extensions/coop-guardrails/index.ts")],
      extensionFactories: builtInExtensions.filter((ext) => ext.name !== "mcp"),
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await resourceLoader.reload();
    const core = ai.createFauxCore({ provider: "faux", api: "faux-api", models: [{ id: "faux-1" }] });
    const runtime = await pi.ModelRuntime.create({ authPath: join(scratch, "faux-auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider("faux", { api: "faux-api", apiKey: "faux", baseUrl: "http://127.0.0.1:9", streamSimple: core.streamSimple,
      models: [{ id: "faux-1", name: "faux", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] });
    // pi-mcp-adapter's proxy tool, inert: it records what reached it.
    const ran = [];
    const mcpTool = { name: "mcp", label: "mcp", description: "MCP proxy (test)",
      parameters: { type: "object", properties: { server: { type: "string" }, tool: { type: "string" }, args: { type: "object" } }, required: ["tool"] },
      execute: async (_id, params) => { ran.push(`${params.server ?? ""}/${params.tool}`); return { content: [{ type: "text", text: "executed" }], details: {} }; } };
    const { session } = await pi.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime: runtime,
      model: runtime.getModel("faux", "faux-1"), sessionManager: pi.SessionManager.inMemory(), customTools: [mcpTool],
      tools: ["+codemode"], excludeTools: ["tool_search"] });
    let open = 0, maxOpen = 0;
    const asked = [];
    const slow = (value) => { open++; maxOpen = Math.max(maxOpen, open); return new Promise((done) => setTimeout(() => { open--; done(value); }, 300)); };
    let answerConfirm = false, holdConfirm = null;
    const uiContext = new Proxy({
      confirm: async (_title, message) => { asked.push(String(message)); return holdConfirm ? holdConfirm() : slow(answerConfirm); },
      // An edit's session approval: "Allow ... edits for this session".
      select: async (title, options) => { asked.push(String(title)); return slow(options[1]); },
    }, { get: (target, key) => (key in target ? target[key] : () => undefined) });
    await session.bindExtensions({ uiContext });
    const codemodeTools = session.getAllTools().filter((info) => info.name === "codemode");
    assert.equal(codemodeTools.length, 1);
    assert.match(String(codemodeTools[0].sourceInfo?.path).replace(/\\/g, "/"), /extensions\/coop-codemode$/, "coop's codemode replaces Pi's");
    assert.ok(session.getActiveToolNames().includes("read"), "mode stays on: tools stay declared");
    const run = async (code) => {
      core.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("codemode", { code })), ai.fauxAssistantMessage("done")]);
      await session.prompt("run the script");
      const results = session.messages.filter((m) => m.role === "toolResult" && m.toolName === "codemode");
      return results.at(-1).content.map((c) => c.text ?? "").join("");
    };
    assert.match(await run("return typeof models;"), /undefined/, "a script cannot reach outside models");
    const q = (query) => JSON.stringify({ server: "fabric-sqlendpoint", tool: "execute_query", args: { workspaceId: workspace, itemId: item, query } });
    const unlockPath = join(agentDir, "..", PROD_UNLOCK_FILE);
    const out = await run(`const r = await Promise.allSettled([
      tools.mcp(${q("SELECT TOP (5) customer_id FROM dbo.Customer")}),
      tools.mcp(${q("DELETE FROM dbo.Customer")}),
      tools.bash({ command: "rm -rf ./build" }),
      tools.read({ path: ".env" }),
      tools.write({ path: ${JSON.stringify(unlockPath)}, content: "{}" }),
    ]);
    return r.map((x) => x.status).join(",");`);
    assert.match(out, /fulfilled,rejected,rejected,rejected,rejected/, out);
    assert.deepEqual(ran, ["fabric-sqlendpoint/execute_query"], "only the production read ran; the production write never reached the tool");
    assert.equal(asked.length, 2, "the rm -rf and the .env read asked; the production write and the unlock were blocked outright");
    assert.equal(maxOpen, 1, "never two dialogs at once");
    // Dev edits: the first asks, its session approval covers the ones that waited.
    asked.length = 0; ran.length = 0;
    const m = (op) => JSON.stringify({ server: "powerbi-modeling-mcp", tool: "measure_operations", args: { request: { operation: op } } });
    const edits = await run(`const r = await Promise.allSettled([tools.mcp(${m("Create")}), tools.mcp(${m("Update")}), tools.mcp(${m("Create")})]);
    return r.map((x) => x.status).join(",");`);
    assert.match(edits, /fulfilled,fulfilled,fulfilled/, edits);
    assert.equal(asked.length, 1, "one approval, held for the session, covers the edits that waited (each waited 300 ms on the desk)");
    assert.equal(ran.length, 3);
    const rows = readFileSync(join(agentDir, "guardrails-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
      .filter((r) => r.kind === "codemode-script" && r.decision === "ran");
    assert.equal(rows.at(-2).detail, "mcp:ok, mcp:error, bash:error, read:error, write:error", "each nested call is audited by name");
    assert.ok(!rows.some((r) => /DELETE|dbo\.Customer|rm -rf/.test(r.detail)), "never the arguments");
    // #373: a script with more than 20 calls keeps every call in its audit row.
    writeFileSync(join(cwd, "safe.txt"), "safe");
    await run(`for (let i = 0; i < 21; i++) await tools.read({ path: "safe.txt" });
    return await tools.mcp(${q("SELECT TOP (5) customer_id FROM dbo.Customer")});`);
    const long = readFileSync(join(agentDir, "guardrails-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
      .filter((r) => r.kind === "codemode-script" && r.decision === "ran").at(-1);
    assert.equal(long.detail, `${Array(21).fill("read:ok").join(", ")}, mcp:ok`, "every nested call, in order, the last one too");
    // #371: a link alias to the production unlock, dangling or not, is refused
    // without a prompt and never creates a grant.
    const coopDir = mkdtempSync(join(scratch, "coop-dir-"));
    mkdirSync(join(coopDir, ".coop"));
    const savedCoopDir = process.env.COOP_DIR;
    process.env.COOP_DIR = coopDir;
    try {
      const grantPath = join(coopDir, ".coop", PROD_UNLOCK_FILE);
      symlinkSync(grantPath, join(cwd, "receipt.json"));
      const grant = JSON.stringify({ schema_version: 1, id: "review-only", client: "Contoso",
        created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() });
      asked.length = 0;
      const alias = await run(`const r = await Promise.allSettled([
        tools.write({ path: "receipt.json", content: ${JSON.stringify(grant)} }),
        tools.edit({ path: "receipt.json", edits: [{ oldText: "a", newText: "b" }] }),
      ]);
      return r.map((x) => x.status).join(",");`);
      assert.match(alias, /rejected,rejected/, alias);
      assert.equal(existsSync(grantPath), false, "no grant was written");
      writeFileSync(grantPath, "{}");
      answerConfirm = true;
      const present = await run(`try { await tools.write({ path: "receipt.json", content: ${JSON.stringify(grant)} }); return "wrote"; } catch { return "refused"; }`);
      answerConfirm = false;
      assert.match(present, /refused/, present);
      assert.equal(readFileSync(grantPath, "utf8"), "{}", "an existing grant is not changed either");
      assert.equal(asked.length, 0, "no confirmation was offered to override it");
    } finally {
      if (savedCoopDir === undefined) delete process.env.COOP_DIR; else process.env.COOP_DIR = savedCoopDir;
    }
    // #372: Esc while a script's approval is open closes it as a no; the next
    // script is not held behind the old dialog, and a late answer grants nothing.
    let pendingAnswer;
    holdConfirm = () => new Promise((done) => { pendingAnswer = done; });
    asked.length = 0;
    core.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall("codemode", { code: `await Promise.allSettled([tools.read({ path: ".env" }), tools.read({ path: ".env.local" })]); return "finished";` })), ai.fauxAssistantMessage("done")]);
    const stopped = session.prompt("run the script");
    for (let i = 0; i < 100 && asked.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(asked.length, 1, "the first secret read is asking");
    await session.abort();
    await stopped;
    holdConfirm = null;
    const followup = await Promise.race([run(`return await tools.read({ path: "safe.txt" });`), new Promise((r) => setTimeout(() => r("still blocked"), 2000))]);
    assert.match(followup, /safe/, `a harmless script after the stop completes: ${followup}`);
    pendingAnswer?.(true);
    assert.equal(asked.length, 1, "the queued call from the stopped script never asked");
    await session._extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
}
if (Number(version.split(".")[0]) >= 1) assert.ok(codemode, "Pi 1.x: the codemode script check must run (faux provider or createCodemodeExtension not found)");
console.log(`Pi ${version}: real AgentSession beforeToolCall + ExtensionRunner integration passed${builtinMcp ? ", with its built-in MCP" : ""}${codemode ? ", and codemode scripts" : ""} (offline, synthetic fixtures).`);

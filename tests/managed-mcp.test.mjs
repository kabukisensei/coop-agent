import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { patchMcpConfigSource, patchMcpInitSource, ensureMcpIsolationCompatibility } from "../lib/mcp-isolation-compat.mjs";
import { ensureManagedMcpConfig } from "../lib/managed-mcp-config.mjs";
import { createReparseLink } from "./fixtures/reparse-link.mjs";

const temp = mkdtempSync(join(tmpdir(), "coop-managed-mcp-"));
const original = readFileSync(new URL("fixtures/pi-mcp-adapter-2.10.0/config.ts", import.meta.url), "utf8");
const originalInit = readFileSync(new URL("fixtures/pi-mcp-adapter-2.10.0/init.ts", import.meta.url), "utf8");
const savedManaged = process.env.COOP_DESKTOP_MANAGED_RUNTIME;
let count = 0;
const test = async (name, fn) => { await fn(); count++; console.log(`  ✓ ${name}`); };
const put = (path, value) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value)); };
try {
  const home = join(temp, "home"), profile = join(temp, "profile"), project = join(temp, "project");
  for (const path of [home, profile, project]) mkdirSync(path);
  put(join(home, ".config/mcp/mcp.json"), { mcpServers: { unrelated: { command: "not-run" } } });
  put(join(home, ".cursor/mcp.json"), { mcpServers: { imported: { command: "not-run" } } });
  put(join(profile, "mcp.json"), { mcpServers: { owned: { command: "not-run" } } });
  put(join(project, ".mcp.json"), { mcpServers: { project: { command: "not-run" } } });
  // Run the pinned upstream parser against a wholly synthetic home/profile.
  const source = patchMcpConfigSource(original)
    .replace('import { homedir } from "node:os";', `const homedir = () => ${JSON.stringify(home)};`)
    .replace('import { getAgentPath } from "./agent-dir.ts";', `const getAgentPath = name => join(${JSON.stringify(profile)}, name);`);
  const input = join(temp, "config.ts"), output = join(temp, "config.mjs"); put(input, source);
  const bundled = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["-y", "esbuild", input, "--format=esm", "--platform=node", "--outfile=" + output], { shell: process.platform === "win32", encoding: "utf8" });
  assert.equal(bundled.status, 0, bundled.stderr);
  const config = await import(pathToFileURL(output));
  await test("managed clients exclude shared global servers and import discovery while preserving profile and project configuration", () => {
    process.env.COOP_DESKTOP_MANAGED_RUNTIME = "1";
    assert.deepEqual(Object.keys(config.loadMcpConfig(undefined, project).mcpServers).sort(), ["owned", "project"]);
    assert.deepEqual(config.findAvailableImportConfigs(project), []);
    assert.deepEqual(config.getMcpDiscoverySummary(undefined, project).imports, []);
    assert.equal(config.getConfigDiscoveryPaths(undefined, project).length, 3);
  });
  await test("ordinary terminal clients retain upstream global and explicit import discovery", () => {
    delete process.env.COOP_DESKTOP_MANAGED_RUNTIME;
    assert.deepEqual(Object.keys(config.loadMcpConfig(undefined, project).mcpServers).sort(), ["owned", "project", "unrelated"]);
    assert.equal(config.findAvailableImportConfigs(project).some(value => value.kind === "cursor"), true);
  });
  await test("the correction is reproducible and rejects source drift and tampering", () => {
    const pkg = join(temp, "package"); mkdirSync(pkg);
    put(join(pkg, "package.json"), { name: "pi-mcp-adapter", version: "2.10.0" }); put(join(pkg, "config.ts"), original);
    put(join(pkg, "init.ts"), originalInit);
    assert.throws(() => ensureMcpIsolationCompatibility(pkg, { check: true }), /missing or changed/);
    const receipt = ensureMcpIsolationCompatibility(pkg);
    assert.deepEqual(ensureMcpIsolationCompatibility(pkg, { check: true }), receipt);
    assert.deepEqual(ensureMcpIsolationCompatibility(pkg), receipt);
    put(join(pkg, "config.ts"), source + "\n");
    assert.throws(() => ensureMcpIsolationCompatibility(pkg), /Unrecognized/);
  });
  await test("initialization correction is pinned and rejects upstream source drift", () => {
    const patched = patchMcpInitSource(originalInit);
    assert.equal(patched.replace('    bootstrapAll = process.env.COOP_DESKTOP_MANAGED_RUNTIME !== "1";', "    bootstrapAll = true;"), originalInit);
    assert.throws(() => patchMcpInitSource(originalInit + "\n"), /Unrecognized/);
  });
  function runtime(name) {
    const root = join(temp, name);
    for (const path of ["node/node.exe", "npm/node_modules/@microsoft/fabric-mcp/index.js", "npm/node_modules/@microsoft/powerbi-modeling-mcp/index.js"]) put(join(root, path), "fixture");
    return root;
  }
  const first = runtime("Runtime & café"), second = runtime("replacement-runtime"), agent = join(temp, "agent");
  await test("bundled defaults require no npm acquisition and keep Modeling read-only", () => {
    assert.equal(ensureManagedMcpConfig(first, agent, { platform: "win32" }).changed, true);
    const value = JSON.parse(readFileSync(join(agent, "mcp.json"), "utf8"));
    assert.equal(Object.keys(value.mcpServers).length, 3);
    assert.equal(value.mcpServers["powerbi-modeling-mcp"].args.at(-1), "--readonly");
    assert.equal(value.mcpServers.fabric.command, join(first, "node/node.exe"));
    assert.equal(ensureManagedMcpConfig(first, agent, { platform: "win32" }).changed, false);
    assert.equal(ensureManagedMcpConfig(second, agent, { platform: "win32" }).changed, true);
    assert.equal(JSON.parse(readFileSync(join(agent, "mcp.json"))).mcpServers.fabric.command, join(second, "node/node.exe"));
  });
  await test("existing unowned servers and settings survive refresh", () => {
    put(join(agent, "mcp.json"), { mcpServers: { fabric: { command: "user-owned" }, custom: { command: "preserve" } }, settings: { autoAuth: false }, _coop: { note: "preserve" } });
    ensureManagedMcpConfig(first, agent, { platform: "win32" });
    const value = JSON.parse(readFileSync(join(agent, "mcp.json")));
    assert.equal(value.mcpServers.fabric.command, "user-owned");
    assert.equal(value.mcpServers.custom.command, "preserve");
    assert.deepEqual(value.settings, { autoAuth: false });
    assert.equal(value._coop.note, "preserve");
    assert.equal(value._coop.managed_servers.includes("fabric"), false);
  });
  await test("invalid config and linked profile are preserved without writing outside the profile", () => {
    put(join(agent, "mcp.json"), "broken");
    assert.throws(() => ensureManagedMcpConfig(first, agent, { platform: "win32" }));
    assert.equal(readFileSync(join(agent, "mcp.json"), "utf8"), "broken");
    const linked = join(temp, "linked-profile"); createReparseLink(agent, linked, "dir");
    assert.throws(() => ensureManagedMcpConfig(first, linked, { platform: "win32" }), /must not be links/);
  });
  console.log(`  ${count} managed MCP tests passed`);
} finally {
  if (savedManaged === undefined) delete process.env.COOP_DESKTOP_MANAGED_RUNTIME; else process.env.COOP_DESKTOP_MANAGED_RUNTIME = savedManaged;
  rmSync(temp, { recursive: true, force: true });
}

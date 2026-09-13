import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync, renameSync, linkSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Never import the workstation's tenant, credentials or shared MCP config. Only
// these owned defaults are refreshed when the installed runtime path changes.
export function ensureManagedMcpConfig(runtimeRoot, agentDir, { platform = process.platform } = {}) {
  for (const path of [runtimeRoot, agentDir]) if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Managed MCP paths must be absolute.");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  for (const path of [runtimeRoot, agentDir]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Managed MCP directories must not be links.");
  }
  const node = join(runtimeRoot, platform === "win32" ? "node/node.exe" : "node/bin/node");
  const entry = path => join(runtimeRoot, "npm/node_modules", path);
  const desired = {
    "powerbi-modeling-mcp": { command: node, args: [entry("@microsoft/powerbi-modeling-mcp/index.js"), "--start", "--readonly"], lifecycle: "lazy" },
    fabric: { command: node, args: [entry("@microsoft/fabric-mcp/index.js"), "server", "start", "--mode", "namespace"], env: { AZURE_TOKEN_CREDENTIALS: "AzureCliCredential" }, lifecycle: "lazy" },
    "microsoft-learn": { url: "https://learn.microsoft.com/api/mcp", auth: false, lifecycle: "lazy" },
  };
  for (const server of Object.values(desired)) {
    for (const path of server.command ? [server.command, server.args[0]] : []) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Bundled MCP command is missing or unsafe.");
    }
  }
  const path = join(agentDir, "mcp.json");
  let value = {}, original = null, bytes = "";
  try {
    original = lstatSync(path);
    if (!original.isFile() || original.isSymbolicLink() || original.size > 1024 * 1024) throw new Error("Managed MCP configuration must be a bounded regular file.");
    const fd = openSync(path, "r");
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== original.dev || opened.ino !== original.ino) throw new Error("Managed MCP configuration changed while opening.");
      bytes = readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
    value = JSON.parse(bytes.replace(/^\uFEFF/, ""));
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!value || typeof value !== "object" || Array.isArray(value) || (value.mcpServers !== undefined && (!value.mcpServers || typeof value.mcpServers !== "object" || Array.isArray(value.mcpServers)))) throw new Error("Managed MCP configuration is invalid; it was preserved.");
  const servers = { ...value.mcpServers }, owned = new Set(Array.isArray(value._coop?.managed_servers) ? value._coop.managed_servers : []);
  for (const [name, server] of Object.entries(desired)) {
    if (!(name in servers) || owned.has(name)) { servers[name] = server; owned.add(name); }
  }
  const result = { ...value, mcpServers: servers, _coop: { ...value._coop, managed_servers: [...owned] } };
  const output = JSON.stringify(result, null, 2) + "\n";
  if (output === bytes) return { changed: false, path };
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, output, { flag: "wx", mode: 0o600 });
  try {
    if (original) {
      const current = lstatSync(path);
      if (current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino || readFileSync(path, "utf8") !== bytes) throw new Error("Managed MCP configuration changed; retry after the editor finishes.");
      renameSync(temporary, path);
    } else linkSync(temporary, path);
  } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  return { changed: true, path };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error("Expected runtime-root and agent-directory.");
    ensureManagedMcpConfig(process.argv[2], process.argv[3]);
  } catch (error) { console.error(`Managed MCP: ${error.message}`); process.exitCode = 1; }
}

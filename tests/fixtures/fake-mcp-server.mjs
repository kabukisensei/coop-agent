// A minimal MCP server over stdio (newline-delimited JSON-RPC) for offline tests.
// It lists three tools and answers every call with fixed text; nothing leaves the process.
import { createInterface } from "node:readline";

const tools = [
  { name: "measure_operations", description: "Model measures", inputSchema: { type: "object", properties: { request: { type: "object" } } } },
  { name: "delete_item", description: "Delete an item", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
  { name: "lookup", description: "Look something up", inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } },
];
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") {
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "coop-test", version: "0.0.1" } } });
  } else if (m.method === "tools/list") {
    send({ jsonrpc: "2.0", id: m.id, result: { tools } });
  } else if (m.method === "tools/call") {
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `ran ${m.params?.name}` }] } });
  } else if (m.id !== undefined) {
    send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});

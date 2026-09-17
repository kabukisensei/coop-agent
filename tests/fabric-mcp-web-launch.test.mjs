// Prove coop web injects a Fabric token only into Pi and fails soft without Python.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const STUB_PI_URL = pathToFileURL(join(HERE, "stub-pi.mjs")).href;

async function runCase({ withPython }) {
  const temp = mkdtempSync(join(tmpdir(), "coop-fabric-web-"));
  const marker = join(temp, "pi-token");
  const canary = "fabric-web-canary-4bd593";
  const fakeRoot = join(temp, "root");
  const agentDir = join(temp, "agent");
  const piWrapper = join(temp, "pi-wrapper.mjs");
  const port = 20000 + Math.floor(Math.random() * 20000);
  mkdirSync(join(fakeRoot, "lib"), { recursive: true });
  mkdirSync(agentDir);

  // server.mjs invokes COOP_PYTHON_BIN <root>/lib/warehouse_mcp.py launch-token ...
  // Node executes this extension-independent fixture so the test is native on Windows too.
  writeFileSync(
    join(fakeRoot, "lib", "warehouse_mcp.py"),
    `process.stdout.write(${JSON.stringify(`token\t${canary}\tend`)});\n`,
  );
  writeFileSync(
    join(agentDir, "mcp.json"),
    JSON.stringify({
      _coop: { managed_servers: ["fabric-sqlendpoint"] },
      mcpServers: {
        "fabric-sqlendpoint": {
          url: "https://api.fabric.microsoft.com/v1/mcp/dataPlane/sqlEndpoint",
          auth: false,
          requestHeadersCommand: {
            command: "node",
            args: [
              join(fakeRoot, "lib", "fabric_request_headers.mjs"),
              "https://api.fabric.microsoft.com/v1/mcp/dataPlane/sqlEndpoint",
            ],
            timeoutMs: 10000,
          },
          requestTimeoutMs: 60000,
          lifecycle: "lazy",
          _coop_target: {
            scope: "global", workspace_id: "", item_id: "", item_type: "", reason: "fixture",
            client: "", tenant_id: "", environment: "", item_name: "",
          },
        },
      },
    }),
  );
  writeFileSync(
    piWrapper,
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(marker)}, process.env.COOP_FABRIC_MCP_TOKEN || "");\n` +
      `await import(${JSON.stringify(STUB_PI_URL)});\n`,
  );

  const spec = JSON.stringify({
    bin: process.execPath,
    args: [piWrapper],
    env: { PI_CODING_AGENT_DIR: agentDir },
  });
  assert(!spec.includes(canary));
  const env = {
    ...process.env,
    COOP_FABRIC_MCP_TOKEN: "stale-inherited-token",
    COOP_LAUNCH_SPEC: spec,
    COOP_ROOT: fakeRoot,
    COOP_WEB_NO_OPEN: "1",
  };
  delete env.COOP_PYTHON_BIN;
  if (withPython) env.COOP_PYTHON_BIN = process.execPath;

  const server = spawn(process.execPath, [join(ROOT, "web", "server.mjs"), "--port", String(port)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk) => { stdout += chunk; });
  server.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    const expected = withPython ? canary : "";
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        if (readFileSync(marker, "utf8") === expected) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(readFileSync(marker, "utf8"), expected);
    assert(!stdout.includes(canary));
    assert(!stderr.includes(canary));
    assert(!stderr.includes("stale-inherited-token"));
    assert(!spec.includes("COOP_FABRIC_MCP_TOKEN"));
    if (!withPython) {
      assert.match(stderr, /Fabric Warehouse MCP unavailable: token helper Python is unavailable/);
    }
  } finally {
    if (server.exitCode === null) server.kill("SIGTERM");
    if (server.exitCode === null) {
      await new Promise((resolve) => server.once("exit", resolve));
    }
    rmSync(temp, { recursive: true, force: true });
  }
}

await runCase({ withPython: true });
console.log("  ✓ coop web injects the Fabric token only into Pi child environment");
await runCase({ withPython: false });
console.log("  ✓ coop web remains available without token-helper Python");

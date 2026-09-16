// Prove coop web keeps the Fabric token out of launch-spec and injects it only into Pi.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
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
  `process.stdout.write(${JSON.stringify(canary)});\n`,
);
writeFileSync(
  piWrapper,
  `import { writeFileSync } from "node:fs";\n` +
    `writeFileSync(${JSON.stringify(marker)}, process.env.COOP_FABRIC_MCP_TOKEN || "");\n` +
    `await import(${JSON.stringify(pathToFileURL(join(HERE, "stub-pi.mjs")).href)});\n`,
);

const spec = JSON.stringify({
  bin: process.execPath,
  args: [piWrapper],
  env: { PI_CODING_AGENT_DIR: agentDir },
});
assert(!spec.includes(canary));
const server = spawn(process.execPath, [join(ROOT, "web", "server.mjs"), "--port", String(port)], {
  env: {
    ...process.env,
    COOP_FABRIC_MCP_TOKEN: "stale-inherited-token",
    COOP_LAUNCH_SPEC: spec,
    COOP_PYTHON_BIN: process.execPath,
    COOP_ROOT: fakeRoot,
    COOP_WEB_NO_OPEN: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
server.stdout.on("data", (chunk) => { stdout += chunk; });
server.stderr.on("data", (chunk) => { stderr += chunk; });

try {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      if (readFileSync(marker, "utf8") === canary) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(readFileSync(marker, "utf8"), canary);
  assert(!stdout.includes(canary));
  assert(!stderr.includes(canary));
  assert(!spec.includes("COOP_FABRIC_MCP_TOKEN"));
  console.log("  ✓ coop web injects the Fabric token only into Pi child environment");
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  rmSync(temp, { recursive: true, force: true });
}

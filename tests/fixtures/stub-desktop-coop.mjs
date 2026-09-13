#!/usr/bin/env node
// A development-only `coop` executable for exercising the packaged desktop shell
// against the real Coop Runtime/Web SPA and the checked-in stub Pi process.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const args = process.argv.slice(2);
if (args[0] !== "runtime") {
  process.stderr.write("stub-desktop-coop only supports the runtime command.\n");
  process.exit(2);
}

const agentDir = mkdtempSync(join(tmpdir(), "coop-desktop-spike-agent-"));
process.on("exit", () => {
  try { rmSync(agentDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

process.env.COOP_RUNTIME_MODE = "1";
process.env.COOP_WEB_NO_OPEN = "1";
process.env.COOP_LAUNCH_SPEC = JSON.stringify({
  bin: process.execPath,
  args: [join(ROOT, "tests", "stub-pi.mjs")],
  env: { PI_CODING_AGENT_DIR: agentDir },
});

await import(join(ROOT, "web", "server.mjs"));

#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { getAuthProviders } from "../web/auth-service.mjs";

try {
  const agentDir = process.env.PI_CODING_AGENT_DIR || process.env.COOP_AGENT_DIR || join(homedir(), ".coop", "agent");
  const report = await getAuthProviders({ agentDir });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  process.stderr.write(`coop auth: ${error.message}\n`);
  process.exitCode = 1;
}

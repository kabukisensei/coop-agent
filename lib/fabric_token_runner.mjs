#!/usr/bin/env node
// Supervise the Python token helper without exposing child diagnostics.
import { spawnSync } from "node:child_process";

const [python, helper, config] = process.argv.slice(2);
if (!python || !helper || !config) process.exit(2);
const env = { ...process.env };
delete env.COOP_FABRIC_MCP_TOKEN;
const result = spawnSync(python, [helper, "launch-token", config], {
  env,
  encoding: "buffer",
  timeout: 15000,
  windowsHide: true,
  maxBuffer: 65536,
});
if (result.error || result.status !== 0 || (result.stderr?.length || 0) !== 0) process.exit(1);
const bytes = result.stdout || Buffer.alloc(0);
if (bytes.length === 0) process.exit(0);
let output;
try {
  output = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
} catch {
  process.exit(1);
}
const token = output.match(/^token\t([!-~]{1,16384})\tend$/);
const warning = output.match(/^warning\t(config_invalid|azure_cli_unavailable|token_launch_failed|token_timeout|auth_required|token_command_failed|token_output_invalid)\tend$/);
if (!token && !warning) process.exit(1);
process.stdout.write(output);

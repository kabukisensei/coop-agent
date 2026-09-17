#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_AZ_OUTPUT_BYTES = 64 * 1024;
const AZ_TIMEOUT_MS = 8000;
const FABRIC_RESOURCE = "https://api.fabric.microsoft.com";
const FABRIC_URL = /^https:\/\/api\.fabric\.microsoft\.com\/v1\/mcp\/dataPlane\/(?:sqlEndpoint|workspaces\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/items\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/sqlEndpoint)$/;
const VISIBLE_ASCII = /^[!-~]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function azureCliCommand(platform = process.platform, env = process.env) {
  const args = ["account", "get-access-token", "--resource", FABRIC_RESOURCE, "--output", "json"];
  if (platform === "win32") {
    if (typeof env.COMSPEC !== "string" || env.COMSPEC.length === 0) return null;
    return { command: env.COMSPEC, args: ["/d", "/c", "az", ...args] };
  }
  return { command: "az", args };
}

function jwtIdentity(token) {
  if (typeof token !== "string" || token.length > 16384 || !VISIBLE_ASCII.test(token)) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const tenant = typeof claims?.tid === "string" ? claims.tid.toLowerCase() : "";
    const kind = typeof claims?.oid === "string" ? "oid" : typeof claims?.sub === "string" ? "sub" : "";
    const principal = kind ? claims[kind] : "";
    if (!UUID.test(tenant) || typeof principal !== "string" || !VISIBLE_ASCII.test(principal)) return null;
    return { tenant, kind, principal: principal.toLowerCase() };
  } catch {
    return null;
  }
}

function sameIdentity(left, right) {
  return left && right && left.tenant === right.tenant && left.kind === right.kind && left.principal === right.principal;
}

function readEnvelope() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_STDIN_BYTES) {
        process.stdin.destroy();
        reject(new Error());
      } else chunks.push(chunk);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("error", reject);
  });
}

function acquireToken(commandSpec, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandSpec.command, commandSpec.args, {
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error());
    };
    const timer = setTimeout(fail, AZ_TIMEOUT_MS);
    child.on("error", fail);
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
      if (stdout.length > MAX_AZ_OUTPUT_BYTES) fail();
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      fail();
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 || stderrBytes !== 0 || stdout.length === 0) return reject(new Error());
      resolve(stdout);
    });
  });
}

async function main() {
  const expectedUrl = process.argv[2];
  if (process.argv.length !== 3 || typeof expectedUrl !== "string" || !FABRIC_URL.test(expectedUrl)) throw new Error();
  const raw = await readEnvelope();
  let envelope;
  try { envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { throw new Error(); }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
      || Object.keys(envelope).sort().join(",") !== "bodyBase64,method,url,version"
      || envelope.version !== 1 || !["GET", "POST", "DELETE"].includes(envelope.method)
      || envelope.url !== expectedUrl || typeof envelope.bodyBase64 !== "string"
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.bodyBase64)) throw new Error();

  const launchIdentity = jwtIdentity(process.env.COOP_FABRIC_MCP_TOKEN);
  if (!launchIdentity) throw new Error();
  const commandSpec = azureCliCommand();
  if (!commandSpec) throw new Error();
  const childEnv = { ...process.env };
  delete childEnv.COOP_FABRIC_MCP_TOKEN;
  const output = await acquireToken(commandSpec, childEnv);
  let token;
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output));
    token = parsed?.accessToken;
  } catch { throw new Error(); }
  const renewedIdentity = jwtIdentity(token);
  if (!sameIdentity(launchIdentity, renewedIdentity)) throw new Error();
  process.stdout.write(JSON.stringify({ Authorization: `Bearer ${token}` }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => { process.exitCode = 1; });
}

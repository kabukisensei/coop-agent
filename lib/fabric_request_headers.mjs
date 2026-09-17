#!/usr/bin/env node
import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_AZ_OUTPUT_BYTES = 64 * 1024;
const AZ_TIMEOUT_MS = 8000;
const FABRIC_RESOURCE = "https://api.fabric.microsoft.com";
const FABRIC_URL = /^https:\/\/api\.fabric\.microsoft\.com\/v1\/mcp\/dataPlane\/(?:sqlEndpoint|workspaces\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/items\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/sqlEndpoint)$/;
const VISIBLE_ASCII = /^[!-~]+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AZ_ARGS = ["account", "get-access-token", "--resource", FABRIC_RESOURCE, "--output", "json"];
const SAFE_ENV_KEYS = [
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA",
  "SystemRoot", "WINDIR", "SystemDrive", "TEMP", "TMP", "TMPDIR",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
];

function inside(candidate, directory, pathApi) {
  const relative = pathApi.relative(directory, candidate);
  return relative === "" || (!relative.startsWith(`..${pathApi.sep}`) && relative !== ".." && !pathApi.isAbsolute(relative));
}

function canonicalDirectory(raw, pathApi) {
  if (typeof raw !== "string" || !raw || !pathApi.isAbsolute(raw)) return null;
  try {
    const canonical = realpathSync.native(raw);
    return statSync(canonical).isDirectory() ? canonical : null;
  } catch { return null; }
}

function safePath(platform, env, cwd) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const separator = platform === "win32" ? ";" : ":";
  let canonicalCwd;
  try { canonicalCwd = realpathSync.native(cwd); } catch { return null; }
  const directories = [];
  for (const raw of typeof env.PATH === "string" ? env.PATH.split(separator) : []) {
    const directory = canonicalDirectory(raw, pathApi);
    if (directory && !inside(directory, canonicalCwd, pathApi) && !directories.includes(directory)) directories.push(directory);
  }
  return { directories, value: directories.join(separator), canonicalCwd, pathApi };
}

function executable(candidate, cwd, pathApi, mode = constants.F_OK) {
  try {
    const canonical = realpathSync.native(candidate);
    if (!pathApi.isAbsolute(canonical) || inside(canonical, cwd, pathApi) || !statSync(canonical).isFile()) return null;
    accessSync(canonical, mode);
    return canonical;
  } catch { return null; }
}

export function windowsAzureCliCommand(cmd, cli) {
  if (![cmd, cli].every((value) => typeof value === "string" && path.win32.isAbsolute(value))) return null;
  if (/["&|<>^%!()\r\n]/.test(cli)) return null;
  const extension = path.win32.extname(cli).toLowerCase();
  if (extension === ".exe") return { command: cli, args: [...AZ_ARGS] };
  if (extension !== ".cmd" && extension !== ".bat") return null;
  const commandLine = `""${cli}" ${AZ_ARGS.join(" ")}"`;
  return { command: cmd, args: ["/d", "/s", "/c", commandLine] };
}

export function azureCliCommand(platform = process.platform, env = process.env, cwd = process.cwd()) {
  const sanitized = safePath(platform, env, cwd);
  if (!sanitized) return null;
  const { directories, canonicalCwd, pathApi } = sanitized;
  if (platform === "win32") {
    const systemRoot = canonicalDirectory(env.SystemRoot, pathApi);
    if (!systemRoot || inside(systemRoot, canonicalCwd, pathApi)) return null;
    const system32 = canonicalDirectory(pathApi.join(systemRoot, "System32"), pathApi);
    if (!system32) return null;
    const cmd = executable(pathApi.join(system32, "cmd.exe"), canonicalCwd, pathApi);
    if (!cmd || !inside(cmd, system32, pathApi)) return null;
    for (const name of ["az.cmd", "az.exe", "az.bat"]) {
      for (const directory of directories) {
        const cli = executable(pathApi.join(directory, name), canonicalCwd, pathApi);
        if (cli) return windowsAzureCliCommand(cmd, cli);
      }
    }
    return null;
  }
  for (const directory of directories) {
    const cli = executable(pathApi.join(directory, "az"), canonicalCwd, pathApi, constants.X_OK);
    if (cli) return { command: cli, args: [...AZ_ARGS] };
  }
  return null;
}

function childEnvironment(commandSpec, platform, env, cwd) {
  const sanitized = safePath(platform, env, cwd);
  if (!sanitized || !sanitized.value) return null;
  const child = { PATH: sanitized.value };
  for (const key of SAFE_ENV_KEYS) {
    if (typeof env[key] === "string" && env[key] && !env[key].includes("\0")) child[key] = env[key];
  }
  if (typeof env.AZURE_CONFIG_DIR === "string") {
    const directory = canonicalDirectory(env.AZURE_CONFIG_DIR, sanitized.pathApi);
    if (directory && !inside(directory, sanitized.canonicalCwd, sanitized.pathApi)) child.AZURE_CONFIG_DIR = directory;
  }
  if (platform === "win32") child.SystemRoot = path.win32.dirname(path.win32.dirname(commandSpec.command));
  return child;
}

function canonicalBase64url(part) {
  if (typeof part !== "string" || !BASE64URL.test(part)) return null;
  try {
    const decoded = Buffer.from(part, "base64url");
    return decoded.length > 0 && decoded.toString("base64url") === part ? decoded : null;
  } catch { return null; }
}

function jwtIdentity(token) {
  if (typeof token !== "string" || token.length > 16384 || !VISIBLE_ASCII.test(token)) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const decoded = parts.map(canonicalBase64url);
  if (decoded.some((part) => part === null)) return null;
  try {
    const claims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded[1]));
    const tenant = typeof claims?.tid === "string" ? claims.tid.toLowerCase() : "";
    const kind = typeof claims?.oid === "string" ? "oid" : typeof claims?.sub === "string" ? "sub" : "";
    const principal = kind ? claims[kind] : "";
    if (!UUID.test(tenant) || typeof principal !== "string" || !VISIBLE_ASCII.test(principal)) return null;
    return { tenant, kind, principal: principal.toLowerCase() };
  } catch { return null; }
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
  const childEnv = childEnvironment(commandSpec, process.platform, process.env, process.cwd());
  if (!childEnv) throw new Error();
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

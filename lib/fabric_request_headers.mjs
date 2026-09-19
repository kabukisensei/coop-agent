#!/usr/bin/env node
import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_AZ_OUTPUT_BYTES = 64 * 1024;
const MAX_WINDOWS_PROTOCOL_BYTES = MAX_AZ_OUTPUT_BYTES + 128;
const AZ_TIMEOUT_MS = 8000;
const FABRIC_RESOURCE = "https://api.fabric.microsoft.com";
const SQL_RESOURCE = "https://database.windows.net/";
const TOKEN_RESOURCES = new Set([FABRIC_RESOURCE, SQL_RESOURCE]);
const TOKEN_FRAME = "coop-azure-token-v1\t";
const WINDOWS_STDOUT_SENTINEL = Buffer.from("COOP_AZURE_COMPLETE_V1:", "ascii");
const WINDOWS_STDERR_SENTINEL = Buffer.from("COOP_AZURE_STDERR_COMPLETE_V1", "ascii");
const FABRIC_URL = /^https:\/\/api\.fabric\.microsoft\.com\/v1\/mcp\/dataPlane\/(?:sqlEndpoint|workspaces\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/items\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/sqlEndpoint)$/;
const VISIBLE_ASCII = /^[!-~]+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const azArgs = (resource) => ["account", "get-access-token", "--resource", resource, "--output", "json"];
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

export function windowsAzureCliCommand(cmd, cli, resource = FABRIC_RESOURCE) {
  if (![cmd, cli].every((value) => typeof value === "string" && path.win32.isAbsolute(value))) return null;
  if (!TOKEN_RESOURCES.has(resource) || /["&|<>^%!\r\n]/.test(cli)) return null;
  const extension = path.win32.extname(cli).toLowerCase();
  if (![".cmd", ".bat", ".exe"].includes(extension)) return null;
  const args = azArgs(resource);
  const invocation = extension === ".exe" ? `"${cli}"` : `call "${cli}"`;
  const commandLine = `${invocation} ${args.join(" ")} & set "COOP_AZURE_RC=!ERRORLEVEL!" & echo ${WINDOWS_STDOUT_SENTINEL.toString("ascii")}!COOP_AZURE_RC!& >&2 echo ${WINDOWS_STDERR_SENTINEL.toString("ascii")}& set /p "COOP_AZURE_RELEASE=" & exit /b !COOP_AZURE_RC!`;
  return {
    command: cmd,
    args: ["/d", "/v:on", "/s", "/c", commandLine],
    windowsSupervisor: true,
  };
}

export function windowsAzureCliCandidates(directories) {
  return directories.flatMap((directory) => ["az.cmd", "az.exe", "az.bat"].map((name) => path.win32.join(directory, name)));
}

export function windowsTaskkillCommand(systemRoot, pid) {
  if (typeof systemRoot !== "string" || !path.win32.isAbsolute(systemRoot)
      || !Number.isSafeInteger(pid) || pid <= 0) return null;
  return {
    command: path.win32.join(systemRoot, "System32", "taskkill.exe"),
    args: ["/PID", String(pid), "/T", "/F"],
  };
}

function markerCount(buffer, marker) {
  let count = 0;
  let offset = 0;
  while ((offset = buffer.indexOf(marker, offset)) !== -1) {
    count += 1;
    offset += marker.length;
  }
  return count;
}

function parseTerminalMarker(buffer, marker, hasStatus, final) {
  const count = markerCount(buffer, marker);
  if (count !== 1) return { state: count > 1 || final ? "invalid" : "pending" };
  const index = buffer.indexOf(marker);
  const tail = buffer.subarray(index + marker.length).toString("ascii");
  const match = hasStatus ? /^(0|[1-9][0-9]{0,9})\r?\n$/.exec(tail) : /^\r?\n$/.exec(tail);
  if (!match) return { state: final || tail.includes("\n") ? "invalid" : "pending" };
  const parsed = { state: "complete", payload: buffer.subarray(0, index) };
  if (hasStatus) {
    const code = Number(match[1]);
    if (!Number.isSafeInteger(code) || code > 0xFFFFFFFF) return { state: "invalid" };
    parsed.code = code;
  }
  return parsed;
}

export function parseWindowsAzureCompletion(stdout, stderr, final = false) {
  if (!Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr)) return { state: "invalid" };
  const out = parseTerminalMarker(stdout, WINDOWS_STDOUT_SENTINEL, true, final);
  const err = parseTerminalMarker(stderr, WINDOWS_STDERR_SENTINEL, false, final);
  if (out.state === "invalid" || err.state === "invalid") return { state: "invalid" };
  if (out.state !== "complete" || err.state !== "complete") return { state: "pending" };
  return { state: "complete", code: out.code, stdout: out.payload, stderr: err.payload };
}

export function azureCliCommand(platform = process.platform, env = process.env, cwd = process.cwd(), resource = FABRIC_RESOURCE) {
  if (!TOKEN_RESOURCES.has(resource)) return null;
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
    for (const candidate of windowsAzureCliCandidates(directories)) {
      const cli = executable(candidate, canonicalCwd, pathApi);
      if (cli) return windowsAzureCliCommand(cmd, cli, resource);
    }
    return null;
  }
  for (const directory of directories) {
    const cli = executable(pathApi.join(directory, "az"), canonicalCwd, pathApi, constants.X_OK);
    if (cli) return { command: cli, args: azArgs(resource) };
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
  if (platform === "win32") {
    const systemRoot = canonicalDirectory(env.SystemRoot, sanitized.pathApi);
    if (!systemRoot) return null;
    child.SystemRoot = systemRoot;
  }
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

class TokenError extends Error {
  constructor(kind) { super(); this.kind = kind; }
}

function acquireToken(commandSpec, env, expectedIdentity = null) {
  return new Promise((resolve, reject) => {
    const windowsSupervisor = process.platform === "win32" && commandSpec.windowsSupervisor === true;
    const child = spawn(commandSpec.command, commandSpec.args, {
      env,
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: windowsSupervisor,
      stdio: [windowsSupervisor ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const ownedPid = child.pid;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let completion = null;
    let token = null;
    let released = false;
    let settled = false;
    let cleanupTimer;
    const terminateTree = (done) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(cleanupTimer);
        try { child.kill("SIGKILL"); } catch {}
        done();
      };
      cleanupTimer = setTimeout(finish, 1500);
      if (process.platform !== "win32") {
        try { process.kill(-ownedPid, "SIGKILL"); } catch {}
        return finish();
      }
      const spec = windowsTaskkillCommand(env.SystemRoot, ownedPid);
      if (!spec) return finish();
      let killer;
      try {
        killer = spawn(spec.command, spec.args, {
          env: { SystemRoot: env.SystemRoot }, shell: false, windowsHide: true,
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch { return finish(); }
      const killerTimer = setTimeout(() => { try { killer.kill("SIGKILL"); } catch {}; finish(); }, 1000);
      killer.once("error", () => { clearTimeout(killerTimer); finish(); });
      killer.once("close", () => { clearTimeout(killerTimer); finish(); });
    };
    const removeSignalHandler = () => process.removeListener("SIGTERM", onTerminate);
    const onTerminate = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminateTree(() => process.exit(143));
    };
    const fail = (failure = "command") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeSignalHandler();
      terminateTree(() => reject(failure instanceof Error ? failure : new TokenError(failure)));
    };
    const authError = () => {
      let message = "";
      try { message = new TextDecoder("utf-8", { fatal: true }).decode(completion?.stderr || stderr).toLowerCase(); } catch {}
      return ["az login", "not logged in", "login required", "authentication required", "interaction_required", "interactionrequired", "invalid_grant", "aadsts50058", "aadsts50076", "aadsts50078", "aadsts50079", "aadsts50158"].some((marker) => message.includes(marker));
    };
    const validateOutput = (output) => {
      const validated = tokenFromAzureOutput(output);
      if (expectedIdentity && !sameIdentity(expectedIdentity, jwtIdentity(validated))) throw new Error();
      return validated;
    };
    const inspectWindowsCompletion = (final = false) => {
      if (!windowsSupervisor || settled) return;
      const parsed = parseWindowsAzureCompletion(stdout, stderr, final);
      if (parsed.state === "invalid") return fail();
      if (parsed.state !== "complete" || completion !== null) return;
      completion = parsed;
      if (parsed.stdout.length > MAX_AZ_OUTPUT_BYTES || parsed.stderr.length > MAX_AZ_OUTPUT_BYTES
          || parsed.code !== 0 || parsed.stderr.length !== 0 || parsed.stdout.length === 0) {
        return fail(authError() ? "auth" : "command");
      }
      try { token = validateOutput(parsed.stdout); } catch (error) { return fail(error); }
      released = true;
      try { child.stdin.end(); } catch { fail(); }
    };
    const timer = setTimeout(() => fail("timeout"), AZ_TIMEOUT_MS);
    process.once("SIGTERM", onTerminate);
    child.on("error", () => fail("launch"));
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
      if (stdout.length > (windowsSupervisor ? MAX_WINDOWS_PROTOCOL_BYTES : MAX_AZ_OUTPUT_BYTES)) return fail();
      inspectWindowsCompletion();
    });
    child.stderr.on("data", (chunk) => {
      if (settled) return;
      stderr = Buffer.concat([stderr, Buffer.from(chunk)]);
      if (stderr.length > (windowsSupervisor ? MAX_WINDOWS_PROTOCOL_BYTES : MAX_AZ_OUTPUT_BYTES)) return fail();
      inspectWindowsCompletion();
    });
    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      if (windowsSupervisor) {
        inspectWindowsCompletion(true);
        if (settled) return;
        if (completion === null || !released || code !== 0) return fail();
      } else if (code !== 0 || stderr.length !== 0 || stdout.length === 0) {
        return fail(authError() ? "auth" : "command");
      }
      if (!windowsSupervisor) {
        try { token = validateOutput(stdout); } catch (error) { return fail(error); }
      }
      settled = true;
      removeSignalHandler();
      resolve(token);
    });
  });
}

function tokenFromAzureOutput(output) {
  let token;
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output));
    token = parsed?.accessToken;
  } catch { throw new TokenError("output"); }
  if (!jwtIdentity(token)) throw new TokenError("output");
  return token;
}

async function acquireAzureToken(resource, expectedIdentity = null) {
  const commandSpec = azureCliCommand(process.platform, process.env, process.cwd(), resource);
  if (!commandSpec) throw new TokenError("unavailable");
  const childEnv = childEnvironment(commandSpec, process.platform, process.env, process.cwd());
  if (!childEnv) throw new TokenError("unavailable");
  return acquireToken(commandSpec, childEnv, expectedIdentity);
}

async function requestHeaders(expectedUrl) {
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
  const token = await acquireAzureToken(FABRIC_RESOURCE, launchIdentity);
  process.stdout.write(JSON.stringify({ Authorization: `Bearer ${token}` }));
}

async function main() {
  if (process.argv.length === 4 && process.argv[2] === "--token" && TOKEN_RESOURCES.has(process.argv[3])) {
    const token = await acquireAzureToken(process.argv[3]);
    process.stdout.write(`${TOKEN_FRAME}${Buffer.from(token, "ascii").toString("base64url")}\tend`);
    return;
  }
  const expectedUrl = process.argv[2];
  if (process.argv.length !== 3 || typeof expectedUrl !== "string" || !FABRIC_URL.test(expectedUrl)) throw new Error();
  await requestHeaders(expectedUrl);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    const exits = { unavailable: 20, launch: 21, timeout: 22, command: 23, output: 24, auth: 25 };
    process.exitCode = error instanceof TokenError ? exits[error.kind] || 1 : 1;
  });
}

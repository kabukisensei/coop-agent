import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseWindowsAzureCompletion,
  windowsAzureCliCandidates,
  windowsAzureCliCommand,
  windowsTaskkillCommand,
} from "../lib/fabric_request_headers.mjs";

const ROOT = fileURLToPath(new globalThis.URL("..", import.meta.url));
const HELPER = join(ROOT, "lib", "fabric_request_headers.mjs");
const ENDPOINT = "https://api.fabric.microsoft.com/v1/mcp/dataPlane/sqlEndpoint";
const TENANT = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "22222222-2222-4222-8222-222222222222";
const segment = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
const jwt = (claims, signature) => `${segment('{"alg":"none"}')}.${segment(claims)}.${segment(signature)}`;
const launch = jwt({ tid: TENANT, oid: PRINCIPAL }, "launch-canary");
const dir = mkdtempSync(join(tmpdir(), "coop fabric headers "));
const fakeAz = join(dir, process.platform === "win32" ? "az.cmd" : "az");
const fakeProgram = join(dir, "fake-az.cjs");
const counter = join(dir, "counter");
const envDump = join(dir, "child-env.json");
const marker = join(dir, "executed");
const delayedMarker = join(dir, "descendant-survived");
const baseEnvelope = { version: 1, method: "POST", url: ENDPOINT, bodyBase64: Buffer.from("{}").toString("base64") };
const quoted = (value) => JSON.stringify(value);

function installFake(mode) {
  const source = `#!${process.execPath}
const fs=require('node:fs');
const {spawn}=require('node:child_process');
fs.writeFileSync(${quoted(marker)},'yes');
fs.writeFileSync(${quoted(envDump)},JSON.stringify(process.env));
const mode=${quoted(mode)};
const seg=(v)=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url');
const jwt=(claims,sig)=>seg('{"alg":"none"}')+'.'+seg(claims)+'.'+seg(sig);
if(mode==='tree-stderr'||mode==='tree-oversize'||mode==='tree-nonzero'||mode==='tree-invalid') spawn(process.execPath,['-e',${quoted(`setTimeout(()=>require('node:fs').writeFileSync(${quoted(delayedMarker)},'survived'),2000);setTimeout(()=>{},20000)`)}],{stdio:'ignore'}).unref();
if(mode==='split-auth'){process.stderr.write('generic-prefix');setTimeout(()=>{process.stderr.write(' aadsts50076');process.exit(7)},25)}
else if(mode==='stderr'||mode==='tree-stderr'){process.stderr.write('child-diagnostic-canary');process.exit(0)}
else if(mode==='nonzero'||mode==='tree-nonzero') process.exit(7);
else if(mode==='timeout') setTimeout(()=>{},20000);
else if(mode==='oversize'||mode==='tree-oversize') process.stdout.write('x'.repeat(70000));
else if(mode==='invalid'||mode==='tree-invalid') process.stdout.write('{');
else if(mode==='invalid-token') process.stdout.write(JSON.stringify({accessToken:'not-a-jwt'}));
else if(mode==='invalid-utf8-token') process.stdout.write(JSON.stringify({accessToken:seg('{"alg":"none"}')+'.'+Buffer.from([0xc3,0x28]).toString('base64url')+'.'+seg('sig')}));
else {
 let n=0; try{n=Number(fs.readFileSync(${quoted(counter)},'utf8'))||0}catch{}; fs.writeFileSync(${quoted(counter)},String(n+1));
 const claims=mode==='mismatch'?{tid:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',oid:${quoted(PRINCIPAL)}}:{tid:${quoted(TENANT)},oid:${quoted(PRINCIPAL)}};
 let token=jwt(claims,'renewed-'+n);
 if(mode==='malformed-header') token='*'+token.slice(1);
 if(mode==='malformed-payload') token=token.replace('.', '.=');
 if(mode==='malformed-signature') token+='=';
 process.stdout.write(JSON.stringify({accessToken:token}));
}
`;
  writeFileSync(fakeProgram, source);
  if (process.platform === "win32") {
    writeFileSync(fakeAz, `@echo off\r\n"${process.execPath}" "${fakeProgram}" %*\r\nexit /b !ERRORLEVEL!\r\n`);
  } else {
    writeFileSync(fakeAz, source);
    chmodSync(fakeAz, 0o755);
  }
  rmSync(marker, { force: true });
  rmSync(delayedMarker, { force: true });
}

const run = (envelope = baseEnvelope, mode = "success", endpoint = ENDPOINT, token = launch, options = {}) => {
  installFake(mode);
  const env = {
    PATH: options.path || `${dir}${delimiter}${process.env.PATH || ""}`,
    HOME: process.env.HOME || tmpdir(),
    COOP_FABRIC_MCP_TOKEN: token,
    ARBITRARY_SECRET_CANARY: "must-not-reach-child",
  };
  if (process.platform === "win32") env.SystemRoot = process.env.SystemRoot;
  return spawnSync(process.execPath, [HELPER, endpoint], {
    input: typeof envelope === "string" ? envelope : JSON.stringify(envelope), encoding: "utf8", timeout: 12000,
    cwd: options.cwd || ROOT,
    env,
  });
};

const runToken = (resource = "https://api.fabric.microsoft.com", mode = "success", options = {}) => {
  installFake(mode);
  return spawnSync(process.execPath, [HELPER, "--token", resource, ...(options.extraArgs || [])], {
    encoding: "buffer", timeout: 12000, cwd: options.cwd || ROOT,
    env: {
      PATH: options.path || `${dir}${delimiter}${process.env.PATH || ""}`,
      HOME: process.env.HOME || tmpdir(),
      ARBITRARY_SECRET_CANARY: "must-not-reach-child",
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
    },
  });
};

try {
  const first = run();
  const second = run();
  const firstPhase = `executed=${Number(existsSync(marker))} counter=${Number(existsSync(counter))} stdout=${first.stdout.length} stderr=${first.stderr.length}`;
  assert.equal(first.status, 0, firstPhase); assert.equal(first.stderr, "");
  assert.equal(second.status, 0); assert.equal(second.stderr, "");
  const firstHeader = JSON.parse(first.stdout).Authorization;
  const secondHeader = JSON.parse(second.stdout).Authorization;
  assert.match(firstHeader, /^Bearer /); assert.notEqual(firstHeader, secondHeader);
  assert.equal(readFileSync(counter, "utf8"), "2");
  const actualChildEnv = JSON.parse(readFileSync(envDump, "utf8"));
  assert.equal(actualChildEnv.COOP_FABRIC_MCP_TOKEN, undefined);
  assert.equal(actualChildEnv.ARBITRARY_SECRET_CANARY, undefined);
  assert.deepEqual(Object.keys(actualChildEnv).filter((key) => key.includes("FAKE_AZ")), []);
  assert.ok(actualChildEnv.PATH.split(delimiter).every(isAbsolute), "child PATH is absolute");

  for (const resource of ["https://api.fabric.microsoft.com", "https://database.windows.net/"]) {
    const result = runToken(resource);
    assert.equal(result.status, 0); assert.equal(result.stderr.length, 0);
    const match = /^coop-azure-token-v1\t([A-Za-z0-9_-]+)\tend$/.exec(result.stdout.toString("ascii"));
    assert.ok(match, resource);
    assert.match(Buffer.from(match[1], "base64url").toString("ascii"), /^[!-~]+\.[!-~]+\.[!-~]+$/);
    const tokenChildEnv = JSON.parse(readFileSync(envDump, "utf8"));
    assert.equal(tokenChildEnv.ARBITRARY_SECRET_CANARY, undefined);
  }
  for (const [resource, extraArgs] of [
    ["https://evil.example", []],
    ["https://api.fabric.microsoft.com", ["extra"]],
  ]) {
    const result = runToken(resource, "success", { extraArgs });
    assert.notEqual(result.status, 0); assert.equal(result.stdout.length, 0); assert.equal(result.stderr.length, 0);
  }
  for (const mode of ["invalid", "invalid-token", "invalid-utf8-token", "stderr", "nonzero", "timeout", "oversize"]) {
    const result = runToken("https://api.fabric.microsoft.com", mode);
    assert.notEqual(result.status, 0, `token mode ${mode}`);
    assert.equal(result.stdout.length, 0, mode); assert.equal(result.stderr.length, 0, mode);
  }
  const splitAuth = runToken("https://api.fabric.microsoft.com", "split-auth");
  assert.equal(splitAuth.status, 25, "auth classification waits for complete stderr");
  assert.equal(splitAuth.stdout.length, 0); assert.equal(splitAuth.stderr.length, 0);
  for (const mode of ["tree-stderr", "tree-oversize", "tree-nonzero", "tree-invalid"]) {
    const result = runToken("https://api.fabric.microsoft.com", mode);
    assert.notEqual(result.status, 0, mode);
    await new Promise((resolveWait) => setTimeout(resolveWait, 2200));
    assert.equal(existsSync(delayedMarker), false, `${mode} Azure CLI descendant was not terminated`);
  }

  for (const [envelope, endpoint] of [
    ["not-json", ENDPOINT],
    [{ ...baseEnvelope, extra: true }, ENDPOINT],
    [{ ...baseEnvelope, version: 2 }, ENDPOINT],
    [{ ...baseEnvelope, method: "PUT" }, ENDPOINT],
    [{ ...baseEnvelope, bodyBase64: "%%%" }, ENDPOINT],
    [{ ...baseEnvelope, url: `${ENDPOINT}?x=1` }, ENDPOINT],
    [{ ...baseEnvelope, url: ENDPOINT.replace("https://", "http://") }, ENDPOINT],
    [{ ...baseEnvelope, url: ENDPOINT.replace("api.fabric.microsoft.com", "evil.example") }, ENDPOINT],
    [{ ...baseEnvelope, url: `${ENDPOINT}/redirect` }, ENDPOINT],
    [baseEnvelope, `${ENDPOINT}?configured=1`],
  ]) {
    const result = run(envelope, "success", endpoint);
    assert.notEqual(result.status, 0); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  }
  for (const mode of ["mismatch", "invalid", "invalid-token", "malformed-header", "malformed-payload", "malformed-signature", "stderr", "nonzero", "timeout", "oversize"]) {
    const result = run(baseEnvelope, mode);
    assert.notEqual(result.status, 0, mode);
    assert.equal(result.stdout, "", mode);
    assert.equal(result.stderr, "", mode);
    assert.equal(`${result.stdout}${result.stderr}`.includes("child-diagnostic-canary"), false);
  }
  for (const malformed of [
    `${segment('{"alg":"none"}')}.${Buffer.from([0xc3, 0x28]).toString("base64url")}.${segment("sig")}`,
    launch.replace(/^./, "*"),
    launch.replace(".", ".="),
    `${launch}=`,
  ]) {
    const result = run(baseEnvelope, "success", ENDPOINT, malformed);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(marker), false);
  }

  const hijack = mkdtempSync(join(ROOT, ".az-hijack-"));
  try {
    for (const name of ["az", "az.cmd", "az.bat"]) {
      const candidate = join(hijack, name);
      writeFileSync(candidate, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${quoted(marker)},'hijacked')\n`);
      chmodSync(candidate, 0o755);
    }
    rmSync(marker, { force: true });
    const result = run(baseEnvelope, "success", ENDPOINT, launch, { cwd: hijack, path: hijack });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(marker), false, "repo-local Azure CLI candidates never execute");
    const tokenResult = runToken("https://api.fabric.microsoft.com", "success", { cwd: hijack, path: hijack });
    assert.notEqual(tokenResult.status, 0);
    assert.equal(tokenResult.stdout.length, 0);
    assert.equal(existsSync(marker), false, "token mode also rejects repo-local Azure CLI candidates");
  } finally { rmSync(hijack, { recursive: true, force: true }); }

  const windows = windowsAzureCliCommand(
    "C:\\Windows\\System32\\cmd.exe",
    "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd",
  );
  assert.deepEqual(windows, {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/v:on", "/s", "/c", '"call "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd" account get-access-token --resource https://api.fabric.microsoft.com --output json & set "COOP_AZURE_RC=!ERRORLEVEL!" & echo COOP_AZURE_COMPLETE_V1:!COOP_AZURE_RC! & echo COOP_AZURE_STDERR_COMPLETE_V1 1>&2 & set /p "COOP_AZURE_RELEASE=" & exit /b !COOP_AZURE_RC!"'],
    windowsSupervisor: true,
  });
  const candidates = windowsAzureCliCandidates(["C:\\Earlier", "C:\\Later"]);
  assert.equal(candidates.find((candidate) => new Set(["C:\\Earlier\\az.exe", "C:\\Later\\az.cmd"]).has(candidate)), "C:\\Earlier\\az.exe");
  assert.equal(windowsAzureCliCommand("C:\\Windows\\System32\\cmd.exe", "C:\\unsafe&path\\az.cmd"), null);
  assert.equal(
    windowsAzureCliCommand("C:\\Windows\\System32\\cmd.exe", "C:\\Azure\\az.bat").windowsSupervisor,
    true,
  );
  assert.deepEqual(
    windowsAzureCliCommand("C:\\Windows\\System32\\cmd.exe", "C:\\Program Files\\Azure CLI\\az.exe"),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/v:on", "/s", "/c", '""C:\\Program Files\\Azure CLI\\az.exe" account get-access-token --resource https://api.fabric.microsoft.com --output json & set "COOP_AZURE_RC=!ERRORLEVEL!" & echo COOP_AZURE_COMPLETE_V1:!COOP_AZURE_RC! & echo COOP_AZURE_STDERR_COMPLETE_V1 1>&2 & set /p "COOP_AZURE_RELEASE=" & exit /b !COOP_AZURE_RC!"'],
      windowsSupervisor: true,
    },
  );
  assert.deepEqual(
    windowsAzureCliCommand("C:\\Windows\\System32\\cmd.exe", "C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd"),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/v:on", "/s", "/c", '"call "C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd" account get-access-token --resource https://api.fabric.microsoft.com --output json & set "COOP_AZURE_RC=!ERRORLEVEL!" & echo COOP_AZURE_COMPLETE_V1:!COOP_AZURE_RC! & echo COOP_AZURE_STDERR_COMPLETE_V1 1>&2 & set /p "COOP_AZURE_RELEASE=" & exit /b !COOP_AZURE_RC!"'],
      windowsSupervisor: true,
    },
  );
  const parsedCompletion = parseWindowsAzureCompletion(
    Buffer.from('{"accessToken":"fixture"}COOP_AZURE_COMPLETE_V1:7\r\n'),
    Buffer.from('diagnosticCOOP_AZURE_STDERR_COMPLETE_V1\r\n'),
    true,
  );
  assert.deepEqual(parsedCompletion, {
    state: "complete",
    code: 7,
    stdout: Buffer.from('{"accessToken":"fixture"}'),
    stderr: Buffer.from("diagnostic"),
  });
  for (const [stdout, stderr] of [
    [Buffer.from("json"), Buffer.from("diagnostic")],
    [Buffer.from("jsonCOOP_AZURE_COMPLETE_V1:nope\r\n"), Buffer.from("COOP_AZURE_STDERR_COMPLETE_V1\r\n")],
    [Buffer.from("COOP_AZURE_COMPLETE_V1:0\r\nCOOP_AZURE_COMPLETE_V1:0\r\n"), Buffer.from("COOP_AZURE_STDERR_COMPLETE_V1\r\n")],
    [Buffer.from("COOP_AZURE_COMPLETE_V1:0\r\ntrailing"), Buffer.from("COOP_AZURE_STDERR_COMPLETE_V1\r\n")],
    [Buffer.from("COOP_AZURE_COMPLETE_V1:0\r\n"), Buffer.from("COOP_AZURE_STDERR_COMPLETE_V1\r\nCOOP_AZURE_STDERR_COMPLETE_V1\r\n")],
  ]) assert.equal(parseWindowsAzureCompletion(stdout, stderr, true).state, "invalid");
  assert.deepEqual(windowsTaskkillCommand("C:\\Windows", 4242), {
    command: "C:\\Windows\\System32\\taskkill.exe",
    args: ["/PID", "4242", "/T", "/F"],
  });
  assert.equal(windowsTaskkillCommand("Windows", 4242), null);
  console.log("  ✓ Fabric request headers resolve Azure CLI safely and fail closed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

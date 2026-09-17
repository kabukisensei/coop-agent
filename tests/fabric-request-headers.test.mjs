import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { azureCliCommand } from "../lib/fabric_request_headers.mjs";

const ROOT = fileURLToPath(new globalThis.URL("..", import.meta.url));
const HELPER = join(ROOT, "lib", "fabric_request_headers.mjs");
const ENDPOINT = "https://api.fabric.microsoft.com/v1/mcp/dataPlane/sqlEndpoint";
const TENANT = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "22222222-2222-4222-8222-222222222222";
const jwt = (claims, signature) => `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
const launch = jwt({ tid: TENANT, oid: PRINCIPAL }, "launch-canary");
const dir = mkdtempSync(join(tmpdir(), "coop-fabric-headers-"));
const fakeAz = join(dir, "az");
const counter = join(dir, "counter");
writeFileSync(fakeAz, `#!/usr/bin/env node
const fs=require('node:fs');
if(process.env.COOP_FABRIC_MCP_TOKEN) process.exit(90);
const mode=process.env.FAKE_AZ_MODE||'success';
const jwt=(claims,sig)=>Buffer.from('{"alg":"none"}').toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.'+sig;
if(mode==='stderr'){process.stderr.write('child-diagnostic-canary');process.exit(0)}
if(mode==='nonzero') process.exit(7);
if(mode==='timeout') setTimeout(()=>{},20000);
else if(mode==='oversize') process.stdout.write('x'.repeat(70000));
else if(mode==='invalid') process.stdout.write('{');
else if(mode==='invalid-token') process.stdout.write(JSON.stringify({accessToken:'not-a-jwt'}));
else {
 let n=0; try{n=Number(fs.readFileSync(process.env.FAKE_AZ_COUNTER,'utf8'))||0}catch{}; fs.writeFileSync(process.env.FAKE_AZ_COUNTER,String(n+1));
 const claims=mode==='mismatch'?{tid:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',oid:'${PRINCIPAL}'}:{tid:'${TENANT}',oid:'${PRINCIPAL}'};
 process.stdout.write(JSON.stringify({accessToken:jwt(claims,'renewed-'+n)}));
}
`);
chmodSync(fakeAz, 0o755);
const baseEnvelope = { version: 1, method: "POST", url: ENDPOINT, bodyBase64: Buffer.from("{}").toString("base64") };
const run = (envelope = baseEnvelope, mode = "success", endpoint = ENDPOINT) => spawnSync(process.execPath, [HELPER, endpoint], {
  input: typeof envelope === "string" ? envelope : JSON.stringify(envelope), encoding: "utf8", timeout: 12000,
  env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH || ""}`, COOP_FABRIC_MCP_TOKEN: launch, FAKE_AZ_MODE: mode, FAKE_AZ_COUNTER: counter },
});

const first = run();
const second = run();
assert.equal(first.status, 0); assert.equal(first.stderr, "");
assert.equal(second.status, 0); assert.equal(second.stderr, "");
const firstHeader = JSON.parse(first.stdout).Authorization;
const secondHeader = JSON.parse(second.stdout).Authorization;
assert.match(firstHeader, /^Bearer /); assert.notEqual(firstHeader, secondHeader);
assert.equal(readFileSync(counter, "utf8"), "2");

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
for (const mode of ["mismatch", "invalid", "invalid-token", "stderr", "nonzero", "timeout", "oversize"]) {
  const result = run(baseEnvelope, mode);
  assert.notEqual(result.status, 0, mode);
  assert.equal(result.stdout, "", mode);
  assert.equal(result.stderr, "", mode);
  assert.equal(`${result.stdout}${result.stderr}`.includes("child-diagnostic-canary"), false);
}
const windows = azureCliCommand("win32", { COMSPEC: "C:\\Windows\\System32\\cmd.exe" });
assert.deepEqual(windows, { command: "C:\\Windows\\System32\\cmd.exe", args: ["/d", "/c", "az", "account", "get-access-token", "--resource", "https://api.fabric.microsoft.com", "--output", "json"] });
assert.deepEqual(azureCliCommand("linux", {}), { command: "az", args: ["account", "get-access-token", "--resource", "https://api.fabric.microsoft.com", "--output", "json"] });
console.log("  ✓ Fabric request headers renew offline and fail closed");

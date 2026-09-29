// Shared fake Azure CLI for the H2 sign-in fixtures: tests/azcache.test.sh,
// tests/fixtures/azcache.test.ps1, tests/doctor.test.sh and
// tests/azure-auth.test.py, and for the H2b tenant-pinned mints:
// tests/fabric-request-headers.test.mjs, tests/warehouse-mcp.test.py and
// tests/fabric-sql-query.test.py. It never contacts Azure. Tests wrap it per OS:
//   POSIX:   az      = #!/bin/sh + exec "<node>" "<this file>" "$@"
//   Windows: az.cmd  = @"<node>" "<this file>" %*
// The token helper passes az only an allowlisted environment, so the H2b
// wrappers set COOP_TEST_AZ_STATE themselves.
// State lives in the directory named by COOP_TEST_AZ_STATE:
//   tokens    lines "TENANT RESOURCE" or "TENANT *": tokens az can mint
//   default-tenant  the tenant of az's default account: a get-access-token
//             without --tenant mints for it (a guest's home tenant)
//   With --output json, get-access-token prints {"accessToken": <JWT>} whose tid
//   is the tenant it minted for and whose oid is PRINCIPAL below.
//   login-rc  exit code for `az login` (default 0); success adds "TENANT *";
//             "hang" never finishes the sign-in (see hang below)
//   mode      optional probe behavior: "term" ends the probe the way the
//             launch watchdog does (killed by SIGTERM, or exit 143 on
//             Windows, where a signal cannot be sent to itself);
//             "error" fails with a non-authentication error; "hang" never
//             answers (see hang below)
//   hang.pid  written by a hanging call: its pid, so a test can check that the
//             watchdog ended it. A hanging call exits by itself after 20 s and
//             then writes hang.expired, so a test can tell "stopped" from "ran out".
//   argv.log  one line per call; login lines end with " LXV2=<value>" (the
//             AZURE_CORE_LOGIN_EXPERIENCE_V2 the call saw)
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.COOP_TEST_AZ_STATE;
if (!dir) {
  process.stderr.write("fake az: COOP_TEST_AZ_STATE is not set\n");
  process.exit(90);
}
const args = process.argv.slice(2);
const read = (name) => {
  try { return readFileSync(join(dir, name), "utf8").trim(); } catch { return ""; }
};
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : "";
};
const lxv2 = process.env.AZURE_CORE_LOGIN_EXPERIENCE_V2 ?? "";
appendFileSync(join(dir, "argv.log"), args.join(" ") + (args[0] === "login" ? ` LXV2=${lxv2}` : "") + "\n");

const tenant = option("--tenant");
const json = option("--output") === "json";
const PRINCIPAL = "0a0a0a0a-0a0a-40a0-80a0-0a0a0a0a0a0a";
const segment = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (tid) => `${segment({ alg: "none" })}.${segment({ tid, oid: PRINCIPAL })}.${segment("fake-az")}`;
const hang = () => {
  writeFileSync(join(dir, "hang.pid"), String(process.pid));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
  // Reaching here means nothing stopped this call: tests assert this is absent.
  writeFileSync(join(dir, "hang.expired"), "");
  process.exit(98);
};

if (args[0] === "account" && args[1] === "get-access-token") {
  const mode = read("mode");
  if (mode === "term") {
    if (process.platform === "win32") process.exit(143);
    process.kill(process.pid, "SIGTERM");
    // The signal ends the process; never fall through to a normal exit code.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
    process.exit(97);
  }
  if (mode === "hang") hang();
  if (mode === "error") {
    process.stderr.write("ERROR: HTTPSConnectionPool: connection reset by proxy\n");
    process.exit(1);
  }
  const resource = option("--resource");
  const minted = tenant || read("default-tenant");
  const tokens = read("tokens").split(/\r?\n/).map((line) => line.trim());
  if (tokens.includes(`${minted} ${resource}`) || tokens.includes(`${minted} *`)) {
    if (json) process.stdout.write(JSON.stringify({ accessToken: jwt(minted) }) + "\n");
    process.exit(0);
  }
  process.stderr.write("ERROR: Please run 'az login' to setup account.\n");
  process.exit(1);
}

if (args[0] === "login") {
  if (read("login-rc") === "hang") hang();
  const rc = Number(read("login-rc") || "0");
  if (rc !== 0) {
    process.stderr.write("ERROR: fake sign-in was cancelled\n");
    process.exit(rc);
  }
  const signedIn = tenant || "tenant-on-path";
  appendFileSync(join(dir, "tokens"), `${signedIn} *\n`);
  if (json) process.stdout.write(JSON.stringify([{ tenantId: signedIn, name: "Fake Tenant" }]) + "\n");
  process.exit(0);
}

if (args[0] === "account" && args[1] === "show") {
  process.stdout.write(JSON.stringify({ tenantId: "tenant-on-path", name: "Fake Tenant" }) + "\n");
  process.exit(0);
}

if (args[0] === "account" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{ tenantId: "tenant-on-path", name: "Fake Tenant" }]) + "\n");
  process.exit(0);
}

process.stderr.write(`fake az: unsupported command: ${args.join(" ")}\n`);
process.exit(2);

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
const sourceRoot = process.env.COOP_ROOT;
assert.ok(dist && sourceRoot, "COOP_TEST_DIST and COOP_ROOT are required");
const mod = await import(pathToFileURL(join(dist, "coop-tools.mjs")).href);

const windowsRoot = String.raw`C:\Program Files\Coop Agent`;
const windows = mod.fabricSqlPythonResolverInvocation(windowsRoot, "win32");
assert.equal(windows.bin, "powershell.exe");
assert.equal(windows.env.COOP_ROOT, windowsRoot);
assert.ok(windows.args.includes("-NoProfile") && windows.args.includes("-Command"));
const windowsCommand = windows.args.at(-1);
assert.match(windowsCommand, /Join-Path \$env:COOP_ROOT/);
assert.ok(!windowsCommand.includes(windowsRoot), "dynamic paths must not enter PowerShell command text");
assert.ok(!windowsCommand.includes("$args["), "Windows PowerShell 5.1 binding must not depend on $args indexing");

const direct = mod.fabricSqlHelperInvocation("/tmp/Python With Spaces/python3", "/tmp/Coop Root");
assert.deepEqual(direct, {
  bin: "/tmp/Python With Spaces/python3",
  args: [join("/tmp/Coop Root", "lib", "fabric_sql_query.py")],
});

const root = mkdtempSync(join(tmpdir(), "coop sql launcher spaces "));
const fakePython = join(root, "Python Runtime", "python3");
const helperPath = join(root, "lib", "fabric_sql_query.py");
const marker = join(root, "helper-invoked");
mkdirSync(join(root, "lib"), { recursive: true });
mkdirSync(join(root, "Python Runtime"), { recursive: true });
cpSync(join(sourceRoot, "lib", "common.sh"), join(root, "lib", "common.sh"));
cpSync(join(sourceRoot, "lib", "common.ps1"), join(root, "lib", "common.ps1"));
writeFileSync(helperPath, `import os, sys
sys.stdin.read()
open(os.environ["COOP_SQL_TEST_MARKER"], "a").close()
print('{"ok":true,"state":"ok","row_count":0,"rows":[],"columns":[],"truncated":false}')
`);
writeFileSync(fakePython, `#!/bin/sh
touch "$COOP_SQL_TEST_MARKER"
cat >/dev/null
printf '%s' '{"ok":true,"state":"ok","row_count":0,"rows":[],"columns":[],"truncated":false}'
`);
chmodSync(fakePython, 0o755);

// PowerShell 7 is only a local syntax/binding check; native Windows CI remains
// the evidence for Windows PowerShell 5.1. The command uses no pwsh-only flags.
const psBinding = mod.fabricSqlPythonResolverInvocation(root, "win32");
let psFakePython = fakePython;
if (process.platform === "win32") {
  const lookup = spawnSync("where.exe", ["python"], { encoding: "utf8" });
  psFakePython = lookup.stdout?.split(/\r?\n/).find((candidate) => candidate.toLowerCase().endsWith(".exe") && !candidate.toLowerCase().includes("\\windowsapps\\"));
  assert.ok(psFakePython, "native Windows Python is required by this fixture");
}
const pwsh = spawnSync("pwsh", psBinding.args, {
  encoding: "utf8",
  env: { ...process.env, ...psBinding.env, COOP_FABRIC_PYTHON: psFakePython },
});
if (!pwsh.error || pwsh.error.code !== "ENOENT") {
  assert.equal(pwsh.status, 0, pwsh.stderr);
  assert.equal(pwsh.stdout.trim(), psFakePython);
}

const tools = new Map();
const pi = {
  on() {},
  registerTool(tool) { tools.set(tool.name, tool); },
  registerCommand() {},
  sendUserMessage() {},
  exec() { throw new Error("unexpected pi.exec"); },
};
mod.default(pi);
const tool = tools.get("fabric_sql_query");
assert.ok(tool, "fabric_sql_query must be publicly registered");
assert.match(tool.description, /First attempt the managed fabric-sqlendpoint MCP tool/);
assert.match(tool.description, /only after that actual attempt fails/);
assert.match(tool.description, /Never use it for SQL\/business\/query rejection/);
assert.match(tool.promptGuidelines.join(" "), /never fallback before MCP/);
assert.match(tool.promptGuidelines.join(" "), /never cascade automatically/);
const oldRoot = process.env.COOP_ROOT;
const oldPython = process.env.COOP_FABRIC_PYTHON;
const oldMarker = process.env.COOP_SQL_TEST_MARKER;
try {
  process.env.COOP_ROOT = root;
  process.env.COOP_FABRIC_PYTHON = process.platform === "win32" ? psFakePython : fakePython;
  process.env.COOP_SQL_TEST_MARKER = marker;
  const result = await tool.execute("1", { query: "SELECT TOP (1) x FROM dbo.t" }, undefined, undefined, { cwd: root });
  assert.equal(result.details.state, "ok");
  assert.equal(result.details.row_count, 0);
  assert.equal(existsSync(marker), true);

  rmSync(marker);
  const preAborted = new AbortController();
  preAborted.abort();
  const abortedBeforeSpawn = await tool.execute("2", { query: "SELECT TOP (1) x FROM dbo.t" }, preAborted.signal, undefined, { cwd: root });
  assert.deepEqual(abortedBeforeSpawn.details, { ok: false, state: "aborted" });
  assert.equal(existsSync(marker), false, "pre-aborted calls must not start the resolver or helper");

  if (process.platform === "win32") writeFileSync(helperPath, "import time\ntime.sleep(60)\n");
  else writeFileSync(fakePython, `#!/bin/sh
trap '' TERM
cat >/dev/null
while :; do :; done
`);
  chmodSync(fakePython, 0o755);
  const controller = new AbortController();
  const started = Date.now();
  const pending = tool.execute("3", { query: "SELECT TOP (1) x FROM dbo.t" }, controller.signal, undefined, { cwd: root });
  setTimeout(() => controller.abort(), 100);
  const cancelled = await pending;
  assert.equal(cancelled.details.state, "aborted");
  assert.ok(Date.now() - started < 2_000, "cancel must force-kill and reap within a bounded deadline");
} finally {
  // The abort case above intentionally leaves a TERM-ignoring busy-loop stub.
  // The tool force-kills its direct child within the bounded deadline, but the
  // resolver's probe grandchild (`sh "<root>/Python Runtime/python3" -c ...`)
  // can be orphaned mid-loop and spin at 100% CPU forever (real incident:
  // orphaned fixtures kept this VPS at load ~13 and load-flaked unrelated
  // timing tests). Reap anything under the unique fixture root before
  // removing it.
  if (process.platform !== "win32") {
    spawnSync("pkill", ["-9", "-f", root], { stdio: "ignore" });
  }
  if (oldRoot === undefined) delete process.env.COOP_ROOT; else process.env.COOP_ROOT = oldRoot;
  if (oldPython === undefined) delete process.env.COOP_FABRIC_PYTHON; else process.env.COOP_FABRIC_PYTHON = oldPython;
  if (oldMarker === undefined) delete process.env.COOP_SQL_TEST_MARKER; else process.env.COOP_SQL_TEST_MARKER = oldMarker;
  rmSync(root, { recursive: true, force: true });
}

console.log("fabric SQL launcher tests passed");

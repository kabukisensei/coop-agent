import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { managedRuntimeBuildPlan } from "../scripts/managed-runtime-build-plan.mjs";
import { preparationCommands } from "../scripts/prepare-managed-runtime.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let count = 0;
async function test(name, fn) { await fn(); count += 1; console.log(`  ✓ ${name}`); }

await test("preparation invokes the pinned Node npm CLI without a shell or global install", () => {
  const plan = managedRuntimeBuildPlan("darwin-arm64");
  const paths = { work: "/safe/work", output: "/safe/output", nodeRoot: "/safe/node", npmPrefix: "/safe/npm", pythonRoot: "/safe/python" };
  const commands = preparationCommands(plan, paths);
  assert.equal(commands.npm.command, "/safe/node/bin/node");
  assert.equal(commands.npm.args[0], "/safe/node/lib/node_modules/npm/bin/npm-cli.js");
  assert.equal(commands.npm.args.includes("--global"), false);
  assert.equal(commands.npm.args.includes("--prefix"), true);
  assert.deepEqual(commands.npm.args.slice(-plan.npmSpecs.length), [...plan.npmSpecs]);
});

await test("each Python pin gets an isolated package root driven by the bundled relocatable interpreter", () => {
  const plan = managedRuntimeBuildPlan("darwin-arm64");
  const paths = { work: "/safe/work", output: "/safe/output", nodeRoot: "/safe/node", npmPrefix: "/safe/npm", pythonRoot: "/safe/python" };
  const commands = preparationCommands(plan, paths);
  assert.equal(commands.python.command, "/safe/python/bin/python3");
  assert.equal(commands.pythonTools.length, plan.pipSpecs.length);
  assert.equal(new Set(commands.pythonTools.map(({ root }) => root)).size, plan.pipSpecs.length);
  assert.equal(commands.pythonTools.every(({ command, args }) => command === commands.python.command && args.includes("--target") && !args.includes("venv")), true);
  assert.equal(commands.stage.command, process.execPath);
  assert.equal(commands.stage.args[0], join(ROOT, "scripts", "stage-managed-runtime.mjs"));
  assert.equal(commands.stage.args.filter((value) => value === "--python-tool").length, plan.pipSpecs.length);
  assert.equal(commands.stage.args.includes("--python-root"), true);
  assert.equal(commands.stage.args.includes("--python-env"), false);
});

await test("macOS acquisition omits the Windows-only Power BI Desktop bridge", () => {
  const plan = managedRuntimeBuildPlan("darwin-x64");
  assert.equal(plan.npmSpecs.some((value) => value.startsWith("@microsoft/powerbi-desktop-bridge-cli@")), false);
});

await test("Windows preparation uses only target-bundled Node and Python executables", () => {
  const plan = managedRuntimeBuildPlan("win32-x64");
  const paths = { work: "C:\\safe\\work", output: "C:\\safe\\output", nodeRoot: "C:\\safe\\node", npmPrefix: "C:\\safe\\npm", pythonRoot: "C:\\safe\\python" };
  const commands = preparationCommands(plan, paths);
  assert.match(commands.npm.command, /node\.exe$/);
  assert.match(commands.python.command, /python\.exe$/);
  assert.equal(commands.npm.args.some((value) => value.startsWith("@microsoft/powerbi-desktop-bridge-cli@")), true);
});



await test("missing integrity is recorded only after full archive comparison, with no partial writes", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { createRequire } = await import("node:module");
  const { createHash } = await import("node:crypto");
  const { completeNpmIntegrity } = await import("../scripts/complete-npm-integrity.mjs");
  const nodeDir = dirname(realpathSync(process.execPath));
  const npmCli = [process.env.npm_execpath,
    join(nodeDir, "../lib/node_modules/npm/bin/npm-cli.js"),
    join(nodeDir, "node_modules/npm/bin/npm-cli.js"),
    "/usr/share/nodejs/npm/bin/npm-cli.js",
  ].find(path => path && existsSync(path));
  assert.ok(npmCli, "Tests require the npm installation that supplies npx.");
  const tar = createRequire(npmCli)("tar");
  const base = mkdtempSync(join(tmpdir(), "coop-integrity-"));
  try {
    const npmPrefix = join(base, "npm");
    const root = join(npmPrefix, "node_modules/example");
    const archiveRoot = join(base, "archive");
    mkdirSync(root, { recursive: true });
    mkdirSync(join(archiveRoot, "package"), { recursive: true });
    for (const dir of [root, join(archiveRoot, "package")]) {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
      writeFileSync(join(dir, "index.js"), "export const value = 1;\n");
    }
    const bytes = tar.c({ sync: true, gzip: true, cwd: archiveRoot }, ["package"]).read();
    const lockPath = join(npmPrefix, "node_modules/.package-lock.json");
    const lock = { lockfileVersion: 3, packages: { "node_modules/example": { version: "1.0.0", resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz" } } };
    const original = JSON.stringify(lock);
    const reset = () => writeFileSync(lockPath, original);
    const run = () => completeNpmIntegrity({ npmPrefix, npmCli, fetchArchive: async () => bytes });
    reset();
    assert.deepEqual(await run(), { completed: 1 });
    assert.equal(JSON.parse(readFileSync(lockPath)).packages["node_modules/example"].integrity,
      `sha512-${createHash("sha512").update(bytes).digest("base64")}`);
    assert.deepEqual(await run(), { completed: 0 });
    reset();
    writeFileSync(join(root, "index.js"), "modified");
    await assert.rejects(run, /differs from/);
    assert.equal(readFileSync(lockPath, "utf8"), original);
    writeFileSync(join(root, "index.js"), "export const value = 1;\n");
    writeFileSync(join(root, "extra.js"), "extra");
    await assert.rejects(run, /differs from/);
    rmSync(join(root, "extra.js"));
    lock.packages["node_modules/missing"] = { version: "1.0.0", resolved: "https://registry.npmjs.org/missing.tgz" };
    const partial = JSON.stringify(lock);
    writeFileSync(lockPath, partial);
    await assert.rejects(run);
    assert.equal(readFileSync(lockPath, "utf8"), partial, "failure after one match must not publish any changes");
    reset();
    await assert.rejects(() => completeNpmIntegrity({ npmPrefix, npmCli, fetchArchive: async () => Buffer.from("not tar") }));
    assert.equal(readFileSync(lockPath, "utf8"), original);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

await test("development wheels authenticate snapshots, retain exact pins, and bind installed provenance", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { createHash } = await import("node:crypto");
  const { snapshotDevelopmentWheels, recordDevelopmentSource, readDevelopmentSource, validateDevelopmentSource } = await import("../desktop/src/development-wheels.mjs");
  const { buildDependencyInventory, validateDependencyInventory } = await import("../desktop/src/dependency-inventory.mjs");
  const base = mkdtempSync(join(tmpdir(), "coop-development-wheel-"));
  try {
    const plan = managedRuntimeBuildPlan("win32-x64"), version = plan.pipSpecs.find(spec => spec.startsWith("coop-data-doc==")).split("==")[1];
    const source = { name: "coop-data-doc", version, file: `coop_data_doc-${version}-py3-none-any.whl`, sha256: createHash("sha256").update("wheel bytes").digest("hex"), repository: "https://github.com/kabukisensei/coop-data-doc.git", revision: "a".repeat(40) };
    const manifest = join(base, "development-wheels.json");
    const writeManifest = wheels => writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, wheels }));
    writeManifest([source]); writeFileSync(join(base, source.file), "wheel bytes");
    const development = snapshotDevelopmentWheels(manifest, join(base, "snapshot with spaces"), plan.pipSpecs);
    writeFileSync(join(base, source.file), "changed original");
    assert.equal(readFileSync(join(base, "snapshot with spaces", source.file), "utf8"), "wheel bytes");
    assert.match(development[source.name].spec, /%20.*#sha256=/);
    const paths = { work: base, output: join(base, "out"), nodeRoot: base, npmPrefix: base, pythonRoot: base };
    const command = preparationCommands(plan, paths, development).pythonTools.find(tool => tool.name === source.name);
    assert.deepEqual(command.args.slice(-2), [`${source.name}==${version}`, development[source.name].spec]);
    assert.throws(() => snapshotDevelopmentWheels(manifest, join(base, "bad-hash"), plan.pipSpecs), /provenance/);
    writeManifest([source, source]);
    assert.throws(() => snapshotDevelopmentWheels(manifest, join(base, "duplicate"), plan.pipSpecs), /provenance/);
    writeManifest([source]);
    assert.throws(() => snapshotDevelopmentWheels(manifest, join(base, "wrong-pin"), []), /provenance/);
    for (const change of [{ file: "../outside.whl" }, { revision: "main" }, { name: "untrusted" }, { repository: "https://example.test/repo.git" }, { extra: true }]) assert.throws(() => validateDevelopmentSource({ ...source, ...change }), /provenance/);
    const installed = join(base, "installed"), info = join(installed, `coop_data_doc-${version}.dist-info`);
    mkdirSync(info, { recursive: true });
    writeFileSync(join(info, "METADATA"), `Name: coop-data-doc\nVersion: ${version}\n`);
    const receipt = hash => writeFileSync(join(info, "direct_url.json"), JSON.stringify({ archive_info: { hashes: { sha256: hash } } }));
    receipt("b".repeat(64)); assert.throws(() => recordDevelopmentSource(installed, source), /provenance/);
    receipt(source.sha256); recordDevelopmentSource(installed, source);
    assert.deepEqual(readDevelopmentSource(installed), source);
    const npm = join(base, "npm"); mkdirSync(join(npm, "node_modules"), { recursive: true });
    writeFileSync(join(npm, "node_modules/.package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
    const target = { platform: "win32", arch: "x64" };
    const inventory = buildDependencyInventory({ npmPrefix: npm, pythonTools: [{ name: source.name, root: installed }], target });
    validateDependencyInventory(inventory, target);
    assert.deepEqual(inventory.python.tools[0].developmentSource, source);
    const altered = structuredClone(inventory); altered.python.tools[0].developmentSource.version = "9.9.9";
    assert.throws(() => validateDependencyInventory(altered, target));
    receipt("b".repeat(64)); assert.throws(() => buildDependencyInventory({ npmPrefix: npm, pythonTools: [{ name: source.name, root: installed }], target }), /provenance/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

console.log(`prepare managed runtime: ${count} tests passed`);

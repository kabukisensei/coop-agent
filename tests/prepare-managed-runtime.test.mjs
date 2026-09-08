import { loadManagedPythonLock, writeManagedPythonInputs, verifyManagedPythonInstallation } from "../scripts/managed-python-lock.mjs";
import { loadManagedNpmLock, writeManagedNpmInputs, verifyManagedNpmResolution } from "../scripts/managed-npm-lock.mjs";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { managedRuntimeBuildPlan } from "../scripts/managed-runtime-build-plan.mjs";
import { archiveExtractor, preparationCommands } from "../scripts/prepare-managed-runtime.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let count = 0;
async function test(name, fn) { await fn(); count += 1; console.log(`  ✓ ${name}`); }

await test("Windows acquisition selects the system ZIP-capable tar independently of PATH", () => {
  assert.equal(archiveExtractor({ platform: "win32", systemRoot: "D:\\Windows" }), "D:\\Windows\\System32\\tar.exe");
  assert.equal(archiveExtractor({ platform: "win32", systemRoot: "C:/Windows" }), "C:\\Windows\\System32\\tar.exe");
  assert.equal(archiveExtractor({ platform: "darwin", systemRoot: "" }), "tar");
  for (const systemRoot of ["", "relative", "C:\\Windows\nother"]) {
    assert.throws(() => archiveExtractor({ platform: "win32", systemRoot }), /SystemRoot/);
  }
});

await test("preparation invokes the pinned Node npm CLI without a shell or global install", () => {
  const plan = managedRuntimeBuildPlan("darwin-arm64");
  const paths = { work: "/safe/work", output: "/safe/output", nodeRoot: "/safe/node", npmPrefix: "/safe/npm", pythonRoot: "/safe/python" };
  const commands = preparationCommands(plan, paths);
  assert.equal(commands.npm.command, join(paths.nodeRoot, "bin/node"));
  assert.equal(commands.npm.args[0], join(paths.nodeRoot, "lib/node_modules/npm/bin/npm-cli.js"));
  assert.equal(commands.npm.args.includes("--global"), false);
  assert.equal(commands.npm.args.includes("--prefix"), true);
  assert.equal(commands.npm.args[1], "ci", "fresh preparation must consume a fixed resolution");
  assert.equal(commands.npm.args.includes("--no-save"), false);
});

await test("each Python pin gets an isolated package root driven by the bundled relocatable interpreter", () => {
  const plan = managedRuntimeBuildPlan("darwin-arm64");
  const paths = { work: "/safe/work", output: "/safe/output", nodeRoot: "/safe/node", npmPrefix: "/safe/npm", pythonRoot: "/safe/python" };
  const commands = preparationCommands(plan, paths);
  assert.equal(commands.python.command, join(paths.pythonRoot, "bin/python3"));
  assert.equal(commands.pythonTools.length, plan.pipSpecs.length);
  assert.equal(new Set(commands.pythonTools.map(({ root }) => root)).size, plan.pipSpecs.length);
  assert.equal(commands.pythonTools.every(tool => tool.args.includes("--require-hashes")), true, "Python acquisition must require locked hashes");
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
  assert.equal(plan.npmSpecs.includes("@microsoft/powerbi-desktop-bridge-cli@0.1.2"), true);
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
    const resolution = loadManagedPythonLock(plan);
    writeManagedPythonInputs(base, resolution, development);
    const command = preparationCommands(plan, paths, resolution).pythonTools.find(tool => tool.name === source.name);
    assert.equal(command.args.includes("--require-hashes"), true);
    assert.equal(readFileSync(command.constraints, "utf8"), `${source.name}==${version}\n`);
    assert.ok(readFileSync(command.requirements, "utf8").includes(`${source.name} @ ${development[source.name].spec} --hash=sha256:${source.sha256}`));
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

await test("every managed target has a hashed resolution matching its release plan", () => {
  for (const target of ["darwin-arm64", "darwin-x64", "win32-x64"]) {
    const plan = managedRuntimeBuildPlan(target), result = loadManagedNpmLock(plan);
    assert.equal(result.sha256.length, 64);
    assert.ok(Object.keys(result.lock.packages).length > 500);
    assert.deepEqual(Object.entries(result.packageJson.dependencies).map(([name, version]) => `${name}@${version}`), [...plan.npmSpecs]);
  }
});

await test("managed npm locks reject manifest mismatch, unhashed archives and installed drift", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "coop-npm-lock-")), path = join(root, "lock.json");
  const entry = { version: "1.0.0", resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz", integrity: "sha512-YWJj" };
  const lock = { name: "coop-managed-runtime", version: "0.0.0", lockfileVersion: 3, packages: { "": { dependencies: { example: "1.0.0" } }, "node_modules/example": entry } };
  const plan = { target: "darwin-arm64", npmSpecs: ["example@1.0.0"] };
  const save = value => writeFileSync(path, JSON.stringify(value));
  try {
    save(lock);
    const result = loadManagedNpmLock(plan, path), prefix = join(root, "npm");
    writeManagedNpmInputs(prefix, result);
    assert.throws(() => writeManagedNpmInputs(prefix, result), /exist/i);
    mkdirSync(join(prefix, "node_modules"));
    const installedPath = join(prefix, "node_modules", ".package-lock.json");
    const installed = { lockfileVersion: 3, packages: { "node_modules/example": entry } };
    const writeInstalled = value => writeFileSync(installedPath, JSON.stringify(value));
    writeInstalled(installed);
    assert.equal(verifyManagedNpmResolution(prefix, result).packages, 1);
    for (const field of ["version", "resolved", "integrity"]) {
      const drift = structuredClone(installed); drift.packages["node_modules/example"][field] += "changed"; writeInstalled(drift);
      assert.throws(() => verifyManagedNpmResolution(prefix, result), /differs/);
    }
    writeInstalled({ ...installed, packages: {} });
    assert.throws(() => verifyManagedNpmResolution(prefix, result), /missing/);
    writeInstalled({ ...installed, packages: { ...installed.packages, "node_modules/extra": entry } });
    assert.throws(() => verifyManagedNpmResolution(prefix, result), /differs/);
    writeInstalled(installed); writeFileSync(join(prefix, "package-lock.json"), "{}");
    assert.throws(() => verifyManagedNpmResolution(prefix, result), /changed/);
    assert.throws(() => loadManagedNpmLock({ ...plan, npmSpecs: ["example@2.0.0"] }, path), /manifest/);
    for (const change of [{ integrity: null }, { resolved: "https://user:secret@example.test/pkg.tgz" }, { resolved: "file:///tmp/pkg.tgz" }, { link: true }]) {
      const bad = structuredClone(lock); Object.assign(bad.packages["node_modules/example"], change); save(bad);
      assert.throws(() => loadManagedNpmLock(plan, path), /invalid|unhashed/);
    }
    const bad = structuredClone(lock); bad.packages["node_modules/../escape"] = entry; save(bad);
    assert.throws(() => loadManagedNpmLock(plan, path), /invalid/);
    assert.ok(readFileSync(join(prefix, "package.json"), "utf8").includes('"private": true'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test("native npm payloads must exist in the lock and installed tree for their target", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "coop-native-lock-")), path = join(root, "lock.json");
  const entry = { version: "1.0.0", resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz", integrity: "sha512-YWJj" };
  const owner = { ...entry, optionalDependencies: { "example-win32-x64": "1.0.0", "example-darwin-x64": "1.0.0" } };
  const payload = { ...entry, optional: true, os: ["win32"], cpu: ["x64"] };
  const lock = { name: "coop-managed-runtime", version: "0.0.0", lockfileVersion: 3,
    packages: { "": { dependencies: { example: "1.0.0" } }, "node_modules/example": owner } };
  const plan = { target: "win32-x64", npmSpecs: ["example@1.0.0"] };
  const save = () => writeFileSync(path, JSON.stringify(lock));
  try {
    save(); assert.throws(() => loadManagedNpmLock(plan, path), /native dependency example-win32-x64 is missing/);
    // Nested resolution is valid; an optional package for another OS is not required.
    const nativePath = "node_modules/example/node_modules/example-win32-x64";
    lock.packages[nativePath] = payload; save();
    const resolution = loadManagedNpmLock(plan, path), prefix = join(root, "npm");
    writeManagedNpmInputs(prefix, resolution); mkdirSync(join(prefix, "node_modules"));
    const installed = { lockfileVersion: 3, packages: { "node_modules/example": owner } };
    const installedPath = join(prefix, "node_modules", ".package-lock.json");
    writeFileSync(installedPath, JSON.stringify(installed));
    assert.throws(() => verifyManagedNpmResolution(prefix, resolution), /required native dependency is missing/);
    installed.packages[nativePath] = payload; writeFileSync(installedPath, JSON.stringify(installed));
    assert.equal(verifyManagedNpmResolution(prefix, resolution).packages, 2);
    lock.packages[nativePath] = { ...payload, cpu: ["arm64"] }; save();
    assert.throws(() => loadManagedNpmLock(plan, path), /does not match/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await test("all Python targets lock the manifest tools and scope source builds explicitly", () => {
  for (const target of ["darwin-arm64", "darwin-x64", "win32-x64"]) {
    const plan = managedRuntimeBuildPlan(target), result = loadManagedPythonLock(plan);
    assert.equal(result.sha256.length, 64);
    assert.equal(result.lock.tools.length, plan.pipSpecs.length);
    assert.equal(result.lock.tools.flatMap(tool => tool.packages).length, 101);
    assert.deepEqual([...new Set(result.lock.tools.flatMap(tool => tool.sourceBuilds))], target === "darwin-x64" ? ["cryptography"] : []);
  }
});

await test("Python locks reconcile downloaded hashes and exact installed distributions", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "coop-python-lock-")), lockPath = join(root, "lock.json"), report = join(root, "report.json");
  const hash = "a".repeat(64);
  const tool = { name: "example", version: "1.0.0", sourceBuilds: [], packages: [{ name: "example", version: "1.0.0", sha256: [hash] }] };
  const lock = { schemaVersion: 1, target: "darwin-arm64", pythonVersion: "3.12.14", tools: [tool] };
  const plan = { target: lock.target, python: { version: lock.pythonVersion }, pipSpecs: ["example==1.0.0"] };
  const saveLock = value => writeFileSync(lockPath, JSON.stringify(value));
  const item = { metadata: { name: "example", version: "1.0.0" }, download_info: { url: "https://files.pythonhosted.org/example.whl", archive_info: { hashes: { sha256: hash } } } };
  const saveReport = install => writeFileSync(report, JSON.stringify({ version: "1", install }));
  const info = join(root, "example-1.0.0.dist-info"); mkdirSync(info);
  const metadata = version => writeFileSync(join(info, "METADATA"), `Name: example\nVersion: ${version}\n`);
  const verify = () => verifyManagedPythonInstallation({ root, report, tool });
  try {
    saveLock(lock); loadManagedPythonLock(plan, lockPath); saveReport([item]); metadata("1.0.0");
    assert.equal(verify().packages, 1);
    saveReport([]); assert.throws(verify, /package set differs/);
    saveReport([item, item]); assert.throws(verify, /differs/);
    for (const url of ["http://example.test/example.whl", "https://user:secret@example.test/example.whl", "https://example.test/example.tar.gz"]) {
      const bad = structuredClone(item); bad.download_info.url = url; saveReport([bad]); assert.throws(verify, /archive/);
    }
    const bad = structuredClone(item); bad.download_info.archive_info.hashes.sha256 = "b".repeat(64); saveReport([bad]); assert.throws(verify, /download differs/);
    saveReport([item]); metadata("2.0.0"); assert.throws(verify, /installed package differs/); metadata("1.0.0");
    const extra = join(root, "extra-1.0.0.dist-info"); mkdirSync(extra); writeFileSync(join(extra, "METADATA"), "Name: extra\nVersion: 1.0.0\n");
    assert.throws(verify, /installed package differs/); rmSync(extra, { recursive: true });
    assert.throws(() => loadManagedPythonLock({ ...plan, pipSpecs: ["example==2.0.0"] }, lockPath), /pins/);
    for (const alter of [value => { value.tools[0].packages[0].sha256 = []; }, value => { value.tools[0].packages.push(value.tools[0].packages[0]); }, value => { value.tools[0].sourceBuilds = ["example"]; }]) {
      const changed = structuredClone(lock); alter(changed); saveLock(changed); assert.throws(() => loadManagedPythonLock(plan, lockPath), /invalid|unexpected/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`prepare managed runtime: ${count} tests passed`);

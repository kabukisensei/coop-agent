import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packagedPaths } from "../desktop/scripts/verify-managed-package.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "desktop", "package.json"), "utf8"));
const workflow = readFileSync(join(ROOT, ".github", "workflows", "managed-desktop-smoke.yml"), "utf8");
const verifier = readFileSync(join(ROOT, "desktop", "scripts", "verify-managed-package.mjs"), "utf8");
let count = 0;
function test(name, fn) { fn(); count += 1; console.log(`  ✓ ${name}`); }

test("managed packages require ASAR integrity and deny dangerous Electron fuses", () => {
  assert.equal(pkg.build.asar, true);
  assert.equal(pkg.build.electronFuses.enableEmbeddedAsarIntegrityValidation, true);
  assert.equal(pkg.build.electronFuses.onlyLoadAppFromAsar, true);
  for (const key of ["runAsNode", "enableNodeOptionsEnvironmentVariable", "enableNodeCliInspectArguments", "grantFileProtocolExtraPrivileges"]) assert.equal(pkg.build.electronFuses[key], false);
  assert.match(verifier, /getCurrentFuseWire/);
  assert.match(verifier, /default_app\.asar/);
  assert.match(verifier, /inspectManagedRuntime/);
});

test("post-package verification runs on both native managed build workers", () => {
  assert.match(pkg.scripts["verify:managed-package"], /verify-managed-package\.mjs/);
  assert.match(workflow, /matrix:\s*\n\s*os: \[macos-latest, windows-latest\]/);
  assert.match(workflow, /npm run verify:managed-package --prefix desktop/);
});

test("platform paths select the fixed packaged binary and resource directory", () => {
  const mac = packagedPaths("/build", "darwin", "arm64");
  assert.equal(mac.fuseTarget, join("/build", "mac-arm64", "Coop Desktop.app"));
  assert.equal(mac.resources, join("/build", "mac-arm64", "Coop Desktop.app", "Contents", "Resources"));
  const windows = packagedPaths("C:\\build", "win32", "x64");
  assert.match(windows.fuseTarget, /win-unpacked[\\/]Coop Desktop\.exe$/);
  assert.match(windows.resources, /win-unpacked[\\/]resources$/);
  assert.throws(() => packagedPaths("/build", "linux", "x64"), /Unsupported/);
});

test("installers preserve managed boundaries and user data without publishing or automatic launch", () => {
  const base = mkdtempSync(join(tmpdir(), "coop-installer-config-"));
  try {
    for (const [platform, arch, target] of [["darwin", "arm64", "dmg"], ["win32", "x64", "nsis"]]) {
      const bundle = join(base, platform);
      mkdirSync(bundle);
      writeFileSync(join(bundle, "manifest.json"), JSON.stringify({ schemaVersion: 1, target: { platform, arch } }));
      const result = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(require('./desktop/electron-builder-installer.cjs')))"], {
        cwd: ROOT, env: { ...process.env, COOP_DESKTOP_MANAGED_RUNTIME_DIR: bundle }, encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      const config = JSON.parse(result.stdout);
      assert.deepEqual(config[platform === "darwin" ? "mac" : "win"].target, [{ target, arch: [arch] }]);
      assert.equal(config.appId, "com.cooptimize.coop.desktop");
      assert.deepEqual(config.electronFuses, pkg.build.electronFuses);
      assert.equal(config.asar, true);
      assert.equal(config.extraResources[0].to, "managed-runtime");
      assert.equal(config.nsis.deleteAppDataOnUninstall, false);
      assert.equal(config.nsis.runAfterFinish, false);
      assert.equal(config.nsis.perMachine, false);
      assert.equal(config.nsis.allowElevation, false);
      assert.ok(config.dmg.contents.some(item => item.type === "link" && item.path === "/Applications"));
    }
    assert.match(pkg.scripts["package:installer:mac"], /--publish never/);
    assert.match(pkg.scripts["package:installer:win"], /--publish never/);
    assert.match(pkg.scripts["package:managed:mac"], /--dir/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

console.log(`managed package security: ${count} tests passed`);

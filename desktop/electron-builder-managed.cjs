const { existsSync, readFileSync, mkdirSync, readdirSync, copyFileSync } = require("node:fs");
const { isAbsolute, resolve, join } = require("node:path");
const base = require("./package.json").build;

const input = process.env.COOP_DESKTOP_MANAGED_RUNTIME_DIR || "";
if (!input || !isAbsolute(input)) throw new Error("COOP_DESKTOP_MANAGED_RUNTIME_DIR must be an absolute staged bundle path.");
const managedRuntime = resolve(input);
if (!existsSync(`${managedRuntime}/manifest.json`)) throw new Error("Managed runtime manifest is missing.");
const manifest = JSON.parse(readFileSync(`${managedRuntime}/manifest.json`, "utf8"));
if (manifest.schemaVersion !== 1 || !["darwin", "win32"].includes(manifest.target?.platform) || !["arm64", "x64"].includes(manifest.target?.arch)) {
  throw new Error("Managed runtime manifest target is invalid.");
}
if (process.argv.includes("--mac") && manifest.target.platform !== "darwin") throw new Error("A macOS package requires a darwin managed runtime.");
if (process.argv.includes("--win") && manifest.target.platform !== "win32") throw new Error("A Windows package requires a win32 managed runtime.");

module.exports = {
  ...base,
  appId: "com.cooptimize.coop.desktop",
  productName: "Coop Desktop",
  directories: { ...base.directories, output: "dist-managed" },
  mac: { ...base.mac, target: [{ target: "dir", arch: [manifest.target.arch] }] },
  win: { ...base.win, target: [{ target: "dir", arch: [manifest.target.arch] }] },
  extraResources: [{ from: managedRuntime, to: "managed-runtime" }],
  // extraResources excludes its source matches from app.asar. These modules are
  // also imported by main, so copy a second helper closure after app packaging.
  afterPack: async context => {
    const resources = context.electronPlatformName === "darwin"
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : join(context.appOutDir, "resources");
    const destination = join(resources, "update-helper");
    mkdirSync(destination, { recursive: true });
    const shared = new Set(["managed-runtime.mjs", "coop-launcher.mjs", "dependency-inventory.mjs", "development-wheels.mjs", "runtime-supervisor.mjs"]);
    for (const name of readdirSync(join(__dirname, "src"))) {
      if ((name.startsWith("update-") && name.endsWith(".mjs")) || name === "update-windows-job.py" || shared.has(name)) copyFileSync(join(__dirname, "src", name), join(destination, name));
    }
  },
};

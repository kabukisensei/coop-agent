import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = new Set(["darwin-arm64", "darwin-x64", "win32-x64"]);
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[a-z0-9]+(?:[._-][a-z0-9]+)*)?$/i;
const normalize = name => typeof name === "string" ? name.toLowerCase().replace(/[-_.]+/g, "-") : "";
const fail = message => { throw new Error(`Managed Python resolution: ${message}`); };
const exactKeys = (value, keys) => value && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.sort());

export function loadManagedPythonLock(plan, path) {
  if (!TARGETS.has(plan.target)) fail("unsupported target.");
  const bytes = readFileSync(path || join(ROOT, "config", "managed-python", `${plan.target}.json`));
  const lock = JSON.parse(bytes);
  if (!exactKeys(lock, ["schemaVersion", "target", "pythonVersion", "tools"]) || lock.schemaVersion !== 1 ||
      lock.target !== plan.target || lock.pythonVersion !== plan.python.version || !Array.isArray(lock.tools)) fail("incompatible lock.");
  const pins = new Map(plan.pipSpecs.map(spec => spec.split("==")));
  if (lock.tools.length !== pins.size) fail("tool set differs from the release manifest.");
  const seenTools = new Set();
  for (const tool of lock.tools) {
    if (!exactKeys(tool, ["name", "version", "sourceBuilds", "packages"]) || seenTools.has(tool.name) || pins.get(tool.name) !== tool.version ||
        !Array.isArray(tool.packages) || !tool.packages.length || !Array.isArray(tool.sourceBuilds)) fail("tool pins differ from the release manifest.");
    seenTools.add(tool.name);
    const names = new Set();
    for (const entry of tool.packages) {
      if (!exactKeys(entry, ["name", "version", "sha256"]) || !NAME.test(entry.name) || !VERSION.test(entry.version) || names.has(entry.name) ||
          !Array.isArray(entry.sha256) || !entry.sha256.length || new Set(entry.sha256).size !== entry.sha256.length ||
          entry.sha256.some(hash => !/^[a-f0-9]{64}$/.test(hash))) fail(`invalid package or hash in ${tool.name}.`);
      names.add(entry.name);
    }
    if (!tool.packages.some(entry => entry.name === tool.name && entry.version === tool.version)) fail(`top-level pin differs for ${tool.name}.`);
    if (new Set(tool.sourceBuilds).size !== tool.sourceBuilds.length || tool.sourceBuilds.some(name =>
      !names.has(name) || lock.target !== "darwin-x64" || name !== "cryptography")) fail("unexpected source-build exception.");
  }
  return { lock, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function writeManagedPythonInputs(work, resolution, developmentWheels = {}) {
  const destination = join(work, "python-locks");
  mkdirSync(destination);
  for (const tool of resolution.lock.tools) {
    const wheel = developmentWheels[tool.name];
    if (wheel && (wheel.source.name !== tool.name || wheel.source.version !== tool.version)) fail("development wheel pin differs.");
    const lines = tool.packages.map(entry => {
      if (wheel && entry.name === tool.name) return `${entry.name} @ ${wheel.spec} --hash=sha256:${wheel.source.sha256}`;
      return `${entry.name}==${entry.version} ${entry.sha256.map(hash => `--hash=sha256:${hash}`).join(" ")}`;
    });
    writeFileSync(join(destination, `${tool.name}.txt`), lines.join("\n") + "\n", { flag: "wx" });
    // A direct development wheel must still satisfy the release-version pin.
    writeFileSync(join(destination, `${tool.name}.constraints.txt`), `${tool.name}==${tool.version}\n`, { flag: "wx" });
  }
}

export function verifyManagedPythonInstallation({ root, report, tool, developmentWheel }) {
  const value = JSON.parse(readFileSync(report));
  if (value.version !== "1" || !Array.isArray(value.install)) fail("pip installation report is invalid.");
  const expected = new Map(tool.packages.map(entry => [entry.name, entry]));
  const reported = new Set();
  for (const item of value.install) {
    const name = normalize(item.metadata?.name), entry = expected.get(name);
    const hash = item.download_info?.archive_info?.hashes?.sha256;
    const wheel = name === tool.name ? developmentWheel : undefined;
    if (!entry || reported.has(name) || item.metadata?.version !== entry.version ||
        !(wheel ? [wheel.source.sha256] : entry.sha256).includes(hash)) fail(`download differs for ${name || "unknown package"}.`);
    let url;
    try { url = new URL(item.download_info.url); } catch { fail("invalid package download URL."); }
    if (wheel) {
      const original = new URL(wheel.spec); original.hash = "";
      if (url.href !== original.href) fail("development wheel source differs.");
    } else if (url.protocol !== "https:" || url.username || url.password ||
        (!url.pathname.endsWith(".whl") && !tool.sourceBuilds.includes(name))) fail(`unexpected package archive for ${name}.`);
    reported.add(name);
  }
  if (reported.size !== expected.size) fail(`downloaded package set differs for ${tool.name}.`);
  const installed = new Set();
  for (const directory of readdirSync(root, { withFileTypes: true })) {
    if (!directory.name.endsWith(".dist-info")) continue;
    if (!directory.isDirectory() || directory.isSymbolicLink()) fail("linked or invalid distribution metadata.");
    const metadata = readFileSync(join(root, directory.name, "METADATA"), "utf8");
    const name = normalize(metadata.match(/^Name:\s*(.+)$/mi)?.[1]?.trim());
    const version = metadata.match(/^Version:\s*(.+)$/mi)?.[1]?.trim();
    if (installed.has(name) || !expected.has(name) || expected.get(name).version !== version) fail(`installed package differs for ${name || "unknown package"}.`);
    installed.add(name);
  }
  if (installed.size !== expected.size) fail(`installed package set differs for ${tool.name}.`);
  return { name: tool.name, packages: installed.size, sourceBuilds: tool.sourceBuilds };
}

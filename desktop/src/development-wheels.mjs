import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const COMPANIONS = new Set(["coop-data-doc", "coop-sql-review", "coop-dax-review"]);
const MARKER = "coop-development-source.json";
function fail() { throw new Error("Development wheel provenance is invalid or does not match the installed package."); }

export function validateDevelopmentSource(value) {
  const fields = ["name", "version", "file", "sha256", "repository", "revision"];
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(fields.sort()) ||
      !COMPANIONS.has(value.name) || !/^\d+\.\d+\.\d+$/.test(value.version || "") ||
      value.file !== `${value.name.replaceAll("-", "_")}-${value.version}-py3-none-any.whl` ||
      !/^[a-f0-9]{64}$/.test(value.sha256 || "") || !/^[a-f0-9]{40}$/.test(value.revision || "") ||
      value.repository !== `https://github.com/kabukisensei/${value.name}.git`) fail();
  return Object.freeze({ ...value });
}

function verifyInstalled(root, source) {
  const info = join(root, `${source.name.replaceAll("-", "_")}-${source.version}.dist-info`);
  const metadata = readFileSync(join(info, "METADATA"), "utf8");
  const direct = JSON.parse(readFileSync(join(info, "direct_url.json"), "utf8"));
  const hash = direct.archive_info?.hashes?.sha256 ?? direct.archive_info?.hash?.replace(/^sha256=/, "");
  if (metadata.match(/^Name:\s*(.+)$/mi)?.[1]?.trim().replaceAll("_", "-") !== source.name ||
      metadata.match(/^Version:\s*(.+)$/mi)?.[1]?.trim() !== source.version || hash !== source.sha256) fail();
}

export function readDevelopmentSource(root) {
  if (!existsSync(join(root, MARKER))) return undefined;
  const source = validateDevelopmentSource(JSON.parse(readFileSync(join(root, MARKER), "utf8")));
  verifyInstalled(root, source);
  return source;
}

export function recordDevelopmentSource(root, source) {
  validateDevelopmentSource(source);
  verifyInstalled(root, source);
  writeFileSync(join(root, MARKER), `${JSON.stringify(source, null, 2)}\n`, { flag: "wx" });
}

// Copy first and authenticate the private snapshot used by pip. The hash fragment
// makes pip authenticate it again at installation rather than trusting a prior read.
export function snapshotDevelopmentWheels(manifestPath, destination, pipSpecs) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest || JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(["schemaVersion", "wheels"]) ||
      manifest.schemaVersion !== 1 || !Array.isArray(manifest.wheels) || !manifest.wheels.length || manifest.wheels.length > 3) fail();
  const seen = new Set();
  const sources = manifest.wheels.map(entry => {
    const source = validateDevelopmentSource(entry);
    if (seen.has(source.name) || !pipSpecs.includes(`${source.name}==${source.version}`)) fail();
    seen.add(source.name);
    return source;
  });
  mkdirSync(destination);
  return Object.freeze(Object.fromEntries(sources.map(source => {
    const original = join(dirname(manifestPath), source.file), path = join(destination, source.file);
    if (!lstatSync(original).isFile() || lstatSync(original).isSymbolicLink()) fail();
    copyFileSync(original, path);
    if (createHash("sha256").update(readFileSync(path)).digest("hex") !== source.sha256) fail();
    return [source.name, Object.freeze({ source, spec: `${pathToFileURL(path).href}#sha256=${source.sha256}` })];
  })));
}

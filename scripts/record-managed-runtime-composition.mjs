#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, extname, relative, resolve, sep } from "node:path";

function die(message) {
  console.error(message);
  process.exit(1);
}

const root = resolve(process.env.MANAGED_RUNTIME_ROOT || "");
const out = resolve(process.env.COMPOSITION_OUT || "");
if (!process.env.MANAGED_RUNTIME_ROOT || !process.env.COMPOSITION_OUT) die("MANAGED_RUNTIME_ROOT and COMPOSITION_OUT are required.");
if (realpathSync(root) !== root) die("Managed runtime root must be canonical.");

const totals = { files: 0, directories: 0, bytes: 0 };
const groups = new Map();
const extensions = new Map();
const classes = new Map();
const depthFour = new Map();
const largestFiles = [];
const digest = createHash("sha256");

function add(map, key, size) {
  const value = map.get(key) || { files: 0, bytes: 0 };
  value.files += 1;
  value.bytes += size;
  map.set(key, value);
}

function groupFor(parts) {
  if (parts[0] === "python" && parts[1] === "tools" && parts[2]) return `python/tools/${parts[2]}`;
  if (parts[0] === "python" && parts[1]) return `python/${parts[1]}`;
  return parts[0] || "<root>";
}

function classFor(parts, filename, extension) {
  const lowerParts = parts.map((part) => part.toLowerCase());
  if (lowerParts.some((part) => part === "tests" || part === "test")) return "test-tree";
  if (lowerParts.some((part) => part.endsWith(".dist-info"))) return "python-dist-info";
  if (lowerParts.some((part) => part.endsWith(".egg-info"))) return "python-egg-info";
  if (extension === ".py") return "python-source";
  if (extension === ".pyi") return "python-type-stub";
  if ([".dll", ".exe", ".node", ".pyd", ".so", ".dylib"].includes(extension)) return "native-binary";
  if (["license", "license.txt", "license.md", "copying", "notice", "readme", "readme.md", "readme.txt", "changelog", "changelog.md"].includes(filename.toLowerCase())) return "documentation-metadata";
  return "other";
}

const pending = [root];
while (pending.length) {
  const directory = pending.pop();
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    const rel = relative(root, path).split(sep).join("/");
    if (!rel || rel.startsWith("../") || rel.includes("/../")) die(`Unsafe managed runtime path: ${rel}`);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) die(`Managed runtime inventory refuses symbolic link: ${rel}`);
    if (stat.isDirectory()) {
      totals.directories += 1;
      pending.push(path);
      continue;
    }
    if (!stat.isFile()) die(`Unsupported managed runtime entry: ${rel}`);
    const parts = rel.split("/");
    const extension = extname(entry.name).toLowerCase() || "<none>";
    totals.files += 1;
    totals.bytes += stat.size;
    add(groups, groupFor(parts), stat.size);
    add(extensions, extension, stat.size);
    add(classes, classFor(parts, basename(entry.name), extension), stat.size);
    add(depthFour, parts.slice(0, 4).join("/"), stat.size);
    digest.update(rel, "utf8");
    digest.update("\0");
    digest.update(String(stat.size), "ascii");
    digest.update("\n");
    largestFiles.push({ path: rel, bytes: stat.size });
  }
}

function rows(map, limit = null) {
  const values = [...map].map(([name, value]) => ({ name, ...value }))
    .sort((a, b) => b.bytes - a.bytes || b.files - a.files || a.name.localeCompare(b.name, "en"));
  return limit === null ? values : values.slice(0, limit);
}

largestFiles.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path, "en"));
const report = {
  schemaVersion: 1,
  diagnosticOnly: true,
  rootName: basename(root),
  totals,
  inventoryPathSizeSha256: digest.digest("hex"),
  groups: rows(groups),
  semanticClasses: rows(classes),
  extensions: rows(extensions, 50),
  depthFour: rows(depthFour, 100),
  largestFiles: largestFiles.slice(0, 50),
};
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ out, totals, inventoryPathSizeSha256: report.inventoryPathSizeSha256 }));

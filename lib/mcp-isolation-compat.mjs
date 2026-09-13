// Targeted correction for pi-mcp-adapter 2.10.0 (MIT). Managed Desktop and its
// terminal handoffs share one profile; unrelated global MCP settings stay out.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const ORIGINAL_MCP_CONFIG_SHA256 = "f3b650f3a57a61115b16411782452fd10c79c7f113d6e86508f4558975e4fbad";
export const ORIGINAL_MCP_INIT_SHA256 = "4f7c722064c2abe1442542e2d2691f809f09778d1a6296b49c469703587ff9a8";
const hash = value => createHash("sha256").update(value).digest("hex");
const replacements = [
  ['  if (GENERIC_GLOBAL_CONFIG_PATH !== userPath) {', '  if (process.env.COOP_DESKTOP_MANAGED_RUNTIME !== "1" && GENERIC_GLOBAL_CONFIG_PATH !== userPath) {'],
  ['export function findAvailableImportConfigs(cwd = process.cwd()): DiscoveredImportConfig[] {', 'export function findAvailableImportConfigs(cwd = process.cwd()): DiscoveredImportConfig[] {\n  if (process.env.COOP_DESKTOP_MANAGED_RUNTIME === "1") return [];'],
  ['  const imports = (Object.keys(IMPORT_PATHS) as ImportKind[])', '  const imports = (process.env.COOP_DESKTOP_MANAGED_RUNTIME === "1" ? [] : Object.keys(IMPORT_PATHS) as ImportKind[])'],
];
export function patchMcpConfigSource(source) {
  if (hash(source) !== ORIGINAL_MCP_CONFIG_SHA256) throw new Error("Unrecognized pi-mcp-adapter config source; review the isolation correction.");
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error("MCP isolation correction is ambiguous.");
    source = source.replace(before, after);
  }
  return source;
}
const bootstrapBefore = "    bootstrapAll = true;";
const bootstrapAfter = '    bootstrapAll = process.env.COOP_DESKTOP_MANAGED_RUNTIME !== "1";';
export function patchMcpInitSource(source) {
  if (hash(source) !== ORIGINAL_MCP_INIT_SHA256 || source.split(bootstrapBefore).length !== 2) throw new Error("Unrecognized pi-mcp-adapter initialization source; review the lazy startup correction.");
  // First-use metadata bootstrap must not turn lazy integrations into a gate on
  // opening a chat. Eager servers still start; lazy tools connect when invoked.
  return source.replace(bootstrapBefore, bootstrapAfter);
}
export function ensureMcpIsolationCompatibility(packageRoot, { check = false } = {}) {
  if (lstatSync(packageRoot).isSymbolicLink()) throw new Error("MCP package directory must not be a link.");
  const read = name => {
    const path = join(packageRoot, name), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("MCP compatibility input must be a bounded regular file.");
    return readFileSync(path, "utf8");
  };
  const pkg = JSON.parse(read("package.json"));
  if (pkg.name !== "pi-mcp-adapter" || pkg.version !== "2.10.0") throw new Error("Review MCP isolation for this package version.");
  const source = read("config.ts");
  let original = source;
  for (const [before, after] of [...replacements].reverse()) original = original.replace(after, before);
  const patched = hash(original) === ORIGINAL_MCP_CONFIG_SHA256 && patchMcpConfigSource(original) === source;
  if (!patched) {
    if (check) throw new Error("Packaged MCP isolation correction is missing or changed.");
    const path = join(packageRoot, "config.ts"), temporary = `${path}.coop-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, patchMcpConfigSource(source), { flag: "wx", mode: 0o644 });
    try { renameSync(temporary, path); } catch (error) { unlinkSync(temporary); throw error; }
  }
  const init = read("init.ts");
  const initOriginal = init.replace(bootstrapAfter, bootstrapBefore);
  const initPatched = hash(initOriginal) === ORIGINAL_MCP_INIT_SHA256 && patchMcpInitSource(initOriginal) === init;
  if (!initPatched) {
    if (check) throw new Error("Packaged MCP lazy startup correction is missing or changed.");
    const path = join(packageRoot, "init.ts"), temporary = `${path}.coop-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, patchMcpInitSource(init), { flag: "wx", mode: 0o644 });
    try { renameSync(temporary, path); } catch (error) { unlinkSync(temporary); throw error; }
  }
  return { id: "managed-mcp-isolation-v1", files: [
    { path: "config.ts", upstreamSha256: ORIGINAL_MCP_CONFIG_SHA256, patchedSha256: hash(read("config.ts")) },
    { path: "init.ts", upstreamSha256: ORIGINAL_MCP_INIT_SHA256, patchedSha256: hash(read("init.ts")) },
  ] };
}

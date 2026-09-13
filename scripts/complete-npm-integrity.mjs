import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const LIMIT = 200 * 1024 * 1024;
const digest = bytes => createHash("sha512").update(bytes).digest("base64");
function safePath(path) {
  return typeof path === "string" && !/[\\\x00-\x1f:]/.test(path)
    && path.split("/").every(part => part && part !== "." && part !== "..");
}
async function download(url) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error(`Package archive download failed (${response.status}).`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > LIMIT) throw new Error("Package archive exceeds the verification limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function installedFiles(root, prefix = "", files = new Map()) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    // Dependencies have their own inventory entries; they are not package files.
    if (!prefix && entry.name === "node_modules") continue;
    const path = prefix + entry.name;
    if (entry.isDirectory()) installedFiles(join(root, entry.name), `${path}/`, files);
    else if (entry.isFile()) files.set(path, digest(readFileSync(join(root, entry.name))));
    else throw new Error(`Cannot verify a linked or special package file: ${path}.`);
  }
  return files;
}
async function archiveFiles(tar, bytes) {
  const files = new Map();
  let failure, size = 0;
  await new Promise((resolve, reject) => {
    const parser = tar.t({ strict: true, onentry(entry) {
      if (entry.type === "Directory") return;
      const path = entry.path.slice("package/".length);
      if (entry.type !== "File" || !entry.path.startsWith("package/") || !safePath(path)
        || path.startsWith("node_modules/") || files.has(path)) {
        failure ||= new Error("Package archive contains an unsafe or duplicate entry.");
        return;
      }
      files.set(path, null);
      const hash = createHash("sha512");
      entry.on("data", chunk => {
        size += chunk.length;
        if (size > LIMIT) parser.destroy(new Error("Expanded package exceeds the verification limit."));
        else hash.update(chunk);
      });
      entry.on("end", () => files.set(path, hash.digest("base64")));
    } });
    parser.on("error", reject);
    parser.on("end", resolve);
    parser.end(bytes);
  });
  if (failure) throw failure;
  if (!files.has("package.json")) throw new Error("Package archive has no package identity.");
  return files;
}

// Upstream shrinkwrap files can omit integrity. Never fill those gaps from
// registry metadata alone: compare every installed package file to the archive.
export async function completeNpmIntegrity({ npmPrefix, npmCli, fetchArchive = download }) {
  const path = join(npmPrefix, "node_modules", ".package-lock.json");
  const original = readFileSync(path, "utf8");
  const lock = JSON.parse(original);
  if (lock.lockfileVersion !== 3 || !lock.packages || Array.isArray(lock.packages)) throw new Error("Installed npm lock is invalid.");
  const tar = createRequire(npmCli)("tar");
  let completed = 0;
  for (const [packagePath, entry] of Object.entries(lock.packages)) {
    if (entry.integrity) continue;
    if (!safePath(packagePath) || !packagePath.startsWith("node_modules/")) throw new Error("Installed package path is invalid.");
    const url = new URL(entry.resolved);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Package archive URL is invalid.");
    let root = npmPrefix;
    for (const part of packagePath.split("/")) {
      root = join(root, part);
      if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error("Installed package path contains a link.");
    }
    const bytes = await fetchArchive(url.href);
    if (!Buffer.isBuffer(bytes) || bytes.length > LIMIT) throw new Error("Package archive is invalid or too large.");
    const expected = await archiveFiles(tar, bytes);
    const actual = installedFiles(root);
    if (actual.size !== expected.size || [...expected].some(([name, hash]) => actual.get(name) !== hash)) {
      throw new Error(`Installed package differs from its resolved archive: ${packagePath}.`);
    }
    entry.integrity = `sha512-${digest(bytes)}`;
    completed++;
  }
  if (!completed) return { completed };
  if (readFileSync(path, "utf8") !== original) throw new Error("Installed npm lock changed during verification.");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(lock, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
  return { completed };
}

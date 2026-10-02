// Files attached to a message in the coop window (master plan D1b2). Images go
// to the model as images, the way the terminal pastes them. Everything else
// is handed to coop by path, so its reads go through the same guarded read
// tool as any other file: a text file by its own path, and a Word, Excel,
// PowerPoint or PDF file as the Markdown text pulled out of it, saved under
// the window's data folder (<userData>/attachments/<id>/<name>.md).
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OFFICE_KINDS, officeText } from "./office.mjs";

const MB = 1024 * 1024;
export const LIMITS = Object.freeze({
  image: 4 * MB,          // the terminal's own limit for a pasted image
  text: 2 * MB,           // referenced by path; the read tool pages through it
  document: 25 * MB,      // Word, Excel, PowerPoint, PDF
  chars: 1_500_000,       // extracted text kept per file
  perMessage: 10,
  images: 5,
  pdfSeconds: 60,
});

const IMAGE_TYPES = Object.freeze({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" });
const OLD_OFFICE = Object.freeze({ ".doc": "Word", ".xls": "Excel", ".ppt": "PowerPoint" });
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".yml", ".yaml", ".xml", ".html", ".htm", ".svg", ".log",
  ".sql", ".dax", ".tmdl", ".bim", ".pbip", ".pq", ".m", ".kql", ".ipynb",
  ".py", ".ps1", ".psm1", ".psd1", ".bat", ".cmd", ".sh", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".cs", ".vb", ".r", ".rmd",
  ".ini", ".toml", ".cfg", ".conf", ".env", ".gitignore", ".tex", ".rst", ".adoc",
]);
export const PDF_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "pdf-text.mjs");
const ID = /^[a-z0-9]{6,12}-[0-9a-f]{6}$/;

export class AttachError extends Error {}

function head(path, bytes = 8192) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally { closeSync(fd); }
}

function mb(bytes) {
  return bytes >= MB ? `${(bytes / MB).toFixed(bytes >= 10 * MB ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** What kind of attachment a file is: image, text, office, pdf, or unsupported with a reason. */
export function classify(path, sniff = Buffer.alloc(0)) {
  const ext = extname(path).toLowerCase();
  if (IMAGE_TYPES[ext]) return { kind: "image", label: "image", mimeType: IMAGE_TYPES[ext] };
  if (ext === ".pdf" || sniff.subarray(0, 5).toString("latin1") === "%PDF-") return { kind: "pdf", label: "PDF" };
  if (OFFICE_KINDS[ext]) return { kind: "office", label: OFFICE_KINDS[ext] };
  if (OLD_OFFICE[ext]) return { kind: "unsupported", reason: `coop reads the current ${OLD_OFFICE[ext]} format (${ext}x). Save the file as ${ext}x first.` };
  if (TEXT_EXTENSIONS.has(ext) || (sniff.length && !sniff.includes(0))) return { kind: "text", label: "text" };
  return { kind: "unsupported", reason: `coop cannot read ${ext ? `${ext} files` : "this kind of file"}. Attach images, text, Word, Excel, PowerPoint or PDF files.` };
}

/** How coop is told where the file is: relative inside the working folder, else the full path. */
export function referenceFor(path, cwd) {
  const windows = /^[A-Za-z]:[\\/]/.test(cwd) || sep === "\\";
  const inside = (a, b) => (windows ? a.toLowerCase() : a) === (windows ? b.toLowerCase() : b);
  const rel = relative(cwd, path);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel) && inside(resolve(cwd, rel), resolve(path))) return rel.split(sep).join("/");
  return path;
}

/** The pdfjs-dist folder of the window runtime Electron runs from; "" when it is not installed. */
export function findPdfjs(execPath, env = process.env) {
  if (env.COOP_DESKTOP_RUNTIME) {
    const dir = join(env.COOP_DESKTOP_RUNTIME, "node_modules", "pdfjs-dist");
    return existsSync(join(dir, "package.json")) ? dir : "";
  }
  let dir = dirname(execPath || "");
  for (let up = 0; up < 8 && dir; up++) {
    const candidate = join(dir, "node_modules", "pdfjs-dist");
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

function pdfEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) if (!key.startsWith("ELECTRON_") && key !== "NODE_OPTIONS") out[key] = value;
  return out;
}

/** Text of a PDF through desktop/scripts/pdf-text.mjs in its own node process. */
export function pdfText({ node, pdfjsDir, file, maxChars = LIMITS.chars, timeoutMs = LIMITS.pdfSeconds * 1000, script = PDF_SCRIPT, env = process.env }) {
  return new Promise((resolvePromise, reject) => {
    if (!pdfjsDir) { reject(new AttachError("PDF reading is not installed in this window runtime yet. Close the window and run: coop sync")); return; }
    execFile(node, [script, pdfjsDir, file, String(maxChars)], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * MB, windowsHide: true, env: pdfEnv(env) }, (error, stdout, stderr) => {
      if (error && error.killed) { reject(new AttachError(`${basename(file)} took longer than ${Math.round(timeoutMs / 1000)} seconds to read. Attach a smaller PDF.`)); return; }
      let result = null;
      try { result = JSON.parse(String(stdout).trim().split("\n").pop()); } catch { /* no JSON */ }
      if (result && result.error) { reject(new AttachError(result.error)); return; }
      if (error || !result || typeof result.text !== "string") {
        const tail = String(stderr || "").trim().split("\n").filter(Boolean).pop();
        reject(new AttachError(`${basename(file)} could not be read as a PDF${tail ? ` (${tail.slice(0, 200)})` : ""}.`));
        return;
      }
      resolvePromise({ text: result.text, detail: `${result.pages} page${result.pages === 1 ? "" : "s"}`, truncated: Boolean(result.truncated) });
    });
  });
}

function safeName(name) {
  return name.replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "_").slice(0, 120) || "file";
}

/** Write the extracted text under the store; returns { id, file }. */
export function saveExtract(store, { name, source, label, detail, text }, now = new Date()) {
  const id = `${now.getTime().toString(36)}-${randomBytes(3).toString("hex")}`;
  const dir = join(store, id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${safeName(name)}.md`);
  const header = `# ${name}\n\nText from ${source} (${label}, ${detail}), pulled out by coop on ${now.toISOString().slice(0, 10)}. Layout, images and formatting are not included; tables are Markdown tables.\n\n`;
  writeFileSync(file, header + text + "\n");
  return { id, file };
}

/** Drop stored extracts older than maxAgeMs, and all but the newest keep. */
export function pruneStore(store, { maxAgeMs = 7 * 24 * 3600 * 1000, keep = 100, now = Date.now() } = {}) {
  let entries = [];
  try { entries = readdirSync(store).filter((name) => ID.test(name)); } catch { return 0; }
  const dated = entries.map((name) => { try { return { name, time: statSync(join(store, name)).mtimeMs }; } catch { return { name, time: 0 }; } }).sort((a, b) => b.time - a.time);
  let removed = 0;
  dated.forEach((entry, index) => {
    if (index < keep && now - entry.time <= maxAgeMs) return;
    try { rmSync(join(store, entry.name), { recursive: true, force: true }); removed++; } catch { /* in use */ }
  });
  return removed;
}

/** Remove one stored extract (the chip was removed before sending). */
export function forget(store, id) {
  if (!ID.test(String(id))) return false;
  try { rmSync(join(store, id), { recursive: true, force: true }); return true; } catch { return false; }
}

/**
 * Attach one file. Returns, by kind:
 *   image:  { kind, name, size, path, mimeType, data (base64) }
 *   text:   { kind, label, name, size, path, ref }
 *   office, pdf: { kind, label, name, size, path, ref (the extract), id, detail, chars, truncated }
 * Throws AttachError with a sentence for the person.
 */
export async function attach(path, { cwd, store, node, pdfjsDir, script = PDF_SCRIPT, limits = LIMITS, env = process.env }) {
  if (typeof path !== "string" || !isAbsolute(path) || /[\0\r\n]/.test(path)) throw new AttachError("That is not a file path.");
  let stat;
  try { stat = statSync(path); } catch { throw new AttachError(`${basename(path)} was not found.`); }
  if (!stat.isFile()) throw new AttachError(`${basename(path)} is not a file. Drop files, not folders.`);
  const name = basename(path);
  const kind = classify(path, stat.size ? head(path) : Buffer.alloc(0));
  if (kind.kind === "unsupported") throw new AttachError(kind.reason);
  const cap = (limit, what) => { if (stat.size > limit) throw new AttachError(`${name} is ${mb(stat.size)}; ${what} up to ${mb(limit)} can be attached.`); };
  if (kind.kind === "image") {
    cap(limits.image, "images");
    return { kind: "image", name, size: stat.size, path, mimeType: kind.mimeType, data: readFileSync(path).toString("base64") };
  }
  if (kind.kind === "text") {
    cap(limits.text, "text files");
    return { kind: "text", label: "text", name, size: stat.size, path, ref: referenceFor(path, cwd) };
  }
  cap(limits.document, "documents");
  let extracted;
  if (kind.kind === "office") {
    try { extracted = officeText(readFileSync(path), extname(path).toLowerCase(), { maxChars: limits.chars }); } catch (error) { throw new AttachError(`${name} could not be read: ${error.message}.`); }
  } else {
    extracted = await pdfText({ node, pdfjsDir, file: path, maxChars: limits.chars, timeoutMs: limits.pdfSeconds * 1000, script, env });
  }
  if (!extracted.text.trim()) throw new AttachError(`${name} has no text coop can read${kind.kind === "pdf" ? " (a scanned PDF has only pictures of text)" : ""}.`);
  const saved = saveExtract(store, { name, source: path, label: kind.label, detail: extracted.detail, text: extracted.text });
  return { kind: kind.kind, label: kind.label, name, size: stat.size, path, ref: saved.file, id: saved.id, detail: extracted.detail, chars: extracted.text.length, truncated: extracted.truncated };
}

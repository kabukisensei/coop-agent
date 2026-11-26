// Change history (FEATURES-DESIGN, CW2): a private, local log of coop's own file
// edits, with restore. Off by default (`coop settings set history on`).
//
//   <profile dir>/history/<repo-slug>-<hash8>/<YYYY-MM>/log.jsonl
//   <profile dir>/history/<repo-slug>-<hash8>/<YYYY-MM>/blobs/<sha256>.gz
//
// <hash8> is the start of the SHA-256 of the repository's real root path
// (lowercased on Windows), so two repositories with one folder name never share a
// store. No Git repository, no remote, no hooks: nothing here is ever pushed.
//
// The guardrails (extensions/coop-guardrails) record after the fact: the file's
// bytes before a write or edit are held in memory by toolCallId, and once the
// tool's result is back the line and the blobs are written off the critical
// path. A failure to record is reported and never fails or delays the tool call.
// Each line is one append, so two coop tabs on one repository cannot corrupt each
// other; a reader skips a line that does not parse.
//
// Never stored (the call is still recorded, without content): secret-looking
// paths (the guardrails' isSecretPath), text that matches a secret pattern
// (lib/secret-text.mjs), data extracts (.csv .tsv .parquet .xlsx .xls .pbix .bak),
// anything under live/, backups/ or drafts/, paths the repository's .gitignore
// excludes, files over 5 MB and binary files.
//
// The model never sees any of this: there is no model-facing tool, /history
// shows its output to the person only, and the guardrails block every model
// read, write or shell command that names the history folder.
//
// Retention: whole month folders only. The daily cleanup (lib/common.ps1
// Get-CoopCleanupTargets) removes month folders older than cleanup.days; the 1 GB
// cap (enforceCap) is checked at session start, oldest months first.
//
// CLI (doctor):  node lib/action-history.mjs status [--json]

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, readdir, rm, stat } from "node:fs/promises";
import { execFile, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { backupPathFor, profileDir, repositoryRootFor } from "./paths.mjs";
import { hasSecretText } from "./secret-text.mjs";
import { unifiedDiff } from "./text-diff.mjs";
import { isMainModule } from "./features.mjs";

export const LINE_VERSION = 1;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const CAP_BYTES = 1024 * 1024 * 1024;
export const LIST_DEFAULT = 20;
const DATA_EXTENSIONS = /\.(csv|tsv|parquet|xlsx|xls|pbix|bak)$/i;
const WORK_FOLDERS = new Set(["live", "backups", "drafts"]);
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
const GIT_IGNORED_MAX = 2000;

/** A month folder's name ("2026-11"): four digits, a dash, a month 01-12, year 1 or later. */
export function validMonth(name) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(name || ""));
  return Boolean(m) && Number(m[1]) >= 1 && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}

/** `<profile dir>/history`. */
export function historyRoot(env = process.env) {
  return join(profileDir(env), "history");
}

const caseKey = (p, platform = process.platform) => (platform === "win32" ? p.toLowerCase() : p);

/** A path as the file system names it: links followed, 8.3 short names made long. */
export function realPath(p) {
  const full = resolve(p);
  try { return realpathSync.native(full); } catch { /* missing */ }
  // Not there yet (a new file, or a new folder under it): the nearest folder
  // above that exists, resolved, plus the rest of the path as written.
  let rest = basename(full);
  for (let dir = dirname(full); ; dir = dirname(dir)) {
    try { return join(realpathSync.native(dir), rest); } catch { /* keep climbing */ }
    if (dirname(dir) === dir) return full;
    rest = join(basename(dir), rest);
  }
}

/** `<repo-slug>-<hash8>` for a repository root. */
export function storeKey(repoRoot, platform = process.platform) {
  const real = realPath(resolve(repoRoot));
  const hash8 = createHash("sha256").update(caseKey(real, platform)).digest("hex").slice(0, 8);
  const slug = basename(real).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 40) || "root";
  return `${slug}-${hash8}`;
}

/** The store folder for the repository that holds `fileOrDir`: { repoRoot, store }. */
export function storeFor(fileOrDir, env = process.env) {
  const full = resolve(fileOrDir || ".");
  let dir = full;
  try { if (!statSync(full).isDirectory()) dir = dirname(full); } catch { dir = dirname(full); }
  const repoRoot = realPath(repositoryRootFor(dir));
  return { repoRoot, store: join(historyRoot(env), storeKey(repoRoot)) };
}

/**
 * The repository stores a session in `cwd` can see, the cwd's own repository
 * first, then each repository directly inside it (a Cooptimize client folder
 * holds several): [{ repoRoot, store, rel }], `rel` being the repository's
 * folder relative to `cwd` ("" for its own). A file's history is kept in its
 * own repository's store, so /history looks in all of them.
 */
export function storesNear(cwd, env = process.env) {
  const base = resolve(cwd || ".");
  const out = [];
  const seen = new Set();
  const add = (dir, rel) => {
    const s = storeFor(dir, env);
    if (seen.has(s.store)) return;
    seen.add(s.store);
    out.push({ ...s, rel });
  };
  add(base, "");
  let names = [];
  try { names = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort(); } catch { names = []; }
  for (const name of names) if (existsSync(join(base, name, ".git"))) add(join(base, name), name);
  return out;
}

/** True when `p` (resolved against `cwd`, links followed) is the history folder or inside it. */
export function isHistoryPath(p, cwd = ".", env = process.env) {
  if (!p) return false;
  const root = caseKey(realPath(historyRoot(env)));
  for (const candidate of [resolve(cwd || ".", p), realPath(resolve(cwd || ".", p))]) {
    const c = caseKey(candidate);
    if (c === root || c.startsWith(root + sep) || c.startsWith(`${root}/`)) return true;
  }
  return false;
}

export function monthOf(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** Off the critical path only: try now, and on a lock (an antivirus scan, another
 *  writer's rename) wait 25 ms without holding the thread, up to 20 times. */
async function retry(fn, tries = 20) {
  for (let attempt = 0; ; attempt++) {
    try { return fn(); } catch (e) {
      if (attempt >= tries || !e || !TRANSIENT.has(e.code)) throw e;
      await pause(25);
    }
  }
}

/**
 * Why a file's content is not stored ("" when it may be). Path rules only; the
 * content rules (size, binary, secret text, .gitignore) come at record time.
 * `isSecretPath` is the guardrails' own check, passed in.
 */
export function pathExclusion(file, repoRoot, { isSecretPath = () => false, asWritten = "" } = {}) {
  const rel = relative(repoRoot, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return "outside the repository";
  // The name the tool was given counts too: a .env that links to docs/cfg.txt is a secret.
  if (isSecretPath(file) || isSecretPath(rel) || (asWritten && isSecretPath(asWritten))) return "secret-looking file";
  if (DATA_EXTENSIONS.test(file)) return "data file";
  if (rel.split(/[\\/]+/).slice(0, -1).some((part) => WORK_FOLDERS.has(part.toLowerCase()))) return "live, backups or drafts folder";
  return "";
}

/** Why these bytes are not stored ("" when they may be). */
export function contentExclusion(buf) {
  if (!buf) return "";
  if (buf.length > MAX_FILE_BYTES) return "over 5 MB";
  if (buf.subarray(0, 8000).includes(0)) return "binary file";
  if (hasSecretText(buf.toString("utf8"))) return "secret text";
  return "";
}

/**
 * The file's bytes now, in ONE try (the tool path never waits): a Buffer, null
 * when it does not exist, "large" past 5 MB (not read), or "unreadable" when it
 * is locked (an antivirus scan, Excel) or cannot be read.
 */
export function readNow(file) {
  let st;
  try { st = statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  if (st.size > MAX_FILE_BYTES) return "large";
  try { return readFileSync(file); } catch { return "unreadable"; }
}

/** The same, off the tool path: a lock is retried (async) before it counts as unreadable. */
export async function readCapped(file) {
  let st;
  try { st = statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  if (st.size > MAX_FILE_BYTES) return "large";
  try { return await retry(() => readFileSync(file)); } catch { return "unreadable"; }
}

/**
 * Where a write or edit's history goes, and whether its content may be kept by
 * path alone: { file, full, repoRoot, store, excluded }. Synchronous and
 * cheap, so the tool path checks it BEFORE reading anything: an excluded file
 * (a .env, a data extract) is never read or held in memory.
 */
export function prepareFile(file, { isSecretPath, env = process.env } = {}) {
  const { repoRoot, store } = storeFor(file, env);
  const full = realPath(resolve(file));
  return { file, full, repoRoot, store, excluded: pathExclusion(full, repoRoot, { isSecretPath, asWritten: file }) };
}

/** Store `buf` once per month folder: blobs/<sha256>.gz, written by temp file and rename. */
async function putBlob(monthDir, buf) {
  const hash = sha256(buf);
  const dir = join(monthDir, "blobs");
  const file = join(dir, `${hash}.gz`);
  if (existsSync(file)) return hash;
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    // A full disk mid-write leaves no temp file behind.
    writeFileSync(tmp, gzipSync(buf));
    await retry(() => renameSync(tmp, file));
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* gone */ }
    // Another tab stored the same content first.
    if (!existsSync(file)) throw e;
  }
  return hash;
}

/** True when the log ends inside a line (a crash or a full disk cut the last append). */
function endsTorn(log) {
  let fd;
  try {
    fd = openSync(log, "r");
    const size = fstatSync(fd).size;
    if (!size) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } catch { return false; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
}

/** One line, appended in one write; a torn last line is closed first, so this one still parses. */
async function appendLine(monthDir, entry) {
  mkdirSync(monthDir, { recursive: true });
  const log = join(monthDir, "log.jsonl");
  const text = `${endsTorn(log) ? "\n" : ""}${JSON.stringify(entry)}\n`;
  await retry(() => appendFileSync(log, text, "utf8"));
}

function newId() {
  return randomBytes(4).toString("hex");
}

const gitIgnoredCache = new Map();
/**
 * Does the repository's .gitignore exclude `file`? One `git check-ignore`,
 * cached per path (at most 2000 paths; cleared at each session start and when a
 * .gitignore is written). Exit 0 is ignored and 1 is not; anything else (git
 * missing, a timeout) counts as ignored, so the content is not kept, and is not
 * cached, so the next write asks git again.
 */
export function gitIgnored(repoRoot, file, { exec = execFile } = {}) {
  const key = `${repoRoot}\u0000${file}`;
  if (gitIgnoredCache.has(key)) return Promise.resolve(gitIgnoredCache.get(key));
  if (!existsSync(join(repoRoot, ".git"))) return Promise.resolve(false);
  return new Promise((done) => {
    exec("git", ["-C", repoRoot, "check-ignore", "-q", "--", relative(repoRoot, file)], { windowsHide: true, timeout: 5000 }, (error) => {
      if (error && error.code !== 1) { done(true); return; }
      const ignored = !error;
      if (gitIgnoredCache.size >= GIT_IGNORED_MAX) gitIgnoredCache.delete(gitIgnoredCache.keys().next().value);
      gitIgnoredCache.set(key, ignored);
      done(ignored);
    });
  });
}
export function clearGitIgnoredCache() { gitIgnoredCache.clear(); }

/**
 * Record one file change: blobs for the content before and after (when it may be
 * stored) and one line. `before` and `after` are what the tool path captured
 * (readNow): a Buffer, null when the file did not exist, "large" or
 * "unreadable". `after` is read here (with retries) only when it was not
 * captured. `prep` is prepareFile's answer from the tool path. Returns the line.
 */
export async function recordFileChange({ file, prep, tool, toolCallId = "", session = "", approval = "none-needed", isError = false, before = null, after, isSecretPath, env = process.env, now = new Date(), exec } = {}) {
  const p = prep || prepareFile(file, { isSecretPath, env });
  const { repoRoot, store, full } = p;
  const monthDir = join(store, monthOf(now));
  const entry = {
    v: LINE_VERSION, id: newId(), ts: now.toISOString(), session, toolCallId, tool,
    target: relative(repoRoot, full).split(sep).join("/") || basename(full),
    approval, before: null, after: null, result: isError ? "error" : "ok", kind: "file",
  };
  // A .gitignore written by coop changes what is ignored from here on.
  if (basename(full).toLowerCase() === ".gitignore") clearGitIgnoredCache();
  let excluded = p.excluded;
  if (!excluded && await gitIgnored(repoRoot, full, { exec })) excluded = "ignored by .gitignore";
  if (!excluded) {
    if (after === undefined) after = await readCapped(full);
    if (before === "unreadable" || after === "unreadable") excluded = "could not be read (locked?)";
    else if (before === "large" || after === "large") excluded = "over 5 MB";
    else excluded = contentExclusion(before) || contentExclusion(after);
  }
  if (excluded) entry.excluded = excluded;
  else {
    entry.before = before ? await putBlob(monthDir, before) : "absent";
    entry.after = after ? await putBlob(monthDir, after) : "absent";
  }
  await appendLine(monthDir, entry);
  return entry;
}

/** A record-only line: a live write or a shell command the guardrails approved (no content). */
export async function recordCallOnly({ cwd, tool, toolCallId = "", session = "", approval, label = "", isError = false, env = process.env, now = new Date() } = {}) {
  const { store } = storeFor(cwd, env);
  const entry = { v: LINE_VERSION, id: newId(), ts: now.toISOString(), session, toolCallId, tool, target: String(label).slice(0, 200), approval, before: null, after: null, result: isError ? "error" : "ok", kind: "record-only" };
  await appendLine(join(store, monthOf(now)), entry);
  return entry;
}

// Month folders only (a valid month name), never through a link (a junction on Windows).
function monthDirs(store) {
  try { return readdirSync(store, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink() && validMonth(d.name)).map((d) => d.name).sort().reverse(); } catch { return []; }
}

/** The store's lines, newest first (a line that does not parse is skipped), each with its `month`. */
export function readEntries(store, { limit = LIST_DEFAULT } = {}) {
  const out = [];
  for (const month of monthDirs(store)) {
    let text = "";
    try { text = readFileSync(join(store, month, "log.jsonl"), "utf8"); } catch { continue; }
    const lines = text.split("\n").filter(Boolean).reverse();
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
      out.push({ ...entry, month });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function findEntry(store, id) {
  const want = String(id || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(want)) return null;
  return readEntries(store, { limit: Infinity }).find((e) => e.id === want) || null;
}

export function readBlob(store, month, hash) {
  if (!/^[0-9a-f]{64}$/.test(String(hash || "")) || !validMonth(month)) return null;
  try { return gunzipSync(readFileSync(join(store, month, "blobs", `${hash}.gz`))); } catch { return null; }
}

/** Why an entry cannot be restored, or "". */
export function notRestorable(entry) {
  if (!entry) return "no such change in this repository's history";
  if (entry.kind !== "file") return "not restorable here: it was not a file edit (a live database change or a command). Ask coop for a reverse script if you need one (dev only, the usual rules apply)";
  if (entry.excluded) return `not restorable: its content was not stored (${entry.excluded})`;
  if (entry.before === "absent") return "not restorable: that change created the file; delete it yourself if you no longer want it";
  if (!entry.before || !entry.after) return "not restorable: its content was not stored";
  return "";
}

/**
 * What restoring `entry` would do to the file as it is now (`current`: Buffer or
 * null when the file is gone):
 *   { mode: "clean", content }      the file is that change's result: write back the before
 *   { mode: "recreate", content }   the file was deleted since: write it back as it was before
 *   { mode: "merged", content }     the file changed since: only that change's hunks removed
 *   { mode: "conflict", merged, content }  later edits overlap; `content` is the whole before
 *   { mode: "same" }                the file already has the before content
 *   { mode: "refused", reason }
 */
export function planRestore(store, entry, current, { git = "git" } = {}) {
  const why = notRestorable(entry);
  if (why) return { mode: "refused", reason: why };
  const before = readBlob(store, entry.month, entry.before);
  const after = entry.after === "absent" ? Buffer.alloc(0) : readBlob(store, entry.month, entry.after);
  if (!before || !after) return { mode: "refused", reason: "not restorable: its stored content is missing (removed by the cleanup?)" };
  // Deleted since: there is nothing to merge with; it comes back as it was before.
  if (current === null || current === undefined) return { mode: "recreate", content: before };
  if (!Buffer.isBuffer(current)) return { mode: "refused", reason: "not restorable: the file cannot be read now" };
  if (current.equals(before)) return { mode: "same" };
  if (current.equals(after)) return { mode: "clean", content: before };
  if (current.subarray(0, 8000).includes(0)) return { mode: "refused", reason: "not restorable: the file is binary now, so coop cannot take out only that change" };
  // Only now: git merge-file takes that change's hunks out of the file as it is.
  const tmp = mkdtempSync(join(tmpdir(), "coop-history-"));
  try {
    const cur = join(tmp, "current"), base = join(tmp, "after"), other = join(tmp, "before");
    writeFileSync(cur, current); writeFileSync(base, after); writeFileSync(other, before);
    const r = spawnSync(git, ["merge-file", "-p", "-L", "now", "-L", "that change", "-L", "before that change", cur, base, other], { windowsHide: true, timeout: 20_000, maxBuffer: 4 * MAX_FILE_BYTES });
    // 0: merged; 1-127: that many conflicts; 255 (binary), 128 (fatal) or a signal: it did not merge.
    if (r.error || r.status === null || r.status < 0 || r.status > 127) return { mode: "refused", reason: "git merge-file could not take out only that change (a binary file, or git failed)" };
    const merged = Buffer.from(r.stdout || "");
    return r.status === 0 ? { mode: "merged", content: merged } : { mode: "conflict", merged, content: before };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

const asText = (buf) => (buf ? buf.toString("utf8") : "");
const noBom = (text) => text.replace(/^\uFEFF/, "");

/** Unified-diff text from `a` to `b` (Buffers or null). A byte-order mark is left
 *  out of the lines (it would show as an invisible -/+ pair); changeNote names it. */
export function diffText(a, b) {
  return unifiedDiff(noBom(asText(a)), noBom(asText(b)));
}

/** What changed that a line diff cannot show: "line endings (CRLF/LF)", "the
 *  byte-order mark", both, or "" (nothing of the kind, or the bytes are equal). */
export function changeNote(a, b) {
  const x = asText(a), y = asText(b);
  if (x === y) return "";
  const notes = [];
  if (x.startsWith("\uFEFF") !== y.startsWith("\uFEFF")) notes.push("the byte-order mark");
  const bx = noBom(x), by = noBom(y);
  if (bx !== by && bx.replace(/\r\n/g, "\n") === by.replace(/\r\n/g, "\n")) notes.push("line endings (CRLF/LF)");
  return notes.join(" and ");
}

/** One entry's own diff (before -> after) as text; { diff: "", note } when only the
 *  line endings or the byte-order mark changed; null when its content was not stored. */
export function entryDiff(store, entry) {
  if (!entry || notRestorable(entry) && entry.before !== "absent") return null;
  if (!entry.after) return null;
  const before = entry.before === "absent" ? Buffer.alloc(0) : readBlob(store, entry.month, entry.before);
  const after = entry.after === "absent" ? Buffer.alloc(0) : readBlob(store, entry.month, entry.after);
  if (!before || !after) return null;
  const diff = diffText(before, after);
  const note = diff ? "" : changeNote(before, after);
  return note ? { diff: "", note } : diff;
}

/**
 * Write the restored content: a backup of the file as it is goes into the usual
 * backups folder first, then the file is replaced (temp file, rename). Returns
 * the backup path ("" when the file did not exist).
 */
export async function writeRestore(file, content, { env = process.env, now = new Date() } = {}) {
  let backup = "";
  if (existsSync(file)) {
    const bytes = await retry(() => readFileSync(file));
    const base = backupPathFor(file, env, now);
    mkdirSync(dirname(base), { recursive: true });
    // Two restores within one second: the next free name, never an overwrite.
    for (let n = 0; ; n++) {
      backup = n ? base.replace(/\.bak$/, `.${n}.bak`) : base;
      try { await retry(() => writeFileSync(backup, bytes, { flag: "wx" })); break; } catch (e) {
        if (!e || e.code !== "EEXIST" || n >= 50) throw e;
      }
    }
  }
  // A deleted file's folder may be gone too.
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.coop-restore-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    // A full disk mid-write leaves no temp file in the repository.
    writeFileSync(tmp, content);
    await retry(() => renameSync(tmp, file));
  } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
  return backup;
}

async function folderBytes(dir) {
  let total = 0;
  let names = [];
  try { names = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const d of names) {
    const p = join(dir, d.name);
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory()) total += await folderBytes(p);
    else { try { total += (await stat(p)).size; } catch { /* gone */ } }
  }
  return total;
}

/** True when the history root itself is a link or junction: then nothing in it is
 *  measured or removed (it could point at folders outside coop's own). */
async function rootIsLink(root) {
  try { return (await lstat(root)).isSymbolicLink(); } catch { return false; }
}

/** Every month folder of every store: [{ store, month, dir, bytes }], oldest first.
 *  Asynchronous, so a large store never holds up the session that measures it. */
export async function listMonths(root = historyRoot()) {
  const out = [];
  if (await rootIsLink(root)) return out;
  let stores = [];
  try { stores = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.isSymbolicLink()).map((d) => d.name); } catch { return out; }
  for (const store of stores) {
    for (const month of monthDirs(join(root, store))) out.push({ store, month, dir: join(root, store, month), bytes: await folderBytes(join(root, store, month)) });
  }
  return out.sort((a, b) => (a.month === b.month ? a.store.localeCompare(b.store) : a.month < b.month ? -1 : 1));
}

/** Keep the whole history under `cap` bytes: the oldest month folders go first,
 *  never the current month. Returns the folders removed. */
export async function enforceCap(root = historyRoot(), cap = CAP_BYTES, { now = new Date() } = {}) {
  const months = await listMonths(root);
  const current = monthOf(now);
  let total = months.reduce((n, m) => n + m.bytes, 0);
  const removed = [];
  for (const m of months) {
    if (total <= cap) break;
    if (m.month >= current) continue;
    try { await rm(m.dir, { recursive: true, force: true }); total -= m.bytes; removed.push(m); } catch { /* locked: next time */ }
  }
  return removed;
}

/** For doctor: { root, stores, months, bytes, cap, linked }. */
export async function historyStatus(root = historyRoot()) {
  const linked = await rootIsLink(root);
  const months = await listMonths(root);
  return { root, stores: new Set(months.map((m) => m.store)).size, months: months.length, bytes: months.reduce((n, m) => n + m.bytes, 0), cap: CAP_BYTES, linked };
}

/** "12 KB", "3.4 MB", "1.0 GB". */
export function sizeText(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** The /history list's lines for a store (newest first). */
export function historyLines(entries) {
  if (!entries.length) return ["No changes recorded for this repository yet."];
  return entries.map((e) => {
    const when = String(e.ts || "").replace("T", " ").slice(0, 16);
    const note = e.kind !== "file" ? "  (not restorable here)" : e.excluded ? `  (content not kept: ${e.excluded})` : "";
    return `  ${e.id}  ${when}  ${String(e.tool || "").padEnd(6)} ${e.target}  [${e.approval}]${e.result === "error" ? "  (failed)" : ""}${note}`;
  });
}

async function cli(argv) {
  const json = argv.includes("--json");
  const verb = argv.filter((a) => a !== "--json")[0] || "status";
  if (verb !== "status") { process.stderr.write("usage: node lib/action-history.mjs status [--json]\n"); return 2; }
  const s = await historyStatus();
  if (json) process.stdout.write(`${JSON.stringify(s).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`);
  else process.stdout.write(`Change history: ${s.months} month folder(s) in ${s.stores} repository store(s), ${sizeText(s.bytes)} of ${sizeText(s.cap)} (${s.root})\n`);
  return 0;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  cli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

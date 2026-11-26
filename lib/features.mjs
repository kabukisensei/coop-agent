// The Features list (FEATURES-DESIGN "Shared piece: one Features list") and the
// one writer of this client's ~/.coop/config.
//
// Every feature switch lives in ~/.coop/config (one Windows user is one client),
// starts off, and is on only when the file says `true`: missing, unreadable or
// anything else is off. There is no project-file or machine-wide override, so a
// teammate cannot switch a feature on for someone else.
//
// Every writer of ~/.coop/config goes through updateCoopConfig: the window's
// Settings (desktop/main.mjs imports this module and calls it directly),
// `coop settings` and `coop cleanup days|off` (PowerShell runs the CLI below),
// and /sql-source on|off (lib/sqlsc.mjs). It takes a short lock file
// (config.lock, create-new, 2 second wait), re-reads the file, applies the
// change, writes a temp file and renames it over, keeping every other key. A
// file that does not parse is reported and never overwritten.
//
// CLI:
//   node lib/features.mjs show [--json]
//   node lib/features.mjs set <key> on|off [--json]
//   node lib/features.mjs cleanup-days <N>        (0 turns the cleanup off)
//   each takes --file <config> (default: <profile dir>/config)
// Exit codes: 0 done, 1 the file could not be read or written, 2 usage.

import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath } from "./paths.mjs";

/**
 * The one list. `key` is the CLI key, `path` where ~/.coop/config stores it,
 * `takesEffect` the plain words the window and terminal show after a change.
 * `available: false` marks a feature this version does not carry yet: it is
 * listed (off) so every switch has its place, and it cannot be turned on.
 */
export const FEATURES = Object.freeze([
  { key: "instructions", label: "Client instructions", path: ["features", "instructions"], help: "Follow the client's saved instructions and corrections", takesEffect: "after /new", available: true },
  { key: "history", label: "Change history", path: ["features", "history"], help: "Keep a private log of coop's file edits, with restore", takesEffect: "after /new", available: false },
  { key: "comments", label: "Diff review comments", path: ["features", "comments"], help: "Comment on lines in Changes and send them as one batch", takesEffect: "at once", available: true },
  { key: "docs-refresh", label: "Daily lineage refresh", path: ["features", "docs_refresh"], help: "Refresh the dev lineage docs once a day, in the background", takesEffect: "at the next sign-in or coop start", available: false },
  // The existing key, unchanged; /sql-source on|off writes it through this module.
  { key: "sql-source", label: "SQL source control", path: ["sql_source_control", "enabled"], help: "Check out, script and commit SQL with approval", takesEffect: "after /new", available: true },
].map((f) => Object.freeze({ ...f, path: Object.freeze(f.path) })));

export const LOCK_WAIT_MS = 2000;
// A lock older than this was left by a writer that died; it is removed.
const STALE_LOCK_MS = 10_000;
const CLEANUP_DEFAULT_DAYS = 45;

export class ConfigUnreadableError extends Error {
  constructor(file, reason) {
    super(`${file} is not valid JSON (${reason}); coop left it as it is. Fix or remove it, then try again.`);
    this.name = "ConfigUnreadableError";
    this.file = file;
    this.reason = reason;
  }
}

/** The file is there but could not be opened (a lock, a permission): nothing to fix in its contents. */
export class ConfigIoError extends Error {
  constructor(file, reason) {
    super(`${file} could not be read (${reason}); coop left it as it is. Try again in a moment.`);
    this.name = "ConfigIoError";
    this.file = file;
    this.reason = reason;
  }
}

export class ConfigBusyError extends Error {
  constructor(file) {
    super(`another coop is changing ${file}; try again in a moment`);
    this.name = "ConfigBusyError";
    this.file = file;
  }
}

/** The feature for a CLI key (case-insensitive), or null. */
export function featureFor(key) {
  const want = String(key || "").trim().toLowerCase();
  return FEATURES.find((f) => f.key === want) || null;
}

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// The config's file calls, reachable so a test can play Windows' transient errors.
export const configFs = { openSync, writeSync, closeSync, readFileSync, statSync, unlinkSync };

// Windows refuses an open for a moment while another process holds the file
// (a writer's rename, an antivirus scan): EBUSY / EPERM / EACCES.
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
const READ_TRIES = 8;

/**
 * Read ~/.coop/config (or `file`): { ok, exists, data, error, errorKind }. A
 * UTF-8 BOM (Windows PowerShell 5.1's Set-Content writes one) is tolerated; an
 * empty file is an empty object. A file that does not parse, or is not a JSON
 * object, is { ok: false, errorKind: "parse" }; one that could not be opened,
 * after a few tries, { ok: false, errorKind: "io" }. Either way its data reads
 * as {} (every feature off).
 */
export function readCoopConfig(file = configPath()) {
  let text;
  for (let attempt = 1; ; attempt++) {
    try {
      text = configFs.readFileSync(file, "utf8");
      break;
    } catch (e) {
      if (e && e.code === "ENOENT") return { ok: true, exists: false, data: {}, error: "", errorKind: "" };
      if (attempt < READ_TRIES && e && TRANSIENT.has(e.code)) { sleep(15 * attempt); continue; }
      return { ok: false, exists: true, data: {}, error: String(e && e.message || e), errorKind: "io" };
    }
  }
  const body = String(text).replace(/^﻿/, "");
  if (!body.trim()) return { ok: true, exists: true, data: {}, error: "", errorKind: "" };
  try {
    const data = JSON.parse(body);
    if (!isObject(data)) return { ok: false, exists: true, data: {}, error: "the file is not a JSON object", errorKind: "parse" };
    return { ok: true, exists: true, data, error: "", errorKind: "" };
  } catch (e) {
    return { ok: false, exists: true, data: {}, error: String(e && e.message || e), errorKind: "parse" };
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}


// Windows answers a create-new on a lock file that is being deleted
// (DELETE_PENDING: another writer just released it while an antivirus scan or a
// reader still holds a handle) or scanned with EPERM / EACCES / EBUSY, not
// EEXIST: those mean "busy, try again", like EEXIST.
const LOCK_BUSY = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY"]);

/**
 * Create `path` only if it does not exist, holding `token`: true when created,
 * else the busy error (EEXIST, or a transient Windows refusal) to try again on.
 */
function createExclusive(path, token) {
  let fd;
  try {
    fd = configFs.openSync(path, "wx");
  } catch (e) {
    if (e && LOCK_BUSY.has(e.code)) return e;
    throw e;
  }
  try { configFs.writeSync(fd, token); } finally { configFs.closeSync(fd); }
  return true;
}

const isStale = (path) => {
  try { return Date.now() - configFs.statSync(path).mtimeMs > STALE_LOCK_MS; } catch { return false; }
};

// Break a lock a dead writer left. Two contenders may both see it stale; only
// the one that creates config.lock.break removes it, and only after checking
// again that it is still stale (the other may already have taken a fresh one).
// True when something was removed (try the lock again at once), false when
// another contender is breaking it (wait as for any held lock).
function breakStaleLock(lock, token) {
  const breaker = `${lock}.break`;
  if (createExclusive(breaker, token) !== true) {
    // A breaker that died mid-break: its marker ages out like a lock.
    if (!isStale(breaker)) return false;
    try { configFs.unlinkSync(breaker); return true; } catch { return false; }
  }
  try {
    if (isStale(lock)) configFs.unlinkSync(lock);
    return true;
  } catch { return true; /* gone meanwhile */ } finally {
    try { configFs.unlinkSync(breaker); } catch { /* already gone */ }
  }
}

/** Take config.lock: the owner token, or false when another writer held it for the whole wait. */
function takeLock(lock, waitMs) {
  const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const made = createExclusive(lock, token);
    if (made === true) return token;
    if (isStale(lock) && breakStaleLock(lock, token)) continue;
    if (Date.now() >= deadline) {
      // No lock file to wait for, yet create-new kept being refused: the folder
      // is not writable. Say that, not "another coop is changing it".
      if (made.code !== "EEXIST") { try { configFs.statSync(lock); } catch { throw made; } }
      return false;
    }
    sleep(10 + Math.floor(Math.random() * 15));
  }
}

/** Remove config.lock only if it still holds our token: a write that outlived the stale age may have lost it. */
function releaseLock(lock, token) {
  let held = "";
  try { held = configFs.readFileSync(lock, "utf8"); } catch { return; }
  if (held !== token) return;
  try { configFs.unlinkSync(lock); } catch { /* already gone */ }
}

// Windows refuses a rename over a file another process has open for a moment
// (a reader, an antivirus scan): try again briefly.
function renameOver(tmp, file) {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(tmp, file); return; } catch (e) {
      if (attempt >= 20 || !e || !["EPERM", "EACCES", "EBUSY"].includes(e.code)) throw e;
      sleep(25);
    }
  }
}

/**
 * Apply `change(data)` to ~/.coop/config under the lock, keeping every other
 * key. `change` mutates the object it gets or returns a replacement. Returns
 * the data written. Throws ConfigUnreadableError (file untouched),
 * ConfigBusyError (the lock was held for the whole wait) or a file error.
 */
export function updateCoopConfig(change, { file = configPath(), waitMs = LOCK_WAIT_MS } = {}) {
  const dir = dirname(resolve(file));
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "config.lock");
  const token = takeLock(lock, waitMs);
  if (token === false) throw new ConfigBusyError(file);
  try {
    const current = readCoopConfig(file);
    if (!current.ok) throw current.errorKind === "io" ? new ConfigIoError(file, current.error) : new ConfigUnreadableError(file, current.error);
    const data = current.data;
    const returned = change(data);
    let next = returned === undefined ? data : returned;
    if (!isObject(next)) throw new Error("a config change must leave a JSON object");
    // scripts/onboard.py and lib/mcp_config.py refuse a config without
    // schema_version 1: a file this writer creates (or one an older writer left
    // without it) is stamped; an explicit other version is kept as it is.
    if (next.schema_version === undefined) next = { schema_version: 1, ...next };
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      renameOver(tmp, file);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* not written */ }
      throw e;
    }
    return next;
  } finally {
    releaseLock(lock, token);
  }
}

function valueAt(data, path) {
  let cur = data;
  for (const part of path) {
    if (!isObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** True only when the stored value is exactly `true`. */
export function isFeatureOn(key, data) {
  const feature = featureFor(key);
  return Boolean(feature && feature.available && valueAt(data, feature.path) === true);
}

/** Read one switch from ~/.coop/config (or `file`): false unless it is `true`. */
export function featureEnabled(key, file = configPath()) {
  return isFeatureOn(key, readCoopConfig(file).data);
}

/**
 * Turn one feature on or off. Returns the state written. Throws for an unknown
 * key (code "unknown"), a feature this version does not carry (code
 * "unavailable"), and the errors of updateCoopConfig.
 */
export function setFeature(key, on, { file = configPath(), now = new Date(), waitMs } = {}) {
  const feature = featureFor(key);
  if (!feature) {
    const e = new Error(`unknown feature '${String(key)}'; one of: ${FEATURES.map((f) => f.key).join(", ")}`);
    e.code = "unknown";
    throw e;
  }
  const want = on === true;
  if (want && !feature.available) {
    const e = new Error(`${feature.label} is not in this version of coop yet`);
    e.code = "unavailable";
    throw e;
  }
  updateCoopConfig((data) => {
    const [block, leaf] = feature.path;
    const prior = isObject(data[block]) ? data[block] : {};
    data[block] = feature.key === "sql-source"
      ? { ...prior, [leaf]: want, changed_at: now.toISOString() }
      : { ...prior, [leaf]: want };
  }, { file, ...(waitMs === undefined ? {} : { waitMs }) });
  return want;
}

/** The cleanup age in days (0: off), read as Get-CoopCleanupDays reads it. */
export function cleanupDays(data) {
  const raw = valueAt(data, ["cleanup", "days"]);
  if (raw === undefined || raw === null) return CLEANUP_DEFAULT_DAYS;
  const text = String(raw).trim();
  if (!/^[+-]?\d+$/.test(text)) return CLEANUP_DEFAULT_DAYS;
  const n = Number(text);
  return n >= 0 && n <= 3650 ? n : CLEANUP_DEFAULT_DAYS;
}

/** Save the cleanup age (0 to 3650 days; 0 turns it off), keeping every other key. */
export function setCleanupDays(days, { file = configPath(), waitMs } = {}) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 0 || n > 3650) throw Object.assign(new Error("the cleanup age is 0 to 3650 days"), { code: "usage" });
  updateCoopConfig((data) => { data.cleanup = { ...(isObject(data.cleanup) ? data.cleanup : {}), days: n }; }, { file, ...(waitMs === undefined ? {} : { waitMs }) });
  return n;
}

/**
 * Every feature with its state, for the window, `coop settings` and doctor:
 * { file, ok, error, features: [{ key, label, help, on, available, takesEffect, stored }], cleanup: { days } }.
 */
export function listFeatures({ file = configPath() } = {}) {
  const config = readCoopConfig(file);
  return {
    file,
    ok: config.ok,
    error: config.error,
    errorKind: config.errorKind,
    features: FEATURES.map((f) => ({
      key: f.key,
      label: f.label,
      help: f.help,
      on: isFeatureOn(f.key, config.data),
      available: f.available,
      takesEffect: f.takesEffect,
      stored: f.path.join("."),
    })),
    cleanup: { days: cleanupDays(config.data) },
  };
}

/** The one session-start line naming the features that are on ("" when none). */
export function featuresOnLine(list = listFeatures()) {
  const on = list.features.filter((f) => f.on).map((f) => f.label);
  return on.length ? `Features on for this client: ${on.join(", ")}.` : "";
}

/** The Features block `node lib/features.mjs show` and `coop settings` print. */
export function featureRows(list) {
  return list.features.map((f) => `  ${f.label.padEnd(24)}${(f.on ? "on" : "off").padEnd(5)}${f.key}${f.available ? "" : "  (not in this version yet)"}`);
}

/** Why every feature reads as off, for `show`, `coop settings` and doctor. */
export function unreadableNote(list) {
  return list.errorKind === "io"
    ? `  ${list.file} could not be read just now (${list.error}); every feature reads as off. Try again in a moment.`
    : `  ${list.file} is not valid JSON (${list.error}); every feature reads as off and coop leaves the file as it is.`;
}

/** What a change says, in the window and the terminal. */
export function changedText(feature, on) {
  const when = feature.takesEffect === "at once" ? "applies at once in the window's Changes pane"
    : feature.takesEffect === "after /new" ? "takes effect after /new or a restart"
    : `takes effect ${feature.takesEffect}`;
  return `${feature.label} is ${on ? "on" : "off"} for this client (${when}).`;
}

function cli(argv) {
  const json = argv.includes("--json");
  // --file <path>: the config file to use (PowerShell passes Get-CoopConfigFile,
  // so both name the same file); else <profile dir>/config.
  const at = argv.indexOf("--file");
  const file = at >= 0 ? argv[at + 1] : configPath();
  // COOP_CONFIG_LOCK_WAIT_MS: how long to wait for config.lock (default 2 s);
  // scripts/onboard.py reads the same variable.
  const envWait = Number.parseInt(process.env.COOP_CONFIG_LOCK_WAIT_MS || "", 10);
  const waitMs = Number.isInteger(envWait) && envWait >= 0 ? envWait : LOCK_WAIT_MS;
  const args = argv.filter((a, i) => a !== "--json" && !(at >= 0 && (i === at || i === at + 1)));
  // JSON goes out as ASCII (\uXXXX for anything else): PowerShell decodes a
  // child's output in the console's code page, which is not UTF-8 everywhere
  // (Windows PowerShell 5.1 without a console), and a profile path may not be ASCII.
  const asciiJson = (value) => JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const out = (value) => process.stdout.write(`${typeof value === "string" ? value : asciiJson(value)}\n`);
  const fail = (code, message) => {
    if (json) out({ ok: false, error: message });
    else process.stderr.write(`${message}\n`);
    return code;
  };
  const usage = "usage: node lib/features.mjs show [--json] | set <key> on|off [--json] | cleanup-days <N>   (each takes --file <config>)";
  const verb = args[0] || "show";
  // --file with no value must not fall back to the real profile's config.
  if (at >= 0 && (!file || file.startsWith("--"))) return fail(2, `--file needs a path; ${usage}`);
  try {
    if (verb === "show" && args.length <= 1) {
      const list = listFeatures({ file });
      if (json) { out(list); return 0; }
      const lines = [`Features for this client (${list.file})`];
      if (!list.ok) lines.push(unreadableNote(list));
      out([...lines, ...featureRows(list)].join("\n"));
      return 0;
    }
    if (verb === "set" && args.length === 3 && ["on", "off"].includes(String(args[2]).toLowerCase())) {
      const feature = featureFor(args[1]);
      if (!feature) return fail(2, `unknown feature '${args[1]}'; one of: ${FEATURES.map((f) => f.key).join(", ")}`);
      const on = setFeature(feature.key, String(args[2]).toLowerCase() === "on", { file, waitMs });
      if (json) out({ ok: true, key: feature.key, on, text: changedText(feature, on) });
      else out(changedText(feature, on));
      return 0;
    }
    if (verb === "cleanup-days" && args.length === 2 && /^\d+$/.test(args[1])) {
      const days = setCleanupDays(Number(args[1]), { file, waitMs });
      if (json) out({ ok: true, days });
      return 0;
    }
    return fail(2, usage);
  } catch (e) {
    if (e && (e.code === "unknown" || e.code === "usage")) return fail(2, e.message);
    if (e && e.code === "unavailable") return fail(2, `${e.message}; it stays off.`);
    return fail(1, String(e && e.message || e));
  }
}

// Run as a program? Compare canonical paths: PowerShell may start node with a
// different letter case, a short (8.3) name or through a link, and a plain string
// compare would then exit 0 having done nothing (Set-CoopCleanupDays would
// report a save that never happened).
function canonical(path) {
  let out = resolve(path);
  try { out = realpathSync.native(out); } catch { try { out = realpathSync(out); } catch { /* keep the resolved path */ } }
  return process.platform === "win32" ? out.toLowerCase() : out;
}
export function isMainModule(argv1, moduleUrl = import.meta.url) {
  return Boolean(argv1) && canonical(argv1) === canonical(fileURLToPath(moduleUrl));
}

if (isMainModule(process.argv[1])) {
  process.exitCode = cli(process.argv.slice(2));
}

// For tests: the CLI without a process.
export { cli as runCli };

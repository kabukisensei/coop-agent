// Session lineage context (master plan SQ8): coop holds the downstream of every
// SQL object it is about to change, filled once per object from the cheapest
// fresh source, and never re-runs a lookup it already holds.
//
// The store is one JSON file per Pi process under the agent dir
// (lineage-context/<pid>.json), because coop-tools fills it (tool results, the
// snapshot scan, the built docs) and coop-guardrails reads it (the gate before
// a SQL edit); the two extensions share a process but not a module instance.
// Entries are keyed by the lower-cased "schema.name"; a session switch
// (/new, /resume) clears the file.
//
// Sources, cheapest first: the committed catalog snapshot (SQ9, local files),
// the built lineage docs (coop-data-doc lineage, local), the live catalog
// (sql_impact, a connection). An entry records which sources answered, so the
// gate knows whether a live lookup is still owed.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { agentDir } from "./paths.mjs";
import { projectYamlScalar, repositoryNames } from "./project-contract.mjs";
import { findProjectContract } from "./standards.mjs";

export const DEFAULT_MAX_AGE_DAYS = 7;
const MAX_SNAPSHOT_FILES = 5000;
const MAX_FILE_CHARS = 1_000_000;
const SQL_KINDS = /^(table|view|procedure|function)$/i;

// --- the store ------------------------------------------------------------------

export function contextPath(env = process.env, pid = process.pid) {
  return join(agentDir(env), "lineage-context", `${pid}.json`);
}

/** @returns {{ entries: Record<string, any> }} */
export function readContext(path = contextPath()) {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data && typeof data === "object" && data.entries && typeof data.entries === "object") return data;
  } catch { /* missing or unreadable: empty */ }
  return { entries: {} };
}

export function writeContext(data, path = contextPath()) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data), "utf8");
  } catch { /* best effort: the context is an aid */ }
}

export function clearContext(path = contextPath()) {
  try { unlinkSync(path); } catch { /* already gone */ }
}

/** Drop stale context files of Pi processes that no longer exist. */
export function pruneContexts(env = process.env, isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }) {
  const dir = join(agentDir(env), "lineage-context");
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const pid = Number(name.replace(/\.json$/, ""));
    if (!Number.isFinite(pid) || pid === process.pid || isAlive(pid)) continue;
    try { rmSync(join(dir, name), { force: true }); } catch { /* best effort */ }
  }
}

export function normalizeObject(name) {
  const clean = String(name || "").trim().replace(/[\[\]"]/g, "");
  if (!clean) return "";
  const parts = clean.split(".").filter(Boolean);
  if (parts.length === 1) return `dbo.${parts[0]}`.toLowerCase();
  return parts.slice(-2).join(".").toLowerCase();
}

/**
 * A source's state for one object: "hit" (it answered with the object), "miss"
 * (it exists but lacks the object), "stale" (the snapshot answered but is older
 * than the contract's max_age_days, so a live lookup is still owed), "absent"
 * (the source does not exist here, or was never asked).
 * @typedef {"hit" | "miss" | "stale" | "absent"} SourceState
 * @typedef {{ name: string, kind: string, columns?: string[], via?: string }} Downstream
 * @typedef {{
 *   object: string, kind?: string, columns?: string[],
 *   downstream: Downstream[],
 *   sources: { snapshot: SourceState, docs: SourceState, live: SourceState },
 *   updatedAt: string,
 * }} LineageEntry
 */

/** @returns {LineageEntry | null} */
export function getEntry(object, path = contextPath()) {
  const key = normalizeObject(object);
  if (!key) return null;
  return readContext(path).entries[key] || null;
}

/** Merge one source's answer into the object's entry (a later source never
 *  erases what an earlier one found; the same dependent is listed once, with
 *  the union of the columns each source saw). */
export function recordLineage(object, source, found, { path = contextPath(), status, kind } = {}) {
  const key = normalizeObject(object);
  if (!key) return null;
  const data = readContext(path);
  const entry = data.entries[key] || { object: key, downstream: [], sources: { snapshot: "absent", docs: "absent", live: "absent" }, updatedAt: "" };
  entry.sources[source] = status || (found ? "hit" : "miss");
  if (kind && (!entry.kind || entry.kind === "unknown")) entry.kind = kind;
  if (found) {
    if (found.kind) entry.kind = found.kind;
    if (Array.isArray(found.columns) && found.columns.length) entry.columns = found.columns;
    for (const dep of found.downstream || []) {
      const depKey = String(dep.name || "").toLowerCase();
      if (!depKey) continue;
      const existing = entry.downstream.find((d) => d.name.toLowerCase() === depKey);
      if (existing) {
        if (!existing.kind && dep.kind) existing.kind = dep.kind;
        if (dep.columns?.length) existing.columns = Array.from(new Set([...(existing.columns || []), ...dep.columns]));
        if (!existing.via && dep.via) existing.via = dep.via;
      } else {
        entry.downstream.push({ name: dep.name, kind: dep.kind || "unknown", ...(dep.columns?.length ? { columns: dep.columns } : {}), ...(dep.via ? { via: dep.via } : {}) });
      }
    }
  }
  entry.updatedAt = new Date().toISOString();
  data.entries[key] = entry;
  writeContext(data, path);
  return entry;
}

// --- the SQL object a file edit is about -----------------------------------------

const CREATE_RE = /\bcreate\s+(?:or\s+alter\s+)?(view|table|procedure|proc|function)\s+(?:\[?([A-Za-z_][\w@#$]*)\]?\s*\.\s*)?\[?([A-Za-z_][\w@#$]*)\]?/i;

/** The SQL object a .sql file defines: from its CREATE statement, else from the
 *  snapshot layout (<schema>/<name>.sql), else dbo.<file stem>. */
export function sqlObjectFromFile(filePath, content) {
  if (!/\.sql$/i.test(String(filePath || ""))) return null;
  let text = typeof content === "string" ? content : "";
  if (!text) {
    try { text = readFileSync(filePath, "utf8").slice(0, MAX_FILE_CHARS); } catch { text = ""; }
  }
  const m = CREATE_RE.exec(text);
  if (m) {
    const kind = m[1].toLowerCase() === "proc" ? "procedure" : m[1].toLowerCase();
    return { object: `${m[2] || "dbo"}.${m[3]}`.toLowerCase(), kind };
  }
  const stem = basename(filePath).replace(/\.sql$/i, "");
  const parentName = basename(dirname(filePath));
  const schema = /^[A-Za-z_][\w@#$]*$/.test(parentName) && parentName !== "." ? parentName : "dbo";
  return { object: `${schema}.${stem}`.toLowerCase(), kind: "unknown" };
}

// --- the committed catalog snapshot as a source (SQ9) -----------------------------

function isTodo(value) {
  return !value || /^todo/i.test(String(value).trim());
}

/** The snapshot folder the contract names: catalog.path, else the data_docs
 *  repository's catalog/<env>, else .coop/catalog/<env> beside the contract.
 *  Shared with coop-tools (status, session note) and the snapshot scan here. */
export function catalogSnapshotFolder(contractPath, text) {
  const root = dirname(dirname(contractPath));
  const env = (projectYamlScalar(text, ["sql_targets", "default_environment"]) || "dev").trim().toLowerCase();
  const environment = env === "test" ? "test" : "dev";
  const rawAge = parseInt(projectYamlScalar(text, ["catalog", "max_age_days"]) || "", 10);
  const maxAgeDays = Number.isFinite(rawAge) && rawAge > 0 ? rawAge : DEFAULT_MAX_AGE_DAYS;
  const configured = projectYamlScalar(text, ["catalog", "path"]);
  if (!isTodo(configured)) return { folder: resolve(root, configured.trim()), environment, maxAgeDays };
  for (const name of repositoryNames(text)) {
    const role = (projectYamlScalar(text, ["repositories", name, "role"]) || "").trim().toLowerCase().replace(/-/g, "_");
    const localPath = projectYamlScalar(text, ["repositories", name, "local_path"]);
    if (role === "data_docs" && !isTodo(localPath)) {
      const expanded = localPath.trim().replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || "~");
      return { folder: resolve(root, expanded, "catalog", environment), environment, maxAgeDays };
    }
  }
  return { folder: join(root, ".coop", "catalog", environment), environment, maxAgeDays };
}

/** Nearest .coop/project.yml walking up from cwd, or null. */
export function findContractAbove(cwd) {
  let dir = resolve(cwd || ".");
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, ".coop", "project.yml");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function listSqlFiles(folder, out = []) {
  let names = [];
  try { names = readdirSync(folder, { withFileTypes: true }); } catch { return out; }
  for (const entry of names) {
    if (out.length >= MAX_SNAPSHOT_FILES) break;
    const full = join(folder, entry.name);
    if (entry.isDirectory()) listSqlFiles(full, out);
    else if (/\.sql$/i.test(entry.name)) out.push(full);
  }
  return out;
}

function columnsFromTableFile(text) {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return [];
  const cols = [];
  for (const line of text.slice(open + 1, close).split(/\r?\n/)) {
    const m = /^\s*\[([^\]]+)\]\s+\S/.exec(line);
    if (m) cols.push(m[1]);
  }
  return cols;
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when the SQL text names schema.name (bracketed or not; dbo may be
 *  omitted) outside its own CREATE statement. */
function mentions(text, schema, name) {
  const n = escapeRe(name);
  const s = escapeRe(schema);
  const qualified = new RegExp(`\\[?${s}\\]?\\s*\\.\\s*\\[?${n}\\]?(?![\\w@#$])`, "i");
  if (qualified.test(text)) return true;
  if (schema.toLowerCase() === "dbo") {
    const bare = new RegExp(`(?<![\\w@#$.\\]])\\[?${n}\\]?(?![\\w@#$])`, "i");
    return bare.test(text);
  }
  return false;
}

/**
 * Scan the committed catalog snapshot for one object: its kind and columns from
 * its own file, and every snapshot object whose definition names it, with the
 * object's columns that definition mentions. Returns null when the snapshot is
 * absent or has no file for the object.
 * @returns {{ found: { kind: string, columns: string[], downstream: Downstream[] } | null, state: "absent" | "stale" | "ok", folder?: string, ageDays?: number }}
 */
export function snapshotLineage(cwd, object, now = Date.now()) {
  // Above cwd, else the client home repository beside it that lists it (C1).
  const contractPath = findContractAbove(cwd) || findProjectContract(cwd);
  if (!contractPath) return { found: null, state: "absent" };
  let text = "";
  try { text = readFileSync(contractPath, "utf8"); } catch { return { found: null, state: "absent" }; }
  const { folder, maxAgeDays } = catalogSnapshotFolder(contractPath, text);
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")); } catch { manifest = null; }
  if (!manifest || manifest.coop_catalog_snapshot !== true) return { found: null, state: "absent" };
  const taken = Date.parse(String(manifest.taken_at || ""));
  const ageDays = Number.isFinite(taken) ? Math.max(0, (now - taken) / 86_400_000) : Number.POSITIVE_INFINITY;
  const state = ageDays > maxAgeDays ? "stale" : "ok";
  const key = normalizeObject(object);
  const [schema, name] = key.split(".");
  const ownFile = join(folder, schema, `${name}.sql`);
  let own = "";
  const files = listSqlFiles(folder);
  const ownHit = files.find((f) => f.toLowerCase() === ownFile.toLowerCase());
  if (ownHit) {
    try { own = readFileSync(ownHit, "utf8").slice(0, MAX_FILE_CHARS); } catch { own = ""; }
  }
  if (!own) return { found: null, state, folder, ageDays: Math.round(ageDays * 10) / 10 };
  const kindMatch = /^-- coop catalog snapshot: (\w+)/m.exec(own);
  const kind = kindMatch ? kindMatch[1].toLowerCase() : (sqlObjectFromFile(ownHit, own)?.kind || "unknown");
  const columns = kind === "table" || /^-- VIEW/m.test(own) ? columnsFromTableFile(own) : [];
  const downstream = [];
  for (const file of files) {
    if (file === ownHit) continue;
    let body = "";
    try { body = readFileSync(file, "utf8").slice(0, MAX_FILE_CHARS); } catch { continue; }
    const defn = body.replace(/^--.*$/gm, "");
    if (!mentions(defn, schema, name)) continue;
    const depSchema = basename(dirname(file));
    const depName = basename(file).replace(/\.sql$/i, "");
    const depKindMatch = /^-- coop catalog snapshot: (\w+)/m.exec(body);
    const depKind = depKindMatch ? depKindMatch[1].toLowerCase() : "unknown";
    const used = columns.filter((col) => new RegExp(`(?<![\\w@#$])\\[?${escapeRe(col)}\\]?(?![\\w@#$])`, "i").test(defn));
    downstream.push({ name: `${depSchema}.${depName}`, kind: depKind, ...(used.length ? { columns: used } : {}) });
  }
  return { found: { kind, columns, downstream }, state, folder, ageDays: Math.round(ageDays * 10) / 10 };
}

// --- the other sources, normalized -------------------------------------------------

/** sql_impact's result (lib/sql_impact.py) as a source answer, or null when it
 *  did not resolve the object. */
export function lineageFromSqlImpact(details) {
  if (!details?.ok || !details.object) return null;
  const downstream = [];
  for (const item of details.downstream?.items || []) {
    const name = [item.schema, item.name].filter(Boolean).join(".");
    if (!name) continue;
    const columns = Array.isArray(item.columns) ? item.columns.filter((c) => typeof c === "string") : [];
    downstream.push({ name, kind: typeKind(item.type), ...(columns.length ? { columns } : {}) });
  }
  const columns = (details.columns?.items || []).map((c) => c.name).filter((c) => typeof c === "string");
  return { kind: typeKind(details.object.type), columns, downstream };
}

function typeKind(type) {
  const t = String(type || "").toUpperCase();
  if (t.includes("TABLE") && !t.includes("FUNCTION")) return "table";
  if (t.includes("VIEW")) return "view";
  if (t.includes("PROCEDURE")) return "procedure";
  if (t.includes("FUNCTION")) return "function";
  return t ? t.toLowerCase() : "unknown";
}

/** coop-data-doc's lineage slice as a source answer (downstream objects plus the
 *  Power BI tables that load the object, each as "via" the table), or null when
 *  the slice is ambiguous or empty. */
export function lineageFromDocs(parsed) {
  if (!parsed || parsed.ambiguous) return null;
  // An object the docs do not hold can still be named by a Power BI partition
  // (undocumented_source + loaded_by): that is its Power BI blast radius.
  if (!parsed.object && !(Array.isArray(parsed.loaded_by) && parsed.loaded_by.length)) return null;
  const downstream = [];
  for (const item of parsed.downstream || []) {
    const name = item?.name || item?.id;
    if (name) downstream.push({ name: String(name), kind: String(item.kind || item.type || "unknown").toLowerCase() });
  }
  for (const hit of parsed.loaded_by || []) {
    const table = hit?.table ?? hit;
    const name = table?.name || table?.id;
    if (name) downstream.push({ name: String(name), kind: "power bi table", via: "loads it by name" });
  }
  const kind = String(parsed.object?.kind || parsed.object?.type || "unknown").toLowerCase();
  return { kind, columns: [], downstream };
}

// --- what the model and the user see ---------------------------------------------

/** One line for the edit summary: every downstream object and the follow-on
 *  edit it would need. */
export function summaryLine(entry) {
  if (!entry) return "";
  const deps = entry.downstream || [];
  if (!deps.length) {
    const looked = Object.entries(entry.sources).filter(([, v]) => v !== "absent").map(([k]) => k);
    return `Downstream of ${entry.object}: none found (${looked.length ? looked.join(", ") + " checked" : "no lineage source"}); an empty result is not proof of zero impact.`;
  }
  const parts = deps.slice(0, 12).map((d) => `${d.name} (${d.kind}${d.columns?.length ? `, uses ${d.columns.slice(0, 6).join(", ")}${d.columns.length > 6 ? "…" : ""}` : ""}${d.via ? `, ${d.via}` : ""})`);
  const more = deps.length > 12 ? `, and ${deps.length - 12} more` : "";
  return `Downstream of ${entry.object}: ${parts.join("; ")}${more}. A renamed or removed column breaks each one that uses it; an added column reaches them only when each is updated. /impact shows the detail.`;
}

/** The detail lines for /impact. */
export function detailLines(entry) {
  if (!entry) return [];
  const lines = [`${entry.object}${entry.kind ? ` (${entry.kind})` : ""}`];
  lines.push(`sources: snapshot ${entry.sources.snapshot}, built docs ${entry.sources.docs}, live catalog ${entry.sources.live}`);
  if (entry.columns?.length) lines.push(`columns: ${entry.columns.join(", ")}`);
  if (!entry.downstream?.length) lines.push("downstream: none found (not proof of zero impact)");
  for (const d of entry.downstream || []) {
    lines.push(`- ${d.name} (${d.kind})${d.columns?.length ? `: uses ${d.columns.join(", ")}` : ""}${d.via ? ` (${d.via})` : ""}`);
  }
  return lines;
}

/** True when the entry is enough to let a SQL edit through: some source answered,
 *  or every source that exists was tried (a miss everywhere with a live target
 *  untried is not enough). */
export function entryCoversEdit(entry, { liveTarget }) {
  if (!entry) return false;
  const s = entry.sources;
  if (s.snapshot === "hit" || s.docs === "hit" || s.live === "hit") return true;
  if (liveTarget && s.live === "absent") return false;
  return true;
}

// --- the edit itself ---------------------------------------------------------------

/**
 * Fill the context for the SQL object a file edit is about, from the committed
 * snapshot, unless the context already holds that source's answer. Returns the
 * object and its entry, or null when the file is not a .sql file.
 * @returns {{ object: string, kind: string, entry: LineageEntry } | null}
 */
export function prepareEditContext(cwd, filePath, content, { path = contextPath(), now = Date.now() } = {}) {
  const target = sqlObjectFromFile(filePath, content);
  if (!target) return null;
  let entry = getEntry(target.object, path);
  if (!entry || entry.sources.snapshot === "absent") {
    const scan = snapshotLineage(cwd, target.object, now);
    let status = "absent";
    if (scan.state !== "absent") status = scan.found ? (scan.state === "stale" ? "stale" : "hit") : "miss";
    entry = recordLineage(target.object, "snapshot", scan.found, { path, status, kind: target.kind });
  }
  return { object: target.object, kind: entry.kind || target.kind, entry };
}

/**
 * The guardrails' decision for an edit or write of a SQL file: the lookup must
 * have happened before the edit. "allow" when some source holds the object, when
 * every source that exists was tried, or when the file defines no object coop can
 * name (no CREATE statement and no source knows the stem); "block" when a live
 * target could still answer and was never asked.
 * @returns {{ action: "allow" | "block", object?: string, reason?: string }}
 */
export function editGateDecision(cwd, filePath, content, { liveTarget, path = contextPath(), now = Date.now() } = {}) {
  const prepared = prepareEditContext(cwd, filePath, content, { path, now });
  if (!prepared) return { action: "allow" };
  const { object, kind, entry } = prepared;
  if (entryCoversEdit(entry, { liveTarget })) return { action: "allow", object };
  if (kind === "unknown" && !entry.downstream.length) return { action: "allow", object };
  const s = entry.sources;
  const tried = [
    `snapshot ${s.snapshot === "stale" ? "stale" : s.snapshot === "absent" ? "none" : s.snapshot}`,
    `built docs ${s.docs === "absent" ? "none" : s.docs}`,
    "live catalog not asked",
  ].join(", ");
  return {
    action: "block",
    object,
    reason: `coop does not yet hold the downstream of ${object} (${tried}). Call sql_impact with object "${object}" first (and data_doc lineage when built docs exist); the edit then goes through without asking again this session.`,
  };
}

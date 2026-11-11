// The standards pane's data (master plan D1b2): the coop-standards articles
// coop resolves for this folder, read through lib/standards-cli.mjs exactly as
// a task pins them (`resolve-many`, which also refreshes a stale canonical
// copy), with source and freshness from `status`. Read-only: the pane shows
// the resolved snapshot each domain feeds the model, never a second copy.
//
// The same `status` names the team knowledge repositories coop keeps next to
// the standards (cooptimize/incremental-bi, the approved patterns, and
// cooptimize/coop-team-knowledge, the TeamAI team share): the pane lists each
// clone's notes and reads one at a time, the clone the team-knowledge skill
// searches, never a copy.
//
// The `source` domain is the wiki's Source Systems articles (D365 F&O and
// Dataverse for every Cooptimize client): tasks get the ones that fit the
// project's `source_systems` (both D365 systems when the key is absent, none for
// `[]`), so the pane lists exactly those, or shows the domain as off.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { sourceArticleFits } from "../../lib/standards.mjs";

export const DOMAINS = Object.freeze(["sql", "dax", "semantic_model", "fabric", "documentation", "source"]);
export const DOMAIN_LABELS = Object.freeze({ sql: "SQL", dax: "DAX", semantic_model: "Semantic model", fabric: "Fabric", documentation: "Documentation", source: "Source systems" });
export const KNOWLEDGE_LABELS = Object.freeze({ "cooptimize/incremental-bi": "Incremental BI", "cooptimize/coop-team-knowledge": "Team knowledge" });
const MAX_SNAPSHOT = 2 * 1024 * 1024;
const MAX_NOTES = 400;
const MAX_TITLE_BYTES = 4096;

function runCli({ node, cli, args, cwd, env, execFileImpl = execFile }) {
  return new Promise((resolve, reject) => {
    execFileImpl(node, [cli, ...args], { cwd, env, windowsHide: true, timeout: 90_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) { reject(new Error(String(stderr || error.message).trim().split("\n").pop() || "the standards resolver failed")); return; }
      try { resolve(JSON.parse(String(stdout))); } catch { reject(new Error("the standards resolver returned no result")); }
    });
  });
}

const text = (value) => (typeof value === "string" ? value : "");

/** The pane's summary of one domain's resolution (no paths cross to the window). */
export function domainView(domain, resolution) {
  const r = resolution && typeof resolution === "object" ? resolution : {};
  const articles = Array.isArray(r.articles) ? r.articles : [];
  return {
    domain,
    label: DOMAIN_LABELS[domain] || domain,
    state: text(r.state) || "unavailable",
    authority: text(r.authority_class),
    source: text(r.source),
    revision: text(r.revision || r.commit).slice(0, 12),
    branch: text(r.branch),
    fallback: Boolean(r.fallback),
    degraded: Boolean(r.degraded),
    available: Boolean(r.path),
    articles: articles.map((a) => ({ id: text(a.id), title: text(a.title) || text(a.file), file: text(a.file), layer: text(a.layer), technology: text(a.technology) })),
  };
}

/**
 * The source domain as a task sees it: only the articles that fit the project's
 * source systems, named "D365 source" when every system is a D365 one, and off
 * (not selectable) when the project turns source systems off. `systems` is null
 * when an older resolver could not say: the domain is then shown unfiltered.
 */
export function sourceDomainView(view, systems) {
  if (!Array.isArray(systems)) return view;
  if (!systems.length) return { ...view, state: "off", available: false, articles: [] };
  const label = systems.every((s) => s === "d365" || s.startsWith("d365_")) ? "D365 source" : view.label;
  return { ...view, label, articles: view.articles.filter((a) => sourceArticleFits(a, systems)) };
}

/** The pane's summary of `standards-cli.mjs status`. */
export function sourceView(status) {
  const s = status && typeof status === "object" ? status : {};
  const bundle = s.bundle && typeof s.bundle === "object" ? s.bundle : {};
  return {
    repository: text(s.repository),
    branch: text(s.authoritative_branch),
    freshness: text(s.freshness) || "unknown",
    degraded: Boolean(s.degraded),
    lastCheckMs: Number.isFinite(s.last_successful_check_ms) ? s.last_successful_check_ms : null,
    lastAttemptOk: s.last_attempt_ok !== false,
    detail: text(s.detail),
    bundle: { state: text(bundle.state) || "unavailable", revision: text(bundle.revision).slice(0, 12), capturedMs: Number.isFinite(bundle.captured_ms) ? bundle.captured_ms : null },
  };
}

/** A note's title: its `title:` front matter, else its first `# ` heading, else its file name. */
function noteTitle(path, rel) {
  let head = "";
  try { head = readFileSync(path).subarray(0, MAX_TITLE_BYTES).toString("utf8").replace(/^\uFEFF/, ""); } catch { /* unreadable: named by its file */ }
  const front = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(head);
  const title = front && /^title:[ \t]*(.+)$/m.exec(front[1]);
  if (title) return title[1].trim().replace(/^(["'])(.*)\1$/, "$2").trim() || rel;
  const heading = /^#[ \t]+(.+)$/m.exec(front ? head.slice(front[0].length) : head);
  if (heading) return heading[1].trim();
  return rel.split("/").pop().replace(/\.md$/i, "");
}

/**
 * The Markdown notes of one knowledge clone, in folder order, bounded: dot
 * folders and node_modules are skipped, and a listing stops at MAX_NOTES. Paths
 * are relative to the clone with forward slashes, the way the terminal's
 * team-knowledge skill cites them.
 */
export function listNotes(root, { readdirImpl = readdirSync } = {}) {
  const notes = [];
  const walk = (dir, prefix) => {
    if (notes.length >= MAX_NOTES) return;
    let entries;
    try { entries = readdirImpl(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (notes.length >= MAX_NOTES) break;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) notes.push({ path: rel, title: noteTitle(join(dir, entry.name), rel), folder: prefix });
    }
  };
  walk(root, "");
  return { notes, truncated: notes.length >= MAX_NOTES };
}

/** The pane's summary of one knowledge repository from `status.sources` (no paths cross to the window). */
export function knowledgeView(source, listing) {
  const s = source && typeof source === "object" ? source : {};
  const id = text(s.id);
  const available = Boolean(s.path) && s.state !== "unavailable";
  const l = available && listing ? listing : { notes: [], truncated: false };
  return {
    id,
    label: KNOWLEDGE_LABELS[id] || id.replace(/^cooptimize\//, ""),
    authority: text(s.authority_class),
    state: available ? text(s.state) || "available" : "unavailable",
    revision: text(s.revision).slice(0, 12),
    available,
    notes: l.notes.map((n) => ({ path: n.path, title: n.title, folder: n.folder })),
    truncated: Boolean(l.truncated),
  };
}

/**
 * Resolve every domain for the folder. Returns { source, domains, snapshots,
 * keep, knowledge, roots } where snapshots maps a domain to the resolved snapshot's
 * path, keep maps a domain shown with only some of its articles (source) to the
 * titles to read from that snapshot, and roots maps a knowledge repository id to its clone (both kept in
 * main; the window asks for a domain's text by name and a note by its path).
 */
export async function readStandards({ node, repoRoot, cwd, env, execFileImpl, readdirImpl }) {
  const cli = join(repoRoot, "lib", "standards-cli.mjs");
  // Resolve first: it refreshes a stale canonical copy, which status then reports.
  const resolved = await runCli({ node, cli, args: ["resolve-many", DOMAINS.join(","), cwd], cwd, env, execFileImpl });
  const [status, systems] = await Promise.all([
    runCli({ node, cli, args: ["status"], cwd, env, execFileImpl }).catch(() => ({})),
    runCli({ node, cli, args: ["source-systems", cwd], cwd, env, execFileImpl }).then((s) => (Array.isArray(s) ? s.filter((x) => typeof x === "string") : null), () => null),
  ]);
  const snapshots = new Map();
  const keep = new Map();
  const domains = DOMAINS.map((domain) => {
    const resolution = resolved[domain];
    let view = domainView(domain, resolution);
    if (domain === "source") {
      const all = view.articles.length;
      view = sourceDomainView(view, systems);
      if (view.available && view.articles.length < all) keep.set(domain, view.articles.map((a) => a.title));
    }
    if (view.available && resolution && typeof resolution.path === "string" && resolution.path) snapshots.set(domain, resolution.path);
    return view;
  });
  const roots = new Map();
  const knowledge = [];
  for (const source of Array.isArray(status.sources) ? status.sources : []) {
    if (!source || source.authority_class === "formal_standard" || typeof source.id !== "string") continue;
    const root = typeof source.path === "string" && source.path && source.state !== "unavailable" ? source.path : "";
    if (root) roots.set(source.id, root);
    knowledge.push(knowledgeView(source, root ? listNotes(root, { readdirImpl }) : null));
  }
  return { source: sourceView(status), domains, snapshots, keep, knowledge, roots };
}

/** One note of a knowledge clone, by its listed path; front matter dropped, bounded. */
export async function readNote(root, path, { readFileImpl = readFile } = {}) {
  const rel = String(path || "");
  const full = resolve(root, rel);
  const inside = relative(resolve(root), full);
  if (!rel || !inside || inside === ".." || inside.startsWith(`..${sep}`) || resolve(inside) === inside) throw new Error("that note is not in the knowledge repository");
  // Both ends resolved (as readDocsPage does): a symlink in the clone cannot
  // point outside it.
  let realRoot;
  let realFull;
  try { [realRoot, realFull] = await Promise.all([realpath(root), realpath(full)]); } catch { throw new Error("that note is not in the knowledge repository"); }
  if (realFull !== realRoot && !realFull.startsWith(realRoot + sep)) throw new Error("that note is not in the knowledge repository");
  const bytes = await readFileImpl(realFull);
  const body = bytes.length > MAX_SNAPSHOT ? bytes.subarray(0, MAX_SNAPSHOT) : bytes;
  const text = body.toString("utf8").replace(/^\uFEFF/, "").replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
  return { text, truncated: bytes.length > MAX_SNAPSHOT };
}

/**
 * Only the articles of a snapshot whose top-level `# ` heading is one of `titles`
 * (headings inside code fences are not articles). When none matches, the whole
 * text: better too much than an empty pane.
 */
export function keepArticles(text, titles) {
  const wanted = new Set(titles);
  const sections = [];
  let current = null;
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = !fence && /^#[ \t]+(.+?)[ \t]*\r?$/.exec(line);
    if (heading) { current = { keep: wanted.has(heading[1]), lines: [] }; sections.push(current); }
    if (current) current.lines.push(line);
  }
  const kept = sections.filter((s) => s.keep);
  return kept.length ? kept.map((s) => s.lines.join("\n").replace(/\s+$/, "")).join("\n\n") + "\n" : text;
}

/** One resolved snapshot's Markdown, bounded; `titles` keeps only those articles. */
export async function readSnapshot(path, { readFileImpl = readFile, titles = null } = {}) {
  const bytes = await readFileImpl(path);
  const body = bytes.length > MAX_SNAPSHOT ? bytes.subarray(0, MAX_SNAPSHOT) : bytes;
  // The first line is coop's provenance comment, not part of any article.
  const text = body.toString("utf8").replace(/^<!--[\s\S]*?-->\s*/, "");
  return { text: Array.isArray(titles) ? keepArticles(text, titles) : text, truncated: bytes.length > MAX_SNAPSHOT };
}

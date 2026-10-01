import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import BUNDLED_STANDARDS_REGISTRY from "../config/standards-registry.json" with { type: "json" };
import { configPath as coopConfigPath, profileDir as coopProfileDir } from "./paths.mjs";

export const DOMAINS = Object.freeze(["sql", "dax", "semantic_model", "fabric", "documentation"]);
export const AUTHORITY_CLASSES = Object.freeze(["formal_standard", "approved_pattern", "team_knowledge", "project_local"]);
export const RESOLUTION_STATES = Object.freeze(["canonical", "project_override", "stale_last_known_good", "bundled_fallback", "auth_required", "unavailable"]);
export const CANONICAL_REMOTE_STATE = "https://github.com/cooptimize/coop-standards.git#main";
// config/standards-registry.json is the only copy of the managed authority. It is
// captured and frozen when this module loads. What the standards are comes from the
// coop-standards wiki articles themselves (see wikiArticles), not from coop-agent.
const MANAGED_STANDARDS_REGISTRY = structuredClone(BUNDLED_STANDARDS_REGISTRY);
Object.freeze(MANAGED_STANDARDS_REGISTRY.canonical);
Object.freeze(MANAGED_STANDARDS_REGISTRY);
const DOMAIN_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_MANIFEST_DOMAINS = 32;

// coop-standards is an Obsidian wiki the team reads directly. coop reads the same
// articles: every Markdown file whose YAML front matter carries these fields and
// `status: active`. It never reads the repo's assembled shim for older clients
// (standards.yml, standards/*.md, scripts/assemble.py) or retired articles.
const WIKI_REQUIRED_FIELDS = Object.freeze(["id", "title", "domain", "layer", "artifact", "technology", "status"]);
const WIKI_SKIP_TOP_LEVEL = new Set(["deprecation", "standards", "scripts"]);
const WIKI_MAX_ARTICLES = 500;
const WIKI_MAX_ARTICLE_BYTES = 256 * 1024;
// Wiki domains are sql and powerbi; coop's task domains split Power BI into DAX
// expressions/measures and the rest of the semantic model and reports.
const WIKI_DAX_ARTIFACTS = new Set(["dax_expression", "measure"]);
const ARTICLE_CHAR_LIMIT = 16000;
const ARTICLE_TOTAL_CHAR_LIMIT = 48000;
const MAX_TASK_ARTICLES = 6;

const ACTION_RE = /\b(create|write|rewrite|add|modify|change|edit|repair|fix|review|audit|explain|plan|design|architect|refactor|implement|validate|assess|analy[sz]e|inspect|optimi[sz]e|update|document|build|test|check|convert|(?:re)?format|replace|rename|set up|turn (?:on|off)|fail(?:s|ed|ing)|debug|tune|troubleshoot|speed up|dedupe)\b/i;
// A Fabric warehouse, Schema Manager, dim./fact. names and silver/gold objects are SQL
// work. A lakehouse or "Microsoft Fabric" alone stays fabric only. A schema.object view
// (sales.Customer view) is SQL; a file name (accounts.py views, index.html view) is not,
// and neither is a web domain ("the drop in example.com views", #101).
// A sproc or stored proc is SQL anywhere; a bare "proc" or "SP" is not (Rust proc
// macros, /proc, service principals, SharePoint).
// Silver/gold objects include a proc or sproc, a D365 table name (silver custtable,
// gold inventtrans; not "gold stable") and a merge or upsert named right after the layer
// word (not a merge conflict, request or commit).
const SQL_RE = /\b(sql|t-?sql|stored procedure|stored procs?|sprocs?|sql procedure|sql query|select statement|insert statement|update statement|delete statement|merge statement|common table expression|cte|ddl|dml|schema (?:manager|derivation)|(?:dim|fact)\.[a-z_]\w*|[a-z_]\w*\.(?!(?:py|js|mjs|cjs|jsx|ts|tsx|vue|svelte|html?|cshtml|razor|php|rb|erb|java|kt|swift|go|rs|cs|vb|css|scss|sass|less|md|txt|json|ya?ml|xml|com|net|org|edu|gov|io|co|ly|ai|app|dev|info|biz|me|us|uk|ca|au|de|tv)\b)[a-z_]\w* views?|fabric (?:data )?warehouse|warehouse (?:in|on|for) fabric)\b|\.sql\b|\bselect \*|\b(?:silver|gold)(?:\.\w|\b.{0,40}\b(?:table|view|load|procedure|proc|sproc|dimension|fact|layer|database|schema|index(?:ing)?|column)s?\b|\s+[a-z]\w{2,}(?:table|trans)\b|\s+(?:(?!(?:and|or|then)\b)[a-z]\w*\s+)?(?:merge|upsert)s?\b(?!\s+(?:conflicts?|requests?|commits?)\b))/i;
// Loading tables into a layer: "Add inventdim and inventlocation to silver". A load verb,
// at most five words, then to/into/from silver or gold at the end of the clause, so
// "change the button color to gold" and "add the logos to the gold sponsors" are not.
const LAYER_TARGET_RE = /\b(?:add|load|land|ingest|stage|copy|replicate|bring|pull|sync|extract|import)(?:s|ed|ing)?(?:\s+[\w'-]+){1,5}?\s+(?:to|into|from)\s+(?:the\s+)?(?:silver|gold)(?:\s+(?:and|or)\s+(?:silver|gold))?(?=\s*(?:$|[.,;:!?)]|(?:so|then|with|for|using|via|before|after|because|next|tonight|today)\b))/i;
// A warehouse in a Fabric workspace, capacity or tenant is the Fabric warehouse: "the
// warehouse in our Fabric workspace", "in the Fabric workspace, create a warehouse".
// "Fabric" alone may be cloth, and "a Fabric workspace for the warehouse team" is not
// warehouse work.
const FABRIC_WAREHOUSE_RE = /\bwarehouses?\s+(?:in|on|inside|within)\s+(?:(?:the|our|my|a|this|that|your|their)\s+)?(?:[\w-]+\s+)?fabric (?:workspace|capacity|tenant)s?\b|\b(?:in|on|inside|within)\s+(?:(?:the|our|my|a|this|that|your|their)\s+)?(?:[\w-]+\s+)?fabric (?:workspace|capacity|tenant)s?\b.{0,40}\bwarehouses?\b/i;
// "this measure" is a DAX measure; "this measures" and "a test that measures" are verbs.
const DAX_RE = /\bdax\b|\.dax\b|\bcalculation group\b|\bcalculated (?:column|table)\b|\bthis\s+measure\b(?!\s+of\b)/i;
// Any other "a/the/these ... measure(s)" is DAX only next to a Power BI word
// (POWERBI_CONTEXT_RE): "the preventive measures we took" is not.
const MEASURE_NOUN_RE = /\b(?:a|an|the|these|those)\s+(?:(?!security\b|safety\b)[a-z]+\s+)?measures?\b(?!\s+of\b)/i;
const DAX_CONCEPT_RE = /\b(measures?|calculations?|expressions?)\b/i;
// Power BI context: Power BI words, a semantic or tabular model, a dataset, format
// strings, a [Column] or [Measure] reference, or an upper-case DAX function. A bare
// "model" is not: "how the churn model did against the success measures" and "the
// business model canvas with the key measures" are not DAX (#101). "report" is left out
// too: incident and audit reports talk about measures. Context alone is not DAX: "the
// format strings in the Python logging calls" names no measure.
// A bracketed name is a reference when it is table-qualified (Sales[Amount]) or not a
// template placeholder: [Project Name], [Client Name], [Your Name], [Insert date] and
// [Date] fill in a document, so "a project charter for [Project Name] with the success
// measures" is not DAX (#101). A Markdown link ([the runbook](docs/runbook.md)) is not
// a reference either.
const POWERBI_CONTEXT_RE = /\b(?:power bi|pbi[xpr]|dax|(?:semantic|tabular) models?|datasets?|slicers?|sort by|format strings?)\b|(?<=[\w'])\[[a-z][\w ]+\](?!\()|\[(?!(?:your|insert|enter|add|type|client|company|project|recipient|sender|organi[sz]ation)\b|(?:name|date|title|company|client|address|email|phone|signature|tbd|tbc|placeholder)\])[a-z][\w ]+\](?!\()/i;
// A visual is Power BI context too ("Fix those measures on the Sales visual", "the
// visual that reads the gold fact table"), except Visual Studio or Basic, a visual
// regression, "visual" as an everyday adjective (a visual merchandising role, the visual
// design, visual aids), and any visual in a prompt about slides or a presentation:
// "Design a visual for the town hall slides showing the austerity measures" is not DAX
// (#101).
const POWERBI_VISUAL_RE = /\bvisuals?\b(?!\s+(?:studio|basic|regression|merchandising|design|identity|arts?|aids?|effects?|cues?|inspection|impairment|storytelling|thinking|style|timeline|bug|artist)s?\b)/i;
const PRESENTATION_RE = /\b(?:slides?|slide ?decks?|decks?|presentations?|powerpoint|town ?halls?|all-hands|keynotes?|posters?|infographics?|webinars?)\b/i;
const DAX_FUNCTION_RE = /\b(?:CALCULATE(?:TABLE)?|SUMX|AVERAGEX|COUNTX|MAXX|MINX|RANKX|COUNTROWS|DISTINCTCOUNT|DIVIDE|SELECTEDVALUE|RELATED(?:TABLE)?|EARLIER|USERELATIONSHIP|TREATAS|KEEPFILTERS|REMOVEFILTERS|ALLEXCEPT|ALLSELECTED|TOTAL[MQY]TD|DATES[MQY]TD|SAMEPERIODLASTYEAR|SUMMARIZECOLUMNS|HASONEVALUE|ISINSCOPE)\b/;
const MODEL_RE = /\b(semantic model|tabular model|star schema|tmdl|composite models?|direct lake)\b|\.bim\b|\bpower query\b.{0,60}\b(?:dimension|fact|parameters?)\b|(?:\bpower bi\b.{0,100}\b(?:model|dataset|(?:model )?relationships?|relationship cardinality|filter direction)\b|\b(?:model relationships?|table relationships?|relationship cardinality|filter direction)\b.{0,100}\bpower bi\b)/i;
// The wiki's key columns (FKDueDate, PKCustomer) near "relationship". Case-sensitive,
// so pkg, PKCE and fkey are not keys.
const KEY_RELATIONSHIP_RE = /\b[FP]K[A-Z][a-z]\w*\b.{0,40}\b[Rr]elationships?\b|\b[Rr]elationships?\b.{0,40}\b[FP]K[A-Z][a-z]\w*/;
// "fact table", "dimension table" or "date table" is model work when nothing says SQL,
// or when the prompt also has Power BI context or names a model or a measure: "Create
// the gold fact table for budgets and add a Budget Amount measure on top of it", "Build
// the fiscal calendar dimension table in gold and relate it to the GL fact in the
// model". Only SQL-only table work ("Create a gold dimension table in SQL for
// customers") drops the Power BI model main's bare "fact table" rule added (#101).
const MODEL_TABLE_RE = /\b(?:fact|dimension|date) tables?\b/i;
const MODEL_TABLE_CONTEXT_RE = /\b(?:models?|measures?)\b/i;
// A measure table is model work next to a model, other measures or Power BI context
// ("its Ledger Transactions measure table to the Finance model"), not "a measure table
// for converting my grandmother's recipes from cups to grams" (#101).
const MEASURE_TABLE_RE = /\bmeasure tables?\b/i;
const MEASURE_TABLE_CONTEXT_RE = /\b(?:models?|measures)\b/i;
// Report work needs the report articles, not DAX: report pages, PBIX/PBIP/PBIR, a Power
// BI report or app, drill-through, a report theme, a theme, visual, card, slicer,
// bookmark or tooltip up to 60 characters before "report", or a visual, card or slicer
// up to 60 characters after it ("the AP Aging report so the slicer defaults ...").
// Further after "report", a theme or bookmark is usually a document's theme or a browser
// bookmark. A status, progress, incident, bug, test, expense or annual report is not a
// Power BI report, nor is a report card or a web app's report button, viewer, form, list
// or PDF, and Visual Studio is not a visual.
const BI_REPORT = String.raw`(?<!\b(?:status|progress|incident|bug|test|expense|error|crash|coverage|annual)\s)\breports?\b(?!\s+(?:viewer|button|link|form|list|component|generator|template|tab|menu|modal|dialog|screen|endpoint|api|script|issue|icon|pdf|card)s?\b)`;
const VISUAL = String.raw`visuals?(?!\s+(?:studio|basic|regression)\b)`;
const REPORT_RE = new RegExp(String.raw`\b(?:report pages?|pbi[xpr]|power bi (?:apps?|reports?)|drill-?through)\b|${BI_REPORT}\s+themes?\b|\b(?:theme|${VISUAL}|cards?|slicers?|bookmarks?|tooltips?)\b.{0,60}${BI_REPORT}|${BI_REPORT}.{0,60}\b(?:${VISUAL}|cards?|slicers?)\b`, "i");
// In a prompt about a Power BI report (REPORT_RE), any visual but Visual Studio or Basic
// is Power BI context: "the visual design of the Sales report and the measures behind it".
const REPORT_VISUAL_RE = new RegExp(String.raw`\b${VISUAL}`, "i");
const DOC_RE = /\b(documentation|document|readme|glossary|metadata description)\b/i;
const FABRIC_RE = /\b(?:microsoft fabric|lakehouse|fabric (?:workspace|notebook|pipeline|data pipeline|deployment pipeline|lakehouse|warehouse|medallion architecture)|(?:workspace|notebook|pipeline|data pipeline|deployment pipeline|lakehouse|warehouse|medallion architecture) (?:in|on|for) fabric|fabric medallion architecture)\b/i;
const INCREMENTAL_RE = /\b(incremental|partition|refresh policy|deployment pipeline|large model)\b/i;
const FULL_RE = /\b(full|complete|entire|all)\s+(?:standard|authority|guidance|document)/i;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function inside(path, root) {
  const rel = relative(realpathSync(root), realpathSync(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function safeJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
function plainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function regularUnsymbolic(path) {
  try { return existsSync(path) && !lstatSync(path).isSymbolicLink() && statSync(path).isFile(); } catch { return false; }
}
function directoryUnsymbolic(path) {
  try { return existsSync(path) && !lstatSync(path).isSymbolicLink() && statSync(path).isDirectory(); } catch { return false; }
}

const HELD_STORAGE_LOCKS = new Map();
const VERIFIED_TASK_PINS = new WeakSet();
const sleepSync = (ms) => { const wait = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(wait, 0, 0, ms); };

/**
 * Conservative cross-process serialization for Monday P0.
 *
 * A contender only publishes its own fully written candidate. An existing lock
 * is never inspected for recoverability and is never stolen, renamed, or
 * deleted. A crash-abandoned lock therefore requires manual/later cleanup.
 */
function withStorageLock(root, name, options, fn) {
  assertSafeStorageRoot(root);
  const lock = join(root, `.${name}.lock`);
  const held = HELD_STORAGE_LOCKS.get(lock);
  if (held) {
    held.depth++;
    try { return fn(); } finally { held.depth--; }
  }
  const timeoutMs = Math.max(0, Number(options.lockTimeoutMs ?? 5000));
  const deadline = Date.now() + timeoutMs;
  const token = randomBytes(16).toString("hex");
  for (;;) {
    const candidate = `${lock}.candidate-${process.pid}-${randomBytes(12).toString("hex")}`;
    try {
      mkdirSync(candidate, { mode: 0o700 });
      writeDurable(join(candidate, "owner.json"), JSON.stringify({
        schema_version: 1, pid: process.pid, acquired_ms: Date.now(), token,
      }) + "\n");
      fsyncDirectory(candidate);
      renameSync(candidate, lock);
      fsyncDirectory(root);
      HELD_STORAGE_LOCKS.set(lock, { depth: 1, token });
      break;
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error?.code) && !existsSync(lock)) throw error;
      if (Date.now() >= deadline) throw new Error(`${name} storage lock is busy; automatic recovery is disabled`);
      sleepSync(Math.min(25, Math.max(1, deadline - Date.now())));
    } finally {
      // This process owns the unique unpublished candidate name.
      rmSync(candidate, { recursive: true, force: true });
    }
  }
  try { return fn(); }
  finally {
    const record = HELD_STORAGE_LOCKS.get(lock);
    if (record && --record.depth === 0) {
      HELD_STORAGE_LOCKS.delete(lock);
      const claimed = `${lock}.release-${process.pid}-${randomBytes(12).toString("hex")}`;
      try {
        // Claim one exact directory before inspecting ownership. Anything that
        // subsequently occupies the canonical pathname is never our delete
        // target. A mismatched claim is restored when possible, otherwise left
        // under its unique name for manual cleanup.
        renameSync(lock, claimed);
        fsyncDirectory(root);
        if (typeof options.lockFault === "function") options.lockFault("unlock:claimed", { lock, claimed });
        const owner = safeJson(join(claimed, "owner.json"));
        if (typeof options.lockFault === "function") options.lockFault("unlock:owner-observed", { lock, claimed });
        if (owner?.token === token && owner?.pid === process.pid) {
          if (typeof options.lockFault === "function") options.lockFault("unlock:before-delete", { lock, claimed });
          rmSync(claimed, { recursive: true, force: true });
          fsyncDirectory(root);
        } else if (!existsSync(lock)) {
          renameSync(claimed, lock);
          fsyncDirectory(root);
        }
      } catch { /* uncertain ownership is preserved for manual cleanup */ }
    }
  }
}

/** Test seam for exercising the real cross-process filesystem protocol. */
export function __testWithStorageLock(root, name, options, fn) {
  return withStorageLock(root, name, options || {}, fn);
}

function standardsAuthority(options = {}) {
  const fixture = options.fixtureRegistry === true;
  const registryPath = options.registryPath;
  const requestedRemote = options.remote;
  if ((registryPath || requestedRemote) && !fixture) throw new Error("alternate standards registry or remote is allowed only for an explicit fixture");
  const registry = fixture && registryPath ? JSON.parse(readFileSync(registryPath, "utf8")) : structuredClone(MANAGED_STANDARDS_REGISTRY);
  const c = registry?.canonical;
  if (registry?.schema_version !== 1 || !c || typeof c.repository !== "string" || c.authoritative_branch !== "main" ||
      !Number.isInteger(c.freshness_seconds) || c.freshness_seconds < 1 ||
      !Number.isInteger(c.timeout_seconds) || c.timeout_seconds < 1) {
    throw new Error("managed standards registry is invalid");
  }
  const frozen = structuredClone(registry);
  Object.freeze(frozen.canonical);
  Object.freeze(frozen);
  const remote = fixture && requestedRemote ? String(requestedRemote) : frozen.canonical.repository;
  return Object.freeze({ registry: frozen, remote });
}

export function standardsRegistry(options = {}) {
  return standardsAuthority(options).registry;
}

/** YAML front matter (flat `key: value` lines) and the body after it. A leading
 * UTF-8 BOM (Windows editors add one) is not part of the text. */
function frontMatter(text) {
  text = String(text).replace(/^\uFEFF/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fields: null, body: text };
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (kv) fields[kv[1]] = scalar(kv[2]);
  }
  return { fields, body: text.slice(m[0].length) };
}

/** The coop task domain an article serves. sql stays sql; powerbi splits into dax
 * (DAX expressions, measures) and semantic_model (everything else). Any other wiki
 * domain keeps its own name, so a new domain resolves without a coop release. */
function coopDomainFor(fields) {
  const domain = String(fields.domain || "").toLowerCase();
  if (domain === "powerbi") return WIKI_DAX_ARTIFACTS.has(String(fields.artifact || "").toLowerCase()) ? "dax" : "semantic_model";
  return domain;
}

/** Every active standards article in a coop-standards checkout, sorted by path.
 * Safety: regular non-symlink files inside the root; symlinks are never followed. */
function wikiArticles(root) {
  const articles = [];
  let base;
  try { base = realpathSync(root); } catch (e) { return { error: `standards root is unreadable: ${e.message}` }; }
  const walk = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth === 0 && WIKI_SKIP_TOP_LEVEL.has(entry.name)) continue;
        if (depth < 12) walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > WIKI_MAX_ARTICLE_BYTES || !inside(path, base)) continue;
      const bytes = readFileSync(path);
      const { fields, body } = frontMatter(bytes.toString("utf8"));
      if (!fields || !WIKI_REQUIRED_FIELDS.every((key) => fields[key])) continue;
      if (String(fields.status).toLowerCase() !== "active") continue;
      const domain = coopDomainFor(fields);
      if (!DOMAIN_NAME_RE.test(domain)) continue;
      if (articles.length >= WIKI_MAX_ARTICLES) throw new Error("standards wiki has too many active articles");
      const lower = (key) => String(fields[key]).toLowerCase();
      articles.push({
        file: relative(base, path).split(sep).join("/"), path, sha256: hashBytes(bytes), body: body.trim(),
        id: fields.id, title: fields.title, domain, wiki_domain: lower("domain"), layer: lower("layer"), artifact: lower("artifact"), technology: lower("technology"),
      });
    }
  };
  try { walk(base, 0); } catch (e) { return { error: e.message }; }
  articles.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  // Article ids should be unique. Obsidian's "Make a copy" duplicates one with its
  // front matter ("Views 1.md" beside "Views.md"). Both files stay in the standard:
  // which one is the original is guesswork, and dropping either could hide the edit
  // that matters. The duplicate is reported instead (standards status, coop doctor,
  // coop sync) naming both paths; it never switches standards off.
  const firstById = new Map(), warnings = [];
  for (const a of articles) {
    const first = firstById.get(a.id);
    if (first) warnings.push(`duplicate article id ${a.id}: ${first.file} and ${a.file}`);
    else firstById.set(a.id, a);
  }
  return { articles, warnings };
}

/** Reviewer-input cache: coop-sql-review / coop-dax-review accept exactly one
 * --standards file, so coop concatenates a domain's articles (path order, front
 * matter stripped) for that call only. It is not the standard; agents get the
 * articles themselves (retrieveRelevantSections). */
function reviewerInputBytes(domain, revision, articles) {
  const header = `<!-- coop reviewer-input cache for ${domain}: built from ${articles.length} coop-standards wiki article(s) at ${revision}. Not the standard; edit the wiki articles. -->`;
  return Buffer.from([header, ...articles.map((a) => a.body)].join("\n\n") + "\n", "utf8");
}

/** Group a checkout's active wiki articles by coop domain. */
function wikiManifest(root) {
  const revision = gitRevision(root);
  if (!/^[0-9a-f]{40}$/.test(revision)) return { error: "canonical revision is unavailable" };
  const listed = wikiArticles(root);
  if (listed.error) return { error: listed.error };
  if (!listed.articles.length) return { error: "standards wiki has no active articles (front matter with status: active)" };
  const grouped = {};
  for (const article of listed.articles) (grouped[article.domain] ||= []).push(article);
  if (Object.keys(grouped).length > MAX_MANIFEST_DOMAINS) return { error: "standards wiki declares too many domains" };
  const domains = {};
  for (const [domain, articles] of Object.entries(grouped)) {
    const reviewerInput = reviewerInputBytes(domain, revision, articles);
    domains[domain] = { wiki: true, file: `wiki:${domain}`, sha256: hashBytes(reviewerInput), reviewer_input: reviewerInput, articles };
  }
  return { manifest: { schema_version: 1, revision, domains }, manifestPath: realpathSync(root) };
}

function authorityManifest(root) {
  try { return wikiManifest(root); } catch (e) { return { error: e.message }; }
}

/** `git rev-parse HEAD`, memoized on the exact bytes that decide it (#138): `.git/HEAD`
 * and, for a symbolic HEAD, the loose ref file or `packed-refs`. A changed HEAD, branch or
 * ref changes the key and runs git again; anything unusual (no `.git` directory, a
 * symlink) always runs git. Every prompt used to spawn this about eight times. */
const revisionMemo = new Map();
function headKey(path) {
  try {
    const git = join(path, ".git");
    // A reftable repository keeps its refs outside these files, so it is never memoized.
    if (!directoryUnsymbolic(git) || !regularUnsymbolic(join(git, "HEAD")) || existsSync(join(git, "reftable"))) return null;
    const head = readFileSync(join(git, "HEAD"), "utf8");
    const parts = [resolve(path), head];
    const ref = /^ref: (refs\/[^\s]+)\s*$/.exec(head)?.[1];
    if (ref) {
      if (ref.split("/").includes("..")) return null;
      const loose = join(git, ...ref.split("/"));
      parts.push(existsSync(loose) ? (regularUnsymbolic(loose) ? readFileSync(loose, "utf8") : null) : "", existsSync(join(git, "packed-refs")) ? readFileSync(join(git, "packed-refs"), "utf8") : "");
      if (parts.includes(null)) return null;
    }
    return JSON.stringify(parts);
  } catch { return null; }
}
function gitRevision(path) {
  const key = headKey(path);
  if (key && revisionMemo.has(key)) return revisionMemo.get(key);
  let revision = "";
  try { revision = execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
  if (key && /^[0-9a-f]{40}$/.test(revision) && headKey(path) === key) {
    if (revisionMemo.size > 64) revisionMemo.clear();
    revisionMemo.set(key, revision);
  }
  return revision;
}
function projectAuthorityRevision(root, relativePath, expectedSha256) {
  const revision = gitRevision(root);
  if (!/^[0-9a-f]{40}$/.test(revision)) return "project-local";
  try {
    const bytes = execFileSync("git", ["-C", root, "show", `${revision}:${relativePath}`], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 5 * 1024 * 1024 });
    return hashBytes(bytes) === expectedSha256 ? revision : "project-local";
  } catch { return "project-local"; }
}
function gitDirty(path) {
  try { return execFileSync("git", ["-C", path, "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() !== ""; }
  catch { return null; }
}
function scalar(after) {
  const s = after.trim();
  if (!s || s[0] === "#") return "";
  if (s[0] === '"') { try { return JSON.parse(s.match(/^"(?:[^"\\]|\\.)*"/)?.[0] || '""'); } catch { return ""; } }
  if (s[0] === "'") return (s.match(/^'((?:[^']|'')*)'/)?.[1] || "").replace(/''/g, "'");
  return s.replace(/\s+#.*$/, "").trim();
}

export function findProjectContract(cwd) {
  let dir = resolve(cwd || ".");
  for (;;) {
    const path = join(dir, ".coop", "project.yml");
    if (existsSync(path)) return path;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Block-YAML reader for project standards overrides. Accepts the scalar shape
 * (`standards.sql: docs/sql.md`) and the nested shape used by the standards repo
 * (`standards.sql.path: docs/sql.md`). The first key under `standards:` sets the
 * domain indent (any consistent indent of 2 or more); deeper lines under a domain
 * without a value are its nested keys. */
export function projectStandardPaths(text) {
  const out = {};
  let active = false, level = 0, nested = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const body = raw.trim();
    if (!body || body.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) { active = /^standards:\s*(?:#.*)?$/.test(body); level = 0; nested = null; continue; }
    if (!active || indent < 2) continue;
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(body);
    if (!m) continue;
    level ||= indent;
    if (indent === level) {
      nested = null;
      if (!DOMAIN_NAME_RE.test(m[1])) continue;
      const value = scalar(m[2]);
      if (value) out[m[1]] = value;
      else nested = m[1];
    } else if (indent > level && nested && m[1] === "path") out[nested] = scalar(m[2]);
  }
  return out;
}

function verifiedManifestEntry(root, domain, requestedState, options = {}) {
  const loaded = authorityManifest(root);
  if (loaded.error) return { error: loaded.error };
  const manifest = loaded.manifest;
  const entry = manifest.domains[domain];
  if (!entry) return { error: `domain not present: ${domain}` };
  try {
    const path = writeSnapshotBytes(entry.reviewer_input, domain, options);
    return Object.freeze({
      domain, authority_class: "formal_standard", state: requestedState,
      path, revision: manifest.revision, sha256: entry.sha256,
      source: "cooptimize-formal-standards", source_root: realpathSync(root), source_manifest: loaded.manifestPath,
      repository: options.repository || null, branch: options.branch || null, commit: manifest.revision, file: entry.file,
      articles: Object.freeze(entry.articles.map(({ body: _body, path: articlePath, ...meta }) => Object.freeze({ ...meta, path: realpathSync(articlePath) }))),
    });
  } catch (e) { return { error: `standard cannot be verified: ${e.message}` }; }
}

function authorityRootErrors(root, options = {}) {
  const loaded = authorityManifest(root);
  if (loaded.error) return [loaded.error];
  const manifest = loaded.manifest;
  const errors = [];
  for (const domain of Object.keys(manifest.domains)) {
    const result = verifiedManifestEntry(root, domain, "canonical", options);
    if (result.error) errors.push(`${domain}: ${result.error}`);
  }
  return errors;
}

function isCrossPlatformAbsolute(path) {
  return isAbsolute(path) || win32.isAbsolute(path) || /^[\\/]{2}/.test(path);
}

function isSafeRelativePath(path) {
  return path && !path.includes("\0") && !isCrossPlatformAbsolute(path) && !path.split(/[\\/]/).includes("..");
}

/** Write bytes into coop's content-addressed snapshot storage; returns the path. */
function writeSnapshotBytes(bytes, domain, options) {
  const hash = hashBytes(bytes);
  const root = resolve(options.snapshotRoot || process.env.COOP_STANDARDS_SNAPSHOT_ROOT || join(coopProfileDir(), "standards", "snapshots"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = join(root, `${hash}-${domain}.md`);
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink() || !statSync(target).isFile() || !inside(target, root) || sha256(target) !== hash) throw new Error("immutable standards snapshot is invalid");
  } else {
    const temp = join(root, `.${hash}-${process.pid}-${randomBytes(12).toString("hex")}.tmp`);
    try {
      writeFileSync(temp, bytes, { flag: "wx", mode: 0o400 });
      try { renameSync(temp, target); }
      catch (e) {
        // Another process may have won the content-addressed write race.
        if (!existsSync(target) || lstatSync(target).isSymbolicLink() || !statSync(target).isFile() || sha256(target) !== hash) throw e;
      }
    } finally { rmSync(temp, { force: true }); }
  }
  if (process.platform !== "win32") chmodSync(target, 0o400);
  return realpathSync(target);
}

function snapshotResolution(resolution, options) {
  if (!resolution?.path) return resolution;
  const sourcePath = realpathSync(resolution.path);
  const bytes = readFileSync(sourcePath);
  const hash = hashBytes(bytes);
  if (resolution.sha256 && resolution.sha256 !== hash) throw new Error("standard changed while it was being resolved");
  const target = writeSnapshotBytes(bytes, resolution.domain, options);
  return Object.freeze({ ...resolution, path: target, source_path: sourcePath, sha256: hash, immutable: true });
}

function bundledResolution(domain, options) {
  const configured = options.reviewerBins?.[domain];
  const bin = typeof configured === "object" ? configured.command : (configured || `coop-${domain}-review`);
  const prefix = typeof configured === "object" && Array.isArray(configured.args) ? configured.args : [];
  const probe = mkdtempSync(join(tmpdir(), `coop-${domain}-standards-`));
  try {
    const result = spawnSync(bin, [...prefix, "check", probe, "--format", "json"], {
      cwd: probe, encoding: "utf8", timeout: 15000, maxBuffer: 5 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) return null;
    const discovery = JSON.parse(result.stdout || "");
    const info = discovery?.standards;
    if (!info || typeof info.path !== "string" || !/^[0-9a-f]{64}$/.test(info.sha256 || "")) return null;
    const path = resolve(info.path);
    if (!existsSync(path) || !statSync(path).isFile() || sha256(path) !== info.sha256) return null;
    // Discovery is healthy only when the reviewer can consume the discovered
    // bytes through its real --standards contract and return matching
    // provenance. This is the same compatibility rule used by actual review.
    const sourcePath = realpathSync(path);
    if (!reviewerProvenanceClaim(sourcePath, info.sha256, discovery, domain).ok) return null;
    const roundTrip = spawnSync(bin, [...prefix, "check", probe, "--format", "json", "--standards", sourcePath], {
      cwd: probe, encoding: "utf8", timeout: 15000, maxBuffer: 5 * 1024 * 1024,
    });
    if (roundTrip.error || roundTrip.status !== 0) return null;
    const report = JSON.parse(roundTrip.stdout || "");
    if (!reviewerProvenanceClaim(sourcePath, info.sha256, report, domain).ok) return null;
    // Reviewer claims remain reviewer-owned. COOP binds its authority revision
    // to the immutable bytes discovered through the reviewer's real contract.
    const returned = report.standards;
    const revision = typeof report.version === "string" && report.version.trim()
      ? `reviewer-${report.version.trim()}`
      : (typeof returned.revision === "string" && returned.revision.trim() ? `reviewer-standard-${returned.revision.trim()}` : null);
    if (!revision) return null;
    return Object.freeze({
      domain, authority_class: "formal_standard", state: "bundled_fallback", path: sourcePath,
      revision, sha256: info.sha256,
      source: `coop-${domain}-review:bundled`, source_root: dirname(sourcePath),
      reviewer_command: bin, reviewer_args: Object.freeze([...prefix]), reviewer_version: report.version.trim(),
    });
  } catch { return null; }
  finally { rmSync(probe, { recursive: true, force: true }); }
}

function degradedLockResolution(resolution, detail) {
  if (resolution?.authority_class === "formal_standard" && resolution?.repository && ["canonical", "stale_last_known_good"].includes(resolution.state)) {
    return Object.freeze({ ...resolution, state: "stale_last_known_good", degraded: true, uncertain: true, detail });
  }
  return resolution;
}

/** Task-classified domains plus every domain the pinned canonical generation ships. */
function knownDomains(generation, extra = []) {
  return [...new Set([...DOMAINS, ...extra, ...(generation?.ok ? Object.keys(generation.domains || {}) : [])])];
}
function unavailableStandard(domain, source = "cooptimize-formal-standards") {
  return Object.freeze({ domain, authority_class: "formal_standard", state: "unavailable", path: null, revision: null, sha256: null, source });
}

export function resolveStandard(domain, options = {}) {
  if (!DOMAIN_NAME_RE.test(String(domain))) throw new Error(`unsupported standards domain: ${domain}`);
  if (options.taskPin) {
    const pinned = options.taskPin.resolutions?.[domain];
    try {
      if (!VERIFIED_TASK_PINS.has(options.taskPin) || !options.taskPin.verified || !plainObject(pinned) || pinned.domain !== domain || !pinned.immutable ||
          typeof pinned.path !== "string" || typeof pinned.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(pinned.sha256) ||
          !regularUnsymbolic(pinned.path) || sha256(pinned.path) !== pinned.sha256 ||
          (pinned.repository && pinned.authority_class === "formal_standard" && pinned.revision !== options.taskPin.revision)) {
        throw new Error("task pin is incomplete or no longer immutable");
      }
      return Object.freeze({ ...pinned });
    } catch {
      return Object.freeze({ domain, authority_class: "formal_standard", state: "unavailable", path: null, revision: null, sha256: null, source: "task-pin-invalid" });
    }
  }
  const cwd = resolve(options.cwd || ".");
  const snapshot = (record) => snapshotResolution(record, options);
  const contract = options.projectFile || findProjectContract(cwd);
  if (contract && existsSync(contract)) {
    const configured = projectStandardPaths(readFileSync(contract, "utf8"))[domain];
    if (isSafeRelativePath(configured)) {
      const root = resolve(dirname(contract), "..");
      const path = resolve(root, configured);
      try {
        if (existsSync(path) && statSync(path).isFile() && inside(path, root)) {
          const sourcePath = realpathSync(path), sourceSha256 = sha256(sourcePath);
          return snapshot(Object.freeze({
            domain, authority_class: "project_local", state: "project_override", path: sourcePath,
            revision: projectAuthorityRevision(root, configured, sourceSha256), sha256: sourceSha256, source: "project-contract", source_root: realpathSync(root),
            project_contract: realpathSync(contract), project_relative_path: configured,
          }));
        }
      } catch { /* unsafe, unreadable, or mutable project standards fail soft */ }
    }
  }
  if (!options._canonicalLockHeld) {
    const storage = canonicalStorage(options);
    try { return withStorageLock(storage.base, "canonical-storage", options, () => resolveStandard(domain, { ...options, _canonicalLockHeld: true })); }
    catch (error) {
      const generation = activeCanonicalGenerationUnlocked(options);
      if (generation.ok) {
        const lkg = resolveStandard(domain, { ...options, refresh: false, captureGeneration: generation, _canonicalLockHeld: true });
        return degradedLockResolution(lkg, error.message);
      }
      return Object.freeze({ domain, authority_class: "formal_standard", state: "unavailable", path: null, revision: null, sha256: null, source: "canonical-lock-degraded", degraded: true, uncertain: true, detail: error.message });
    }
  }
  const canonicalRoot = resolve(options.canonicalRoot || process.env.COOP_STANDARDS_ROOT || join(coopProfileDir(), "standards", "canonical"));
  const registry = standardsRegistry(options).canonical;
  const statePath = resolve(options.statePath || process.env.COOP_STANDARDS_STATE || join(dirname(canonicalRoot), "status.json"));
  const syncState = safeJson(statePath);
  const now = Number(options.now ? options.now() : Date.now());
  const stale = !syncState?.ok || !syncState.last_successful_check_ms || now - syncState.last_successful_check_ms >= registry.freshness_seconds * 1000;
  const generation = options.captureGeneration || (options._canonicalLockHeld ? activeCanonicalGenerationUnlocked(options) : activeCanonicalGeneration(options));
  if (generation?.ok) {
    const hit = verifiedManifestEntry(generation.checkout, domain, stale ? "stale_last_known_good" : "canonical", { ...options, repository: registry.repository, branch: registry.authoritative_branch });
    const indexed = generation.domains?.[domain];
    if (!hit.error && indexed && hit.revision === generation.revision && hit.file === indexed.file && hit.sha256 === indexed.sha256) {
      try { return snapshot(hit); } catch { /* fail through to verified LKG */ }
    }
  }
  if ((options.authRequired || false) && !["sql", "dax"].includes(domain)) return Object.freeze({ domain, authority_class: "formal_standard", state: "auth_required", path: null, revision: null, sha256: null, source: "cooptimize-formal-standards" });
  if (["sql", "dax"].includes(domain)) {
    const bundled = bundledResolution(domain, options);
    if (bundled) try { return snapshot(bundled); } catch { /* fail truthfully below */ }
    return Object.freeze({ domain, authority_class: "formal_standard", state: options.authRequired ? "auth_required" : "unavailable", path: null, revision: null, sha256: null, source: `coop-${domain}-review:bundled` });
  }
  return Object.freeze({ domain, authority_class: "formal_standard", state: "unavailable", path: null, revision: null, sha256: null, source: "cooptimize-formal-standards" });
}

export function identifyTaskDomains(prompt) {
  const text = String(prompt || "");
  if (!ACTION_RE.test(text)) return [];
  const out = [];
  const sql = (SQL_RE.test(text) || LAYER_TARGET_RE.test(text) || FABRIC_WAREHOUSE_RE.test(text)) && !/\bpower query\b/i.test(text);
  const report = REPORT_RE.test(text);
  const visual = report ? REPORT_VISUAL_RE.test(text) : POWERBI_VISUAL_RE.test(text) && !PRESENTATION_RE.test(text);
  const powerBi = POWERBI_CONTEXT_RE.test(text) || DAX_FUNCTION_RE.test(text) || visual;
  const dax = DAX_RE.test(text) || (powerBi && MEASURE_NOUN_RE.test(text)) || (DAX_CONCEPT_RE.test(text) && /\bpower bi\b/i.test(text));
  const semanticModel = MODEL_RE.test(text) || KEY_RELATIONSHIP_RE.test(text)
    || (MODEL_TABLE_RE.test(text) && (!sql || powerBi || dax || MODEL_TABLE_CONTEXT_RE.test(text)))
    || (MEASURE_TABLE_RE.test(text) && (powerBi || dax || MEASURE_TABLE_CONTEXT_RE.test(text)));
  if (semanticModel) out.push("semantic_model", "dax");
  else if (report) out.push("semantic_model");
  if (sql) out.push("sql");
  if (!semanticModel && dax) out.push("dax");
  if (FABRIC_RE.test(text)) out.push("fabric");
  if (DOC_RE.test(text)) out.push("documentation");
  return [...new Set(out)];
}

const TOPICS = {
  sql: ["procedure", "query", "naming", "performance", "security", "format", "transaction", "error"],
  dax: ["measure", "calculation", "expression", "filter", "naming", "performance", "format"],
  semantic_model: ["architecture", "fact", "dimension", "relationship", "cardinality", "filter direction", "naming", "visibility", "technical", "metadata", "organization"],
  documentation: ["documentation", "description", "metadata", "glossary", "naming"],
  fabric: ["workspace", "lakehouse", "warehouse", "deployment", "security", "naming"],
};

// "indexing" matches "index"; "string" keeps its "ing". Dropping "ing" never makes a
// layer name: a "reporting model" is not the report layer.
const singular = (word) => word.replace(/(?:ies)$/, "y").replace(/(?<=[a-z]{3})s$/, "");
const stem = (word, layers) => {
  const base = singular(word);
  const bare = base.replace(/(?<=[a-z]{4})ing$/, "");
  return bare !== base && layers?.has(bare) ? base : bare;
};
const wordsOf = (prompt) => String(prompt || "").toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
// Prompt words the wiki spells differently: "dim" (dim.Customer) is a dimension, a proc
// or sproc is a stored procedure, "relate it to the Budget Version dimension" is a
// relationship, and a PBIX, PBIP or PBIR is a Power BI file (Power BI File Types).
const PROMPT_WORD_ALIASES = new Map([["dim", "dimension"], ["proc", "procedure"], ["sproc", "procedure"], ...["relate", "related", "relating"].map((w) => [w, "relationship"]), ...["pbix", "pbip", "pbir"].map((w) => [w, "file"])]);
const promptWords = (prompt, layers) => new Set(wordsOf(prompt).map((w) => PROMPT_WORD_ALIASES.get(singular(w)) ?? stem(w, layers)));

/** Pick the wiki articles a task needs. General articles for the domain (layer and
 * technology both `agnostic`, e.g. SQL Conventions and SQL Layout) always apply;
 * the rest rank by front-matter layer/artifact/technology and title words shared
 * with the prompt. When nothing matches, the task gets the domain's core-layer
 * articles (layer equal to the domain, e.g. semantic_model), never whatever sorts
 * first by path; with no core layer it gets a list of the domain's articles and no
 * bodies. Each article is re-hashed on read; a changed one is skipped. */
function selectWikiArticles(resolution, prompt, full) {
  const layers = new Set(resolution.articles.map((a) => a.layer));
  const words = promptWords(prompt, layers);
  const tokens = (a) => [...new Set([a.title.toLowerCase(), a.layer, a.artifact, a.technology].join(" ").split(/[^a-z0-9]+/).filter((w) => w.length > 2 && w !== "agnostic").map((w) => stem(w)))];
  // A word more than a third of the domain's articles share ("power", "table") says
  // little about which article a task needs, unless it names a layer ("silver",
  // "gold", "report"). A domain with fewer than three articles (dax) is injected whole.
  const seen = new Map();
  for (const a of resolution.articles) for (const w of tokens(a)) seen.set(w, (seen.get(w) || 0) + 1);
  const small = resolution.articles.length < 3;
  const telling = (w) => small || layers.has(w) || seen.get(w) <= resolution.articles.length / 3;
  // A prompt that names an object in a layer's schema (silver.custtable) gets that
  // layer's overview articles (artifact agnostic, e.g. Silver Layer) one point ahead of
  // the layer's other articles and of other layers it only mentions.
  const schemas = new Set([...String(prompt || "").toLowerCase().matchAll(/\b([a-z_][a-z0-9_]*)\.[a-z_]/g)].map((m) => m[1]));
  const overview = (a) => (a.layer !== "agnostic" && a.artifact === "agnostic" && schemas.has(a.layer) ? 1 : 0);
  const ranked = resolution.articles.map((a) => ({ a, general: a.layer === "agnostic" && a.technology === "agnostic", score: tokens(a).filter((w) => words.has(w) && telling(w)).length + overview(a) }));
  const best = Math.max(0, ...ranked.filter((r) => !r.general).map((r) => r.score));
  const chosen = full ? ranked : [
    ...ranked.filter((r) => r.general),
    ...ranked.filter((r) => !r.general && (small || (r.score > 0 && r.score >= best - 1))).sort((x, y) => y.score - x.score),
  ].slice(0, MAX_TASK_ARTICLES);
  // Nothing matched: the domain's own layer, else the whole domain when it fits
  // (dax is carved out of the semantic_model layer, so it has no layer of its
  // own), else a listing with paths the agent can open. Never path order.
  const coreLayer = ranked.filter((r) => r.a.layer === resolution.domain);
  const picked = chosen.length ? chosen
    : coreLayer.length ? coreLayer.slice(0, MAX_TASK_ARTICLES)
      : ranked.length <= MAX_TASK_ARTICLES ? ranked : [];
  if (!picked.length) {
    return [{ heading: `${resolution.domain} articles (none selected for this task)`, content: resolution.articles.map((a) => `- ${a.title}: ${a.path}`).join("\n") }];
  }
  const sections = [];
  let budget = full ? Infinity : ARTICLE_TOTAL_CHAR_LIMIT;
  for (const { a } of picked) {
    let bytes;
    try { bytes = readFileSync(a.path); } catch { continue; }
    if (hashBytes(bytes) !== a.sha256 || budget <= 0) continue;
    let content = frontMatter(bytes.toString("utf8")).body.trim();
    const limit = Math.min(full ? Infinity : ARTICLE_CHAR_LIMIT, budget);
    if (content.length > limit) content = `${content.slice(0, limit)}\n[truncated; full article: ${a.file}]`;
    budget -= content.length;
    sections.push({ heading: a.title, content, file: a.file, sha256: a.sha256, revision: resolution.revision });
  }
  return sections;
}

/** Select what a task sees: whole wiki articles for canonical standards, heading
 * sections for a single-file project override or reviewer-bundled standard. Full
 * authority is explicit opt-in. */
export function retrieveRelevantSections(resolution, prompt, options = {}) {
  if (Array.isArray(resolution?.articles) && resolution.articles.length) {
    return selectWikiArticles(resolution, prompt, options.full === true || FULL_RE.test(prompt || ""));
  }
  if (!resolution?.path) return [];
  const text = readFileSync(resolution.path, "utf8");
  if (options.full === true || FULL_RE.test(prompt || "")) return [{ heading: "FULL AUTHORITY", content: text }];
  const chunks = [];
  let current = { heading: "Preamble", lines: [] };
  for (const line of text.split(/\r?\n/)) {
    const m = /^(#{1,4})\s+(.+)$/.exec(line);
    if (m) { if (current.lines.length) chunks.push(current); current = { heading: m[2], lines: [line] }; }
    else current.lines.push(line);
  }
  if (current.lines.length) chunks.push(current);
  const words = [...(TOPICS[resolution.domain] || []), ...String(prompt || "").toLowerCase().match(/[a-z][a-z-]{3,}/g) || []];
  const selected = chunks.filter((c) => words.some((w) => c.heading.toLowerCase().includes(w))).slice(0, 6);
  return (selected.length ? selected : chunks.slice(0, 2)).map((c) => ({ heading: c.heading, content: c.lines.join("\n").slice(0, 5000) }));
}

export function pinStandardsTask(domains, options = {}) {
  if (!Array.isArray(domains) || domains.some((domain) => !DOMAIN_NAME_RE.test(String(domain)))) throw new Error("task standards domains are invalid");
  let refresh = null, taskPin = null, initialized = false;
  const byDomain = new Map();
  const initialize = () => {
    if (initialized) return;
    initialized = true;
    if (options.refresh !== false && (options.refresh === true || !options.canonicalRoot)) refresh = refreshCanonical(options);
    const storage = canonicalStorage(options);
    try {
      withStorageLock(storage.base, "canonical-storage", options, () => {
        const generation = activeCanonicalGenerationUnlocked(options);
        const captureOptions = { ...options, refresh: false, captureGeneration: generation };
        for (const domain of knownDomains(generation, domains)) byDomain.set(domain, resolveStandard(domain, captureOptions));
        const resolutionIndex = Object.freeze(Object.fromEntries([...byDomain].map(([domain, value]) => [domain, Object.freeze({ ...value })])));
        taskPin = Object.freeze({
          verified: true,
          generation_id: generation.ok ? generation.generation_id : null,
          revision: generation.ok ? generation.revision : null,
          domains: generation.ok ? generation.domains : Object.freeze({}),
          resolutions: resolutionIndex,
        });
        VERIFIED_TASK_PINS.add(taskPin);
      });
    } catch (error) {
      const generation = activeCanonicalGenerationUnlocked(options);
      const captureOptions = { ...options, refresh: false, captureGeneration: generation, _canonicalLockHeld: true };
      for (const domain of knownDomains(generation, domains)) {
        const resolved = generation.ok ? resolveStandard(domain, captureOptions) : Object.freeze({ domain, authority_class: "formal_standard", state: "unavailable", path: null, revision: null, sha256: null, source: "canonical-lock-degraded", degraded: true, uncertain: true, detail: error.message });
        byDomain.set(domain, degradedLockResolution(resolved, error.message));
      }
      taskPin = Object.freeze({ verified: true, generation_id: generation.ok ? generation.generation_id : null, revision: generation.ok ? generation.revision : null, domains: generation.ok ? generation.domains : Object.freeze({}), resolutions: Object.freeze(Object.fromEntries(byDomain)) });
      VERIFIED_TASK_PINS.add(taskPin);
    }
  };
  // Classified tasks refresh and capture eagerly. Unclassified tasks remain
  // lazy until their first applicable reviewer/standards call.
  if (domains.length) initialize();
  const resolvePinned = (domain) => {
    if (!DOMAIN_NAME_RE.test(String(domain))) throw new Error(`unsupported standards domain: ${domain}`);
    initialize();
    return byDomain.get(domain) || unavailableStandard(domain);
  };
  return Object.freeze({
    get taskPin() { return taskPin; },
    get refresh() { return refresh; },
    resolutions: Object.freeze(domains.map((domain) => resolvePinned(domain))),
    resolve: resolvePinned,
  });
}

/** incremental-bi is an Obsidian wiki too: layer folders whose articles carry a
 * `layer:` front-matter field (bronze, silver, gold, semantic-model, snapshots).
 * Same front-matter reader as coop-standards. Select the task's layer, rank by
 * title words shared with the prompt, and never include articles without a layer
 * (the wiki's editing guide, overview). */
function incrementalPatternArticles(files, layers, prompt) {
  const words = promptWords(prompt);
  const articles = [];
  for (const path of files) {
    let text;
    try { text = readFileSync(path, "utf8"); } catch { continue; }
    const fields = frontMatter(text).fields || {};
    if (!layers.includes(String(fields.layer || "").toLowerCase())) continue;
    const title = String(fields.title || path.split(/[\\/]/).pop().replace(/\.md$/i, "")).toLowerCase();
    articles.push({ path, score: title.split(/[^a-z0-9-]+/).map((w) => stem(w)).filter((w) => words.has(w)).length });
  }
  return articles.sort((a, b) => b.score - a.score).slice(0, 3).map((a) => a.path);
}

// Known non-coding contexts where a bare "report", "silver" or "gold" is not data work
// (#101): a status, progress, incident, expense or annual report; a report generator,
// button, viewer, form or other app-code report widget; gold or silver badges, medals,
// sponsors, tiers or colors; README, website, newsletter and marketing wording.
const NON_CODING_CONTEXT_RE = new RegExp([
  String.raw`\b(?:status|progress|incident|expense|annual)\s+reports?\b`,
  String.raw`\breports?\s+(?:generator|button|viewer|form|component|modal|dialog|endpoint|link|icon|menu)s?\b`,
  String.raw`\b(?:gold|silver)\b.{0,40}\b(?:badges?|medals?|sponsors?|tiers?)\b|\b(?:badges?|medals?|sponsors?|tiers?)\b.{0,40}\b(?:gold|silver)\b`,
  String.raw`\b(?:colou?rs?|hover|font|css|hex|palette)\b.{0,40}\b(?:gold|silver)\b|\b(?:gold|silver)\s+(?:colou?r(?:ed|s)?|font|text|border|background|shade)\b`,
  String.raw`\b(?:readme|website|web site|newsletter|marketing (?:site|page|copy|email|wording|deck|materials?))\b`,
].join("|"), "i");
// A title-case name before Status, Progress, Incident, Expense or Annual Report names a
// report ("the Project Status report", "the Order Status report"), which is not a known
// non-coding context. A determiner or reporting period is not a name: "The Status
// Report", "the Weekly Status Report" stay status documents. Case-sensitive (#101).
const NAMED_REPORT_RE = /\b(?!(?:A|An|The|This|That|These|Those|Our|My|Your|Their|Its|Weekly|Monthly|Daily|Quarterly|Yearly|Biweekly|Final|Draft|New)\b)[A-Z][\w&'-]*\s+(?:Status|Progress|Incident|Expense|Annual)\s+[Rr]eports?\b/g;
// Data work in any of those contexts keeps the floor: a classified SQL, DAX, model or
// Fabric domain, or one of these words ("Update the README with the silver dedupe steps",
// "Update the status report in Power BI"). So do subtotals ("Fix the matrix subtotals on
// the project status report"), a page added to, in or on a Power BI report ("Add a
// Marketing page to the Sales report") and naming conventions or standards ("Update the
// README with the silver and gold naming conventions"). A bare visual, page or tooltip
// does not ("Add a visual timeline to the status report", "the conference page", "the
// tooltip on the report button").
const DATA_SIGNAL_RE = new RegExp(String.raw`\b(?:power ?bi|fabric|(?:semantic|tabular) models?|slicers?|sql|t-?sql|dax|procs?|sprocs?|stored procedures?|views?|tables?|columns?|rows?|quer(?:y|ies)|loads?|dedupe?s?|duplicates?|upserts?|merges?(?!\s+(?:the\s+)?(?:pr|pull request|conflicts?|requests?|branch(?:es)?)\b)|index(?:es|ing)?|schemas?|etl|elt|pipelines?|notebooks?|lakehouses?|warehouses?|datasets?|dataflows?|measures?|dims?|facts?|dimensions?|extracts?|pbi[xpr])\b`
  + String.raw`|\b(?:subtotals?|naming (?:conventions?|standards?))\b`
  + String.raw`|\bpages?\s+(?:to|in|on|of|for)\s+(?:(?:the|a|an|our|this|that|my|your)\s+)?(?:[\w&'-]+\s+){0,3}?${BI_REPORT}`, "i");
const CODING_DOMAINS = new Set(["sql", "dax", "semantic_model", "fabric"]);

/** The recall floor under the classifier (#88, kept by #101). A task that names a layer
 * the domain's wiki articles carry (silver, gold, report ...) or every word of an
 * article's multi-word technology (fabric warehouse -> fabric_warehouse) selects that
 * domain too, so ordinary wording the classifier misses ("Review this SP for gold",
 * "Add a new page to the Inventory report") still gets the standards. Only the cached
 * wiki front matter decides; the classifier's domains are never removed. The floor gives
 * way only in a known non-coding context (NON_CODING_CONTEXT_RE, where a named report
 * such as "the Project Status report" does not count) when neither the classifier nor
 * DATA_SIGNAL_RE found data work. */
function widenDomainsFromWiki(domains, prompt, options) {
  const text = String(prompt || "");
  if (!ACTION_RE.test(text)) return domains;
  let generation;
  try { generation = options.captureGeneration || activeCanonicalGeneration(options); } catch { return domains; }
  if (!generation?.ok || !plainObject(generation.domains)) return domains;
  const words = new Set(wordsOf(text).map(singular));
  const out = [...domains];
  for (const [domain, entry] of Object.entries(generation.domains)) {
    if (out.includes(domain) || !DOMAIN_NAME_RE.test(domain) || !Array.isArray(entry?.articles)) continue;
    const hit = entry.articles.some((a) => {
      const layer = String(a?.layer || "").toLowerCase();
      const technology = String(a?.technology || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      return (layer && layer !== "agnostic" && words.has(singular(layer)))
        || (technology.length > 1 && technology[0] !== "agnostic" && technology.every((w) => words.has(singular(w))));
    });
    if (hit) out.push(domain);
  }
  if (out.length > domains.length && NON_CODING_CONTEXT_RE.test(text.replace(NAMED_REPORT_RE, "report")) && !DATA_SIGNAL_RE.test(text) && !domains.some((d) => CODING_DOMAINS.has(d))) return domains;
  return out;
}

export function buildStandardsContext(prompt, options = {}) {
  const domains = widenDomainsFromWiki(identifyTaskDomains(prompt), prompt, options);
  const pinned = pinStandardsTask(domains, options);
  const resolutions = pinned.resolutions;
  const records = resolutions.map((resolution) => ({ resolution, sections: retrieveRelevantSections(resolution, prompt, options) }));
  const patterns = [];
  const configured = configuredKnowledgeRoots(options);
  const incrementalRoot = options.incrementalBiRoot || configured.incrementalBiRoot;
  if (domains.includes("semantic_model") && INCREMENTAL_RE.test(prompt || "") && incrementalRoot && existsSync(incrementalRoot)) {
    const files = [];
    const walk = (dir) => {
      if (files.length >= 100) return;
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (files.length >= 100) break;
        const path = join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith(".")) walk(path);
        else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(path);
      }
    };
    try { walk(incrementalRoot); } catch { /* approved patterns are optional */ }
    const candidates = incrementalPatternArticles(files, ["semantic-model"], prompt);
    const sections = candidates.flatMap((path) => retrieveRelevantSections({ domain: "semantic_model", path }, prompt).map((section) => ({ path: realpathSync(path), ...section })));
    patterns.push(Object.freeze({ authority_class: "approved_pattern", source: "cooptimize/incremental-bi", source_root: realpathSync(incrementalRoot), selective: true, sections: Object.freeze(sections) }));
  }
  return Object.freeze({ domains, records: Object.freeze(records), patterns: Object.freeze(patterns), get refresh() { return pinned.refresh; }, get taskPin() { return pinned.taskPin; }, resolve: pinned.resolve });
}

export function provenanceText(record) {
  const r = record.resolution;
  const sections = record.sections.map((s) => s.file
    ? `## ${s.heading}\n<!-- coop-standards wiki article: ${s.file} sha256=${s.sha256} revision=${s.revision} -->\n${s.content}`
    : `## ${s.heading}\n${s.content}`).join("\n\n");
  const scope = Array.isArray(r.articles) ? ` articles=${record.sections.filter((s) => s.file).length}/${r.articles.length} (coop-standards wiki)` : ` path=${r.path || "(reviewer bundled/unavailable)"}`;
  return `[${r.domain}] authority=${r.authority_class} state=${r.state} source=${r.source}${scope} revision=${r.revision || "(none)"} sha256=${r.sha256 || "(none)"}${sections ? `\n${sections}` : ""}`;
}

export function reviewStandardsArgs(resolution) {
  return resolution && resolution.path ? ["--standards", resolution.path] : [];
}

export function validateReviewerReport(domain, report) {
  const expectedTool = `coop-${domain}-review`;
  if (!plainObject(report)) return { ok: false, error: "reviewer report envelope is missing" };
  if (report.tool !== expectedTool) return { ok: false, error: `reviewer tool must be ${expectedTool}` };
  const expectedSchema = domain === "sql" ? 4 : 3;
  if (report.schema_version !== expectedSchema) return { ok: false, error: `reviewer schema_version must be ${expectedSchema}` };
  if (typeof report.version !== "string" || !report.version.trim()) return { ok: false, error: "reviewer version is invalid" };
  if (!Array.isArray(report.findings) || !Array.isArray(report.diagnostics) || !Array.isArray(report.agent_review)) return { ok: false, error: "reviewer findings/diagnostics/agent_review envelope is invalid" };
  const exactKeys = (value, required, optional = []) => plainObject(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
  const stringFields = (value, fields) => fields.every((key) => typeof value[key] === "string");
  // Pinned reviewers use 12-character finding identities, not authority digests.
  const fingerprint = (value) => /^[0-9a-f]{12}$/.test(value);
  const findingFields = ["rule_id", "severity", ...(domain === "dax" ? ["model"] : []), "file", "line", "object", "message", "standard_ref", "fingerprint"];
  for (const finding of report.findings) {
    if (!exactKeys(finding, findingFields) || !["error", "warning", "info"].includes(finding.severity) ||
        !stringFields(finding, findingFields.filter((key) => !["severity", "line"].includes(key))) || !fingerprint(finding.fingerprint) ||
        !Number.isInteger(finding.line) || finding.line < 0) return { ok: false, error: "reviewer finding schema is invalid" };
  }
  const diagnosticFields = ["severity", "category", "file", "line", "message", "rule_id"];
  for (const diagnostic of report.diagnostics) {
    if (!exactKeys(diagnostic, diagnosticFields) || !["error", "warning"].includes(diagnostic.severity) ||
        !stringFields(diagnostic, diagnosticFields.filter((key) => !["severity", "line"].includes(key))) ||
        !Number.isInteger(diagnostic.line) || diagnostic.line < 0) return { ok: false, error: "reviewer diagnostic schema is invalid" };
  }
  const agentFields = ["rule_id", ...(domain === "dax" ? ["model"] : []), "file", "object", "line", "note", "standard_ref", "fingerprint"];
  for (const item of report.agent_review) {
    if (!exactKeys(item, agentFields) || !stringFields(item, agentFields.filter((key) => key !== "line")) ||
        !fingerprint(item.fingerprint) || !Number.isInteger(item.line) || item.line < 0) return { ok: false, error: "reviewer agent_review schema is invalid" };
  }
  const summary = report.summary;
  if (!exactKeys(summary, ["error", "warning", "info"]) || !["error", "warning", "info"].every((key) => Number.isInteger(summary[key]) && summary[key] >= 0)) return { ok: false, error: "reviewer summary is invalid" };
  for (const severity of ["error", "warning", "info"]) if (summary[severity] !== report.findings.filter((f) => f.severity === severity).length) return { ok: false, error: "reviewer summary does not match findings" };
  if (!exactKeys(report.verdict, ["clean", "highest_severity"]) || typeof report.verdict.clean !== "boolean" || !(report.verdict.highest_severity === null || ["error", "warning", "info"].includes(report.verdict.highest_severity))) return { ok: false, error: "reviewer verdict is invalid" };
  const hasErrorDiagnostic = report.diagnostics.some((d) => d.severity === "error");
  const highest = hasErrorDiagnostic ? "error" : (["error", "warning", "info"].find((severity) => summary[severity] > 0) || null);
  if (report.verdict.clean !== (report.findings.length === 0 && !hasErrorDiagnostic) || report.verdict.highest_severity !== highest) return { ok: false, error: "reviewer verdict does not match findings/diagnostics" };
  const countKey = domain === "sql" ? "files_checked" : "models_checked";
  if (!Number.isInteger(report[countKey]) || report[countKey] < 0) return { ok: false, error: `reviewer ${countKey} is invalid` };
  const rootFields = ["tool", "schema_version", "version", "standards", countKey, "verdict", "findings", "summary", "agent_review", "diagnostics"];
  if (!exactKeys(report, rootFields)) return { ok: false, error: "reviewer report envelope has unknown or missing fields" };
  if (!exactKeys(report.standards, ["path", "sha256"]) || typeof report.standards.path !== "string" || typeof report.standards.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(report.standards.sha256)) return { ok: false, error: "reviewer standards provenance schema is invalid" };
  return { ok: true };
}

function reviewerProvenanceClaim(expectedPath, expectedSha256, report, domain = null) {
  try {
    if (domain) {
      const envelope = validateReviewerReport(domain, report);
      if (!envelope.ok) return envelope;
    }
    const returned = report && typeof report === "object" && !Array.isArray(report) ? report.standards : null;
    if (!returned || typeof returned !== "object" || Array.isArray(returned)) return { ok: false, error: "reviewer standards provenance is missing" };
    if (typeof returned.path !== "string" || resolve(returned.path) !== resolve(expectedPath)) return { ok: false, error: "reviewer standards path mismatch" };
    if (realpathSync(returned.path) !== realpathSync(expectedPath)) return { ok: false, error: "reviewer standards path mismatch" };
    if (returned.sha256 !== expectedSha256) return { ok: false, error: "reviewer standards hash mismatch" };
    return { ok: true };
  } catch (e) { return { ok: false, error: `standards provenance cannot be verified: ${e.message}` }; }
}

export function verifyReviewerProvenance(resolution, report, binding = null) {
  if (!resolution?.path || !resolution.immutable || typeof resolution.revision !== "string" || !resolution.revision || !/^[0-9a-f]{64}$/.test(resolution.sha256 || "")) {
    return { ok: false, error: "no complete immutable standards resolution is available" };
  }
  try {
    if (!existsSync(resolution.path) || !statSync(resolution.path).isFile()) return { ok: false, error: "immutable standards snapshot is missing" };
    if (sha256(resolution.path) !== resolution.sha256) return { ok: false, error: "immutable standards snapshot hash mismatch" };
    const claim = reviewerProvenanceClaim(resolution.path, resolution.sha256, report, resolution.domain);
    if (!claim.ok) return claim;
    if (binding && (binding.owner !== "coop" || binding.path !== realpathSync(resolution.path) || binding.sha256 !== resolution.sha256 || binding.revision !== resolution.revision)) {
      return { ok: false, error: "trusted standards revision binding mismatch" };
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: `standards provenance cannot be verified: ${e.message}` }; }
}

/** Bind the trusted resolver revision locally without rewriting reviewer claims. */
export function bindReviewerProvenance(resolution, report) {
  const verified = verifyReviewerProvenance(resolution, report);
  if (!verified.ok) return verified;
  const binding = Object.freeze({
    owner: "coop",
    path: realpathSync(resolution.path),
    sha256: resolution.sha256,
    revision: resolution.revision,
  });
  const rebound = verifyReviewerProvenance(resolution, report, binding);
  return rebound.ok ? { ok: true, binding } : rebound;
}

function authorityProvenance(resolution, options = {}) {
  const common = {
    schema_version: 1, domain: resolution.domain, authority_class: resolution.authority_class,
    state: resolution.state, revision: resolution.revision, sha256: resolution.sha256,
    immutable_path: realpathSync(resolution.path), source_path: realpathSync(resolution.source_path),
  };
  let provenance;
  if (resolution.state === "project_override" && resolution.authority_class === "project_local") {
    provenance = { ...common, kind: "project", source_root: realpathSync(resolution.source_root), project_contract: realpathSync(resolution.project_contract), project_relative_path: resolution.project_relative_path };
  } else if (resolution.state === "bundled_fallback" && resolution.source === `coop-${resolution.domain}-review:bundled`) {
    provenance = { ...common, kind: "bundled", source: resolution.source, reviewer_version: resolution.reviewer_version };
  } else if (["canonical", "stale_last_known_good"].includes(resolution.state) && resolution.authority_class === "formal_standard") {
    provenance = { ...common, kind: "canonical", source_root: realpathSync(resolution.source_root), source_manifest: realpathSync(resolution.source_manifest), repository: resolution.repository, branch: resolution.branch, file: resolution.file };
  } else throw new Error("standards authority provenance cannot be persisted");
  const verified = verifyAuthorityProvenance(provenance, options);
  if (!verified.ok) throw new Error(verified.error);
  return Object.freeze(provenance);
}

const VERIFIED_REMOTE_REVISIONS = new Set();
function verifyCanonicalRemoteRevision(repository, branch, revision, timeoutMs = 15000) {
  const key = `${repository}\0${branch}\0${revision}`;
  if (VERIFIED_REMOTE_REVISIONS.has(key)) return;
  const probe = mkdtempSync(join(tmpdir(), "coop-standards-authority-"));
  try {
    execFileSync("git", ["init", "--bare", "--quiet", probe], { stdio: "ignore", timeout: timeoutMs });
    execFileSync("git", ["-C", probe, "fetch", "--quiet", "--no-tags", "--force", "--", repository, `refs/heads/${branch}:refs/heads/authority`], {
      stdio: "ignore", timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_ASKPASS: "" },
    });
    execFileSync("git", ["-C", probe, "cat-file", "-e", `${revision}^{commit}`], { stdio: "ignore", timeout: timeoutMs });
    execFileSync("git", ["-C", probe, "merge-base", "--is-ancestor", revision, "refs/heads/authority"], { stdio: "ignore", timeout: timeoutMs });
    VERIFIED_REMOTE_REVISIONS.add(key);
  } finally { rmSync(probe, { recursive: true, force: true }); }
}

function verifyAuthorityProvenance(provenance, options = {}) {
  try {
    if (!plainObject(provenance) || provenance.schema_version !== 1 || !["sql", "dax"].includes(provenance.domain) ||
        typeof provenance.revision !== "string" || !provenance.revision || !/^[0-9a-f]{64}$/.test(provenance.sha256 || "") ||
        !regularUnsymbolic(provenance.immutable_path) || sha256(provenance.immutable_path) !== provenance.sha256) throw new Error("immutable authority bytes are invalid");
    if (provenance.kind === "project") {
      const root = realpathSync(provenance.source_root), contract = realpathSync(provenance.project_contract);
      if (contract !== join(root, ".coop", "project.yml") || !regularUnsymbolic(contract) || !isSafeRelativePath(provenance.project_relative_path)) throw new Error("project authority path is invalid");
      const source = resolve(root, provenance.project_relative_path);
      if (!regularUnsymbolic(source) || !inside(source, root) || realpathSync(source) !== realpathSync(provenance.source_path)) throw new Error("project authority source is invalid");
      if (/^[0-9a-f]{40}$/.test(provenance.revision)) {
        const fileBytes = execFileSync("git", ["-C", root, "show", `${provenance.revision}:${provenance.project_relative_path}`], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 5 * 1024 * 1024 });
        const contractBytes = execFileSync("git", ["-C", root, "show", `${provenance.revision}:.coop/project.yml`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024 });
        if (projectStandardPaths(contractBytes)[provenance.domain] !== provenance.project_relative_path || hashBytes(fileBytes) !== provenance.sha256) throw new Error("project Git revision does not derive the claimed authority");
      } else if (provenance.revision !== "project-local" || projectStandardPaths(readFileSync(contract, "utf8"))[provenance.domain] !== provenance.project_relative_path || sha256(source) !== provenance.sha256) {
        throw new Error("project-local revision does not derive the claimed authority");
      }
    } else if (provenance.kind === "canonical") {
      if (!/^[0-9a-f]{40}$/.test(provenance.revision) || provenance.branch !== "main") throw new Error("canonical revision is invalid");
      const storage = canonicalStorage(options), checkout = realpathSync(provenance.source_root), generation = dirname(checkout);
      if (!directoryUnsymbolic(storage.generations) || realpathSync(dirname(generation)) !== realpathSync(storage.generations) || checkout !== join(generation, "checkout")) throw new Error("canonical generation is outside managed storage");
      verifyCanonicalRemoteRevision(provenance.repository, provenance.branch, provenance.revision, options.timeoutMs || 15000);
      const registry = standardsRegistry(options).canonical, metadataPath = join(generation, "generation.json"), indexPath = join(generation, "retrieval-index.json");
      if (!regularUnsymbolic(metadataPath) || !regularUnsymbolic(indexPath)) throw new Error("canonical generation metadata/index is missing");
      const metadata = safeJson(metadataPath), index = safeJson(indexPath), expectedIndex = retrievalIndex(checkout, standardsRegistry(options), provenance.revision);
      if (!plainObject(metadata) || metadata.schema_version !== 1 || metadata.generation_id !== generation.split(sep).pop() || metadata.revision !== provenance.revision ||
          metadata.repository !== registry.repository || metadata.branch !== registry.authoritative_branch ||
          metadata.remote_ref !== `refs/remotes/origin/${registry.authoritative_branch}` || metadata.remote_commit !== provenance.revision || metadata.index_sha256 !== sha256(indexPath) ||
          JSON.stringify(metadata.domains) !== JSON.stringify(index?.domains) || JSON.stringify(index) !== JSON.stringify(expectedIndex)) throw new Error("canonical generation metadata/index does not derive the claimed authority");
      const verified = verifyCanonicalCheckout(checkout, options, provenance.revision);
      const hit = verifiedManifestEntry(checkout, provenance.domain, provenance.state, { ...options, repository: provenance.repository, branch: provenance.branch });
      if (!verified.ok || hit.error || provenance.repository !== standardsRegistry(options).canonical.repository || hit.revision !== provenance.revision || hit.file !== provenance.file || hit.sha256 !== provenance.sha256 || realpathSync(hit.path) !== realpathSync(provenance.source_path) || realpathSync(hit.source_manifest) !== realpathSync(provenance.source_manifest)) {
        throw new Error(verified.error || hit.error || "canonical generation does not derive the claimed authority");
      }
    } else if (provenance.kind === "bundled") {
      const current = bundledResolution(provenance.domain, options);
      if (!current || current.revision !== provenance.revision || current.sha256 !== provenance.sha256 || current.source !== provenance.source ||
          current.reviewer_version !== provenance.reviewer_version || realpathSync(current.path) !== realpathSync(provenance.source_path)) throw new Error("reviewer discovery does not derive the claimed bundled authority");
    } else throw new Error("authority provenance kind is invalid");
    return { ok: true };
  } catch (error) { return { ok: false, error: `independent standards provenance is invalid: ${error.message}` }; }
}

/** Validate and publish SQL+DAX reports/bindings behind one atomic pointer. */
export function promoteReviewRun(outdir, entries, options = {}) {
  if (!Array.isArray(entries) || entries.length !== 2 || entries.map((x) => x?.domain).sort().join("|") !== "dax|sql") return { ok: false, error: "review run must contain exactly one SQL and one DAX report" };
  const root = resolve(outdir);
  try {
    return withStorageLock(root, "accepted-review-storage", options, () => {
      const generations = join(root, "accepted-generations");
      assertSafeStorageRoot(generations);
      const verified = [];
      // Capture every input exactly once. Parsing, validation, hashing and
      // publication all operate on these immutable bytes.
      for (const entry of entries) {
        const resolutionBytes = readFileSync(entry.resolutionPath);
        const reportBytes = readFileSync(entry.reportPath);
        const resolution = JSON.parse(resolutionBytes.toString("utf8"));
        const report = JSON.parse(reportBytes.toString("utf8"));
        if (resolution.domain !== entry.domain) throw new Error(`${entry.domain} report rejected: resolution domain mismatch`);
        const bound = bindReviewerProvenance(resolution, report);
        if (!bound.ok) throw new Error(`${resolution.domain || entry.domain} report rejected: ${bound.error}`);
        const provenance = authorityProvenance(resolution, options);
        verified.push({ domain: entry.domain, reportBytes, report, binding: bound.binding, provenance });
      }
      const generationId = `review-${process.pid}-${Date.now().toString(36)}-${randomBytes(12).toString("hex")}`;
      const stage = join(generations, `.stage-${generationId}`), final = join(generations, generationId);
      mkdirSync(stage, { mode: 0o700 });
      writeDurable(join(stage, ".owner.json"), JSON.stringify({ pid: process.pid, created_ms: Date.now() }) + "\n");
      const fault = (step) => {
        if (typeof options.fault === "function") options.fault(step);
        else if (options.fault === step) throw new Error(`fault injected at ${step}`);
      };
      try {
        for (const entry of verified) {
          writeDurable(join(stage, `coop-${entry.domain}-review.json`), entry.reportBytes);
          fault(`review:${entry.domain}:report`);
          writeDurable(join(stage, `coop-${entry.domain}-review.provenance.json`), JSON.stringify(entry.binding) + "\n");
          fault(`review:${entry.domain}:binding`);
          writeDurable(join(stage, `coop-${entry.domain}-review.authority.json`), JSON.stringify(entry.provenance) + "\n");
          fault(`review:${entry.domain}:authority`);
        }
        rmSync(join(stage, ".owner.json"), { force: true });
        const files = Object.fromEntries(verified.flatMap((entry) => [
          [`${entry.domain}_report`, { file: `coop-${entry.domain}-review.json`, sha256: hashBytes(entry.reportBytes) }],
          [`${entry.domain}_binding`, { file: `coop-${entry.domain}-review.provenance.json`, sha256: sha256(join(stage, `coop-${entry.domain}-review.provenance.json`)) }],
          [`${entry.domain}_authority`, { file: `coop-${entry.domain}-review.authority.json`, sha256: sha256(join(stage, `coop-${entry.domain}-review.authority.json`)) }],
        ]));
        const standards_bindings = Object.fromEntries(verified.map((entry) => [entry.domain, {
          path: entry.binding.path, sha256: entry.binding.sha256, revision: entry.binding.revision,
        }]));
        const metadata = { schema_version: 1, generation_id: generationId, domains: verified.map((x) => x.domain).sort(), files, standards_bindings };
        writeDurable(join(stage, "generation.json"), JSON.stringify(metadata, null, 2) + "\n");
        fault("review:metadata");
        fsyncDirectory(stage);
        renameSync(stage, final); fsyncDirectory(generations);
        fault("review:generation");
        const metadataSha256 = sha256(join(final, "generation.json"));
        const own = resolveAcceptedGeneration(root, generationId, metadataSha256, options);
        if (!own.ok) throw new Error(own.error);
        fault("review:before-pointer");
        atomicJson(join(root, "active-review-generation.json"), { schema_version: 1, generation_id: generationId, metadata_sha256: metadataSha256 });
        fault("review:after-pointer");
        return { ok: true, generation_id: generationId, bindings: Object.fromEntries(verified.map((x) => [x.domain, x.binding])), reports: own.reports, binding_paths: own.bindings };
      } finally { rmSync(stage, { recursive: true, force: true }); }
    });
  } catch (e) { return { ok: false, error: `review run promotion failed: ${e.message}` }; }
}

function resolveAcceptedGeneration(root, generationId, metadataSha256, options = {}) {
  try {
    if (typeof generationId !== "string" || !/^review-[A-Za-z0-9.-]+$/.test(generationId) || typeof metadataSha256 !== "string" || !/^[0-9a-f]{64}$/.test(metadataSha256)) throw new Error("active review generation pointer is invalid");
    const generation = join(root, "accepted-generations", generationId);
    if (!directoryUnsymbolic(generation) || !inside(generation, join(root, "accepted-generations"))) throw new Error("active review generation target is unsafe");
    const metadataPath = join(generation, "generation.json");
    if (!regularUnsymbolic(metadataPath)) throw new Error("active review generation metadata is invalid");
    const metadataBytes = readFileSync(metadataPath), metadata = JSON.parse(metadataBytes.toString("utf8"));
    if (hashBytes(metadataBytes) !== metadataSha256 ||
        !plainObject(metadata) || metadata.schema_version !== 1 || metadata.generation_id !== generationId ||
        !Array.isArray(metadata.domains) || metadata.domains.slice().sort().join("|") !== "dax|sql" || !plainObject(metadata.files) ||
        Object.keys(metadata).sort().join("|") !== "domains|files|generation_id|schema_version|standards_bindings" || !plainObject(metadata.standards_bindings) ||
        Object.keys(metadata.standards_bindings).sort().join("|") !== "dax|sql" ||
        Object.keys(metadata.files).sort().join("|") !== "dax_authority|dax_binding|dax_report|sql_authority|sql_binding|sql_report") throw new Error("active review generation metadata is invalid");
    const reports = {}, bindings = {}, authorities = {}, captured = {};
    for (const domain of metadata.domains) {
      for (const [kind, target] of [["report", reports], ["binding", bindings], ["authority", authorities]]) {
        const entry = metadata.files[`${domain}_${kind}`], path = plainObject(entry) && typeof entry.file === "string" ? join(generation, entry.file) : "";
        if (!plainObject(entry) || Object.keys(entry).sort().join("|") !== "file|sha256" || typeof entry.file !== "string" || !isSafeRelativePath(entry.file) ||
            typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256) || !regularUnsymbolic(path) || !inside(path, generation)) throw new Error(`active review ${domain} ${kind} is invalid`);
        const bytes = readFileSync(path);
        if (hashBytes(bytes) !== entry.sha256) throw new Error(`active review ${domain} ${kind} is invalid`);
        target[domain] = realpathSync(path);
        captured[`${domain}_${kind}`] = JSON.parse(bytes.toString("utf8"));
      }
      const report = captured[`${domain}_report`], binding = captured[`${domain}_binding`], authority = captured[`${domain}_authority`];
      const expectedBinding = metadata.standards_bindings[domain];
      const envelope = validateReviewerReport(domain, report);
      if (!envelope.ok) throw new Error(`active review ${domain} report envelope is invalid: ${envelope.error}`);
      if (!plainObject(binding) || Object.keys(binding).sort().join("|") !== "owner|path|revision|sha256" || binding.owner !== "coop" ||
          typeof binding.path !== "string" || typeof binding.revision !== "string" || !binding.revision || typeof binding.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(binding.sha256) ||
          !plainObject(expectedBinding) || Object.keys(expectedBinding).sort().join("|") !== "path|revision|sha256" || expectedBinding.path !== binding.path || expectedBinding.sha256 !== binding.sha256 || expectedBinding.revision !== binding.revision ||
          report.standards.path !== binding.path || report.standards.sha256 !== binding.sha256 || !regularUnsymbolic(binding.path) || sha256(binding.path) !== binding.sha256) {
        throw new Error(`active review ${domain} provenance binding is invalid`);
      }
      const authorityCheck = verifyAuthorityProvenance(authority, options);
      if (!authorityCheck.ok || authority.domain !== domain || authority.revision !== binding.revision || authority.sha256 !== binding.sha256 || authority.immutable_path !== binding.path) {
        throw new Error(`active review ${domain} authority provenance is invalid: ${authorityCheck.error || "binding disagreement"}`);
      }
    }
    return Object.freeze({ ok: true, generation_id: generationId, generation: realpathSync(generation), reports: Object.freeze(reports), bindings: Object.freeze(bindings) });
  } catch (e) { return { ok: false, error: e.message }; }
}

export function resolveAcceptedReviewRun(outdir, options = {}) {
  const root = resolve(outdir);
  try {
    assertSafeStorageRoot(root, false);
    return withStorageLock(root, "accepted-review-storage", options, () => {
      const pointerPath = join(root, "active-review-generation.json");
      if (!regularUnsymbolic(pointerPath)) throw new Error("active review generation pointer is missing or unsafe");
      const pointer = safeJson(pointerPath);
      if (!plainObject(pointer) || Object.keys(pointer).sort().join("|") !== "generation_id|metadata_sha256|schema_version" || pointer.schema_version !== 1) throw new Error("active review generation pointer is invalid");
      return resolveAcceptedGeneration(root, pointer.generation_id, pointer.metadata_sha256, options);
    });
  } catch (e) {
    if (!/storage lock is busy/.test(e.message)) return { ok: false, error: e.message, degraded: true };
    // Accepted generations are immutable and never pruned in Monday P0, so an
    // atomic pointer can be read safely while lock ownership is uncertain.
    try {
      const pointer = safeJson(join(root, "active-review-generation.json"));
      const lkg = resolveAcceptedGeneration(root, pointer?.generation_id, pointer?.metadata_sha256, options);
      if (lkg.ok) return Object.freeze({ ...lkg, degraded: true, uncertain: true, detail: e.message });
    } catch { /* return the original lock failure */ }
    return { ok: false, error: e.message, degraded: true, uncertain: true };
  }
}

function sourceStatusUnlocked(options = {}) {
  const canonicalRoot = resolve(options.canonicalRoot || process.env.COOP_STANDARDS_ROOT || join(coopProfileDir(), "standards", "canonical"));
  const registry = standardsRegistry(options).canonical;
  const statePath = resolve(options.statePath || process.env.COOP_STANDARDS_STATE || join(dirname(canonicalRoot), "status.json"));
  const sync = safeJson(statePath) || {};
  const now = Number(options.now ? options.now() : Date.now());
  const measuredFreshness = sync.last_successful_check_ms ? (now - sync.last_successful_check_ms < registry.freshness_seconds * 1000 ? "fresh" : "stale") : "never_checked";
  const freshness = options.lockUncertain ? "uncertain" : measuredFreshness;
  const statusDegraded = options.lockUncertain === true || sync.degraded === true || ((!options.canonicalRoot || Object.keys(sync).length > 0) && measuredFreshness !== "fresh");
  const configured = configuredKnowledgeRoots(options);
  const source = (id, authority_class, root, absentState) => {
    const present = root && existsSync(root);
    return { id, authority_class, state: present ? (gitDirty(root) ? "dirty_preserved" : "available") : absentState, revision: present ? (gitRevision(root) || null) : null, path: present ? realpathSync(root) : null };
  };
  const canonicalSource = (() => {
    const common = { id: "cooptimize-formal-standards", authority_class: "formal_standard", repository: registry.repository, branch: registry.authoritative_branch, last_successful_check_ms: sync.last_successful_check_ms || null, last_successful_sync_ms: sync.last_successful_sync_ms || null, freshness, degraded: statusDegraded };
    const active = activeCanonicalGenerationUnlocked(options);
    if (!active.ok) return { ...common, state: sync.state || "unavailable", revision: null, path: null, detail: active.error || sync.detail || "no verified canonical generation" };
    return { ...common, state: statusDegraded ? "stale_last_known_good" : "available", revision: active.revision, generation_id: active.generation_id, path: active.checkout, detail: options.lockDetail || sync.detail || null, warnings: wikiArticles(active.checkout).warnings || [] };
  })();
  const statusPin = activeCanonicalGenerationUnlocked(options);
  const domains = Object.fromEntries(knownDomains(statusPin).map((d) => {
    let resolution = resolveStandard(d, { ...options, captureGeneration: statusPin, refresh: false, _canonicalLockHeld: true });
    if (options.lockUncertain) resolution = degradedLockResolution(resolution, options.lockDetail);
    return [d, Object.freeze({ ...resolution, freshness, degraded: canonicalSource.degraded, fallback: resolution.state === "bundled_fallback" || resolution.state === "stale_last_known_good", last_successful_check_ms: sync.last_successful_check_ms || null, last_successful_sync_ms: sync.last_successful_sync_ms || null })];
  }));
  return Object.freeze({
    canonical_remote: CANONICAL_REMOTE_STATE,
    repository: registry.repository,
    authoritative_branch: registry.authoritative_branch,
    freshness_seconds: registry.freshness_seconds,
    last_successful_check_ms: sync.last_successful_check_ms || null,
    last_successful_sync_ms: sync.last_successful_sync_ms || null,
    // The last refresh attempt, separate from the freshness window: a window that
    // expired since a successful launch refresh is not a failed refresh.
    last_attempt_ms: sync.last_attempt_ms || null,
    last_attempt_ok: Object.keys(sync).length ? sync.ok !== false : null,
    detail: sync.detail || null,
    freshness,
    degraded: statusDegraded,
    sources: Object.freeze([
      Object.freeze(canonicalSource),
      source("cooptimize/incremental-bi", "approved_pattern", options.incrementalBiRoot || configured.incrementalBiRoot, "unavailable"),
      source("cooptimize/coop-team-knowledge", "team_knowledge", options.teamKnowledgeRoot || configured.teamKnowledgeRoot, "unavailable"),
    ]),
    domains,
  });
}

export function sourceStatus(options = {}) {
  const storage = canonicalStorage(options);
  try { return withStorageLock(storage.base, "canonical-storage", options, () => sourceStatusUnlocked(options)); }
  catch (error) {
    try {
      return sourceStatusUnlocked({ ...options, lockUncertain: true, lockDetail: error.message, _canonicalLockHeld: true });
    } catch {
      return Object.freeze({ canonical_remote: CANONICAL_REMOTE_STATE, freshness: "uncertain", degraded: true, detail: error.message, sources: Object.freeze([]), domains: Object.freeze({}) });
    }
  }
}

function configuredKnowledgeRoots(options = {}) {
  const out = { incrementalBiRoot: null, teamKnowledgeRoot: null };
  const config = options.coopConfig || coopConfigPath();
  const parsed = safeJson(config);
  for (const repo of parsed?.knowledge?.repos || []) {
    if (!repo || typeof repo.local_path !== "string") continue;
    let path = repo.local_path;
    if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) path = join(homedir(), path.slice(2));
    const identity = `${repo.name || ""} ${repo.url || ""} ${path}`;
    if (/incremental-bi/i.test(identity)) out.incrementalBiRoot = resolve(path);
    if (/coop-team-knowledge/i.test(identity)) out.teamKnowledgeRoot = resolve(path);
  }
  return out;
}

function atomicJson(path, value) {
  assertSafeStorageRoot(dirname(path));
  const temp = join(dirname(path), `.${process.pid}-${randomBytes(12).toString("hex")}.tmp`);
  try { writeDurable(temp, JSON.stringify(value, null, 2) + "\n"); renameSync(temp, path); fsyncDirectory(dirname(path)); }
  finally { rmSync(temp, { force: true }); }
}
function writeDurable(path, value) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
}
export function fsyncDirectory(path, options = {}) {
  const fd = (options.open || openSync)(path, "r");
  try {
    try { (options.fsync || fsyncSync)(fd); }
    catch (error) {
      const unsupported = (options.platform || process.platform) === "win32" && ["EINVAL", "ENOTSUP", "EBADF", "EPERM"].includes(error?.code);
      if (!unsupported) throw error;
    }
  } finally {
    (options.close || closeSync)(fd);
  }
}
export function fsyncFile(path, options = {}) {
  const platform = options.platform || process.platform;
  // FlushFileBuffers requires a write-capable handle on Windows. Opening an
  // existing checkout file r+ does not alter its bytes, but gives fsync the
  // handle access it requires instead of producing EPERM on a read handle.
  const fd = (options.open || openSync)(path, platform === "win32" ? "r+" : "r");
  try { (options.fsync || fsyncSync)(fd); }
  finally { (options.close || closeSync)(fd); }
}
function fsyncTree(root) {
  const absolute = realpathSync(root), directories = [];
  const walk = (dir) => {
    if (!inside(dir, absolute)) throw new Error("durability walk escaped canonical checkout");
    directories.push(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name), info = lstatSync(path);
      // The completed git process owns durability for its object database.
      // Walking .git would require write handles for immutable Windows object
      // files; this pass flushes only the generation's authoritative payload.
      if (dir === absolute && entry.name === ".git") continue;
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) walk(path);
      else if (info.isFile()) {
        if (!inside(path, absolute)) throw new Error("durability file escaped canonical checkout");
        fsyncFile(path);
      }
    }
  };
  walk(absolute);
  for (const dir of directories.reverse()) fsyncDirectory(dir);
}
function assertSafeStorageRoot(path, create = true) {
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  let current = absolute.startsWith(sep) ? sep : parts.shift();
  for (const part of parts) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`unsafe symlink/reparse storage path: ${current}`);
  }
  if (create && !existsSync(absolute)) mkdirSync(absolute, { recursive: true, mode: 0o700 });
  if (existsSync(absolute) && !directoryUnsymbolic(absolute)) throw new Error(`unsafe storage root: ${absolute}`);
  return absolute;
}
function repositoryIdentity(value) {
  const s = String(value || "").trim().replace(/\\/g, "/").replace(/\/$/, "").replace(/\.git$/, "");
  if (!s.includes("://") && !/^git@/i.test(s)) { try { return realpathSync(resolve(s)); } catch { return resolve(s); } }
  return s.replace(/^git@github\.com:/i, "https://github.com/").toLowerCase();
}
function gitRun(args, options, cwd = null) {
  if (options.runner) return options.runner(args, { cwd, timeout: options.timeoutMs });
  return spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: cwd || undefined, encoding: "utf8", timeout: options.timeoutMs, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_ASKPASS: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
/** Schema 2 indexes the wiki articles per coop domain. Schema 1 generations (the
 * standards.yml era) no longer match and are re-fetched on the next refresh. */
function retrievalIndex(root, _registry, revision) {
  const loaded = wikiManifest(root);
  if (loaded.error) throw new Error(loaded.error);
  const domains = {};
  for (const [domain, entry] of Object.entries(loaded.manifest.domains)) {
    domains[domain] = { file: entry.file, sha256: entry.sha256, articles: entry.articles.map(({ file, sha256: articleSha256, id, title, layer, artifact, technology }) => ({ file, sha256: articleSha256, id, title, layer, artifact, technology })) };
  }
  return { schema_version: 2, revision, domains };
}

function canonicalStorage(options = {}) {
  const legacy = resolve(options.canonicalRoot || process.env.COOP_STANDARDS_ROOT || join(coopProfileDir(), "standards", "canonical"));
  const base = dirname(legacy);
  return {
    legacy, base,
    generations: resolve(options.generationsRoot || join(base, "canonical-generations")),
    pointer: resolve(options.activePointerPath || join(base, "active-generation.json")),
    state: resolve(options.statePath || process.env.COOP_STANDARDS_STATE || join(base, "status.json")),
  };
}

/** Content fingerprint of a canonical checkout (#138): the git metadata that decides
 * verifyCanonicalCheckout (HEAD, config, packed-refs, index, every ref file) and the path,
 * type, mode and bytes of every working-tree file, symlinks by target. Any edit, new or removed
 * file, branch switch, ref move or staged change gives a different fingerprint. Null
 * (no caching) for anything unexpected or a tree too large to hash per prompt. */
const MAX_FINGERPRINT_ENTRIES = 5000, MAX_FINGERPRINT_BYTES = 32 * 1024 * 1024;
function checkoutFingerprint(checkout) {
  try {
    if (!directoryUnsymbolic(checkout) || !directoryUnsymbolic(join(checkout, ".git")) || existsSync(join(checkout, ".git", "reftable"))) return null;
    const hash = createHash("sha256");
    let entries = 0, bytes = 0;
    const add = (label, value) => { hash.update(`${label}\0${value.length}\0`); hash.update(value); };
    const walk = (dir, rel, skipGit) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (skipGit && entry.name === ".git") continue;
        if (++entries > MAX_FINGERPRINT_ENTRIES) throw new Error("checkout too large to fingerprint");
        const path = join(dir, entry.name), name = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) add(`l:${name}`, Buffer.from(readlinkSync(path)));
        else if (entry.isDirectory()) { add(`d:${name}`, Buffer.alloc(0)); walk(path, name, false); }
        else if (entry.isFile()) {
          const content = readFileSync(path);
          if ((bytes += content.length) > MAX_FINGERPRINT_BYTES) throw new Error("checkout too large to fingerprint");
          // The mode too: git status reports an executable-bit change as a modification.
          add(`f:${(lstatSync(path).mode & 0o777).toString(8)}:${name}`, content);
        } else throw new Error("unexpected file type in checkout");
      }
    };
    const git = join(checkout, ".git");
    for (const name of ["HEAD", "config", "packed-refs", "index"]) {
      const path = join(git, name);
      if (!existsSync(path)) { add(`g:${name}`, Buffer.from("absent")); continue; }
      if (!regularUnsymbolic(path)) return null;
      add(`g:${name}`, readFileSync(path));
    }
    if (directoryUnsymbolic(join(git, "refs"))) walk(join(git, "refs"), ".git/refs", false);
    walk(checkout, "", true);
    return hash.digest("hex");
  } catch { return null; }
}

/** Successful verifications, reused while the checkout's fingerprint is unchanged. A warm
 * prompt then verifies with file reads instead of five git processes per generation read.
 * Only ok results are kept; any failure, or a change during verification, re-verifies. */
const verifiedCheckouts = new Map();
function verifyCanonicalCheckout(checkout, options, expectedRevision = null, resolvedAuthority = null) {
  options = Object.freeze({ ...options });
  const authority = resolvedAuthority || standardsAuthority(options);
  if (!directoryUnsymbolic(checkout)) return { ok: false, error: "canonical checkout is missing, unsafe, or dirty" };
  const c = authority.registry.canonical;
  const cacheKey = options.runner ? null : JSON.stringify([realpathSync(checkout), expectedRevision || "", repositoryIdentity(authority.remote), c.repository, c.authoritative_branch]);
  const before = cacheKey ? checkoutFingerprint(checkout) : null;
  const cached = before && verifiedCheckouts.get(cacheKey);
  if (cached && cached.fingerprint === before) return { ...cached.result };
  const result = verifyCanonicalCheckoutUncached(checkout, options, expectedRevision, authority);
  if (result.ok && before && checkoutFingerprint(checkout) === before) {
    if (verifiedCheckouts.size > 16) verifiedCheckouts.clear();
    verifiedCheckouts.set(cacheKey, { fingerprint: before, result: Object.freeze({ ...result }) });
  }
  return result;
}

function verifyCanonicalCheckoutUncached(checkout, options, expectedRevision, authority) {
  const registry = authority.registry, c = registry.canonical;
  const expectedRemote = authority.remote;
  if (!directoryUnsymbolic(checkout) || gitDirty(checkout) !== false) return { ok: false, error: "canonical checkout is missing, unsafe, or dirty" };
  const runOptions = { ...options, timeoutMs: options.timeoutMs || c.timeout_seconds * 1000 };
  const remote = gitRun(["config", "--get", "remote.origin.url"], runOptions, checkout);
  const branch = gitRun(["symbolic-ref", "--short", "HEAD"], runOptions, checkout);
  const revision = gitRevision(checkout);
  const remoteRef = `refs/remotes/origin/${c.authoritative_branch}`;
  const authoritative = gitRun(["rev-parse", "--verify", remoteRef], runOptions, checkout);
  if (remote.status !== 0 || repositoryIdentity(remote.stdout) !== repositoryIdentity(expectedRemote)) return { ok: false, error: "canonical repository identity mismatch" };
  if (branch.status !== 0 || branch.stdout.trim() !== c.authoritative_branch) return { ok: false, error: "canonical checkout is not authoritative main" };
  if (!/^[0-9a-f]{40}$/.test(revision) || (expectedRevision && revision !== expectedRevision)) return { ok: false, error: "canonical checkout revision mismatch" };
  const remoteCommit = authoritative.status === 0 ? authoritative.stdout.trim() : "";
  if (!/^[0-9a-f]{40}$/.test(remoteCommit) || remoteCommit !== revision) return { ok: false, error: "canonical checkout is not the fetched authoritative remote main" };
  const errors = authorityRootErrors(checkout, { ...options, repository: c.repository, branch: c.authoritative_branch });
  return errors.length ? { ok: false, error: errors.join("; ") } : { ok: true, revision, remote_ref: remoteRef, remote_commit: remoteCommit };
}

function resolveCanonicalGeneration(storage, generationId, revision, metadataSha256, options = {}) {
  try {
    assertSafeStorageRoot(storage.base, false);
    if (typeof generationId !== "string" || !/^[0-9a-f]{40}-[A-Za-z0-9]+$/.test(generationId) || typeof revision !== "string" || !/^[0-9a-f]{40}$/.test(revision) ||
        typeof metadataSha256 !== "string" || !/^[0-9a-f]{64}$/.test(metadataSha256)) throw new Error("canonical generation identity is invalid");
    const generation = join(storage.generations, generationId);
    if (!directoryUnsymbolic(storage.generations) || !directoryUnsymbolic(generation) || !inside(generation, storage.generations)) throw new Error("active canonical generation target is unsafe");
    const metadataPath = join(generation, "generation.json"), indexPath = join(generation, "retrieval-index.json"), checkout = join(generation, "checkout");
    if (!regularUnsymbolic(metadataPath) || !regularUnsymbolic(indexPath) || sha256(metadataPath) !== metadataSha256) throw new Error("canonical generation metadata/index is missing or unsafe");
    const metadata = safeJson(metadataPath), index = safeJson(indexPath), c = standardsRegistry(options).canonical;
    // Generations written before the anchor pin was dropped still carry `anchor`; it is ignored.
    const metadataKeys = plainObject(metadata) ? Object.keys(metadata).filter((key) => key !== "anchor").sort().join("|") : "";
    if (metadataKeys !== "branch|domains|generation_id|index_sha256|remote_commit|remote_ref|remote_verified_ms|repository|revision|schema_version" ||
        metadata.schema_version !== 1 || metadata.generation_id !== generationId || metadata.revision !== revision || metadata.repository !== c.repository || metadata.branch !== c.authoritative_branch ||
        metadata.remote_ref !== `refs/remotes/origin/${c.authoritative_branch}` || metadata.remote_commit !== revision || !Number.isFinite(metadata.remote_verified_ms) || metadata.remote_verified_ms < 0 || metadata.index_sha256 !== sha256(indexPath) ||
        JSON.stringify(metadata.domains) !== JSON.stringify(index?.domains)) throw new Error("canonical generation metadata/pointer disagreement");
    const checkoutResult = verifyCanonicalCheckout(checkout, options, revision);
    if (!checkoutResult.ok || checkoutResult.remote_ref !== metadata.remote_ref || checkoutResult.remote_commit !== metadata.remote_commit) throw new Error(checkoutResult.error || "canonical remote-main binding mismatch");
    const expectedIndex = retrievalIndex(checkout, standardsRegistry(options), revision);
    if (JSON.stringify(index) !== JSON.stringify(expectedIndex)) throw new Error("canonical retrieval index revision/hash mismatch");
    return Object.freeze({ ok: true, generation_id: generationId, revision, generation: realpathSync(generation), checkout: realpathSync(checkout), index: realpathSync(indexPath), remote_ref: metadata.remote_ref, remote_commit: metadata.remote_commit, remote_verified_ms: metadata.remote_verified_ms, domains: Object.freeze(structuredClone(index.domains)) });
  } catch (e) { return { ok: false, error: e.message }; }
}

function activeCanonicalGenerationUnlocked(options = {}) {
  try {
    const storage = canonicalStorage(options);
    assertSafeStorageRoot(storage.base, false);
    if (!regularUnsymbolic(storage.pointer)) throw new Error("active canonical generation pointer is missing or unsafe");
    const pointer = safeJson(storage.pointer);
    if (!plainObject(pointer) || Object.keys(pointer).sort().join("|") !== "generation_id|metadata_sha256|revision|schema_version" || pointer.schema_version !== 1) throw new Error("active canonical generation pointer is invalid");
    return resolveCanonicalGeneration(storage, pointer.generation_id, pointer.revision, pointer.metadata_sha256, options);
  } catch (e) { return { ok: false, error: e.message }; }
}

export function activeCanonicalGeneration(options = {}) {
  const storage = canonicalStorage(options);
  try { return withStorageLock(storage.base, "canonical-storage", options, () => activeCanonicalGenerationUnlocked(options)); }
  catch (e) {
    // The active pointer is atomic and generations are immutable/non-pruned.
    // Lock uncertainty therefore degrades to a verified read-only LKG; it never
    // permits refresh, deletion, or lock recovery.
    const lkg = activeCanonicalGenerationUnlocked(options);
    if (lkg.ok) return Object.freeze({ ...lkg, state: "stale_last_known_good", degraded: true, uncertain: true, detail: e.message });
    return { ok: false, error: e.message, degraded: true, uncertain: true };
  }
}

/** Refresh only the configured default branch into a verified atomic cache. */
function refreshCanonicalUnlocked(options = {}) {
  options = Object.freeze({ ...options });
  const authority = standardsAuthority(options);
  const registry = authority.registry, c = registry.canonical;
  const expectedRemote = authority.remote;
  const storage = canonicalStorage(options), statePath = storage.state;
  const now = Number(options.now ? options.now() : Date.now());
  if (!Number.isFinite(now) || now < 0) return Object.freeze({ ok: false, state: "unavailable", degraded: true, changed: false, detail: "canonical refresh clock is invalid" });
  let previous = safeJson(statePath) || {};
  let active = activeCanonicalGenerationUnlocked(options);
  if (active.ok && (previous.revision !== active.revision || previous.generation_id !== active.generation_id)) {
    const verifiedAt = active.remote_verified_ms;
    const newerFailure = previous.degraded === true && Number(previous.last_attempt_ms || 0) >= verifiedAt;
    previous = { ...previous, ok: !newerFailure, state: newerFailure ? "stale_last_known_good" : "fresh", degraded: newerFailure,
      revision: active.revision, generation_id: active.generation_id, last_successful_check_ms: verifiedAt,
      last_successful_sync_ms: previous.last_successful_sync_ms || verifiedAt, repository: c.repository, branch: c.authoritative_branch, reconciled: true };
    atomicJson(statePath, previous);
  }
  const age = now - Number(previous.last_successful_check_ms || 0);
  if (!options.force && previous.ok === true && previous.degraded !== true && Number(previous.last_attempt_ms || 0) <= Number(previous.last_successful_check_ms || 0) &&
      active.ok && previous.revision === active.revision && previous.generation_id === active.generation_id && previous.last_successful_check_ms && age < c.freshness_seconds * 1000) {
    return { ok: true, skipped: true, state: "fresh", revision: active.revision, generation_id: active.generation_id, changed: false };
  }
  const runOptions = { ...options, timeoutMs: options.timeoutMs || c.timeout_seconds * 1000 };
  assertSafeStorageRoot(storage.base); assertSafeStorageRoot(storage.generations);
  const nonce = `${process.pid}-${Date.now().toString(36)}-${randomBytes(12).toString("hex")}`;
  const stage = join(storage.generations, `.stage-${nonce}`), checkout = join(stage, "checkout");
  mkdirSync(stage, { mode: 0o700 });
  writeDurable(join(stage, ".owner.json"), JSON.stringify({ pid: process.pid, created_ms: Date.now() }) + "\n");
  let result;
  const fault = (step) => { if (typeof options.fault === "function") options.fault(step); else if (options.fault === step) throw new Error(`fault injected at ${step}`); };
  try {
    const cloned = gitRun(["clone", "--quiet", "--no-tags", "--single-branch", "--branch", c.authoritative_branch, "--config", "core.hooksPath=/dev/null", "--config", "core.autocrlf=false", "--", expectedRemote, checkout], runOptions);
    if (cloned.error || cloned.status !== 0) throw new Error(cloned.error?.code === "ETIMEDOUT" ? "canonical refresh timed out" : "canonical remote unavailable or authentication required");
    fault("canonical:clone");
    const verified = verifyCanonicalCheckout(checkout, options, null, authority);
    if (!verified.ok) throw new Error(verified.error);
    const revision = verified.revision, index = retrievalIndex(checkout, registry, revision);
    fault("canonical:verified");
    const indexPath = join(stage, "retrieval-index.json");
    writeDurable(indexPath, JSON.stringify(index, null, 2) + "\n");
    fault("canonical:index");
    const generationId = `${revision}-${randomBytes(12).toString("hex")}`;
    rmSync(join(stage, ".owner.json"), { force: true });
    const metadata = { schema_version: 1, generation_id: generationId, revision, repository: c.repository, branch: c.authoritative_branch,
      remote_ref: verified.remote_ref, remote_commit: verified.remote_commit, remote_verified_ms: now, index_sha256: sha256(indexPath), domains: index.domains };
    writeDurable(join(stage, "generation.json"), JSON.stringify(metadata, null, 2) + "\n");
    fault("canonical:metadata");
    fsyncTree(checkout);
    fsyncDirectory(stage);
    const final = join(storage.generations, generationId);
    renameSync(stage, final); fsyncDirectory(storage.generations);
    fault("canonical:generation");
    const metadataSha256 = sha256(join(final, "generation.json"));
    const candidate = resolveCanonicalGeneration(storage, generationId, revision, metadataSha256, options);
    if (!candidate.ok) throw new Error(candidate.error);
    fault("canonical:before-pointer");
    atomicJson(storage.pointer, { schema_version: 1, generation_id: generationId, revision, metadata_sha256: metadataSha256 });
    fault("canonical:after-pointer");
    active = activeCanonicalGenerationUnlocked(options);
    if (!active.ok || active.generation_id !== generationId) throw new Error(active.error || "active generation did not advance");
    const changed = previous.revision !== revision;
    const successfulSync = changed || !previous.last_successful_sync_ms ? now : previous.last_successful_sync_ms;
    result = { ok: true, state: "fresh", revision, generation_id: generationId, changed, last_successful_check_ms: now, last_successful_sync_ms: successfulSync };
    fault("canonical:before-state");
    atomicJson(statePath, { ...result, repository: c.repository, branch: c.authoritative_branch, last_attempt_ms: now });
    fault("canonical:after-state");

  } catch (e) {
    active = activeCanonicalGenerationUnlocked(options);
    result = { ok: false, state: active.ok ? "stale_last_known_good" : "unavailable", degraded: true, revision: active.ok ? active.revision : (previous.revision || null), generation_id: active.ok ? active.generation_id : (previous.generation_id || null), changed: false, detail: String(e.message || e) };
    atomicJson(statePath, { ...previous, ...result, repository: c.repository, branch: c.authoritative_branch, last_attempt_ms: now });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return Object.freeze(result);
}

export function refreshCanonical(options = {}) {
  const storage = canonicalStorage(options);
  try { return withStorageLock(storage.base, "canonical-storage", options, () => refreshCanonicalUnlocked(options)); }
  catch (e) {
    const lkg = activeCanonicalGenerationUnlocked(options);
    return Object.freeze({
      ok: false,
      state: lkg.ok ? "stale_last_known_good" : "unavailable",
      degraded: true,
      uncertain: true,
      revision: lkg.ok ? lkg.revision : null,
      generation_id: lkg.ok ? lkg.generation_id : null,
      changed: false,
      detail: e.message,
    });
  }
}



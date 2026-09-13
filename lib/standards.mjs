import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const DOMAINS = Object.freeze(["sql", "dax", "semantic_model", "fabric", "documentation"]);
export const AUTHORITY_CLASSES = Object.freeze(["formal_standard", "approved_pattern", "team_knowledge", "project_local"]);
export const RESOLUTION_STATES = Object.freeze(["canonical", "project_override", "stale_last_known_good", "bundled_fallback", "auth_required", "unavailable"]);
export const CANONICAL_REMOTE_STATE = "PENDING_OWNER_PROVISIONING";

const ACTION_RE = /\b(create|write|add|modify|change|edit|repair|fix|review|audit|explain|plan|design|architect|refactor)\b/i;
const SQL_RE = /\b(sql|t-?sql|stored procedure|procedure|view|warehouse|lakehouse|query)\b|\.sql\b/i;
const DAX_RE = /\b(dax|measure|calculation group|calculated (?:column|table)|expression)\b|\.dax\b/i;
const MODEL_RE = /\b(semantic model|tabular model|star schema|relationship|cardinality|filter direction|fact table|dimension table|tmdl|\.bim)\b/i;
const DOC_RE = /\b(documentation|document|readme|glossary|metadata description)\b/i;
const INCREMENTAL_RE = /\b(incremental|partition|refresh policy|deployment pipeline|large model)\b/i;
const FULL_RE = /\b(full|complete|entire|all)\s+(?:standard|authority|guidance|document)/i;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function inside(path, root) {
  const rel = relative(realpathSync(root), realpathSync(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
function safeJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
function gitRevision(path) {
  try { return execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
}
function gitDirty(path) {
  try { return execFileSync("git", ["-C", path, "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() !== ""; }
  catch { return null; }
}
function scalar(after) {
  const s = after.trim();
  if (!s) return "";
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

/** Backward-compatible block-YAML reader for standards.<domain> scalar paths. */
export function projectStandardPaths(text) {
  const out = {};
  let active = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const body = raw.trim();
    if (!body || body.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) { active = body === "standards:"; continue; }
    if (!active || indent < 2) continue;
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(body);
    if (m && DOMAINS.includes(m[1])) out[m[1]] = scalar(m[2]);
  }
  return out;
}

export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return ["manifest must be an object"];
  if (manifest.schema_version !== 1) errors.push("schema_version must be 1");
  if (!manifest.revision || typeof manifest.revision !== "string") errors.push("revision is required");
  if (!manifest.domains || typeof manifest.domains !== "object" || Array.isArray(manifest.domains)) errors.push("domains must be an object");
  else for (const [domain, entry] of Object.entries(manifest.domains)) {
    if (!DOMAINS.includes(domain)) errors.push(`unknown domain: ${domain}`);
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256 || "")) errors.push(`invalid domain entry: ${domain}`);
  }
  return errors;
}

function verifiedManifestEntry(root, domain, requestedState) {
  const manifestPath = join(root, "manifest.json");
  const manifest = safeJson(manifestPath);
  const errors = validateManifest(manifest);
  if (errors.length) return { error: `invalid manifest: ${errors.join("; ")}` };
  const entry = manifest.domains[domain];
  if (!entry) return { error: `domain not present: ${domain}` };
  const candidate = resolve(root, entry.path);
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return { error: "standard file missing" };
    if (!inside(candidate, root)) return { error: "standard path escapes source root" };
    const hash = sha256(candidate);
    if (hash !== entry.sha256) return { error: "standard hash mismatch" };
    return Object.freeze({
      domain, authority_class: "formal_standard", state: requestedState,
      path: realpathSync(candidate), revision: manifest.revision, sha256: hash,
      source: "cooptimize-formal-standards", source_root: realpathSync(root),
    });
  } catch (e) { return { error: `standard cannot be verified: ${e.message}` }; }
}

export function resolveStandard(domain, options = {}) {
  if (!DOMAINS.includes(domain)) throw new Error(`unsupported standards domain: ${domain}`);
  const cwd = resolve(options.cwd || ".");
  const contract = options.projectFile || findProjectContract(cwd);
  if (contract && existsSync(contract)) {
    const configured = projectStandardPaths(readFileSync(contract, "utf8"))[domain];
    if (configured) {
      const root = resolve(dirname(contract), "..");
      const path = isAbsolute(configured) ? resolve(configured) : resolve(root, configured);
      try {
        if (existsSync(path) && statSync(path).isFile()) return Object.freeze({
          domain, authority_class: "project_local", state: "project_override", path: realpathSync(path),
          revision: gitRevision(root) || "project-local", sha256: sha256(path), source: "project-contract", source_root: root,
        });
      } catch { /* fail soft through canonical */ }
    }
  }
  const canonicalRoot = resolve(options.canonicalRoot || process.env.COOP_STANDARDS_ROOT || join(homedir(), ".coop", "standards", "canonical"));
  if (existsSync(join(canonicalRoot, "manifest.json"))) {
    const hit = verifiedManifestEntry(canonicalRoot, domain, "canonical");
    if (!hit.error) return hit;
  }
  const staleRoot = resolve(options.staleRoot || process.env.COOP_STANDARDS_LKG_ROOT || join(homedir(), ".coop", "standards", "last-known-good"));
  if (existsSync(join(staleRoot, "manifest.json"))) {
    const hit = verifiedManifestEntry(staleRoot, domain, "stale_last_known_good");
    if (!hit.error) return hit;
  }
  if ((options.authRequired || false) && !["sql", "dax"].includes(domain)) return Object.freeze({ domain, authority_class: "formal_standard", state: "auth_required", path: null, revision: null, sha256: null, source: "cooptimize-formal-standards" });
  if (["sql", "dax"].includes(domain)) return Object.freeze({ domain, authority_class: "formal_standard", state: "bundled_fallback", path: null, revision: null, sha256: null, source: `coop-${domain}-review:bundled` });
  return Object.freeze({ domain, authority_class: "formal_standard", state: "unavailable", path: null, revision: null, sha256: null, source: "cooptimize-formal-standards" });
}

export function identifyTaskDomains(prompt) {
  const text = String(prompt || "");
  if (!ACTION_RE.test(text)) return [];
  const out = [];
  if (MODEL_RE.test(text)) out.push("semantic_model", "dax");
  else {
    if (SQL_RE.test(text)) out.push("sql");
    if (DAX_RE.test(text)) out.push("dax");
  }
  if ((out.includes("semantic_model") || out.length) && DOC_RE.test(text)) out.push("documentation");
  return [...new Set(out)];
}

const TOPICS = {
  sql: ["procedure", "query", "naming", "performance", "security", "format", "transaction", "error"],
  dax: ["measure", "calculation", "expression", "filter", "naming", "performance", "format"],
  semantic_model: ["architecture", "fact", "dimension", "relationship", "cardinality", "filter direction", "naming", "visibility", "technical", "metadata", "organization"],
  documentation: ["documentation", "description", "metadata", "glossary", "naming"],
  fabric: ["workspace", "lakehouse", "warehouse", "deployment", "security", "naming"],
};

/** Select heading sections relevant to a prompt; full authority is explicit opt-in. */
export function retrieveRelevantSections(resolution, prompt, options = {}) {
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
  const words = [...TOPICS[resolution.domain], ...String(prompt || "").toLowerCase().match(/[a-z][a-z-]{3,}/g) || []];
  const selected = chunks.filter((c) => words.some((w) => c.heading.toLowerCase().includes(w))).slice(0, 6);
  return (selected.length ? selected : chunks.slice(0, 2)).map((c) => ({ heading: c.heading, content: c.lines.join("\n").slice(0, 5000) }));
}

export function buildStandardsContext(prompt, options = {}) {
  const domains = identifyTaskDomains(prompt);
  const resolutions = domains.map((domain) => resolveStandard(domain, options));
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
        if (entry.isDirectory() && entry.name !== ".git") walk(path);
        else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(path);
      }
    };
    try { walk(incrementalRoot); } catch { /* approved patterns are optional */ }
    const selected = files.filter((p) => /increment|refresh|partition|deploy/i.test(p)).slice(0, 3);
    const candidates = selected.length ? selected : files.slice(0, 1);
    const sections = candidates.flatMap((path) => retrieveRelevantSections({ domain: "semantic_model", path }, prompt).map((section) => ({ path: realpathSync(path), ...section })));
    patterns.push(Object.freeze({ authority_class: "approved_pattern", source: "cooptimize/incremental-bi", source_root: realpathSync(incrementalRoot), selective: true, sections: Object.freeze(sections) }));
  }
  return Object.freeze({ domains, records: Object.freeze(records), patterns: Object.freeze(patterns) });
}

export function provenanceText(record) {
  const r = record.resolution;
  const sections = record.sections.map((s) => `## ${s.heading}\n${s.content}`).join("\n\n");
  return `[${r.domain}] authority=${r.authority_class} state=${r.state} source=${r.source} path=${r.path || "(reviewer bundled/unavailable)"} revision=${r.revision || "(none)"} sha256=${r.sha256 || "(none)"}${sections ? `\n${sections}` : ""}`;
}

export function reviewStandardsArgs(resolution) {
  return resolution && resolution.path ? ["--standards", resolution.path] : [];
}

export function sourceStatus(options = {}) {
  const canonicalRoot = resolve(options.canonicalRoot || process.env.COOP_STANDARDS_ROOT || join(homedir(), ".coop", "standards", "canonical"));
  const configured = configuredKnowledgeRoots(options);
  const source = (id, authority_class, root, absentState) => {
    const present = root && existsSync(root);
    return { id, authority_class, state: present ? (gitDirty(root) ? "dirty_preserved" : "available") : absentState, revision: present ? (gitRevision(root) || null) : null, path: present ? realpathSync(root) : null };
  };
  return Object.freeze({
    canonical_remote: CANONICAL_REMOTE_STATE,
    sources: Object.freeze([
      source("cooptimize-formal-standards", "formal_standard", canonicalRoot, CANONICAL_REMOTE_STATE),
      source("cooptimize/incremental-bi", "approved_pattern", options.incrementalBiRoot || configured.incrementalBiRoot, "unavailable"),
      source("cooptimize/coop-team-knowledge", "team_knowledge", options.teamKnowledgeRoot || configured.teamKnowledgeRoot, "unavailable"),
    ]),
    domains: Object.fromEntries(DOMAINS.map((d) => [d, resolveStandard(d, options)])),
  });
}

function configuredKnowledgeRoots(options = {}) {
  const out = { incrementalBiRoot: null, teamKnowledgeRoot: null };
  const coopBase = process.env.COOP_DIR || homedir();
  const config = options.coopConfig || join(coopBase, ".coop", "config");
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

/** Bootstrap/update only from an explicitly supplied local fake/source checkout.
 * The production canonical remote intentionally has no URL until its owner
 * provisions one. Dirty destinations are preserved and every failure is soft. */
export function syncCanonicalLocal(sourcePath, destination) {
  const source = resolve(sourcePath || "");
  const dest = resolve(destination || "");
  if (!sourcePath || /:\/\//.test(sourcePath) || !existsSync(join(source, ".git"))) {
    return { ok: false, state: "unavailable", detail: "only an existing local git source is accepted" };
  }
  if (existsSync(dest)) {
    const dirty = gitDirty(dest);
    if (dirty !== false) return { ok: false, state: dirty ? "dirty_preserved" : "unavailable", detail: "destination was not modified" };
    try {
      execFileSync("git", ["-C", dest, "fetch", source], { stdio: "ignore" });
      execFileSync("git", ["-C", dest, "merge", "--ff-only", "FETCH_HEAD"], { stdio: "ignore" });
    } catch { return { ok: false, state: "stale_last_known_good", detail: "fast-forward failed; existing checkout preserved" }; }
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    const temp = `${dest}.clone-${process.pid}`;
    rmSync(temp, { recursive: true, force: true });
    try {
      execFileSync("git", ["clone", "--quiet", "--", source, temp], { stdio: "ignore" });
      const manifest = safeJson(join(temp, "manifest.json"));
      const manifestErrors = validateManifest(manifest);
      if (manifestErrors.length) throw new Error(`invalid manifest: ${manifestErrors.join("; ")}`);
      for (const domain of Object.keys(manifest.domains)) {
        const verified = verifiedManifestEntry(temp, domain, "canonical");
        if (verified.error) throw new Error(verified.error);
      }
      renameSync(temp, dest);
    } catch (e) {
      rmSync(temp, { recursive: true, force: true });
      return { ok: false, state: "unavailable", detail: e.message };
    }
  }
  return { ok: true, state: "canonical", revision: gitRevision(dest), path: realpathSync(dest) };
}

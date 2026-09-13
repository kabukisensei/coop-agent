import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

export const DOMAINS = Object.freeze(["sql", "dax", "semantic_model", "fabric", "documentation"]);
export const AUTHORITY_CLASSES = Object.freeze(["formal_standard", "approved_pattern", "team_knowledge", "project_local"]);
export const RESOLUTION_STATES = Object.freeze(["canonical", "project_override", "stale_last_known_good", "bundled_fallback", "auth_required", "unavailable"]);
export const CANONICAL_REMOTE_STATE = "PENDING_OWNER_PROVISIONING";

const ACTION_RE = /\b(create|write|add|modify|change|edit|repair|fix|review|audit|explain|plan|design|architect|refactor|implement|validate|assess|analy[sz]e|inspect|optimi[sz]e|update|document|build|test|check)\b/i;
const SQL_RE = /\b(sql|t-?sql|stored procedure|sql procedure|sql query|select statement|insert statement|update statement|delete statement|merge statement|common table expression|cte|ddl|dml)\b|\.sql\b/i;
const DAX_RE = /\bdax\b|\.dax\b|\bcalculation group\b|\bcalculated (?:column|table)\b/i;
const DAX_CONCEPT_RE = /\b(measures?|calculations?|expressions?)\b/i;
const MODEL_RE = /\b(semantic model|tabular model|star schema|fact table|dimension table|tmdl)\b|\.bim\b|(?:\bpower bi\b.{0,100}\b(?:model|dataset|table relationships?|relationship cardinality|filter direction)\b|\b(?:table relationships?|relationship cardinality|filter direction)\b.{0,100}\bpower bi\b)/i;
const DOC_RE = /\b(documentation|document|readme|glossary|metadata description)\b/i;
const FABRIC_RE = /\b(?:microsoft fabric|lakehouse|fabric (?:workspace|notebook|pipeline|data pipeline|deployment pipeline|lakehouse|warehouse)|(?:workspace|notebook|pipeline|data pipeline|deployment pipeline|lakehouse|warehouse) (?:in|on|for) fabric|fabric medallion architecture)\b/i;
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
  // The committed schema is the runtime source of truth. This tiny evaluator
  // implements every keyword used by that schema without adding a dependency.
  const schema = JSON.parse(readFileSync(new URL("../config/standards-registry.schema.json", import.meta.url), "utf8"));
  const errors = [];
  const walk = (value, rule, at) => {
    if (rule.$ref) {
      const target = rule.$ref.split("/").slice(1).reduce((v, key) => v?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], schema);
      if (!target) errors.push(`${at}: unresolved schema reference`);
      else walk(value, target, at);
      return;
    }
    if (Object.hasOwn(rule, "const") && value !== rule.const) errors.push(`${at}: must equal ${JSON.stringify(rule.const)}`);
    if (rule.type === "object") {
      if (!value || typeof value !== "object" || Array.isArray(value)) { errors.push(`${at}: must be an object`); return; }
      for (const key of rule.required || []) if (!Object.hasOwn(value, key)) errors.push(`${at}: missing required property ${key}`);
      if (rule.additionalProperties === false) for (const key of Object.keys(value)) if (!Object.hasOwn(rule.properties || {}, key)) errors.push(`${at}: additional property ${key}`);
      for (const [key, child] of Object.entries(rule.properties || {})) if (Object.hasOwn(value, key)) walk(value[key], child, `${at}.${key}`);
    } else if (rule.type === "string") {
      if (typeof value !== "string") { errors.push(`${at}: must be a string`); return; }
      if (rule.minLength !== undefined && value.length < rule.minLength) errors.push(`${at}: is too short`);
      if (rule.pattern && !new RegExp(rule.pattern).test(value)) errors.push(`${at}: does not match required pattern`);
    }
  };
  walk(manifest, schema, "manifest");
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

function authorityRootErrors(root) {
  const manifest = safeJson(join(root, "manifest.json"));
  const errors = validateManifest(manifest);
  if (errors.length) return errors;
  for (const domain of Object.keys(manifest.domains)) {
    const result = verifiedManifestEntry(root, domain, "canonical");
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

function snapshotResolution(resolution, options) {
  if (!resolution?.path) return resolution;
  const sourcePath = realpathSync(resolution.path);
  const bytes = readFileSync(sourcePath);
  const hash = hashBytes(bytes);
  if (resolution.sha256 && resolution.sha256 !== hash) throw new Error("standard changed while it was being resolved");
  const root = resolve(options.snapshotRoot || process.env.COOP_STANDARDS_SNAPSHOT_ROOT || join(homedir(), ".coop", "standards", "snapshots"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = join(root, `${hash}-${resolution.domain}.md`);
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink() || !statSync(target).isFile() || !inside(target, root) || sha256(target) !== hash) throw new Error("immutable standards snapshot is invalid");
  } else {
    const temp = join(root, `.${hash}-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
    try {
      writeFileSync(temp, bytes, { flag: "wx", mode: 0o400 });
      try { renameSync(temp, target); }
      catch (e) {
        // Another process may have won the content-addressed write race.
        if (!existsSync(target) || lstatSync(target).isSymbolicLink() || !statSync(target).isFile() || sha256(target) !== hash) throw e;
      }
    } finally { rmSync(temp, { force: true }); }
  }
  chmodSync(target, 0o400);
  return Object.freeze({ ...resolution, path: realpathSync(target), source_path: sourcePath, sha256: hash, immutable: true });
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
    if (!reviewerProvenanceClaim(sourcePath, info.sha256, discovery).ok) return null;
    const roundTrip = spawnSync(bin, [...prefix, "check", probe, "--format", "json", "--standards", sourcePath], {
      cwd: probe, encoding: "utf8", timeout: 15000, maxBuffer: 5 * 1024 * 1024,
    });
    if (roundTrip.error || roundTrip.status !== 0) return null;
    const report = JSON.parse(roundTrip.stdout || "");
    if (!reviewerProvenanceClaim(sourcePath, info.sha256, report).ok) return null;
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
    });
  } catch { return null; }
  finally { rmSync(probe, { recursive: true, force: true }); }
}

export function resolveStandard(domain, options = {}) {
  if (!DOMAINS.includes(domain)) throw new Error(`unsupported standards domain: ${domain}`);
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
          const sourcePath = realpathSync(path);
          return snapshot(Object.freeze({
            domain, authority_class: "project_local", state: "project_override", path: sourcePath,
            revision: gitRevision(root) || "project-local", sha256: sha256(sourcePath), source: "project-contract", source_root: realpathSync(root),
          }));
        }
      } catch { /* unsafe, unreadable, or mutable project standards fail soft */ }
    }
  }
  const canonicalRoot = resolve(options.canonicalRoot || process.env.COOP_STANDARDS_ROOT || join(homedir(), ".coop", "standards", "canonical"));
  if (existsSync(canonicalRoot) && gitDirty(canonicalRoot) === false && authorityRootErrors(canonicalRoot).length === 0) {
    const hit = verifiedManifestEntry(canonicalRoot, domain, "canonical");
    if (!hit.error) try { return snapshot(hit); } catch { /* fail through to verified LKG */ }
  }
  const staleRoot = resolve(options.staleRoot || process.env.COOP_STANDARDS_LKG_ROOT || join(homedir(), ".coop", "standards", "last-known-good"));
  if (existsSync(join(staleRoot, "manifest.json"))) {
    const hit = verifiedManifestEntry(staleRoot, domain, "stale_last_known_good");
    if (!hit.error) try { return snapshot(hit); } catch { /* fail through */ }
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
  if (MODEL_RE.test(text)) out.push("semantic_model");
  if (SQL_RE.test(text) && !/\bpower query\b/i.test(text)) out.push("sql");
  if (DAX_RE.test(text) || (DAX_CONCEPT_RE.test(text) && (MODEL_RE.test(text) || /\bpower bi\b/i.test(text)))) out.push("dax");
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

function reviewerProvenanceClaim(expectedPath, expectedSha256, report) {
  try {
    const returned = report && typeof report === "object" && !Array.isArray(report) ? report.standards : null;
    if (!returned || typeof returned !== "object" || Array.isArray(returned)) return { ok: false, error: "reviewer standards provenance is missing" };
    if (typeof returned.path !== "string" || resolve(returned.path) !== resolve(expectedPath)) return { ok: false, error: "reviewer standards path mismatch" };
    if (realpathSync(returned.path) !== realpathSync(expectedPath)) return { ok: false, error: "reviewer standards path mismatch" };
    if (returned.sha256 !== expectedSha256) return { ok: false, error: "reviewer standards hash mismatch" };
    if (Object.hasOwn(returned, "revision") && (typeof returned.revision !== "string" || !returned.revision.trim())) return { ok: false, error: "reviewer standards revision claim is malformed" };
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
    const claim = reviewerProvenanceClaim(resolution.path, resolution.sha256, report);
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

export function sourceStatus(options = {}) {
  const canonicalRoot = resolve(options.canonicalRoot || process.env.COOP_STANDARDS_ROOT || join(homedir(), ".coop", "standards", "canonical"));
  const configured = configuredKnowledgeRoots(options);
  const source = (id, authority_class, root, absentState) => {
    const present = root && existsSync(root);
    return { id, authority_class, state: present ? (gitDirty(root) ? "dirty_preserved" : "available") : absentState, revision: present ? (gitRevision(root) || null) : null, path: present ? realpathSync(root) : null };
  };
  const canonicalSource = (() => {
    if (!existsSync(canonicalRoot)) return { id: "cooptimize-formal-standards", authority_class: "formal_standard", state: CANONICAL_REMOTE_STATE, revision: null, path: null };
    const dirty = gitDirty(canonicalRoot);
    if (dirty === true) return { id: "cooptimize-formal-standards", authority_class: "formal_standard", state: "dirty_preserved", revision: gitRevision(canonicalRoot) || null, path: realpathSync(canonicalRoot) };
    if (dirty === null) return { id: "cooptimize-formal-standards", authority_class: "formal_standard", state: "unavailable", revision: null, path: realpathSync(canonicalRoot), detail: "not a Git checkout" };
    const errors = authorityRootErrors(canonicalRoot);
    if (errors.length) return { id: "cooptimize-formal-standards", authority_class: "formal_standard", state: "invalid_preserved", revision: gitRevision(canonicalRoot) || null, path: realpathSync(canonicalRoot), detail: errors.join("; ") };
    return { id: "cooptimize-formal-standards", authority_class: "formal_standard", state: "available", revision: gitRevision(canonicalRoot) || null, path: realpathSync(canonicalRoot) };
  })();
  return Object.freeze({
    canonical_remote: CANONICAL_REMOTE_STATE,
    sources: Object.freeze([
      Object.freeze(canonicalSource),
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
    const errors = authorityRootErrors(dest);
    if (gitDirty(dest) !== false || errors.length) return { ok: false, state: "invalid_preserved", detail: `updated checkout failed verification: ${errors.join("; ") || "checkout is dirty"}` };
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    const temp = `${dest}.clone-${process.pid}`;
    rmSync(temp, { recursive: true, force: true });
    try {
      execFileSync("git", ["clone", "--quiet", "--", source, temp], { stdio: "ignore" });
      const errors = authorityRootErrors(temp);
      if (errors.length) throw new Error(`invalid authority: ${errors.join("; ")}`);
      renameSync(temp, dest);
    } catch (e) {
      rmSync(temp, { recursive: true, force: true });
      return { ok: false, state: "unavailable", detail: e.message };
    }
  }
  const finalErrors = authorityRootErrors(dest);
  if (gitDirty(dest) !== false || finalErrors.length) return { ok: false, state: "invalid_preserved", detail: `checkout failed final verification: ${finalErrors.join("; ") || "checkout is dirty"}` };
  return { ok: true, state: "canonical", revision: gitRevision(dest), path: realpathSync(dest) };
}

import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

export const DOMAINS = Object.freeze(["sql", "dax", "semantic_model", "fabric", "documentation"]);
export const AUTHORITY_CLASSES = Object.freeze(["formal_standard", "approved_pattern", "team_knowledge", "project_local"]);
export const RESOLUTION_STATES = Object.freeze(["canonical", "project_override", "stale_last_known_good", "bundled_fallback", "auth_required", "unavailable"]);
export const CANONICAL_REMOTE_STATE = "https://github.com/cooptimize/coop-standards.git#main";
const REGISTRY_PATH = new URL("../config/standards-registry.json", import.meta.url);

const ACTION_RE = /\b(create|write|add|modify|change|edit|repair|fix|review|audit|explain|plan|design|architect|refactor|implement|validate|assess|analy[sz]e|inspect|optimi[sz]e|update|document|build|test|check)\b/i;
const SQL_RE = /\b(sql|t-?sql|stored procedure|sql procedure|sql query|select statement|insert statement|update statement|delete statement|merge statement|common table expression|cte|ddl|dml)\b|\.sql\b/i;
const DAX_RE = /\bdax\b|\.dax\b|\bcalculation group\b|\bcalculated (?:column|table)\b/i;
const DAX_CONCEPT_RE = /\b(measures?|calculations?|expressions?)\b/i;
const MODEL_RE = /\b(semantic model|tabular model|star schema|fact table|dimension table|tmdl)\b|\.bim\b|(?:\bpower bi\b.{0,100}\b(?:model|dataset|(?:model )?relationships?|relationship cardinality|filter direction)\b|\b(?:model relationships?|table relationships?|relationship cardinality|filter direction)\b.{0,100}\bpower bi\b)/i;
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

export function standardsRegistry(options = {}) {
  const path = options.registryPath || process.env.COOP_STANDARDS_REGISTRY || REGISTRY_PATH;
  const registry = JSON.parse(readFileSync(path, "utf8"));
  const c = registry?.canonical;
  if (registry?.schema_version !== 1 || !c || typeof c.repository !== "string" || c.authoritative_branch !== "main" ||
      c.manifest !== "standards.yml" || !Number.isInteger(c.freshness_seconds) || c.freshness_seconds < 1 ||
      !Number.isInteger(c.timeout_seconds) || c.timeout_seconds < 1 || !c.domains || typeof c.domains !== "object") {
    throw new Error("managed standards registry is invalid");
  }
  return Object.freeze(registry);
}

function canonicalManifest(root, registry) {
  const path = join(root, registry.canonical.manifest);
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) return { error: "standards.yml is missing or not a regular file" };
  const text = readFileSync(path, "utf8");
  const scalarAt = (key) => text.match(new RegExp(`^\\s*${key}:\\s*([^#\\r\\n]+)`, "m"))?.[1].trim();
  if (scalarAt("schema_version") !== "1" || scalarAt("authority") !== "formal_standard" || scalarAt("authoritative_ref") !== "default_branch" || scalarAt("content_mode") !== "markdown_only" ||
      scalarAt("startup") !== "true" || scalarAt("task_freshness_minutes") !== "15" || scalarAt("force_command") !== "coop sync" ||
      scalarAt("failure_mode") !== "last_known_good" || scalarAt("pin_revision_per_task") !== "true" || scalarAt("invalidate_index_on_revision_change") !== "true") {
    return { error: "standards.yml authority/refresh contract is invalid" };
  }
  for (const required of ["project_override", "canonical_standard", "last_known_good", "bundled_fallback"]) if (!text.includes(`  - ${required}`)) return { error: "standards.yml precedence contract is invalid" };
  const domains = {};
  let inStandards = false, domain = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^standards:\s*$/.test(line)) { inStandards = true; continue; }
    if (!inStandards) continue;
    const dm = /^  ([a-z_]+):\s*$/.exec(line);
    if (dm) { domain = dm[1]; continue; }
    const pm = /^    path:\s*(\S+)\s*$/.exec(line);
    if (pm && domain) domains[domain] = pm[1];
    if (/^[^ ]/.test(line) && line.trim()) break;
  }
  const configured = registry.canonical.domains;
  if (Object.keys(domains).sort().join("|") !== Object.keys(configured).sort().join("|")) return { error: "standards.yml domain set differs from managed registry" };
  for (const [name, expected] of Object.entries(configured)) if (domains[name] !== expected || !isSafeRelativePath(expected)) return { error: `${name}: canonical path differs from managed registry` };
  const revision = gitRevision(root);
  if (!/^[0-9a-f]{40}$/.test(revision)) return { error: "canonical revision is unavailable" };
  const entries = {};
  for (const [name, rel] of Object.entries(domains)) {
    const candidate = resolve(root, rel);
    try {
      if (!existsSync(candidate) || lstatSync(candidate).isSymbolicLink() || !statSync(candidate).isFile() || !inside(candidate, root)) return { error: `${name}: standard is not a contained regular file` };
      entries[name] = { path: rel, sha256: sha256(candidate) };
    } catch (e) { return { error: `${name}: ${e.message}` }; }
  }
  return { manifest: { schema_version: 1, revision, domains: entries }, manifestPath: realpathSync(path) };
}

function authorityManifest(root, options = {}) {
  if (existsSync(join(root, "standards.yml"))) {
    try { return canonicalManifest(root, standardsRegistry(options)); } catch (e) { return { error: e.message }; }
  }
  const manifestPath = join(root, "manifest.json");
  const manifest = safeJson(manifestPath);
  const errors = validateManifest(manifest);
  return errors.length ? { error: `invalid manifest: ${errors.join("; ")}` } : { manifest, manifestPath: realpathSync(manifestPath) };
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

function verifiedManifestEntry(root, domain, requestedState, options = {}) {
  const loaded = authorityManifest(root, options);
  if (loaded.error) return { error: loaded.error };
  const manifest = loaded.manifest;
  const entry = manifest.domains[domain];
  if (!entry) return { error: `domain not present: ${domain}` };
  const candidate = resolve(root, entry.path);
  try {
    if (!existsSync(candidate) || lstatSync(candidate).isSymbolicLink() || !statSync(candidate).isFile()) return { error: "standard file missing or not regular" };
    if (!inside(candidate, root)) return { error: "standard path escapes source root" };
    const hash = sha256(candidate);
    if (hash !== entry.sha256) return { error: "standard hash mismatch" };
    return Object.freeze({
      domain, authority_class: "formal_standard", state: requestedState,
      path: realpathSync(candidate), revision: manifest.revision, sha256: hash,
      source: "cooptimize-formal-standards", source_root: realpathSync(root), source_manifest: loaded.manifestPath,
      repository: options.repository || null, branch: options.branch || null, commit: manifest.revision, file: entry.path,
    });
  } catch (e) { return { error: `standard cannot be verified: ${e.message}` }; }
}

function authorityRootErrors(root, options = {}) {
  const loaded = authorityManifest(root, options);
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
  const registry = standardsRegistry(options).canonical;
  const statePath = resolve(options.statePath || process.env.COOP_STANDARDS_STATE || join(dirname(canonicalRoot), "status.json"));
  const syncState = safeJson(statePath);
  const now = Number(options.now ? options.now() : Date.now());
  const managedCanonical = !options.canonicalRoot || Boolean(syncState);
  const stale = managedCanonical && (!syncState?.ok || !syncState.last_successful_check_ms || now - syncState.last_successful_check_ms >= registry.freshness_seconds * 1000);
  if (existsSync(canonicalRoot) && gitDirty(canonicalRoot) === false && authorityRootErrors(canonicalRoot, options).length === 0) {
    const hit = verifiedManifestEntry(canonicalRoot, domain, stale ? "stale_last_known_good" : "canonical", { ...options, repository: registry.repository, branch: registry.authoritative_branch });
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
  let refresh = null;
  if (domains.length && (options.refresh === true || !options.canonicalRoot) && options.refresh !== false) refresh = refreshCanonical(options);
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
  return Object.freeze({ domains, records: Object.freeze(records), patterns: Object.freeze(patterns), refresh });
}

export function provenanceText(record) {
  const r = record.resolution;
  const sections = record.sections.map((s) => `## ${s.heading}\n${s.content}`).join("\n\n");
  return `[${r.domain}] authority=${r.authority_class} state=${r.state} source=${r.source} path=${r.path || "(reviewer bundled/unavailable)"} revision=${r.revision || "(none)"} sha256=${r.sha256 || "(none)"}${sections ? `\n${sections}` : ""}`;
}

export function reviewStandardsArgs(resolution) {
  return resolution && resolution.path ? ["--standards", resolution.path] : [];
}

export function validateReviewerReport(domain, report) {
  const expectedTool = `coop-${domain}-review`;
  if (!report || typeof report !== "object" || Array.isArray(report)) return { ok: false, error: "reviewer report envelope is missing" };
  if (report.tool !== expectedTool) return { ok: false, error: `reviewer tool must be ${expectedTool}` };
  const expectedSchema = domain === "sql" ? 4 : 3;
  if (report.schema_version !== expectedSchema) return { ok: false, error: `reviewer schema_version must be ${expectedSchema}` };
  if (typeof report.version !== "string" || !report.version.trim()) return { ok: false, error: "reviewer version is invalid" };
  if (!Array.isArray(report.findings) || !Array.isArray(report.diagnostics) || !Array.isArray(report.agent_review)) return { ok: false, error: "reviewer findings/diagnostics/agent_review envelope is invalid" };
  for (const finding of report.findings) {
    if (!finding || typeof finding !== "object" || !["error", "warning", "info"].includes(finding.severity) ||
        typeof finding.rule_id !== "string" || typeof finding.message !== "string" || typeof finding.file !== "string" ||
        !Number.isInteger(finding.line) || finding.line < 0) return { ok: false, error: "reviewer finding schema is invalid" };
  }
  const summary = report.summary;
  if (!summary || !["error", "warning", "info"].every((key) => Number.isInteger(summary[key]) && summary[key] >= 0)) return { ok: false, error: "reviewer summary is invalid" };
  for (const severity of ["error", "warning", "info"]) if (summary[severity] !== report.findings.filter((f) => f.severity === severity).length) return { ok: false, error: "reviewer summary does not match findings" };
  if (!report.verdict || typeof report.verdict.clean !== "boolean" || !(report.verdict.highest_severity === null || ["error", "warning", "info"].includes(report.verdict.highest_severity))) return { ok: false, error: "reviewer verdict is invalid" };
  const highest = ["error", "warning", "info"].find((severity) => summary[severity] > 0) || null;
  if (report.verdict.clean !== (report.findings.length === 0) || report.verdict.highest_severity !== highest) return { ok: false, error: "reviewer verdict does not match findings" };
  const countKey = domain === "sql" ? "files_checked" : "models_checked";
  if (!Number.isInteger(report[countKey]) || report[countKey] < 0) return { ok: false, error: `reviewer ${countKey} is invalid` };
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

/** Validate and publish SQL+DAX reports/bindings as one rollback-capable run. */
export function promoteReviewRun(outdir, entries) {
  const verified = [];
  for (const entry of entries) {
    const resolution = JSON.parse(readFileSync(entry.resolutionPath, "utf8"));
    const report = JSON.parse(readFileSync(entry.reportPath, "utf8"));
    const bound = bindReviewerProvenance(resolution, report);
    if (!bound.ok) return { ok: false, error: `${resolution.domain || entry.domain} report rejected: ${bound.error}` };
    verified.push({ ...entry, binding: bound.binding });
  }
  const stage = mkdtempSync(join(resolve(outdir), ".review-transaction-"));
  const promoted = [], backups = [];
  const rollback = () => {
    for (const target of promoted.reverse()) rmSync(target, { force: true });
    for (const [backup, target] of backups.reverse()) if (existsSync(backup)) renameSync(backup, target);
    rmSync(stage, { recursive: true, force: true });
  };
  const onSignal = () => { rollback(); process.exit(130); };
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
  try {
    for (const entry of verified) {
      const reportTarget = join(resolve(outdir), `coop-${entry.domain}-review.json`);
      const bindingTarget = join(resolve(outdir), `coop-${entry.domain}-review.provenance.json`);
      const reportStage = join(stage, `${entry.domain}.json`), bindingStage = join(stage, `${entry.domain}.provenance.json`);
      writeFileSync(reportStage, readFileSync(entry.reportPath), { flag: "wx", mode: 0o600 });
      writeFileSync(bindingStage, JSON.stringify(entry.binding) + "\n", { flag: "wx", mode: 0o600 });
      for (const target of [reportTarget, bindingTarget]) if (existsSync(target)) { const backup = join(stage, `${backups.length}.backup`); renameSync(target, backup); backups.push([backup, target]); }
      renameSync(reportStage, reportTarget); promoted.push(reportTarget);
      renameSync(bindingStage, bindingTarget); promoted.push(bindingTarget);
    }
    rmSync(stage, { recursive: true, force: true });
    return { ok: true, bindings: Object.fromEntries(verified.map((x) => [x.domain, x.binding])) };
  } catch (e) { rollback(); return { ok: false, error: `review run promotion failed: ${e.message}` }; }
  finally { process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal); }
}

export function sourceStatus(options = {}) {
  const canonicalRoot = resolve(options.canonicalRoot || process.env.COOP_STANDARDS_ROOT || join(homedir(), ".coop", "standards", "canonical"));
  const registry = standardsRegistry(options).canonical;
  const statePath = resolve(options.statePath || process.env.COOP_STANDARDS_STATE || join(dirname(canonicalRoot), "status.json"));
  const sync = safeJson(statePath) || {};
  const now = Number(options.now ? options.now() : Date.now());
  const freshness = sync.last_successful_check_ms ? (now - sync.last_successful_check_ms < registry.freshness_seconds * 1000 ? "fresh" : "stale") : "never_checked";
  const statusDegraded = sync.degraded === true || ((!options.canonicalRoot || Object.keys(sync).length > 0) && freshness !== "fresh");
  const configured = configuredKnowledgeRoots(options);
  const source = (id, authority_class, root, absentState) => {
    const present = root && existsSync(root);
    return { id, authority_class, state: present ? (gitDirty(root) ? "dirty_preserved" : "available") : absentState, revision: present ? (gitRevision(root) || null) : null, path: present ? realpathSync(root) : null };
  };
  const canonicalSource = (() => {
    const common = { id: "cooptimize-formal-standards", authority_class: "formal_standard", repository: registry.repository, branch: registry.authoritative_branch, last_successful_check_ms: sync.last_successful_check_ms || null, last_successful_sync_ms: sync.last_successful_sync_ms || null, freshness, degraded: statusDegraded };
    if (!existsSync(canonicalRoot)) return { ...common, state: sync.state || "unavailable", revision: null, path: null, detail: sync.detail || "no verified canonical cache" };
    const dirty = gitDirty(canonicalRoot);
    if (dirty === true) return { ...common, state: "dirty_preserved", revision: gitRevision(canonicalRoot) || null, path: realpathSync(canonicalRoot) };
    if (dirty === null) return { ...common, state: "unavailable", revision: null, path: realpathSync(canonicalRoot), detail: "not a Git checkout" };
    const errors = authorityRootErrors(canonicalRoot, options);
    if (errors.length) return { ...common, state: "invalid_preserved", revision: gitRevision(canonicalRoot) || null, path: realpathSync(canonicalRoot), detail: errors.join("; ") };
    return { ...common, state: (!Object.keys(sync).length && options.canonicalRoot) ? "available" : (sync.degraded || freshness !== "fresh" ? "stale_last_known_good" : "available"), revision: gitRevision(canonicalRoot) || null, path: realpathSync(canonicalRoot), detail: sync.detail || null };
  })();
  const domains = Object.fromEntries(DOMAINS.map((d) => {
    const resolution = resolveStandard(d, options);
    return [d, Object.freeze({ ...resolution, freshness, degraded: canonicalSource.degraded, fallback: resolution.state === "bundled_fallback" || resolution.state === "stale_last_known_good", last_successful_check_ms: sync.last_successful_check_ms || null, last_successful_sync_ms: sync.last_successful_sync_ms || null })];
  }));
  return Object.freeze({
    canonical_remote: CANONICAL_REMOTE_STATE,
    repository: registry.repository,
    authoritative_branch: registry.authoritative_branch,
    freshness_seconds: registry.freshness_seconds,
    last_successful_check_ms: sync.last_successful_check_ms || null,
    last_successful_sync_ms: sync.last_successful_sync_ms || null,
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

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
  try { writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
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
function retrievalIndex(root, registry, revision) {
  const domains = {};
  for (const [domain, file] of Object.entries(registry.canonical.domains)) {
    const path = join(root, file), text = readFileSync(path, "utf8");
    domains[domain] = { file, sha256: sha256(path), headings: text.split(/\r?\n/).filter((x) => /^#{1,4}\s+/.test(x)).map((x) => x.replace(/^#{1,4}\s+/, "")) };
  }
  return { schema_version: 1, revision, domains };
}

/** Refresh only the configured default branch into a verified atomic cache. */
export function refreshCanonical(options = {}) {
  const registry = standardsRegistry(options), c = registry.canonical;
  const root = resolve(options.canonicalRoot || process.env.COOP_STANDARDS_ROOT || join(homedir(), ".coop", "standards", "canonical"));
  const statePath = resolve(options.statePath || process.env.COOP_STANDARDS_STATE || join(dirname(root), "status.json"));
  const indexPath = resolve(options.indexPath || join(dirname(root), "retrieval-index.json"));
  const now = Number(options.now ? options.now() : Date.now());
  const previous = safeJson(statePath) || {};
  const age = now - Number(previous.last_successful_check_ms || 0);
  if (!options.force && previous.last_successful_check_ms && age < c.freshness_seconds * 1000) return { ok: true, skipped: true, state: "fresh", revision: previous.revision || null, changed: false };
  const runOptions = { ...options, timeoutMs: options.timeoutMs || c.timeout_seconds * 1000 };
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  const stage = `${root}.stage-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const backup = `${root}.previous-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const indexStage = `${indexPath}.stage-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const indexBackup = `${indexPath}.previous-${process.pid}-${Math.random().toString(16).slice(2)}`;
  let result;
  try {
    const cloned = gitRun(["clone", "--quiet", "--no-tags", "--single-branch", "--branch", c.authoritative_branch, "--config", "core.hooksPath=/dev/null", "--", options.remote || c.repository, stage], runOptions);
    if (cloned.error || cloned.status !== 0) throw new Error(cloned.error?.code === "ETIMEDOUT" ? "canonical refresh timed out" : "canonical remote unavailable or authentication required");
    const remote = gitRun(["config", "--get", "remote.origin.url"], runOptions, stage);
    const branch = gitRun(["symbolic-ref", "--short", "HEAD"], runOptions, stage);
    const revision = gitRevision(stage);
    if (remote.status !== 0 || repositoryIdentity(remote.stdout) !== repositoryIdentity(options.remote || c.repository)) throw new Error("canonical repository identity mismatch");
    if (branch.status !== 0 || branch.stdout.trim() !== c.authoritative_branch) throw new Error("canonical checkout is not the authoritative branch");
    const ancestry = gitRun(["merge-base", "--is-ancestor", c.initial_verified_commit, "HEAD"], runOptions, stage);
    if (ancestry.status !== 0) throw new Error("canonical main does not descend from the configured verified commit");
    const verifyOptions = { ...options, repository: c.repository, branch: c.authoritative_branch };
    const errors = authorityRootErrors(stage, verifyOptions);
    if (errors.length || gitDirty(stage) !== false) throw new Error(`canonical verification failed: ${errors.join("; ") || "checkout is dirty"}`);
    const index = retrievalIndex(stage, registry, revision);
    const changed = previous.revision !== revision;
    if (changed || !existsSync(root)) {
      writeFileSync(indexStage, JSON.stringify(index, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      if (existsSync(root)) renameSync(root, backup);
      if (existsSync(indexPath)) renameSync(indexPath, indexBackup);
      try {
        renameSync(stage, root);
        renameSync(indexStage, indexPath);
      } catch (e) {
        rmSync(root, { recursive: true, force: true });
        rmSync(indexPath, { force: true });
        if (existsSync(backup)) renameSync(backup, root);
        if (existsSync(indexBackup)) renameSync(indexBackup, indexPath);
        throw e;
      }
      rmSync(backup, { recursive: true, force: true });
      rmSync(indexBackup, { force: true });
    }
    const successfulSync = changed || !previous.last_successful_sync_ms ? now : previous.last_successful_sync_ms;
    result = { ok: true, state: "fresh", revision, changed, last_successful_check_ms: now, last_successful_sync_ms: successfulSync };
    atomicJson(statePath, { ...result, repository: c.repository, branch: c.authoritative_branch, last_attempt_ms: now });
  } catch (e) {
    result = { ok: false, state: existsSync(root) ? "stale_last_known_good" : "unavailable", degraded: true, revision: previous.revision || (existsSync(root) ? gitRevision(root) : null), changed: false, detail: String(e.message || e) };
    atomicJson(statePath, { ...previous, ...result, repository: c.repository, branch: c.authoritative_branch, last_attempt_ms: now });
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
    rmSync(indexStage, { force: true });
    rmSync(indexBackup, { force: true });
  }
  return Object.freeze(result);
}

/** Revision-9 compatibility seam for explicitly supplied local legacy fixtures.
 * Production synchronization uses refreshCanonical and the managed main branch. */
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

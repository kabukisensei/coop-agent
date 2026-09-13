import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}
function processIdentity(pid) {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid < 1) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const tail = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
    // tail[0] is field 3 (state); field 22 (starttime) is therefore index 19.
    return /^\d+$/.test(tail[19] || "") ? `linux-proc-start:${tail[19]}` : null;
  } catch { return null; }
}
function ownerProcessAlive(owner) {
  if (!plainObject(owner) || !processAlive(owner.pid)) return false;
  const current = processIdentity(owner.pid);
  // Where a native identity is available, PID reuse must not preserve a dead
  // owner's lock. Other platforms remain conservative rather than stealing.
  return !owner.process_identity || !current || owner.process_identity === current;
}
function lockSnapshot(lock) {
  try {
    const info = statSync(lock), owner = safeJson(join(lock, "owner.json"));
    const acquired = plainObject(owner) && Number.isFinite(owner.acquired_ms) ? owner.acquired_ms : info.mtimeMs;
    return { dev: info.dev, ino: info.ino, owner, acquired, age: Date.now() - acquired };
  } catch { return null; }
}
function recoverStaleLock(lock, observed, staleMs) {
  if (!observed || observed.age < staleMs || ownerProcessAlive(observed.owner)) return false;
  // Revalidate inode and owner identity immediately before the atomic rename.
  // This prevents two stale-lock observers from deleting a replacement lock.
  const current = lockSnapshot(lock);
  const sameOwner = current && current.dev === observed.dev && current.ino === observed.ino &&
    current.owner?.pid === observed.owner?.pid && current.owner?.token === observed.owner?.token && current.owner?.acquired_ms === observed.owner?.acquired_ms;
  if (!sameOwner || current.age < staleMs || ownerProcessAlive(current.owner)) return false;
  const quarantine = `${lock}.recovered-${process.pid}-${randomBytes(12).toString("hex")}`;
  try {
    renameSync(lock, quarantine);
    const moved = lockSnapshot(quarantine);
    if (!moved || moved.dev !== current.dev || moved.ino !== current.ino || moved.owner?.token !== current.owner?.token) {
      if (!existsSync(lock)) renameSync(quarantine, lock);
      return false;
    }
    rmSync(quarantine, { recursive: true, force: true });
    return true;
  } catch { return false; }
  finally { rmSync(quarantine, { recursive: true, force: true }); }
}
function withStorageLock(root, name, options, fn) {
  assertSafeStorageRoot(root);
  const lock = join(root, `.${name}.lock`);
  const held = HELD_STORAGE_LOCKS.get(lock);
  if (held) {
    held.depth++;
    try { return fn(); } finally { held.depth--; }
  }
  const timeoutMs = Math.max(0, Number(options.lockTimeoutMs ?? 5000));
  const staleMs = Math.max(100, Number(options.lockStaleMs ?? 1000));
  const deadline = Date.now() + timeoutMs;
  const token = randomBytes(16).toString("hex");
  for (;;) {
    const candidate = `${lock}.candidate-${process.pid}-${randomBytes(12).toString("hex")}`;
    try {
      // Build complete owner metadata privately, then publish the non-empty
      // directory atomically. A contender can never observe a lock without an
      // owner record and mistake a paused initializer for abandoned state.
      mkdirSync(candidate, { mode: 0o700 });
      const owner = { schema_version: 1, pid: process.pid, process_identity: processIdentity(process.pid), acquired_ms: Date.now(), token };
      writeDurable(join(candidate, "owner.json"), JSON.stringify(owner) + "\n");
      fsyncDirectory(candidate);
      renameSync(candidate, lock);
      fsyncDirectory(root);
      HELD_STORAGE_LOCKS.set(lock, { depth: 1, token });
      break;
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error?.code)) {
        if (!existsSync(lock)) throw error;
      }
      // Never steal from a matching live process identity. Dead, reused, or
      // malformed ownership must still survive the conservative expiry.
      if (recoverStaleLock(lock, lockSnapshot(lock), staleMs)) continue;
      if (Date.now() >= deadline) throw new Error(`${name} storage lock is busy`);
      sleepSync(Math.min(25, Math.max(1, deadline - Date.now())));
    } finally {
      rmSync(candidate, { recursive: true, force: true });
    }
  }
  try { return fn(); }
  finally {
    const record = HELD_STORAGE_LOCKS.get(lock);
    if (record && --record.depth === 0) {
      HELD_STORAGE_LOCKS.delete(lock);
      try {
        const owner = safeJson(join(lock, "owner.json"));
        if (owner?.token === token && owner?.pid === process.pid) { rmSync(lock, { recursive: true, force: true }); fsyncDirectory(root); }
      } catch { /* a failed unlock degrades to bounded stale-lock recovery */ }
    }
  }
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
  if (options.fixtureAuthority !== true) return { error: "legacy manifest authority is allowed only for an explicit fixture" };
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
          const sourcePath = realpathSync(path);
          return snapshot(Object.freeze({
            domain, authority_class: "project_local", state: "project_override", path: sourcePath,
            revision: gitRevision(root) || "project-local", sha256: sha256(sourcePath), source: "project-contract", source_root: realpathSync(root),
          }));
        }
      } catch { /* unsafe, unreadable, or mutable project standards fail soft */ }
    }
  }
  if (options.fixtureRoot) {
    const root = resolve(options.fixtureRoot);
    const hit = verifiedManifestEntry(root, domain, options.fixtureState || "canonical", { ...options, fixtureAuthority: true });
    if (!hit.error) return snapshot(hit);
  }
  if (!options._canonicalLockHeld) {
    const storage = canonicalStorage(options);
    try { return withStorageLock(storage.base, "canonical-storage", options, () => resolveStandard(domain, { ...options, _canonicalLockHeld: true })); }
    catch (error) { return Object.freeze({ domain, authority_class: "formal_standard", state: "unavailable", path: null, revision: null, sha256: null, source: "canonical-lock-degraded", detail: error.message }); }
  }
  const canonicalRoot = resolve(options.canonicalRoot || process.env.COOP_STANDARDS_ROOT || join(homedir(), ".coop", "standards", "canonical"));
  const registry = standardsRegistry(options).canonical;
  const statePath = resolve(options.statePath || process.env.COOP_STANDARDS_STATE || join(dirname(canonicalRoot), "status.json"));
  const syncState = safeJson(statePath);
  const now = Number(options.now ? options.now() : Date.now());
  const stale = !syncState?.ok || !syncState.last_successful_check_ms || now - syncState.last_successful_check_ms >= registry.freshness_seconds * 1000;
  const generation = options.captureGeneration || activeCanonicalGeneration(options);
  if (generation?.ok) {
    const hit = verifiedManifestEntry(generation.checkout, domain, stale ? "stale_last_known_good" : "canonical", { ...options, repository: registry.repository, branch: registry.authoritative_branch });
    const indexed = generation.domains?.[domain];
    if (!hit.error && indexed && hit.revision === generation.revision && hit.file === indexed.file && hit.sha256 === indexed.sha256) {
      try { return snapshot(hit); } catch { /* fail through to verified LKG */ }
    }
  }
  const staleRoot = options.fixtureAuthority === true && options.staleRoot ? resolve(options.staleRoot) : null;
  if (staleRoot && existsSync(join(staleRoot, "manifest.json"))) {
    const hit = verifiedManifestEntry(staleRoot, domain, "stale_last_known_good", { ...options, fixtureAuthority: true });
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

export function pinStandardsTask(domains, options = {}) {
  if (!Array.isArray(domains) || domains.some((domain) => !DOMAINS.includes(domain))) throw new Error("task standards domains are invalid");
  let refresh = null, taskPin = null, initialized = false;
  const byDomain = new Map();
  const initialize = () => {
    if (initialized) return;
    initialized = true;
    if (options.refresh !== false && (options.refresh === true || !options.canonicalRoot)) refresh = refreshCanonical(options);
    const storage = canonicalStorage(options);
    try {
      withStorageLock(storage.base, "canonical-storage", options, () => {
        const generation = activeCanonicalGeneration(options);
        const captureOptions = { ...options, refresh: false, captureGeneration: generation };
        for (const domain of DOMAINS) byDomain.set(domain, resolveStandard(domain, captureOptions));
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
      for (const domain of DOMAINS) byDomain.set(domain, Object.freeze({ domain, authority_class: "formal_standard", state: "unavailable", path: null, revision: null, sha256: null, source: "canonical-lock-degraded", detail: error.message }));
      taskPin = Object.freeze({ verified: true, generation_id: null, revision: null, domains: Object.freeze({}), resolutions: Object.freeze(Object.fromEntries(byDomain)) });
      VERIFIED_TASK_PINS.add(taskPin);
    }
  };
  // Classified tasks refresh and capture eagerly. Unclassified tasks remain
  // lazy until their first applicable reviewer/standards call.
  if (domains.length) initialize();
  const resolvePinned = (domain) => {
    if (!DOMAINS.includes(domain)) throw new Error(`unsupported standards domain: ${domain}`);
    initialize();
    return byDomain.get(domain);
  };
  return Object.freeze({
    get taskPin() { return taskPin; },
    get refresh() { return refresh; },
    resolutions: Object.freeze(domains.map((domain) => resolvePinned(domain))),
    resolve: resolvePinned,
  });
}

export function buildStandardsContext(prompt, options = {}) {
  const domains = identifyTaskDomains(prompt);
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
  return Object.freeze({ domains, records: Object.freeze(records), patterns: Object.freeze(patterns), get refresh() { return pinned.refresh; }, get taskPin() { return pinned.taskPin; }, resolve: pinned.resolve });
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
  if (!plainObject(report)) return { ok: false, error: "reviewer report envelope is missing" };
  if (report.tool !== expectedTool) return { ok: false, error: `reviewer tool must be ${expectedTool}` };
  const expectedSchema = domain === "sql" ? 4 : 3;
  if (report.schema_version !== expectedSchema) return { ok: false, error: `reviewer schema_version must be ${expectedSchema}` };
  if (typeof report.version !== "string" || !report.version.trim()) return { ok: false, error: "reviewer version is invalid" };
  if (!Array.isArray(report.findings) || !Array.isArray(report.diagnostics) || !Array.isArray(report.agent_review)) return { ok: false, error: "reviewer findings/diagnostics/agent_review envelope is invalid" };
  const exactKeys = (value, required, optional = []) => plainObject(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
  const stringFields = (value, fields) => fields.every((key) => typeof value[key] === "string");
  const fingerprint = (value) => /^[0-9a-f]{64}$/.test(value);
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
  if (!exactKeys(report.standards, ["path", "sha256"]) || typeof report.standards.path !== "string" || typeof report.standards.sha256 !== "string" || !fingerprint(report.standards.sha256)) return { ok: false, error: "reviewer standards provenance schema is invalid" };
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

/** Validate and publish SQL+DAX reports/bindings behind one atomic pointer. */
export function promoteReviewRun(outdir, entries, options = {}) {
  if (!Array.isArray(entries) || entries.length !== 2 || entries.map((x) => x?.domain).sort().join("|") !== "dax|sql") return { ok: false, error: "review run must contain exactly one SQL and one DAX report" };
  const root = resolve(outdir);
  try {
    return withStorageLock(root, "accepted-review-storage", options, () => {
      const generations = join(root, "accepted-generations");
      assertSafeStorageRoot(generations);
      cleanupStages(generations, options);
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
        verified.push({ domain: entry.domain, reportBytes, report, binding: bound.binding });
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
        }
        rmSync(join(stage, ".owner.json"), { force: true });
        const files = Object.fromEntries(verified.flatMap((entry) => [
          [`${entry.domain}_report`, { file: `coop-${entry.domain}-review.json`, sha256: hashBytes(entry.reportBytes) }],
          [`${entry.domain}_binding`, { file: `coop-${entry.domain}-review.provenance.json`, sha256: sha256(join(stage, `coop-${entry.domain}-review.provenance.json`)) }],
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
        fault("review:before-pointer");
        atomicJson(join(root, "active-review-generation.json"), { schema_version: 1, generation_id: generationId, metadata_sha256: metadataSha256 });
        fault("review:after-pointer");
        const own = resolveAcceptedGeneration(root, generationId, metadataSha256);
        if (!own.ok) throw new Error(own.error);
        pruneReviewGenerations(generations, generationId, options);
        return { ok: true, generation_id: generationId, bindings: Object.fromEntries(verified.map((x) => [x.domain, x.binding])), reports: own.reports, binding_paths: own.bindings };
      } finally { rmSync(stage, { recursive: true, force: true }); }
    });
  } catch (e) { return { ok: false, error: `review run promotion failed: ${e.message}` }; }
}

function resolveAcceptedGeneration(root, generationId, metadataSha256) {
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
        Object.keys(metadata.files).sort().join("|") !== "dax_binding|dax_report|sql_binding|sql_report") throw new Error("active review generation metadata is invalid");
    const reports = {}, bindings = {}, captured = {};
    for (const domain of metadata.domains) {
      for (const [kind, target] of [["report", reports], ["binding", bindings]]) {
        const entry = metadata.files[`${domain}_${kind}`], path = plainObject(entry) && typeof entry.file === "string" ? join(generation, entry.file) : "";
        if (!plainObject(entry) || Object.keys(entry).sort().join("|") !== "file|sha256" || typeof entry.file !== "string" || !isSafeRelativePath(entry.file) ||
            typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256) || !regularUnsymbolic(path) || !inside(path, generation)) throw new Error(`active review ${domain} ${kind} is invalid`);
        const bytes = readFileSync(path);
        if (hashBytes(bytes) !== entry.sha256) throw new Error(`active review ${domain} ${kind} is invalid`);
        target[domain] = realpathSync(path);
        captured[`${domain}_${kind}`] = JSON.parse(bytes.toString("utf8"));
      }
      const report = captured[`${domain}_report`], binding = captured[`${domain}_binding`];
      const expectedBinding = metadata.standards_bindings[domain];
      const envelope = validateReviewerReport(domain, report);
      if (!envelope.ok) throw new Error(`active review ${domain} report envelope is invalid: ${envelope.error}`);
      if (!plainObject(binding) || Object.keys(binding).sort().join("|") !== "owner|path|revision|sha256" || binding.owner !== "coop" ||
          typeof binding.path !== "string" || typeof binding.revision !== "string" || !binding.revision || typeof binding.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(binding.sha256) ||
          !plainObject(expectedBinding) || Object.keys(expectedBinding).sort().join("|") !== "path|revision|sha256" || expectedBinding.path !== binding.path || expectedBinding.sha256 !== binding.sha256 || expectedBinding.revision !== binding.revision ||
          report.standards.path !== binding.path || report.standards.sha256 !== binding.sha256 || !regularUnsymbolic(binding.path) || sha256(binding.path) !== binding.sha256) {
        throw new Error(`active review ${domain} provenance binding is invalid`);
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
      return resolveAcceptedGeneration(root, pointer.generation_id, pointer.metadata_sha256);
    });
  } catch (e) { return { ok: false, error: e.message, degraded: true }; }
}

function sourceStatusUnlocked(options = {}) {
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
    const active = activeCanonicalGeneration(options);
    if (!active.ok) return { ...common, state: sync.state || "unavailable", revision: null, path: null, detail: active.error || sync.detail || "no verified canonical generation" };
    return { ...common, state: sync.degraded || freshness !== "fresh" ? "stale_last_known_good" : "available", revision: active.revision, generation_id: active.generation_id, path: active.checkout, detail: sync.detail || null };
  })();
  const statusPin = activeCanonicalGeneration(options);
  const domains = Object.fromEntries(DOMAINS.map((d) => {
    const resolution = resolveStandard(d, { ...options, captureGeneration: statusPin, refresh: false, _canonicalLockHeld: true });
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

export function sourceStatus(options = {}) {
  const storage = canonicalStorage(options);
  try { return withStorageLock(storage.base, "canonical-storage", options, () => sourceStatusUnlocked(options)); }
  catch (error) {
    return Object.freeze({ canonical_remote: CANONICAL_REMOTE_STATE, freshness: "uncertain", degraded: true, detail: error.message, sources: Object.freeze([]), domains: Object.freeze({}) });
  }
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
  try { const fd = openSync(path, "r"); try { (options.fsync || fsyncSync)(fd); } finally { closeSync(fd); } }
  catch (error) {
    const unsupported = (options.platform || process.platform) === "win32" && ["EINVAL", "ENOTSUP", "EBADF"].includes(error?.code);
    if (!unsupported) throw error;
  }
}
function fsyncTree(root) {
  const absolute = realpathSync(root), directories = [];
  const walk = (dir) => {
    if (!inside(dir, absolute)) throw new Error("durability walk escaped canonical checkout");
    directories.push(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name), info = lstatSync(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) walk(path);
      else if (info.isFile()) {
        if (!inside(path, absolute)) throw new Error("durability file escaped canonical checkout");
        const fd = openSync(path, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
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
function retrievalIndex(root, registry, revision) {
  const domains = {};
  for (const [domain, file] of Object.entries(registry.canonical.domains)) {
    const path = join(root, file), text = readFileSync(path, "utf8");
    domains[domain] = { file, sha256: sha256(path), headings: text.split(/\r?\n/).filter((x) => /^#{1,4}\s+/.test(x)).map((x) => x.replace(/^#{1,4}\s+/, "")) };
  }
  return { schema_version: 1, revision, domains };
}

function canonicalStorage(options = {}) {
  const legacy = resolve(options.canonicalRoot || process.env.COOP_STANDARDS_ROOT || join(homedir(), ".coop", "standards", "canonical"));
  const base = dirname(legacy);
  return {
    legacy, base,
    generations: resolve(options.generationsRoot || join(base, "canonical-generations")),
    pointer: resolve(options.activePointerPath || join(base, "active-generation.json")),
    state: resolve(options.statePath || process.env.COOP_STANDARDS_STATE || join(base, "status.json")),
  };
}

function verifyCanonicalCheckout(checkout, options, expectedRevision = null) {
  const registry = standardsRegistry(options), c = registry.canonical;
  if (!directoryUnsymbolic(checkout) || gitDirty(checkout) !== false) return { ok: false, error: "canonical checkout is missing, unsafe, or dirty" };
  const runOptions = { ...options, timeoutMs: options.timeoutMs || c.timeout_seconds * 1000 };
  const remote = gitRun(["config", "--get", "remote.origin.url"], runOptions, checkout);
  const branch = gitRun(["symbolic-ref", "--short", "HEAD"], runOptions, checkout);
  const revision = gitRevision(checkout);
  const remoteRef = `refs/remotes/origin/${c.authoritative_branch}`;
  const authoritative = gitRun(["rev-parse", "--verify", remoteRef], runOptions, checkout);
  if (remote.status !== 0 || repositoryIdentity(remote.stdout) !== repositoryIdentity(options.remote || c.repository)) return { ok: false, error: "canonical repository identity mismatch" };
  if (branch.status !== 0 || branch.stdout.trim() !== c.authoritative_branch) return { ok: false, error: "canonical checkout is not authoritative main" };
  if (!/^[0-9a-f]{40}$/.test(revision) || (expectedRevision && revision !== expectedRevision)) return { ok: false, error: "canonical checkout revision mismatch" };
  const remoteCommit = authoritative.status === 0 ? authoritative.stdout.trim() : "";
  if (!/^[0-9a-f]{40}$/.test(remoteCommit) || remoteCommit !== revision) return { ok: false, error: "canonical checkout is not the fetched authoritative remote main" };
  const ancestry = gitRun(["merge-base", "--is-ancestor", c.initial_verified_commit, "HEAD"], runOptions, checkout);
  if (ancestry.status !== 0) return { ok: false, error: "canonical main does not descend from the verified anchor" };
  const errors = authorityRootErrors(checkout, { ...options, repository: c.repository, branch: c.authoritative_branch });
  return errors.length ? { ok: false, error: errors.join("; ") } : { ok: true, revision, remote_ref: remoteRef, remote_commit: remoteCommit };
}

function activeCanonicalGenerationUnlocked(options = {}) {
  try {
    const storage = canonicalStorage(options);
    assertSafeStorageRoot(storage.base, false);
    if (!regularUnsymbolic(storage.pointer)) throw new Error("active canonical generation pointer is missing or unsafe");
    const pointer = safeJson(storage.pointer);
    if (!plainObject(pointer) || Object.keys(pointer).sort().join("|") !== "generation_id|metadata_sha256|revision|schema_version" || pointer.schema_version !== 1 ||
        typeof pointer.generation_id !== "string" || !/^[0-9a-f]{40}-[A-Za-z0-9]+$/.test(pointer.generation_id) || typeof pointer.revision !== "string" || !/^[0-9a-f]{40}$/.test(pointer.revision) ||
        typeof pointer.metadata_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(pointer.metadata_sha256)) throw new Error("active canonical generation pointer is invalid");
    const generation = join(storage.generations, pointer.generation_id);
    if (!directoryUnsymbolic(storage.generations) || !directoryUnsymbolic(generation) || !inside(generation, storage.generations)) throw new Error("active canonical generation target is unsafe");
    const metadataPath = join(generation, "generation.json"), indexPath = join(generation, "retrieval-index.json"), checkout = join(generation, "checkout");
    if (!regularUnsymbolic(metadataPath) || !regularUnsymbolic(indexPath) || sha256(metadataPath) !== pointer.metadata_sha256) throw new Error("canonical generation metadata/index is missing or unsafe");
    const metadata = safeJson(metadataPath), index = safeJson(indexPath), c = standardsRegistry(options).canonical;
    if (!plainObject(metadata) || Object.keys(metadata).sort().join("|") !== "anchor|branch|domains|generation_id|index_sha256|remote_commit|remote_ref|remote_verified_ms|repository|revision|schema_version" ||
        metadata.schema_version !== 1 || metadata.generation_id !== pointer.generation_id || metadata.revision !== pointer.revision || metadata.repository !== c.repository || metadata.branch !== c.authoritative_branch || metadata.anchor !== c.initial_verified_commit ||
        metadata.remote_ref !== `refs/remotes/origin/${c.authoritative_branch}` || metadata.remote_commit !== pointer.revision || !Number.isFinite(metadata.remote_verified_ms) || metadata.remote_verified_ms < 0 || metadata.index_sha256 !== sha256(indexPath) ||
        JSON.stringify(metadata.domains) !== JSON.stringify(index?.domains)) throw new Error("canonical generation metadata/pointer disagreement");
    const checkoutResult = verifyCanonicalCheckout(checkout, options, pointer.revision);
    if (!checkoutResult.ok || checkoutResult.remote_ref !== metadata.remote_ref || checkoutResult.remote_commit !== metadata.remote_commit) throw new Error(checkoutResult.error || "canonical remote-main binding mismatch");
    const expectedIndex = retrievalIndex(checkout, standardsRegistry(options), pointer.revision);
    if (JSON.stringify(index) !== JSON.stringify(expectedIndex)) throw new Error("canonical retrieval index revision/hash mismatch");
    return Object.freeze({ ok: true, generation_id: pointer.generation_id, revision: pointer.revision, generation: realpathSync(generation), checkout: realpathSync(checkout), index: realpathSync(indexPath), remote_ref: metadata.remote_ref, remote_commit: metadata.remote_commit, remote_verified_ms: metadata.remote_verified_ms, domains: Object.freeze(structuredClone(index.domains)) });
  } catch (e) { return { ok: false, error: e.message }; }
}

export function activeCanonicalGeneration(options = {}) {
  const storage = canonicalStorage(options);
  try { return withStorageLock(storage.base, "canonical-storage", options, () => activeCanonicalGenerationUnlocked(options)); }
  catch (e) { return { ok: false, error: e.message, degraded: true, uncertain: true }; }
}

/** Refresh only the configured default branch into a verified atomic cache. */
function refreshCanonicalUnlocked(options = {}) {
  const registry = standardsRegistry(options), c = registry.canonical;
  const storage = canonicalStorage(options), statePath = storage.state;
  const now = Number(options.now ? options.now() : Date.now());
  if (!Number.isFinite(now) || now < 0) return Object.freeze({ ok: false, state: "unavailable", degraded: true, changed: false, detail: "canonical refresh clock is invalid" });
  let previous = safeJson(statePath) || {};
  let active = activeCanonicalGeneration(options);
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
  cleanupStages(storage.generations, options);
  const nonce = `${process.pid}-${Date.now().toString(36)}-${randomBytes(12).toString("hex")}`;
  const stage = join(storage.generations, `.stage-${nonce}`), checkout = join(stage, "checkout");
  mkdirSync(stage, { mode: 0o700 });
  writeDurable(join(stage, ".owner.json"), JSON.stringify({ pid: process.pid, created_ms: Date.now() }) + "\n");
  let result;
  const fault = (step) => { if (typeof options.fault === "function") options.fault(step); else if (options.fault === step) throw new Error(`fault injected at ${step}`); };
  try {
    const cloned = gitRun(["clone", "--quiet", "--no-tags", "--single-branch", "--branch", c.authoritative_branch, "--config", "core.hooksPath=/dev/null", "--", options.remote || c.repository, checkout], runOptions);
    if (cloned.error || cloned.status !== 0) throw new Error(cloned.error?.code === "ETIMEDOUT" ? "canonical refresh timed out" : "canonical remote unavailable or authentication required");
    fault("canonical:clone");
    const verified = verifyCanonicalCheckout(checkout, options);
    if (!verified.ok) throw new Error(verified.error);
    const revision = verified.revision, index = retrievalIndex(checkout, registry, revision);
    fault("canonical:verified");
    const indexPath = join(stage, "retrieval-index.json");
    writeDurable(indexPath, JSON.stringify(index, null, 2) + "\n");
    fault("canonical:index");
    const generationId = `${revision}-${randomBytes(12).toString("hex")}`;
    rmSync(join(stage, ".owner.json"), { force: true });
    const metadata = { schema_version: 1, generation_id: generationId, revision, repository: c.repository, branch: c.authoritative_branch, anchor: c.initial_verified_commit,
      remote_ref: verified.remote_ref, remote_commit: verified.remote_commit, remote_verified_ms: now, index_sha256: sha256(indexPath), domains: index.domains };
    writeDurable(join(stage, "generation.json"), JSON.stringify(metadata, null, 2) + "\n");
    fault("canonical:metadata");
    fsyncTree(checkout);
    fsyncDirectory(stage);
    const final = join(storage.generations, generationId);
    renameSync(stage, final); fsyncDirectory(storage.generations);
    fault("canonical:generation");
    fault("canonical:before-pointer");
    atomicJson(storage.pointer, { schema_version: 1, generation_id: generationId, revision, metadata_sha256: sha256(join(final, "generation.json")) });
    fault("canonical:after-pointer");
    active = activeCanonicalGeneration(options);
    if (!active.ok || active.generation_id !== generationId) throw new Error(active.error || "active generation did not advance");
    const changed = previous.revision !== revision;
    const successfulSync = changed || !previous.last_successful_sync_ms ? now : previous.last_successful_sync_ms;
    result = { ok: true, state: "fresh", revision, generation_id: generationId, changed, last_successful_check_ms: now, last_successful_sync_ms: successfulSync };
    fault("canonical:before-state");
    atomicJson(statePath, { ...result, repository: c.repository, branch: c.authoritative_branch, last_attempt_ms: now });
    fault("canonical:after-state");
    pruneGenerations(storage.generations, storage.pointer, generationId, options);
  } catch (e) {
    active = activeCanonicalGeneration(options);
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
  catch (e) { return Object.freeze({ ok: false, state: "unavailable", degraded: true, changed: false, detail: e.message }); }
}

function cleanupStages(root, options = {}) {
  const expiry = Math.max(1000, Number(options.stageExpiryMs ?? 60 * 60 * 1000));
  let rows = [];
  try { rows = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith(".stage-")); } catch { return; }
  for (const row of rows) {
    const path = join(root, row.name);
    try {
      const owner = safeJson(join(path, ".owner.json"));
      const created = plainObject(owner) && Number.isFinite(owner.created_ms) ? owner.created_ms : statSync(path).mtimeMs;
      if (Date.now() - created >= expiry && (!plainObject(owner) || !processAlive(owner.pid))) rmSync(path, { recursive: true, force: true });
    } catch { /* conservative cleanup is best effort */ }
  }
}

function pruneGenerations(root, pointerPath, writerId, options = {}) {
  try {
    const retain = Math.max(1, Number(options.retainGenerations ?? 3));
    // activeCanonicalGeneration exposes paths for compatibility. Give callers
    // a conservative consumption window rather than deleting a just-returned
    // generation immediately after its read lock is released.
    const minAge = Math.max(1000, Number(options.canonicalRetentionMinAgeMs ?? 24 * 60 * 60 * 1000));
    const rows = readdirSync(root, { withFileTypes: true }).filter((x) => x.isDirectory() && !x.name.startsWith(".stage-")).map((x) => ({ name: x.name, mtime: statSync(join(root, x.name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
    const selected = safeJson(pointerPath)?.generation_id;
    const keep = new Set([selected, writerId, ...rows.slice(0, Math.max(1, retain)).map((x) => x.name)].filter(Boolean));
    for (const row of rows) if (!keep.has(row.name) && Date.now() - row.mtime >= minAge) rmSync(join(root, row.name), { recursive: true, force: true });
  } catch { /* retention is best effort and never affects authority */ }
}

function pruneReviewGenerations(root, writerId, options = {}) {
  // Accepted paths can be consumed after the read lock is released. Retain a
  // bounded count, but only age-expired generations; immediate deletion would
  // race those consumers. The active and just-published generations always win.
  const retain = Math.max(1, Number(options.retainReviewGenerations ?? 20));
  const minAge = Math.max(1000, Number(options.reviewRetentionMinAgeMs ?? 24 * 60 * 60 * 1000));
  try {
    const pointer = safeJson(join(dirname(root), "active-review-generation.json"));
    const rows = readdirSync(root, { withFileTypes: true }).filter((x) => x.isDirectory() && !x.name.startsWith(".stage-"))
      .map((x) => ({ name: x.name, mtime: statSync(join(root, x.name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
    const keep = new Set([pointer?.generation_id, writerId, ...rows.slice(0, retain).map((x) => x.name)].filter(Boolean));
    for (const row of rows) if (!keep.has(row.name) && Date.now() - row.mtime >= minAge) rmSync(join(root, row.name), { recursive: true, force: true });
  } catch { /* age-based retention is deliberately conservative */ }
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
    const errors = authorityRootErrors(dest, { fixtureAuthority: true });
    if (gitDirty(dest) !== false || errors.length) return { ok: false, state: "invalid_preserved", detail: `updated checkout failed verification: ${errors.join("; ") || "checkout is dirty"}` };
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    const temp = `${dest}.clone-${process.pid}`;
    rmSync(temp, { recursive: true, force: true });
    try {
      execFileSync("git", ["clone", "--quiet", "--", source, temp], { stdio: "ignore" });
      const errors = authorityRootErrors(temp, { fixtureAuthority: true });
      if (errors.length) throw new Error(`invalid authority: ${errors.join("; ")}`);
      renameSync(temp, dest);
    } catch (e) {
      rmSync(temp, { recursive: true, force: true });
      return { ok: false, state: "unavailable", detail: e.message };
    }
  }
  const finalErrors = authorityRootErrors(dest, { fixtureAuthority: true });
  if (gitDirty(dest) !== false || finalErrors.length) return { ok: false, state: "invalid_preserved", detail: `checkout failed final verification: ${finalErrors.join("; ") || "checkout is dirty"}` };
  return { ok: true, state: "canonical", revision: gitRevision(dest), path: realpathSync(dest) };
}

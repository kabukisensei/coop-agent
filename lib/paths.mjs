/** coop profile-root paths (master plan S3: one profile root).
 *
 * The ONE meaning of the location variables, shared with lib/common.ps1
 * (Get-CoopProfileDir and friends) and lib/coop_paths.py:
 *
 * - COOP_DIR is the PARENT of `.coop`: the profile dir is `$COOP_DIR/.coop`,
 *   default `~/.coop`. It holds config, user.json, agent/, support/, standards/.
 * - The agent dir Pi actually loads is resolved by ONE chain everywhere:
 *   PI_CODING_AGENT_DIR -> COOP_NO_ISOLATE truthy (1|true|yes|on, any case)
 *   -> ~/.pi/agent -> COOP_AGENT_DIR -> `<profile dir>/agent`.
 *
 * Home is os.homedir() (USERPROFILE on Windows, HOME elsewhere; never the
 * working directory). With no variables set every helper yields the historical
 * `~/.coop/...` path. Pure: reads only `env`, never the filesystem. The one
 * exception is the file-tier block at the end (F2): the standards location
 * probes whether the machine folder is writable, and the backup and drafts
 * helpers look for the repository that holds a file.
 *
 * File tiers (F2, Aaron 2026-10-20). coop keeps its files in three places,
 * named the same way everywhere coop speaks:
 * - this machine: machineProfileDir() (`%ProgramData%\coop`): the program,
 *   the standards, the person's name and preferences.
 * - this client: profileDir() (`%USERPROFILE%\.coop`; one Windows user is one
 *   client): sessions, memory, backups, drafts.
 * - the repository: `<repo>\.coop`: the team's project file, client skills
 *   and prompts.
 */
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

const NO_ISOLATE_RE = /^(1|true|yes|on)$/i;

const read = (env, name) => {
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
};

/** True when COOP_NO_ISOLATE is 1/true/yes/on (case-insensitive). */
export function noIsolate(env = process.env) {
  return NO_ISOLATE_RE.test(read(env, "COOP_NO_ISOLATE"));
}

export function homeDir() {
  return homedir();
}

/** `$COOP_DIR/.coop` when COOP_DIR is set, else `~/.coop`. */
export function profileDir(env = process.env) {
  const base = read(env, "COOP_DIR");
  return join(base || homeDir(), ".coop");
}

/** The fleet/integration config: `<profile dir>/config`. */
export function configPath(env = process.env) {
  return join(profileDir(env), "config");
}

/** The local user profile: `<profile dir>/user.json`. */
export function userProfilePath(env = process.env) {
  return join(profileDir(env), "user.json");
}

/**
 * The machine-level profile (master plan P1): one `user.json` per machine for
 * the team's VMs, where every client is its own Windows user. COOP_MACHINE_DIR
 * names its folder (tests, sandboxes); else `%ProgramData%\coop` on Windows
 * and `/etc/coop` elsewhere. It holds only a person's name and communication
 * preference, never anything client-shaped; the per-user file wins field by field.
 */
export function machineProfileDir(env = process.env, platform = process.platform) {
  const configured = read(env, "COOP_MACHINE_DIR");
  if (configured) return configured;
  if (platform === "win32") return join(read(env, "ProgramData") || "C:\\ProgramData", "coop");
  return "/etc/coop";
}

/** The machine-level profile file: `<machine dir>/user.json`. */
export function machineProfilePath(env = process.env, platform = process.platform) {
  return join(machineProfileDir(env, platform), "user.json");
}

/** coop's ISOLATED Pi agent dir: COOP_AGENT_DIR, else `<profile dir>/agent`
 *  (mirror of Get-CoopPiAgentDir). */
export function coopAgentDir(env = process.env) {
  const configured = read(env, "COOP_AGENT_DIR");
  return configured || join(profileDir(env), "agent");
}

/** The user's own Pi agent dir (`~/.pi/agent`); loaded with COOP_NO_ISOLATE. */
export function personalPiAgentDir() {
  return join(homeDir(), ".pi", "agent");
}

/** The agent dir Pi will ACTUALLY load (mirror of Get-CoopEffectiveAgentDir). */
export function agentDir(env = process.env) {
  const configured = read(env, "PI_CODING_AGENT_DIR");
  if (configured) return configured;
  if (noIsolate(env)) return personalPiAgentDir();
  return coopAgentDir(env);
}

// --- File tiers (F2) ----------------------------------------------------------
// Mirrors of Get-CoopStandardsLocation, Get-CoopBackupDir, Get-CoopDraftsDir and
// Get-CoopRepositoryCoopDir in lib/common.ps1 and the same names in lib/coop_paths.py.

/** True when `dir` exists and this process can create a file in it (the one
 *  honest test on Windows, where access() says yes to every existing folder). */
export function dirWritable(dir) {
  try {
    if (!statSync(dir).isDirectory()) return false;
    const probe = join(dir, `.coop-write-probe-${process.pid}-${Math.random().toString(16).slice(2)}`);
    writeFileSync(probe, "", { flag: "wx" });
    unlinkSync(probe);
    return true;
  } catch { return false; }
}

// A folder found writable stays so for this process (one probe file per
// process, not per resolution); a missing or read-only one is cheap to re-ask
// and is asked again, so a folder `coop sync` just created is seen at once.
const writableCache = new Set();
function cachedWritable(dir, probe) {
  if (probe !== dirWritable) return probe(dir);
  if (writableCache.has(dir)) return true;
  const ok = dirWritable(dir);
  if (ok) writableCache.add(dir);
  return ok;
}
/** Forget the per-process answers of dirWritable (tests). */
export function resetStandardsLocationCache() { writableCache.clear(); }

/**
 * Where the standards live: { root, tier }. COOP_STANDARDS_ROOT (tests,
 * sandboxes) names the canonical checkout as it always has, so the root is its
 * parent (tier "override"); else `<machine dir>/standards` when that folder
 * exists and is writable by this process (tier "machine": once per machine,
 * refreshed with every update); else `<profile dir>/standards` (tier "client",
 * the place before F2). `canonical` and `snapshots` live under the root.
 */
export function standardsLocation(env = process.env, platform = process.platform, probe = dirWritable) {
  const override = read(env, "COOP_STANDARDS_ROOT");
  if (override) return { root: dirname(resolve(override)), tier: "override" };
  const machine = join(machineProfileDir(env, platform), "standards");
  if (cachedWritable(machine, probe)) return { root: machine, tier: "machine" };
  return { root: join(profileDir(env), "standards"), tier: "client" };
}

/** The standards root folder (see standardsLocation). */
export function standardsRoot(env = process.env, platform = process.platform, probe = dirWritable) {
  return standardsLocation(env, platform, probe).root;
}

/** The canonical coop-standards checkout: COOP_STANDARDS_ROOT, else `<standards root>/canonical`. */
export function canonicalStandardsRoot(env = process.env, platform = process.platform, probe = dirWritable) {
  const override = read(env, "COOP_STANDARDS_ROOT");
  return override ? resolve(override) : join(standardsRoot(env, platform, probe), "canonical");
}

/** The immutable standards snapshots: COOP_STANDARDS_SNAPSHOT_ROOT, else `<standards root>/snapshots`. */
export function standardsSnapshotRoot(env = process.env, platform = process.platform, probe = dirWritable) {
  const override = read(env, "COOP_STANDARDS_SNAPSHOT_ROOT");
  return override ? resolve(override) : join(standardsRoot(env, platform, probe), "snapshots");
}

/** This client's backups: `<profile dir>/backups` (one folder per repository under it). */
export function backupsRoot(env = process.env) {
  return join(profileDir(env), "backups");
}

/** This client's drafts: `<profile dir>/drafts` (one folder per repository under it). */
export function draftsRoot(env = process.env) {
  return join(profileDir(env), "drafts");
}

/** The git root at or above `dir`, or null. */
export function gitRootAbove(dir) {
  let at = resolve(dir || ".");
  for (;;) {
    if (existsSync(join(at, ".git"))) return at;
    const parent = dirname(at);
    if (parent === at) return null;
    at = parent;
  }
}

/** The nearest `.coop/project.yml` at or above `dir`, or null. */
function contractAbove(dir) {
  let at = resolve(dir || ".");
  for (;;) {
    const candidate = join(at, ".coop", "project.yml");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(at);
    if (parent === at) return null;
    at = parent;
  }
}

const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The folder that counts as the repository holding `dir`: its git root, else
 *  the folder whose `.coop/project.yml` is nearest above it, else `dir` itself. */
export function repositoryRootFor(dir) {
  const at = resolve(dir || ".");
  const gitRoot = gitRootAbove(at);
  if (gitRoot) return gitRoot;
  const contract = contractAbove(at);
  return contract ? resolve(contract, "..", "..") : at;
}

/** The `repositories.<name>.local_path` entries of a block-YAML contract (a
 *  line scan, like Get-CoopContractLocalPaths): [{ name, localPath }]. */
function contractRepositories(text) {
  const out = [];
  let inRepos = false, name = "";
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\S/.test(line)) { inRepos = /^repositories:\s*(#.*)?$/.test(line); name = ""; continue; }
    if (!inRepos) continue;
    const key = /^  ([A-Za-z0-9_.-]+):\s*(#.*)?$/.exec(line);
    if (key) { name = key[1]; continue; }
    const local = /^\s+local_path:\s*(.+?)\s*$/.exec(line);
    if (local && name) {
      let value = local[1];
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
      if (value && !/^TODO/.test(value)) out.push({ name, localPath: value });
    }
  }
  return out;
}

/**
 * The name of the repository that holds `file`: the `repositories` key of the
 * project file (COOP_PROJECT_YML, else the one at or above the repository)
 * whose local_path is that repository, else the basename of its git root, else
 * the basename of the file's own folder (a file in no repository).
 */
export function repositoryNameFor(file, env = process.env) {
  const full = resolve(file || ".");
  let dir = full;
  try { if (!statSync(full).isDirectory()) dir = dirname(full); } catch { dir = dirname(full); }
  const gitRoot = gitRootAbove(dir);
  if (!gitRoot) return basename(repositoryRootFor(dir)) || "root";
  const contract = read(env, "COOP_PROJECT_YML") || contractAbove(gitRoot);
  if (contract && existsSync(contract)) {
    const root = resolve(contract, "..", "..");
    let text = "";
    try { text = readFileSync(contract, "utf8"); } catch { text = ""; }
    for (const { name, localPath } of contractRepositories(text)) {
      const expanded = localPath.replace(/^~(?=$|[\\/])/, homeDir());
      if (samePath(resolve(root, expanded), gitRoot)) return name;
    }
  }
  return basename(gitRoot) || "root";
}

/** Where backups of `file` go: `<profile dir>/backups/<repository name>`. */
export function backupDirFor(file, env = process.env) {
  return join(backupsRoot(env), repositoryNameFor(file, env));
}

/** Where drafts beside `file` go: `<profile dir>/drafts/<repository name>`. */
export function draftsDirFor(file, env = process.env) {
  return join(draftsRoot(env), repositoryNameFor(file, env));
}

/** `%Y%m%d_%H%M%S`, the contract's default backup.timestamp_format, local time. */
export function backupTimestamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/**
 * The backup file for `file`: `<backup dir>/<path inside the repository>.<timestamp>.bak`
 * (the contract's default naming_pattern `{original_name}.{timestamp}.bak`).
 */
export function backupPathFor(file, env = process.env, now = new Date()) {
  const full = resolve(file);
  const inside = relative(repositoryRootFor(dirname(full)), full) || basename(full);
  return join(backupDirFor(full, env), `${inside}.${backupTimestamp(now)}.bak`);
}

/**
 * The repository's `.coop` folder for a launch in `cwd`: the folder of the
 * project file coop uses there (COOP_PROJECT_YML, else the nearest one at or
 * above), else `<git root>/.coop`, else `<cwd>/.coop`.
 */
export function repositoryCoopDir(cwd, env = process.env) {
  const root = resolve(cwd || ".");
  const configured = read(env, "COOP_PROJECT_YML");
  if (configured && existsSync(configured)) return dirname(resolve(configured));
  const above = contractAbove(root);
  if (above) return dirname(above);
  return join(gitRootAbove(root) || root, ".coop");
}

/**
 * The three places for a launch in `cwd`, plus where the standards, backups
 * and drafts of that folder's repository live:
 * { machine, client, repository, standards, standardsTier, backups, drafts }.
 */
export function folderPlaces(cwd, env = process.env, platform = process.platform, probe = dirWritable) {
  const root = resolve(cwd || ".");
  const standards = standardsLocation(env, platform, probe);
  return {
    machine: machineProfileDir(env, platform),
    client: profileDir(env),
    repository: repositoryCoopDir(root, env),
    standards: standards.root,
    standardsTier: standards.tier,
    backups: backupDirFor(root, env),
    drafts: draftsDirFor(root, env),
  };
}

/** The files in a drafts folder, newest first: [{ path, name, mtimeMs, size }],
 *  `path` relative to the folder with "/" separators. Reads only; [] when the
 *  folder is absent. */
export function listDraftFiles(dir, limit = 200) {
  const out = [];
  const walk = (at, rel, depth) => {
    let entries = [];
    try { entries = readdirSync(at, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(at, entry.name);
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (depth < 4) walk(full, path, depth + 1); continue; }
      if (!entry.isFile()) continue;
      let stat;
      try { stat = statSync(full); } catch { continue; }
      out.push({ path, name: entry.name, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  };
  walk(resolve(dir), "", 0);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  return out.slice(0, limit);
}

/** Windows beta ownership and paths. No package execution or writes on import.
 * One per-installation record; stable callers keep their existing defaults.
 * This is an accidental-cross-channel-write boundary, not a same-user sandbox.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const markerName = '.coop-beta.json';
export const shellJson = value => JSON.stringify(value).replace(/[^\x00-\x7f]/g, unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const within = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) throw Error('Expected an unambiguous absolute path');
  if (process.platform === 'win32') {
    if (!/^[A-Za-z]:[\\/]/.test(value) || /[:*?"<>|]/.test(value.slice(2))) throw Error('Expected an absolute local-drive path');
    if (value.slice(3).split(/[\\/]/).some(p => /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw Error('Ambiguous Windows path component');
  }
  if (value.split(/[\\/]/).some(p => p === '.' || p === '..')) throw Error('Relative path components are not allowed');
  const resolved = path.resolve(value);
  if (samePath(resolved, path.parse(resolved).root)) throw Error('A drive/filesystem root cannot be beta-owned');
  return resolved;
}

/** Inspect every existing ancestor, including dangling links; never follow one. */
export function rejectLinks(target, { hardlinks = false } = {}) {
  const parts = [];
  let cursor = path.resolve(target);
  while (true) {
    parts.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const entry of parts.reverse()) {
    let stat;
    try { stat = fs.lstatSync(entry); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (stat.isSymbolicLink()) throw Error('Link/reparse path is not beta-owned');
    if (hardlinks && stat.isFile() && stat.nlink > 1) throw Error('Hardlink aliases are not beta-owned');
    // realpath also catches junction/reparse resolutions not reported as a link.
    if (!samePath(path.resolve(fs.realpathSync.native(entry)), entry)) throw Error('Reparse path changes beta ownership');
  }
}

function pathsFor(root) {
  const profile = path.join(root, 'profile');
  return {
    source: path.join(root, 'source'), profile, agent: path.join(profile, 'agent'),
    npm: path.join(root, 'runtime', 'npm'), pipx: path.join(root, 'runtime', 'pipx'),
    pipxBin: path.join(root, 'runtime', 'bin'), cache: path.join(root, 'cache'),
    temp: path.join(root, 'temp'), bin: path.join(root, 'bin'),
    manifest: path.join(root, 'source', 'config', 'windows-beta-manifest.json'),
  };
}

function validateTool(file) {
  const value = absolute(file);
  rejectLinks(value);
  let stat;
  try { stat = fs.statSync(value); } catch { throw Error('Selected tool is missing'); }
  if (!stat.isFile()) throw Error('Selected tool must be an explicit executable file');
  return { path: value, sha256: sha256(fs.readFileSync(value)) };
}

/** Resolve a proposed record without creating anything. tools are selected,
 * already-installed shared runtimes, used read-only; never PATH discoveries. */
export function planBetaContext({ root, build, tools, manifest, protectedRoots = [] }) {
  root = absolute(root);
  if (typeof build !== 'string' || !/^[0-9a-f]{40}$/.test(build)) throw Error('Select an exact lowercase 40-character build SHA');
  // The public installer re-validates its plan after moving only its child
  // process into the private beta home. That derived profile is owned by this
  // plan, while the original user home was checked before the handoff.
  const currentHome = os.homedir();
  const privateHome = samePath(currentHome, pathsFor(root).profile);
  if (privateHome && !process.env.COOP_BETA_PLANNED_HOME) throw Error('Private beta planning requires the original protected home');
  const homes = privateHome ? [process.env.COOP_BETA_PLANNED_HOME] : [currentHome];
  const protectedPaths = [...new Set([...homes, path.resolve(fileURLToPath(new URL('..', import.meta.url))), ...protectedRoots].map(absolute))];
  for (const stable of protectedPaths) {
    rejectLinks(stable);
    if (within(stable, root) || within(root, stable)) throw Error('Beta root overlaps protected stable/source state');
  }
  rejectLinks(root);
  const paths = pathsFor(root);
  for (const p of Object.values(paths)) rejectLinks(p);
  let parsed;
  try { parsed = JSON.parse(manifest.toString()); } catch { throw Error('Invalid selected manifest'); }
  if (parsed.schema_version !== 1 || !parsed.pi?.version) throw Error('Invalid selected manifest');
  const selected = {};
  for (const name of ['node', 'python', 'fabricPython', 'git']) selected[name] = validateTool(tools?.[name]);
  if (tools?.npm) selected.npm = validateTool(tools.npm);
  return { schema: 1, channel: 'beta', root, build, paths, tools: selected, manifestHash: sha256(manifest), protectedRoots: protectedPaths };
}

function validateRecord(record, requestedRoot) {
  const root = absolute(requestedRoot);
  if (record?.schema !== 1 || record.channel !== 'beta' || !samePath(record.root, root) || !/^[0-9a-f]{40}$/.test(record.build) || !/^[0-9a-f]{64}$/.test(record.manifestHash)) throw Error('Invalid beta installation identity');
  if (JSON.stringify(record.paths) !== JSON.stringify(pathsFor(root))) throw Error('Invalid derived beta paths');
  if (!Array.isArray(record.protectedRoots) || !record.protectedRoots.length) throw Error('Missing protected root identity');
  // A launched beta deliberately uses its private profile as HOME. The home
  // captured at installation remains in protectedRoots; do not reject that
  // private child profile as an overlap with its own installation.
  const currentHome = os.homedir();
  const protectedPaths = within(root, currentHome) ? record.protectedRoots : [currentHome, ...record.protectedRoots];
  for (const stable of protectedPaths) {
    const protectedPath = absolute(stable);
    rejectLinks(protectedPath);
    if (within(protectedPath, root) || within(root, protectedPath)) throw Error('Beta root overlaps protected state');
  }
  rejectLinks(root);
  for (const p of Object.values(record.paths)) rejectLinks(p, { hardlinks: true });
  for (const name of ['node', 'python', 'fabricPython', 'git']) {
    const selected = validateTool(record.tools?.[name]?.path);
    if (selected.sha256 !== record.tools[name].sha256) throw Error('Selected tool changed; requalification required');
  }
  if (record.tools.npm && validateTool(record.tools.npm.path).sha256 !== record.tools.npm.sha256) throw Error('Selected npm CLI changed; requalification required');
  return record;
}

export function claimBetaRoot(record) {
  validateRecord(record, record.root);
  if (fs.existsSync(record.root) && fs.readdirSync(record.root).length) throw Error('Beta root must be empty and not already owned');
  fs.mkdirSync(record.root, { recursive: true });
  // Exclusive ownership claim. Never replace another installation's record.
  fs.writeFileSync(path.join(record.root, markerName), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

export function loadBetaContext(root) {
  root = absolute(root);
  const marker = path.join(root, markerName);
  rejectLinks(marker, { hardlinks: true });
  const record = JSON.parse(fs.readFileSync(marker, 'utf8'));
  return validateRecord(record, root);
}

/** Call immediately before each write/remove. The installation root itself is
 * intentionally never a recursive deletion target. User data survives removal. */
export function assertOwnedPath(record, candidate) {
  const owned = absolute(candidate);
  if (samePath(owned, record.root)) throw Error('Cannot mutate the entire installation root');
  if (!within(record.root, owned)) throw Error('Path is outside the owned beta root');
  rejectLinks(owned, { hardlinks: true });
  return owned;
}

export function betaEnvironment(record, inherited = process.env) {
  validateRecord(record, record.root);
  const p = record.paths;
  const env = {};
  const inheritedValue = key => process.platform === 'win32'
    ? Object.entries(inherited).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1]
    : inherited[key];
  // Do not propagate credentials, arbitrary profile overrides, or package config.
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'OS', 'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'TERM', 'COLORTERM', 'NO_COLOR', 'COOP_BETA_PARENT_PID']) {
    const value = inheritedValue(key);
    if (value !== undefined) env[key] = value;
  }
  const homeParts = process.platform === 'win32'
    ? { HOMEDRIVE: path.parse(p.profile).root.slice(0, 2), HOMEPATH: p.profile.slice(2) }
    : {};
  const systemPaths = env.SystemRoot ? [path.join(env.SystemRoot, 'System32'), path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')] : [];
  return Object.assign(env, {
    HOME: p.profile, USERPROFILE: p.profile, ...homeParts,
    APPDATA: path.join(p.profile, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(p.profile, 'AppData', 'Local'),
    PATH: [...new Set([p.pipxBin, p.npm, path.dirname(record.tools.node.path), path.dirname(record.tools.git.path), ...systemPaths])].join(path.delimiter),
    COOP_CHANNEL: 'beta', COOP_BETA_ROOT: record.root, COOP_PROFILE_ROOT: p.profile,
    COOP_ROOT: p.source, COOP_RELEASE_MANIFEST: p.manifest, COOP_AGENT_DIR: p.agent,
    COOP_NODE: record.tools.node.path, COOP_GIT: record.tools.git.path,
    PI_CODING_AGENT_DIR: p.agent, COOP_NO_ISOLATE: '0',
    PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', COOP_NO_MODEL_LOGIN: '1',
    COOP_PYTHON: record.tools.python.path, COOP_FABRIC_PYTHON: path.join(p.pipx, 'venvs', 'ms-fabric-cli', 'Scripts', 'python.exe'),
    COOP_STANDARDS_ROOT: path.join(p.profile, 'standards', 'canonical'),
    COOP_STANDARDS_SNAPSHOT_ROOT: path.join(p.profile, 'standards', 'snapshots'),
    npm_config_prefix: p.npm, npm_config_cache: path.join(p.cache, 'npm'),
    npm_config_userconfig: path.join(p.profile, 'npmrc'),
    npm_config_globalconfig: path.join(p.profile, 'npmrc-global'),
    PIPX_HOME: p.pipx, COOP_PIPX_HOME: p.pipx, PIPX_BIN_DIR: p.pipxBin,
    PIPX_MAN_DIR: path.join(record.root, 'runtime', 'man'), PIPX_DISABLE_SHARED_LIBS_AUTO_UPGRADE: '1',
    PIPX_SHARED_LIBS: path.join(p.pipx, 'shared'), PIPX_DEFAULT_PYTHON: record.tools.python.path,
    PIP_CACHE_DIR: path.join(p.cache, 'pip'), PIP_CONFIG_FILE: os.devNull,
    PIP_NO_INPUT: '1', PIP_KEYRING_PROVIDER: 'disabled', PIP_ONLY_BINARY: ':all:',
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1',
    TEMP: p.temp, TMP: p.temp, TMPDIR: p.temp,
    JITI_FS_CACHE: path.join(p.cache, 'jiti'), JITI_CACHE_DIR: path.join(p.cache, 'jiti'),
    AZURE_CONFIG_DIR: path.join(p.profile, 'azure'), AZURE_CORE_COLLECT_TELEMETRY: 'false',
    PI_MCP_CONFIG_MODE: 'exclusive', PI_MCP_CONFIG_PATH: path.join(p.agent, 'mcp.json'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(p.profile, 'gitconfig'), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
  });
}

/** Runtime entry must originate in the selected clean checkout, not a stable
 * script accidentally launched with beta environment variables. */
export function verifyBetaSource(record, source) {
  validateRecord(record, record.root);
  if (!samePath(absolute(source), record.paths.source)) throw Error('Beta invocation came from a different source root');
  const env = betaEnvironment(record);
  const git = args => execFileSync(record.tools.git.path, ['-C', source, ...args], { env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).trim();
  if (git(['rev-parse', 'HEAD']) !== record.build) throw Error('Beta source build differs from selected identity');
  if (git(['status', '--porcelain', '--untracked-files=all'])) throw Error('Beta source is dirty; preserve it and select a clean build');
  if (sha256(fs.readFileSync(record.paths.manifest)) !== record.manifestHash) throw Error('Selected beta manifest changed');
  // These profile entrypoints must not be writable links into a different channel.
  for (const relative of ['config', 'user.json', 'agent/auth.json', 'agent/models.json', 'agent/settings.json', 'agent/mcp.json', 'agent/npm']) assertOwnedPath(record, path.join(record.paths.profile, relative));
  return record;
}

/** Recovery may load the selected clean code from a retained directory when a
 * interrupted rename has made source unavailable. Never search outside beta. */
export function recoverySource(record, requested) {
  validateRecord(record, record.root);
  const candidates = ['source', 'previous-source', 'retired-source', 'candidate-source'].map(name => path.join(record.root, name));
  const env = betaEnvironment(record);
  for (const candidate of candidates) {
    if (requested && !samePath(candidate, absolute(requested))) continue;
    assertOwnedPath(record, candidate);
    try {
      const git = args => execFileSync(record.tools.git.path, ['-C', candidate, ...args], { env, windowsHide: true, timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (git(['rev-parse', 'HEAD']) !== record.build || git(['status', '--porcelain', '--untracked-files=all'])) continue;
      if (sha256(fs.readFileSync(path.join(candidate, 'config/windows-beta-manifest.json'))) !== record.manifestHash) continue;
      return candidate;
    } catch { }
  }
  throw Error('No clean selected beta source is available for recovery; preserve the installation');
}

/** The small immutable recovery bundle remains after application removal.
 * Its hashes prevent accidental mixed or modified helpers from being executed. */
export function verifyBetaRecovery(record) {
  validateRecord(record, record.root);
  const file = assertOwnedPath(record, path.join(record.paths.bin, 'recovery.json'));
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  const names = ['installation-context.mjs', 'beta-entry.mjs', 'coop-beta.ps1', 'coop-beta.cmd'];
  if (receipt.schema !== 1 || receipt.manifestHash !== record.manifestHash || !/^[0-9a-f]{40}$/.test(receipt.build) ||
      JSON.stringify(Object.keys(receipt.files || {}).sort()) !== JSON.stringify([...names].sort())) throw Error('Invalid beta recovery identity');
  for (const name of names) {
    const source = assertOwnedPath(record, path.join(record.paths.bin, name));
    if (sha256(fs.readFileSync(source)) !== receipt.files[name]) throw Error('Beta recovery helper changed; use a clean reviewed source for repair');
  }
  return record;
}

export const recoveryModuleNames = Object.freeze(['installation-context.mjs', 'beta-lifecycle.mjs', 'owned-process.ps1']);

/** Immutable helpers for one exact build. The bootstrap never substitutes a
 * different version if this directory or its receipt is missing or modified. */
export function verifyRecoveryVersion(record, build = record.build) {
  validateRecord(record, record.root);
  if (!/^[0-9a-f]{40}$/.test(build)) throw Error('Invalid recovery build');
  const directory = assertOwnedPath(record, path.join(record.root, 'recovery', build));
  const receipt = JSON.parse(fs.readFileSync(assertOwnedPath(record, path.join(directory, 'receipt.json')), 'utf8'));
  if (receipt.schema !== 1 || receipt.build !== build || receipt.manifestHash !== record.manifestHash ||
      JSON.stringify(Object.keys(receipt.files || {}).sort()) !== JSON.stringify([...recoveryModuleNames].sort())) throw Error('Invalid versioned beta recovery identity');
  for (const name of recoveryModuleNames) {
    if (sha256(fs.readFileSync(assertOwnedPath(record, path.join(directory, name)))) !== receipt.files[name]) throw Error('Versioned beta recovery helper changed');
  }
  return directory;
}

export function betaRecoveryDirectory(record) {
  verifyBetaRecovery(record);
  let build = record.build;
  const journal = assertOwnedPath(record, path.join(record.root, '.coop-beta-transaction.json'));
  if (fs.existsSync(journal)) {
    const pending = JSON.parse(fs.readFileSync(journal, 'utf8'));
    if (pending.operation === 'update' && pending.recoveryBuild !== undefined) {
      const same = other => /^[0-9a-f]{40}$/.test(other?.build || '') && JSON.stringify(other) === JSON.stringify({ ...record, build: other.build });
      if (!same(pending.before) || !same(pending.after) || ![pending.before.build, pending.after.build].includes(record.build) ||
          ![pending.before.build, pending.after.build].includes(pending.recoveryBuild)) throw Error('Invalid source-transition recovery selection');
      build = pending.recoveryBuild;
    }
  }
  return verifyRecoveryVersion(record, build);
}

/** Resolve the actual package and its declared executable, never an npm/npx
 * cache label or a global command with the same name. This does not execute it. */
export function betaNodeEntry(record, group, name, binName) {
  if (!['pi', 'npm_tools', 'mcp_servers', 'extensions'].includes(group) || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || name.includes('..')) throw Error('Unknown beta package selection');
  const manifest = JSON.parse(fs.readFileSync(assertOwnedPath(record, record.paths.manifest), 'utf8'));
  if (sha256(fs.readFileSync(record.paths.manifest)) !== record.manifestHash) throw Error('Selected beta manifest changed');
  const expected = group === 'pi' && manifest.pi?.package === name ? manifest.pi.version : manifest[group]?.[name];
  if (typeof expected !== 'string' || !expected) throw Error('Package is not in the selected beta manifest');
  const prefix = group === 'extensions' ? path.join(record.paths.agent, 'npm') : record.paths.npm;
  const packageRoot = assertOwnedPath(record, path.join(prefix, 'node_modules', name));
  const metadata = assertOwnedPath(record, path.join(packageRoot, 'package.json'));
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(metadata, 'utf8')); } catch { throw Error('Selected beta package is missing or invalid; no global fallback'); }
  if (pkg.name !== name || pkg.version !== expected) throw Error('Selected beta package identity/version does not match manifest');
  const relative = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[binName];
  if (typeof relative !== 'string') throw Error('Selected beta package has no declared executable');
  const entry = assertOwnedPath(record, path.resolve(packageRoot, relative));
  if (!within(packageRoot, entry) || !fs.statSync(entry).isFile()) throw Error('Selected beta executable escapes its package or is missing');
  return entry;
}

if (process.argv[1] && samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  try {
    const [command, root, source, group, name, binName] = process.argv.slice(2);
    if (command === 'recovery-context' && root) {
      const context = verifyBetaRecovery(loadBetaContext(root));
      console.log(shellJson({ context, environment: betaEnvironment(context), recoveryDirectory: betaRecoveryDirectory(context) }));
      process.exit(0);
    }
    if (command === 'recovery-source' && root) {
      console.log(shellJson(recoverySource(loadBetaContext(root))));
      process.exit(0);
    }
    if (command === 'recovery-environment' && root && source) {
      const context = loadBetaContext(root);
      recoverySource(context, source);
      console.log(shellJson({ context, environment: betaEnvironment(context) }));
      process.exit(0);
    }
    if (!['environment', 'package'].includes(command) || !root || !source) throw Error('Usage: installation-context.mjs environment|package ROOT SOURCE [GROUP NAME BIN]');
    const record = verifyBetaSource(loadBetaContext(root), source);
    // ASCII JSON avoids PowerShell 5.1's console-codepage-dependent native
    // stdout decoding, including hidden/no-console startup on Unicode roots.
    if (command === 'package') console.log(shellJson(betaNodeEntry(record, group, name, binName)));
    else console.log(shellJson({ context: record, environment: betaEnvironment(record) }));
  } catch (error) {
    // No command arguments, environment values or subprocess stderr in errors.
    console.error(error instanceof Error && !('stderr' in error) ? error.message : 'Beta source verification failed');
    process.exitCode = 1;
  }
}

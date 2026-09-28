/** B1 lifecycle operations behind the existing install/sync/doctor/update/remove
 * commands. All mutations use the same validated installation context. No global
 * installers, credential migration, persistent PATH changes or version selection.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { planBetaContext, claimBetaRoot, loadBetaContext, verifyBetaSource,
  assertOwnedPath, rejectLinks, betaEnvironment, betaNodeEntry, shellJson,
  betaRecoveryDirectory, verifyRecoveryVersion, recoveryModuleNames } from './installation-context.mjs';

// -I ignores PYTHONUTF8, so select UTF-8 explicitly for the parent.
// The scoped environment carries PYTHONUTF8 to package-manager children.
export const betaPythonFlags = Object.freeze(['-I', '-B', '-X', 'utf8']);

const baseline = 'cee2d7418c0357f8e4bbd23e438cf026e2e15764';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const moduleRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const marker = ctx => path.join(ctx.root, '.coop-beta.json');
const transaction = ctx => path.join(ctx.root, '.coop-beta-transaction.json');
const removedMarker = ctx => path.join(ctx.root, '.coop-beta-removed.json');

function run(ctx, executable, args, { cwd = fs.existsSync(ctx.root) ? ctx.root : moduleRoot, timeout = 120000 } = {}) {
  // The PowerShell caller owns this process and its descendants in a Job Object.
  // Never print package-manager output that may contain credentials or user paths.
  try { return execFileSync(executable, args, { cwd, env: betaEnvironment(ctx), timeout,
    windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }); }
  catch { throw Error(`Beta ${path.basename(executable)} operation failed; existing state retained for recovery`); }
}
function writeJson(ctx, file, value) {
  assertOwnedPath(ctx, file);
  const pending = assertOwnedPath(ctx, `${file}.pending`);
  if (fs.existsSync(pending)) throw Error('Pending beta write exists; inspect recovery state');
  fs.writeFileSync(pending, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(pending, file);
}
function mkdir(ctx, file) { fs.mkdirSync(assertOwnedPath(ctx, file), { recursive: true }); }

/** Validate the entire tree before a recursive copy/remove or package mutation.
 * A link anywhere below a package root is a refusal, never something to follow. */
export function inspectOwnedTree(ctx, file) {
  assertOwnedPath(ctx, file);
  // Validate ancestors once, then each descendant once. Re-walking every
  // ancestor for every package file makes native rollback take many minutes.
  const visit = entry => {
    let stat;
    try { stat = fs.lstatSync(entry); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw Error('Link/reparse path is not beta-owned');
    if (stat.isFile() && stat.nlink > 1) throw Error('Hardlink aliases are not beta-owned');
    const resolved = path.resolve(fs.realpathSync.native(entry));
    const same = process.platform === 'win32' ? resolved.toLowerCase() === entry.toLowerCase() : resolved === entry;
    if (!same) throw Error('Reparse path changes beta ownership');
    if (stat.isDirectory()) for (const name of fs.readdirSync(entry)) visit(path.join(entry, name));
  };
  visit(path.resolve(file));
}
function remove(ctx, file) {
  inspectOwnedTree(ctx, file);
  // The selected Windows Node 24.18.0 aborts inside rmSync on a file held
  // without delete sharing. Primitive unlink/rmdir surface EBUSY instead, so
  // the lifecycle journal can report failure and remain retryable.
  const visit = entry => {
    assertOwnedPath(ctx, entry);
    let stat;
    try { stat = fs.lstatSync(entry); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(entry)) visit(path.join(entry, name));
      fs.rmdirSync(entry);
    } else fs.unlinkSync(entry);
  };
  visit(file);
}
function copy(ctx, from, to) {
  inspectOwnedTree(ctx, from); inspectOwnedTree(ctx, to);
  fs.cpSync(from, assertOwnedPath(ctx, to), { recursive: true, errorOnExist: true, force: false });
}
function git(ctx, source, args) { return run(ctx, ctx.tools.git.path, ['-C', source, ...args], { timeout: 30000 }).trim(); }
function noPending(ctx) {
  if (fs.existsSync(transaction(ctx))) throw Error('An interrupted beta operation requires rollback before further changes');
}

/** Only a clean, locally reviewed exact commit descended from the accepted
 * terminal baseline is eligible. A branch name is never an update target. */
export function eligibleBuild(ctx, source, build, { ancestry = baseline } = {}) {
  if (!path.isAbsolute(source) || !/^[0-9a-f]{40}$/.test(build)) throw Error('Select an absolute source checkout and exact build SHA');
  rejectLinks(source);
  if (git(ctx, source, ['status', '--porcelain', '--untracked-files=all'])) throw Error('Candidate source is dirty; no beta mutation performed');
  if (git(ctx, source, ['rev-parse', 'HEAD']) !== build) throw Error('Candidate checkout is not at the selected build');
  git(ctx, source, ['merge-base', '--is-ancestor', ancestry, build]);
  const manifest = run(ctx, ctx.tools.git.path, ['-C', source, 'show', `${build}:config/windows-beta-manifest.json`]);
  if (hash(manifest) !== ctx.manifestHash) throw Error('Candidate changes the selected manifest; separate package qualification is required');
  return source;
}

function cloneBuild(ctx, source, build, destination) {
  assertOwnedPath(ctx, destination);
  if (fs.existsSync(destination)) throw Error('Candidate source destination already exists');
  run(ctx, ctx.tools.git.path, ['-c', 'core.autocrlf=false', 'clone', '--no-hardlinks', '--no-checkout', '--', source, destination]);
  git(ctx, destination, ['config', 'core.autocrlf', 'false']);
  git(ctx, destination, ['checkout', '--detach', build]);
  if (git(ctx, destination, ['status', '--porcelain', '--untracked-files=all'])) throw Error('Cloned beta source is not clean');
}

/** Pure request validation precedes ownership claim and package work. The request
 * contains {root, source, build, tools:{node,python,fabricPython,git}}. */
export function planInstall(request) {
  if (process.platform !== 'win32') throw Error('B1 beta requires native Windows');
  if (!path.isAbsolute(request.source || '')) throw Error('Select an absolute local source checkout');
  rejectLinks(request.source);
  const bytes = fs.readFileSync(path.join(request.source, 'config/windows-beta-manifest.json'));
  const npmPath = path.join(path.dirname(request.tools?.node || ''), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const ctx = planBetaContext({ ...request, tools: { ...request.tools, npm: npmPath }, manifest: bytes, protectedRoots: [request.source, ...(request.protectedRoots || [])] });
  // Read-only git validation can run before the beta TEMP directory exists.
  eligibleBuild(ctx, request.source, request.build);
  return ctx;
}

export function readPackageInventory(ctx) {
  const manifest = json(ctx.paths.manifest);
  const expected = [[ctx.paths.npm, manifest.pi.package, manifest.pi.version],
    ...Object.entries(manifest.npm_tools).map(([name, version]) => [ctx.paths.npm, name, version]),
    ...Object.entries(manifest.mcp_servers).map(([name, version]) => [ctx.paths.npm, name, version]),
    ...Object.entries(manifest.extensions).map(([name, version]) => [path.join(ctx.paths.agent, 'npm'), name, version]),
    ...['@earendil-works/pi-ai', '@earendil-works/pi-tui'].map(name => [path.join(ctx.paths.agent, 'npm'), name, manifest.pi.version])];
  const packages = expected.map(([prefix, name, version]) => {
    const scope = prefix === ctx.paths.npm ? 'runtime' : 'extensions';
    const metadata = assertOwnedPath(ctx, path.join(prefix, 'node_modules', name, 'package.json'));
    try { const bytes = fs.readFileSync(metadata); const pkg = JSON.parse(bytes); return { name, scope, expected: version,
      actual: pkg.version, matches: pkg.name === name && pkg.version === version, metadataHash: hash(bytes) }; }
    catch { return { name, scope, expected: version, actual: null, matches: false }; }
  });
  return packages;
}

function pythonPackages(ctx) {
  const expected = json(ctx.paths.manifest).python_tools;
  return Object.entries(expected).map(([name, version]) => {
    const environment = ['fabric-cicd', 'pyodbc'].includes(name) ? 'ms-fabric-cli' : name;
    const executable = assertOwnedPath(ctx, path.join(ctx.paths.pipx, 'venvs', environment, 'Scripts', 'python.exe'));
    if (!fs.existsSync(executable)) return { name, expected: version, actual: null, matches: false };
    try {
      const actual = run(ctx, executable, [...betaPythonFlags, '-c', 'import importlib.metadata,sys; print(importlib.metadata.version(sys.argv[1]))', name], { timeout: 15000 }).trim();
      return { name, expected: version, actual, matches: actual === version };
    } catch { return { name, expected: version, actual: null, matches: false }; }
  });
}

function npm(ctx, args) {
  const cli = ctx.tools.npm?.path;
  if (!cli) throw Error('No qualified npm CLI in this installation context');
  rejectLinks(cli);
  if (!fs.existsSync(cli)) throw Error('Selected Node installation has no npm CLI; no PATH fallback');
  // Install scripts are intentionally not run: several packages have installers
  // that discover/repair other products under HOME. Native capabilities require
  // separate qualification; missing binaries never trigger an automatic rebuild.
  return run(ctx, ctx.tools.node.path, [cli, ...args, '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], { timeout: 600000 });
}

function ensurePython(ctx) {
  const bootstrap = path.join(ctx.root, 'runtime', 'pipx-bootstrap');
  const executable = assertOwnedPath(ctx, path.join(bootstrap, 'Scripts', 'python.exe'));
  // pipx's shared-lib creation otherwise upgrades to an unbounded pip version.
  // Precreate it with the reconciled workstation pip 26.2.1 and disable pipx's
  // periodic auto-upgrade. Both environments are private and retain that pin.
  for (const environment of [bootstrap, path.join(ctx.paths.pipx, 'shared')]) {
    const interpreter = assertOwnedPath(ctx, path.join(environment, 'Scripts', 'python.exe'));
    if (!fs.existsSync(interpreter)) run(ctx, ctx.tools.python.path, [...betaPythonFlags, '-m', 'venv', environment]);
    const installed = run(ctx, interpreter, [...betaPythonFlags, '-c', 'import importlib.metadata; print(importlib.metadata.version("pip"))']).trim();
    if (installed !== '26.2.1') run(ctx, interpreter, [...betaPythonFlags, '-m', 'pip', 'install', '--disable-pip-version-check', 'pip==26.2.1']);
  }
  // Match this workstation's existing pipx bootstrap version; no latest lookup.
  const bootstrapVersion = (() => { try { return run(ctx, executable, [...betaPythonFlags, '-c', 'import importlib.metadata; print(importlib.metadata.version("pipx"))']).trim(); } catch { return null; } })();
  if (bootstrapVersion !== '1.14.1') run(ctx, executable, [...betaPythonFlags, '-m', 'pip', 'install', '--disable-pip-version-check', 'pipx==1.14.1']);
  const manifest = json(ctx.paths.manifest);
  const inventory = pythonPackages(ctx);
  for (const name of ['coop-data-doc', 'coop-sql-review', 'coop-dax-review', 'ms-fabric-cli']) {
    if (inventory.find(p => p.name === name)?.matches) continue;
    const interpreter = name === 'ms-fabric-cli' ? ctx.tools.fabricPython.path : ctx.tools.python.path;
    run(ctx, executable, [...betaPythonFlags, '-m', 'pipx', 'install', '--force', '--python', interpreter, `${name}==${manifest.python_tools[name]}`], { timeout: 600000 });
  }
  for (const name of ['fabric-cicd', 'pyodbc']) {
    if (inventory.find(p => p.name === name)?.matches) continue;
    run(ctx, executable, [...betaPythonFlags, '-m', 'pipx', 'inject', '--force', 'ms-fabric-cli', `${name}==${manifest.python_tools[name]}`], { timeout: 600000 });
  }
  // Fabric CLI 1.7.0 unconditionally uses ~/.config/fab at import. Keep its
  // private packages for library/version qualification, but expose no fab
  // command until vendor-specific state isolation is available.
  for (const name of ['fab.exe', 'fab', 'fab.cmd', 'fab.ps1']) {
    const executable = path.join(ctx.paths.pipxBin, name);
    if (fs.existsSync(executable)) { inspectOwnedTree(ctx, executable); fs.unlinkSync(assertOwnedPath(ctx, executable)); }
  }
}

/** Change only managed fields; preserve all unknown fields. Credentials and
 * models are never read, generated or copied by sync. Unqualified providers and
 * integrations stay disabled instead of borrowing another channel's state. */
function syncSettings(ctx) {
  const manifest = json(ctx.paths.manifest);
  const settingsPath = path.join(ctx.paths.agent, 'settings.json');
  const settings = fs.existsSync(settingsPath) ? json(settingsPath) : {};
  const blocked = ['pi-web-access', 'context-mode'];
  const packages = Object.keys(manifest.extensions).map(name => ({ source: `npm:${name}@${manifest.extensions[name]}`,
    ...(blocked.includes(name) ? { extensions: [], skills: [], prompts: [], themes: [] } : {}) }));
  // Do not carry unreviewed package/resource paths into a beta launch.
  if (settings.packages && JSON.stringify(settings.packages) !== JSON.stringify(packages)) throw Error('Beta resource selection changed; review before sync');
  if (settings.defaultProvider && settings.defaultProvider !== 'openai-codex') throw Error('Beta work uses the OpenAI subscription provider only');
  if (settings.defaultModel && !settings.defaultModel.startsWith('gpt-')) throw Error('Beta work requires a GPT model');
  writeJson(ctx, settingsPath, { ...settings, quietStartup: true, packages,
    defaultProvider: settings.defaultProvider || 'openai-codex', defaultModel: settings.defaultModel || 'gpt-5.6-terra',
    _coopBeta: { disabledExtensions: blocked, networkIntegrations: 'disabled pending qualification' } });
  const mcp = path.join(ctx.paths.agent, 'mcp.json');
  if (!fs.existsSync(mcp)) writeJson(ctx, mcp, { mcpServers: {} });
  // A config exists solely for this channel. Never run the global onboarding
  // wizard (which would generate enabled service entries) during provisioning.
  const config = path.join(ctx.paths.profile, 'config');
  if (!fs.existsSync(config)) writeJson(ctx, config, { schema_version: 1, integrations: {} });
}

export function syncBeta(ctx) {
  verifyBetaSource(ctx, ctx.paths.source); noPending(ctx);
  const manifest = json(ctx.paths.manifest);
  for (const file of [ctx.paths.profile, path.join(ctx.root, 'runtime'), ctx.paths.cache, ctx.paths.temp]) inspectOwnedTree(ctx, file);
  for (const file of [ctx.paths.agent, ctx.paths.npm, ctx.paths.pipxBin, ctx.paths.cache, ctx.paths.temp]) mkdir(ctx, file);
  const packages = readPackageInventory(ctx);
  const python = pythonPackages(ctx);
  const changing = packages.some(p => !p.matches) || python.some(p => !p.matches);
  if (!changing) { syncSettings(ctx); return betaDoctor(ctx); }
  const backup = path.join(ctx.root, 'package-rollback');
  if (fs.existsSync(backup)) throw Error('Previous package recovery data exists; preserve it before another repair');
  mkdir(ctx, backup);
  const owned = [path.join(ctx.root, 'runtime'), path.join(ctx.paths.agent, 'npm')];
  const snapshots = owned.map((original, index) => ({ original, saved: path.join(backup, String(index)), existed: fs.existsSync(original) }));
  for (const item of snapshots) if (item.existed) copy(ctx, item.original, item.saved);
  writeJson(ctx, transaction(ctx), { operation: 'sync', before: ctx, snapshots });
  try {
    const main = packages.filter(p => p.scope === 'runtime');
    if (main.some(p => !p.matches)) npm(ctx, ['install', '--global', '--prefix', ctx.paths.npm, ...main.map(p => `${p.name}@${p.expected}`)]);
    if (packages.some(p => p.scope === 'extensions' && !p.matches)) {
      const prefix = path.join(ctx.paths.agent, 'npm'); mkdir(ctx, prefix);
      const file = path.join(prefix, 'package.json');
      const existing = fs.existsSync(file) ? json(file) : {};
      writeJson(ctx, file, { ...existing, private: true, dependencies: { ...manifest.extensions, '@earendil-works/pi-ai': manifest.pi.version, '@earendil-works/pi-tui': manifest.pi.version },
        overrides: { ...existing.overrides, '@earendil-works/pi-ai': manifest.pi.version,
          '@earendil-works/pi-tui': manifest.pi.version, '@earendil-works/pi-coding-agent': manifest.pi.version } });
      npm(ctx, ['install', '--prefix', prefix]);
    }
    ensurePython(ctx);
    if (readPackageInventory(ctx).some(p => !p.matches) || pythonPackages(ctx).some(p => !p.matches)) throw Error('Beta package postcondition failed');
    syncSettings(ctx);
    fs.unlinkSync(assertOwnedPath(ctx, transaction(ctx)));
    remove(ctx, backup);
    return betaDoctor(ctx);
  } catch { throw Error('Beta package convergence failed; run beta rollback to restore the saved package state'); }
}

/** Claim before the native caller acquires its operation lease. Repeating this
 * stage validates identity only; it never changes an existing installation. */
export function claimInstall(request) {
  const ctx = planInstall(request);
  if (fs.existsSync(marker(ctx))) {
    const prior = loadBetaContext(ctx.root);
    // Reinstallation retains the recorded protection set and identity. A new
    // clean source location may add overlap checks but cannot change versions,
    // tools, paths or the previously accepted build of this profile.
    const identity = ({ protectedRoots, ...record }) => JSON.stringify(record);
    if (identity(prior) !== identity(ctx)) throw Error('Reinstall must select the same beta build, manifest and tools');
    return prior;
  }
  claimBetaRoot(ctx);
  return ctx;
}

/** An interrupted first source preparation has no package state or completed
 * removal receipt. Retain incomplete code before retrying; never delete it. The
 * public caller holds the Windows lease across this entire operation. */
export function prepareInitialBeta(ctx, source) {
  noPending(ctx);
  const allowed = new Set(['.coop-beta.json', '.coop-beta.lock', 'source', 'bin',
    'recovery', 'temp', 'cache', 'profile', 'workspaces', 'retained-installs']);
  if (fs.readdirSync(ctx.root).some(name => !allowed.has(name)) ||
      fs.existsSync(path.join(ctx.paths.agent, 'npm'))) {
    throw Error('First-install retry found unexpected application state; preserve it for inspection');
  }
  const targets = [ctx.paths.source, ctx.paths.bin, path.join(ctx.root, 'recovery')];
  for (const target of targets) inspectOwnedTree(ctx, target);
  eligibleBuild(ctx, source, ctx.build, { ancestry: ctx.build });
  const receipt = path.join(ctx.paths.bin, 'recovery.json');
  if (fs.existsSync(receipt)) {
    // The first source step completed before its caller stopped. Verify every
    // recovery hash before allowing the unchanged plan to proceed to sync.
    betaRecoveryDirectory(ctx);
    verifyBetaSource(ctx, ctx.paths.source);
    return ctx;
  }
  const retained = path.join(ctx.root, 'retained-installs', randomUUID());
  inspectOwnedTree(ctx, path.dirname(retained));
  for (const target of targets) {
    if (!fs.existsSync(target)) continue;
    mkdir(ctx, retained);
    // Both ends are validated immediately before each move. An interruption
    // between moves leaves separately named retained copies for the next retry.
    fs.renameSync(assertOwnedPath(ctx, target), assertOwnedPath(ctx, path.join(retained, path.basename(target))));
  }
  for (const file of [ctx.paths.temp, ctx.paths.cache, ctx.paths.bin, ctx.paths.profile, path.join(ctx.root, 'workspaces')]) mkdir(ctx, file);
  cloneBuild(ctx, source, ctx.build, ctx.paths.source);
  verifyBetaSource(ctx, ctx.paths.source);
  writeBetaLaunchers(ctx);
  return ctx;
}

export function installBeta(request) {
  const ctx = claimInstall(request);
  if (fs.existsSync(removedMarker(ctx)) || fs.existsSync(transaction(ctx))) return reinstallBeta(ctx, request.source);
  return prepareInitialBeta(ctx, request.source);
}

function reinstallState(ctx) {
  if (!fs.existsSync(transaction(ctx))) return null;
  const pending = json(transaction(ctx));
  if (pending.operation !== 'reinstall') return null;
  if (JSON.stringify(pending.before) !== JSON.stringify(ctx) || !path.isAbsolute(pending.source || '') || typeof pending.product !== 'string') throw Error('Invalid beta reinstall transaction');
  return pending;
}

/** Reuse only a deliberately removed installation, never an arbitrary nonempty
 * directory. Code is staged; profile data and the verified recovery entry stay
 * in place. Failed staging can be retained by the existing rollback command. */
export function reinstallBeta(ctx, source) {
  betaRecoveryDirectory(ctx);
  eligibleBuild(ctx, source, ctx.build, { ancestry: ctx.build });
  const relative = path.relative(ctx.root, source);
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw Error('Reinstall source must be outside the owned beta root');
  let pending = reinstallState(ctx);
  if (pending && pending.source !== source) throw Error('Retry reinstall with the same source checkout or roll it back');
  const staged = path.join(ctx.root, 'reinstall-source');
  if (!pending) {
    const removed = removalState(ctx);
    if (removed?.operation !== 'removed') throw Error('Reinstall requires completed beta removal');
    removeBeta(ctx); // finish a matching removal journal left at completion
    noPending(ctx);
    if (fs.existsSync(staged)) throw Error('Unowned reinstall staging exists; preserve it before proceeding');
    pending = { operation: 'reinstall', before: ctx, source, product: removed.product };
    writeJson(ctx, transaction(ctx), pending);
  }
  // Packages must still be absent: the install command syncs them only after
  // code recovery completes. Never adopt unexpected application state.
  for (const target of removalTargets(ctx).filter(file => file !== ctx.paths.source)) {
    assertOwnedPath(ctx, target);
    if (fs.existsSync(target)) throw Error('Unexpected application state during beta reinstall');
  }
  inspectOwnedTree(ctx, staged); inspectOwnedTree(ctx, ctx.paths.source);
  try {
    if (fs.existsSync(ctx.paths.source)) {
      verifyBetaSource(ctx, ctx.paths.source);
      if (fs.existsSync(staged)) throw Error('Both source and reinstall staging exist');
    } else {
      if (!fs.existsSync(staged)) cloneBuild(ctx, source, ctx.build, staged);
      eligibleBuild(ctx, staged, ctx.build, { ancestry: ctx.build });
      fs.renameSync(staged, assertOwnedPath(ctx, ctx.paths.source));
      verifyBetaSource(ctx, ctx.paths.source);
    }
    if (fs.existsSync(removedMarker(ctx))) fs.unlinkSync(assertOwnedPath(ctx, removedMarker(ctx)));
    fs.unlinkSync(assertOwnedPath(ctx, transaction(ctx)));
    return ctx;
  } catch { throw Error('Beta reinstall is incomplete; retry the same plan or run beta update --rollback to retain staging. Profile data is preserved.'); }
}

export function writeBetaLaunchers(ctx) {
  verifyBetaSource(ctx, ctx.paths.source);
  writeBetaRecoveryVersion(ctx, ctx.paths.source, ctx.build);
  mkdir(ctx, ctx.paths.bin);
  // Keep a tiny recovery entry outside source/runtime. An interrupted source
  // rename must not remove the only available rollback implementation.
  for (const name of ['installation-context.mjs', 'beta-entry.mjs']) {
    fs.copyFileSync(path.join(ctx.paths.source, 'lib', name), assertOwnedPath(ctx, path.join(ctx.paths.bin, name)), fs.constants.COPYFILE_EXCL);
  }
  const entry = `$ErrorActionPreference = 'Stop'
$betaRoot = Split-Path -Parent $PSScriptRoot
$record = Get-Content -LiteralPath (Join-Path $betaRoot '.coop-beta.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$hasher = [Security.Cryptography.SHA256]::Create()
try { $nodeHash = [BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes($record.tools.node.path))).Replace('-', '').ToLowerInvariant() } finally { $hasher.Dispose() }
if ($nodeHash -ne $record.tools.node.sha256) { throw 'Selected beta Node changed' }
$forwarded = @($args)
if ($env:COOP_BETA_ARGV) { $forwarded = [string[]]([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:COOP_BETA_ARGV)) | ConvertFrom-Json) }
Remove-Item Env:COOP_BETA_ARGV -ErrorAction SilentlyContinue
$env:COOP_CHANNEL = 'beta'; $env:COOP_BETA_ROOT = $betaRoot
$recoveryOperation = $null
if ($forwarded.Count -eq 2 -and $forwarded[0] -eq 'update' -and $forwarded[1] -eq '--rollback') { $recoveryOperation = 'rollback' }
if ($forwarded.Count -eq 1 -and $forwarded[0] -in @('uninstall','doctor')) { $recoveryOperation = $forwarded[0] }
if ($recoveryOperation) {
  $resolved = & $record.tools.node.path (Join-Path $PSScriptRoot 'installation-context.mjs') recovery-context $betaRoot
  if ($LASTEXITCODE -ne 0) { exit 1 }
  $resolved = $resolved | ConvertFrom-Json
  $script:CoopEntryParent = $null
  if ($env:COOP_BETA_PARENT_PID) { $script:CoopEntryParent = [Diagnostics.Process]::GetProcessById([int]$env:COOP_BETA_PARENT_PID) }
  foreach ($key in @([Environment]::GetEnvironmentVariables('Process').Keys)) { [Environment]::SetEnvironmentVariable([string]$key, $null, 'Process') }
  foreach ($property in $resolved.environment.PSObject.Properties) { [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process') }
  $script:CoopInstallationContext = $resolved.context
  . (Join-Path $resolved.recoveryDirectory 'owned-process.ps1')
  Invoke-CoopWindowsOwnedProcess -FilePath $record.tools.node.path -ArgumentVector @((Join-Path $resolved.recoveryDirectory 'beta-lifecycle.mjs'), $recoveryOperation, $betaRoot) -TimeoutMilliseconds 1800000 -ReadOnly:($recoveryOperation -eq 'doctor')
  exit $LASTEXITCODE
}
& (Join-Path $betaRoot 'source/bin/coop.ps1') @forwarded
exit $LASTEXITCODE
`;
  fs.writeFileSync(assertOwnedPath(ctx, path.join(ctx.paths.bin, 'coop-beta.ps1')), `\uFEFF${entry}`, { flag: 'wx' });
  const quotedNode = ctx.tools.node.path.replaceAll('%', '%%');
  fs.writeFileSync(assertOwnedPath(ctx, path.join(ctx.paths.bin, 'coop-beta.cmd')), `@echo off\r\n"${quotedNode}" "%~dp0beta-entry.mjs" %*\r\nexit /b %errorlevel%\r\n`, { flag: 'wx' });
  const files = {};
  for (const name of ['installation-context.mjs', 'beta-entry.mjs', 'coop-beta.ps1', 'coop-beta.cmd']) files[name] = hash(fs.readFileSync(path.join(ctx.paths.bin, name)));
  writeJson(ctx, path.join(ctx.paths.bin, 'recovery.json'), { schema: 1, build: ctx.build, manifestHash: ctx.manifestHash, files });
}

export function writeBetaRecoveryVersion(ctx, source, build) {
  checkedSource(ctx, source, build);
  const parent = path.join(ctx.root, 'recovery'), destination = path.join(parent, build);
  const files = Object.fromEntries(recoveryModuleNames.map(name => {
    const bytes = fs.readFileSync(path.join(source, 'lib', name));
    const committed = run(ctx, ctx.tools.git.path, ['-C', source, 'show', `${build}:lib/${name}`]);
    if (hash(bytes) !== hash(committed)) throw Error('Recovery helper differs from selected source commit');
    return [name, hash(bytes)];
  }));
  if (fs.existsSync(destination)) {
    verifyRecoveryVersion(ctx, build);
    if (JSON.stringify(json(path.join(destination, 'receipt.json')).files) !== JSON.stringify(files)) throw Error('Recovery build already has different helper bytes');
    validatePublishedRecovery(ctx, build, destination);
    return destination;
  }
  mkdir(ctx, parent);
  const staged = path.join(parent, `.pending-${randomUUID()}`);
  mkdir(ctx, staged);
  for (const name of recoveryModuleNames) fs.copyFileSync(path.join(source, 'lib', name), assertOwnedPath(ctx, path.join(staged, name)), fs.constants.COPYFILE_EXCL);
  writeJson(ctx, path.join(staged, 'receipt.json'), { schema: 1, build, manifestHash: ctx.manifestHash, files });
  // Resolve the copied module graph before changing the selected build. A
  // candidate requiring an unpackaged helper must fail while old recovery works.
  const loaded = run(ctx, ctx.tools.node.path, ['--input-type=module', '-e',
    'const m=await import(process.argv[1]); if(!["betaDoctor","rollbackBeta","removeBeta"].every(k=>typeof m[k]==="function")) throw Error("Invalid recovery exports"); console.log("COOP_RECOVERY_READY");',
    pathToFileURL(path.join(staged, 'beta-lifecycle.mjs')).href]);
  if (loaded.trim() !== 'COOP_RECOVERY_READY') throw Error('Candidate recovery module did not validate');
  fs.renameSync(assertOwnedPath(ctx, staged), assertOwnedPath(ctx, destination));
  validatePublishedRecovery(ctx, build, destination);
  return verifyRecoveryVersion(ctx, build);
}

function validatePublishedRecovery(ctx, build, directory) {
  // Use the candidate's validator too: an importable module can still expect a
  // different receipt/bootstrap protocol. Reject that before selecting it, on
  // both first publication and reuse of a previously staged build.
  const output = run(ctx, ctx.tools.node.path, ['--input-type=module', '-e',
    'const m=await import(process.argv[1]); const r=JSON.parse(process.argv[2]); m.verifyRecoveryVersion(r); if(process.argv[3]==="1") m.verifyBetaRecovery(r); console.log("COOP_RECOVERY_VALID");',
    pathToFileURL(path.join(directory, 'installation-context.mjs')).href, JSON.stringify({ ...ctx, build }),
    fs.existsSync(path.join(ctx.paths.bin, 'recovery.json')) ? '1' : '0']);
  if (output.trim() !== 'COOP_RECOVERY_VALID') throw Error('Candidate recovery protocol did not validate');
}

export function betaDoctor(ctx) {
  betaRecoveryDirectory(ctx);
  const reinstall = reinstallState(ctx);
  if (reinstall) return { channel: 'beta', build: ctx.build, manifestHash: ctx.manifestHash, product: reinstall.product,
    profile: ctx.paths.profile, recovery: ctx.paths.bin, status: 'reinstall-incomplete', pendingRecovery: true, healthy: false, readyForClientWork: false };
  const removal = removalState(ctx);
  if (removal) return { channel: 'beta', build: ctx.build, manifestHash: ctx.manifestHash, product: removal.product, profile: ctx.paths.profile, recovery: ctx.paths.bin,
    status: removal.operation === 'removed' ? 'removed' : 'removal-incomplete', pendingRecovery: removal.operation !== 'removed', healthy: false, readyForClientWork: false };
  if (fs.existsSync(transaction(ctx))) {
    const pending = json(transaction(ctx));
    if (pending.operation === 'update') {
      checkedUpdateState(ctx, pending);
      return { channel: 'beta', build: ctx.build, manifestHash: ctx.manifestHash, source: ctx.paths.source, profile: ctx.paths.profile,
        status: 'update-incomplete', pendingRecovery: true, healthy: false, readyForClientWork: false };
    }
  }
  verifyBetaSource(ctx, ctx.paths.source);
  const packages = readPackageInventory(ctx);
  const python = pythonPackages(ctx);
  let pi = null;
  try { pi = betaNodeEntry(ctx, 'pi', json(ctx.paths.manifest).pi.package, 'pi'); } catch { }
  return { channel: 'beta', product: fs.readFileSync(path.join(ctx.paths.source, 'VERSION'), 'utf8').trim(),
    build: ctx.build, manifestHash: ctx.manifestHash, source: ctx.paths.source, profile: ctx.paths.profile,
    node: ctx.tools.node.path, pi, paths: ctx.paths, packages, python, pendingRecovery: fs.existsSync(transaction(ctx)),
    healthScope: 'Source and package identity only; native and service qualification is separate', readyForClientWork: false,
    credentials: 'Separate beta sign-in required; stable credentials are never imported',
    integrations: 'Service integrations remain disabled until their scoped credential/storage qualification',
    nativePackageScripts: 'Disabled; native capabilities require separate qualification',
    healthy: Boolean(pi) && packages.every(p => p.matches) && python.every(p => p.matches) && !fs.existsSync(transaction(ctx)) };
}

/** Validate user-supplied launch scope before resource discovery or Pi startup.
 * Managed Coop arguments are constructed separately from this user vector. */
export function checkBetaLaunchInputs(ctx, cwd = process.cwd(), args = []) {
  const workspace = path.join(ctx.root, 'workspaces');
  assertOwnedPath(ctx, cwd);
  const contained = (base, value) => {
    const rel = path.relative(base, value);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  };
  if (!contained(workspace, cwd)) throw Error('Launch beta from its owned workspaces directory');
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw Error('Invalid beta launch arguments');
  if (['install', 'remove', 'uninstall', 'update', 'config', 'auth'].includes(args[0])) throw Error('Use the scoped beta lifecycle; raw Pi management is not qualified');
  const scopedPath = (value, base) => {
    if (!value || value.startsWith('~')) throw Error('Beta paths must resolve inside their owned scope');
    const resolved = path.resolve(cwd, value);
    assertOwnedPath(ctx, resolved);
    if (!contained(base, resolved)) throw Error('Launch path is outside the selected beta scope');
  };
  const flags = new Set(['--continue', '-c', '--resume', '-r', '--no-session', '--no-tools', '-nt',
    '--no-builtin-tools', '-nbt', '--print', '-p', '--help', '-h', '--version', '-v', '--verbose']);
  const values = new Set(['--name', '-n', '--thinking', '--tools', '-t', '--exclude-tools', '-xt', '--mode', '--tui-mode']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('@')) { scopedPath(arg.slice(1), workspace); continue; }
    if (!arg.startsWith('-')) continue;
    if (flags.has(arg)) continue;
    const value = args[i + 1];
    if (values.has(arg)) {
      if (value === undefined) throw Error('Beta option requires a value');
      i++; continue;
    }
    if (['--provider', '--model', '--models', '--session', '--fork', '--session-id', '--session-dir'].includes(arg)) {
      if (value === undefined) throw Error('Beta option requires a value');
      i++;
      if (arg === '--provider' && value !== 'openai-codex') throw Error('Beta uses the OpenAI subscription provider only');
      if (arg === '--model' || arg === '--models') {
        if (!value.split(',').every(model => /^(?:openai-codex\/)?gpt-[a-z0-9.-]+(?::[a-z]+)?$/i.test(model.trim()))) throw Error('Beta model selection must use explicit GPT models');
      }
      if (arg === '--session-id' && !/^[a-f0-9-]{8,36}$/i.test(value)) throw Error('Invalid beta session ID');
      if (arg === '--session-dir' || (['--session', '--fork'].includes(arg) && !/^[a-f0-9-]{8,36}$/i.test(value))) scopedPath(value, path.join(ctx.paths.agent, 'sessions'));
      continue;
    }
    throw Error('This beta launch option requires separate qualification');
  }
  return { channel: 'beta', workspace: cwd };
}

/** Pi 0.84 discovers user .agents skills and ancestor instructions even with
 * a private agent directory. Refuse external discovery from the beta home. */
export function checkBetaResourceRoots(ctx, cwd = process.cwd(), home = process.env.HOME || os.homedir()) {
  const inside = value => {
    const relative = path.relative(ctx.root, value);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  const inspect = value => {
    rejectLinks(value);
    if (!fs.existsSync(value)) return;
    if (!inside(value)) throw Error('Pi would discover resources outside the beta root');
    inspectOwnedTree(ctx, value);
  };
  inspect(path.join(home, '.agents', 'skills'));
  for (let dir = cwd;; dir = path.dirname(dir)) {
    for (const name of ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD', '.agents', '.coop']) inspect(path.join(dir, name));
    const git = path.join(dir, '.git');
    rejectLinks(git);
    if (fs.existsSync(git) && (!inside(git) || !fs.lstatSync(git).isDirectory())) throw Error('Linked or external Git metadata requires separate beta qualification');
    if (path.dirname(dir) === dir) break;
  }
  inspect(path.join(cwd, '.pi'));
  for (const name of ['extensions', 'skills', 'prompts', 'themes', 'SYSTEM.md', 'APPEND_SYSTEM.md']) inspect(path.join(ctx.paths.agent, name));
  const projectSettings = path.join(cwd, '.pi', 'settings.json');
  if (fs.existsSync(projectSettings)) {
    let settings;
    try { settings = json(projectSettings); } catch { throw Error('Invalid beta project settings'); }
    for (const key of ['packages', 'extensions', 'skills', 'prompts', 'themes']) if (settings[key]?.length) throw Error('Project resource overrides require beta qualification');
    if (settings.defaultProvider && settings.defaultProvider !== 'openai-codex') throw Error('Beta project must use OpenAI subscriptions');
    if (settings.defaultModel && !/^gpt-[a-z0-9.-]+$/i.test(settings.defaultModel)) throw Error('Beta project must use a GPT model');
    if (settings.sessionDir || settings.apiKeys) throw Error('Project session/auth overrides require beta qualification');
  }
  return { resourceRoots: 'contained' };
}

/** data-doc uses its exact private Python and original CLI after input preflight.
 * The PowerShell entry owns this process and its descendants in the same Job. */
function checkBetaCompanion(ctx, name, helper, cwd, args) {
  checkBetaLaunchInputs(ctx, cwd, []);
  verifyBetaSource(ctx, ctx.paths.source);
  noPending(ctx);
  inspectOwnedTree(ctx, ctx.paths.source);
  const environment = assertOwnedPath(ctx, path.join(ctx.paths.pipx, 'venvs', name));
  const executable = assertOwnedPath(ctx, path.join(environment, 'Scripts', 'python.exe'));
  if (!fs.existsSync(executable)) throw Error('Selected beta companion Python is missing; no global fallback');
  inspectOwnedTree(ctx, environment);
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw Error('Invalid beta companion arguments');
  return { executable, args: [...betaPythonFlags, path.join(ctx.paths.source, 'lib', helper),
    json(ctx.paths.manifest).python_tools[name], ...args] };
}

export function checkBetaDataDoc(ctx, cwd = process.cwd(), args = []) {
  return checkBetaCompanion(ctx, 'coop-data-doc', 'beta_data_doc.py', cwd, args);
}

export function checkBetaReview(ctx, operation, cwd = process.cwd(), args = []) {
  if (!['sql-review', 'dax-review'].includes(operation)) throw Error('Unknown beta review companion');
  return checkBetaCompanion(ctx, `coop-${operation}`, 'beta_review.py', cwd, [operation, ...args]);
}

/** The existing Windows suite runs under the same job/lease as other beta
 * commands. Validate discovery roots before its canonical parser reads them. */
export function checkBetaReviewSuite(ctx, cwd = process.cwd(), args = []) {
  checkBetaLaunchInputs(ctx, cwd, []);
  inspectOwnedTree(ctx, cwd);
  for (let dir = cwd;; dir = path.dirname(dir)) {
    const contract = path.join(dir, '.coop');
    if (fs.existsSync(contract)) inspectOwnedTree(ctx, contract);
    if (path.dirname(dir) === dir) break;
  }
  inspectOwnedTree(ctx, path.join(ctx.paths.profile, 'standards'));
  const vectors = Object.fromEntries(['sql-review', 'dax-review'].map(operation =>
    [`coop-${operation}`, checkBetaReview(ctx, operation, cwd)]));
  if (!args.includes('--skip-docs')) vectors['coop-data-doc'] = checkBetaDataDoc(ctx, cwd);
  return vectors;
}

/** Pure scope gate used after the canonical PowerShell parser resolves paths.
 * No report directory or backup is created until every input is validated. */
export function checkBetaReviewScope(ctx, cwd, outdir, inputs) {
  checkBetaLaunchInputs(ctx, cwd, []);
  if (typeof outdir !== 'string' || !Array.isArray(inputs) || !inputs.length) throw Error('Beta review requires explicit resolved scope');
  const ownedWorkspace = value => {
    if (typeof value !== 'string' || !value || value.startsWith('~')) throw Error('Invalid beta review path');
    checkBetaLaunchInputs(ctx, cwd, [`@${value}`]);
    const file = path.resolve(cwd, value);
    inspectOwnedTree(ctx, file);
    return file;
  };
  const output = ownedWorkspace(outdir);
  if (path.basename(output) !== 'reviews' || path.basename(path.dirname(output)) !== '.coop') throw Error('Beta review output must be the project review directory');
  const paths = inputs.map(ownedWorkspace);
  if (paths.some(file => !fs.existsSync(file))) throw Error('Beta review input is missing');
  return { output, paths };
}

export function backupBetaReview(ctx, cwd, outdir, inputs) {
  const scope = checkBetaReviewScope(ctx, cwd, outdir, inputs);
  if (fs.existsSync(scope.output)) {
    const backup = assertOwnedPath(ctx, path.join(cwd, '.backups', 'coop-review-suite', randomUUID()));
    inspectOwnedTree(ctx, backup);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    copy(ctx, scope.output, backup);
  }
  return scope;
}

/** Select changed files using only the recorded Git executable and owned local
 * metadata. A bad ref or redirected repository is a refusal, never full scope. */
export function betaReviewDiff(ctx, cwd, outdir, ref, inputs) {
  const scope = checkBetaReviewScope(ctx, cwd, outdir, inputs);
  if (typeof ref !== 'string' || !ref || ref.startsWith('-') || /[\0\r\n]/.test(ref)) throw Error('Invalid beta review Git reference');
  const paths = [], untrackedRoots = [];
  // Git for Windows accepts NUL, but rejects Node's Win32 device spelling.
  const env = { ...betaEnvironment(ctx), GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull };
  const gitRead = (directory, args) => {
    try { return execFileSync(ctx.tools.git.path, ['--no-optional-locks', '-c', 'core.fsmonitor=false',
      '-C', directory, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 30000,
      maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { throw Error('Beta review Git selection failed; scope was not broadened'); }
  };
  for (const input of scope.paths) {
    if (fs.statSync(input).isFile()) { paths.push(input); continue; }
    let gitRoot = null;
    for (let directory = input;; directory = path.dirname(directory)) {
      const metadata = path.join(directory, '.git');
      if (fs.existsSync(metadata)) {
        checkBetaLaunchInputs(ctx, directory, []);
        inspectOwnedTree(ctx, metadata);
        if (!fs.lstatSync(metadata).isDirectory()) throw Error('Linked beta review Git metadata is not qualified');
        for (const file of ['commondir', 'objects/info/alternates', 'objects/info/http-alternates']) {
          if (fs.existsSync(path.join(metadata, file))) throw Error('Redirected beta review Git metadata is not qualified');
        }
        gitRoot = directory; break;
      }
      if (path.dirname(directory) === directory) break;
    }
    if (!gitRoot) { paths.push(input); untrackedRoots.push(input); continue; }
    const config = gitRead(gitRoot, ['config', '--local', '--no-includes', '--null', '--list']);
    if (config.split('\0').some(entry => /^(include\.|includeif\.|core\.worktree\n|extensions\.worktreeconfig\n)/i.test(entry))) {
      throw Error('External beta review Git configuration is not qualified');
    }
    const revision = gitRead(input, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
    if (!/^[0-9a-f]{40}$/.test(revision)) throw Error('Beta review Git reference is not a commit');
    const names = gitRead(input, ['diff', '--no-ext-diff', '--no-textconv', '--relative', '--name-only', '-z', revision, '--']) +
      gitRead(input, ['ls-files', '-z', '--others', '--exclude-standard']);
    for (const name of names.split('\0').filter(Boolean)) {
      const file = path.resolve(input, name), relative = path.relative(input, file);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error('Beta Git returned an outside review path');
      checkBetaLaunchInputs(ctx, cwd, [`@${file}`]); inspectOwnedTree(ctx, file);
      if (fs.existsSync(file)) paths.push(file);
    }
  }
  return { paths: [...new Set(paths)], untrackedRoots };
}

/** Project setup keeps the existing Python implementations, with scope and
 * exact tool selection enforced before any discovery or write. */
export function checkBetaInit(ctx, cwd = process.cwd(), args = []) {
  checkBetaLaunchInputs(ctx, cwd, []);
  verifyBetaSource(ctx, ctx.paths.source);
  inspectOwnedTree(ctx, ctx.paths.source);
  let target = null, mode = 'wizard', ci = null, apply = false, yes = false;
  const seen = new Set(), archives = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      if (target !== null || arg.startsWith('~')) throw Error('Beta init accepts one owned target directory');
      target = arg; continue;
    }
    if (!['--template', '--migrate-legacy', '--ci', '--seed-docs', '--archive', '--apply', '--yes', '-y'].includes(arg)) throw Error('Unsupported beta init option');
    const key = arg === '-y' ? '--yes' : arg;
    if (key !== '--archive' && seen.has(key)) throw Error('Repeated beta init option');
    seen.add(key);
    if (['--template', '--migrate-legacy', '--ci', '--seed-docs'].includes(key)) {
      if (mode !== 'wizard') throw Error('Choose one beta init mode');
      mode = key.slice(2);
    }
    if (key === '--ci') {
      ci = args[++i];
      if (!['github', 'ado'].includes(ci)) throw Error('Beta init --ci requires github or ado');
    }
    if (key === '--archive') {
      const value = args[++i];
      if (!value || !/^\.pi[\\/]/.test(value) || value.split(/[\\/]/).some(part => part === '..')) throw Error('Beta init archive must be a project-relative .pi path');
      archives.push(value);
    }
    if (key === '--apply') apply = true;
    if (key === '--yes') yes = true;
  }
  if (mode !== 'migrate-legacy' && (apply || archives.length)) throw Error('Migration options require --migrate-legacy');
  target = path.resolve(cwd, target ?? '.');
  checkBetaLaunchInputs(ctx, target, []);
  if (fs.existsSync(target) && !fs.lstatSync(target).isDirectory()) throw Error('Beta init target must be a directory');
  inspectOwnedTree(ctx, target);
  let contractRoot = null;
  for (let dir = target;; dir = path.dirname(dir)) {
    for (const name of ['.coop', '.git']) {
      const entry = path.join(dir, name);
      rejectLinks(entry);
      if (!fs.existsSync(entry)) continue;
      checkBetaLaunchInputs(ctx, dir, []);
      inspectOwnedTree(ctx, entry);
      if (name === '.git' && !fs.lstatSync(entry).isDirectory()) throw Error('Beta init cannot use linked Git metadata');
      if (name === '.coop' && !contractRoot && fs.existsSync(path.join(entry, 'project.yml'))) contractRoot = dir;
    }
    if (path.dirname(dir) === dir) break;
  }
  const contract = path.join(target, '.coop', 'project.yml');
  const library = name => path.join(ctx.paths.source, 'lib', name);
  if (mode === 'seed-docs') {
    if (!fs.existsSync(contract)) throw Error('Beta lineage seeding requires a contract in the selected directory');
    return { target, mode, yes, vector: [...betaPythonFlags, library('_seeddocs.py'), contract] };
  }
  if (mode === 'ci') {
    if (!fs.existsSync(contract)) throw Error('Beta init --ci requires a contract in the selected directory');
    const output = path.join(target, ...(ci === 'github' ? ['.github', 'workflows'] : ['azure-pipelines']), 'coop-gates.yml');
    assertOwnedPath(ctx, output);
    if (fs.existsSync(output)) throw Error('Beta init will not overwrite an existing CI file');
    return { target, mode, vector: [...betaPythonFlags, library('_ciscaffold.py'), ci, contract, path.join(ctx.paths.source, 'config/defaults.yml'), target] };
  }
  if (mode === 'migrate-legacy') {
    if (!contractRoot) throw Error('Beta migration requires an owned project contract');
    for (const value of archives) assertOwnedPath(ctx, path.resolve(contractRoot, value));
    return { target, mode, vector: [...betaPythonFlags, library('project_health.py'), 'migrate', target,
      ...(apply ? ['--apply'] : []), ...(yes ? ['--yes'] : []), ...archives.flatMap(value => ['--archive', value])] };
  }
  if (fs.existsSync(contract)) throw Error('Beta init will not overwrite an existing project contract');
  return { target, mode, contract, vector: [...betaPythonFlags, library('init_wizard.py'), target, ...(mode === 'template' ? ['--template'] : [])] };
}

export async function initBeta(ctx, cwd, args) {
  const spec = checkBetaInit(ctx, cwd, args);
  const template = spec.mode === 'template';
  const env = betaEnvironment(ctx);
  if (spec.mode === 'wizard') {
    const executable = assertOwnedPath(ctx, path.join(ctx.paths.pipx, 'venvs', 'coop-data-doc', 'Scripts', 'python.exe'));
    if (fs.existsSync(executable)) {
      const companion = checkBetaDataDoc(ctx, spec.target);
      env.COOP_BETA_DATA_DOC_COMMAND = JSON.stringify([companion.executable, ...companion.args]);
    }
  }
  const result = spawnSync(ctx.tools.python.path, spec.vector, { cwd: fs.existsSync(spec.target) ? spec.target : cwd,
    env, stdio: template || spec.mode === 'seed-docs' ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8', windowsHide: true });
  if (result.error) throw Error('Selected beta Python could not run project setup');
  if (result.status !== 0) return spec.mode === 'seed-docs' ? 1 : result.status ?? 1;
  if (spec.mode === 'seed-docs') {
    const companion = checkBetaDataDoc(ctx, spec.target, ['config-set', '--config', path.join(spec.target, 'coop-data-doc.yml'), '--from-json', '-']);
    if (!spec.yes) {
      const answer = await new Promise(resolve => {
        const input = createInterface({ input: process.stdin, terminal: false });
        let settled = false;
        const finish = value => { if (settled) return; settled = true; input.close(); resolve(value); };
        input.once('line', finish); input.once('close', () => finish(null));
        process.stderr.write('Write these repositories into the owned data-doc configuration? [y/N] ');
      });
      if (typeof answer !== 'string' || !/^y(?:es)?$/i.test(answer.trim())) {
        process.stderr.write('Lineage seeding cancelled; configuration unchanged.\n');
        return 1;
      }
    }
    const applied = spawnSync(companion.executable, companion.args, { cwd: spec.target, env: betaEnvironment(ctx),
      input: result.stdout, stdio: ['pipe', 'inherit', 'inherit'], encoding: 'utf8', windowsHide: true });
    if (applied.error) throw Error('Selected beta data-doc could not apply the lineage seed');
    return applied.status ?? 1;
  }
  if (template) {
    inspectOwnedTree(ctx, spec.target);
    mkdir(ctx, path.dirname(spec.contract));
    fs.writeFileSync(assertOwnedPath(ctx, spec.contract), result.stdout, { flag: 'wx' });
    console.log(`Wrote ${spec.contract}`);
  }
  return 0;
}

/** Standalone profile and budget readers retain their Python interfaces while
 * sharing beta path validation, executable selection and process ownership. */
export function checkBetaProfileCommand(ctx, operation, cwd = process.cwd(), args = []) {
  if (!['profile', 'context-budget'].includes(operation)) throw Error('Unknown beta profile command');
  checkBetaLaunchInputs(ctx, cwd, []);
  verifyBetaSource(ctx, ctx.paths.source);
  inspectOwnedTree(ctx, ctx.paths.source);
  const allowed = new Set(operation === 'profile' ? ['--edit', '--reset', '--json', '--help', '-h'] : ['--json', '--measure', '--yes', '--help', '-h']);
  if (args.some(arg => !allowed.has(arg)) || new Set(args).size !== args.length || (args.includes('--edit') && args.includes('--reset'))) throw Error('Unsupported or conflicting beta profile options');
  const user = path.join(ctx.paths.profile, 'user.json');
  inspectOwnedTree(ctx, user);
  if (operation === 'profile' && args.includes('--edit') && fs.existsSync(user)) {
    let current;
    try { current = json(user); } catch { throw Error('Invalid beta user profile; repair it before editing'); }
    if (!current || typeof current !== 'object' || Array.isArray(current) || (current.communication !== undefined && (!current.communication || typeof current.communication !== 'object' || Array.isArray(current.communication)))) throw Error('Invalid beta user profile; repair it before editing');
    if ([current.name, current.communication?.preset, current.communication?.custom_instructions].some(value => value !== undefined && typeof value !== 'string')) throw Error('Invalid beta user profile; repair it before editing');
  }
  if (operation === 'context-budget') for (let dir = cwd;; dir = path.dirname(dir)) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const file = path.join(dir, name);
      rejectLinks(file);
      if (fs.existsSync(file)) inspectOwnedTree(ctx, file);
    }
    if (path.dirname(dir) === dir) break;
  }
  return [...betaPythonFlags, path.join(ctx.paths.source, 'scripts', operation === 'profile' ? 'onboard.py' : 'context-budget.py'), ...(operation === 'profile' ? ['profile'] : []), ...args];
}

/** Offline Support Center uses the selected tools and owned project/profile
 * state. Validate every destination before collecting diagnostics or writing. */
export function checkBetaSupport(ctx, cwd = process.cwd(), args = []) {
  checkBetaLaunchInputs(ctx, cwd, []);
  inspectOwnedTree(ctx, cwd);
  for (let dir = cwd;; dir = path.dirname(dir)) {
    const contract = path.join(dir, '.coop');
    if (fs.existsSync(contract)) inspectOwnedTree(ctx, contract);
    const gitPath = path.join(dir, '.git');
    rejectLinks(gitPath);
    if (fs.existsSync(gitPath) && (!fs.lstatSync(gitPath).isDirectory() || !gitPath.startsWith(`${ctx.root}${path.sep}`))) throw Error('Support cannot inspect linked or external Git metadata');
    if (path.dirname(dir) === dir) break;
  }
  const support = path.join(ctx.paths.profile, 'support');
  for (const target of [support, path.join(ctx.paths.profile, 'standards'), path.join(ctx.paths.profile, 'config')]) inspectOwnedTree(ctx, target);
  const config = path.join(ctx.paths.profile, 'config');
  let settings = null;
  if (fs.existsSync(config)) {
    try { settings = json(config); } catch { throw Error('Invalid beta support configuration'); }
  }
  for (const repo of settings?.knowledge?.repos || []) {
    if (typeof repo?.local_path !== 'string') continue;
    inspectOwnedTree(ctx, repo.local_path);
  }
  let exportPath = null;
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!['--json', '--incident', '--export'].includes(arg) || seen.has(arg)) throw Error('Unsupported or repeated beta support option');
    seen.add(arg);
    if (arg === '--export') {
      const value = args[++i];
      if (!value || value.startsWith('-') || value.startsWith('~')) throw Error('Beta support export requires an owned path');
      exportPath = assertOwnedPath(ctx, path.resolve(cwd, value));
      const inside = base => { const rel = path.relative(base, exportPath); return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
      if (!inside(path.join(ctx.root, 'workspaces')) && !inside(path.join(support, 'bundles'))) throw Error('Beta support export must be inside workspaces or support/bundles');
      if (fs.existsSync(exportPath)) throw Error('Beta support export will not overwrite an existing file');
    }
  }
  const reviewerBins = Object.fromEntries(['sql', 'dax'].map(domain => {
    const command = assertOwnedPath(ctx, path.join(ctx.paths.pipx, 'venvs', `coop-${domain}-review`, 'Scripts', `coop-${domain}-review.exe`));
    return [domain, { command, args: [] }];
  }));
  return { exportPath, standardsOptions: { cwd, gitExecutable: ctx.tools.git.path, reviewerBins } };
}

export function checkBetaLaunch(ctx, cwd = process.cwd(), args = []) {
  checkBetaLaunchInputs(ctx, cwd, args);
  checkBetaResourceRoots(ctx, cwd);
  const report = betaDoctor(ctx);
  if (!report.healthy) throw Error('Beta package identity or recovery check failed; run beta doctor');
  const settings = json(path.join(ctx.paths.agent, 'settings.json'));
  if (settings.defaultProvider !== 'openai-codex' || !settings.defaultModel?.startsWith('gpt-')) throw Error('Beta requires an OpenAI subscription GPT model');
  const manifest = json(ctx.paths.manifest);
  const entries = settings.packages;
  if (!Array.isArray(entries) || entries.length !== Object.keys(manifest.extensions).length) throw Error('Beta extension selection changed; qualification required');
  const seen = new Set();
  for (const entry of entries) {
    const name = Object.keys(manifest.extensions).find(name => entry.source === `npm:${name}@${manifest.extensions[name]}`);
    if (!name || seen.has(name)) throw Error('Unknown or duplicate beta extension selection');
    seen.add(name);
    if (['pi-web-access', 'context-mode'].includes(name) && ['extensions', 'skills', 'prompts', 'themes'].some(k => !Array.isArray(entry[k]) || entry[k].length)) throw Error('Unqualified beta extension is enabled');
  }
  for (const key of ['extensions', 'skills', 'prompts', 'themes']) {
    if (settings[key]?.length) throw Error('Additional beta resource paths need qualification');
  }
  const mcp = json(path.join(ctx.paths.agent, 'mcp.json'));
  if (Object.keys(mcp.mcpServers || {}).length) throw Error('Beta MCP integrations have not been qualified');
  if (['fab.exe', 'fab.cmd', 'fab.ps1', 'fab'].some(name => fs.existsSync(path.join(ctx.paths.pipxBin, name)))) throw Error('Unqualified Fabric CLI launcher is present');
  return { channel: 'beta', build: ctx.build, ready: true };
}

/** Update is code-only at B1's approved fixed package set. Package changes are
 * refused before staging. The previous source remains a full independent clone. */
function sameInstallation(ctx, record) {
  return /^[0-9a-f]{40}$/.test(record?.build || '') && JSON.stringify(record) === JSON.stringify({ ...ctx, build: record.build });
}
function checkedSource(ctx, directory, build) {
  inspectOwnedTree(ctx, directory);
  if (git(ctx, directory, ['rev-parse', 'HEAD']) !== build || git(ctx, directory, ['status', '--porcelain', '--untracked-files=all', '--ignored'])) throw Error('Retained or current beta source changed; recovery refused');
  if (hash(fs.readFileSync(path.join(directory, 'config/windows-beta-manifest.json'))) !== ctx.manifestHash) throw Error('Retained beta manifest differs');
}
function retentionPath(ctx) { return path.join(ctx.root, 'retained-sources', randomUUID()); }
function validateRetentionPath(ctx, file) {
  assertOwnedPath(ctx, file);
  if (path.dirname(file) !== path.join(ctx.root, 'retained-sources') || !/^[0-9a-f-]{36}$/.test(path.basename(file))) throw Error('Invalid retained beta source path');
}
function checkedUpdateState(ctx, pending) {
  const { before, after } = pending;
  if (!sameInstallation(ctx, before)) throw Error('Invalid beta rollback receipt');
  if (!sameInstallation(ctx, after) || ![before.build, after.build].includes(ctx.build)) throw Error('Invalid beta update recovery identity');
  const priorPrevious = pending.priorPrevious || null, priorArchive = pending.priorArchive || null;
  if (Boolean(priorPrevious) !== Boolean(priorArchive) || (priorPrevious && !sameInstallation(ctx, priorPrevious))) throw Error('Invalid older beta recovery identity');
  if (priorArchive) validateRetentionPath(ctx, priorArchive);
  if (pending.recoveryBuild !== undefined && ![before.build, after.build].includes(pending.recoveryBuild)) throw Error('Invalid beta recovery build');
  return { before, after, priorPrevious, priorArchive };
}
function retainSource(ctx, source, destination = retentionPath(ctx), record = null) {
  inspectOwnedTree(ctx, source);
  validateRetentionPath(ctx, destination);
  if (fs.existsSync(destination)) throw Error('Retained source destination already exists');
  mkdir(ctx, path.dirname(destination));
  if (record) writeJson(ctx, `${destination}.json`, record);
  fs.renameSync(assertOwnedPath(ctx, source), assertOwnedPath(ctx, destination));
  return destination;
}
export function updateBeta(ctx, source, build, options = {}) {
  verifyBetaSource(ctx, ctx.paths.source); noPending(ctx);
  betaRecoveryDirectory(ctx);
  eligibleBuild(ctx, source, build, options);
  if (build === ctx.build) return { changed: false, build };
  const staged = path.join(ctx.root, 'candidate-source');
  const previous = path.join(ctx.root, 'previous-source');
  if (fs.existsSync(staged)) throw Error('Unexpected beta staging exists; preserve it before update');
  let priorPrevious = null, priorArchive = null;
  if (fs.existsSync(previous)) {
    priorPrevious = json(path.join(ctx.root, 'previous-build.json'));
    if (!sameInstallation(ctx, priorPrevious)) throw Error('Invalid previous beta identity');
    checkedSource(ctx, previous, priorPrevious.build);
    priorArchive = retentionPath(ctx);
  } else if (fs.existsSync(path.join(ctx.root, 'previous-build.json'))) throw Error('Previous beta source is missing; preserve recovery state');
  checkedSource(ctx, ctx.paths.source, ctx.build);
  const next = { ...ctx, build };
  // Journal before cloning, so even an incomplete clone has a recovery owner.
  writeJson(ctx, transaction(ctx), { operation: 'update', before: ctx, after: next, priorPrevious, priorArchive, recoveryBuild: ctx.build });
  try {
    cloneBuild(ctx, source, build, staged);
    checkedSource(ctx, staged, build);
    writeBetaRecoveryVersion(ctx, staged, build);
    if (priorPrevious) retainSource(ctx, previous, priorArchive, priorPrevious);
    fs.renameSync(ctx.paths.source, assertOwnedPath(ctx, previous));
    fs.renameSync(staged, ctx.paths.source);
    writeJson(ctx, marker(ctx), next);
    verifyBetaSource(next, next.paths.source);
    writeJson(next, path.join(ctx.root, 'previous-build.json'), ctx);
    fs.unlinkSync(assertOwnedPath(ctx, transaction(ctx)));
  } catch { throw Error('Beta update did not complete. Previous source is retained; run beta rollback'); }
  return { changed: true, build, previous: ctx.build };
}

export function rollbackBeta(ctx) {
  const pending = fs.existsSync(transaction(ctx)) ? json(transaction(ctx)) : null;
  if (pending?.operation === 'reinstall') {
    const state = reinstallState(ctx);
    betaRecoveryDirectory(ctx);
    const targets = [ctx.paths.source, path.join(ctx.root, 'reinstall-source')];
    for (const target of targets) inspectOwnedTree(ctx, target);
    // Keep incomplete clones and any user edits. Never recursively delete a
    // failed reinstall just to recover its prior removed state.
    const retained = path.join(ctx.root, 'retained-reinstalls', randomUUID());
    mkdir(ctx, retained);
    for (const target of targets) if (fs.existsSync(target)) fs.renameSync(assertOwnedPath(ctx, target), assertOwnedPath(ctx, path.join(retained, path.basename(target))));
    writeJson(ctx, removedMarker(ctx), { operation: 'removed', before: ctx, product: state.product });
    fs.unlinkSync(assertOwnedPath(ctx, transaction(ctx)));
    return { build: ctx.build, status: 'removed', retained, userData: 'preserved' };
  }
  if (pending?.operation === 'sync') {
    if (JSON.stringify(pending.before) !== JSON.stringify(ctx)) throw Error('Invalid package recovery identity');
    const expected = [path.join(ctx.root, 'runtime'), path.join(ctx.paths.agent, 'npm')];
    if (!Array.isArray(pending.snapshots) || pending.snapshots.length !== expected.length) throw Error('Invalid package recovery receipt');
    for (let i = 0; i < expected.length; i++) {
      const item = pending.snapshots[i];
      if (item.original !== expected[i] || item.saved !== path.join(ctx.root, 'package-rollback', String(i))) throw Error('Invalid package recovery path');
      inspectOwnedTree(ctx, item.original); inspectOwnedTree(ctx, item.saved);
      if (item.existed && !fs.existsSync(item.saved)) throw Error('Package recovery data is missing');
    }
    for (const item of pending.snapshots) { remove(ctx, item.original); if (item.existed) copy(ctx, item.saved, item.original); }
    fs.unlinkSync(assertOwnedPath(ctx, transaction(ctx)));
    remove(ctx, path.join(ctx.root, 'package-rollback'));
    return { build: ctx.build, packages: 'restored', userData: 'preserved' };
  }
  if (pending && pending.operation !== 'update') throw Error('Unknown beta recovery operation; preserve the installation');
  // Validate identity before trusting any path in a recovery receipt.
  const { before, after, priorPrevious, priorArchive } = checkedUpdateState(ctx, pending || { before: json(path.join(ctx.root, 'previous-build.json')), after: ctx });
  verifyRecoveryVersion(ctx, before.build);
  const previous = path.join(ctx.root, 'previous-source');
  const staged = path.join(ctx.root, 'candidate-source');
  let activeBuild = null, previousBuild = null;
  if (fs.existsSync(ctx.paths.source)) {
    activeBuild = git(ctx, ctx.paths.source, ['rev-parse', 'HEAD']);
    if (![before.build, after.build].includes(activeBuild)) throw Error('Unexpected current beta revision; recovery refused');
    checkedSource(ctx, ctx.paths.source, activeBuild);
  }
  if (fs.existsSync(previous)) {
    previousBuild = git(ctx, previous, ['rev-parse', 'HEAD']);
    if (![before.build, priorPrevious?.build].includes(previousBuild)) throw Error('Unexpected previous beta revision; recovery refused');
    checkedSource(ctx, previous, previousBuild);
  }
  if (priorArchive && fs.existsSync(priorArchive)) checkedSource(ctx, priorArchive, priorPrevious.build);
  inspectOwnedTree(ctx, staged);
  if (activeBuild !== before.build && previousBuild !== before.build) throw Error('Previous beta source is unavailable');
  // A normal rollback gets the same durable journal as an interrupted update.
  // If killed after either rename, a second rollback resumes from these roots.
  if (!pending) writeJson(ctx, transaction(ctx), { operation: 'update', before, after, priorPrevious: null, priorArchive: null, recoveryBuild: ctx.build });
  if (activeBuild !== before.build) {
    if (activeBuild) retainSource(ctx, ctx.paths.source, undefined, after);
    fs.renameSync(previous, assertOwnedPath(ctx, ctx.paths.source));
    previousBuild = null;
  }
  if (fs.existsSync(staged)) retainSource(ctx, staged); // preserve even an incomplete/dirty clone
  if (priorPrevious) {
    if (!previousBuild) {
      if (!fs.existsSync(priorArchive)) throw Error('Older beta source is unavailable; recovery remains pending');
      fs.renameSync(priorArchive, assertOwnedPath(ctx, previous));
    }
    writeJson(ctx, path.join(ctx.root, 'previous-build.json'), priorPrevious);
  } else if (fs.existsSync(path.join(ctx.root, 'previous-build.json'))) fs.unlinkSync(assertOwnedPath(ctx, path.join(ctx.root, 'previous-build.json')));
  writeJson(ctx, marker(ctx), before);
  verifyBetaSource(before, before.paths.source);
  fs.unlinkSync(assertOwnedPath(ctx, transaction(ctx)));
  return { build: before.build, userData: 'preserved' };
}

function removalState(ctx) {
  if (fs.existsSync(removedMarker(ctx))) {
    const receipt = json(removedMarker(ctx));
    if (receipt.operation !== 'removed' || JSON.stringify(receipt.before) !== JSON.stringify(ctx)) throw Error('Invalid beta removal receipt');
    for (const target of removalTargets(ctx)) {
      assertOwnedPath(ctx, target);
      if (fs.existsSync(target)) throw Error('Application files appeared after beta removal; preserve them before recovery');
    }
    if (fs.existsSync(transaction(ctx))) {
      const pending = json(transaction(ctx));
      if (pending.operation !== 'remove' || JSON.stringify(pending.before) !== JSON.stringify(ctx)) throw Error('Conflicting beta removal transaction');
    }
    return receipt;
  }
  if (fs.existsSync(transaction(ctx))) {
    const receipt = json(transaction(ctx));
    if (receipt.operation !== 'remove') return null;
    if (JSON.stringify(receipt.before) !== JSON.stringify(ctx) || !receipt.sourceFiles || typeof receipt.sourceFiles !== 'object') throw Error('Invalid beta removal transaction');
    return receipt;
  }
  return null;
}
function removalTargets(ctx) {
  // Source goes last. The immutable recovery helpers remain outside all targets.
  return [path.join(ctx.root, 'runtime'), path.join(ctx.paths.agent, 'npm'),
    ...['candidate-source', 'previous-source', 'retired-source', 'source'].map(name => path.join(ctx.root, name))];
}
function sourceRemovalFiles(ctx) {
  const result = {};
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else result[path.relative(ctx.root, file)] = hash(fs.readFileSync(file));
    }
  };
  for (const name of ['candidate-source', 'previous-source', 'retired-source', 'source']) {
    const dir = path.join(ctx.root, name);
    if (fs.existsSync(dir)) visit(dir);
  }
  return result;
}
export function removeBeta(ctx) {
  let state = removalState(ctx);
  if (state?.operation === 'removed') {
    // Completion may have been interrupted after writing the receipt but before
    // clearing its journal. Only the matching removal journal can be retired.
    if (fs.existsSync(transaction(ctx))) fs.unlinkSync(assertOwnedPath(ctx, transaction(ctx)));
    return { removed: true, alreadyRemoved: true, preserved: ctx.paths.profile, recovery: ctx.paths.bin };
  }
  const targets = removalTargets(ctx);
  if (!state) { verifyBetaSource(ctx, ctx.paths.source); noPending(ctx); }
  for (const target of targets) inspectOwnedTree(ctx, target);
  const remaining = sourceRemovalFiles(ctx);
  if (state) {
    for (const [name, digest] of Object.entries(remaining)) if (state.sourceFiles[name] !== digest) throw Error('Source changed during partial removal; preserve it before retry');
  } else {
    for (const name of ['candidate-source', 'previous-source', 'retired-source', 'source']) {
      const dir = path.join(ctx.root, name);
      if (fs.existsSync(dir) && git(ctx, dir, ['status', '--porcelain', '--untracked-files=all', '--ignored'])) throw Error('Beta source contains changed or unowned files; removal refused');
    }
    state = { operation: 'remove', before: ctx, sourceFiles: remaining,
      product: fs.readFileSync(path.join(ctx.paths.source, 'VERSION'), 'utf8').trim() };
    writeJson(ctx, transaction(ctx), state);
  }
  try {
    for (const target of targets) remove(ctx, target);
    writeJson(ctx, removedMarker(ctx), { operation: 'removed', before: ctx, product: state.product });
    fs.unlinkSync(assertOwnedPath(ctx, transaction(ctx)));
  } catch { throw Error('Beta removal is incomplete; release owned file locks and retry beta uninstall. Profile and recovery entry are preserved.'); }
  return { removed: targets, preserved: ctx.paths.profile, recovery: ctx.paths.bin };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, root, ...args] = process.argv.slice(2);
    if (operation === 'plan-json') {
      if (args.length) throw Error('Usage: plan-json REQUEST.json');
      const context = planInstall(json(root));
      const environment = betaEnvironment(context);
      environment.COOP_BETA_PLANNED_HOME = os.homedir();
      console.log(shellJson({ context, environment }));
      process.exit(0);
    }
    if (operation === 'claim-plan') {
      if (args.length) throw Error('Usage: claim-plan REQUEST.json');
      claimInstall(json(root));
      process.exit(0);
    }
    if (operation === 'install-plan') {
      if (args.length) throw Error('Usage: install-plan REQUEST.json');
      const ctx = installBeta(json(root));
      console.log(JSON.stringify({ root: ctx.root, build: ctx.build, next: 'sync', status: 'source prepared; packages pending' }));
      process.exit(0);
    }
    const ctx = loadBetaContext(root);
    if (operation === 'review-vectors') {
      console.log(shellJson(checkBetaReviewSuite(ctx, process.cwd(), args)));
      process.exit(0);
    }
    if (operation === 'review-scope' || operation === 'review-backup') {
      const [outdir, ...inputs] = args;
      const check = operation === 'review-backup' ? backupBetaReview : checkBetaReviewScope;
      check(ctx, process.cwd(), outdir, inputs);
      process.exit(0);
    }
    if (operation === 'review-diff') {
      const [outdir, ref, ...inputs] = args;
      console.log(shellJson(betaReviewDiff(ctx, process.cwd(), outdir, ref, inputs)));
      process.exit(0);
    }
    if (operation === 'review') {
      checkBetaLaunchInputs(ctx, process.cwd(), []);
      verifyBetaSource(ctx, ctx.paths.source); noPending(ctx);
      const env = betaEnvironment(ctx);
      const helper = path.join(ctx.paths.source, 'lib', 'review-suite.ps1');
      const encoded = Buffer.from(JSON.stringify(args)).toString('base64');
      const command = `$ProgressPreference = 'SilentlyContinue'; $v = [string[]]([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json); & '${helper.replaceAll("'", "''")}' @v; exit $LASTEXITCODE`;
      const child = spawnSync(path.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
        { env, stdio: 'inherit', windowsHide: true });
      if (child.error) throw Error('Selected beta review suite could not start');
      process.exit(child.status ?? 1);
    }
    if (operation === 'data-doc') {
      const vector = checkBetaDataDoc(ctx, process.cwd(), args);
      const child = spawnSync(vector.executable, vector.args, { cwd: process.cwd(), env: betaEnvironment(ctx), stdio: 'inherit', windowsHide: true });
      if (child.error) throw Error('Selected beta data-doc could not start');
      process.exit(child.status ?? 1);
    }
    if (['sql-review', 'dax-review'].includes(operation)) {
      const vector = checkBetaReview(ctx, operation, process.cwd(), args);
      const child = spawnSync(vector.executable, vector.args, { env: betaEnvironment(ctx), stdio: 'inherit', windowsHide: true });
      if (child.error) throw Error('Selected beta review companion could not start');
      process.exit(child.status ?? 1);
    }
    if (operation === 'init') process.exit(await initBeta(ctx, process.cwd(), args));
    if (operation === 'profile' || operation === 'context-budget') {
      const vector = checkBetaProfileCommand(ctx, operation, process.cwd(), args);
      const child = spawnSync(ctx.tools.python.path, vector, { cwd: process.cwd(), env: betaEnvironment(ctx), stdio: 'inherit', windowsHide: true });
      if (child.error) throw Error('Selected beta Python command could not start');
      process.exit(child.status ?? 1);
    }
    let result;
    if (operation === 'doctor' && args.length === 0) result = betaDoctor(ctx);
    else if (operation === 'launch-check') result = checkBetaLaunch(ctx, process.cwd(), args);
    else if (operation === 'sync' && args.length === 0) result = syncBeta(ctx);
    else if (operation === 'update' && args.length === 4 && args[0] === '--build' && args[2] === '--source') result = updateBeta(ctx, args[3], args[1]);
    else if (operation === 'rollback' && args.length === 0) result = rollbackBeta(ctx);
    else if (operation === 'uninstall' && args.length === 0) result = removeBeta(ctx);
    else throw Error('Unsupported beta operation or arguments');
    if (operation !== 'launch-check') console.log(JSON.stringify(result, null, 2));
    if (operation === 'doctor' && !result.healthy) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error && !('stderr' in error) ? error.message : 'Beta lifecycle failed');
    process.exitCode = 1;
  }
}

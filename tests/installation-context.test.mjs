import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planBetaContext, claimBetaRoot, loadBetaContext, assertOwnedPath, betaEnvironment, betaNodeEntry } from '../lib/installation-context.mjs';
import { inspectOwnedTree } from '../lib/beta-lifecycle.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-beta-context-'));
const base = path.join(scratch, 'Beta space Ω');
const stable = path.join(scratch, 'stable');
fs.mkdirSync(stable);
fs.writeFileSync(path.join(stable, 'sentinel'), 'stable must remain unchanged');
const tools = {};
for (const name of ['node', 'python', 'fabricPython', 'git']) {
  tools[name] = path.join(scratch, `${name}.exe`);
  fs.writeFileSync(tools[name], `inert ${name} fixture`);
}
const manifest = Buffer.from('{"schema_version":1,"pi":{"package":"@earendil-works/pi-coding-agent","version":"0.84.3"}}');
const input = { root: base, build: 'a'.repeat(40), tools, manifest, protectedRoots: [stable] };
const ctx = planBetaContext(input);
assert.equal(fs.existsSync(base), false, 'planning and validation do not create directories');
assert.equal(ctx.channel, 'beta');
assert.equal(ctx.paths.profile, path.join(base, 'profile'));
assert.equal(ctx.paths.agent, path.join(base, 'profile', 'agent'));
assert.equal(ctx.paths.pipx, path.join(base, 'runtime', 'pipx'));
for (const root of ['relative', path.parse(base).root, stable, path.join(stable, 'nested'), scratch]) {
  assert.throws(() => planBetaContext({ ...input, root }), /absolute|root|overlap/i);
}
assert.throws(() => planBetaContext({ ...input, build: 'main' }), /40.*SHA/i);
assert.throws(() => planBetaContext({ ...input, tools: { ...tools, node: path.join(scratch, 'missing') } }), /tool/i);
assert.throws(() => planBetaContext({ ...input, manifest: Buffer.from('{}') }), /manifest/i);
claimBetaRoot(ctx);
assert.equal(loadBetaContext(base).build, ctx.build);
assert.throws(() => claimBetaRoot(ctx), /owned|exist/i);
assert.throws(() => assertOwnedPath(ctx, stable), /outside/i);
assert.throws(() => assertOwnedPath(ctx, base), /root/i);
assert.equal(assertOwnedPath(ctx, path.join(base, 'profile', 'sessions')), path.join(base, 'profile', 'sessions'));
const aliases = path.join(base, 'aliases');
fs.mkdirSync(aliases);
const alias = path.join(aliases, 'outside-canary');
fs.linkSync(path.join(stable, 'sentinel'), alias);
assert.throws(() => assertOwnedPath(ctx, alias), /Hardlink/);
assert.throws(() => inspectOwnedTree(ctx, aliases), /Hardlink/);
fs.unlinkSync(alias); // remove only the disposable alias, never the outside original
assert.equal(fs.readFileSync(path.join(stable, 'sentinel'), 'utf8'), 'stable must remain unchanged');
// Shared read-only tool selection does not claim ownership or forbid hardlinks.
const toolAlias = path.join(scratch, 'node-readonly-alias.exe');
fs.linkSync(tools.node, toolAlias);
assert.equal(loadBetaContext(base).tools.node.path, tools.node);
fs.unlinkSync(toolAlias);
const env = betaEnvironment(ctx, { HOME: 'keep-real-home', USERPROFILE: 'keep-real-user', COOP_DIR: 'poison', PI_CODING_AGENT_DIR: 'poison', COOP_FABRIC_MCP_TOKEN: 'must-not-inherit', OPENAI_API_KEY: 'must-not-inherit', PATH: 'poison' });
assert.equal(env.HOME, ctx.paths.profile);
assert.equal(env.USERPROFILE, ctx.paths.profile);
assert.equal(env.APPDATA, path.join(ctx.paths.profile, 'AppData', 'Roaming'));
assert.equal(env.LOCALAPPDATA, path.join(ctx.paths.profile, 'AppData', 'Local'));
if (process.platform === 'win32') {
  assert.equal(env.HOMEDRIVE, path.parse(ctx.paths.profile).root.slice(0, 2));
  assert.equal(env.HOMEPATH, ctx.paths.profile.slice(2));
}
assert.equal(env.COOP_PROFILE_ROOT, ctx.paths.profile);
assert.equal(env.PI_CODING_AGENT_DIR, ctx.paths.agent);
assert.equal(env.COOP_DIR, undefined);
assert.equal(env.PI_OFFLINE, '1');
assert.equal(env.PI_SKIP_VERSION_CHECK, '1');
assert.equal(env.COOP_NO_MODEL_LOGIN, '1');
assert.equal(env.COOP_FABRIC_MCP_TOKEN, undefined);
assert.equal(env.OPENAI_API_KEY, undefined);
assert.equal(env.PATH.includes('poison'), false);
assert.equal(env.AZURE_CONFIG_DIR, path.join(ctx.paths.profile, 'azure'));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'npm_config_prefix', 'npm_config_cache', 'npm_config_userconfig', 'npm_config_globalconfig', 'PIPX_HOME', 'PIPX_BIN_DIR', 'PIPX_MAN_DIR', 'PIPX_SHARED_LIBS', 'PIP_CACHE_DIR', 'TEMP', 'JITI_FS_CACHE', 'GIT_CONFIG_GLOBAL']) {
  assert.equal(assertOwnedPath(ctx, env[key]), path.resolve(env[key]), `${key} must remain beta-owned`);
}
const childCode = `import os from 'node:os'; import { loadBetaContext } from ${JSON.stringify(new URL('../lib/installation-context.mjs', import.meta.url).href)}; console.log(JSON.stringify({ home: os.homedir(), build: loadBetaContext(process.argv[1]).build }));`;
const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode, base],
  { env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
assert.equal(child.status, 0, child.stderr);
assert.deepEqual(JSON.parse(child.stdout), { home: ctx.paths.profile, build: ctx.build });
assert.equal(env.PIPX_DISABLE_SHARED_LIBS_AUTO_UPGRADE, '1');
assert.equal(env.PIP_ONLY_BINARY, ':all:');
assert.equal(env.PYTHONUTF8, '1', 'Python subprocesses must support Unicode beta roots');
const marker = path.join(base, '.coop-beta.json');
const original = fs.readFileSync(marker);
const markerAlias = path.join(scratch, 'marker-alias.json');
fs.linkSync(marker, markerAlias);
assert.throws(() => loadBetaContext(base), /Hardlink/);
assert.deepEqual(fs.readFileSync(markerAlias), original);
fs.unlinkSync(markerAlias);
const poisoned = JSON.parse(original);
poisoned.paths.agent = stable;
fs.writeFileSync(marker, JSON.stringify(poisoned));
assert.throws(() => loadBetaContext(base), /derived|identity/i);
fs.writeFileSync(marker, original);
fs.appendFileSync(tools.node, 'changed');
assert.throws(() => loadBetaContext(base), /tool.*changed/i);
fs.writeFileSync(tools.node, 'inert node fixture');

// Windows junctions need no symlink privilege; exercise real reparse resolution.
const junction = path.join(base, 'runtime');
fs.symlinkSync(stable, junction, process.platform === 'win32' ? 'junction' : 'dir');
assert.throws(() => loadBetaContext(base), /link|reparse/i);
assert.throws(() => assertOwnedPath(ctx, path.join(junction, 'victim')), /link|reparse/i);
fs.unlinkSync(junction);
fs.mkdirSync(path.dirname(ctx.paths.manifest), { recursive: true });
fs.writeFileSync(ctx.paths.manifest, manifest);
const piName = '@earendil-works/pi-coding-agent';
assert.throws(() => betaNodeEntry(ctx, 'pi', piName, 'pi'), /missing.*no global fallback/);
const packageRoot = path.join(ctx.paths.npm, 'node_modules', piName);
fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
const packageFile = path.join(packageRoot, 'package.json');
fs.writeFileSync(packageFile, JSON.stringify({ name: piName, version: '0.84.3', bin: { pi: 'dist/cli.js' } }));
fs.writeFileSync(path.join(packageRoot, 'dist', 'cli.js'), '// inert executable fixture');
assert.equal(betaNodeEntry(ctx, 'pi', piName, 'pi'), path.join(packageRoot, 'dist', 'cli.js'));
fs.writeFileSync(packageFile, JSON.stringify({ name: piName, version: '0.99.0', bin: { pi: 'dist/cli.js' } }));
assert.throws(() => betaNodeEntry(ctx, 'pi', piName, 'pi'), /identity\/version/);
fs.writeFileSync(packageFile, JSON.stringify({ name: piName, version: '0.84.3', bin: { pi: '../../outside.js' } }));
assert.throws(() => betaNodeEntry(ctx, 'pi', piName, 'pi'), /escapes|missing/);
const occupied = path.join(scratch, 'occupied');
fs.mkdirSync(occupied);
fs.writeFileSync(path.join(occupied, 'user-file'), 'preserve');
assert.throws(() => claimBetaRoot(planBetaContext({ ...input, root: occupied })), /empty|owned/i);
assert.equal(fs.readFileSync(path.join(stable, 'sentinel'), 'utf8'), 'stable must remain unchanged');
assert.equal(fs.readFileSync(path.join(occupied, 'user-file'), 'utf8'), 'preserve');
console.log('installation context: pure planning, ownership, real junctions, environment and tamper checks passed');

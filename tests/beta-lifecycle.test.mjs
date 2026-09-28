import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planBetaContext, claimBetaRoot, loadBetaContext } from '../lib/installation-context.mjs';
import { updateBeta, rollbackBeta, removeBeta, betaDoctor, readPackageInventory, writeBetaLaunchers, reinstallBeta } from '../lib/beta-lifecycle.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-beta-lifecycle-'));
const fixture = path.join(scratch, 'reviewed-source');
const gitTool = process.env.COOP_TEST_GIT || (process.platform === 'win32'
  ? execFileSync('where.exe', ['git.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
  : execFileSync('which', ['git'], { encoding: 'utf8' }).trim());
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(scratch, 'no-global'), GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, args) => execFileSync(gitTool, ['-C', cwd, ...args], { env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
fs.mkdirSync(path.join(fixture, 'config'), { recursive: true });
fs.copyFileSync(path.join(repo, 'config/windows-beta-manifest.json'), path.join(fixture, 'config/windows-beta-manifest.json'));
fs.copyFileSync(path.join(repo, 'VERSION'), path.join(fixture, 'VERSION'));
fs.mkdirSync(path.join(fixture, 'lib'));
for (const name of ['installation-context.mjs', 'beta-lifecycle.mjs', 'beta-entry.mjs', 'owned-process.ps1']) fs.copyFileSync(path.join(repo, 'lib', name), path.join(fixture, 'lib', name));
git(fixture, ['init']); git(fixture, ['config', 'core.autocrlf', 'false']);
const commit = message => { git(fixture, ['add', '.']); git(fixture, ['-c', 'user.name=Coop fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', message]); return git(fixture, ['rev-parse', 'HEAD']); };
const first = commit('Synthetic initial source');
const ctx = planBetaContext({ root: path.join(scratch, 'Beta Ω'), build: first,
  tools: { node: process.execPath, python: process.execPath, fabricPython: process.execPath, git: gitTool },
  manifest: fs.readFileSync(path.join(fixture, 'config/windows-beta-manifest.json')) });
claimBetaRoot(ctx);
execFileSync(gitTool, ['-c', 'core.autocrlf=false', 'clone', '--no-hardlinks', fixture, ctx.paths.source], { env, stdio: 'ignore' });
writeBetaLaunchers(ctx);
fs.mkdirSync(ctx.paths.agent, { recursive: true });
fs.writeFileSync(path.join(ctx.paths.agent, 'auth.json'), '{"synthetic":"preserve"}');
fs.writeFileSync(path.join(ctx.paths.agent, 'settings.json'), '{"unknownFutureField":37}');
assert.equal(betaDoctor(ctx).healthy, false, 'missing packages must not pass Doctor');
assert.equal(fs.existsSync(path.join(ctx.paths.agent, 'npm')), false, 'Doctor is observational');
// Package metadata alone must not conceal a missing root-level Pi dependency.
// npm can leave pi-ai nested beneath the agent despite an override declaration.
for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-tui']) {
  const nested = path.join(ctx.paths.agent, 'npm/node_modules/pi-mcp-adapter/node_modules', name);
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name, version: '0.84.3' }));
  assert.equal(readPackageInventory(ctx).find(p => p.name === name)?.matches, false);
  const metadata = path.join(ctx.paths.agent, 'npm/node_modules', name);
  fs.mkdirSync(metadata, { recursive: true });
  fs.writeFileSync(path.join(metadata, 'package.json'), JSON.stringify({ name, version: '0.84.3' }));
  const installed = readPackageInventory(ctx).find(p => p.name === name);
  assert.equal(installed.matches, true);
  assert.equal(installed.scope, 'extensions');
}
fs.writeFileSync(path.join(fixture, 'next.txt'), 'next reviewed build');
// Only this synthetic candidate changes Doctor's return to identify which
// recovery module the public bootstrap actually executed after an update.
const candidateLifecycle = path.join(fixture, 'lib/beta-lifecycle.mjs');
fs.writeFileSync(candidateLifecycle, fs.readFileSync(candidateLifecycle, 'utf8').replace('export function betaDoctor(ctx) {', 'export function betaDoctor(ctx) {\n  return { healthy: false, recoveryCanary: "second" };'));
const second = commit('Synthetic next source');
assert.throws(() => updateBeta(ctx, fixture, 'main', { ancestry: first }), /exact build/);
fs.writeFileSync(path.join(fixture, 'dirty.txt'), 'preserve candidate');
assert.throws(() => updateBeta(ctx, fixture, second, { ancestry: first }), /dirty/);
// Only the disposable test-owned file is removed; real source is never reset.
fs.unlinkSync(path.join(fixture, 'dirty.txt'));
assert.deepEqual(updateBeta(ctx, fixture, second, { ancestry: first }), { changed: true, build: second, previous: first });
const next = loadBetaContext(ctx.root);
assert.equal(next.build, second);
assert.equal(git(ctx.paths.source, ['rev-parse', 'HEAD']), second);
assert.equal(git(path.join(ctx.root, 'previous-source'), ['rev-parse', 'HEAD']), first);
const publicCall = (args, expected) => {
  const result = spawnSync(process.execPath, [path.join(ctx.paths.bin, 'beta-entry.mjs'), ...args], { cwd: ctx.root, env, windowsHide: true, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, expected, result.stderr);
  return result;
};
if (process.platform === 'win32') {
  assert.equal(JSON.parse(publicCall(['doctor'], 1).stdout).recoveryCanary, 'second', 'completed update must use its new helper version');
  const helper = path.join(ctx.root, 'recovery', second, 'owned-process.ps1');
  const helperBytes = fs.readFileSync(helper);
  fs.appendFileSync(helper, '# synthetic tamper');
  const tampered = publicCall(['doctor'], 1);
  assert.equal(tampered.stdout.includes('recoveryCanary'), false);
  assert.match(tampered.stderr, /recovery helper changed/);
  fs.writeFileSync(helper, helperBytes);
  const journal = path.join(ctx.root, '.coop-beta-transaction.json');
  fs.writeFileSync(journal, JSON.stringify({ operation: 'update', before: ctx, after: next, recoveryBuild: first }));
  assert.equal(JSON.parse(publicCall(['doctor'], 1).stdout).status, 'update-incomplete', 'interrupted update must use the creator helper version');
  fs.unlinkSync(journal); // synthetic interrupted-state receipt
}
const targetReceipt = path.join(ctx.root, 'recovery', first, 'receipt.json');
const targetReceiptBytes = fs.readFileSync(targetReceipt);
fs.unlinkSync(targetReceipt);
assert.throws(() => rollbackBeta(next), /ENOENT/);
assert.equal(git(ctx.paths.source, ['rev-parse', 'HEAD']), second, 'missing target recovery must refuse before rollback mutates source');
fs.writeFileSync(targetReceipt, targetReceiptBytes);
const beforeFile = path.join(ctx.root, 'previous-build.json');
const savedBefore = fs.readFileSync(beforeFile);
fs.writeFileSync(beforeFile, JSON.stringify({ ...ctx, tools: { ...ctx.tools, node: ctx.tools.git } }));
assert.throws(() => rollbackBeta(next), /Invalid beta rollback receipt/);
assert.equal(git(ctx.paths.source, ['rev-parse', 'HEAD']), second, 'invalid receipt must refuse before a source rename');
fs.writeFileSync(beforeFile, savedBefore);
assert.equal((process.platform === 'win32' ? JSON.parse(publicCall(['update', '--rollback'], 0).stdout) : rollbackBeta(next)).build, first);
if (process.platform === 'win32') assert.equal(JSON.parse(publicCall(['doctor'], 1).stdout).recoveryCanary, undefined, 'completed rollback must select the restored helper version');
assert.equal(loadBetaContext(ctx.root).build, first);
// More than one update, and another update/rollback cycle, require no manual
// source archiving. Older clean copies remain available for inspection.
assert.equal(updateBeta(ctx, fixture, second, { ancestry: first }).build, second);
fs.writeFileSync(path.join(fixture, 'third.txt'), 'third reviewed build');
const third = commit('Synthetic third source');
assert.equal(updateBeta(loadBetaContext(ctx.root), fixture, third, { ancestry: first }).build, third);
assert.equal(git(path.join(ctx.root, 'previous-source'), ['rev-parse', 'HEAD']), second);
const retainedRoot = path.join(ctx.root, 'retained-sources');
assert.ok(fs.readdirSync(retainedRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())
  .some(entry => git(path.join(retainedRoot, entry.name), ['rev-parse', 'HEAD']) === first));
assert.equal(rollbackBeta(loadBetaContext(ctx.root)).build, second);
git(fixture, ['checkout', '--detach', first]);
assert.equal(updateBeta(loadBetaContext(ctx.root), fixture, first, { ancestry: first }).build, first);
assert.equal(rollbackBeta(loadBetaContext(ctx.root)).build, second);
assert.equal(updateBeta(loadBetaContext(ctx.root), fixture, first, { ancestry: first }).build, first);
console.log('Beta update: repeated exact-build update/rollback preserves older source copies automatically');
fs.appendFileSync(candidateLifecycle, '\nimport "./unpackaged-recovery-helper.mjs";\n');
const unpackaged = commit('Synthetic incompatible recovery module');
assert.throws(() => updateBeta(loadBetaContext(ctx.root), fixture, unpackaged, { ancestry: first }), /update did not complete/);
assert.equal(loadBetaContext(ctx.root).build, first, 'unloadable recovery must fail before selecting the candidate build');
assert.equal(fs.existsSync(path.join(ctx.root, 'recovery', unpackaged)), false, 'incomplete helper graph must not publish');
assert.equal(betaDoctor(ctx).status, 'update-incomplete');
assert.equal((process.platform === 'win32' ? JSON.parse(publicCall(['update', '--rollback'], 0).stdout) : rollbackBeta(ctx)).build, first);
assert.equal(git(path.join(ctx.root, 'previous-source'), ['rev-parse', 'HEAD']), second);
git(fixture, ['checkout', '--detach', first]);
const candidateContext = path.join(fixture, 'lib/installation-context.mjs');
fs.writeFileSync(candidateContext, fs.readFileSync(candidateContext, 'utf8').replace('export const recoveryModuleNames = Object.freeze([', 'export const recoveryModuleNames = Object.freeze(["unpackaged.mjs", '));
const incompatibleReceipt = commit('Synthetic incompatible recovery receipt protocol');
for (let attempt = 0; attempt < 2; attempt++) {
  assert.throws(() => updateBeta(loadBetaContext(ctx.root), fixture, incompatibleReceipt, { ancestry: first }), /update did not complete/);
  assert.equal(loadBetaContext(ctx.root).build, first, 'candidate self-validation must fail before selection, including a retry');
  assert.equal(rollbackBeta(loadBetaContext(ctx.root)).build, first);
}
git(fixture, ['checkout', '--detach', first]);
console.log('Beta recovery versions: changed helpers selected, creator retained during interruption, tamper/missing target/unpackaged helper refused');
for (const [file, expected] of [['auth.json', '{"synthetic":"preserve"}'], ['settings.json', '{"unknownFutureField":37}']]) {
  assert.equal(fs.readFileSync(path.join(ctx.paths.agent, file), 'utf8'), expected);
}
const runtime = path.join(ctx.root, 'runtime');
const extensions = path.join(ctx.paths.agent, 'npm');
const backup = path.join(ctx.root, 'package-rollback');
for (const dir of [runtime, extensions, backup]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(runtime, 'package-state'), 'last good runtime');
fs.writeFileSync(path.join(extensions, 'package-state'), 'last good extensions');
const snapshots = [runtime, extensions].map((original, i) => ({ original, saved: path.join(backup, String(i)), existed: true }));
for (const item of snapshots) fs.cpSync(item.original, item.saved, { recursive: true });
fs.writeFileSync(path.join(runtime, 'package-state'), 'interrupted install');
fs.writeFileSync(path.join(extensions, 'package-state'), 'interrupted install');
fs.writeFileSync(path.join(ctx.root, '.coop-beta-transaction.json'), JSON.stringify({ operation: 'sync', before: ctx, snapshots }));
assert.equal(rollbackBeta(loadBetaContext(ctx.root)).packages, 'restored');
assert.equal(fs.readFileSync(path.join(runtime, 'package-state'), 'utf8'), 'last good runtime');
assert.equal(fs.readFileSync(path.join(extensions, 'package-state'), 'utf8'), 'last good extensions');
// A nested reparse escape invalidates removal BEFORE the first deletion.
const outside = path.join(scratch, 'stable-sentinel'); fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'unchanged'), 'stable');
fs.mkdirSync(ctx.paths.npm, { recursive: true });
const escape = path.join(ctx.paths.npm, 'escape');
fs.symlinkSync(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
assert.throws(() => removeBeta(loadBetaContext(ctx.root)), /Link|Reparse/);
assert.equal(fs.existsSync(ctx.paths.source), true);
assert.equal(fs.readFileSync(path.join(outside, 'unchanged'), 'utf8'), 'stable');
fs.unlinkSync(escape);
const removed = removeBeta(loadBetaContext(ctx.root));
assert.equal(removed.preserved, ctx.paths.profile);
assert.equal(fs.existsSync(ctx.paths.source), false);
assert.equal(fs.existsSync(path.join(ctx.paths.agent, 'auth.json')), true);
assert.equal(fs.readFileSync(path.join(outside, 'unchanged'), 'utf8'), 'stable');
assert.equal(betaDoctor(ctx).status, 'removed');
fs.writeFileSync(path.join(ctx.root, '.coop-beta-transaction.json'), JSON.stringify({ operation: 'remove', before: ctx, sourceFiles: {} }));
assert.equal(removeBeta(ctx).alreadyRemoved, true, 'retry completes interrupted receipt cleanup');
assert.equal(fs.existsSync(path.join(ctx.root, '.coop-beta-transaction.json')), false);
fs.mkdirSync(ctx.paths.source);
fs.writeFileSync(path.join(ctx.paths.source, 'new-user-file'), 'preserve after removal');
assert.throws(() => removeBeta(ctx), /files appeared after beta removal/);
assert.equal(fs.readFileSync(path.join(ctx.paths.source, 'new-user-file'), 'utf8'), 'preserve after removal');
fs.unlinkSync(path.join(ctx.paths.source, 'new-user-file')); // own synthetic marker
fs.rmdirSync(ctx.paths.source);
git(fixture, ['checkout', '--detach', first]);
const settingsBytes = fs.readFileSync(path.join(ctx.paths.agent, 'settings.json'));
const recoveryBytes = fs.readFileSync(path.join(ctx.paths.bin, 'recovery.json'));
const journal = path.join(ctx.root, '.coop-beta-transaction.json');
fs.writeFileSync(path.join(fixture, 'candidate-user-change'), 'preserve candidate');
assert.throws(() => reinstallBeta(ctx, fixture), /dirty/);
assert.equal(fs.existsSync(journal), false, 'invalid candidate must refuse before reinstall starts');
fs.unlinkSync(path.join(fixture, 'candidate-user-change'));
assert.equal(reinstallBeta(ctx, fixture).build, first);
assert.equal(git(ctx.paths.source, ['rev-parse', 'HEAD']), first);
assert.deepEqual(fs.readFileSync(path.join(ctx.paths.agent, 'settings.json')), settingsBytes);
assert.deepEqual(fs.readFileSync(path.join(ctx.paths.bin, 'recovery.json')), recoveryBytes);
assert.equal(fs.readFileSync(path.join(ctx.paths.agent, 'auth.json'), 'utf8'), '{"synthetic":"preserve"}');
assert.equal(fs.existsSync(runtime), false, 'source reinstallation must not silently provision packages');
assert.equal(betaDoctor(ctx).healthy, false, 'reinstalled source still requires explicit package convergence');
assert.throws(() => reinstallBeta(ctx, fixture), /completed beta removal/);
removeBeta(ctx);
// A killed clone may be incomplete and may contain new user files. Rollback
// retains them without requiring Git to recognize a complete checkout.
const staged = path.join(ctx.root, 'reinstall-source');
const pendingReinstall = { operation: 'reinstall', before: ctx, source: fixture, product: '0.23.3' };
fs.writeFileSync(journal, JSON.stringify(pendingReinstall));
fs.mkdirSync(staged);
fs.writeFileSync(path.join(staged, 'user-note'), 'preserve interrupted clone');
assert.equal(betaDoctor(ctx).status, 'reinstall-incomplete');
assert.throws(() => reinstallBeta(ctx, fixture), /reinstall is incomplete/);
assert.equal(fs.readFileSync(path.join(staged, 'user-note'), 'utf8'), 'preserve interrupted clone');
const restoredRemoval = rollbackBeta(ctx);
assert.equal(restoredRemoval.status, 'removed');
assert.equal(fs.readFileSync(path.join(restoredRemoval.retained, 'reinstall-source/user-note'), 'utf8'), 'preserve interrupted clone');
assert.equal(betaDoctor(ctx).status, 'removed');
// A complete staged clone can finish after interruption without copying or
// deleting any profile data or replacing the recovery entry.
fs.writeFileSync(journal, JSON.stringify(pendingReinstall));
execFileSync(gitTool, ['-c', 'core.autocrlf=false', 'clone', '--no-hardlinks', fixture, staged], { env, stdio: 'ignore' });
assert.equal(reinstallBeta(ctx, fixture).build, first);
assert.equal(fs.existsSync(staged), false);
assert.equal(fs.existsSync(journal), false);
assert.deepEqual(fs.readFileSync(path.join(ctx.paths.agent, 'settings.json')), settingsBytes);
assert.deepEqual(fs.readFileSync(path.join(ctx.paths.bin, 'recovery.json')), recoveryBytes);
assert.equal(fs.readFileSync(path.join(ctx.paths.agent, 'auth.json'), 'utf8'), '{"synthetic":"preserve"}');
console.log('Beta reinstall: same-build source recovery, incomplete-clone retention, resumable staging and profile preservation passed');
console.log('Beta lifecycle: exact-build update, dirty/refusal, rollback, data preservation and removal boundary passed');

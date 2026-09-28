import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planBetaContext, claimBetaRoot, loadBetaContext } from '../lib/installation-context.mjs';
import { rollbackBeta, writeBetaLaunchers, betaDoctor } from '../lib/beta-lifecycle.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-beta-source-recovery-'));
const fixture = path.join(scratch, 'fixture');
const gitTool = process.env.COOP_TEST_GIT || execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [process.platform === 'win32' ? 'git.exe' : 'git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(scratch, 'no-global'), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, args) => execFileSync(gitTool, ['-C', cwd, ...args], { env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
for (const relative of ['config/windows-beta-manifest.json', 'VERSION', ...['installation-context.mjs', 'beta-lifecycle.mjs', 'beta-entry.mjs', 'owned-process.ps1'].map(name => `lib/${name}`)]) {
  const destination = path.join(fixture, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(repo, relative), destination);
}
git(fixture, ['init']); git(fixture, ['config', 'core.autocrlf', 'false']);
const commit = label => {
  fs.writeFileSync(path.join(fixture, 'revision'), label);
  git(fixture, ['add', '.']);
  git(fixture, ['-c', 'user.name=Coop recovery fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', label]);
  return git(fixture, ['rev-parse', 'HEAD']);
};
const older = commit('Synthetic older source'), before = commit('Synthetic current source'), after = commit('Synthetic candidate source');
const clone = (destination, revision) => {
  execFileSync(gitTool, ['-c', 'core.autocrlf=false', 'clone', '--no-hardlinks', fixture, destination], { env, windowsHide: true, stdio: 'ignore' });
  git(destination, ['checkout', '--detach', revision]);
};

for (let phase = 0; phase < 10; phase++) {
  const ctx = planBetaContext({ root: path.join(scratch, `phase-${phase}`), build: before,
    tools: { node: process.execPath, python: process.execPath, fabricPython: process.execPath, git: gitTool },
    manifest: fs.readFileSync(path.join(fixture, 'config/windows-beta-manifest.json')) });
  claimBetaRoot(ctx);
  clone(ctx.paths.source, before);
  writeBetaLaunchers(ctx);
  fs.mkdirSync(ctx.paths.agent, { recursive: true });
  const userFile = path.join(ctx.paths.agent, 'user-session');
  fs.writeFileSync(userFile, 'preserve user history');
  const previous = path.join(ctx.root, 'previous-source'), staged = path.join(ctx.root, 'candidate-source');
  clone(previous, older);
  const priorPrevious = { ...ctx, build: older }, next = { ...ctx, build: after };
  const priorArchive = path.join(ctx.root, 'retained-sources', randomUUID());
  const journal = path.join(ctx.root, '.coop-beta-transaction.json');
  fs.writeFileSync(path.join(ctx.root, 'previous-build.json'), JSON.stringify(priorPrevious));
  fs.writeFileSync(journal, JSON.stringify({ operation: 'update', before: ctx, after: next, priorPrevious, priorArchive, recoveryBuild: before }));
  if (phase === 0) {
    fs.mkdirSync(staged);
    fs.writeFileSync(path.join(staged, 'partial-clone-user-note'), 'retain incomplete staging');
  } else clone(staged, after);
  if (phase >= 2) { fs.mkdirSync(path.dirname(priorArchive), { recursive: true }); fs.renameSync(previous, priorArchive); }
  if (phase >= 3) fs.renameSync(ctx.paths.source, previous);
  if (phase >= 4) fs.renameSync(staged, ctx.paths.source);
  if (phase >= 5) fs.writeFileSync(path.join(ctx.root, '.coop-beta.json'), JSON.stringify(next));
  if (phase >= 6) fs.writeFileSync(path.join(ctx.root, 'previous-build.json'), JSON.stringify(ctx));
  if (phase >= 7) fs.renameSync(ctx.paths.source, path.join(ctx.root, 'retained-sources', randomUUID()));
  if (phase >= 8) fs.renameSync(previous, ctx.paths.source);
  if (phase >= 9) fs.renameSync(priorArchive, previous);
  const native = process.platform === 'win32' && [0, 3, 5, 7, 9].includes(phase);
  const publicCall = (args, expected) => {
    const result = spawnSync(process.execPath, [path.join(ctx.paths.bin, 'beta-entry.mjs'), ...args], { cwd: ctx.root, env, windowsHide: true, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.error, undefined, 'public recovery must not time out');
    assert.equal(result.status, expected, result.stderr);
    assert.equal(fs.existsSync(path.join(ctx.root, '.coop-beta.lock')), false, 'recovery must release its operation lock');
    return JSON.parse(result.stdout);
  };
  const doctor = native ? publicCall(['doctor'], 1) : betaDoctor(loadBetaContext(ctx.root));
  assert.equal(doctor.status, 'update-incomplete');
  assert.equal(doctor.healthy, false);
  assert.equal(doctor.pendingRecovery, true);
  const result = native ? publicCall(['update', '--rollback'], 0) : rollbackBeta(loadBetaContext(ctx.root));
  assert.equal(result.build, before);
  assert.equal(loadBetaContext(ctx.root).build, before);
  assert.equal(git(ctx.paths.source, ['rev-parse', 'HEAD']), before);
  assert.equal(git(previous, ['rev-parse', 'HEAD']), older);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctx.root, 'previous-build.json'))), priorPrevious);
  assert.equal(fs.readFileSync(userFile, 'utf8'), 'preserve user history');
  assert.equal(fs.existsSync(journal), false);
  assert.equal(fs.existsSync(staged), false);
  if (phase === 0) {
    const retained = fs.readdirSync(path.join(ctx.root, 'retained-sources'), { withFileTypes: true }).filter(item => item.isDirectory());
    assert.ok(retained.some(item => fs.existsSync(path.join(ctx.root, 'retained-sources', item.name, 'partial-clone-user-note'))));
  }
  console.log(`Beta source recovery phase ${phase}${native ? ' (public Windows entry)' : ''}: active build, earlier rollback and user data preserved`);
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {planBetaContext, claimBetaRoot} from '../lib/installation-context.mjs';
import {checkBetaReviewScope, backupBetaReview, betaReviewDiff} from '../lib/beta-lifecycle.mjs';
import {resolveStandard, promoteReviewRun, resolveAcceptedReviewRun} from '../lib/standards.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-review-suite-'));
const git = process.env.COOP_TEST_GIT || execFileSync(process.platform === 'win32' ? 'where.exe' : 'which',
  [process.platform === 'win32' ? 'git.exe' : 'git'], {encoding: 'utf8'}).trim().split(/\r?\n/)[0];
const ctx = planBetaContext({root: path.join(scratch, 'Beta Ω'), build: 'a'.repeat(40),
  tools: {node: process.execPath, python: process.execPath, fabricPython: process.execPath, git},
  manifest: fs.readFileSync(path.join(repo, 'config/windows-beta-manifest.json'))});
claimBetaRoot(ctx);
const cwd = path.join(ctx.root, 'workspaces', 'Review Ω'); fs.mkdirSync(cwd, {recursive: true});
const input = path.join(cwd, 'source.sql'); fs.writeFileSync(input, 'synthetic source');
const outdir = path.join(cwd, '.coop', 'reviews');
const outside = path.join(scratch, 'outside'); fs.mkdirSync(outside);
const canary = path.join(outside, 'canary.sql'); fs.writeFileSync(canary, 'preserve outside');
assert.deepEqual(checkBetaReviewScope(ctx, cwd, outdir, [input]), {output: outdir, paths: [input]});
assert.equal(fs.existsSync(outdir), false);
for (const [output, inputs] of [[outside, [input]], [outdir, [canary]], [outdir, []], [outdir, ['missing.sql']], [cwd, [input]]]) {
  assert.throws(() => backupBetaReview(ctx, cwd, output, inputs));
  assert.equal(fs.existsSync(path.join(cwd, '.backups')), false);
}
fs.mkdirSync(outdir, {recursive: true});
const report = path.join(outdir, 'suite.html'); fs.writeFileSync(report, 'preserve report Ω');
backupBetaReview(ctx, cwd, outdir, [input]);
const backups = path.join(cwd, '.backups', 'coop-review-suite');
assert.equal(fs.readdirSync(backups).length, 1);
assert.equal(fs.readFileSync(path.join(backups, fs.readdirSync(backups)[0], 'suite.html'), 'utf8'), 'preserve report Ω');
assert.equal(fs.readFileSync(input, 'utf8'), 'synthetic source');
assert.equal(fs.readFileSync(canary, 'utf8'), 'preserve outside');
const alias = path.join(cwd, 'alias.sql'); fs.linkSync(canary, alias);
assert.throws(() => checkBetaReviewScope(ctx, cwd, outdir, [alias]), /Hardlink/);
if (process.platform === 'win32') {
  const junction = path.join(cwd, 'linked'); fs.symlinkSync(outside, junction, 'junction');
  assert.throws(() => checkBetaReviewScope(ctx, cwd, outdir, [junction]), /Link|Reparse/);
}
const resolution = path.join(scratch, 'resolution.json');
const selected = {path: path.join(ctx.root, 'profile', 'standards', 'Ω 😀.md'), future: '日本語'};
fs.writeFileSync(resolution, JSON.stringify({sql: selected}));
const result = spawnSync(process.execPath, [path.join(repo, 'lib/standards-cli.mjs'), 'resolution-domain', resolution, 'sql'], {encoding: 'utf8'});
assert.equal(result.status, 0, result.stderr);
assert.ok(!/[^\x00-\x7f]/.test(result.stdout));
assert.deepEqual(JSON.parse(result.stdout), selected);

// The pinned Python packages use POSIX separators in JSON, including on Windows.
// Publication must apply the same lexical/physical/hash check as initial binding.
const project = path.join(scratch, 'Provenance Ω'); fs.mkdirSync(path.join(project, '.coop'), {recursive: true});
fs.writeFileSync(path.join(project, '.coop', 'project.yml'), 'standards:\n  sql: sql.md\n  dax: dax.md\n');
const entries = [];
for (const domain of ['sql', 'dax']) {
  fs.writeFileSync(path.join(project, domain + '.md'), '# Synthetic ' + domain);
  const resolution = resolveStandard(domain, {cwd: project, canonicalRoot: path.join(scratch, 'no-canonical'),
    staleRoot: path.join(scratch, 'no-stale'), snapshotRoot: path.join(scratch, 'snapshots'), refresh: false});
  const resolutionPath = path.join(scratch, domain + '-resolution.json'), reportPath = path.join(scratch, domain + '-report.json');
  const report = {tool: 'coop-' + domain + '-review', schema_version: domain === 'sql' ? 4 : 3, version: 'fixture',
    [domain === 'sql' ? 'files_checked' : 'models_checked']: 0,
    standards: {path: resolution.path.replaceAll('\\', '/'), sha256: resolution.sha256}, findings: [], diagnostics: [], agent_review: [],
    summary: {error: 0, warning: 0, info: 0}, verdict: {clean: true, highest_severity: null}};
  fs.writeFileSync(resolutionPath, JSON.stringify(resolution)); fs.writeFileSync(reportPath, JSON.stringify(report));
  entries.push({domain, resolutionPath, reportPath});
}
const acceptedDir = path.join(scratch, 'accepted');
const promoted = promoteReviewRun(acceptedDir, entries); assert.equal(promoted.ok, true, promoted.error);
assert.equal(resolveAcceptedReviewRun(acceptedDir).ok, true);
const pointerFile = path.join(acceptedDir, 'active-review-generation.json'), pointerBytes = fs.readFileSync(pointerFile);
const forged = JSON.parse(fs.readFileSync(entries[0].reportPath));
const aliasStandard = path.join(scratch, 'same-bytes-other-path.md'); fs.copyFileSync(forged.standards.path, aliasStandard);
forged.standards.path = aliasStandard; fs.writeFileSync(entries[0].reportPath, JSON.stringify(forged));
assert.equal(promoteReviewRun(acceptedDir, entries).ok, false);
assert.deepEqual(fs.readFileSync(pointerFile), pointerBytes);
assert.equal(resolveAcceptedReviewRun(acceptedDir).ok, true);
console.log('Beta combined review: scope refusal, backups, real aliases, Unicode JSON and Windows report provenance passed');

const diffRoot = path.join(ctx.root, 'workspaces', 'Git Ω'); fs.mkdirSync(diffRoot);
const gitEnv = {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(scratch, 'no-global'), GIT_TERMINAL_PROMPT: '0'};
const localGit = args => execFileSync(git, ['-C', diffRoot, ...args], {env: gitEnv, encoding: 'utf8', windowsHide: true, stdio: ['ignore','pipe','pipe']});
localGit(['init']); localGit(['config', 'core.autocrlf', 'false']);
fs.mkdirSync(path.join(diffRoot, 'nested'));
fs.writeFileSync(path.join(diffRoot, 'nested', 'tracked Ω.sql'), 'SELECT 1;');
fs.writeFileSync(path.join(diffRoot, 'removed.sql'), 'SELECT 1;');
localGit(['add', '.']); localGit(['-c','user.name=Coop test','-c','user.email=fixture@example.invalid','commit','-m','Synthetic diff fixture']);
const diffOut = path.join(diffRoot, '.coop/reviews');
assert.deepEqual(betaReviewDiff(ctx, diffRoot, diffOut, 'HEAD', [diffRoot]).paths, []);
fs.appendFileSync(path.join(diffRoot, 'nested', 'tracked Ω.sql'), '\nSELECT 2;');
fs.writeFileSync(path.join(diffRoot, 'new Ω.sql'), 'SELECT 3;');
fs.unlinkSync(path.join(diffRoot, 'removed.sql')); // disposable synthetic source
const chosen = betaReviewDiff(ctx, diffRoot, diffOut, 'HEAD', [diffRoot]);
assert.deepEqual(chosen.paths.sort(), [path.join(diffRoot, 'nested', 'tracked Ω.sql'), path.join(diffRoot, 'new Ω.sql')].sort());
assert.deepEqual(betaReviewDiff(ctx, diffRoot, diffOut, 'HEAD', [path.join(diffRoot, 'nested')]).paths, [path.join(diffRoot, 'nested', 'tracked Ω.sql')]);
for (const ref of ['missing-ref', '--output=outside', 'HEAD\n']) assert.throws(() => betaReviewDiff(ctx, diffRoot, diffOut, ref, [diffRoot]), /Git|reference/);
assert.equal(fs.existsSync(diffOut), false);
localGit(['config','include.path',path.join(outside,'external.gitconfig')]);
assert.throws(() => betaReviewDiff(ctx, diffRoot, diffOut, 'HEAD', [diffRoot]), /configuration/);
localGit(['config','--unset','include.path']);
fs.writeFileSync(path.join(diffRoot,'.git','objects','info','alternates'), outside);
assert.throws(() => betaReviewDiff(ctx, diffRoot, diffOut, 'HEAD', [diffRoot]), /Redirected/);
const linkedRepo = path.join(ctx.root,'workspaces','Linked git Ω');fs.mkdirSync(linkedRepo);
fs.writeFileSync(path.join(linkedRepo,'.git'),'gitdir: '+path.join(diffRoot,'.git'));
assert.throws(() => betaReviewDiff(ctx, linkedRepo, path.join(linkedRepo,'.coop/reviews'), 'HEAD', [linkedRepo]), /Linked/);
const loose = path.join(ctx.root,'workspaces','No repository Ω');fs.mkdirSync(loose);
assert.deepEqual(betaReviewDiff(ctx, loose, path.join(loose,'.coop/reviews'), 'HEAD', [loose]), {paths:[loose],untrackedRoots:[loose]});
console.log('Beta Git review selection: tracked/untracked/deleted/subdirectory scope, empty result, invalid ref and metadata redirects passed');

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkBetaLaunchInputs, checkBetaResourceRoots } from '../lib/beta-lifecycle.mjs';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-beta-launch-'));
const root = path.join(sandbox, 'beta');
const cwd = path.join(root, 'workspaces', 'Project Ω');
const agent = path.join(root, 'profile', 'agent');
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
const ctx = { root, paths: { agent } };
const external = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-other-profile-'));
fs.writeFileSync(path.join(external, 'sentinel'), 'unchanged');
assert.equal(checkBetaLaunchInputs(ctx, cwd, ['--provider', 'openai-codex', '--model', 'gpt-5.6-terra',
  '--session', '12345678-abcd', '@notes.md', 'hello Ω']).workspace, cwd);
checkBetaLaunchInputs(ctx, cwd, ['--session', path.join(agent, 'sessions', 'example.jsonl')]);
for (const args of [
  ['install', 'npm:unreviewed'], ['auth', 'print-api-key'], ['--provider', 'anthropic'], ['--model', 'openai/gpt-5'], ['--models', 'gpt-5,claude-sonnet'],
  ['--api-key', 'synthetic'], ['--extension', path.join(external, 'extension.js')],
  ['--append-system-prompt', path.join(external, 'prompt.md')], ['--export', path.join(external, 'session.jsonl')],
  ['--session', path.join(external, 'session.jsonl')], ['--fork', path.join(external, 'session.jsonl')],
  ['--session-dir', external], ['--session-dir', cwd], [`@${path.join(external, 'sentinel')}`],
  ['--provider'], ['--session-id', '../escape'], ['--future-resource-flag', external],
]) assert.throws(() => checkBetaLaunchInputs(ctx, cwd, args), /beta|Beta|scope|qualification/i);
assert.throws(() => checkBetaLaunchInputs(ctx, external, []), /outside/);
assert.throws(() => checkBetaLaunchInputs(ctx, agent, []), /workspaces/);
const linked = path.join(cwd, 'linked');
fs.symlinkSync(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
assert.throws(() => checkBetaLaunchInputs(ctx, cwd, ['@linked/sentinel']), /Link|reparse/);
assert.equal(fs.readFileSync(path.join(external, 'sentinel'), 'utf8'), 'unchanged');
console.log('Beta launch input scope: owned workspace/session paths, provider, override and junction refusal passed');

const home = path.join(sandbox, 'personal-home');
fs.mkdirSync(home);
checkBetaResourceRoots(ctx, cwd, home);
fs.mkdirSync(path.join(home, '.agents/skills'), { recursive: true });
assert.throws(() => checkBetaResourceRoots(ctx, cwd, home), /outside the beta root/);
fs.rmdirSync(path.join(home, '.agents/skills'));
fs.writeFileSync(path.join(sandbox, 'AGENTS.md'), 'external instructions must not load');
assert.throws(() => checkBetaResourceRoots(ctx, cwd, home), /outside the beta root/);
fs.unlinkSync(path.join(sandbox, 'AGENTS.md'));
fs.mkdirSync(path.join(cwd, '.pi'));
const projectSettings = path.join(cwd, '.pi/settings.json');
for (const overrides of [{ packages: ['npm:unreviewed'] }, { skills: [external] },
  { defaultProvider: 'anthropic' }, { defaultModel: 'claude' }, { sessionDir: external }]) {
  fs.writeFileSync(projectSettings, JSON.stringify(overrides));
  assert.throws(() => checkBetaResourceRoots(ctx, cwd, home), /beta|Beta|GPT/);
}
fs.writeFileSync(projectSettings, JSON.stringify({ defaultProvider: 'openai-codex', defaultModel: 'gpt-5.6-terra', userPreference: 37 }));
checkBetaResourceRoots(ctx, cwd, home);
fs.writeFileSync(path.join(cwd, '.git'), `gitdir: ${external}`);
assert.throws(() => checkBetaResourceRoots(ctx, cwd, home), /Linked|external/);
assert.equal(JSON.parse(fs.readFileSync(projectSettings)).userPreference, 37);
console.log('Beta resource roots: external user/ancestor discovery, project overrides and linked Git refusal passed');

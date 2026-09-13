import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { patchUsageSource, ensureUsageCompatibility } from '../lib/openai-usage-compat.mjs';
const require = createRequire(import.meta.url);
const { parse } = require('../web/public/usage-model.js');
const original = readFileSync(new URL('fixtures/pi-better-openai-0.1.22/usage.ts', import.meta.url), 'utf8');
const temp = mkdtempSync(join(tmpdir(), 'coop-usage-windows-'));
let count = 0;
const test = async (name, fn) => { await fn(); console.log(`  ✓ ${name}`); count++; };
async function load(source, label) {
  // Only replace the auth transport import in this isolated parser fixture. The
  // production dependency's fetch/auth code is unchanged by the correction.
  source = source.replace('import { getCodexCredentials } from "./codex-auth.ts";', 'const getCodexCredentials = async () => undefined;')
    .replace('export { AUTH_FILE, readCodexAuth } from "./codex-auth.ts";', '');
  const path = join(temp, label + '.ts'); writeFileSync(path, source);
  const out = join(temp, label + '.mjs');
  const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['-y', 'esbuild', path, '--format=esm', '--platform=node', '--outfile=' + out], { encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(result.status, 0, result.stderr);
  return import(pathToFileURL(out));
}
try {
  const before = await load(original, 'before');
  const after = await load(patchUsageSource(original), 'after');
  const now = 1788796800000;
  const window = (seconds, used, reset = 432000) => ({ limit_window_seconds: seconds, used_percent: used, reset_after_seconds: reset });
  const text = (data, model) => after.formatUsageSnapshot(after.parseUsageSnapshot(data, model, now), { showResetTimes: true }, now);
  await test('reproduces upstream weekly-primary label error and corrects percentage and reset labels', () => {
    const data = { rate_limit: { primary_window: window(604800, 77) } };
    assert.match(before.formatUsageSnapshot(before.parseUsageSnapshot(data, undefined, now), { showResetTimes: true }, now), /5h: 23%.*5h ↺ 5d0h/);
    const value = text(data);
    assert.match(value, /^Usage: 7d: 23% \| 7d ↺ 5d0h/);
    assert.doesNotMatch(value, /5h|Secondary/);
    assert.deepEqual(parse(value).windows, [{ label: '7d', remaining: 23 }]);
  });
  await test('supports swapped, custom and unknown window durations without inventing periods', () => {
    const data = { rate_limit: { primary_window: window(86400, 20), secondary_window: window(1800, 50, 900) } };
    assert.match(text(data), /Usage: 1d: 80% \| 30m: 50%/);
    assert.match(text({ rate_limit: { primary_window: { used_percent: 0 } } }), /^Usage: Primary: 100%$/);
    assert.equal(text({ rate_limit: null }), 'Usage unavailable.');
    assert.equal(parse('Usage: Primary: --').windows[0].remaining, null);
    assert.deepEqual(parse('Usage: 7d: 0% | 5h: 100%').windows.map(w => w.remaining), [0, 100]);
  });
  await test('preserves Spark-specific selection, countdown aging and missing quota values', () => {
    const data = { rate_limit: { primary_window: window(604800, 50) }, additional_rate_limits: [{ limit_name: 'GPT-5.3-Codex-Spark', rate_limit: { primary_window: window(3600, 10, 120) } }] };
    const snapshot = after.parseUsageSnapshot(data, 'gpt-5.3-codex-spark', now);
    assert.match(after.formatUsageSnapshot(snapshot, { showResetTimes: true }, now + 60000), /1h: 90% \| 1h ↺ 1m/);
    assert.match(text({ rate_limit: { secondary_window: window(604800, null) } }), /^Usage: 7d: --/);
    assert.equal(parse('ordinary message'), null);
  });
  await test('patch install is repeatable, verifies exact source and rejects tampering, version drift and symlinks', () => {
    const dir = join(temp, 'package'); mkdirSync(join(dir, 'src'), { recursive: true });
    const pkg = join(dir, 'package.json'), file = join(dir, 'src/usage.ts');
    writeFileSync(pkg, JSON.stringify({ name: 'pi-better-openai', version: '0.1.22' })); writeFileSync(file, original);
    assert.throws(() => ensureUsageCompatibility(dir, { check: true }), /missing or changed/);
    const receipt = ensureUsageCompatibility(dir);
    assert.deepEqual(ensureUsageCompatibility(dir), receipt);
    assert.deepEqual(ensureUsageCompatibility(dir, { check: true }), receipt);
    writeFileSync(file, readFileSync(file, 'utf8') + '\n');
    assert.throws(() => ensureUsageCompatibility(dir), /Unrecognized/);
    writeFileSync(file, original); writeFileSync(pkg, '{"name":"pi-better-openai","version":"0.1.23"}');
    assert.throws(() => ensureUsageCompatibility(dir), /package version/);
    writeFileSync(pkg, '{"name":"pi-better-openai","version":"0.1.22"}');
    // Windows native symlink acceptance is covered on hosts with Developer Mode.
    if (process.platform !== 'win32') { rmSync(file); symlinkSync(join(temp, 'before.ts'), file); assert.throws(() => ensureUsageCompatibility(dir), /regular file/); }
  });
  await test('Desktop meter clears unknown and absent bars, hides on unavailable status, and loads its parser', () => {
    const app = readFileSync(new URL('../web/public/app.js', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8');
    assert.ok(html.indexOf('/usage-model.js') < html.indexOf('/app.js'));
    const meter = {}, usageEl = { hidden: true, querySelector: () => meter }, usageText = {}, bar5 = { style: {} }, bar7 = { style: {} };
    const sandbox = { usageEl, usageText, bar5, bar7, window: { CoopUsage: { parse } } }; vm.createContext(sandbox);
    vm.runInContext(app.slice(app.indexOf('function clearUsage()'), app.indexOf('const input =', app.indexOf('function clearUsage()'))), sandbox);
    sandbox.maybeUsage('Usage: 5h: 75% | 7d: 20%'); assert.equal(bar7.style.width, '20%');
    sandbox.maybeUsage('Usage: 7d: --'); assert.equal(bar5.style.width, '0%'); assert.equal(bar7.style.width, '0%'); assert.equal(bar7.hidden, true);
    sandbox.maybeUsage('Usage unavailable.'); assert.equal(usageEl.hidden, true); assert.equal(usageText.textContent, '');
    assert.doesNotMatch(app, /post\("\/prompt", \{ message: "\/openai-usage"/);
  });
  console.log(`  ${count} provider usage window tests passed`);
} finally { rmSync(temp, { recursive: true, force: true }); }

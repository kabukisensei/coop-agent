import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { readWindowsProcessIdentity, validateWindowsProcessIdentity } from '../desktop/src/update-windows-process.mjs';
const identity = { pid: 42, startedUtcTicks: '638900000000000000' };
const options = { platform: 'win32', systemRoot: resolve('test-windows'), execute: async (_exe, args) => {
  assert.equal(args.at(-1), '42'); assert.ok(args.includes('-File'));
  return JSON.stringify(identity);
} };
assert.deepEqual(await readWindowsProcessIdentity(42, options), identity);
assert.equal(await readWindowsProcessIdentity(42, { ...options, execute: async () => 'null' }), null);
await assert.rejects(readWindowsProcessIdentity(42, { ...options, execute: async () => JSON.stringify({ ...identity, pid: 43 }) }), /different PID/);
await assert.rejects(readWindowsProcessIdentity(42, { ...options, execute: async () => 'x'.repeat(2049) }), /response is invalid/);
await assert.rejects(readWindowsProcessIdentity(42, { ...options, execute: async () => { throw new Error('Access denied'); } }), /Access denied/);
for (const value of [null, { ...identity, extra: true }, { ...identity, startedUtcTicks: 638900000000000000 }, { ...identity, startedUtcTicks: '0' }]) assert.throws(() => validateWindowsProcessIdentity(value), /invalid/);
for (const pid of [0, -1, 1.5, 2147483648, '42']) await assert.rejects(readWindowsProcessIdentity(pid, options), /valid PID/);
if (process.platform === 'win32') {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  try {
    await once(child.stdout, 'data');
    const first = await readWindowsProcessIdentity(child.pid);
    assert.equal(first.pid, child.pid);
    assert.deepEqual(await readWindowsProcessIdentity(child.pid), first, 'Creation identity must remain stable while the same process lives');
    child.kill(); await closed;
    assert.equal(await readWindowsProcessIdentity(child.pid), null);
    console.log('PASS: native Windows creation identity is stable while alive and absent after confirmed exit');
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed; } }
}
console.log('PASS: process identity validation rejects malformed, mismatched, oversized and unavailable observations');

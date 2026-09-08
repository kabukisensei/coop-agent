import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runUpdateCommand } from './update-installer.mjs';

export function validateWindowsProcessIdentity(value) {
  if (!value || JSON.stringify(Object.keys(value).sort()) !== '["pid","startedUtcTicks"]'
    || !Number.isInteger(value.pid) || value.pid < 1 || value.pid > 2147483647
    || typeof value.startedUtcTicks !== 'string' || !/^[1-9]\d{16,18}$/.test(value.startedUtcTicks)) {
    throw new Error('Windows process identity is invalid.');
  }
  return value;
}

// Read only a PID and its creation time. No command lines, environment variables,
// credentials or unrelated process inventory are returned to the updater.
export async function readWindowsProcessIdentity(pid, { execute = runUpdateCommand,
  platform = process.platform, systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT, signal } = {}) {
  if (platform !== 'win32' || !Number.isInteger(pid) || pid < 1 || pid > 2147483647) throw new Error('Native Windows process identity requires a valid PID.');
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error('Windows system directory is unavailable.');
  const output = await execute(join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./update-windows-process.ps1', import.meta.url)), String(pid)], { signal });
  if (typeof output !== 'string' || Buffer.byteLength(output) > 2048) throw new Error('Windows process identity response is invalid.');
  const value = JSON.parse(output);
  if (value === null) return null;
  validateWindowsProcessIdentity(value);
  if (value.pid !== pid) throw new Error('Windows process identity returned a different PID.');
  return Object.freeze(value);
}

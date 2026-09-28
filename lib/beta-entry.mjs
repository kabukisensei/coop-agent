/** Native argv bridge for cmd.exe/Git Bash. PowerShell 5.1 receives only an
 * encoded vector, avoiding its lossy native argument binder. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadBetaContext, betaEnvironment } from './installation-context.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const ctx = loadBetaContext(root);
  const env = betaEnvironment(ctx);
  env.COOP_BETA_ARGV = Buffer.from(JSON.stringify(process.argv.slice(2))).toString('base64');
  env.COOP_BETA_PARENT_PID = String(process.pid);
  const ps = path.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const child = spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ctx.paths.bin, 'coop-beta.ps1')], { env, stdio: 'inherit', windowsHide: false });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill());
  child.once('error', () => { console.error('Beta Windows entry could not start'); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
} catch { console.error('Beta installation identity is invalid; no fallback was attempted'); process.exitCode = 1; }

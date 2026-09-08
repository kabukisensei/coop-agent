import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Used through Pi's public shell-tool operations seam. Pi still owns argument
// validation, output truncation, streaming, tool rendering and session metadata.
export function createWindowsShellOperations({ python, helper, resolveShellConfig, prefix = '' }) {
  return { exec: async (command, cwd, { onData, signal, timeout, env }) => {
    if (signal?.aborted) throw new Error('aborted');
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2147483647)) throw new Error('Invalid shell timeout');
    const config = resolveShellConfig();
    const root = mkdtempSync(join(tmpdir(), 'coop-shell-job-'));
    const cancellation = join(root, 'cancel');
    let child, timer, forceTimer, timedOut = false, cancellationError;
    const cancel = () => {
      try { writeFileSync(cancellation, 'cancel', { flag: 'w' }); }
      catch (error) { cancellationError = error; child?.kill(); }
      forceTimer ??= setTimeout(() => { cancellationError ??= new Error('Windows shell cancellation was not acknowledged'); child?.kill(); }, 7000);
    };
    try {
      const fromStdin = config.commandTransport === 'stdin';
      child = spawn(python, ['-I', '-B', '-X', 'utf8', helper, cancellation, config.shell,
        ...config.args, ...(fromStdin ? [] : [prefix + command])], {
        cwd, env, windowsHide: true, stdio: [fromStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
      if (fromStdin) { child.stdin.on('error', () => {}); child.stdin.end(prefix + command); }
      child.stdout.on('data', onData); child.stderr.on('data', onData);
      const exit = new Promise((resolve, reject) => {
        let drain;
        child.once('error', reject);
        child.once('exit', (code, exitSignal) => {
          // An intentional background process can retain stdout handles.
          drain = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); resolve({code, exitSignal}); }, 250);
        });
        child.once('close', (code, exitSignal) => { clearTimeout(drain); resolve({code, exitSignal}); });
      });
      if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
      if (timeout !== undefined) timer = setTimeout(() => { timedOut = true; cancel(); }, timeout * 1000);
      const result = await exit;
      if (cancellationError) throw cancellationError;
      if ((signal?.aborted || timedOut) && result.code !== 130) throw new Error(`Windows shell cancellation was not acknowledged (exit ${result.code ?? result.exitSignal})`);
      if (signal?.aborted) throw new Error('aborted');
      if (timedOut) throw new Error(`timeout:${timeout}`);
      return { exitCode: result.code ?? 1 };
    } finally {
      signal?.removeEventListener('abort', cancel);
      clearTimeout(timer); clearTimeout(forceTimer);
      // root was freshly created here and is never derived from the workspace.
      rmSync(root, { recursive: true, force: true });
    }
  } };
}

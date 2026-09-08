import { fileURLToPath } from 'node:url';
import { resolveManagedToolInvocation } from './managed-tool-invocation.mjs';
import { createWindowsShellOperations } from './windows-shell-operations.mjs';

export function registerManagedWindowsShellTools(pi, sdk) {
  if (process.platform !== 'win32' || process.env.COOP_DESKTOP_MANAGED_RUNTIME !== '1') return;
  // Reuse the relocated, bounded Python resolution required by managed tools.
  const { command: python } = resolveManagedToolInvocation('coop-data-doc', []);
  const helper = fileURLToPath(new URL('./windows-shell-job.py', import.meta.url));
  const { createBashToolDefinition, createPowerShellToolDefinition, getShellConfig, getPowerShellConfig } = sdk;
  for (const [factory, resolveShellConfig, prefix] of [
    [createBashToolDefinition, getShellConfig, ''],
    [createPowerShellToolDefinition, getPowerShellConfig, "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n"],
  ]) {
    const operations = createWindowsShellOperations({ python, helper, resolveShellConfig, prefix });
    pi.registerTool({
      ...factory(process.cwd(), { operations }),
      execute(id, params, signal, onUpdate, ctx) {
        return factory(ctx.cwd, { operations }).execute(id, params, signal, onUpdate, ctx);
      },
    });
  }
}

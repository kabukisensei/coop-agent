import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const commands = new Set(["coop-data-doc", "coop-sql-review", "coop-dax-review", "fab"]);

// A packaged invocation must never select a workstation's same-named .exe or
// pass arbitrary arguments through cmd.exe. The staged Python entrypoint knows
// its own private site-packages directory and works unchanged after relocation.
export function resolveManagedToolInvocation(command, args, env = process.env, platform = process.platform) {
  if (env.COOP_DESKTOP_MANAGED_RUNTIME !== "1" || !commands.has(command)) return null;
  if (!isAbsolute(env.COOP_ROOT || "")) throw new Error("Managed Coop root is unavailable.");
  const coop = realpathSync(env.COOP_ROOT), root = dirname(coop);
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const pythonPath = platform === "win32" ? "python/runtime/python.exe" : "python/runtime/bin/python3";
  if (manifest.schemaVersion !== 1 || manifest.target?.platform !== platform || manifest.paths?.coopRoot !== "coop"
    || manifest.paths.python !== pythonPath || !manifest.paths.pythonCommands?.includes(command)
    || realpathSync(join(root, "coop")) !== coop) throw new Error("Managed Python tool contract is invalid.");
  const checked = path => {
    const actual = realpathSync(path), rel = relative(root, actual), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Managed Python tool escapes its bundle.");
    return actual;
  };
  return { command: checked(join(root, pythonPath)), args: ["-I", checked(join(root, "python", "entrypoints", `${command}.py`)), ...args] };
}

export function execCoopTool(pi, command, args, options) {
  const invocation = resolveManagedToolInvocation(command, args);
  return pi.exec(invocation?.command || command, invocation?.args || args, options);
}

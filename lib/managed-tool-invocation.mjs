import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";

import { dirname, isAbsolute, join, relative, sep } from "node:path";

const commands = new Set(["coop-data-doc", "coop-sql-review", "coop-dax-review", "fab"]);

// Managed tools use their relocated private Python entrypoint directly. No
// workstation executable or command shell may reinterpret their arguments.
export function resolveManagedToolInvocation(command, args, env = process.env, platform = process.platform) {
  if (env.COOP_DESKTOP_MANAGED_RUNTIME !== "1" || !commands.has(command)) return null;
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Managed tool arguments are invalid.");
  if (!isAbsolute(env.COOP_ROOT || "")) throw new Error("Managed Coop root is unavailable.");
  const coop = realpathSync(env.COOP_ROOT), root = dirname(coop);
  if (!statSync(coop).isDirectory()) throw new Error("Managed Coop root must be a directory.");
  const manifestPath = join(root, "manifest.json"), manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 65536) throw new Error("Managed tool manifest is invalid.");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const pythonPath = platform === "win32" ? "python/runtime/python.exe" : "python/runtime/bin/python3";
  if (!["win32", "darwin"].includes(platform) || manifest.schemaVersion !== 1 || manifest.target?.platform !== platform || manifest.paths?.coopRoot !== "coop"
    || manifest.paths.python !== pythonPath || !Array.isArray(manifest.paths.pythonCommands) || !manifest.paths.pythonCommands.includes(command)
    || realpathSync(join(root, "coop")) !== coop) throw new Error("Managed Python tool contract is invalid.");
  const checked = (path, allowLink = false) => {
    const actual = realpathSync(path), rel = relative(root, actual), stat = lstatSync(path);
    if ((!allowLink && stat.isSymbolicLink()) || !statSync(actual).isFile() || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Managed Python tool escapes its bundle or is not a regular file.");
    return actual;
  };
  // The Mac runtime's python3 -> python3.12 link is legitimate inside the bundle.
  // -I excludes host Python configuration; -B keeps signed resources immutable;
  // -X utf8 preserves Unicode over Windows pipes even with Python env ignored.
  return { command: checked(join(root, pythonPath), true), args: ["-I", "-B", "-X", "utf8", checked(join(root, "python", "entrypoints", `${command}.py`)), ...args] };

}

export function execCoopTool(pi, command, args, options) {
  const invocation = resolveManagedToolInvocation(command, args);
  return pi.exec(invocation?.command || command, invocation?.args || args, options);
}

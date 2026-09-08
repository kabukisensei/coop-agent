import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// Exercise the dependency's own discovery and file executor with only bundled
// runtimes plus OS utilities on PATH. No model, credentials or host Python.
export function verifyManagedContextWork(bundle) {
  const root = mkdtempSync(join(tmpdir(), "coop-context-work-"));
  try {
    writeFileSync(join(root, "numbers.txt"), "2\n4\n6\n");
    const env = {
      PATH: [...bundle.executableDirs, ...(process.platform === "win32"
        ? [join(process.env.SystemRoot || "C:\\Windows", "System32")]
        : ["/usr/bin", "/bin"])].join(delimiter),
      HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
      TEMP: root, TMP: root, TMPDIR: root, PYTHONDONTWRITEBYTECODE: "1",
    };
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];
    const executorUrl = pathToFileURL(join(bundle.root, "npm/node_modules/context-mode/build/executor.js")).href;
    const code = `import { PolyglotExecutor } from ${JSON.stringify(executorUrl)};
const executor = new PolyglotExecutor({ projectRoot: process.cwd() });
const result = await executor.executeFile({ path: 'numbers.txt', language: 'python',
code: 'import json, sys\\nprint(json.dumps({"executable": sys.executable, "total": sum(map(int, FILE_CONTENT.split()))}))', timeout: 10000 });
if (result.exitCode !== 0) throw new Error(JSON.stringify(result));
console.log(result.stdout);`;
    const result = spawnSync(bundle.node, ["--input-type=module", "-e", code], {
      cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 60000,
    });
    assert.equal(result.status, 0, `Context Python execution failed: ${result.error || result.stderr}`);
    const work = JSON.parse(result.stdout);
    assert.equal(work.total, 12);
    const normalize = path => process.platform === "win32" ? realpathSync(path).toLowerCase() : realpathSync(path);
    assert.equal(normalize(work.executable), normalize(bundle.python), "Context tool must use bundled Python");
    return { passed: true, executable: work.executable, total: work.total };
  } finally {
    // root is the fresh directory created above, never a caller supplied path.
    rmSync(root, { recursive: true, force: true });
  }
}

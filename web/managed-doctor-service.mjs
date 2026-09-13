import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Managed dependencies belong to the app. Probing global pipx/npm environments
// both reports the wrong installation and suggests repairs outside that app.
export async function runManagedDoctor({ root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), env = process.env, inspect, probe = probeExecutable } = {}) {
  const runtimeRoot = resolve(root, "..");
  const inspectRuntime = inspect || (await import(pathToFileURL(join(runtimeRoot, "lib/desktop-inspection/managed-runtime.mjs")).href)).inspectManagedRuntime;
  const managed = inspectRuntime(runtimeRoot);
  const checks = [];
  const add = (status, name, hint = "") => checks.push({ section: "Managed runtime", status, name, hint });
  add("ok", "Managed runtime manifest, dependency inventory and release pins verified");
  for (const [name, version] of Object.entries(managed.versions.npmPackages)) add("ok", `${name} ${version} (bundled package metadata)`);
  const jobs = [
    { name: "Node executable", command: managed.node, args: ["--version"], expected: managed.versions.node },
    { name: "Python executable", command: managed.python, args: ["--version"], expected: managed.versions.python },
  ];
  const modules = { "coop-data-doc": "coop_data_doc.cli", "coop-sql-review": "coop_sql_review.cli", "coop-dax-review": "coop_dax_review.cli", "ms-fabric-cli": "fabric_cli", "fabric-cicd": "fabric_cicd" };
  for (const [name, module] of Object.entries(modules)) {
    jobs.push({ name: `${name} import`, command: managed.python, args: ["-c", `import importlib; importlib.import_module('${module}'); print('import-ok')`],
      env: { ...env, PYTHONPATH: managed.pythonToolRoots[name], PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" }, expected: "import-ok" });
  }
  const results = await Promise.all(jobs.map(async (job) => {
    try {
      const result = await probe(job.command, job.args, { env: job.env || env, cwd: runtimeRoot, timeoutMs: 45_000 });
      return result.code === 0 && result.stdout.includes(job.expected) ? { status: "ok", name: `${job.name} passed` } : { status: "fail", name: `${job.name} failed` };
    } catch (error) { return { status: "fail", name: `${job.name}: ${error.message}` }; }
  }));
  for (const result of results) add(result.status, result.name, result.status === "fail" ? "Repair the managed Desktop installation; do not change global pipx or npm tools." : "");
  return { checks, fail: checks.filter((check) => check.status === "fail").length, warn: 0 };
}

function probeExecutable(command, args, { env, cwd, timeoutMs }) {
  return new Promise((resolveProbe, reject) => {
    const child = spawn(command, args, { env, cwd, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let finished = false;
    const finish = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolveProbe(value); };
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString("utf8")).slice(-65536); });
    child.stderr.resume();
    const timer = setTimeout(() => { child.kill(); finish(new Error("probe timed out")); }, timeoutMs);
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(null, { code, stdout }));
  });
}

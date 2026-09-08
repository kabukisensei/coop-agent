import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") console.log("  Windows job-object probes run on native Windows.");
else {
  const root = mkdtempSync(join(tmpdir(), "coop-health-job-"));
  const python = process.env.PYTHON || "python";
  const helper = fileURLToPath(new URL("../desktop/src/update-windows-job.py", import.meta.url));
  const fixture = join(root, "child & café.mjs");
  writeFileSync(fixture, `import { spawn } from 'node:child_process';import {writeFileSync} from 'node:fs';
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true});
    child.unref();writeFileSync(process.argv[2],JSON.stringify({pid:child.pid,text:process.argv[4]}));
    if(process.argv[3]==='hang')setInterval(()=>{},1000);else process.exit(process.argv[3]==='crash'?7:0);`);
  const stopped = pid => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; } };
  try {
    for (const mode of ["healthy", "crash", "hang"]) {
      const receipt = join(root, mode + ".json"), quoted = 'spaces & café 中文 "quoted"';
      const child = spawn(python, ["-I", "-B", helper, process.execPath, fixture, receipt, mode, quoted], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = ""; child.stderr.on("data", value => { stderr += value; });
      const closed = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", code => resolve(code)); });
      const timeout = setTimeout(() => child.kill(), 15000);
      try {
        const deadline = Date.now() + 10000;
        while (!existsSync(receipt) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        assert.ok(existsSync(receipt), stderr || "child did not start");
        const value = JSON.parse(readFileSync(receipt, "utf8"));
        assert.equal(value.text, quoted, "Windows argument quoting");
        if (mode === "hang") child.kill();
        const code = await closed;
        if (mode !== "hang") assert.equal(code, mode === "healthy" ? 0 : 7, stderr);
        const exitDeadline = Date.now() + 3000;
        while (!stopped(value.pid) && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(stopped(value.pid), true, `${mode} orphaned a descendant`);
        console.log(`  ✓ Windows health job reaps descendants after ${mode} and preserves Unicode arguments`);
      } finally { clearTimeout(timeout); child.kill(); await closed; }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

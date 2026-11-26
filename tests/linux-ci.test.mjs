// The Linux personal edition's CI gate (master plan row LX1): ci.yml carries a
// `linux` job on a pinned ubuntu image that runs a real install / doctor /
// launch-spec / uninstall against a sandbox HOME, with their exit codes checked,
// and the guardrails through the pinned Pi's own extension runner; the gate
// needs it. The PowerShell suite runs on Linux in the `tests` job.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8").replace(/\r\n/g, "\n");
const jobs = ci.split(/^  (?=[a-z-]+:\s*$)/m);
const linux = jobs.find((job) => job.startsWith("linux:"));
const gate = jobs.find((job) => job.startsWith("gate:"));
const tests = jobs.find((job) => job.startsWith("tests:"));

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

t("ci.yml has a linux job on the pinned ubuntu-24.04 image", () => {
  assert.ok(linux, "ci.yml has a linux job");
  assert.match(linux, /runs-on: ubuntu-24\.04\n/);
  assert.doesNotMatch(linux, /ubuntu-latest/);
});
t("every action in the linux job is pinned by commit SHA", () => {
  const uses = [...linux.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 3);
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
});
t("the linux job runs install --yes, doctor --json, launch-spec --json and uninstall, not the suite the tests job runs", () => {
  assert.doesNotMatch(linux, /-File tests\/run\.ps1/, "tests/run.ps1 already runs under pwsh 7 on Linux in the tests job");
  assert.match(tests, /tests\/run\.ps1/);
  assert.match(tests, /runs-on: ubuntu-/);
  assert.match(linux, /bin\/coop install --yes .*install_rc=\$\?/);
  assert.match(linux, /bin\/coop doctor --json .*doctor_rc=\$\?/);
  assert.doesNotMatch(linux, /bin\/coop doctor >/, "install already ends with doctor; no second plain doctor run");
  assert.match(linux, /bin\/coop launch-spec --json /);
  assert.match(linux, /bin\/coop uninstall --yes .*rc=\$\?/);
  assert.doesNotMatch(linux, /\|\| true/, "no exit code is discarded");
});
t("the linux job checks exit codes, the link target, PATH, and PowerShell error lines", () => {
  assert.match(linux, /if doctor_rc != want_doctor/);
  assert.match(linux, /install_rc == 1 and odbc_only/, "install may exit 1 only for the ODBC/pyodbc row");
  assert.match(linux, /startswith\("Fabric SQL fallback"\)/, "only the ODBC/pyodbc doctor row may be red");
  assert.match(linux, /"checks" in obj/);
  assert.match(linux, /not doc\["checks"\]/);
  assert.match(linux, /readlink -f "\$HOME\/\.local\/bin\/coop"/);
  assert.match(linux, /coop version\)/);
  assert.match(linux, /test "\$rc" -eq 0/);
  assert.match(linux, /\$HOME\/\.coop\/agent/);
  for (const pattern of ["Exception", "Cannot bind", "is not recognized", "CategoryInfo", "InvalidOperation"]) assert.ok(linux.split(pattern).length >= 3, pattern);
  assert.doesNotMatch(linux, /"Exception" in text|grep -q Exception/, "no bare-word Exception check");
});
t("the linux job pins pipx, caches npm and pip, and checks out shallow", () => {
  assert.match(linux, /pipx==\d+\.\d+\.\d+/);
  assert.match(linux, /cache: npm/);
  assert.match(linux, /cache: pip/);
  assert.doesNotMatch(linux, /fetch-depth: 0/);
});
t("the linux job runs the guardrails against the Pi install put in the sandbox", () => {
  assert.match(linux, /node tests\/guardrails-pi-runner\.test\.mjs "\$NPM_CONFIG_PREFIX\/lib\/node_modules\/@earendil-works\/pi-coding-agent"/);
});
t("the gate needs the linux job and fails unless it succeeded", () => {
  assert.match(gate, /needs: \[[^\]]*\blinux\b/);
  assert.match(gate, /"linux=\$LINUX_RESULT"/);
});
console.log(`✓ linux CI job (${n} checks)`);

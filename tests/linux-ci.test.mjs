// The Linux personal edition's CI gate (master plan row LX1): ci.yml carries a
// `linux` job on a pinned ubuntu image that runs the PowerShell suite, a real
// install / doctor / launch-spec / uninstall against a sandbox HOME, and the
// guardrails through the pinned Pi's own extension runner; the gate needs it.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8").replace(/\r\n/g, "\n");
const jobs = ci.split(/^  (?=[a-z-]+:\s*$)/m);
const linux = jobs.find((job) => job.startsWith("linux:"));
const gate = jobs.find((job) => job.startsWith("gate:"));

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
t("the linux job runs the PowerShell gate lane, install --yes, doctor, launch-spec --json and uninstall", () => {
  assert.match(linux, /pwsh -NoProfile -File tests\/run\.ps1/);
  assert.match(linux, /bin\/coop install --yes /);
  assert.match(linux, /bin\/coop doctor /);
  assert.match(linux, /bin\/coop launch-spec --json /);
  assert.match(linux, /bin\/coop uninstall --yes /);
  assert.match(linux, /"Exception" in text/, "a PowerShell exception in the output fails the job");
  assert.match(linux, /startswith\("Fabric SQL fallback"\)/, "only the ODBC/pyodbc doctor row may be red");
});
t("the linux job runs the guardrails against the Pi install put in the sandbox", () => {
  assert.match(linux, /node tests\/guardrails-pi-runner\.test\.mjs "\$NPM_CONFIG_PREFIX\/lib\/node_modules\/@earendil-works\/pi-coding-agent"/);
});
t("the gate needs the linux job and fails unless it succeeded", () => {
  assert.match(gate, /needs: \[[^\]]*\blinux\b/);
  assert.match(gate, /"linux=\$LINUX_RESULT"/);
});
console.log(`✓ linux CI job (${n} checks)`);

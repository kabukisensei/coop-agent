// Client instructions (CW1, fix round B5) on an installed Pi: what /new does to the
// client_rules tool and the /correct command. Pi builds a new runtime for /new
// (AgentSessionRuntime.newSession -> createRuntime -> a new DefaultResourceLoader),
// and its extension loader imports each extension with moduleCache:false and calls
// its factory again. So the tool and the command follow the switch after /new, as
// the "takes effect after /new" wording says. This test drives Pi's own loader
// (loadExtensions) the way each new runtime does, with the switch flipped between
// two loads of the real coop-tools source. Offline, sandbox home only.
//   node tests/client-rules-pi-reload.test.mjs /absolute/path/to/pi-coding-agent
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const piRoot = process.argv[2];
assert.ok(piRoot && isAbsolute(piRoot), "supply the installed Pi package root explicitly");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "coop-cw1-pi-")));
const home = join(scratch, "home");
mkdirSync(join(home, ".coop"), { recursive: true });
for (const k of ["HOME", "USERPROFILE", "COOP_DIR"]) process.env[k] = home;
process.env.PI_CODING_AGENT_DIR = join(home, ".coop", "agent");
process.env.COOP_ROOT = root;
process.env.JITI_FS_CACHE = join(scratch, "jiti"); // never a cache inside the Pi install
delete process.env.COOP_FIRST_RUN;
const config = join(home, ".coop", "config");
const setSwitch = (on) => writeFileSync(config, JSON.stringify({ schema_version: 1, features: { instructions: on } }));
const version = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version;
const { loadExtensions } = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
const ext = join(root, "extensions", "coop-tools", "index.ts");

const load = async () => {
  const result = await loadExtensions([ext], scratch);
  assert.deepEqual(result.errors, [], JSON.stringify(result.errors));
  const [e] = result.extensions;
  return { tools: [...e.tools.keys()], commands: [...e.commands.keys()] };
};

let n = 0;
try {
  setSwitch(false);
  const first = await load();
  assert.equal(first.tools.includes("client_rules"), false);
  assert.equal(first.commands.includes("correct"), false);
  n++; console.log(`  ✓ Pi ${version}: loaded with the switch off, coop-tools has no client_rules and no /correct`);
  setSwitch(true);
  const second = await load();
  assert.ok(second.tools.includes("client_rules"), second.tools.join(","));
  assert.ok(second.commands.includes("correct"), second.commands.join(","));
  n++; console.log(`  ✓ Pi ${version}: the next runtime's load (what /new builds) has both once the switch is on`);
  setSwitch(false);
  const third = await load();
  assert.equal(third.tools.includes("client_rules"), false);
  assert.equal(third.commands.includes("correct"), false);
  n++; console.log(`  ✓ Pi ${version}: and neither after it is turned off again`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`✓ client instructions across /new on Pi ${version}: ${n} checks`);

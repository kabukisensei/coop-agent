// One profile root (master plan S3, issue #220): lib/paths.mjs and the Node/TS
// readers that go through it resolve the profile locations from ONE meaning of
// the variables.
//   COOP_DIR is the PARENT of .coop: profileDir() = $COOP_DIR/.coop (default
//   ~/.coop); configPath() / userProfilePath() hang off it.
//   The agent dir is one chain: PI_CODING_AGENT_DIR -> COOP_NO_ISOLATE truthy
//   (1|true|yes|on, any case) -> ~/.pi/agent -> COOP_AGENT_DIR -> <profile>/agent.
// Mirrors tests/fixtures/profile-root.test.ps1 and tests/coop-paths.test.py.
// Pure: the helpers take an env object, so nothing on disk is read; the bundled
// extensions (COOP_TEST_DIST, when present) are checked through process.env.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { agentDir, configPath, coopAgentDir, noIsolate, personalPiAgentDir, profileDir, userProfilePath } =
  await import("../lib/paths.mjs");

const home = homedir();
const cdir = join("/tmp", "coop-paths-test", "cdir");
const agent = join("/tmp", "coop-paths-test", "agent");
const pidir = join("/tmp", "coop-paths-test", "pidir");
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

t("no vars: ~/.coop/{config,user.json,agent}, isolation on", () => {
  const env = {};
  assert.equal(profileDir(env), join(home, ".coop"));
  assert.equal(configPath(env), join(home, ".coop", "config"));
  assert.equal(userProfilePath(env), join(home, ".coop", "user.json"));
  assert.equal(coopAgentDir(env), join(home, ".coop", "agent"));
  assert.equal(agentDir(env), join(home, ".coop", "agent"));
  assert.equal(personalPiAgentDir(), join(home, ".pi", "agent"));
  assert.equal(noIsolate(env), false);
});

t("COOP_DIR=X: X/.coop/{config,user.json,agent} (X is the parent of .coop)", () => {
  const env = { COOP_DIR: cdir };
  assert.equal(profileDir(env), join(cdir, ".coop"));
  assert.equal(configPath(env), join(cdir, ".coop", "config"));
  assert.equal(userProfilePath(env), join(cdir, ".coop", "user.json"));
  assert.equal(agentDir(env), join(cdir, ".coop", "agent"));
  assert.equal(profileDir({ COOP_DIR: "  " }), join(home, ".coop"), "blank COOP_DIR means unset");
});

t("COOP_AGENT_DIR only: agent dir moves, profile dir stays; it beats COOP_DIR/.coop/agent", () => {
  assert.equal(coopAgentDir({ COOP_AGENT_DIR: agent }), agent);
  assert.equal(agentDir({ COOP_AGENT_DIR: agent }), agent);
  assert.equal(profileDir({ COOP_AGENT_DIR: agent }), join(home, ".coop"));
  assert.equal(agentDir({ COOP_DIR: cdir, COOP_AGENT_DIR: agent }), agent);
});

t("PI_CODING_AGENT_DIR wins over NO_ISOLATE, COOP_AGENT_DIR and COOP_DIR", () => {
  const env = { COOP_DIR: cdir, COOP_AGENT_DIR: agent, PI_CODING_AGENT_DIR: pidir, COOP_NO_ISOLATE: "1" };
  assert.equal(agentDir(env), pidir);
  assert.equal(coopAgentDir(env), agent, "the isolated dir itself is unchanged");
});

t("COOP_NO_ISOLATE=1|true|yes|on (any case) -> ~/.pi/agent; anything else keeps isolation", () => {
  for (const v of ["1", "true", "TRUE", "Yes", "on", " On "]) {
    assert.equal(noIsolate({ COOP_NO_ISOLATE: v }), true, v);
    assert.equal(agentDir({ COOP_NO_ISOLATE: v, COOP_AGENT_DIR: agent }), join(home, ".pi", "agent"), v);
  }
  for (const v of ["0", "false", "no", "off", "yes please", ""]) {
    assert.equal(noIsolate({ COOP_NO_ISOLATE: v }), false, v);
    assert.equal(agentDir({ COOP_NO_ISOLATE: v, COOP_AGENT_DIR: agent }), agent, v);
  }
});

// --- the bundled extensions read through the same helper ---------------------
const dist = process.env.COOP_TEST_DIST || "";
const toolsPath = join(dist, "coop-tools.mjs");
if (dist && existsSync(toolsPath)) {
  const saved = {};
  for (const k of ["COOP_DIR", "COOP_AGENT_DIR", "PI_CODING_AGENT_DIR", "COOP_NO_ISOLATE"]) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    const { modelLoginAuthPath } = await import(pathToFileURL(toolsPath).href);
    t("coop-tools modelLoginAuthPath follows the one agent-dir chain", () => {
      assert.equal(modelLoginAuthPath(), join(home, ".coop", "agent", "auth.json"));
      process.env.COOP_DIR = cdir;
      assert.equal(modelLoginAuthPath(), join(cdir, ".coop", "agent", "auth.json"));
      process.env.COOP_AGENT_DIR = agent;
      assert.equal(modelLoginAuthPath(), join(agent, "auth.json"));
      process.env.COOP_NO_ISOLATE = "true";
      assert.equal(modelLoginAuthPath(), join(home, ".pi", "agent", "auth.json"));
      process.env.PI_CODING_AGENT_DIR = pidir;
      assert.equal(modelLoginAuthPath(), join(pidir, "auth.json"));
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
} else {
  console.log("  - bundled coop-tools not present (COOP_TEST_DIST); extension chain check skipped");
}

console.log(`  ${n} paths tests passed`);

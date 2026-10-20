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

const { agentDir, configPath, coopAgentDir, machineProfileDir, machineProfilePath, noIsolate, personalPiAgentDir, profileDir, userProfilePath } =
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

t("machine profile (P1): COOP_MACHINE_DIR, else %ProgramData%\\coop on Windows, else /etc/coop", () => {
  assert.equal(machineProfileDir({ COOP_MACHINE_DIR: cdir }, "win32"), cdir);
  assert.equal(machineProfilePath({ COOP_MACHINE_DIR: cdir }, "linux"), join(cdir, "user.json"));
  assert.equal(machineProfileDir({ ProgramData: "D:\\PD" }, "win32"), join("D:\\PD", "coop"));
  assert.equal(machineProfileDir({}, "win32"), join("C:\\ProgramData", "coop"));
  assert.equal(machineProfileDir({}, "linux"), "/etc/coop");
  assert.equal(machineProfilePath({}, "darwin"), join("/etc/coop", "user.json"));
  assert.notEqual(machineProfilePath({ COOP_DIR: cdir }), userProfilePath({ COOP_DIR: cdir }), "COOP_DIR never moves the machine file");
});

// --- file tiers (F2): this machine, this client, the repository ---------------
const { backupDirFor, backupPathFor, backupTimestamp, canonicalStandardsRoot, draftsDirFor, folderPlaces, listDraftFiles, repositoryCoopDir, repositoryNameFor, standardsLocation, standardsRoot, standardsSnapshotRoot } =
  await import("../lib/paths.mjs");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const tiers = mkdtempSync(join(tmpdir(), "coop-paths-tiers-"));
const yes = () => true, no = () => false;

t("standards: COOP_STANDARDS_ROOT names the canonical checkout (root is its parent), else the machine folder when writable, else this client", () => {
  const override = join(tiers, "ovr", "canonical");
  assert.deepEqual(standardsLocation({ COOP_STANDARDS_ROOT: override }, "linux", no), { root: join(tiers, "ovr"), tier: "override" });
  assert.equal(canonicalStandardsRoot({ COOP_STANDARDS_ROOT: override }, "linux", no), override);
  assert.deepEqual(standardsLocation({ COOP_MACHINE_DIR: cdir, COOP_DIR: cdir }, "linux", yes), { root: join(cdir, "standards"), tier: "machine" });
  assert.deepEqual(standardsLocation({ COOP_MACHINE_DIR: cdir, COOP_DIR: cdir }, "linux", no), { root: join(cdir, ".coop", "standards"), tier: "client" });
  assert.equal(standardsRoot({ COOP_DIR: cdir }, "linux", no), join(cdir, ".coop", "standards"), "no variables: the place before F2");
  assert.equal(canonicalStandardsRoot({ COOP_MACHINE_DIR: cdir }, "linux", yes), join(cdir, "standards", "canonical"));
  assert.equal(standardsSnapshotRoot({ COOP_MACHINE_DIR: cdir }, "linux", yes), join(cdir, "standards", "snapshots"));
  assert.equal(standardsSnapshotRoot({ COOP_STANDARDS_SNAPSHOT_ROOT: join(tiers, "snaps") }, "linux", yes), join(tiers, "snaps"));
  // The real probe: an existing writable folder is the machine tier; a missing one is not.
  const machine = join(tiers, "machine-real");
  assert.equal(standardsLocation({ COOP_MACHINE_DIR: machine, COOP_DIR: cdir }, "linux").tier, "client", "no <machine dir>/standards yet");
  mkdirSync(join(machine, "standards"), { recursive: true });
  assert.equal(standardsLocation({ COOP_MACHINE_DIR: machine, COOP_DIR: cdir }, "linux").root, join(machine, "standards"));
});

t("backups and drafts: <profile dir>/{backups,drafts}/<repository>, the repository named by the project file else its folder", () => {
  const client = join(tiers, "client");
  const repo = join(client, "acme-sql");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "sql", "dbo"), { recursive: true });
  writeFileSync(join(repo, "sql", "dbo", "v.sql"), "SELECT 1");
  const env = { COOP_DIR: cdir };
  assert.equal(repositoryNameFor(join(repo, "sql", "dbo", "v.sql"), env), "acme-sql");
  assert.equal(backupDirFor(join(repo, "sql", "dbo", "v.sql"), env), join(cdir, ".coop", "backups", "acme-sql"));
  assert.equal(draftsDirFor(repo, env), join(cdir, ".coop", "drafts", "acme-sql"));
  const when = new Date(2026, 9, 20, 14, 5, 9);
  assert.equal(backupTimestamp(when), "20261020_140509");
  assert.equal(backupPathFor(join(repo, "sql", "dbo", "v.sql"), env, when), join(cdir, ".coop", "backups", "acme-sql", "sql", "dbo", "v.sql.20261020_140509.bak"));
  // The home repository beside it lists the repository under another key: that key wins.
  const home = join(client, "acme-coop");
  mkdirSync(join(home, ".coop"), { recursive: true });
  writeFileSync(join(home, ".coop", "project.yml"), "profile:\n  client: Acme\nrepositories:\n  sql:\n    local_path: ../acme-sql\n  home:\n    local_path: .\n");
  assert.equal(repositoryNameFor(join(repo, "sql", "dbo", "v.sql"), { ...env, COOP_PROJECT_YML: join(home, ".coop", "project.yml") }), "sql");
  assert.equal(backupDirFor(repo, { ...env, COOP_PROJECT_YML: join(home, ".coop", "project.yml") }), join(cdir, ".coop", "backups", "sql"));
  // A folder in no repository: its own name.
  mkdirSync(join(tiers, "loose"), { recursive: true });
  assert.equal(repositoryNameFor(join(tiers, "loose", "notes.md"), env), "loose");
  // The repository's .coop: the project file's folder, else <git root>/.coop.
  assert.equal(repositoryCoopDir(join(repo, "sql"), env), join(repo, ".coop"));
  assert.equal(repositoryCoopDir(join(repo, "sql"), { ...env, COOP_PROJECT_YML: join(home, ".coop", "project.yml") }), join(home, ".coop"));
  assert.equal(repositoryCoopDir(home, env), join(home, ".coop"));
  const places = folderPlaces(join(repo, "sql"), { ...env, COOP_MACHINE_DIR: cdir, COOP_PROJECT_YML: join(home, ".coop", "project.yml") }, "linux", no);
  assert.deepEqual(places, { machine: cdir, client: join(cdir, ".coop"), repository: join(home, ".coop"), standards: join(cdir, ".coop", "standards"), standardsTier: "client", backups: join(cdir, ".coop", "backups", "sql"), drafts: join(cdir, ".coop", "drafts", "sql") });
});

t("drafts listing: newest first, relative paths, dot files skipped, missing folder empty", () => {
  const drafts = join(tiers, "drafts");
  assert.deepEqual(listDraftFiles(drafts), []);
  mkdirSync(join(drafts, "proposals"), { recursive: true });
  writeFileSync(join(drafts, "old.sql"), "SELECT 1");
  writeFileSync(join(drafts, "proposals", "new.sql"), "SELECT 2");
  writeFileSync(join(drafts, ".hidden"), "");
  utimesSync(join(drafts, "old.sql"), new Date(2026, 0, 1), new Date(2026, 0, 1));
  utimesSync(join(drafts, "proposals", "new.sql"), new Date(2026, 5, 1), new Date(2026, 5, 1));
  assert.deepEqual(listDraftFiles(drafts).map((d) => d.path), ["proposals/new.sql", "old.sql"]);
  assert.equal(listDraftFiles(drafts, 1).length, 1);
});

rmSync(tiers, { recursive: true, force: true });

console.log(`  ${n} paths tests passed`);

// The Features list and the one ~/.coop/config writer (lib/features.mjs,
// FEATURES-DESIGN "Shared piece: one Features list"): the five rows with their
// plain labels, off unless the file says true, a round trip that keeps every
// other key, a BOM file, an unparseable file left alone, the lock, two writers
// at once (in-process and the CLI the window and `coop settings` use), and
// /sql-source writing through the same writer.
//
// Run: node --test tests/features.test.mjs (tests/run.sh runs it in the gate lane).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "lib", "features.mjs");
// Hermetic: the default config path resolves inside a temp folder, never the real home.
const HOME = mkdtempSync(join(tmpdir(), "coop-features-"));
process.env.COOP_DIR = HOME;
const lib = await import("../lib/features.mjs");
const TEMPS = [HOME];
after(() => { for (const dir of TEMPS) rmSync(dir, { recursive: true, force: true }); });
const sqlsc = await import("../lib/sqlsc.mjs");

let n = 0;
/** A fresh config file path in its own folder. */
function fresh(text) {
  const dir = join(HOME, `case-${++n}`, ".coop");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config");
  if (text !== undefined) writeFileSync(file, text);
  return file;
}
const read = (file) => JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
const runCli = (args, coopDir) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, COOP_DIR: coopDir } });

test("the Features list: five rows, plain labels, CLI keys and stored keys exactly as designed", () => {
  assert.deepEqual(lib.FEATURES.map((f) => [f.label, f.key, f.path.join("."), f.help]), [
    ["Client instructions", "instructions", "features.instructions", "Follow the client's saved instructions and corrections"],
    ["Change history", "history", "features.history", "Keep a private log of coop's file edits, with restore"],
    ["Diff review comments", "comments", "features.comments", "Comment on lines in Changes and send them as one batch"],
    ["Daily lineage refresh", "docs-refresh", "features.docs_refresh", "Refresh the dev lineage docs once a day, in the background"],
    ["SQL source control", "sql-source", "sql_source_control.enabled", "Check out, script and commit SQL with approval"],
  ]);
  assert.deepEqual(lib.FEATURES.map((f) => f.takesEffect), ["after /new", "after /new", "at once", "at the next sign-in or coop start", "after /new"]);
  // Built so far: Client instructions (CW1), Change history (CW2), the comments (CW3) and the existing SQL source control switch.
  assert.deepEqual(lib.FEATURES.filter((f) => f.available).map((f) => f.key), ["instructions", "history", "comments", "sql-source"]);
});

test("absent keys and an absent file are off; only a literal true is on", () => {
  const none = fresh();
  const list = lib.listFeatures({ file: none });
  assert.equal(list.ok, true);
  assert.ok(list.features.every((f) => f.on === false), "no file: every feature off");
  assert.equal(list.cleanup.days, 45);
  assert.equal(lib.featuresOnLine(list), "", "nothing on: no session-start line");
  for (const value of ['"true"', "1", '"yes"', "null", "{}"]) {
    const file = fresh(`{"features":{"comments":${value}},"sql_source_control":{"enabled":${value}}}`);
    assert.equal(lib.featureEnabled("comments", file), false, `comments ${value} is off`);
    assert.equal(sqlsc.sqlSourceEnabled(file), false, `sql-source ${value} is off`);
  }
  // Daily lineage refresh (CW6) is built: true in the file turns it on like the others.
  const hand = fresh('{"features":{"docs_refresh":true,"comments":true}}');
  assert.equal(lib.featureEnabled("docs-refresh", hand), true);
  assert.equal(lib.featureEnabled("comments", hand), true);
  assert.equal(lib.featuresOnLine(lib.listFeatures({ file: hand })), "Features on for this client: Diff review comments, Daily lineage refresh.");
  assert.ok(lib.FEATURES.every((f) => f.available), "every listed feature is in this version");
});

test("a round trip keeps every other key, in order", () => {
  const file = fresh(JSON.stringify({ schema_version: 1, client: { platform: "fabric" }, knowledge: { enabled: true, repos: [{ url: "u" }] }, cleanup: { days: 30 }, features: { other: "kept" }, sql_source_control: { enabled: false, note: "kept" } }));
  assert.equal(lib.setFeature("comments", true, { file }), true);
  assert.equal(lib.setFeature("sql-source", true, { file, now: new Date("2026-11-26T08:00:00Z") }), true);
  const data = read(file);
  assert.deepEqual(Object.keys(data), ["schema_version", "client", "knowledge", "cleanup", "features", "sql_source_control"]);
  assert.deepEqual(data.client, { platform: "fabric" });
  assert.deepEqual(data.knowledge, { enabled: true, repos: [{ url: "u" }] });
  assert.deepEqual(data.cleanup, { days: 30 });
  assert.deepEqual(data.features, { other: "kept", comments: true });
  assert.deepEqual(data.sql_source_control, { enabled: true, note: "kept", changed_at: "2026-11-26T08:00:00.000Z" });
  assert.equal(lib.setFeature("comments", false, { file }), false);
  assert.equal(read(file).features.comments, false);
  assert.equal(lib.setCleanupDays(0, { file }), 0);
  assert.deepEqual(read(file).cleanup, { days: 0 });
  assert.equal(read(file).client.platform, "fabric");
  assert.ok(!readdirSync(dirname(file)).some((name) => name.includes(".tmp-") || name === "config.lock"), "no temp or lock file is left");
});

test("a BOM-prefixed file (Windows PowerShell 5.1) is read and rewritten", () => {
  const file = fresh("﻿" + JSON.stringify({ client: { platform: "azure_sql" }, features: { comments: true } }, null, 2));
  assert.equal(lib.readCoopConfig(file).ok, true);
  assert.equal(lib.featureEnabled("comments", file), true);
  lib.setFeature("sql-source", true, { file });
  const text = readFileSync(file, "utf8");
  assert.ok(!text.startsWith("﻿"), "written as plain UTF-8");
  assert.equal(JSON.parse(text).client.platform, "azure_sql");
  assert.equal(JSON.parse(text).features.comments, true);
});

test("a corrupt file is reported, read as all off, and never overwritten", () => {
  for (const bad of ["{not json", "[1, 2]", "﻿{\"features\": {\"comments\": tru", "\"just a string\""]) {
    const file = fresh(bad);
    const config = lib.readCoopConfig(file);
    assert.equal(config.ok, false, `${JSON.stringify(bad)} is unreadable`);
    const list = lib.listFeatures({ file });
    assert.equal(list.ok, false);
    assert.ok(list.features.every((f) => !f.on));
    assert.throws(() => lib.setFeature("comments", true, { file }), (e) => e instanceof lib.ConfigUnreadableError && /coop left it as it is/.test(e.message));
    assert.throws(() => lib.setCleanupDays(10, { file }), lib.ConfigUnreadableError);
    assert.throws(() => sqlsc.setSqlSourceEnabled(true, file), lib.ConfigUnreadableError);
    assert.equal(readFileSync(file, "utf8"), bad, "the bytes are untouched");
    assert.ok(!existsSync(join(dirname(file), "config.lock")), "the lock is released");
  }
});

test("unknown keys are refused; Daily lineage refresh turns on and off", () => {
  const file = fresh("{}");
  assert.throws(() => lib.setFeature("autopilot", true, { file }), (e) => e.code === "unknown" && /one of: instructions, history, comments, docs-refresh, sql-source/.test(e.message));
  assert.equal(readFileSync(file, "utf8"), "{}", "a refused change writes nothing");
  assert.equal(lib.setFeature("docs-refresh", true, { file }), true);
  assert.equal(read(file).features.docs_refresh, true, "stored as features.docs_refresh");
  assert.equal(lib.setFeature("docs-refresh", false, { file }), false);
  assert.equal(read(file).features.docs_refresh, false);
  assert.equal(lib.featureFor("SQL-SOURCE").key, "sql-source");
});

test("the lock: a held lock makes a writer wait, then give up; a stale one is cleared", () => {
  const file = fresh('{"a":1}');
  const lock = join(dirname(file), "config.lock");
  writeFileSync(lock, "");
  const started = Date.now();
  assert.throws(() => lib.setFeature("comments", true, { file, waitMs: 150 }), lib.ConfigBusyError);
  assert.ok(Date.now() - started >= 140, "it waited");
  assert.deepEqual(read(file), { a: 1 }, "nothing written while another writer holds the lock");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.equal(lib.setFeature("comments", true, { file, waitMs: 150 }), true, "a lock a dead writer left is removed");
  assert.deepEqual(read(file), { schema_version: 1, a: 1, features: { comments: true } });
  assert.ok(!existsSync(lock));
});

test("the lock: Windows' EPERM/EACCES/EBUSY on config.lock (DELETE_PENDING, an AV scan) are waited out, not thrown", () => {
  const file = fresh('{"a":1}');
  assert.ok(lib.configFs && typeof lib.configFs.openSync === "function", "the lock's fs calls are reachable for this test");
  const real = lib.configFs.openSync;
  const codes = ["EPERM", "EACCES", "EBUSY"];
  let calls = 0;
  lib.configFs.openSync = (path, flags, ...rest) => {
    if (String(path).endsWith("config.lock") && flags === "wx" && calls < codes.length) {
      const e = new Error(`${codes[calls]}: operation not permitted, open '${path}'`);
      e.code = codes[calls++];
      throw e;
    }
    return real(path, flags, ...rest);
  };
  try {
    assert.equal(lib.setFeature("comments", true, { file, waitMs: 2000 }), true);
  } finally {
    lib.configFs.openSync = real;
  }
  assert.equal(calls, 3, "each transient error was retried");
  assert.equal(read(file).features.comments, true);
});

test("the lock: a writer releases only its own lock, and a stale lock is broken by one contender only", () => {
  const file = fresh('{"a":1}');
  const lock = join(dirname(file), "config.lock");
  // A slow write lost its (stale) lock to another writer: it must not remove theirs.
  lib.updateCoopConfig((d) => { writeFileSync(lock, "another-writer"); d.b = 2; }, { file });
  assert.ok(existsSync(lock), "another writer's lock is left in place");
  assert.equal(readFileSync(lock, "utf8"), "another-writer");
  // A stale lock while someone else is already breaking it (config.lock.break is
  // fresh): this writer does not remove the lock behind their back; it waits.
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const breaker = join(dirname(file), "config.lock.break");
  writeFileSync(breaker, "breaking");
  assert.throws(() => lib.setFeature("comments", true, { file, waitMs: 150 }), lib.ConfigBusyError);
  assert.ok(existsSync(lock), "only the contender holding config.lock.break removes a stale lock");
  // That breaker died too: its marker ages out and the stale lock is broken.
  utimesSync(breaker, old, old);
  assert.equal(lib.setFeature("comments", true, { file, waitMs: 1000 }), true);
  assert.ok(!existsSync(lock) && !existsSync(breaker));
  assert.deepEqual(read(file), { schema_version: 1, a: 1, b: 2, features: { comments: true } });
});

test("a read refused for a moment (Windows EBUSY/EPERM/EACCES) is retried; one that stays refused is an io error, never 'not valid JSON, remove it'", () => {
  const file = fresh('{"features":{"comments":true}}');
  const fsOps = lib.configFs;
  assert.ok(fsOps && typeof fsOps.readFileSync === "function", "the config's fs calls are reachable for this test");
  const real = fsOps.readFileSync;
  let left = 2;
  fsOps.readFileSync = (path, ...rest) => {
    if (path === file && left > 0) { left -= 1; throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }); }
    return real(path, ...rest);
  };
  try {
    const config = lib.readCoopConfig(file);
    assert.equal(config.ok, true, "two busy reads, then the file");
    assert.equal(lib.featureEnabled("comments", file), true);
    fsOps.readFileSync = (path, ...rest) => {
      if (path === file) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return real(path, ...rest);
    };
    const refused = lib.readCoopConfig(file);
    assert.equal(refused.ok, false);
    assert.equal(refused.errorKind, "io");
    assert.equal(lib.listFeatures({ file }).errorKind, "io");
    assert.throws(() => lib.setFeature("comments", false, { file }), (e) => !/not valid JSON|remove/i.test(e.message) && /could not be read/.test(e.message));
  } finally {
    fsOps.readFileSync = real;
  }
  assert.equal(readFileSync(file, "utf8"), '{"features":{"comments":true}}', "untouched");
  const bad = fresh("{broken");
  assert.equal(lib.readCoopConfig(bad).errorKind, "parse");
  assert.equal(lib.listFeatures({ file: bad }).errorKind, "parse");
});

test("the CLI runs when started through another spelling of its path (a link; on Windows letter case or a short name)", () => {
  const file = fresh('{"a":1}');
  const linked = join(HOME, `link-${++n}`);
  symlinkSync(join(ROOT, "lib"), linked, process.platform === "win32" ? "junction" : "dir");
  const r = spawnSync(process.execPath, [join(linked, "features.mjs"), "set", "comments", "on", "--file", file], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Diff review comments is on/, "the CLI ran instead of exiting 0 silently");
  assert.equal(read(file).features.comments, true);
});

test("two writers at once (the window in-process and the CLI) lose no update", async () => {
  const file = fresh(JSON.stringify({ client: { platform: "fabric" } }));
  const coopDir = dirname(dirname(file));
  const writer = (prefix, count) => new Promise((done, fail) => {
    const code = `
      const lib = await import(${JSON.stringify(new URL("../lib/features.mjs", import.meta.url).href)});
      for (let i = 0; i < ${count}; i++) lib.updateCoopConfig((d) => { d[${JSON.stringify(prefix)} + i] = i; }, { file: ${JSON.stringify(file)}, waitMs: 10000 });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (rc) => (rc === 0 ? done() : fail(new Error(`writer ${prefix} exited ${rc}: ${err}`))));
  });
  // The terminal's `coop settings set` path: the CLI as its own processes.
  const cliRuns = () => new Promise((done, fail) => {
    let left = 6;
    for (let i = 0; i < 6; i++) {
      const child = spawn(process.execPath, [CLI, "set", "comments", i % 2 ? "off" : "on"], { env: { ...process.env, COOP_DIR: coopDir, COOP_CONFIG_LOCK_WAIT_MS: "10000" }, stdio: "ignore" });
      child.on("exit", (rc) => { if (rc !== 0) fail(new Error(`cli exited ${rc}`)); else if (--left === 0) done(); });
    }
  });
  await Promise.all([writer("a", 40), writer("b", 40), cliRuns()]);
  const data = read(file);
  for (let i = 0; i < 40; i++) {
    assert.equal(data[`a${i}`], i, `a${i} kept`);
    assert.equal(data[`b${i}`], i, `b${i} kept`);
  }
  assert.equal(data.client.platform, "fabric");
  assert.equal(typeof data.features.comments, "boolean");
  assert.ok(!existsSync(join(dirname(file), "config.lock")));
});

test("the CLI: show, set, cleanup-days and its exit codes", () => {
  const file = fresh(JSON.stringify({ client: { platform: "fabric" } }));
  const coopDir = dirname(dirname(file));
  let r = runCli(["show"], coopDir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^ {2}Client instructions {5}off {2}instructions/m);
  assert.match(r.stdout, /^ {2}Diff review comments {4}off {2}comments$/m);
  assert.match(r.stdout, /^ {2}SQL source control {6}off {2}sql-source$/m);
  r = runCli(["set", "comments", "on"], coopDir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "Diff review comments is on for this client (applies at once in the window's Changes pane).");
  r = runCli(["show", "--json"], coopDir);
  const shown = JSON.parse(r.stdout);
  assert.equal(shown.features.find((f) => f.key === "comments").on, true);
  assert.equal(shown.file, file);
  r = runCli(["set", "sql-source", "on", "--json"], coopDir);
  assert.equal(JSON.parse(r.stdout).text, "SQL source control is on for this client (takes effect after /new or a restart).");
  assert.equal(read(file).sql_source_control.enabled, true);
  assert.equal(runCli(["set", "nope", "on"], coopDir).status, 2, "unknown key: usage");
  r = runCli(["set", "docs-refresh", "on"], coopDir);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "Daily lineage refresh is on for this client (takes effect at the next sign-in or coop start).");
  assert.equal(runCli(["set", "docs-refresh", "off"], coopDir).status, 0);
  assert.equal(runCli(["set", "comments", "maybe"], coopDir).status, 2);
  assert.equal(runCli(["cleanup-days", "12"], coopDir).status, 0);
  assert.deepEqual(read(file).cleanup, { days: 12 });
  assert.equal(runCli(["cleanup-days", "9999"], coopDir).status, 2);
  assert.equal(read(file).client.platform, "fabric");
  writeFileSync(file, "{broken");
  r = runCli(["set", "comments", "off"], coopDir);
  assert.equal(r.status, 1, "an unreadable file fails the change");
  assert.match(r.stderr, /not valid JSON.*coop left it as it is/);
  assert.equal(readFileSync(file, "utf8"), "{broken");
  r = runCli(["show"], coopDir);
  assert.equal(r.status, 0, "show still answers");
  assert.match(r.stdout, /every feature reads as off/);
});

test("the CLI: COOP_CONFIG_LOCK_WAIT_MS sets its lock wait; --file needs a value; cleanup-days keeps its siblings", () => {
  const file = fresh('{"a":1}');
  const coopDir = dirname(dirname(file));
  const lock = join(dirname(file), "config.lock");
  writeFileSync(lock, "held");
  const started = Date.now();
  const r = spawnSync(process.execPath, [CLI, "set", "comments", "on", "--file", file], { encoding: "utf8", env: { ...process.env, COOP_CONFIG_LOCK_WAIT_MS: "100" } });
  const took = Date.now() - started;
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /another coop is changing/);
  assert.ok(took < 1500, `the 100 ms wait was used, not the 2 s default (${took} ms)`);
  rmSync(lock);
  // --file with no value is a usage error, not a write to the real profile's config.
  const own = fresh();
  const ownDir = dirname(dirname(own));
  const bare = spawnSync(process.execPath, [CLI, "set", "comments", "on", "--file"], { encoding: "utf8", env: { ...process.env, COOP_DIR: ownDir } });
  assert.equal(bare.status, 2, bare.stdout + bare.stderr);
  assert.ok(!existsSync(own), "nothing written to the default config");
  // cleanup-days keeps other keys in the cleanup block.
  writeFileSync(file, JSON.stringify({ schema_version: 1, cleanup: { days: 30, note: "kept" } }));
  lib.setCleanupDays(12, { file });
  assert.deepEqual(read(file).cleanup, { days: 12, note: "kept" });
  void coopDir;
});

test("/sql-source on|off writes through the one writer", () => {
  const file = fresh("﻿" + JSON.stringify({ features: { comments: true } }));
  assert.equal(sqlsc.setSqlSourceEnabled(true, file, new Date("2026-10-20T22:00:00Z")), true);
  assert.equal(sqlsc.sqlSourceEnabled(file), true);
  assert.equal(lib.featureEnabled("sql-source", file), true, "the same switch the Features list shows");
  assert.deepEqual(read(file), { schema_version: 1, features: { comments: true }, sql_source_control: { enabled: true, changed_at: "2026-10-20T22:00:00.000Z" } });
  const source = readFileSync(join(ROOT, "lib", "sqlsc.mjs"), "utf8");
  assert.ok(!/renameSync|writeFileSync/.test(source), "lib/sqlsc.mjs no longer writes ~/.coop/config itself");
});

// --- Interop with scripts/onboard.py (the other ~/.coop/config writer) --------
// onboard.py refuses a config without schema_version 1, and used to rebuild the
// file from its own keys only, so re-running onboarding dropped every switch.
const PY = process.env.PYTHON || (spawnSync("python3", ["--version"]).status === 0 ? "python3" : "python");
// Blank answers to every onboarding question (no Azure, no integrations change).
const ONBOARD_ANSWERS = "n\nn\nn\nn\nn\nn\nn\n";
function onboard(coopDir, args = ["onboard", "--config-only"]) {
  return spawnSync(PY, [join(ROOT, "scripts", "onboard.py"), ...args], {
    encoding: "utf8",
    input: ONBOARD_ANSWERS,
    env: { ...process.env, HOME: coopDir, USERPROFILE: coopDir, COOP_DIR: coopDir, COOP_AZ_BIN: join(coopDir, "no-az"), COOP_CLIENT_PLATFORM: "fabric" },
  });
}

test("a fresh ~/.coop/config the Node writer creates carries schema_version 1, and onboard.py accepts it", () => {
  const file = fresh();
  const coopDir = dirname(dirname(file));
  lib.setFeature("comments", true, { file });
  assert.equal(read(file).schema_version, 1, "a new file is stamped with schema_version 1");
  const cleanupOnly = fresh();
  lib.setCleanupDays(20, { file: cleanupOnly });
  assert.deepEqual(read(cleanupOnly), { schema_version: 1, cleanup: { days: 20 } });
  const r = onboard(coopDir);
  assert.equal(r.status, 0, `onboard.py --config-only must accept the Node writer's file: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /Unsupported existing/);
  const data = read(file);
  assert.equal(data.schema_version, 1);
  assert.equal(data.features.comments, true, "onboarding keeps the feature switch");
  assert.ok(data.integrations, "onboarding wrote its own keys");
});

test("setFeature, then onboard.py --config-only (and platform --set): every switch, sql_source_control and cleanup survive", () => {
  const file = fresh();
  const coopDir = dirname(dirname(file));
  let r = onboard(coopDir);
  assert.equal(r.status, 0, r.stderr);
  lib.setFeature("comments", true, { file });
  lib.setFeature("sql-source", true, { file, now: new Date("2026-11-26T08:00:00Z") });
  lib.setCleanupDays(30, { file });
  r = onboard(coopDir);
  assert.equal(r.status, 0, r.stderr);
  let data = read(file);
  assert.equal(data.features.comments, true, "features.comments kept");
  assert.deepEqual(data.sql_source_control, { enabled: true, changed_at: "2026-11-26T08:00:00.000Z" }, "sql_source_control kept");
  assert.deepEqual(data.cleanup, { days: 30 }, "cleanup kept");
  assert.equal(data.client.platform, "fabric");
  r = onboard(coopDir, ["platform", "--set", "azure_sql"]);
  assert.equal(r.status, 0, r.stderr);
  data = read(file);
  assert.equal(data.client.platform, "azure_sql");
  assert.equal(data.features.comments, true, "platform --set keeps the switches");
  assert.ok(!existsSync(join(dirname(file), "config.lock")), "onboard.py releases config.lock");
});

test("onboard.py accepts a schema-less config another coop writer left (main's Set-CoopCleanupDays) and stamps it", () => {
  const file = fresh(JSON.stringify({ cleanup: { days: 12 } }, null, 2));
  const r = onboard(dirname(dirname(file)));
  assert.equal(r.status, 0, r.stderr);
  const data = read(file);
  assert.equal(data.schema_version, 1);
  assert.deepEqual(data.cleanup, { days: 12 });
  // A different, explicit schema is still refused and left alone.
  const future = fresh('{"schema_version": 2}');
  const r2 = onboard(dirname(dirname(future)));
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /expected schema_version 1/);
  assert.equal(readFileSync(future, "utf8"), '{"schema_version": 2}');
});

test("onboard.py waits for config.lock like every other writer", () => {
  const file = fresh();
  const coopDir = dirname(dirname(file));
  const lock = join(dirname(file), "config.lock");
  writeFileSync(lock, "someone-else");
  const r = spawnSync(PY, [join(ROOT, "scripts", "onboard.py"), "platform", "--set", "both"], {
    encoding: "utf8",
    env: { ...process.env, HOME: coopDir, USERPROFILE: coopDir, COOP_DIR: coopDir, COOP_CONFIG_LOCK_WAIT_MS: "200" },
  });
  assert.notEqual(r.status, 0, "a held lock refuses the write");
  assert.match(r.stderr, /another coop is changing/);
  assert.ok(!existsSync(file), "nothing written while the lock is held");
  assert.equal(readFileSync(lock, "utf8"), "someone-else", "someone else's lock is left alone");
});

const dist = process.env.COOP_TEST_DIST;
test("session start names the features that are on, and says nothing while every one is off", { skip: dist ? false : "needs COOP_TEST_DIST (tests/run.sh bundles coop-tools)" }, async () => {
  const tools = await import(pathToFileURL(join(dist, "coop-tools.mjs")).href);
  const starts = [];
  tools.default({
    registerTool: () => {}, registerCommand: () => {}, sendUserMessage: () => {}, getThinkingLevel: () => "off",
    on: (event, fn) => { if (event === "session_start") starts.push(fn); },
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
  });
  const cwd = mkdtempSync(join(tmpdir(), "coop-features-cwd-"));
  TEMPS.push(cwd);
  const start = async () => {
    const notices = [];
    const ctx = { cwd, hasUI: false, ui: { notify: (m) => notices.push(String(m)), setStatus: () => {} }, sessionManager: { getSessionId: () => "s", getSessionFile: () => "" } };
    for (const fn of starts) { try { await fn({}, ctx); } catch { /* other session_start work needs more of Pi */ } }
    return notices;
  };
  const file = join(HOME, ".coop", "config");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ client: { platform: "fabric" } }));
  assert.ok(starts.length > 0);
  assert.ok(!(await start()).some((m) => /Features on/.test(m)), "every feature off: no line");
  lib.setFeature("comments", true, { file });
  lib.setFeature("sql-source", true, { file });
  assert.deepEqual((await start()).filter((m) => /Features on/.test(m)), ["Features on for this client: Diff review comments, SQL source control."]);
  lib.setFeature("comments", false, { file });
  lib.setFeature("sql-source", false, { file });
});

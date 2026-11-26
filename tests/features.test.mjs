// The Features list and the one ~/.coop/config writer (lib/features.mjs,
// FEATURES-DESIGN "Shared piece: one Features list"): the five rows with their
// plain labels, off unless the file says true, a round trip that keeps every
// other key, a BOM file, an unparseable file left alone, the lock, two writers
// at once (in-process and the CLI the window and `coop settings` use), and
// /sql-source writing through the same writer.
//
// Run: node --test tests/features.test.mjs (tests/run.sh runs it in the gate lane).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "lib", "features.mjs");
// Hermetic: the default config path resolves inside a temp folder, never the real home.
const HOME = mkdtempSync(join(tmpdir(), "coop-features-"));
process.env.COOP_DIR = HOME;
const lib = await import("../lib/features.mjs");
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
  // Built in this step: the comments and the existing SQL source control switch.
  assert.deepEqual(lib.FEATURES.filter((f) => f.available).map((f) => f.key), ["comments", "sql-source"]);
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
  // A feature this version does not carry stays off even when the file says true.
  const hand = fresh('{"features":{"history":true,"comments":true}}');
  assert.equal(lib.featureEnabled("history", hand), false);
  assert.equal(lib.featureEnabled("comments", hand), true);
  assert.equal(lib.featuresOnLine(lib.listFeatures({ file: hand })), "Features on for this client: Diff review comments.");
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

test("unknown keys and features this version does not carry are refused", () => {
  const file = fresh("{}");
  assert.throws(() => lib.setFeature("autopilot", true, { file }), (e) => e.code === "unknown" && /one of: instructions, history, comments, docs-refresh, sql-source/.test(e.message));
  assert.throws(() => lib.setFeature("history", true, { file }), (e) => e.code === "unavailable");
  assert.equal(readFileSync(file, "utf8"), "{}", "a refused change writes nothing");
  assert.equal(lib.setFeature("history", false, { file }), false, "turning an unbuilt feature off is harmless");
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
  assert.deepEqual(read(file), { a: 1, features: { comments: true } });
  assert.ok(!existsSync(lock));
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
      const child = spawn(process.execPath, [CLI, "set", "comments", i % 2 ? "off" : "on"], { env: { ...process.env, COOP_DIR: coopDir }, stdio: "ignore" });
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
  r = runCli(["set", "history", "on"], coopDir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Change history is not in this version of coop yet; it stays off/);
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

test("/sql-source on|off writes through the one writer", () => {
  const file = fresh("﻿" + JSON.stringify({ features: { comments: true } }));
  assert.equal(sqlsc.setSqlSourceEnabled(true, file, new Date("2026-10-20T22:00:00Z")), true);
  assert.equal(sqlsc.sqlSourceEnabled(file), true);
  assert.equal(lib.featureEnabled("sql-source", file), true, "the same switch the Features list shows");
  assert.deepEqual(read(file), { features: { comments: true }, sql_source_control: { enabled: true, changed_at: "2026-10-20T22:00:00.000Z" } });
  const source = readFileSync(join(ROOT, "lib", "sqlsc.mjs"), "utf8");
  assert.ok(!/renameSync|writeFileSync/.test(source), "lib/sqlsc.mjs no longer writes ~/.coop/config itself");
});

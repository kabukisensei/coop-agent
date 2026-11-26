// Daily lineage refresh (FEATURES-DESIGN CW6): the next session start shows the
// background run's one line from ~/.coop/docs-refresh/state.json, through the
// bundled coop-tools on a fake Pi (tests/cw1-capture.mjs). On: "Docs refreshed
// 08:21, 3 files changed." as info, a skip or failure as a warning; a run more
// than a day old, or none, says nothing. Off (the switch absent or false): no
// line even with a state file there, and the state file is not read at all.
//   COOP_TEST_DIST=<bundled extensions> node tests/docs-refresh-notice.test.mjs
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { strict as assert } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureSession, makeFixture, useHome } from "./cw1-capture.mjs";
import { docsRefreshNotice } from "../lib/features.mjs";

const reads = [];
const original = fs.readFileSync;
fs.readFileSync = function (path, ...rest) { reads.push(String(path)); return original.call(this, path, ...rest); };
syncBuiltinESMExports();

const dist = process.env.COOP_TEST_DIST;
const fx = makeFixture();
useHome(fx.home);
const config = join(fx.home, ".coop", "config");
const stateFile = join(fx.home, ".coop", "docs-refresh", "state.json");
mkdirSync(join(fx.home, ".coop", "docs-refresh"), { recursive: true });
const writeState = (state) => writeFileSync(stateFile, `﻿${JSON.stringify({ schema_version: 1, ...state })}`);
const ago = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString();
const lines = (capture) => capture.notices.filter(([text]) => /^Docs refresh/.test(text));

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`); };

await t("on: the last run's line at session start, as info", async () => {
  writeFileSync(config, JSON.stringify({ schema_version: 1, features: { docs_refresh: true } }));
  writeState({ result: "ok", finished: ago(1), files_changed: 3, line: "Docs refreshed 08:21, 3 files changed." });
  const got = lines(await captureSession(dist, { project: fx.project }));
  assert.deepEqual(got, [["Docs refreshed 08:21, 3 files changed.", "info"]]);
});

await t("on: a skip reason is a warning", async () => {
  writeState({ result: "no_docs_config", finished: ago(2), line: "Docs refresh skipped 08:20: the client folder has no coop-data-doc.yml (/setup-docs makes one) (no_docs_config)." });
  const got = lines(await captureSession(dist, { project: fx.project }));
  assert.equal(got.length, 1);
  assert.equal(got[0][1], "warning");
  assert.match(got[0][0], /\(no_docs_config\)\.$/);
});

await t("on: a run over a day old, an unreadable state, or none says nothing", async () => {
  writeState({ result: "ok", finished: ago(30), line: "Docs refreshed 08:21, 3 files changed." });
  assert.deepEqual(lines(await captureSession(dist, { project: fx.project })), []);
  writeFileSync(stateFile, "{broken");
  assert.deepEqual(lines(await captureSession(dist, { project: fx.project })), []);
  rmSync(stateFile);
  assert.deepEqual(lines(await captureSession(dist, { project: fx.project })), []);
});

for (const [label, value] of [["absent", undefined], ["false", false], ['"true" (a string)', "true"]]) {
  await t(`off (${label}): no line, and state.json is not read`, async () => {
    writeFileSync(config, JSON.stringify({ schema_version: 1, features: value === undefined ? {} : { docs_refresh: value } }));
    writeState({ result: "ok", finished: ago(1), line: "Docs refreshed 08:21, 3 files changed." });
    reads.length = 0;
    const got = lines(await captureSession(dist, { project: fx.project }));
    assert.deepEqual(got, []);
    assert.ok(!reads.some((p) => p.includes("docs-refresh")), `read ${reads.filter((p) => p.includes("docs-refresh")).join(", ")}`);
  });
}

await t("docsRefreshNotice: the line, its level and the one-day window", () => {
  writeState({ result: "timeout", finished: "2026-11-26T08:30:00+01:00", line: "Docs refresh failed 08:30: it did not finish within 20 minutes (timeout)." });
  assert.deepEqual(docsRefreshNotice({ file: stateFile, now: new Date("2026-11-27T07:00:00Z") }), { text: "Docs refresh failed 08:30: it did not finish within 20 minutes (timeout).", level: "warning" });
  assert.equal(docsRefreshNotice({ file: stateFile, now: new Date("2026-11-27T08:00:00Z") }), null);
  writeState({ result: "ok", finished: "2026-11-26T08:30:00Z", line: "" });
  assert.equal(docsRefreshNotice({ file: stateFile, now: new Date("2026-11-26T09:00:00Z") }), null);
});

rmSync(fx.root, { recursive: true, force: true });
console.log(`✓ daily lineage refresh: the session-start line (${n} checks)`);

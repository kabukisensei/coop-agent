// Client instructions (CW1) off is today's behaviour exactly. The bundled
// coop-tools runs on a fake Pi in a client repository that HAS a .coop/rules/
// folder; with the switch off (absent, false, or anything but a literal true) the
// session sees the same tools with the same metadata, the same slash commands,
// the same session-start notices and the same first-turn hidden context as the
// 03600165 bundle (before CW1), recorded in tests/fixtures/cw1-off-golden.json by
// tests/cw1-capture.mjs. On, the same capture differs: the switch is real.
// Off, nothing under .coop/rules/ is touched at all: every fs call coop-tools makes
// during the capture is traced (no read, no stat, no existence check). The commit
// and write gates in coop-guardrails do not depend on this switch (they follow the
// files; tests/client-rules-guardrails.test.mjs).
//   COOP_TEST_DIST=<bundled extensions> node tests/client-instructions-off.test.mjs
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { strict as assert } from "node:assert";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureSession, digest, makeFixture, normalized, useHome } from "./cw1-capture.mjs";
import { FEATURES } from "../lib/features.mjs";

// The trace, before any bundle loads (builtin ESM exports synced to it).
const touched = [];
let tracing = false;
for (const name of ["readFileSync", "existsSync", "statSync", "lstatSync", "openSync", "readdirSync", "realpathSync", "accessSync", "createReadStream"]) {
  const original = fs[name];
  if (typeof original !== "function") continue;
  const traced = function (path, ...rest) { if (tracing) touched.push({ call: name, path: String(path) }); return original.call(this, path, ...rest); };
  if (original.native) traced.native = original.native;
  fs[name] = traced;
}
syncBuiltinESMExports();
const IN_RULES = /[\\/]\.coop[\\/]rules([\\/]|$)/;
const traceCapture = async (opts) => {
  touched.length = 0;
  tracing = true;
  try { return await captureSession(dist, opts); } finally { tracing = false; }
};

const dist = process.env.COOP_TEST_DIST;
const golden = JSON.parse(readFileSync(new URL("./fixtures/cw1-off-golden.json", import.meta.url), "utf8"));
const fx = makeFixture();
useHome(fx.home);
const config = join(fx.home, ".coop", "config");

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`); };

await t("Client instructions is in this version (it can be turned on), and starts off", () => {
  const f = FEATURES.find((x) => x.key === "instructions");
  assert.equal(f.available, true);
  assert.equal(f.takesEffect, "after /new");
});

for (const [label, write] of [
  ["no ~/.coop/config", () => rmSync(config, { force: true })],
  ["features.instructions false", () => writeFileSync(config, JSON.stringify({ schema_version: 1, features: { instructions: false } }))],
  ["features.instructions \"true\" (a string, not true)", () => writeFileSync(config, JSON.stringify({ schema_version: 1, features: { instructions: "true" } }))],
]) {
  await t(`off (${label}): tools, commands, session-start notices and first-turn context match the 03600165 golden (sha256 ${golden.sha256.slice(0, 12)})`, async () => {
    write();
    const cap = normalized(await traceCapture({ project: fx.project }), fx.root);
    assert.deepEqual(touched.filter((x) => IN_RULES.test(x.path)), [], "off: nothing under .coop/rules/ is read, listed or even checked");
    assert.deepEqual(cap, golden.capture);
    assert.equal(digest(cap), golden.sha256);
  });
}

await t("on: the same capture differs (client_rules, /correct, the session line, the note)", async () => {
  writeFileSync(config, JSON.stringify({ schema_version: 1, features: { instructions: true } }));
  const cap = normalized(await traceCapture({ project: fx.project }), fx.root);
  assert.ok(touched.some((x) => x.call === "readFileSync" && IN_RULES.test(x.path)), "on: the trace sees the loader read .coop/rules/");
  assert.notEqual(digest(cap), golden.sha256);
  assert.equal(cap.tools.filter((x) => x.name === "client_rules").length, 1);
  assert.deepEqual(cap.tools.filter((x) => x.name !== "client_rules"), golden.capture.tools, "every other tool is unchanged");
  assert.deepEqual(cap.commands.filter((x) => x.name !== "correct"), golden.capture.commands);
  assert.ok(cap.notices.some(([m]) => /^Client instructions: /.test(m)));
  assert.match(cap.turns[0].message.content, /\[coop client instructions [0-9a-f]{12}\]/);
  assert.ok(cap.turns[0].message.content.startsWith(golden.capture.turns[0].message.content), "today's note first, the client instructions after it");
});

try { rmSync(fx.root, { recursive: true, force: true }); } catch { /* Windows may hold a handle a moment */ }
console.log(`✓ client instructions off is today's behaviour: ${n} checks`);

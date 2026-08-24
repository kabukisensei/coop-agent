// Behavioral tests for extensions/coop-profile.
//
// The default export is tested against the REAL Pi contract: the extension
// receives the ExtensionAPI object itself and registers via `api.on(...)`.
// (Pi's own type: ExtensionFactory = (pi: ExtensionAPI) => void. A mock shaped
// { pi: { on } } reproduces an old bug instead of testing the contract.)
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(path.join(tmpdir(), "coop-profile-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const userFile = path.join(home, ".coop", "user.json");
mkdirSync(path.dirname(userFile), { recursive: true });
const dist = process.env.COOP_TEST_DIST || "/tmp/coop-test-dist";
const modPath = path.join(dist, "coop-profile.mjs");
assert.ok(existsSync(modPath));
const mod = await import(pathToFileURL(modPath).href);

writeFileSync(userFile, JSON.stringify({ schema_version: 2, name: "Ignored", communication: { preset: "balanced" } }));
assert.equal(mod.loadProfile(), null, "unknown schema is ignored");
writeFileSync(userFile, "not-json");
assert.equal(mod.loadProfile(), null, "malformed JSON is ignored");
writeFileSync(userFile, JSON.stringify({ schema_version: 1, name: "Aaron\nInjected", communication: { preset: "custom", custom_instructions: "Be brief\u0000\nplease" } }));
const profile = mod.loadProfile();
assert.equal(profile.name, "Aaron Injected");
assert.match(mod.buildInstruction(profile), /Be brief please/);

let handler;
mod.default({ on: (event, h) => { handler = h; } });
const first = await handler({ systemPrompt: "base" }, {});
const second = await handler({ systemPrompt: "base" }, {});
assert.equal(first.systemPrompt, second.systemPrompt, "contribution remains constant across turns");
assert.ok(!("message" in first), "does not append a persistent session message");
assert.equal((first.systemPrompt.match(/COOP user profile/g) || []).length, 1);
// --- startup must never be blocked by profile problems -----------------------
// Each of these runs the registered handler against a fresh registration; a
// startup-blocking extension would throw or return a broken result instead of
// silently contributing nothing.
const negativeCases = [
  ["missing profile", () => { try { rmSync(userFile); } catch {} }],
  ["malformed profile JSON", () => writeFileSync(userFile, "{broken")],
  ["unknown profile schema", () => writeFileSync(userFile, JSON.stringify({ schema_version: 99, name: "X", communication: { preset: "balanced" } }))],
];
for (const [label, setup] of negativeCases) {
  setup();
  let h;
  mod.default({ on: (_e, handler) => { h = handler; } });
  const result = await h({ systemPrompt: "base" }, {});
  assert.ok(result === undefined || (result && typeof result.systemPrompt === "string"), `${label}: handler returned a sane result`);
  if (result && result.systemPrompt !== undefined) {
    assert.ok(!result.systemPrompt.includes("COOP user profile"), `${label}: no instruction contributed`);
  }
  console.log(`  ✓ ${label} does not block startup`);
}

// A throwing API (registration failure) surfaces synchronously so Pi's loader
// can report and omit ONLY this extension instead of aborting the session.
await assert.rejects(
  async () => { await mod.default({ on: () => { throw new Error("boom"); } }); },
  /boom/,
  "registration failure propagates to the loader"
);
console.log("  ✓ registration failure propagates to Pi's loader (extension omitted, not fatal)\n");

// --- black-box load through the REAL Pi loader --------------------------------
// Unit tests above mock the API; this exercises what actually happens when Pi
// loads the shipped TypeScript. Skipped cleanly when no installed Pi is found.
{
  const candidates = [
    // Opt-in override for compatibility-matrix runs (e.g. the isolated ~/.coop
    // tree, whose pi-ai/pi-tui may be intentionally skewed — see slice-4 notes).
    process.env.COOP_TEST_PI_PKG,
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent",
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
    path.join(process.env.HOME || "", ".hermes/node/lib/node_modules/@earendil-works/pi-coding-agent"),
  ].filter(Boolean);
  const piPkg = candidates.find((p) => existsSync(path.join(p, "package.json")));
  if (!piPkg) {
    console.log("  – no installed Pi found; skipping real-loader test");
  } else {
    const loaderUrl = pathToFileURL(path.join(piPkg, "dist/core/extensions/loader.js")).href;
    const { createExtensionRuntime, loadExtensions } = await import(loaderUrl);
    // The shipped source, exactly as `-e <repo>/extensions/coop-profile` loads it.
    const src = process.env.COOP_TEST_PROFILE_SRC
      || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extensions/coop-profile/index.ts");
    assert.ok(existsSync(src), `profile extension source exists at ${src}`);
    const result = await loadExtensions([src], process.cwd(), undefined, createExtensionRuntime());
    assert.equal(result.errors.length, 0, `real Pi loader reports errors: ${JSON.stringify(result.errors)}`);
    assert.equal(result.extensions.length, 1, "real Pi loader loaded coop-profile");
    const piVersion = JSON.parse(readFileSync(path.join(piPkg, "package.json"), "utf8")).version;
    console.log(`  ✓ real Pi loader (${piVersion}) loads coop-profile without error`);
  }
}

console.log("  ✓ profile schema, sanitization, and constant system-prompt contribution");

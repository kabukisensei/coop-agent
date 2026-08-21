// Tests for extensions/coop-profile
import assert from "node:assert";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = process.env.COOP_TEST_DIST || "/tmp/coop-test-dist";
const modPath = path.join(dist, "coop-profile.mjs");

assert.ok(existsSync(modPath), `bundled coop-profile.mjs exists: ${modPath}`);
const mod = await import(pathToFileURL(modPath).href);
assert.strictEqual(typeof mod.default, "function", "coop-profile exports a default function");
console.log("  ✓ bundled and exports a function");

console.log("coop-profile tests passed");

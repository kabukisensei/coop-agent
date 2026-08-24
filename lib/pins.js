#!/usr/bin/env node
/**
 * Converge the isolated Pi extension tree's recorded dependency specs to EXACT
 * versions (used by coop sync / coop_converge_extension_pins /
 * Sync-CoopExtensionPins). `pi install` records ^-ranges, which lets fresh
 * trees float to latest-in-range; exact dependency specs make convergence
 * deterministic.
 *
 * usage: node pins.js <agent-dir> <name>@<version> [[name]@<version>...]
 * Writes <agent-dir>/npm/package.json with dependencies set to the exact pins.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const [agentDir, ...specs] = process.argv.slice(2);
if (!agentDir || !specs.length) {
  console.error("usage: pins.js <agent-dir> <name>@<version>...");
  process.exit(2);
}

// Normalize Windows-style separators even on POSIX hosts.
const dir = String(agentDir).replace(/\\+/g, "/");
if (!fs.existsSync(dir)) { console.error("agent dir not found: " + dir); process.exit(2); }
const pjPath = path.join(dir, "npm", "package.json");
let pj = {};
try { pj = JSON.parse(fs.readFileSync(pjPath, "utf8")); } catch { /* bootstrap below */ }

pj.name = pj.name || "pi-extensions";
pj.private = true;
pj.dependencies = pj.dependencies || {};
for (const spec of specs) {
  const i = spec.lastIndexOf("@");
  if (i <= 0) continue; // skip malformed entries rather than corrupting the file
  pj.dependencies[spec.slice(0, i)] = spec.slice(i + 1);
}
fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2));

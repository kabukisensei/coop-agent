#!/usr/bin/env node
/** Support Center CLI — the installed, user-facing support workflow.
 *
 * Collects component health + versions + recent events, builds a sanitized
 * support bundle through lib/support-center.mjs (the reviewed contracts),
 * PREVIEWS it in the terminal, and EXPORTS it under the support dir with
 * bounded retention. Pure Node + shell: runs when the Pi/model runtime is
 * unavailable. No network, no credentials, no unsanitized persistence.
 *
 * Usage:
 *   node lib/support-center-cli.mjs [--json] [--export PATH] [--incident]
 *
 * Layout (under COOP_DIR, default ~/.coop):
 *   support/events.jsonl        host-recorded event log (created if absent;
 *                               trimmed to the last 200 lines each run)
 *   support/bundles/            exported bundles, newest last;
 *                               pruned to the newest 10 on each export
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import {
  normalizeComponentHealth, makeRunId, makeIncidentId, fingerprintBuild,
  sanitizeSupportEvent, supportBundleManifest,
} from "./support-center.mjs";

const COOP_DIR = process.env.COOP_DIR || join(process.env.HOME || ".", ".coop");
const SUPPORT_DIR = join(COOP_DIR, "support");
const EVENTS = join(SUPPORT_DIR, "events.jsonl");
const BUNDLES = join(SUPPORT_DIR, "bundles");
const MAX_BUNDLES = 10;
const MAX_EVENT_LOG_LINES = 200;

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const incidentMode = args.includes("--incident");
const exportIdx = args.indexOf("--export");
const explicitExport = exportIdx >= 0 ? args[exportIdx + 1] : null;

const hex8 = () => {
  // Run-local randomness is fine here (the CLI is the host layer, not the
  // pure contract module): 8 lowercase hex chars from crypto.
  return [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString();

const probe = (label, cmd, argv) => {
  try {
    const out = execFileSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { component: label, status: "ok", detail: out.split("\n")[0].slice(0, 120), checkedAt: now() };
  } catch (e) {
    return { component: label, status: "down", detail: `${cmd} unavailable (${e.code ?? "error"})`, checkedAt: now() };
  }
};

// --- collect ---------------------------------------------------------------
const probes = [
  probe("node", "node", ["--version"]),
  probe("git", "git", ["--version"]),
  { component: "coop-config", status: existsSync(join(COOP_DIR, "config")) ? "ok" : "degraded",
    detail: existsSync(join(COOP_DIR, "config")) ? `${COOP_DIR}/config present` : "no ~/.coop/config yet", checkedAt: now() },
];
if (incidentMode) {
  probes.push({ component: "operator-report", status: "degraded", detail: "incident mode: user-reported failure attached", checkedAt: now() });
}

const versions = {
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  coopBuild: fingerprintBuild({ version: "integration-2026-09-20", commit: "8a57991", channel: "candidate" }).value ?? "build-unavailable",
};

// --- events (read + bounded trim) -------------------------------------------
mkdirSync(SUPPORT_DIR, { recursive: true });
let rawEvents = [];
if (existsSync(EVENTS)) {
  const lines = readFileSync(EVENTS, "utf8").split("\n").filter((l) => l.trim());
  rawEvents = lines.slice(-MAX_EVENT_LOG_LINES).map((l) => { try { return JSON.parse(l); } catch { return { unparseable: l.slice(0, 200) }; } });
  if (lines.length > MAX_EVENT_LOG_LINES) writeFileSync(EVENTS, lines.slice(-MAX_EVENT_LOG_LINES).join("\n") + "\n");
}

// --- bundle ------------------------------------------------------------------
const runId = (incidentMode ? makeIncidentId : makeRunId)(today(), hex8());
const manifest = supportBundleManifest({
  components: probes,
  generatedAt: now(),
  build: versions.coopBuild,
});
const sanitizedEvents = rawEvents.slice(-20).map((e) => sanitizeSupportEvent(e));
const bundle = {
  run: runId.ok ? runId.value : "run-unknown",
  manifest: manifest.value,
  versions,
  events: sanitizedEvents.map((e) => (e.ok ? e.value : { sanitize_error: e.errors })),
};

// preview (terminal) — or JSON when asked
if (jsonMode) {
  console.log(JSON.stringify(bundle, null, 2));
} else {
  const m = bundle.manifest;
  console.log(`COOP SUPPORT — run ${bundle.run} — ${m.generatedAt}`);
  console.log(`build: ${bundle.versions.coopBuild}  (${bundle.versions.node} on ${bundle.versions.platform})`);
  for (const c of m.components) console.log(`  ${c.status === "ok" ? "✓" : c.status === "degraded" ? "!" : "✗"} ${c.component}: ${c.status}${c.detail ? ` — ${c.detail}` : ""}`);
  if (m.componentDiagnostics.length) console.log(`  ⚠ ${m.componentDiagnostics.length} component diagnostic(s) preserved in export`);
  console.log(`redact: ${m.redact.join(", ")}`);
  console.log(`events attached (sanitized): ${bundle.events.length}`);
  if (m.redact.length) console.log("preview is sanitized; export writes the same sanitized bundle.");
}

// record this run (a controlled failure still leaves a useful run record)
try {
  appendFileSync(EVENTS, JSON.stringify({ event: incidentMode ? "support-incident" : "support-run", run: bundle.run, at: now(), components: mStatusSummary(bundle) }) + "\n");
} catch { /* event log best-effort */ }
function mStatusSummary(b) {
  return b.manifest.components.map((c) => `${c.component}=${c.status}`).join(",");
}

// export + bounded retention
const exportPath = explicitExport || join(BUNDLES, `bundle-${bundle.run}.json`);
try {
  mkdirSync(dirname(exportPath), { recursive: true });
  writeFileSync(exportPath, JSON.stringify(bundle, null, 2));
  if (!jsonMode) console.log(`exported: ${exportPath}`);
  if (!explicitExport && existsSync(BUNDLES)) {
    const files = readdirSync(BUNDLES).map((f) => [f, statSync(join(BUNDLES, f)).mtimeMs]).sort((a, b) => a[1] - b[1]);
    for (const [f] of files.slice(0, Math.max(0, files.length - MAX_BUNDLES))) {
      unlinkSync(join(BUNDLES, f)); // bounded retention: prune oldest beyond 10
      if (!jsonMode) console.log(`pruned (retention): ${f}`);
    }
  }
} catch (e) {
  console.error(`export failed: ${e.message}`);
  process.exit(3);
}

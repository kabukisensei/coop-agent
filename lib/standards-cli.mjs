#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { bundledStandardsStatus, pinStandardsTask, refreshCanonical, sourceStatus, writeStandardsBundle } from "./standards.mjs";

const [command = "status", domain, cwd = process.cwd()] = process.argv.slice(2);
if (command === "resolve") {
  const result = pinStandardsTask([domain], { cwd }).resolutions[0];
  process.stdout.write(JSON.stringify(result));
} else if (command === "path") {
  const result = pinStandardsTask([domain], { cwd }).resolutions[0];
  if (result.path) process.stdout.write(result.path);
} else if (command === "resolve-many") {
  const domains = String(domain || "").split(",").filter(Boolean);
  const pinned = pinStandardsTask(domains, { cwd });
  process.stdout.write(JSON.stringify(Object.fromEntries(pinned.resolutions.map((r) => [r.domain, r]))));
} else if (command === "resolution-field") {
  const result = JSON.parse(readFileSync(domain, "utf8"));
  const value = String(cwd).split(".").reduce((at, key) => at?.[key], result);
  if (value !== null && value !== undefined) process.stdout.write(String(value));
} else if (command === "resolution-domain") {
  const result = JSON.parse(readFileSync(domain, "utf8"));
  if (!result[cwd]) { process.stderr.write(`resolution domain is missing: ${cwd}\n`); process.exitCode = 2; }
  else process.stdout.write(JSON.stringify(result[cwd]));
} else if (command === "refresh") {
  const result = refreshCanonical({ force: process.argv.slice(3).includes("--force") });
  process.stdout.write(JSON.stringify(result) + "\n");
} else if (command === "doctor-lines") {
  const status = sourceStatus({ cwd });
  process.stdout.write(`source\tcanonical-remote\tconfigured\t${status.repository}|${status.authoritative_branch}\n`);
  // The sync row tells a failed refresh apart from a freshness window that expired
  // since the last successful one: doctor never refreshes, so an install last
  // launched more than freshness_seconds ago is stale, not broken.
  const minutesAgo = (ms) => Math.max(0, Math.round((Date.now() - ms) / 60000));
  const syncRow = status.last_attempt_ok === false ? ["failed", `${status.detail || "last refresh failed"}; run: coop sync`]
    : !status.last_successful_check_ms ? ["never", "no successful refresh yet; run: coop sync"]
      : status.freshness === "stale" ? ["stale", `last checked ${minutesAgo(status.last_successful_check_ms)} min ago; standards refresh at every coop launch, or now with: coop sync`]
        : [status.degraded ? "degraded" : status.freshness, `${status.last_successful_check_ms}|${status.last_successful_sync_ms || "never"}`];
  process.stdout.write(`source\tcanonical-sync\t${syncRow[0]}\t${syncRow[1]}\n`);
  const bundle = status.bundle || {};
  process.stdout.write(`source\tbundled-copy\t${bundle.state || "unavailable"}\t${bundle.state === "available" ? `${bundle.revision}|captured ${new Date(bundle.captured_ms).toISOString().slice(0, 10)}` : (bundle.detail || "no bundled standards")}\n`);
  for (const source of status.sources) {
    process.stdout.write(`source\t${source.id}\t${source.state}\t${source.revision || "none"}|${source.freshness || "n/a"}|${source.degraded ? "degraded" : "ok"}\n`);
    // Wiki problems that do not switch standards off (e.g. a duplicate article id).
    for (const warning of source.warnings || []) process.stdout.write(`source\t${source.id}\twiki_warning\t${String(warning).replace(/[\t\r\n]+/g, " ")}\n`);
  }
  for (const [name, r] of Object.entries(status.domains)) process.stdout.write(`domain\t${name}\t${r.authority_class}/${r.state}\t${r.revision || "none"}|${r.sha256 || "none"}|${r.path || "none"}|${r.freshness}|${r.degraded ? "degraded" : "ok"}|${r.fallback ? "fallback" : "primary"}\n`);
} else if (command === "bundle-update") {
  // Refresh config/standards-bundle from a clean clone of the canonical wiki
  // (maintainers, before a release): `bundle-update [checkout]`.
  const checkout = process.argv[3];
  if (!checkout) { process.stderr.write("usage: standards-cli.mjs bundle-update <clean clone of cooptimize/coop-standards on main>\n"); process.exitCode = 2; }
  else {
    const result = writeStandardsBundle(checkout);
    process.stdout.write(`bundled ${result.articles} article(s) for ${result.domains.join(", ")} at ${result.revision} into ${result.root}\n`);
  }
} else if (command === "bundle-check") {
  const status = bundledStandardsStatus({});
  process.stdout.write(JSON.stringify(status, null, 2) + "\n");
  if (status.state !== "available") process.exitCode = 1;
} else if (command === "status") {
  process.stdout.write(JSON.stringify(sourceStatus({ cwd }), null, 2) + "\n");
} else {
  process.stderr.write("usage: standards-cli.mjs status | refresh [--force] | doctor-lines [cwd] | bundle-check | bundle-update <checkout> | resolve <domain> [cwd] | resolve-many <domain,...> [cwd] | path <domain> [cwd] | resolution-field <json> <field> | resolution-domain <json> <domain>\n");
  process.exitCode = 2;
}

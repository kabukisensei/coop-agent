#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { bindReviewerProvenance, promoteReviewRun, refreshCanonical, resolveStandard, sourceStatus } from "./standards.mjs";

const [command = "status", domain, cwd = process.cwd()] = process.argv.slice(2);
if (command === "resolve") {
  const result = resolveStandard(domain, { cwd });
  process.stdout.write(JSON.stringify(result));
} else if (command === "path") {
  const result = resolveStandard(domain, { cwd });
  if (result.path) process.stdout.write(result.path);
} else if (command === "resolution-field") {
  const result = JSON.parse(readFileSync(domain, "utf8"));
  const value = result[cwd];
  if (value !== null && value !== undefined) process.stdout.write(String(value));
} else if (command === "verify-report") {
  try {
    const resolution = JSON.parse(readFileSync(domain, "utf8"));
    const report = JSON.parse(readFileSync(cwd, "utf8"));
    const result = bindReviewerProvenance(resolution, report);
    if (!result.ok) { process.stderr.write(`${result.error}\n`); process.exitCode = 2; }
    else process.stdout.write(JSON.stringify(result.binding));
  } catch (error) {
    process.stderr.write(`reviewer report is missing or malformed: ${error.message}\n`);
    process.exitCode = 2;
  }
} else if (command === "promote-run") {
  try {
    const [, outdir, sqlResolution, sqlReport, daxResolution, daxReport] = process.argv.slice(2);
    const result = promoteReviewRun(outdir, [
      { domain: "sql", resolutionPath: sqlResolution, reportPath: sqlReport },
      { domain: "dax", resolutionPath: daxResolution, reportPath: daxReport },
    ]);
    if (!result.ok) { process.stderr.write(`${result.error}\n`); process.exitCode = 2; }
    else process.stdout.write(JSON.stringify(result.bindings));
  } catch (error) { process.stderr.write(`review run rejected: ${error.message}\n`); process.exitCode = 2; }
} else if (command === "refresh") {
  const result = refreshCanonical({ force: process.argv.slice(3).includes("--force") });
  process.stdout.write(JSON.stringify(result) + "\n");
} else if (command === "doctor-lines") {
  const status = sourceStatus({ cwd });
  process.stdout.write(`source\tcanonical-remote\tconfigured\t${status.repository}|${status.authoritative_branch}\n`);
  process.stdout.write(`source\tcanonical-sync\t${status.degraded ? "degraded" : status.freshness}\t${status.last_successful_check_ms || "never"}|${status.last_successful_sync_ms || "never"}\n`);
  for (const source of status.sources) process.stdout.write(`source\t${source.id}\t${source.state}\t${source.revision || "none"}|${source.freshness || "n/a"}|${source.degraded ? "degraded" : "ok"}\n`);
  for (const [name, r] of Object.entries(status.domains)) process.stdout.write(`domain\t${name}\t${r.authority_class}/${r.state}\t${r.revision || "none"}|${r.sha256 || "none"}|${r.path || "none"}|${r.freshness}|${r.degraded ? "degraded" : "ok"}|${r.fallback ? "fallback" : "primary"}\n`);
} else if (command === "status") {
  process.stdout.write(JSON.stringify(sourceStatus({ cwd }), null, 2) + "\n");
} else {
  process.stderr.write("usage: standards-cli.mjs status | refresh [--force] | resolve <domain> [cwd] | path <domain> [cwd] | resolution-field <json> <field> | verify-report <resolution-json> <report-json>\n");
  process.exitCode = 2;
}

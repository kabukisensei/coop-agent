#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolveStandard, sourceStatus, verifyReviewerProvenance } from "./standards.mjs";

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
    const result = verifyReviewerProvenance(resolution, report);
    if (!result.ok) { process.stderr.write(`${result.error}\n`); process.exitCode = 2; }
  } catch (error) {
    process.stderr.write(`reviewer report is missing or malformed: ${error.message}\n`);
    process.exitCode = 2;
  }
} else if (command === "doctor-lines") {
  const status = sourceStatus({ cwd });
  process.stdout.write(`source\tcanonical-remote\t${status.canonical_remote}\t\n`);
  for (const source of status.sources) process.stdout.write(`source\t${source.id}\t${source.state}\t${source.revision || "none"}\n`);
  for (const [name, r] of Object.entries(status.domains)) process.stdout.write(`domain\t${name}\t${r.authority_class}/${r.state}\t${r.revision || "none"}|${r.sha256 || "none"}|${r.path || "none"}\n`);
} else if (command === "status") {
  process.stdout.write(JSON.stringify(sourceStatus({ cwd }), null, 2) + "\n");
} else {
  process.stderr.write("usage: standards-cli.mjs status | resolve <domain> [cwd] | path <domain> [cwd] | resolution-field <json> <field> | verify-report <resolution-json> <report-json>\n");
  process.exitCode = 2;
}

#!/usr/bin/env node
import { resolveStandard, sourceStatus } from "./standards.mjs";

const [command = "status", domain, cwd = process.cwd()] = process.argv.slice(2);
if (command === "resolve") {
  const result = resolveStandard(domain, { cwd });
  process.stdout.write(JSON.stringify(result));
} else if (command === "path") {
  const result = resolveStandard(domain, { cwd });
  if (result.path) process.stdout.write(result.path);
} else if (command === "doctor-lines") {
  const status = sourceStatus({ cwd });
  process.stdout.write(`source\tcanonical-remote\t${status.canonical_remote}\t\n`);
  for (const source of status.sources) process.stdout.write(`source\t${source.id}\t${source.state}\t${source.revision || "none"}\n`);
  for (const [name, r] of Object.entries(status.domains)) process.stdout.write(`domain\t${name}\t${r.authority_class}/${r.state}\t${r.revision || "none"}|${r.sha256 || "none"}|${r.path || "none"}\n`);
} else if (command === "status") {
  process.stdout.write(JSON.stringify(sourceStatus({ cwd }), null, 2) + "\n");
} else {
  process.stderr.write("usage: standards-cli.mjs status | resolve <domain> [cwd] | path <domain> [cwd]\n");
  process.exitCode = 2;
}

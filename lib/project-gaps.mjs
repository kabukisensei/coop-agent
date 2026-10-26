#!/usr/bin/env node
// Project-file gaps (A2): the sections a current coop reads that a client's
// .coop/project.yml lacks. Read-only; `coop doctor` prints the rows.
//   node lib/project-gaps.mjs doctor-lines <project.yml>
//   node lib/project-gaps.mjs json <project.yml>
import { readFileSync } from "node:fs";
import { projectFileGaps } from "./project-contract.mjs";

const [command, file] = process.argv.slice(2);
if (!command || !file || !["doctor-lines", "json"].includes(command)) {
  console.error("usage: node lib/project-gaps.mjs doctor-lines|json <project.yml>");
  process.exit(2);
}
let text = "";
try {
  text = readFileSync(file, "utf8");
} catch {
  console.error(`cannot read ${file}`);
  process.exit(1);
}
const gaps = projectFileGaps(text);
if (command === "json") {
  process.stdout.write(`${JSON.stringify({ file, gaps })}\n`);
} else if (!gaps.length) {
  process.stdout.write("ok\tproject file has every section this coop reads\n");
} else {
  for (const gap of gaps) {
    process.stdout.write(`warn\tproject file lacks ${gap.path}: ${gap.why}\tadd it with /setup-project (or the Project pane); nothing else in the file changes\n`);
  }
}

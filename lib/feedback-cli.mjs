#!/usr/bin/env node
/** `coop feedback`: the shell form of /feedback, for when coop itself will not
 * start. Asks for the kind, a title and what happened, builds the same redacted
 * report as /feedback (lib/feedback.mjs) with no session errors, shows it, lets
 * the person edit it in Notepad, then opens the pre-filled new-issue page on the
 * private feedback repository. Nothing is sent by coop.
 *
 * Usage:
 *   node lib/feedback-cli.mjs [--kind bug|idea|question] [--title TEXT] [--description TEXT] [--print] [--no-open]
 *   --print    print the redacted preview and the link, open and save nothing (tests, scripts)
 *   --no-open  save and copy the report but do not open the browser
 */
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  KINDS, KIND_IDS, buildReport, collectRedactionTerms, deliverReport, environmentFacts, feedbackRepo,
  issueUrl, redactText, reportsDir, splitPreview,
} from "./feedback.mjs";
import { findProjectContract } from "./standards.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined; };
if (flag("--help") || flag("-h")) {
  console.log("coop feedback [--kind bug|idea|question] [--title TEXT] [--description TEXT] [--print] [--no-open]");
  console.log("Builds a redacted report, shows it for editing, then opens a pre-filled issue on the private coop feedback repository.");
  process.exit(0);
}

const env = process.env;
const repo = feedbackRepo(env);
const interactive = Boolean(process.stdin.isTTY) && !flag("--print");
const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
const ask = async (q) => (rl ? (await rl.question(q)).trim() : "");

async function main() {
  let kind = option("--kind");
  if (kind && !KIND_IDS.includes(kind)) { console.error(`--kind must be one of: ${KIND_IDS.join(", ")}`); return 2; }
  if (!kind) {
    if (!rl) kind = "bug";
    else {
      console.log(`Send feedback to the coop team (${repo}, private). Nothing is filed until you press Submit on GitHub.`);
      KINDS.forEach((k, i) => console.log(`  ${i + 1}. ${k.label}`));
      const n = Number(await ask("Which one? [1] ")) || 1;
      kind = (KINDS[n - 1] || KINDS[0]).id;
    }
  }
  const info = KINDS.find((k) => k.id === kind);
  let title = option("--title") || (await ask("A short title: "));
  if (!title) { console.error("No feedback sent: a title is needed."); return 1; }
  let description = option("--description");
  if (description === undefined && rl) {
    console.log(`${info.heading} (end with a line holding only a full stop)`);
    const lines = [];
    for (;;) { const line = await rl.question(""); if (line.trim() === ".") break; lines.push(line); }
    description = lines.join("\n");
  }
  let projectFile = "";
  try { projectFile = findProjectContract(process.cwd(), env) || ""; } catch { projectFile = ""; }
  const names = collectRedactionTerms({ projectFiles: projectFile ? [projectFile] : [], env, cwd: process.cwd() });
  const report = buildReport({ kind, title, description: description || "", facts: environmentFacts({ surface: "shell", env }), errors: [], names });
  let preview = `# ${report.title}\n\n${report.body}`;

  if (flag("--print")) {
    console.log(preview);
    console.log("");
    console.log(issueUrl({ repo, kind, title: report.title, body: report.body }).url);
    return 0;
  }

  if (rl) {
    for (;;) {
      console.log("\n----- the report -----\n" + preview + "\n----------------------");
      const choice = (await ask("Enter opens GitHub with this filled in, e edits it in Notepad, q quits: ")).toLowerCase();
      if (choice === "q") { console.log("No feedback sent."); return 0; }
      if (choice !== "e") break;
      const dir = reportsDir(env);
      mkdirSync(dir, { recursive: true });
      const draft = join(dir, "feedback-draft.md");
      writeFileSync(draft, preview, "utf8");
      const editor = process.platform === "win32" ? "notepad.exe" : (env.VISUAL || env.EDITOR || "vi");
      spawnSync(editor, [draft], { stdio: "inherit" });
      try { preview = readFileSync(draft, "utf8"); } catch { /* keep the last one */ }
    }
  }
  // The person's edits go through the same redaction again.
  const split = splitPreview(preview);
  const finalTitle = redactText(split.title || report.title, names).text;
  const finalBody = redactText(split.body, names).text;
  const result = deliverReport({ repo, kind, title: finalTitle, body: finalBody, env, ...(flag("--no-open") ? { open: () => false } : {}) });
  if (result.opened) console.log(`Opened the new-issue page on ${repo}: check it and press Submit.${result.cut ? " The report was cut to fit the link; the full text is on your clipboard." : ""}`);
  else console.log(`${result.copied ? "The report is on your clipboard." : ""} Paste it into a new issue at https://github.com/${repo}/issues/new, or send it in Teams.`.trim());
  if (result.file) console.log(`Saved: ${result.file}`);
  return 0;
}

main().then((code) => { rl?.close(); process.exit(code); }, (error) => { rl?.close(); console.error(`coop feedback failed: ${error.message}. Nothing was sent.`); process.exit(1); });

// Fresh-context standards check (master plan row SC1).
//
// coop's self-check (coop-workflow step 7) runs in the conversation that wrote the
// change, so it grades its own work with the writer's blind spots. `standards_check`
// sends one separate model request that sees only the change and the standards
// articles, never the conversation, and returns findings that each name a file, a
// line and the article they break. Findings the model cannot ground (no line, an
// article it was not given, a file outside the change) are dropped here, so the
// writer never chases an invented rule.
//
// Pure helpers live here so tests run them without Pi; extensions/coop-tools wires
// them to the session's model.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

/** The longest change text sent to the checker; past it the tool says what it left out. */
export const CHANGE_CHAR_LIMIT = 60000;
/** A new or untracked file is sent whole up to this many characters. */
const NEW_FILE_CHAR_LIMIT = 30000;
const SQL_EXT = /\.sql$/i;
const MODEL_EXT = /\.(tmdl|bim|pbism)$/i;
const DAX_EXT = /\.(dax|tmdl)$/i;

function runGit(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
}

function numbered(text) {
  return text.split(/\r?\n/).map((line, i) => `${String(i + 1).padStart(5)}  ${line}`).join("\n");
}

/**
 * The change for each file: the git diff against HEAD (staged and unstaged) for a
 * tracked file, the whole numbered file for a new one or one outside git. `git` is a
 * seam for tests: (cwd, args) => stdout, throwing when git fails.
 */
export function collectChange(files, cwd, git = runGit) {
  const parts = [];
  const checked = [];
  const skipped = [];
  for (const raw of files || []) {
    const file = String(raw || "").trim();
    if (!file) continue;
    const abs = isAbsolute(file) ? file : resolve(cwd, file);
    let isFile = false;
    try { isFile = statSync(abs).isFile(); } catch { isFile = false; }
    if (!isFile) { skipped.push(`${file} (not found)`); continue; }
    const shown = relative(cwd, abs) && !relative(cwd, abs).startsWith("..") ? relative(cwd, abs).replace(/\\/g, "/") : abs;
    let top = null;
    try { top = git(dirname(abs), ["rev-parse", "--show-toplevel"]).trim() || null; } catch { top = null; }
    let tracked = false;
    if (top) {
      try { git(dirname(abs), ["ls-files", "--error-unmatch", "--", basename(abs)]); tracked = true; } catch { tracked = false; }
    }
    if (tracked) {
      let diff = "";
      try { diff = git(dirname(abs), ["diff", "--no-color", "--no-ext-diff", "-U3", "HEAD", "--", basename(abs)]); } catch { diff = ""; }
      if (!diff.trim()) { skipped.push(`${shown} (no change against the last commit)`); continue; }
      parts.push(`=== ${shown} (diff against the last commit; + lines are the change) ===\n${diff.trimEnd()}`);
      checked.push({ file: shown, baseline: "git" });
    } else {
      let text = "";
      try { text = readFileSync(abs, "utf8"); } catch { skipped.push(`${shown} (unreadable)`); continue; }
      const cut = text.length > NEW_FILE_CHAR_LIMIT;
      const body = numbered(cut ? text.slice(0, NEW_FILE_CHAR_LIMIT) : text);
      const why = top ? "new file, not yet in git" : "no git history: every line counts as part of the change";
      parts.push(`=== ${shown} (${why}; line numbers on the left) ===\n${body}${cut ? `\n[cut at ${NEW_FILE_CHAR_LIMIT} characters]` : ""}`);
      checked.push({ file: shown, baseline: top ? "new" : "none" });
    }
  }
  let text = parts.join("\n\n");
  let truncated = false;
  if (text.length > CHANGE_CHAR_LIMIT) { text = `${text.slice(0, CHANGE_CHAR_LIMIT)}\n[change cut at ${CHANGE_CHAR_LIMIT} characters]`; truncated = true; }
  return { text, checked, skipped, truncated };
}

/** Words that steer lib/standards.mjs to the right domains and articles for these files. */
export function standardsQuery(files, changeText, task = "") {
  const names = (files || []).map((f) => String(f));
  const hints = [];
  if (names.some((f) => SQL_EXT.test(f))) hints.push("T-SQL");
  if (names.some((f) => MODEL_EXT.test(f))) hints.push("semantic model TMDL");
  if (names.some((f) => DAX_EXT.test(f))) hints.push("DAX measure");
  // Only the added lines say what the change is about; context lines would pull in
  // articles for code the change did not touch.
  const added = String(changeText || "").split("\n").filter((l) => /^\+(?!\+\+)/.test(l) || /^\s*\d+\s{2}/.test(l)).join("\n").slice(0, 4000);
  return `Check this ${hints.join(" and ") || "change"} against the standards. ${task}\n${names.join("\n")}\n${added}`.trim();
}

export const CHECKER_SYSTEM_PROMPT = [
  "You are a standards reviewer for Cooptimize data work (T-SQL, Fabric Warehouse, DAX, Power BI semantic models).",
  "You see one change and the standards articles that govern it. You did not write the change.",
  "Report only places where the change breaks a rule that one of the given articles states. Never apply a rule from memory or general best practice.",
  "Every finding names the file, a line number in that file, the article's exact title, and the rule broken in a few words.",
  "Mark each finding introduced=true when the change added or modified that line (a + line in a diff, or any line of a file with no history), introduced=false when the problem was already there in a context line.",
  "Skip taste, formatting the articles do not mention, and anything you cannot point to a line for. One finding per rule per place; a rule broken the same way on many lines is one finding naming the first line and how many more.",
  "Answer with JSON only, no prose: {\"findings\":[{\"file\":\"...\",\"line\":12,\"article\":\"<exact title>\",\"rule\":\"...\",\"problem\":\"...\",\"fix\":\"...\",\"introduced\":true}]}. When nothing breaks a rule, answer {\"findings\":[]}.",
].join("\n");

export function checkerUserPrompt(changeText, standardsText) {
  return `<standards>\n${standardsText}\n</standards>\n\n<change>\n${changeText}\n</change>\n\nCheck the change against the standards. JSON only.`;
}

/** The standards text and the article titles the checker may cite. */
export function standardsForChecker(records) {
  const titles = [];
  const blocks = [];
  for (const record of records || []) {
    for (const s of record.sections || []) {
      if (!s.content) continue;
      titles.push(String(s.heading));
      blocks.push(`## ${s.heading}${s.file ? ` (${s.file})` : ""}\n${s.content}`);
    }
  }
  return { titles: [...new Set(titles)], text: blocks.join("\n\n") };
}

function extractJson(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  }
  return null;
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Keep only findings the checker grounded: a file that was checked, a positive line,
 * and an article it was given. Returns the kept findings and how many were dropped.
 */
export function parseFindings(text, { titles = [], files = [] } = {}) {
  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.findings)) return { ok: false, findings: [], dropped: 0 };
  const known = titles.map(norm);
  const checkedFiles = files.map((f) => String(f).replace(/\\/g, "/"));
  const fileFor = (f) => {
    const s = String(f || "").replace(/\\/g, "/");
    return checkedFiles.find((c) => c === s || c.endsWith(`/${s}`) || s.endsWith(`/${c}`) || basename(c) === s) || null;
  };
  const findings = [];
  let dropped = 0;
  for (const f of parsed.findings) {
    const file = f && fileFor(f.file);
    const line = Number(f?.line);
    const article = norm(f?.article);
    const title = article ? titles[known.findIndex((k) => k === article || k.includes(article) || article.includes(k))] : undefined;
    if (!file || !Number.isInteger(line) || line < 1 || !title || !String(f.problem || f.rule || "").trim()) { dropped += 1; continue; }
    findings.push({
      file,
      line,
      article: title,
      rule: String(f.rule || "").trim(),
      problem: String(f.problem || "").trim(),
      fix: String(f.fix || "").trim(),
      introduced: f.introduced !== false,
    });
  }
  findings.sort((a, b) => Number(b.introduced) - Number(a.introduced) || a.file.localeCompare(b.file) || a.line - b.line);
  return { ok: true, findings, dropped };
}

/** What the writing model reads back: the count first, then one line per finding. */
export function findingsText(result) {
  const { findings = [], dropped = 0, checked = [], skipped = [], truncated = false, titles = [] } = result;
  const fresh = findings.filter((f) => f.introduced);
  const old = findings.filter((f) => !f.introduced);
  const scope = `${checked.length} file(s) against ${titles.length} article(s): ${titles.join(", ")}`;
  const lines = [];
  if (!findings.length) {
    lines.push(`standards_check: no standards problems found in the change (${scope}).`);
  } else {
    lines.push(`standards_check: ${fresh.length} problem(s) in the change, ${old.length} pre-existing (${scope}).`);
    for (const f of fresh) lines.push(`- ${f.file}:${f.line} [${f.article}] ${f.rule ? `${f.rule}: ` : ""}${f.problem}${f.fix ? ` Fix: ${f.fix}` : ""}`);
    if (old.length) {
      lines.push("Pre-existing (already there before this change; mention them, fix only if asked):");
      for (const f of old) lines.push(`- ${f.file}:${f.line} [${f.article}] ${f.rule ? `${f.rule}: ` : ""}${f.problem}`);
    }
    if (fresh.length) lines.push("Fix each problem in the change before presenting it, or name the user's exception or your concrete reason for it in the summary. A finding you judge wrong: say why in one line.");
  }
  if (dropped) lines.push(`(${dropped} finding(s) dropped: no line, or an article the check was not given.)`);
  if (truncated) lines.push("The change was cut to fit; check the rest yourself.");
  if (skipped.length) lines.push(`Not checked: ${skipped.join("; ")}.`);
  return lines.join("\n");
}

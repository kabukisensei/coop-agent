// The docs setup form's back end (master plan D1b2): /setup-docs as one panel.
// It runs the same `coop-data-doc setup --transport jsonl` wizard through the
// same driver as /setup-docs (lib/data-doc-setup.mjs), with the same prefill,
// and shows each prompt as a form field instead of a dialog; coop-data-doc
// stays the only writer of coop-data-doc.yml. Answers are untrusted:
// normalizeAnswer gives the wizard exactly what /setup-docs's dialogs would.
// After a completed setup, Build runs `coop-data-doc build` with its output
// streamed to the form, and the built Markdown docs open in a pane.
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DATADOC_CONFIG,
  DEFAULT_OUTPUT_DIR,
  driveJsonlSetup,
  findDataDocConfig,
  isHomeFolder,
  parseExisting,
  resolveDataDocExecutable,
  setupDocsPrefill,
} from "../../lib/data-doc-setup.mjs";
import { cleanAnswer } from "../../lib/project-contract.mjs";

const MAX_TEXT = 4000;
const MAX_CHOICES = 500;
const MAX_PAGE = 1024 * 1024;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export const MESSAGES = Object.freeze({
  homeFolder: "coop didn't set up lineage docs: this window is open in your home folder, and coop-data-doc.yml belongs in a project folder, so nothing was written. Open the project folder in a coop window (Open folder...), then set up the docs there.",
  noJsonl: "Your coop-data-doc does not support the native JSONL setup wizard. Run `coop update` (requires coop-data-doc 1.1.1+), then retry.",
  notRunnable: (reason) => `Not building yet: ${reason || "the saved config doesn't validate"}. Run the setup again and choose a folder that exists (or fix the path in ${DATADOC_CONFIG}), then build.`,
});

const str = (value, max = MAX_TEXT) => (typeof value === "string" ? value.slice(0, max) : "");

/** A wizard prompt as the form receives it: only the fields it draws. */
export function formPrompt(prompt) {
  const choices = Array.isArray(prompt.choices) ? prompt.choices.slice(0, MAX_CHOICES) : [];
  const def = prompt.default;
  return {
    id: str(prompt.id, 200),
    kind: ["text", "path", "confirm", "select", "checkbox"].includes(prompt.kind) ? prompt.kind : "text",
    message: str(prompt.message),
    default: typeof def === "boolean" ? def : typeof def === "string" ? str(def) : Array.isArray(def) ? def.filter((v) => typeof v === "string").map((v) => str(v)) : null,
    choices: choices.map((c) => ({ label: str(c && c.label, 500), value: str(c && c.value, 2000), checked: Boolean(c && c.checked) })),
  };
}

export class AnswerError extends Error {}

/**
 * The answer /setup-docs's dialogs would send for this form input. Text: the
 * cleaned text or the default; path: the trimmed text or the default; confirm:
 * true or false; select: one offered value; checkbox: offered values in the
 * wizard's order.
 */
export function normalizeAnswer(prompt, raw) {
  const def = typeof prompt.default === "string" ? prompt.default : "";
  switch (prompt.kind) {
    case "confirm":
      if (typeof raw !== "boolean") throw new AnswerError("choose yes or no");
      return raw;
    case "select": {
      const values = (prompt.choices || []).map((c) => c.value);
      if (typeof raw !== "string" || !values.includes(raw)) throw new AnswerError("choose one of the options");
      return raw;
    }
    case "checkbox": {
      const values = (prompt.choices || []).map((c) => c.value);
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string" || !values.includes(v))) throw new AnswerError("choose from the options");
      const picked = new Set(raw);
      return values.filter((v) => picked.has(v));
    }
    case "path":
      if (typeof raw !== "string") throw new AnswerError("type a folder");
      return raw.trim() || def;
    default:
      if (typeof raw !== "string") throw new AnswerError("type an answer");
      return cleanAnswer(raw.slice(0, MAX_TEXT)) || def;
  }
}

/** The folder a path answer is relative to: the selected config's folder, as /setup-docs uses. */
export function pathBase(cwd, env) {
  const config = findDataDocConfig(cwd, env);
  return config ? dirname(config) : cwd;
}

/** A folder picked in the window as the path answer /setup-docs's folder browser gives. */
export function pickedPathAnswer(base, folder, def = "") {
  if (isAbsolute(def)) return folder;
  return relative(base, folder).replace(/\\/g, "/") || ".";
}

function supportsJsonl(executable, cwd, env, execFileImpl = execFile) {
  return new Promise((resolveSupport) => {
    execFileImpl(executable, ["setup", "--help"], { cwd, env, windowsHide: true, timeout: 30_000, encoding: "utf8" }, (error, stdout, stderr) => {
      resolveSupport(/--transport/.test(`${stdout || ""}\n${stderr || ""}`));
    });
  });
}

/**
 * One run of the setup wizard for a window. send(event) reports to the form:
 * { type: "prompt", prompt }, { type: "notice", level, message } and finally
 * { type: "done", ok, notRunnable, message }.
 */
export class DocsSetupRun {
  constructor({ cwd, env, send, platform = process.platform, spawnImpl, execFileImpl }) {
    this.cwd = cwd;
    this.env = env;
    this.send = send;
    this.platform = platform;
    this.spawnImpl = spawnImpl;
    this.execFileImpl = execFileImpl;
    this.pending = null;
    this.child = null;
    this.finished = false;
  }

  async start() {
    const done = (ok, extra = {}) => { this.finished = true; this.pending = null; this.send({ type: "done", ok, ...extra }); return ok; };
    if (isHomeFolder(this.cwd)) return done(false, { message: MESSAGES.homeFolder });
    let executable;
    try { executable = resolveDataDocExecutable(this.platform, this.env); } catch (error) { return done(false, { message: error.message }); }
    if (!(await supportsJsonl(executable, this.cwd, this.env, this.execFileImpl))) return done(false, { message: MESSAGES.noJsonl });
    // Path answers are relative to the config the run started with, as in /setup-docs.
    this.base = pathBase(this.cwd, this.env);
    const outcome = {};
    const ok = await driveJsonlSetup({
      executable,
      cwd: this.cwd,
      env: this.env,
      prefill: setupDocsPrefill(this.cwd, this.env),
      outcome,
      ask: (prompt) => this.ask(prompt),
      notify: (message, level) => this.send({ type: "notice", level, message: String(message).replace(ANSI, "") }),
      ...(this.spawnImpl ? { spawnImpl: this.spawnImpl } : {}),
      onChild: (child) => { this.child = child; },
    });
    this.child = null;
    return done(ok, ok && outcome.notRunnable !== undefined ? { notRunnable: true, message: MESSAGES.notRunnable(outcome.notRunnable) } : {});
  }

  ask(prompt) {
    const shown = formPrompt(prompt);
    return new Promise((resolveAnswer) => {
      this.pending = { id: shown.id, prompt: shown, resolve: resolveAnswer };
      this.send({ type: "prompt", prompt: shown });
    });
  }

  /** The form's answer to the open prompt; throws AnswerError when it does not fit. */
  answer(id, raw) {
    const pending = this.pending;
    if (!pending || pending.id !== id) throw new AnswerError("that question was already answered");
    const value = normalizeAnswer(pending.prompt, raw);
    this.pending = null;
    pending.resolve(value);
    return value;
  }

  /** Cancel: the open prompt answers "cancelled", as Esc does in /setup-docs. */
  cancel() {
    if (this.pending) { const pending = this.pending; this.pending = null; pending.resolve(null); return; }
    if (this.child) { try { this.child.kill(); } catch { /* already gone */ } }
  }
}

/** Where the folder's docs config, built Markdown and HTML portal are. */
export function docsLocation(cwd, env) {
  const config = findDataDocConfig(cwd, env) || join(cwd, DATADOC_CONFIG);
  const exists = existsSync(config);
  const settings = exists ? parseExisting(readFileSync(config, "utf8")) : {};
  const base = dirname(config);
  const outputDir = resolve(base, settings.outputDir || DEFAULT_OUTPUT_DIR);
  const built = existsSync(join(outputDir, "manifest.json")) || existsSync(join(outputDir, "index.md"));
  const siteIndex = resolve(base, siteDirOf(exists ? readFileSync(config, "utf8") : ""), "index.html");
  return { config, exists, outputDir, built, portal: existsSync(siteIndex) ? siteIndex : "" };
}

// output.site_dir (coop-data-doc's config.py default ./data-docs-site).
function siteDirOf(text) {
  let inOutput = false;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) { inOutput = /^output\s*:/.test(raw); continue; }
    const match = inOutput ? /^\s+site_dir\s*:\s*(.*)$/.exec(raw) : null;
    if (match) {
      const value = match[1].replace(/\s+#.*$/, "").trim().replace(/^(['"])(.*)\1$/, "$2");
      if (value) return value;
    }
  }
  return "./data-docs-site";
}

/**
 * Read one built Markdown page by its path relative to the docs folder. Only
 * .md files inside that folder are served (symlinks resolved), up to 1 MB.
 */
export function readDocsPage(outputDir, page) {
  const rel = String(page || "index.md").replace(/\\/g, "/").replace(/^\/+/, "").split("#")[0] || "index.md";
  if (!/\.md$/i.test(rel) || rel.split("/").includes("..")) throw new Error("only the built Markdown docs open here");
  const root = realpathSync(outputDir);
  const full = realpathSync(resolve(root, rel));
  if (full !== root && !full.startsWith(root + sep)) throw new Error("only the built Markdown docs open here");
  if (statSync(full).size > MAX_PAGE) throw new Error("that page is too large to show here; open the portal instead");
  return { page: relative(root, full).replace(/\\/g, "/"), text: readFileSync(full, "utf8") };
}

/**
 * Run `coop-data-doc build` in the folder, as /setup-docs's Build now does.
 * onLine(text) gets each output line; resolves { code, tail }.
 */
export function runDocsBuild({ cwd, env, platform = process.platform, onLine, spawnImpl = spawn, onChild }) {
  const executable = resolveDataDocExecutable(platform, env);
  return new Promise((resolveBuild) => {
    const child = spawnImpl(executable, ["build"], { cwd, env: { ...env, PYTHONIOENCODING: "utf-8" }, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
    if (onChild) onChild(child);
    const tail = [];
    const partial = { stdout: "", stderr: "" };
    const take = (stream) => (chunk) => {
      const lines = (partial[stream] + chunk.toString("utf8")).split(/\r?\n|\r/);
      partial[stream] = lines.pop();
      for (const line of lines) emit(line);
    };
    const emit = (line) => {
      const text = line.replace(ANSI, "");
      if (!text.trim()) return;
      tail.push(text);
      if (tail.length > 20) tail.shift();
      if (onLine) onLine(text.slice(0, 2000));
    };
    child.stdout?.on("data", take("stdout"));
    child.stderr?.on("data", take("stderr"));
    child.once("error", (error) => resolveBuild({ code: null, tail: [`Couldn't run coop-data-doc: ${error.message}. Is it installed? (coop install)`] }));
    child.once("close", (code) => {
      emit(partial.stdout);
      emit(partial.stderr);
      resolveBuild({ code, tail: tail.slice(-3) });
    });
  });
}

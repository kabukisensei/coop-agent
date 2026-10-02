// coop-data-doc's setup wizard as coop drives it: config discovery, the
// prefill coop offers, and the JSONL protocol of `coop-data-doc setup
// --transport jsonl`. One implementation for /setup-docs (the coop-tools
// extension renders each prompt as a Pi dialog) and the coop window's docs
// setup form (desktop/, a prompt is a form field). coop never writes
// coop-data-doc.yml itself: the wizard in coop-data-doc owns that file, and
// coop only READS the few scalars it needs (parseExisting). Keys and defaults
// mirror coop-data-doc/src/coop_data_doc/config.py; if that schema changes,
// mirror it here.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { findProjectContract } from "./standards.mjs";
import { projectYamlScalar, repositoryNames, scalarValue } from "./project-contract.mjs";

export const DATADOC_CONFIG = "coop-data-doc.yml";
export const DEFAULT_OUTPUT_DIR = "./data-docs";
/** coop-data-doc's notice when setup saved a config that fails validation (for
 *  example a repo path that doesn't exist). Setup still completes with exit 0. */
export const NOT_RUNNABLE_NOTICE = "Saved, but not runnable yet:";

/**
 * @typedef {{ projectName?: string, sqlPath?: string, pbiPath?: string, outputDir?: string,
 *   sourceMode?: "both" | "sql" | "powerbi" | "none" }} DataDocSetupPrefill
 * @typedef {{ label: string, value: string, checked?: boolean }} JsonlChoice
 * @typedef {{ type: "prompt", id: string, kind: "text" | "path" | "confirm" | "select" | "checkbox",
 *   message: string, default?: unknown, choices?: JsonlChoice[] }} JsonlPrompt
 */

const errMsg = (e) => (e && e.message ? e.message : String(e));

function safeRead(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

export function expandHomePath(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

/** Two paths name the same folder (case-insensitive on Windows). */
export function samePath(a, b) {
  const aa = resolve(a).replace(/\\/g, "/");
  const bb = resolve(b).replace(/\\/g, "/");
  return process.platform === "win32" ? aa.toLowerCase() === bb.toLowerCase() : aa === bb;
}

/** True when `cwd` is the user's home folder, where coop never sets up docs
 *  (the desktop shortcuts start coop there; #102). */
export function isHomeFolder(cwd) {
  let home = "";
  try { home = homedir(); } catch { return false; }
  return Boolean(cwd && home) && samePath(cwd, home);
}

/** Match the companion's environment-first, ancestor config discovery. */
export function findDataDocConfig(cwd, env = process.env) {
  const selected = env.COOP_DATA_DOC_CONFIG;
  if (selected) {
    const candidate = resolve(cwd, expandHomePath(selected));
    let existing = candidate;
    while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
    try { return resolve(realpathSync(existing), relative(existing, candidate)); } catch { return candidate; }
  }
  let directory = resolve(cwd);
  for (;;) {
    const candidate = join(directory, DATADOC_CONFIG);
    try { if (statSync(candidate).isFile()) return realpathSync(candidate); } catch { /* absent */ }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** Locate the lines for the 4 scalars coop reads (project_name, repos.sql.path,
 *  repos.powerbi.path, output.dir) — robust to 2- or 4-space indentation, extra
 *  repo keys (e.g. a third `staging:`), and nested mappings. Block-style YAML only
 *  (best-effort), matching what coop-data-doc emits.
 *  @returns {Array<{ i: number, key: "project_name" | "sql_path" | "powerbi_path" | "output_dir" }>} */
export function classifyManagedLines(text) {
  const lines = text.split("\n");
  const found = [];
  let section = null;
  let repo = null;
  let repoIndent = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\t/g, "  ");
    const body = line.trim();
    if (!body || body.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      section = null;
      repo = null;
      repoIndent = null;
      const ci = body.indexOf(":");
      const key = ci >= 0 ? body.slice(0, ci) : body;
      if (key === "repos") section = "repos";
      else if (key === "output") section = "output";
      else if (key === "project_name" && ci >= 0) found.push({ i, key: "project_name" });
      continue;
    }
    if (section === "repos") {
      if (repoIndent === null) repoIndent = indent; // first nested key sets the repo level
      if (indent === repoIndent) {
        repo = body.startsWith("sql:") ? "sql" : body.startsWith("powerbi:") ? "powerbi" : null;
      } else if (indent > repoIndent && repo && body.startsWith("path:")) {
        found.push({ i, key: repo === "sql" ? "sql_path" : "powerbi_path" });
      }
    } else if (section === "output") {
      if (body.startsWith("dir:")) found.push({ i, key: "output_dir" });
    }
  }
  return found;
}

/** Best-effort prefill: pull the few scalars we manage from an existing yml.
 *  @returns {DataDocSetupPrefill} */
export function parseExisting(text) {
  const out = {};
  const lines = text.split("\n");
  for (const { i, key } of classifyManagedLines(text)) {
    const v = scalarValue(lines[i].slice(lines[i].indexOf(":") + 1));
    if (key === "project_name") out.projectName = v;
    else if (key === "sql_path") out.sqlPath = v;
    else if (key === "powerbi_path") out.pbiPath = v;
    else if (key === "output_dir") out.outputDir = v;
  }
  out.sourceMode = out.sqlPath && out.pbiPath ? "both" : out.sqlPath ? "sql" : out.pbiPath ? "powerbi" : "none";
  return out;
}

/** Use the project contract to prefill data-doc without making users type repo paths twice.
 *  @returns {DataDocSetupPrefill} */
export function dataDocPrefillFromProject(cwd) {
  const contract = findProjectContract(cwd);
  if (!contract) return {};
  const text = safeRead(contract);
  const projectRoot = resolve(contract, "..", "..");
  let sqlPath = "", pbiPath = "";
  let sql = false, powerbi = false;
  const fromRoot = (raw) => {
    const absolute = isAbsolute(raw) ? raw : resolve(projectRoot, raw);
    // project.yml and coop-data-doc.yml are portable contracts, so keep their
    // relative paths stable when the same project is opened on Windows.
    return relative(cwd, absolute).replace(/\\/g, "/") || ".";
  };
  for (const name of repositoryNames(text)) {
    const role = projectYamlScalar(text, ["repositories", name, "role"]) || "generic";
    const raw = projectYamlScalar(text, ["repositories", name, "local_path"]);
    if (!raw || /^TODO\b/i.test(raw)) continue;
    if ((role === "sql" || role === "mixed") && !sqlPath) { sqlPath = fromRoot(raw); sql = true; }
    if ((role === "powerbi" || role === "mixed") && !pbiPath) { pbiPath = fromRoot(raw); powerbi = true; }
  }
  const sourceMode = sql && powerbi ? "both" : sql ? "sql" : powerbi ? "powerbi" : "none";
  return {
    sourceMode,
    ...(sqlPath ? { sqlPath } : {}),
    ...(pbiPath ? { pbiPath } : {}),
    projectName: projectYamlScalar(text, ["profile", "client"]),
  };
}

/** What /setup-docs prefills for a folder: the contract's repositories, then
 *  whatever the existing coop-data-doc.yml already says. */
export function setupDocsPrefill(cwd, env = process.env) {
  const ymlPath = findDataDocConfig(cwd, env) || join(cwd, DATADOC_CONFIG);
  const existing = existsSync(ymlPath) ? parseExisting(safeRead(ymlPath)) : {};
  return { ...dataDocPrefillFromProject(dirname(ymlPath)), ...existing };
}

export function resolveDataDocExecutable(platform = process.platform, env = process.env) {
  if (platform !== "win32") return "coop-data-doc";
  const pathValue = env.PATH || env.Path || "";
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    const exe = join(dir, "coop-data-doc.exe");
    if (existsSync(exe)) return exe;
  }
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    if (existsSync(join(dir, "coop-data-doc.cmd")) || existsSync(join(dir, "coop-data-doc.bat"))) {
      throw new Error("Found only an unsafe .cmd/.bat shim. Reinstall coop-data-doc with pipx so coop-data-doc.exe is on PATH.");
    }
  }
  throw new Error("coop-data-doc.exe was not found on PATH. Run `coop install`.");
}

export class JsonlLineDecoder {
  constructor(maxLine = 1024 * 1024) {
    this.maxLine = maxLine;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
  }

  push(chunk) {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    if (this.buffer.length > this.maxLine && !this.buffer.includes("\n")) throw new Error("JSONL line exceeds 1 MiB");
    const out = [];
    for (;;) {
      const i = this.buffer.indexOf("\n");
      if (i < 0) break;
      let line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > this.maxLine) throw new Error("JSONL line exceeds 1 MiB");
      out.push(line);
    }
    return out;
  }

  finish() {
    this.buffer += this.decoder.end();
    if (this.buffer.length) throw new Error("JSONL stream ended with a partial line");
  }
}

/** A wizard prompt with coop's prefill as its default, where coop knows better. */
export function prefilledPrompt(evt, prefill = {}) {
  const prompt = { ...evt };
  if (prompt.id === "project_name" && prefill.projectName) prompt.default = prefill.projectName;
  if (prompt.id === "local_sources" && prefill.sourceMode) prompt.default = prefill.sourceMode;
  if (prompt.kind === "path" && /SQL repo path/i.test(prompt.message) && prefill.sqlPath) prompt.default = prefill.sqlPath;
  if (prompt.kind === "path" && /Power BI repo path/i.test(prompt.message) && prefill.pbiPath) prompt.default = prefill.pbiPath;
  return prompt;
}

/**
 * Drive the authoritative JSONL wizard. Terminal event and exit code must agree.
 *
 * ask(prompt) answers one prompt (any JSON value) or returns null when the
 * person cancelled; notify(message, level) reports what the wizard says and
 * what went wrong. Resolves true only after a completed setup; outcome gets
 * notRunnable when the wizard saved a config that cannot build yet.
 */
export async function driveJsonlSetup({ executable, cwd, env = process.env, prefill = {}, outcome = {}, ask, notify, spawnImpl = spawn, onChild }) {
  const child = spawnImpl(executable, ["setup", "--transport", "jsonl"], { cwd, env: { ...env, PYTHONIOENCODING: "utf-8" }, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
  if (onChild) onChild(child);
  let stderrTail = "", terminal = null, protocolError = "";
  let helloSeen = false;
  child.stderr?.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
  child.stdin?.on("error", (e) => { protocolError ||= `wizard input closed: ${errMsg(e)}`; });
  const decoder = new JsonlLineDecoder();
  let chain = Promise.resolve();
  const send = async (payload) => {
    if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) {
      throw new Error("coop-data-doc closed before it accepted the wizard answer");
    }
    await new Promise((resolveWrite, rejectWrite) => {
      child.stdin.write(JSON.stringify(payload) + "\n", (error) => {
        if (!error) { resolveWrite(); return; }
        // EPIPE race: the wizard exited before consuming the answer. Report it
        // exactly like the pre-write closed check so the user-facing message is
        // stable regardless of which event (stream 'error' vs write callback)
        // lands first — a bare "write EPIPE" both reads worse and flakes the
        // early-close integration assertion under load.
        rejectWrite(error && error.code === "EPIPE"
          ? new Error("coop-data-doc closed before it accepted the wizard answer")
          : error);
      });
    });
  };
  const accept = async (line) => {
    if (!line.trim()) return;
    let evt;
    try { evt = JSON.parse(line); } catch { throw new Error("malformed JSONL from coop-data-doc"); }
    if (!evt || typeof evt !== "object" || !("type" in evt)) throw new Error("invalid JSONL event");
    if (evt.type === "hello") {
      // Handshake: required before the first prompt/terminal event; the wire
      // protocol is 1.x — a future major means the bridge must be upgraded.
      if (helloSeen) throw new Error("duplicate hello event");
      const v = typeof evt.protocol_version === "string" ? evt.protocol_version : "";
      if (!/^1\./.test(v)) throw new Error(`unsupported coop-data-doc protocol version '${v || "(none)"}' (bridge supports 1.x; requires coop-data-doc 1.1.1+)`);
      helloSeen = true;
      return;
    }
    if (evt.type === "prompt") {
      if (!helloSeen) throw new Error("missing hello handshake before first prompt (requires coop-data-doc 1.1.1+)");
      if (terminal) throw new Error("prompt received after terminal event");
      const answer = await ask(prefilledPrompt(evt, prefill));
      if (answer === null) {
        await send({ id: evt.id, cancelled: true });
        return;
      }
      await send({ id: evt.id, answer });
    } else if (evt.type === "notice" || evt.type === "progress") {
      if (!evt.message) return;
      const notRunnable = evt.type === "notice" && evt.message.trimStart().startsWith(NOT_RUNNABLE_NOTICE);
      if (notRunnable) outcome.notRunnable = evt.message.trimStart().slice(NOT_RUNNABLE_NOTICE.length).trim();
      notify(evt.message, notRunnable ? "warning" : "info");
    } else if (evt.type === "complete" || evt.type === "cancelled" || evt.type === "error") {
      if (!helloSeen) throw new Error(`missing hello handshake before ${evt.type} event (requires coop-data-doc 1.1.1+)`);
      if (terminal) throw new Error(`duplicate terminal event (${terminal}, ${evt.type})`);
      terminal = evt.type;
      if (evt.message) notify(evt.message, evt.type === "error" ? "error" : "info");
    } else throw new Error(`unknown JSONL event type: ${evt.type}`);
  };
  child.stdout?.on("data", (chunk) => {
    try {
      for (const line of decoder.push(chunk)) chain = chain.then(() => accept(line));
      chain = chain.catch((e) => { protocolError = errMsg(e); try { child.kill(); } catch { /* best effort */ } });
    } catch (e) { protocolError = errMsg(e); try { child.kill(); } catch { /* best effort */ } }
  });
  const code = await new Promise((resolveCode) => {
    child.once("error", (e) => { protocolError = `spawn failed: ${errMsg(e)}`; resolveCode(null); });
    child.once("close", resolveCode);
  });
  await chain;
  try { decoder.finish(); } catch (e) { protocolError ||= errMsg(e); }
  if (protocolError) { notify(`setup protocol failed: ${protocolError}`, "error"); return false; }
  if (code === 0 && terminal === "complete") return true;
  if (code === 130 && terminal === "cancelled") return false;
  if (code !== 0 && code !== 130 && terminal === "error") return false;
  const tail = stderrTail.trim() ? ` — ${stderrTail.trim().split("\n").slice(-2).join("  ")}` : "";
  if (!terminal) {
    // The wizard exited without a terminal event (e.g. it died right after a
    // prompt). That is a silent close, not a protocol contradiction — say so,
    // and keep the wording stable: the early-close path must be recognizable
    // regardless of which stdin/exit race won.
    notify(`coop-data-doc closed without a terminal event (exit ${code ?? "?"})${tail}`, "error");
    return false;
  }
  notify(`setup protocol contradiction (exit ${code ?? "?"}, event ${terminal})${tail}`, "error");
  return false;
}

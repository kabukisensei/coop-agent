// Feedback and bug reports (Aaron, 2026-11-10): `/feedback` in the terminal and
// the window, Help > Report a problem in the window, and `coop feedback` in a
// shell. coop builds a short report, redacts it, shows it for editing, and then
// opens a pre-filled "new issue" page in the browser on a PRIVATE repository
// (Cooptimize/coop-feedback by default). The person presses Submit on GitHub:
// coop itself sends nothing, holds no token and calls no service.
//
// Client data isolation: a report never carries the conversation, prompts,
// answers, file contents, query results or the project file. What it does carry
// (the person's words, versions and the last few error messages) is redacted
// first, by default, and shown in full before anything leaves the machine.
//
// Pure helpers here (no prompts); the extension command (coop-tools) and the
// shell command (lib/feedback-cli.mjs) do the asking.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { configPath, profileDir } from "./paths.mjs";

export const DEFAULT_FEEDBACK_REPO = "Cooptimize/coop-feedback";
/** GitHub accepts long URLs, but browsers and Windows' URL handler cut them; stay well inside. */
export const MAX_URL_LENGTH = 7000;
export const KINDS = Object.freeze([
  { id: "bug", label: "Bug: something went wrong", heading: "What happened? What did you expect instead?" },
  { id: "idea", label: "Idea: something coop should do", heading: "What would you like coop to do, and why?" },
  { id: "question", label: "Question: how does coop do something", heading: "What do you want to know?" },
]);
export const KIND_IDS = Object.freeze(KINDS.map((kind) => kind.id));

const COOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Where reports go: COOP_FEEDBACK_REPO, else `feedback.repo` in ~/.coop/config,
 * else Cooptimize/coop-feedback. Only an `owner/name` value is accepted, so a
 * typo can never turn into some other URL.
 */
export function feedbackRepo(env = process.env, file = configPath(env)) {
  const fromEnv = String(env.COOP_FEEDBACK_REPO || "").trim();
  if (REPO_PATTERN.test(fromEnv)) return fromEnv;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
    const value = String(raw?.feedback?.repo || "").trim();
    if (REPO_PATTERN.test(value)) return value;
  } catch { /* no config yet */ }
  return DEFAULT_FEEDBACK_REPO;
}

// --- Redaction ------------------------------------------------------------------

// Values a project file holds that are coop's own words, not the client's.
const SAFE_VALUES = new Set([
  "true", "false", "null", "yes", "no", "on", "off", "main", "master", "origin", "dev", "test", "prod", "sql", "powerbi",
  "available", "unknown", "not_available_yet", "connected", "discovery", "partial", "warehouse", "lakehouse",
  "sql_database", "mixed", "same_name", "prefix", "runnable", "commented", "fabric_warehouse", "fabric_lakehouse",
  "fabric_sql_database", "azure_sql", "synapse_serverless", "consultant_review_first", "cooptimize", "america/chicago", "fabric", "fabric_dw", "docs", "site",
]);
// Words a client name may contain that are too common to strip from the person's text.
const COMMON_WORDS = new Set(["group", "company", "corp", "corporation", "holdings", "services", "solutions", "international", "the", "and", "foods", "bank", "health", "university", "college", "school", "city", "county", "state", "department", "partners", "consulting", "systems", "technologies", "global", "national", "american", "united"]);
// Keys whose values are coop settings, never client names.
const SAFE_KEYS = new Set(["schema_version", "role", "kind", "mode", "layout", "work_mode", "timezone", "remote_name", "default_branch", "default_environment", "organization", "item_type", "destructive", "rule", "enabled"]);

function unquote(value) {
  let v = String(value).trim();
  const hash = v.search(/\s#/);
  if (hash >= 0 && !/^["']/.test(v)) v = v.slice(0, hash).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v.trim();
}

function keepTerm(value, { always = false } = {}) {
  const v = String(value || "").trim();
  if (v.length < 3 || v.length > 200) return false;
  if (/^TODO\b/i.test(v) || /\*/.test(v)) return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return false;
  if (SAFE_VALUES.has(v.toLowerCase())) return false;
  if (always) return true;
  // A plain lowercase word (an enum, "available") would wipe ordinary English
  // from the person's text; names carry a capital, a digit or a separator.
  return /[A-Z0-9_\-.\\/ ]/.test(v);
}

/**
 * The names a project file gives away (client, repositories, folders, servers,
 * databases, workspaces, items, ids), read line by line with no YAML library.
 * `profile.client` is always kept; other values are kept when they look like names.
 */
export function projectFileTerms(text) {
  const terms = new Set();
  let inRepositories = false;
  for (const raw of String(text || "").replace(/^﻿/, "").split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(raw)) continue;
    const indent = raw.match(/^\s*/)[0].length;
    if (indent === 0) inRepositories = /^repositories\s*:/.test(raw);
    const pair = raw.match(/^\s*(?:-\s+)?([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (pair) {
      const [, key, rest] = pair;
      if (inRepositories && indent === 2 && keepTerm(key)) terms.add(key);
      if (!rest || SAFE_KEYS.has(key)) continue;
      const value = rest.trim();
      if (value.startsWith("[")) {
        for (const item of value.replace(/^\[|\]\s*(#.*)?$/g, "").split(",")) {
          const v = unquote(item);
          if (keepTerm(v)) terms.add(v);
        }
        continue;
      }
      const v = unquote(value);
      if (key === "client" ? keepTerm(v, { always: true }) : keepTerm(v)) addWithParts(terms, v);
      continue;
    }
    const item = raw.match(/^\s*-\s+(.*)$/);
    if (item) {
      const v = unquote(item[1]);
      if (keepTerm(v)) addWithParts(terms, v);
    }
  }
  return [...terms];
}

// A path's folder names can be client names too ("..\acme-sql").
function addWithParts(terms, value) {
  terms.add(value);
  if (/[\\/]/.test(value)) {
    for (const part of value.split(/[\\/]+/)) if (part !== ".." && part !== "." && keepTerm(part, { always: /[A-Za-z]/.test(part) && part.length >= 4 })) terms.add(part);
  }
}

/**
 * Everything this Windows user's coop knows that names the client: the project
 * file(s), client.json, the client folder, plus the user and machine names.
 * Returns { terms, client } where `client` are the terms to show as <client>.
 */
export function collectRedactionTerms({ projectFiles = [], env = process.env, cwd = "" } = {}) {
  const terms = new Set();
  const client = new Set();
  const read = (file) => { try { return readFileSync(file, "utf8"); } catch { return ""; } };
  let record = {};
  try { record = JSON.parse(read(join(profileDir(env), "client.json")).replace(/^﻿/, "") || "{}"); } catch { record = {}; }
  const files = new Set(projectFiles.filter(Boolean));
  if (record && typeof record.project_file === "string" && record.project_file) files.add(record.project_file);
  for (const file of files) {
    const text = read(file);
    for (const term of projectFileTerms(text)) terms.add(term);
    const name = text.match(/^\s+client\s*:\s*(.+)$/m);
    if (name) { const v = unquote(name[1]); if (keepTerm(v, { always: true })) client.add(v); }
  }
  if (record && typeof record.client === "string" && keepTerm(record.client, { always: true })) client.add(record.client.trim());
  for (const folder of [record && record.root, cwd]) {
    if (typeof folder !== "string" || !folder) continue;
    const name = basename(folder.replace(/[\\/]+$/, ""));
    if (keepTerm(name, { always: name.length >= 4 })) terms.add(name);
  }
  // The client's name word by word too ("Acme" from "Acme Foods").
  for (const value of [...client]) for (const word of value.split(/[\s,.&()-]+/)) if (word.length >= 4 && !SAFE_VALUES.has(word.toLowerCase()) && !COMMON_WORDS.has(word.toLowerCase())) client.add(word);
  for (const value of client) terms.add(value);
  let user = "";
  try { user = os.userInfo().username; } catch { user = env.USERNAME || env.USER || ""; }
  return { terms: [...terms], client: [...client], user: String(user || ""), machine: String(os.hostname() || "") };
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const COOP_LINK = /^https:\/\/github\.com\/(?:kabukisensei|Cooptimize)\/coop-[\w.-]+(?:[/?#][^\s]*)?$/i;

// Applied to everything, in this order (the earlier ones would leave pieces the later ones miss).
const BASE_RULES = [
  { label: "secret", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, to: "Bearer <secret>" },
  { label: "secret", re: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, to: "<secret>" },
  { label: "secret", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})/g, to: "<secret>" },
  { label: "secret", re: /\b(password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|api[_-]?key|account[_-]?key|sharedaccesskey|sig)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s;,&]+)/gi, to: "$1$2<secret>" },
  { label: "connection detail", re: /\b(server|data source|address|addr|database|initial catalog|user id|uid|user)\b(\s*=\s*)[^;\r\n]+/gi, to: "$1$2<redacted>" },
  { label: "link", re: /\bhttps?:\/\/[^\s<>"')\]]+/gi, to: (m) => (COOP_LINK.test(m) ? m : "<url>") },
  { label: "server", re: /\b[\w.-]+\.(?:database\.windows\.net|database\.fabric\.microsoft\.com|datawarehouse\.fabric\.microsoft\.com|fabric\.microsoft\.com|pbidedicated\.windows\.net|sql\.azuresynapse\.net|(?:blob|dfs|file|queue|table)\.core\.windows\.net|azurewebsites\.net|vault\.azure\.net|analysis\.windows\.net)\b/gi, to: "<server>" },
  { label: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, to: "<email>" },
  { label: "id", re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, to: "<id>" },
  { label: "path", re: /\\\\[^\s\\"'<>|]+\\[^\s"'<>|]*/g, to: "<path>" },
  { label: "path", re: /\b[A-Za-z]:[\\/][^\s"'<>|*?\r\n]*/g, to: "<path>" },
  { label: "path", re: /(?:~|\/(?:home|Users|mnt|srv|opt|var))\/[^\s"'<>|]+/g, to: "<path>" },
  { label: "secret", re: /\b[A-Za-z0-9+/_-]{40,}={0,2}/g, to: "<secret>" },
];

// Machine text only (error messages): SQL statements and quoted names.
const SQL_START = /\b(?:SELECT\b[^\n]*\bFROM\b|INSERT\s+INTO\b|UPDATE\s+[\w\[\].]+\s+SET\b|DELETE\s+FROM\b|MERGE\s+(?:INTO\s+)?[\w\[]|(?:CREATE(?:\s+OR\s+ALTER)?|ALTER|DROP)\s+(?:TABLE|VIEW|PROC|PROCEDURE|FUNCTION|SCHEMA|INDEX|TRIGGER)\b|EXEC(?:UTE)?\s+[\w\[@]|TRUNCATE\s+TABLE\b)/i;
const ERROR_RULES = [
  { label: "SQL", line: true },
  { label: "object name", re: /\[[^\]\r\n]{1,128}\](?:\.\[[^\]\r\n]{1,128}\]){0,3}/g, to: "<object>" },
  { label: "quoted name", re: /'[^'\r\n]{2,200}'/g, to: "'<name>'" },
  { label: "quoted name", re: /"[^"\r\n]{2,200}"/g, to: '"<name>"' },
];

function applyRule(text, rule, counts) {
  if (rule.line) {
    // From the first statement keyword to the end of that line.
    return text.split("\n").map((line) => {
      const match = SQL_START.exec(line);
      if (!match) return line;
      counts[rule.label] = (counts[rule.label] || 0) + 1;
      return `${line.slice(0, match.index)}<sql omitted>`;
    }).join("\n");
  }
  return text.replace(rule.re, (...args) => {
    const match = args[0];
    const out = typeof rule.to === "function" ? rule.to(...args) : match.replace(new RegExp(rule.re.source, rule.re.flags.replace("g", "")), rule.to);
    if (out !== match) counts[rule.label] = (counts[rule.label] || 0) + 1;
    return out;
  });
}

function applyTerms(text, names, counts) {
  let out = text;
  const list = [
    ...names.client.map((t) => [t, "<client>", "client name"]),
    ...names.terms.filter((t) => !names.client.includes(t)).map((t) => [t, "<name>", "project name"]),
    ...(names.user && names.user.length >= 3 ? [[names.user, "<user>", "user name"]] : []),
    ...(names.machine && names.machine.length >= 3 ? [[names.machine, "<machine>", "machine name"]] : []),
  ].sort((a, b) => b[0].length - a[0].length);
  for (const [term, to, label] of list) {
    const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(term)}(?![A-Za-z0-9_])`, "gi");
    out = out.replace(re, () => { counts[label] = (counts[label] || 0) + 1; return to; });
  }
  return out;
}

/**
 * Redact one piece of text. `names` comes from collectRedactionTerms; `machine`
 * true also strips SQL and quoted names (error messages, never the person's words).
 * Returns { text, counts } where counts maps a label to how many were replaced.
 */
export function redactText(text, names = { terms: [], client: [], user: "", machine: "" }, { machine = false, counts = {} } = {}) {
  let out = String(text || "");
  if (machine) for (const rule of ERROR_RULES.slice(0, 1)) out = applyRule(out, rule, counts);
  for (const rule of BASE_RULES) out = applyRule(out, rule, counts);
  out = applyTerms(out, { terms: names.terms || [], client: names.client || [], user: names.user || "", machine: names.machine || "" }, counts);
  if (machine) for (const rule of ERROR_RULES.slice(1)) out = applyRule(out, rule, counts);
  return { text: out, counts };
}

export function redactionSummary(counts) {
  const parts = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => a[0].localeCompare(b[0])).map(([label, n]) => `${n} ${label}${n === 1 ? "" : "s"}`);
  return parts.length ? `coop removed ${parts.join(", ")} before this preview.` : "coop found nothing to remove.";
}

// --- The report -----------------------------------------------------------------

/** coop's own facts: never the client's. */
export function environmentFacts({ surface = "terminal", model = "", env = process.env, root = COOP_ROOT } = {}) {
  const read = (file) => { try { return readFileSync(file, "utf8"); } catch { return ""; } };
  let pi = "";
  try { pi = JSON.parse(read(join(root, "config", "release-manifest.json")))?.pi?.version || ""; } catch { pi = ""; }
  let windows = "";
  try { windows = `${os.version ? os.version() : os.type()} ${os.release()}`.trim(); } catch { windows = `${process.platform}`; }
  return {
    coop: read(join(root, "VERSION")).trim() || "unknown",
    pi: pi || "unknown",
    surface: surface === "window" || (surface !== "shell" && env.COOP_DESKTOP === "1") ? "window" : surface,
    os: windows,
    node: process.version,
    model: String(model || ""),
  };
}

/**
 * The last few errors on this session's branch: failed model calls and failed
 * tool calls, one line each, newest last. Text only; the caller redacts.
 */
export function sessionErrors(branch, limit = 5) {
  const out = [];
  for (const entry of Array.isArray(branch) ? branch : []) {
    const message = entry && entry.type === "message" ? entry.message : null;
    if (!message) continue;
    if (message.role === "assistant" && message.stopReason === "error" && message.errorMessage) {
      out.push(`model: ${firstLine(message.errorMessage)}`);
    } else if (message.role === "toolResult" && message.isError) {
      const text = Array.isArray(message.content) ? message.content.filter((part) => part && part.type === "text").map((part) => part.text).join(" ") : String(message.content || "");
      out.push(`${message.toolName || "tool"}: ${firstLine(text) || "failed"}`);
    }
  }
  return out.slice(-limit);
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 240) || "";
}

/**
 * The report the person checks and edits: their words, then coop's facts.
 * Returns { title, body, counts }; the preview is `# title`, a blank line, the body.
 */
export function buildReport({ kind = "bug", title = "", description = "", facts = {}, errors = [], names } = {}) {
  const counts = {};
  const safe = (text, machine = false) => redactText(text, names, { machine, counts }).text;
  const kindInfo = KINDS.find((k) => k.id === kind) || KINDS[0];
  const lines = [
    `# ${safe(title).replace(/\s+/g, " ").trim() || "coop feedback"}`,
    "",
    `**Kind:** ${kindInfo.id}`,
    "",
    `## ${kindInfo.heading}`,
    "",
    safe(description).trim() || "(not given)",
    "",
    "## About this coop",
    "",
    `- coop ${facts.coop || "unknown"}, Pi ${facts.pi || "unknown"}, in the ${facts.surface || "terminal"}`,
    `- ${facts.os || "unknown OS"}, Node ${facts.node || "unknown"}`,
    ...(facts.model ? [`- model: ${safe(facts.model)}`] : []),
  ];
  if (errors.length) {
    lines.push("", "## Recent errors (redacted)", "", ...errors.map((error) => `- ${safe(error, true)}`));
  }
  lines.push("", `_Filed with coop /feedback. ${redactionSummary(counts)}_`);
  return { title: lines[0].slice(2), body: lines.slice(2).join("\n"), counts };
}

/** Split an edited preview back into title and body (the first `# ` line is the title). */
export function splitPreview(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const index = lines.findIndex((line) => line.trim());
  if (index >= 0 && /^#\s+/.test(lines[index])) {
    return { title: lines[index].replace(/^#\s+/, "").trim(), body: lines.slice(index + 1).join("\n").trim() };
  }
  return { title: "", body: lines.join("\n").trim() };
}

/**
 * The pre-filled new-issue page. A body too long for a URL is cut, and says
 * the whole report is on the clipboard. Returns { url, cut }.
 */
export function issueUrl({ repo = DEFAULT_FEEDBACK_REPO, kind = "bug", title = "", body = "" } = {}) {
  const base = `https://github.com/${repo}/issues/new`;
  const label = KIND_IDS.includes(kind) ? kind : "bug";
  const make = (b) => `${base}?title=${encodeURIComponent(title || "coop feedback")}&labels=${encodeURIComponent(`${label},from-coop`)}&body=${encodeURIComponent(b)}`;
  let url = make(body);
  if (url.length <= MAX_URL_LENGTH) return { url, cut: false };
  const note = "\n\n_(Cut to fit the link: the full report is on your clipboard. Paste it over this text.)_";
  let lo = 0, hi = body.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (make(body.slice(0, mid) + note).length <= MAX_URL_LENGTH) lo = mid; else hi = mid - 1;
  }
  url = make(body.slice(0, lo) + note);
  return { url, cut: true };
}

// --- Delivery ---------------------------------------------------------------------

export function reportsDir(env = process.env) {
  return join(profileDir(env), "reports");
}

/** Save the final report under ~/.coop/reports (never in a project folder). Returns the path or "". */
export function saveReport(title, body, { env = process.env, now = new Date() } = {}) {
  try {
    const dir = reportsDir(env);
    mkdirSync(dir, { recursive: true });
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
    let file = join(dir, `feedback-${stamp}.md`);
    for (let n = 2; existsSync(file); n++) file = join(dir, `feedback-${stamp}-${n}.md`);
    writeFileSync(file, `# ${title}\n\n${body}\n`, "utf8");
    return file;
  } catch {
    return "";
  }
}

/** Put the report on the clipboard. Best effort; returns true when it worked. */
export function copyToClipboard(text, platform = process.platform) {
  try {
    if (platform === "win32") {
      // clip.exe reads UTF-16LE with a byte-order mark as Unicode.
      const input = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(String(text), "utf16le")]);
      return spawnSync("clip.exe", [], { input, windowsHide: true, timeout: 5000 }).status === 0;
    }
    const tool = platform === "darwin" ? ["pbcopy", []] : ["xclip", ["-selection", "clipboard"]];
    return spawnSync(tool[0], tool[1], { input: String(text), timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

/** Open a github.com page in the default browser. Only https://github.com/ links. */
export function openInBrowser(url, platform = process.platform) {
  if (!/^https:\/\/github\.com\//.test(String(url))) return false;
  try {
    const [cmd, args] = platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Save, copy and open: what both commands do once the person says go. */
export function deliverReport({ repo, kind, title, body, env = process.env, open = openInBrowser, copy = copyToClipboard }) {
  const file = saveReport(title, body, { env });
  const copied = copy(`# ${title}\n\n${body}\n`);
  const { url, cut } = issueUrl({ repo, kind, title, body });
  const opened = open(url);
  return { file, copied, opened, url, cut };
}

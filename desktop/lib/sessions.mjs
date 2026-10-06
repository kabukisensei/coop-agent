// Saved sessions for the session list and resume. Pi keeps them under
// <agent dir>/sessions/--<cwd>--/<timestamp>_<id>.jsonl (docs/session-format.md).
// Read-only: the window lists them and asks Pi to switch; Pi does the loading.
import { openSync, readSync, closeSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, resolve, sep, relative, isAbsolute } from "node:path";

// Read in chunks so a long session never sits in memory whole.
const CHUNK_BYTES = 1024 * 1024;
// path -> what the file held up to `offset` (the end of its last full line).
// Pi only appends, so a grown file is read from there on, not from the start.
const scanned = new Map();

export function sessionsRoot(env) {
  if (env.PI_CODING_AGENT_SESSION_DIR) return resolve(env.PI_CODING_AGENT_SESSION_DIR);
  if (!env.PI_CODING_AGENT_DIR) return null;
  return join(resolve(env.PI_CODING_AGENT_DIR), "sessions");
}

/** Pi's folder name for a working directory: no leading separator, / \ : become -. */
export function sessionFolderName(cwd) {
  return `--${String(cwd).replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-")}--`;
}

function firstText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const block = content.find((item) => item && item.type === "text" && typeof item.text === "string");
  return block ? block.text : "";
}

function readLines(file, state, size) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let carry = Buffer.alloc(0);
    let position = state.offset;
    while (position < size) {
      const read = readSync(fd, buffer, 0, Math.min(CHUNK_BYTES, size - position), position);
      if (read <= 0) break;
      position += read;
      let data = Buffer.concat([carry, buffer.subarray(0, read)]);
      let newline;
      while ((newline = data.indexOf(10)) >= 0) {
        if (!readLine(state, data.subarray(0, newline).toString("utf8"))) return false;
        state.offset += newline + 1;
        data = data.subarray(newline + 1);
      }
      carry = Buffer.from(data);
    }
    // A last line without a newline is complete when it parses; Pi may still be writing it otherwise.
    if (carry.length) {
      const text = carry.toString("utf8");
      let whole = true;
      try { JSON.parse(text); } catch { whole = false; }
      if (whole) {
        if (!readLine(state, text)) return false;
        state.offset += carry.length;
      }
    }
    return true;
  } finally {
    closeSync(fd);
  }
}

/** One line into the summary; false when the file is not a session. */
function readLine(state, line) {
  if (!line.trim()) return true;
  // Only the header, names and user prompts count: skip parsing everything else.
  if (state.header && !line.includes('"session_info"') && !line.includes('"user"')) return true;
  let entry;
  try { entry = JSON.parse(line); } catch { return true; }
  if (!state.header) {
    if (!entry || entry.type !== "session") return false;
    state.header = entry;
    return true;
  }
  if (entry.type === "session_info" && typeof entry.name === "string") state.name = entry.name;
  if (entry.type === "message" && entry.message && entry.message.role === "user") {
    state.messages += 1;
    if (!state.title) state.title = firstText(entry.message.content).trim().split("\n")[0].slice(0, 140);
  }
  return true;
}

/** Summarize one session file; null when it is not a session. The name is Pi's last session_info, wherever it sits. */
export function summarizeSession(file) {
  let stat;
  try { stat = statSync(file); } catch { scanned.delete(file); return null; }
  let state = scanned.get(file);
  if (!state || stat.size < state.size) state = { offset: 0, size: 0, header: null, name: "", title: "", messages: 0 };
  if (stat.size !== state.size || !state.header) {
    // Read the new part into a copy so a failed read leaves the cache as it was.
    const next = { ...state };
    try {
      if (!readLines(file, next, stat.size)) { scanned.delete(file); return null; }
    } catch { return null; }
    next.size = stat.size;
    state = next;
    scanned.set(file, state);
  }
  const header = state.header;
  if (!header) return null;
  return { path: file, id: String(header.id || ""), cwd: String(header.cwd || ""), started: String(header.timestamp || ""), modified: stat.mtimeMs, name: state.name, title: state.title, messages: state.messages };
}

/** Recent sessions for one working folder, newest first. */
export function listSessions(env, cwd, { limit = 50 } = {}) {
  const root = sessionsRoot(env);
  if (!root) return [];
  const folder = join(root, sessionFolderName(cwd));
  let names;
  try { names = readdirSync(folder); } catch { return []; }
  return names
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(folder, name))
    .map((file) => { try { return { file, mtime: statSync(file).mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map(({ file }) => summarizeSession(file))
    .filter(Boolean);
}

/** True when a path the renderer sent is a session file under the sessions root. */
export function isSessionPath(env, candidate) {
  const root = sessionsRoot(env);
  if (!root || typeof candidate !== "string" || !isAbsolute(candidate) || !candidate.endsWith(".jsonl") || /[\0\r\n]/.test(candidate)) return false;
  let real;
  let realRoot;
  try { real = realpathSync(candidate); realRoot = realpathSync(root); } catch { return false; }
  const rel = relative(realRoot, real);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel) && rel.split(sep).length === 2;
}

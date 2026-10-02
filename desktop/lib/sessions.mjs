// Saved sessions for the session list and resume. Pi keeps them under
// <agent dir>/sessions/--<cwd>--/<timestamp>_<id>.jsonl (docs/session-format.md).
// Read-only: the window lists them and asks Pi to switch; Pi does the loading.
import { openSync, readSync, closeSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, resolve, sep, relative, isAbsolute } from "node:path";

const HEAD_BYTES = 256 * 1024;

export function sessionsRoot(env) {
  if (env.PI_CODING_AGENT_SESSION_DIR) return resolve(env.PI_CODING_AGENT_SESSION_DIR);
  if (!env.PI_CODING_AGENT_DIR) return null;
  return join(resolve(env.PI_CODING_AGENT_DIR), "sessions");
}

/** Pi's folder name for a working directory: no leading separator, / \ : become -. */
export function sessionFolderName(cwd) {
  return `--${String(cwd).replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-")}--`;
}

function readHead(file) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function firstText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const block = content.find((item) => item && item.type === "text" && typeof item.text === "string");
  return block ? block.text : "";
}

/** Summarize one session file from its first part; null when it is not a session. */
export function summarizeSession(file) {
  let head;
  try { head = readHead(file); } catch { return null; }
  const lines = head.split("\n");
  let header = null;
  let title = "";
  let name = "";
  let messages = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!header) {
      if (entry.type !== "session") return null;
      header = entry;
      continue;
    }
    if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name;
    if (entry.type === "message" && entry.message && entry.message.role === "user") {
      messages += 1;
      if (!title) title = firstText(entry.message.content).trim().split("\n")[0].slice(0, 140);
    }
  }
  if (!header) return null;
  let modified = 0;
  try { modified = statSync(file).mtimeMs; } catch { /* keep 0 */ }
  return { path: file, id: String(header.id || ""), cwd: String(header.cwd || ""), started: String(header.timestamp || ""), modified, name, title, messages };
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

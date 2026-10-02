// Files for the composer's @ mentions: the window's form of Pi's "type @ to
// search for a file". Read-only. In a git repository the list is what git
// tracks plus untracked files it does not ignore (Pi's fd search also honors
// .gitignore); any other folder is walked, skipping .git and node_modules.
// Paths are relative to the working folder with "/" separators; folders end
// in "/".
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const MAX_FILES = 20_000;

function gitFiles(cwd, execFileImpl) {
  return new Promise((resolve) => {
    execFileImpl("git", ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      windowsHide: true, timeout: 5000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8",
    }, (error, stdout) => resolve(error ? null : String(stdout).split("\0").filter(Boolean).slice(0, MAX_FILES)));
  });
}

async function walkFiles(cwd, readdirImpl) {
  const files = [];
  const queue = [""];
  while (queue.length && files.length < MAX_FILES) {
    const dir = queue.shift();
    let entries;
    try { entries = await readdirImpl(join(cwd, dir), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile()) files.push(path);
      if (files.length >= MAX_FILES) break;
    }
  }
  return files;
}

/** Files and their folders under cwd, as relative "/" paths. */
export async function listFiles(cwd, { execFileImpl = execFile, readdirImpl = readdir } = {}) {
  const files = (await gitFiles(cwd, execFileImpl)) || (await walkFiles(cwd, readdirImpl));
  const folders = new Set();
  for (const file of files) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(`${parts.slice(0, i).join("/")}/`);
  }
  return [...folders, ...files];
}

function score(path, query) {
  const lower = path.toLowerCase();
  const trimmed = lower.endsWith("/") ? lower.slice(0, -1) : lower;
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  // Better tiers first; within a tier, shorter paths first.
  const tier = (n) => n * 100_000 - lower.length;
  if (base.startsWith(query)) return tier(5);
  if (base.includes(query)) return tier(4);
  if (lower.startsWith(query)) return tier(3);
  if (lower.includes(query)) return tier(2);
  // Letters in order, as a fuzzy finder matches them.
  let at = 0;
  for (const ch of query) {
    at = lower.indexOf(ch, at);
    if (at < 0) return -Infinity;
    at += 1;
  }
  return tier(1);
}

/** The best matches for a query typed after "@"; the top level when it is empty. */
export function rankFiles(paths, query, limit = 30) {
  const q = String(query || "").replace(/^["']/, "").toLowerCase();
  if (!q) {
    return paths.filter((p) => !p.slice(0, -1).includes("/")).sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b)).slice(0, limit);
  }
  return paths
    .map((path) => ({ path, score: score(path, q) }))
    .filter((entry) => entry.score > -Infinity && entry.path.toLowerCase() !== q)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((entry) => entry.path);
}

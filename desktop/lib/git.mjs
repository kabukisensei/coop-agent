// The working folder's git branch for the status bar, read from .git/HEAD the
// way the terminal footer shows it. No git process is started.
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";

function headFile(dotGit) {
  let stat;
  try { stat = statSync(dotGit); } catch { return null; }
  if (stat.isDirectory()) return join(dotGit, "HEAD");
  if (!stat.isFile()) return null;
  // A worktree or submodule: .git is a file naming its gitdir.
  let text;
  try { text = readFileSync(dotGit, "utf8"); } catch { return null; }
  const match = /^gitdir:\s*(.+)\s*$/m.exec(text);
  if (!match) return null;
  const gitdir = match[1].trim();
  return join(isAbsolute(gitdir) ? gitdir : resolve(dirname(dotGit), gitdir), "HEAD");
}

/** The branch name, a short commit for a detached HEAD, or "" outside a repo. */
export function readBranch(cwd) {
  let dir = resolve(cwd);
  for (let depth = 0; depth < 64; depth += 1) {
    const head = headFile(join(dir, ".git"));
    if (head) {
      let text;
      try { text = readFileSync(head, "utf8").trim(); } catch { return ""; }
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
      if (ref) return ref[1];
      return /^[0-9a-f]{7,64}$/.test(text) ? text.slice(0, 7) : "";
    }
    const parent = dirname(dir);
    if (parent === dir) return "";
    dir = parent;
  }
  return "";
}

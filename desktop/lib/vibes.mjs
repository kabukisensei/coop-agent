// The vibes (rotating tips) the terminal shows under its splash and on its
// working line, for the window. Same files, same rules as
// extensions/coop-powerline: vibes/*.txt in the repo (COOP_VIBES_DIR to
// override), one tip per line, # lines skipped, {user} is the person's name.
// Pi's RPC mode does not forward the terminal's working message, so the
// window picks its own.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { effectiveProfileName } from "../../lib/user-profile.mjs";

export const FALLBACK_VIBES = Object.freeze([
  "Type /start anytime to open the Start Here menu of common tasks.",
  "Run /setup-docs to configure and build data documentation in-agent.",
  "Use /handoff to generate a clean summary of changes and next steps.",
  "Type /copy to copy the last assistant response directly to your clipboard.",
]);

export function vibesDir(repoRoot, env = process.env) {
  return env.COOP_VIBES_DIR || join(repoRoot, "vibes");
}

function readLines(file) {
  try {
    return readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  } catch { return []; }
}

/** Every tip of one set (vibes/<set>.txt), or of all sets. */
export function loadVibes(dir, set = "") {
  try {
    if (set) {
      const file = join(dir, `${set}.txt`);
      return existsSync(file) ? readLines(file) : [];
    }
    const all = [];
    for (const name of readdirSync(dir)) if (name.endsWith(".txt")) all.push(...readLines(join(dir, name)));
    return all;
  } catch { return []; }
}

export function vibeSets(dir) {
  try { return readdirSync(dir).filter((name) => name.endsWith(".txt")).map((name) => name.replace(/\.txt$/, "")); } catch { return []; }
}

/** The name {user} becomes: the profile name (per-user, else the machine-level
 *  file; lib/user-profile.mjs), else the OS login, else Dave. */
export function userName(env = process.env) {
  try {
    const name = effectiveProfileName(env);
    if (name) return name;
  } catch { /* no profile */ }
  try { const login = userInfo().username; if (login) return login; } catch { /* no login */ }
  return "Dave";
}

export function fillVibe(vibe, name) {
  return vibe.includes("{user}") ? vibe.replace(/\{user\}/g, name) : vibe;
}

export function pickVibe(pool, random = Math.random) {
  const list = pool.length ? pool : FALLBACK_VIBES;
  return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
}

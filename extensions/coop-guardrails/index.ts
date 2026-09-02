/**
 * coop-guardrails — runtime ENFORCEMENT of Cooptimize's governance rules.
 *
 * `docs/guardrails.md` is the advisory system prompt (it asks the model to behave).
 * This extension hooks the agent's tool calls and actually ENFORCES the
 * non-negotiables the model could slip on:
 *
 *   1. NEVER commit source — block `git commit` from the agent whenever the commit
 *      would include anything outside the allow-listed docs / logs / site paths. This
 *      covers staged files, `git commit -a/-am` (which auto-stages tracked changes),
 *      `git -C <dir> commit`, and `git commit <pathspec>` (which commits working-tree
 *      content ignoring the index). The agent may commit docs/logs/site (with
 *      approval); a human commits source.
 *   2. Destructive commands — confirm before `rm -rf`, `git push --force` (incl. a
 *      `+refspec` force push), `git reset --hard`, `git clean -f`, and `DROP`/
 *      `TRUNCATE` SQL. All git detectors tolerate `git -C <dir>` and interspersed
 *      flags, and match case-insensitively.
 *   3. Secret files — confirm before read/edit/write of `.env`, private keys, or
 *      credential files, AND before a bash command that touches one (`cat .env`
 *      etc.). The agent must never expose secrets.
 *   4. Live data reads — dev/test metadata is allowed read-only; row-level reads
 *      and any production access require explicit approval.
 *   5. Mutating MCP actions — confirm before Fabric/Power BI/MCP tool calls whose
 *      names look like create/update/delete/deploy/publish (best-effort; MCP tool
 *      names vary, so this complements — not replaces — Pi's tool approval).
 *
 * It is the coop-native replacement for the third-party @aliou/pi-guardrails (which
 * was pinned to the old @mariozechner Pi). It enforces the AGENT's tool calls — your
 * own shell is never intercepted. Approval-required actions fail closed when no UI is
 * available; unexpected extension faults remain isolated so Pi cannot crash. Disable
 * entirely with COOP_NO_GUARDRAILS=1.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

// Paths the agent MAY commit; everything else counts as source. The .coop/project.yml
// `approval_policy.agent_allowed_to_commit` globs are merged in on top of these.
const DEFAULT_ALLOWED_GLOBS = [
  "docs/**",
  "site/**",
  "data-docs/**",
  "data-docs-site/**",
];

/** Find the nearest .coop/project.yml walking up from `cwd` (bounded). */
function findProjectYml(cwd: string): string | null {
  let d = cwd;
  for (let i = 0; i < 8; i++) {
    const p = join(d, ".coop", "project.yml");
    if (existsSync(p)) return p;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

/** Parse the `agent_allowed_to_commit` globs out of project.yml text — handling BOTH
 *  YAML flow form (`agent_allowed_to_commit: ["docs/**", ...]`) AND block form
 *
 *      agent_allowed_to_commit:
 *        - "docs/**"
 *        - reports/generated/**
 *
 *  across every occurrence (project.yml defines the key per-repository). The shipped
 *  .coop/project.example.yml uses block form, so a flow-only regex silently ignored a
 *  user's customizations — and diverged from the bash side (lib/_yaml.py reads both). */
export function parseAllowedGlobs(text: string): string[] {
  const globs: string[] = [];
  const add = (raw: string) => {
    const g = raw.trim().replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
    if (g) globs.push(g);
  };
  // Flow form (all occurrences).
  const flow = /agent_allowed_to_commit\s*:\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = flow.exec(text))) {
    for (const raw of m[1].split(",")) add(raw);
  }
  // Block form: the key on its own line, then more-indented `- item` entries.
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = /^(\s*)agent_allowed_to_commit\s*:\s*(#.*)?$/.exec(lines[i]);
    if (!head) continue;
    const baseIndent = head[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const body = lines[j].trim();
      if (!body || body.startsWith("#")) continue;
      const indent = lines[j].length - lines[j].trimStart().length;
      const item = /^-\s+(.*)$/.exec(body);
      if (indent > baseIndent && item) add(item[1]);
      else break; // dedent / non-list sibling → end of this block
    }
  }
  return globs;
}

/** A committed path is allowed only after explicit deny rules have been checked. */
function isAllowedCommitPath(file: string, allowedGlobs: string[], deniedGlobs: string[]): boolean {
  if (deniedGlobs.some((g) => matchGlob(file, g))) return false;
  if (/\.(md|markdown)$/i.test(file)) return true; // documentation anywhere, unless denied
  return allowedGlobs.some((g) => matchGlob(file, g));
}

/** Very small glob matcher for the patterns we use in project.yml: `**` matches any
 *  number of path segments; `*` matches within a segment; `?` matches one char. */
function matchGlob(path: string, glob: string): boolean {
  const re = globToRegex(glob);
  return re.test(path);
}

function globToRegex(glob: string): RegExp {
  let s = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      s += ".*";
      i += 2;
      if (glob[i] === "/") { s += "\\/?"; i++; }
    } else if (c === "*") { s += "[^/]*"; i++; }
    else if (c === "?") { s += "[^/]"; i++; }
    else if (/[A-Za-z0-9_\-./]/.test(c)) { s += c.replace(/[.]/g, "\\$&"); i++; }
    else { s += "\\" + c; i++; }
  }
  return new RegExp("^" + s + "$", "i");
}

export type RepoCommitPolicy = { allowed: string[]; denied: string[] };

/** Parse the `repositories` section of project.yml and find the entry whose
 *  `local_path` resolves to `repoDir`. Returns null if no matching entry. */
export type RepoPolicyEntry = { name: string; path: string; allowed: string[]; denied: string[] };

/** Parse EVERY repositories: entry into resolved policy entries. This is the input
 *  to the trusted per-session governance snapshot — it is read once, never per commit. */
export function parseRepoEntries(text: string, projectDir: string): RepoPolicyEntry[] {
  const entries: RepoPolicyEntry[] = [];
  const lines = text.split("\n");
  let inRepos = false;
  let repoBaseIndent = 0;
  let currentName: string | null = null;
  let currentLocalPath: string | null = null;
  let currentAllowed: string[] = [];
  let currentDenied: string[] = [];
  let currentBaseIndent = 0;

  function flush(): void {
    if (!currentName || !currentLocalPath) return;
    const resolved = isAbsolute(currentLocalPath)
      ? currentLocalPath
      : resolve(projectDir, currentLocalPath);
    entries.push({ name: currentName, path: resolve(resolved), allowed: [...currentAllowed], denied: [...currentDenied] });
    currentName = null;
    currentLocalPath = null;
    currentAllowed = [];
    currentDenied = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trimStart();
    const indent = raw.length - trimmed.length;
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (/^repositories\s*:\s*(#.*)?$/.test(trimmed)) {
      inRepos = true;
      repoBaseIndent = indent;
      continue;
    }
    if (!inRepos) continue;

    // End of repositories section: a key at or before repoBaseIndent that isn't a repo name.
    if (indent <= repoBaseIndent && !trimmed.startsWith("-")) {
      flush();
      inRepos = false;
      continue;
    }

    // A repository entry name is a key exactly one indent deeper than `repositories:`.
    const repoKey = /^(?:'((?:[^']|'')+)'|"([^"]+)"|([A-Za-z0-9_\-]+))\s*:\s*(#.*)?$/.exec(trimmed);
    if (indent === repoBaseIndent + 2 && repoKey && !trimmed.startsWith("-")) {
      flush();
      currentName = (repoKey[1] || repoKey[2] || repoKey[3]).replace(/''/g, "'");
      currentLocalPath = null;
      currentAllowed = [];
      currentDenied = [];
      currentBaseIndent = indent;
      continue;
    }

    // Properties inside a repository entry.
    if (currentName && indent > currentBaseIndent) {
      const kv = /^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/.exec(trimmed);
      if (kv) {
        const k = kv[1];
        const v = kv[2].trim().replace(/\s+#.*$/, "");
        if (k === "local_path") {
          currentLocalPath = v.replace(/^["']|["']$/g, "");
        } else if (k === "agent_allowed_to_commit" && v.startsWith("[")) {
          // Flow form on a single line.
          for (const raw of v.slice(1, -1).split(",")) {
            const g = raw.trim().replace(/^["']|["']$/g, "");
            if (g) currentAllowed.push(g);
          }
        } else if (k === "agent_never_commit" && v.startsWith("[")) {
          for (const raw of v.slice(1, -1).split(",")) {
            const g = raw.trim().replace(/^["']|["']$/g, "");
            if (g) currentDenied.push(g);
          }
        }
      }
      const item = /^-\s+(.*)$/.exec(trimmed);
      if (item && indent > currentBaseIndent + 2) {
        const parentKey = findParentKey(lines, i, currentBaseIndent + 2);
        const g = item[1].trim().replace(/^["']|["']$/g, "");
        if (g) {
          if (parentKey === "agent_allowed_to_commit") currentAllowed.push(g);
          else if (parentKey === "agent_never_commit") currentDenied.push(g);
        }
      }
    }
  }
  if (inRepos) flush();
  return entries;
}

/** Back-compat wrapper: policy for exactly the repository whose local_path matches. */
export function parseRepoCommitPolicy(text: string, projectDir: string, repoDir: string): RepoCommitPolicy | null {
  const hit = parseRepoEntries(text, projectDir).find((e) => e.path === resolve(repoDir));
  return hit ? { allowed: hit.allowed, denied: hit.denied } : null;
}

function findParentKey(lines: string[], idx: number, parentIndent: number): string | null {
  for (let j = idx - 1; j >= 0; j--) {
    const raw = lines[j];
    const trimmed = raw.trimStart();
    const indent = raw.length - trimmed.length;
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (indent === parentIndent) {
      const kv = /^([A-Za-z0-9_\-]+)\s*:/.exec(trimmed);
      return kv ? kv[1] : null;
    }
    if (indent < parentIndent) return null;
  }
  return null;
}

export type SessionGovernance = { loaded: boolean; entries: RepoPolicyEntry[] };

// The TRUSTED policy snapshot: read once per session, then frozen. Editing
// .coop/project.yml mid-session can never weaken the active guardrails.
let sessionGovernance: SessionGovernance = { loaded: false, entries: [] };

/** Read the session's project contract once into an immutable governance snapshot. */
export function buildSessionGovernance(sessionCwd: string): SessionGovernance {
  const entries: RepoPolicyEntry[] = [];
  try {
    const proj = findProjectYml(sessionCwd);
    if (proj) {
      const projectRoot = dirname(dirname(proj));
      entries.push(...parseRepoEntries(readFileSync(proj, "utf8"), projectRoot));
    }
  } catch {
    /* conservative defaults are fine */
  }
  return { loaded: true, entries };
}

/** Forget the snapshot so the next governed call re-reads the contract (new session / tests). */
export function resetSessionGovernance(): void {
  sessionGovernance = { loaded: false, entries: [] };
}

function ensureSessionGovernance(sessionCwd: string): SessionGovernance {
  if (!sessionGovernance.loaded) sessionGovernance = buildSessionGovernance(sessionCwd);
  return sessionGovernance;
}

/** Resolve commit policy for exactly the repository whose local_path matches,
 *  using ONLY the trusted snapshot — the working tree is never re-read here.
 *  An unmatched repository receives conservative built-ins only; repository-
 *  specific allowlists never leak across sibling repositories. */
export function commitPolicy(repoDir: string, governance?: SessionGovernance): RepoCommitPolicy {
  const snap = governance?.loaded ? governance : ensureSessionGovernance(repoDir);
  const result: RepoCommitPolicy = { allowed: [...DEFAULT_ALLOWED_GLOBS], denied: [] };
  const hit = snap.entries.find((e) => e.path === resolve(repoDir));
  if (hit) {
    result.allowed.push(...hit.allowed);
    result.denied.push(...hit.denied);
  }
  return result;
}

/** Split a command string into tokens, honoring single/double quotes. */
export function tokenizeArgs(s: string): string[] {
  const toks: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) toks.push(m[1] ?? m[2] ?? m[3] ?? "");
  return toks;
}

function isEscapedAt(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

/** Split a shell command on unquoted shell separators, including LF/CRLF.
 *  Quote/escape-aware: separators inside quotes or escaped with backslash do not split. */
function splitShellSegments(cmd: string): { segment: string; start: number }[] {
  const segs: { segment: string; start: number }[] = [];
  let current = "";
  let start = 0;
  let inDquote = false, inSquote = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '"' && !inSquote && !isEscapedAt(cmd, i)) { inDquote = !inDquote; current += ch; continue; }
    if (ch === "'" && !inDquote && !isEscapedAt(cmd, i)) { inSquote = !inSquote; current += ch; continue; }
    if (!inDquote && !inSquote && !isEscapedAt(cmd, i)) {
      const two = cmd.slice(i, i + 2);
      const one = ch;
      const sep = two === "&&" || two === "||" || two === "\r\n" ? two : one === ";" || one === "|" || one === "&" || one === "\n" || one === "\r" ? one : null;
      if (sep) {
        segs.push({ segment: current, start });
        current = "";
        i += sep.length - 1;
        start = i + 1;
        continue;
      }
    }
    current += ch;
  }
  segs.push({ segment: current, start });
  return segs;
}

/** A parsed Git invocation inside one shell segment. */
export type ParsedGitCommand = {
  segment: string;
  segmentStart: number;
  cwdOverride?: string;
  subcommand?: string;
  args: string[];
  pathspecs: string[];
};

// git-commit options that consume a SEPARATE following token (so that token is the
// option's value, not a pathspec). `--opt=value` forms are self-contained.
const COMMIT_VALUE_OPTS = new Set([
  "-m", "-F", "-C", "-c", "-t", "--message", "--file", "--reuse-message",
  "--reedit-message", "--fixup", "--squash", "--template", "--author", "--date",
  "--cleanup", "--gpg-sign", "--trailer", "--pathspec-from-file",
]);

// Git global options that take a value and should be consumed before the subcommand.
const GIT_GLOBAL_VALUE_OPTS = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix",
  "--config-env", "--attr-source",
]);

/** Parse one quote-aware Git invocation from a shell command segment, or null.
 *  The caller supplies the segment so sibling commands (and their flags) are never
 *  mixed into the Git parse. */
/** Remove quote characters that are glued onto word characters ("git" -> git,
 *  "gi"t -> git) while leaving space-delimited quoted strings untouched so prose
 *  like "some docs about git" never looks like a Git command word. */
function stripGluedQuotes(s: string): string {
  return s.replace(/(['"])(?=\S)/g, "").replace(/(?<=\S)(['"])/g, "");
}

/** Walk a shell segment's words and find the word that resolves to the COMMAND
 *  position, skipping grouping punctuation, reserved words (then/do/else/!),
 *  VAR=value assignments, and supported wrappers (command/builtin/exec/time/env
 *  with their flags and env value flags). Returns null when the command word is
 *  anything other than git — mentioning git as an ARGUMENT (grep git README.md)
 *  does not make a command a Git invocation. Quote-glued names count: bash
 *  executes "git" and "gi"t exactly like unquoted git. */
function findGitAtCommandPosition(segment: string): { charOffset: number } | null {
  const wordRe = /\S+/g;
  let m: RegExpExecArray | null;
  let inWrapper = false;
  let envValuePending = false;
  while ((m = wordRe.exec(segment))) {
    const w = m[0];
    const core = w.replace(/^[({]+/, "");
    const charOffset = m.index + (w.length - core.length);
    if (core === "") continue; // pure grouping token
    if (envValuePending) { envValuePending = false; continue; } // consumed env flag value
    if (inWrapper) {
      if (core.startsWith("-")) {
        // env flags that take a separate value (-u NAME, -S STR, -C DIR)
        if (/^-(u|S|C)$|^--split-string$/.test(core)) envValuePending = true;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(core)) continue; // env VAR=val
      inWrapper = false; // wrapper arguments ended — this word is the command
    }
    const bare = core.replace(/['"]/g, "").toLowerCase();
    if (bare === "git") return { charOffset };
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(core)) continue; // assignment prefix
    if (/^(then|do|else|!)$/.test(bare)) continue; // reserved words
    if (/^(command|builtin|exec|time|env)$/.test(bare)) { inWrapper = true; continue; }
    return null; // command position resolves to something else — not a Git command
  }
  return null;
}

/** Parse one Git invocation whose command word resolves to git. Shapes the walker
 *  cannot safely attribute are classified as ambiguous by hasAmbiguousGitInvocation()
 *  and fail closed at runtime. */
function parseGitSegment(segment: string, segmentStart: number): ParsedGitCommand | null {
  const loc = findGitAtCommandPosition(segment);
  if (!loc) return null;
  segmentStart += loc.charOffset;
  const rawTail = segment.slice(loc.charOffset);
  let toks = tokenizeArgs(rawTail);
  if (toks.length === 0) return null;
  if (toks[0].toLowerCase() !== "git") {
    // Split-quote command name ("gi"t): tokenizeArgs keeps it in pieces, so parse
    // the de-glued tail instead. Whole-word quotes ("git") already tokenize to git.
    const degluedFirst = stripGluedQuotes(rawTail).split(/\s+/)[0]?.replace(/['"]/g, "").toLowerCase();
    if (degluedFirst !== "git") return null;
    segment = rawTail;
    toks = tokenizeArgs(stripGluedQuotes(rawTail));
  } else {
    segment = rawTail;
  }

  let i = 1;
  let cwdOverride: string | undefined;
  while (i < toks.length) {
    const t = toks[i];
    if (t.startsWith("-")) {
      const eq = t.indexOf("=");
      const opt = eq >= 0 ? t.slice(0, eq) : t;
      if (GIT_GLOBAL_VALUE_OPTS.has(opt)) {
        if (eq >= 0) {
          if (opt === "-C") cwdOverride = t.slice(eq + 1);
          i++;
          continue;
        }
        if (i + 1 < toks.length) {
          if (opt === "-C") cwdOverride = toks[i + 1];
          i += 2;
          continue;
        }
      }
      i++;
      continue;
    }
    break; // first non-option token is the subcommand
  }

  const subcommand = toks[i]?.toLowerCase();
  if (!subcommand) return { segment, segmentStart, cwdOverride, args: [], pathspecs: [] };
  i++;

  const args: string[] = [];
  const pathspecs: string[] = [];
  let dashDash = false;
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (dashDash) { pathspecs.push(t); continue; }
    if (t === "--") { dashDash = true; continue; }
    if (t.startsWith("-")) {
      args.push(t);
      if (subcommand === "commit") {
        // Long-form `--opt value` consumes the next token.
        if (COMMIT_VALUE_OPTS.has(t) && i + 1 < toks.length) {
          i++;
          args.push(toks[i]);
          continue;
        }
        // Short-flag cluster like `-am x`: if the cluster ends with a value-taking
        // letter (m/F/C/c/t), the next token is that value, not a pathspec.
        if (/^-[A-Za-z]+$/.test(t)) {
          const last = t[t.length - 1];
          if (["m", "F", "C", "c", "t"].includes(last) && i + 1 < toks.length) {
            i++;
            args.push(toks[i]);
          }
        }
      }
      continue;
    }
    if (subcommand === "commit") {
      pathspecs.push(t);
    } else {
      args.push(t);
    }
  }
  return { segment, segmentStart, cwdOverride, subcommand, args, pathspecs };
}

/** Find every Git invocation in a command, quote-aware and segment-scoped. */
export function parseGitCommands(cmd: string): ParsedGitCommand[] {
  const out: ParsedGitCommand[] = [];
  for (const { segment, start } of splitShellSegments(cmd)) {
    const leading = segment.length - segment.trimStart().length;
    const parsed = parseGitSegment(segment.trim(), start + leading);
    if (parsed) out.push(parsed);
  }
  return out;
}

function unquotedText(text: string): string {
  let out = "", single = false, double = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" && !double && !isEscapedAt(text, i)) { single = !single; out += " "; }
    else if (ch === '"' && !single && !isEscapedAt(text, i)) { double = !double; out += " "; }
    else out += single || double ? " " : ch;
  }
  return out;
}

export function hasAmbiguousGitInvocation(cmd: string): boolean {
  return splitShellSegments(cmd).some(({ segment, start }) => {
    // Git mentioned anywhere (prose-blanked or glue-stripped views)?
    const mentioned = /\bgit\b/i.test(unquotedText(segment)) || /\bgit\b/i.test(stripGluedQuotes(segment));
    if (!mentioned) return false;
    // Real Git command word we cannot safely parse -> fail closed.
    if (findGitAtCommandPosition(segment) && parseGitSegment(segment.trim(), start) === null) return true;
    // Command substitution/backticks containing git execute it out of view.
    if (/\$\(/.test(segment) || segment.includes("`")) return true;
    return false;
  });
}

/** Backwards-compatible first-invocation helper. Runtime enforcement uses all. */
export function parseGitCommand(cmd: string): ParsedGitCommand | null {
  return parseGitCommands(cmd)[0] ?? null;
}

/** `git`, optionally followed by global options (`-C <dir>`, `-c k=v`, `--no-pager`),
 *  as a regex-source fragment shared by every git detector so `git -C <dir> <subcmd>`
 *  and interspersed flags match consistently. Kept for backwards compatibility with
 *  any external callers; new code should use {@link parseGitCommand}. */
const GIT_PREFIX = String.raw`\bgit\b(?:\s+-{1,2}[A-Za-z][\w-]*(?:[=\s]\S+)?)*`;

/** A `git commit` invocation, tolerant of global options between `git` and `commit`
 *  (`git -C <dir> commit`, `git -c k=v commit`, `git --no-pager commit`). */
export const GIT_COMMIT_RE = new RegExp(GIT_PREFIX + String.raw`\s+commit\b`, "i");

/** Explicit pathspec arguments of `git commit <pathspec>` — the files it commits
 *  straight from the WORKING TREE, ignoring the index. */
export function explicitCommitPathspecs(cmd: string, parsed: ParsedGitCommand | null = parseGitCommand(cmd)): string[] {
  if (!parsed || parsed.subcommand !== "commit") return [];
  return parsed.pathspecs;
}

/** The shell segment (top-level, split on ; && || | &) that contains string index
 *  `idx`, plus everything before it — positions are on the ORIGINAL string so callers
 *  can slice exactly. Kept for leading-cd logic. */
function segmentAround(cmd: string, idx: number): { segment: string; before: string } {
  for (const { segment, start } of splitShellSegments(cmd)) {
    const end = start + segment.length;
    if (idx >= start && idx < end) return { segment, before: cmd.slice(0, start) };
  }
  return { segment: cmd, before: "" };
}

/** The directory of the LAST `cd <dir>` / `pushd <dir>` in a command prefix, or null.
 *  Quote-aware (reuses tokenizeArgs). `cd` with no arg or an option arg (`cd -`) is
 *  ignored — it can't be resolved to a concrete repo, so we fall back to cwd there. */
export function leadingCdDir(before: string): string | null {
  let dir: string | null = null;
  for (const seg of before.split(/&&|\|\||[;&|]/)) {
    const toks = tokenizeArgs(seg.trim());
    if ((toks[0] === "cd" || toks[0] === "pushd") && toks[1] && !toks[1].startsWith("-")) {
      dir = toks[1];
    }
  }
  return dir;
}

function isAbsoluteOrWinAbsolute(dir: string): boolean {
  return isAbsolute(dir) || /^[A-Za-z]:[\\/]/.test(dir);
}

function resolveDir(dir: string, cwd: string): string {
  return isAbsoluteOrWinAbsolute(dir) ? dir : resolve(cwd, dir);
}

/** The effective git repo dir for a `git commit` command, resolved to an absolute path:
 *  git's own `-C <dir>` global option if present; else a leading `cd`/`pushd` target
 *  from an earlier shell segment (`cd /other && git commit …` — the chained-cd bypass);
 *  else the caller's cwd. Uses the quote-aware parser so sibling commands and quoted
 *  paths are handled correctly. */
export function gitRepoDir(cmd: string, cwd: string, parsed: ParsedGitCommand | null = parseGitCommand(cmd)): string {
  if (parsed?.cwdOverride) return resolveDir(parsed.cwdOverride, cwd);
  if (parsed?.subcommand) {
    const cd = leadingCdDir(cmd.slice(0, parsed.segmentStart));
    if (cd) return resolveDir(cd, cwd);
  }
  return cwd;
}

/** True when a `cd`/`pushd` precedes the `git commit` segment (`cd /other && git commit`
 *  …`) — the chained-cd shape whose target repo the staged-file check may not be able to
 *  reach. Used to prompt instead of silently allowing when the check can't determine. */
export function commitHasLeadingCd(cmd: string, parsed: ParsedGitCommand | null = parseGitCommand(cmd)): boolean {
  if (!parsed) return false;
  return leadingCdDir(cmd.slice(0, parsed.segmentStart)) !== null;
}

/** Will this `git commit` auto-stage tracked changes (-a / --all / a short-flag
 *  cluster containing 'a', e.g. -am / -av)? Uses the parsed command so flags in a sibling
 *  segment (like `grep -a`) are never misread. */
export function commitStagesAll(cmd: string, parsed: ParsedGitCommand | null = parseGitCommand(cmd)): boolean {
  if (!parsed || parsed.subcommand !== "commit") return false;
  if (parsed.args.includes("--all")) return true;
  return parsed.args.some((a) => /^-[A-Za-z]*a[A-Za-z]*$/.test(a));
}

/** Committed paths that are NOT docs/logs/site, or null if it can't be determined
 *  (fail-open). Covers staged files AND, when the command auto-stages (-a/-am), the
 *  tracked modifications `-a` will stage at commit time. */
async function offendingCommitPaths(pi: ExtensionAPI, cwd: string, cmd: string, parsed: ParsedGitCommand, governance: SessionGovernance): Promise<string[] | null> {
  const repoDir = gitRepoDir(cmd, cwd, parsed);
  const diff = async (extra: string[]): Promise<string[] | null> => {
    let res: { stdout: string; code: number };
    try {
      res = await pi.exec("git", ["-C", repoDir, ...extra], { cwd });
    } catch {
      return null; // not a repo / git missing → don't block
    }
    if (!res || res.code !== 0) return null;
    return String(res.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
  };
  const staged = await diff(["diff", "--cached", "--name-only"]);
  if (staged === null) return null; // can't determine → fail open (old behavior)
  const files = [...staged];
  if (commitStagesAll(cmd, parsed)) {
    const modified = await diff(["diff", "--name-only"]); // -a will stage these
    if (modified) for (const f of modified) if (!files.includes(f)) files.push(f);
  }
  // `git commit <pathspec>` commits the WORKING-TREE content of the named paths,
  // ignoring the index — so a --cached-only check misses them entirely (the classic
  // pathspec bypass). Diff those paths vs HEAD to learn what the commit will include.
  const pathspecs = explicitCommitPathspecs(cmd, parsed);
  if (pathspecs.length) {
    const named =
      (await diff(["diff", "--name-only", "HEAD", "--", ...pathspecs])) ??
      (await diff(["diff", "--name-only", "--", ...pathspecs]));
    if (named) for (const f of named) if (!files.includes(f)) files.push(f);
  }
  if (!files.length) return null;
  const { allowed, denied } = commitPolicy(repoDir, governance);
  return files.filter((f) => !isAllowedCommitPath(f, allowed, denied));
}

// MCP tools carry no server-enforced read-only flag for Fabric (unlike powerbi's
// --readonly), and this hook can't see whether a given MCP call mutates. As a
// best-effort layer we CONFIRM tool calls whose names look like a mutating
// Fabric/Power BI/MCP action. Approval-required mutations fail closed headlessly;
// this complements Pi approval and server-side read-only flags.
const MCP_TOOLISH =
  /(^|[_\-.:/])(mcp|fabric|powerbi|pbi|pbip|adx|kusto|eventhouse|onelake|lakehouse|warehouse|workspace|dataset|semanticmodel|report|pipeline|notebook|dataflow|capacity)([_\-.:/]|$)/i;
const MCP_WRITE_VERB =
  /(^|[_\-.:/])(create|update|delete|remove|deploy|publish|drop|write|patch|overwrite|rename|truncate|grant|revoke|provision)([_\-.:/A-Z]|$)/i;
const DATA_SERVER = /(^|[_\-.:/])(fabric|powerbi|pbi|sql|database|db|warehouse|lakehouse|onelake|kusto|adx|eventhouse)([_\-.:/]|$)/i;
const ROW_READ_VERB = /(^|[_\-.:/])(query|execute|evaluate|run_sql|runsql|sql_query|dax_query|preview|sample|row|rows|record|records|data|export|download)([_\-.:/]|$)/i;
const PRODUCTION_WORD = /(^|[^a-z0-9])(prod|production)([^a-z0-9]|$)/i;

/** The effective target of a proxied MCP call. The `pi-mcp-adapter` normally
 *  registers a single `mcp` tool and carries the real server/tool in
 *  `event.input.tool` (and optional `event.input.server`). Direct calls have no
 *  inner tool. */
export function effectiveMutationTarget(event: any): { outerTool: string; innerTool?: string; server?: string } {
  const outerTool = String(event?.toolName ?? "");
  const input = event?.input;
  if (outerTool === "mcp" && input && typeof input === "object" && typeof input.tool === "string") {
    return {
      outerTool,
      innerTool: input.tool,
      server: typeof input.server === "string" ? input.server : undefined,
    };
  }
  return { outerTool };
}

function mutationName(target: { outerTool: string; innerTool?: string; server?: string }): string {
  if (!target.innerTool) return target.outerTool;
  const prefix = target.server ? `${target.server}/` : "";
  return `${prefix}${target.innerTool}`;
}

/** Label a tool call that looks like a MUTATING MCP/Fabric/Power BI action, or null.
 *  Accepts either a raw tool name (for direct calls) or an effective target
 *  (for proxied `mcp` calls). Requires BOTH an MCP-ish name and a write verb,
 *  so reads (list/get/inspect) pass. */
export function mcpMutationLabel(toolName: string | { outerTool: string; innerTool?: string; server?: string }): string | null {
  const target = typeof toolName === "string" ? { outerTool: toolName } : toolName;
  const name = target.innerTool || target.outerTool;
  if (!name || name === "bash" || name === "read" || name === "edit" || name === "write" || name === "mcp") return null;
  if (!MCP_WRITE_VERB.test(name)) return null;
  // A proxied call's server identity proves this is MCP; remote tool names need not
  // repeat a Fabric/Power BI noun (e.g. azure-devops/create_work_item).
  if (target.outerTool === "mcp" && target.innerTool && target.server) return mutationName(target);
  if (!MCP_TOOLISH.test(name)) return null;
  return mutationName(target);
}

export type LiveReadRisk = {
  label: string;
  kind: "row-data" | "production-metadata";
  environment: "production" | "dev/test/unspecified";
};

/** Classify approval-required live reads without retaining or logging arguments.
 * Dev/test/unspecified metadata calls (list/get/describe/schema/inspect) return null.
 * Query/execute/sample/export-style calls can return actual rows and always ask.
 * Any read whose tool identity or arguments explicitly name prod/production asks,
 * even when it appears metadata-only. Mutations are handled by mcpMutationLabel. */
export function mcpLiveReadRisk(event: any): LiveReadRisk | null {
  const target = effectiveMutationTarget(event);
  if (mcpMutationLabel(target)) return null;
  const name = target.innerTool || target.outerTool;
  if (!name || ["bash", "read", "edit", "write", "mcp"].includes(name)) return null;
  const isDataRemote = DATA_SERVER.test(target.server || "") || MCP_TOOLISH.test(name);
  if (!isDataRemote) return null;
  let inputText = "";
  try { inputText = JSON.stringify(event?.input || {}); } catch { inputText = ""; }
  const production = PRODUCTION_WORD.test(`${name} ${target.server || ""} ${inputText}`);
  const rows = ROW_READ_VERB.test(name);
  if (!production && !rows) return null;
  return {
    label: mutationName(target),
    kind: rows ? "row-data" : "production-metadata",
    environment: production ? "production" : "dev/test/unspecified",
  };
}

/** Hard-block reasons for commit forms whose contents cannot be policy-checked:
 *  --amend rewrites an existing commit; pathspec-file forms commit paths the
 *  guardrail deliberately does not read. */
export function usesCommitPathspecFile(git: ParsedGitCommand): boolean {
  return git.args.some(
    (a) => a === "--pathspec-from-file" || a === "--pathspec-file-nul" || a.startsWith("--pathspec-from-file="),
  );
}

export function commitHardBlockReason(git: ParsedGitCommand): string | null {
  if (git.args.some((a) => a === "--amend")) return "git commit --amend";
  if (usesCommitPathspecFile(git)) return "git commit --pathspec-from-file";
  return null;
}

/** Label a destructive bash command, or null. Conservative — only clearly risky ops. */
function dangerLabel(cmd: string): string | null {
  for (const git of parseGitCommands(cmd)) {
    const args = git.args;
    if (git.subcommand === "push" && args.some((a) => a === "--force" || a === "--force-with-lease" || /^-[A-Za-z]*f[A-Za-z]*$/.test(a) || a.startsWith("+"))) return "git push --force";
    if (git.subcommand === "reset" && args.includes("--hard")) return "git reset --hard";
    if (git.subcommand === "clean" && args.some((a) => a === "--force" || /^-[A-Za-z]*f[A-Za-z]*$/.test(a))) return "git clean -f";
  }
  // rm with BOTH recursive and force flags (single-file rm is fine), SEGMENT-SCOPED:
  // flags from sibling commands (`rm x && grep -rf y .`) must never classify as rm.
  for (const { segment } of splitShellSegments(cmd)) {
    const toks = tokenizeArgs(segment);
    if (!toks.some((t) => t.replace(/['"]/g, "").split("/").pop()?.toLowerCase() === "rm")) continue;
    // Dash-prefixed tokens of THIS segment only (never the literal "rm" itself).
    const flagTokens = toks.filter((t) => t.startsWith("-"));
    // Short-flag clusters (e.g. -rf, -fr) carry their letters after a single dash.
    const shortFlags = flagTokens.filter((t) => !t.startsWith("--")).join("");
    const longFlags = flagTokens.filter((t) => t.startsWith("--")).join(" ");
    const recursive = /r/i.test(shortFlags) || /--recursive\b/i.test(longFlags);
    const force = /f/i.test(shortFlags) || /--force\b/i.test(longFlags);
    if (recursive && force) return "rm -rf";
  }
  if (/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA|VIEW|PROCEDURE|FUNCTION|INDEX|TRIGGER|SEQUENCE|TYPE)\b/i.test(cmd)) return "destructive SQL (DROP/TRUNCATE)";
  return null;
}

/** Does this path look like a secret (private key / credential / .env) the agent
 *  shouldn't read or write? Public keys (.pub) and *.example/.sample are excluded. */
export function isSecretPath(p: string): boolean {
  const base = (p.split(/[/\\]/).pop() || "").toLowerCase();
  if (base.endsWith(".pub")) return false; // public keys are fine
  if (/^\.env(\.|$)/.test(base) && !/\.(example|sample|template|dist)$/.test(base)) return true;
  if (/\.(pem|key|p12|pfx|keystore|jks)$/.test(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/.test(base)) return true;
  if (/^(\.npmrc|\.pypirc|\.netrc|\.pgpass|credentials)$/.test(base)) return true;
  if (/(^|[._-])secrets?([._-]|$)/.test(base) && /\.(ya?ml|json|env|txt|conf|ini)$/.test(base)) return true;
  return false;
}

/** First secret-looking path token in a bash command, or null. Mirrors the
 *  read/edit/write secret gate so bash isn't an unguarded exfil path
 *  (`cat .env`, `cp .env /tmp`, `curl -F f=@.env`, `base64 .env`, `>.env`). */
export function bashSecretCmdPath(cmd: string): string | null {
  for (let t of tokenizeArgs(cmd)) {
    t = t.replace(/^\d*[<>&]+/, "");         // strip redirection operators (>.env, <.env, 2>.env, &>.env)
    const at = t.lastIndexOf("@");       // curl -F field=@.env / scp x@host — take the tail
    const cand = at >= 0 ? t.slice(at + 1) : t;
    if (cand && isSecretPath(cand)) return cand;
  }
  return null;
}

// --- Audit trail ----------------------------------------------------------------
// An append-only JSONL record of what the guardrails blocked/confirmed, WHEN, and in
// WHICH repo. For a governed, review-first practice this is direct client-trust value
// and the fastest way to debug a false positive (e.g. the git -C / pathspec / cd family
// that has needed several rounds of fixes). SECRETS ARE NEVER WRITTEN — the secret gate
// logs only the matched path, never file contents; commands are truncated. Every write is
// wrapped so a logging failure can never block work or crash pi (the extension's prime
// directive is fail-open).
const AUDIT_MAX_BYTES = 1_000_000;
function auditDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".coop", "agent");
}
function auditPath(): string {
  return join(auditDir(), "guardrails-audit.jsonl");
}
type AuditEntry = {
  ts?: string;     // set by audit() on write; present on every read
  cwd: string;
  kind: "commit-block" | "danger-confirm" | "secret-confirm" | "mcp-confirm";
  tool: string;
  decision: "blocked" | "blocked-headless" | "allowed" | "declined";
  label: string;   // the short subject (offending path, danger label, tool name)
  detail: string;  // paths (commit, first 8) or the command truncated to 200 chars — NEVER secrets
};
function audit(entry: AuditEntry): void {
  try {
    appendFileSync(auditPath(), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    /* fail-open — a logging failure must never block legitimate work */
  }
}
// Best-effort size cap: on load, roll a >1 MB log to .jsonl.1 so it can't grow unbounded.
function rotateAuditIfLarge(): void {
  try {
    const p = auditPath();
    if (existsSync(p) && statSync(p).size > AUDIT_MAX_BYTES) renameSync(p, p + ".1");
  } catch {
    /* best-effort */
  }
}
// The last `n` audit entries (newest last), parsed. Empty on any read/parse trouble.
function readAuditTail(n: number): AuditEntry[] {
  try {
    const lines = readFileSync(auditPath(), "utf8").split("\n").filter((l) => l.trim());
    return lines.slice(-n).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Coop owns the tested Pi/extension fleet. context-mode currently has no setting
 * to disable its independent registry warning, so remove only its two exact update
 * notice shapes while leaving every useful byte of tool output untouched. */
export function stripManagedUpdateNotices(text: string): string {
  return text
    .replace(/^⚠️ context-mode v\S+ outdated → v\S+ available\. Upgrade: [^\r\n]+\r?\n\r?\n/, "")
    .replace(/^[ \t]*Update available: v\S+ (?:->|→) v\S+[ \t]*\|[ \t]*ctx_upgrade[ \t]*(?:\r?\n|$)/gm, "");
}

function contextModeToolName(event: any): string | null {
  const target = effectiveMutationTarget(event);
  const name = target.innerTool || target.outerTool;
  return /^ctx_[a-z0-9_]+$/i.test(name) ? name : null;
}

export default function coopGuardrails(pi: ExtensionAPI) {
  const enabled = () => process.env.COOP_NO_GUARDRAILS !== "1";
  const showUpstreamUpdates = () => process.env.COOP_SHOW_UPSTREAM_UPDATE_NOTICES === "1";
  rotateAuditIfLarge();
  // One Pi process can serve multiple sessions (/new, /resume, /fork fire
  // session_shutdown + session_start without reloading this module). Drop the
  // stale governance snapshot so THIS session's project contract is re-read on
  // its next governed call — never carry policy across session switches.
  pi.on("session_start", async () => { resetSessionGovernance(); });

  // context-mode performs its own npm registry check outside Pi's update system.
  // Filter only its exact warning lines. Maintainers can restore upstream notices
  // (and the self-upgrade tool) with COOP_SHOW_UPSTREAM_UPDATE_NOTICES=1.
  pi.on("tool_result", async (event: any) => {
    try {
      if (showUpstreamUpdates() || !contextModeToolName(event)) return;
      let changed = false;
      const content = (event?.content || []).map((item: any) => {
        if (item?.type !== "text" || typeof item.text !== "string") return item;
        const text = stripManagedUpdateNotices(item.text);
        if (text === item.text) return item;
        changed = true;
        return { ...item, text };
      });
      return changed ? { content } : undefined;
    } catch {
      return;
    }
  });

  pi.on("tool_call", async (event: any, ctx: ExtensionContext) => {
    try {
      // Never let an extension self-update around Coop's tested manifest. This is
      // intentionally a hard block with one fleet-safe remediation path.
      if (!showUpstreamUpdates() && contextModeToolName(event)?.toLowerCase() === "ctx_upgrade") {
        return { block: true, reason: "coop update policy: context-mode is manifest-pinned. Use `coop update` so Pi and every extension move together." };
      }
      if (!enabled()) return;
      const tool = event?.toolName;

      // 0. Secret-file access (read / edit / write) → confirm.
      if (tool === "read" || tool === "edit" || tool === "write") {
        const path = String(event?.input?.path ?? "");
        if (path && isSecretPath(path)) {
          if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") {
            audit({ cwd: ctx.cwd, kind: "secret-confirm", tool, decision: "blocked-headless", label: path, detail: path });
            return { block: true, reason: `coop guardrails: blocked ${tool} of secret-looking file ${path}; approval is unavailable in headless mode.` };
          }
          const verb = tool === "read" ? "read" : "write to";
          const ok = await ctx.ui.confirm(
            "coop guardrails",
            `Secret-looking file (${verb}):\n  ${path}\ncoop never exposes secrets (tokens, keys, .env). Proceed?`,
          );
          audit({ cwd: ctx.cwd, kind: "secret-confirm", tool, decision: ok ? "allowed" : "declined", label: path, detail: path });
          if (!ok) return { block: true, reason: `coop guardrails: blocked ${tool} of the secret-looking file ${path} (you declined). Reference an env var / vault instead.` };
        }
        return;
      }

      // 0b. Mutating MCP / Fabric / Power BI action → explicit approval. Proxied
      // calls use the adapter's server/tool identity; approval fails closed headlessly.
      if (tool !== "bash") {
        const target = effectiveMutationTarget(event);
        const mcp = mcpMutationLabel(target);
        if (mcp) {
          if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") {
            audit({ cwd: ctx.cwd, kind: "mcp-confirm", tool: String(tool), decision: "blocked-headless", label: mcp, detail: mcp });
            return { block: true, reason: `coop guardrails: blocked mutating MCP action ${mcp}; approval is unavailable in headless mode.` };
          }
          const ok = await ctx.ui.confirm(
            "coop guardrails",
            `This looks like a MUTATING MCP action (create/update/delete/deploy/publish):\n  ${mcp}\ncoop treats MCP as read-only (list / read / inspect). Run it?`,
          );
          audit({ cwd: ctx.cwd, kind: "mcp-confirm", tool: String(tool), decision: ok ? "allowed" : "declined", label: mcp, detail: mcp });
          if (!ok) {
            return { block: true, reason: `coop guardrails: blocked the MCP action ${mcp} (you declined). MCP is read-only by default — list / read / inspect only; make changes with explicit approval or in the Fabric / Power BI UX.` };
          }
        }
        const readRisk = mcpLiveReadRisk(event);
        if (readRisk) {
          if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") {
            audit({ cwd: ctx.cwd, kind: "mcp-confirm", tool: String(tool), decision: "blocked-headless", label: readRisk.label, detail: `${readRisk.kind}/${readRisk.environment}` });
            return { block: true, reason: `coop guardrails: blocked ${readRisk.kind} access through ${readRisk.label}; explicit approval is unavailable in headless mode.` };
          }
          const production = readRisk.environment === "production";
          const prompt = readRisk.kind === "row-data"
            ? `${production ? "PRODUCTION " : ""}row-level data read:\n  ${readRisk.label}\nConfirm the target, columns, filters, and a small row limit in the tool request. Read these rows?`
            : `Production metadata/code read:\n  ${readRisk.label}\nDev/test metadata is read-only by default; production always asks. Read it?`;
          const ok = await ctx.ui.confirm("coop live-data guardrail", prompt);
          audit({ cwd: ctx.cwd, kind: "mcp-confirm", tool: String(tool), decision: ok ? "allowed" : "declined", label: readRisk.label, detail: `${readRisk.kind}/${readRisk.environment}` });
          if (!ok) {
            return { block: true, reason: `coop guardrails: blocked ${readRisk.kind} access through ${readRisk.label} (you declined). Use dev/test metadata, or request a specific target and bounded read.` };
          }
        }
        return;
      }

      const cmd = String(event?.input?.command ?? "").trim();
      if (!cmd) return;
      if (hasAmbiguousGitInvocation(cmd)) {
        return { block: true, reason: "coop guardrails: blocked an ambiguous Git wrapper/segment that cannot be safely inspected. Run Git directly or use a supported env/command/group wrapper." };
      }

      // 1a. Secret-file access via bash mirrors the read/edit/write gate and fails
      // closed when approval UI is unavailable.
      const secretPath = bashSecretCmdPath(cmd);
      if (secretPath) {
        if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") {
          audit({ cwd: ctx.cwd, kind: "secret-confirm", tool: "bash", decision: "blocked-headless", label: secretPath, detail: secretPath });
          return { block: true, reason: `coop guardrails: blocked command touching ${secretPath}; approval is unavailable in headless mode.` };
        }
        const ok = await ctx.ui.confirm(
          "coop guardrails",
          `This command touches a secret-looking file:\n  ${secretPath}\ncoop never exposes secrets (tokens, keys, .env). Run it?`,
        );
        // Log the matched PATH only — never the command (it may embed the secret's value).
        audit({ cwd: ctx.cwd, kind: "secret-confirm", tool: "bash", decision: ok ? "allowed" : "declined", label: secretPath, detail: secretPath });
        if (!ok) {
          return { block: true, reason: `coop guardrails: blocked a command touching the secret-looking file ${secretPath} (you declined). Reference an env var / vault instead of reading or writing secrets.` };
        }
      }

      // 1. Never commit source (incl. `git commit -a/-am` auto-staging, `git -C <dir>`,
      //    `git commit <pathspec>`, and `cd <dir> && git commit` — the staged check runs
      //    against the repo the commit actually targets, see gitRepoDir).
      //    Policy comes from the TRUSTED SESSION SNAPSHOT (read once at first governed
      //    call) — in-session edits to .coop/project.yml cannot weaken it, and the
      //    contract is resolved from the session directory so sibling repositories
      //    inherit their configured policies.
      //    Hard-blocked first: --amend (rewrites history) and pathspec-file forms
      //    (commits paths the guardrail deliberately does not read) — no approval path.
      const governance = ensureSessionGovernance(ctx.cwd);
      for (const git of parseGitCommands(cmd).filter((g) => g.subcommand === "commit")) {
        const hard = commitHardBlockReason(git);
        if (hard) {
          // Inside this loop every entry is a commit; explain WHICH hard block fired.
          const why = hard.includes("--amend")
            ? "amend rewrites an existing commit"
            : "the guardrail does not read pathspec files";
          audit({ cwd: ctx.cwd, kind: "commit-block", tool: "bash", decision: "blocked", label: hard, detail: git.segment.slice(0, 200) });
          return { block: true, reason: `coop guardrails: ${hard} is never permitted — ${why}. Let a human run it.` };
        }
        const offending = await offendingCommitPaths(pi, ctx.cwd, cmd, git, governance);
        if (offending && offending.length) {
          const shown = offending.slice(0, 8).join(", ");
          const more = offending.length > 8 ? ` (+${offending.length - 8} more)` : "";
          audit({ cwd: ctx.cwd, kind: "commit-block", tool: "bash", decision: "blocked", label: "git commit", detail: shown });
          return { block: true, reason: `coop guardrails: never commit source. These paths aren't docs/logs/site: ${shown}${more}. Unstage them and let a human commit source.` };
        }
        if (offending === null && commitHasLeadingCd(cmd, git)) {
          if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") {
            return { block: true, reason: "coop guardrails: blocked an unverifiable commit because approval is unavailable in headless mode." };
          }
          const ok = await ctx.ui.confirm("coop guardrails", `Can't verify what this commit would include:\n  ${git.segment.slice(0, 200)}\nProceed?`);
          audit({ cwd: ctx.cwd, kind: "commit-block", tool: "bash", decision: ok ? "allowed" : "declined", label: "unverifiable git commit", detail: git.segment.slice(0, 200) });
          if (!ok) return { block: true, reason: "coop guardrails: blocked an unverifiable commit (you declined)." };
        }
      }

      // 2. Destructive command → explicit approval; fail closed without UI.
      const danger = dangerLabel(cmd);
      if (danger) {
        if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") {
          audit({ cwd: ctx.cwd, kind: "danger-confirm", tool: "bash", decision: "blocked-headless", label: danger, detail: cmd.slice(0, 200) });
          return { block: true, reason: `coop guardrails: blocked ${danger}; approval is unavailable in headless mode.` };
        }
        const ok = await ctx.ui.confirm(
          "coop guardrails",
          `Destructive command (${danger}):\n  ${cmd.slice(0, 200)}\nRun it?`,
        );
        audit({ cwd: ctx.cwd, kind: "danger-confirm", tool: "bash", decision: ok ? "allowed" : "declined", label: danger, detail: cmd.slice(0, 200) });
        if (!ok) {
          return { block: true, reason: `coop guardrails: blocked the ${danger} command (you declined). Propose a safer approach.` };
        }
      }
    } catch {
      /* fail-open — never block legitimate work on a guardrails bug */
    }
  });

  pi.registerCommand("coop-guardrails", {
    description: "Show what coop's runtime guardrails enforce (and whether they're on)",
    handler: async (_args, ctx) => {
      const lines = [
        `coop-guardrails: ${enabled() ? "ON" : "OFF (COOP_NO_GUARDRAILS=1)"}`,
        `coop update policy: ${showUpstreamUpdates() ? "UPSTREAM NOTICES ENABLED (maintainer mode)" : "ON — Pi/context-mode self-update prompts suppressed; use coop update"}`,
        "Enforced on the agent's tool calls (your own shell is never intercepted):",
        "  • never commit source — blocks `git commit` (incl. -a/-am, `git -C`, `git commit <path>`, and `cd <dir> && git commit`) of anything outside docs/logs/site",
        "  • destructive commands — confirms rm -rf / git push --force (incl. +refspec) / reset --hard / git clean -f / DROP·TRUNCATE",
        "  • secret files — confirms read/edit/write AND bash access (cat .env etc.) of .env / keys / credentials",
        "  • live data — allows read-only dev/test metadata; confirms row-level reads and all production access",
        "  • mutating MCP actions — confirms create/update/delete/deploy/publish-looking Fabric/Power BI/MCP tool calls (best-effort)",
        "  • managed updates — blocks ctx_upgrade so the manifest-pinned fleet moves together",
        "Advisory rules live in docs/guardrails.md. Disable with COOP_NO_GUARDRAILS=1.",
        "",
        `Audit log (append-only; secrets/file contents never written): ${auditPath()}`,
      ];
      const recent = readAuditTail(10);
      if (recent.length) {
        lines.push(`Last ${recent.length} decision(s):`);
        for (const e of recent) {
          lines.push(`  ${e.ts || "?"}  ${e.kind}/${e.decision}  ${e.label}${e.detail && e.detail !== e.label ? `  (${e.detail})` : ""}`);
        }
      } else {
        lines.push("No guardrail decisions recorded yet.");
      }
      try {
        if (typeof ctx.ui?.notify === "function") ctx.ui.notify(lines.join("\n"), "info");
      } catch {
        /* ignore */
      }
    },
  });
}

/**
 * coop-powerline — Cooptimize's own footer, splash, and rotating feature tips for Pi.
 *
 * coop renders its OWN footer and splash (NOT a third-party powerline; pi-powerline-footer
 * was removed). It adds:
 *   • its OWN footer via ctx.ui.setFooter — left "⬢ Cooptimize · <session> · <branch>", right
 *     "<model> · ctx% · tokens · $cost · <ext statuses>" (under coop/auto the model reads
 *     "auto → <routed model>"), surfacing other extensions'
 *     status text (e.g. pi-better-openai's plan usage limits) via getExtensionStatuses();
 *     one line when it fits, else the right side wraps onto extra lines (layoutFooter);
 *     plain text + common Unicode (no Nerd Font glyphs)
 *   • a startup SPLASH header via ctx.ui.setHeader, rendered from the truecolor block-art
 *     logo (assets/splash.ansi), uniform-padded and width-robust
 *   • rotating working messages via ctx.ui.setWorkingMessage — actionable feature
 *     discovery tips with a small set of easter eggs
 *   • a honeycomb working indicator in the Cooptimize palette
 *   • the running coop version in the footer (`v0.38.4`, plus `dev` from a git checkout)
 *   • a Coop-branded terminal title (`coop - <session> - <folder>`), reasserted after
 *     every point where Pi or a child process rewrites it (#429)
 *   • slash-command safety (#428): Enter on `/word` runs a command only when `word` is
 *     the start of one; an unknown command is kept in the editor with a notice, never
 *     the list's closest fuzzy match. `/exit` quits like `/quit`.
 *   • /coop-vibe, /coop-splash and /exit commands
 *
 * Everything is feature-detected and wrapped in try/catch so it can never crash pi.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveProfileName } from "../../lib/user-profile.mjs";

// --- Locate our assets (env vars from bin/coop.ps1 win; else resolve from this file) ---
let EXT_DIR = "";
try {
  EXT_DIR = dirname(fileURLToPath(import.meta.url));
} catch {
  EXT_DIR = process.env.COOP_ROOT ? join(process.env.COOP_ROOT, "extensions", "coop-powerline") : process.cwd();
}
const REPO_ROOT = join(EXT_DIR, "..", "..");

// --- Cooptimize brand palette (sampled from the color logo) ---
const fg = (r: number, g: number, b: number) => (s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
const NAVY = fg(0, 65, 107);
const FOREST = fg(66, 120, 60);
const OLIVE = fg(130, 170, 67);
const LIME = fg(178, 210, 53);
const RED = fg(239, 65, 45);
const GRAD = [NAVY, FOREST, OLIVE, LIME];

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
// Title reassertion schedule (#429): after Pi's post-bind restore (fast), after
// its async provider count on /new, and after its Windows package check (~16 s).
export const TITLE_SETTLE_DELAYS_MS = [0, 250, 1_000, 3_000, 16_000, 30_000];
export const TITLE_HEARTBEAT_MS = 15_000;
// Terminal columns one code point takes: 0 for combining marks, zero-width
// joiners and variation selectors, 2 for CJK and emoji, else 1. A rough
// East Asian Width table, enough that a wide session name cannot push a footer
// line past the terminal edge.
function charWidth(cp: number): number {
  if ((cp >= 0x0300 && cp <= 0x036f) || cp === 0x200b || cp === 0x200c || cp === 0x200d) return 0;
  if ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}
export function visWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0) || 0);
  return w;
}
// Session names come from the user (`/name`) or the naming model (`/rename`,
// automatic naming): fold whitespace and control characters and cap the length
// so one odd title cannot crowd the footer.
export function formatSessionName(name: unknown, max = 40): string {
  if (typeof name !== "string") return "";
  const clean = name.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function formatCoopTitle(cwd: string, session?: string): string {
  const folder = basename(cwd) || "coop";
  return session ? `coop - ${session} - ${folder}` : `coop - ${folder}`;
}
// The running coop version for the footer (#429): `v0.38.4`, with ` dev` when
// coop runs from a git checkout rather than an installed package. bin/coop.ps1
// exports COOP_VERSION; the VERSION file beside this extension covers a plain
// `pi -e` launch. "" when neither is readable, so the footer loses nothing.
export function formatCoopVersion(env: NodeJS.ProcessEnv = process.env, root: string = REPO_ROOT): string {
  let version = (env.COOP_VERSION || "").trim();
  if (!version) {
    try {
      version = readFileSync(join(root, "VERSION"), "utf8").trim();
    } catch {
      version = "";
    }
  }
  if (!/^\d+\.\d+\.\d+[\w.-]*$/.test(version)) return "";
  let dev = false;
  try {
    dev = existsSync(join(root, ".git"));
  } catch {
    dev = false;
  }
  return `v${version}${dev ? " dev" : ""}`;
}
function center(line: string, width: number): string {
  const w = visWidth(line);
  if (w >= width) return line;
  return " ".repeat(Math.floor((width - w) / 2)) + line;
}
// Split `s` into chunks of at most `width` visible columns, keeping ANSI escapes
// with the text they colour and never splitting a surrogate pair. Each chunk
// that carried an escape ends with a reset so colour cannot bleed into the next.
function chunks(s: string, width: number): string[] {
  const out: string[] = [];
  let cur = "";
  let vis = 0;
  let styled = false;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        cur += m[0];
        styled = true;
        i += m[0].length;
        continue;
      }
    }
    const ch = String.fromCodePoint(s.codePointAt(i) || 0);
    const w = charWidth(ch.codePointAt(0) || 0);
    if (vis + w > width && vis > 0) {
      out.push(styled ? `${cur}\x1b[0m` : cur);
      cur = "";
      vis = 0;
    }
    cur += ch;
    vis += w;
    i += ch.length;
  }
  if (cur) out.push(styled ? `${cur}\x1b[0m` : cur);
  return out;
}
// Truncate to `width` visible columns, preserving ANSI escapes so a line never overflows.
function clip(s: string, width: number): string {
  if (visWidth(s) <= width) return s;
  return chunks(s, width)[0] || "";
}

// A footer segment: its fields, the separator between them, and the separator
// drawn before the segment when it shares a line with the one before it.
export interface FooterSegment {
  parts: string[];
  join: string;
  sep: string;
}

// Lay the footer out for `width` columns. When the left side, a gap and every
// right-hand segment fit, it is the one line it has always been. Otherwise the
// left side keeps line 1 with whatever segments still fit beside it, and the
// rest wrap onto right-aligned lines below, so usage and plan limits are never
// cut off in a narrow window. A segment moves to the next line whole; only one
// wider than a whole line breaks between its fields (and a field wider than a
// line is split).
export function layoutFooter(left: string, segments: FooterSegment[], width: number): string[] {
  if (width < 1) return [];
  const segs = segments
    .map((s) => ({ ...s, parts: s.parts.filter((p) => p && stripAnsi(p).trim()) }))
    .filter((s) => s.parts.length > 0);
  const leftW = visWidth(left);
  const joined = segs.map((s, i) => (i ? s.sep : "") + s.parts.join(s.join)).join("");
  if (leftW + 1 + visWidth(joined) <= width) {
    return [left + " ".repeat(Math.max(1, width - leftW - visWidth(joined))) + joined];
  }
  const lines: string[] = [];
  const first = clip(left, width);
  const firstW = visWidth(first);
  let onFirst = true;
  let cur = "";
  const flush = () => {
    if (onFirst) {
      lines.push(cur ? first + " ".repeat(Math.max(2, width - firstW - visWidth(cur))) + cur : first);
      onFirst = false;
    } else if (cur) {
      lines.push(" ".repeat(Math.max(0, width - visWidth(cur))) + cur);
    }
    cur = "";
  };
  // Append `text` to the current line, or start a new one; true when it fit.
  const place = (text: string, sep: string): boolean => {
    const candidate = cur ? cur + sep + text : text;
    if (visWidth(candidate) <= (onFirst ? width - firstW - 2 : width)) {
      cur = candidate;
      return true;
    }
    return false;
  };
  for (const seg of segs) {
    const whole = seg.parts.join(seg.join);
    if (place(whole, seg.sep)) continue;
    flush();
    if (place(whole, seg.sep)) continue;
    seg.parts.forEach((part, i) => {
      const sep = i ? seg.join : seg.sep;
      if (place(part, sep)) return;
      flush();
      if (place(part, sep)) return;
      const pieces = chunks(part, width);
      cur = pieces.pop() || "";
      lines.push(...pieces);
    });
  }
  flush();
  return lines;
}

// --- Vibes ---
function vibesDir(): string {
  return process.env.COOP_VIBES_DIR || join(REPO_ROOT, "vibes");
}
function readLines(file: string): string[] {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch {
    return [];
  }
}
function loadVibes(set?: string): string[] {
  const dir = vibesDir();
  try {
    if (set) {
      const f = join(dir, `${set}.txt`);
      if (existsSync(f)) return readLines(f);
    }
    const all: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".txt")) continue;
      all.push(...readLines(join(dir, name)));
    }
    return all;
  } catch {
    return [];
  }
}
function vibeSets(): string[] {
  try {
    return readdirSync(vibesDir())
      .filter((n) => n.endsWith(".txt"))
      .map((n) => n.replace(/\.txt$/, ""));
  } catch {
    return [];
  }
}

// `{user}` in a vibe line becomes the person's name: the COOP profile name
// (the per-user user.json, else the machine-level one; lib/user-profile.mjs, the
// same resolution coop-profile uses), else the OS login, else "Dave" (HAL never
// did learn anyone else's name).
function vibeUserName(): string {
  try {
    const name = effectiveProfileName();
    if (name) return name;
  } catch {
    /* no profile */
  }
  try {
    const login = userInfo().username;
    if (login) return login;
  } catch {
    /* no login */
  }
  return "Dave";
}
function fillVibe(vibe: string): string {
  return vibe.includes("{user}") ? vibe.replace(/\{user\}/g, vibeUserName()) : vibe;
}

const FALLBACK_VIBES = [
  "Type /start anytime to open the Start Here menu of common tasks.",
  "Run /setup-docs to configure and build data documentation in-agent.",
  "Use /handoff to generate a clean summary of changes and next steps.",
  "Type /copy to copy the last assistant response directly to your clipboard.",
];

// --- Splash ---
function loadSplash(): string[] {
  const f = process.env.COOP_SPLASH_FILE || join(EXT_DIR, "assets", "splash.ansi");
  try {
    return readFileSync(f, "utf8").replace(/\n+$/, "").split("\n");
  } catch {
    return [];
  }
}
function wordmark(): string {
  const letters = "COOPTIMIZE".split("");
  const n = letters.length - 1;
  return letters
    .map((ch, i) => {
      const idx = Math.min(GRAD.length - 1, Math.round((i / n) * (GRAD.length - 1)));
      return GRAD[idx](ch);
    })
    .join(" ");
}

// Model segment. Under a virtual selection (coop/auto, master plan R1) the footer
// shows the routed model beside it, as Pi's own footer does: "auto → gpt-5.6-luna",
// read from the latest successful assistant response on the branch.
export function formatModel(ctx: any): string {
  try {
    const model = ctx?.model;
    if (!model?.id) return "";
    if (model.api !== "pi-virtual") return String(model.id);
    const branch = ctx?.sessionManager?.getBranch?.() ?? [];
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i];
      if (e?.type !== "message" || e.message?.role !== "assistant") continue;
      if (e.message.stopReason === "error" || e.message.stopReason === "aborted" || e.message.api === "pi-virtual") continue;
      if (e.message.model) return `${model.id} → ${e.message.model}`;
    }
    return String(model.id);
  } catch {
    return "";
  }
}

// Usage string: context-window % (room left), token totals, cost — from the session,
// so it works for any provider. Plain text + common Unicode only (no Nerd Font glyphs).
function formatUsage(ctx: any): string {
  try {
    let input = 0;
    let output = 0;
    let cost = 0;
    const branch = ctx?.sessionManager?.getBranch?.() ?? [];
    for (const e of branch) {
      if (e?.type === "message" && e.message?.role === "assistant" && e.message?.usage) {
        input += e.message.usage.input || 0;
        output += e.message.usage.output || 0;
        cost += e.message.usage.cost?.total || 0;
      }
    }
    const parts: string[] = [];
    const cu = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
    if (cu && typeof cu.percent === "number") parts.push(`ctx ${Math.round(cu.percent)}%`);
    const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
    if (input || output) parts.push(`${fmt(input)}>${fmt(output)} tok`);
    if (cost > 0) parts.push(`$${cost.toFixed(3)}`);
    return parts.join("  ");
  } catch {
    return "";
  }
}


// --- Slash-command safety (#428) ----------------------------------------------
// Pi's editor applies the autocomplete list's selected item when Enter is
// pressed on `/word`, then submits: an unknown command runs the closest FUZZY
// match (on the dev VM `/exit` ran an MCP prompt). Two coop-side guards:
//   1. the autocomplete wrapper keeps the list only while `word` is the start
//      of a command name (prefix matches first, the fuzzy rest after them), so
//      Enter never applies a fuzzy pick; an unknown word shows no list and is
//      submitted as typed;
//   2. the input hook catches such an unknown `/word` before it reaches the
//      model, puts it back in the editor with a notice, and lets the same text
//      through on a second Enter (so a message that happens to start with a
//      slash can still be sent).
// The command names come from Pi's own provider (built-ins, prompt templates,
// extension commands and skills), so nothing is listed twice.
type SlashItem = { value: string; label?: string; description?: string };
// Bare name a `/word` is matched against: `skill:name` also answers to `name`.
const bareName = (value: string) => (value.startsWith("skill:") ? value.slice("skill:".length) : value);
export function slashCommandWord(lines: string[], cursorLine: number, cursorCol: number): string | undefined {
  const line = (lines[cursorLine] || "").slice(0, cursorCol);
  const text = line.trimStart();
  if (!text.startsWith("/") || /\s/.test(text)) return undefined;
  return text.slice(1);
}
// Reorder a slash list so prefix matches lead; null when nothing starts with
// `word` (the list hides, Enter submits the text as typed).
export function filterSlashItems<T extends SlashItem>(items: T[], word: string): T[] | null {
  if (!word) return items;
  const w = word.toLowerCase();
  const starts = items.filter((i) => bareName(String(i.value)).toLowerCase().startsWith(w) || String(i.value).toLowerCase().startsWith(w));
  if (starts.length === 0) return null;
  const rest = items.filter((i) => !starts.includes(i));
  return [...starts, ...rest];
}
// Wrap Pi's autocomplete provider: every member is forwarded to the base
// provider (bound to it, so its own fields stay reachable); only getSuggestions
// is filtered, and only for a slash command word. `onCommands` receives the
// provider's command names for the input hook.
export function wrapSlashProvider(base: any, onCommands: (names: Set<string>) => void): any {
  const collect = () => {
    try {
      const names = new Set<string>();
      for (const cmd of base?.commands ?? []) {
        const name = cmd && typeof cmd === "object" ? (cmd.name ?? cmd.value) : undefined;
        if (typeof name === "string" && name) names.add(name);
      }
      onCommands(names);
    } catch {
      /* the hook then stays passive */
    }
  };
  collect();
  const getSuggestions = async (lines: string[], cursorLine: number, cursorCol: number, options: any) => {
    const result = await base.getSuggestions(lines, cursorLine, cursorCol, options);
    try {
      const word = options?.force ? undefined : slashCommandWord(lines, cursorLine, cursorCol);
      if (word === undefined || !result?.items) return result;
      const items = filterSlashItems(result.items, word);
      return items ? { ...result, items } : null;
    } catch {
      return result;
    }
  };
  return new Proxy(base, {
    get(target, prop, _receiver) {
      if (prop === "getSuggestions") return getSuggestions;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
// Is `text` an unknown slash command (one `/word` token, optionally followed by
// arguments) given the known names? A path-like first token (`/tmp/x`, `/a.b`)
// is ordinary text.
export function unknownSlashCommand(text: string, known: Set<string>): string | undefined {
  const m = /^\/([^\s/]+)(?:\s|$)/.exec(text.trim());
  if (!m || known.size === 0) return undefined;
  const word = m[1];
  if (word.includes(".") && !known.has(word)) return undefined;
  for (const name of known) if (name === word || bareName(name) === word) return undefined;
  return word;
}

export default function coopPowerline(pi: ExtensionAPI) {
  let currentSet: string | undefined; // active vibe theme (undefined = all)
  let vibes = loadVibes();
  if (vibes.length === 0) vibes = FALLBACK_VIBES;

  // Terminal title (#429). Pi restores its own title after extension binding
  // (startup and every /new, once its async provider count settles), after its
  // Windows package check, and a child console process (cmd.exe running npm
  // for a tool) leaves ITS title behind when it exits. Coop's title is
  // reasserted at each of those points: a few staggered timers after
  // session_start, every turn and tool boundary, and a slow heartbeat while a
  // terminal is attached (not the window: there the title is Electron's). The
  // timers are unref'd, so they never keep the process alive; a session
  // generation counter keeps an old session's timers from firing after /new.
  const titleTimers = new Set<ReturnType<typeof setTimeout>>();
  let titleHeartbeat: ReturnType<typeof setInterval> | undefined;
  let titleGeneration = 0;
  const clearTitleTimers = () => {
    for (const timer of titleTimers) clearTimeout(timer);
    titleTimers.clear();
    if (titleHeartbeat) clearInterval(titleHeartbeat);
    titleHeartbeat = undefined;
    titleGeneration += 1;
  };
  const renderCoopTitle = (ctx: any) => {
    try {
      const session = ctx.sessionManager?.getSessionName?.();
      ctx.ui.setTitle(formatCoopTitle(ctx.cwd || process.cwd(), session));
    } catch {
      /* title branding must never affect the session */
    }
  };
  const setCoopTitle = (ctx: any, settleStartup = false) => {
    if (!ctx?.hasUI || typeof ctx?.ui?.setTitle !== "function") return;
    renderCoopTitle(ctx);
    const generation = titleGeneration;
    const delays = settleStartup ? TITLE_SETTLE_DELAYS_MS : [0];
    for (const delay of delays) {
      const timer = setTimeout(() => {
        titleTimers.delete(timer);
        if (generation === titleGeneration) renderCoopTitle(ctx);
      }, delay);
      timer.unref?.();
      titleTimers.add(timer);
    }
    if (settleStartup && !titleHeartbeat && process.stdout?.isTTY) {
      titleHeartbeat = setInterval(() => renderCoopTitle(ctx), TITLE_HEARTBEAT_MS);
      titleHeartbeat.unref?.();
    }
  };

  // Slash-command safety (#428): the command names Pi's provider knows, filled
  // by the autocomplete wrapper; an unknown `/word` is held once (lastHeld).
  let knownCommands = new Set<string>();
  let lastHeld = "";

  const pickVibe = (): string => fillVibe(vibes[Math.floor(Math.random() * vibes.length)] || FALLBACK_VIBES[0]);

  // The footer's TUI handle, kept so a session rename (Pi's /name, or the
  // automatic naming extension) re-renders the bar without waiting for a turn.
  let footerTui: any;
  const requestFooterRender = () => {
    try {
      footerTui?.requestRender?.();
    } catch {
      /* ignore */
    }
  };

  const HEX_FRAMES = [NAVY("⬢"), FOREST("⬢"), OLIVE("⬢"), LIME("⬢"), RED("⬢")];

  const showSplash = (theme: Theme) => {
    const splash = loadSplash();
    const splashW = splash.reduce((m, l) => Math.max(m, visWidth(l)), 0);
    const vibe = pickVibe();
    return {
      invalidate() {},
      render(width: number): string[] {
        try {
          const out: string[] = [""];
          // Only draw the block-art logo when the terminal is wide enough; otherwise
          // it would wrap and look malformed — fall back to the wordmark alone.
          if (splashW > 0 && width >= splashW) {
            // Pad the whole block by ONE uniform left margin so the concentric arcs
            // stay aligned. (Centering each line by its own width — lines have ragged
            // widths because trailing transparent cells are trimmed — skews the logo.)
            const pad = " ".repeat(Math.max(0, Math.floor((width - splashW) / 2)));
            for (const l of splash) out.push(pad + l);
            out.push("");
          }
          out.push(center(wordmark(), width));
          out.push(center(theme.fg("muted", "worker-owned analytics engineering"), width));
          out.push(center(theme.fg("dim", "Microsoft Fabric · Power BI · D365 · SQL · DAX"), width));
          out.push("");
          out.push(center(`${OLIVE("⬡")} ${theme.fg("muted", vibe)}`, width));
          out.push("");
          return out;
        } catch {
          return [];
        }
      },
    };
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      if (!ctx.hasUI) return;
      setCoopTitle(ctx, true);
      // Slash-command safety (#428): wrap Pi's provider; Pi clears wrappers on
      // every rebind, so this runs per session_start.
      if (typeof ctx.ui.addAutocompleteProvider === "function") {
        ctx.ui.addAutocompleteProvider((base: any) =>
          wrapSlashProvider(base, (names) => {
            knownCommands = names;
          }),
        );
      }
      // Splash header (logo + wordmark + a vibe).
      if (typeof ctx.ui.setHeader === "function") {
        ctx.ui.setHeader((_tui, theme) => showSplash(theme));
      }
      // coop renders its OWN footer (no third-party powerline → no Nerd Font `?`
      // glyphs, no welcome overlay, no duplication). Plain text + common Unicode.
      if (typeof ctx.ui.setFooter === "function") {
        ctx.ui.setFooter((tui: any, theme: Theme, footerData: any) => {
          footerTui = tui;
          const unsub =
            typeof footerData?.onBranchChange === "function"
              ? footerData.onBranchChange(() => tui?.requestRender?.())
              : () => {};
          return {
            dispose: () => {
              if (footerTui === tui) footerTui = undefined;
              unsub();
            },
            invalidate() {},
            render(width: number): string[] {
              try {
                const branch = typeof footerData?.getGitBranch === "function" ? footerData.getGitBranch() : "";
                const session = formatSessionName(ctx.sessionManager?.getSessionName?.());
                const model = formatModel(ctx);
                const usage = formatUsage(ctx);
                // Surface other extensions' status text (e.g. pi-better-openai's plan
                // usage limits / 5h+7d windows) in OUR footer — no duplicate bar.
                const extTexts: string[] = [];
                try {
                  const statuses =
                    typeof footerData?.getExtensionStatuses === "function" ? footerData.getExtensionStatuses() : null;
                  statuses?.forEach?.((v: string) => {
                    if (v && stripAnsi(v).trim()) extTexts.push(v.trim());
                  });
                } catch {
                  /* ignore */
                }
                const version = formatCoopVersion();
                const left =
                  `${NAVY("⬢")}${LIME(" Cooptimize")}` +
                  (version ? theme.fg("dim", ` ${version}`) : "") +
                  (session ? theme.fg("muted", `  ${session}`) : "") +
                  (branch ? theme.fg("dim", `  ${branch}`) : "");
                // Model and usage first, then each extension status with its " | "
                // fields, so a status too wide for a whole line breaks between fields.
                const dot = theme.fg("dim", "  ·  ");
                const segments: FooterSegment[] = [model, usage]
                  .filter(Boolean)
                  .map((text) => ({ parts: [theme.fg("dim", text)], join: "", sep: dot }));
                for (const ext of extTexts) segments.push({ parts: ext.split(" | "), join: theme.fg("dim", " | "), sep: dot });
                return layoutFooter(left, segments, width);
              } catch {
                return [theme.fg("dim", " Cooptimize")];
              }
            },
          };
        });
      }
      // Working vibes + honeycomb indicator.
      if (typeof ctx.ui.setWorkingMessage === "function") {
        ctx.ui.setWorkingMessage(pickVibe());
      }
      if (typeof ctx.ui.setWorkingIndicator === "function") {
        ctx.ui.setWorkingIndicator({ frames: HEX_FRAMES, intervalMs: 140 });
      }
    } catch {
      /* never break pi */
    }
  });

  // Rotate the vibe each turn so the working line stays fresh; nudge a re-render so
  // the footer's usage/context numbers refresh between turns.
  pi.on("turn_start", async (_event, ctx) => {
    try {
      if (ctx.hasUI && typeof ctx.ui.setWorkingMessage === "function") {
        ctx.ui.setWorkingMessage(pickVibe());
      }
      setCoopTitle(ctx);
    } catch {
      /* ignore */
    }
  });

  pi.on("session_info_changed", async (_event, ctx) => {
    setCoopTitle(ctx);
    requestFooterRender();
  });

  pi.on("agent_start", async (_event, ctx) => {
    setCoopTitle(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    setCoopTitle(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    setCoopTitle(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    setCoopTitle(ctx);
  });

  // A tool that ran a child console process (npm, git, python) can leave that
  // process's title on the tab; take it back as soon as the tool returns.
  pi.on("tool_execution_end", async (_event, ctx) => {
    setCoopTitle(ctx);
  });

  pi.on("session_shutdown", async () => {
    clearTitleTimers();
  });

  // Slash-command safety (#428), part 2: an unknown `/word` typed in the
  // terminal is held in the editor with a notice instead of going to the model;
  // the same text sent again goes through. Passive when the provider was never
  // wrapped (the window, RPC) or the input is not the user's own typing.
  pi.on("input", async (event: any, ctx: any) => {
    try {
      if (event?.source !== "interactive" || typeof event?.text !== "string") return { action: "continue" as const };
      const text = event.text;
      if (text.trim() === lastHeld) {
        lastHeld = "";
        return { action: "continue" as const };
      }
      const word = unknownSlashCommand(text, knownCommands);
      if (!word) return { action: "continue" as const };
      lastHeld = text.trim();
      if (typeof ctx?.ui?.setEditorText === "function") {
        const restore = () => {
          try {
            ctx.ui.setEditorText(text);
          } catch {
            /* nothing to restore into */
          }
        };
        restore();
        const timer = setTimeout(restore, 0);
        timer.unref?.();
      }
      ctx?.ui?.notify?.(`Unknown command /${word}. Type / to see the list (/exit quits); press Enter again to send it as text.`, "warning");
      return { action: "handled" as const };
    } catch {
      return { action: "continue" as const };
    }
  });

  // People type /exit (#428); Pi only knows /quit.
  pi.registerCommand("exit", {
    description: "Quit coop (same as /quit)",
    handler: async (_args, ctx) => {
      try {
        ctx.shutdown();
      } catch {
        /* Pi handles the exit */
      }
    },
  });

  pi.registerCommand("coop-vibe", {
    description: "Pick a Cooptimize vibe set (rotating feature tips & easter eggs), or show a fresh one",
    handler: async (args, ctx) => {
      const want = args.trim();
      const sets = vibeSets();
      if (want && want !== "all") {
        if (!sets.includes(want)) {
          ctx.ui.notify(`Unknown vibe set "${want}". Available: ${sets.join(", ") || "(none)"}`, "warning");
          return;
        }
        currentSet = want;
      } else if (want === "all") {
        currentSet = undefined;
      }
      vibes = loadVibes(currentSet);
      if (vibes.length === 0) vibes = FALLBACK_VIBES;
      const v = pickVibe();
      if (ctx.hasUI && typeof ctx.ui.setWorkingMessage === "function") {
        ctx.ui.setWorkingMessage(v);
      }
      ctx.ui.notify(`vibe[${currentSet ?? "all"}]: ${stripAnsi(v)}`, "info");
    },
  });

  pi.registerCommand("coop-splash", {
    description: "Re-show the Cooptimize splash header",
    handler: async (_args, ctx) => {
      if (ctx.hasUI && typeof ctx.ui.setHeader === "function") {
        ctx.ui.setHeader((_tui, theme) => showSplash(theme));
        ctx.ui.notify("Cooptimize splash refreshed", "info");
      }
    },
  });
}

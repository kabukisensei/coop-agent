/**
 * coop-powerline — Cooptimize's own footer, splash, and rotating feature tips for Pi.
 *
 * coop renders its OWN footer and splash (NOT a third-party powerline; pi-powerline-footer
 * was removed). It adds:
 *   • its OWN footer via ctx.ui.setFooter — left "⬢ Cooptimize · <session> · <branch>", right
 *     "<model> · ctx% · tokens · $cost · <ext statuses>", surfacing other extensions'
 *     status text (e.g. pi-better-openai's plan usage limits) via getExtensionStatuses();
 *     plain text + common Unicode (no Nerd Font glyphs)
 *   • a startup SPLASH header via ctx.ui.setHeader, rendered from the truecolor block-art
 *     logo (assets/splash.ansi), uniform-padded and width-robust
 *   • rotating working messages via ctx.ui.setWorkingMessage — actionable feature
 *     discovery tips with a small set of easter eggs
 *   • a honeycomb working indicator in the Cooptimize palette
 *   • a Coop-branded terminal title (`coop - <session> - <folder>`)
 *   • /coop-vibe and /coop-splash commands
 *
 * Everything is feature-detected and wrapped in try/catch so it can never crash pi.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
const visWidth = (s: string) => stripAnsi(s).length;
// Session names come from the user (`/name`) or the naming model (`/rename`,
// automatic naming): fold whitespace and control characters and cap the length
// so one odd title cannot break the single-line footer.
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
function center(line: string, width: number): string {
  const w = visWidth(line);
  if (w >= width) return line;
  return " ".repeat(Math.floor((width - w) / 2)) + line;
}
// Truncate to `width` visible columns, preserving ANSI escapes so the footer never overflows.
function clip(s: string, width: number): string {
  if (visWidth(s) <= width) return s;
  let out = "";
  let vis = 0;
  let i = 0;
  while (i < s.length && vis < width) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += s[i];
    vis++;
    i++;
  }
  return `${out}\x1b[0m`;
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
// (~/.coop/user.json, the same file coop-profile reads), else the OS login,
// else "Dave" (HAL never did learn anyone else's name).
function vibeUserName(): string {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".coop", "user.json"), "utf8"));
    if (raw && typeof raw.name === "string") {
      const name = raw.name.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
      if (name) return name;
    }
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

export default function coopPowerline(pi: ExtensionAPI) {
  let currentSet: string | undefined; // active vibe theme (undefined = all)
  let vibes = loadVibes();
  if (vibes.length === 0) vibes = FALLBACK_VIBES;

  const titleTimers = new Set<ReturnType<typeof setTimeout>>();
  const clearTitleTimers = () => {
    for (const timer of titleTimers) clearTimeout(timer);
    titleTimers.clear();
  };
  const setCoopTitle = (ctx: any, settleStartup = false) => {
    if (!ctx?.hasUI || typeof ctx?.ui?.setTitle !== "function") return;
    const render = () => {
      try {
        const session = ctx.sessionManager?.getSessionName?.();
        ctx.ui.setTitle(formatCoopTitle(ctx.cwd || process.cwd(), session));
      } catch {
        /* title branding must never affect the session */
      }
    };
    render();
    // Pi restores its own title immediately after extension binding and, on
    // Windows, once more after its async package check. Reassert after both
    // lifecycle points without keeping the process alive for the delayed pass.
    for (const delay of settleStartup ? [0, 16_000] : [0]) {
      const timer = setTimeout(() => {
        titleTimers.delete(timer);
        render();
      }, delay);
      timer.unref?.();
      titleTimers.add(timer);
    }
  };

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
                const model = ctx.model?.id || "";
                const usage = formatUsage(ctx);
                // Surface other extensions' status text (e.g. pi-better-openai's plan
                // usage limits / 5h+7d windows) in OUR single footer — no duplicate bar.
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
                const left =
                  `${NAVY("⬢")}${LIME(" Cooptimize")}` +
                  (session ? theme.fg("muted", `  ${session}`) : "") +
                  (branch ? theme.fg("dim", `  ${branch}`) : "");
                const meta = theme.fg("dim", [model, usage].filter(Boolean).join("  ·  "));
                const right = [meta, ...extTexts].filter((s) => s && stripAnsi(s).trim()).join(theme.fg("dim", "  ·  "));
                const gap = Math.max(1, width - visWidth(left) - visWidth(right));
                return [clip(left + " ".repeat(gap) + right, width)];
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

  pi.on("session_shutdown", async () => {
    clearTitleTimers();
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

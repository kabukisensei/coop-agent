/**
 * coop-powerline — Cooptimize branding for Pi.
 *
 * A small companion extension (NOT a fork of pi-powerline-footer). It adds:
 *   • a startup SPLASH header rendered from the color logo (assets/splash.ansi)
 *   • a branded footer segment via ctx.ui.setStatus (surfaced by pi-powerline-footer)
 *   • rotating "working vibes" via ctx.ui.setWorkingMessage — sociocracy / democratic
 *     workplace lines riffing on the D365 + Microsoft Fabric analytics stack
 *   • a honeycomb working indicator in the Cooptimize palette
 *   • /coop-vibe and /coop-splash commands
 *
 * Everything is feature-detected and wrapped in try/catch so it can never crash pi.
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// --- Locate our assets (env vars from bin/coop win; else resolve from this file) ---
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
function center(line: string, width: number): string {
  const w = visWidth(line);
  if (w >= width) return line;
  return " ".repeat(Math.floor((width - w) / 2)) + line;
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
      if (name.endsWith(".txt")) all.push(...readLines(join(dir, name)));
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

const FALLBACK_VIBES = [
  "Forming a consent round on the bronze layer…",
  "No objections to this measure…",
  "Stewarding D365 entities into OneLake…",
  "Surfacing a tension in the lineage graph…",
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

// Build a usage segment: context-window % (how much room is left), token totals,
// and cost — computed from the session, so it works for any provider. Composes with
// pi-better-openai's own usage/limit status in the footer.
function formatUsage(ctx: any): string | undefined {
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
    if (input || output) parts.push(`↑${fmt(input)} ↓${fmt(output)}`);
    if (cost > 0) parts.push(`$${cost.toFixed(3)}`);
    return parts.length ? parts.join(" · ") : undefined;
  } catch {
    return undefined;
  }
}

function updateUsage(ctx: any): void {
  try {
    if (!ctx?.hasUI || typeof ctx.ui?.setStatus !== "function") return;
    const u = formatUsage(ctx);
    if (u) ctx.ui.setStatus("coop-usage", `${OLIVE("⬡")} ${ctx.ui.theme?.fg ? ctx.ui.theme.fg("dim", u) : u}`);
  } catch {
    /* never break pi */
  }
}

export default function coopPowerline(pi: ExtensionAPI) {
  let currentSet: string | undefined; // active vibe theme (undefined = all)
  let vibes = loadVibes();
  if (vibes.length === 0) vibes = FALLBACK_VIBES;

  const pickVibe = (): string => vibes[Math.floor(Math.random() * vibes.length)] || FALLBACK_VIBES[0];

  const HEX_FRAMES = [NAVY("⬢"), FOREST("⬢"), OLIVE("⬢"), LIME("⬢"), RED("⬢")];

  const showSplash = (theme: Theme) => {
    const splash = loadSplash();
    const vibe = pickVibe();
    return {
      invalidate() {},
      render(width: number): string[] {
        try {
          const out: string[] = [""];
          for (const l of splash) out.push(center(l, width));
          out.push("");
          out.push(center(wordmark(), width));
          out.push(center(theme.fg("muted", "worker-owned analytics engineering"), width));
          out.push(center(theme.fg("dim", "Microsoft Fabric · Power BI · D365 · SQL · DAX · semantic models"), width));
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
      // Splash header (logo + wordmark + a vibe).
      if (typeof ctx.ui.setHeader === "function") {
        ctx.ui.setHeader((_tui, theme) => showSplash(theme));
      }
      // Branded footer segment (pi-powerline-footer surfaces setStatus entries).
      if (typeof ctx.ui.setStatus === "function") {
        ctx.ui.setStatus("coop", `${NAVY("⬢")}${LIME(" Cooptimize")}`);
      }
      // Usage segment: context % left + tokens + cost (provider-agnostic).
      updateUsage(ctx);
      // Working vibes + honeycomb indicator.
      if (typeof ctx.ui.setWorkingMessage === "function") {
        ctx.ui.setWorkingMessage(`${OLIVE("⬡")} ${pickVibe()}`);
      }
      if (typeof ctx.ui.setWorkingIndicator === "function") {
        ctx.ui.setWorkingIndicator({ frames: HEX_FRAMES, intervalMs: 140 });
      }
    } catch {
      /* never break pi */
    }
  });

  // Rotate the vibe each turn so the working line stays fresh.
  pi.on("turn_start", async (_event, ctx) => {
    try {
      if (ctx.hasUI && typeof ctx.ui.setWorkingMessage === "function") {
        ctx.ui.setWorkingMessage(`${OLIVE("⬡")} ${pickVibe()}`);
      }
    } catch {
      /* ignore */
    }
  });

  // Refresh the usage segment as the conversation grows.
  pi.on("turn_end", async (_event, ctx) => updateUsage(ctx));
  pi.on("message_end", async (_event, ctx) => updateUsage(ctx));

  pi.registerCommand("coop-vibe", {
    description: "Pick a Cooptimize vibe set (sociocracy × Fabric/D365), or show a fresh one",
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
        ctx.ui.setWorkingMessage(`${OLIVE("⬡")} ${v}`);
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

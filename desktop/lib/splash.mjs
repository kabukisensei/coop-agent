// The Cooptimize splash logo for the window, from the same block-art file the
// terminal draws (extensions/coop-powerline/assets/splash.ansi, or
// COOP_SPLASH_FILE). Each character cell is two pixels tall (upper and lower
// half blocks in 24-bit colour), so the art becomes a pixel grid the renderer
// draws as crisp rectangles at any size.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SGR = /\x1b\[([0-9;]*)m/y;

function hex(parts) {
  return `#${parts.map((n) => Math.max(0, Math.min(255, Number(n) || 0)).toString(16).padStart(2, "0")).join("")}`;
}

/** The art as { width, height, runs: [[y, x, length, colour], ...] }; empty art gives width 0. */
export function parseSplash(text) {
  const lines = String(text || "").replace(/\r/g, "").replace(/\n+$/, "").split("\n");
  const grid = [];
  let width = 0;
  for (const line of lines) {
    const top = [];
    const bottom = [];
    let fg = null;
    let bg = null;
    let i = 0;
    while (i < line.length) {
      SGR.lastIndex = i;
      const m = SGR.exec(line);
      if (m) {
        const p = m[1].split(";").map(Number);
        for (let k = 0; k < p.length; k++) {
          if (p[k] === 0) { fg = null; bg = null; }
          else if (p[k] === 39) fg = null;
          else if (p[k] === 49) bg = null;
          else if ((p[k] === 38 || p[k] === 48) && p[k + 1] === 2) { const colour = hex(p.slice(k + 2, k + 5)); if (p[k] === 38) fg = colour; else bg = colour; k += 4; }
        }
        i += m[0].length;
        continue;
      }
      const ch = line[i++];
      if (ch === "▀") { top.push(fg); bottom.push(bg); }
      else if (ch === "▄") { top.push(bg); bottom.push(fg); }
      else if (ch === "█") { top.push(fg); bottom.push(fg); }
      else { top.push(bg); bottom.push(bg); }
    }
    width = Math.max(width, top.length);
    grid.push(top, bottom);
  }
  const runs = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const colour = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === colour) end++;
      if (colour) runs.push([y, x, end - x, colour]);
      x = end;
    }
  });
  return runs.length ? { width, height: grid.length, runs } : { width: 0, height: 0, runs: [] };
}

export function splashFile(repoRoot, env = process.env) {
  return env.COOP_SPLASH_FILE || join(repoRoot, "extensions", "coop-powerline", "assets", "splash.ansi");
}

export function loadSplash(repoRoot, env = process.env) {
  try { return parseSplash(readFileSync(splashFile(repoRoot, env), "utf8")); } catch { return { width: 0, height: 0, runs: [] }; }
}

// The window's own preferences (theme, size), kept in Electron's userData
// folder. Nothing here changes how Pi or coop behave.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

// "auto" follows Windows' light or dark setting with the modern pair.
export const THEMES = Object.freeze(["auto", "modern-dark", "modern-light", "retro-dark", "retro-light"]);

const DEFAULTS = Object.freeze({ theme: "auto", width: 1280, height: 860, maximized: false });

function size(value, fallback, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function normalize(value) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    theme: THEMES.includes(raw.theme) ? raw.theme : DEFAULTS.theme,
    width: size(raw.width, DEFAULTS.width, 640, 10000),
    height: size(raw.height, DEFAULTS.height, 420, 10000),
    maximized: raw.maximized === true,
  };
}

export function loadSettings(file) {
  try { return normalize(JSON.parse(readFileSync(file, "utf8"))); } catch { return normalize({}); }
}

export function saveSettings(file, settings) {
  const clean = normalize(settings);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(clean, null, 2) + "\n");
  renameSync(temp, file);
  return clean;
}

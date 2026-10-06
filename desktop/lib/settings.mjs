// The window's own preferences (theme, size), kept in Electron's userData
// folder. Nothing here changes how Pi or coop behave.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

// "auto" follows Windows' light or dark setting with the modern pair.
export const THEMES = Object.freeze(["auto", "modern-dark", "modern-light", "retro-dark", "retro-light"]);

const DEFAULTS = Object.freeze({ theme: "auto", width: 1280, height: 860, maximized: false, lastFolder: "", notify: true, menuBar: true, projects: [], openNextTime: "" });

const folderString = (value) => (typeof value === "string" && !/[\0\r\n]/.test(value) ? value.slice(0, 1024) : "");

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
    // The folder the installed package's picker opens on (the last window's).
    lastFolder: typeof raw.lastFolder === "string" && !/[\0\r\n]/.test(raw.lastFolder) ? raw.lastFolder.slice(0, 1024) : DEFAULTS.lastFolder,
    // A Windows notification and a taskbar flash when coop finishes or asks
    // while the window is in the background; the menu bar's visibility.
    notify: raw.notify !== false,
    menuBar: raw.menuBar !== false,
    // The project picker (D1m): the folders opened before, newest first, and
    // the one the icon opens without asking ("" asks).
    projects: Array.isArray(raw.projects) ? raw.projects.map(folderString).filter(Boolean).slice(0, 12) : [],
    openNextTime: folderString(raw.openNextTime),
    // The phone companion's address when it is not this computer's Tailscale
    // name (MC2); "" reads it from Tailscale.
    companionOrigin: typeof raw.companionOrigin === "string" && /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(raw.companionOrigin) ? raw.companionOrigin.toLowerCase() : "",
  };
}

/**
 * The window's size on this screen: the saved size, but never bigger than the
 * screen's work area (the screen less the taskbar), so a size saved on a
 * larger screen, or the default on a small VM display, still fits. `workArea`
 * is Electron's `{ width, height }`; the minimums still hold.
 */
export function fitToScreen({ width, height }, workArea) {
  const room = workArea && workArea.width > 0 && workArea.height > 0 ? workArea : null;
  if (!room) return { width, height };
  return { width: Math.max(640, Math.min(width, room.width)), height: Math.max(420, Math.min(height, room.height)) };
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

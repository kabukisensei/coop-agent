import { normalizeSavedChats } from "./session-restoration.mjs";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const THEMES = new Set(["modern-dark", "modern-light", "retro-messenger"]);
const DEFAULT_STATE = Object.freeze({ schemaVersion: 1, lastWorkspace: null, windowBounds: null, theme: "modern-dark", openChats: [], activeChatIndex: 0 });

function safeBounds(value) {
  if (!value || typeof value !== "object") return null;
  const fields = ["x", "y", "width", "height"];
  if (!fields.every((field) => Number.isInteger(value[field]))) return null;
  if (value.width < 960 || value.height < 640 || value.width > 10000 || value.height > 10000) return null;
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

export function normalizeDesktopState(value) {
  return {
    schemaVersion: 1,
    lastWorkspace: typeof value?.lastWorkspace === "string" && !value.lastWorkspace.includes("\0") ? value.lastWorkspace : null,
    windowBounds: safeBounds(value?.windowBounds),
    theme: THEMES.has(value?.theme) ? value.theme : "modern-dark",
    openChats: normalizeSavedChats(value?.openChats),
    activeChatIndex: Number.isInteger(value?.activeChatIndex) && value.activeChatIndex >= 0 && value.activeChatIndex < 8 ? value.activeChatIndex : 0,
  };
}

export function restoreWindowBounds(value, workAreas) {
  const bounds = safeBounds(value);
  if (!bounds || !Array.isArray(workAreas) || !workAreas.length) return null;
  const areas = workAreas.filter(area => [area?.x, area?.y, area?.width, area?.height].every(Number.isFinite) && area.width > 0 && area.height > 0);
  if (!areas.length) return null;
  const area = areas.find(area => bounds.x >= area.x && bounds.y >= area.y && bounds.x < area.x + area.width && bounds.y < area.y + area.height) || areas[0];
  const width = Math.min(bounds.width, Math.max(960, area.width));
  const height = Math.min(bounds.height, Math.max(640, area.height));
  return { width, height, x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) };
}

export function loadDesktopState(path) {
  try {
    if (!existsSync(path)) return { ...DEFAULT_STATE };
    return normalizeDesktopState(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveDesktopState(path, value) {
  const state = normalizeDesktopState(value);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  return state;
}

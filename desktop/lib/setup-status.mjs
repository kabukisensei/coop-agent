// What the first launch's setup is doing, for the "Setting up coop" window
// (Aaron 2026-10-29: the install takes minutes and said little). coop.exe
// starts the setup console with COOP_BOOT_STATUS pointing at a small JSON file;
// lib/common.ps1 (Set-CoopSetupPhase, Set-CoopSetupDetail) rewrites it at each
// step and item: { schema: 1, step, steps, phase, detail, since }. A launch
// that sets nothing up never writes it, so the window appears only when there
// is something to wait for. This module only reads and words it.

const MAX_TEXT = 300;

function text(value) {
  return typeof value === "string" ? value.replace(/[\0-\x1f\x7f]+/g, " ").trim().slice(0, MAX_TEXT) : "";
}

function count(value) {
  return Number.isInteger(value) && value >= 0 && value <= 99 ? value : 0;
}

/** The status file's text as { step, steps, phase, detail, since }, or null when it is not one. */
export function parseSetupStatus(raw) {
  let data;
  try { data = JSON.parse(String(raw || "").replace(/^﻿/, "")); } catch { return null; }
  if (!data || typeof data !== "object" || data.schema !== 1) return null;
  const phase = text(data.phase);
  if (!phase) return null;
  const since = Date.parse(typeof data.since === "string" ? data.since : "");
  const steps = count(data.steps);
  const step = Math.min(count(data.step), steps);
  return { step, steps, phase, detail: text(data.detail), since: Number.isFinite(since) ? since : 0 };
}

/** "45s", "3m 07s", "1h 02m". */
export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * What the window shows: the step line ("Step 4 of 8: Installing coop's Python
 * tools"), the item with how long it has run, the whole setup's time, and the
 * bar's fraction (steps done, half a step for the one running; null when the
 * phase has no count). `lines` are the console's last lines (consoleTail).
 */
export function setupView(status, { startedAt = 0, now = Date.now(), lines = [] } = {}) {
  const total = formatElapsed(now - startedAt);
  const recent = (Array.isArray(lines) ? lines : []).map((line) => text(String(line))).filter(Boolean).slice(-6);
  if (!status) return { stepLine: "Starting coop", detailLine: "", elapsed: total, fraction: null, lines: recent };
  const counted = status.steps > 0 && status.step > 0;
  const stepLine = counted ? `Step ${status.step} of ${status.steps}: ${status.phase}` : status.phase;
  const itemTime = status.since && status.since <= now ? ` (${formatElapsed(now - status.since)})` : "";
  const detailLine = status.detail ? `${status.detail}${itemTime}` : "";
  const fraction = counted ? Math.min(1, (status.step - 0.5) / status.steps) : null;
  return { stepLine, detailLine, elapsed: total, fraction, lines: recent };
}

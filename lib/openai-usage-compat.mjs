// Coop compatibility correction for pi-better-openai 0.1.22 (MIT).
// Upstream assumes primary=5h and secondary=7d. Preserve its fetch/auth lifecycle
// and use the provider's actual limit_window_seconds for labels instead.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ORIGINAL_USAGE_SHA256 = 'e08a1c4b6de6f5ac4fbac24b8fced4608fc270b19846a4be47022cb3c0b20976';
const hash = value => createHash('sha256').update(value).digest('hex');
const replacements = [
  ['  used_percent?: number | null;', '  used_percent?: number | null;\n  limit_window_seconds?: number | null;'],
  ['  capturedAt: number;', '  capturedAt: number;\n  windowLabels: [string, string];\n  windowPresent: [boolean, boolean];'],
  ['    capturedAt: now,', `    capturedAt: now,
    windowLabels: [windowLabel(bucket?.primary_window, "Primary"), windowLabel(bucket?.secondary_window, "Secondary")],
    windowPresent: [!!bucket?.primary_window, !!bucket?.secondary_window],`],
  ['export function parseUsageSnapshot(', `function windowLabel(window: UsageWindow | null | undefined, fallback: string): string {
  const seconds = window?.limit_window_seconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return fallback;
  if (seconds % 86400 === 0) return String(seconds / 86400) + "d";
  if (seconds % 3600 === 0) return String(seconds / 3600) + "h";
  if (seconds % 60 === 0) return String(seconds / 60) + "m";
  return String(seconds) + "s";
}

export function parseUsageSnapshot(`],
  ['          "5h",', '          snapshot.windowLabels[0],'],
  ['          "7d",', '          snapshot.windowLabels[1],'],
  ['  return `Usage: 5h: ${fiveHour} | 7d: ${sevenDay}${resets.length ? ` | ${resets.join(" | ")}` : ""}`;', `  const windows = [fiveHour, sevenDay]
    .map((percent, index) => snapshot.windowPresent[index] ? snapshot.windowLabels[index] + ": " + percent : null)
    .filter(Boolean);
  return windows.length ? "Usage: " + windows.join(" | ") + (resets.length ? " | " + resets.join(" | ") : "") : "Usage unavailable.";`],
];

export function patchUsageSource(source) {
  if (hash(source) !== ORIGINAL_USAGE_SHA256) throw new Error('Unrecognized pi-better-openai usage source; review the compatibility correction before updating.');
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error('Usage compatibility correction is ambiguous.');
    source = source.replace(before, after);
  }
  return source;
}

function regular(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Usage compatibility input must be a bounded regular file.');
  return stat;
}

export function ensureUsageCompatibility(packageRoot, { check = false } = {}) {
  if (lstatSync(packageRoot).isSymbolicLink() || lstatSync(join(packageRoot, 'src')).isSymbolicLink()) throw new Error('Usage package directories must not be symlinks.');
  const packagePath = join(packageRoot, 'package.json'); regular(packagePath);
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (pkg.name !== 'pi-better-openai' || pkg.version !== '0.1.22') throw new Error('Review the usage compatibility correction for this package version.');
  const path = join(packageRoot, 'src/usage.ts');
  const stat = regular(path), source = readFileSync(path, 'utf8');
  // Reversing the exact correction gives a verifiable original without shipping
  // a replacement copy of the dependency in production.
  let original = source;
  for (const [before, after] of [...replacements].reverse()) original = original.replace(after, before);
  const alreadyPatched = hash(original) === ORIGINAL_USAGE_SHA256 && patchUsageSource(original) === source;
  if (alreadyPatched) return { id: 'usage-window-duration-v1', upstreamSha256: ORIGINAL_USAGE_SHA256, patchedSha256: hash(source) };
  if (check) throw new Error('The packaged usage window correction is missing or changed.');
  const patched = patchUsageSource(source);
  const temporary = `${path}.coop-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, patched, { flag: 'wx', mode: stat.mode & 0o777 });
  try { renameSync(temporary, path); } catch (error) { unlinkSync(temporary); throw error; }
  return { id: 'usage-window-duration-v1', upstreamSha256: ORIGINAL_USAGE_SHA256, patchedSha256: hash(patched) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2] || process.argv.length > 4 || (process.argv[3] && process.argv[3] !== '--check')) throw new Error('Expected package-root [--check].');
    console.log(JSON.stringify(ensureUsageCompatibility(resolve(process.argv[2]), { check: process.argv[3] === '--check' })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

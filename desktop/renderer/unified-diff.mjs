// The changes panel's diff model: git's unified diff as data. Parses hunks,
// pairs each deleted line with the added line that replaced it (with a cheap
// intraline emphasis), flattens hunks into rows for the side-by-side view and
// finds search matches. Pure, no DOM (the tests run it in Node); salvaged from
// the September desktop branch's web/public/diff.js (master plan 11.5).

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

// One trailing "\r" (a CRLF working tree); a line whose own text ends in "\r"
// keeps the rest.
const stripCr = (s) => (s.length && s[s.length - 1] === "\r" ? s.slice(0, -1) : s);
const isBinaryMarker = (raw) => raw.startsWith("Binary files ") && raw.includes(" differ");

/**
 * Parse unified-diff text into { binary, hunks: [{ header, lines }] }, each line
 * { type: "ctx" | "add" | "del", oldNo, newNo, text, noNewline? }. Header noise
 * between hunks (diff --git, index, mode and rename lines, ---, +++) is skipped;
 * anything unrecognised inside a hunk closes it.
 */
export function parseUnifiedDiff(text) {
  const hunks = [];
  let binary = false;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of String(text || "").split("\n")) {
    const match = HUNK.exec(raw);
    if (match) {
      oldNo = parseInt(match[1], 10);
      newNo = parseInt(match[3], 10);
      hunk = { header: raw, lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (isBinaryMarker(raw)) binary = true;
      continue;
    }
    const c = raw[0];
    if (c === " ") {
      hunk.lines.push({ type: "ctx", oldNo, newNo, text: stripCr(raw.slice(1)) });
      oldNo += 1;
      newNo += 1;
    } else if (c === "-") {
      hunk.lines.push({ type: "del", oldNo, newNo: null, text: stripCr(raw.slice(1)) });
      oldNo += 1;
    } else if (c === "+") {
      hunk.lines.push({ type: "add", oldNo: null, newNo, text: stripCr(raw.slice(1)) });
      newNo += 1;
    } else if (c === "\\") {
      // "\ No newline at end of file" marks the line before it.
      const prev = hunk.lines[hunk.lines.length - 1];
      if (prev) prev.noNewline = true;
    } else {
      hunk = null;
      if (isBinaryMarker(raw)) binary = true;
    }
  }
  return { binary, hunks };
}

function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

// The shared suffix of what is left after the prefix, so the two never overlap.
function commonSuffixLen(a, b, p) {
  const max = Math.min(a.length - p, b.length - p);
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}

/**
 * Set .em = [start, end) on a paired del and add: only the middle that differs.
 * No emphasis for lines over 500 characters, or when most of the line changed
 * (a rewrite reads better without it).
 */
export function emphasize(del, add) {
  const a = del.text;
  const b = add.text;
  if (a.length > 500 || b.length > 500) return;
  const p = commonPrefixLen(a, b);
  let s = commonSuffixLen(a, b, p);
  const minLen = Math.min(a.length, b.length);
  if (p + s > minLen) s = minLen - p;
  const changed = (a.length - p - s) + (b.length - p - s);
  const denom = 2 * Math.max(a.length, b.length);
  if (denom === 0 || changed / denom > 0.65) return;
  del.em = [p, a.length - s];
  add.em = [p, b.length - s];
}

/**
 * Pair each run of deleted lines with the run of added lines right after it
 * (del[k] with add[k], partner index in .pair) and emphasise what changed.
 * Blocks over 200 pairs are paired without emphasis. Mutates and returns hunks.
 */
export function pairAndEmphasize(hunks) {
  for (const hunk of hunks) {
    const lines = hunk.lines;
    let i = 0;
    while (i < lines.length) {
      if (lines[i].type !== "del") { i += 1; continue; }
      const d0 = i;
      while (i < lines.length && lines[i].type === "del") i += 1;
      const dels = lines.slice(d0, i);
      if (i >= lines.length || lines[i].type !== "add") continue;
      const a0 = i;
      while (i < lines.length && lines[i].type === "add") i += 1;
      const adds = lines.slice(a0, i);
      const pairs = Math.min(dels.length, adds.length);
      for (let k = 0; k < pairs; k += 1) {
        dels[k].pair = a0 + k;
        adds[k].pair = d0 + k;
        if (pairs <= 200) emphasize(dels[k], adds[k]);
      }
    }
  }
  return hunks;
}

/**
 * Rows for the side-by-side view: { kind: "hunk", header }, { kind: "ctx",
 * oldNo, newNo, text, line } and { kind: "pair", left, right } where a del/add block
 * puts del[k] left and add[k] right (null on the shorter side).
 */
export function buildSplitRows(hunks) {
  const rows = [];
  for (const hunk of hunks) {
    rows.push({ kind: "hunk", header: hunk.header });
    const lines = hunk.lines;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.type === "ctx") {
        rows.push({ kind: "ctx", oldNo: line.oldNo, newNo: line.newNo, text: line.text, line });
        i += 1;
        continue;
      }
      const dels = [];
      const adds = [];
      while (i < lines.length && lines[i].type === "del") { dels.push(lines[i]); i += 1; }
      while (i < lines.length && lines[i].type === "add") { adds.push(lines[i]); i += 1; }
      for (let k = 0; k < Math.max(dels.length, adds.length); k += 1) {
        rows.push({ kind: "pair", left: dels[k] || null, right: adds[k] || null });
      }
    }
  }
  return rows;
}

/**
 * Case-insensitive, non-overlapping matches of query in every line, in order:
 * [{ hunkIdx, lineIdx, start, end }]. An empty query matches nothing.
 */
export function computeMatches(hunks, query) {
  const out = [];
  const needle = String(query || "").toLowerCase();
  if (!needle) return out;
  hunks.forEach((hunk, hunkIdx) => {
    hunk.lines.forEach((line, lineIdx) => {
      const hay = String(line.text).toLowerCase();
      let from = 0;
      for (;;) {
        const at = hay.indexOf(needle, from);
        if (at === -1) break;
        out.push({ hunkIdx, lineIdx, start: at, end: at + needle.length });
        from = at + needle.length;
      }
    });
  });
  return out;
}

/** Lines added and removed across the hunks. */
export function hunkStats(hunks) {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add") added += 1;
      else if (line.type === "del") removed += 1;
    }
  }
  return { added, removed };
}

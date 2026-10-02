// A line diff of two texts as unified-diff hunks, for the project form's
// "review before saving" step: the file as it is against what saving writes.
// Myers' O(ND) algorithm; pure.

const MAX_LINES = 20_000;
// Past this many changed lines the trace costs more than it is worth: the
// whole file shows as replaced.
const MAX_EDITS = 2000;

function splitLines(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// The shortest edit script as [op, line] pairs: " " kept, "-" removed, "+" added.
function editScript(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Map([[1, 0]]);
  const trace = [];
  for (let d = 0; d <= Math.min(max, MAX_EDITS); d += 1) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v.set(k, x);
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
  }
  return null;
}

function backtrack(trace, a, b, dEnd) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d -= 1) {
    const v = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = v.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push([" ", a[x - 1]]); x -= 1; y -= 1; }
    if (down) { ops.push(["+", b[y - 1]]); y -= 1; } else { ops.push(["-", a[x - 1]]); x -= 1; }
  }
  while (x > 0 && y > 0) { ops.push([" ", a[x - 1]]); x -= 1; y -= 1; }
  return ops.reverse();
}

/**
 * Unified-diff text (hunks only, `context` lines around each change) turning
 * `before` into `after`; "" when they are the same.
 */
export function unifiedDiff(before, after, { context = 3 } = {}) {
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = (a.length + b.length <= MAX_LINES && editScript(a, b))
    || [...a.map((line) => ["-", line]), ...b.map((line) => ["+", line])];
  if (!ops.some(([op]) => op !== " ")) return "";
  // Number every op, then cut hunks around the changes.
  let oldNo = 1;
  let newNo = 1;
  const rows = ops.map(([op, text]) => {
    const row = { op, text, oldNo, newNo };
    if (op !== "+") oldNo += 1;
    if (op !== "-") newNo += 1;
    return row;
  });
  const out = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].op === " ") { i += 1; continue; }
    const start = Math.max(0, i - context);
    let end = i;
    // Extend while the next change is within 2 * context kept lines.
    for (;;) {
      let j = end + 1;
      while (j < rows.length && rows[j].op === " ") j += 1;
      if (j < rows.length && j - end - 1 <= 2 * context) { end = j; continue; }
      break;
    }
    const stop = Math.min(rows.length, end + context + 1);
    const slice = rows.slice(start, stop);
    const oldCount = slice.filter((r) => r.op !== "+").length;
    const newCount = slice.filter((r) => r.op !== "-").length;
    const oldStart = oldCount ? slice.find((r) => r.op !== "+").oldNo : Math.max(0, slice[0].oldNo - 1);
    const newStart = newCount ? slice.find((r) => r.op !== "-").newNo : Math.max(0, slice[0].newNo - 1);
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const row of slice) out.push(`${row.op}${row.text}`);
    i = stop;
  }
  return out.join("\n");
}

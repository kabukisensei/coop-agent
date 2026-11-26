// Draws a unified diff from unified-diff.mjs's model, unified or side by side,
// with the changed part of each paired line emphasised and search matches
// marked. Text goes in through textContent only.
import { el } from "./ui.mjs";
import { buildSplitRows, computeMatches, pairAndEmphasize, parseUnifiedDiff } from "./unified-diff.mjs";

// Past this many rows the diff is cut (and so are review comments: a line not
// drawn has no control).
export const MAX_ROWS = 4000;

/** Parse once: { binary, hunks } with pairs and emphasis set. */
export function diffModel(text) {
  const model = parseUnifiedDiff(text);
  pairAndEmphasize(model.hunks);
  return model;
}

// A line's text split into plain, emphasised and matched runs.
function lineText(line, marks) {
  const text = line.text;
  const cuts = new Set([0, text.length]);
  const em = line.em || null;
  if (em) { cuts.add(em[0]); cuts.add(em[1]); }
  for (const m of marks) { cuts.add(m.start); cuts.add(m.end); }
  const points = [...cuts].filter((n) => n >= 0 && n <= text.length).sort((a, b) => a - b);
  const box = el("span", { class: "diff-text" });
  for (let i = 0; i < points.length - 1; i += 1) {
    const [from, to] = [points[i], points[i + 1]];
    if (from === to) continue;
    const classes = [];
    if (em && from >= em[0] && to <= em[1]) classes.push("em");
    const hit = marks.find((m) => from >= m.start && to <= m.end);
    if (hit) classes.push(hit.active ? "hit active" : "hit");
    const part = text.slice(from, to);
    box.append(classes.length ? el("span", { class: classes.join(" "), text: part }) : document.createTextNode(part));
  }
  if (!text.length) box.append(document.createTextNode(" "));
  return box;
}

const sign = (type) => (type === "add" ? "+" : type === "del" ? "-" : " ");

/**
 * The rows renderDiff draws, in order, cut after MAX_ROWS: { rows, cut }. A
 * unified row is { kind: "hunk", hunk, header } or { kind: "line", hunk, line };
 * a split row is a buildSplitRows row plus its hunk index. `hunk` is the index
 * in model.hunks.
 */
export function diffRows(model, mode = "unified") {
  const rows = [];
  let count = 0;
  let cut = false;
  if (mode === "split") {
    let hunk = -1;
    for (const row of buildSplitRows(model.hunks)) {
      if (++count > MAX_ROWS) { cut = true; break; }
      if (row.kind === "hunk") hunk += 1;
      rows.push({ ...row, hunk });
    }
  } else {
    outer: for (let hunk = 0; hunk < model.hunks.length; hunk += 1) {
      if (++count > MAX_ROWS) { cut = true; break; }
      rows.push({ kind: "hunk", hunk, header: model.hunks[hunk].header });
      for (const line of model.hunks[hunk].lines) {
        if (++count > MAX_ROWS) { cut = true; break outer; }
        rows.push({ kind: "line", hunk, line });
      }
    }
  }
  return { rows, cut };
}

/**
 * DOM for a diff. options: { mode: "unified" | "split", query, active, comments }
 * where active is the index of the match to mark as current. With `comments`
 * (Diff review comments on), removed lines carry their old line number
 * (data-old-line) and every commentable line its hunk (data-hunk); without it
 * the DOM is ED1's exactly. Returns { node, matches, cut }.
 */
export function renderDiff(model, { mode = "unified", query = "", active = -1, comments = false } = {}) {
  const matches = computeMatches(model.hunks, query);
  const marksFor = new Map();
  matches.forEach((m, index) => {
    const key = `${m.hunkIdx}:${m.lineIdx}`;
    if (!marksFor.has(key)) marksFor.set(key, []);
    marksFor.get(key).push({ ...m, active: index === active });
  });
  const lineIndex = new Map();
  model.hunks.forEach((hunk, h) => hunk.lines.forEach((line, i) => lineIndex.set(line, `${h}:${i}`)));
  const marks = (line) => (line ? marksFor.get(lineIndex.get(line)) || [] : []);
  const { rows, cut } = diffRows(model, mode);
  const box = el("div", { class: `diff-view ${mode}`, role: "group", "aria-label": "Changes", tabindex: "0" });
  if (mode === "split") {
    for (const row of rows) {
      if (row.kind === "hunk") { box.append(el("div", { class: "diff-hunk", text: row.header })); continue; }
      const hunkAttr = comments ? { "data-hunk": String(row.hunk) } : {};
      // The new side's cells carry their line number for "Fix this line" (and,
      // with review comments, a removed line's cell its old one).
      const side = (line, kind, no, newSide = false) => line
        ? [el("span", { class: "diff-num", text: no === null ? "" : String(no) }), el("span", { class: `diff-cell ${kind}`, ...(newSide && no !== null ? { "data-line": String(no), ...hunkAttr } : {}), ...(comments && !newSide && kind === "del" && no !== null ? { "data-old-line": String(no), ...hunkAttr } : {}) }, lineText(line, marks(line)))]
        : [el("span", { class: "diff-num" }), el("span", { class: "diff-cell blank" })];
      if (row.kind === "ctx") {
        box.append(el("div", { class: "diff-split-row" }, ...side(row.line, "ctx", row.oldNo), ...side(row.line, "ctx", row.newNo, true)));
      } else {
        box.append(el("div", { class: "diff-split-row" },
          ...side(row.left, "del", row.left ? row.left.oldNo : null),
          ...side(row.right, "add", row.right ? row.right.newNo : null, true)));
      }
    }
  } else {
    for (const row of rows) {
      if (row.kind === "hunk") { box.append(el("div", { class: "diff-hunk", text: row.header })); continue; }
      const { line } = row;
      const anchor = line.newNo === null ? {} : { "data-line": String(line.newNo) };
      const extra = !comments ? {} : line.newNo === null ? (line.oldNo === null ? {} : { "data-old-line": String(line.oldNo), "data-hunk": String(row.hunk) }) : { "data-hunk": String(row.hunk) };
      box.append(el("div", { class: `diff-row ${line.type}`, ...anchor, ...extra },
        el("span", { class: "diff-num", text: line.oldNo === null ? "" : String(line.oldNo) }),
        el("span", { class: "diff-num", text: line.newNo === null ? "" : String(line.newNo) }),
        el("span", { class: "diff-sign", text: sign(line.type) }),
        lineText(line, marks(line))));
    }
  }
  if (cut) box.append(el("div", { class: "diff-hunk", text: comments ? `Showing the first ${MAX_ROWS} lines. Review comments stop here: open the file to comment further down.` : `Showing the first ${MAX_ROWS} lines.` }));
  return { node: box, matches, cut };
}

// Draws a unified diff from unified-diff.mjs's model, unified or side by side,
// with the changed part of each paired line emphasised and search matches
// marked. Text goes in through textContent only.
import { el } from "./ui.mjs";
import { buildSplitRows, computeMatches, pairAndEmphasize, parseUnifiedDiff } from "./unified-diff.mjs";

const MAX_ROWS = 4000;

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
 * DOM for a diff. options: { mode: "unified" | "split", query, active } where
 * active is the index of the match to mark as current. Returns { node, matches }.
 */
export function renderDiff(model, { mode = "unified", query = "", active = -1 } = {}) {
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
  let rows = 0;
  const box = el("div", { class: `diff-view ${mode}`, role: "table", "aria-label": "Changes" });
  if (mode === "split") {
    for (const row of buildSplitRows(model.hunks)) {
      if (++rows > MAX_ROWS) break;
      if (row.kind === "hunk") { box.append(el("div", { class: "diff-hunk", role: "row", text: row.header })); continue; }
      const side = (line, kind, no) => line
        ? [el("span", { class: "diff-num", text: no === null ? "" : String(no) }), el("span", { class: `diff-cell ${kind}` }, lineText(line, marks(line)))]
        : [el("span", { class: "diff-num" }), el("span", { class: "diff-cell empty" })];
      if (row.kind === "ctx") {
        box.append(el("div", { class: "diff-split-row", role: "row" }, ...side(row.line, "ctx", row.oldNo), ...side(row.line, "ctx", row.newNo)));
      } else {
        box.append(el("div", { class: "diff-split-row", role: "row" },
          ...side(row.left, "del", row.left ? row.left.oldNo : null),
          ...side(row.right, "add", row.right ? row.right.newNo : null)));
      }
    }
  } else {
    for (const hunk of model.hunks) {
      if (++rows > MAX_ROWS) break;
      box.append(el("div", { class: "diff-hunk", role: "row", text: hunk.header }));
      for (const line of hunk.lines) {
        if (++rows > MAX_ROWS) break;
        box.append(el("div", { class: `diff-row ${line.type}`, role: "row" },
          el("span", { class: "diff-num", text: line.oldNo === null ? "" : String(line.oldNo) }),
          el("span", { class: "diff-num", text: line.newNo === null ? "" : String(line.newNo) }),
          el("span", { class: "diff-sign", text: sign(line.type) }),
          lineText(line, marks(line))));
      }
    }
  }
  if (rows > MAX_ROWS) box.append(el("div", { class: "diff-hunk", text: `Showing the first ${MAX_ROWS} lines.` }));
  return { node: box, matches };
}

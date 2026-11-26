// The changes panel (master plan D1b2): every file changed in the folder
// since the last commit, as a diff, unified or side by side. Read-only; the
// list and each diff come from git through the main process. Two ways to act
// on a change, neither of which writes from here: "Open in editor" opens the
// file in the person's own program (SSMS, Tabular Editor or Power BI Desktop,
// else Windows' app for it), and clicking a line puts a "Fix this line" note
// in the prompt, so coop makes the edit with its usual backups and approvals.
import { el, fill, icon, toast } from "./ui.mjs";
import { diffModel, diffRows, renderDiff } from "./diff-view.mjs";
import { hunkStats } from "./unified-diff.mjs";
import { makeResizer } from "./resize.mjs";

const STATUS_LABEL = { modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C", "type changed": "T", conflicted: "U", new: "N" };
// The letters are git's; the tooltip and screen-reader text say it in words.
const STATUS_TITLE = {
  modified: "Modified since the last commit",
  added: "Added (staged, not committed yet)",
  deleted: "Deleted since the last commit",
  renamed: "Renamed since the last commit",
  copied: "Copied from another file",
  "type changed": "Changed type (for example a file became a link)",
  conflicted: "Has merge conflicts to resolve",
  new: "New file, not in git yet",
};
const statusTitle = (status) => STATUS_TITLE[status] || `${status.charAt(0).toUpperCase()}${status.slice(1)} since the last commit`;

/**
 * A path from a tool call as the changes list names it: relative to the
 * working folder with "/" separators ("" when it is outside the folder).
 */
export function normalizePath(path, cwd) {
  let p = String(path || "").trim().replace(/\\/g, "/").replace(/^@/, "");
  const root = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const windows = /^[A-Za-z]:\//.test(root);
  if (root && (windows ? p.toLowerCase().startsWith(`${root.toLowerCase()}/`) : p.startsWith(`${root}/`))) p = p.slice(root.length + 1);
  else if (/^([A-Za-z]:)?\//.test(p)) return "";
  return p.replace(/^(\.\/)+/, "");
}

/**
 * Like normalizePath, but a path outside the working folder stays as a
 * "../" path (a project file repository beside it), and "" only when it is
 * on another drive.
 */
export function relativePath(path, cwd) {
  const inside = normalizePath(path, cwd);
  if (inside) return inside;
  const p = String(path || "").trim().replace(/\\/g, "/").replace(/^@/, "");
  const root = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root || !/^([A-Za-z]:)?\//.test(p)) return "";
  const windows = /^[A-Za-z]:\//.test(root);
  const same = (a, b) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  const from = root.split("/");
  const to = p.split("/");
  if (!same(from[0], to[0])) return "";
  let common = 0;
  while (common < from.length && common < to.length && same(from[common], to[common])) common++;
  return [...from.slice(common).filter(Boolean).map(() => ".."), ...to.slice(common)].join("/");
}

/**
 * The repository a changed path belongs to, from the panel's list (`rel` is
 * each repository's folder relative to the open folder: "" for the folder's
 * own, a name one level down, or a "../" path from the project file):
 * { id, path } with the path made relative to that repository, or null when
 * no listed repository holds it. The deepest match wins.
 */
export function repoForPath(repos, path) {
  const p = String(path || "");
  if (!p) return null;
  const relOf = (r) => (typeof r.rel === "string" ? r.rel : r.id);
  const inside = (repos || []).filter((r) => relOf(r) && p.startsWith(`${relOf(r)}/`));
  inside.sort((a, b) => relOf(b).length - relOf(a).length);
  if (inside.length) return { id: inside[0].id, path: p.slice(relOf(inside[0]).length + 1) };
  return !p.startsWith("../") && (repos || []).some((r) => r.id === "") ? { id: "", path: p } : null;
}

/**
 * The prompt "Fix this line" puts in the composer: the file, the line number
 * on the new side and the line's text, then the person's note.
 */
/** A path as the folders it is in ("" at the top) and the file's own name: `{ dir, name }`. */
export function splitPath(path) {
  const text = String(path || "");
  const at = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  return { dir: text.slice(0, at + 1), name: text.slice(at + 1) };
}

// One row's path: when it is too long for the list, the folders shorten and the name stays.
function pathLabel(path) {
  const { dir, name } = splitPath(path);
  return el("span", { class: "change-path" }, dir ? el("span", { class: "change-dir", text: dir }) : null, el("span", { class: "change-name", text: name }));
}

export function fixLinePrompt({ path, line, text, note }) {
  const where = line ? `${path} line ${line}` : path;
  const code = String(text || "").replace(/\s+/g, " ").trim().slice(0, 300);
  return `Fix ${where}${code ? ` (\`${code.replace(/`/g, "'")}\`)` : ""}: ${String(note || "").trim()}`;
}

// --- Diff review comments (FEATURES-DESIGN CW3) ------------------------------
// With the feature on (Settings, Features; it applies at once), a click on a
// new line OR a removed line, or a shift-click range inside one hunk and one
// side, adds a comment marker instead of ED1's single "Fix this line" note.
// Markers collect (edit, delete) and "Send to coop (N comments)" fills ONE
// prompt; the person sends it, and coop revises in an ordinary turn under the
// usual backups, approvals, lineage gate and standards_check. When the pane
// diffs again it re-anchors each comment. Comments live in this tab's memory
// only. Off (or an unreadable setting), the pane is ED1 exactly.

/** True only when the window's feature list says Diff review comments is on. */
export function commentsOn(view) {
  if (!view || view.ok === false || !Array.isArray(view.features)) return false;
  return view.features.some((f) => f && f.key === "comments" && f.on === true);
}

/**
 * The path a comment names: the repository's `rel` prefix and the path inside
 * it (a non-root repository reads as from the open folder), or
 * `draft <name>` for a draft (no prefix).
 */
export function reviewPath({ rel = "", selected = "" }) {
  const key = String(selected || "");
  if (key.startsWith("draft:")) return `draft ${key.slice(6)}`;
  const prefix = String(rel || "").replace(/\\/g, "/").replace(/\/+$/, "");
  return prefix ? `${prefix}/${key}` : key;
}

/**
 * A shift-click: a range from the last clicked line when both lie in the same
 * file, hunk and side; otherwise a new single-line comment at the click.
 * `anchor` and `click` are { key, side: "new" | "old", hunk, line }.
 * Returns { side, hunk, from, to }.
 */
export function extendSelection(anchor, click) {
  if (anchor && anchor.key === click.key && anchor.side === click.side && anchor.hunk === click.hunk) {
    return { side: click.side, hunk: click.hunk, from: Math.min(anchor.line, click.line), to: Math.max(anchor.line, click.line) };
  }
  return { side: click.side, hunk: click.hunk, from: click.line, to: click.line };
}

/**
 * One side of a diff as line number -> { text, type, hunk }: the new side holds
 * context and added lines (new numbers), the old side context and removed
 * lines (old numbers). Only lines the diff shows (MAX_ROWS) are in it.
 */
export function sideLines(model, side, mode = "unified") {
  const out = new Map();
  const add = (line, hunk) => {
    if (side === "old" ? line.oldNo !== null : line.newNo !== null) out.set(side === "old" ? line.oldNo : line.newNo, { text: line.text, type: line.type, hunk });
  };
  for (const row of diffRows(model, mode).rows) {
    if (row.kind === "line") add(row.line, row.hunk);
    else if (row.kind === "ctx") add(row.line, row.hunk);
    else if (row.kind === "pair") { if (row.left) add(row.left, row.hunk); if (row.right) add(row.right, row.hunk); }
  }
  return out;
}

/**
 * Whether a line may take a comment: shown (not past the cut) and, on the old
 * side, a removed line.
 */
export function canComment(model, side, line, mode = "unified") {
  const hit = sideLines(model, side, mode).get(line);
  return Boolean(hit && (side === "new" || hit.type === "del"));
}

/** A comment's lines and the two lines either side ({ text, before, after }), null where the diff shows none. */
export function commentContext(model, side, from, to) {
  const lines = sideLines(model, side);
  const at = (n) => (lines.has(n) ? lines.get(n).text : null);
  const text = [];
  for (let n = from; n <= to; n += 1) text.push(at(n) === null ? "" : at(n));
  return { text, before: [at(from - 2), at(from - 1)], after: [at(to + 1), at(to + 2)] };
}

// How far from its old number a comment's lines may have moved and still count
// as the same place.
const NEAR = 40;

/**
 * Re-anchor a comment ({ side, from, to, text, before, after }) on a fresh diff
 * model: { status, from, to, hunk }. status is "unchanged" (the same lines,
 * perhaps shifted), "changed" (the lines around it fit and the lines
 * themselves were edited) or "moved" ("moved or gone, check it": no single
 * match near the old number). The two lines either side tell repeated lines
 * (END, GO, ")") apart.
 */
export function reanchorComment(comment, model) {
  const { side, from, to } = comment;
  const len = to - from + 1;
  const text = comment.text || [];
  const before = comment.before || [null, null];
  const after = comment.after || [null, null];
  const lines = sideLines(model, side);
  const textOf = (n) => (lines.has(n) ? lines.get(n).text : undefined);
  const moved = { status: "moved", from, to, hunk: -1 };
  if (side === "old") {
    // The old side is the last commit: its numbers hold until a commit.
    let removed = true;
    for (let i = 0; i < len; i += 1) {
      const hit = lines.get(from + i);
      if (hit && hit.text !== text[i]) return moved;
      if (!hit || hit.type !== "del") removed = false;
    }
    const hunk = lines.has(from) ? lines.get(from).hunk : -1;
    return { status: removed ? "unchanged" : "changed", from, to, hunk };
  }
  const textAt = (p) => text.every((t, i) => textOf(p + i) === t);
  const contextScore = (p, size) => before.filter((t, k) => t !== null && textOf(p - before.length + k) === t).length
    + after.filter((t, k) => t !== null && textOf(p + size + k) === t).length;
  const contextSize = before.filter((t) => t !== null).length + after.filter((t) => t !== null).length;
  const near = [...lines.keys()].filter((p) => Math.abs(p - from) <= NEAR).sort((a, b) => a - b);
  const exact = near.filter(textAt);
  const unchanged = (p) => ({ status: "unchanged", from: p, to: p + len - 1, hunk: lines.get(p).hunk });
  // 1. The same lines with their neighbours (one neighbour may have been edited).
  const strong = exact.filter((p) => contextScore(p, len) >= Math.max(1, contextSize - 1) || contextSize === 0);
  if (strong.length === 1) return unchanged(strong[0]);
  if (strong.length > 1) return moved;
  // Not there with its neighbours: does the place around it still fit? The lines before
  // end just above q, the lines after start further down; something lies
  // between (an empty gap means the lines are gone).
  const beforeKnown = before.some((t) => t !== null);
  const afterKnown = after.some((t) => t !== null);
  if (!beforeKnown && !afterKnown) return exact.length === 1 ? unchanged(exact[0]) : moved;
  const beforeFits = (q) => before.every((t, k) => t === null || textOf(q - before.length + k) === t);
  const afterFits = (r) => after.every((t, k) => t === null || textOf(r + k) === t);
  const fits = [];
  if (beforeKnown) {
    for (const q of near) {
      if (!beforeFits(q)) continue;
      let end = -1;
      if (afterKnown) {
        for (let r = q + 1; r <= q + len + 20; r += 1) if (afterFits(r)) { end = r - 1; break; }
        if (end < q) continue;
      } else {
        end = q;
        while (end - q + 1 < len && lines.has(end + 1)) end += 1;
      }
      fits.push({ q, end });
    }
  } else {
    // Only the lines after are known (the top of the file): they start at r.
    for (const r of near) {
      if (!afterFits(r) || !lines.has(r - 1)) continue;
      let q = r - 1;
      while (r - q < len && lines.has(q - 1)) q -= 1;
      fits.push({ q, end: r - 1 });
    }
  }
  // 2. The place around it fits and the lines themselves were edited.
  if (fits.length === 1 && lines.has(fits[0].q)) return { status: "changed", from: fits[0].q, to: fits[0].end, hunk: lines.get(fits[0].q).hunk };
  // The lines before and after now meet with nothing between: the lines are gone.
  if (beforeKnown && afterKnown && near.some((q) => beforeFits(q) && afterFits(q))) return moved;
  // 3. Its neighbours changed, but the lines are there once.
  if (!fits.length && exact.length === 1) return unchanged(exact[0]);
  return moved;
}

/** The words a marker shows for a status. */
export const COMMENT_STATUS = { unchanged: "unchanged", changed: "changed", moved: "moved or gone, check it" };

/** One numbered line of the batch prompt. */
export function commentLine(comment, index) {
  const removed = comment.side === "old";
  const where = comment.from === comment.to ? `line ${comment.from}` : `lines ${comment.from}-${comment.to}`;
  const code = comment.from === comment.to ? String((comment.text || [])[0] || "").replace(/\s+/g, " ").trim().slice(0, 300) : "";
  const note = String(comment.note || "").replace(/\s+/g, " ").trim();
  return `${index}. ${comment.path} ${where} (${removed ? "removed" : "new"})${code ? ` \`${code.replace(/`/g, "'")}\`` : ""}: ${note}`;
}

/**
 * The one prompt "Send to coop (N comments)" fills: every comment numbered, so
 * coop answers each by number. `comments` carry { repoLabel, path, side, from,
 * to, text, note }.
 */
export function reviewPrompt(comments) {
  const repos = [...new Set(comments.map((c) => c.repoLabel).filter(Boolean))];
  const where = repos.length > 1 ? ` (repos ${repos.join(", ")})` : repos.length ? ` (repo ${repos[0]})` : "";
  return [`Review comments on the Changes pane${where}:`, ...comments.map((c, i) => commentLine(c, i + 1)), "Revise under the usual rules; answer each by number."].join("\n");
}

export function mountChanges(box, options, { coop, cwd, setPrompt, commentsOn: isCommentsOn }) {
  const state = { files: [], drafts: [], draftsDir: "", selected: "", mode: "unified", query: "", active: 0, matches: [], diff: null, loading: false, repos: [], repo: null, comments: [], anchor: null, model: null, nextComment: 1 };
  // Diff review comments (CW3): read at every use, so a Settings change applies at once.
  const reviewing = () => { try { return typeof isCommentsOn === "function" && isCommentsOn() === true; } catch { return false; } };
  // Shown only when the open folder holds more than one repository.
  const repoPicker = el("select", { class: "field", "aria-label": "Repository to compare", title: "Which repository's changes to show", onchange: (event) => load("", event.target.value) });
  const repoRow = el("label", { class: "pane-toolbar change-repo", hidden: true }, el("span", { class: "change-repo-label", text: "Repository" }), repoPicker);
  const summary = el("div", { class: "pane-summary" });
  const list = el("ul", { class: "change-list", role: "listbox", "aria-label": "Changed files" });
  const search = el("input", { class: "field", type: "search", placeholder: "Find in this diff", "aria-label": "Find in this diff" });
  const count = el("span", { class: "find-count", "aria-live": "polite" });
  const modeButton = el("button", { type: "button", class: "btn", title: "Show the diff as one column or side by side" });
  const fileHead = el("div", { class: "change-head" });
  const diffBox = el("div", { class: "change-diff" });
  const toolbar = el("div", { class: "pane-toolbar" }, search, count,
    el("button", { type: "button", class: "btn icon", title: "Earlier match", "aria-label": "Earlier match", onclick: () => step(-1) }, icon("up")),
    el("button", { type: "button", class: "btn icon", title: "Later match", "aria-label": "Later match", onclick: () => step(1) }, icon("down")),
    modeButton);
  const split = el("div", { class: "split-resize", role: "separator", "aria-orientation": "horizontal", "aria-label": "Resize the changed files list", tabindex: "0" });
  box.append(repoRow, summary, list, split, fileHead, toolbar, diffBox);
  // The list and the diff share the pane; the diff keeps room for a few lines.
  const resizer = makeResizer({
    handle: split,
    key: "coop.changeListHeight",
    cssVar: "--change-list-height",
    target: box,
    min: 36,
    max: () => (box.clientHeight ? box.clientHeight - 200 : Infinity),
    measure: () => list.getBoundingClientRect().height,
    fromPointer: (event, start) => start.size + (event.clientY - start.y),
    keys: { grow: "ArrowDown", shrink: "ArrowUp" },
    axis: "y",
  });
  window.addEventListener("resize", () => resizer.apply());

  function renderModeButton() {
    modeButton.textContent = state.mode === "split" ? "Unified" : "Side by side";
  }

  function renderList() {
    fill(list, ...state.files.map((file) => {
      const item = el("li", { class: `change-file${file.path === state.selected ? " active" : ""}`, role: "option", "aria-selected": file.path === state.selected ? "true" : "false", tabindex: "0", title: file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path },
        el("span", { class: `change-status ${file.status.replace(/\s+/g, "-")}`, text: STATUS_LABEL[file.status] || "M", title: statusTitle(file.status), "aria-label": statusTitle(file.status) }),
        pathLabel(file.path),
        file.binary ? el("span", { class: "chip", text: "binary", title: "Not a text file, so there is no diff to read" }) : file.status === "new" ? el("span", { class: "chip", text: "new", title: STATUS_TITLE.new })
          : el("span", { class: "tool-stats", title: `${file.added} ${file.added === 1 ? "line" : "lines"} added, ${file.removed} removed` }, el("span", { class: "add", text: `+${file.added}` }), el("span", { class: "del", text: `-${file.removed}` })));
      item.addEventListener("click", () => select(file.path));
      item.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(file.path); } });
      return item;
    }), ...draftItems());
  }

  // F2: the drafts coop wrote for this repository (this client's drafts folder),
  // newest first, as a group after the changed files; nothing when there are none.
  function draftItems() {
    if (!state.drafts.length) return [];
    const head = el("li", { class: "change-group", role: "presentation", title: state.draftsDir ? `Draft (this client): ${state.draftsDir}` : "" }, el("span", { text: "Drafts (this client)" }));
    const items = state.drafts.map((draft) => {
      const key = `draft:${draft.path}`;
      const item = el("li", { class: `change-file${key === state.selected ? " active" : ""}`, role: "option", "aria-selected": key === state.selected ? "true" : "false", tabindex: "0", title: `Draft (this client): ${draft.path}` },
        el("span", { class: "change-status draft", text: "D", title: "Draft: a file coop wrote for review, not an edit of a repository file", "aria-label": "Draft" }),
        pathLabel(draft.path),
        el("span", { class: "chip", text: "draft", title: "Lives in this client's drafts folder, not in the repository" }));
      item.addEventListener("click", () => select(key));
      item.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(key); } });
      return item;
    });
    return [head, ...items];
  }

  function renderDiffView(scroll = false) {
    if (!state.diff) { fill(diffBox); count.textContent = ""; return; }
    const result = state.diff;
    if (result.binary || result.tooLarge || result.gone || result.error) {
      const text = result.error || (result.gone ? "This file is gone." : result.tooLarge ? "This change is too large to show here." : "This is not a text file, so there is no diff to read.");
      fill(diffBox, el("p", { class: "pane-empty", text }));
      count.textContent = "";
      return;
    }
    const model = diffModel(result.diff);
    if (!model.hunks.length) { fill(diffBox, el("p", { class: "pane-empty", text: "No lines changed: the file was renamed or its permissions changed." })); count.textContent = ""; return; }
    const review = reviewing();
    state.model = model;
    const { node, matches } = renderDiff(model, { mode: state.mode, query: state.query, active: state.active, comments: review });
    state.matches = matches;
    count.textContent = state.query ? (matches.length ? `${Math.min(state.active + 1, matches.length)} of ${matches.length}` : "No matches") : "";
    fill(diffBox, node);
    if (review) decorate(node);
    if (scroll) { const hit = node.querySelector(".hit.active"); if (hit) hit.scrollIntoView({ block: "center" }); }
  }

  async function select(path) {
    state.selected = path;
    state.active = 0;
    renderList();
    const file = state.files.find((f) => f.path === path);
    const draft = path.startsWith("draft:") ? state.drafts.find((d) => `draft:${d.path}` === path) : null;
    const canOpen = Boolean(draft || (file && file.status !== "deleted"));
    fill(fileHead, draft ? el("code", { text: `Draft (this client): ${draft.path}` }) : file ? el("code", { text: file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path }) : "",
      canOpen ? el("button", { type: "button", class: "btn change-open", title: "Edit this file in SSMS, Tabular Editor, Power BI Desktop or your default app (Settings picks the one for DAX)", onclick: () => openInEditor(path) }, icon("file"), " Open in editor") : null);
    fill(diffBox, el("div", { class: "working" }, el("span", { class: "spinner" }), el("span", { text: "Reading the diff" })));
    const result = await coop.changeDiff(path);
    if (state.selected !== path) return;
    if (!result.success) { state.diff = { error: result.error || "Could not read the diff." }; renderDiffView(); return; }
    state.diff = result.data;
    reanchorFile(path, result.data.diff || "");
    if (file && file.status === "new" && result.data.diff) {
      const stats = hunkStats(diffModel(result.data.diff).hunks);
      file.added = stats.added;
    }
    renderDiffView(true);
  }

  function renderRepos() {
    repoRow.hidden = state.repos.length < 2;
    fill(repoPicker, ...state.repos.map((r) => el("option", { value: r.id, text: r.id ? r.label : `${r.label} (this folder)`, selected: r.id === state.repo })));
  }

  // `want` is a path from a tool card (relative to the open folder, "../" for
  // a project file repository beside it); it picks
  // the repository that holds it. `repo` is a choice from the picker.
  async function load(want, repo) {
    // A request during a load (a "View in Changes" click) is not dropped: the
    // latest one runs again when this load ends.
    if (state.loading) { state.queued = { want: want || (state.queued && state.queued.want) || "", repo }; return; }
    state.loading = true;
    try { await loadNow(want, repo); } finally { state.loading = false; }
    if (state.queued) { const next = state.queued; state.queued = null; await load(next.want, next.repo); }
  }

  async function loadNow(want, repo) {
    fill(summary, el("span", { class: "spinner" }), el("span", { text: " Reading changes" }));
    const asked = want;
    let pick = typeof repo === "string" ? repo : null;
    let hit = want ? repoForPath(state.repos, want) : null;
    if (hit) pick = hit.id;
    let result = await coop.changes(pick);
    // The first time, the list of repositories comes with the first answer.
    if (result.success && want && !hit) {
      hit = repoForPath(result.data.repos, want);
      if (hit && hit.id !== result.data.current) result = await coop.changes(hit.id);
    }
    if (hit) want = hit.path;
    else if (want.startsWith("../")) want = "";
    if (!result.success) { summary.textContent = result.error || "Could not read the changes."; return; }
    const data = result.data;
    state.repos = data.repos || [];
    if (state.repo !== data.current) state.selected = "";
    state.repo = data.current;
    state.drafts = data.drafts || [];
    state.draftsDir = data.draftsDir || "";
    renderRepos();
    if (!data.repo) {
      state.files = [];
      summary.textContent = "This folder is not in a git repository, so there is nothing to compare. The tool cards in the conversation still show each edit.";
      renderList();
      state.diff = null;
      renderDiffView();
      fill(fileHead);
      return;
    }
    state.files = data.files;
    const n = data.files.length;
    summary.textContent = n ? `${n} ${n === 1 ? "file" : "files"} changed since the last commit${data.truncated ? " (list cut short)" : ""}` : "No changes since the last commit.";
    const target = want && data.files.some((f) => f.path === want) ? want
      : data.files.some((f) => f.path === state.selected) ? state.selected : (data.files[0] && data.files[0].path) || "";
    renderList();
    if (target) await select(target);
    else { state.diff = null; renderDiffView(); fill(fileHead); }
    if (want && target !== want) toast(`${asked} has no changes since the last commit.`, "info");
  }

  // The panel refreshes once when the window comes back after an editor
  // opened, so a saved edit shows in the diff.
  let refreshOnFocus = false;
  window.addEventListener("focus", () => { if (refreshOnFocus) { refreshOnFocus = false; load(state.selected.startsWith("draft:") ? "" : state.selected); } });

  async function openInEditor(path) {
    const result = await coop.openInEditor(path);
    if (result && result.cancelled) return;
    if (!result || !result.success) { toast((result && result.error) || "Could not open the file.", "warning"); return; }
    const { editor, fallback } = result.data || {};
    refreshOnFocus = true;
    toast(fallback ? `${fallback} was not found, so it opened in ${editor}.` : `Opened in ${editor}. Save there; this panel shows the edit when you come back.`, fallback ? "warning" : "info");
  }

  // "Fix this line": a click on a line of the new side opens a note under it;
  // sending puts the note in the prompt (the person sends it).
  function openFixForm(row) {
    const old = diffBox.querySelector(".fix-line");
    if (old) old.remove();
    const line = Number(row.dataset.line);
    const text = (row.querySelector(".diff-text") || row).textContent;
    const file = state.selected.startsWith("draft:") ? state.selected.slice(6) : state.selected;
    const input = el("input", { class: "field", type: "text", placeholder: `What should change on line ${line}?`, "aria-label": `What should change on line ${line}` });
    const send = () => {
      const note = input.value.trim();
      if (!note) { input.focus(); return; }
      form.remove();
      if (typeof setPrompt === "function") setPrompt(fixLinePrompt({ path: file, line, text, note }));
    };
    const form = el("div", { class: "fix-line", role: "group", "aria-label": "Fix this line" },
      input,
      el("button", { type: "button", class: "btn primary", text: "Ask coop", title: "Put this in the prompt; you send it", onclick: send }),
      el("button", { type: "button", class: "btn icon", title: "Cancel", "aria-label": "Cancel", onclick: () => form.remove() }, icon("close")));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); send(); }
      else if (event.key === "Escape") { event.preventDefault(); form.remove(); }
    });
    const anchor = row.classList.contains("diff-cell") ? row.parentElement : row;
    anchor.after(form);
    input.focus();
  }

  diffBox.addEventListener("click", (event) => {
    if (event.target.closest(".fix-line")) return;
    if (reviewing()) { commentClick(event); return; }
    const selection = window.getSelection ? String(window.getSelection()) : "";
    if (selection) return;
    const row = event.target.closest("[data-line]");
    if (row && diffBox.contains(row)) openFixForm(row);
  });
  // A shift-click makes a range of review comments, not a text selection.
  diffBox.addEventListener("mousedown", (event) => {
    if (event.shiftKey && reviewing() && event.target.closest("[data-line], [data-old-line]")) event.preventDefault();
  });

  // --- Diff review comments (CW3) ----------------------------------------------
  const reviewBar = el("div", { class: "pane-toolbar review-bar", role: "group", "aria-label": "Review comments" });
  const fileKey = (path = state.selected) => `${state.repo === null ? "" : state.repo}\u0000${path}`;
  const currentRepo = () => state.repos.find((r) => r.id === state.repo) || null;
  const unsent = () => state.comments.filter((c) => !c.sent);
  const commentWhere = (c) => `${c.from === c.to ? `line ${c.from}` : `lines ${c.from}-${c.to}`} (${c.side === "old" ? "removed" : "new"})`;

  function renderReviewBar() {
    if (!reviewing() || !state.comments.length) { reviewBar.remove(); return; }
    const waiting = unsent().length;
    fill(reviewBar,
      el("span", { class: "review-count", text: `${state.comments.length} review ${state.comments.length === 1 ? "comment" : "comments"}${waiting !== state.comments.length ? ` (${waiting} not sent yet)` : ""}` }),
      el("button", { type: "button", class: "btn primary", disabled: waiting === 0, title: "Put every comment not sent yet in the prompt as one numbered request; you send it", onclick: sendComments, text: `Send to coop (${waiting} ${waiting === 1 ? "comment" : "comments"})` }),
      el("button", { type: "button", class: "btn", title: "Remove every comment in this tab", onclick: () => { state.comments = []; state.anchor = null; rerender(); }, text: "Clear" }));
    if (reviewBar.parentNode !== box) box.insertBefore(reviewBar, diffBox);
  }

  // Draw again keeping the diff's scroll position.
  function rerender() {
    const top = diffBox.scrollTop;
    renderDiffView();
    diffBox.scrollTop = top;
    renderReviewBar();
  }

  function sendComments() {
    const batch = unsent();
    if (!batch.length || typeof setPrompt !== "function") return;
    setPrompt(reviewPrompt(batch));
    batch.forEach((c, i) => { c.sent = true; c.number = i + 1; c.status = ""; });
    rerender();
  }

  // After a revision the pane diffs the file again: each comment finds its place.
  function reanchorFile(path, diffText) {
    const key = fileKey(path);
    const mine = state.comments.filter((c) => c.key === key && c.diffText !== diffText);
    if (!mine.length) return;
    const model = diffModel(diffText);
    for (const c of mine) {
      const found = reanchorComment(c, model);
      Object.assign(c, { from: found.from, to: found.to, hunk: found.hunk, status: found.status, diffText });
      if (found.status !== "moved") Object.assign(c, commentContext(model, c.side, c.from, c.to));
    }
  }

  function rowFor(node, side, hunk, line) {
    const attr = side === "old" ? "data-old-line" : "data-line";
    const cell = (hunk >= 0 && node.querySelector(`[data-hunk="${hunk}"][${attr}="${line}"]`)) || node.querySelector(`[data-hunk][${attr}="${line}"]`);
    if (!cell) return null;
    return cell.classList.contains("diff-cell") ? cell.parentElement : cell;
  }

  function marker(c) {
    const waiting = unsent();
    const number = c.sent ? c.number : waiting.indexOf(c) + 1;
    const showStatus = c.status && (c.sent || c.status === "moved");
    return el("div", { class: `review-marker${showStatus ? ` ${c.status}` : ""}${c.sent ? " sent" : ""}`, role: "note", "aria-label": `Review comment ${number}` },
      el("span", { class: "review-num", text: String(number), title: c.sent ? "Sent to coop with this number" : "Its number in the next batch" }),
      el("span", { class: "review-where", text: commentWhere(c) }),
      showStatus ? el("span", { class: "chip review-status", text: COMMENT_STATUS[c.status] }) : null,
      el("span", { class: "review-note", text: c.note }),
      el("button", { type: "button", class: "btn", text: "Edit", title: "Change this comment", onclick: (event) => { event.stopPropagation(); openCommentForm(c, event.currentTarget.closest(".review-marker")); } }),
      el("button", { type: "button", class: "btn icon", title: "Delete this comment", "aria-label": "Delete this comment", onclick: (event) => { event.stopPropagation(); state.comments = state.comments.filter((x) => x !== c); rerender(); } }, icon("close")));
  }

  // Markers under their lines; a comment whose lines are not drawn here (past the
  // cut, or moved or gone) is listed at the end.
  function decorate(node) {
    const key = fileKey();
    const after = new Map();
    const loose = [];
    for (const c of state.comments.filter((x) => x.key === key)) {
      const row = rowFor(node, c.side, c.hunk, c.to);
      if (!row || c.status === "moved") { loose.push(c); continue; }
      for (let n = c.from; n <= c.to; n += 1) { const r = rowFor(node, c.side, c.hunk, n); if (r) r.classList.add("review-commented"); }
      const m = marker(c);
      (after.get(row) || row).after(m);
      after.set(row, m);
    }
    if (loose.length) node.append(el("div", { class: "review-loose" }, el("div", { class: "diff-hunk", text: "Review comments not on a line shown here" }), ...loose.map(marker)));
    renderReviewBar();
  }

  function commentClick(event) {
    if (event.target.closest(".review-marker, .review-loose")) return;
    // Selecting text to copy is not a comment; a shift-click range is.
    const selection = window.getSelection ? String(window.getSelection()) : "";
    if (selection && !event.shiftKey) return;
    if (selection && window.getSelection) window.getSelection().removeAllRanges();
    const row = event.target.closest("[data-line], [data-old-line]");
    if (!row || !diffBox.contains(row) || !state.model) return;
    const side = row.hasAttribute("data-old-line") ? "old" : "new";
    const line = Number(side === "old" ? row.getAttribute("data-old-line") : row.getAttribute("data-line"));
    const hunk = Number(row.getAttribute("data-hunk"));
    if (!canComment(state.model, side, line, state.mode)) return;
    const click = { key: fileKey(), side, hunk, line };
    const span = event.shiftKey ? extendSelection(state.anchor, click) : extendSelection(null, click);
    if (!event.shiftKey || span.from === span.to) state.anchor = click;
    openCommentForm(span, row.classList.contains("diff-cell") ? row.parentElement : row);
  }

  // The note for a new comment (`target` is a span) or an existing one (a comment).
  function openCommentForm(target, after) {
    const old = diffBox.querySelector(".fix-line");
    if (old) old.remove();
    const editing = state.comments.includes(target) ? target : null;
    const where = commentWhere(target);
    const input = el("input", { class: "field", type: "text", value: editing ? editing.note : "", placeholder: `Comment on ${where}`, "aria-label": `Comment on ${where}` });
    const save = () => {
      const note = input.value.trim();
      if (!note) { input.focus(); return; }
      form.remove();
      if (editing) { editing.note = note; if (editing.sent) { editing.sent = false; editing.status = ""; } }
      else {
        const repo = currentRepo();
        state.comments.push({
          id: state.nextComment++, key: fileKey(), repoLabel: repo ? repo.label : "",
          path: reviewPath({ rel: repo ? repo.rel || "" : "", selected: state.selected }),
          side: target.side, hunk: target.hunk, from: target.from, to: target.to,
          ...commentContext(state.model, target.side, target.from, target.to),
          note, sent: false, status: "", diffText: (state.diff && state.diff.diff) || "",
        });
      }
      rerender();
    };
    const form = el("div", { class: "fix-line review-form", role: "group", "aria-label": "Review comment" },
      input,
      el("button", { type: "button", class: "btn primary", text: editing ? "Save" : "Add comment", title: "Keep it with the others; Send to coop puts them all in the prompt", onclick: save }),
      el("button", { type: "button", class: "btn icon", title: "Cancel", "aria-label": "Cancel", onclick: () => form.remove() }, icon("close")));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); save(); }
      else if (event.key === "Escape") { event.preventDefault(); form.remove(); }
    });
    after.after(form);
    input.focus();
  }

  // Settings turned the feature on or off: the diff and the bar follow at once.
  window.addEventListener("coop:features", () => { if (state.diff) rerender(); else renderReviewBar(); });

  function step(direction) {
    if (!state.matches.length) return;
    state.active = (state.active + direction + state.matches.length) % state.matches.length;
    renderDiffView(true);
  }

  search.addEventListener("input", () => { state.query = search.value; state.active = 0; renderDiffView(true); });
  search.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? -1 : 1); } });
  modeButton.addEventListener("click", () => { state.mode = state.mode === "split" ? "unified" : "split"; renderModeButton(); renderDiffView(); });
  renderModeButton();
  load(options && options.path ? relativePath(options.path, cwd()) : "");

  return {
    show: (opts) => load(opts && opts.path ? relativePath(opts.path, cwd()) : ""),
    refresh: () => load(""),
  };
}

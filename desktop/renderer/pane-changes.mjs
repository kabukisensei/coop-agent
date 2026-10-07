// The changes panel (master plan D1b2): every file changed in the folder
// since the last commit, as a diff, unified or side by side. Read-only; the
// list and each diff come from git through the main process.
import { el, fill, icon, toast } from "./ui.mjs";
import { diffModel, renderDiff } from "./diff-view.mjs";
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

export function mountChanges(box, options, { coop, cwd }) {
  const state = { files: [], selected: "", mode: "unified", query: "", active: 0, matches: [], diff: null, loading: false, repos: [], repo: null };
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
        el("span", { class: "change-path", text: file.path }),
        file.binary ? el("span", { class: "chip", text: "binary", title: "Not a text file, so there is no diff to read" }) : file.status === "new" ? el("span", { class: "chip", text: "new", title: STATUS_TITLE.new })
          : el("span", { class: "tool-stats", title: `${file.added} ${file.added === 1 ? "line" : "lines"} added, ${file.removed} removed` }, el("span", { class: "add", text: `+${file.added}` }), el("span", { class: "del", text: `-${file.removed}` })));
      item.addEventListener("click", () => select(file.path));
      item.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(file.path); } });
      return item;
    }));
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
    const { node, matches } = renderDiff(model, { mode: state.mode, query: state.query, active: state.active });
    state.matches = matches;
    count.textContent = state.query ? (matches.length ? `${Math.min(state.active + 1, matches.length)} of ${matches.length}` : "No matches") : "";
    fill(diffBox, node);
    if (scroll) { const hit = node.querySelector(".hit.active"); if (hit) hit.scrollIntoView({ block: "center" }); }
  }

  async function select(path) {
    state.selected = path;
    state.active = 0;
    renderList();
    const file = state.files.find((f) => f.path === path);
    fill(fileHead, file ? el("code", { text: file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path }) : "");
    fill(diffBox, el("div", { class: "working" }, el("span", { class: "spinner" }), el("span", { text: "Reading the diff" })));
    const result = await coop.changeDiff(path);
    if (state.selected !== path) return;
    if (!result.success) { state.diff = { error: result.error || "Could not read the diff." }; renderDiffView(); return; }
    state.diff = result.data;
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
    if (state.loading) return;
    state.loading = true;
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
    state.loading = false;
    if (!result.success) { summary.textContent = result.error || "Could not read the changes."; return; }
    const data = result.data;
    state.repos = data.repos || [];
    if (state.repo !== data.current) state.selected = "";
    state.repo = data.current;
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

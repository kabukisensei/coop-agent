// The changes panel (master plan D1b2): every file changed in the folder
// since the last commit, as a diff, unified or side by side. Read-only; the
// list and each diff come from git through the main process.
import { el, fill, icon, toast } from "./ui.mjs";
import { diffModel, renderDiff } from "./diff-view.mjs";
import { hunkStats } from "./unified-diff.mjs";

const STATUS_LABEL = { modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C", "type changed": "T", conflicted: "U", new: "N" };

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

export function mountChanges(box, options, { coop, cwd }) {
  const state = { files: [], selected: "", mode: "unified", query: "", active: 0, matches: [], diff: null, loading: false };
  const summary = el("div", { class: "pane-summary" });
  const list = el("ul", { class: "change-list", role: "listbox", "aria-label": "Changed files" });
  const search = el("input", { class: "field", type: "search", placeholder: "Find in this diff", "aria-label": "Find in this diff" });
  const count = el("span", { class: "find-count", "aria-live": "polite" });
  const modeButton = el("button", { type: "button", class: "btn", title: "Unified or side by side" });
  const fileHead = el("div", { class: "change-head" });
  const diffBox = el("div", { class: "change-diff" });
  const toolbar = el("div", { class: "pane-toolbar" }, search, count,
    el("button", { type: "button", class: "btn icon", title: "Earlier match", "aria-label": "Earlier match", onclick: () => step(-1) }, icon("up")),
    el("button", { type: "button", class: "btn icon", title: "Later match", "aria-label": "Later match", onclick: () => step(1) }, icon("down")),
    modeButton);
  box.append(summary, list, fileHead, toolbar, diffBox);

  function renderModeButton() {
    modeButton.textContent = state.mode === "split" ? "Unified" : "Side by side";
  }

  function renderList() {
    fill(list, ...state.files.map((file) => {
      const item = el("li", { class: `change-file${file.path === state.selected ? " active" : ""}`, role: "option", "aria-selected": file.path === state.selected ? "true" : "false", tabindex: "0", title: file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path },
        el("span", { class: `change-status ${file.status.replace(/\s+/g, "-")}`, text: STATUS_LABEL[file.status] || "M", title: file.status }),
        el("span", { class: "change-path", text: file.path }),
        file.binary ? el("span", { class: "chip", text: "binary" }) : file.status === "new" ? el("span", { class: "chip", text: "new" })
          : el("span", { class: "tool-stats" }, el("span", { class: "add", text: `+${file.added}` }), el("span", { class: "del", text: `-${file.removed}` })));
      item.addEventListener("click", () => select(file.path));
      item.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(file.path); } });
      return item;
    }));
  }

  function renderDiffView(scroll = false) {
    if (!state.diff) { fill(diffBox); count.textContent = ""; return; }
    const result = state.diff;
    if (result.binary || result.tooLarge || result.gone || result.error) {
      const text = result.error || (result.gone ? "This file is gone." : result.tooLarge ? "This change is too large to show here." : "Binary file: no text diff.");
      fill(diffBox, el("p", { class: "pane-empty", text }));
      count.textContent = "";
      return;
    }
    const model = diffModel(result.diff);
    if (!model.hunks.length) { fill(diffBox, el("p", { class: "pane-empty", text: "No line changes (a rename or a mode change)." })); count.textContent = ""; return; }
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

  async function load(want) {
    if (state.loading) return;
    state.loading = true;
    fill(summary, el("span", { class: "spinner" }), el("span", { text: " Reading changes" }));
    const result = await coop.changes();
    state.loading = false;
    if (!result.success) { summary.textContent = result.error || "Could not read the changes."; return; }
    const data = result.data;
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
    if (want && target !== want) toast(`${want} has no changes since the last commit.`, "info");
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
  load(options && options.path ? normalizePath(options.path, cwd()) : "");

  return {
    show: (opts) => load(opts && opts.path ? normalizePath(opts.path, cwd()) : ""),
    refresh: () => load(""),
  };
}

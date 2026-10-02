// The pane beside the timeline (master plan D1b2): one column on the right
// that shows one view at a time (changes, standards, the project form, the
// docs setup form), opened from the timeline or from a menu. Each view is
// mounted once and kept while the window lives, so switching keeps its state.
import { el, icon } from "./ui.mjs";
import { makeResizer, paneMaxWidth } from "./resize.mjs";

const $ = (id) => document.getElementById(id);

const views = new Map();
const mounted = new Map();
let current = "";
let onOpen = () => {};

// What each tab shows, for its tooltip: the label alone is one word.
const TAB_HELP = {
  changes: "Files changed since the last commit",
  standards: "The standards coop applies in this folder",
  project: "Project settings (.coop/project.yml)",
  docs: "Lineage docs for this folder (coop-data-doc)",
};

/**
 * Register a view: { id, label, icon, description, mount(container, options) }
 * where mount returns { show(options), refresh(), unmount() } (each optional)
 * and description, when given, is the tab's tooltip.
 */
export function registerPane(view) {
  views.set(view.id, view);
}

export function paneViews() {
  return [...views.values()];
}

export function currentPane() {
  return current;
}

function renderTabs() {
  $("paneTabs").replaceChildren(...paneViews().map((view) => el("button", {
    type: "button",
    class: `pane-tab${view.id === current ? " active" : ""}`,
    role: "tab",
    "aria-selected": view.id === current ? "true" : "false",
    title: view.description || TAB_HELP[view.id] || view.label,
    onclick: () => openPane(view.id),
  }, icon(view.icon), el("span", { text: view.label }))));
}

/** Show a view, mounting it the first time; options go to its show(). */
export function openPane(id, options = {}) {
  const view = views.get(id);
  if (!view) return;
  const pane = $("pane");
  pane.hidden = false;
  document.body.classList.add("with-pane");
  current = id;
  let instance = mounted.get(id);
  if (!instance) {
    const box = el("div", { class: `pane-view pane-${id}`, dataset: { view: id } });
    $("paneBody").append(box);
    instance = { box, api: view.mount(box, options) || {} };
    mounted.set(id, instance);
  } else if (instance.api.show) {
    instance.api.show(options);
  }
  for (const [other, { box }] of mounted) box.hidden = other !== id;
  renderTabs();
  onOpen(id);
}

export function closePane() {
  $("pane").hidden = true;
  document.body.classList.remove("with-pane");
  current = "";
}

export function togglePane(fallback) {
  if (current) closePane();
  else openPane(fallback || "changes");
}

export function refreshPane() {
  const instance = mounted.get(current);
  if (instance && instance.api.refresh) instance.api.refresh();
}

const sidebarWidth = () => (document.body.classList.contains("no-sidebar") ? 0 : document.querySelector(".sidebar").getBoundingClientRect().width);

export function initPanes(options = {}) {
  if (options.onOpen) onOpen = options.onOpen;
  const resizer = makeResizer({
    handle: $("paneResize"),
    key: "coop.paneWidth",
    cssVar: "--pane-width",
    min: 320,
    max: () => paneMaxWidth(window.innerWidth, sidebarWidth()),
    measure: () => $("pane").getBoundingClientRect().width,
    // The handle is on the pane's left edge: dragging left widens it.
    fromPointer: (event, start) => start.size + (start.x - event.clientX),
    keys: { grow: "ArrowLeft", shrink: "ArrowRight" },
  });
  window.addEventListener("resize", () => resizer.apply());
  $("paneClose").addEventListener("click", closePane);
  $("paneRefresh").addEventListener("click", refreshPane);
  // Web links in a pane's Markdown open in the browser, never in the window.
  $("paneBody").addEventListener("click", (event) => {
    const link = event.target.closest("a.md-link");
    if (link) { event.preventDefault(); window.coop.openExternal(link.dataset.href); }
  });
}

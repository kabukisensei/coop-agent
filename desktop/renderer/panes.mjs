// The pane beside the timeline (master plan D1b2): one column on the right
// that shows one view at a time (changes, standards, the project form, the
// docs setup form), opened from the timeline or from a menu. Each view is
// mounted once and kept while the window lives, so switching keeps its state.
import { el, icon } from "./ui.mjs";

const $ = (id) => document.getElementById(id);
const WIDTH_KEY = "coop.paneWidth";
const MIN_WIDTH = 320;

const views = new Map();
const mounted = new Map();
let current = "";
let onOpen = () => {};

function storedWidth() {
  try { return Number(window.localStorage.getItem(WIDTH_KEY)) || 0; } catch { return 0; }
}

function setWidth(px) {
  const max = Math.max(MIN_WIDTH, Math.floor(window.innerWidth * 0.7));
  const width = Math.max(MIN_WIDTH, Math.min(max, Math.round(px)));
  document.documentElement.style.setProperty("--pane-width", `${width}px`);
  try { window.localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* storage off */ }
}

/**
 * Register a view: { id, label, icon, mount(container, options) } where mount
 * returns { show(options), refresh(), unmount() } (each optional).
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
    title: view.label,
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

function wireResize() {
  const handle = $("paneResize");
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const move = (e) => setWidth(window.innerWidth - e.clientX);
    const up = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
  handle.addEventListener("keydown", (event) => {
    const now = $("pane").getBoundingClientRect().width;
    if (event.key === "ArrowLeft") { event.preventDefault(); setWidth(now + 32); }
    if (event.key === "ArrowRight") { event.preventDefault(); setWidth(now - 32); }
  });
}

export function initPanes(options = {}) {
  if (options.onOpen) onOpen = options.onOpen;
  const width = storedWidth();
  if (width) setWidth(width);
  $("paneClose").addEventListener("click", closePane);
  $("paneRefresh").addEventListener("click", refreshPane);
  // Web links in a pane's Markdown open in the browser, never in the window.
  $("paneBody").addEventListener("click", (event) => {
    const link = event.target.closest("a.md-link");
    if (link) { event.preventDefault(); window.coop.openExternal(link.dataset.href); }
  });
  wireResize();
}

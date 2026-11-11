// The tab strip (several sessions at once): the coop window's own page, above
// the tab in front. Each tab is a session page with its own coop; the main
// process owns the tabs (main.mjs addTab/closeTab) and this page only draws
// them: the name, a dot while coop works, a mark while it waits on a question.
// A tab can be dragged along the strip to a new place (the main process keeps
// the order, so Ctrl+1..9 follow it); Ctrl+Shift+PageUp/PageDown move it too.
const coop = window.coop;
const $ = (id) => document.getElementById(id);
let canAdd = true;
/** The tab being dragged (its id) and where it would land, while a drag is on. */
let drag = null;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.filter(Boolean));
  return node;
}

function applyTheme({ theme, systemDark }) {
  const resolved = theme === "auto" ? (systemDark ? "modern-dark" : "modern-light") : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.style = resolved.startsWith("retro") ? "retro" : "modern";
}

function state(tab) {
  if (tab.asking) return el("span", { class: "tab-mark asking", title: "coop is asking you something", text: "?" });
  if (tab.working) return el("span", { class: "tab-mark working", title: "coop is working" });
  return null;
}

/** The index a tab dropped at `clientX` takes: before the first tab whose middle is right of the pointer. */
export function dropIndex(middles, clientX) {
  const at = middles.findIndex((middle) => clientX < middle);
  return at < 0 ? middles.length : at;
}

function clearDropMarks() {
  for (const node of $("tabList").querySelectorAll(".drop-before, .drop-after")) node.classList.remove("drop-before", "drop-after");
}

/** Show where the dragged tab would land: a line before the tab at `index`, or after the last one. */
function markDrop(index) {
  clearDropMarks();
  const items = [...$("tabList").children];
  if (!items.length) return;
  if (index >= items.length) items[items.length - 1].classList.add("drop-after");
  else items[index].classList.add("drop-before");
}

function onDragOver(event) {
  if (!drag) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const items = [...$("tabList").children];
  const index = dropIndex(items.map((item) => { const box = item.getBoundingClientRect(); return box.left + box.width / 2; }), event.clientX);
  if (index !== drag.index) { drag.index = index; markDrop(index); }
}

function onDrop(event) {
  if (!drag) return;
  event.preventDefault();
  const items = [...$("tabList").children];
  const from = items.findIndex((item) => item.dataset.tabId === String(drag.id));
  // Dropping after a tab to the right of the one dragged moves it one less, as the dragged tab leaves its slot.
  const to = drag.index > from ? drag.index - 1 : drag.index;
  const { id } = drag;
  endDrag();
  if (from >= 0 && to !== from) coop.stripMove(id, to);
}

function endDrag() {
  drag = null;
  clearDropMarks();
  for (const node of $("tabList").querySelectorAll(".dragging")) node.classList.remove("dragging");
}

function render(tabs) {
  if (drag && !tabs.some((tab) => tab.id === drag.id)) endDrag();
  $("tabList").replaceChildren(...tabs.map((tab) => {
    const close = el("button", { type: "button", class: "tab-close", title: "Close this tab (Ctrl+W)", "aria-label": `Close ${tab.label}`, tabindex: "-1" }, el("span", { "aria-hidden": "true", text: "×" }));
    close.addEventListener("click", (event) => { event.stopPropagation(); coop.stripClose(tab.id); });
    const item = el("li", { class: `tab${tab.active ? " active" : ""}${tab.asking ? " asking" : ""}${drag && drag.id === tab.id ? " dragging" : ""}`, role: "tab", "aria-selected": tab.active ? "true" : "false", tabindex: tab.active ? "0" : "-1", title: `${tab.label}\nDrag to move this tab (Ctrl+Shift+PageUp/PageDown)`, draggable: "true", "data-tab-id": String(tab.id) },
      state(tab), el("span", { class: "tab-label", text: tab.label }), close);
    item.addEventListener("click", () => coop.stripSelect(tab.id));
    item.addEventListener("dragstart", (event) => {
      drag = { id: tab.id, index: -1 };
      item.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      // Text, so a drop outside the strip pastes nothing surprising; the id travels in `drag`.
      event.dataTransfer.setData("text/plain", tab.label);
    });
    item.addEventListener("dragend", endDrag);
    // Middle click closes, as in a browser.
    item.addEventListener("auxclick", (event) => { if (event.button === 1) coop.stripClose(tab.id); });
    item.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); coop.stripSelect(tab.id); } });
    return item;
  }));
  $("newTab").disabled = !canAdd;
}

function update(data) {
  if (!data) return;
  canAdd = data.canAdd !== false;
  render(Array.isArray(data.tabs) ? data.tabs : []);
}

$("newTab").addEventListener("click", () => coop.stripNew());
$("tabList").addEventListener("dragover", onDragOver);
$("tabList").addEventListener("drop", onDrop);
// A drop on the strip's empty space, after the last tab, counts too.
document.querySelector(".tab-strip").addEventListener("dragover", onDragOver);
document.querySelector(".tab-strip").addEventListener("drop", onDrop);
document.addEventListener("dragleave", (event) => { if (drag && !event.relatedTarget) clearDropMarks(); });
coop.onTheme(applyTheme);
coop.onTabs(update);
coop.stripReady().then((data) => { if (data) { applyTheme(data); update(data); } });

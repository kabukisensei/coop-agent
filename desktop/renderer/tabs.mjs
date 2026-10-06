// The tab strip (several sessions at once): the coop window's own page, above
// the tab in front. Each tab is a session page with its own coop; the main
// process owns the tabs (main.mjs addTab/closeTab) and this page only draws
// them: the name, a dot while coop works, a mark while it waits on a question.
const coop = window.coop;
const $ = (id) => document.getElementById(id);
let canAdd = true;

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

function render(tabs) {
  $("tabList").replaceChildren(...tabs.map((tab) => {
    const close = el("button", { type: "button", class: "tab-close", title: "Close this tab (Ctrl+W)", "aria-label": `Close ${tab.label}`, tabindex: "-1" }, el("span", { "aria-hidden": "true", text: "×" }));
    close.addEventListener("click", (event) => { event.stopPropagation(); coop.stripClose(tab.id); });
    const item = el("li", { class: `tab${tab.active ? " active" : ""}${tab.asking ? " asking" : ""}`, role: "tab", "aria-selected": tab.active ? "true" : "false", tabindex: tab.active ? "0" : "-1", title: tab.label },
      state(tab), el("span", { class: "tab-label", text: tab.label }), close);
    item.addEventListener("click", () => coop.stripSelect(tab.id));
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
coop.onTheme(applyTheme);
coop.onTabs(update);
coop.stripReady().then((data) => { if (data) { applyTheme(data); update(data); } });

// The project picker page (master plan D1m): the folders opened before, each
// with the client its project file names, the branch and whether the team's
// copy of the file is in step; Browse for a new one; "open this one next time"
// so the icon opens straight on the last project. The main process owns the
// list and the choice (coop:picker-* in main.mjs); this page only draws it.
const coop = window.coop;
const $ = (id) => document.getElementById(id);
let entries = [];
let selected = "";

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

function select(path) {
  selected = path;
  for (const row of document.querySelectorAll(".project")) row.classList.toggle("selected", row.dataset.path === path);
  $("open").disabled = !path;
}

function row(entry) {
  const title = entry.client ? `${entry.client}` : entry.name;
  const where = entry.client ? `${entry.name}${entry.home ? ` · project file in ${entry.root.split(/[\\/]/).pop()}` : ""}` : "no project file yet: /setup-project creates one";
  const chips = [];
  if (entry.branch) chips.push(el("span", { class: "chip branch", text: entry.branch }));
  if (entry.team) chips.push(el("span", { class: "chip warn", text: entry.team }));
  const forget = el("button", { type: "button", class: "btn icon project-forget", title: "Forget this folder", "aria-label": `Forget ${entry.name}` }, el("span", { "aria-hidden": "true", text: "×" }));
  forget.addEventListener("click", async (event) => {
    event.stopPropagation();
    await coop.pickerForget(entry.path);
    await load();
  });
  const item = el("li", { class: "project", "data-path": entry.path, tabindex: "0", role: "option", title: entry.path },
    el("div", { class: "project-main" }, el("span", { class: "project-title", text: title }), el("span", { class: "project-where", text: where })),
    el("div", { class: "project-side" }, ...chips, forget));
  item.addEventListener("click", () => select(entry.path));
  item.addEventListener("dblclick", () => open(entry.path));
  item.addEventListener("keydown", (event) => { if (event.key === "Enter") open(entry.path); });
  return item;
}

async function load() {
  const result = await coop.pickerList();
  if (!result || !result.success) return;
  entries = result.data.entries || [];
  $("projectList").replaceChildren(...entries.map(row));
  $("pickerEmpty").hidden = entries.length > 0;
  $("openNextTime").checked = Boolean(result.data.openNextTime);
  const current = entries.find((entry) => entry.path === result.data.openNextTime) || entries[0];
  select(current ? current.path : "");
}

async function open(path) {
  if (!path) return;
  $("open").disabled = true;
  await coop.pickerOpen(path, $("openNextTime").checked);
}

$("open").addEventListener("click", () => open(selected));
$("cancel").addEventListener("click", () => coop.pickerCancel());
$("browse").addEventListener("click", async () => {
  const result = await coop.pickerBrowse();
  if (result && result.success && result.data) {
    await load();
    select(result.data);
  }
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape") coop.pickerCancel(); });

coop.onTheme((theme) => applyTheme(theme));
coop.pickerTheme().then((result) => { if (result && result.success) applyTheme(result.data); });
load();

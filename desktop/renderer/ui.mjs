// Small DOM helpers shared by the window: elements, icons, modals, toasts,
// pickers. Text always goes in through textContent.

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== "string") node[key] = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// 16x16 line icons; colour comes from CSS (currentColor).
const ICONS = {
  plus: "M8 3v10M3 8h10",
  menu: "M2.5 4h11M2.5 8h11M2.5 12h11",
  more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  terminal: "M2.5 3.5h11v9h-11zM4.5 6l2 2-2 2M8 10h3.5",
  folder: "M2 4.5h4l1.2 1.5H14v6.5H2z",
  stop: "M4.5 4.5h7v7h-7z",
  send: "M3 8h9M8.5 4.5 12 8l-3.5 3.5",
  copy: "M5.5 5.5h7v8h-7zM3.5 10.5v-8h7",
  check: "M3 8.5 6.5 12 13 4.5",
  close: "M4 4l8 8M12 4l-8 8",
  chevron: "M6 4l4 4-4 4",
  spark: "M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2",
  shield: "M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z",
  book: "M3 3h4.5A1.5 1.5 0 0 1 9 4.5V13a1.5 1.5 0 0 0-1.5-1.5H3zM13 3H10.5A1.5 1.5 0 0 0 9 4.5V13a1.5 1.5 0 0 1 1.5-1.5H13z",
  restart: "M3 8a5 5 0 1 0 1.5-3.5M3 2.5V5h2.5",
  warn: "M8 2.5 14 13H2zM8 6.5v3M8 11.2h.01",
};

export function icon(name, label) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", `icon icon-${name}`);
  svg.setAttribute("aria-hidden", label ? "false" : "true");
  if (label) svg.setAttribute("aria-label", label);
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICONS[name] || ICONS.more);
  svg.append(path);
  return svg;
}

// --- Modals -------------------------------------------------------------------

const layer = () => document.getElementById("modalLayer");
const stack = [];

/**
 * Open a modal window. Returns { close, root }. onCancel runs on Esc or the
 * close button; buttons: [{ label, kind, onClick }] (onClick returning false
 * keeps it open).
 */
export function openModal({ title, body, buttons = [], onCancel, wide = false, className = "" }) {
  const root = layer();
  const previous = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    box.remove();
    stack.splice(stack.indexOf(entry), 1);
    root.hidden = stack.length === 0;
    if (previous && typeof previous.focus === "function" && document.contains(previous)) previous.focus();
  };
  const cancel = () => { if (onCancel) onCancel(); close(); };
  const footer = buttons.length ? el("div", { class: "modal-buttons" }, buttons.map((button) => el("button", {
    type: "button",
    class: `btn ${button.kind || ""}`,
    text: button.label,
    onclick: () => { if (button.onClick && button.onClick() === false) return; close(); },
  }))) : null;
  const box = el("div", { class: `modal ${wide ? "wide" : ""} ${className}`, role: "dialog", "aria-modal": "true", "aria-label": title || "coop" },
    el("div", { class: "modal-title" },
      el("span", { class: "modal-title-text", text: title || "coop" }),
      el("button", { type: "button", class: "btn icon title-close", title: "Close (Esc)", onclick: cancel }, icon("close", "Close"))),
    el("div", { class: "modal-body" }, body),
    footer);
  box.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
    if (event.key === "Tab") trapFocus(box, event);
  });
  const entry = { box, cancel };
  stack.push(entry);
  root.append(box);
  root.hidden = false;
  requestAnimationFrame(() => {
    const target = ["[autofocus]", "input, textarea, select", ".option", ".modal-buttons .btn.primary", ".modal-buttons .btn", ".btn"].map((selector) => box.querySelector(selector)).find(Boolean);
    if (target) target.focus();
  });
  return { close, cancel, root: box };
}

export function modalOpen() {
  return stack.length > 0;
}

function trapFocus(box, event) {
  const items = [...box.querySelectorAll("button, input, textarea, select, [tabindex='0']")].filter((node) => !node.disabled && node.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

/**
 * A filterable list (model picker, sessions, palette, extension selects).
 * items: [{ label, detail, value, hint }]. Resolves with the value or undefined.
 */
export function pickFrom({ title, items, placeholder = "Type to filter", filter = true, message = "", current }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    const input = filter ? el("input", { class: "field", type: "text", placeholder, autofocus: true, "aria-label": placeholder }) : null;
    const list = el("ul", { class: "pick-list", role: "listbox" });
    let shown = items;
    let active = Math.max(0, items.findIndex((item) => item.value === current));
    const render = () => {
      list.replaceChildren(...shown.map((item, index) => el("li", {
        class: `option ${index === active ? "active" : ""} ${item.value === current ? "current" : ""}`,
        role: "option",
        tabindex: filter ? "-1" : "0",
        "aria-selected": index === active ? "true" : "false",
        onclick: () => { finish(item.value); modal.close(); },
        onmousemove: () => { if (active !== index) { active = index; render(); } },
      }, el("span", { class: "option-label", text: item.label }), item.detail ? el("span", { class: "option-detail", text: item.detail }) : null, item.hint ? el("span", { class: "option-hint", text: item.hint }) : null)));
      const node = list.children[active];
      if (node) node.scrollIntoView({ block: "nearest" });
    };
    const onKey = (event) => {
      if (event.key === "ArrowDown") { event.preventDefault(); active = Math.min(shown.length - 1, active + 1); render(); }
      else if (event.key === "ArrowUp") { event.preventDefault(); active = Math.max(0, active - 1); render(); }
      else if (event.key === "PageDown") { event.preventDefault(); active = Math.min(shown.length - 1, active + 8); render(); }
      else if (event.key === "PageUp") { event.preventDefault(); active = Math.max(0, active - 8); render(); }
      else if (event.key === "Enter") { event.preventDefault(); if (shown[active]) { finish(shown[active].value); modal.close(); } }
    };
    if (input) {
      input.addEventListener("input", () => {
        const q = input.value.trim().toLowerCase();
        shown = q ? items.filter((item) => `${item.label} ${item.detail || ""} ${item.hint || ""}`.toLowerCase().includes(q)) : items;
        active = 0;
        render();
      });
      input.addEventListener("keydown", onKey);
    }
    list.addEventListener("keydown", onKey);
    const body = el("div", { class: "picker" }, message ? el("p", { class: "dialog-message", text: message }) : null, input, list);
    const modal = openModal({ title, body, onCancel: () => finish(undefined), wide: true });
    render();
    if (!filter) requestAnimationFrame(() => { const node = list.children[active]; if (node) node.focus(); });
  });
}

// --- Toasts -------------------------------------------------------------------

export function toast(message, level = "info", { timeout } = {}) {
  const host = document.getElementById("toasts");
  const node = el("div", { class: `toast ${level}`, role: level === "error" ? "alert" : "status" },
    el("span", { class: "toast-text", text: String(message) }),
    el("button", { type: "button", class: "btn icon", title: "Dismiss", onclick: () => node.remove() }, icon("close", "Dismiss")));
  host.append(node);
  while (host.children.length > 5) host.firstElementChild.remove();
  const ms = timeout !== undefined ? timeout : level === "error" ? 0 : level === "warning" ? 12000 : 6000;
  if (ms > 0) setTimeout(() => node.remove(), ms);
  return node;
}

export function relativeTime(ms) {
  const diff = Date.now() - ms;
  if (!Number.isFinite(diff)) return "";
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(ms).toLocaleDateString();
}

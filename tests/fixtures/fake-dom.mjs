// A small live DOM for running renderer code (desktop/renderer/*.mjs) in node:
// elements with attributes, classes, children, events and the simple selectors
// the panes use (tag, .class, [attr], [attr="value"], comma lists; no
// combinators). Not the ED1 golden's serializer: that one lives in
// diff-render-cases.mjs and is left as it is.
//
// installLiveDom() sets globalThis.document / window / Node and returns
// { document, window, click, fire, settle }.

class ClassList {
  constructor(el) { this.el = el; }
  get items() { return (this.el.getAttribute("class") || "").split(/\s+/).filter(Boolean); }
  set items(list) { this.el.setAttribute("class", list.join(" ")); }
  contains(name) { return this.items.includes(name); }
  add(...names) { this.items = [...new Set([...this.items, ...names])]; }
  remove(...names) { this.items = this.items.filter((n) => !names.includes(n)); }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : Boolean(force);
    if (on) this.add(name); else this.remove(name);
    return on;
  }
}

function parseCompound(text) {
  const out = { tag: "", classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/gy;
  let m;
  let at = 0;
  re.lastIndex = 0;
  while (at < text.length && (m = re.exec(text))) {
    if (m[1]) out.tag = m[1].toLowerCase();
    else if (m[2]) out.classes.push(m[2]);
    else out.attrs.push([m[3], m[4]]);
    at = re.lastIndex;
  }
  if (at !== text.length) throw new Error(`fake DOM: unsupported selector '${text}'`);
  return out;
}

function matches(el, selector) {
  if (!(el instanceof FakeElement)) return false;
  return selector.split(",").map((s) => s.trim()).filter(Boolean).some((one) => {
    const c = parseCompound(one);
    if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
    if (c.classes.some((k) => !el.classList.contains(k))) return false;
    return c.attrs.every(([k, v]) => el.hasAttribute(k) && (v === undefined || el.getAttribute(k) === v));
  });
}

export class FakeNode {
  constructor() { this.parentNode = null; this.childNodes = []; }
  get parentElement() { return this.parentNode instanceof FakeElement ? this.parentNode : null; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); if (value !== "" && value !== null && value !== undefined) this.append(new FakeText(String(value))); }
  _detach(node) {
    if (node.parentNode) {
      const list = node.parentNode.childNodes;
      const i = list.indexOf(node);
      if (i >= 0) list.splice(i, 1);
    }
    node.parentNode = null;
  }
  append(...nodes) {
    for (const raw of nodes) {
      const n = typeof raw === "string" ? new FakeText(raw) : raw;
      this._detach(n);
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }
  prepend(...nodes) { const first = this.childNodes[0]; for (const n of nodes) { if (first) this.insertBefore(n, first); else this.append(n); } }
  insertBefore(node, ref) {
    if (!ref) { this.append(node); return node; }
    this._detach(node);
    const i = this.childNodes.indexOf(ref);
    node.parentNode = this;
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, node);
    return node;
  }
  removeChild(node) { this._detach(node); return node; }
  replaceChildren(...nodes) {
    for (const c of [...this.childNodes]) this._detach(c);
    this.append(...nodes);
  }
  remove() { if (this.parentNode) this._detach(this); }
  after(...nodes) {
    const parent = this.parentNode;
    if (!parent) return;
    let ref = this;
    for (const n of nodes) {
      const i = parent.childNodes.indexOf(ref);
      const next = parent.childNodes[i + 1] || null;
      parent.insertBefore(n, next);
      ref = n;
    }
  }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
}

export class FakeText extends FakeNode {
  constructor(text) { super(); this.data = text; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

export class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.attrs = new Map();
    this.listeners = new Map();
    this.classList = new ClassList(this);
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this._value = undefined;
    this.disabled = false;
    this.checked = false;
    this.hidden = false;
    this.scrollTop = 0;
    this.clientHeight = 0;
    this.focused = false;
  }
  get className() { return this.getAttribute("class") || ""; }
  set className(v) { this.setAttribute("class", v); }
  // Like a browser: an input's value is its value attribute until it is set.
  get value() { return this._value !== undefined ? this._value : this.getAttribute("value") || ""; }
  set value(v) { this._value = String(v); }
  get children() { return this.childNodes.filter((c) => c instanceof FakeElement); }
  get firstElementChild() { return this.children[0] || null; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); if (k.startsWith("data-")) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  removeEventListener(type, fn) { const l = this.listeners.get(type) || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
  /** Every element below this one, depth first. */
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelectorAll(selector) { return this.all().filter((e) => matches(e, selector)); }
  querySelector(selector) { return this.all().find((e) => matches(e, selector)) || null; }
  matches(selector) { return matches(this, selector); }
  closest(selector) { for (let n = this; n instanceof FakeElement; n = n.parentNode) if (matches(n, selector)) return n; return null; }
  focus() { this.focused = true; }
  blur() { this.focused = false; }
  scrollIntoView() {}
  setSelectionRange() {}
  setPointerCapture() {}
  getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; }
  dispatchEvent(event) {
    // Bubble from this element up, like a real click.
    event.target = event.target || this;
    for (let n = this; n; n = n.parentNode) {
      if (event.stopped) break;
      event.currentTarget = n;
      for (const fn of [...((n.listeners && n.listeners.get(event.type)) || [])]) fn(event);
    }
    return !event.defaultPrevented;
  }
}

export function makeEvent(type, props = {}) {
  return {
    type, shiftKey: false, key: "", button: 0, defaultPrevented: false, stopped: false, ...props,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
  };
}

export function installLiveDom() {
  const body = new FakeElement("body");
  const toasts = new FakeElement("div");
  toasts.setAttribute("id", "toasts");
  body.append(toasts);
  const listeners = new Map();
  const document = {
    body,
    documentElement: new FakeElement("html"),
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: (text) => new FakeText(String(text)),
    getElementById: (id) => (id === "toasts" ? toasts : body.querySelector(`[id="${id}"]`)),
  };
  const store = new Map();
  const window = {
    selection: "",
    getSelection() { const self = this; return { toString: () => self.selection, removeAllRanges: () => { self.selection = ""; } }; },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    removeEventListener(type, fn) { const l = listeners.get(type) || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
    dispatchEvent(event) { for (const fn of [...(listeners.get(event.type) || [])]) fn(event); return true; },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    innerHeight: 800,
  };
  class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }
  Object.assign(globalThis, { document, window, Node: FakeNode, CustomEvent });
  const fire = (el, type, props = {}) => el.dispatchEvent(makeEvent(type, { target: el, ...props }));
  const click = (el, props = {}) => fire(el, "click", props);
  // Let the pane's awaits (fake IPC answers) run.
  const settle = async (rounds = 20) => { for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r)); };
  return { document, window, body, fire, click, settle, toasts };
}

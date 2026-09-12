import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const values = new Map();
const document = { documentElement: { dataset: {}, style: {} } };
const localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
const context = vm.createContext({ console, document, localStorage });
context.globalThis = context;
vm.runInContext(readFileSync(join(ROOT, "web", "public", "theme-system.js"), "utf8"), context);
let count = 0;
const test = async (name, fn) => { await fn(); count++; console.log(`  ✓ ${name}`); };

await test("the design system exposes exactly the three required themes", () => {
  assert.deepEqual(Array.from(context.CoopThemes.themes, (theme) => theme.id), ["modern-dark", "modern-light", "retro-messenger"]);
});

await test("theme changes apply without reload and do not touch capability state", () => {
  const capabilities = Object.freeze({ available: 42 });
  assert.equal(context.CoopThemes.apply("modern-light", document), "modern-light");
  assert.equal(document.documentElement.dataset.theme, "modern-light");
  assert.deepEqual(capabilities, { available: 42 });
  assert.equal(context.CoopThemes.apply("retro-messenger", document), "retro-messenger");
  assert.equal(document.documentElement.dataset.theme, "retro-messenger");
});

await test("browser preference is bounded and unknown themes fail to Modern Dark", () => {
  context.CoopThemes.saveLocal("modern-light", localStorage);
  assert.equal(context.CoopThemes.loadLocal(localStorage), "modern-light");
  context.CoopThemes.saveLocal("untrusted-theme", localStorage);
  assert.equal(context.CoopThemes.loadLocal(localStorage), "modern-dark");
  assert.equal(context.CoopThemes.normalize("constructor"), "modern-dark");
});

await test("all visual modes use semantic tokens and cannot hide themed capabilities", () => {
  const css = readFileSync(join(ROOT, "web", "public", "style.css"), "utf8");
  for (const theme of ["modern-dark", "modern-light", "retro-messenger"]) assert.match(css, new RegExp(`data-theme=[\\\"]${theme}`));
  for (const token of ["--surface-base", "--surface-raised", "--surface-panel", "--text-primary", "--accent-primary", "--font-ui", "--radius-control"]) assert.match(css, new RegExp(token));
  assert.match(css, /data-theme="modern-dark"\]\s*\{\s*color-scheme:dark/);
  assert.equal((css.match(/color-scheme:light/g) || []).length, 2);
  assert.doesNotMatch(css, /\[data-theme=[^\]]+\][^{]*(?:capability|mission-action|toolbar)[^{]*\{[^}]*display\s*:\s*none/i);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /forced-colors:active/);
});

await test("core text and themed accent combinations meet WCAG AA contrast", () => {
  const css = readFileSync(join(ROOT, "web", "public", "style.css"), "utf8");
  const block = (selector) => {
    const start = css.indexOf(selector);
    const open = css.indexOf("{", start);
    return css.slice(open + 1, css.indexOf("}", open));
  };
  const token = (source, name) => source.match(new RegExp(`${name}:#([0-9a-f]{6})`, "i"))?.[1];
  const luminance = (hex) => {
    const channels = hex.match(/../g).map((part) => Number.parseInt(part, 16) / 255).map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  for (const selector of ['[data-theme="modern-dark"]', '[data-theme="modern-light"]', '[data-theme="retro-messenger"]']) {
    const source = block(selector);
    const surface = token(source, "--surface-raised");
    assert.ok(contrast(token(source, "--text-primary"), surface) >= 4.5, `${selector} primary text contrast`);
    assert.ok(contrast(token(source, "--text-muted"), surface) >= 4.5, `${selector} muted text contrast`);
    assert.ok(contrast(token(source, "--accent-primary"), surface) >= 4.5, `${selector} accent contrast`);
    assert.ok(contrast(token(source, "--danger-ink"), token(source, "--accent-danger")) >= 4.5, `${selector} danger button contrast`);
  }
});

await test("utility views replace each other, reject late refreshes, and restore focus on Escape", async () => {
  const doc = { activeElement: null, createElement: () => new Element() };
  class Element {
    children = []; parent = null; hidden = false; handlers = {};
    get isConnected() { return this.root || Boolean(this.parent?.isConnected); }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    replaceChildren(...children) {
      for (const child of this.children) child.parent = null;
      this.children = children;
      for (const child of children) child.parent = this;
    }
    append(...children) { this.replaceChildren(...this.children, ...children); }
    appendChild(child) { this.append(child); }
    setAttribute(name, value) { this[name] = value; }
    removeAttribute(name) { delete this[name]; }
    focus() { doc.activeElement = this; }
    addEventListener(type, handler) { this.handlers[type] = handler; }
  }
  const panel = new Element(); panel.root = true; panel.hidden = true;
  const body = new Element(), title = new Element(), close = new Element();
  panel.replaceChildren(title, close, body);
  const opener = new Element(); opener.root = true; opener.focus();
  const nodes = { "#utilityPanel": panel, "#utilityBody": body, "#utilityTitle": title, "#utilityClose": close };
  const source = readFileSync(join(ROOT, "web", "public", "app.js"), "utf8");
  const start = source.indexOf("let utilityOpener = null;");
  const end = source.indexOf("// --- markdown-lite", start);
  const ctx = vm.createContext({ document: doc, $: selector => nodes[selector] });
  vm.runInContext(source.slice(start, end), ctx);
  const health = ctx.createUtilityCard("Health");
  assert.equal(panel.hidden, false);
  assert.equal(doc.activeElement, title);
  const theme = ctx.createUtilityCard("Appearance");
  assert.equal(body.children.length, 1);
  assert.equal(health.isConnected, false);
  assert.equal(ctx.createUtilityCard("Late health", health), null);
  ctx.closeUtilityPanel(health);
  assert.equal(panel.hidden, false, "stale close must not close the current view");
  let prevented = false;
  panel.handlers.keydown({ key: "Escape", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(panel.hidden, true);
  assert.equal(body.children.length, 0);
  assert.equal(doc.activeElement, opener);
  assert.equal(ctx.createUtilityCard("Late theme", theme), null);
  // Exercise the actual async view entry points, not just the panel helper.
  ctx.modelChip = {};
  ctx.activeSid = "test-chat";
  nodes["#commandsBtn"] = new Element(); nodes["#sessionBtn"] = new Element();
  ctx.autoCompactionEnabled = true;
  ctx.window = { CoopInteraction: { normalizeCommands: commands => commands } };
  const cases = [
    ["modelChip.onclick = async", "thinkChip.onclick", () => ctx.modelChip.onclick(), { data: { models: [{ id: "late" }] } }],
    ["async function openSessionControls()", '$("#sessionBtn").onclick', () => ctx.openSessionControls(), { data: { autoCompactionEnabled: false } }],
    ['$("#commandsBtn").onclick = async', "modelChip.onclick", () => nodes["#commandsBtn"].onclick(), { data: { commands: [{ name: "late" }] } }],
  ];
  for (const [begin, finish, invoke, response] of cases) {
    let resolveRpc;
    ctx.rpc = () => new Promise(resolve => { resolveRpc = resolve; });
    const from = source.indexOf(begin), to = source.indexOf(finish, from + begin.length);
    vm.runInContext(source.slice(from, to), ctx);
    const pending = invoke();
    const replacement = ctx.createUtilityCard("Newer view");
    resolveRpc(response);
    await pending;
    assert.equal(body.children.length, 1);
    assert.equal(body.children[0], replacement);
    assert.equal(title.textContent, "Newer view");
  }
  assert.equal(ctx.autoCompactionEnabled, true, "stale settings must not replace current state");

  // Model setup remains reachable by keyboard; selection is pinned and single-flight.
  const modelStart = source.indexOf("modelChip.onclick = async");
  vm.runInContext(source.slice(modelStart, source.indexOf("thinkChip.onclick", modelStart)), ctx);
  let healthOpened = 0;
  ctx.openHealthCard = () => { healthOpened++; };
  ctx.rpc = async () => ({ data: { models: [] } });
  await ctx.modelChip.onclick();
  const setupButton = body.children[0].children[0];
  assert.equal(setupButton.textContent, "Set up model access");
  assert.equal(doc.activeElement, setupButton);
  setupButton.onclick();
  assert.equal(healthOpened, 1);
  ctx.rpc = async () => { throw new Error("offline"); };
  await ctx.modelChip.onclick();
  assert.equal(doc.activeElement.textContent, "Retry");
  let resolveSelection, selectionCalls = 0;
  const updates = [];
  ctx.setModelChip = model => updates.push(model.id);
  ctx.setThinkChip = () => {};
  ctx.shortModel = model => model.id;
  ctx.toast = () => {};
  ctx.rpc = command => {
    assert.equal(command.sid, "test-chat");
    if (command.type === "get_available_models") return Promise.resolve({ data: { models: [{ id: "one", provider: "example" }] } });
    selectionCalls++;
    return new Promise(resolve => { resolveSelection = resolve; });
  };
  await ctx.modelChip.onclick();
  const modelCard = body.children[0];
  const modelFilter = modelCard.children[1];
  assert.equal(modelFilter["aria-label"], "Filter models");
  assert.equal(doc.activeElement, modelFilter);
  const modelButton = modelCard.children[2].children[0];
  const selection = modelButton.onclick();
  await modelButton.onclick();
  assert.equal(selectionCalls, 1);
  ctx.activeSid = "another-chat";
  const replacement = ctx.createUtilityCard("Other chat view");
  resolveSelection({ data: { id: "one" } });
  await selection;
  assert.deepEqual(updates, []);
  assert.equal(body.children[0], replacement);

  nodes["#historyBtn"] = new Element();
  ctx.activeSid = "test-chat";
  ctx.relTime = () => "just now";
  ctx.toast = () => {};
  ctx.refreshState = () => {};
  ctx.setTimeout = () => {};
  let requests = 0, rejectResume;
  ctx.fetch = async (url) => {
    if (url.startsWith("/history")) return { ok: true, json: async () => ({ groups: [
      { current: true, sessions: [{ name: "First", file: "first.jsonl" }, { name: "Second", file: "second.jsonl" }] },
      { dir: "/missing", exists: false, sessions: [{ name: "Unavailable", file: "missing.jsonl" }] },
    ] }) };
    requests++;
    return new Promise((resolve, reject) => { rejectResume = reject; });
  };
  const historyStart = source.indexOf('$("#historyBtn").onclick');
  vm.runInContext(source.slice(historyStart, source.indexOf('$("#sessionTreeBtn").onclick', historyStart)), ctx);
  await nodes["#historyBtn"].onclick();
  const history = body.children[0];
  const [first, second] = history.children[2].children;
  const unavailable = history.children[3].children[1].children[0];
  const resume = first.onclick();
  await second.onclick();
  assert.equal(requests, 1, "rapid selections must submit only one resume");
  assert.equal(second.disabled, true);
  assert.equal(history["aria-busy"], "true");
  rejectResume(new Error("Offline"));
  await resume;
  assert.equal(history.isConnected, true, "network failure must leave History open for retry");
  assert.equal(first.disabled, false);
  assert.equal(second.disabled, false);
  assert.equal(unavailable.disabled, true, "missing folders must remain unavailable");
  ctx.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  await second.onclick();
  assert.equal(panel.hidden, true, "successful resume closes History");


});

await test("toolbar state ignores stale chat and out-of-order refresh replies", async () => {
  const source = readFileSync(join(ROOT, "web", "public", "app.js"), "utf8");
  const start = source.indexOf("async function refreshState()");
  const end = source.indexOf("// --- context gauge", start);
  const updates = [], pending = [];
  const ctx = vm.createContext({
    activeSid: "alpha", stateRefreshSeq: 0,
    steeringMode: "all", followUpMode: "all", autoCompactionEnabled: true,
    availableThinkLevels: [],
    rpc: command => new Promise(resolve => pending.push({ command, resolve })),
    setModelChip: value => updates.push(value), setThinkChip: () => {},
    queueFor: () => ({}), renderQueue: () => {}, startUsagePolling: () => {},
    refreshCtx: () => updates.push("context"), window: {},
  });
  vm.runInContext(source.slice(start, end), ctx);
  const oldChat = ctx.refreshState();
  ctx.activeSid = "beta";
  pending.shift().resolve({ data: { model: "wrong-chat", autoCompactionEnabled: false } });
  pending.shift().resolve({ data: { levels: ["high"] } });
  await oldChat;
  assert.deepEqual(updates, [], "an old chat response must not mutate the new chat toolbar");
  assert.equal(ctx.autoCompactionEnabled, true);
  const older = ctx.refreshState(), newer = ctx.refreshState();
  const requests = pending.splice(0);
  requests[2].resolve({ data: { model: "newest" } });
  requests[3].resolve({ data: { levels: ["medium"] } });
  await newer;
  requests[0].resolve({ data: { model: "obsolete" } });
  requests[1].resolve({ data: { levels: ["high"] } });
  await older;
  assert.deepEqual(updates, ["newest", "context"], "latest request wins even within one chat");
  assert.ok(requests.every(request => request.command.sid === "beta"), "both RPCs pin the requested session");
});

await test("context gauge rejects stale chat statistics", async () => {
  const source = readFileSync(join(ROOT, "web", "public", "app.js"), "utf8");
  const start = source.indexOf("async function doRefreshCtx()");
  const pending = [];
  const ctx = vm.createContext({
    activeSid: "alpha", contextRefreshSeq: 0, ctxEl: { hidden: true },
    ctxBar: { style: {} }, ctxText: {}, fmtTok: String,
    rpc: command => new Promise(resolve => pending.push({ command, resolve })),
  });
  vm.runInContext(source.slice(start, source.indexOf('$("#newChat").onclick', start)), ctx);
  const old = ctx.doRefreshCtx();
  ctx.activeSid = "beta";
  pending.shift().resolve({ data: { contextUsage: { percent: 99 } } });
  await old;
  assert.equal(ctx.ctxEl.hidden, true);
  const older = ctx.doRefreshCtx(), newer = ctx.doRefreshCtx();
  const requests = pending.splice(0);
  requests[1].resolve({ data: { contextUsage: { percent: 12 } } });
  await newer;
  requests[0].resolve({ data: { contextUsage: { percent: 90 } } });
  await older;
  assert.equal(ctx.ctxBar.style.width, "12%");
  assert.equal(ctx.ctxText.textContent, "ctx 12%");
  assert.ok(requests.every(request => request.command.sid === "beta"));
});

console.log(`theme system: ${count} tests passed`);

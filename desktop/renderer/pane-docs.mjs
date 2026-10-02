// The docs pane (master plan D1b2): /setup-docs as a form, a Build button and
// the built lineage docs. The setup runs coop-data-doc's own wizard in the main
// process, which shows each question here as a field (earlier answers stay
// listed); coop-data-doc stays the only writer of coop-data-doc.yml. Build
// runs `coop-data-doc build` with its output streamed here, and the built
// Markdown pages open in the pane, with the HTML portal one click away.
import { el, icon, toast } from "./ui.mjs";
import { parseMarkdown, renderBlocks } from "./markdown.mjs";

const MAX_LOG = 400;

/** The built page a relative docs link points to, from the page it is on ("" when it leaves the docs). */
export function resolvePage(current, href) {
  let target = String(href || "").split("#")[0];
  try { target = decodeURIComponent(target); } catch { /* keep it as written */ }
  if (!target) return current;
  const parts = target.startsWith("/") ? [] : String(current || "").split("/").slice(0, -1);
  for (const part of target.replace(/^\/+/, "").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (!parts.length) return ""; parts.pop(); } else parts.push(part);
  }
  return parts.join("/");
}

/** A link the docs pane opens itself: a relative .md page, no scheme. */
export const isDocsLink = (href) => /^(?![a-z][a-z0-9+.-]*:)[^?]*\.md(#.*)?$/i.test(String(href || ""));

/** A built page without its YAML front matter. */
export function stripFrontMatter(text) {
  const value = String(text || "");
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(value);
  return match ? value.slice(match[0].length) : value;
}

/** How a wizard answer reads in the list of earlier answers. */
export function answerLabel(prompt, value) {
  if (prompt.kind === "confirm") return value ? "Yes" : "No";
  const label = (v) => { const choice = (prompt.choices || []).find((c) => c.value === v); return choice ? choice.label : v; };
  if (prompt.kind === "select") return label(value);
  if (prompt.kind === "checkbox") return value.length ? value.map(label).join(", ") : "none";
  return value === "" ? "(blank)" : String(value);
}

export function mountDocs(box, options, { coop, codeBlock }) {
  const state = { location: null, running: false, prompt: null, answers: [], notices: [], result: null, building: false, log: [], page: "", history: [] };
  const summary = el("div", { class: "pane-summary" });
  const actions = el("div", { class: "form-actions" });
  const setup = el("div", { class: "docs-setup", hidden: true });
  const build = el("div", { class: "docs-build", hidden: true });
  const viewer = el("div", { class: "docs-viewer", hidden: true });
  box.append(el("div", { class: "pane-scroll" }, summary, actions, setup, build, viewer));

  // --- Status and actions --------------------------------------------------

  function renderTop() {
    const where = state.location;
    if (!where) { summary.replaceChildren(el("span", { class: "spinner" }), el("span", { text: " Looking for coop-data-doc.yml" })); actions.replaceChildren(); return; }
    summary.replaceChildren(
      where.exists ? el("span", { text: "Lineage docs set up: " }) : el("span", { text: "No lineage docs here yet. Setting them up writes " }),
      el("code", { text: where.config }),
      where.built ? el("span", { class: "chip ok", text: "built" }) : where.exists ? el("span", { class: "chip", text: "not built yet" }) : null);
    const busy = state.running || state.building;
    actions.replaceChildren(
      el("button", { type: "button", class: `btn ${where.exists ? "" : "primary"}`, text: where.exists ? "Change the setup" : "Set up the docs", disabled: busy, onclick: startSetup }),
      where.exists ? el("button", { type: "button", class: `btn ${where.exists && !where.built ? "primary" : ""}`, text: where.built ? "Build again" : "Build", disabled: busy, onclick: runBuild }) : null,
      where.built ? el("button", { type: "button", class: "btn", text: "Read the docs", disabled: busy, onclick: () => openPage("index.md") }) : null,
      where.portal ? el("button", { type: "button", class: "btn", text: "Open the portal", title: "The HTML portal in your browser", onclick: openPortal }) : null);
  }

  async function loadLocation() {
    const result = await coop.docsLocation();
    if (!result.success) { summary.textContent = result.error || "Could not look for the docs."; return; }
    state.location = result.data;
    renderTop();
  }

  // --- The setup form ----------------------------------------------------------

  function renderSetup() {
    setup.hidden = !(state.running || state.answers.length || state.notices.length || state.result);
    const done = state.answers.map((a) => el("div", { class: "docs-answer" }, el("span", { class: "docs-question", text: a.message }), el("span", { class: "docs-value", text: a.label })));
    const notes = state.notices.map((n) => el("div", { class: `notice ${n.level === "error" || n.level === "warning" ? n.level : "info"}` }, n.level === "error" || n.level === "warning" ? icon("warn") : null, el("span", { text: n.message })));
    let current = null;
    if (state.prompt) current = promptField(state.prompt);
    else if (state.running) current = el("div", { class: "working" }, el("span", { class: "spinner" }), el("span", { text: "coop-data-doc is working" }));
    let end = null;
    if (state.result) {
      const r = state.result;
      end = el("div", { class: `docs-result ${r.ok && !r.notRunnable ? "ok" : ""}` },
        el("p", { text: r.ok ? (r.notRunnable ? r.message : "Saved. The docs are ready to build.") : (r.message || "The setup stopped. Nothing was saved unless a message above says so.") }),
        r.ok && !r.notRunnable ? el("button", { type: "button", class: "btn primary", text: "Build the docs now", onclick: runBuild }) : null);
    }
    setup.replaceChildren(el("h3", { text: "Setup" }), ...done, ...notes, current, end);
  }

  function promptField(prompt) {
    const problem = el("div", { class: "form-problem", role: "alert", hidden: true });
    const send = async (value) => {
      const result = await coop.docsAnswer(prompt.id, value);
      if (!result.success) { problem.textContent = result.error || "That answer did not fit."; problem.hidden = false; return; }
      if (!state.prompt || state.prompt.id !== prompt.id) return;
      state.answers.push({ message: prompt.message, label: answerLabel(prompt, normalizedForLabel(prompt, value)) });
      state.prompt = null;
      renderSetup();
    };
    const cancel = el("button", { type: "button", class: "btn", text: "Cancel", onclick: () => coop.docsCancel() });
    const label = el("label", { class: "form-label" }, el("span", { text: prompt.message }));
    let control;
    let next;
    if (prompt.kind === "confirm") {
      const yes = el("button", { type: "button", class: `btn ${prompt.default !== false ? "primary" : ""}`, text: "Yes", onclick: () => send(true) });
      const no = el("button", { type: "button", class: `btn ${prompt.default === false ? "primary" : ""}`, text: "No", onclick: () => send(false) });
      return el("div", { class: "form-row docs-prompt" }, label, el("div", { class: "form-actions" }, ...(prompt.default === false ? [no, yes] : [yes, no]), cancel), problem);
    }
    if (prompt.kind === "select" || prompt.kind === "checkbox") {
      const multi = prompt.kind === "checkbox";
      const name = `docs-${prompt.id}`;
      const inputs = prompt.choices.map((choice) => el("input", { type: multi ? "checkbox" : "radio", name, value: choice.value, checked: multi ? choice.checked : choice.value === prompt.default }));
      if (!multi && !inputs.some((input) => input.checked) && inputs[0]) inputs[0].checked = true;
      control = el("div", { class: "choice-list", role: multi ? "group" : "radiogroup", "aria-label": prompt.message },
        prompt.choices.map((choice, i) => el("label", { class: "choice" }, inputs[i], el("span", { text: choice.label }))));
      next = () => send(multi ? inputs.filter((input) => input.checked).map((input) => input.value) : (inputs.find((input) => input.checked) || {}).value);
    } else {
      const fallback = defaultText(prompt);
      const input = el("input", { class: "field", type: "text", value: fallback, spellcheck: "false", "aria-label": prompt.message });
      input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); next(); } });
      const browse = prompt.kind === "path" ? el("button", { type: "button", class: "btn", text: "Browse...", onclick: async () => {
        const result = await coop.pickFolder("docs", input.value || fallback);
        if (result.success) input.value = result.data;
        else if (!result.cancelled) toast(result.error || "Could not choose a folder.", "warning");
      } }) : null;
      control = el("div", { class: "form-control" }, input, browse);
      next = () => send(input.value);
      requestAnimationFrame(() => { if (input.isConnected) input.focus(); });
    }
    return el("div", { class: "form-row docs-prompt" }, label, control,
      defaultText(prompt) ? el("div", { class: "hint", text: `Blank keeps ${defaultText(prompt)}` }) : null,
      problem,
      el("div", { class: "form-actions" }, el("button", { type: "button", class: "btn primary", text: "Next", onclick: () => next() }), cancel));
  }

  const defaultText = (prompt) => ((prompt.kind === "text" || prompt.kind === "path") && typeof prompt.default === "string" ? prompt.default : "");

  // The answer as the main process normalised it (blank text takes the default).
  function normalizedForLabel(prompt, value) {
    if (prompt.kind === "text" || prompt.kind === "path") return String(value).trim() || defaultText(prompt);
    return value;
  }

  async function startSetup() {
    Object.assign(state, { running: true, prompt: null, answers: [], notices: [], result: null });
    viewer.hidden = true;
    renderTop();
    renderSetup();
    const result = await coop.docsStart();
    if (!result.success) {
      Object.assign(state, { running: false, result: { ok: false, message: result.error || "Could not start the setup." } });
      renderTop();
      renderSetup();
    }
  }

  // --- Build -----------------------------------------------------------------

  function renderBuild(done) {
    build.hidden = !(state.building || state.log.length);
    const pre = el("pre", { class: "output build-log" }, el("code", { text: state.log.join("\n") }));
    build.replaceChildren(el("h3", {}, state.building ? el("span", { class: "spinner" }) : null, el("span", { text: state.building ? " Building the docs" : "Build" })), pre, done || null);
    pre.scrollTop = pre.scrollHeight;
  }

  async function runBuild() {
    state.building = true;
    state.log = [];
    renderTop();
    renderBuild();
    const result = await coop.docsBuild();
    state.building = false;
    if (!result.success) { renderBuild(el("div", { class: "notice error" }, icon("warn"), el("span", { text: result.error || "The build did not run." }))); renderTop(); return; }
    const { code, tail, location } = result.data;
    state.location = location;
    renderTop();
    if (code === 0) {
      renderBuild(el("div", { class: "notice info" }, icon("check"), el("span", { text: "Data docs built. coop uses them for lineage." })));
      if (location.built) openPage("index.md");
    } else {
      renderBuild(el("div", { class: "notice error" }, icon("warn"), el("span", { text: `Build failed${code === null ? "" : ` (exit ${code})`}: ${tail.join("  ")}. Fix it, or run the setup again.` })));
    }
  }

  async function openPortal() {
    const result = await coop.docsPortal();
    if (!result.success) toast(result.error || "Could not open the portal.", "warning");
  }

  // --- The built docs ------------------------------------------------------------

  async function openPage(page, { push = true } = {}) {
    const result = await coop.docsPage(page);
    if (!result.success) { toast(result.error || "Could not open that page.", "warning"); return; }
    if (push && state.page && state.page !== result.data.page) state.history.push(state.page);
    state.page = result.data.page;
    const content = el("div", { class: "md docs-page" });
    renderBlocks(document, parseMarkdown(stripFrontMatter(result.data.text)), content, { codeBlock, localLink: isDocsLink });
    viewer.replaceChildren(
      el("div", { class: "pane-toolbar" },
        el("button", { type: "button", class: "btn icon", title: "Back", "aria-label": "Back", disabled: !state.history.length, onclick: () => { const prev = state.history.pop(); if (prev) openPage(prev, { push: false }); } }, icon("back")),
        el("button", { type: "button", class: "btn", text: "Overview", disabled: state.page === "index.md", onclick: () => openPage("index.md") }),
        el("code", { class: "docs-path", text: state.page })),
      content);
    viewer.hidden = false;
    viewer.scrollIntoView({ block: "start" });
  }

  viewer.addEventListener("click", (event) => {
    const link = event.target.closest("a.md-local");
    if (!link) return;
    event.preventDefault();
    const target = resolvePage(state.page, link.dataset.local);
    if (target) openPage(target);
    else toast("That link points outside the built docs.", "info");
  });
  viewer.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.matches && event.target.matches("a.md-local")) { event.preventDefault(); event.target.click(); }
  });

  // --- Events from the main process ------------------------------------------------

  coop.onDocs((event) => {
    if (event.type === "prompt") { state.running = true; state.prompt = event.prompt; renderSetup(); }
    else if (event.type === "notice") { state.notices.push({ level: event.level, message: event.message }); renderSetup(); }
    else if (event.type === "done") {
      Object.assign(state, { running: false, prompt: null, result: { ok: event.ok, notRunnable: Boolean(event.notRunnable), message: event.message || "" } });
      renderSetup();
      loadLocation();
    } else if (event.type === "build-line") {
      state.log.push(event.line);
      if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
      if (state.building) renderBuild();
    }
  });

  async function restore() {
    renderTop();
    await loadLocation();
    // A reloaded window picks up the question the wizard is waiting on.
    const now = await coop.docsState();
    if (now.success && now.data.running) {
      state.running = true;
      state.prompt = now.data.prompt;
      renderSetup();
    }
    if (options && options.start && !state.running && state.location) startSetup();
    else if (state.location && state.location.built && !state.running) openPage("index.md");
  }

  restore();
  return {
    show: (opts) => { if (opts && opts.start && !state.running && !state.building) startSetup(); },
    refresh: () => loadLocation(),
  };
}

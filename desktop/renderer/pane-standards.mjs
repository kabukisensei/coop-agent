// The standards pane (master plan D1b2): the coop-standards articles coop
// resolves for this folder, exactly what a task is given (the wiki's main,
// the last known good copy, the copy shipped with coop, or the project's own
// override), readable and searchable while coop works. Read-only.
import { el, fill, icon, relativeTime } from "./ui.mjs";
import { parseMarkdown, renderBlocks } from "./markdown.mjs";
import { createFinder } from "./find.mjs";

export const STATE_LABELS = Object.freeze({
  canonical: "From the coop-standards wiki",
  stale_last_known_good: "Last copy coop fetched (the wiki was not reachable or the copy is stale)",
  bundled: "Copy shipped with coop (the wiki was not reachable)",
  project_override: "This project's own standard (.coop/project.yml)",
  auth_required: "Sign-in needed to read the wiki",
  unavailable: "No articles for this domain",
});

/** The articles in a resolved snapshot: its top-level headings, in order. */
export function articleOutline(blocks) {
  return blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.type === "heading" && block.level === 1)
    .map(({ block, index }) => ({ index, title: block.children.map((c) => c.text || (c.children || []).map((x) => x.text || "").join("")).join("").trim() }));
}

/** One line on where the standards came from and how fresh they are. */
export function sourceLine(source) {
  if (!source) return "";
  const parts = [];
  if (source.repository) parts.push(`${source.repository.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")} (${source.branch || "main"})`);
  if (source.freshness) parts.push(source.freshness === "fresh" ? "up to date" : source.freshness);
  if (source.lastCheckMs) parts.push(`checked ${relativeTime(source.lastCheckMs)}`);
  if (!source.lastAttemptOk) parts.push("the last refresh failed");
  if (source.bundle && source.bundle.state === "available") parts.push(`shipped copy ${source.bundle.revision}`);
  return parts.join(" · ");
}

export function mountStandards(box, options, { coop, codeBlock }) {
  const state = { domains: [], source: null, domain: (options && options.domain) || "", text: "", loading: false };
  const head = el("div", { class: "pane-summary" });
  const chips = el("div", { class: "domain-chips", role: "tablist", "aria-label": "Standards domains" });
  const meta = el("div", { class: "standards-meta" });
  const articles = el("select", { class: "field", "aria-label": "Jump to an article" });
  const findInput = el("input", { class: "field", type: "search", placeholder: "Search these standards", "aria-label": "Search these standards" });
  const findCount = el("span", { class: "find-count", "aria-live": "polite" });
  const prev = el("button", { type: "button", class: "btn icon", title: "Earlier match", "aria-label": "Earlier match" }, icon("up"));
  const next = el("button", { type: "button", class: "btn icon", title: "Later match", "aria-label": "Later match" }, icon("down"));
  const clear = el("button", { type: "button", class: "btn icon", title: "Clear the search", "aria-label": "Clear the search" }, icon("close"));
  const bar = el("div", { class: "pane-toolbar" }, findInput, findCount, prev, next, clear);
  const content = el("div", { class: "md standards-body" });
  box.append(head, chips, meta, el("div", { class: "pane-toolbar" }, articles), bar, content);
  const finder = createFinder({ root: content, bar, input: findInput, count: findCount, prev, next, close: clear, highlight: "coop-pane-find", fromTop: true, bodyClass: "", onClose: () => { findInput.value = ""; findCount.textContent = ""; bar.hidden = false; } });

  function renderChips() {
    fill(chips, ...state.domains.map((d) => el("button", {
      type: "button",
      class: `chip domain${d.domain === state.domain ? " active" : ""}${d.available ? "" : " off"}`,
      role: "tab",
      "aria-selected": d.domain === state.domain ? "true" : "false",
      disabled: !d.available,
      title: STATE_LABELS[d.state] || d.state,
      onclick: () => choose(d.domain),
    }, el("span", { text: d.label }), d.available ? el("span", { class: "chip-count", text: String(d.articles.length) }) : null)));
  }

  function renderMeta(domain) {
    if (!domain) { fill(meta); return; }
    fill(meta, 
      el("span", { class: `state ${domain.state}`, text: STATE_LABELS[domain.state] || domain.state }),
      domain.revision ? el("code", { text: domain.revision }) : null,
      domain.degraded ? el("span", { class: "chip bad", text: "degraded" }) : null);
  }

  async function choose(domainId) {
    state.domain = domainId;
    renderChips();
    const domain = state.domains.find((d) => d.domain === domainId);
    renderMeta(domain);
    fill(content, el("div", { class: "working" }, el("span", { class: "spinner" }), el("span", { text: "Reading the articles" })));
    const result = await coop.standardsText(domainId);
    if (state.domain !== domainId) return;
    if (!result.success) { fill(content, el("p", { class: "pane-empty", text: result.error || "Could not read these standards." })); fill(articles); return; }
    const blocks = parseMarkdown(result.data.text);
    const outline = articleOutline(blocks);
    fill(content);
    renderBlocks(document, blocks, content, { codeBlock });
    if (result.data.truncated) content.append(el("p", { class: "hint", text: "Cut short here. The full text is in the terminal: run /standards-status." }));
    const headings = [...content.querySelectorAll(":scope > h2")];
    fill(articles, el("option", { value: "", text: `${outline.length} ${outline.length === 1 ? "article" : "articles"}: jump to one` }),
      ...outline.map((a, i) => el("option", { value: String(i), text: a.title })));
    articles.onchange = () => { const h = headings[Number(articles.value)]; if (h) h.scrollIntoView({ block: "start" }); };
    if (findInput.value.trim()) finder.search({ scroll: false });
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    fill(head, el("span", { class: "spinner" }), el("span", { text: " Resolving the standards coop applies here" }));
    const result = await coop.standards();
    state.loading = false;
    if (!result.success) { head.textContent = result.error || "Could not resolve the standards."; return; }
    state.domains = result.data.domains;
    state.source = result.data.source;
    fill(head, el("span", { text: sourceLine(state.source) || "Standards" }));
    const wanted = state.domains.find((d) => d.domain === state.domain && d.available);
    const first = wanted || state.domains.find((d) => d.available);
    renderChips();
    if (first) await choose(first.domain);
    else { renderMeta(null); fill(content, el("p", { class: "pane-empty", text: "No standards resolve for this folder. Run coop sync when online, or check /standards-status in the terminal." })); }
  }

  findInput.addEventListener("focus", () => { bar.hidden = false; });
  load();
  return {
    show: (opts) => { if (opts && opts.domain && opts.domain !== state.domain && state.domains.some((d) => d.domain === opts.domain && d.available)) choose(opts.domain); },
    refresh: () => load(),
  };
}

// The standards pane (master plan D1b2): the coop-standards articles coop
// resolves for this folder, exactly what a task is given (the wiki's main,
// the last known good copy, the copy shipped with coop, or the project's own
// override), readable and searchable while coop works. Read-only.
//
// Under the domains, the team knowledge repositories coop keeps next to the
// standards (incremental BI, the approved patterns; team knowledge, the
// TeamAI team share): one chip each, the clone's notes to pick from, one note
// at a time, the same clone the terminal's team-knowledge skill searches.
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

export const KNOWLEDGE_STATE_LABELS = Object.freeze({
  available: "Cloned by coop sync",
  dirty_preserved: "Cloned, with local edits coop sync keeps",
  unavailable: "Not cloned here: enable team knowledge with coop onboard, then run coop sync",
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

/** The option label of a knowledge note: its folder, then its title. */
export function noteLabel(note) {
  return note.folder ? `${note.folder.replace(/\//g, " / ")} / ${note.title}` : note.title;
}

/** A pane selector: a domain id, or `knowledge:<repository id>`. */
export function isKnowledgeId(id) {
  return typeof id === "string" && id.startsWith("knowledge:");
}

export function mountStandards(box, options, { coop, codeBlock }) {
  const state = { domains: [], knowledge: [], source: null, domain: (options && options.domain) || "", note: "", loading: false };
  const head = el("div", { class: "pane-summary" });
  const chips = el("div", { class: "domain-chips", role: "tablist", "aria-label": "Standards domains" });
  const knowledgeChips = el("div", { class: "domain-chips", role: "tablist", "aria-label": "Team knowledge repositories", hidden: true });
  const meta = el("div", { class: "standards-meta" });
  const articles = el("select", { class: "field", "aria-label": "Jump to an article" });
  const findInput = el("input", { class: "field", type: "search", placeholder: "Search these standards", "aria-label": "Search these standards" });
  const findCount = el("span", { class: "find-count", "aria-live": "polite" });
  const prev = el("button", { type: "button", class: "btn icon", title: "Earlier match", "aria-label": "Earlier match" }, icon("up"));
  const next = el("button", { type: "button", class: "btn icon", title: "Later match", "aria-label": "Later match" }, icon("down"));
  const clear = el("button", { type: "button", class: "btn icon", title: "Clear the search", "aria-label": "Clear the search" }, icon("close"));
  const bar = el("div", { class: "pane-toolbar" }, findInput, findCount, prev, next, clear);
  const content = el("div", { class: "md standards-body" });
  box.append(head, chips, knowledgeChips, meta, el("div", { class: "pane-toolbar" }, articles), bar, content);
  const finder = createFinder({ root: content, bar, input: findInput, count: findCount, prev, next, close: clear, highlight: "coop-pane-find", fromTop: true, bodyClass: "", onClose: () => { findInput.value = ""; findCount.textContent = ""; bar.hidden = false; } });

  const chip = (id, label, count, available, title) => el("button", {
    type: "button",
    class: `chip domain${id === state.domain ? " active" : ""}${available ? "" : " off"}`,
    role: "tab",
    "aria-selected": id === state.domain ? "true" : "false",
    disabled: !available,
    title,
    onclick: () => choose(id),
  }, el("span", { text: label }), available ? el("span", { class: "chip-count", text: String(count) }) : null);

  function renderChips() {
    fill(chips, ...state.domains.map((d) => chip(d.domain, d.label, d.articles.length, d.available, STATE_LABELS[d.state] || d.state)));
    knowledgeChips.hidden = state.knowledge.length === 0;
    fill(knowledgeChips, el("span", { class: "chips-label", text: "Knowledge" }),
      ...state.knowledge.map((k) => chip(`knowledge:${k.id}`, k.label, k.notes.length, k.available, `${k.id}: ${KNOWLEDGE_STATE_LABELS[k.state] || k.state}`)));
  }

  function renderMeta(domain) {
    if (!domain) { fill(meta); return; }
    fill(meta,
      el("span", { class: `state ${domain.state}`, text: STATE_LABELS[domain.state] || domain.state }),
      domain.revision ? el("code", { text: domain.revision }) : null,
      domain.degraded ? el("span", { class: "chip bad", text: "degraded" }) : null);
  }

  function renderKnowledgeMeta(repo, note) {
    fill(meta,
      el("span", { class: `state ${repo.state}`, text: KNOWLEDGE_STATE_LABELS[repo.state] || repo.state }),
      repo.revision ? el("code", { text: repo.revision }) : null,
      note ? el("span", { class: "note-folder", text: note.path }) : null);
  }

  function showResult(result) {
    if (!result.success) { fill(content, el("p", { class: "pane-empty", text: result.error || "Could not read this." })); return null; }
    const blocks = parseMarkdown(result.data.text);
    fill(content);
    renderBlocks(document, blocks, content, { codeBlock });
    if (result.data.truncated) content.append(el("p", { class: "hint", text: "Cut short here. The full text is in the terminal: run /standards-status." }));
    if (findInput.value.trim()) finder.search({ scroll: false });
    return blocks;
  }

  async function chooseDomain(domainId) {
    const domain = state.domains.find((d) => d.domain === domainId);
    renderMeta(domain);
    fill(content, el("div", { class: "working" }, el("span", { class: "spinner" }), el("span", { text: "Reading the articles" })));
    const result = await coop.standardsText(domainId);
    if (state.domain !== domainId) return;
    const blocks = showResult(result);
    if (!blocks) { fill(articles); return; }
    const outline = articleOutline(blocks);
    const headings = [...content.querySelectorAll(":scope > h2")];
    fill(articles, el("option", { value: "", text: `${outline.length} ${outline.length === 1 ? "article" : "articles"}: jump to one` }),
      ...outline.map((a, i) => el("option", { value: String(i), text: a.title })));
    articles.onchange = () => { const h = headings[Number(articles.value)]; if (h) h.scrollIntoView({ block: "start" }); };
  }

  async function openNote(repo, note) {
    state.note = note ? note.path : "";
    renderKnowledgeMeta(repo, note);
    if (!note) { fill(content, el("p", { class: "pane-empty", text: "No Markdown notes in this clone yet." })); return; }
    fill(content, el("div", { class: "working" }, el("span", { class: "spinner" }), el("span", { text: "Reading the note" })));
    const result = await coop.knowledgeNote(repo.id, note.path);
    if (state.domain !== `knowledge:${repo.id}` || state.note !== note.path) return;
    showResult(result);
    content.scrollTop = 0;
  }

  async function chooseKnowledge(id) {
    const repo = state.knowledge.find((k) => `knowledge:${k.id}` === id);
    if (!repo) return;
    fill(articles, el("option", { value: "", text: `${repo.notes.length} ${repo.notes.length === 1 ? "note" : "notes"}${repo.truncated ? " (first ones)" : ""}: open one` }),
      ...repo.notes.map((n, i) => el("option", { value: String(i), text: noteLabel(n) })));
    articles.onchange = () => { const n = repo.notes[Number(articles.value)]; if (n) openNote(repo, n); };
    const current = repo.notes.find((n) => n.path === state.note);
    await openNote(repo, current || repo.notes[0] || null);
    if (current || repo.notes[0]) articles.value = String(repo.notes.indexOf(current || repo.notes[0]));
  }

  async function choose(id) {
    state.domain = id;
    renderChips();
    if (isKnowledgeId(id)) await chooseKnowledge(id);
    else await chooseDomain(id);
  }

  function selectable(id) {
    return isKnowledgeId(id)
      ? state.knowledge.some((k) => `knowledge:${k.id}` === id && k.available)
      : state.domains.some((d) => d.domain === id && d.available);
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    fill(head, el("span", { class: "spinner" }), el("span", { text: " Resolving the standards coop applies here" }));
    const result = await coop.standards();
    state.loading = false;
    if (!result.success) { head.textContent = result.error || "Could not resolve the standards."; return; }
    state.domains = result.data.domains;
    state.knowledge = Array.isArray(result.data.knowledge) ? result.data.knowledge : [];
    state.source = result.data.source;
    fill(head, el("span", { text: sourceLine(state.source) || "Standards" }));
    const first = selectable(state.domain) ? state.domain
      : (state.domains.find((d) => d.available) || {}).domain || (state.knowledge.filter((k) => k.available).map((k) => `knowledge:${k.id}`)[0]);
    renderChips();
    if (first) await choose(first);
    else { renderMeta(null); fill(articles); fill(content, el("p", { class: "pane-empty", text: "No standards resolve for this folder. Run coop sync when online, or check /standards-status in the terminal." })); }
  }

  findInput.addEventListener("focus", () => { bar.hidden = false; });
  load();
  return {
    show: (opts) => { if (opts && opts.domain && opts.domain !== state.domain && selectable(opts.domain)) choose(opts.domain); },
    refresh: () => load(),
  };
}

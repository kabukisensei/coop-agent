// coop web — the Changes panel: a read-only git diff viewer that opens full-pane
// over the transcript. It LISTS the working tree's changed files (/git/changes)
// and RENDERS the selected file's diff (/git/diff, or /file for untracked ones)
// either unified or side-by-side, with line numbers, add/remove coloring, cheap
// intraline emphasis, and in-file search. It never writes.
//
// The diff *text* is turned into a model by the pure, DOM-free module in diff.js
// (window.coopDiffModel — parseUnifiedDiff/pairAndEmphasize/buildSplitRows/
// computeMatches); this file owns only the DOM. Everything it renders is escaped
// before it touches the page (createElement/textContent ONLY — never innerHTML),
// same escape-first rule as viewer.js and the chat. The +/- diff markers are drawn
// by CSS ::before, never put in textContent, so a copy of the diff carries no
// markers. No inline styles/scripts — CSP-clean.
//
// It exposes window.coopDiff for app.js to call: onAgentEnd() (a turn may have
// changed files, so refresh the badge / open file) and onReset() (folder changed
// on __hello — close and forget everything).
"use strict";
(function () {
  const $ = (s) => document.querySelector(s);
  // toast() lives in app.js's module scope (not on window); prefer it if a future
  // build exposes it, else degrade to the console so this self-contained file can
  // never throw for a missing helper.
  const toast = (msg, kind) => {
    if (typeof window.toast === "function") window.toast(msg, kind || "info");
    else console.warn("coop web (diff):", msg);
  };
  // The pure model is loaded first (diff.js). Guard its presence so a missing
  // script can't throw here; every consumer below short-circuits when absent.
  const M = () => window.coopDiffModel || null;
  // Route git reads to the ACTIVE chat's working folder. Guard on a non-empty string so
  // we never interpolate an unset value into the literal "undefined" (the bridge would
  // 400); before the first __hello the un-sid'd request works via single-chat fallback.
  const withSid = (url) => (typeof window.coopSid === "string" && window.coopSid)
    ? url + (url.includes("?") ? "&" : "?") + "sid=" + encodeURIComponent(window.coopSid) : url;

  const RENDER_CAP = 4000; // rows drawn per file before the "show more" button

  // --- module state ---------------------------------------------------------------
  let open = false;
  let changes = null; // last /git/changes payload
  let selected = null; // the selected file record ({path, status, untracked, …}) or null
  let model = null; // parsed hunks for the open file: {binary, hunks:[…]} or null
  let viewMode = "unified"; // "unified" | "split"
  let baseRef = ""; // "" means HEAD; otherwise a user-typed ref
  let matches = []; // computeMatches() result for the open file + current query
  let matchIdx = -1; // index into matches of the active (.cur) hit, or -1
  let query = ""; // current search text
  let renderCapped = true; // whether the current render honors RENDER_CAP
  let gen = 0; // generation counter — every async load stamps gen; stale ones no-op

  // 500 ms debounced, single-flight badge-only refresh (used while the panel is
  // closed): replay bursts after __hello collapse to a single /git/changes fetch.
  let badgeTimer = null;
  let badgeInFlight = false;

  // Toolbar controls, created once in ensureToolbar() and cached here so a re-render
  // never rebuilds them (and so search/base-ref state survives a view toggle).
  let ui = null; // { viewBtn, baseInput, searchInput, counter } or null
  let builtToolbar = false;

  // --- element lookups (all null-guarded so a missing id can't throw) --------------
  const overlay = () => $("#diff");
  const btn = () => $("#diffBtn");
  const head = () => $("#diffHead");
  const filesRail = () => $("#diffFiles");
  const body = () => $("#diffBody");

  // --- toggle / open-close --------------------------------------------------------
  function toggle() {
    open = !open;
    const ov = overlay();
    if (ov) ov.hidden = !open;
    const b = btn();
    if (b) b.classList.toggle("on", open);
    if (open) {
      ensureToolbar();
      refreshAll();
    }
  }

  function close() {
    if (!open) return;
    open = false;
    const ov = overlay();
    if (ov) ov.hidden = true;
    const b = btn();
    if (b) b.classList.remove("on");
  }

  // --- toolbar (built in JS so the file doesn't depend on markup it doesn't own) ---
  // We CREATE the controls and append them to #diffHead rather than querying for
  // pre-existing elements, so diffview.js is self-contained. Guard #diffHead itself.
  function ensureToolbar() {
    if (builtToolbar) return;
    const h = head();
    if (!h) return; // nothing to attach to — stay inert rather than throw
    builtToolbar = true;

    const viewBtn = document.createElement("button");
    viewBtn.className = "chip";
    viewBtn.type = "button";
    viewBtn.title = "Toggle unified / side-by-side";
    viewBtn.textContent = "Unified ⇄ Split";
    viewBtn.onclick = () => {
      viewMode = viewMode === "unified" ? "split" : "unified";
      render(); // re-render only — no refetch
    };

    const baseInput = document.createElement("input");
    baseInput.className = "diff-base";
    baseInput.type = "text";
    baseInput.placeholder = "vs HEAD — type a ref, e.g. origin/main";
    baseInput.value = baseRef;
    baseInput.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      baseRef = baseInput.value.trim();
      refreshAll();
    };

    const searchInput = document.createElement("input");
    searchInput.className = "diff-search";
    searchInput.type = "text";
    searchInput.placeholder = "Find in file";
    searchInput.oninput = () => scheduleSearch(searchInput.value);
    searchInput.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      cycleMatch(e.shiftKey ? -1 : 1);
    };

    const counter = document.createElement("span");
    counter.className = "diff-count";
    counter.textContent = "";

    const refreshBtn = document.createElement("button");
    refreshBtn.className = "chip";
    refreshBtn.type = "button";
    refreshBtn.title = "Refresh the changed-files list";
    refreshBtn.textContent = "⟳";
    refreshBtn.onclick = () => refreshAll(); // refreshAll re-renders the list+badge AND reloads the open file

    const closeBtn = document.createElement("button");
    closeBtn.className = "chip";
    closeBtn.type = "button";
    closeBtn.title = "Close the panel";
    closeBtn.textContent = "✕";
    closeBtn.onclick = close;

    h.append(viewBtn, baseInput, searchInput, counter, refreshBtn, closeBtn);
    ui = { viewBtn, baseInput, searchInput, counter };
  }

  // --- badge (a <span class="cnt"> inside #diffBtn) --------------------------------
  function badgeEl() {
    const b = btn();
    if (!b) return null;
    let el = b.querySelector(".cnt");
    if (!el) {
      el = document.createElement("span");
      el.className = "cnt";
      b.appendChild(el);
    }
    return el;
  }

  function setBadge(n) {
    const el = badgeEl();
    if (!el) return;
    el.textContent = String(n);
    el.hidden = false;
  }

  function hideBadge() {
    const el = badgeEl();
    if (el) el.hidden = true;
  }

  // --- refresh: fetch /git/changes and dispatch on the state shape -----------------
  async function refreshAll() {
    const my = ++gen; // stamp this load; a later load supersedes it
    const url = "/git/changes" + (baseRef ? "?base=" + encodeURIComponent(baseRef) : "");
    let data;
    try {
      const r = await fetch(withSid(url));
      data = await r.json();
    } catch {
      if (my !== gen) return;
      showEmpty("Couldn't reach coop web to list changes.");
      hideBadge();
      return;
    }
    if (my !== gen) return; // a newer refresh won — drop this stale result

    // git not installed on this machine.
    if (data && data.git === false) {
      changes = data;
      hideBadge();
      showEmpty("Git isn't installed on this machine, so coop can't show file changes. Install git and reopen this panel.");
      return;
    }
    // not a git repository.
    if (data && data.repo === false) {
      changes = data;
      hideBadge();
      showEmpty("This folder isn't a git repository — no changes to show.");
      return;
    }
    // bad base ref (or any resolution failure): toast, reset to HEAD, retry once.
    if (data && data.ok === false) {
      toast(data.error || "That base ref wasn't found.", "error");
      if (baseRef) {
        baseRef = "";
        if (ui && ui.baseInput) ui.baseInput.value = "";
        refreshAll(); // retry vs HEAD (bumps gen again — this stale frame is done)
      } else {
        hideBadge();
        showEmpty("Couldn't list changes.");
      }
      return;
    }

    // ok — render the file list and update the badge.
    changes = data;
    const files = (data && data.files) || [];
    setBadge(data && data.truncated ? "500+" : files.length);
    if (!files.length) hideBadge(); // no changes → no badge

    // keep the previously selected path selected if it survives; else pick the first.
    let keep = null;
    if (selected) keep = files.find((f) => f.path === selected.path) || null;
    const next = keep || files[0] || null;

    renderFileList(files);
    if (next) {
      // Reload the open file's diff too. refreshAll is only ever called for a FULL
      // refresh (panel open, agent turn, ⟳, base-ref change), and a turn changes a
      // file's CONTENT even when its path/status don't — so reload unconditionally.
      // Keeping the reload INSIDE refreshAll is load-bearing: the file-list + badge
      // render above always commit before openDiff bumps `gen`, so an external
      // openDiff() can't race ahead and make this refresh's stale-guard drop them.
      selected = next;
      markActive();
      openDiff(next);
    } else {
      selected = null;
      model = null;
      clearBody();
      showEmpty(files.length ? "" : "No changes in this folder.");
    }
  }

  // --- left rail: the changed-files list -------------------------------------------
  function renderFileList(files) {
    const rail = filesRail();
    if (!rail) return;
    rail.textContent = "";
    for (const f of files) rail.appendChild(fileRow(f));
  }

  function fileRow(f) {
    const row = document.createElement("div");
    row.className = "dfile" + (selected && f.path === selected.path ? " active" : "");
    row.dataset.path = f.path;

    // colored status letter (A lime / M gold / D red / R dim).
    const st = document.createElement("span");
    const letter = String(f.status || "M").charAt(0).toUpperCase();
    const cls = { A: "a", M: "m", D: "d", R: "r" }[letter] || "m";
    st.className = "st " + cls;
    st.textContent = letter;

    // the path; renames show old → new. title carries the full path.
    const name = document.createElement("span");
    name.className = "dfile-path";
    if (f.oldPath && f.oldPath !== f.path) {
      name.textContent = f.oldPath + " → " + f.path;
      name.title = f.oldPath + " → " + f.path;
    } else {
      name.textContent = f.path;
      name.title = f.path;
    }

    row.append(st, name);

    // untracked files are flagged "new".
    if (f.untracked) {
      const tag = document.createElement("span");
      tag.className = "dfile-new";
      tag.textContent = "new";
      row.appendChild(tag);
    }

    row.onclick = () => {
      selected = f;
      markActive();
      openDiff(f);
    };
    return row;
  }

  function markActive() {
    const rail = filesRail();
    if (!rail) return;
    for (const el of rail.querySelectorAll(".dfile.active")) el.classList.remove("active");
    if (!selected) return;
    for (const el of rail.querySelectorAll(".dfile")) {
      if (el.dataset.path === selected.path) el.classList.add("active");
    }
  }

  // --- open a file: fetch + parse into `model`, then render ------------------------
  async function openDiff(file) {
    const my = ++gen;
    // reset search for the newly opened file.
    resetSearch();
    clearBody();
    showEmpty("Loading…");

    if (file.untracked) {
      // untracked files have no git-tracked base — render their /file content as an
      // all-added model. /file enforces the same jail + hidden-file + binary rules,
      // so an untracked .env stays refused exactly as in the Files panel.
      let data;
      try {
        const r = await fetch(withSid("/file?p=" + encodeURIComponent(file.path)));
        data = await r.json();
      } catch {
        if (my !== gen) return;
        model = null;
        clearBody();
        showEmpty("Couldn't read that file.");
        return;
      }
      if (my !== gen) return;
      if (!data || !data.ok) {
        model = null;
        clearBody();
        showEmpty((data && data.error) || "Can't preview this file.");
        return;
      }
      if (data.kind === "binary") {
        model = null;
        clearBody();
        showEmpty("Binary file — no diff preview.");
        return;
      }
      model = allAddedModel(String(data.content == null ? "" : data.content));
      render();
      if (data.truncated) appendNote("⚠ Diff truncated for preview.");
      return;
    }

    // tracked file: ask git for the unified diff, then parse it client-side.
    const mod = M();
    const parts = ["p=" + encodeURIComponent(file.path)];
    if (file.oldPath && file.oldPath !== file.path) parts.push("old=" + encodeURIComponent(file.oldPath));
    if (baseRef) parts.push("base=" + encodeURIComponent(baseRef));
    let data;
    try {
      const r = await fetch(withSid("/git/diff?" + parts.join("&")));
      data = await r.json();
    } catch {
      if (my !== gen) return;
      model = null;
      clearBody();
      showEmpty("Couldn't load that diff.");
      return;
    }
    if (my !== gen) return;
    if (!data || !data.ok) {
      model = null;
      clearBody();
      showEmpty((data && data.error) || "That diff can't be shown.");
      return;
    }
    if (!mod) {
      model = null;
      clearBody();
      showEmpty("Diff model unavailable.");
      return;
    }
    const parsed = mod.parseUnifiedDiff(String(data.diff == null ? "" : data.diff));
    if (parsed && parsed.binary) {
      model = null;
      clearBody();
      showEmpty("Binary file — no diff preview.");
      return;
    }
    if (!parsed || !parsed.hunks || !parsed.hunks.length) {
      model = null;
      clearBody();
      showEmpty("No text changes.");
      return;
    }
    mod.pairAndEmphasize(parsed.hunks);
    model = parsed;
    render();
    if (data.truncated) appendNote("⚠ Diff truncated for preview.");
  }

  // Synthesize an all-added model (one hunk, every line an add) for untracked files.
  function allAddedModel(text) {
    const raw = text.split("\n");
    // a trailing newline yields a final empty element; drop it so we don't render a
    // phantom blank added line at the end.
    if (raw.length && raw[raw.length - 1] === "") raw.pop();
    const lines = raw.map((t, i) => ({ type: "add", oldNo: null, newNo: i + 1, text: t }));
    return { binary: false, hunks: [{ header: "@@ new file @@", lines }] };
  }

  // --- rendering ------------------------------------------------------------------
  function render() {
    if (!model) return;
    recomputeMatches(); // matches depend on the model; recompute before drawing
    if (viewMode === "split") renderSplit();
    else renderUnified();
    updateCounter();
    scrollToActive();
  }

  function clearBody() {
    const b = body();
    if (b) b.textContent = "";
  }

  function showEmpty(msg) {
    const b = body();
    if (!b) return;
    b.textContent = "";
    if (!msg) return;
    b.appendChild(emptyNote(msg));
  }

  function emptyNote(msg) {
    const p = document.createElement("div");
    p.className = "files-empty";
    p.textContent = msg;
    return p;
  }

  function appendNote(msg) {
    const b = body();
    if (b) b.appendChild(emptyNote(msg));
  }

  // A flat list of {hunkIdx, lineIdx} match refs is what the renderers consult to
  // decide which line carries hits and whether one of them is the active .cur.
  function hitsForLine(hunkIdx, lineIdx) {
    const out = [];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      if (m.hunkIdx === hunkIdx && m.lineIdx === lineIdx) out.push({ m, active: i === matchIdx });
    }
    return out;
  }

  // Unified view: old-number gutter, new-number gutter, code cell — one .drow each.
  function renderUnified() {
    const b = body();
    if (!b) return;
    b.textContent = "";
    let drawn = 0,
      total = 0,
      capped = false;
    for (let h = 0; h < model.hunks.length; h++) {
      const hunk = model.hunks[h];
      b.appendChild(hunkRow(hunk.header, false));
      for (let li = 0; li < hunk.lines.length; li++) {
        total++;
        if (renderCapped && drawn >= RENDER_CAP) {
          capped = true;
          continue;
        }
        b.appendChild(unifiedRow(hunk.lines[li], h, li));
        drawn++;
      }
    }
    if (capped) b.appendChild(showMoreBtn(total - drawn));
  }

  function unifiedRow(line, hunkIdx, lineIdx) {
    const row = document.createElement("div");
    row.className = "drow " + rowKind(line.type);
    const oldNo = document.createElement("span");
    oldNo.className = "dno";
    oldNo.textContent = line.oldNo == null ? "" : String(line.oldNo);
    const newNo = document.createElement("span");
    newNo.className = "dno";
    newNo.textContent = line.newNo == null ? "" : String(line.newNo);
    const code = document.createElement("span");
    code.className = "dcode";
    fillCode(code, line, hunkIdx, lineIdx);
    row.append(oldNo, newNo, code);
    return row;
  }

  // Split view: number+code | number+code, built from buildSplitRows().
  function renderSplit() {
    const b = body();
    if (!b) return;
    b.textContent = "";
    const mod = M();
    if (!mod) return;
    const rows = mod.buildSplitRows(model.hunks);
    let drawn = 0,
      total = 0,
      capped = false;
    for (const r of rows) {
      if (r.kind === "hunk") {
        b.appendChild(hunkRow(r.header, true));
        continue;
      }
      total++;
      if (renderCapped && drawn >= RENDER_CAP) {
        capped = true;
        continue;
      }
      b.appendChild(splitRow(r));
      drawn++;
    }
    if (capped) b.appendChild(showMoreBtn(total - drawn));
  }

  function splitRow(r) {
    const row = document.createElement("div");
    row.className = "drow split";
    let left, right;
    if (r.kind === "ctx") {
      // context shows the same text on both sides, each with its own line number.
      left = { type: "ctx", oldNo: r.oldNo, newNo: null, text: r.text };
      right = { type: "ctx", oldNo: null, newNo: r.newNo, text: r.text };
    } else {
      // "pair": left is a del (or null), right is an add (or null).
      left = r.left;
      right = r.right;
    }
    row.append(splitCell(left, "l"), splitCell(right, "r"));
    return row;
  }

  // One side of a split row = number gutter + code cell. A null line (shorter side
  // of a del/add block) renders empty, non-colored filler.
  function splitCell(line, side) {
    const wrap = document.createElement("span");
    wrap.className = "dside";
    const no = document.createElement("span");
    no.className = "dno";
    const code = document.createElement("span");
    code.className = "dcode";
    if (line) {
      // color the code cell by the side's role so ::before markers land per side.
      code.classList.add(side === "l" ? "del" : line.type === "add" ? "add" : rowKind(line.type));
      no.textContent = side === "l" ? (line.oldNo == null ? "" : String(line.oldNo)) : line.newNo == null ? "" : String(line.newNo);
      // search hits are located by (hunkIdx, lineIdx) which split rows don't carry;
      // split view therefore shows emphasis but not live search highlight — the
      // search box operates on the unified model’s line coordinates.
      fillCode(code, line, -1, -1);
    }
    wrap.append(no, code);
    return wrap;
  }

  // A hunk boundary: a full-width separator row carrying the @@ header text.
  function hunkRow(header, isSplit) {
    const row = document.createElement("div");
    row.className = "drow hunk" + (isSplit ? " split" : "");
    const cell = document.createElement("span");
    cell.className = "dcode";
    cell.textContent = header || "";
    row.appendChild(cell);
    return row;
  }

  // Map a Line.type to the row-coloring class the CSS ::before markers key off.
  function rowKind(type) {
    if (type === "add") return "add";
    if (type === "del") return "del";
    return "ctx";
  }

  // "Show N more rows" — re-render uncapped.
  function showMoreBtn(n) {
    const btnEl = document.createElement("button");
    btnEl.className = "chip diff-more";
    btnEl.type = "button";
    btnEl.textContent = "Show " + n + " more rows";
    btnEl.onclick = () => {
      renderCapped = false;
      render();
    };
    return btnEl;
  }

  // --- code-cell content: emphasis + search spans (escape-first) -------------------
  // Build the code cell for one line: cut its text at every emphasis/hit boundary
  // and emit plain text nodes or <span> segments. The +/- marker is NOT part of the
  // text — CSS ::before draws it — so a copy of the diff never contains a marker.
  function fillCode(code, line, hunkIdx, lineIdx) {
    const text = line.text == null ? "" : String(line.text);
    const em = line.em && line.em.length === 2 ? line.em : null; // [start, end)
    const hits = hunkIdx >= 0 ? hitsForLine(hunkIdx, lineIdx) : [];
    const segs = lineSpans(text, em, hits);
    for (const s of segs) {
      if (!s.cls) {
        code.appendChild(document.createTextNode(s.text));
      } else {
        const span = document.createElement("span");
        span.className = s.cls;
        span.textContent = s.text;
        code.appendChild(span);
      }
    }
  }

  // Cut `text` into styled segments. Boundaries come from the emphasis range and
  // every search hit; between two boundaries we emit one segment whose class is the
  // union of whatever spans cover it (dem for emphasis, dhit / dhit cur for hits).
  function lineSpans(text, em, hits) {
    const n = text.length;
    if (!n) return [{ text: "", cls: "" }];
    // collect boundary offsets.
    const bounds = new Set([0, n]);
    if (em) {
      if (em[0] > 0 && em[0] < n) bounds.add(em[0]);
      if (em[1] > 0 && em[1] < n) bounds.add(em[1]);
    }
    for (const h of hits) {
      if (h.m.start > 0 && h.m.start < n) bounds.add(h.m.start);
      if (h.m.end > 0 && h.m.end < n) bounds.add(h.m.end);
    }
    const cuts = Array.from(bounds).sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i],
        z = cuts[i + 1];
      if (z <= a) continue;
      const mid = a; // any offset inside [a,z) has identical coverage
      let isEm = !!(em && mid >= em[0] && mid < em[1]);
      let isHit = false,
        isCur = false;
      for (const h of hits) {
        if (mid >= h.m.start && mid < h.m.end) {
          isHit = true;
          if (h.active) isCur = true;
        }
      }
      let cls = "";
      if (isHit) cls = isCur ? "dhit cur" : "dhit";
      else if (isEm) cls = "dem";
      out.push({ text: text.slice(a, z), cls });
    }
    return out;
  }

  // --- search ---------------------------------------------------------------------
  let searchTimer = null;
  function scheduleSearch(value) {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      query = value;
      matchIdx = -1;
      render(); // recomputeMatches() runs inside render()
      if (matches.length) {
        matchIdx = 0;
        render();
      }
    }, 150);
  }

  function recomputeMatches() {
    const mod = M();
    if (!mod || !model || !query) {
      matches = [];
      if (!query) matchIdx = -1;
      return;
    }
    matches = mod.computeMatches(model.hunks, query) || [];
    if (matchIdx >= matches.length) matchIdx = matches.length ? matches.length - 1 : -1;
  }

  function cycleMatch(dir) {
    if (!matches.length) return;
    matchIdx = (matchIdx + dir + matches.length) % matches.length; // wraparound
    render();
  }

  function updateCounter() {
    if (!ui || !ui.counter) return;
    if (!query) {
      ui.counter.textContent = "";
      return;
    }
    ui.counter.textContent = matches.length ? matchIdx + 1 + " of " + matches.length : "0 of 0";
  }

  // Scroll the active hit's element into the middle of the viewport.
  function scrollToActive() {
    if (matchIdx < 0 || !matches.length) return;
    const b = body();
    if (!b) return;
    const el = b.querySelector(".dhit.cur");
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "center" });
  }

  function resetSearch() {
    query = "";
    matches = [];
    matchIdx = -1;
    renderCapped = true;
    if (ui && ui.searchInput) ui.searchInput.value = "";
    if (ui && ui.counter) ui.counter.textContent = "";
  }

  // --- document-level Escape closes the panel when open ----------------------------
  document.addEventListener("keydown", (e) => {
    if (open && e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  // --- badge-only refresh (panel closed): 500 ms debounced, single-flight ----------
  function scheduleBadgeRefresh() {
    if (badgeTimer) clearTimeout(badgeTimer);
    badgeTimer = setTimeout(async () => {
      badgeTimer = null;
      if (badgeInFlight) return; // single-flight: a fetch is already running
      badgeInFlight = true;
      try {
        const url = "/git/changes" + (baseRef ? "?base=" + encodeURIComponent(baseRef) : "");
        const r = await fetch(withSid(url));
        const data = await r.json();
        changes = data;
        if (!data || data.git === false || data.repo === false || data.ok === false) {
          hideBadge();
        } else {
          const files = (data.files || []).length;
          if (files) setBadge(data.truncated ? "500+" : files);
          else hideBadge();
        }
      } catch {
        // leave the badge as-is on a transient failure
      } finally {
        badgeInFlight = false;
      }
    }, 500);
  }

  // --- public surface for app.js --------------------------------------------------
  window.coopDiff = {
    // After an agent turn (or a /chdir repopulate): if the panel is open, refresh
    // the list and reload the open file (a tool may have edited it); if closed, do a
    // debounced, single-flight badge-only fetch so replay bursts collapse to one.
    onAgentEnd() {
      // refreshAll renders the file list + badge AND reloads the open file, in the
      // right order — do NOT add a separate openDiff() here (it would race `gen` and
      // drop the list/badge render; the whole point is they update after each turn).
      if (open) refreshAll();
      else scheduleBadgeRefresh();
    },
    // On __hello (folder may have changed): close the panel and forget everything so
    // a stale repo's file list can never show over a new folder.
    onReset() {
      close();
      changes = null;
      selected = null;
      model = null;
      matches = [];
      matchIdx = -1;
      query = "";
      baseRef = "";
      renderCapped = true;
      if (ui && ui.baseInput) ui.baseInput.value = "";
      if (ui && ui.searchInput) ui.searchInput.value = "";
      if (ui && ui.counter) ui.counter.textContent = "";
      clearBody();
      const rail = filesRail();
      if (rail) rail.textContent = "";
      hideBadge();
    },
  };

  // Wire the toolbar chip. If it isn't in the DOM yet this is simply a no-op.
  const b = btn();
  if (b) b.onclick = toggle;
})();

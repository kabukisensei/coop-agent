// Search the rendered conversation: Pi's transcript search (Ctrl+F on
// Windows). Matches are painted with the CSS Custom Highlight API, so the
// timeline's DOM is never rewritten, and the search runs again whenever the
// timeline redraws while the bar is open.

/** Start offsets of every case-insensitive, non-overlapping match. */
export function matchOffsets(text, query) {
  const offsets = [];
  const needle = String(query || "").toLowerCase();
  if (!needle) return offsets;
  const hay = String(text || "").toLowerCase();
  let index = hay.indexOf(needle);
  while (index >= 0) {
    offsets.push(index);
    index = hay.indexOf(needle, index + needle.length);
  }
  return offsets;
}

/**
 * highlight names the CSS highlights (a pane's search paints its own);
 * fromTop starts at the first match instead of the newest; bodyClass marks
 * the page while the bar is open ("" for none).
 */
export function createFinder({ root, bar, input, count, prev, next, close, onClose, highlight = "coop-find", fromTop = false, bodyClass = "finding" }) {
  const state = { ranges: [], index: -1, timer: 0 };
  const supported = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight === "function";

  function paint() {
    if (!supported) return;
    CSS.highlights.set(highlight, new Highlight(...state.ranges));
    const current = state.ranges[state.index];
    if (current) CSS.highlights.set(`${highlight}-current`, new Highlight(current));
    else CSS.highlights.delete(`${highlight}-current`);
  }

  function show(scroll = true) {
    const total = state.ranges.length;
    count.textContent = input.value.trim() ? (total ? `${state.index + 1} of ${total}` : "No matches") : "";
    paint();
    const current = state.ranges[state.index];
    if (!current || !scroll) return;
    const holder = current.startContainer.parentElement;
    if (!holder) return;
    // A match inside a folded thinking or standards block opens it.
    for (let node = holder.closest("details:not([open])"); node; node = node.parentElement && node.parentElement.closest("details:not([open])")) node.open = true;
    holder.scrollIntoView({ block: "center" });
  }

  function search({ keepIndex = false, scroll = true } = {}) {
    const query = input.value.trim();
    const previous = state.index;
    state.ranges = [];
    if (query) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const start of matchOffsets(node.nodeValue, query)) {
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + query.length);
          state.ranges.push(range);
        }
      }
    }
    // The newest match first, as the terminal searches up from the bottom.
    state.index = state.ranges.length ? (keepIndex && previous >= 0 ? Math.min(previous, state.ranges.length - 1) : fromTop ? 0 : state.ranges.length - 1) : -1;
    show(scroll);
  }

  function step(direction) {
    if (!state.ranges.length) return;
    state.index = (state.index + direction + state.ranges.length) % state.ranges.length;
    show();
  }

  function open() {
    bar.hidden = false;
    if (bodyClass) document.body.classList.add(bodyClass);
    input.focus();
    input.select();
    search();
  }

  function hide() {
    bar.hidden = true;
    if (bodyClass) document.body.classList.remove(bodyClass);
    state.ranges = [];
    state.index = -1;
    if (supported) { CSS.highlights.delete(highlight); CSS.highlights.delete(`${highlight}-current`); }
    if (onClose) onClose();
  }

  input.addEventListener("input", () => search());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hide(); }
    else if (event.key === "Enter" || (event.ctrlKey && event.key.toLowerCase() === "g")) {
      event.preventDefault();
      event.stopPropagation();
      step((event.shiftKey ? 1 : -1) * (fromTop ? -1 : 1));
    }
  });
  prev.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  close.addEventListener("click", hide);

  return {
    open,
    hide,
    search,
    get isOpen() { return !bar.hidden; },
    /** The timeline redrew: find again, keeping the place. */
    refresh() {
      if (bar.hidden) return;
      clearTimeout(state.timer);
      state.timer = setTimeout(() => search({ keepIndex: true, scroll: false }), 150);
    },
  };
}

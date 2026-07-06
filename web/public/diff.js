// coop web — the diff model: the pure, DOM-free half of the Changes panel.
// It parses git's unified-diff text into structured hunks, pairs deleted lines
// with the added lines that replaced them (with cheap intraline emphasis), flattens
// the result into rows for the side-by-side view, and finds search matches.
//
// This file has ZERO document/DOM references on purpose: that is what makes it
// unit-testable in plain Node (`globalThis.window = globalThis; await import(...)`).
// It returns DATA, never HTML — the rendering (and all escaping) lives in
// diffview.js. No dependencies; CSP-clean. It only assigns window.coopDiffModel.
"use strict";
(function () {
  // parseUnifiedDiff(text) -> {binary, hunks:[{header, lines:[Line]}]}
  // Line = {type:"ctx"|"add"|"del", oldNo:number|null, newNo:number|null, text, noNewline?:true}.
  //
  // A small state machine over text.split("\n"). Between hunks we skip git's header
  // noise (diff --git, index, mode/rename lines, ---/+++). "Binary files … differ"
  // flips a flag and yields no hunks. An @@ line opens a hunk and seeds the two
  // running line numbers; inside a hunk we dispatch on the first char. Anything the
  // parser doesn't recognise inside a hunk closes it (tolerates trailing junk).
  function parseUnifiedDiff(text) {
    const hunks = [];
    let binary = false;
    let hunk = null; // the open hunk, or null when we're between hunks
    let oldNo = 0, newNo = 0; // running 1-based line numbers, seeded by @@
    const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

    // Strip ONE trailing "\r" (CRLF working trees). Only one: a line whose real
    // content ends in "\r" would keep the rest.
    const stripCr = (s) => (s.length && s[s.length - 1] === "\r" ? s.slice(0, -1) : s);

    for (const raw of String(text).split("\n")) {
      const m = HUNK.exec(raw);
      if (m) {
        // Open a fresh hunk; the start numbers are the first of each side.
        oldNo = parseInt(m[1], 10);
        newNo = parseInt(m[3], 10);
        hunk = { header: raw, lines: [] };
        hunks.push(hunk);
        continue;
      }
      if (!hunk) {
        // Between hunks: header noise, or the binary marker. Everything else here
        // (diff --git, index, old/new mode, similarity/rename, ---, +++) is skipped.
        if (raw.indexOf("Binary files ") === 0 && raw.indexOf(" differ") !== -1) binary = true;
        continue;
      }
      // Inside a hunk: dispatch on the first char of the raw line.
      const c = raw[0];
      if (c === " ") {
        hunk.lines.push({ type: "ctx", oldNo: oldNo, newNo: newNo, text: stripCr(raw.slice(1)) });
        oldNo++; newNo++;
      } else if (c === "-") {
        hunk.lines.push({ type: "del", oldNo: oldNo, newNo: null, text: stripCr(raw.slice(1)) });
        oldNo++;
      } else if (c === "+") {
        hunk.lines.push({ type: "add", oldNo: null, newNo: newNo, text: stripCr(raw.slice(1)) });
        newNo++;
      } else if (c === "\\") {
        // "\ No newline at end of file" — flag the previous line, emit nothing.
        const prev = hunk.lines[hunk.lines.length - 1];
        if (prev) prev.noNewline = true;
      } else {
        // Unrecognised line closes the hunk; re-test it as between-hunk noise so a
        // binary marker or a fresh @@ that follows immediately is still seen.
        hunk = null;
        if (raw.indexOf("Binary files ") === 0 && raw.indexOf(" differ") !== -1) binary = true;
      }
    }
    return { binary: binary, hunks: hunks };
  }

  // longestCommonPrefix / Suffix — plain char-by-char scans; the cheap alternative
  // to a word diff (O(n), no dependency). Used only for intraline emphasis.
  function commonPrefixLen(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
  }
  // Longest common suffix of the two REMAINDERS (a and b after the shared prefix of
  // length p is removed), so prefix and suffix never overlap: capped at min length
  // of the remainders.
  function commonSuffixLen(a, b, p) {
    const max = Math.min(a.length - p, b.length - p);
    let i = 0;
    while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
    return i;
  }

  // pairAndEmphasize(hunks) -> mutates lines in place, returns hunks.
  // Per hunk: find each maximal run of consecutive dels immediately followed by a
  // run of adds (a "change block"). If the block has ≤200 pairs, pair del[i]↔add[i]
  // for i<min(len) storing the partner's index in .pair, and compute intraline
  // emphasis by prefix/suffix trim (stored as .em=[start,end] on each line).
  function pairAndEmphasize(hunks) {
    for (const h of hunks) {
      const ls = h.lines;
      let i = 0;
      while (i < ls.length) {
        if (ls[i].type !== "del") { i++; continue; }
        // Gather the maximal del run.
        let d0 = i;
        while (i < ls.length && ls[i].type === "del") i++;
        const dels = ls.slice(d0, i);
        // …immediately followed by an add run (else it's a pure deletion — no pairs).
        if (i >= ls.length || ls[i].type !== "add") continue;
        let a0 = i;
        while (i < ls.length && ls[i].type === "add") i++;
        const adds = ls.slice(a0, i);

        const pairs = Math.min(dels.length, adds.length);
        // Guard against pathological blocks: >200 pairs get paired but never
        // emphasised (the O(n) trim per pair is cheap, but skip it in bulk).
        const doEm = pairs <= 200;
        for (let k = 0; k < pairs; k++) {
          const del = dels[k], add = adds[k];
          del.pair = a0 + k;
          add.pair = d0 + k;
          if (doEm) emphasize(del, add);
        }
      }
    }
    return hunks;
  }

  // emphasize(del, add) — sets .em=[start,end) on each line covering only the middle
  // that actually differs (shared prefix and suffix trimmed off). Bails (leaves no
  // .em) when either line is >500 chars, or when the changed fraction is so large
  // (>0.65) that a whole-line rewrite reads better unhighlighted.
  function emphasize(del, add) {
    const A = del.text, B = add.text;
    if (A.length > 500 || B.length > 500) return;
    const p = commonPrefixLen(A, B);
    let s = commonSuffixLen(A, B, p);
    // Guard: prefix + suffix must not exceed the shorter line (they can't overlap).
    const minLen = Math.min(A.length, B.length);
    if (p + s > minLen) s = minLen - p;
    const lenOld = A.length, lenNew = B.length;
    const changed = (lenOld - p - s) + (lenNew - p - s);
    const denom = 2 * Math.max(lenOld, lenNew);
    // denom is 0 only when both lines are empty (nothing changed) — nothing to em.
    if (denom === 0 || changed / denom > 0.65) return;
    del.em = [p, lenOld - s];
    add.em = [p, lenNew - s];
  }

  // buildSplitRows(hunks) -> flat array for the side-by-side view:
  //   {kind:"hunk", header}                     per hunk boundary
  //   {kind:"ctx", oldNo, newNo, text}          context lines
  //   {kind:"pair", left:Line|null, right:Line|null}  del/add blocks, index-paired
  // A del+add block emits max(dels, adds) rows: del[k] on the left, add[k] on the
  // right, null on the shorter side. A pure deletion is dels-with-no-adds (right
  // null); a pure insertion is adds-with-no-dels (left null).
  function buildSplitRows(hunks) {
    const rows = [];
    for (const h of hunks) {
      rows.push({ kind: "hunk", header: h.header });
      const ls = h.lines;
      let i = 0;
      while (i < ls.length) {
        const ln = ls[i];
        if (ln.type === "ctx") {
          rows.push({ kind: "ctx", oldNo: ln.oldNo, newNo: ln.newNo, text: ln.text });
          i++;
          continue;
        }
        // A del/add block: gather the del run then the add run.
        const dels = [], adds = [];
        while (i < ls.length && ls[i].type === "del") { dels.push(ls[i]); i++; }
        while (i < ls.length && ls[i].type === "add") { adds.push(ls[i]); i++; }
        const rowsInBlock = Math.max(dels.length, adds.length);
        for (let k = 0; k < rowsInBlock; k++) {
          rows.push({ kind: "pair", left: dels[k] || null, right: adds[k] || null });
        }
      }
    }
    return rows;
  }

  // computeMatches(hunks, query) -> [{hunkIdx, lineIdx, start, end}]
  // Case-insensitive, non-overlapping indexOf walk over every line's text, in
  // document order. Empty query -> []. Offsets are into the (original-case) text.
  function computeMatches(hunks, query) {
    const out = [];
    const q = String(query || "");
    if (!q) return out;
    const needle = q.toLowerCase();
    const nlen = needle.length;
    for (let hi = 0; hi < hunks.length; hi++) {
      const lines = hunks[hi].lines;
      for (let li = 0; li < lines.length; li++) {
        const hay = String(lines[li].text).toLowerCase();
        let from = 0;
        for (;;) {
          const at = hay.indexOf(needle, from);
          if (at === -1) break;
          out.push({ hunkIdx: hi, lineIdx: li, start: at, end: at + nlen });
          from = at + nlen; // non-overlapping: resume past this match
        }
      }
    }
    return out;
  }

  window.coopDiffModel = { parseUnifiedDiff, pairAndEmphasize, buildSplitRows, computeMatches };
})();

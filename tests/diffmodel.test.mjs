// Unit tests for web/public/diff.js — the pure, DOM-free diff model backing the
// Changes panel. diff.js is a plain browser script (not a module): it assigns
// window.coopDiffModel. We give it a window (globalThis) and import it for its
// side effect, then drive the four functions. Flat t(name, ok) style, matching
// the other suites. Pure — no server spawn.
import { strict as assert } from "node:assert";
globalThis.window = globalThis;
await import(new URL("../web/public/diff.js", import.meta.url));
const { parseUnifiedDiff, pairAndEmphasize, buildSplitRows, computeMatches } = window.coopDiffModel;

let n = 0;
const t = (name, ok) => {
  assert.ok(ok, name);
  n++;
  console.log(`  ✓ ${name}`);
};

// --- parseUnifiedDiff: a hand-written 2-hunk fixture --------------------------
// Header noise (diff --git, index, rename block, ---/+++), two @@ hunks with a
// mix of ctx/add/del, a "\ No newline at end of file" marker, and one content
// line carrying a trailing CRLF "\r" that the parser must strip.
{
  const fixture = [
    "diff --git a/old.txt b/new.txt",
    "similarity index 88%",
    "rename from old.txt",
    "rename to new.txt",
    "index 1234567..89abcde 100644",
    "--- a/old.txt",
    "+++ b/new.txt",
    "@@ -1,3 +1,3 @@",
    " context one\r",       // ctx, carries a trailing \r to strip
    "-removed two",         // del
    "+added two",           // add
    " context three",       // ctx
    "@@ -10,2 +10,3 @@ func()",
    " ten",                 // ctx
    "+eleven added",        // add
    "-old twelve",          // del
    "\\ No newline at end of file", // flags the previous line (the del)
  ].join("\n");
  const { binary, hunks } = parseUnifiedDiff(fixture);

  t("parse: not binary, exactly 2 hunks", binary === false && hunks.length === 2);
  t("parse: hunk headers are the full @@ lines",
    hunks[0].header === "@@ -1,3 +1,3 @@" && hunks[1].header === "@@ -10,2 +10,3 @@ func()");

  const h0 = hunks[0].lines;
  t("parse: hunk-1 line types are ctx/del/add/ctx",
    h0.map((l) => l.type).join(",") === "ctx,del,add,ctx");
  t("parse: trailing \\r stripped from content", h0[0].text === "context one");
  // Numbering seeded by @@ -1,3 +1,3 @@: ctx advances both, del advances old only,
  // add advances new only.
  t("parse: ctx line numbered on both sides", h0[0].oldNo === 1 && h0[0].newNo === 1);
  t("parse: del line has oldNo, null newNo", h0[1].type === "del" && h0[1].oldNo === 2 && h0[1].newNo === null);
  t("parse: add line has newNo, null oldNo", h0[2].type === "add" && h0[2].newNo === 2 && h0[2].oldNo === null);
  t("parse: ctx after a del/add advances past both", h0[3].oldNo === 3 && h0[3].newNo === 3);

  const h1 = hunks[1].lines;
  // @@ -10,2 +10,3 @@ : ctx at 10/10, add at newNo 11, del at oldNo 11.
  t("parse: hunk-2 numbering seeded from @@ -10 +10",
    h1[0].oldNo === 10 && h1[0].newNo === 10 && h1[1].newNo === 11 && h1[2].oldNo === 11);
  t("parse: \\ No newline flags the previous line only",
    h1[2].noNewline === true && h1[0].noNewline === undefined && h1[1].noNewline === undefined);
}

// --- parseUnifiedDiff: binary --------------------------------------------------
{
  const { binary, hunks } = parseUnifiedDiff(
    "diff --git a/x b/x\nindex 111..222\nBinary files a/x and b/x differ\n"
  );
  t("parse: binary marker -> binary:true, no hunks", binary === true && hunks.length === 0);
}

// --- pairAndEmphasize: pairing by index ---------------------------------------
{
  const { hunks } = parseUnifiedDiff(
    ["@@ -1,3 +1,3 @@", "-aaa", "-bbb", "+aaX", "+bbY", " keep"].join("\n")
  );
  pairAndEmphasize(hunks);
  const ls = hunks[0].lines; // del,del,add,add,ctx
  t("pair: del[i] partners add[i] by index",
    ls[0].pair === 2 && ls[1].pair === 3 && ls[2].pair === 0 && ls[3].pair === 1);
  t("pair: paired lines get an .em range", Array.isArray(ls[0].em) && Array.isArray(ls[2].em));
}

// A change block with 201 del/add pairs gets paired but NO emphasis (>200 bail).
{
  const lines = ["@@ -1,201 +1,201 @@"];
  for (let i = 0; i < 201; i++) lines.push("-line " + i + " old");
  for (let i = 0; i < 201; i++) lines.push("+line " + i + " new");
  const { hunks } = parseUnifiedDiff(lines.join("\n"));
  pairAndEmphasize(hunks);
  const ls = hunks[0].lines;
  t("pair: a 201-pair block is still paired", ls[0].pair === 201 && ls[201].pair === 0);
  t("pair: a 201-pair block gets NO .em (bail over 200 pairs)",
    ls.every((l) => l.em === undefined));
}

// --- emphasis: prefix/suffix trim ---------------------------------------------
{
  // "const x = 1;" vs "const x = 2;" — only the digit differs. Shared prefix is
  // "const x = " (10 chars), shared suffix is ";" (1 char) -> em covers [10,11).
  const { hunks } = parseUnifiedDiff(
    ["@@ -1 +1 @@", "-const x = 1;", "+const x = 2;"].join("\n")
  );
  pairAndEmphasize(hunks);
  const [del, add] = hunks[0].lines;
  t("emphasis: em range covers only the differing digit",
    del.em[0] === 10 && del.em[1] === 11 && add.em[0] === 10 && add.em[1] === 11 &&
    del.text.slice(del.em[0], del.em[1]) === "1" && add.text.slice(add.em[0], add.em[1]) === "2");
}
{
  // "aaa" vs "aa" — the whole of "aa" is both a valid prefix AND suffix; the guard
  // (p + s ≤ min length) must clamp so the em range stays sane (non-negative,
  // start ≤ end) rather than double-counting the overlap.
  const { hunks } = parseUnifiedDiff(["@@ -1 +1 @@", "-aaa", "+aa"].join("\n"));
  pairAndEmphasize(hunks);
  const [del, add] = hunks[0].lines;
  t("emphasis: identical prefix/suffix overlap is guarded (ranges stay valid)",
    del.em[0] <= del.em[1] && add.em[0] <= add.em[1] &&
    del.em[0] >= 0 && add.em[0] >= 0 && del.em[1] <= del.text.length && add.em[1] <= add.text.length);
}
{
  // >500-char line -> no emphasis at all.
  const big = "x".repeat(600);
  const { hunks } = parseUnifiedDiff(["@@ -1 +1 @@", "-" + big + "1", "+" + big + "2"].join("\n"));
  pairAndEmphasize(hunks);
  const [del, add] = hunks[0].lines;
  t("emphasis: >500-char line bails (no .em)", del.em === undefined && add.em === undefined && del.pair === 1);
}
{
  // Changed fraction >0.65 -> no emphasis (whole-line rewrite reads better plain).
  // "abcdefghij" vs "abZZZZZZZZ": shared prefix "ab" (2), no shared suffix; changed
  // = 8 + 8 = 16, denom = 2*10 = 20, ratio 0.8 > 0.65.
  const { hunks } = parseUnifiedDiff(
    ["@@ -1 +1 @@", "-abcdefghij", "+abZZZZZZZZ"].join("\n")
  );
  pairAndEmphasize(hunks);
  const [del, add] = hunks[0].lines;
  t("emphasis: >0.65 changed-ratio bails (no .em)", del.em === undefined && add.em === undefined);
}

// --- buildSplitRows -----------------------------------------------------------
{
  // 2 dels + 1 add -> max(2,1) = 2 pair rows; the second row's right cell is null.
  // Plus the hunk separator row and a trailing ctx.
  const { hunks } = parseUnifiedDiff(
    ["@@ -1,3 +1,2 @@", "-one", "-two", "+ONE", " three"].join("\n")
  );
  pairAndEmphasize(hunks);
  const rows = buildSplitRows(hunks);
  t("buildSplitRows: a hunk separator row is present",
    rows[0].kind === "hunk" && rows[0].header === "@@ -1,3 +1,2 @@");
  const pairRows = rows.filter((r) => r.kind === "pair");
  t("buildSplitRows: 2 dels + 1 add -> 2 pair rows", pairRows.length === 2);
  t("buildSplitRows: first pair has both sides",
    pairRows[0].left && pairRows[0].left.text === "one" && pairRows[0].right && pairRows[0].right.text === "ONE");
  t("buildSplitRows: second pair's right cell is null",
    pairRows[1].left && pairRows[1].left.text === "two" && pairRows[1].right === null);
  t("buildSplitRows: ctx rows carry both numbers and text",
    rows.some((r) => r.kind === "ctx" && r.text === "three" && r.oldNo === 3 && r.newNo === 2));
}

// --- computeMatches -----------------------------------------------------------
{
  const { hunks } = parseUnifiedDiff(
    ["@@ -1,2 +1,2 @@", " Foo foo FOO", "+the food is foo"].join("\n")
  );
  const empty = computeMatches(hunks, "");
  t("computeMatches: empty query -> []", Array.isArray(empty) && empty.length === 0);

  const m = computeMatches(hunks, "foo");
  // Case-insensitive: "Foo foo FOO" has 3 hits at 0/4/8; "the food is foo" has 2
  // (non-overlapping) at 4 and 12. Document order: line 0 first, then line 1.
  t("computeMatches: case-insensitive, all occurrences found", m.length === 5);
  t("computeMatches: document order (line 0 before line 1)",
    m[0].lineIdx === 0 && m[1].lineIdx === 0 && m[2].lineIdx === 0 && m[3].lineIdx === 1 && m[4].lineIdx === 1);
  t("computeMatches: offsets are correct and non-overlapping",
    m[0].start === 0 && m[0].end === 3 && m[1].start === 4 && m[2].start === 8 &&
    m[3].start === 4 && m[4].start === 12);
}
{
  // Non-overlapping specifically: "aaaa" searched for "aa" -> 2 matches (0-2, 2-4),
  // not 3 (an overlapping walk would also find 1-3).
  const { hunks } = parseUnifiedDiff(["@@ -1 +1 @@", " aaaa"].join("\n"));
  const m = computeMatches(hunks, "aa");
  t("computeMatches: non-overlapping walk", m.length === 2 && m[0].start === 0 && m[1].start === 2);
}

console.log(`  ${n} diff model tests passed`);
process.exit(0);

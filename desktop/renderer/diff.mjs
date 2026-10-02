// Pi's edit tool returns a numbered diff in result.details.diff:
// "+12 new line", "-12 old line", " 12 context", and "     ..." for a skip
// (Pi 0.87.1 core/tools/edit-diff.js generateDiffString). Pure.

const LINE = /^([+\- ])( *\d*) (.*)$/;

/** Parse Pi's diff text into rows: { kind: add|del|ctx|skip, line, text }. */
export function parseEditDiff(diff) {
  if (typeof diff !== "string" || !diff) return [];
  return diff.split("\n").map((raw) => {
    if (/^ +\.\.\.$/.test(raw)) return { kind: "skip", line: "", text: "..." };
    const match = LINE.exec(raw);
    if (!match) return { kind: "ctx", line: "", text: raw };
    const kind = match[1] === "+" ? "add" : match[1] === "-" ? "del" : "ctx";
    return { kind, line: match[2].trim(), text: match[3] };
  });
}

/** Lines added and removed, for the tool card's header. */
export function diffStats(rows) {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === "add") added += 1;
    else if (row.kind === "del") removed += 1;
  }
  return { added, removed };
}

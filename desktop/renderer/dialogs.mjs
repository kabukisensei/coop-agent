// How the window reads the text an extension puts in a confirm, select or
// input dialog (desktop UX review, 2026-10-03). coop-guardrails writes the
// command or SQL being approved on lines indented with two spaces and ends
// with a question; @juicesharp/rpiv-ask-user-question's RPC fallback numbers
// its options ("1. Label — description") and asks for multi-select answers as
// comma-separated numbers. Both are read here into shapes app.mjs can draw as
// cards; anything else falls through unchanged (null). The answers sent back
// are exactly the strings the extension offered, so a mirrored dialog (plan
// row M1) sees the same values.

/**
 * A confirm message as blocks: `{ blocks: [{ kind: "text" | "code", text }], question }`.
 * Indented lines become one code block; a last line ending in "?" is the question.
 */
export function parseConfirm(message) {
  const lines = String(message || "").replace(/\r\n/g, "\n").split("\n");
  let question = "";
  if (lines.length > 1 && /\?\s*$/.test(lines[lines.length - 1]) && !/^\s{2,}/.test(lines[lines.length - 1])) question = lines.pop().trim();
  const blocks = [];
  for (const line of lines) {
    const code = /^\s{2,}\S/.test(line);
    const kind = code ? "code" : "text";
    const text = code ? line.replace(/^\s{2}/, "") : line;
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind) last.text += `\n${text}`;
    else blocks.push({ kind, text });
  }
  for (const block of blocks) block.text = block.text.replace(/^\n+|\n+$/g, "");
  return { blocks: blocks.filter((block) => block.text.trim()), question };
}

/** Labels for the two buttons: the verb the question asks for, and a plain No. */
export function confirmLabels({ title = "", question = "", message = "" } = {}) {
  const q = question || message;
  let yes = "Yes";
  if (/\brun (it|them|this)\?$/i.test(q.trim())) yes = "Run it";
  else if (/\b(allow|approve|grant)\b.*\?$/i.test(q.trim())) yes = "Allow";
  else if (/\b(save|write|overwrite)\b.*\?$/i.test(q.trim())) yes = "Save it";
  else if (/\b(continue|proceed)\b.*\?$/i.test(q.trim())) yes = "Continue";
  const risky = /guardrail/i.test(title) || /destructive|mutat|\bDDL\b|\bdelete|\bdrop\b|\bwrite\b|production|\brm -rf/i.test(message);
  return { yes, no: "No", risky };
}

const OPTION = /^(\d+)\.\s+(.+?)(?:\s+—\s+([\s\S]*))?$/;
const OTHER = /^(\d+)\.\s+(Type something\.?|I'll type it myself)\s*$/i;

/**
 * An ask_user_question select, as its RPC fallback sends it: `[Header] question`
 * and options "1. Label — description" with a final "N. Type something." row.
 * Returns `{ header, question, previews, options: [{ value, label, description, other }] }`
 * or null when the options are not numbered that way.
 */
export function parseQuestionSelect(title, options) {
  const list = Array.isArray(options) ? options.map(String) : [];
  if (list.length < 2) return null;
  const parsed = list.map((option) => {
    const other = OTHER.exec(option);
    if (other) return { value: option, label: other[2], description: "", other: true };
    const match = OPTION.exec(option);
    return match ? { value: option, label: match[2], description: (match[3] || "").trim(), other: false } : null;
  });
  if (parsed.some((item) => !item)) return null;
  if (parsed.some((item, index) => Number(OPTION.exec(item.value)[1]) !== index + 1)) return null;
  if (!parsed.some((item) => !item.other && item.description)) return null;
  const text = String(title || "");
  const header = (/^\[([^\]]{1,32})\]\s*/.exec(text) || [])[1] || "";
  const rest = header ? text.replace(/^\[[^\]]{1,32}\]\s*/, "") : text;
  const [question, ...previews] = rest.split(/\n\n(?=--- \d+\. )/);
  return { header, question: question.trim(), previews: previews.map((p) => p.trim()), options: parsed };
}

const MULTI_HINT = /Enter the numbers of all that apply/i;

/**
 * An ask_user_question multi-select, which the RPC fallback asks as an input:
 * the question, a numbered list and the "Enter the numbers..." line. Returns
 * `{ header, question, options: [{ index, label, description }], hint }` or null.
 */
export function parseQuestionMulti(title) {
  const text = String(title || "").replace(/\r\n/g, "\n");
  if (!MULTI_HINT.test(text)) return null;
  const parts = text.split("\n\n");
  if (parts.length < 3) return null;
  const hint = parts.pop().trim();
  const options = parts.pop().split("\n").map((line) => OPTION.exec(line.trim())).map((match, index) => (match && Number(match[1]) === index + 1 ? { index: index + 1, label: match[2], description: (match[3] || "").trim() } : null));
  if (options.length < 2 || options.some((option) => !option)) return null;
  const head = parts.join("\n\n");
  const header = (/^\[([^\]]{1,32})\]\s*/.exec(head) || [])[1] || "";
  return { header, question: head.replace(/^\[[^\]]{1,32}\]\s*/, "").trim(), options, hint };
}

/** The answer a multi-select card sends: the chosen numbers, or the typed text. */
export function multiAnswer(selected, typed) {
  const text = String(typed || "").trim();
  if (text) return text;
  return [...selected].sort((a, b) => a - b).join(",");
}

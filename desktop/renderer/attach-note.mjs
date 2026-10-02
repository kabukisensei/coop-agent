// The lines added to a message for its attached files. Images go to the model
// as images; every other file is named by path so coop reads it with its own
// read tool, under the same guardrails as any file in the folder.

export const NOTE_HEAD = "Attached files (read each one with the read tool before answering):";

/** The block appended to the prompt text; "" when nothing needs a path. */
export function attachmentNote(files) {
  const lines = [];
  for (const file of files) {
    if (file.kind === "text") lines.push(`- ${file.name}: ${file.ref}`);
    else if (file.kind === "office" || file.kind === "pdf") lines.push(`- ${file.name} (${file.label}, ${file.detail}${file.truncated ? "; the text was cut at coop's limit" : ""}): ${file.ref}`);
  }
  if (!lines.length) return "";
  return `\n\n${NOTE_HEAD}\n${lines.join("\n")}`;
}

/**
 * A sent message split back into what the person typed and the files the
 * note names, for the conversation view (the session keeps the whole text).
 * Returns { text, files: [{ name, detail, ref }] }; a line the note did not
 * write stays in the text.
 */
export function splitAttachmentNote(text) {
  const source = String(text || "");
  const at = source.lastIndexOf(`\n\n${NOTE_HEAD}\n`);
  if (at < 0) return { text: source, files: [] };
  const files = [];
  for (const line of source.slice(at + NOTE_HEAD.length + 3).split("\n")) {
    const split = line.lastIndexOf(": ");
    if (!line.startsWith("- ") || split < 2) return { text: source, files: [] };
    const head = line.slice(2, split);
    const ref = line.slice(split + 2);
    const detail = /\(([^()]*)\)$/.exec(head);
    files.push({ name: detail ? head.slice(0, detail.index).trimEnd() : head, detail: detail ? detail[1] : "", ref });
  }
  return { text: source.slice(0, at), files };
}

// Pi's RPC stream is one JSON object per line. Split on "\n" only and strip a
// trailing "\r": Node's readline also splits on U+2028/U+2029, which can appear
// inside JSON strings and would corrupt a message (docs/history/ui-strategy.md).
import { StringDecoder } from "node:string_decoder";

export class JsonlSplitter {
  constructor(onLine, { maxLine = 64 * 1024 * 1024 } = {}) {
    this.onLine = onLine;
    this.maxLine = maxLine;
    this.buffer = "";
    // A chunk can end inside a multi-byte UTF-8 character.
    this.decoder = new StringDecoder("utf8");
  }

  push(chunk) {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) this.onLine(line);
    }
    if (this.buffer.length > this.maxLine) {
      this.buffer = "";
      throw new Error("Pi sent a line longer than the desktop accepts.");
    }
  }

  flush() {
    let line = this.buffer + this.decoder.end();
    this.buffer = "";
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line) this.onLine(line);
  }
}

export function encodeLine(value) {
  return JSON.stringify(value) + "\n";
}

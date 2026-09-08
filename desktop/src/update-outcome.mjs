import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";

const busy = new Set();
const sameFile = (left, right) => left.isFile() && !left.isSymbolicLink()
  && left.dev === right.dev && left.ino === right.ino
  && left.mtimeMs === right.mtimeMs && left.size === right.size;

// This file is informational, never an authority for launching or restoring an
// app. Display only fixed copy; do not surface arbitrary text from user data.
export async function presentUpdateOutcome({ userData, currentVersion, show }) {
  const path = join(userData, "update-result.json");
  if (busy.has(path)) return false;
  busy.add(path);
  let handle;
  try {
    // O_NOFOLLOW is unavailable on Windows. Check the directory entry as well
    // as the opened handle, including after the read and before consuming it.
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 4096) return false;
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!sameFile(entry, stat)) return false;
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096 || !sameFile(await lstat(path), stat)) return false;
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    let options;
    if (value?.status === "healthy" && value.version === currentVersion) {
      options = { type: "info", title: "Coop Desktop updated", message: "Update installed",
        detail: `Coop Desktop ${currentVersion} is ready.`, buttons: ["Continue"], defaultId: 0 };
    } else if (value?.status === "failed") {
      options = { type: "warning", title: "Coop Desktop update", message: "The update could not finish",
        detail: "Coop Desktop has reopened. You can continue working and try again from Help → Check for Updates.",
        buttons: ["Continue"], defaultId: 0 };
    } else return false;
    await show(options);
    // A newer helper result must not be consumed by an older dialog.
    if (sameFile(await lstat(path), stat)) await unlink(path);
    return true;
  } catch { return false; }
  finally { await handle?.close(); busy.delete(path); }
}

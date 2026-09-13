// Desktop stores navigation references only. Runtime/Pi retain session ownership,
// content, path validation and all write-access decisions.
import { isAbsolute, win32 } from "node:path";

export const MAX_SAVED_CHATS = 8;
export function normalizeSavedChat(value) {
  if (!value || typeof value.cwd !== "string" || value.cwd.length > 4096 || /[\0\r\n]/.test(value.cwd)
    || (!isAbsolute(value.cwd) && !win32.isAbsolute(value.cwd))) return null;
  if (value.file !== null && (typeof value.file !== "string" || value.file.length > 255 || !/^[A-Za-z0-9._-]+\.jsonl$/.test(value.file))) return null;
  if (!["write", "read-only"].includes(value.access)) return null;
  return { cwd: value.cwd, file: value.file, access: value.access };
}
export function normalizeSavedChats(values) {
  if (!Array.isArray(values)) return [];
  // Empty chats can legitimately share a workspace; retain their positions.
  return values.slice(0, MAX_SAVED_CHATS).map(normalizeSavedChat).filter(Boolean);
}

export async function restoreSavedChats({ entries, activeIndex = 0, create, resume, close }) {
  const saved = normalizeSavedChats(entries);
  const restored = [], failures = [];
  for (let index = 0; index < saved.length; index++) {
    const entry = saved[index];
    let sid = null;
    try {
      const created = await create({ cwd: entry.cwd, workspaceAccess: entry.access });
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(created?.sid || "")) throw new Error("Runtime did not confirm the restored chat.");
      sid = created.sid;
      if (entry.file) await resume({ sid, workspace: entry.cwd, file: entry.file });
      restored.push({ sid, entry, index });
    } catch (error) {
      // Failed attempts must not consume chat capacity. Never discard references.
      if (sid) {
        try { await close({ sid }); }
        catch {
          for (let remaining = index; remaining < saved.length; remaining++) {
            failures.push({ entry: saved[remaining], index: remaining, error: "An incomplete chat could not be closed. Close it before retrying." });
          }
          break;
        }
      }
      failures.push({ entry, index, error: error?.message || "This chat could not be reopened." });
    }
  }
  return { restored, failures, activeSid: restored.find(item => item.index === activeIndex)?.sid || restored[0]?.sid || null };
}

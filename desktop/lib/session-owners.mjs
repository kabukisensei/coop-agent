// Several sessions at once: one coop window per session, each with its own Pi
// (as the terminal runs one coop per console). Two Pi processes writing one
// session file would interleave its entries, so a saved session is open in at
// most one window: switching to a session another window holds brings that
// window forward instead. Plain functions over the main process's window
// states, so tests can run them without Electron.

/** Windows paths compare without case and with either slash. */
export function sameSessionPath(a, b, platform = process.platform) {
  if (!a || !b) return false;
  if (platform !== "win32") return a === b;
  const norm = (p) => String(p).replace(/\//g, "\\").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The other window state whose session is `path`, or null. Each state carries
 * the session file it last reported (`sessionFile`); a window whose Pi has
 * exited holds nothing.
 */
export function ownerOf(states, self, path, platform = process.platform) {
  for (const state of states) {
    if (state === self || !state.pi || state.pi.exited) continue;
    if (sameSessionPath(state.sessionFile, path, platform)) return state;
  }
  return null;
}

/** The saved sessions with `openElsewhere` set on those another window holds. */
export function markOpenElsewhere(sessions, states, self, platform = process.platform) {
  const all = [...states]; // an iterator (a Map's values) runs out after one pass
  return sessions.map((session) => (ownerOf(all, self, session.path, platform) ? { ...session, openElsewhere: true } : session));
}

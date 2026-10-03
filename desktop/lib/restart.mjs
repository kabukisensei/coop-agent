// One restart at a time per window (#286). Two restart requests that overlap
// (the palette reopened during the shutdown, a double click) used to each await
// the old Pi and each start a replacement: the second overwrote the window's
// Pi, so the first replacement ran on, unseen, until the app quit. The main
// process coalesces them here, so UI debouncing is never what keeps a hidden
// Pi from starting.

/**
 * Run `run` unless a restart is already in flight for `state`; a request that
 * arrives meanwhile gets that restart's promise instead of a second run.
 * `state.restarting` holds the pending promise and clears when it settles.
 */
export function restartOnce(state, run) {
  if (state.restarting) return state.restarting;
  const pending = Promise.resolve().then(run).finally(() => {
    if (state.restarting === pending) state.restarting = null;
  });
  state.restarting = pending;
  return pending;
}

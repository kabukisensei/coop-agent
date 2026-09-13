// Backpressure is per client. A slow renderer must not pause Pi or other clients.
const writers = new WeakMap();
export const SSE_BUFFER_BYTES = 32 * 1024 * 1024;

export function writeSse(res, frame, maxBytes = SSE_BUFFER_BYTES) {
  let state = writers.get(res);
  if (!state) {
    state = { queue: [], bytes: 0, waiting: false, closed: false };
    writers.set(res, state);
    res.once("close", () => { state.closed = true; state.queue.length = 0; state.bytes = 0; });
  }
  const close = () => {
    state.closed = true;
    state.queue.length = 0;
    state.bytes = 0;
    res.destroy();
    return false;
  };
  if (state.closed || res.destroyed || res.writableEnded) return false;
  const bytes = Buffer.byteLength(frame);
  if (bytes + state.bytes + (res.writableLength || 0) > maxBytes) return close();
  const flush = () => {
    state.waiting = false;
    if (state.closed || res.destroyed) return;
    try {
      while (state.queue.length) {
        const next = state.queue.shift();
        state.bytes -= next.bytes;
        if (!res.write(next.frame)) {
          state.waiting = true;
          res.once("drain", flush);
          return;
        }
      }
    } catch { close(); }
  };
  state.queue.push({ frame, bytes });
  state.bytes += bytes;
  if (!state.waiting) flush();
  return !state.closed;
}

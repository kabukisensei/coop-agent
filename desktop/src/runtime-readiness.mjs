// Only read-only startup probes may be retried. Never replay an agent command.
export async function waitForRuntimeState(rpc, sid, { isCurrent = () => true, attempts = 3 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!isCurrent()) throw new Error("Agent startup was interrupted.");
    try {
      const reply = await rpc({ type: "get_state", sid });
      if (!isCurrent()) throw new Error("Agent startup was interrupted.");
      return reply;
    } catch (error) {
      if (!isCurrent() || error.status !== 504 || attempt === attempts - 1) throw error;
    }
  }
}

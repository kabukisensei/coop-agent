// Project Pi's public active-branch messages without losing tool evidence.
// Matching results requires a pre-scan: they follow their assistant tool calls.
export const REPLAY_THINKING_MAX = 8000;
export const REPLAY_TOOL_OUT_MAX = 6000;
const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
const clipOutput = output => output.length > REPLAY_TOOL_OUT_MAX
  ? output.slice(0, REPLAY_TOOL_OUT_MAX) + `\n… (${output.length - REPLAY_TOOL_OUT_MAX} more chars)` : output;

export function projectTranscriptMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const results = new Map();
  for (const message of messages) {
    if (message?.role === 'toolResult' && typeof message.toolCallId === 'string') {
      results.set(message.toolCallId, { output: clipOutput(textOf(message.content)), isError: message.isError === true });
    }
  }
  const events = [];
  for (const message of messages) {
    if (message?.role === 'user') {
      const text = textOf(message.content);
      if (text.trim()) events.push({ type: '__replay', role: 'user', text });
    } else if (message?.role === 'assistant') {
      const parts = [];
      const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
      for (const block of Array.isArray(blocks) ? blocks : []) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text) parts.push({ kind: 'text', text: block.text });
        else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) parts.push({ kind: 'thinking', text: block.thinking.slice(0, REPLAY_THINKING_MAX) });
        else if (block?.type === 'toolCall') {
          const result = results.get(block.id);
          parts.push({ kind: 'tool', name: block.name || 'tool', args: block.arguments,
            output: result?.output || '', isError: result?.isError || false, incomplete: !result });
        }
      }
      if (parts.length) events.push({ type: '__replay', role: 'assistant', parts });
    }
  }
  return events;
}

// The running Pi session is the authority for selection, including an interior
// entry or the empty root. Timestamps and physical file order never pick a branch.
export function selectSessionChain(entries, leafId) {
  if (!Array.isArray(entries) || (leafId !== null && (typeof leafId !== 'string' || !leafId))) return null;
  const byId = new Map(), referenced = new Set();
  for (const entry of entries) {
    if (!entry || entry.type === 'session' || typeof entry.id !== 'string') continue;
    if (byId.has(entry.id)) return null;
    byId.set(entry.id, entry);
    if (entry.parentId != null) referenced.add(entry.parentId);
  }
  const branched = [...byId.keys()].filter(id => !referenced.has(id)).length > 1;
  const chain = [], seen = new Set();
  let id = leafId;
  while (id !== null) {
    if (seen.has(id) || !byId.has(id)) return null;
    seen.add(id);
    const entry = byId.get(id);
    chain.push(entry);
    id = entry.parentId ?? null;
  }
  return { chain: chain.reverse(), branched };
}

// Coop Runtime adapter for Pi 0.84.3 existing-branch navigation.
//
// Pi exposes AgentSession.navigateTree() and ExtensionCommandContext.navigateTree(),
// but its 0.84.3 RPC command union does not expose that operation. The runtime
// therefore invokes one narrowly scoped Coop extension command. The extension
// calls Pi's public API and reports a correlated result through its supported RPC
// UI event stream. No session JSONL is read, rewritten, or synthesized here.

const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const RESULT_KEY_PREFIX = "coop-tree-navigate:";

function fail(error) {
  return { ok: false, error };
}

function optionalString(body, name, max) {
  if (body?.[name] === undefined) return { ok: true, value: undefined };
  if (typeof body[name] !== "string" || !body[name] || body[name].length > max || body[name].includes("\0")) {
    return fail(`${name} must be a non-empty string no longer than ${max} characters`);
  }
  return { ok: true, value: body[name] };
}

export function buildTreeNavigationInvocation(body, { requestId, secret } = {}) {
  if (!body || typeof body !== "object") return fail("navigation request is required");
  if (typeof body.entryId !== "string" || !ENTRY_ID.test(body.entryId)) return fail("entryId is invalid");
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return fail("requestId is invalid");
  if (typeof secret !== "string" || secret.length < 16 || secret.length > 200) return fail("runtime bridge secret is invalid");
  if (body.summarize !== undefined && typeof body.summarize !== "boolean") return fail("summarize must be a boolean");
  if (body.replaceInstructions !== undefined && typeof body.replaceInstructions !== "boolean") {
    return fail("replaceInstructions must be a boolean");
  }
  const custom = optionalString(body, "customInstructions", 10_000);
  if (!custom.ok) return custom;
  const label = optionalString(body, "label", 200);
  if (!label.ok) return label;
  if (body.replaceInstructions === true && custom.value === undefined) {
    return fail("replaceInstructions requires customInstructions");
  }

  const payload = {
    requestId,
    bridgeSecret: secret,
    targetId: body.entryId,
    summarize: body.summarize === true,
  };
  if (custom.value !== undefined) payload.customInstructions = custom.value;
  if (body.replaceInstructions !== undefined) payload.replaceInstructions = body.replaceInstructions;
  if (label.value !== undefined) payload.label = label.value;

  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return {
    ok: true,
    requestId,
    command: { type: "prompt", message: `/coop-tree-navigate ${encoded}` },
  };
}

export function parseTreeNavigationResultEvent(event) {
  if (!event || event.type !== "extension_ui_request" || event.method !== "setStatus") return null;
  if (typeof event.statusKey !== "string" || !event.statusKey.startsWith(RESULT_KEY_PREFIX)) return null;
  const requestId = event.statusKey.slice(RESULT_KEY_PREFIX.length);
  if (!REQUEST_ID.test(requestId) || typeof event.statusText !== "string") return null;
  let result;
  try { result = JSON.parse(event.statusText); } catch { return null; }
  if (!result || typeof result !== "object" || result.requestId !== requestId) return null;
  if (typeof result.cancelled !== "boolean" || typeof result.targetId !== "string") return null;
  if (result.error !== undefined && typeof result.error !== "string") return null;
  if (result.editorText !== undefined && typeof result.editorText !== "string") return null;
  if (result.previousLeafId !== undefined && result.previousLeafId !== null && typeof result.previousLeafId !== "string") return null;
  if (result.currentLeafId !== undefined && result.currentLeafId !== null && typeof result.currentLeafId !== "string") return null;
  return { requestId, result };
}

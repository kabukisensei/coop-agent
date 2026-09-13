// Shell-neutral terminal handoff contract. The runtime prepares only a fixed,
// allowlisted `coop [--session <jailed path>]` launch request; the Desktop shell
// owns the OS-specific terminal application and never accepts an arbitrary command.

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const MODES = new Set(["open", "clone", "move"]);

function fail(error) {
  return { ok: false, error };
}

export function validateTerminalHandoffRequest(body) {
  if (!body || typeof body !== "object" || !MODES.has(body.mode)) {
    return fail("mode must be one of: open, clone, move");
  }
  return { ok: true, mode: body.mode };
}

export function buildTerminalLaunchRequest({ handoffId, mode, cwd, sessionPath } = {}) {
  if (typeof handoffId !== "string" || !REQUEST_ID.test(handoffId)) return fail("handoffId is invalid");
  if (!MODES.has(mode)) return fail("handoff mode is invalid");
  if (typeof cwd !== "string" || !cwd || cwd.includes("\0")) return fail("handoff cwd is invalid");
  if (mode !== "open" && (typeof sessionPath !== "string" || !sessionPath.endsWith(".jsonl") || sessionPath.includes("\0"))) {
    return fail("handoff session path is invalid");
  }
  return {
    ok: true,
    launch: {
      schemaVersion: 1,
      kind: "native-terminal",
      handoffId,
      mode,
      cwd,
      executable: "coop",
      args: mode === "open" ? [] : ["--session", sessionPath],
    },
  };
}

export function buildRuntimeShutdownInvocation({ requestId, secret } = {}) {
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return fail("requestId is invalid");
  if (typeof secret !== "string" || secret.length < 16 || secret.length > 200) return fail("runtime control secret is invalid");
  const encoded = Buffer.from(JSON.stringify({ requestId, bridgeSecret: secret }), "utf8").toString("base64url");
  return { ok: true, command: { type: "prompt", message: `/coop-runtime-shutdown ${encoded}` } };
}

// Strict renderer-to-Pi command adapter. Browser/Desktop input is untrusted:
// construct each supported Pi 0.84.3 command field-by-field and reject invalid
// values instead of spreading request bodies into the governed agent process.

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const QUEUE_MODES = new Set(["all", "one-at-a-time"]);
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;

// Pi's model-list RPC reads a snapshot. Its public extension API can refresh
// that snapshot after the separate login process saves credentials. Check that
// the command exists first: an unknown slash command must never become a prompt.
export async function listAvailableModels(rpc) {
  const commands = await rpc({ type: "get_commands" });
  if (!commands) return null;
  if (commands.success && commands.data?.commands?.some(command => command.name === "coop-refresh-models")) {
    const refreshed = await rpc({ type: "prompt", message: "/coop-refresh-models" });
    if (!refreshed) return null;
    if (!refreshed.success) return { ...refreshed, command: "get_available_models" };
  }
  return rpc({ type: "get_available_models" });
}

export const IMAGE_INPUT_LIMITS = Object.freeze({
  mimeTypes: Object.freeze([...IMAGE_MIME_TYPES]),
  maxImages: MAX_IMAGES,
  maxImageBytes: MAX_IMAGE_BYTES,
  maxTotalImageBytes: MAX_TOTAL_IMAGE_BYTES,
});

function fail(error) {
  return { ok: false, error };
}

function stringField(body, name, { max = 10000, trim = false } = {}) {
  if (typeof body?.[name] !== "string") return null;
  const value = trim ? body[name].trim() : body[name];
  if (!value || value.length > max || value.includes("\0")) return null;
  return value;
}

export function sanitizeImages(value) {
  if (value === undefined) return { ok: true, images: undefined };
  if (!Array.isArray(value) || value.length > MAX_IMAGES) {
    return fail(`images must be an array of at most ${MAX_IMAGES} items`);
  }
  let total = 0;
  const images = [];
  for (const image of value) {
    if (!image || image.type !== "image" || !IMAGE_MIME_TYPES.has(image.mimeType) || typeof image.data !== "string") {
      return fail("each image must contain type=image, a supported mimeType, and base64 data");
    }
    if (!image.data || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
      return fail("image data must be canonical base64 without a data-URL prefix");
    }
    const bytes = Buffer.from(image.data, "base64").length;
    if (bytes <= 0 || bytes > MAX_IMAGE_BYTES) return fail("each decoded image must be 4 MiB or smaller");
    total += bytes;
    if (total > MAX_TOTAL_IMAGE_BYTES) return fail("decoded images must total 8 MiB or less");
    images.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  return { ok: true, images };
}

export function buildRpcCommand(body, { resolveSessionPath = () => null } = {}) {
  if (!body || typeof body !== "object" || typeof body.type !== "string") return fail("command type is required");
  const type = body.type;
  const command = { type };

  switch (type) {
    case "new_session":
    case "get_state":
    case "cycle_model":
    case "get_available_models":
    case "cycle_thinking_level":
    case "get_available_thinking_levels":
    case "set_auto_compaction":
    case "set_auto_retry":
    case "abort_retry":
    case "get_session_stats":
    case "clone":
    case "get_fork_messages":
    case "get_tree":
    case "get_last_assistant_text":
    case "get_commands":
      break;
    case "steer":
    case "follow_up": {
      const message = stringField(body, "message", { max: 1_000_000 });
      if (message === null) return fail(`${type} requires a non-empty message`);
      const imageResult = sanitizeImages(body.images);
      if (!imageResult.ok) return imageResult;
      command.message = message;
      if (imageResult.images?.length) command.images = imageResult.images;
      break;
    }
    case "set_model": {
      const provider = stringField(body, "provider", { max: 200, trim: true });
      const modelId = stringField(body, "modelId", { max: 500, trim: true });
      if (provider === null || modelId === null) return fail("set_model requires provider and modelId");
      command.provider = provider;
      command.modelId = modelId;
      break;
    }
    case "set_thinking_level":
      if (!THINKING_LEVELS.has(body.level)) return fail("invalid thinking level");
      command.level = body.level;
      break;
    case "set_steering_mode":
    case "set_follow_up_mode":
      if (!QUEUE_MODES.has(body.mode)) return fail("invalid queue mode");
      command.mode = body.mode;
      break;
    case "compact":
      if (body.customInstructions !== undefined) {
        const customInstructions = stringField(body, "customInstructions", { max: 10000 });
        if (customInstructions === null) return fail("customInstructions must be a non-empty string");
        command.customInstructions = customInstructions;
      }
      break;
    case "export_html":
      if (body.outputPath !== undefined) return fail("custom export paths require a native save flow");
      break;
    case "switch_session": {
      const requested = stringField(body, "sessionPath", { max: 4096 });
      const sessionPath = requested === null ? null : resolveSessionPath(requested);
      if (!sessionPath) return fail("sessionPath is outside Coop's session store or does not exist");
      command.sessionPath = sessionPath;
      break;
    }
    case "fork": {
      const entryId = stringField(body, "entryId", { max: 200, trim: true });
      if (entryId === null) return fail("fork requires entryId");
      command.entryId = entryId;
      break;
    }
    case "get_entries":
      if (body.since !== undefined) {
        const since = stringField(body, "since", { max: 200, trim: true });
        if (since === null) return fail("since must be a non-empty entry ID");
        command.since = since;
      }
      break;
    case "set_session_name": {
      const name = stringField(body, "name", { max: 200, trim: true });
      if (name === null) return fail("session name cannot be empty");
      command.name = name;
      break;
    }
    default:
      return fail("command not allowed");
  }

  if (type === "set_auto_compaction" || type === "set_auto_retry") {
    if (typeof body.enabled !== "boolean") return fail(`${type} requires a boolean enabled value`);
    command.enabled = body.enabled;
  }
  return { ok: true, command };
}

export function buildPromptCommand(body, { busy = false } = {}) {
  const message = stringField(body, "message", { max: 1_000_000 });
  if (message === null) return fail("prompt requires a non-empty message");
  const imageResult = sanitizeImages(body.images);
  if (!imageResult.ok) return imageResult;
  const command = { type: "prompt", message };
  if (imageResult.images?.length) command.images = imageResult.images;
  if (busy) command.streamingBehavior = "steer";
  return { ok: true, command };
}

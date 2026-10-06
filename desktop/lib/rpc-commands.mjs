// Renderer input is untrusted. Every Pi RPC command is rebuilt here field by
// field from an allowlist; nothing from the renderer is spread into a command.
// Field names follow Pi 0.87.1 docs/rpc-commands.md and docs/rpc-extension-ui.md.

export const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const QUEUE_MODES = new Set(["all", "one-at-a-time"]);
const STREAMING_BEHAVIORS = new Set(["steer", "followUp"]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const IMAGE_LIMITS = Object.freeze({ maxImages: 5, maxImageBytes: 4 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 });
const MAX_TEXT = 200_000;
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;

// Commands that carry no fields at all.
const BARE = new Set([
  "abort", "clear_queue", "new_session", "get_state", "get_messages", "get_commands",
  "get_available_models", "get_available_thinking_levels", "get_session_stats",
  "get_fork_messages", "get_tree", "get_last_assistant_text", "cycle_model",
  "cycle_thinking_level", "clone", "abort_retry", "abort_bash",
]);

export class CommandError extends Error {}

function text(value, name, { max = MAX_TEXT, allowEmpty = false } = {}) {
  if (typeof value !== "string") throw new CommandError(`${name} must be text`);
  if (!allowEmpty && !value.trim()) throw new CommandError(`${name} is empty`);
  if (value.length > max) throw new CommandError(`${name} is too long`);
  if (value.includes("\0")) throw new CommandError(`${name} contains a null character`);
  return value;
}

function images(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > IMAGE_LIMITS.maxImages) throw new CommandError("too many images");
  let total = 0;
  return value.map((image) => {
    if (!image || image.type !== "image" || !IMAGE_TYPES.has(image.mimeType) || typeof image.data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(image.data)) {
      throw new CommandError("unsupported image");
    }
    const bytes = Math.floor(image.data.length * 3 / 4);
    total += bytes;
    if (bytes > IMAGE_LIMITS.maxImageBytes || total > IMAGE_LIMITS.maxTotalBytes) throw new CommandError("image too large");
    return { type: "image", data: image.data, mimeType: image.mimeType };
  });
}

function bool(value, name) {
  if (typeof value !== "boolean") throw new CommandError(`${name} must be true or false`);
  return value;
}

/** Build one Pi RPC command from renderer input. Throws CommandError when invalid. */
export function buildCommand(input) {
  if (!input || typeof input !== "object") throw new CommandError("command missing");
  const type = input.type;
  if (BARE.has(type)) return { type };
  switch (type) {
    case "prompt": {
      const command = { type, message: text(input.message, "message") };
      const imgs = images(input.images);
      if (imgs && imgs.length) command.images = imgs;
      if (input.streamingBehavior !== undefined) {
        if (!STREAMING_BEHAVIORS.has(input.streamingBehavior)) throw new CommandError("unknown streaming behavior");
        command.streamingBehavior = input.streamingBehavior;
      }
      return command;
    }
    case "steer":
    case "follow_up": {
      const command = { type, message: text(input.message, "message") };
      const imgs = images(input.images);
      if (imgs && imgs.length) command.images = imgs;
      return command;
    }
    case "set_model":
      return { type, provider: text(input.provider, "provider", { max: 200 }), modelId: text(input.modelId, "model", { max: 300 }) };
    case "set_thinking_level":
      if (!THINKING_LEVELS.has(input.level)) throw new CommandError("unknown thinking level");
      return { type, level: input.level };
    case "set_steering_mode":
    case "set_follow_up_mode":
      if (!QUEUE_MODES.has(input.mode)) throw new CommandError("unknown queue mode");
      return { type, mode: input.mode };
    case "compact": {
      const command = { type };
      if (input.customInstructions !== undefined && input.customInstructions !== "") {
        command.customInstructions = text(input.customInstructions, "instructions", { max: 4000 });
      }
      return command;
    }
    case "set_auto_compaction":
    case "set_auto_retry":
      return { type, enabled: bool(input.enabled, "enabled") };
    case "bash": {
      // `!!command` in the terminal: run it, keep it out of the model's context.
      const command = { type, command: text(input.command, "command", { max: 20_000 }) };
      if (input.excludeFromContext !== undefined) command.excludeFromContext = bool(input.excludeFromContext, "excludeFromContext");
      return command;
    }
    case "fork":
      if (typeof input.entryId !== "string" || !ID.test(input.entryId)) throw new CommandError("invalid entry");
      return { type, entryId: input.entryId };
    case "set_session_name":
      return { type, name: text(input.name, "name", { max: 200 }).trim() };
    default:
      // switch_session and export_html carry file paths: the main process
      // builds those itself after its own checks (see main.mjs).
      throw new CommandError(`command not allowed: ${String(type).slice(0, 40)}`);
  }
}

/** Build the answer to an extension dialog (select, confirm, input, editor). */
export function buildUiResponse(request, answer) {
  if (!request || typeof request.id !== "string") throw new CommandError("unknown dialog");
  const base = { type: "extension_ui_response", id: request.id };
  if (!answer || answer.cancelled === true) return { ...base, cancelled: true };
  switch (request.method) {
    case "confirm":
      return { ...base, confirmed: bool(answer.confirmed, "confirmed") };
    case "select":
      if (!Array.isArray(request.options) || !request.options.includes(answer.value)) throw new CommandError("not one of the options");
      return { ...base, value: answer.value };
    case "input":
    case "editor":
      return { ...base, value: text(answer.value, "value", { max: MAX_TEXT, allowEmpty: true }) };
    default:
      throw new CommandError("not a dialog");
  }
}

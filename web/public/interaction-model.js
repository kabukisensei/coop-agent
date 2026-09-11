// UI-neutral helpers for command discovery, image admission, and live queues.
// Dependency-free so the no-build SPA and Node contract tests use identical logic.
(function installInteractionModel(root) {
  "use strict";

  const DEFAULT_IMAGE_LIMITS = Object.freeze({
    mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
    maxImages: 5,
    maxImageBytes: 4 * 1024 * 1024,
    maxTotalImageBytes: 8 * 1024 * 1024,
  });

  function imageLimits(value) {
    const input = value && typeof value === "object" ? value : {};
    const mimeTypes = Array.isArray(input.mimeTypes) && input.mimeTypes.length
      ? input.mimeTypes.filter((item) => typeof item === "string")
      : DEFAULT_IMAGE_LIMITS.mimeTypes;
    const positive = (candidate, fallback) => Number.isSafeInteger(candidate) && candidate > 0 ? candidate : fallback;
    return Object.freeze({
      mimeTypes: Object.freeze([...mimeTypes]),
      maxImages: positive(input.maxImages, DEFAULT_IMAGE_LIMITS.maxImages),
      maxImageBytes: positive(input.maxImageBytes, DEFAULT_IMAGE_LIMITS.maxImageBytes),
      maxTotalImageBytes: positive(input.maxTotalImageBytes, DEFAULT_IMAGE_LIMITS.maxTotalImageBytes),
    });
  }

  function admitImage(existing, file, rawLimits) {
    const limits = imageLimits(rawLimits);
    const items = Array.isArray(existing) ? existing : [];
    if (!file || typeof file.type !== "string" || !limits.mimeTypes.includes(file.type)) {
      return { ok: false, error: `Supported images: ${limits.mimeTypes.join(", ")}.` };
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > limits.maxImageBytes) {
      return { ok: false, error: `Each image must be ${Math.floor(limits.maxImageBytes / 1048576)} MiB or smaller.` };
    }
    if (items.length >= limits.maxImages) {
      return { ok: false, error: `Attach at most ${limits.maxImages} images.` };
    }
    const total = items.reduce((sum, item) => sum + (Number.isSafeInteger(item.bytes) ? item.bytes : 0), 0) + file.size;
    if (total > limits.maxTotalImageBytes) {
      return { ok: false, error: `Attached images must total ${Math.floor(limits.maxTotalImageBytes / 1048576)} MiB or less.` };
    }
    return { ok: true };
  }

  function normalizeCommands(commands, nativeCommands = []) {
    const rows = [];
    for (const command of Array.isArray(commands) ? commands : []) {
      if (!command || typeof command.name !== "string" || !command.name.trim()) continue;
      const name = command.name.trim().replace(/^\/+/, "");
      const sourceInfo = command.sourceInfo && typeof command.sourceInfo === "object" ? command.sourceInfo : {};
      rows.push({
        id: `pi:${name}`,
        name: `/${name}`,
        description: typeof command.description === "string" ? command.description : "",
        source: typeof command.source === "string" ? command.source : "runtime",
        sourceDetail: [sourceInfo.package, sourceInfo.path, sourceInfo.origin].find((item) => typeof item === "string" && item) || "",
        kind: "pi",
        command: `/${name}`,
        available: true,
      });
    }
    for (const command of Array.isArray(nativeCommands) ? nativeCommands : []) {
      if (!command || typeof command.id !== "string" || typeof command.name !== "string") continue;
      rows.push({
        id: `desktop:${command.id}`,
        name: command.name,
        description: typeof command.description === "string" ? command.description : "",
        source: "desktop",
        sourceDetail: "Coop Desktop",
        kind: "desktop",
        nativeId: command.id,
        available: command.available !== false,
      });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  function updateQueue(queue, event) {
    const next = {
      steering: [...(Array.isArray(queue?.steering) ? queue.steering : [])],
      followUp: [...(Array.isArray(queue?.followUp) ? queue.followUp : [])],
      pendingUnknown: Number.isSafeInteger(queue?.pendingUnknown) ? queue.pendingUnknown : 0,
    };
    const key = event?.queueType === "steering" ? "steering" : event?.queueType === "followUp" ? "followUp" : null;
    if (!key) return next;
    if (event.action === "enqueue") next[key].push(typeof event.message === "string" ? event.message : "Queued message");
    else if (event.action === "dequeue") next[key].shift();
    else if (event.action === "clear") next[key] = [];
    return next;
  }

  root.CoopInteraction = Object.freeze({ DEFAULT_IMAGE_LIMITS, imageLimits, admitImage, normalizeCommands, updateQueue });
})(globalThis);

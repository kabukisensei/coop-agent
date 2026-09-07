import assert from "node:assert/strict";
import "../web/public/interaction-model.js";

const { DEFAULT_IMAGE_LIMITS, admitImage, imageLimits, normalizeCommands, updateQueue } = globalThis.CoopInteraction;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

test("image limits fall back safely and accept the runtime contract", () => {
  assert.equal(imageLimits(null).maxImages, 5);
  assert.deepEqual(imageLimits({ mimeTypes: ["image/png"], maxImages: 2, maxImageBytes: 10, maxTotalImageBytes: 12 }), {
    mimeTypes: ["image/png"], maxImages: 2, maxImageBytes: 10, maxTotalImageBytes: 12,
  });
});

test("image admission enforces type, count, per-image, and total byte limits", () => {
  const png = { type: "image/png", size: 10 };
  const limits = { mimeTypes: ["image/png"], maxImages: 2, maxImageBytes: 10, maxTotalImageBytes: 15 };
  assert.equal(admitImage([], png, limits).ok, true);
  assert.equal(admitImage([], { type: "image/svg+xml", size: 1 }, limits).ok, false);
  assert.equal(admitImage([], { type: "image/png", size: 11 }, limits).ok, false);
  assert.equal(admitImage([{ bytes: 1 }, { bytes: 1 }], png, limits).ok, false);
  assert.equal(admitImage([{ bytes: 6 }], png, limits).ok, false);
  assert.equal(DEFAULT_IMAGE_LIMITS.maxTotalImageBytes, 8 * 1024 * 1024);
});

test("command discovery preserves runtime source metadata and merges native actions", () => {
  const rows = normalizeCommands([
    { name: "impact-analysis", description: "Trace impact", source: "skill", sourceInfo: { path: "/skills/impact/SKILL.md" } },
  ], [
    { id: "open-workspace", name: "Open workspace", description: "Choose a folder" },
  ]);
  assert.deepEqual(rows.map((item) => item.id), ["pi:impact-analysis", "desktop:open-workspace"]);
  assert.equal(rows[0].source, "skill");
  assert.equal(rows[0].sourceDetail, "/skills/impact/SKILL.md");
  assert.equal(rows[1].source, "desktop");
});

test("queue updates are immutable and keep steering separate from follow-up", () => {
  const initial = { steering: [], followUp: [], pendingUnknown: 0 };
  const steered = updateQueue(initial, { action: "enqueue", queueType: "steering", message: "adjust" });
  const followed = updateQueue(steered, { action: "enqueue", queueType: "followUp", message: "next" });
  assert.deepEqual(initial, { steering: [], followUp: [], pendingUnknown: 0 });
  assert.deepEqual(followed, { steering: ["adjust"], followUp: ["next"], pendingUnknown: 0 });
  assert.deepEqual(updateQueue(followed, { action: "dequeue", queueType: "steering" }).steering, []);
  assert.deepEqual(updateQueue(followed, { action: "clear", queueType: "followUp" }).followUp, []);
});

console.log(`interaction model: ${passed} tests passed`);

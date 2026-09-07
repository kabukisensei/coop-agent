import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_EXPORT_BYTES, runtimeExportSource, saveRuntimeExport } from "../desktop/src/session-export.mjs";

let count = 0;
const test = async (name, fn) => { await fn(); count++; console.log(`  ✓ ${name}`); };

await test("runtime export validation accepts only a successful absolute HTML artifact", () => {
  const ok = { success: true, data: { path: "/safe/session.html" } };
  assert.equal(runtimeExportSource(ok), "/safe/session.html");
  assert.throws(() => runtimeExportSource({ success: false, data: { path: "/safe/session.html" } }), /invalid/);
  assert.throws(() => runtimeExportSource({ success: true, data: { path: "relative.html" } }), /invalid/);
  assert.throws(() => runtimeExportSource({ success: true, data: { path: "/safe/session.txt" } }), /invalid/);
});

await test("native save copies a bounded regular runtime artifact to the selected HTML path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-session-export-"));
  try {
    const source = join(dir, "generated.html");
    const destination = join(dir, "chosen.html");
    writeFileSync(source, "<html>safe</html>", "utf8");
    const result = await saveRuntimeExport({ success: true, data: { path: source } }, destination);
    assert.equal(result.ok, true);
    assert.equal(result.fileName, "chosen.html");
    assert.equal(readFileSync(destination, "utf8"), "<html>safe</html>");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await test("native save rejects renderer-like destinations, symlinks, and oversized artifacts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coop-session-export-"));
  try {
    const source = join(dir, "generated.html");
    const link = join(dir, "linked.html");
    writeFileSync(source, "safe", "utf8");
    symlinkSync(source, link);
    await assert.rejects(saveRuntimeExport({ success: true, data: { path: source } }, "relative.html"), /absolute HTML path/);
    await assert.rejects(saveRuntimeExport({ success: true, data: { path: link } }, join(dir, "out.html")), /safe regular/);
    await assert.rejects(saveRuntimeExport({ success: true, data: { path: source } }, join(dir, "out.html"), {
      lstatImpl: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: MAX_EXPORT_BYTES + 1 }),
    }), /safe regular/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`session export: ${count} tests passed`);

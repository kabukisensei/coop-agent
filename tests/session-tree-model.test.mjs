import assert from "node:assert/strict";
import "../web/public/session-tree-model.js";

const { buildRows, entryText } = globalThis.CoopSessionTree;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const user = { type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "change revenue" }] } };
const assistant = { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "plan" }] } };
const branch = { type: "message", id: "a2", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "other plan" }] } };
const tree = [{ entry: user, children: [{ entry: assistant, children: [] }, { entry: branch, label: "alternate", children: [] }] }];

test("flattens Pi tree depth-first with stable depths", () => {
  assert.deepEqual(buildRows(tree).map((row) => [row.entry.id, row.depth]), [["u1", 0], ["a1", 1], ["a2", 1]]);
});
test("marks exactly the runtime-reported active leaf", () => {
  const rows = buildRows(tree, { leafId: "a2" });
  assert.deepEqual(rows.filter((row) => row.isCurrent).map((row) => row.entry.id), ["a2"]);
});
test("forkability comes only from get_fork_messages", () => {
  const rows = buildRows(tree, { forkMessages: [{ entryId: "u1", text: "change revenue" }] });
  assert.deepEqual(rows.filter((row) => row.forkable).map((row) => row.entry.id), ["u1"]);
});
test("summaries preserve role/text and represent image-only messages", () => {
  assert.equal(entryText(user), "user: change revenue");
  assert.equal(entryText({ type: "message", message: { role: "user", content: [{ type: "image", data: "x" }] } }), "user: 1 image");
});
test("cycles and oversized trees are bounded", () => {
  const node = { entry: user, children: [] };
  node.children.push(node);
  assert.equal(buildRows([node], { maxRows: 5 }).length, 1);
  assert.equal(buildRows(tree, { maxRows: 2 }).length, 2);
});

console.log(`session tree model: ${passed} tests passed`);

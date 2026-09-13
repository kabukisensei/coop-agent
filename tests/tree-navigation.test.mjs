import { strict as assert } from "node:assert";
import { pathToFileURL } from "node:url";

import {
  buildTreeNavigationInvocation,
  parseTreeNavigationResultEvent,
} from "../web/tree-navigation.mjs";

const dist = process.env.COOP_TEST_DIST;
const extension = dist ? await import(pathToFileURL(`${dist}/coop-tools.mjs`).href) : null;

let count = 0;
async function test(name, fn) {
  await fn();
  count++;
  console.log(`  ✓ ${name}`);
}

const secret = "0123456789abcdef0123456789abcdef";

await test("runtime builds a bounded authenticated extension invocation", async () => {
  const built = buildTreeNavigationInvocation({
    entryId: "user-entry:1",
    summarize: true,
    customInstructions: "Keep decisions.",
    replaceInstructions: false,
    label: "alternate",
  }, { requestId: "tree-1", secret });
  assert.equal(built.ok, true);
  assert.match(built.command.message, /^\/coop-tree-navigate [A-Za-z0-9_-]+$/);
  if (extension) {
    const decoded = extension.decodeTreeNavigationRequest(built.command.message.split(" ")[1]);
    assert.deepEqual(decoded, {
      requestId: "tree-1",
      bridgeSecret: secret,
      targetId: "user-entry:1",
      summarize: true,
      customInstructions: "Keep decisions.",
      replaceInstructions: false,
      label: "alternate",
    });
  }
});

await test("runtime rejects malformed navigation inputs", async () => {
  assert.equal(buildTreeNavigationInvocation({ entryId: "../escape" }, { requestId: "tree-1", secret }).ok, false);
  assert.equal(buildTreeNavigationInvocation({ entryId: "a1", summarize: "yes" }, { requestId: "tree-1", secret }).ok, false);
  assert.equal(buildTreeNavigationInvocation({ entryId: "a1", replaceInstructions: true }, { requestId: "tree-1", secret }).ok, false);
  if (extension) assert.throws(() => extension.decodeTreeNavigationRequest("not-json"), /invalid tree-navigation request/);
});

if (extension) {
  const { navigateTreeFromRuntime, navigationEditorText } = extension;

  await test("entry projection restores only user/custom editor text", async () => {
    assert.equal(navigationEditorText({ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }, { type: "image" }, { type: "text", text: " world" }] } }), "hello world");
    assert.equal(navigationEditorText({ type: "custom_message", content: "custom" }), "custom");
    assert.equal(navigationEditorText({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "no" }] } }), undefined);
  });

  await test("extension delegates to Pi public navigation and returns correlated state", async () => {
  let leaf = "old-leaf";
  const statuses = [];
  let receivedOptions;
  const ctx = {
    mode: "rpc",
    sessionManager: {
      getLeafId: () => leaf,
      getEntry: (id) => ({ type: "message", id, message: { role: "user", content: [{ type: "text", text: "restore me" }] } }),
    },
    navigateTree: async (targetId, options) => {
      receivedOptions = options;
      leaf = options.summarize ? "summary-entry" : targetId;
      return { cancelled: false };
    },
    ui: { setStatus: (key, text) => statuses.push({ key, text }) },
  };
  const built = buildTreeNavigationInvocation({ entryId: "u1", summarize: true }, { requestId: "tree-2", secret });
  await navigateTreeFromRuntime(built.command.message.split(" ")[1], ctx, secret);
  assert.deepEqual(receivedOptions, {
    summarize: true,
    customInstructions: undefined,
    replaceInstructions: undefined,
    label: undefined,
  });
  const parsed = parseTreeNavigationResultEvent({
    type: "extension_ui_request",
    method: "setStatus",
    statusKey: statuses[0].key,
    statusText: statuses[0].text,
  });
  assert.deepEqual(parsed.result, {
    requestId: "tree-2",
    targetId: "u1",
    cancelled: false,
    previousLeafId: "old-leaf",
    currentLeafId: "summary-entry",
    editorText: "restore me",
  });
  });

  await test("cancellation preserves the prior leaf and does not restore editor text", async () => {
  const statuses = [];
  const ctx = {
    mode: "rpc",
    sessionManager: { getLeafId: () => "old-leaf", getEntry: () => ({ type: "custom_message", content: "draft" }) },
    navigateTree: async () => ({ cancelled: true }),
    ui: { setStatus: (key, text) => statuses.push({ key, text }) },
  };
  const built = buildTreeNavigationInvocation({ entryId: "u1" }, { requestId: "tree-cancel", secret });
  await navigateTreeFromRuntime(built.command.message.split(" ")[1], ctx, secret);
  const result = JSON.parse(statuses[0].text);
  assert.equal(result.cancelled, true);
  assert.equal(result.previousLeafId, "old-leaf");
  assert.equal(result.currentLeafId, "old-leaf");
  assert.equal("editorText" in result, false);
  });

  await test("navigation errors are correlated and bridge authentication fails closed", async () => {
  const statuses = [];
  let calls = 0;
  const ctx = {
    mode: "rpc",
    sessionManager: { getLeafId: () => "old-leaf", getEntry: () => undefined },
    navigateTree: async () => { calls++; throw new Error("Entry missing not found"); },
    ui: { setStatus: (key, text) => statuses.push({ key, text }) },
  };
  const built = buildTreeNavigationInvocation({ entryId: "missing" }, { requestId: "tree-error", secret });
  const encoded = built.command.message.split(" ")[1];
  await assert.rejects(() => navigateTreeFromRuntime(encoded, ctx, secret), /Entry missing not found/);
  assert.match(JSON.parse(statuses[0].text).error, /not found/);
  await assert.rejects(() => navigateTreeFromRuntime(encoded, ctx, "different-secret-value"), /authentication failed/);
  assert.equal(calls, 1);
  });
}

console.log(`tree navigation: ${count} tests passed`);

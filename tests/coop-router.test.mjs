// Behavioral tests for extensions/coop-router (master plan R1): the coop/auto
// virtual model's rules, against a fake catalog shaped like Pi's ModelRegistry.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST || "/tmp/coop-test-dist";
const modPath = join(dist, "coop-router.mjs");
assert.ok(existsSync(modPath), `missing bundle ${modPath}`);
const mod = await import(pathToFileURL(modPath).href);
const { routeRequest, classifyRequest, resolveTier, parseTierOverride, describeTiers, storedState, editedThisTurn, lastUserText } = mod;

const codex = (id) => ({ provider: "openai-codex", id, api: "openai-codex-responses", name: id });
const catalog = (ids, signedIn = true) => {
  const models = new Map(ids.map((id) => [id, codex(id)]));
  return { find: (p, id) => (p === "openai-codex" ? models.get(id) : undefined), hasConfiguredAuth: (m) => signedIn && models.has(m.id) };
};
const full = catalog(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-sol", "gpt-6-luna", "gpt-5.5"]);
const user = (text) => ({ role: "user", content: text });
const toolResult = (toolName, isError = false) => ({ role: "toolResult", toolName, isError, content: [] });
const env = {};

// --- classification ---------------------------------------------------------
assert.equal(classifyRequest("what does this view do?", "low"), "build");
assert.equal(classifyRequest("what does this view do?", "medium"), "standard");
assert.equal(classifyRequest("x".repeat(401), "low"), "standard");
assert.equal(classifyRequest("refactor", "high"), "plan");
assert.equal(classifyRequest("refactor", "xhigh"), "plan");
assert.equal(classifyRequest("y".repeat(4000), "medium"), "plan");
console.log("  ✓ thinking level and prompt length pick the tier");

// --- tiers and sign-in -------------------------------------------------------
assert.equal(resolveTier("plan", full, env).id, "gpt-5.6-sol");
assert.equal(resolveTier("standard", full, env).id, "gpt-5.6-terra");
assert.equal(resolveTier("build", full, env).id, "gpt-5.6-luna");
assert.equal(resolveTier("plan", catalog(["gpt-6-sol", "gpt-6-luna"]), env).id, "gpt-6-sol", "falls through the tier list");
assert.throws(() => resolveTier("build", catalog(["gpt-5.6-luna"], false), env), /login openai-codex/, "no sign-in: a clear error, never another vendor");
assert.throws(() => resolveTier("plan", catalog([]), env), /none of the plan models/);
assert.deepEqual(parseTierOverride("plan=gpt-6-sol, gpt-5.5;build=gpt-6-luna;bogus=x;standard="), { plan: ["gpt-6-sol", "gpt-5.5"], build: ["gpt-6-luna"] });
assert.equal(resolveTier("plan", full, { COOP_ROUTER_MODELS: "plan=gpt-5.5" }).id, "gpt-5.5", "COOP_ROUTER_MODELS overrides a tier");
assert.deepEqual(describeTiers(full, env), ["plan: openai-codex/gpt-5.6-sol", "standard: openai-codex/gpt-5.6-terra", "build: openai-codex/gpt-5.6-luna"]);
assert.match(describeTiers(catalog([]), env)[0], /none available/);
console.log("  ✓ each tier resolves to the first signed-in Codex model, with a COOP_ROUTER_MODELS override");

// --- routing ------------------------------------------------------------------
// A new session: an ordinary prompt plans on the standard model and keeps the thinking level.
let r = routeRequest({ reason: "user", thinkingLevel: "medium", messages: [user("add a column to the sales view")] }, full, env);
assert.equal(r.model.id, "gpt-5.6-terra");
assert.equal(r.thinkingLevel, "medium");
assert.deepEqual(r.state, { phase: "planning", model: "gpt-5.6-terra", tier: "standard" });
const planning = r.state;

// Tool follow-ups stay on the turn's model, and return the same state object (no new entry).
r = routeRequest({ reason: "continuation", thinkingLevel: "medium", state: planning, messages: [user("add a column"), toolResult("read")] }, full, env);
assert.equal(r.model.id, "gpt-5.6-terra");
assert.equal(r.state, planning, "unchanged state is returned as is");

// The first successful edit of the turn hands the work to the build model.
r = routeRequest({ reason: "continuation", thinkingLevel: "medium", state: planning, messages: [user("add a column"), toolResult("read"), toolResult("edit")] }, full, env);
assert.equal(r.model.id, "gpt-5.6-luna");
assert.deepEqual(r.state, { phase: "implementation", model: "gpt-5.6-luna", tier: "build" });
const implementing = r.state;
// A failed edit does not.
r = routeRequest({ reason: "continuation", thinkingLevel: "medium", state: planning, messages: [user("add a column"), toolResult("edit", true)] }, full, env);
assert.equal(r.model.id, "gpt-5.6-terra");

// Ordinary follow-ups stay on the build model; a high-thinking prompt goes back to planning on the plan model.
r = routeRequest({ reason: "user", thinkingLevel: "medium", state: implementing, messages: [user("add a column"), toolResult("edit"), user("now the tests")] }, full, env);
assert.equal(r.model.id, "gpt-5.6-luna");
assert.equal(r.state, implementing);
r = routeRequest({ reason: "user", thinkingLevel: "high", state: implementing, messages: [user("add a column"), toolResult("edit"), user("rethink the model")] }, full, env);
// Planning at high thinking runs on the standard model (Aaron, 2026-10-19: the plan model only on an explicit xhigh).
assert.equal(r.model.id, "gpt-5.6-terra");
assert.equal(r.thinkingLevel, "high");
assert.deepEqual(r.state, { phase: "planning", model: "gpt-5.6-terra", tier: "plan" });
r = routeRequest({ reason: "user", thinkingLevel: "xhigh", state: implementing, messages: [user("add a column"), toolResult("edit"), user("rethink the model")] }, full, env);
assert.equal(r.model.id, "gpt-5.6-sol", "xhigh asks for the plan model");
assert.deepEqual(r.state, { phase: "planning", model: "gpt-5.6-sol", tier: "plan" });
assert.equal(routeRequest({ reason: "user", thinkingLevel: "medium", messages: [user("y".repeat(4000))] }, full, env).model.id, "gpt-5.6-terra", "a long brief plans on the standard model too");
assert.deepEqual([mod.modelTier("plan", "high"), mod.modelTier("plan", "xhigh"), mod.modelTier("plan", "max"), mod.modelTier("standard", "xhigh"), mod.modelTier("build", "low")], ["standard", "plan", "plan", "standard", "build"]);

// A quick question at low thinking goes straight to the build model.
r = routeRequest({ reason: "user", thinkingLevel: "low", messages: [user("what is a lakehouse?")] }, full, env);
assert.equal(r.model.id, "gpt-5.6-luna");
assert.equal(r.state.phase, "implementation");

// Compaction summaries and extension calls: build model, low thinking, no state.
r = routeRequest({ reason: "direct", thinkingLevel: "high", messages: [user("summarize")] }, full, env);
assert.equal(r.model.id, "gpt-5.6-luna");
assert.equal(r.thinkingLevel, "low");
assert.equal(r.state, undefined);

// A retry with no router state yet (coop/auto picked mid-session) stays on the model that failed.
r = routeRequest({ reason: "retry", thinkingLevel: "medium", failed: { model: codex("gpt-5.6-terra"), thinkingLevel: "medium", message: {} }, messages: [user("add a column")] }, full, env);
assert.equal(r.model.id, "gpt-5.6-terra");
assert.equal(r.state, undefined);

// A stored model that left the catalog is re-resolved by tier, never left to fail.
r = routeRequest({ reason: "continuation", thinkingLevel: "medium", state: { phase: "planning", model: "gpt-5.6-terra", tier: "standard" }, messages: [user("x"), toolResult("read")] }, full && catalog(["gpt-6-sol", "gpt-6-luna"]), env);
assert.equal(r.model.id, "gpt-6-sol");

// Switching to coop/auto mid-session with no state: a tool follow-up keeps the previous physical model.
r = routeRequest({ reason: "continuation", thinkingLevel: "medium", previous: { model: codex("gpt-5.5"), thinkingLevel: "medium" }, messages: [user("x"), toolResult("read")] }, full, env);
assert.equal(r.model.id, "gpt-5.5");
assert.equal(r.state, undefined);

// Every route is an openai-codex model.
for (const reason of ["user", "continuation", "retry", "direct"]) {
  const out = routeRequest({ reason, thinkingLevel: "medium", messages: [user("x")] }, full, env);
  assert.equal(out.model.provider, "openai-codex", `${reason} stays on openai-codex`);
}
console.log("  ✓ plans on the standard or plan model, builds after the first edit, summaries and quick answers on the build model");

// --- escalation (Aaron, 2026-10-09: quality over the prompt cache) -------------------
const { failedEditsThisTurn, tierAbove, FAILED_EDITS_TO_ESCALATE } = mod;
assert.equal(FAILED_EDITS_TO_ESCALATE, 2);
assert.deepEqual([tierAbove("build"), tierAbove("standard"), tierAbove("plan")], ["standard", "plan", undefined]);
// A provider error on the build model: the retry steps up to the standard model, phase kept.
r = routeRequest({ reason: "retry", thinkingLevel: "medium", state: implementing, failed: { model: codex("gpt-5.6-luna"), thinkingLevel: "medium", message: { stopReason: "error", errorMessage: "overloaded" } }, messages: [user("x"), toolResult("edit")] }, full, env);
assert.equal(r.model.id, "gpt-5.6-terra");
assert.deepEqual(r.state, { phase: "implementation", model: "gpt-5.6-terra", tier: "standard" });
// ...and again from standard to plan; on the plan model the retry stays put.
r = routeRequest({ reason: "retry", thinkingLevel: "medium", state: r.state, failed: { model: codex("gpt-5.6-terra"), message: { stopReason: "error" } }, messages: [user("x")] }, full, env);
assert.equal(r.model.id, "gpt-5.6-sol");
const onPlan = r.state;
r = routeRequest({ reason: "retry", thinkingLevel: "medium", state: onPlan, failed: { model: codex("gpt-5.6-sol"), message: { stopReason: "error" } }, messages: [user("x")] }, full, env);
assert.equal(r.model.id, "gpt-5.6-sol");
assert.equal(r.state, onPlan);
// Two failed edits in a turn on the build model step up to the standard model; one does not.
const turn = (...results) => [user("add a column"), toolResult("edit"), user("now the tests"), ...results];
r = routeRequest({ reason: "continuation", thinkingLevel: "medium", state: implementing, messages: turn(toolResult("edit", true)) }, full, env);
assert.equal(r.model.id, "gpt-5.6-luna");
r = routeRequest({ reason: "continuation", thinkingLevel: "medium", state: implementing, messages: turn(toolResult("edit", true), toolResult("read"), toolResult("write", true)) }, full, env);
assert.equal(r.model.id, "gpt-5.6-terra");
assert.deepEqual(r.state, { phase: "implementation", model: "gpt-5.6-terra", tier: "standard", failedEdits: 2 });
const escalated = r.state;
// The escalated tier needs two NEW failed edits before the next step; a successful edit on it does not drop it back to build.
r = routeRequest({ reason: "continuation", thinkingLevel: "medium", state: escalated, messages: turn(toolResult("edit", true), toolResult("write", true), toolResult("edit")) }, full, env);
assert.equal(r.model.id, "gpt-5.6-terra");
assert.equal(r.state, escalated);
r = routeRequest({ reason: "continuation", thinkingLevel: "medium", state: escalated, messages: turn(toolResult("edit", true), toolResult("write", true), toolResult("edit", true), toolResult("edit", true)) }, full, env);
assert.equal(r.model.id, "gpt-5.6-sol");
assert.equal(r.state.failedEdits, 4);
// The escalation lasts the turn: the next ordinary prompt is back on the build model with a fresh baseline.
r = routeRequest({ reason: "user", thinkingLevel: "medium", state: escalated, messages: turn(toolResult("edit", true), toolResult("write", true), user("next thing")) }, full, env);
assert.equal(r.model.id, "gpt-5.6-luna");
assert.deepEqual(r.state, { phase: "implementation", model: "gpt-5.6-luna", tier: "build" });
assert.equal(failedEditsThisTurn(turn(toolResult("edit", true), toolResult("write", true), toolResult("read", true))), 2);
console.log("  ✓ a provider error or two failed edits step the turn up one tier; the next prompt starts afresh");

// --- helpers --------------------------------------------------------------------
assert.equal(lastUserText([user("a"), { role: "assistant", content: [] }, user([{ type: "text", text: "b" }, { type: "image" }])]), "b");
// Pi hands the router coop's injected note (standards, team knowledge) as a user
// message AFTER the prompt; the prompt is the first user message of the turn.
const note = user("Cooptimize standards apply automatically to this task. " + "x".repeat(5000));
assert.equal(lastUserText([user("What does `coop doctor` check?"), note]), "What does `coop doctor` check?");
assert.equal(lastUserText([user("a"), { role: "assistant", content: [] }, toolResult("read"), user("Add a column"), note]), "Add a column");
assert.equal(lastUserText([user("a"), note, { role: "assistant", content: [] }, toolResult("edit")]), "a", "mid-turn: the turn's prompt, not the note");
assert.equal(routeRequest({ reason: "user", thinkingLevel: "medium", messages: [user("Add a column to the orders view"), note] }, full, env).model.id, "gpt-5.6-terra", "an injected note never turns an edit into a plan");
assert.equal(routeRequest({ reason: "user", thinkingLevel: "low", messages: [user("What does `coop doctor` check?"), note] }, full, env).model.id, "gpt-5.6-luna", "an injected note never turns a quick question into a standard task");
// The typed prompt from before_agent_start wins over the messages, even when the note is all they hold.
assert.equal(routeRequest({ reason: "user", thinkingLevel: "medium", messages: [note] }, full, env, "Add a column to the orders view").model.id, "gpt-5.6-terra", "the typed prompt is classified when the messages hold only the note");
assert.equal(routeRequest({ reason: "user", thinkingLevel: "medium", messages: [note] }, full, env).state.tier, "plan", "without the typed prompt the note alone still classifies as a plan (the fallback)");
assert.equal(editedThisTurn([user("a"), toolResult("edit"), user("b"), toolResult("read")]), false, "an edit before the last user message does not count");
assert.equal(storedState({ sessionManager: { getBranch: () => [{ type: "custom", customType: "pi.virtual-model-state", data: { provider: "coop", modelId: "auto", state: implementing } }] } }), implementing);
assert.equal(storedState({}), undefined);

// --- registration against the real Pi contract ----------------------------------
let definition;
const commands = new Map();
const notices = [];
const hooks = new Map();
mod.default({ registerVirtualModel: (d) => { definition = d; }, registerCommand: (name, opts) => commands.set(name, opts), on: (name, fn) => hooks.set(name, fn) });
assert.ok(hooks.has("before_agent_start"), "the router listens for the typed prompt");
assert.equal(definition.provider, "coop");
assert.equal(definition.id, "auto");
assert.deepEqual(definition.thinkingLevels, ["low", "medium", "high", "xhigh"]);
const ctx = { modelRegistry: full, model: { provider: "coop", id: "auto", api: "pi-virtual" }, sessionManager: { getBranch: () => [] }, ui: { notify: (m) => notices.push(m) } };
const routed = await definition.route({ reason: "user", thinkingLevel: "medium", messages: [user("hello there, what changed?")] }, ctx);
assert.equal(routed.model.id, "gpt-5.6-terra");
// The live path: before_agent_start carries the typed prompt; the messages Pi routes on may hold only coop's note.
await hooks.get("before_agent_start")({ prompt: "Add a column to the orders view" });
assert.equal((await definition.route({ reason: "user", thinkingLevel: "medium", messages: [note] }, ctx)).model.id, "gpt-5.6-terra", "the typed prompt is classified, not the note");
await commands.get("router").handler("", ctx);
assert.match(notices.at(-1), /plan: openai-codex\/gpt-5.6-sol/);
assert.match(notices.at(-1), /no request routed yet/);
// Pi before 0.99 has no registerVirtualModel: the extension registers nothing and never throws.
mod.default({ registerCommand: () => assert.fail("registered a command on an old Pi") });
console.log("  ✓ registers coop/auto with /router, and stays quiet on a Pi without virtual models");

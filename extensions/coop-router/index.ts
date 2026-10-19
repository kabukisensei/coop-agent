// coop's router (master plan R1, section 6.6): a coop-owned virtual model,
// `coop/auto`, over the OpenAI Codex models coop already signs in to. It picks a
// physical model for each request by rules, never by a classifier, in the shape
// of Pi's examples/extensions/jev-router.ts: a large model plans and a smaller
// one implements and summarizes. Nothing new leaves the machine: every route
// lands on the `openai-codex` provider, with the session's own sign-in.
//
// Rules, in order:
// - `direct` requests (compaction summaries, an extension's own call) go to the
//   build model at low thinking.
// - `retry` after a provider error steps up one tier for the rest of the turn
//   (build to standard, standard to plan; Aaron, 2026-10-09: quality over the
//   prompt cache); a retry already on the plan model stays there.
// - `continuation` stays on the turn's model, except that the first successful
//   edit or write of a planning turn hands the rest of the work to the build
//   model, and the session stays there; and two failed edits or writes in a
//   turn on a tier below plan step up one tier for the rest of the turn.
// - `user` requests are classified by the thinking level picked and the prompt:
//   high or xhigh, or a long prompt, is planning on the plan model; low (or off)
//   with a short prompt is a quick answer on the build model; anything else is
//   planning on the standard model. A session already implementing keeps the
//   build model for ordinary follow-ups, so it switches models once per phase.
//
// The phase is router state: Pi stores it on the session branch, so it follows
// forks and survives compaction. Opt in with `/model coop/auto`; the footer shows
// the routed model beside the selection. Loaded only on Pi 1.x (bin/coop.ps1).
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
// The classification rule lives in lib/router-rules.mjs so the J0 classifier
// trial (lib/router-trial.mjs) scores classifiers against the very same rule.
import { classifyRequest as classifyRule, LONG_PROMPT_CHARS as LONG, SHORT_PROMPT_CHARS as SHORT } from "../../lib/router-rules.mjs";

export const PROVIDER = "openai-codex";
export const ROUTER_PROVIDER = "coop";
export const ROUTER_ID = "auto";

export type Tier = "plan" | "standard" | "build";
export const TIERS: readonly Tier[] = ["plan", "standard", "build"];

/**
 * Model families per tier, fallback families in order. The Codex catalog names a
 * model by family and version (gpt-5.6-sol, gpt-6-luna, gpt-6.1-sol), so a tier
 * resolves to the newest version of its first family the signed-in account can
 * use, else the next family, read from the catalog the first time the session
 * routes and kept for the rest of the session. A new release is picked up at
 * the next start with no code change (Aaron, 2026-10-19: sol 6.1, terra 5.6 and
 * luna 6 today, terra 6 expected). COOP_ROUTER_MODELS (`plan=a,b;standard=c;build=d`)
 * pins exact ids instead, first usable wins, for a measurement run or a hold.
 */
export const TIER_FAMILIES: Record<Tier, readonly string[]> = {
  plan: ["sol"],
  standard: ["terra", "sol"],
  build: ["luna", "terra"],
};

/** `gpt-<version>-<family>` → its family and version parts; undefined for any other id (gpt-5.5, gpt-5.3-codex-spark). */
export function parseCodexModelId(id: string): { family: string; version: number[] } | undefined {
  const m = /^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/.exec(String(id ?? ""));
  if (!m) return undefined;
  return { family: m[2], version: m[1].split(".").map(Number) };
}

/** Newer first: 6.1 > 6 > 5.6. */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** A prompt at least this long (characters) plans on the plan model (lib/router-rules.mjs). */
export const LONG_PROMPT_CHARS: number = LONG;
/** A low-thinking prompt at most this long is a quick answer on the build model. */
export const SHORT_PROMPT_CHARS: number = SHORT;

/** Tools whose successful result means implementation has started. */
const EDIT_TOOLS = new Set(["edit", "write"]);
/** Failed edits or writes in one turn, on one tier, that step the turn up a tier. */
export const FAILED_EDITS_TO_ESCALATE = 2;

export interface RouterState {
  phase: "planning" | "implementation";
  /** openai-codex model id for this phase. */
  model: string;
  tier: Tier;
  /** Failed edits of the turn already counted by an escalation, so each step needs new ones. */
  failedEdits?: number;
  /**
   * Why this state sits a tier above where the prompt was classified: the model
   * that failed and what failed (a provider error on it, or two failed edits on
   * it). Pi keeps no record of a failed call, so this is the one trace a session
   * leaves of an escalation; /router shows it. Cleared by the next user prompt
   * that classifies to the same tier (the escalation lasts the turn).
   */
  escalated?: { from: string; reason: "provider-error" | "failed-edits" };
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** The slice of Pi's ModelRouteRequest the rules read. */
export interface RouteInput {
  reason: "user" | "continuation" | "retry" | "direct";
  thinkingLevel: ThinkingLevel;
  messages: readonly any[];
  state?: RouterState;
  previous?: { model: any; thinkingLevel?: ThinkingLevel };
  failed?: { model: any; thinkingLevel?: ThinkingLevel; message?: any };
}

/** The slice of Pi's ModelRegistry the router uses. */
export interface Registry {
  find(provider: string, modelId: string): any;
  hasConfiguredAuth?(model: any): boolean;
  /** Every catalog model (Pi's ModelRegistry.getAll); the newest-in-family lookup reads it. */
  getAll?(): any[];
}

/** Parse a COOP_ROUTER_MODELS override; unknown tiers and empty lists are ignored. */
export function parseTierOverride(raw: string | undefined): Partial<Record<Tier, string[]>> {
  const out: Partial<Record<Tier, string[]>> = {};
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const tier = part.slice(0, eq).trim() as Tier;
    if (!TIERS.includes(tier)) continue;
    const ids = part.slice(eq + 1).split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length) out[tier] = ids;
  }
  return out;
}

/** What a tier is asked to resolve to: pinned ids from COOP_ROUTER_MODELS, else its families. */
export function tierSpec(tier: Tier, env: NodeJS.ProcessEnv = process.env): { pinned?: readonly string[]; families: readonly string[] } {
  const override = parseTierOverride(env.COOP_ROUTER_MODELS);
  return { pinned: override[tier], families: TIER_FAMILIES[tier] };
}

function usable(registry: Registry, model: any): boolean {
  if (!model || model.provider !== PROVIDER) return false;
  if (typeof registry.hasConfiguredAuth === "function") {
    try { return registry.hasConfiguredAuth(model) === true; } catch { return false; }
  }
  return true;
}

/** The newest usable Codex model of a family in the catalog, or undefined. */
export function newestInFamily(family: string, registry: Registry): any {
  const all: any[] = typeof registry.getAll === "function" ? registry.getAll() ?? [] : [];
  let best: any; let bestVersion: number[] = [];
  for (const model of all) {
    if (model?.provider !== PROVIDER) continue;
    const parsed = parseCodexModelId(model.id);
    if (!parsed || parsed.family !== family || !usable(registry, model)) continue;
    if (!best || compareVersions(parsed.version, bestVersion) > 0) { best = model; bestVersion = parsed.version; }
  }
  return best;
}

// One resolution per tier per registry (one registry per Pi process): the model
// a session routes to does not change while it runs, whatever the catalog does.
const resolvedTiers = new WeakMap<Registry, Map<string, any>>();

/** The catalog model a tier runs on: a pinned id the signed-in account can use, else the newest of its families. */
export function resolveTier(tier: Tier, registry: Registry, env: NodeJS.ProcessEnv = process.env): any {
  const spec = tierSpec(tier, env);
  const key = `${tier}|${(spec.pinned ?? []).join(",")}`;
  let cache = resolvedTiers.get(registry);
  if (!cache) { cache = new Map(); resolvedTiers.set(registry, cache); }
  if (cache.has(key)) return cache.get(key);
  let found: any;
  if (spec.pinned) {
    for (const id of spec.pinned) { const model = registry.find(PROVIDER, id); if (usable(registry, model)) { found = model; break; } }
  } else {
    for (const family of spec.families) { found = newestInFamily(family, registry); if (found) break; }
  }
  if (!found) {
    const wanted = spec.pinned ? spec.pinned.join(", ") : spec.families.map((f) => `newest ${f}`).join(", ");
    throw new Error(`coop/auto: none of the ${tier} models (${wanted}) is in the catalog with an OpenAI Codex sign-in. Run /login openai-codex, or pick a model with /model.`);
  }
  cache.set(key, found);
  return found;
}

/**
 * The person's prompt for the latest user turn: the FIRST user-role message after
 * the last assistant reply. Pi hands the router its LLM-shaped messages, where
 * every custom message an extension injected (coop's standards and team-knowledge
 * note, a few thousand characters, appended after the prompt) arrives as a user
 * message too; classifying the last one sent a 27-character question to the
 * standard model and a 240-character edit to the plan model (dev VM, 2026-10-19).
 * So: the run of consecutive user-role messages that ends at the last user
 * message (mid-turn, that run sits before the last assistant reply), and the
 * first message of that run.
 */
export function lastUserText(messages: readonly any[]): string {
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") { last = i; break; }
  if (last < 0) return "";
  let first = last;
  while (first > 0 && messages[first - 1]?.role === "user") first--;
  const content = messages[first]?.content ?? "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block: any) => (block?.type === "text" ? [String(block.text ?? "")] : [])).join("\n");
}

/** Whether a tool call since the last user message edited a file successfully. */
export function editedThisTurn(messages: readonly any[]): boolean {
  const lastUser = messages.findLastIndex((m) => m?.role === "user");
  return messages.slice(lastUser + 1).some((m) => m?.role === "toolResult" && EDIT_TOOLS.has(m.toolName) && !m.isError);
}

/** Failed edit or write tool calls since the last user message. */
export function failedEditsThisTurn(messages: readonly any[]): number {
  const lastUser = messages.findLastIndex((m) => m?.role === "user");
  return messages.slice(lastUser + 1).filter((m) => m?.role === "toolResult" && EDIT_TOOLS.has(m.toolName) && m.isError).length;
}

/** The next tier up, or undefined on the plan model. */
export function tierAbove(tier: Tier): Tier | undefined {
  return tier === "build" ? "standard" : tier === "standard" ? "plan" : undefined;
}

/** The tier a new user request starts on (the rule in lib/router-rules.mjs). */
export function classifyRequest(prompt: string, level: ThinkingLevel): Tier {
  return classifyRule(prompt, level) as Tier;
}

function route(model: any, thinkingLevel: ThinkingLevel, state?: RouterState) {
  return { model, thinkingLevel, state };
}

function phaseState(tier: Tier, model: any): RouterState {
  return { phase: tier === "build" ? "implementation" : "planning", model: model.id, tier };
}

/** The /router suffix for an escalated state: where it stepped up from and why. */
export function describeEscalation(state: RouterState | undefined): string {
  if (!state?.escalated) return "";
  const why = state.escalated.reason === "provider-error" ? "a provider error" : `${FAILED_EDITS_TO_ESCALATE} failed edits`;
  return `, stepped up from ${state.escalated.from} after ${why}`;
}

/** The model a stored state names, re-resolved by tier when the catalog no longer has it. */
function stateModel(state: RouterState, registry: Registry, env: NodeJS.ProcessEnv): any {
  const model = registry.find(PROVIDER, state.model);
  if (usable(registry, model)) return model;
  return resolveTier(state.tier, registry, env);
}

/** Pick the physical model and thinking level for one request. Pure: no Pi, no I/O. */
export function routeRequest(request: RouteInput, registry: Registry, env: NodeJS.ProcessEnv = process.env, typedPrompt = "") {
  const level = request.thinkingLevel;
  if (request.reason === "direct") return route(resolveTier("build", registry, env), "low");
  const state = request.state;
  if (request.reason === "retry") {
    // A provider error: step up one tier for the rest of the turn. The next user
    // prompt is classified afresh, so the escalation lasts the turn.
    const up = state ? tierAbove(state.tier) : undefined;
    if (state && up && request.failed) {
      const model = resolveTier(up, registry, env);
      return route(model, level, { ...state, model: model.id, tier: up, escalated: { from: state.model, reason: "provider-error" } });
    }
    const sticky = request.failed ?? request.previous;
    if (sticky && usable(registry, sticky.model)) return route(sticky.model, sticky.thinkingLevel ?? level, state);
  }
  if (request.reason === "continuation" || request.reason === "retry") {
    if (state?.phase === "planning" && editedThisTurn(request.messages)) {
      const build = resolveTier("build", registry, env);
      return route(build, level, phaseState("build", build));
    }
    // Two failed edits on this tier since the last escalation: step up one tier.
    const failed = state ? failedEditsThisTurn(request.messages) : 0;
    const up = state ? tierAbove(state.tier) : undefined;
    if (state && up && failed - (state.failedEdits ?? 0) >= FAILED_EDITS_TO_ESCALATE) {
      const model = resolveTier(up, registry, env);
      return route(model, level, { ...state, model: model.id, tier: up, failedEdits: failed, escalated: { from: state.model, reason: "failed-edits" } });
    }
    if (state) return route(stateModel(state, registry, env), level, state);
    if (request.previous && usable(registry, request.previous.model)) return route(request.previous.model, level, state);
  }
  // A user request (or the first request of a session with no state yet).
  let tier = classifyRequest(typedPrompt || lastUserText(request.messages), level);
  if (state?.phase === "implementation" && tier !== "plan") tier = "build";
  if (state && state.tier === tier) {
    // Same tier as the stored state: keep it, dropping a previous turn's escalation baseline and note.
    return route(stateModel(state, registry, env), level, state.failedEdits || state.escalated ? { ...state, failedEdits: undefined, escalated: undefined } : state);
  }
  const model = resolveTier(tier, registry, env);
  return route(model, level, phaseState(tier, model));
}

/** The latest router state stored on the session branch, for /router. */
export function storedState(ctx: any): RouterState | undefined {
  try {
    const branch: any[] = ctx?.sessionManager?.getBranch?.() ?? [];
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i];
      if (e?.type !== "custom" || e.customType !== "pi.virtual-model-state") continue;
      if (e.data?.provider === ROUTER_PROVIDER && e.data?.modelId === ROUTER_ID) return e.data.state as RouterState;
    }
  } catch { /* no branch to read */ }
  return undefined;
}

/** One line per tier naming the model it resolves to and how (newest of a family, or pinned), or why it cannot. */
export function describeTiers(registry: Registry, env: NodeJS.ProcessEnv = process.env): string[] {
  return TIERS.map((tier) => {
    const spec = tierSpec(tier, env);
    try {
      const model = resolveTier(tier, registry, env);
      const how = spec.pinned ? "pinned by COOP_ROUTER_MODELS" : `newest ${parseCodexModelId(model.id)?.family ?? "model"}`;
      return `${tier}: ${PROVIDER}/${model.id} (${how})`;
    } catch {
      return `${tier}: none available (${spec.pinned ? spec.pinned.join(", ") : spec.families.map((f) => `newest ${f}`).join(", ")})`;
    }
  });
}

export default function coopRouter(pi: ExtensionAPI) {
  if (typeof (pi as any).registerVirtualModel !== "function") return; // Pi before 0.99: no virtual models
  // The prompt the person typed, from Pi's before_agent_start (fired for every
  // user turn before the first route): the one text a `user` request classifies.
  // By routing time the messages may hold coop's injected note beside, or even
  // without, that prompt (see lastUserText), so the event is the reliable source.
  let typedPrompt = "";
  if (typeof (pi as any).on === "function") pi.on("before_agent_start", async (event: any) => { typedPrompt = String(event?.prompt ?? ""); });
  pi.registerVirtualModel<RouterState>({
    provider: ROUTER_PROVIDER,
    id: ROUTER_ID,
    name: "Auto (coop router)",
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    // Shared by the Codex models; shown before the first response.
    contextWindow: 272_000,
    maxTokens: 128_000,
    route(request, ctx: ExtensionContext) {
      return routeRequest(request as RouteInput, ctx.modelRegistry as unknown as Registry, process.env, typedPrompt);
    },
  });
  pi.registerCommand("router", {
    description: "Show what coop/auto routes to: the model per tier and this session's phase",
    handler: async (_args, ctx) => {
      const lines = describeTiers(ctx.modelRegistry as unknown as Registry);
      const state = storedState(ctx);
      const selected = ctx.model?.provider === ROUTER_PROVIDER && ctx.model?.id === ROUTER_ID;
      lines.push(selected ? (state ? `this session: ${state.phase} on ${PROVIDER}/${state.model}${describeEscalation(state)}` : "this session: no request routed yet") : "not selected: /model coop/auto turns it on");
      ctx.ui.notify(`coop/auto\n${lines.join("\n")}`, "info");
    },
  });
}

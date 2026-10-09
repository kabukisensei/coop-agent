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
// - `retry` stays on the model that failed, so prompt caches and thinking
//   signatures stay valid; `continuation` stays on the turn's model, except that
//   the first successful edit or write of a planning turn hands the rest of the
//   work to the build model, and the session stays there.
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

export const PROVIDER = "openai-codex";
export const ROUTER_PROVIDER = "coop";
export const ROUTER_ID = "auto";

export type Tier = "plan" | "standard" | "build";
export const TIERS: readonly Tier[] = ["plan", "standard", "build"];

/** Candidate model ids per tier, first available wins. Override with COOP_ROUTER_MODELS
 * (`plan=a,b;standard=c;build=d`) for a measurement run; the ids must be openai-codex
 * chat models that the signed-in account can use. */
export const DEFAULT_TIER_MODELS: Record<Tier, readonly string[]> = {
  plan: ["gpt-5.6-sol", "gpt-6-sol", "gpt-5.5"],
  standard: ["gpt-5.6-terra", "gpt-6-sol", "gpt-5.5"],
  build: ["gpt-5.6-luna", "gpt-6-luna", "gpt-5.6-terra"],
};

/** A prompt at least this long (characters) plans on the plan model. */
export const LONG_PROMPT_CHARS = 4000;
/** A low-thinking prompt at most this long is a quick answer on the build model. */
export const SHORT_PROMPT_CHARS = 400;

/** Tools whose successful result means implementation has started. */
const EDIT_TOOLS = new Set(["edit", "write"]);

export interface RouterState {
  phase: "planning" | "implementation";
  /** openai-codex model id for this phase. */
  model: string;
  tier: Tier;
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

export function tierModels(env: NodeJS.ProcessEnv = process.env): Record<Tier, readonly string[]> {
  const override = parseTierOverride(env.COOP_ROUTER_MODELS);
  return { plan: override.plan ?? DEFAULT_TIER_MODELS.plan, standard: override.standard ?? DEFAULT_TIER_MODELS.standard, build: override.build ?? DEFAULT_TIER_MODELS.build };
}

function usable(registry: Registry, model: any): boolean {
  if (!model || model.provider !== PROVIDER) return false;
  if (typeof registry.hasConfiguredAuth === "function") {
    try { return registry.hasConfiguredAuth(model) === true; } catch { return false; }
  }
  return true;
}

/** The first catalog model of a tier the signed-in account can use. */
export function resolveTier(tier: Tier, registry: Registry, env: NodeJS.ProcessEnv = process.env): any {
  const ids = tierModels(env)[tier];
  for (const id of ids) {
    const model = registry.find(PROVIDER, id);
    if (usable(registry, model)) return model;
  }
  throw new Error(`coop/auto: none of the ${tier} models (${ids.join(", ")}) is in the catalog with an OpenAI Codex sign-in. Run /login openai-codex, or pick a model with /model.`);
}

export function lastUserText(messages: readonly any[]): string {
  const content = messages.filter((m) => m?.role === "user").at(-1)?.content ?? "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block: any) => (block?.type === "text" ? [String(block.text ?? "")] : [])).join("\n");
}

/** Whether a tool call since the last user message edited a file successfully. */
export function editedThisTurn(messages: readonly any[]): boolean {
  const lastUser = messages.findLastIndex((m) => m?.role === "user");
  return messages.slice(lastUser + 1).some((m) => m?.role === "toolResult" && EDIT_TOOLS.has(m.toolName) && !m.isError);
}

/** The tier a new user request starts on. */
export function classifyRequest(prompt: string, level: ThinkingLevel): Tier {
  const length = prompt.trim().length;
  if (level === "high" || level === "xhigh" || level === "max" || length >= LONG_PROMPT_CHARS) return "plan";
  if ((level === "low" || level === "minimal" || level === "off") && length <= SHORT_PROMPT_CHARS) return "build";
  return "standard";
}

function route(model: any, thinkingLevel: ThinkingLevel, state?: RouterState) {
  return { model, thinkingLevel, state };
}

function phaseState(tier: Tier, model: any): RouterState {
  return { phase: tier === "build" ? "implementation" : "planning", model: model.id, tier };
}

/** The model a stored state names, re-resolved by tier when the catalog no longer has it. */
function stateModel(state: RouterState, registry: Registry, env: NodeJS.ProcessEnv): any {
  const model = registry.find(PROVIDER, state.model);
  if (usable(registry, model)) return model;
  return resolveTier(state.tier, registry, env);
}

/** Pick the physical model and thinking level for one request. Pure: no Pi, no I/O. */
export function routeRequest(request: RouteInput, registry: Registry, env: NodeJS.ProcessEnv = process.env) {
  const level = request.thinkingLevel;
  if (request.reason === "direct") return route(resolveTier("build", registry, env), "low");
  const state = request.state;
  if (request.reason === "retry") {
    const sticky = request.failed ?? request.previous;
    if (sticky && usable(registry, sticky.model)) return route(sticky.model, sticky.thinkingLevel ?? level, state);
  }
  if (request.reason === "continuation" || request.reason === "retry") {
    if (state?.phase === "planning" && editedThisTurn(request.messages)) {
      const build = resolveTier("build", registry, env);
      return route(build, level, phaseState("build", build));
    }
    if (state) return route(stateModel(state, registry, env), level, state);
    if (request.previous && usable(registry, request.previous.model)) return route(request.previous.model, level, state);
  }
  // A user request (or the first request of a session with no state yet).
  let tier = classifyRequest(lastUserText(request.messages), level);
  if (state?.phase === "implementation" && tier !== "plan") tier = "build";
  if (state && state.tier === tier) return route(stateModel(state, registry, env), level, state);
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

/** One line per tier naming the model it resolves to, or why it cannot. */
export function describeTiers(registry: Registry, env: NodeJS.ProcessEnv = process.env): string[] {
  return TIERS.map((tier) => {
    try { return `${tier}: ${PROVIDER}/${resolveTier(tier, registry, env).id}`; } catch { return `${tier}: none available (${tierModels(env)[tier].join(", ")})`; }
  });
}

export default function coopRouter(pi: ExtensionAPI) {
  if (typeof (pi as any).registerVirtualModel !== "function") return; // Pi before 0.99: no virtual models
  pi.registerVirtualModel<RouterState>({
    provider: ROUTER_PROVIDER,
    id: ROUTER_ID,
    name: "Auto (coop router)",
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    // Shared by the Codex models; shown before the first response.
    contextWindow: 272_000,
    maxTokens: 128_000,
    route(request, ctx: ExtensionContext) {
      return routeRequest(request as RouteInput, ctx.modelRegistry as unknown as Registry);
    },
  });
  pi.registerCommand("router", {
    description: "Show what coop/auto routes to: the model per tier and this session's phase",
    handler: async (_args, ctx) => {
      const lines = describeTiers(ctx.modelRegistry as unknown as Registry);
      const state = storedState(ctx);
      const selected = ctx.model?.provider === ROUTER_PROVIDER && ctx.model?.id === ROUTER_ID;
      lines.push(selected ? (state ? `this session: ${state.phase} on ${PROVIDER}/${state.model}` : "this session: no request routed yet") : "not selected: /model coop/auto turns it on");
      ctx.ui.notify(`coop/auto\n${lines.join("\n")}`, "info");
    },
  });
}

// The coop/auto routing rule (master plan R1), shared by extensions/coop-router
// (the virtual model) and lib/router-trial.mjs (the J0 classifier trial, which
// scores classifiers against this rule and against hand labels). Pure: no Pi.

/** A prompt at least this long (characters) plans on the plan model. */
export const LONG_PROMPT_CHARS = 4000;
/** A low-thinking prompt at most this long is a quick answer on the build model. */
export const SHORT_PROMPT_CHARS = 400;
/** A medium-thinking prompt at most this long that reads as a question is a lookup on the build model. */
export const LOOKUP_PROMPT_CHARS = 80;

export const TIERS = ["plan", "standard", "build"];

// A lookup: one short question (a question word first and a question mark last),
// or a "define / name / explain" ask. The J0 trial (2026-10-19) showed the rule's
// only misses on its set were seven of these at medium thinking, sent to the
// standard model; a classifier routed them to build. An imperative of the same
// length ("Make coop update --edge print the commit") stays standard.
const LOOKUP_QUESTION = /^(what|which|who|whom|whose|where|when|why|how|does|do|did|is|are|was|were|can|could|should|will|would|has|have)\b[\s\S]*\?\s*$/i;
const LOOKUP_ASK = /^(define|name|explain)\b/i;

/** Whether a prompt is a short lookup question (see LOOKUP_PROMPT_CHARS). */
export function isLookupQuestion(prompt) {
  const text = String(prompt ?? "").trim();
  return text.length > 0 && text.length <= LOOKUP_PROMPT_CHARS && (LOOKUP_QUESTION.test(text) || LOOKUP_ASK.test(text));
}

/** The tier a new user request starts on: by the thinking level picked, the prompt's length, and whether it is a lookup. */
export function classifyRequest(prompt, level) {
  const length = String(prompt ?? "").trim().length;
  if (level === "high" || level === "xhigh" || level === "max" || length >= LONG_PROMPT_CHARS) return "plan";
  if ((level === "low" || level === "minimal" || level === "off") && length <= SHORT_PROMPT_CHARS) return "build";
  if (level === "medium" && isLookupQuestion(prompt)) return "build";
  return "standard";
}

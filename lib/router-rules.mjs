// The coop/auto routing rule (master plan R1), shared by extensions/coop-router
// (the virtual model) and lib/router-trial.mjs (the J0 classifier trial, which
// scores classifiers against this rule and against hand labels). Pure: no Pi.

/** A prompt at least this long (characters) plans on the plan model. */
export const LONG_PROMPT_CHARS = 4000;
/** A low-thinking prompt at most this long is a quick answer on the build model. */
export const SHORT_PROMPT_CHARS = 400;

export const TIERS = ["plan", "standard", "build"];

/** The tier a new user request starts on: by the thinking level picked and the prompt's length. */
export function classifyRequest(prompt, level) {
  const length = String(prompt ?? "").trim().length;
  if (level === "high" || level === "xhigh" || level === "max" || length >= LONG_PROMPT_CHARS) return "plan";
  if ((level === "low" || level === "minimal" || level === "off") && length <= SHORT_PROMPT_CHARS) return "build";
  return "standard";
}

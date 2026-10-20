// The coop/auto routing rule (master plan R1), used by extensions/coop-router
// (the virtual model) and tested on the synthetic prompt sets by
// tests/router-rules.test.mjs. Pure: no Pi.

/** A prompt at least this long (characters) plans on the plan model. */
export const LONG_PROMPT_CHARS = 4000;
/** A prompt at most this long at low or medium thinking is a short task on the build model. */
export const SHORT_PROMPT_CHARS = 400;

export const TIERS = ["plan", "standard", "build"];

/** Thinking levels whose short prompts are short tasks for the build model. */
const SHORT_TASK_LEVELS = new Set(["off", "minimal", "low", "medium"]);

/**
 * The tier a new user request starts on: by the thinking level picked and the
 * prompt's length. A short prompt at medium thinking is a build-model task too:
 * the blind quality test (dev VM, 2026-10-19; 30 edits and 30 lookups, two
 * graders) scored the build model above the standard model on both, at a tenth
 * of the cost, and every refusal in that run came from the standard model.
 */
export function classifyRequest(prompt, level) {
  const length = String(prompt ?? "").trim().length;
  if (level === "high" || level === "xhigh" || level === "max" || length >= LONG_PROMPT_CHARS) return "plan";
  if (SHORT_TASK_LEVELS.has(level) && length <= SHORT_PROMPT_CHARS) return "build";
  return "standard";
}

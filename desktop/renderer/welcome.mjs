// The empty window's first minutes (desktop UX review, 2026-10-03): the
// set-up items a fresh machine still owes (sign-in, the COOP profile, Azure),
// each with the terminal command that settles it, and three example prompts a
// teammate can start from. Pure functions; app.mjs renders them.

/** How a launch notice from coop.ps1 is read: what to run, and where. */
const NOTICE_RULES = [
  { test: /onboarding is incomplete/i, id: "onboard", command: "coop onboard", text: "Your COOP profile (name, client platform) is not set up yet." },
  { test: /az login|azure (cli )?(authentication|sign-in|login)/i, id: "azure", command: "az login", text: "Azure sign-in is missing, so Fabric Warehouse queries are off." },
  { test: /\/login|model sign-in|no stored (provider )?credential/i, id: "login", command: "/login", text: "No model sign-in yet." },
];

/**
 * The set-up list for a window: `[{ id, text, command, detail }]`, newest
 * launch notices included. `command` is what to run in the terminal coop opens
 * on this session (`/login` runs inside coop; the others in the console).
 * Empty when nothing is owed.
 */
export function setupItems({ loginPresent = true, notices = [] } = {}) {
  const items = [];
  const seen = new Set();
  const add = (item) => { if (!seen.has(item.id)) { seen.add(item.id); items.push(item); } };
  if (loginPresent === false) add({ id: "login", text: "No model sign-in yet. coop cannot answer until you sign in once.", command: "/login", detail: "" });
  for (const raw of notices) {
    const text = String(raw || "").trim();
    if (!text) continue;
    const rule = NOTICE_RULES.find((r) => r.test.test(text));
    if (rule) add({ id: rule.id, text: rule.text, command: rule.command, detail: text });
    else add({ id: `notice:${text.slice(0, 80)}`, text, command: "", detail: "" });
  }
  return items;
}

/** One line for the banner above the conversation. */
export function setupSummary(items) {
  const commands = items.filter((item) => item.command).length;
  if (!items.length) return "";
  if (items.length === 1) return items[0].text;
  return `${items.length} set-up items${commands ? `, ${commands} need${commands === 1 ? "s" : ""} a terminal` : ""}.`;
}

/**
 * Example prompts for the empty window, each a task from the Start menu in
 * one sentence. The chip fills the prompt; the person edits and sends.
 */
export const EXAMPLES = Object.freeze([
  { label: "Check this machine is ready", prompt: "Check that this machine is ready: run coop doctor and explain anything that is not green in plain language, with the exact command to fix it." },
  { label: "Explain a SQL view or DAX measure", prompt: "Explain what @ does, where its data comes from and what depends on it. (Replace @ with the file.)" },
  { label: "Review changes against the standards", prompt: "Review the files changed since the last commit against the Cooptimize standards and list what needs fixing, most important first." },
]);

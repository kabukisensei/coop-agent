// Secret-text patterns: the one copy (FEATURES-DESIGN, CW1 "Changes after review" B4a).
// The design names this file lib/secrets.mjs; that name matches .gitignore's
// `secrets*` (kept so a real secrets file is never committed), so it would never
// ship. Same module, this name.
//
// These regexes find secrets in TEXT (a token, a password value, a signed key).
// They were the "secret" rules of lib/feedback.mjs's BASE_RULES and moved here
// unchanged; lib/feedback.mjs imports them back in its original order, so a
// feedback report is redacted exactly as before. lib/client-rules.mjs uses the
// same patterns to keep a secret out of the client's instructions and its
// corrections log.
//
// isSecretPath (coop-guardrails) checks file NAMES only; it is not used for text.

/** A bearer token. */
export const SECRET_BEARER = { label: "secret", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, to: "Bearer <secret>" };
/** A JSON web token (three base64url parts). */
export const SECRET_JWT = { label: "secret", re: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, to: "<secret>" };
/** Provider token prefixes: GitHub, OpenAI-style sk-, Slack. */
export const SECRET_PREFIXED = { label: "secret", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})/g, to: "<secret>" };
/** `password=...`, `api_key: ...`, `sig=...` and the like. */
export const SECRET_KEY_VALUE = { label: "secret", re: /\b(password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|api[_-]?key|account[_-]?key|sharedaccesskey|sig)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s;,&]+)/gi, to: "$1$2<secret>" };
/** A long base64-like run (a key, a signature). Last: it is the widest. */
export const SECRET_LONG_TOKEN = { label: "secret", re: /\b[A-Za-z0-9+/_-]{40,}={0,2}/g, to: "<secret>" };

/** Every secret-text rule, in the order lib/feedback.mjs applies them. */
export const SECRET_TEXT_RULES = Object.freeze([SECRET_BEARER, SECRET_JWT, SECRET_PREFIXED, SECRET_KEY_VALUE, SECRET_LONG_TOKEN]);

// --- Text-only rules (fix round, Neon B4) ---------------------------------------
// findSecretText screens prose a person wrote (client instructions, a correction).
// It adds shapes the feedback rules never needed (they run on a report whose paths
// are already redacted) and judges long unlabelled runs by their shape, not their
// length alone. lib/feedback.mjs still applies SECRET_TEXT_RULES above, unchanged.

/** Text-only rules, each with the short name findSecretText reports. */
const TEXT_ONLY_RULES = Object.freeze([
  { name: "a private key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { name: "a password in a URL", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
  { name: "a provider token", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "a signed key", re: /\bSharedAccessSignature\s*[=:]?\s*\S*\bsig=|\bSharedAccessSignature\s*[=:]\s*\S/i },
  { name: "a client secret", re: /(?:^|[^A-Za-z0-9_.~-])[A-Za-z0-9_.-]{3,4}Q~[A-Za-z0-9_.~-]{30,}/ },
  { name: "a secret value", re: /\b(?:api|client|access|refresh|account|secret|private|auth|sas|storage)[_-]?(?:key|secret|token|password)\b\s*[=:]\s*["']?[^\s"',;]{4,}/i },
]);

/** A long unlabelled run: letters, digits and the symbols keys are written with. */
const LONG_RUN = /[A-Za-z0-9+/_~.=-]{40,}/g;
const charClass = (c) => (/[a-z]/.test(c) ? "l" : /[A-Z]/.test(c) ? "u" : "d");

/**
 * True when a long run reads like a name or a path (a SQL object, a repo path, a
 * dotted namespace), not a key: few character-class changes (a random key flips
 * case and digits about every other character; a capital starting a word is not a
 * change) and mostly real word pieces, or many short segments (a snake_case or
 * abbreviated name). A run with `+`, `~` or base64 `=` padding is never a name.
 * Trade-off, by design: about 1 in 100 random letter-and-digit keys with none of
 * those symbols reads as a name and passes; a labelled secret (password=, a token
 * prefix, a URL password) is caught by the rules before this one.
 */
export function looksLikeName(run) {
  if (/[+~]|=$/.test(run)) return false;
  const body = run.replace(/[^A-Za-z0-9]/g, "");
  if (!body) return true;
  let flips = 0;
  for (let i = 1; i < body.length; i++) {
    const a = charClass(body[i - 1]);
    const b = charClass(body[i]);
    if (a !== b && !(a === "u" && b === "l")) flips++;
  }
  if (flips / body.length >= 0.3) return false;
  const wordChars = (run.match(/[A-Z]?[a-z]{3,}|[A-Z]{2,5}(?![a-z])|\d{3,}/g) || []).join("").length;
  if (wordChars / body.length >= 0.6) return true;
  const segments = run.split(/[/_.-]+/);
  return segments.length >= 5 && Math.max(...segments.map((x) => x.length)) <= 20;
}

/**
 * The first secret-text pattern `text` matches, as a short name, or "" when none
 * does. Pure; the shared rules' `g` flags carry no state between calls here.
 */
export function findSecretText(text) {
  const value = String(text ?? "");
  const names = ["a bearer token", "a web token", "a provider token", "a secret value"];
  for (let i = 0; i < names.length; i++) {
    const rule = SECRET_TEXT_RULES[i];
    if (new RegExp(rule.re.source, rule.re.flags.replace("g", "")).test(value)) return names[i];
  }
  for (const rule of TEXT_ONLY_RULES) if (rule.re.test(value)) return rule.name;
  for (const m of value.matchAll(LONG_RUN)) {
    const run = m[0].replace(/^[.]+|[.]+$/g, "");
    if (run.length >= 40 && !looksLikeName(run)) return "a long key or signature";
  }
  return "";
}

/** True when `text` matches any secret-text pattern. */
export function hasSecretText(text) {
  return findSecretText(text) !== "";
}

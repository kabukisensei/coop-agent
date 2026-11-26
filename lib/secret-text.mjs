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

/**
 * The first secret-text pattern `text` matches, as a short name, or "" when none
 * does. Pure; the shared rules' `g` flags carry no state between calls here.
 */
export function findSecretText(text) {
  const value = String(text ?? "");
  const names = ["a bearer token", "a web token", "a provider token", "a secret value", "a long key or signature"];
  for (let i = 0; i < SECRET_TEXT_RULES.length; i++) {
    const rule = SECRET_TEXT_RULES[i];
    if (new RegExp(rule.re.source, rule.re.flags.replace("g", "")).test(value)) return names[i];
  }
  return "";
}

/** True when `text` matches any secret-text pattern. */
export function hasSecretText(text) {
  return findSecretText(text) !== "";
}

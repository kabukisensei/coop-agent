import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { validateUpdateTrustStore } from "./update-service.mjs";

const MAX_TRUST_BYTES = 64 * 1024;

function fail(message) { throw new Error(message); }
function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function loadPackagedUpdateTrust({ packaged, appPath } = {}) {
  if (!packaged) return Object.freeze({ configured: false, reason: "development-build", activeKeyIds: Object.freeze([]), trustStore: null });
  if (typeof appPath !== "string" || !isAbsolute(appPath)) fail("Packaged update trust root is invalid.");
  let root;
  try { root = realpathSync(appPath); } catch { fail("Packaged update trust root is unavailable."); }
  const candidate = join(root, "resources", "desktop-update-trust.json");
  if (!existsSync(candidate)) return Object.freeze({ configured: false, reason: "not-provisioned", activeKeyIds: Object.freeze([]), trustStore: null });
  let stat;
  let resolved;
  try {
    stat = lstatSync(candidate);
    resolved = realpathSync(candidate);
  } catch { fail("Packaged update trust policy is unreadable."); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_TRUST_BYTES || !inside(root, resolved)) fail("Packaged update trust policy is not a bounded in-app file.");
  let value;
  try { value = JSON.parse(readFileSync(resolved, "utf8")); } catch { fail("Packaged update trust policy is invalid JSON."); }
  const trustStore = validateUpdateTrustStore(value);
  const activeKeyIds = Object.freeze(trustStore.keys.filter((key) => key.status === "active").map((key) => key.keyId));
  if (!activeKeyIds.length) fail("Packaged update trust policy has no active key.");
  return Object.freeze({ configured: true, reason: null, activeKeyIds, trustStore });
}

export function updateTrustSummary(value) {
  return Object.freeze({ configured: value.configured === true, reason: value.reason || null, activeKeyIds: Object.freeze([...(value.activeKeyIds || [])]) });
}

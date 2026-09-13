/** Coop build identity — resolves the checkout's OWN trustworthy revision.
 *
 * The build fingerprint identifies the coop build that produced a support
 * bundle. It must come from the coop checkout itself (the installed COOP_ROOT
 * this file ships in) — never from the user's project HEAD, which says
 * nothing about which coop build is running.
 *
 * Existing trustworthy mechanisms, in order:
 *   version: the VERSION file at the checkout root (shipped in every bundle)
 *   commit:  `git -C <coopRoot> rev-parse HEAD` (absent in packaged runtimes
 *            without .git — then the identity is honestly build-unavailable)
 *
 * Everything is injectable so the contract can be unit-tested without git or
 * a filesystem.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ok = (value) => ({ ok: true, value });
const diag = (errors) => ({ ok: false, errors });
const COMMIT = /^[0-9a-f]{40}$/;

export function resolveCoopBuildIdentity(coopRoot, {
  execFileImpl = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim(),
  readVersionImpl = (root) => readFileSync(join(root, "VERSION"), "utf8"),
} = {}) {
  if (typeof coopRoot !== "string" || !coopRoot) return diag(["build-identity: coopRoot is required"]);
  let version = null;
  try {
    version = readVersionImpl(coopRoot);
  } catch {
    version = null;
  }
  if (typeof version !== "string" || !version.trim()) return diag(["build-identity: VERSION is unavailable"]);
  let commit = null;
  try {
    commit = execFileImpl("git", ["-C", coopRoot, "rev-parse", "HEAD"]);
  } catch {
    commit = null;
  }
  if (typeof commit !== "string" || !COMMIT.test(commit.trim())) return diag(["build-identity: checkout revision is unavailable"]);
  return ok({ version: version.trim(), commit: commit.trim() });
}

/** coop profile-root paths (master plan S3: one profile root).
 *
 * The ONE meaning of the location variables, shared with lib/common.ps1
 * (Get-CoopProfileDir and friends) and lib/coop_paths.py:
 *
 * - COOP_DIR is the PARENT of `.coop`: the profile dir is `$COOP_DIR/.coop`,
 *   default `~/.coop`. It holds config, user.json, agent/, support/, standards/.
 * - The agent dir Pi actually loads is resolved by ONE chain everywhere:
 *   PI_CODING_AGENT_DIR -> COOP_NO_ISOLATE truthy (1|true|yes|on, any case)
 *   -> ~/.pi/agent -> COOP_AGENT_DIR -> `<profile dir>/agent`.
 *
 * Home is os.homedir() (USERPROFILE on Windows, HOME elsewhere; never the
 * working directory). With no variables set every helper yields the historical
 * `~/.coop/...` path. Pure: reads only `env`, never the filesystem.
 */
import { homedir } from "node:os";
import { join } from "node:path";

const NO_ISOLATE_RE = /^(1|true|yes|on)$/i;

const read = (env, name) => {
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
};

/** True when COOP_NO_ISOLATE is 1/true/yes/on (case-insensitive). */
export function noIsolate(env = process.env) {
  return NO_ISOLATE_RE.test(read(env, "COOP_NO_ISOLATE"));
}

export function homeDir() {
  return homedir();
}

/** `$COOP_DIR/.coop` when COOP_DIR is set, else `~/.coop`. */
export function profileDir(env = process.env) {
  const base = read(env, "COOP_DIR");
  return join(base || homeDir(), ".coop");
}

/** The fleet/integration config: `<profile dir>/config`. */
export function configPath(env = process.env) {
  return join(profileDir(env), "config");
}

/** The local user profile: `<profile dir>/user.json`. */
export function userProfilePath(env = process.env) {
  return join(profileDir(env), "user.json");
}

/**
 * The machine-level profile (master plan P1): one `user.json` per machine for
 * the team's VMs, where every client is its own Windows user. COOP_MACHINE_DIR
 * names its folder (tests, sandboxes); else `%ProgramData%\coop` on Windows
 * and `/etc/coop` elsewhere. It holds only a person's name and communication
 * preference, never anything client-shaped; the per-user file wins field by field.
 */
export function machineProfileDir(env = process.env, platform = process.platform) {
  const configured = read(env, "COOP_MACHINE_DIR");
  if (configured) return configured;
  if (platform === "win32") return join(read(env, "ProgramData") || "C:\\ProgramData", "coop");
  return "/etc/coop";
}

/** The machine-level profile file: `<machine dir>/user.json`. */
export function machineProfilePath(env = process.env, platform = process.platform) {
  return join(machineProfileDir(env, platform), "user.json");
}

/** coop's ISOLATED Pi agent dir: COOP_AGENT_DIR, else `<profile dir>/agent`
 *  (mirror of Get-CoopPiAgentDir). */
export function coopAgentDir(env = process.env) {
  const configured = read(env, "COOP_AGENT_DIR");
  return configured || join(profileDir(env), "agent");
}

/** The user's own Pi agent dir (`~/.pi/agent`); loaded with COOP_NO_ISOLATE. */
export function personalPiAgentDir() {
  return join(homeDir(), ".pi", "agent");
}

/** The agent dir Pi will ACTUALLY load (mirror of Get-CoopEffectiveAgentDir). */
export function agentDir(env = process.env) {
  const configured = read(env, "PI_CODING_AGENT_DIR");
  if (configured) return configured;
  if (noIsolate(env)) return personalPiAgentDir();
  return coopAgentDir(env);
}

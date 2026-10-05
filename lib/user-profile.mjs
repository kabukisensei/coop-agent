/** The effective coop user profile (master plan P1: the machine-level profile).
 *
 * Two files hold a person's name and communication preference:
 *   - the per-user `<profile dir>/user.json` (lib/paths.mjs userProfilePath),
 *     written by `coop onboard` and the window's set-up card;
 *   - the machine-level `<machine dir>/user.json` (machineProfilePath), written
 *     once per machine by `coop onboard --machine`, for the team's VMs where
 *     every client is its own Windows user and one person owns the machine.
 * The per-user file wins field by field; the machine file fills what it lacks.
 * The machine file carries only the name and the communication preference,
 * never a client, tenant, workspace, contract, memory or session: everything
 * client-shaped stays in the client's Windows user. Readers: coop-profile,
 * coop-powerline, the window's vibes and set-up card, the /setup-project name
 * question, `coop doctor` (lib/common.ps1 mirrors this in PowerShell).
 */
import { readFileSync } from "node:fs";
import { machineProfilePath, userProfilePath } from "./paths.mjs";

export const COMMUNICATION_PRESETS = Object.freeze(["concise", "balanced", "teaching", "custom"]);

/** Mirror of scripts/context-budget.py _sanitize: control characters to spaces, collapsed, trimmed, capped. */
export function sanitizeProfileText(value, max = 100) {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * One profile file as its fields: `{ name, communication }` where either may be
 * null when the file lacks or misstates it; null when the file is missing,
 * malformed or of an unknown schema. Never throws.
 */
export function readProfileFile(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || raw.schema_version !== 1) return null;
  const name = typeof raw.name === "string" ? sanitizeProfileText(raw.name) : "";
  let communication = null;
  const comm = raw.communication;
  if (typeof comm === "object" && comm !== null && typeof comm.preset === "string" && COMMUNICATION_PRESETS.includes(comm.preset)) {
    communication = {
      preset: comm.preset,
      custom_instructions: typeof comm.custom_instructions === "string" ? sanitizeProfileText(comm.custom_instructions, 1000) : "",
    };
  }
  return { name: name || null, communication };
}

/**
 * The profile coop uses: `{ profile, source, userPath, machinePath }`. `profile`
 * is `{ schema_version: 1, name, communication }` or null when neither file
 * supplies a name; `source.name` / `source.communication` say which file supplied
 * each field ("user", "machine" or ""). A field the per-user file states wins.
 */
export function effectiveProfile(env = process.env) {
  const userPath = userProfilePath(env);
  const machinePath = machineProfilePath(env);
  const user = readProfileFile(userPath);
  const machine = readProfileFile(machinePath);
  const pick = (field) => {
    if (user && user[field]) return { value: user[field], source: "user" };
    if (machine && machine[field]) return { value: machine[field], source: "machine" };
    return { value: null, source: "" };
  };
  const name = pick("name");
  const communication = pick("communication");
  const source = { name: name.source, communication: communication.source };
  if (!name.value) return { profile: null, source, userPath, machinePath };
  return {
    profile: {
      schema_version: 1,
      name: name.value,
      communication: communication.value || { preset: "balanced", custom_instructions: "" },
    },
    source,
    userPath,
    machinePath,
  };
}

/** The name coop calls the person, or "" when no file supplies one. */
export function effectiveProfileName(env = process.env) {
  return effectiveProfile(env).profile?.name || "";
}

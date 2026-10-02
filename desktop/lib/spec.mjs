// The launch spec `coop desktop` hands to the window (COOP_DESKTOP_SPEC). It is
// built by bin/coop.ps1 from the same Build-CoopPiArgs the terminal uses, so the
// window never assembles Pi's arguments itself. This module only validates it
// and adds `--mode rpc`.
import { isAbsolute } from "node:path";
import { win32, posix } from "node:path";

const ENV_KEY = /^(PI|COOP)_[A-Z0-9_]{1,80}$/;

export class SpecError extends Error {}

function absolute(value, name) {
  if (typeof value !== "string" || !value || /[\0\r\n]/.test(value) || !(isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value))) {
    throw new SpecError(`${name} must be an absolute path`);
  }
  return value;
}

/** Parse and validate the JSON spec. Throws SpecError with a reason. */
export function parseSpec(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new SpecError("coop desktop did not pass a launch spec; start the window with: coop desktop");
  let spec;
  try { spec = JSON.parse(raw); } catch { throw new SpecError("the launch spec is not valid JSON"); }
  if (!spec || spec.schema !== 1) throw new SpecError("the launch spec has an unknown schema; run coop update");
  const node = absolute(spec.node, "node");
  const entry = absolute(spec.entry, "Pi entry");
  const cwd = absolute(spec.cwd, "working folder");
  const coop = spec.coop ? absolute(spec.coop, "coop.ps1") : null;
  if (!Array.isArray(spec.args) || spec.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new SpecError("the launch spec arguments are invalid");
  }
  // The window owns the mode; a spec that already chose one is not coop's.
  if (spec.args.some((arg) => arg === "--mode" || arg.startsWith("--mode=") || arg === "-p" || arg === "--print")) {
    throw new SpecError("the launch spec already sets a Pi mode");
  }
  const env = {};
  for (const [key, value] of Object.entries(spec.env || {})) {
    if (!ENV_KEY.test(key) || typeof value !== "string" || value.includes("\0")) throw new SpecError(`launch spec environment entry ${key} is not allowed`);
    env[key] = value;
  }
  return {
    node, entry, cwd, coop, args: [...spec.args], env,
    version: typeof spec.version === "string" ? spec.version.slice(0, 40) : "",
    // No stored model sign-in: the window offers the terminal's /login.
    loginPresent: spec.loginPresent !== false,
    // Launch warnings coop printed in the console the window replaced.
    notices: Array.isArray(spec.notices) ? spec.notices.filter((n) => typeof n === "string" && n.trim()).slice(0, 8).map((n) => n.slice(0, 500)) : [],
  };
}

/** The exact argv the window runs: node <pi entry> --mode rpc <coop's args>. */
export function piArgv(spec) {
  return { command: spec.node, args: [spec.entry, "--mode", "rpc", ...spec.args] };
}

/** Pi's environment: the window's own, without Electron's variables, plus coop's. */
export function piEnv(spec, baseEnv, { fabricToken = "" } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key.startsWith("ELECTRON_") || key === "NODE_OPTIONS" || key === "COOP_DESKTOP_SPEC" || key === "COOP_FABRIC_MCP_TOKEN") continue;
    env[key] = value;
  }
  Object.assign(env, spec.env);
  env.COOP_DESKTOP = "1";
  if (fabricToken) env.COOP_FABRIC_MCP_TOKEN = fabricToken;
  return env;
}

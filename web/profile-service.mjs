import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const USER_PROFILE_SERVICE_VERSION = 1;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function command(args, env) {
  return {
    bin: env.COOP_PYTHON || (process.platform === "win32" ? "python" : "python3"),
    args: [join(ROOT, "scripts", "onboard.py"), "profile", ...args],
  };
}

async function invoke(spec, { env, input = "", execute } = {}) {
  if (execute) return execute(spec, input);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.bin, spec.args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", bytes = 0;
    child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes <= 128 * 1024) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { if (stderr.length < 16 * 1024) stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, oversized: bytes > 128 * 1024 }));
    child.stdin.end(input);
  });
}

function parsed(result) {
  if (result.oversized) throw new Error("Profile response exceeded the safe limit.");
  try { return JSON.parse(String(result.stdout || "").trim()); }
  catch { throw new Error("Profile service returned an unreadable response."); }
}

async function getContract({ env, execute }) {
  const result = await invoke(command(["--contract-json"], env), { env, execute });
  if (result.code !== 0) throw new Error("Profile questionnaire contract is unavailable.");
  return parsed(result);
}

export async function getUserProfile({ env = process.env, execute } = {}) {
  const [result, questionnaire] = await Promise.all([
    invoke(command(["--json"], env), { env, execute }),
    getContract({ env, execute }),
  ]);
  if (result.code !== 0) return { schemaVersion: USER_PROFILE_SERVICE_VERSION, state: "not-configured", profile: null, questionnaire };
  return { schemaVersion: USER_PROFILE_SERVICE_VERSION, state: "configured", profile: parsed(result), questionnaire };
}

export async function applyUserProfile(candidate, { approved = false, env = process.env, execute } = {}) {
  if (approved !== true) throw new Error("Explicit approval is required before saving the user profile.");
  const safe = {
    schema_version: 1,
    name: typeof candidate?.name === "string" ? candidate.name : "",
    communication: {
      preset: typeof candidate?.communication?.preset === "string" ? candidate.communication.preset : "",
      custom_instructions: typeof candidate?.communication?.custom_instructions === "string" ? candidate.communication.custom_instructions : "",
    },
  };
  const result = await invoke(command(["--apply-json"], env), { env, input: JSON.stringify(safe), execute });
  if (result.code !== 0) throw new Error(String(result.stderr || "Profile validation failed.").trim().split("\n").at(-1));
  return {
    schemaVersion: USER_PROFILE_SERVICE_VERSION,
    state: "configured",
    profile: parsed(result),
    questionnaire: await getContract({ env, execute }),
  };
}

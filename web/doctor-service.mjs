import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runManagedDoctor } from "./managed-doctor-service.mjs";

export const DOCTOR_REPORT_SCHEMA_VERSION = 1;
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(HERE, "..");
const OUTPUT_MAX = 4 * 1024 * 1024;

function slug(value) {
  return String(value || "general")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "general";
}

function stateFor(check) {
  const summary = String(check.name || "").toLowerCase();
  if (check.status === "fail") return "error";
  if (check.status === "ok" && /\b(?:disabled|not applicable)\b/.test(summary)) return "skipped";
  if (check.status === "ok") return "healthy";
  if (check.status === "warn" && /\b(?:missing|not installed|not found|not configured|unavailable|cannot check|no .* found)\b/.test(summary)) return "unavailable";
  if (check.status === "warn") return "warning";
  return "unavailable";
}

function stableIdentityText(check) {
  return `${check.section || "general"}\n${check.name || "check"}`
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[a-z]:\\[^\s)]+/gi, "<path>")
    .replace(/(?:^|\s)\/[\w./-]+/g, " <path>")
    .replace(/\b\d+\.\d+(?:\.\d+)?\b/g, "<version>")
    .replace(/\b\d+\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim();
}

function checkId(check) {
  const category = slug(check.section);
  const digest = createHash("sha256").update(stableIdentityText(check)).digest("hex").slice(0, 12);
  return `doctor.${category}.${digest}`;
}

function repairFor(hint) {
  const value = String(hint || "").toLowerCase();
  let operation = null;
  if (value.includes("coop sync")) operation = "sync";
  else if (value.includes("coop update")) operation = "update";
  else if (value.includes("coop install") || value.includes("pipx install") || value.includes("npm install")) operation = "install";
  else if (value.includes("sign in") || value.includes("login")) operation = "authenticate";
  else if (value.includes("project.yml") || value.includes("configure") || value.includes("set ")) operation = "configure";
  return operation
    ? { operationId: `doctor.repair.${operation}`, available: true, approvalRequired: true }
    : null;
}

export function normalizeDoctorReport(legacy, { now = new Date(), runId = randomUUID() } = {}) {
  if (!legacy || !Array.isArray(legacy.checks)) throw new TypeError("Doctor output did not contain a checks array.");
  const checks = legacy.checks.map((check) => {
    const state = stateFor(check);
    const hint = typeof check.hint === "string" && check.hint.trim() ? check.hint.trim() : null;
    return {
      id: checkId(check),
      category: String(check.section || "General"),
      state,
      summary: String(check.name || "Unnamed Doctor check"),
      evidence: { source: "coop doctor", legacyStatus: String(check.status || "unknown") },
      recommendedAction: hint,
      repair: repairFor(hint),
    };
  });
  const uniqueIds = new Set(checks.map((check) => check.id));
  if (uniqueIds.size !== checks.length) throw new TypeError("Doctor produced duplicate stable check IDs.");
  const counts = { healthy: 0, warning: 0, error: 0, unavailable: 0, skipped: 0 };
  for (const check of checks) counts[check.state]++;
  return {
    schemaVersion: DOCTOR_REPORT_SCHEMA_VERSION,
    runId,
    checkedAt: now.toISOString(),
    status: counts.error ? "error" : counts.warning || counts.unavailable ? "warning" : "healthy",
    counts,
    checks,
    diagnostics: [],
  };
}

function commandFor(platform, root, env) {
  if (platform === "win32") {
    return {
      bin: env.COOP_POWERSHELL || "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "doctor.ps1"), "--json"],
    };
  }
  return { bin: "bash", args: [join(root, "scripts", "doctor.sh"), "--json"] };
}

export async function runDoctor({
  cwd = process.cwd(),
  root = DEFAULT_ROOT,
  platform = process.platform,
  env = process.env,
  timeoutMs = 60_000,
  execute,
} = {}) {
  if (env.COOP_DESKTOP_MANAGED_RUNTIME === "1" && !execute) return normalizeDoctorReport(await runManagedDoctor({ root, env }));
  const invoke = execute || ((spec) => new Promise((resolve, reject) => {
    const child = spawn(spec.bin, spec.args, { cwd, env: { ...env, COOP_ROOT: root }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    let timedOut = false;
    const collect = (target, chunk) => {
      const next = target + chunk.toString("utf8");
      if (Buffer.byteLength(next) > OUTPUT_MAX) exceeded = true;
      return exceeded ? next.slice(0, OUTPUT_MAX) : next;
    };
    child.stdout.on("data", (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = collect(stderr, chunk); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    timer.unref();
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("Doctor timed out."));
      else if (exceeded) reject(new Error("Doctor output exceeded the safe limit."));
      else resolve({ code, stdout, stderr });
    });
  }));

  const spec = commandFor(platform, root, env);
  const result = await invoke(spec);
  let legacy;
  try {
    legacy = JSON.parse(String(result.stdout || "").trim());
  } catch {
    throw new Error(`Doctor did not return valid JSON${result.code == null ? "." : ` (exit ${result.code}).`}`);
  }
  return normalizeDoctorReport(legacy);
}

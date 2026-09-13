import { spawn } from "node:child_process";
import { statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const AUTH_PROVIDERS_SCHEMA_VERSION = 1;
const OUTPUT_MAX = 1024 * 1024;

export function modelProviderState({ env = process.env, agentDir, globalAgentDir = join(homedir(), ".pi", "agent"), stat = statSync, read = readFileSync } = {}) {
  // Pi accepts OPENAI_API_KEY from the runtime environment without auth.json.
  // Presence means configured credentials, not a successful provider request.
  if (typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim()) return "authenticated";
  // An explicit runtime profile is authoritative. Another Pi profile cannot
  // authenticate this one, even when the selected profile has no auth file yet.
  const directory = agentDir || globalAgentDir;
  if (!directory) return "unauthenticated";
  try {
    const path = join(directory, "auth.json");
    const metadata = stat(path);
    if (!metadata.isFile() || metadata.size > 1024 * 1024) return "error";
    if (!metadata.size) return "unauthenticated";
    const bytes = read(path, "utf8");
    if (Buffer.byteLength(bytes) > 1024 * 1024) return "error";
    const credentials = JSON.parse(bytes);
    if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) return "error";
    // Pi 0.84.3 owns this format. Inspect only readiness; never include credential
    // values in the provider report, logs, diagnostics, or thrown errors.
    const present = value => typeof value === "string" && value.trim().length > 0;
    const codex = credentials["openai-codex"];
    const openai = credentials.openai;
    if (codex?.type === "oauth" && present(codex.access) && present(codex.refresh) && Number.isFinite(codex.expires)) return "authenticated";
    if (openai?.type === "api_key" && present(openai.key)) return "authenticated";
    return "unauthenticated";
  } catch (error) {
    return error?.code === "ENOENT" ? "unauthenticated" : "error";
  }
}

export function normalizeMicrosoftAccount(result) {
  if (result?.kind === "unavailable") return { state: "unavailable", account: null, diagnostic: { code: "azure-cli-unavailable", message: "Azure CLI is not installed." } };
  if (result?.kind === "timeout") return { state: "error", account: null, diagnostic: { code: "azure-cli-timeout", message: "Azure account inspection timed out." } };
  if (!result || result.code !== 0) return { state: "unauthenticated", account: null, diagnostic: { code: "microsoft-sign-in-required", message: "No active Azure account was found." } };
  try {
    const value = JSON.parse(String(result.stdout || ""));
    const label = typeof value?.user?.name === "string" ? value.user.name : null;
    const tenantId = typeof value?.tenantId === "string" ? value.tenantId : null;
    const accountType = typeof value?.user?.type === "string" ? value.user.type : null;
    if (!tenantId && !label) throw new Error("missing account identity");
    return { state: "authenticated", account: { label, tenantId, accountType }, diagnostic: null };
  } catch {
    return { state: "error", account: null, diagnostic: { code: "azure-account-invalid", message: "Azure CLI returned an unreadable account response." } };
  }
}

export async function inspectMicrosoftAccount({ execute, env = process.env, timeoutMs = 15_000 } = {}) {
  const invoke = execute || (() => new Promise((resolve) => {
    const child = spawn("az", ["account", "show", "--output", "json", "--only-show-errors"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let bytes = 0;
    let timedOut = false;
    child.stderr.resume();
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= OUTPUT_MAX) stdout += chunk.toString("utf8");
    });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    timer.unref();
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve(error?.code === "ENOENT" ? { kind: "unavailable" } : { code: 1, stdout: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(timedOut ? { kind: "timeout" } : bytes > OUTPUT_MAX ? { code: 1, stdout: "" } : { code, stdout });
    });
  }));
  return normalizeMicrosoftAccount(await invoke());
}

export async function getAuthProviders({ env = process.env, agentDir, globalAgentDir, stat = statSync, read = readFileSync, inspectMicrosoft = inspectMicrosoftAccount, now = new Date() } = {}) {
  const modelState = modelProviderState({ env, agentDir, globalAgentDir, stat, read });
  const microsoft = await inspectMicrosoft();
  return {
    schemaVersion: AUTH_PROVIDERS_SCHEMA_VERSION,
    checkedAt: now.toISOString(),
    providers: [
      {
        id: "model.openai-codex",
        name: "OpenAI / Codex model access",
        trustContext: "model",
        state: modelState,
        account: null,
        login: { method: "pi-terminal", available: true, requiresExternalBrowser: true },
        actions: modelState === "authenticated" ? ["reauthenticate"] : ["login"],
        unlocks: ["coop.agent.chat.streaming"],
        diagnostics: modelState === "authenticated" ? [] : modelState === "error"
          ? [{ code: "model-auth-unreadable", message: "Saved model sign-in could not be inspected. Retry or sign in again." }]
          : [{ code: "model-sign-in-required", message: "Model-provider sign-in is required for this profile." }],
      },
      {
        id: "microsoft.client",
        name: "Client Microsoft / Azure",
        trustContext: "client-microsoft",
        state: microsoft.state,
        account: microsoft.account,
        login: { method: "browser-device-code", available: microsoft.state !== "unavailable", requiresExternalBrowser: true },
        actions: microsoft.state === "authenticated" ? ["reauthenticate", "logout"] : microsoft.state === "unavailable" ? [] : ["login"],
        unlocks: ["coop.auth.microsoft", "coop.impact.guided"],
        diagnostics: microsoft.diagnostic ? [microsoft.diagnostic] : [],
      },
      {
        id: "knowledge.cooptimize",
        name: "Cooptimize shared knowledge",
        trustContext: "cooptimize-knowledge",
        state: "unavailable",
        account: null,
        login: { method: "none", available: false, requiresExternalBrowser: false },
        actions: [],
        unlocks: ["coop.knowledge.shared"],
        diagnostics: [{ code: "knowledge-auth-not-configured", message: "Shared-knowledge identity is not configured in this release." }],
      },
    ],
  };
}

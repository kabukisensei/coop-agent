/**
 * coop-mobile — approve and steer a coop session from the phone through Microsoft
 * Teams (master plan row M1, section 12.3).
 *
 * How it works, and why it is safe to run on a client VM:
 *
 * - The VM signs in ONCE as the user (device-code flow against the Cooptimize
 *   tenant's Entra app registration, delegated scopes only: Chat.ReadWrite,
 *   User.Read, offline_access). The refresh token is stored under the coop
 *   profile, DPAPI-protected on Windows (`<profile>/mobile-auth.json`).
 * - While `/mobile on` is active, the extension polls the user's Teams self-chat
 *   (`48:notes`, overridable in `<profile>/mobile.json`) over OUTBOUND HTTPS only:
 *   login.microsoftonline.com and graph.microsoft.com. Nothing listens on the VM.
 * - Only messages written by the pinned user id, created after `/mobile on`, and
 *   not posted by the extension itself count. Everything else is ignored.
 * - Every `ctx.ui.confirm` / `select` / `input` raised in the process (the
 *   guardrails' approvals above all) is mirrored to the chat as a numbered
 *   message. The dialog stays open in the terminal too; the first answer from
 *   either side wins and the other dialog is aborted through its AbortSignal.
 *   A dialog's own timeout still applies, and a timeout is a decline. There is
 *   no silent yes: only an explicit number, "yes"/"no" or an option's text counts.
 * - Other text from the phone becomes a prompt to the session (a follow-up while
 *   the agent is busy), under the same guardrails as a prompt typed in the terminal.
 * - Off by default and per session. `auto_on: true` in mobile.json opts a VM in.
 *
 * Pure helpers (parsing, filtering, the dialog race, the token store) are exported
 * for tests/mobile.test.mjs; nothing here reaches the network at import time.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { profileDir } from "../../lib/paths.mjs";

// --- Config and auth files ------------------------------------------------------

export interface MobileConfig {
  schema_version: 1;
  tenant_id: string;
  client_id: string;
  /** Graph chat id. `48:notes` is the signed-in user's chat with themself. */
  chat_id: string;
  /** Start mobile with every session on this machine without `/mobile on`. */
  auto_on: boolean;
  /** Poll interval in milliseconds (minimum 2000). */
  poll_ms: number;
}

export interface MobileAuth {
  schema_version: 1;
  tenant_id: string;
  client_id: string;
  /** The signed-in user's Graph id; the only sender whose messages count. */
  user_id: string;
  upn: string;
  /** How the refresh token below is protected: DPAPI (Windows) or file mode only. */
  protection: "dpapi" | "file";
  refresh_token: string;
  signed_in_at: string;
}

export const DEFAULT_CHAT_ID = "48:notes";
export const SCOPES = "https://graph.microsoft.com/Chat.ReadWrite https://graph.microsoft.com/User.Read offline_access";
const GRAPH = "https://graph.microsoft.com/v1.0";
const MIN_POLL_MS = 2000;
export const MAX_POST_CHARS = 6000;

export function configPath(env = process.env): string {
  return join(profileDir(env), "mobile.json");
}
export function authPath(env = process.env): string {
  return join(profileDir(env), "mobile-auth.json");
}

export function loadConfig(env = process.env): MobileConfig | null {
  const path = configPath(env);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || raw.schema_version !== 1) return null;
    if (typeof raw.tenant_id !== "string" || typeof raw.client_id !== "string") return null;
    if (!/^[A-Za-z0-9.-]+$/.test(raw.tenant_id) || !/^[0-9a-fA-F-]{36}$/.test(raw.client_id)) return null;
    const pollRaw = Number(raw.poll_ms);
    return {
      schema_version: 1,
      tenant_id: raw.tenant_id,
      client_id: raw.client_id,
      chat_id: typeof raw.chat_id === "string" && raw.chat_id.trim() ? raw.chat_id.trim() : DEFAULT_CHAT_ID,
      auto_on: raw.auto_on === true,
      poll_ms: Number.isFinite(pollRaw) && pollRaw >= MIN_POLL_MS ? Math.floor(pollRaw) : 3000,
    };
  } catch {
    return null;
  }
}

export function saveConfig(config: MobileConfig, env = process.env): void {
  const path = configPath(env);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// --- Token store ------------------------------------------------------------------
// Windows: the refresh token is wrapped with DPAPI (CurrentUser scope) through
// Windows PowerShell, which every supported machine has; the secret travels over
// stdin, never the command line. Elsewhere (tests, a Mac): the file is mode 0600
// and `protection` says so, so doctor and `/mobile status` can show it.

function runPowerShell(script: string, stdin: string): string {
  const exe = process.platform === "win32" ? "powershell.exe" : "pwsh";
  return execFileSync(exe, ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: stdin,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  }).trim();
}

export function protectSecret(secret: string, platform = process.platform): { value: string; protection: "dpapi" | "file" } {
  if (platform !== "win32") return { value: secret, protection: "file" };
  const script =
    "$s = [Console]::In.ReadToEnd(); Add-Type -AssemblyName System.Security; " +
    "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s), $null, 'CurrentUser'))";
  return { value: runPowerShell(script, secret), protection: "dpapi" };
}

export function unprotectSecret(value: string, protection: "dpapi" | "file", platform = process.platform): string {
  if (protection === "file") return value;
  if (platform !== "win32") throw new Error("this token was protected with Windows DPAPI on another machine");
  const script =
    "$s = [Console]::In.ReadToEnd().Trim(); Add-Type -AssemblyName System.Security; " +
    "[Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s), $null, 'CurrentUser'))";
  return runPowerShell(script, value);
}

export function saveAuth(auth: Omit<MobileAuth, "protection" | "refresh_token"> & { refresh_token: string }, env = process.env, platform = process.platform): MobileAuth {
  const wrapped = protectSecret(auth.refresh_token, platform);
  const record: MobileAuth = { ...auth, refresh_token: wrapped.value, protection: wrapped.protection };
  const path = authPath(env);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows: ACLs, not modes */ }
  return record;
}

export function loadAuth(env = process.env): MobileAuth | null {
  const path = authPath(env);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || raw.schema_version !== 1 || typeof raw.refresh_token !== "string" || typeof raw.user_id !== "string") return null;
    if (raw.protection !== "dpapi" && raw.protection !== "file") return null;
    return raw as MobileAuth;
  } catch {
    return null;
  }
}

export function clearAuth(env = process.env): boolean {
  const path = authPath(env);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

// --- Message helpers ---------------------------------------------------------------

/** Teams message bodies arrive as HTML; the phone's answer is the visible text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\r/g, "")
    .trim();
}

export interface PendingDialog {
  kind: "confirm" | "select" | "input";
  title: string;
  message?: string;
  options?: string[];
}

export function buildDialogMessage(dialog: PendingDialog): string {
  const head = `coop needs an answer: ${dialog.title}`;
  if (dialog.kind === "confirm") {
    return `${head}\n${dialog.message ?? ""}\n\nReply 1 (yes) or 2 (no).`.replace(/\n\n\n/g, "\n\n");
  }
  if (dialog.kind === "select") {
    const list = (dialog.options ?? []).map((o, i) => `${i + 1}. ${o}`).join("\n");
    return `${head}\n${list}\n\nReply with the number, or "cancel".`;
  }
  return `${head}\n${dialog.message ?? ""}\n\nReply with the text, or "cancel".`.replace(/\n\n\n/g, "\n\n");
}

export type ParsedAnswer =
  | { ok: true; value: boolean | string | undefined }
  | { ok: false; hint: string };

/** Map a phone reply onto a dialog answer. Anything ambiguous is NOT an answer. */
export function parseAnswer(dialog: PendingDialog, text: string): ParsedAnswer {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (!t) return { ok: false, hint: "empty reply" };
  if (dialog.kind === "confirm") {
    if (["1", "yes", "y", "approve", "allow", "ok"].includes(t)) return { ok: true, value: true };
    if (["2", "no", "n", "decline", "deny", "cancel"].includes(t)) return { ok: true, value: false };
    return { ok: false, hint: "Reply 1 (yes) or 2 (no)." };
  }
  if (dialog.kind === "select") {
    const options = dialog.options ?? [];
    if (t === "cancel") return { ok: true, value: undefined };
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      if (n >= 1 && n <= options.length) return { ok: true, value: options[n - 1] };
      return { ok: false, hint: `Reply with a number from 1 to ${options.length}, or "cancel".` };
    }
    const exact = options.find((o) => o.trim().toLowerCase() === t);
    if (exact !== undefined) return { ok: true, value: exact };
    return { ok: false, hint: `Reply with a number from 1 to ${options.length}, or "cancel".` };
  }
  if (t === "cancel") return { ok: true, value: undefined };
  return { ok: true, value: text.trim() };
}

export interface IncomingMessage {
  id: string;
  createdDateTime: string;
  messageType?: string;
  from?: { user?: { id?: string } | null } | null;
  body?: { contentType?: string; content?: string } | null;
}

/** The messages that count: by the pinned user, after `since`, not ours, real messages. */
export function filterIncoming(messages: IncomingMessage[], opts: { userId: string; since: string; ownIds: Set<string>; seen: Set<string>; ownTexts?: Set<string> }): IncomingMessage[] {
  const sinceMs = Date.parse(opts.since);
  return messages
    .filter((m) => m && typeof m.id === "string" && !opts.ownIds.has(m.id) && !opts.seen.has(m.id))
    // A post of ours can be listed before its id comes back; its text gives it away.
    .filter((m) => !opts.ownTexts?.has(messageText(m)))
    .filter((m) => (m.messageType ?? "message") === "message")
    .filter((m) => m.from?.user?.id === opts.userId)
    .filter((m) => Date.parse(m.createdDateTime) > sinceMs)
    .sort((a, b) => Date.parse(a.createdDateTime) - Date.parse(b.createdDateTime));
}

export function messageText(m: IncomingMessage): string {
  const content = m.body?.content ?? "";
  return m.body?.contentType === "html" ? stripHtml(content) : content.trim();
}

export function truncateForPost(text: string, max = MAX_POST_CHARS): string {
  if (text.length <= max) return text;
  const note = "\n… (truncated; the full reply is in the session)";
  return text.slice(0, max - note.length).trimEnd() + note;
}

/** Race the terminal dialog against the phone. The loser is aborted through its
 *  signal; the dialog's own timeout and outer signal keep working. */
export async function raceDialog<T>(
  local: (signal: AbortSignal) => Promise<T>,
  remote: (signal: AbortSignal) => Promise<{ answered: true; value: T } | { answered: false }>,
  outer?: AbortSignal,
): Promise<{ source: "local" | "remote"; value: T }> {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const localRun = local(controller.signal).then((value) => ({ source: "local" as const, value }));
    const remoteRun = remote(controller.signal).then((r) => (r.answered ? { source: "remote" as const, value: r.value } : null));
    const winner = await Promise.race([localRun, remoteRun.then((r) => r ?? localRun)]);
    controller.abort();
    return winner;
  } finally {
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

// --- Entra and Graph --------------------------------------------------------------

type Fetch = typeof fetch;

export interface DeviceCode { user_code: string; verification_uri: string; device_code: string; interval: number; expires_in: number; message: string }

export async function requestDeviceCode(config: Pick<MobileConfig, "tenant_id" | "client_id">, f: Fetch = fetch): Promise<DeviceCode> {
  const res = await f(`https://login.microsoftonline.com/${encodeURIComponent(config.tenant_id)}/oauth2/v2.0/devicecode`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.client_id, scope: SCOPES }).toString(),
  });
  const json: any = await res.json();
  if (!res.ok || !json.device_code) throw new Error(`device code request failed: ${json.error_description ?? json.error ?? res.status}`);
  return json as DeviceCode;
}

export async function pollDeviceToken(config: Pick<MobileConfig, "tenant_id" | "client_id">, code: DeviceCode, f: Fetch = fetch, signal?: AbortSignal): Promise<{ access_token: string; refresh_token: string }> {
  const deadline = Date.now() + code.expires_in * 1000;
  let interval = Math.max(1, code.interval || 5) * 1000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("sign-in cancelled");
    await new Promise((r) => setTimeout(r, interval));
    const res = await f(`https://login.microsoftonline.com/${encodeURIComponent(config.tenant_id)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: config.client_id, device_code: code.device_code }).toString(),
    });
    const json: any = await res.json();
    if (res.ok && json.access_token && json.refresh_token) return json;
    if (json.error === "authorization_pending") continue;
    if (json.error === "slow_down") { interval += 5000; continue; }
    throw new Error(`sign-in failed: ${json.error_description ?? json.error ?? res.status}`);
  }
  throw new Error("sign-in timed out; run /mobile login again");
}

export async function refreshAccessToken(auth: Pick<MobileAuth, "tenant_id" | "client_id">, refreshToken: string, f: Fetch = fetch): Promise<{ access_token: string; refresh_token?: string }> {
  const res = await f(`https://login.microsoftonline.com/${encodeURIComponent(auth.tenant_id)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: auth.client_id, refresh_token: refreshToken, scope: SCOPES }).toString(),
  });
  const json: any = await res.json();
  if (!res.ok || !json.access_token) throw new Error(`token refresh failed: ${json.error_description ?? json.error ?? res.status}; run /mobile login`);
  return json;
}

export class GraphClient {
  private accessToken = "";
  private expiresAt = 0;
  constructor(
    private readonly auth: MobileAuth,
    private readonly refreshToken: string,
    private readonly f: Fetch = fetch,
  ) {}

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - 60000) return this.accessToken;
    const t: any = await refreshAccessToken(this.auth, this.refreshToken, this.f);
    this.accessToken = t.access_token;
    this.expiresAt = Date.now() + (Number(t.expires_in) || 3600) * 1000;
    return this.accessToken;
  }

  async request(method: string, path: string, body?: unknown): Promise<any> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.f(`${GRAPH}${path}`, {
        method,
        headers: { authorization: `Bearer ${await this.token()}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 429 || res.status === 503) {
        const wait = Math.min(30, Number(res.headers.get("retry-after")) || 5) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (res.status === 401 && attempt === 0) { this.accessToken = ""; continue; }
      if (!res.ok) throw new Error(`Graph ${method} ${path} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return res.status === 204 ? null : res.json();
    }
    throw new Error(`Graph ${method} ${path}: throttled`);
  }

  me(): Promise<{ id: string; userPrincipalName: string }> { return this.request("GET", "/me?$select=id,userPrincipalName"); }
  chat(chatId: string): Promise<any> { return this.request("GET", `/me/chats/${encodeURIComponent(chatId)}?$expand=members`); }
  async listMessages(chatId: string, top = 10): Promise<IncomingMessage[]> {
    const r = await this.request("GET", `/me/chats/${encodeURIComponent(chatId)}/messages?$top=${top}`);
    return Array.isArray(r?.value) ? r.value : [];
  }
  async post(chatId: string, text: string): Promise<string> {
    const r = await this.request("POST", `/chats/${encodeURIComponent(chatId)}/messages`, { body: { contentType: "text", content: truncateForPost(text) } });
    return String(r?.id ?? "");
  }
}

// --- The extension ----------------------------------------------------------------

interface Session {
  config: MobileConfig;
  auth: MobileAuth;
  graph: GraphClient;
  since: string;
  ownIds: Set<string>;
  ownTexts: Set<string>;
  seen: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  pending: { dialog: PendingDialog; resolve: (v: { answered: true; value: any }) => void; messageId: string } | null;
  toolCount: number;
}

const ANSWER_MARK = "(answered in the terminal)";

export default function coopMobile(pi: ExtensionAPI) {
  let ctxRef: ExtensionContext | null = null;
  let session: Session | null = null;
  let patched: { ui: any; confirm: any; select: any; input: any } | null = null;

  const notify = (ctx: ExtensionContext | null, text: string, type: "info" | "warning" | "error" = "info") => {
    if (ctx?.hasUI && typeof ctx.ui?.notify === "function") ctx.ui.notify(text, type);
  };

  const post = async (text: string) => {
    if (!session || session.stopped) return "";
    try {
      session.ownTexts.add(truncateForPost(text));
      const id = await session.graph.post(session.config.chat_id, text);
      if (id) session.ownIds.add(id);
      return id;
    } catch (err: any) {
      notify(ctxRef, `coop mobile: could not post to Teams (${err?.message ?? err})`, "warning");
      return "";
    }
  };

  // Mirror every dialog raised in the process to the phone, and let either side answer.
  const patchUi = (ctx: ExtensionContext) => {
    const ui: any = ctx.ui;
    if (!ui || patched?.ui === ui) return;
    unpatchUi();
    const orig = { confirm: ui.confirm, select: ui.select, input: ui.input };
    const mirror = <T,>(dialog: PendingDialog, local: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal) =>
      raceDialog<T>(local, (signal) => askPhone<T>(dialog, signal), outer).then((r) => r.value);
    ui.confirm = (title: string, message: string, opts?: any) =>
      mirror<boolean>({ kind: "confirm", title, message }, (signal) => orig.confirm.call(ui, title, message, { ...(opts ?? {}), signal }), opts?.signal);
    ui.select = (title: string, options: string[], opts?: any) =>
      mirror<string | undefined>({ kind: "select", title, options }, (signal) => orig.select.call(ui, title, options, { ...(opts ?? {}), signal }), opts?.signal);
    ui.input = (title: string, placeholder?: string, opts?: any) =>
      mirror<string | undefined>({ kind: "input", title, message: placeholder }, (signal) => orig.input.call(ui, title, placeholder, { ...(opts ?? {}), signal }), opts?.signal);
    patched = { ui, ...orig };
  };
  const unpatchUi = () => {
    if (!patched) return;
    patched.ui.confirm = patched.confirm;
    patched.ui.select = patched.select;
    patched.ui.input = patched.input;
    patched = null;
  };

  const askPhone = <T,>(dialog: PendingDialog, signal: AbortSignal): Promise<{ answered: true; value: T } | { answered: false }> =>
    new Promise((resolve) => {
      if (!session || session.stopped || session.pending) return resolve({ answered: false });
      const entry = { dialog, resolve: resolve as any, messageId: "" };
      session.pending = entry;
      void post(buildDialogMessage(dialog)).then((id) => { entry.messageId = id; });
      signal.addEventListener("abort", () => {
        if (session?.pending === entry) {
          session.pending = null;
          void post(`${dialog.title}${dialog.message ? `: ${dialog.message.slice(0, 120)}` : ""} ${ANSWER_MARK}`);
        }
        resolve({ answered: false });
      }, { once: true });
    });

  const handleIncoming = async (m: IncomingMessage) => {
    if (!session) return;
    const text = messageText(m);
    if (!text) return;
    if (session.pending) {
      const parsed = parseAnswer(session.pending.dialog, text);
      if (!parsed.ok) { await post(parsed.hint); return; }
      const entry = session.pending;
      session.pending = null;
      entry.resolve({ answered: true, value: parsed.value });
      await post(`Got it: ${typeof parsed.value === "boolean" ? (parsed.value ? "yes" : "no") : (parsed.value ?? "cancelled")}`);
      return;
    }
    const lower = text.toLowerCase();
    if (lower === "/stop") {
      if (ctxRef && !ctxRef.isIdle()) { ctxRef.abort(); await post("Stopping the current turn."); }
      else await post("Nothing is running.");
      return;
    }
    if (lower === "/status") { await post(statusLine()); return; }
    if (lower === "/mobile off") { await stop("from the phone"); return; }
    if (lower.startsWith("/")) { await post("Only /stop, /status and /mobile off work from the phone; other commands run in the terminal."); return; }
    const busy = ctxRef ? !ctxRef.isIdle() : false;
    pi.sendUserMessage(text, busy ? { deliverAs: "followUp" } : undefined);
    await post(busy ? "Queued as a follow-up." : "Sent.");
  };

  const poll = async () => {
    if (!session || session.stopped) return;
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    try {
      const messages = await session.graph.listMessages(session.config.chat_id, 10);
      for (const m of filterIncoming(messages, { userId: session.auth.user_id, since: session.since, ownIds: session.ownIds, ownTexts: session.ownTexts, seen: session.seen })) {
        session.seen.add(m.id);
        await handleIncoming(m);
      }
    } catch (err: any) {
      notify(ctxRef, `coop mobile: ${err?.message ?? err}`, "warning");
      if (/run \/mobile login/.test(String(err?.message))) { await stop("sign-in expired"); return; }
    }
    if (session && !session.stopped) session.timer = setTimeout(poll, session.pending ? Math.max(MIN_POLL_MS, session.config.poll_ms / 2) : session.config.poll_ms);
  };

  const statusLine = () => {
    if (!session) return "coop mobile: off";
    const cwd = ctxRef?.cwd ?? "";
    return `coop mobile: on as ${session.auth.upn}${cwd ? ` in ${cwd}` : ""}${session.pending ? "; waiting for an answer" : ctxRef && !ctxRef.isIdle() ? "; working" : "; idle"}`;
  };

  const start = async (ctx: ExtensionContext, how: string): Promise<boolean> => {
    if (session) { notify(ctx, statusLine()); return true; }
    const config = loadConfig();
    if (!config) { notify(ctx, "coop mobile: not set up on this machine; run /mobile setup", "warning"); return false; }
    const auth = loadAuth();
    if (!auth || auth.client_id !== config.client_id) { notify(ctx, "coop mobile: not signed in; run /mobile login", "warning"); return false; }
    let refreshToken: string;
    try { refreshToken = unprotectSecret(auth.refresh_token, auth.protection); }
    catch (err: any) { notify(ctx, `coop mobile: cannot read the saved sign-in (${err?.message ?? err}); run /mobile login`, "warning"); return false; }
    const graph = new GraphClient(auth, refreshToken);
    session = { config, auth, graph, since: new Date().toISOString(), ownIds: new Set(), ownTexts: new Set(), seen: new Set(), timer: null, stopped: false, pending: null, toolCount: 0 };
    ctxRef = ctx;
    try {
      await graph.chat(config.chat_id);
    } catch (err: any) {
      session = null;
      notify(ctx, `coop mobile: cannot open the Teams chat (${err?.message ?? err})`, "warning");
      return false;
    }
    patchUi(ctx);
    await post(`coop mobile on (${how}) in ${ctx.cwd}. Type a prompt, /status or /stop. Approvals arrive here as numbered messages.`);
    session.timer = setTimeout(poll, config.poll_ms);
    notify(ctx, `coop mobile: on as ${auth.upn}; Teams chat ${config.chat_id}`);
    return true;
  };

  const stop = async (why: string) => {
    if (!session) return;
    const s = session;
    s.stopped = true;
    if (s.timer) clearTimeout(s.timer);
    if (s.pending) { const p = s.pending; s.pending = null; p.resolve({ answered: false } as any); }
    unpatchUi();
    try { await s.graph.post(s.config.chat_id, `coop mobile off (${why}).`); } catch { /* best effort */ }
    session = null;
    notify(ctxRef, `coop mobile: off (${why})`);
  };

  const setup = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) { notify(ctx, "coop mobile: /mobile setup needs the terminal", "warning"); return; }
    const existing = loadConfig();
    const tenant = await ctx.ui.input("Entra tenant (Cooptimize tenant id or domain)", existing?.tenant_id ?? "");
    if (!tenant) return;
    const client = await ctx.ui.input("Application (client) ID of the coop mobile app registration", existing?.client_id ?? "");
    if (!client) return;
    const config: MobileConfig = { schema_version: 1, tenant_id: tenant.trim(), client_id: client.trim(), chat_id: existing?.chat_id ?? DEFAULT_CHAT_ID, auto_on: existing?.auto_on ?? false, poll_ms: existing?.poll_ms ?? 3000 };
    saveConfig(config);
    if (!loadConfig()) { notify(ctx, "coop mobile: those values do not look right (tenant id or domain; client id is a GUID); nothing enabled", "warning"); return; }
    notify(ctx, `coop mobile: saved ${configPath()}; now run /mobile login`);
  };

  const login = async (ctx: ExtensionContext) => {
    const config = loadConfig();
    if (!config) { notify(ctx, "coop mobile: run /mobile setup first", "warning"); return; }
    try {
      const code = await requestDeviceCode(config);
      const go = ctx.hasUI
        ? await ctx.ui.confirm("coop mobile sign-in", `${code.message}\n\nOpen ${code.verification_uri} on any device and enter the code ${code.user_code}. Continue waiting here?`)
        : true;
      if (!go) return;
      const token = await pollDeviceToken(config, code);
      const probe = new GraphClient({ schema_version: 1, tenant_id: config.tenant_id, client_id: config.client_id, user_id: "", upn: "", protection: "file", refresh_token: "", signed_in_at: "" }, token.refresh_token);
      const me = await probe.me();
      const chat = await probe.chat(config.chat_id);
      const members = Array.isArray(chat?.members) ? chat.members.length : 0;
      saveAuth({ schema_version: 1, tenant_id: config.tenant_id, client_id: config.client_id, user_id: me.id, upn: me.userPrincipalName, refresh_token: token.refresh_token, signed_in_at: new Date().toISOString() });
      notify(ctx, `coop mobile: signed in as ${me.userPrincipalName}; chat ${config.chat_id} opens${members > 1 ? ` (${members} members: everyone in it will see coop's replies)` : ""}. Run /mobile on when you want it.`, members > 1 ? "warning" : "info");
    } catch (err: any) {
      notify(ctx, `coop mobile: ${err?.message ?? err}`, "error");
    }
  };

  pi.registerCommand("mobile", {
    description: "Teams mobile access: setup | login | on | off | status | logout",
    getArgumentCompletions: (prefix) => ["setup", "login", "on", "off", "status", "logout"].filter((a) => a.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const verb = (args ?? "").trim().toLowerCase();
      switch (verb) {
        case "setup": return setup(ctx);
        case "login": return login(ctx);
        case "on": {
          if (ctx.hasUI && !(await ctx.ui.confirm("coop mobile", "Mirror this session to your Teams self-chat and accept prompts and approval answers from it?"))) return;
          await start(ctx, "/mobile on");
          return;
        }
        case "off": return stop("/mobile off");
        case "logout": {
          await stop("logout");
          notify(ctx, clearAuth() ? "coop mobile: sign-in removed from this machine (revoke the app's sessions in Entra to be thorough)" : "coop mobile: no saved sign-in");
          return;
        }
        default: notify(ctx, `${statusLine()}${loadConfig() ? "" : "; not set up (run /mobile setup)"}${loadAuth() ? "" : "; not signed in"}`);
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    const config = loadConfig();
    if (config?.auto_on && !session) await start(ctx, "auto_on");
  });

  pi.on("before_agent_start", (_event, ctx) => {
    ctxRef = ctx;
    if (session) { patchUi(ctx); session.toolCount = 0; }
  });

  pi.on("tool_execution_end", () => { if (session) session.toolCount++; });

  pi.on("agent_end", async (event) => {
    if (!session) return;
    const last = [...event.messages].reverse().find((m: any) => m.role === "assistant");
    const text = last ? ((last as any).content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n").trim() : "";
    const tools = session.toolCount ? ` (${session.toolCount} tool call${session.toolCount === 1 ? "" : "s"})` : "";
    await post(text ? `${text}${tools}` : `Turn finished${tools}.`);
  });

  pi.on("session_shutdown", async () => { await stop("session ended"); });

  // Pi ignores the factory's return value; tests use it to drive one poll without timers.
  return { pollNow: poll, isOn: () => session !== null };
}

// Coop's local runtime / coop web bridge. It puts a friendly browser window in
// front of the SAME governed Coop the terminal runs, or starts headlessly through
// the supported `coop runtime` entry point for Desktop and other local clients.
//
// It spawns `pi --mode rpc -a` using the shared launch spec (COOP_LAUNCH_SPEC, from
// `coop launch-spec --json`), relays Pi's JSONL events to the browser over SSE, and
// forwards prompts + extension-UI responses back to Pi's stdin. Node built-ins only.
//
// Security model (localhost, single user — layered):
//   - binds 127.0.0.1 only; Host header must be localhost/127.0.0.1 (DNS-rebinding guard)
//   - per-run random token (query -> HttpOnly SameSite=Strict cookie) gates every
//     route; compared timing-safe. Valid until this process exits.
//   - strict CSP (no inline script/style — the SPA is served as separate files),
//     nosniff, no-referrer; CORS is never enabled
//   - POSTs additionally require the X-Coop-CSRF custom header (cross-origin pages
//     can't set custom headers without a CORS preflight, which we never grant)
//
// NOT for remote or multi-user use.

import { createServer } from "node:http";
import { writeSse } from "./sse-writer.mjs";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, readdirSync, openSync, readSync, closeSync, fstatSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep, extname, resolve as resolvePath, relative as relPath } from "node:path";
import { tmpdir } from "node:os";
// The checked-in Pi RPC protocol contract + the hardened JSONL splitter. RPC_ALLOWED
// lives there next to the rest of the contract so the /rpc whitelist and the wire
// contract can never drift apart. See web/protocol.mjs and web/README.md.
import {
  COMMANDS_SENT,
  PI_PROTOCOL_VERSION,
  RPC_ALLOWED,
  checkEvent,
  checkResponseData,
  createJsonlSplitter,
} from "./protocol.mjs";
import { buildRuntimeCapabilities, detectIntegrationStates } from "./runtime-capabilities.mjs";
import { getAuthProviders } from "./auth-service.mjs";
import { runDoctor } from "./doctor-service.mjs";
import { applyUserProfile, getUserProfile } from "./profile-service.mjs";
import { applyProjectConfig, getProjectConfig, proposeProjectConfig } from "./project-config-service.mjs";
import { discoverFabricItems, discoverFabricWorkspaces, discoverLocalRepositories } from "./environment-discovery.mjs";
import { getProjectSetupState } from "./project-setup-service.mjs";
import { buildExecutionEnvelope, capabilityForTool } from "./execution-envelope.mjs";
import { projectTranscriptMessages, REPLAY_THINKING_MAX, REPLAY_TOOL_OUT_MAX } from "./transcript-replay.mjs";
import { buildPromptCommand, buildRpcCommand, listAvailableModels } from "./rpc-adapter.mjs";
import { RuntimeEventStream } from "./runtime-events.mjs";
import { WorkflowService } from "./workflow-service.mjs";
import {
  WorkspaceLeaseManager,
  createManagedWorktree,
  inspectWorkspace,
  removeManagedWorktree,
} from "../lib/workspace-isolation.mjs";
import {
  buildRuntimeShutdownInvocation,
  buildTerminalLaunchRequest,
  validateTerminalHandoffRequest,
} from "./terminal-handoff.mjs";
import { buildTreeNavigationInvocation, parseTreeNavigationResultEvent } from "./tree-navigation.mjs";
import { KnowledgeService } from "../lib/knowledge-service.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const RUNTIME_MODE = argv.includes("--runtime") || process.env.COOP_RUNTIME_MODE === "1";
const RUNTIME_JSON = RUNTIME_MODE && argv.includes("--json");
const getArg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT_EXPLICIT = argv.includes("--port") || Boolean(process.env.COOP_WEB_PORT);
let PORT = Number(getArg("--port", process.env.COOP_WEB_PORT || "7420"));
const HOST = "127.0.0.1";
const TOKEN = randomBytes(16).toString("hex");
const TREE_NAVIGATION_SECRET = randomBytes(24).toString("hex");
const RUNTIME_CONTROL_SECRET = randomBytes(24).toString("hex");

function startupError(message, exitCode = 1) {
  if (RUNTIME_JSON) {
    process.stdout.write(`${JSON.stringify({
      type: "runtime.error",
      contractVersion: 1,
      error: message,
    })}\n`);
  } else {
    console.error(`${RUNTIME_MODE ? "coop runtime" : "coop web"}: ${message}`);
  }
  process.exit(exitCode);
}
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  startupError(`invalid port: ${getArg("--port", process.env.COOP_WEB_PORT || "7420")}`, 2);
}
// Default working folder for a new chat: --cwd <dir>, else wherever `coop web` was
// run. Immutable — each chat carries its OWN cwd (POST /chdir moves only that chat).
// resolvePath() so a relative --cwd, a trailing separator, or a Windows case difference
// becomes ONE canonical absolute path: DEFAULT_CWD seeds chat.cwd, sessionsDirFor(),
// the tab labels, /history's `current` marking, and the SPA's recents filter — all of
// which compare cwd strings. Every other write to chat.cwd already goes through
// resolvePath (/chdir, /chat-new, /resume), so normalizing here makes the whole set
// consistent and the client-side `f.dir !== currentCwd` compare safe.
const DEFAULT_CWD = resolvePath(getArg("--cwd", process.cwd()));

// --- Resolve the governed launch spec ---------------------------------------
let spec;
try {
  spec = JSON.parse(process.env.COOP_LAUNCH_SPEC || "");
  if (!spec || !Array.isArray(spec.args)) throw new Error("no args");
} catch {
  startupError(
    `missing/invalid COOP_LAUNCH_SPEC. Run this via \`coop ${RUNTIME_MODE ? "runtime" : "web"}\`, not \`node server.mjs\` directly.`,
  );
}

const AGENT_DIR = resolvePath(spec.env?.PI_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || join(tmpdir(), "coop-agent"));

function configuredKnowledgeSources() {
  const sources = [];
  const projectRoot = process.env.COOP_PROJECT_KNOWLEDGE_ROOT;
  const projectId = process.env.COOP_PROJECT_KNOWLEDGE_ID;
  const teamRoot = process.env.COOP_TEAM_KNOWLEDGE_ROOT;
  if (projectRoot) {
    if (!projectId) throw new TypeError("COOP_PROJECT_KNOWLEDGE_ID is required with COOP_PROJECT_KNOWLEDGE_ROOT.");
    sources.push({ id: `project.${projectId}`, scope: "project", root: projectRoot, projectId });
  }
  if (teamRoot) sources.push({ id: "team.general", scope: "team", root: teamRoot, projectId: null });
  return sources;
}

let knowledgeSources = [];
let knowledgeService = null;
let knowledgeServiceError = null;
try {
  knowledgeSources = configuredKnowledgeSources();
  knowledgeService = new KnowledgeService({ sources: knowledgeSources, stateDir: AGENT_DIR });
} catch (error) {
  knowledgeServiceError = error?.message || "Knowledge repositories are unavailable.";
}

// Capability/version negotiation is checked-in contract data plus conservative
// local integration detection. The renderer consumes this response; it never
// guesses platform support from navigator/user-agent strings.
let runtimeCapabilities;
let workflowRegistry;
try {
  const manifest = JSON.parse(readFileSync(join(HERE, "..", "config", "release-manifest.json"), "utf8"));
  const registry = JSON.parse(readFileSync(join(HERE, "..", "config", "capabilities.json"), "utf8"));
  const parity = JSON.parse(readFileSync(join(HERE, "..", "config", "desktop-parity.json"), "utf8"));
  workflowRegistry = JSON.parse(readFileSync(join(HERE, "..", "config", "workflows.json"), "utf8"));
  const integrations = detectIntegrationStates({
    platform: process.platform,
    env: { ...process.env, ...(spec.env || {}) },
    piRunning: true,
  });
  integrations["knowledge-repository"] = knowledgeService && knowledgeSources.length
    ? { state: "available", installed: true, authenticated: null, reason: null }
    : { state: "unavailable", installed: false, authenticated: null, reason: knowledgeServiceError || "No governed knowledge repository is configured." };
  runtimeCapabilities = buildRuntimeCapabilities({
    manifest,
    registry,
    parity,
    piProtocolVersion: PI_PROTOCOL_VERSION,
    bridgeCommands: RPC_ALLOWED,
    protocolCommands: Object.keys(COMMANDS_SENT),
    workflowRegistry,
    platform: process.platform,
    integrations,
  });
} catch (error) {
  startupError(`could not load runtime capability contracts: ${error.message}`);
}

import { statSync } from "node:fs";
try {
  if (!statSync(DEFAULT_CWD).isDirectory()) throw new Error("not a directory");
} catch {
  startupError(`working folder not found: ${DEFAULT_CWD}`);
}

// --- Spawn the governed Pi in RPC mode --------------------------------------
// `cwd` is a per-chat parameter (each chat can work in a different folder). The
// arg list stays [...spec.args, --mode rpc -a, ...extraArgs] — NEVER drop `-a`.
function spawnPi(cwd, extraArgs = [], workspaceAccess = null) {
  const bin = spec.bin || "pi";
  const args = [...spec.args, "--mode", "rpc", "-a", ...extraArgs];
  const env = {
    ...process.env,
    ...(spec.env || {}),
    COOP_CLIENT_INTERFACE: process.env.COOP_RUNTIME_CLIENT || (RUNTIME_MODE ? "runtime" : "web"),
    COOP_RUNTIME_CONTROL_SECRET: RUNTIME_CONTROL_SECRET,
    COOP_TREE_NAVIGATION_SECRET: TREE_NAVIGATION_SECRET,
    ...(workspaceAccess ? {
      COOP_WORKSPACE_ACCESS_MODE: workspaceAccess.mode,
      COOP_WORKSPACE_LEASE_DELEGATED: workspaceAccess.leaseId || "read-only",
      ...(workspaceAccess.mode === "override" ? { COOP_WORKSPACE_OVERRIDE_APPROVED: "1" } : {}),
    } : {}),
  };
  if (process.platform === "win32") {
    // npm-global `pi` is a .cmd shim, which Node can only launch through cmd.exe.
    // cmd has no safe escape for embedded `"` or `%` inside a quoted argument, so
    // refuse those outright (launch-spec args are repo paths + fixed flags — they
    // never legitimately contain either) rather than quote them wrongly.
    for (const a of [bin, ...args]) {
      if (/["%]/.test(String(a))) {
        startupError(`launch-spec argument contains '"' or '%', which cmd.exe cannot quote safely: ${a}`);
      }
    }
    const line = [bin, ...args].map((s) => `"${s}"`).join(" ");
    // `/s` strips the first and last quote of the string after /c, so wrap the
    // whole line in one extra pair (the canonical cmd /s /c pattern).
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      env,
      cwd,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
  return spawn(bin, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
}

// Terminate a pi child. On Windows the child is a cmd.exe wrapper around the real `pi`
// grandchild, and killing cmd does NOT propagate to it — so `child.kill()` would orphan
// a file-editing/bash-capable agent on every restart and on shutdown. taskkill /T (tree)
// /F reaps the whole subtree. On POSIX a plain kill suffices.
function killPi(child) {
  if (!child) return;
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      child.kill();
    }
  } catch { /* already gone */ }
}

// --- Chat registry -------------------------------------------------------------
// Each chat is an INDEPENDENT governed pi subprocess with its own transcript, model,
// working folder, and dialog state. Today (Stage 1) there is exactly one; the registry
// exists so a missing sid falls back to it and the wire protocol stays byte-identical.
const STDERR_TAIL_MAX = 4000;
const MAX_CHATS = Math.max(1, Math.min(8, Number(process.env.COOP_WEB_MAX_CHATS) || 4));
const TREE_NAV_RESULTS_MAX = 32;
const RUNTIME_ARTIFACTS_MAX = 200;
let chatSeq = 0;
let rpcSeq = 0; // global — rpc ids are unique across all chats
const chats = new Map(); // sid -> chat
const sseClients = new Set(); // ONE SSE fan-out carries every chat
const runtimeSseClients = new Set(); // {res, chat} Coop domain stream consumers

function appendRuntimeEvent(chat, type, payload = {}, fields = {}) {
  const event = chat.runtimeEvents.append(type, payload, fields);
  const frame = `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of runtimeSseClients) {
    if (client.chat !== chat) continue;
    if (!writeSse(client.res, frame)) runtimeSseClients.delete(client);
  }
  return event;
}

function closeRuntimeEventClients(chat) {
  for (const client of runtimeSseClients) {
    if (client.chat !== chat) continue;
    runtimeSseClients.delete(client);
    try { client.res.end(); } catch { /* already closed */ }
  }
}

async function makeChat(cwd, extraArgs = [], accessRequest = { mode: "write", approved: false }) {
  const sid = `c${++chatSeq}`;
  const repository = await inspectWorkspace(cwd);
  const workspaceLease = new WorkspaceLeaseManager({
    agentDir: AGENT_DIR,
    ownerId: sid,
    clientInterface: RUNTIME_MODE ? "desktop-runtime" : "web",
    onLost: () => {
      const chat = chats.get(sid);
      if (chat?.child) {
        chat.status = "exited";
        killPi(chat.child);
        chat.child = null;
        appendRuntimeEvent(chat, "workspace.changed", { cwd: chat.cwd, access: { mode: "lost" } });
        broadcastChats();
      }
    },
  });
  const leaseResult = workspaceLease.acquire(cwd, {
    mode: accessRequest.mode,
    approved: accessRequest.approved === true,
    repository,
  });
  if (!leaseResult.ok) {
    const error = new Error(leaseResult.message);
    error.workspaceAccess = leaseResult;
    throw error;
  }
  const chat = {
    sid,
    cwd,                    // per-chat working folder (replaces the old global mutable CWD)
    workspaceLease,
    workspaceAccess: leaseResult.access,
    managedWorktreeId: accessRequest.managedWorktreeId || null,
    child: null,            // current pi child — generation-checked like today
    busy: false,            // agent streaming? (chooses prompt vs steer)
    history: [],            // ring buffer of { line, uiId?, uiMethod? }
    historyBase: 0,         // count of evicted entries — history[i] is event #(historyBase+i)
    resetEpoch: 0,          // bumped on new_session / chdir / resume
    answeredUi: new Set(),  // dialog ids already answered (skipped on replay)
    pendingRpc: new Map(),  // id -> { resolve, timer } — per chat so a restart fails only its own waiters
    treeNavigationResults: new Map(), // request id -> authenticated Coop extension result
    runtimeEvents: new RuntimeEventStream({ streamId: sid }),
    runtimeArtifacts: new Map(), // opaque artifact id -> original structured tool result
    toolRuns: new Map(),         // Pi toolCallId -> stable Coop run id
    configProposals: new Map(),  // bounded, chat-scoped config previews awaiting approval
    knowledgeProposals: new Set(), // opaque IDs; source paths remain inside KnowledgeService
    workflows: new WorkflowService(workflowRegistry), // runtime-owned resumable workflow checkpoints
    stderrTail: "",         // bounded tail of THIS pi's stderr (crash card)
    driftSeen: new Set(),   // M1 drift dedupe, per pi child (cleared on restart)
    status: "running",      // "running" | "exited"
    expectedExit: null,      // child intentionally stopping for terminal handoff
    createdAt: Date.now(),
  };
  chat.child = spawnPi(cwd, extraArgs, chat.workspaceAccess);
  wireChat(chat, chat.child);
  chats.set(chat.sid, chat);
  appendRuntimeEvent(chat, "session.started", { cwd, status: chat.status, workspaceAccess: chat.workspaceAccess });
  return chat;
}

// Resolve the target chat from ?sid= (GET) or body.sid (POST). With exactly one chat
// open, a missing sid falls back to it (Stage 1 compatibility + curl ergonomics). Any
// non-empty string that isn't a live sid — including the literal "undefined" from a
// client bug — returns null (the caller answers the uniform 400).
function chatFor(sidRaw) {
  if (typeof sidRaw === "string" && sidRaw) return chats.get(sidRaw) || null;
  return chats.size === 1 ? chats.values().next().value : null;
}

// The tab-strip surface: chatList() is the per-chat summary the SPA renders; a
// __chats global frame is broadcast whenever the list changes (create/close/crash/cwd).
function chatList() {
  return [...chats.values()].map((c) => ({ sid: c.sid, cwd: c.cwd, busy: c.busy, status: c.status, createdAt: c.createdAt, workspaceAccess: c.workspaceAccess, managedWorktreeId: c.managedWorktreeId }));
}
function broadcastChats() { broadcastGlobal({ type: "__chats", chats: chatList() }); }

function wireChat(chat, child) {
  child.on("error", (e) => {
    if (child !== chat.child) return; // an old child we replaced — ignore
    console.error("coop web: failed to start pi:", e.message);
    chatDied(chat, null); // spawn failure — a friendly crash card beats a vanished window
  });
  child.on("exit", (code) => {
    if (child !== chat.child) return; // an old child we intentionally replaced — ignore
    if (chat.expectedExit === child) {
      chat.expectedExit = null;
      return;
    }
    console.error(`coop web: pi exited (${code}) for chat ${chat.sid}.`);
    chatDied(chat, code); // per-chat crash containment — the bridge itself stays up
  });
  // Strict \n-only JSONL parse, buffered PER CHILD via createJsonlSplitter (a replaced
  // child's partial line — or partial multi-byte code point — must never bleed into the
  // new one's stream; the splitter + its StringDecoder are closured here per child).
  // NEVER Node readline.
  const feed = createJsonlSplitter((line) => handleChatLine(chat, line), {
    onOversize: (n) => console.error(`coop web: dropped an oversized pi output line (~${n} chars) — exceeds the JSONL cap`),
  });
  child.stdout.on("data", (chunk) => {
    if (child !== chat.child) return;
    feed(chunk);
  });
  child.stderr.on("data", (c) => {
    process.stderr.write(c); // pi diagnostics -> our console
    if (child !== chat.child) return;
    chat.stderrTail = (chat.stderrTail + c.toString("utf8")).slice(-STDERR_TAIL_MAX);
  });
  child.stdin.on("error", (e) => console.error("coop web: pi stdin error:", e.message));
}

// Per-chat crash containment: a pi exit (or spawn failure) no longer exits the WHOLE
// bridge. Record a __fatal crash card (RECORDED now — was broadcast-only — so switching
// to a crashed tab replays it) and mark the chat exited; other chats keep running. The
// bridge itself exits only on bad/missing spec, port errors, signals, and uncaught.
function chatDied(chat, code) {
  if (chat.status === "exited") return; // 'error' and 'exit' can both fire — handle once
  chat.status = "exited";
  chat.busy = false;
  chat.workspaceLease?.release();
  for (const [id, w] of chat.pendingRpc) { clearTimeout(w.timer); w.resolve(null); chat.pendingRpc.delete(id); }
  const line = JSON.stringify({ type: "__fatal", code: code == null ? null : code, stderrTail: chat.stderrTail.trim().slice(-1500) });
  recordAndBroadcast(chat, line, { type: "__fatal" });
  chat.runtimeEvents.revise();
  appendRuntimeEvent(chat, "session.updated", { status: "exited", exitCode: code == null ? null : code });
  broadcastChats(); // Stage 2: the tab strip shows the ✗
}

function storeRuntimeArtifact(chat, id, value) {
  if (chat.runtimeArtifacts.size >= RUNTIME_ARTIFACTS_MAX && !chat.runtimeArtifacts.has(id)) {
    chat.runtimeArtifacts.delete(chat.runtimeArtifacts.keys().next().value);
  }
  chat.runtimeArtifacts.set(id, value);
}

function appendPiDomainEvent(chat, evt, rawSequence) {
  const raw = { type: evt.type, sequence: rawSequence };
  if (evt.type === "message_update") {
    const update = evt.assistantMessageEvent;
    if (update?.type === "text_delta" && typeof update.delta === "string") {
      appendRuntimeEvent(chat, "agent.message.delta", { delta: update.delta, contentIndex: update.contentIndex }, { raw });
    } else if (update?.type === "thinking_delta" && typeof update.delta === "string") {
      appendRuntimeEvent(chat, "agent.thinking.changed", { delta: update.delta, contentIndex: update.contentIndex }, { raw });
    }
    return;
  }
  if (evt.type === "tool_execution_start") {
    const runId = `${chat.sid}:tool:${evt.toolCallId}`;
    chat.toolRuns.set(evt.toolCallId, runId);
    appendRuntimeEvent(chat, "tool.started", { toolCallId: evt.toolCallId, toolName: evt.toolName }, { runId, raw });
    return;
  }
  if (evt.type === "tool_execution_update") {
    const runId = chat.toolRuns.get(evt.toolCallId) || `${chat.sid}:tool:${evt.toolCallId}`;
    appendRuntimeEvent(chat, "tool.progress", { toolCallId: evt.toolCallId, toolName: evt.toolName }, { runId, raw });
    return;
  }
  if (evt.type === "tool_execution_end") {
    const runId = chat.toolRuns.get(evt.toolCallId) || `${chat.sid}:tool:${evt.toolCallId}`;
    chat.toolRuns.delete(evt.toolCallId);
    let envelope = null;
    if (capabilityForTool(evt.toolName)) {
      const artifactId = `${chat.sid}:artifact:${evt.toolCallId}`;
      storeRuntimeArtifact(chat, artifactId, evt.result);
      envelope = buildExecutionEnvelope(evt, { runId, artifactId });
    }
    appendRuntimeEvent(chat, evt.isError ? "tool.failed" : "tool.completed", {
      toolCallId: evt.toolCallId,
      toolName: evt.toolName,
      envelope,
    }, { runId, raw });
    return envelope;
  }
  if (evt.type === "session_info_changed") {
    chat.runtimeEvents.revise();
    appendRuntimeEvent(chat, "session.updated", { name: evt.name }, { raw });
  }
}

// Write one JSONL command to a chat's pi stdin (LF-terminated, per the RPC contract).
function sendTo(chat, obj) {
  if (!chat || chat.status === "exited" || !chat.child) {
    console.error("coop web: dropping a command to a chat with no live pi");
    return;
  }
  try {
    chat.child.stdin.write(JSON.stringify(obj) + "\n");
  } catch (e) {
    console.error("coop web: could not write to pi:", e.message);
  }
}

// --- Event fan-out + reconnect replay -----------------------------------------
// Each chat keeps a bounded ring buffer of every event line broadcast to browsers. A
// new (or reconnecting) SSE client gets a `__hello` marker, then the replay, then live
// events — so refreshing the page or dropping the connection doesn't lose the
// transcript. Skipped on replay: answered dialog cards, transient `notify` toasts, and
// `set_editor_text` (a live-only composer prefill — replaying it would clobber a draft).
// Keyed extension-UI state (setStatus/setWidget/setTitle) IS replayed in order, so a
// reconnecting client reconstructs the current dock/title from history.
const HISTORY_MAX = 4000; // per chat
const DRIFT_SEEN_MAX = 100; // per chat
const ANSWERED_UI_MAX = 500; // per chat — bound the answered-dialog dedupe set

// The ONLY way to broadcast a recorded event: record + broadcast together, and the
// ONLY place that computes the global event number n. Because EVERY recorded event —
// handleChatLine's pi lines, chatDied's __fatal, backfill's __message/__replay — goes
// through here, no recorded frame can ship without its dedupe cursor. Direct
// broadcast(chat,line) (no n) is reserved for unrecorded live-only frames (unclaimed
// responses, __drift, __reset). The SPA uses n to dedupe live frames vs a replay.
function recordAndBroadcast(chat, rawLine, evt) {
  record(chat, rawLine, evt);
  broadcast(chat, rawLine, chat.historyBase + chat.history.length - 1);
}

function record(chat, line, evt) {
  const entry = { line };
  if (evt.type === "extension_ui_request") {
    entry.uiId = evt.id;
    entry.uiMethod = evt.method;
  }
  chat.history.push(entry);
  if (chat.history.length > HISTORY_MAX) {
    // Evict oldest — and drop their ids from this chat's answeredUi so it can't grow
    // unbounded over a long session.
    const evicted = chat.history.splice(0, chat.history.length - HISTORY_MAX);
    chat.historyBase += evicted.length;
    for (const old of evicted) {
      if (old.uiId) chat.answeredUi.delete(old.uiId);
    }
  }
}

function replayable(chat, entry) {
  if (entry.uiMethod === "notify") return false; // transient toast
  if (entry.uiMethod === "set_editor_text") return false; // composer injection is live-only — replaying it would clobber the user's draft
  if (entry.uiId && chat.answeredUi.has(entry.uiId)) return false; // dialog already answered
  return true;
}

// Every per-chat frame is an ENVELOPE built by string concatenation — the raw pi line
// is embedded verbatim (`ev`), never re-parsed/re-serialized. `sid` routes it to a tab;
// `n` (the global event number) is present for RECORDED events and omitted for live-only
// ones. ONE SSE connection carries every chat (per-chat streams would burn the browser's
// ~6-connection HTTP/1.1 budget).
function broadcast(chat, rawLine, n) {
  const frame = `data: {"sid":${JSON.stringify(chat.sid)}${n !== undefined ? `,"n":${n}` : ""},"ev":${rawLine}}\n\n`;
  for (const res of sseClients) {
    try {
      if (!writeSse(res, frame)) sseClients.delete(res);
    } catch {
      sseClients.delete(res);
    }
  }
}
// Global (chat-less) frames — __hello and __chats — carry no sid/n.
function broadcastGlobal(obj) {
  const frame = `data: {"ev":${JSON.stringify(obj)}}\n\n`;
  for (const res of sseClients) {
    try {
      if (!writeSse(res, frame)) sseClients.delete(res);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Heartbeat: a comment frame every 15s keeps intermediaries (proxies, endpoint
// protection) from idling-out or indefinitely buffering the SSE stream.
setInterval(() => {
  for (const res of sseClients) {
    try {
      if (!writeSse(res, ": ping\n\n")) sseClients.delete(res);
    } catch {
      sseClients.delete(res);
    }
  }
  for (const client of runtimeSseClients) {
    try {
      if (!writeSse(client.res, ": ping\n\n")) runtimeSseClients.delete(client);
    } catch {
      runtimeSseClients.delete(client);
    }
  }
}, 15000).unref();

// --- Protocol drift detection (observe-only — the dumb pipe is preserved) -------
// Every parsed pi event is validated against protocol.mjs at this bridge chokepoint.
// On an unknown/shape-mismatched event we log to stderr (the authoritative record) and
// broadcast a one-time __drift toast — but we STILL record/broadcast the event verbatim,
// so nothing is dropped, rewritten, or blocked. Deduped per (kind,type) PER CHAT and
// capped so a genuinely-new Pi can't spam; cleared on restartChat (a respawn may be a
// different Pi build). __drift is broadcast-only, never recorded.
function reportDrift(chat, kind, eventType, problems, line) {
  const key = `${kind}:${eventType}`;
  if (chat.driftSeen.has(key)) return; // already warned about this shape on this pi child
  if (chat.driftSeen.size >= DRIFT_SEEN_MAX) return; // stop reporting once full
  chat.driftSeen.add(key);
  console.error(
    "coop web: protocol drift — " + kind + " event '" + eventType + "': " + problems.join("; ") + " | " + line.slice(0, 200),
  );
  broadcast(chat, JSON.stringify({ type: "__drift", eventType, kind, problems: problems.slice(0, 5) }));
}
function noteDrift(chat, evt, line) {
  const r = checkEvent(evt);
  if (r.kind === "ok") return;
  reportDrift(chat, r.kind, evt.type, r.problems, line);
}

// One parsed line from a chat's pi child (called by wireChat's stream reader).
function handleChatLine(chat, line) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    return; // ignore any non-JSON noise on stdout
  }
  // Only parsed JSON OBJECTS are events. A bare `null`/number/string/array is valid JSON
  // but not an event (and dereferencing `.type` on `null` would throw and take the whole
  // bridge down) — drop it like non-JSON noise, so the drift detector never validates or
  // forwards it. (Plan §5: only parsed JSON objects are validated.)
  if (evt === null || typeof evt !== "object" || Array.isArray(evt)) return;
  noteDrift(chat, evt, line); // observe-only, before any branching — never changes forwarding
  const treeNavigation = parseTreeNavigationResultEvent(evt);
  if (treeNavigation) {
    if (chat.treeNavigationResults.size >= TREE_NAV_RESULTS_MAX && !chat.treeNavigationResults.has(treeNavigation.requestId)) {
      chat.treeNavigationResults.delete(chat.treeNavigationResults.keys().next().value);
    }
    chat.treeNavigationResults.set(treeNavigation.requestId, treeNavigation.result);
    return; // internal correlated result: never render it as a persistent status chip
  }
  const executionEnvelope = appendPiDomainEvent(chat, evt, chat.historyBase + chat.history.length);
  if (evt.type === "response") {
    const waiter = evt.id !== undefined ? chat.pendingRpc.get(evt.id) : undefined;
    if (waiter) {
      // Claimed by a /rpc call: request-scoped, never recorded or broadcast. Validate
      // the response's `data` against the contract (only on success) — the SPA reads it.
      if (evt.success === true) {
        const probs = checkResponseData(evt.command, evt.data);
        if (probs.length) reportDrift(chat, "data", evt.command, probs, line);
      }
      chat.pendingRpc.delete(evt.id);
      clearTimeout(waiter.timer);
      waiter.resolve(evt);
    } else {
      broadcast(chat, line); // unclaimed (e.g. a rejected prompt) — live only, unrecorded
    }
    return;
  }
  if (evt.type === "agent_start") chat.busy = true;
  if (evt.type === "agent_end") chat.busy = false;
  recordAndBroadcast(chat, line, evt); // recorded + forwarded verbatim
  if (executionEnvelope) {
    const normalized = {
      type: "__execution_envelope",
      toolCallId: evt.toolCallId,
      toolName: evt.toolName,
      envelope: executionEnvelope,
    };
    recordAndBroadcast(chat, JSON.stringify(normalized), normalized);
  }
}

// Restart a chat's pi in a new working folder: fresh session, tools, and data-doc
// detection all consistent with the header. The old child's exit is ignored via the
// generation check in wireChat.
async function restartChat(chat, newCwd, extraArgs = []) {
  let nextLease = chat.workspaceLease;
  let nextAccess = chat.workspaceAccess;
  const repository = await inspectWorkspace(newCwd);
  const targetOwnershipPath = repository.repositoryRoot || repository.workspacePath || newCwd;
  if (!samePath(chat.workspaceAccess?.workspacePath, targetOwnershipPath)) {
    nextLease = new WorkspaceLeaseManager({
      agentDir: AGENT_DIR,
      ownerId: chat.sid,
      clientInterface: RUNTIME_MODE ? "desktop-runtime" : "web",
    });
    const nextMode = chat.workspaceAccess?.mode === "read-only" ? "read-only" : "write";
    const result = nextLease.acquire(newCwd, { mode: nextMode, repository });
    if (!result.ok) {
      const error = new Error(result.message);
      error.workspaceAccess = result;
      throw error;
    }
    nextAccess = result.access;
  }
  if (nextLease !== chat.workspaceLease) chat.workspaceLease?.release();
  chat.cwd = newCwd;
  chat.workspaceLease = nextLease;
  chat.workspaceAccess = nextAccess;
  chat.managedWorktreeId = null;
  const old = chat.child;
  chat.child = null; // generation check: the old child's events/exit are ignored from here
  killPi(old); // reap the whole subtree (Windows cmd.exe wrapper would otherwise orphan pi)
  for (const [id, waiter] of chat.pendingRpc) {
    clearTimeout(waiter.timer);
    waiter.resolve(null); // fail pending toolbar calls fast instead of timing out
    chat.pendingRpc.delete(id);
  }
  chat.busy = false;
  chat.history.length = 0;
  chat.historyBase = 0;
  chat.resetEpoch++;
  chat.answeredUi.clear();
  chat.treeNavigationResults.clear();
  chat.runtimeArtifacts.clear();
  chat.toolRuns.clear();
  chat.stderrTail = "";
  chat.driftSeen.clear(); // a respawn may be a different Pi build — re-warn once per shape
  chat.status = "running";
  chat.runtimeEvents.revise();
  appendRuntimeEvent(chat, "workspace.changed", { cwd: newCwd, access: chat.workspaceAccess });
  appendRuntimeEvent(chat, "session.updated", { cwd: newCwd, reason: "process-restarted" });
  chat.child = spawnPi(newCwd, extraArgs, chat.workspaceAccess);
  wireChat(chat, chat.child);
  // Per-chat reset frame (unrecorded → plain broadcast, no n). Pollers detect it via the
  // bumped epoch exactly as before; SSE clients reset this tab's transcript on it.
  broadcast(chat, JSON.stringify({ type: "__reset", cwd: chat.cwd, epoch: chat.resetEpoch }));
}

// Pi session mutations (new/fork/clone/switch) keep the process but replace its
// active transcript. Clear only bridge/UI replay state; Pi remains authoritative.
// Callers decide whether to backfill the newly active branch after the reset.
function resetChatReplay(chat) {
  chat.busy = false;
  chat.history.length = 0;
  chat.historyBase = 0;
  chat.resetEpoch++;
  chat.answeredUi.clear();
  chat.runtimeEvents.revise();
  appendRuntimeEvent(chat, "session.updated", { cwd: chat.cwd, reason: "session-replaced" });
  broadcast(chat, JSON.stringify({ type: "__reset", cwd: chat.cwd, epoch: chat.resetEpoch }));
}

// One correlated RPC round-trip against a chat's pi child.
function rpcCall(chat, cmd, timeoutMs = 30000) {
  const id = `web-${++rpcSeq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chat.pendingRpc.delete(id);
      resolve(null);
    }, timeoutMs);
    chat.pendingRpc.set(id, { resolve, timer });
    sendTo(chat, { ...cmd, id });
  });
}

function waitForChildExit(child, timeoutMs = 10000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => { cleanup(); resolveWait(false); }, timeoutMs);
    const done = () => { cleanup(); resolveWait(true); };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", done);
      child.off("error", done);
    };
    child.once("exit", done);
    child.once("error", done);
  });
}

// Per-command /rpc timeouts. `compact` is an LLM round-trip: pi summarizes a long
// conversation with the model, which routinely exceeds the 30 s default on big sessions
// (the whole point of compacting). A 504 there falsely reports failure while pi is still
// working — so give compact a 3-minute ceiling. COOP_WEB_RPC_TIMEOUT_COMPACT (ms) overrides
// it, used by tests to exercise the timeout path without a real 3-minute wait. Documented
// next to `compact` in web/protocol.mjs COMMANDS_SENT.
const RPC_TIMEOUTS = {
  compact: Number(process.env.COOP_WEB_RPC_TIMEOUT_COMPACT) || 180000,
};

// Boot: one chat in the default working folder. Every function/const above is defined,
// so spawning here is safe. Each chat carries its own cwd from this point on.
try {
  await makeChat(DEFAULT_CWD);
} catch (error) {
  if (error.workspaceAccess?.code !== "workspace-write-conflict") throw error;
  console.error("  workspace is already writable in another Coop client; opening the initial chat read-only");
  await makeChat(DEFAULT_CWD, [], { mode: "read-only", approved: false });
}

// --- Session listing + resume -------------------------------------------------
// Mirrors pi's getDefaultSessionDirPath: sessions live under
// <agentDir>/sessions/--<cwd with [/\:] -> - >--/. We list the newest files with
// a cheap scan for the display name (last session_info entry) and a preview
// (first user message), and resume by restarting pi with --session <file> —
// the file must live inside the current folder's session dir (path jail).
function sessionsDirFor(cwd) {
  const agentDir = (spec.env && spec.env.PI_CODING_AGENT_DIR) || process.env.PI_CODING_AGENT_DIR || "";
  if (!agentDir) return null;
  const safe = `--${resolvePath(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolvePath(agentDir), "sessions", safe);
}

// "Same folder?" — resolve both sides, case-insensitive on win32. The startup CWD is
// NOT normalized (`getArg("--cwd", process.cwd())`) and Pi writes the resolved cwd
// into each session header, so a relative --cwd, a trailing separator, or a Windows
// case difference must not defeat a naive === when the server marks which /history
// group is the current one (the SPA never string-compares paths — see /history).
function samePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let ra = resolvePath(a), rb = resolvePath(b);
  if (process.platform === "win32") { ra = ra.toLowerCase(); rb = rb.toLowerCase(); }
  return ra === rb;
}

// Resolve a renderer-supplied Pi session path only inside Coop's isolated
// <agentDir>/sessions tree. switch_session is a real Pi RPC capability, but it
// must not become an arbitrary local-file selector exposed to the renderer.
function resolveStoredSessionPath(value) {
  if (typeof value !== "string" || !value.endsWith(".jsonl") || value.includes("\0")) return null;
  const agentDir = (spec.env && spec.env.PI_CODING_AGENT_DIR) || process.env.PI_CODING_AGENT_DIR || "";
  if (!agentDir) return null;
  try {
    let root = realpathSync(join(resolvePath(agentDir), "sessions"));
    let full = realpathSync(resolvePath(value));
    const st = statSync(full);
    if (!st.isFile()) return null;
    if (process.platform === "win32") { root = root.toLowerCase(); full = full.toLowerCase(); }
    return full === root || full.startsWith(root + sep) ? realpathSync(resolvePath(value)) : null;
  } catch {
    return null;
  }
}

// Read up to maxBytes from the head of a file, without loading a multi-MB session
// wholesale. A truncated trailing line simply fails JSON.parse below and is skipped.
function readHead(fullPath, maxBytes) {
  let fd;
  try {
    fd = openSync(fullPath, "r");
    const len = Math.min(fstatSync(fd).size, maxBytes);
    const buf = Buffer.allocUnsafe(len);
    let off = 0;
    while (off < len) {
      const nread = readSync(fd, buf, off, len - off, off);
      if (nread <= 0) break;
      off += nread;
    }
    return buf.toString("utf8", 0, off);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

// mtime-keyed cache for scanSessionFile: /history can scan up to 12×30 files at
// 256 KB head-reads each; return cached meta when the file's mtime is unchanged.
// Bounded at 500 entries (evict oldest-inserted). /sessions benefits for free.
const sessionMetaCache = new Map(); // fullPath -> { mtimeMs, meta }
const SESSION_META_CACHE_MAX = 500;

// A prompt sent with a Files-panel attachment is persisted wrapped in a
// <coop-viewing-context> directive (see wrapViewingContext in web/public/app.js). The
// SPA strips it from every user-bubble render (app.js VIEW_RE / stripViewingContext);
// the History/`/sessions` preview must strip it too, or every such conversation shows
// the same boilerplate instead of the user's question. KEEP THIS IN SYNC with the SPA's
// VIEW_RE (web/public/app.js).
const VIEW_CONTEXT_RE = /^<coop-viewing-context file="[\s\S]*?">[\s\S]*?<\/coop-viewing-context>\n*/;

function scanSessionFile(fullPath) {
  let mtimeMs = 0;
  try { mtimeMs = statSync(fullPath).mtimeMs; } catch { /* fall through to a fresh read */ }
  const cached = sessionMetaCache.get(fullPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.meta;
  // Read a bounded head chunk: enough for the header + early entries (session name
  // and the first user message) without loading a multi-MB session wholesale.
  const text = readHead(fullPath, 256 * 1024);
  if (text === null) return null;
  const lines = text.split("\n");
  let name = "";
  let preview = "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name; // last one wins
    if (!preview && entry.message && entry.message.role === "user") {
      const c = entry.message.content;
      const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join(" ") : "";
      // Strip the viewing-context wrapper first so the preview is the real question, not
      // the attachment boilerplate. A wrapper-only message strips to "" (falsy), so the
      // `!preview` guard lets the NEXT user message supply the preview instead.
      preview = String(t).replace(VIEW_CONTEXT_RE, "").replace(/\s+/g, " ").trim().slice(0, 80);
    }
  }
  const meta = { name, preview };
  sessionMetaCache.set(fullPath, { mtimeMs, meta });
  if (sessionMetaCache.size > SESSION_META_CACHE_MAX) {
    sessionMetaCache.delete(sessionMetaCache.keys().next().value); // evict first-inserted
  }
  return meta;
}

// --- Recent working folders ----------------------------------------------------
// Folders coop has been used in before, derived from pi's session store: each
// sessions/--…--/ dir holds the conversations for one working folder. The dir
// NAME is a lossy encoding (hyphens in real path segments are indistinguishable
// from separators), so we read the authoritative `cwd` from the newest session
// file's header line instead — and only offer folders that still exist.
function recentFolders(limit = 12) {
  const agentDir = (spec.env && spec.env.PI_CODING_AGENT_DIR) || process.env.PI_CODING_AGENT_DIR || "";
  if (!agentDir) return [];
  const root = join(resolvePath(agentDir), "sessions");
  let dirs = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const byNewest = dirs
    .map((d) => {
      try {
        return { name: d.name, mtime: statSync(join(root, d.name)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  const seen = new Set();
  const out = [];
  for (const { name, mtime } of byNewest) {
    if (out.length >= limit) break;
    const dir = join(root, name);
    let newest = null;
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const m = statSync(join(dir, f)).mtimeMs;
        if (!newest || m > newest.mtime) newest = { f, mtime: m };
      }
    } catch {
      continue;
    }
    if (!newest) continue;
    // The header ({"type":"session",…,"cwd":…}) is the first line of the file.
    const head = readHead(join(dir, newest.f), 8 * 1024);
    if (!head) continue;
    let cwd = "";
    for (const line of head.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "session" && typeof entry.cwd === "string") cwd = entry.cwd;
      } catch { /* truncated/odd line — keep scanning */ }
      break; // header is line one; don't scan the whole head
    }
    if (!cwd || seen.has(cwd)) continue;
    try {
      if (!statSync(cwd).isDirectory()) continue;
    } catch {
      continue;
    }
    seen.add(cwd);
    out.push({ dir: cwd, mtime });
  }
  return out;
}

// --- Session history (grouped by workspace) ------------------------------------
// The conversations in ONE session dir (newest first, capped), with display name +
// preview. Extracted from the /sessions handler so /history can reuse it per group;
// /sessions keeps its exact wire shape.
function listSessionsIn(dir) {
  const sessions = [];
  if (!dir || !existsSync(dir)) return sessions;
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return sessions;
  }
  const withTimes = files
    .map((f) => {
      try {
        return { f, mtime: statSync(join(dir, f)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 30);
  for (const { f, mtime } of withTimes) {
    const meta = scanSessionFile(join(dir, f));
    if (!meta) continue;
    if (!meta.name && !meta.preview) continue; // empty shell sessions aren't resumable conversations
    sessions.push({ file: f, mtime, name: meta.name, preview: meta.preview });
  }
  return sessions;
}

// Every workspace coop has been used in, each with its listable sessions — for the
// grouped 🕘 History card. Follows the recentFolders() skeleton, but does NOT drop
// non-existent workspaces (returns them exists:false so the UI can show-but-disable),
// and the SERVER decides which group is current (current:true via samePath) so the
// SPA never string-compares paths.
function listWorkspaceGroups(currentCwd, limit = 12) {
  const agentDir = (spec.env && spec.env.PI_CODING_AGENT_DIR) || process.env.PI_CODING_AGENT_DIR || "";
  if (!agentDir) return [];
  const root = join(resolvePath(agentDir), "sessions");
  let dirs = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const byNewest = dirs
    .map((d) => { try { return { name: d.name, mtime: statSync(join(root, d.name)).mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  const seen = new Set();
  const groups = [];
  for (const { name } of byNewest) {
    if (groups.length >= limit) break;
    const dir = join(root, name);
    // Authoritative cwd = the newest file's header line (the dir name is lossy).
    let newest = null;
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const m = statSync(join(dir, f)).mtimeMs;
        if (!newest || m > newest.mtime) newest = { f, mtime: m };
      }
    } catch { continue; }
    if (!newest) continue;
    const head = readHead(join(dir, newest.f), 8 * 1024);
    if (!head) continue;
    let cwd = "";
    for (const line of head.split("\n")) {
      if (!line.trim()) continue;
      try { const entry = JSON.parse(line); if (entry.type === "session" && typeof entry.cwd === "string") cwd = entry.cwd; } catch { /* odd line */ }
      break; // header is line one
    }
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    const sessions = listSessionsIn(dir);
    if (!sessions.length) continue; // drop empty groups (no listable conversations)
    let exists = false;
    try { exists = statSync(cwd).isDirectory(); } catch { exists = false; }
    groups.push({ dir: cwd, exists, current: samePath(cwd, currentCwd), sessions });
  }
  return groups;
}

// --- Read-only file browsing (Files panel) --------------------------------------
// The browser can LIST and READ files inside the current working folder — never
// outside it (path jail incl. symlink resolution), never write. This mirrors what
// the user could already see in their own file manager; it exists so review docs,
// lineage output, and CSVs are readable next to the chat.
const FILES_IGNORE = new Set([
  ".git", "node_modules", ".DS_Store", ".venv", "venv", "__pycache__", "dist", "out", ".next",
]);
// One rule for BOTH the listing and the read path, so /file can never serve a file
// the /files tree deliberately hid (e.g. .env, .git/config). Dotfiles are hidden
// except .gitignore; FILES_IGNORE dirs are hidden outright.
const isHidden = (name) => FILES_IGNORE.has(name) || (name.startsWith(".") && name !== ".gitignore");
const FILES_DEPTH = 6; // directory levels below CWD
const FILES_MAX = 2000; // total entries per listing — keeps the payload bounded
const FILE_TEXT_MAX = 1_000_000; // 1MB text preview cap

function listTree(dir, rel, depth, state) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes = [];
  for (const e of entries) {
    if (state.count >= FILES_MAX) {
      state.clipped = true;
      break;
    }
    if (isHidden(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      state.count++;
      nodes.push({
        name: e.name,
        path: childRel,
        type: "dir",
        children: depth > 0 ? listTree(join(dir, e.name), childRel, depth - 1, state) : [],
      });
    } else if (e.isFile()) {
      state.count++;
      nodes.push({ name: e.name, path: childRel, type: "file" });
    }
  }
  nodes.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
  return nodes;
}

const MD_EXT = new Set([".md", ".markdown", ".mdx"]);
const SHEET_EXT = new Set([".csv", ".tsv"]);
const DATA_EXT = new Set([".json", ".jsonl", ".ndjson"]);

// Resolve a browser-supplied relative path inside the CWD jail, or null.
// Two gates: the lexical resolve must stay under CWD (blocks ../ traversal), and
// the REAL path must too (blocks a symlink inside the tree pointing outside it).
function jailPath(cwd, rel) {
  if (typeof rel !== "string" || !rel || rel.includes("\0")) return null;
  const root = resolvePath(cwd);
  const full = resolvePath(root, rel);
  if (full !== root && !full.startsWith(root + sep)) return null;
  try {
    const real = realpathSync(full);
    const realRoot = realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
    return real;
  } catch {
    return null; // doesn't exist / unreadable
  }
}

function readFilePreview(cwd, rel) {
  const full = jailPath(cwd, rel);
  if (!full) return null;
  // Apply the listing's hide rule to the READ path too, so /file can't serve a
  // .env / .git/config the tree never showed. Derive segments relative to the REAL
  // root (jailPath returns a realpath-resolved `full`, so a symlinked CWD like
  // macOS /var -> /private/var doesn't spuriously produce ".." segments). Splitting
  // on both separators also catches Windows-style input. Refusing returns null ->
  // the same 400 as a missing file.
  for (const seg of relPath(realpathSync(resolvePath(cwd)), full).split(/[/\\]/)) {
    if (seg && isHidden(seg)) return null;
  }
  let st;
  try {
    st = statSync(full);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const truncated = st.size > FILE_TEXT_MAX;
  const text = readHead(full, FILE_TEXT_MAX);
  if (text === null) return null;
  // Binary sniff: a NUL byte in the first 8KB means "don't render this as text".
  if (text.slice(0, 8192).includes("\0")) {
    return { path: rel, kind: "binary", content: "", truncated: false, size: st.size };
  }
  const ext = extname(full).toLowerCase();
  const kind = MD_EXT.has(ext) ? "markdown" : SHEET_EXT.has(ext) ? "sheet" : DATA_EXT.has(ext) ? "data" : "code";
  return { path: rel, kind, ext, content: text, truncated, size: st.size };
}

// --- Git changes viewer (read-only, jailed to the working folder) ---------------
// The "± Changes" panel shows the working tree's git changes. Everything here is a
// bridge-local READ, exactly like /files — no new pi RPC, no shell.
const GIT_MAX_FILES = 500;
const GIT_DIFF_MAX = 1_000_000; // 1 MB per-diff cap
const GIT_TIMEOUT_MS = 15000;
// Base-ref validation (prevents option injection even though there's no shell): a
// conservative ref charset, never starting with "-". Always pass `--` before
// pathspecs in every git invocation so a ref/path can't be read as a flag.
const gitRefOk = (s) => typeof s === "string" && /^[A-Za-z0-9._/~^-]{1,200}$/.test(s) && !s.startsWith("-");

// Path jail for git pathspecs (p/old on /git/diff). Like jailPath, but: (a) the
// realpath gate applies ONLY when the file exists — a deleted file legitimately has
// no realpath, and its content comes from git's object store (git stores a symlink
// as its link text, so a tracked symlink can't leak target contents through a diff);
// (b) dotfiles are ALLOWED here (unlike /file's isHidden), so a tracked path like
// .github/workflows/ci.yml is diffable — a dotfile's diff is only ever served if git
// itself reports it changed. FILES_IGNORE segments (.git, node_modules, …) stay
// refused everywhere. Returns the validated relative path, or null.
function jailGitPath(cwd, rel) {
  if (typeof rel !== "string" || !rel || rel.includes("\0")) return null;
  const root = resolvePath(cwd);
  const full = resolvePath(root, rel);
  if (full !== root && !full.startsWith(root + sep)) return null; // lexical ../ gate
  for (const seg of relPath(root, full).split(/[/\\]/)) {
    if (seg && FILES_IGNORE.has(seg)) return null; // keep .git/, node_modules/ out
  }
  try {
    if (existsSync(full)) {
      const real = realpathSync(full);
      const realRoot = realpathSync(root);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) return null; // symlink escape
    }
  } catch {
    return null;
  }
  return rel;
}

// Run `git` DIRECTLY (never a shell) inside CWD. Resolves, never rejects (swallow-
// and-degrade, matching the rest of the bridge). GIT_OPTIONAL_LOCKS=0 so read
// commands never take the index lock while the agent works. On Windows git.exe is a
// real executable, so PATH resolution works without the cmd.exe wrapper spawnPi
// needs for the .cmd shim — do NOT reuse that wrapper here.
//   -> {ok:true, out, truncated} | {ok:false, missing:true} | {ok:false, code, err}
function runGit(cwd, args, { maxBytes = 2_000_000, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("git", args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({ ok: false, missing: true });
      return;
    }
    let out = Buffer.alloc(0);
    let outLen = 0;
    let truncated = false;
    let errTail = "";
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ ok: false, code: -1, err: "timed out" }); }, timeoutMs);
    child.on("error", (e) => {
      if (e && e.code === "ENOENT") finish({ ok: false, missing: true }); // git not installed
      else finish({ ok: false, code: -1, err: String((e && e.message) || e) });
    });
    child.stdout.on("data", (d) => {
      if (truncated) return;
      if (outLen + d.length > maxBytes) {
        out = Buffer.concat([out, d.subarray(0, Math.max(0, maxBytes - outLen))]);
        outLen = maxBytes;
        truncated = true; // keep the partial buffer, stop the child
        try { child.kill(); } catch { /* gone */ }
      } else {
        out = Buffer.concat([out, d]);
        outLen += d.length;
      }
    });
    child.stderr.on("data", (d) => { errTail = (errTail + d.toString("utf8")).slice(-1000); });
    child.on("close", (code) => {
      if (code === 0 || truncated) finish({ ok: true, out: out.toString("utf8"), truncated });
      else finish({ ok: false, code: code == null ? -1 : code, err: errTail.trim() });
    });
  });
}

// Resolve the diff base for /git/changes and /git/diff. Returns { base } (a sha or
// ref string), or { error } (bad/unresolvable ref — uniform, no oracle), or
// { noHead:true } when the repo has no commits yet. `noHead` is only computed for
// the default (no base) path; an explicit base against a HEAD-less repo errors.
async function resolveGitBase(cwd, baseParam) {
  const head = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const noHead = !(head.ok);
  if (!baseParam) return { base: "HEAD", noHead };
  if (!gitRefOk(baseParam)) return { error: true };
  // GitHub-style branch diff: prefer the merge-base; fall back to the ref itself.
  const mb = await runGit(cwd, ["merge-base", baseParam, "HEAD", "--"]);
  if (mb.ok && mb.out.trim()) return { base: mb.out.trim(), noHead };
  const verify = await runGit(cwd, ["rev-parse", "--verify", "--quiet", baseParam + "^{commit}"]);
  if (verify.ok && verify.out.trim()) return { base: baseParam, noHead };
  return { error: true };
}

// Parse git's NUL-separated `--name-status -z` grammar into file records. Records
// are STATUS\0path\0, except R<score>/C<score> which consume TWO path tokens
// (old\0new\0, keyed by the new path). Skips FILES_IGNORE first segments.
function parseNameStatusZ(text, records) {
  const toks = text.split("\0");
  let i = 0;
  while (i < toks.length) {
    const status = toks[i];
    if (!status) { i++; continue; } // trailing empty token after the final NUL
    const letter = status[0];
    if (letter === "R" || letter === "C") {
      const oldPath = toks[i + 1];
      const newPath = toks[i + 2];
      i += 3;
      if (!newPath) continue;
      if (newPath.split("/").some((seg) => FILES_IGNORE.has(seg))) continue;
      records.push({ path: newPath, oldPath, status: letter === "R" ? "R" : "A", untracked: false });
    } else {
      const p = toks[i + 1];
      i += 2;
      if (!p) continue;
      if (p.split("/").some((seg) => FILES_IGNORE.has(seg))) continue;
      // Map statuses: A/M/D pass through; T/U -> M; anything else -> M.
      const s = letter === "A" ? "A" : letter === "D" ? "D" : letter === "M" ? "M" : "M";
      records.push({ path: p, status: s, untracked: false });
    }
  }
}

// After resuming, pull the active branch and backfill the browser transcript as
// rich __replay events (recorded, so replay/polling see them too).
async function backfillMessages(chat) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const reply = await rpcCall(chat, { type: "get_messages" }, 5000);
    if (reply && reply.success && reply.data && Array.isArray(reply.data.messages)) {
      for (const event of projectTranscriptMessages(reply.data.messages)) {
        recordAndBroadcast(chat, JSON.stringify(event), { type: "__replay" });
      }
      return;
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  console.error("coop web: could not backfill the resumed conversation (get_messages never answered)");
}

// --- File-based transcript backfill (the primary resume path) --------------------
// Rebuild a resumed conversation FROM THE SESSION FILE — thinking blocks, tool calls
// with their arguments + outputs, and compaction markers, in original order —
// including pre-compaction history. Emitted as recorded+broadcast
// __replay lines. get_messages stays the fallback for oversized/corrupt files.
const SESSION_READ_MAX = 16 * 1024 * 1024; // 16 MiB — bigger files fall back to get_messages

function loadSessionTranscript(fullPath) {
  let size = 0;
  try { size = statSync(fullPath).size; } catch { return null; }
  if (size > SESSION_READ_MAX) return null; // caller falls back to get_messages
  let raw;
  try { raw = readFileSync(fullPath, "utf8"); } catch { return null; }
  // Split on "\n" only, strip one trailing "\r", skip blanks, parse per line. NEVER
  // node:readline (U+2028/U+2029 corruption — same rule as the stdout framer).
  const entries = [];
  for (let line of raw.split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* torn/odd line — skip */ }
  }
  if (!entries.length) return null;
  // Index entries with a string id, EXCLUDING the header (type:"session"): the header
  // has an id too, but nothing ever points at it (the first real entry carries
  // parentId:null), so indexing it would make the header an eternal extra "leaf" and
  // flag EVERY session — even strictly linear ones — as branched.
  const byId = new Map();
  entries.forEach((e, pos) => { if (e && typeof e.id === "string" && e.type !== "session") byId.set(e.id, { e, pos }); });
  const referenced = new Set();
  for (const { e } of byId.values()) { if (e.parentId != null) referenced.add(e.parentId); }
  const leaves = [];
  for (const rec of byId.values()) { if (!referenced.has(rec.e.id)) leaves.push(rec); }
  if (!leaves.length) return null;
  const ts = (e) => { const v = e.timestamp; if (typeof v === "number") return v; const p = Date.parse(v); return isNaN(p) ? 0 : p; };
  // Active leaf = max timestamp; ties -> later file position wins.
  let active = leaves[0];
  for (const rec of leaves) {
    const c = ts(rec.e), a = ts(active.e);
    if (c > a || (c === a && rec.pos > active.pos)) active = rec;
  }
  // Walk parentId links to the root, then reverse -> the active chain (root-first).
  const chain = [];
  const guard = new Set();
  let cur = active;
  while (cur && !guard.has(cur.e.id)) {
    guard.add(cur.e.id);
    chain.push(cur.e);
    cur = cur.e.parentId != null ? byId.get(cur.e.parentId) : null;
  }
  chain.reverse();
  const branched = leaves.length > 1;
  // Pre-scan the chain's toolResults: toolCallId -> {output, isError}.
  const toolResults = new Map();
  for (const e of chain) {
    const m = e && e.message;
    if (m && m.role === "toolResult" && m.toolCallId) {
      const c = m.content;
      let output = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b && b.type === "text").map((b) => b.text).join("\n") : "";
      if (output.length > REPLAY_TOOL_OUT_MAX) output = output.slice(0, REPLAY_TOOL_OUT_MAX) + `\n… (${output.length - REPLAY_TOOL_OUT_MAX} more chars)`;
      toolResults.set(m.toolCallId, { output, isError: !!m.isError });
    }
  }
  // Convert the chain in order.
  const lines = [];
  for (const e of chain) {
    if (!e) continue;
    if (e.type === "compaction") {
      // Do NOT trim pre-compaction turns — showing them is the point of reading the
      // file; the marker keeps the context honest.
      lines.push(JSON.stringify({ type: "__replay", kind: "compaction", summary: String(e.summary || "").slice(0, 500) }));
      continue;
    }
    if (e.type !== "message") continue; // session_info/model_change/label/custom/branch_summary/... skipped in v1
    const m = e.message;
    if (!m) continue;
    if (m.role === "user") {
      const c = m.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b && b.type === "text").map((b) => b.text).join("\n") : "";
      if (!text.trim()) continue;
      lines.push(JSON.stringify({ type: "__replay", role: "user", text }));
    } else if (m.role === "assistant") {
      const parts = [];
      const c = m.content;
      if (typeof c === "string") {
        if (c.trim()) parts.push({ kind: "text", text: c });
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (!b || typeof b !== "object") continue;
          if (b.type === "text" && b.text) parts.push({ kind: "text", text: String(b.text) });
          else if (b.type === "thinking" && b.thinking) parts.push({ kind: "thinking", text: String(b.thinking).slice(0, REPLAY_THINKING_MAX) });
          else if (b.type === "toolCall") {
            const tr = toolResults.get(b.id) || {};
            parts.push({ kind: "tool", name: b.name || "tool", args: b.arguments, output: tr.output || "", isError: !!tr.isError, incomplete: !toolResults.has(b.id) });
          }
        }
      }
      if (!parts.length) continue;
      lines.push(JSON.stringify({ type: "__replay", role: "assistant", parts }));
    }
    // toolResult messages are consumed into the assistant tool parts (pre-scan above).
  }
  if (!lines.length) return null;
  if (branched) lines.unshift(JSON.stringify({ type: "__replay", kind: "info", text: "This conversation has other branches — showing the most recent." }));
  return { lines, branched };
}

// Backfill from the session file; on non-null, record+broadcast each __replay line
// (same loop shape as backfillMessages) and return true; else return false so the
// caller falls back to get_messages.
function backfillFromFile(chat, fullPath) {
  let res;
  try { res = loadSessionTranscript(fullPath); } catch { return false; }
  if (!res || !res.lines.length) return false;
  for (const line of res.lines) {
    recordAndBroadcast(chat, line, { type: "__replay" });
  }
  return true;
}

// --- HTTP server ---------------------------------------------------------------
const STATIC = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/theme-system.js": { file: "theme-system.js", type: "text/javascript; charset=utf-8" },
  "/usage-model.js": { file: "usage-model.js", type: "text/javascript; charset=utf-8" },
  "/session-tree-model.js": { file: "session-tree-model.js", type: "text/javascript; charset=utf-8" },
  "/interaction-model.js": { file: "interaction-model.js", type: "text/javascript; charset=utf-8" },
  "/workspace-health-model.js": { file: "workspace-health-model.js", type: "text/javascript; charset=utf-8" },
  "/capability-view-registry.js": { file: "capability-view-registry.js", type: "text/javascript; charset=utf-8" },
  "/findings-model.js": { file: "findings-model.js", type: "text/javascript; charset=utf-8" },
  "/lineage-model.js": { file: "lineage-model.js", type: "text/javascript; charset=utf-8" },
  "/impact-model.js": { file: "impact-model.js", type: "text/javascript; charset=utf-8" },
  "/knowledge-model.js": { file: "knowledge-model.js", type: "text/javascript; charset=utf-8" },
  "/mission-control-model.js": { file: "mission-control-model.js", type: "text/javascript; charset=utf-8" },
  "/content-portability.js": { file: "content-portability.js", type: "text/javascript; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/viewer.js": { file: "viewer.js", type: "text/javascript; charset=utf-8" },
  "/diff.js": { file: "diff.js", type: "text/javascript; charset=utf-8" },
  "/diffview.js": { file: "diffview.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};
const FAVICON = join(HERE, "..", "themes", "coop.ico");

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function baseHeaders(type) {
  return {
    "content-type": type,
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  };
}

function hostOk(req) {
  const h = (req.headers.host || "").split(":")[0];
  return h === "127.0.0.1" || h === "localhost";
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
function cookieToken(req) {
  const m = /(?:^|;\s*)coop_token=([a-f0-9]+)/.exec(req.headers.cookie || "");
  return m ? m[1] : null;
}
function authed(req) {
  const t = cookieToken(req);
  return t !== null && safeEqual(t, TOKEN);
}
const REQUEST_BODY_MAX = 12 * 1024 * 1024; // permits bounded screenshot prompts
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (d) => {
      chunks.push(d);
      bytes += d.length;
      if (bytes > REQUEST_BODY_MAX) req.destroy();
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
    req.on("close", () => resolve(Buffer.concat(chunks).toString("utf8"))); // destroyed (cap hit)
  });
}
async function readJson(req) {
  try {
    return JSON.parse((await readBody(req)) || "{}");
  } catch {
    return null;
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(`${RUNTIME_MODE ? "coop runtime" : "coop web"}: request error:`, e.message);
    try {
      res.writeHead(500, baseHeaders("text/plain")).end("error");
    } catch {
      /* headers already sent */
    }
  });
});

async function handle(req, res) {
  res.on("finish", () => {
    if (req.url && (req.url.startsWith("/events-poll") || req.url.startsWith("/runtime-events-poll")) && res.statusCode === 200) return;
    console.error(`  ${req.method} ${(req.url || "").split("?")[0]} -> ${res.statusCode}`);
  });
  if (!hostOk(req)) {
    res.writeHead(403, baseHeaders("text/plain")).end("bad host");
    return;
  }
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // Landing page: require the one-time token in the query, then set it as a cookie.
  if (req.method === "GET" && url.pathname === "/") {
    if (!safeEqual(url.searchParams.get("token") || "", TOKEN)) {
      res
        .writeHead(401, baseHeaders("text/plain"))
        .end(`coop ${RUNTIME_MODE ? "runtime" : "web"}: invalid or missing token. Restart the runtime and use its one-time token.`);
      return;
    }
    res.writeHead(200, {
      ...baseHeaders(STATIC["/"].type),
      // No `Secure` flag: this is plain http on 127.0.0.1 (loopback never leaves the machine).
      "set-cookie": `coop_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`,
    });
    res.end(readFileSync(join(HERE, "public", STATIC["/"].file)));
    return;
  }

  // Everything below requires the cookie.
  if (!authed(req)) {
    res.writeHead(401, baseHeaders("text/plain")).end("unauthorized");
    return;
  }

  if (req.method === "GET" && STATIC[url.pathname] && url.pathname !== "/") {
    const s = STATIC[url.pathname];
    res.writeHead(200, baseHeaders(s.type));
    res.end(readFileSync(join(HERE, "public", s.file)));
    return;
  }

  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    if (existsSync(FAVICON)) {
      res.writeHead(200, baseHeaders("image/x-icon"));
      res.end(readFileSync(FAVICON));
    } else {
      res.writeHead(404, baseHeaders("text/plain")).end();
    }
    return;
  }

  // Bounded navigation metadata; no transcript replay or session-file reads.
  if (req.method === "GET" && url.pathname === "/chat-state") {
    res.writeHead(200, baseHeaders("application/json"));
    res.end(JSON.stringify({ ok: true, chats: chatList().map(chat => ({ ...chat, epoch: chats.get(chat.sid)?.resetEpoch })), maxChats: MAX_CHATS }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      ...baseHeaders("text/event-stream"),
      connection: "keep-alive",
    });
    if (!writeSse(res, `retry: 2000\n\n`)) return;
    // Global hello: the chat list + the cap. Per-chat REPLAY has moved to
    // /events-poll?sid (§2.4) — /events carries only the live enveloped frames now.
    if (!writeSse(res, `data: {"ev":${JSON.stringify({ type: "__hello", chats: chatList(), maxChats: MAX_CHATS })}}\n\n`)) return;
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // Polling fallback for environments where SSE never connects (some corporate
  // proxies/endpoint protection buffer or block streaming responses, even on
  // loopback). Returns everything after global event #since, plus the next cursor.
  if (req.method === "GET" && url.pathname === "/events-poll") {
    const chat = chatFor(url.searchParams.get("sid"));
    // Unknown/ambiguous sid → 400 whose body carries `chats` so a polling client can
    // recover (list-refresh + ensureActiveExists) instead of dead-ending.
    if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open.", chats: chatList() })); return; }
    const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
    // A `since` greater than the current total can only be a cursor from a PREVIOUS
    // epoch (next never exceeds the total within an epoch), e.g. a poll that crossed a
    // /resume|/chdir|new_session reset. Clamp it to 0 so the client gets the new epoch
    // from its beginning — otherwise the slice returns [] while `next` already counts
    // the synchronously-recorded backfill (__replay/__message), and the client, having
    // reset its transcript on the epoch bump, would skip the entire replay.
    const total = chat.historyBase + chat.history.length;
    const rel = since > total ? 0 : Math.max(0, since - chat.historyBase);
    const events = chat.history.slice(rel).filter((e) => replayable(chat, e)).map((e) => e.line);
    res.writeHead(200, baseHeaders("application/json"));
    res.end(JSON.stringify({ next: total, epoch: chat.resetEpoch, cwd: chat.cwd, busy: chat.busy, status: chat.status, chats: chatList(), events }));
    return;
  }

  // Versioned Desktop/Core event stream. It is additive beside the existing raw
  // Web replay so current clients remain byte-compatible. Poll cursors are
  // at-least-once; eventId/sequence support client dedupe and resetRequired tells
  // a reconnecting client to reconcile from its snapshot when the ring evicted.
  if (req.method === "GET" && url.pathname === "/runtime-events") {
    const chat = chatFor(url.searchParams.get("sid"));
    if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open.", chats: chatList() })); return; }
    const headerCursor = Number(req.headers["last-event-id"]);
    const queryCursor = Number(url.searchParams.get("since"));
    const since = Math.max(0, Number.isSafeInteger(queryCursor) ? queryCursor : 0, Number.isSafeInteger(headerCursor) ? headerCursor : 0);
    const replay = chat.runtimeEvents.poll(since);
    res.writeHead(200, {
      ...baseHeaders("text/event-stream"),
      connection: "keep-alive",
    });
    if (!writeSse(res, "retry: 2000\n\n")) return;
    for (const event of replay.events) {
      if (!writeSse(res, `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)) return;
    }
    const client = { res, chat };
    runtimeSseClients.add(client);
    req.on("close", () => runtimeSseClients.delete(client));
    return;
  }

  if (req.method === "GET" && url.pathname === "/runtime-events-poll") {
    const chat = chatFor(url.searchParams.get("sid"));
    if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open.", chats: chatList() })); return; }
    const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
    res.writeHead(200, baseHeaders("application/json"));
    res.end(JSON.stringify({ ok: true, ...chat.runtimeEvents.poll(since) }));
    return;
  }

  // Opaque artifact lookup for the permanent raw fallback. IDs are minted and
  // stored by this chat only; no renderer path is ever resolved or opened.
  if (req.method === "GET" && url.pathname === "/runtime-artifact") {
    const chat = chatFor(url.searchParams.get("sid"));
    const id = url.searchParams.get("id") || "";
    if (!chat || !chat.runtimeArtifacts.has(id)) {
      res.writeHead(404, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That runtime artifact is unavailable." }));
      return;
    }
    res.writeHead(200, baseHeaders("application/json"));
    res.end(JSON.stringify({ ok: true, id, artifact: chat.runtimeArtifacts.get(id) }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/doctor") {
    const chat = chatFor(url.searchParams.get("sid"));
    if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
    try {
      const report = await runDoctor({ cwd: chat.cwd });
      appendRuntimeEvent(chat, "doctor.changed", { report });
      res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: true, report }));
    } catch (error) {
      res.writeHead(500, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: `Doctor could not complete: ${error.message}` }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/auth/providers") {
    const chat = chatFor(url.searchParams.get("sid"));
    if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
    try {
      const providers = await getAuthProviders({ agentDir: AGENT_DIR, env: { ...process.env, ...(spec.env || {}) } });
      appendRuntimeEvent(chat, "auth.changed", { providers });
      res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: true, ...providers }));
    } catch (error) {
      res.writeHead(500, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: `Authentication state could not be inspected: ${error.message}` }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/knowledge/catalog") {
    const chat = chatFor(url.searchParams.get("sid"));
    if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
    if (!knowledgeService) { res.writeHead(503, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: knowledgeServiceError || "Knowledge repositories are unavailable." })); return; }
    try {
      const catalog = knowledgeService.catalog();
      res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: true, catalog }));
    } catch (error) {
      res.writeHead(500, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: `Knowledge catalog could not be built: ${error.message}` }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/knowledge/search") {
    const chat = chatFor(url.searchParams.get("sid"));
    if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
    if (!knowledgeService) { res.writeHead(503, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: knowledgeServiceError || "Knowledge repositories are unavailable." })); return; }
    const query = url.searchParams.get("q") || "";
    if (!query.trim() || query.length > 500) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "Knowledge search requires a query of at most 500 characters." })); return; }
    const scopes = url.searchParams.getAll("scope");
    try {
      const results = knowledgeService.search(query, { scopes: scopes.length ? scopes : ["project", "team"], limit: 50 });
      res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: true, results }));
    } catch (error) {
      res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/profile") {
    const chat = chatFor(url.searchParams.get("sid"));
    if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
    try {
      const report = await getUserProfile();
      res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: true, report }));
    } catch (error) {
      res.writeHead(500, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: `User profile could not be inspected: ${error.message}` }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/sessions") {
    const chat = chatFor(url.searchParams.get("sid"));
    if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
    const sessions = listSessionsIn(sessionsDirFor(chat.cwd));
    res.writeHead(200, baseHeaders("application/json"));
    res.end(JSON.stringify({ sessions }));
    return;
  }

  // Every workspace coop has been used in, grouped, current folder marked (against the
  // requesting chat's cwd). Read-only, touches nothing outside <agentDir>/sessions.
  if (req.method === "GET" && url.pathname === "/history") {
    const chat = chatFor(url.searchParams.get("sid"));
    if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
    let groups = [];
    try { groups = listWorkspaceGroups(chat.cwd); } catch { groups = []; }
    res.writeHead(200, baseHeaders("application/json"));
    res.end(JSON.stringify({ groups }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/folders") {
    res.writeHead(200, baseHeaders("application/json"));
    res.end(JSON.stringify({ folders: recentFolders() }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/capabilities") {
    res.writeHead(200, baseHeaders("application/json"));
    res.end(JSON.stringify(runtimeCapabilities));
    return;
  }

  if (req.method === "GET" && url.pathname === "/workspace/access") {
    const chat = chatFor(url.searchParams.get("sid"));
    if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
    const repository = await inspectWorkspace(chat.cwd);
    res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({
      ok: true,
      access: chat.workspaceAccess,
      managedWorktreeId: chat.managedWorktreeId,
      repository,
    }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/workflows") {
    res.writeHead(200, baseHeaders("application/json"));
    res.end(JSON.stringify({ ok: true, ...workflowRegistry }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/workflow/run") {
    const chat = chatFor(url.searchParams.get("sid"));
    if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
    const runId = url.searchParams.get("runId") || "";
    const run = chat.workflows.get(runId);
    if (!run) { res.writeHead(404, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That workflow run is unavailable." })); return; }
    res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: true, run }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/setup/state") {
    const chat = chatFor(url.searchParams.get("sid"));
    if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
    try {
      const capabilityId = url.searchParams.get("capabilityId");
      if (capabilityId && (!/^[a-z0-9.-]+$/.test(capabilityId) || capabilityId.length > 200)) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "Invalid capability ID." }));
        return;
      }
      const report = await getProjectSetupState({ workspace: chat.cwd, capabilityId: capabilityId || null });
      res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: true, report }));
    } catch {
      res.writeHead(500, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "Project setup state could not be inspected. Open Coop Health and retry." }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/config/current") {
    const chat = chatFor(url.searchParams.get("sid"));
    if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
    try {
      const report = getProjectConfig({ workspace: chat.cwd });
      res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: true, report }));
    } catch (error) {
      res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: error.message || "Project configuration could not be inspected." }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/files") {
    const chat = chatFor(url.searchParams.get("sid"));
    if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
    const state = { count: 0, clipped: false };
    const tree = listTree(resolvePath(chat.cwd), "", FILES_DEPTH, state);
    res.writeHead(200, baseHeaders("application/json"));
    res.end(JSON.stringify({ cwd: chat.cwd, tree, clipped: state.clipped }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/file") {
    const chat = chatFor(url.searchParams.get("sid"));
    if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
    const preview = readFilePreview(chat.cwd, url.searchParams.get("p") || "");
    if (!preview) {
      res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That file can't be shown." }));
      return;
    }
    res.writeHead(200, baseHeaders("application/json"));
    res.end(JSON.stringify({ ok: true, ...preview }));
    return;
  }

  // Changed-file list for the "± Changes" badge + panel left rail. All responses
  // are 200 — git-missing / non-repo / bad-base are STATES, not HTTP errors.
  if (req.method === "GET" && url.pathname === "/git/changes") {
    const chat = chatFor(url.searchParams.get("sid"));
    if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
    const cwd = chat.cwd;
    const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.missing) { res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: true, git: false })); return; }
    if (!inside.ok) { res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: true, git: true, repo: false })); return; }
    const resolved = await resolveGitBase(cwd, url.searchParams.get("base") || "");
    if (resolved.error) { res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That base ref wasn't found." })); return; }
    const { base, noHead } = resolved;
    const records = [];
    if (noHead) {
      // No commits yet: tracked-but-uncommitted files, all reported "added" (the SPA
      // renders them from /file, so the empty-tree sha — which differs under sha256
      // repos — is never needed).
      const cached = await runGit(cwd, ["ls-files", "--cached", "-z", "--"]);
      if (cached.ok) for (const p of cached.out.split("\0")) {
        if (p && !p.split("/").some((seg) => FILES_IGNORE.has(seg))) records.push({ path: p, status: "A", untracked: true });
      }
    } else {
      // --relative is load-bearing: it limits output to the cwd subtree AND emits
      // cwd-relative forward-slash paths — the jail and /file consume them directly,
      // and a cwd inside a bigger repo never leaks paths outside the working folder.
      const diff = await runGit(cwd, ["diff", "--relative", "--name-status", "-z", "-M", base, "--"]);
      if (diff.ok) parseNameStatusZ(diff.out, records);
    }
    const others = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--"]);
    if (others.ok) for (const p of others.out.split("\0")) {
      if (p && !p.split("/").some((seg) => FILES_IGNORE.has(seg))) records.push({ path: p, status: "A", untracked: true });
    }
    records.sort((a, b) => a.path.localeCompare(b.path));
    let files = records, truncated = false;
    if (files.length > GIT_MAX_FILES) { files = files.slice(0, GIT_MAX_FILES); truncated = true; }
    res.writeHead(200, baseHeaders("application/json"));
    res.end(JSON.stringify({ ok: true, git: true, repo: true, base, noHead, files, truncated }));
    return;
  }

  // Unified diff text for ONE tracked file. The bridge does NOT parse the diff — the
  // SPA does. Untracked files never reach here (the SPA renders them from /file).
  if (req.method === "GET" && url.pathname === "/git/diff") {
    const chat = chatFor(url.searchParams.get("sid"));
    if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
    const cwd = chat.cwd;
    const p = jailGitPath(cwd, url.searchParams.get("p") || "");
    const oldRaw = url.searchParams.get("old");
    const oldPath = oldRaw ? jailGitPath(cwd, oldRaw) : null;
    if (!p || (oldRaw && !oldPath)) {
      res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That diff can't be shown." }));
      return;
    }
    const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.missing) { res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "Git isn't installed on this machine, so coop can't show the diff." })); return; }
    if (!inside.ok) { res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "This folder isn't a git repository." })); return; }
    const resolved = await resolveGitBase(cwd, url.searchParams.get("base") || "");
    if (resolved.error) { res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That base ref wasn't found." })); return; }
    const args = ["diff", "--relative", "--no-color", "-M", "--unified=3", resolved.base, "--", p];
    if (oldPath) args.push(oldPath); // include the rename's old side so it resolves
    const result = await runGit(cwd, args, { maxBytes: GIT_DIFF_MAX });
    if (!result.ok) { res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That diff can't be shown." })); return; }
    res.writeHead(200, baseHeaders("application/json"));
    res.end(JSON.stringify({ ok: true, diff: result.out, truncated: !!result.truncated }));
    return;
  }

  // POSTs: require the CSRF custom header on top of the cookie.
  if (req.method === "POST") {
    if (req.headers["x-coop-csrf"] !== "1") {
      res.writeHead(403, baseHeaders("text/plain")).end("missing CSRF header");
      return;
    }

    if (url.pathname === "/knowledge/preview") {
      const body = await readJson(req);
      const chat = chatFor(body && body.sid);
      if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
      if (!knowledgeService) { res.writeHead(503, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: knowledgeServiceError || "Knowledge repositories are unavailable." })); return; }
      try {
        const proposal = body?.action === "create"
          ? knowledgeService.previewCreate({ sourceId: body?.sourceId, record: body?.record })
          : body?.action === "transition"
            ? knowledgeService.previewTransition({ sourceId: body?.sourceId, recordId: body?.recordId, record: body?.record })
            : null;
        if (!proposal) throw new TypeError("Unknown knowledge proposal action.");
        chat.knowledgeProposals.add(proposal.proposalId);
        while (chat.knowledgeProposals.size > 20) chat.knowledgeProposals.delete(chat.knowledgeProposals.values().next().value);
        res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: true, proposal }));
      } catch (error) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }

    if (url.pathname === "/knowledge/apply") {
      const body = await readJson(req);
      const chat = chatFor(body && body.sid);
      if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
      if (!knowledgeService) { res.writeHead(503, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: knowledgeServiceError || "Knowledge repositories are unavailable." })); return; }
      if (!chat.knowledgeProposals.has(body?.proposalId)) { res.writeHead(404, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat's knowledge proposal is unavailable." })); return; }
      if (chat.workspaceAccess?.mode === "read-only") { res.writeHead(409, baseHeaders("application/json")).end(JSON.stringify({ ok: false, code: "workspace-read-only", error: "Knowledge source changes cannot be written from a read-only workspace attachment." })); return; }
      if (body?.approved !== true) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "Explicit approval is required before writing a knowledge source change." })); return; }
      let sourceLease = null;
      try {
        const sourceRoot = knowledgeService.proposalWriteRoot(body?.proposalId);
        const [sourceRepository, chatRepository] = await Promise.all([inspectWorkspace(sourceRoot), inspectWorkspace(chat.cwd)]);
        const alreadyOwnedByChat = sourceRepository.repositoryRoot && sourceRepository.repositoryRoot === chatRepository.repositoryRoot;
        if (!alreadyOwnedByChat) {
          sourceLease = new WorkspaceLeaseManager({ agentDir: AGENT_DIR, ownerId: `knw_${randomBytes(10).toString("hex")}`, clientInterface: "knowledge-service" });
          const acquired = sourceLease.acquire(sourceRoot, { mode: "write", repository: sourceRepository });
          if (!acquired.ok) {
            res.writeHead(409, baseHeaders("application/json")).end(JSON.stringify({ ok: false, code: acquired.code, error: "The knowledge repository is already writable in another Coop client. Resolve that owner before applying this source change." }));
            return;
          }
        }
        const result = knowledgeService.apply({ proposalId: body?.proposalId, approved: true });
        if (result.state === "stale") { chat.knowledgeProposals.delete(body?.proposalId); knowledgeService.discardProposal(body?.proposalId); res.writeHead(409, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "Knowledge source changed after preview; review a new proposal.", result })); return; }
        chat.knowledgeProposals.delete(body?.proposalId);
        appendRuntimeEvent(chat, "knowledge.proposed", { operation: result.operation, recordId: result.recordId, sourceId: result.sourceId, relativePath: result.relativePath, fromStatus: result.fromStatus, toStatus: result.toStatus, gitCommitCreated: false });
        res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: error.message }));
      } finally {
        sourceLease?.release();
      }
      return;
    }

    if (url.pathname === "/workflow/start") {
      const body = await readJson(req);
      const chat = chatFor(body && body.sid);
      if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
      try {
        const run = chat.workflows.start(body?.workflowId, body?.input || {});
        appendRuntimeEvent(chat, "workflow.started", { workflowId: run.workflowId, revision: run.revision, state: run.state, currentStageId: run.currentStageId }, { runId: run.runId });
        res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: true, run }));
      } catch (error) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }

    if (url.pathname === "/workflow/transition") {
      const body = await readJson(req);
      const chat = chatFor(body && body.sid);
      if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
      try {
        const run = chat.workflows.transition(body?.runId, body?.operation, {
          result: body?.result,
          approved: body?.approved,
          actor: body?.actor,
          note: body?.note,
        });
        const eventType = run.state === "completed"
          ? "workflow.completed"
          : ["blocked", "failed"].includes(run.state)
            ? "workflow.blocked"
            : "workflow.updated";
        appendRuntimeEvent(chat, eventType, { workflowId: run.workflowId, revision: run.revision, state: run.state, currentStageId: run.currentStageId, evidenceStatus: run.evidenceStatus }, { runId: run.runId });
        res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: true, run }));
      } catch (error) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }

    if (url.pathname === "/discovery") {
      const body = await readJson(req);
      const chat = chatFor(body && body.sid);
      if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
      try {
        let report;
        if (body?.kind === "local-repositories") {
          report = await discoverLocalRepositories({ workspace: chat.cwd });
        } else if (body?.kind === "fabric-workspaces") {
          report = await discoverFabricWorkspaces();
        } else if (body?.kind === "fabric-items" || body?.kind === "semantic-models") {
          const workspaceName = typeof body.workspaceName === "string" && body.workspaceName.length <= 200 ? body.workspaceName : null;
          report = await discoverFabricItems({ workspaceId: body.workspaceId, workspaceName, itemTypes: Array.isArray(body.itemTypes) ? body.itemTypes : [], kind: body.kind });
        } else {
          res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "Unknown environment discovery kind." }));
          return;
        }
        res.writeHead(report.status === "failed" ? 502 : 200, baseHeaders("application/json")).end(JSON.stringify({ ok: !["failed", "unavailable"].includes(report.status), report }));
      } catch (error) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }

    if (url.pathname === "/config/proposal") {
      const body = await readJson(req);
      const chat = chatFor(body && body.sid);
      if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
      try {
        const proposal = await proposeProjectConfig({ workspace: chat.cwd, candidate: body?.candidate });
        if (proposal.state === "proposed") {
          chat.configProposals.set(proposal.proposalId, proposal);
          while (chat.configProposals.size > 20) chat.configProposals.delete(chat.configProposals.keys().next().value);
        }
        res.writeHead(proposal.state === "proposed" ? 200 : 400, baseHeaders("application/json")).end(JSON.stringify({ ok: proposal.state === "proposed", proposal }));
      } catch (error) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }

    if (url.pathname === "/config/apply") {
      const body = await readJson(req);
      const chat = chatFor(body && body.sid);
      const proposal = chat?.configProposals.get(body?.proposalId);
      if (!chat || !proposal) { res.writeHead(404, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That configuration proposal is unavailable." })); return; }
      if (chat.workspaceAccess?.mode === "read-only") { res.writeHead(409, baseHeaders("application/json")).end(JSON.stringify({ ok: false, code: "workspace-read-only", error: "Project configuration cannot be written from a read-only workspace attachment." })); return; }
      if (body?.approved !== true) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "Explicit approval is required before writing project configuration." })); return; }
      try {
        const result = applyProjectConfig(proposal);
        chat.configProposals.delete(proposal.proposalId);
        if (result.state === "stale") { res.writeHead(409, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "Project configuration changed after preview; create a new proposal.", result })); return; }
        appendRuntimeEvent(chat, "config.changed", { targetPath: result.targetPath, backupPath: result.backupPath, proposalId: result.proposalId });
        res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        res.writeHead(500, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: `Project configuration was not written: ${error.message}` }));
      }
      return;
    }

    if (url.pathname === "/profile/apply") {
      const body = await readJson(req);
      const chat = chatFor(body && body.sid);
      if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
      if (body?.approved !== true) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "Explicit approval is required before saving the user profile." })); return; }
      try {
        const report = await applyUserProfile(body?.profile, { approved: true });
        appendRuntimeEvent(chat, "config.changed", { scope: "user-profile" });
        res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: true, report }));
      } catch (error) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: error.message || "User profile validation failed." }));
      }
      return;
    }

    // Open a new chat (its own governed pi). Validate cwd like /chdir; enforce the cap.
    if (url.pathname === "/chat-new") {
      const body = await readJson(req);
      let cwd = DEFAULT_CWD;
      if (body && body.cwd !== undefined) {
        const resolved = typeof body.cwd === "string" ? resolvePath(String(body.cwd).trim()) : "";
        let ok = false;
        try { ok = Boolean(resolved) && statSync(resolved).isDirectory(); } catch { ok = false; }
        if (!ok) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That folder doesn't exist." })); return; }
        cwd = resolved;
      }
      if (chats.size >= MAX_CHATS) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: `You already have ${MAX_CHATS} chats open — close one first.` }));
        return;
      }
      const requestedMode = typeof body?.workspaceAccess === "string" ? body.workspaceAccess : "write";
      if (!["write", "worktree", "read-only", "override"].includes(requestedMode)) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "Workspace access mode is invalid." }));
        return;
      }
      let accessRequest = { mode: requestedMode, approved: body?.approved === true };
      if (["worktree", "override"].includes(requestedMode) && body?.approved !== true) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "Explicit approval is required for that workspace access mode." }));
        return;
      }
      if (requestedMode === "worktree") {
        const created = await createManagedWorktree({
          cwd,
          agentDir: AGENT_DIR,
          ownerId: `worktree-${chatSeq + 1}`,
          approved: true,
        });
        if (!created.ok) {
          res.writeHead(409, baseHeaders("application/json")).end(JSON.stringify({ ok: false, code: created.code, error: created.message }));
          return;
        }
        cwd = created.record.checkoutPath;
        accessRequest = { mode: "write", approved: false, managedWorktreeId: created.record.id };
      }
      try {
        const chat = await makeChat(cwd, [], accessRequest);
        broadcastChats();
        res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: true, sid: chat.sid, cwd: chat.cwd, workspaceAccess: chat.workspaceAccess, managedWorktreeId: chat.managedWorktreeId }));
      } catch (error) {
        const conflict = error.workspaceAccess;
        if (conflict?.code === "workspace-write-conflict") {
          res.writeHead(409, baseHeaders("application/json")).end(JSON.stringify({
            ok: false,
            code: conflict.code,
            error: conflict.message,
            choices: conflict.choices,
            owner: conflict.owner ? { ownerId: conflict.owner.ownerId, clientInterface: conflict.owner.clientInterface, createdAt: conflict.owner.createdAt } : null,
          }));
        } else {
          res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: error.message || "Workspace access could not be established." }));
        }
      }
      return;
    }

    if (url.pathname === "/worktree/remove") {
      const body = await readJson(req);
      if (body?.approved !== true) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "Explicit approval is required before removing a managed worktree." })); return; }
      if ([...chats.values()].some((chat) => chat.managedWorktreeId === body?.id)) {
        res.writeHead(409, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "Close the session using this worktree before cleanup." }));
        return;
      }
      try {
        const result = await removeManagedWorktree({ agentDir: AGENT_DIR, id: body?.id, approved: true });
        res.writeHead(result.ok ? 200 : 409, baseHeaders("application/json")).end(JSON.stringify({ ok: result.ok, result, ...(result.ok ? {} : { error: result.message }) }));
      } catch (error) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: error.message || "Managed worktree cleanup was rejected." }));
      }
      return;
    }

    // Close a chat (reap its pi, drop it from the registry). Closing the last chat is
    // allowed — the SPA auto-creates a fresh one.
    if (url.pathname === "/chat-close") {
      const body = await readJson(req);
      const chat = chatFor(body && body.sid);
      if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
      // Arm the generation check + status guard BEFORE killing (like restartChat), so
      // the killed child's async exit is a deliberate close — not a spurious __fatal.
      chat.status = "exited";
      const old = chat.child;
      chat.child = null;
      killPi(old);
      chat.workspaceLease?.release();
      for (const [id, w] of chat.pendingRpc) { clearTimeout(w.timer); w.resolve(null); chat.pendingRpc.delete(id); }
      closeRuntimeEventClients(chat);
      chats.delete(chat.sid);
      broadcastChats();
      res.writeHead(200, baseHeaders("application/json")).end(`{"ok":true}`);
      return;
    }

    if (url.pathname === "/prompt") {
      const body = await readJson(req);
      const chat = chatFor(body && body.sid);
      if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
      const adapted = buildPromptCommand(body, { busy: chat.busy });
      if (!adapted.ok) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: adapted.error }));
        return;
      }
      sendTo(chat, adapted.command);
      res.writeHead(200, baseHeaders("application/json")).end(`{"ok":true}`);
      return;
    }

    if (url.pathname === "/ui-response") {
      const body = await readJson(req);
      const chat = chatFor(body && body.sid);
      if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
      if (body && body.id) {
        const id = String(body.id);
        // Bound the dedupe set: an id that never matches a recorded dialog (a client bug
        // or a junk POST) is otherwise never evicted by record()'s history-eviction path,
        // so the Set grows unbounded for the life of the chat. When full, drop the oldest
        // inserted (Set preserves insertion order — same idiom as sessionMetaCache).
        if (chat.answeredUi.size >= ANSWERED_UI_MAX && !chat.answeredUi.has(id)) {
          chat.answeredUi.delete(chat.answeredUi.values().next().value);
        }
        chat.answeredUi.add(id); // don't replay this dialog card on reconnect
        // Whitelist the fields — never spread an untrusted body over a fixed
        // `type`, or the browser could relay arbitrary RPC commands to pi.
        const reply = { type: "extension_ui_response", id };
        if (body.value !== undefined) reply.value = body.value;
        if (body.confirmed !== undefined) reply.confirmed = Boolean(body.confirmed);
        if (body.cancelled !== undefined) reply.cancelled = Boolean(body.cancelled);
        sendTo(chat, reply);
      }
      res.writeHead(200, baseHeaders("application/json")).end(`{"ok":true}`);
      return;
    }

    if (url.pathname === "/rpc") {
      const body = await readJson(req);
      const chat = chatFor(body && body.sid);
      if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
      const type = body && body.type;
      if (!type || !RPC_ALLOWED.has(type)) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "command not allowed" }));
        return;
      }
      const adapted = buildRpcCommand(body, { resolveSessionPath: resolveStoredSessionPath });
      if (!adapted.ok) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: adapted.error }));
        return;
      }
      const cmd = adapted.command;
      const reply = type === "get_available_models"
        ? await listAvailableModels(command => rpcCall(chat, command, 15000))
        : await rpcCall(chat, cmd, RPC_TIMEOUTS[type] || 30000);
      if (!reply) {
        res.writeHead(504, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "pi did not answer in time" }));
        return;
      }
      const changedSession = type === "new_session" || type === "switch_session" || type === "fork" || type === "clone";
      if (changedSession && reply.success && !(reply.data && reply.data.cancelled)) {
        resetChatReplay(chat);
        // new_session is intentionally empty. The other mutations select a
        // populated session/branch, so rebuild from Pi's public get_messages RPC.
        if (type !== "new_session") await backfillMessages(chat);
      }
      res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify(reply));
      return;
    }

    // Desktop-only handoff preparation. The response is a fixed launch request
    // for the native shell; this runtime never accepts an executable or argument
    // from the renderer. `clone` returns the Desktop Pi to its original session.
    // `move` gracefully disposes Pi and its lease before returning the request.
    if (url.pathname === "/terminal-handoff") {
      if (!RUNTIME_MODE) {
        res.writeHead(404, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "Terminal handoff is available through Coop Runtime only." }));
        return;
      }
      const body = await readJson(req);
      const request = validateTerminalHandoffRequest(body);
      if (!request.ok) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify(request));
        return;
      }
      const chat = chatFor(body && body.sid);
      if (!chat || !chat.child || chat.status !== "running") {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." }));
        return;
      }
      const handoffId = `handoff-${++rpcSeq}-${randomBytes(4).toString("hex")}`;
      if (request.mode === "open") {
        const launch = buildTerminalLaunchRequest({ handoffId, mode: "open", cwd: chat.cwd });
        res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify(launch));
        return;
      }
      if (chat.busy) {
        res.writeHead(409, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "Stop the running agent before handing this session to a terminal." }));
        return;
      }
      const originalState = await rpcCall(chat, { type: "get_state" });
      const originalSession = resolveStoredSessionPath(originalState?.data?.sessionFile);
      if (!originalState?.success || !originalSession) {
        res.writeHead(409, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "This session must be saved in Coop's session store before it can be handed off." }));
        return;
      }

      if (request.mode === "clone") {
        const cloned = await rpcCall(chat, { type: "clone" });
        if (!cloned?.success || cloned.data?.cancelled) {
          res.writeHead(409, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: cloned?.error || "Pi could not clone this session." }));
          return;
        }
        const cloneState = await rpcCall(chat, { type: "get_state" });
        const clonedSession = resolveStoredSessionPath(cloneState?.data?.sessionFile);
        const restored = await rpcCall(chat, { type: "switch_session", sessionPath: originalSession });
        if (!clonedSession || !restored?.success || restored.data?.cancelled) {
          res.writeHead(409, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "The clone was created, but Desktop could not safely restore its original session." }));
          return;
        }
        resetChatReplay(chat);
        await backfillMessages(chat);
        const launch = buildTerminalLaunchRequest({ handoffId, mode: "clone", cwd: chat.cwd, sessionPath: clonedSession });
        res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify(launch));
        return;
      }

      const launch = buildTerminalLaunchRequest({ handoffId, mode: "move", cwd: chat.cwd, sessionPath: originalSession });
      const shutdown = buildRuntimeShutdownInvocation({ requestId: handoffId, secret: RUNTIME_CONTROL_SECRET });
      if (!launch.ok || !shutdown.ok) {
        res.writeHead(500, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "Could not prepare terminal handoff." }));
        return;
      }
      const child = chat.child;
      chat.status = "handing-off";
      chat.expectedExit = child;
      broadcastChats();
      const shutdownReply = await rpcCall(chat, shutdown.command, 10000);
      const exited = shutdownReply?.success ? await waitForChildExit(child, 10000) : false;
      if (!exited) {
        chat.expectedExit = null;
        chat.status = "exited";
        killPi(child);
        res.writeHead(504, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "Pi did not release the session cleanly; terminal launch was cancelled." }));
        return;
      }
      chat.child = null;
      chat.workspaceLease?.release();
      closeRuntimeEventClients(chat);
      chats.delete(chat.sid);
      broadcastChats();
      res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify(launch));
      return;
    }

    // Pi 0.84.3 has no direct RPC command for selecting an existing tree entry,
    // but its public extension command context exposes navigateTree(). Invoke the
    // authenticated Coop adapter, wait for its correlated structured result, then
    // rebuild replay from Pi's public get_messages command. Session JSONL remains
    // exclusively owned by Pi.
    if (url.pathname === "/tree-navigate") {
      const body = await readJson(req);
      const chat = chatFor(body && body.sid);
      if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
      const requestId = `tree-${++rpcSeq}-${randomBytes(4).toString("hex")}`;
      const invocation = buildTreeNavigationInvocation(body, { requestId, secret: TREE_NAVIGATION_SECRET });
      if (!invocation.ok) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: invocation.error }));
        return;
      }
      const timeout = body.summarize === true ? 180000 : 30000;
      const promptReply = await rpcCall(chat, invocation.command, timeout);
      const result = chat.treeNavigationResults.get(requestId);
      chat.treeNavigationResults.delete(requestId);
      if (!promptReply) {
        res.writeHead(504, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "pi did not answer in time" }));
        return;
      }
      if (!result) {
        res.writeHead(409, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "The installed Coop/Pi runtime does not provide existing-branch navigation." }));
        return;
      }
      if (result.error) {
        res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ type: "response", command: "navigate_tree", success: false, error: result.error }));
        return;
      }
      if (!result.cancelled) {
        resetChatReplay(chat);
        await backfillMessages(chat);
      }
      res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ type: "response", command: "navigate_tree", success: true, data: result }));
      return;
    }

    if (url.pathname === "/resume") {
      const body = await readJson(req);
      const chat = chatFor(body && body.sid);
      if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
      const name = body && typeof body.file === "string" ? body.file : "";
      // Cross-workspace resume: `workspace` (whitelisted) selects a DIFFERENT folder to
      // switch to + resume in. The server re-DERIVES its session dir via sessionsDirFor
      // (the encoding is deterministic forward) — never accept a client-supplied dir.
      let targetCwd = chat.cwd;
      if (body && body.workspace !== undefined) {
        if (typeof body.workspace !== "string") {
          res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That conversation could not be found." }));
          return;
        }
        const resolved = resolvePath(String(body.workspace).trim());
        let ok = false;
        try { ok = Boolean(resolved) && statSync(resolved).isDirectory(); } catch { ok = false; }
        if (!ok) {
          res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That conversation could not be found." }));
          return;
        }
        targetCwd = resolved;
      }
      const dir = sessionsDirFor(targetCwd);
      // Path jail: a plain .jsonl basename inside THAT folder's session dir only.
      const safeName = /^[A-Za-z0-9._-]+\.jsonl$/.test(name);
      const full = dir && safeName ? join(dir, name) : "";
      if (!full || !existsSync(full)) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That conversation could not be found." }));
        return;
      }
      // samePath (not a naive !==): on Windows a case-different or trailing-separator
      // equivalent of the chat's own folder must NOT count as a switch (spurious
      // broadcastChats + a misleading "resuming … in <dir>" log).
      const switched = !samePath(targetCwd, chat.cwd);
      try {
        await restartChat(chat, targetCwd, ["--session", full]); // switches the working folder AND resumes
      } catch (error) {
        const conflict = error.workspaceAccess;
        res.writeHead(conflict?.code === "workspace-write-conflict" ? 409 : 400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, code: conflict?.code, error: error.message, choices: conflict?.choices }));
        return;
      }
      console.error(`  resuming session ${name}${switched ? ` in ${targetCwd}` : ""}`);
      if (switched) broadcastChats(); // the tab's cwd (label) changed
      // Rebuild the transcript FROM THE FILE (synchronous, high fidelity); fall back to
      // the get_messages backfill only for oversized/corrupt files.
      if (!backfillFromFile(chat, full)) await backfillMessages(chat);
      res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/chdir") {
      const body = await readJson(req);
      const chat = chatFor(body && body.sid);
      if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
      const target = body && typeof body.dir === "string" ? resolvePath(String(body.dir).trim()) : "";
      let ok = false;
      try {
        ok = Boolean(target) && statSync(target).isDirectory();
      } catch {
        ok = false;
      }
      if (!ok) {
        res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That folder doesn't exist. Paste a full path (e.g. C:\\Users\\you\\repo)." }));
        return;
      }
      try {
        await restartChat(chat, target);
      } catch (error) {
        const conflict = error.workspaceAccess;
        res.writeHead(conflict?.code === "workspace-write-conflict" ? 409 : 400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, code: conflict?.code, error: error.message, choices: conflict?.choices }));
        return;
      }
      broadcastChats(); // the tab's cwd (label) changed
      console.error(`  working folder changed -> ${target}`);
      res.writeHead(200, baseHeaders("application/json")).end(JSON.stringify({ ok: true, cwd: target }));
      return;
    }

    if (url.pathname === "/abort") {
      const body = await readJson(req);
      const chat = chatFor(body && body.sid);
      if (!chat) { res.writeHead(400, baseHeaders("application/json")).end(JSON.stringify({ ok: false, error: "That chat is no longer open." })); return; }
      sendTo(chat, { type: "abort" });
      res.writeHead(200, baseHeaders("application/json")).end(`{"ok":true}`);
      return;
    }
  }

  res.writeHead(404, baseHeaders("text/plain")).end("not found");
}

// --- Open the UI as a native-feeling "app" window -----------------------------
// The lowest-cost path to "it's an app, not a browser tab": launch a Chromium-
// family browser (Edge/Chrome/Brave/…) in --app mode with a DEDICATED profile.
// That single choice buys the whole native finish — a chromeless window, its own
// taskbar/dock entry, the coop icon (from the served favicon), and isolation from
// the user's real browsing session/extensions — with no Electron, no bundle, no
// build step, and no dependency: it's purely how the browser is invoked. If no
// Chromium browser is found (or COOP_WEB_NO_APP is set) we fall back to the OS
// default handler, i.e. a normal tab. Set COOP_WEB_NO_OPEN=1 to open nothing.

// A persistent, coop-owned profile dir. Distinct from the user's real profile, so
// the window is its own app (own taskbar identity + icon) and never touches their
// session; persisted so the window's size/position stick between launches.
function webAppProfileDir() {
  const agentDir = (spec.env && spec.env.PI_CODING_AGENT_DIR) || process.env.PI_CODING_AGENT_DIR || "";
  const base = agentDir ? dirname(resolvePath(agentDir)) : join(tmpdir(), "coop");
  return join(base, "web-app-profile");
}

// First existing browser from a candidate list. Windows/macOS entries are absolute
// install paths (existence-checked); Linux entries are bare names resolved against
// PATH. Spawning the resolved executable directly (never via cmd.exe) sidesteps
// the Windows quoting hazards called out in spawnPi.
function firstBrowser(candidates) {
  const pathSep = process.platform === "win32" ? ";" : ":";
  for (const c of candidates) {
    if (!c) continue;
    if (c.includes("/") || c.includes("\\")) {
      if (existsSync(c)) return c;
    } else {
      for (const dir of (process.env.PATH || "").split(pathSep)) {
        if (dir && existsSync(join(dir, c))) return join(dir, c);
      }
    }
  }
  return null;
}

function browserCandidates() {
  const p = process.platform;
  if (p === "win32") {
    const pf = process.env["ProgramFiles"] || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"] || "";
    return [
      join(pf, "Microsoft\\Edge\\Application\\msedge.exe"),
      join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"),
      join(pf, "Google\\Chrome\\Application\\chrome.exe"),
      join(pf86, "Google\\Chrome\\Application\\chrome.exe"),
      local ? join(local, "Google\\Chrome\\Application\\chrome.exe") : null,
      // Brave and Vivaldi default to PER-USER installs (%LOCALAPPDATA%), so check
      // there as well as Program Files — else these browsers silently fall back to
      // a plain tab. Chromium too, so the win32 list matches the README's chain.
      join(pf, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
      local ? join(local, "BraveSoftware\\Brave-Browser\\Application\\brave.exe") : null,
      local ? join(local, "Vivaldi\\Application\\vivaldi.exe") : null,
      join(pf, "Vivaldi\\Application\\vivaldi.exe"),
      local ? join(local, "Chromium\\Application\\chrome.exe") : null,
    ];
  }
  if (p === "darwin") {
    return [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  return [
    "microsoft-edge", "microsoft-edge-stable", "google-chrome", "google-chrome-stable",
    "brave-browser", "chromium", "chromium-browser", "vivaldi-stable",
  ];
}

// Last resort: hand the URL to the OS default handler (a normal browser tab).
function openDefault(u) {
  const p = process.platform;
  try {
    if (p === "win32") spawn("cmd", ["/c", "start", "", u], { detached: true, stdio: "ignore" }).unref();
    else if (p === "darwin") spawn("open", [u], { detached: true, stdio: "ignore" }).unref();
    else spawn("xdg-open", [u], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* the URL is printed to the console regardless */
  }
}

function openBrowser(u) {
  if (/^(1|true|yes)$/i.test(process.env.COOP_WEB_NO_APP || "")) {
    openDefault(u);
    return;
  }
  try {
    const exe = firstBrowser(browserCandidates());
    if (!exe) {
      openDefault(u);
      return;
    }
    // The browser CREATES --user-data-dir (and parents) if absent, so no mkdir.
    const args = [
      `--app=${u}`,
      `--user-data-dir=${webAppProfileDir()}`,
      "--window-size=1200,840",
      "--no-first-run",
      "--no-default-browser-check",
    ];
    const child = spawn(exe, args, { detached: true, stdio: "ignore" });
    child.on("error", () => openDefault(u)); // resolved path failed to launch
    child.unref();
  } catch {
    openDefault(u);
  }
}

// A busy default port (e.g. the desktop icon double-clicked twice) walks to the
// next free one instead of dying in a minimized console nobody sees. An explicit
// --port / COOP_WEB_PORT is respected strictly.
let portTries = 0;
server.on("error", (e) => {
  if (e.code === "EADDRINUSE" && !PORT_EXPLICIT && portTries < 10) {
    portTries++;
    PORT++;
    console.error(`${RUNTIME_MODE ? "coop runtime" : "coop web"}: port ${PORT - 1} is in use — trying ${PORT}…`);
    setTimeout(() => server.listen(PORT, HOST), 100);
    return;
  }
  for (const c of chats.values()) killPi(c.child);
  if (e.code === "EADDRINUSE") {
    startupError(`port ${PORT} is already in use. Try: coop ${RUNTIME_MODE ? "runtime" : "web"} --port ${PORT + 1}`);
  }
  startupError(`server error: ${e.message}`);
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const activePort = typeof address === "object" && address ? address.port : PORT;
  const endpoint = `http://${HOST}:${activePort}`;
  const u = `${endpoint}/?token=${TOKEN}`;
  if (RUNTIME_MODE) {
    if (RUNTIME_JSON) {
      process.stdout.write(`${JSON.stringify({
        type: "runtime.ready",
        contractVersion: 1,
        transport: "http",
        endpoint,
        oneTimeToken: TOKEN,
        runtimePid: process.pid,
        coopVersion: runtimeCapabilities.versions.coop,
        piVersion: runtimeCapabilities.versions.pi,
      })}\n`);
    } else {
      console.error(`\n  coop runtime is ready at ${endpoint}\n  Press Ctrl+C to stop.\n`);
    }
    return;
  }
  console.error(`\n  coop web is running.\n  Opening: ${u}\n  (If it doesn't open, paste that URL into your browser.)\n  Press Ctrl+C to stop.\n`);
  if (!/^(1|true|yes)$/i.test(process.env.COOP_WEB_NO_OPEN || "")) openBrowser(u);
});

function shutdown() {
  for (const c of chats.values()) {
    killPi(c.child); // reap every chat's subtree — never orphan a bash-capable agent
    c.workspaceLease?.release();
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// A stray throw or rejected promise must not leave the governed (file-editing, bash-
// capable) agent running unsupervised with browsers stuck reconnecting. Route both
// through shutdown(), which reaps the child. Node v15+ would otherwise terminate on an
// unhandled rejection WITHOUT running our cleanup.
process.on("uncaughtException", (e) => { console.error(`${RUNTIME_MODE ? "coop runtime" : "coop web"}: uncaught exception:`, e); shutdown(); });
process.on("unhandledRejection", (e) => { console.error(`${RUNTIME_MODE ? "coop runtime" : "coop web"}: unhandled rejection:`, e); shutdown(); });

// Shell-neutral runtime capability negotiation for coop web and Coop Desktop.
// Pure builders live here so platform behavior is testable without launching Pi.

import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { EXECUTION_ENVELOPE_SCHEMA_VERSION } from "./execution-envelope.mjs";
import { AUTH_PROVIDERS_SCHEMA_VERSION } from "./auth-service.mjs";
import { DOCTOR_REPORT_SCHEMA_VERSION } from "./doctor-service.mjs";
import { PROJECT_CONFIG_PROPOSAL_SCHEMA_VERSION } from "./project-config-service.mjs";
import { ENVIRONMENT_DISCOVERY_SCHEMA_VERSION } from "./environment-discovery.mjs";
import { PROJECT_SETUP_STATE_SCHEMA_VERSION } from "./project-setup-service.mjs";
import { USER_PROFILE_SERVICE_VERSION } from "./profile-service.mjs";
import { RUNTIME_EVENT_CONTRACT_VERSION } from "./runtime-events.mjs";
import { IMAGE_INPUT_LIMITS } from "./rpc-adapter.mjs";
import { SERVICE_EXTENSION_CONTRACT_VERSION, listServiceExtensions } from "./service-extensions.mjs";
import { IMPACT_ANALYSIS_SCHEMA_VERSION } from "./impact-analysis.mjs";
import {
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  WORKFLOW_RUN_SCHEMA_VERSION,
  listWorkflowExtensions,
} from "./workflow-service.mjs";
import { MANAGED_WORKTREE_SCHEMA_VERSION, WORKSPACE_LEASE_SCHEMA_VERSION } from "../lib/workspace-isolation.mjs";
import { KNOWLEDGE_RECORD_SCHEMA_VERSION } from "../lib/knowledge-policy.mjs";
import { KNOWLEDGE_INDEX_SCHEMA_VERSION } from "../lib/knowledge-index.mjs";
import { KNOWLEDGE_SERVICE_VERSION } from "../lib/knowledge-service.mjs";

export const RUNTIME_CAPABILITIES_CONTRACT_VERSION = 1;

const COMMANDS = {
  "azure-cli": ["az"],
  "coop-data-doc": ["coop-data-doc"],
  "coop-dax-review": ["coop-dax-review"],
  "coop-sql-review": ["coop-sql-review"],
  fabric: ["fab"],
  git: ["git"],
  "powerbi-desktop": ["powerbi-desktop"],
  "tabular-editor": ["te"],
};

export function normalizePlatform(platform) {
  if (platform === "win32" || platform === "windows") return "windows";
  if (platform === "darwin" || platform === "macos") return "macos";
  return "linux";
}

export function commandAvailable(command, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const windows = normalizePlatform(platform) === "windows";
  const pathApi = windows ? win32 : posix;
  const pathValue = env.PATH || env.Path || "";
  const delimiter = windows ? ";" : ":";
  const extensions = windows
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const hasExtension = windows && Boolean(pathApi.extname(command));
  const candidates = hasExtension ? [command] : extensions.map((extension) => command + extension);

  if (command.includes("/") || command.includes("\\")) {
    return candidates.some((candidate) => exists(candidate));
  }
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    if (candidates.some((candidate) => exists(pathApi.join(directory, candidate)))) return true;
  }
  return false;
}

function state(availability, { installed = null, authenticated = null, reason = null } = {}) {
  return { state: availability, installed, authenticated, reason };
}

export function detectIntegrationStates({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  piRunning = false,
} = {}) {
  const result = {
    pi: piRunning
      ? state("available", { installed: true })
      : state("unknown", { reason: "Pi process state has not been established." }),
    "native-terminal": state("available", { installed: true }),
    "pi-hermes-memory": state("unknown", { reason: "Extension health has not been queried yet." }),
    powerbi: state("unknown", { reason: "Power BI service authentication has not been queried yet." }),
  };

  for (const [integration, commands] of Object.entries(COMMANDS)) {
    const installed = commands.some((command) => commandAvailable(command, { platform, env, exists }));
    result[integration] = installed
      ? state("available", { installed: true })
      : state("unavailable", { installed: false, reason: `${commands.join(" or ")} was not found on PATH.` });
  }
  return result;
}

function resolveCapability(capability, parityEntry, platform, integrations) {
  const platformSupported = capability.availability.platforms.includes(platform);
  const unavailableIntegrations = capability.integrations.filter(
    (integration) => integrations[integration]?.state === "unavailable",
  );
  const unknownIntegrations = capability.integrations.filter(
    (integration) => !integrations[integration] || integrations[integration].state === "unknown",
  );
  let runtimeState = "available";
  const reasonCodes = [];
  if (!platformSupported) {
    runtimeState = "unavailable";
    reasonCodes.push("platform-unsupported");
  }
  if (unavailableIntegrations.length > 0) {
    runtimeState = "unavailable";
    reasonCodes.push("integration-unavailable");
  } else if (runtimeState === "available" && unknownIntegrations.length > 0) {
    runtimeState = "unknown";
    reasonCodes.push("integration-health-unknown");
  }

  return {
    ...capability,
    runtime: {
      state: runtimeState,
      available: runtimeState === "available",
      platformSupported,
      unavailableIntegrations,
      unknownIntegrations,
      reasonCodes,
    },
    clients: parityEntry
      ? {
          terminal: parityEntry.terminalState,
          web: parityEntry.webState,
          desktop: parityEntry.desktopState,
          fallback: parityEntry.fallback,
          releaseGate: parityEntry.releaseGate,
        }
      : null,
  };
}

export function buildRuntimeCapabilities({
  manifest,
  registry,
  parity,
  piProtocolVersion,
  bridgeCommands,
  protocolCommands,
  workflowRegistry,
  platform = process.platform,
  integrations = {},
}) {
  const os = normalizePlatform(platform);
  const parityById = new Map(parity.entries.map((entry) => [entry.capabilityId, entry]));
  const capabilities = registry.capabilities.map((capability) =>
    resolveCapability(capability, parityById.get(capability.id), os, integrations),
  );
  const powerBiDesktop = integrations["powerbi-desktop"];
  const nativeTerminal = integrations["native-terminal"];

  return {
    contractVersion: RUNTIME_CAPABILITIES_CONTRACT_VERSION,
    contracts: {
      executionEnvelope: EXECUTION_ENVELOPE_SCHEMA_VERSION,
      authProviders: AUTH_PROVIDERS_SCHEMA_VERSION,
      doctorReport: DOCTOR_REPORT_SCHEMA_VERSION,
      projectConfigProposal: PROJECT_CONFIG_PROPOSAL_SCHEMA_VERSION,
      environmentDiscovery: ENVIRONMENT_DISCOVERY_SCHEMA_VERSION,
      projectSetupState: PROJECT_SETUP_STATE_SCHEMA_VERSION,
      userProfile: USER_PROFILE_SERVICE_VERSION,
      runtimeEvent: RUNTIME_EVENT_CONTRACT_VERSION,
      serviceExtension: SERVICE_EXTENSION_CONTRACT_VERSION,
      workflowDefinition: WORKFLOW_DEFINITION_SCHEMA_VERSION,
      workflowRun: WORKFLOW_RUN_SCHEMA_VERSION,
      impactAnalysis: IMPACT_ANALYSIS_SCHEMA_VERSION,
      workspaceAccess: WORKSPACE_LEASE_SCHEMA_VERSION,
      managedWorktree: MANAGED_WORKTREE_SCHEMA_VERSION,
      knowledgeRecord: KNOWLEDGE_RECORD_SCHEMA_VERSION,
      knowledgeIndex: KNOWLEDGE_INDEX_SCHEMA_VERSION,
      knowledgeService: KNOWLEDGE_SERVICE_VERSION,
    },
    versions: {
      coop: manifest.coop_version,
      pi: manifest.pi.version,
      piProtocol: piProtocolVersion,
      dataDoc: manifest.python_tools["coop-data-doc"],
      sqlReview: manifest.python_tools["coop-sql-review"],
      daxReview: manifest.python_tools["coop-dax-review"],
      capabilityRegistry: registry.schemaVersion,
      desktopParity: parity.schemaVersion,
    },
    rpc: {
      commands: [...bridgeCommands].sort(),
      protocolCommands: [...protocolCommands].sort(),
      existingBranchCheckout: true,
      existingBranchCheckoutProvider: "coop-extension",
    },
    limits: {
      promptImages: IMAGE_INPUT_LIMITS,
    },
    extensions: {
      service: listServiceExtensions(),
      workflow: listWorkflowExtensions(workflowRegistry),
    },
    platform: {
      os,
      powerBiDesktopBridge:
        os === "windows" && powerBiDesktop?.state === "available",
      nativeTerminal: nativeTerminal?.state === "available",
    },
    integrations,
    capabilities,
  };
}

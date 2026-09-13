// Declarative Coop Core service-extension registry. Presentation code receives
// capability IDs and structured envelopes; it never imports or reimplements a
// companion tool. Pi remains the governed invocation owner for these adapters.

export const SERVICE_EXTENSION_CONTRACT_VERSION = 1;

const EXTENSIONS = Object.freeze([
  {
    id: "coop-sql-review",
    version: 1,
    capabilityId: "coop.review.sql",
    invocation: { kind: "pi-tool", name: "sql_review" },
    output: { kind: "execution-envelope", reportField: "details.report" },
    permissions: ["workspace.read"],
    healthCheckIds: ["tool.coop-sql-review"],
  },
  {
    id: "coop-dax-review",
    version: 1,
    capabilityId: "coop.review.dax",
    invocation: { kind: "pi-tool", name: "dax_review" },
    output: { kind: "execution-envelope", reportField: "details.report" },
    permissions: ["workspace.read"],
    healthCheckIds: ["tool.coop-dax-review"],
  },
  {
    id: "coop-bpa-review",
    version: 1,
    capabilityId: "coop.review.bpa",
    invocation: { kind: "pi-tool", name: "bpa_review" },
    output: { kind: "execution-envelope", reportField: "details.report" },
    permissions: ["workspace.read"],
    healthCheckIds: ["tool.tabular-editor"],
  },
  {
    id: "coop-data-doc",
    version: 1,
    capabilityId: "coop.lineage.explorer",
    invocation: { kind: "pi-tool", name: "data_doc" },
    output: { kind: "execution-envelope", reportField: "details.lineage" },
    permissions: ["workspace.read"],
    healthCheckIds: ["tool.coop-data-doc", "project.data-doc"],
  },
  {
    id: "coop-impact-analysis-result",
    version: 1,
    capabilityId: "coop.impact.guided",
    invocation: { kind: "pi-tool", name: "impact_analysis_result" },
    output: { kind: "execution-envelope", reportField: "details.report" },
    permissions: ["workspace.read", "integration.read", "session.write"],
    healthCheckIds: ["tool.coop-data-doc", "integration.fabric", "integration.powerbi"],
  },
].map((item) => Object.freeze({
  ...item,
  invocation: Object.freeze({ ...item.invocation }),
  output: Object.freeze({ ...item.output }),
  permissions: Object.freeze([...item.permissions]),
  healthCheckIds: Object.freeze([...item.healthCheckIds]),
})));

const BY_TOOL = new Map(EXTENSIONS.map((extension) => [extension.invocation.name, extension]));
const BY_CAPABILITY = new Map(EXTENSIONS.map((extension) => [extension.capabilityId, extension]));

export function listServiceExtensions() {
  return EXTENSIONS;
}

export function serviceExtensionForTool(toolName) {
  return BY_TOOL.get(toolName) || null;
}

export function serviceExtensionForCapability(capabilityId) {
  return BY_CAPABILITY.get(capabilityId) || null;
}

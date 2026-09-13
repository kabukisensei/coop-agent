import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_SETUP_STATE_SCHEMA_VERSION = 1;
const ROOT = resolve(process.env.COOP_ROOT || join(dirname(fileURLToPath(import.meta.url)), ".."));

const OPERATIONS = {
  "project.configure": ["project-contract", "Set up project", "coop init", "Project setup"],
  "project.repair": ["project-contract", "Repair project contract", "coop init", "Project setup"],
  "repositories.configure": ["repositories", "Connect local repositories", "coop init", "Repositories"],
  "microsoft.configure": ["microsoft", "Connect Microsoft client identity", "coop onboard", "Connections"],
  "fabric-workspace.discover": ["fabric-workspace", "Choose Fabric workspace", "coop discover workspaces", "Fabric workspace"],
  "power-bi-workspace.discover": ["power-bi-workspace", "Choose Power BI workspace", "coop discover workspaces", "Power BI workspace"],
  "data-doc.configure": ["data-doc", "Configure lineage", "coop data-doc setup", "Lineage setup"],
  "tabular-editor.configure": ["tabular-editor", "Configure Tabular Editor", "coop init", "BPA setup"],
};

const REQUIREMENTS = {
  "coop.lineage.explorer": ["data-doc"],
  "coop.impact.guided": ["data-doc", "microsoft", "power-bi-workspace"],
  "coop.review.bpa": ["tabular-editor"],
};

function action(operationId) {
  const spec = OPERATIONS[operationId];
  if (!spec) return null;
  return { operationId, sectionId: spec[0], label: spec[1], requiresApproval: true, entrypoints: { cli: spec[2], desktop: spec[3] } };
}

async function inspectRaw(workspace) {
  const python = process.env.COOP_PYTHON || (process.platform === "win32" ? "python" : "python3");
  return await new Promise((resolveResult, reject) => {
    const child = spawn(python, [join(ROOT, "lib", "project_setup_state.py"), workspace], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) { reject(new Error(stderr.trim() || "Project setup inspection failed.")); return; }
      try { resolveResult(JSON.parse(stdout)); } catch { reject(new Error("Project setup inspection returned invalid JSON.")); }
    });
  });
}

export async function getProjectSetupState({ workspace, capabilityId = null, inspect = inspectRaw }) {
  const root = resolve(workspace);
  const raw = await inspect(root);
  const sections = Array.isArray(raw.sections) ? raw.sections : [];
  const byId = new Map(sections.map((section) => [section.id, section]));
  const nextActions = [];
  for (const section of sections) {
    if (section.state !== "configured" && section.setupOperationId) {
      const item = action(section.setupOperationId);
      if (item) nextActions.push(item);
    }
  }
  const requiredSections = capabilityId ? [...(REQUIREMENTS[capabilityId] || [])] : [];
  if (raw.contractState !== "configured" && !requiredSections.includes("project-contract")) requiredSections.unshift("project-contract");
  const missingSections = requiredSections.filter((id) => byId.get(id)?.state !== "configured");
  const capability = capabilityId ? {
    id: capabilityId,
    available: missingSections.length === 0,
    missingSections,
    nextAction: missingSections.length ? nextActions.find((item) => item.sectionId === missingSections[0]) || null : null,
  } : null;
  const broken = sections.some((section) => section.state === "broken");
  const selectedGap = sections.some((section) => section.selected && section.state === "not-configured");
  return {
    schemaVersion: PROJECT_SETUP_STATE_SCHEMA_VERSION,
    workspace: raw.workspace || root,
    contractPath: raw.contractPath || join(root, ".coop", "project.yml"),
    state: broken ? "broken" : selectedGap ? "progressive" : "ready",
    sections,
    nextActions,
    capability,
  };
}

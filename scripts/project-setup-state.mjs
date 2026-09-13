#!/usr/bin/env node
import { getProjectSetupState } from "../web/project-setup-service.mjs";

const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
try {
  const report = await getProjectSetupState({ workspace: value("--workspace") || process.cwd(), capabilityId: value("--for-capability") });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch {
  process.stderr.write("Project setup state could not be inspected. Run coop doctor and retry.\n");
  process.exitCode = 1;
}

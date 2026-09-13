#!/usr/bin/env node
const { createHash } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function sha256(value) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

const builderPath = resolve("desktop/electron-builder-installer.cjs");
const output = process.env.EFFECTIVE_CONFIG_OUT ? resolve(process.env.EFFECTIVE_CONFIG_OUT) : null;
if (!output) throw new Error("EFFECTIVE_CONFIG_OUT is required.");
const sourceRequire = createRequire(builderPath);
const electronBuilder = sourceRequire("electron-builder");
const originalBuild = electronBuilder.build;
if (typeof originalBuild !== "function") throw new Error("electron-builder build export is unavailable.");
let intercepted = false;
electronBuilder.build = (options) => {
  if (intercepted) throw new Error("Expected exactly one electron-builder build invocation.");
  if (!options?.config?.nsis || Object.hasOwn(options.config.nsis, "useZip")) throw new Error("Expected candidate NSIS config without useZip.");
  const beforeConfig = structuredClone(options.config);
  const afterConfig = structuredClone(options.config);
  afterConfig.nsis.useZip = true;
  const afterWithoutTreatment = structuredClone(afterConfig);
  delete afterWithoutTreatment.nsis.useZip;
  if (canonicalJson(beforeConfig) !== canonicalJson(afterWithoutTreatment)) throw new Error("Treatment changed more than nsis.useZip.");
  writeFileSync(output, `${JSON.stringify({
    schemaVersion: 1,
    diagnosticOnly: true,
    treatment: "nsis.useZip=true",
    beforeSha256: sha256(beforeConfig),
    afterSha256: sha256(afterConfig),
    beforeNsis: beforeConfig.nsis,
    afterNsis: afterConfig.nsis,
    onlyDifferenceConfirmed: true,
  }, null, 2)}\n`);
  intercepted = true;
  return originalBuild({ ...options, config: afterConfig });
};
sourceRequire(builderPath);
if (!intercepted) throw new Error("Candidate installer builder did not invoke electron-builder synchronously.");

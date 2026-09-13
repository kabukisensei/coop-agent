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

async function main() {
  const projectDir = resolve("desktop");
  const configPath = resolve(projectDir, "electron-builder-installer.cjs");
  const output = process.env.EFFECTIVE_CONFIG_OUT ? resolve(process.env.EFFECTIVE_CONFIG_OUT) : null;
  if (!output) throw new Error("EFFECTIVE_CONFIG_OUT is required.");
  const sourceRequire = createRequire(configPath);
  const electronBuilder = sourceRequire("electron-builder");
  const beforeConfig = structuredClone(sourceRequire(configPath));
  if (!beforeConfig.nsis || Object.hasOwn(beforeConfig.nsis, "useZip")) throw new Error("Expected candidate NSIS config without useZip.");
  const afterConfig = structuredClone(beforeConfig);
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
    beforeConfig,
    afterConfig,
    beforeNsis: beforeConfig.nsis,
    afterNsis: afterConfig.nsis,
    onlyDifferenceConfirmed: true,
  }, null, 2)}\n`);
  await electronBuilder.build({
    projectDir,
    targets: electronBuilder.Platform.WINDOWS.createTarget(["nsis"], electronBuilder.Arch.x64),
    config: afterConfig,
    publish: "never",
  });
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

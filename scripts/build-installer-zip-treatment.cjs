#!/usr/bin/env node
const { createHash } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");

function hashText(value) { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function describe(value) {
  if (typeof value === "function") return { functionSha256: hashText(Function.prototype.toString.call(value)) };
  if (Array.isArray(value)) return value.map(describe);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, describe(value[key])]));
  return value;
}
function valueSha256(value) { return hashText(canonicalJson(value)); }

async function main() {
  const projectDir = resolve("desktop");
  const configPath = resolve(projectDir, "electron-builder-installer.cjs");
  const output = process.env.EFFECTIVE_CONFIG_OUT ? resolve(process.env.EFFECTIVE_CONFIG_OUT) : null;
  if (!output) throw new Error("EFFECTIVE_CONFIG_OUT is required.");
  const sourceRequire = createRequire(configPath);
  const electronBuilder = sourceRequire("electron-builder");
  const beforeConfig = sourceRequire(configPath);
  if (!beforeConfig.nsis || Object.hasOwn(beforeConfig.nsis, "useZip")) throw new Error("Expected candidate NSIS config without useZip.");
  const afterConfig = { ...beforeConfig, nsis: { ...beforeConfig.nsis, useZip: true } };
  const beforeKeys = Reflect.ownKeys(beforeConfig);
  const afterKeys = Reflect.ownKeys(afterConfig);
  if (canonicalJson(beforeKeys) !== canonicalJson(afterKeys)) throw new Error("Treatment changed top-level config keys.");
  for (const key of beforeKeys) if (key !== "nsis" && beforeConfig[key] !== afterConfig[key]) throw new Error(`Treatment changed non-NSIS config property: ${String(key)}`);
  const afterNsis = { ...afterConfig.nsis };
  delete afterNsis.useZip;
  if (canonicalJson(beforeConfig.nsis) !== canonicalJson(afterNsis)) throw new Error("Treatment changed more than nsis.useZip.");
  const beforeDescriptor = describe(beforeConfig);
  const afterDescriptor = describe(afterConfig);
  writeFileSync(output, `${JSON.stringify({
    schemaVersion: 1,
    diagnosticOnly: true,
    treatment: "nsis.useZip=true",
    beforeSha256: valueSha256(beforeDescriptor),
    afterSha256: valueSha256(afterDescriptor),
    beforeConfigDescriptor: beforeDescriptor,
    afterConfigDescriptor: afterDescriptor,
    beforeNsis: beforeConfig.nsis,
    afterNsis: afterConfig.nsis,
    nonNsisPropertiesIdenticalByReference: true,
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

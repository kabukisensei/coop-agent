#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function fail(message) { throw new Error(message); }
function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || !argv[i + 1]) fail(`Unknown or incomplete argument: ${argv[i] || "<missing>"}`);
    out[argv[i].slice(2)] = resolve(argv[i + 1]);
  }
  for (const key of ["control-identity", "control-probe", "treatment-identity", "treatment-probe", "output"]) if (!out[key]) fail(`--${key} is required.`);
  return out;
}
function load(path) { return JSON.parse(readFileSync(path, "utf8")); }
function classify(report) {
  if (report.decision === "FIRST_INSTALL_COMPLETE" && report.ok === true) return "FIRST_INSTALL_COMPLETE";
  const material = report.samples.some(sample => ["executable", "appAsar", "managedRuntime"].some(name => sample.files?.[name]?.exists));
  const registry = report.samples.some(sample => (sample.registry?.count || 0) > 0);
  if (report.process?.exceededBound === true && !material && !registry) return "INSTALLER_STARTUP_HANG";
  return report.decision || "INSTALLER_INCONCLUSIVE";
}
const options = args(process.argv.slice(2));
const ci = load(options["control-identity"]);
const cp = load(options["control-probe"]);
const ti = load(options["treatment-identity"]);
const tp = load(options["treatment-probe"]);
for (const [label, identity, probe, builder] of [["control", ci, cp, "26.15.3"], ["treatment", ti, tp, "26.15.6"]]) {
  if (identity.abLabel !== label || identity.electronBuilderVersion !== builder) fail(`${label} builder identity mismatch.`);
  if (identity.electronVersion !== "44.2.0") fail(`${label} Electron version mismatch.`);
  if (identity.productCandidateSha !== probe.candidate || identity.checksums.installerSha256 !== probe.installerSha256) fail(`${label} probe/installer provenance mismatch.`);
  if (probe.boundMs !== 180000 || probe.cleanup?.confirmed !== true) fail(`${label} bound or cleanup evidence invalid.`);
}
for (const key of ["productCandidateSha", "productCandidateTree", "electronVersion"]) if (ci[key] !== ti[key]) fail(`A/B shared identity mismatch: ${key}.`);
for (const key of ["managedConfigSha256", "installerConfigSha256"]) if (ci.nsisConfig[key] !== ti.nsisConfig[key]) fail(`A/B NSIS config mismatch: ${key}.`);
for (const key of ["releaseManifestSha256", "developmentCompanionsSha256", "managedRuntimeManifestSha256", "managedRuntimeInventorySha256"]) if (ci.checksums[key] !== ti.checksums[key]) fail(`A/B product/runtime input mismatch: ${key}.`);
const controlClassification = classify(cp);
const treatmentClassification = classify(tp);
const result = {
  schemaVersion: 1,
  diagnosticOnly: true,
  releaseAcceptance: false,
  runtimeGateClaimedPassed: false,
  candidate: ci.productCandidateSha,
  electronVersion: ci.electronVersion,
  nsisConfigIdentical: true,
  managedRuntimeReceiptsIdentical: true,
  control: { builder: ci.electronBuilderVersion, installerSha256: ci.checksums.installerSha256, classification: controlClassification, rawDecision: cp.decision },
  treatment: { builder: ti.electronBuilderVersion, installerSha256: ti.checksums.installerSha256, classification: treatmentClassification, rawDecision: tp.decision },
  decision: controlClassification === "INSTALLER_STARTUP_HANG" && treatmentClassification === "FIRST_INSTALL_COMPLETE"
    ? "TREATMENT_RESOLVES_UPSTREAM_PACKAGER_REGRESSION_HYPOTHESIS_SUPPORTED"
    : controlClassification === treatmentClassification
      ? "NO_TREATMENT_EFFECT"
      : "AB_INCONCLUSIVE_OR_DIFFERENT_FAILURE",
};
writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));

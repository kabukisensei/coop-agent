#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function fail(message) { throw new Error(message); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || !argv[i + 1]) fail(`Unknown or incomplete argument: ${argv[i] || "<missing>"}`);
    out[argv[i].slice(2)] = resolve(argv[i + 1]);
  }
  for (const key of ["control-identity", "control-probe", "treatment-identity", "treatment-probe", "effective-config", "output"]) if (!out[key]) fail(`--${key} is required.`);
  return out;
}
function load(path) { return JSON.parse(readFileSync(path, "utf8")); }
function rootMetrics(report) {
  const pid = report.process?.pid;
  return (report.samples || []).map(sample => ({
    elapsedMs: sample.elapsedMs,
    process: sample.processTree?.processes?.find(item => item.pid === pid),
  })).filter(item => item.process?.metrics);
}
function classify(report) {
  if (report.decision === "FIRST_INSTALL_COMPLETE" && report.ok === true) return "FIRST_INSTALL_COMPLETE";
  if (report.process?.exceededBound !== true) return "INSTALLER_INCONCLUSIVE";
  const metrics = rootMetrics(report).filter(item => item.elapsedMs >= report.boundMs / 2);
  const first = metrics[0];
  const last = metrics.at(-1);
  const sameProcess = first && last && first.process.metrics.creationTime100ns === last.process.metrics.creationTime100ns;
  const cpuDelta = sameProcess ? (last.process.metrics.kernelTime100ns + last.process.metrics.userTime100ns) - (first.process.metrics.kernelTime100ns + first.process.metrics.userTime100ns) : 0;
  const ioDelta = sameProcess ? (last.process.metrics.readBytes + last.process.metrics.writeBytes) - (first.process.metrics.readBytes + first.process.metrics.writeBytes) : 0;
  const activeNearBound = sameProcess && last.elapsedMs >= report.boundMs - 15000 && cpuDelta > 0 && ioDelta > 0;
  if (activeNearBound) return "INSTALLER_TOO_SLOW_FOR_ACCEPTANCE";
  const material = (report.samples || []).some(sample => ["executable", "appAsar", "managedRuntime"].some(name => sample.files?.[name]?.exists));
  const registry = (report.samples || []).some(sample => (sample.registry?.count || 0) > 0);
  return !material && !registry ? "INSTALLER_STARTUP_HANG" : "INSTALLER_INCONCLUSIVE";
}

const options = parseArgs(process.argv.slice(2));
const ci = load(options["control-identity"]);
const cp = load(options["control-probe"]);
const ti = load(options["treatment-identity"]);
const tp = load(options["treatment-probe"]);
const effective = load(options["effective-config"]);
for (const [label, identity, probe, compression] of [["control", ci, cp, "lzma"], ["treatment", ti, tp, "zip"]]) {
  if (identity.abLabel !== label || identity.compressionTreatment !== compression) fail(`${label} compression identity mismatch.`);
  if (identity.electronBuilderVersion !== "26.15.3" || identity.electronVersion !== "44.2.0") fail(`${label} builder/Electron identity mismatch.`);
  if (identity.productCandidateSha !== probe.candidate || identity.checksums.installerSha256 !== probe.installerSha256) fail(`${label} probe/installer provenance mismatch.`);
  if (probe.boundMs !== 180000 || probe.cleanup?.confirmed !== true) fail(`${label} bound or cleanup evidence invalid.`);
}
for (const key of ["productCandidateSha", "productCandidateTree", "electronVersion", "electronBuilderVersion"]) if (ci[key] !== ti[key]) fail(`A/B shared identity mismatch: ${key}.`);
if (JSON.stringify(ci.builderFamily) !== JSON.stringify(ti.builderFamily)) fail("A/B builder-family mismatch.");
for (const key of ["managedConfigSha256", "installerConfigSha256"]) if (ci.nsisConfig[key] !== ti.nsisConfig[key]) fail(`A/B source config mismatch: ${key}.`);
for (const key of ["releaseManifestSha256", "developmentCompanionsSha256", "desktopPackageLockSha256", "managedRuntimeManifestSha256", "managedRuntimeInventorySha256", "packagedAppAsarSha256", "packagedExecutableSha256"]) if (ci.checksums[key] !== ti.checksums[key]) fail(`A/B product/runtime input mismatch: ${key}.`);
if (effective.diagnosticOnly !== true || effective.treatment !== "nsis.useZip=true" || effective.onlyDifferenceConfirmed !== true) fail("Effective treatment config evidence invalid.");
if (Object.hasOwn(effective.beforeNsis, "useZip") || effective.afterNsis?.useZip !== true) fail("Effective treatment did not add exactly useZip=true.");
const beforeComparable = structuredClone(effective.beforeNsis);
const afterComparable = structuredClone(effective.afterNsis);
delete afterComparable.useZip;
if (JSON.stringify(beforeComparable) !== JSON.stringify(afterComparable)) fail("Effective NSIS config differs beyond useZip.");

const controlClassification = classify(cp);
const treatmentClassification = classify(tp);
const conclusive = new Set(["FIRST_INSTALL_COMPLETE", "INSTALLER_STARTUP_HANG", "INSTALLER_TOO_SLOW_FOR_ACCEPTANCE"]);
const decision = controlClassification === "INSTALLER_TOO_SLOW_FOR_ACCEPTANCE" && treatmentClassification === "FIRST_INSTALL_COMPLETE"
  ? "ZIP_DIRECT_EXTRACTION_RESOLVES_ACCEPTANCE_DEFECT"
  : controlClassification === treatmentClassification && conclusive.has(controlClassification)
    ? "NO_TREATMENT_EFFECT"
    : "AB_INCONCLUSIVE_OR_DIFFERENT_FAILURE";
const result = {
  schemaVersion: 1,
  diagnosticOnly: true,
  releaseAcceptance: false,
  runtimeGateClaimedPassed: false,
  candidate: ci.productCandidateSha,
  electronBuilderVersion: ci.electronBuilderVersion,
  electronVersion: ci.electronVersion,
  onlyTreatment: "nsis.useZip=true",
  control: { compression: "lzma", installerSha256: ci.checksums.installerSha256, installerBytes: ci.installer.size, classification: controlClassification, rawDecision: cp.decision },
  treatment: { compression: "zip", installerSha256: ti.checksums.installerSha256, installerBytes: ti.installer.size, classification: treatmentClassification, rawDecision: tp.decision },
  decision,
};
writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
if (decision === "AB_INCONCLUSIVE_OR_DIFFERENT_FAILURE") process.exitCode = 1;

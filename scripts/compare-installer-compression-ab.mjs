#!/usr/bin/env node
import { createHash } from "node:crypto";
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
function fileSha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function valueSha256(value) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
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
  const metrics = rootMetrics(report).filter(item => item.elapsedMs >= report.boundMs - 45000 && item.elapsedMs <= report.boundMs + 15000);
  const last = metrics.at(-1);
  const intervals = metrics.slice(1).map((item, index) => {
    const previous = metrics[index];
    const sameProcess = previous.process.metrics.creationTime100ns === item.process.metrics.creationTime100ns;
    const cpuDelta = sameProcess ? (item.process.metrics.kernelTime100ns + item.process.metrics.userTime100ns) - (previous.process.metrics.kernelTime100ns + previous.process.metrics.userTime100ns) : 0;
    const ioDelta = sameProcess ? (item.process.metrics.readBytes + item.process.metrics.writeBytes) - (previous.process.metrics.readBytes + previous.process.metrics.writeBytes) : 0;
    return { sameProcess, cpuDelta, ioDelta };
  });
  const activeNearBound = metrics.length >= 4 && Math.abs(last?.elapsedMs - report.boundMs) <= 15000 && intervals.length >= 3 && intervals.every(interval => interval.sameProcess && interval.cpuDelta > 0 && interval.ioDelta > 0);
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
if (ti.checksums.effectiveConfigSha256 !== fileSha256(options["effective-config"]) || ci.checksums.effectiveConfigSha256 !== null) fail("Effective config evidence is not bound to treatment identity only.");
if (valueSha256(effective.beforeConfigDescriptor) !== effective.beforeSha256 || valueSha256(effective.afterConfigDescriptor) !== effective.afterSha256) fail("Effective config descriptor hashes do not match their recorded values.");
if (Object.hasOwn(effective.beforeNsis, "useZip") || effective.afterNsis?.useZip !== true) fail("Effective treatment did not add exactly useZip=true.");
if (canonicalJson(effective.beforeNsis) !== canonicalJson(effective.beforeConfigDescriptor?.nsis) || canonicalJson(effective.afterNsis) !== canonicalJson(effective.afterConfigDescriptor?.nsis)) fail("Effective NSIS views do not match config descriptors.");
if (effective.nonNsisPropertiesIdenticalByReference !== true) fail("Wrapper did not confirm non-NSIS identity preservation.");
const beforeComparable = structuredClone(effective.beforeConfigDescriptor);
const afterComparable = structuredClone(effective.afterConfigDescriptor);
delete afterComparable.nsis.useZip;
if (canonicalJson(beforeComparable) !== canonicalJson(afterComparable)) fail("Effective builder config differs beyond useZip.");
const controlArchives = ci.characteristics?.installerArchive?.filter(item => item.path === "$PLUGINSDIR\\app-64.7z" && item.folder === false) || [];
const treatmentArchives = ti.characteristics?.installerArchive?.filter(item => item.path === "$PLUGINSDIR\\app-64.zip" && item.folder === false) || [];
if (controlArchives.length !== 1 || treatmentArchives.length !== 1) fail("Built installers do not contain exactly one expected $PLUGINSDIR application archive.");
if (ci.characteristics.installerArchive.some(item => /(^|[\\/])app-64\.zip$/i.test(item.path)) || ti.characteristics.installerArchive.some(item => /(^|[\\/])app-64\.7z$/i.test(item.path))) fail("Built installer contains opposite-arm application archive format.");

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

#!/usr/bin/env node
// Release gate for the coop window installer (#277): release.yml publishes the
// built executable only if the acceptance report that verify-installer.mjs wrote
// on the same runner says the install, `--doctor` and uninstall passed on these
// exact bytes. The report names the installer's SHA-256 and the VERSION it was
// built from; this script recomputes the hash of the file about to be published
// and refuses any mismatch, so a report from another build can never vouch for it.
//
//   node desktop/scripts/check-installer-report.mjs <report.json> <dir-with-one-coop-window-*.exe>
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * The one installer in `dir` that `report` vouches for, or an Error naming what
 * is wrong: the report did not pass, the hash or the version differ, or the
 * folder does not hold exactly one coop-window-*.exe. `version` defaults to the
 * checkout's VERSION file (the tag's).
 */
export function verifiedInstaller(report, dir, version = readFileSync(join(ROOT, "VERSION"), "utf8").trim()) {
  if (!report || typeof report !== "object") throw new Error("the acceptance report is not an object");
  if (report.ok !== true) throw new Error(`the acceptance report does not say ok${report.error ? `: ${report.error}` : ""}`);
  if (report.version !== version) throw new Error(`the acceptance ran on version ${report.version}, this release is ${version}`);
  if (!/^[0-9a-f]{64}$/.test(String(report.installerSha256 || ""))) throw new Error("the acceptance report carries no installer SHA-256");
  const installers = readdirSync(dir).filter((name) => /^coop-window-.*\.exe$/i.test(name));
  if (installers.length !== 1) throw new Error(`expected one coop-window-*.exe in ${dir}, found ${installers.length}`);
  const file = join(dir, installers[0]);
  const actual = sha256(file);
  if (actual !== report.installerSha256) throw new Error(`${installers[0]} is ${actual}; the acceptance passed on ${report.installerSha256}`);
  if (report.installer && report.installer !== installers[0]) throw new Error(`the acceptance ran on ${report.installer}, publishing ${installers[0]}`);
  return { file, sha256: actual, version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [reportPath, dir] = process.argv.slice(2);
    if (!reportPath || !dir) throw new Error("usage: check-installer-report.mjs <report.json> <installer-dir>");
    const report = JSON.parse(readFileSync(resolve(reportPath), "utf8"));
    const verified = verifiedInstaller(report, resolve(dir));
    console.log(`✓ ${verified.file} (${verified.sha256}) passed the installer acceptance for ${verified.version}`);
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  }
}

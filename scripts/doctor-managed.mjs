#!/usr/bin/env node
import { runManagedDoctor } from "../web/managed-doctor-service.mjs";

const args = process.argv.slice(2);
try {
  if (args.some((arg) => !["--json", "--help", "-h"].includes(arg))) throw new Error("Managed Doctor is read-only. Repair or update the Desktop app to change bundled dependencies.");
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: coop doctor [--json]\nInspect and probe this managed Desktop runtime. Dependencies are repaired through Desktop installation/update.");
  } else {
    const report = await runManagedDoctor();
    console.log(args.includes("--json") ? JSON.stringify(report) : report.checks.map((check) => `${check.status.toUpperCase()}  ${check.name}${check.hint ? ` — ${check.hint}` : ""}`).join("\n"));
    process.exitCode = report.fail ? 1 : 0;
  }
} catch (error) {
  const report = { checks: [{ section: "Managed runtime", status: "fail", name: error.message, hint: "Repair the managed Desktop installation." }], fail: 1, warn: 0 };
  console.log(args.includes("--json") ? JSON.stringify(report) : error.message);
  process.exitCode = 1;
}

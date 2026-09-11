#!/usr/bin/env node
import { runDoctor } from "../web/doctor-service.mjs";

try {
  const report = await runDoctor();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.status === "error" ? 1 : 0;
} catch (error) {
  process.stderr.write(`coop doctor: ${error.message}\n`);
  process.exitCode = 1;
}

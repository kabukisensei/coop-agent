import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const matrix = JSON.parse(readFileSync(join(root, "config", "clipboard-interoperability.json"), "utf8"));
const schema = JSON.parse(readFileSync(join(root, "config", "clipboard-interoperability.schema.json"), "utf8"));
const exactApplications = ["ssms", "vs-code", "power-bi", "teams", "browser", "azure-devops"];
const statuses = new Set(["pending", "pass", "fail", "not-applicable"]);

assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
assert.equal(matrix.schemaVersion, 1);
assert.equal(matrix.platform, "windows");
assert.ok(["pending", "pass", "fail"].includes(matrix.overallStatus));
assert.deepEqual(matrix.applications.map((entry) => entry.id), exactApplications);
assert.equal(new Set(matrix.applications.map((entry) => entry.id)).size, matrix.applications.length);
assert.ok(matrix.automatedChecks.length >= 3);
for (const check of matrix.automatedChecks) {
  assert.deepEqual(Object.keys(check).sort(), ["id", "status", "testId"]);
  assert.equal(check.status, "pass");
  assert.ok(check.id && check.testId);
}
for (const application of matrix.applications) {
  assert.deepEqual(Object.keys(application).sort(), ["cases", "evidence", "id", "name", "required", "status"]);
  assert.equal(application.required, true);
  assert.ok(statuses.has(application.status));
  assert.ok(application.cases.length > 0);
  assert.equal(new Set(application.cases).size, application.cases.length);
  if (application.status === "pass") assert.ok(application.evidence, `${application.id} requires evidence when passed`);
  else assert.equal(application.evidence, null, `${application.id} must not retain passing evidence in ${application.status} state`);
}

const required = matrix.applications.filter((entry) => entry.required);
if (process.env.COOP_DESKTOP_WINDOWS_RELEASE_GATE === "1") {
  assert.equal(matrix.overallStatus, "pass", "Windows release requires clipboard interoperability to pass");
  assert.ok(required.every((entry) => entry.status === "pass"), "every required Windows application needs passing evidence");
} else {
  assert.equal(matrix.overallStatus, "pending", "development matrix must keep unexecuted Windows evidence explicit");
  assert.ok(required.some((entry) => entry.status === "pending"), "development should not claim unexecuted Windows interoperability");
}

console.log(`clipboard interoperability: ${matrix.automatedChecks.length} automated checks pass; ${required.filter((entry) => entry.status === "pending").length} Windows application rows pending`);

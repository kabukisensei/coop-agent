import assert from "node:assert/strict";
import { listServiceExtensions, serviceExtensionForCapability, serviceExtensionForTool } from "../web/service-extensions.mjs";

const extensions = listServiceExtensions();
assert.equal(extensions.length, 5);
assert.equal(new Set(extensions.map((item) => item.id)).size, extensions.length);
assert.equal(serviceExtensionForTool("sql_review")?.capabilityId, "coop.review.sql");
assert.equal(serviceExtensionForCapability("coop.review.dax")?.invocation.name, "dax_review");
assert.equal(serviceExtensionForTool("impact_analysis_result")?.capabilityId, "coop.impact.guided");
assert.equal(serviceExtensionForTool("bash"), null);
assert.equal(serviceExtensionForCapability("coop.unknown"), null);
assert.throws(() => { extensions[0].permissions.push("workspace.write"); }, TypeError);
assert.deepEqual(extensions[0].output, { kind: "execution-envelope", reportField: "details.report" });
console.log("service extensions: 8 assertions passed");

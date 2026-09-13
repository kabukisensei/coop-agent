import assert from "node:assert/strict";
import "../web/public/capability-view-registry.js";

const views = globalThis.CoopCapabilityViews;
assert.equal(views.resolve("coop.review.sql").rendererId, "findings");
assert.equal(views.resolve("coop.impact.guided").rendererId, "impact");
assert.equal(views.resolve("coop.unknown").rendererId, "generic-result");
assert.deepEqual(views.resolve("coop.unknown").actions, ["show-raw"]);
assert.throws(() => views.createRegistry([{ capabilityId: "coop.bad", rendererId: "script", actions: [] }]), /not allowlisted/);
assert.throws(() => views.createRegistry([{ capabilityId: "coop.bad", rendererId: "findings", actions: ["shell"] }]), /not allowlisted/);
assert.throws(() => views.createRegistry([{ capabilityId: "coop.bad", rendererId: "findings", actions: [], run: () => {} }]), /unsupported fields/);
assert.throws(() => views.resolve("coop.review.sql").actions.push("shell"), TypeError);
console.log("capability view registry: 8 assertions passed");

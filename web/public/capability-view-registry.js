// Declarative, allowlisted UI-extension registry. It registers presentation
// metadata only: no extension code, callbacks, paths, IPC methods, or commands.
(function installCapabilityViews(root) {
  "use strict";

  const RENDERERS = new Set(["generic-result", "findings", "lineage", "impact"]);
  const ACTIONS = new Set(["ask-agent", "add-change-plan", "open-source", "show-raw"]);
  const FALLBACK = Object.freeze({ capabilityId: "*", rendererId: "generic-result", actions: Object.freeze(["show-raw"]) });

  function descriptor(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("UI extension descriptor must be an object.");
    const keys = Object.keys(value).sort().join(",");
    if (keys !== "actions,capabilityId,rendererId") throw new TypeError("UI extension descriptor contains unsupported fields.");
    if (typeof value.capabilityId !== "string" || !/^coop\.[a-z0-9.-]+$/.test(value.capabilityId)) throw new TypeError("UI extension capabilityId is invalid.");
    if (!RENDERERS.has(value.rendererId)) throw new TypeError("UI extension renderer is not allowlisted.");
    if (!Array.isArray(value.actions) || value.actions.some((action) => !ACTIONS.has(action))) throw new TypeError("UI extension action is not allowlisted.");
    return Object.freeze({ capabilityId: value.capabilityId, rendererId: value.rendererId, actions: Object.freeze([...new Set(value.actions)]) });
  }

  function createRegistry(values = []) {
    const entries = new Map();
    for (const value of values) {
      const item = descriptor(value);
      if (entries.has(item.capabilityId)) throw new TypeError(`Duplicate UI extension for ${item.capabilityId}.`);
      entries.set(item.capabilityId, item);
    }
    return Object.freeze({
      resolve: (capabilityId) => entries.get(capabilityId) || FALLBACK,
      list: () => Object.freeze([...entries.values()]),
    });
  }

  const registry = createRegistry([
    { capabilityId: "coop.review.sql", rendererId: "findings", actions: ["ask-agent", "add-change-plan", "open-source", "show-raw"] },
    { capabilityId: "coop.review.dax", rendererId: "findings", actions: ["ask-agent", "add-change-plan", "open-source", "show-raw"] },
    { capabilityId: "coop.review.bpa", rendererId: "findings", actions: ["ask-agent", "add-change-plan", "show-raw"] },
    { capabilityId: "coop.lineage.explorer", rendererId: "lineage", actions: ["ask-agent", "open-source", "show-raw"] },
    { capabilityId: "coop.impact.guided", rendererId: "impact", actions: ["ask-agent", "add-change-plan", "open-source", "show-raw"] },
  ]);

  root.CoopCapabilityViews = Object.freeze({ createRegistry, resolve: registry.resolve, list: registry.list });
})(globalThis);

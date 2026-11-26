// The Features list in the window's Settings (FEATURES-DESIGN): this client's
// switches, the same five rows as `coop settings`, read and written in the main
// process through lib/features.mjs (coop.features / coop.setFeature).
//
// The main process broadcasts "coop:features" to every tab after a change, and
// app.mjs turns that into one window "coop:features" event, so this group does
// not raise one itself (the Changes pane would redraw twice).
import { el } from "./ui.mjs";

/** When a feature switch takes effect, in the words the Settings row shows. */
export function featureWhen(feature) {
  if (!feature.available) return "Not in this version yet";
  if (feature.takesEffect === "at once") return "Takes effect at once";
  return `Takes effect ${feature.takesEffect}`;
}

const sameView = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

/**
 * Read the switches again (Settings opens: `coop settings` in a terminal,
 * /sql-source in a session, or a fixed ~/.coop/config may have changed them).
 * Updates `info.features`; calls `changed()` once when they differ. Keeps the
 * last view when the read fails.
 */
export async function refreshFeatures({ coop, info, changed }) {
  let result = null;
  try { result = await coop.features(); } catch { result = null; }
  if (!result || !result.success || !result.data) return info.features;
  const before = info.features;
  info.features = result.data;
  if (!sameView(before, result.data) && typeof changed === "function") changed();
  return info.features;
}

/** The message under the heading: the hint, or why the switches cannot change. */
function headHint(view) {
  if (view.ok !== false) return "All off unless you turn them on. Saved for this Windows user (coop settings in a terminal shows the same list).";
  if (!view.file) return "The feature switches could not be read.";
  // Only a file that does not parse is "not valid JSON"; a file coop could not
  // open (a lock, a permission) is not the person's to fix by deleting it.
  if (view.errorKind === "io") return `${view.file} could not be read just now (${view.error || "the file is busy"}), so every feature reads as off. Close Settings and open it again in a moment.`;
  return `${view.file} is not valid JSON, so every feature reads as off and coop leaves the file as it is. Fix or remove it to change these.`;
}

/**
 * The group. `row(label, control, help)` is Settings' row; `info` holds the
 * view (info.features); `toast(message, level)`.
 */
export function featuresGroup(row, { coop, info, toast }) {
  const view = (info && info.features) || { ok: false, features: [] };
  const rows = (view.features || []).map((feature) => {
    const locked = !feature.available || view.ok === false;
    const input = el("input", { type: "checkbox", class: "switch", role: "switch", checked: feature.on === true, disabled: locked, "aria-label": feature.label });
    input.addEventListener("change", async () => {
      const want = input.checked;
      // One change at a time: a second click waits for the first to be saved.
      input.disabled = true;
      let result = null;
      try { result = await coop.setFeature(feature.key, want); } catch (error) { result = { success: false, error: error && error.message ? error.message : String(error) }; }
      if (result && result.success) {
        const { text, ...next } = result.data || {};
        info.features = next;
        toast(text, "info");
      } else {
        input.checked = !want;
        toast(`Could not change ${feature.label}: ${(result && result.error) || "unknown error"}`, "warning");
      }
      input.disabled = locked;
    });
    return row(feature.label, input, `${feature.help}. ${featureWhen(feature)}.`);
  });
  return el("div", { class: "settings-group", role: "group", "aria-label": "Features (this client)" },
    el("h3", { class: "settings-head", text: "Features (this client)" }),
    el("p", { class: "hint", text: headHint(view) }),
    ...rows);
}

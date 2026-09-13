// One semantic theme contract for every shared SPA component. Themes alter
// presentation only; capability discovery and workflow state remain untouched.
(function installThemeSystem(root) {
  "use strict";

  const STORAGE_KEY = "coop.ui.theme.v1";
  const THEMES = Object.freeze([
    Object.freeze({ id: "modern-dark", name: "Modern Dark", description: "Restrained dark surfaces with high-density code readability.", colorScheme: "dark" }),
    Object.freeze({ id: "modern-light", name: "Modern Light", description: "A calm light workspace designed for long consulting sessions.", colorScheme: "light" }),
    Object.freeze({ id: "retro-messenger", name: "Retro Messenger", description: "A purpose-built messenger-era treatment with the same serious engineering tools.", colorScheme: "light" }),
  ]);
  const IDS = new Set(THEMES.map((theme) => theme.id));

  function normalize(value) {
    return IDS.has(value) ? value : "modern-dark";
  }

  function descriptor(value) {
    const id = normalize(value);
    return THEMES.find((theme) => theme.id === id);
  }

  function apply(value, documentRef = root.document) {
    const theme = descriptor(value);
    if (!documentRef?.documentElement) return theme.id;
    documentRef.documentElement.dataset.theme = theme.id;
    return theme.id;
  }

  function loadLocal(storage = root.localStorage) {
    try { return normalize(storage?.getItem(STORAGE_KEY)); }
    catch { return "modern-dark"; }
  }

  function saveLocal(value, storage = root.localStorage) {
    const id = normalize(value);
    try { storage?.setItem(STORAGE_KEY, id); } catch { /* optional browser preference only */ }
    return id;
  }

  root.CoopThemes = Object.freeze({ themes: THEMES, normalize, descriptor, apply, loadLocal, saveLocal, storageKey: STORAGE_KEY });
  apply(loadLocal());
})(globalThis);

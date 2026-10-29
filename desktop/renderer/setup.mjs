// The first launch's progress (Aaron 2026-10-29): which step the setup is on,
// the item inside it and the console's last lines, pushed twice a second by
// the main process (setupTick in main.mjs, words from lib/setup-status.mjs).
// This page only draws them.
const coop = window.coop;
const $ = (id) => document.getElementById(id);

function applyTheme({ theme, systemDark }) {
  const resolved = theme === "auto" ? (systemDark ? "modern-dark" : "modern-light") : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.style = resolved.startsWith("retro") ? "retro" : "modern";
}

function draw(view) {
  if (!view) return;
  $("setupStep").textContent = view.stepLine || "Starting coop";
  $("setupDetail").textContent = view.detailLine || "";
  $("setupElapsed").textContent = view.elapsed || "0s";
  const bar = $("setupBar");
  if (typeof view.fraction === "number") {
    const pct = Math.round(view.fraction * 100);
    bar.classList.remove("indeterminate");
    bar.setAttribute("aria-valuenow", String(pct));
    $("setupFill").style.width = `${pct}%`;
  } else {
    bar.classList.add("indeterminate");
    bar.removeAttribute("aria-valuenow");
    $("setupFill").style.width = "";
  }
  $("setupLines").textContent = (view.lines || []).join("\n");
}

coop.onTheme((theme) => applyTheme(theme));
coop.onSetupStatus((view) => draw(view));
coop.setupState().then((result) => {
  if (!result || !result.success || !result.data) return;
  applyTheme(result.data);
  draw(result.data.view);
});

// The client folder question (master plan F1): one question, once per Windows
// user. "Where is this client's code?" with one primary button that opens the
// OS folder dialog; the main process records the folder in ~/.coop/client.json
// (coop:picker-choose in main.mjs), finds the project file from it and opens
// the window there. This page only draws the question. Also behind File >
// Switch client, with the folder recorded today shown under the lead.
const coop = window.coop;
const $ = (id) => document.getElementById(id);

function applyTheme({ theme, systemDark }) {
  const resolved = theme === "auto" ? (systemDark ? "modern-dark" : "modern-light") : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.style = resolved.startsWith("retro") ? "retro" : "modern";
}

async function load() {
  const result = await coop.pickerInfo();
  if (!result || !result.success || !result.data) return;
  if (result.data.client) $("pickerTitle").textContent = `Where is ${result.data.client}'s code?`;
  if (result.data.root) {
    $("pickerCurrent").textContent = `Today coop opens in ${result.data.root}. Choosing another folder changes that for every launch.`;
    $("pickerCurrent").hidden = false;
  }
}

$("choose").addEventListener("click", async () => {
  $("choose").disabled = true;
  const result = await coop.pickerChoose();
  // A cancelled dialog leaves the question open; a choice closes this window.
  if (!result || !result.success || !result.data) $("choose").disabled = false;
});
$("cancel").addEventListener("click", () => coop.pickerCancel());
document.addEventListener("keydown", (event) => { if (event.key === "Escape") coop.pickerCancel(); });

coop.onTheme((theme) => applyTheme(theme));
coop.pickerTheme().then((result) => { if (result && result.success) applyTheme(result.data); });
load();

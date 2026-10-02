// The project form (master plan D1b2): .coop/project.yml as a form with the
// questions /setup-project asks. It marks the fields the guardrails read,
// shows what saving changes as a YAML diff first, and saves through the same
// writer (the main process rebuilds and checks every answer, keeps the fields
// it does not own and backs up the old file). The fields nothing reads
// (estate.live_discovery, the mcp.* action lists) never reach the form.
import { el, fill, icon, openModal, toast } from "./ui.mjs";
import { diffModel, renderDiff } from "./diff-view.mjs";

export const ROLE_LABELS = Object.freeze({ sql: "SQL / Warehouse", powerbi: "Power BI / Semantic models", mixed: "SQL + Power BI / mixed", generic: "General project" });
const KIND_LABELS = { fabric_warehouse: "Fabric Warehouse", fabric_lakehouse: "Fabric Lakehouse SQL endpoint", azure_sql: "Azure SQL Database", sql_server: "SQL Server" };
const GUARD_TITLE = "The guardrails read this. A change applies from the next session.";

/** The wizard's hint under the Fabric question for this machine's client platform. */
export function platformHint(platform) {
  if (platform === "azure_sql") return "This machine is set up as an Azure SQL client, so No is the usual answer.";
  if (platform === "both") return "This machine is set up as a Fabric and Azure SQL client.";
  if (platform === "fabric") return "This machine is set up as a Fabric client.";
  return "";
}

const FLAT = ["profileName", "organization", "client", "timezone", "defaultBranch", "tenantId", "fabricWorkspaceName", "fabricWorkspaceId", "sqlEndpointItemType", "sqlEndpointItemName", "sqlEndpointItemId", "sqlEndpointPropertiesId", "powerBiWorkspaceName", "powerBiWorkspaceId", "sqlTargetKind", "sqlTargetServer", "sqlTargetDatabase", "tabularEditorPath", "bpaRulesPath"];
const REPO_FIELDS = ["name", "description", "role", "localPath", "remoteName", "defaultBranch"];

/** The form's starting values: the contract's settings with the wizard's defaults. */
export function initialValues(data) {
  const s = data.settings;
  const values = Object.fromEntries(FLAT.map((key) => [key, typeof s[key] === "string" ? s[key] : ""]));
  values.profileName = "";
  values.fabricEnabled = Boolean(s.fabricEnabled);
  values.tabularEditorEnabled = Boolean(s.tabularEditorEnabled);
  values.tabularEditorPath = s.tabularEditorPath || "te";
  values.powerBiWorkspaceName = s.powerBiWorkspaceName || s.fabricWorkspaceName || "";
  values.sqlTargetKind = s.sqlTargetKind || data.proposedKind[s.fabricEnabled ? "fabric" : "noFabric"] || "";
  values.sqlTargetDatabase = s.sqlTargetDatabase || s.sqlEndpointItemName || "";
  values.repositories = s.repositories.map((repo) => ({ ...Object.fromEntries(REPO_FIELDS.map((key) => [key, repo[key] || ""])), isNew: Boolean(repo.isNew) }));
  return values;
}

/** What the window sends to save: only the fields the form owns. */
export function formInput(values) {
  const input = Object.fromEntries(FLAT.map((key) => [key, String(values[key] || "")]));
  input.fabricEnabled = Boolean(values.fabricEnabled);
  input.tabularEditorEnabled = Boolean(values.tabularEditorEnabled);
  input.repositories = values.repositories.map((repo) => Object.fromEntries(REPO_FIELDS.map((key) => [key, String(repo[key] || "")])));
  return input;
}

export function mountProject(box, options, { coop, newSession }) {
  const state = { data: null, values: null, dirty: false, kindTouched: false, view: "form", preview: null };
  const body = el("div", { class: "pane-scroll project-form" });
  box.append(body);

  // --- Fields -------------------------------------------------------------

  const guard = () => el("span", { class: "chip guard", title: GUARD_TITLE }, icon("shield"), el("span", { text: "guardrails" }));

  function row({ field, label, hint, control, guarded, extra }) {
    return el("div", { class: "form-row", dataset: { field } },
      el("label", { class: "form-label" }, el("span", { text: label }), guarded ? guard() : null),
      el("div", { class: "form-control" }, control, extra || null),
      hint ? el("div", { class: "hint", text: hint }) : null,
      el("div", { class: "form-problem", role: "alert", hidden: true }));
  }

  function changed() {
    state.dirty = true;
    clearProblems();
  }

  function text(target, key, attrs = {}) {
    return el("input", { class: "field", type: "text", value: target[key] || "", spellcheck: "false", ...attrs, oninput: (event) => { target[key] = event.target.value; changed(); } });
  }

  function select(target, key, choices, onChange) {
    return el("select", { class: "field", onchange: (event) => { target[key] = event.target.value; changed(); if (onChange) onChange(event.target.value); } },
      choices.map(([value, label]) => el("option", { value, text: label, selected: value === (target[key] || "") })));
  }

  function toggle(key, label, onChange) {
    return el("label", { class: "form-toggle" },
      el("input", { type: "checkbox", class: "switch", checked: Boolean(state.values[key]), onchange: (event) => { state.values[key] = event.target.checked; changed(); onChange(event.target.checked); } }),
      el("span", { text: label }));
  }

  function section(title, ...children) {
    return el("section", { class: "form-section" }, el("h3", { text: title }), ...children);
  }

  function list(items) {
    return items.length ? items.map((item) => el("code", { text: item })) : [el("span", { class: "hint", text: "none" })];
  }

  function commitRows(lists) {
    if (!lists) return null;
    return el("div", { class: "commit-lists" },
      el("div", { class: "form-label" }, el("span", { text: "Commit lists" }), guard()),
      el("div", {}, el("span", { class: "commit-kind", text: "Allowed to commit: " }), ...list(lists.allowed)),
      el("div", {}, el("span", { class: "commit-kind", text: "Never commit: " }), ...list(lists.never)));
  }

  function repoCard(repo, index) {
    const at = (key) => `repositories.${index}.${key}`;
    const path = text(repo, "localPath");
    const browse = el("button", { type: "button", class: "btn", text: "Browse...", onclick: async () => {
      const result = await coop.pickFolder("project", repo.localPath);
      if (result.success) { repo.localPath = result.data; path.value = result.data; changed(); }
      else if (!result.cancelled) toast(result.error || "Could not choose a folder.", "warning");
    } });
    const lists = !repo.isNew ? state.data.commitLists.repositories[repo.name] : null;
    return el("div", { class: "repo-card" },
      el("div", { class: "repo-head" },
        repo.isNew ? null : el("strong", { text: repo.name }),
        repo.isNew ? el("span", { class: "chip", text: "new" }) : null,
        repo.isNew ? el("button", { type: "button", class: "btn link", text: "Remove", onclick: () => { state.values.repositories.splice(index, 1); changed(); renderForm(); } }) : null),
      repo.isNew ? row({ field: at("name"), label: "Repository short name", control: text(repo, "name") }) : null,
      row({ field: at("description"), label: "Description", control: text(repo, "description") }),
      row({ field: at("role"), label: "What kind of repository is this?", control: select(repo, "role", Object.entries(ROLE_LABELS)) }),
      row({ field: at("localPath"), label: "Local folder", hint: "Relative to the project folder, or a full path.", control: path, extra: browse, guarded: true }),
      row({ field: at("remoteName"), label: "Git remote name", control: text(repo, "remoteName") }),
      row({ field: at("defaultBranch"), label: "Default branch", control: text(repo, "defaultBranch") }),
      commitRows(lists));
  }

  function renderForm() {
    state.view = "form";
    const { data, values } = state;
    const fabricBox = el("div", { class: "form-group", hidden: !values.fabricEnabled });
    const serverRow = row({ field: "sqlTargetServer", label: "Dev SQL server host", hint: "For example contoso-dev.database.windows.net. A host name only.", control: text(values, "sqlTargetServer"), guarded: true });
    const dbRow = row({ field: "sqlTargetDatabase", label: "Dev database name", control: text(values, "sqlTargetDatabase"), guarded: true });
    const kindChoices = [["", "None (no SQL target)"], ...data.kinds.map((kind) => [kind, KIND_LABELS[kind] || kind])];
    const kindSelect = select(values, "sqlTargetKind", kindChoices, () => { state.kindTouched = true; showTarget(); });
    const showTarget = () => {
      serverRow.hidden = !values.sqlTargetKind || data.discoveredKinds.includes(values.sqlTargetKind);
      dbRow.hidden = !values.sqlTargetKind;
    };
    const teBox = el("div", { class: "form-group", hidden: !values.tabularEditorEnabled });
    fabricBox.append(
      row({ field: "tenantId", label: "Azure tenant ID", hint: "Optional.", control: text(values, "tenantId"), guarded: true }),
      row({ field: "fabricWorkspaceName", label: "Default Fabric workspace name", hint: "Optional.", control: text(values, "fabricWorkspaceName") }),
      row({ field: "fabricWorkspaceId", label: "Default Fabric workspace ID", hint: "Optional; a lowercase UUID.", control: text(values, "fabricWorkspaceId") }),
      row({ field: "sqlEndpointItemType", label: "Default SQL endpoint item type", control: select(values, "sqlEndpointItemType", [["", "None"], ...data.endpointTypes.map((type) => [type, type])]) }),
      row({ field: "sqlEndpointItemName", label: "Default SQL endpoint item name", hint: "Optional.", control: text(values, "sqlEndpointItemName") }),
      row({ field: "sqlEndpointItemId", label: "Default SQL endpoint item ID", hint: "Optional; a lowercase UUID.", control: text(values, "sqlEndpointItemId") }),
      row({ field: "sqlEndpointPropertiesId", label: "Lakehouse sqlEndpointProperties.id", hint: "A lowercase UUID; required for a Lakehouse.", control: text(values, "sqlEndpointPropertiesId") }),
      row({ field: "powerBiWorkspaceName", label: "Default Power BI workspace name", hint: "Optional.", control: text(values, "powerBiWorkspaceName") }),
      row({ field: "powerBiWorkspaceId", label: "Default Power BI workspace ID", hint: "Optional.", control: text(values, "powerBiWorkspaceId") }));
    teBox.append(
      row({ field: "tabularEditorPath", label: "Tabular Editor CLI command or path", control: text(values, "tabularEditorPath") }),
      row({ field: "bpaRulesPath", label: "BPA rules file path", hint: "Optional.", control: text(values, "bpaRulesPath") }));
    const hint = platformHint(data.platform);
    const repos = values.repositories;
    fill(body, 
      el("div", { class: "pane-summary" },
        el("span", { text: data.exists ? "Editing " : "No contract yet: saving creates " }),
        el("code", { text: data.path })),
      el("p", { class: "hint", text: "The same questions as /setup-project. Review shows the change before anything is written; the old file is backed up." }),
      data.profileMissing ? section("You",
        row({ field: "profileName", label: "What should coop call you?", hint: "Your local profile, not the project. Leave blank to skip.", control: text(values, "profileName") })) : null,
      section("Project",
        row({ field: "organization", label: "Organization", control: text(values, "organization") }),
        row({ field: "client", label: "Client / engagement", control: text(values, "client"), guarded: true }),
        row({ field: "timezone", label: "Timezone", control: text(values, "timezone") }),
        row({ field: "defaultBranch", label: "Project default branch", control: text(values, "defaultBranch") }),
        data.commitLists.top.length ? el("div", { class: "commit-lists" },
          el("div", { class: "form-label" }, el("span", { text: "Allowed to commit (all repositories)" }), guard()),
          el("div", {}, ...list(data.commitLists.top))) : null),
      section("Repositories",
        el("p", { class: "hint", text: repos.length ? "Repositories already in the file stay; their commit lists are edited in the file itself." : "No local source yet: coop starts in discovery mode. Add a repository when you have one." }),
        ...repos.map((repo, index) => repoCard(repo, index)),
        el("button", { type: "button", class: "btn", onclick: () => {
          repos.push({ name: `repo${repos.length + 1}`, description: "Project source and docs", role: "generic", localPath: ".", remoteName: "origin", defaultBranch: values.defaultBranch || "main", isNew: true });
          changed();
          renderForm();
        } }, icon("plus"), el("span", { text: "Add a repository" }))),
      section("Microsoft Fabric / Power BI",
        toggle("fabricEnabled", "This project uses Microsoft Fabric or Power BI", (on) => {
          fabricBox.hidden = !on;
          if (!state.kindTouched && !data.settings.sqlTargetKind) {
            values.sqlTargetKind = data.proposedKind[on ? "fabric" : "noFabric"] || "";
            kindSelect.value = values.sqlTargetKind;
            showTarget();
          }
        }),
        hint ? el("p", { class: "hint", text: hint }) : null,
        fabricBox),
      section("Dev SQL target",
        row({ field: "sqlTargetKind", label: "Kind", hint: `Where coop runs read-only SQL by default (dev, never prod).${data.settings.sqlTargetKind ? "" : " The kind shown is proposed for this machine, as /setup-project proposes it; choose None to leave it out."}`, control: kindSelect, guarded: true }),
        serverRow, dbRow),
      section("Tabular Editor",
        toggle("tabularEditorEnabled", "Use the Tabular Editor CLI for semantic-model BPA reviews", (on) => { teBox.hidden = !on; }),
        teBox),
      el("div", { class: "form-problems", role: "alert", hidden: true }),
      // The form is long: its buttons stay in view at the bottom of the pane.
      el("div", { class: "form-actions form-footer" },
        el("button", { type: "button", class: "btn primary", text: "Review changes", title: "Check the answers and show what saving would change", onclick: review }),
        el("button", { type: "button", class: "btn", text: "Discard edits", title: "Go back to what the file says now", onclick: () => reload(true) })));
    showTarget();
  }

  // --- Problems -------------------------------------------------------------

  function clearProblems() {
    for (const node of body.querySelectorAll(".form-row.bad")) node.classList.remove("bad");
    for (const node of body.querySelectorAll(".form-problem")) { node.hidden = true; node.textContent = ""; }
    const all = body.querySelector(".form-problems");
    if (all) all.hidden = true;
  }

  function showProblems(problems) {
    clearProblems();
    let first = null;
    const loose = [];
    for (const problem of problems) {
      const rowNode = [...body.querySelectorAll(".form-row")].find((node) => node.dataset.field === problem.field);
      if (rowNode && !rowNode.closest("[hidden]")) {
        rowNode.classList.add("bad");
        const note = rowNode.querySelector(".form-problem");
        note.textContent = note.textContent ? `${note.textContent} ${problem.message}` : problem.message;
        note.hidden = false;
        if (!first) first = rowNode;
      } else loose.push(problem.message);
    }
    const all = body.querySelector(".form-problems");
    if (all) {
      fill(all, el("strong", { text: problems.length === 1 ? "One answer needs a fix before saving." : `${problems.length} answers need a fix before saving.` }), ...loose.map((message) => el("div", { text: message })));
      all.hidden = false;
    }
    (first || all).scrollIntoView({ block: "center" });
  }

  // --- Review and save --------------------------------------------------------

  async function review() {
    const result = await coop.projectPreview(formInput(state.values));
    if (!result.success) { toast(result.error || "Could not check the answers.", "error"); return; }
    if (result.data.problems.length) { showProblems(result.data.problems); return; }
    state.preview = result.data;
    renderReview();
  }

  function renderReview() {
    state.view = "review";
    const p = state.preview;
    const back = el("button", { type: "button", class: "btn", text: "Back to the form", onclick: renderForm });
    if (!p.changed) {
      fill(body, el("div", { class: "pane-summary", text: "Nothing to save: the file already says this." }), el("div", { class: "form-actions" }, back));
      return;
    }
    const save = el("button", { type: "button", class: "btn primary", text: p.exists ? "Save" : "Create .coop/project.yml", onclick: () => doSave(save) });
    fill(body, 
      el("div", { class: "pane-summary" }, el("span", { text: p.exists ? "Saving changes " : "Saving creates " }), el("code", { text: p.path })),
      el("p", { class: "hint", text: `Mode: ${p.mode}. The fields the form does not own stay as they are${p.exists ? ", and the old file is backed up" : ""}.` }),
      el("div", { class: "change-diff" }, renderDiff(diffModel(p.diff), { mode: "unified" }).node),
      el("div", { class: "form-actions" }, save, back));
  }

  async function doSave(button) {
    button.disabled = true;
    const result = await coop.projectSave(formInput(state.values), state.preview.token);
    button.disabled = false;
    if (!result.success) { toast(result.error || "Could not save.", "error", { timeout: 0 }); return; }
    if (result.data.problems && result.data.problems.length) { renderForm(); showProblems(result.data.problems); return; }
    renderSaved(result.data);
  }

  function renderSaved(saved) {
    state.view = "saved";
    state.dirty = false;
    fill(body, 
      el("div", { class: "pane-summary ok" }, icon("check"), el("span", { text: saved.created ? "Created " : "Saved " }), el("code", { text: saved.path })),
      saved.backup ? el("p", { class: "hint" }, el("span", { text: "Backup: " }), el("code", { text: saved.backup })) : null,
      saved.profileSaved ? el("p", { class: "hint", text: `Saved your profile name (${saved.profileSaved}). coop uses it from the next session.` }) : null,
      el("p", { text: "The guardrails read the contract when a session starts. Start a new session before governed work so they use this one." }),
      el("div", { class: "form-actions" },
        el("button", { type: "button", class: "btn primary", text: "Start a new session", onclick: () => newSession() }),
        el("button", { type: "button", class: "btn", text: "Back to the form", onclick: () => reload(false) })));
  }

  // --- Loading ------------------------------------------------------------------

  async function reload(confirmDiscard) {
    if (confirmDiscard && state.dirty) {
      const ok = await new Promise((resolve) => openModal({
        title: "Discard your edits?",
        body: el("p", { class: "dialog-message", text: "The form goes back to what .coop/project.yml says now." }),
        onCancel: () => resolve(false),
        buttons: [{ label: "Keep editing", onClick: () => resolve(false) }, { label: "Discard", kind: "danger", onClick: () => resolve(true) }],
      }));
      if (!ok) return;
    }
    fill(body, el("div", { class: "working" }, el("span", { class: "spinner" }), el("span", { text: "Reading .coop/project.yml" })));
    const result = await coop.projectLoad();
    if (!result.success) { fill(body, el("p", { class: "pane-empty", text: result.error || "Could not read the project contract." })); return; }
    state.data = result.data;
    state.values = initialValues(result.data);
    state.dirty = false;
    state.kindTouched = false;
    renderForm();
  }

  reload(false);
  return {
    show: () => {},
    refresh: () => reload(true),
  };
}

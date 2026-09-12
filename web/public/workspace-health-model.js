// Presentation-neutral projection of the shared Doctor, auth, and setup contracts.
(function installWorkspaceHealthModel(root) {
  "use strict";

  const RANK = Object.freeze({ healthy: 0, skipped: 0, configured: 0, authenticated: 0, unavailable: 1, "not-configured": 1, unauthenticated: 1, warning: 2, progressive: 2, expired: 2, error: 3, broken: 3 });

  function state(value, fallback = "unavailable") {
    return typeof value === "string" && Object.hasOwn(RANK, value) ? value : fallback;
  }

  function overall(items) {
    let selected = "healthy";
    let rank = 0;
    for (const item of items) {
      const next = RANK[state(item.state)] ?? 1;
      if (next > rank) { rank = next; selected = state(item.state); }
    }
    return selected;
  }

  function build({ doctor, auth, setup, profile }) {
    const doctorItems = Array.isArray(doctor?.checks) ? doctor.checks.map((check) => ({
      id: check.id,
      title: check.summary,
      detail: check.recommendedAction || "",
      state: state(check.state),
      action: check.repair?.available ? { kind: "repair", ...check.repair } : null,
    })) : [];
    const authItems = Array.isArray(auth?.providers) ? auth.providers.map((provider) => ({
      id: provider.id,
      title: provider.name,
      detail: provider.account?.label
        ? [provider.account.label, provider.account.tenantId].filter(Boolean).join(" · ")
        : provider.diagnostics?.[0]?.message || "",
      state: state(provider.state),
      trustContext: provider.trustContext,
      action: provider.actions?.includes("login") || provider.actions?.includes("reauthenticate")
        ? { kind: "auth", providerId: provider.id, method: provider.login?.method || "none", available: provider.login?.available === true, reauthenticate: provider.state === "authenticated" }
        : null,
    })) : [];
    const setupItems = Array.isArray(setup?.sections) ? setup.sections.map((section) => ({
      id: section.id,
      title: section.label,
      detail: section.summary,
      state: state(section.state),
      selected: section.selected === true,
      action: section.setupOperationId ? { kind: "setup", operationId: section.setupOperationId } : null,
    })) : [];
    const profileItem = {
      id: "user-profile",
      title: "Your Coop profile",
      detail: profile?.profile?.name
        ? `${profile.profile.name} · ${profile.profile.communication?.preset || "balanced"}`
        : "Add your name and preferred communication style.",
      state: profile?.state === "configured" ? "configured" : "not-configured",
      action: { kind: "profile" },
      profile: profile?.profile || null,
      questionnaire: profile?.questionnaire || null,
    };
    const workspaceItems = [profileItem, ...setupItems];
    const items = [...doctorItems, ...authItems, ...workspaceItems];
    return {
      state: overall(items),
      sections: [
        { id: "workspace", title: "Workspace setup", items: workspaceItems },
        { id: "identity", title: "Identity and access", items: authItems },
        { id: "doctor", title: "Runtime health", items: doctorItems },
      ],
      checkedAt: [doctor?.checkedAt, auth?.checkedAt].filter((item) => typeof item === "string").sort().at(-1) || null,
    };
  }

  root.CoopWorkspaceHealth = Object.freeze({ build, overall });
})(globalThis);

/**
 * coop-profile — inject the local COOP user profile as a tiny hidden instruction.
 *
 * Reads the COOP user profile before each turn and contributes a stable
 * system-prompt instruction, without appending persistent session messages. The
 * profile is the per-user <profile dir>/user.json (scripts/onboard.py), filled
 * field by field from the machine-level file (`coop onboard --machine`, master
 * plan P1) when the per-user file lacks a field or is missing (lib/user-profile.mjs).
 *
 * Failure is graceful: if the file is missing, malformed, or the schema is unknown,
 * the extension silently does nothing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { effectiveProfile } from "../../lib/user-profile.mjs";

type CommunicationPreset = "concise" | "balanced" | "teaching" | "custom";

interface UserProfile {
  schema_version: number;
  name: string;
  communication: {
    preset: CommunicationPreset;
    custom_instructions?: string;
  };
}

const PRESET_TEXT: Record<CommunicationPreset, string> = {
  concise: "Answer first. Keep explanations short. Use bullets where useful. Explain tradeoffs only when material.",
  balanced: "Answer first. Give a brief why. Then structured detail.",
  teaching: "Answer first. Explain reasoning, alternatives, and tradeoffs in more depth.",
  custom: "", // filled from custom_instructions
};

function isValidPreset(p: string): p is CommunicationPreset {
  return ["concise", "balanced", "teaching", "custom"].includes(p);
}

export function loadProfile(): UserProfile | null {
  try {
    const { profile } = effectiveProfile();
    if (!profile || !sanitize(profile.name) || !isValidPreset(profile.communication.preset)) return null;
    return {
      schema_version: 1,
      name: sanitize(profile.name),
      communication: {
        preset: profile.communication.preset,
        custom_instructions: sanitize(profile.communication.custom_instructions || "", 1000),
      },
    };
  } catch {
    return null;
  }
}

export function sanitize(value: string, max = 100): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function buildInstruction(profile: UserProfile): string {
  const preset = profile.communication.preset;
  let style = PRESET_TEXT[preset];
  if (preset === "custom" && profile.communication.custom_instructions) {
    style = profile.communication.custom_instructions.trim();
  }
  const parts: string[] = [
    `COOP user profile:`,
    `- Call the user ${profile.name}.`,
  ];
  if (style) {
    parts.push(`- Communication: ${preset}. ${style}`);
  } else {
    parts.push(`- Communication: ${preset}.`);
  }
  return parts.join("\n");
}

// Pi passes the ExtensionAPI itself as the argument (ExtensionFactory =
// (pi: ExtensionAPI) => void). Registering on it directly is the only correct
// contract — destructuring a `pi` property from it crashes at load time.
export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event: any, _ctx: ExtensionContext) => {
    try {
      const profile = loadProfile();
      if (!profile) return;
      const instruction = buildInstruction(profile);
      return { systemPrompt: `${String(event?.systemPrompt || "")}\n\n${instruction}`.trim() };
    } catch {
      // Never break a session because of a profile problem.
      return;
    }
  });
}

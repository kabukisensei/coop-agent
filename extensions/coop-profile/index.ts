/**
 * coop-profile — inject the local COOP user profile as a tiny hidden instruction.
 *
 * Reads the COOP user profile (<profile dir>/user.json, the file scripts/onboard.py
 * writes; see lib/paths.mjs) before each turn and contributes a stable system-prompt
 * instruction, without appending persistent session messages.
 *
 * Failure is graceful: if the file is missing, malformed, or the schema is unknown,
 * the extension silently does nothing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { userProfilePath } from "../../lib/paths.mjs";

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
  const userJson = userProfilePath();
  if (!existsSync(userJson)) return null;
  try {
    const raw = JSON.parse(readFileSync(userJson, "utf8"));
    if (typeof raw !== "object" || raw === null || raw.schema_version !== 1) return null;
    if (typeof raw.name !== "string" || !sanitize(raw.name)) return null;
    if (typeof raw.communication !== "object" || raw.communication === null) return null;
    const preset = raw.communication.preset;
    if (typeof preset !== "string" || !isValidPreset(preset)) return null;
    return {
      schema_version: 1,
      name: sanitize(raw.name),
      communication: {
        preset,
        custom_instructions: typeof raw.communication.custom_instructions === "string"
          ? sanitize(raw.communication.custom_instructions, 1000)
          : "",
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

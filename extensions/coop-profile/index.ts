/**
 * coop-profile — inject the local COOP user profile as a tiny hidden instruction.
 *
 * Reads ~/.coop/user.json once per session and adds one agent-visible, human-hidden
 * note so the model knows how the user prefers to be addressed and communicated with.
 *
 * Failure is graceful: if the file is missing, malformed, or the schema is unknown,
 * the extension silently does nothing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

const USER_JSON = join(homedir(), ".coop", "user.json");

function isValidPreset(p: string): p is CommunicationPreset {
  return ["concise", "balanced", "teaching", "custom"].includes(p);
}

function loadProfile(): UserProfile | null {
  if (!existsSync(USER_JSON)) return null;
  try {
    const raw = JSON.parse(readFileSync(USER_JSON, "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    if (typeof raw.name !== "string" || !raw.name.trim()) return null;
    if (typeof raw.communication !== "object" || raw.communication === null) return null;
    const preset = raw.communication.preset;
    if (typeof preset !== "string" || !isValidPreset(preset)) return null;
    return {
      schema_version: typeof raw.schema_version === "number" ? raw.schema_version : 1,
      name: raw.name.trim(),
      communication: {
        preset,
        custom_instructions: typeof raw.communication.custom_instructions === "string"
          ? raw.communication.custom_instructions
          : "",
      },
    };
  } catch {
    return null;
  }
}

function buildInstruction(profile: UserProfile): string {
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

export default function (api: ExtensionAPI) {
  const { pi } = api;

  pi.on("before_agent_start", async (_event, _ctx: ExtensionContext) => {
    try {
      const profile = loadProfile();
      if (!profile) return;
      return {
        message: {
          customType: "coop-profile",
          display: false,
          content: buildInstruction(profile),
          details: { preset: profile.communication.preset },
        },
      };
    } catch {
      // Never break a session because of a profile problem.
      return;
    }
  });
}

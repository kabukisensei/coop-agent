// coop's codemode (master plan U2 step 3). Pi 1.x ships codemode as a built-in
// extension that lets a script call the session's tools and, through `models.*`,
// outside classifier and image models with the session's sign-ins. Those model
// calls never pass a tool hook, so coop-guardrails could not see them, and a
// script could send client data out without a prompt. This extension registers
// Pi's own codemode with `models` off, which replaces the built-in one (Pi drops
// a replaceable built-in when another extension registers its tool), and fixes
// the mode to "on" so a work repo's settings cannot hide coop's tools behind
// scripts. Every tool call a script makes runs through Pi's tool pipeline, so
// coop-guardrails checks it like a direct call; coop-guardrails also blocks any
// codemode tool that is not this one. Loaded only on Pi 1.x (bin/coop.ps1).
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";

export default createCodemodeExtension({ models: false, mode: "on" });

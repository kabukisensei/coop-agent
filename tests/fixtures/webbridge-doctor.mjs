import { runDoctor as executeDoctor } from "../../web/doctor-service.mjs";
export function runDoctor(options) {
  return executeDoctor({ ...options, execute: async () => ({ code: 0, stdout: JSON.stringify({ checks: [
    { section: "Core", name: "Controlled bridge test runtime", status: "ok", hint: "" },
  ] }), stderr: "" }) });
}

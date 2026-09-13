// Keep the stub-Pi HTTP contract suite independent of workstation installations.
// Doctor's command execution and real managed runtime probes have separate tests.
import { registerHooks } from "node:module";
const server = new URL("../../web/server.mjs", import.meta.url).href;
const fixture = new URL("./webbridge-doctor.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === server && specifier === "./doctor-service.mjs") return { url: fixture, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const expected = ["runtime", "--transport", "http", "--json", "--port", "0", "--cwd"];
if (!expected.every((value, index) => args[index] === value) || !args[expected.length]) process.exit(2);
let descendant;
if (process.env.COOP_TEST_DESCENDANT_FILE) {
  descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  writeFileSync(process.env.COOP_TEST_DESCENDANT_FILE, JSON.stringify({ parent: process.pid, descendant: descendant.pid }));
}
if (!process.env.COOP_TEST_SUPPRESS_READY) process.stdout.write(`${JSON.stringify({
  type: "runtime.ready",
  contractVersion: 1,
  transport: "http",
  endpoint: "http://127.0.0.1:54321",
  oneTimeToken: "0123456789abcdef0123456789abcdef",
  runtimePid: process.pid,
  coopVersion: "0.23.1",
  piVersion: "0.84.3",
})}\n`);
process.on("SIGTERM", () => { descendant?.kill(); process.exit(0); });
setInterval(() => {}, 1000);

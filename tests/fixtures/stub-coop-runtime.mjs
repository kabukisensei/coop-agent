const args = process.argv.slice(2);
const expected = ["runtime", "--transport", "http", "--json", "--port", "0", "--cwd"];
if (!expected.every((value, index) => args[index] === value) || !args[expected.length]) process.exit(2);
process.stdout.write(`${JSON.stringify({
  type: "runtime.ready",
  contractVersion: 1,
  transport: "http",
  endpoint: "http://127.0.0.1:54321",
  oneTimeToken: "0123456789abcdef0123456789abcdef",
  runtimePid: process.pid,
  coopVersion: "0.23.1",
  piVersion: "0.84.3",
})}\n`);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
